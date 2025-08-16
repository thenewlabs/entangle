import WebSocket from 'ws';
import { 
  FrameType, 
  FrameReader, 
  encodeFrame,
  type RunMessage,
  type ErrorMessage,
  type TtyOpenMessage,
  type TtyDataMessage,
  type TtyResizeMessage,
  type TtySignalMessage,
  ErrorCode,
} from '@sunpix/entangle-protocol';
import {
  deriveKeys,
  extractSaltFromCapId,
  aeadEncrypt,
  aeadDecrypt,
  verifyHmac,
  hashPolicy,
} from '@sunpix/entangle-crypto';
import { 
  OutputHandler,
  parseOutputMode,
  BidirectionalCounters,
  validateArguments,
  getConfig,
} from '@sunpix/entangle-utils';
import { encode, decode } from 'cborg';
import { runCommand } from './runner.js';
import { PtyManager } from './pty.js';
import type { CapabilityInfo } from './capability.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export interface Session {
  socketId: string;
  ws: WebSocket;
  cap: CapabilityInfo;
  keys?: Awaited<ReturnType<typeof deriveKeys>>;
  counters: BidirectionalCounters;
  authenticated: boolean;
  passwordVerified: boolean;
  requiresPassword: boolean;
  passwordHash?: string | undefined;
  nonceB?: string;
  nonceC?: string;
  hasRun: boolean;
  currentCommand?: string;
  abortController?: AbortController;
  ptyManager?: PtyManager;
}

// Helper to send wrapped relay responses
export function sendRelayResponse(session: Session, frame: Uint8Array): void {
  session.ws.send(JSON.stringify({
    type: 'RELAY_RESPONSE',
    socketId: session.socketId,
    frame: Buffer.from(frame).toString('base64')
  }));
}

export async function handleInvokerConnection(
  agentWs: WebSocket,
  socketId: string,
  cap: CapabilityInfo,
  passwordHash?: string
): Promise<any> {
  const session: Session = {
    socketId,
    ws: agentWs,
    cap,
    counters: new BidirectionalCounters(),
    authenticated: false,
    passwordVerified: !passwordHash, // If no password, consider it verified
    requiresPassword: !!passwordHash,
    passwordHash: passwordHash || undefined,
    hasRun: false,
    ptyManager: new PtyManager(),
  };
  
  const reader = new FrameReader();
  
  // Add sendError and sendEncrypted methods to session
  (session as any).sendError = (code: string, detail?: string, commandId?: string | null) => {
    sendError(session, commandId || null, code, detail);
  };
  
  (session as any).sendEncrypted = async (type: FrameType, msg: any) => {
    if (!session.keys) return;
    const ctr = session.counters.outgoing.next();
    const encrypted = aeadEncrypt(session.keys.K_enc, type, ctr, msg);
    const frame = encodeFrame(type, encode(encrypted));
    sendRelayResponse(session, frame);
  };
  
  // Return session object with methods to handle frames
  return {
    handleFrame: async (data: Buffer) => {
      const frames = reader.push(data);
      for (const frame of frames) {
        try {
          await handleFrame(session, frame);
        } catch (error) {
          output.error(`Failed to handle frame for socket ${socketId}`, error instanceof Error ? error.message : String(error));
          sendError(session, null, ErrorCode.INTERNAL_ERROR, String(error));
        }
      }
    },
    cleanup: () => {
      if (session.abortController) {
        session.abortController.abort();
      }
      if (session.ptyManager) {
        session.ptyManager.cleanup();
      }
    }
  };
}

