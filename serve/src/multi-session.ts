import WebSocket from 'ws';
import {
  FrameType,
  encodeFrame,
  StreamOpenMessage,
  StreamDataMessage,
  StreamResizeMessage,
  StreamSignalMessage,
  StreamCloseMessage,
  StreamOpenedMessage,
  StreamExitMessage,
  StreamClosedMessage,
  StreamErrorMessage,
  WindowCtlOpMessageSchema,
  type WindowCtlOpMessage,
  type WindowStateBody,
} from '@thenewlabs/entangle-protocol';
import {
  deriveKeys,
  streamAeadEncrypt,
  streamAeadDecrypt,
  frameAad,
  AeadDir,
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
import { StreamManager } from './stream-manager.js';
import type { CapabilityInfo } from './capability.js';
import type { SharedWorkspace } from './shared-workspace.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export interface MultiSession {
  socketId: string;
  ws: WebSocket;
  cap: CapabilityInfo;
  keys?: Awaited<ReturnType<typeof deriveKeys>>;
  counters: BidirectionalCounters; // For auth and legacy mode
  streamCounters: StreamCounters; // Per-stream counters
  authenticated: boolean;
  // Password-gating state propagated from legacy session/auth handler
  requiresPassword?: boolean;
  passwordVerified?: boolean;
  nonceB?: string;
  nonceC?: string;
  streamManager?: StreamManager;
  // Registered forwarded-channel endpoints (allow-list) threaded from agent
  // state; passed to the StreamManager for `mode: 'pipe'` opens.
  pipeEndpoints?: Map<string, PipeEndpoint>;
  terminated?: boolean;
  // Shared-workspace mode: a tmux-style set of windows that every client's
  // viewport binds to. When set, a `pty` STREAM_OPEN binds a viewport to the
  // workspace (multiplexing the active window) instead of spawning a fresh
  // shell, `sharedViewers` tracks this session's viewport sids so their
  // data/close route there, and WINDOW_CTL frames drive window operations.
  sharedWorkspace?: SharedWorkspace | undefined;
  sharedViewers?: Set<string>;
}

// Tear down a single invoker session on a protocol/counter error WITHOUT
// closing session.ws — that socket is the shared agent-to-relay control
// connection carrying every invoker. Killing it here would take down all of
// them, so instead we close just this session's streams, mark it terminated so
// further frames are ignored, and let the relay's idle timeout drop the peer.
function terminateSession(session: MultiSession, reason: string): void {
  if (session.terminated) return;
  session.terminated = true;
  output.warn(`Terminating invoker session ${session.socketId}: ${reason}`);
  if (session.streamManager) {
    try { session.streamManager.closeAllStreams(reason); } catch {}
  }
}

// Helper to send encrypted messages with per-stream counters
async function sendEncrypted(
  session: MultiSession,
  frameType: FrameType,
  message: any,
  sid?: string
): Promise<void> {
  if (!session.keys) {
    throw new Error('Session not authenticated');
  }

  // If we have a stream ID, update the counter
  if (sid && 'ctr' in message) {
    message.ctr = session.streamCounters.increment(sid, 'outgoing');
  }

  const plaintext = encode(message);
  const aad = frameAad(frameType, AeadDir.ServerToClient);
  const ciphertext = await streamAeadEncrypt(session.keys.K_enc, plaintext, aad);
  const frame = encodeFrame(frameType, ciphertext);

  // Relay via server: wrap in JSON envelope so the server can
  // forward to the correct invoker socket.
  try {
    const envelope = {
      type: 'RELAY_RESPONSE',
      socketId: session.socketId,
      frame: Buffer.from(frame).toString('base64'),
    };
    (session.ws as any).send(JSON.stringify(envelope));
  } catch {
    // Best-effort fallback: avoid crashing handler on send errors
  }
}

