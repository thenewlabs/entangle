import WebSocket from 'ws';
import {
  FrameType,
  FrameReader,
  encodeFrame,
  ErrorCode,
} from '@thenewlabs/entangle-protocol';
import {
  deriveKeyMaterial,
  deriveBootstrapKeys,
  deriveSessionKeys,
  extractSaltFromCapId,
  aeadEncrypt,
  aeadDecrypt,
  verifyHmac,
  verifyPassword,
  hashPolicy,
  AeadDir,
  type DerivedKeys,
} from '@thenewlabs/entangle-crypto';
import {
  OutputHandler,
  parseOutputMode,
  BidirectionalCounters,
  StreamCounters,
} from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';
import { randomBytes } from 'crypto';
import type { CapabilityInfo } from './capability.js';
import type { SharedWorkspace } from './shared-workspace.js';
import { handleMultiStreamFrame, cleanupMultiSession } from './multi-session.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// How long an authenticated session is considered valid (advertised to the
// client in AUTH2 so it can reject stale/replayed handshakes).
const SESSION_TTL_MS = 3600_000;

export interface Session {
  socketId: string;
  ws: WebSocket;
  cap: CapabilityInfo;
  K_raw?: Uint8Array;
  bootstrapKeys?: DerivedKeys;
  keys?: DerivedKeys; // session keys, set once nonces are known
  counters: BidirectionalCounters;
  authenticated: boolean;
  passwordVerified: boolean;
  requiresPassword: boolean;
  passwordHash?: string | undefined; // Argon2id encoded string
  nonceB?: string;
  nonceC?: string;
  auth1Seen?: boolean; // one AUTH1 per session to bound Argon2 work
  sharedWorkspace?: SharedWorkspace | undefined; // set when serving a shared workspace
}

// Helper to send wrapped relay responses
export function sendRelayResponse(session: Session, frame: Uint8Array): void {
  session.ws.send(JSON.stringify({
    type: 'RELAY_RESPONSE',
    socketId: session.socketId,
    frame: Buffer.from(frame).toString('base64'),
  }));
}

// NOTE: synchronous on purpose. The caller must register the returned session
// before the next relay message is processed; an `await` here would defer that
// by a microtask and drop the AUTH1 that the client sends immediately after
// connecting (breaking concurrent sessions on the same capability).
export function handleInvokerConnection(
  agentWs: WebSocket,
  socketId: string,
  cap: CapabilityInfo,
  passwordHash?: string,
  sharedWorkspace?: SharedWorkspace
): { handleFrame: (data: Buffer) => Promise<void>; cleanup: () => void } {
  const session: Session = {
    socketId,
    ws: agentWs,
    cap,
    counters: new BidirectionalCounters(),
    authenticated: false,
    passwordVerified: !passwordHash, // If no password, consider it verified
    requiresPassword: !!passwordHash,
    passwordHash: passwordHash || undefined,
    sharedWorkspace,
  };

  const reader = new FrameReader();
  const store: { multiSession?: any } = {};

  return {
    handleFrame: async (data: Buffer) => {
      const frames = reader.push(data);
      for (const frame of frames) {
        try {
          await handleFrame(session, store, frame);
        } catch (error) {
          output.error(`Failed to handle frame for socket ${socketId}`, error instanceof Error ? error.message : String(error));
          sendError(session, null, ErrorCode.INTERNAL_ERROR, 'Internal error');
        }
      }
    },
    cleanup: () => {
      if (store.multiSession) {
        try {
          cleanupMultiSession(store.multiSession);
        } catch {}
      }
    },
  };
}

const STREAM_FRAME_TYPES = new Set<FrameType>([
  FrameType.STREAM_OPEN,
  FrameType.STREAM_DATA,
  FrameType.STREAM_RESIZE,
  FrameType.STREAM_SIGNAL,
  FrameType.STREAM_CLOSE,
  FrameType.STREAM_ERROR,
  FrameType.STREAM_EXIT,
  // Shared-workspace window control rides the same multi-session handler.
  FrameType.WINDOW_CTL,
]);

async function handleFrame(
  session: Session,
  store: { multiSession?: any },
  frame: { type: FrameType; payload: Uint8Array }
): Promise<void> {
  if (STREAM_FRAME_TYPES.has(frame.type)) {
    if (!session.authenticated || !session.keys) {
      output.error(`Received stream frame before authentication: type=${frame.type}`);
      return;
    }

    if (!store.multiSession) {
      store.multiSession = {
        socketId: session.socketId,
        ws: session.ws,
        cap: session.cap,
        keys: session.keys,
        counters: session.counters,
        streamCounters: new StreamCounters(),
        authenticated: true,
        requiresPassword: session.requiresPassword,
        passwordVerified: session.passwordVerified,
        sharedWorkspace: session.sharedWorkspace,
        sharedViewers: new Set<string>(),
      };
    }
    // Keep dynamic gating fields fresh (password may be verified after streams open attempts)
    store.multiSession.passwordVerified = session.passwordVerified;

    await handleMultiStreamFrame(store.multiSession, frame);
    return;
  }

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
    case FrameType.KEEPALIVE:
      break;
    default:
      output.warn(`Unexpected frame type: ${frame.type}`);
  }
}

