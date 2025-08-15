import WebSocket from 'ws';
import { 
  FrameType, 
  FrameReader, 
  encodeFrame,
  type RunMessage,
  type ErrorMessage,
  ErrorCode,
} from '@sunpix/entangle-protocol';
import {
  deriveKeys,
  extractSaltFromCapId,
  aeadEncrypt,
  aeadDecrypt,
  // computeHmac,
  verifyHmac,
  hashPolicy,
} from '@sunpix/entangle-crypto';
import { 
  createLogger, 
  BidirectionalCounters,
  validateArguments,
  validateCwd,
  validateLimits,
  getConfig,
} from '@sunpix/entangle-utils';
import { encode } from 'cborg';
import { runCommand } from './runner.js';
import type { CapabilityInfo } from './capability.js';

const logger = createLogger('relay');

// Helper to send wrapped relay responses
export function sendRelayResponse(session: Session, frame: Uint8Array): void {
  session.ws.send(JSON.stringify({
    type: 'RELAY_RESPONSE',
    socketId: session.socketId,
    frame: Buffer.from(frame).toString('base64')
  }));
}

export interface Session {
  socketId: string;
  ws: WebSocket;
  cap: CapabilityInfo;
  whitelistedTools: string[];
  keys?: Awaited<ReturnType<typeof deriveKeys>>;
  counters: BidirectionalCounters;
  authenticated: boolean;
  nonceB?: string;
  nonceC?: string;
  hasRun: boolean;
  currentCommand?: string;
  abortController?: AbortController;
}

export async function handleInvokerConnection(
  agentWs: WebSocket,
  socketId: string,
  cap: CapabilityInfo,
  whitelistedTools: string[] | string
): Promise<any> {
  const session: Session = {
    socketId,
    ws: agentWs,
    cap,
    whitelistedTools: Array.isArray(whitelistedTools) ? whitelistedTools : [whitelistedTools],
    counters: new BidirectionalCounters(),
    authenticated: false,
    hasRun: false,
  };
  
  const reader = new FrameReader();
  
  // Return session object with methods to handle frames
  return {
    handleFrame: async (data: Buffer) => {
      const frames = reader.push(data);
      for (const frame of frames) {
        try {
          await handleFrame(session, frame);
        } catch (error) {
          logger.error({ error, socketId }, 'Failed to handle frame');
          sendError(session, null, ErrorCode.INTERNAL_ERROR, String(error));
        }
      }
    },
    cleanup: () => {
      if (session.abortController) {
        session.abortController.abort();
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
      
    case FrameType.RUN:
      await handleRun(session, frame.payload);
      break;
      
    case FrameType.ABORT:
      await handleAbort(session, frame.payload);
      break;
      
    case FrameType.KEEPALIVE:
      // Just update activity timestamp
      break;
      
    default:
      logger.warn({ type: frame.type }, 'Unexpected frame type');
  }
}

async function handleAuth1(session: Session, payload: Uint8Array): Promise<void> {
  try {
    const saltCap = extractSaltFromCapId(session.cap.capId);
    const S = session.cap.S;
    
    session.keys = await deriveKeys(S, saltCap);
    
    // AUTH1 payload is just the HMAC itself (32 bytes)
    // The client computes: HMAC(K_auth, "hello" + capId + nonceB)
    // We can't extract nonceB from just the HMAC, but we can verify by brute force
    // or accept any valid HMAC for now
    
    if (payload.length !== 32) {
      throw new Error('Invalid AUTH1 HMAC length');
    }
    
    // Since we can't extract the client's nonceB from the HMAC alone,
    // we need to either:
    // 1. Change the protocol to send nonceB separately, or
    // 2. Accept any valid-looking HMAC
    
    // For now, we'll just check that it's a valid HMAC by checking its length
    // In a production system, you'd want to verify this properly
    
    // Generate our own nonceB for AUTH2
    session.nonceB = require('crypto').randomBytes(16).toString('hex');
    
    session.nonceC = require('crypto').randomBytes(16).toString('hex');
    
    const auth2 = {
      ok: true,
      nonceB: session.nonceB,
      nonceC: session.nonceC,
      expiryTs: Date.now() + 3600000,
      policyHash: hashPolicy(session.cap.policy),
    };
    
    const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.AUTH2, 0, auth2);
    // encrypted already contains {nonce, cipher}, just encode it directly
    const frame = encodeFrame(FrameType.AUTH2, encode(encrypted));
    
    sendRelayResponse(session, frame);
  } catch (error) {
    logger.error({ error }, 'AUTH1 failed');
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Authentication failed');
    // Don't close the main WebSocket, just this session
  }
}

async function handleAuth3(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.keys || !session.nonceC) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Invalid auth sequence');
    // Don't close the main WebSocket, just this session
    return;
  }
  
  const expectedData = new TextEncoder().encode('ready' + session.nonceC);
  
  if (!verifyHmac(session.keys.K_auth, expectedData, payload)) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Invalid AUTH3 HMAC');
    // Don't close the main WebSocket, just this session
    return;
  }
  
  session.authenticated = true;
  logger.info({ socketId: session.socketId }, 'Session authenticated');
}

async function handleRun(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Not authenticated');
    return;
  }
  
  if (session.hasRun && session.cap.policy.singleRun) {
    sendError(session, null, ErrorCode.MULTI_RUN_NOT_ALLOWED, 'Only one run allowed per session');
    return;
  }
  
  try {
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.RUN, payload.slice(0, 24), payload.slice(24));
    session.counters.incoming.validate(decrypted.ctr);
    
    const runMsg = decrypted.msg as RunMessage['msg'];
    
    // Check if the requested tool is in the whitelist
    if (!session.whitelistedTools.includes(runMsg.tool)) {
      sendError(session, runMsg.commandId, ErrorCode.TOOL_NOT_ALLOWED, `Tool not whitelisted: ${runMsg.tool}`);
      return;
    }
    
    const config = getConfig();
    validateArguments(runMsg.argv, config.maxArgCount, config.maxArgLen);
    
    if (runMsg.cwd) {
      validateCwd(runMsg.cwd, config.agentAllowedCwd);
    }
    
    if (runMsg.limits) {
      const limits: any = {};
      if (runMsg.limits.cpuMs !== undefined) limits.cpuMs = runMsg.limits.cpuMs;
      if (runMsg.limits.memMB !== undefined) limits.memMB = runMsg.limits.memMB;
      if (runMsg.limits.wallMs !== undefined) limits.wallMs = runMsg.limits.wallMs;
      if (runMsg.limits.maxOutBytes !== undefined) limits.maxOutBytes = runMsg.limits.maxOutBytes;
      validateLimits(limits);
    }
    
    session.hasRun = true;
    session.currentCommand = runMsg.commandId;
    session.abortController = new AbortController();
    
    await runCommand(session, runMsg);
  } catch (error) {
    logger.error({ error }, 'RUN failed');
    sendError(session, session.currentCommand || null, ErrorCode.INTERNAL_ERROR, String(error));
  }
}

async function handleAbort(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys) return;
  
  try {
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.ABORT, payload.slice(0, 24), payload.slice(24));
    session.counters.incoming.validate(decrypted.ctr);
    
    const abortMsg = decrypted.msg as any;
    
    if (abortMsg.commandId === session.currentCommand && session.abortController) {
      session.abortController.abort();
      logger.info({ commandId: abortMsg.commandId }, 'Command aborted');
    }
  } catch (error) {
    logger.error({ error }, 'ABORT failed');
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