// Bind a client viewport to the shared workspace instead of spawning a new
// shell. The workspace multiplexes the ACTIVE window's output onto this sid and
// repaints it on a window switch; window-state is pushed via WINDOW_CTL.
//
// Ordering matters: the 'opened' confirmation and the replay snapshot must be
// the first frames the client sees for this sid, so any live output produced
// during setup is buffered and flushed only after they are sent.
async function handleSharedAttach(
  session: MultiSession,
  _message: StreamOpenMessage
): Promise<void> {
  const workspace = session.sharedWorkspace!;
  const sid = randomBytes(8).toString('base64url');
  if (!session.sharedViewers) session.sharedViewers = new Set<string>();
  session.sharedViewers.add(sid);

  let live = false;
  const pending: Uint8Array[] = [];

  const { replay } = workspace.attachViewport({
    sid,
    onData: (chunk) => {
      if (!live) { pending.push(chunk); return; }
      void sendStreamData(session, sid, chunk, 'stdout');
    },
    onExit: (code, signal) => {
      session.sharedViewers?.delete(sid);
      void sendStreamExit(session, sid, code, signal);
    },
    onWindowState: (state) => { void sendWindowState(session, state); },
  });

  // Confirm the open with the agent-assigned sid (first frame for this sid).
  const openedMsg: StreamOpenedMessage = {
    ctr: 0,
    msg: { v: 1, kind: 'opened', sid, startedAt: Date.now(), mode: 'pty' },
  };
  await sendEncrypted(session, FrameType.STREAM_OPEN, openedMsg, sid);

  // Sync the late joiner's screen with the active window's recent scrollback.
  if (replay.length > 0) {
    await sendStreamData(session, sid, replay, 'stdout');
  }

  // Go live and flush anything captured during setup, preserving order.
  live = true;
  for (const chunk of pending) {
    await sendStreamData(session, sid, chunk, 'stdout');
  }

  // Populate the client's tab bar with THIS viewport's own window state (its
  // active index), not the host's global view.
  await sendWindowState(session, workspace.windowStateForViewport(sid));
}

// This viewer's pty viewport sid — the key its per-viewport window ops apply to.
// A session's `sharedViewers` holds only pty-viewport sids (they are added only
// in handleSharedAttach), so the first one is the pty viewport.
function ptyViewportSid(session: MultiSession): string | undefined {
  if (!session.sharedViewers) return undefined;
  for (const sid of session.sharedViewers) return sid;
  return undefined;
}

