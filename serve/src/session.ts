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
  type PipeEndpoint,
} from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';
import { randomBytes } from 'crypto';
import type { CapabilityInfo } from './capability.js';
import type { SharedWorkspace } from './shared-workspace.js';
import { handleMultiStreamFrame, cleanupMultiSession, type WorkspaceResolver } from './multi-session.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// How long an authenticated session is considered valid (advertised to the
// client in AUTH2 so it can reject stale/replayed handshakes).
const SESSION_TTL_MS = 3600_000;

/**
 * How many failed AUTH_PW attempts one invoker connection may make before the
 * session is terminated.
 *
 * Two problems this bounds, both of which were previously UNBOUNDED once a
 * client had completed AUTH1/2/3 (which only proves it holds `S`, i.e. the
 * capability URL — the password is the SECOND factor and was guessable for
 * free):
 *
 *  • Brute force. Nothing capped guesses per connection, so a holder of the
 *    URL could stream password attempts down a single authenticated socket.
 *  • DoS. Every attempt runs `verifyPassword` = Argon2id at interactive limits
 *    — ~64 MiB and hundreds of ms of CPU EACH. A few concurrent sockets
 *    spraying guesses is a memory/CPU exhaustion vector against the agent host.
 *
 * `handleAuth1` already bounds the OTHER Argon2 cost (key derivation) to one
 * per socket; this is the matching bound for the verification cost. Beyond it,
 * an attacker must pay a fresh relay connection + handshake per N guesses, and
 * connection setup is separately rate-limited per IP at the relay.
 */
export const MAX_PASSWORD_ATTEMPTS = 5;

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
  /** Failed AUTH_PW attempts on this connection; see {@link MAX_PASSWORD_ATTEMPTS}. */
  passwordAttempts: number;
  /**
   * Set once the session is dead to this agent (currently: too many failed
   * password attempts). Every subsequent frame on this socket is dropped, so the
   * only way forward is a fresh relay connection + handshake.
   */
  terminated?: boolean;
  nonceB?: string;
  nonceC?: string;
  auth1Seen?: boolean; // one AUTH1 per session to bound Argon2 work
  // Registered forwarded-channel endpoints (allow-list) for `mode: 'pipe'`.
  pipeEndpoints?: Map<string, PipeEndpoint>;
  // Set when serving shared workspace(s): resolves the workspace a pty viewport
  // binds to from the key+cwd in its open message (multi-workspace); a constant
  // resolver returning one workspace is the single-workspace back-compat path.
  getWorkspace?: WorkspaceResolver | undefined;
  // PIPES-ONLY capability: when true, only `mode: 'pipe'` STREAM_OPENs are served
  // — `pty` and `cmd` are refused. This is what makes a capability that advertises
  // a single forwarded channel (e.g. Locus's scoped chat-bridge cap) grant ONLY
  // that channel and never shell/exec access on the box. Defaults to false (the
  // pre-existing behavior: a cap holder may open pty/cmd).
  pipesOnly?: boolean;
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
  pipeEndpoints?: Map<string, PipeEndpoint>,
  getWorkspace?: WorkspaceResolver,
  pipesOnly?: boolean
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
    passwordAttempts: 0,
    ...(pipeEndpoints && { pipeEndpoints }),
    getWorkspace,
    ...(pipesOnly ? { pipesOnly: true } : {}),
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
  // KEEPALIVE too: the multi-session handler ECHOES it (the local switch below only `break`s,
  // so keepalives went unanswered and the client's liveness watchdog force-closed every idle
  // connection ~45s later — a reconnect storm on any preview/workbench left sitting). Routing it
  // here also keeps the session-global counter consistent (the client counts keepalives in its
  // outgoing counter; the serve must validate+count them the same way, exactly like WINDOW_CTL).
  FrameType.KEEPALIVE,
]);