async function handleAuth1(session: Session, payload: Uint8Array): Promise<void> {
  // Bound the expensive Argon2 derivation to a single attempt per connection so
  // a client that only knows capId cannot queue unbounded key-derivation work.
  // (Connection setup is separately rate-limited per IP at the relay.)
  if (session.auth1Seen) {
    output.warn(`Ignoring repeat AUTH1 for socket ${session.socketId}`);
    return;
  }
  session.auth1Seen = true;

  // Cheap structural checks BEFORE any key derivation. AUTH1 payload is
  // HMAC(32 bytes) || nonceB, and nonceB is a 16-byte hex string (32 chars).
  const EXPECTED_NONCE_LEN = 32;
  if (payload.length !== 32 + EXPECTED_NONCE_LEN) {
    output.warn(`Rejecting malformed AUTH1 for socket ${session.socketId}: len=${payload.length}`);
    return;
  }

  try {
    const saltCap = extractSaltFromCapId(session.cap.capId);
    const K_raw = await deriveKeyMaterial(session.cap.S, saltCap);
    session.K_raw = K_raw;
    session.bootstrapKeys = deriveBootstrapKeys(K_raw);

    const receivedHmac = payload.slice(0, 32);
    const nonceBBytes = payload.slice(32);
    session.nonceB = new TextDecoder().decode(nonceBBytes);

    const auth1Data = new TextEncoder().encode('hello' + session.cap.capId + session.nonceB);
    if (!verifyHmac(session.bootstrapKeys.K_auth, auth1Data, receivedHmac)) {
      throw new Error('AUTH1 HMAC verification failed');
    }

    // Fresh session nonce and per-session keys bound to (nonceB, nonceC).
    session.nonceC = randomBytes(16).toString('hex');
    session.keys = deriveSessionKeys(K_raw, session.nonceB, session.nonceC);

    const auth2 = {
      ok: true,
      nonceB: session.nonceB,
      nonceC: session.nonceC,
      expiryTs: Date.now() + SESSION_TTL_MS,
      policyHash: hashPolicy(session.cap.policy),
      requiresPassword: session.requiresPassword,
    };

    // AUTH2 is protected with the BOOTSTRAP key: the client cannot derive the
    // session key until it has learned nonceC from this very message.
    const encrypted = aeadEncrypt(session.bootstrapKeys.K_enc, FrameType.AUTH2, 0, auth2, AeadDir.ServerToClient);
    const frame = encodeFrame(FrameType.AUTH2, encode(encrypted));
    sendRelayResponse(session, frame);
  } catch (error) {
    output.error('AUTH1 failed', error instanceof Error ? error.message : String(error));
    // No session key yet on failure paths; nothing encryptable to send.
  }
}

async function handleAuth3(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.keys || !session.nonceC) {
    output.error('AUTH3 received out of sequence');
    return;
  }

  // AUTH3 HMAC is keyed with the SESSION auth key, binding the client's
  // handshake completion to the fresh per-session key material.
  const expectedData = new TextEncoder().encode('ready' + session.nonceC);
  if (!verifyHmac(session.keys.K_auth, expectedData, payload)) {
    output.error('AUTH3 HMAC verification failed');
    return;
  }

  session.authenticated = true;
  output.info(`Session authenticated: ${session.socketId}`);
}

async function handleAuthPw(session: Session, payload: Uint8Array): Promise<void> {
  if (!session.authenticated || !session.keys) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Not authenticated');
    return;
  }
  if (!session.requiresPassword || !session.passwordHash) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Password not required');
    return;
  }
  if (session.passwordVerified) {
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Already verified');
    return;
  }

  try {
    const encrypted = decode(payload) as any;
    const decrypted = aeadDecrypt(session.keys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher, AeadDir.ClientToServer);
    session.counters.incoming.validate(decrypted.ctr);

    const { password } = decrypted.msg as { password?: string };
    const ok = typeof password === 'string' && await verifyPassword(session.passwordHash, password);
    if (!ok) {
      output.warn(`Invalid password attempt for session: ${session.socketId}`);
      sendError(session, null, ErrorCode.AUTH_FAILED, 'Invalid password');
      return;
    }

    session.passwordVerified = true;
    output.info(`Password verified for session: ${session.socketId}`);

    const ctr = session.counters.outgoing.next();
    const successEncrypted = aeadEncrypt(session.keys.K_enc, FrameType.AUTH_PW, ctr, { ok: true }, AeadDir.ServerToClient);
    sendRelayResponse(session, encodeFrame(FrameType.AUTH_PW, encode(successEncrypted)));
  } catch (error) {
    output.error('AUTH_PW failed', error instanceof Error ? error.message : String(error));
    sendError(session, null, ErrorCode.AUTH_FAILED, 'Password verification failed');
  }
}

function sendError(session: Session, commandId: string | null, code: string, detail?: string): void {
  if (!session.keys) return;
  const ctr = session.counters.outgoing.next();
  const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.ERROR, ctr, { commandId, code, detail }, AeadDir.ServerToClient);
  sendRelayResponse(session, encodeFrame(FrameType.ERROR, encode(encrypted)));
}