// Handle stream open request
async function handleStreamOpen(
  session: MultiSession,
  message: StreamOpenMessage
): Promise<void> {
  // In shared-workspace mode a PTY open binds a viewport to the workspace; a
  // 'cmd' open still spawns normally so one-off `connect <url> ls` keeps working.
  if (session.sharedWorkspace && message.msg?.mode === 'pty') {
    await handleSharedAttach(session, message);
    return;
  }

  if (!session.streamManager) {
    session.streamManager = new StreamManager({
      policy: session.cap.policy,
      output,
      ...(session.pipeEndpoints && { pipeEndpoints: session.pipeEndpoints }),
      onStreamData: async (sid, data, channel) => {
        await sendStreamData(session, sid, data, channel);
      },
      onStreamExit: async (sid, code, signal, usage) => {
        await sendStreamExit(session, sid, code, signal, usage);
      },
      onStreamError: async (sid, error) => {
        await sendStreamError(session, sid, error);
      },
    });
  }

  try {
    const { mode, pty, exec, pipe } = message.msg;
    let actualSid: string;

    if (mode === 'pty' && pty) {
      const ptyOptions: any = {
        cols: pty.cols,
        rows: pty.rows,
      };
      if (pty.env) {
        ptyOptions.env = pty.env;
      }
      if (exec?.cwd) {
        ptyOptions.cwd = exec.cwd;
      }
      actualSid = await session.streamManager.openPtyStream(ptyOptions);
    } else if (mode === 'cmd' && exec) {
      const cmdOptions: any = {
        argv: exec.argv,
      };
      if (exec.cwd) {
        cmdOptions.cwd = exec.cwd;
      }
      if (exec.env) {
        cmdOptions.env = exec.env;
      }
      if (exec.stdin !== undefined) {
        cmdOptions.stdin = exec.stdin;
      }
      actualSid = await session.streamManager.openCmdStream(cmdOptions);
    } else if (mode === 'pipe' && pipe) {
      actualSid = await session.streamManager.openPipeStream({ name: pipe.name });
    } else {
      throw new Error(`Invalid stream configuration for mode ${mode}`);
    }

    // Send opened confirmation
    const openedMsg: StreamOpenedMessage = {
      ctr: 0, // Will be set by sendEncrypted
      msg: {
        v: 1,
        kind: 'opened',
        sid: actualSid,
        startedAt: Date.now(),
        mode,
      },
    };

    await sendEncrypted(session, FrameType.STREAM_OPEN, openedMsg, actualSid);
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream data (stdin)
async function handleStreamData(
  session: MultiSession,
  message: StreamDataMessage
): Promise<void> {
  // Collaborative input: a viewport's keystrokes merge into the ACTIVE window.
  if (session.sharedViewers?.has(message.msg.sid)) {
    session.sharedWorkspace?.writeFromViewport(message.msg.sid, message.msg.chunk);
    return;
  }

  if (!session.streamManager) {
    await sendStreamError(session, message.msg.sid, 'No active streams');
    return;
  }

  try {
    session.streamManager.writeToStream(message.msg.sid, message.msg.chunk);
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream resize (PTY only)
async function handleStreamResize(
  session: MultiSession,
  message: StreamResizeMessage
): Promise<void> {
  // The host terminal owns the shared shell's size, so a viewer resize must NOT
  // resize the shared PTY (participants would fight over dimensions). Instead,
  // repaint just this viewport with the active window's screen so its locally
  // reflowed/corrupted display is redrawn clean at its new size. Use the
  // SCREEN repaint (no \x1b[3J): the viewer keeps its own accumulated xterm
  // scrollback, so a resize must redraw the visible screen only, NOT erase the
  // history the client is holding (a window switch is what wipes+rebuilds it).
  if (session.sharedViewers?.has(message.msg.sid)) {
    session.sharedWorkspace?.repaintViewportScreen(message.msg.sid);
    return;
  }

  if (!session.streamManager) {
    await sendStreamError(session, message.msg.sid, 'No active streams');
    return;
  }

  try {
    session.streamManager.resizePtyStream(
      message.msg.sid,
      message.msg.cols,
      message.msg.rows
    );
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream signal
async function handleStreamSignal(
  session: MultiSession,
  message: StreamSignalMessage
): Promise<void> {
  // In the shared shell, control chars (e.g. Ctrl-C) arrive as raw data and are
  // written through; explicit signal frames from a viewer are ignored so one
  // participant can't kill the shell out from under the others.
  if (session.sharedViewers?.has(message.msg.sid)) return;

  if (!session.streamManager) {
    await sendStreamError(session, message.msg.sid, 'No active streams');
    return;
  }

  try {
    session.streamManager.signalStream(message.msg.sid, message.msg.signal);
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream close
async function handleStreamClose(
  session: MultiSession,
  message: StreamCloseMessage
): Promise<void> {
  // A viewport leaving the shared workspace just detaches — the windows keep
  // running for everyone else.
  if (session.sharedViewers?.has(message.msg.sid)) {
    session.sharedViewers.delete(message.msg.sid);
    session.sharedWorkspace?.detachViewport(message.msg.sid);
    const closedMsg: StreamClosedMessage = {
      ctr: 0,
      msg: { v: 1, kind: 'closed', sid: message.msg.sid },
    };
    await sendEncrypted(session, FrameType.STREAM_CLOSE, closedMsg, message.msg.sid);
    session.streamCounters.removeStream(message.msg.sid);
    return;
  }

  if (!session.streamManager) {
    return;
  }

  session.streamManager.closeStream(message.msg.sid, 'Client requested close');

  // Send closed confirmation
  const closedMsg: StreamClosedMessage = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1,
      kind: 'closed',
      sid: message.msg.sid,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_CLOSE, closedMsg, message.msg.sid);
  // Clean up stream counters
  session.streamCounters.removeStream(message.msg.sid);
}

// Send stream data to client
async function sendStreamData(
  session: MultiSession,
  sid: string,
  data: Uint8Array,
  channel: 'stdout' | 'stderr' = 'stdout'
): Promise<void> {
  const msg = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1 as const,
      kind: 'data' as const,
      sid,
      chunk: data,
      channel,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_DATA, msg, sid);
}

// Send stream exit to client
async function sendStreamExit(
  session: MultiSession,
  sid: string,
  code: number | null,
  signal: string | null,
  usage?: any
): Promise<void> {
  const msg: StreamExitMessage = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1,
      kind: 'exit',
      sid,
      code,
      signal,
      usage,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_EXIT, msg, sid);
  // Clean up stream counters after exit
  session.streamCounters.removeStream(sid);
}

// Send stream error to client
async function sendStreamError(
  session: MultiSession,
  sid: string,
  error: string
): Promise<void> {
  const msg: StreamErrorMessage = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1,
      kind: 'error',
      sid,
      message: error,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_ERROR, msg, sid);
}

// Send a window-state broadcast to this client's viewport(s). WINDOW_CTL frames
// are not stream-scoped, so they ride the session GLOBAL counter (the same
// sequence AUTH_PW / ERROR use), not a per-stream counter.
async function sendWindowState(
  session: MultiSession,
  state: WindowStateBody
): Promise<void> {
  const msg = {
    ctr: session.counters.outgoing.next(),
    msg: state,
  };
  await sendEncrypted(session, FrameType.WINDOW_CTL, msg);
}

// Handle a client->server window operation (WINDOW_CTL). Window ops drive THIS
// viewer's OWN active window (keyed by its pty-viewport sid), so viewers can sit
// on different windows independently; the workspace pushes each affected
// viewport its own window-state and repaints. Rename mutates the shared window
// list, so it stays global and re-broadcasts to everyone.
async function handleWindowCtl(
  session: MultiSession,
  message: WindowCtlOpMessage
): Promise<void> {
  const workspace = session.sharedWorkspace;
  if (!workspace) return;
  const sid = ptyViewportSid(session);
  const op = message.msg;
  switch (op.op) {
    case 'new-window': if (sid) workspace.newWindowForViewport(sid); break;
    case 'next-window': if (sid) workspace.nextWindowForViewport(sid); break;
    case 'prev-window': if (sid) workspace.prevWindowForViewport(sid); break;
    case 'select-window': if (sid) workspace.selectWindowForViewport(sid, op.index); break;
    case 'close-window': if (sid) workspace.closeWindowFromViewport(sid, op.index); break;
    case 'rename-window': workspace.renameWindow(op.index, op.title); break;
  }
}

// Main frame handler for multi-stream protocol
export async function handleMultiStreamFrame(
  session: MultiSession,
  frame: { type: FrameType; payload: Uint8Array }
): Promise<void> {
  if (session.terminated) return;

  if (!session.authenticated) {
    terminateSession(session, 'Frame received before authentication');
    return;
  }

  if (!session.keys) {
    throw new Error('Keys not derived');
  }

  try {
    // Single canonical decryption: session key + direction-bound AAD. Frames
    // that don't authenticate under exactly this AAD are rejected (no
    // downgrade/alternate-AAD fallbacks).
    const aad = frameAad(frame.type, AeadDir.ClientToServer);
    const plaintext = await streamAeadDecrypt(session.keys.K_enc, frame.payload, aad);
    const message: any = decode(plaintext);

    // Bounded structural validation before we trust any field. A decoded value
    // that is not a well-formed envelope terminates only this invoker session.
    if (!message || typeof message !== 'object' || typeof message.ctr !== 'number') {
      terminateSession(session, 'Malformed message envelope');
      return;
    }

    // For stream messages, verify per-stream counter
    if (message.msg && typeof message.msg.sid === 'string') {
      const sid = message.msg.sid;
      const expectedCounter = session.streamCounters.getNext(sid, 'incoming');
      if (message.ctr !== expectedCounter) {
        terminateSession(session, `Stream counter mismatch for ${sid}: expected=${expectedCounter}, received=${message.ctr}`);
        return;
      }
      session.streamCounters.increment(sid, 'incoming');
    } else {
      // Non-stream messages use global counter
      try {
        session.counters.incoming.validate(message.ctr);
      } catch (err: any) {
        terminateSession(session, `Counter mismatch: ${err.message}`);
        return;
      }
    }

    // Enforce password verification for all stream operations when required
    const pwRequiredButMissing = !!session.requiresPassword && !session.passwordVerified;

    // Handle frame based on type
    switch (frame.type) {
      case FrameType.STREAM_OPEN:
        if (pwRequiredButMissing) {
          // Block stream open and notify client
          try {
            const sid = (message as StreamOpenMessage).msg?.sid;
            if (sid) await sendStreamError(session, sid, 'Password verification required');
          } catch {}
          return;
        }
        await handleStreamOpen(session, message as StreamOpenMessage);
        break;

      case FrameType.STREAM_DATA:
        if (pwRequiredButMissing) {
          try {
            const sid = (message as StreamDataMessage).msg?.sid;
            if (sid) await sendStreamError(session, sid, 'Password verification required');
          } catch {}
          return;
        }
        await handleStreamData(session, message as StreamDataMessage);
        break;

      case FrameType.STREAM_RESIZE:
        if (pwRequiredButMissing) {
          try {
            const sid = (message as StreamResizeMessage).msg?.sid;
            if (sid) await sendStreamError(session, sid, 'Password verification required');
          } catch {}
          return;
        }
        await handleStreamResize(session, message as StreamResizeMessage);
        break;

      case FrameType.STREAM_SIGNAL:
        if (pwRequiredButMissing) {
          try {
            const sid = (message as StreamSignalMessage).msg?.sid;
            if (sid) await sendStreamError(session, sid, 'Password verification required');
          } catch {}
          return;
        }
        await handleStreamSignal(session, message as StreamSignalMessage);
        break;

      case FrameType.STREAM_CLOSE:
        if (pwRequiredButMissing) {
          try {
            const sid = (message as StreamCloseMessage).msg?.sid;
            if (sid) await sendStreamError(session, sid, 'Password verification required');
          } catch {}
          return;
        }
        await handleStreamClose(session, message as StreamCloseMessage);
        break;

      case FrameType.WINDOW_CTL: {
        if (pwRequiredButMissing) return;
        // Window ops are not stream-scoped; validate the op envelope with zod
        // and ignore anything malformed/unknown (forward-compatible with newer
        // clients) rather than tearing down the session.
        const parsed = WindowCtlOpMessageSchema.safeParse(message);
        if (!parsed.success) {
          output.warn(`Ignoring malformed WINDOW_CTL op: ${parsed.error.message}`);
          return;
        }
        await handleWindowCtl(session, parsed.data);
        break;
      }

      case FrameType.KEEPALIVE:
        // Echo keepalive back
        await sendEncrypted(session, FrameType.KEEPALIVE, message);
        break;

      default:
        output.warn(`Unknown frame type in multi-stream mode: ${frame.type}`);
    }
  } catch (error: any) {
    output.error(`Error handling multi-stream frame type ${frame.type}`, error.message);
    terminateSession(session, 'Protocol error');
  }
}

// Clean up session
export function cleanupMultiSession(session: MultiSession): void {
  // Detach this invoker's viewports from the workspace without killing windows.
  if (session.sharedViewers && session.sharedWorkspace) {
    for (const sid of session.sharedViewers) {
      session.sharedWorkspace.detachViewport(sid);
    }
    session.sharedViewers.clear();
  }
  if (session.streamManager) {
    session.streamManager.closeAllStreams('Session cleanup');
  }
}