async function handleFrame(session: Session, frame: { type: FrameType; payload: Uint8Array }): Promise<void> {
  switch (frame.type) {
    case FrameType.AUTH1:
      await handleAuth1(session, frame.payload);
      break;
      
    case FrameType.AUTH3:
      await handleAuth3(session, frame.payload);
      break;
      
    case FrameType.AUTH_PW:
      await handleAuthPw(session, frame.payload);
      break;
      
    case FrameType.RUN:
      await handleRun(session, frame.payload);
      break;
      
    case FrameType.ABORT:
      await handleAbort(session, frame.payload);
      break;
      
    case FrameType.TTY_OPEN:
      await handleTtyOpen(session, frame.payload);
      break;
      
    case FrameType.TTY_DATA:
      await handleTtyData(session, frame.payload);
      break;
      
    case FrameType.TTY_RESIZE:
      await handleTtyResize(session, frame.payload);
      break;
      
    case FrameType.TTY_SIGNAL:
      await handleTtySignal(session, frame.payload);
      break;
      
    case FrameType.KEEPALIVE:
      // Just update activity timestamp
      break;
      
    default:
      output.warn(`Unexpected frame type: ${frame.type}`);
  }
}

async function handleAuth1(session: Session, payload: Uint8Array): Promise<void> {
  try {
    output.debug(`AUTH1 received: payload length ${payload.length}`);
    
    const saltCap = extractSaltFromCapId(session.cap.capId);
    const S = session.cap.S;
    
    session.keys = await deriveKeys(S, saltCap);
    
    // AUTH1 payload should be HMAC (32 bytes) + nonceB (variable length)
    if (payload.length < 32) {
      output.error(`AUTH1 payload too short: ${payload.length} bytes`);
      throw new Error('Invalid AUTH1 payload: too short');
    }
    
    const receivedHmac = payload.slice(0, 32);
    const nonceBBytes = payload.slice(32);
    
    // Avoid logging sensitive auth material
    
    // Convert nonceB bytes to string (it's already UTF-8 encoded)
    session.nonceB = new TextDecoder().decode(nonceBBytes);
    
    // Avoid logging nonce values
    
    // Verify the HMAC
    const auth1Data = new TextEncoder().encode('hello' + session.cap.capId + session.nonceB);
    
    // Avoid logging HMAC details
    
    if (!verifyHmac(session.keys.K_auth, auth1Data, receivedHmac)) {
      output.error('AUTH1 HMAC verification failed');
      throw new Error('AUTH1 HMAC verification failed');
    }
    
    output.debug('AUTH1 HMAC verified');
    
    // Generate nonceC for AUTH2
    session.nonceC = require('crypto').randomBytes(16).toString('hex');
    
    const auth2 = {
      ok: true,
      nonceB: session.nonceB,
      nonceC: session.nonceC,
      expiryTs: Date.now() + 3600000,
      policyHash: hashPolicy(session.cap.policy),
      requiresPassword: session.requiresPassword,
    };
    
    const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.AUTH2, 0, auth2);
    const frame = encodeFrame(FrameType.AUTH2, encode(encrypted));
    
    sendRelayResponse(session, frame);
    
    output.debug('AUTH2 sent');
  } catch (error) {
    output.error('AUTH1 failed', error instanceof Error ? error.message : String(error));
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Authentication failed');
  }
}

async function handleAuth3(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.keys || !session.nonceC) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Invalid auth sequence');
    return;
  }
  
  const expectedData = new TextEncoder().encode('ready' + session.nonceC);
  
  if (!verifyHmac(session.keys.K_auth, expectedData, payload)) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Invalid AUTH3 HMAC');
    return;
  }
  
  session.authenticated = true;
  output.info(`Session authenticated: ${session.socketId}`);
  
  // If password is required but not yet verified, don't allow other operations
  if (session.requiresPassword && !session.passwordVerified) {
    output.info(`Waiting for password authentication: ${session.socketId}`);
  }
}

async function handleAuthPw(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Not authenticated');
    return;
  }
  
  if (!session.requiresPassword) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Password not required');
    return;
  }
  
  if (session.passwordVerified) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Already verified');
    return;
  }
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const authPwMsg = decrypted.msg as { password: string };
    
    // Hash the provided password and compare
    const crypto = require('crypto');
    const providedHash = crypto.createHash('sha256').update(authPwMsg.password).digest('hex');
    
    if (providedHash !== session.passwordHash) {
      output.warn(`Invalid password attempt for session: ${session.socketId}`);
      sendError(session, null, ErrorCode.AUTH_FAILED, 'Invalid password');
      return;
    }
    
    session.passwordVerified = true;
    output.info(`Password verified for session: ${session.socketId}`);
    
    // Send success response
    const successMsg = {
      ctr: session.counters.outgoing.next(),
      msg: { ok: true }
    };
    
    const successEncrypted = aeadEncrypt(session.keys.K_enc, FrameType.AUTH_PW, successMsg.ctr, successMsg.msg);
    const successFrame = encodeFrame(FrameType.AUTH_PW, encode(successEncrypted));
    sendRelayResponse(session, successFrame);
  } catch (error) {
    output.error('AUTH_PW failed', error instanceof Error ? error.message : String(error));
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Password verification failed');
  }
}