async function handleFrame(
  session: Session,
  store: { multiSession?: any },
  frame: { type: FrameType; payload: Uint8Array }
): Promise<void> {
  // A terminated session is dead to us: drop EVERYTHING, including further AUTH*
  // frames, so a locked-out guesser cannot keep spending Argon2 on this socket.
  if (session.terminated) return;

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
        ...(session.pipeEndpoints && { pipeEndpoints: session.pipeEndpoints }),
        getWorkspace: session.getWorkspace,
        ...(session.pipesOnly ? { pipesOnly: true } : {}),
        viewerWorkspaces: new Map<string, SharedWorkspace>(),
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
      await handleAuthPw(session, store, frame.payload);
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

/**
 * Terminate a session after an abuse threshold is hit: tear down any streams it
 * opened and mark it dead so `handleFrame` drops every later frame.
 *
 * The agent cannot close the invoker's relay socket (the WS it holds is its OWN
 * multiplexed link to the relay — closing that would drop every other session),
 * so termination is enforced agent-side by refusing to process the socket
 * further. The client observes silence, its liveness watchdog fires, and it must
 * reconnect — which is exactly the cost we want to impose per N guesses.
 */
function terminateSession(session: Session, store: { multiSession?: any }, reason: string): void {
  if (session.terminated) return;
  session.terminated = true;
  output.warn(`Terminating session ${session.socketId}: ${reason}`);
  if (store.multiSession) {
    try {
      cleanupMultiSession(store.multiSession);
    } catch { /* best effort */ }
    store.multiSession = undefined;
  }
}

/**
 * Verify the second-factor password. Exported for unit tests, which drive it
 * directly rather than paying a full Argon2id AUTH1 handshake per case.
 */
export async function handleAuthPw(
  session: Session,
  store: { multiSession?: any },
  payload: Uint8Array
): Promise<void> {
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
      failPasswordAttempt(session, store, 'Invalid password');
      return;
    }

    session.passwordVerified = true;
    output.info(`Password verified for session: ${session.socketId}`);

    const ctr = session.counters.outgoing.next();
    const successEncrypted = aeadEncrypt(session.keys.K_enc, FrameType.AUTH_PW, ctr, { ok: true }, AeadDir.ServerToClient);
    sendRelayResponse(session, encodeFrame(FrameType.AUTH_PW, encode(successEncrypted)));
  } catch (error) {
    // A malformed/undecryptable AUTH_PW counts too: it is indistinguishable from
    // probing, and leaving it uncounted would be a trivial way to sit on a socket.
    output.error('AUTH_PW failed', error instanceof Error ? error.message : String(error));
    failPasswordAttempt(session, store, 'Password verification failed');
  }
}

/**
 * Record one failed password attempt, report it, and terminate the session once
 * {@link MAX_PASSWORD_ATTEMPTS} is reached.
 *
 * The error detail deliberately stays generic ('Invalid password' / the lockout
 * notice) — it never reveals whether the password was close, and the lockout
 * notice is sent BEFORE termination so a legitimate user's UI can explain the
 * reconnect rather than hanging on silence.
 */
function failPasswordAttempt(
  session: Session,
  store: { multiSession?: any },
  detail: string
): void {
  session.passwordAttempts += 1;
  const remaining = MAX_PASSWORD_ATTEMPTS - session.passwordAttempts;
  output.warn(
    `Invalid password attempt ${session.passwordAttempts}/${MAX_PASSWORD_ATTEMPTS} for session: ${session.socketId}`
  );
  if (remaining > 0) {
    sendError(session, null, ErrorCode.AUTH_FAILED, detail);
    return;
  }
  sendError(session, null, ErrorCode.AUTH_FAILED, 'Too many password attempts; reconnect to try again');
  terminateSession(session, store, 'too many failed password attempts');
}

function sendError(session: Session, commandId: string | null, code: string, detail?: string): void {
  if (!session.keys) return;
  const ctr = session.counters.outgoing.next();
  const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.ERROR, ctr, { commandId, code, detail }, AeadDir.ServerToClient);
  sendRelayResponse(session, encodeFrame(FrameType.ERROR, encode(encrypted)));
}