async function handleRun(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Not authenticated');
    return;
  }
  
  if (!session.passwordVerified) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Password verification required');
    return;
  }
  
  if (session.hasRun && session.cap.policy.singleRun) {
    sendError(session, null, ErrorCode.MULTI_RUN_NOT_ALLOWED, 'Only one run allowed per session');
    return;
  }
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.RUN, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const runMsg = decrypted.msg as RunMessage['msg'];
    
    const config = getConfig();
    validateArguments(runMsg.argv, config.maxArgCount, config.maxArgLen);
    
    session.hasRun = true;
    session.currentCommand = runMsg.commandId;
    session.abortController = new AbortController();
    
    await runCommand(session, runMsg);
  } catch (error) {
    output.error('RUN failed', error instanceof Error ? error.message : String(error));
    sendError(session, session.currentCommand || null, ErrorCode.INTERNAL_ERROR, String(error));
  }
}

async function handleAbort(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys) return;
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.ABORT, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const abortMsg = decrypted.msg as any;
    
    if (abortMsg.commandId === session.currentCommand && session.abortController) {
      session.abortController.abort();
      output.info(`Command aborted: ${abortMsg.commandId}`);
    }
  } catch (error) {
    output.error('ABORT failed', error instanceof Error ? error.message : String(error));
  }
}

async function handleTtyOpen(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys || !session.ptyManager) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Not authenticated');
    return;
  }
  
  if (!session.passwordVerified) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Password verification required');
    return;
  }
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.TTY_OPEN, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const ttyOpenMsg = decrypted as TtyOpenMessage;
    await session.ptyManager.handleTtyOpen(session as any, ttyOpenMsg);
  } catch (error) {
    output.error('TTY_OPEN failed', error instanceof Error ? error.message : String(error));
    sendError(session, null, ErrorCode.INTERNAL_ERROR, String(error));
  }
}

async function handleTtyData(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys || !session.ptyManager) return;
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.TTY_DATA, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const ttyDataMsg = decrypted as TtyDataMessage;
    await session.ptyManager.handleTtyData(session as any, ttyDataMsg);
  } catch (error) {
    output.error('TTY_DATA failed', error instanceof Error ? error.message : String(error));
  }
}

async function handleTtyResize(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys || !session.ptyManager) return;
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.TTY_RESIZE, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const ttyResizeMsg = decrypted as TtyResizeMessage;
    await session.ptyManager.handleTtyResize(session as any, ttyResizeMsg);
  } catch (error) {
    output.error('TTY_RESIZE failed', error instanceof Error ? error.message : String(error));
  }
}

async function handleTtySignal(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys || !session.ptyManager) return;
  
  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.TTY_SIGNAL, encrypted.nonce, encrypted.cipher);
    session.counters.incoming.validate(decrypted.ctr);
    
    const ttySignalMsg = decrypted as TtySignalMessage;
    await session.ptyManager.handleTtySignal(session as any, ttySignalMsg);
  } catch (error) {
    output.error('TTY_SIGNAL failed', error instanceof Error ? error.message : String(error));
  }
}

function sendError(session: Session, commandId: string | null, code: string, detail?: string): void {
  if (!session.keys) return;
  
  const error: ErrorMessage = {
    ctr: session.counters.outgoing.next(),
    msg: {
      commandId,
      code,
      detail,
    },
  };
  
  const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.ERROR, error.ctr, error.msg);
  const frame = encodeFrame(FrameType.ERROR, encode(encrypted));
  
  sendRelayResponse(session, frame);
}
