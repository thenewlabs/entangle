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

/**
 * Resolves the {@link SharedWorkspace} a pty viewport binds to, from an optional
 * workspace KEY and initial CWD carried in the pty STREAM_OPEN. Injected by the
 * embedder (via `startAgent`) to enable MULTI-WORKSPACE hosting over a single
 * capability/connection: each distinct key selects its own durable workspace,
 * lazily created with `cwd` on first use.
 *
 * When `key` is undefined/absent the resolver MUST return the single default
 * workspace — this is the back-compat path (one shared workspace, exactly the
 * pre-multi-workspace behavior). `entangle serve`'s own CLI/daemon inject a
 * constant resolver that ignores both arguments and always returns their one
 * `SharedWorkspace`.
 */
export type WorkspaceResolver = (
  key: string | undefined,
  cwd: string | undefined
) => SharedWorkspace;

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
  // Shared-workspace mode: when a resolver is set, a `pty` STREAM_OPEN binds a
  // viewport to a SharedWorkspace (multiplexing the active window) instead of
  // spawning a fresh shell. The resolver picks WHICH workspace from the key+cwd
  // in the open message, so one connection can host several workspaces at once
  // (multi-workspace); with no key it returns the single default workspace
  // (back-compat). `viewerWorkspaces` maps each of this session's pty-viewport
  // sids to the workspace it attached to, so data/resize/close/window-ops route
  // to the correct workspace by sid.
  getWorkspace?: WorkspaceResolver | undefined;
  viewerWorkspaces?: Map<string, SharedWorkspace>;
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
  message: StreamOpenMessage
): Promise<void> {
  // Multi-workspace selection: the workspace KEY and initial CWD ride the pty
  // open's `exec` field — argv[0] is the key (a Locus tab id), `cwd` the tab's
  // directory. Absent/empty argv → key undefined → the resolver's default
  // workspace (back-compat with clients that send no key). argv beyond [0] is
  // ignored here: in shared mode it is never executed as a command.
  const exec = message.msg?.exec;
  const key = exec?.argv && exec.argv.length > 0 ? exec.argv[0] : undefined;
  const cwd = exec?.cwd;
  const workspace = session.getWorkspace!(key, cwd);
  const sid = randomBytes(8).toString('base64url');
  if (!session.viewerWorkspaces) session.viewerWorkspaces = new Map<string, SharedWorkspace>();
  session.viewerWorkspaces.set(sid, workspace);

  let live = false;
  const pending: Uint8Array[] = [];

  const { replay } = workspace.attachViewport({
    sid,
    onData: (chunk) => {
      if (!live) { pending.push(chunk); return; }
      void sendStreamData(session, sid, chunk, 'stdout');
    },
    onExit: (code, signal) => {
      session.viewerWorkspaces?.delete(sid);
      void sendStreamExit(session, sid, code, signal);
    },
    onWindowState: (state) => { void sendWindowState(session, sid, state); },
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
  await sendWindowState(session, sid, workspace.windowStateForViewport(sid));
}

// Fallback viewport sid for a window op that carried no explicit `sid` (a legacy
// single-viewport client). A session's `viewerWorkspaces` holds only pty-viewport
// sids (added only in handleSharedAttach), so the first one is the pty viewport.
// Multi-viewport clients always send an explicit sid, so this fallback only ever
// fires for the single-viewport back-compat case.
function firstViewerSid(session: MultiSession): string | undefined {
  if (!session.viewerWorkspaces) return undefined;
  for (const sid of session.viewerWorkspaces.keys()) return sid;
  return undefined;
}

// Handle stream open request
async function handleStreamOpen(
  session: MultiSession,
  message: StreamOpenMessage
): Promise<void> {
  // In shared-workspace mode a PTY open binds a viewport to a workspace (the
  // resolver picks which); a 'cmd' open still spawns normally so one-off
  // `connect <url> ls` keeps working.
  if (session.getWorkspace && message.msg?.mode === 'pty') {
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
  // Collaborative input: a viewport's keystrokes merge into ITS workspace's
  // active window.
  const inputWs = session.viewerWorkspaces?.get(message.msg.sid);
  if (inputWs) {
    inputWs.writeFromViewport(message.msg.sid, message.msg.chunk);
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
  //
  // EXCEPT in viewer-authoritative workspaces (headless daemons with no host
  // TTY, e.g. Locus): there the browser viewport IS the terminal, so its resize
  // reshapes the whole workspace — otherwise every shell would stay at the
  // 80×24 construction default forever.
  const resizeWs = session.viewerWorkspaces?.get(message.msg.sid);
  if (resizeWs) {
    if (resizeWs.viewerResizeAuthoritative) {
      resizeWs.resize(message.msg.cols, message.msg.rows);
    } else {
      resizeWs.repaintViewportScreen(message.msg.sid);
    }
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
  if (session.viewerWorkspaces?.has(message.msg.sid)) return;

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
  // A viewport leaving its workspace just detaches — the windows keep running
  // for everyone else.
  const closeWs = session.viewerWorkspaces?.get(message.msg.sid);
  if (closeWs) {
    session.viewerWorkspaces!.delete(message.msg.sid);
    closeWs.detachViewport(message.msg.sid);
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

// Send a window-state push for a specific viewport. WINDOW_CTL frames are not
// stream-scoped, so they ride the session GLOBAL counter (the same sequence
// AUTH_PW / ERROR use), not a per-stream counter. The viewport's pty `sid` is
// carried IN the message body (additive optional field) so a multi-viewport
// client can route the state to the owning stream handle; single-viewport
// clients ignore it.
async function sendWindowState(
  session: MultiSession,
  sid: string,
  state: WindowStateBody
): Promise<void> {
  const msg = {
    ctr: session.counters.outgoing.next(),
    msg: { ...state, sid },
  };
  await sendEncrypted(session, FrameType.WINDOW_CTL, msg);
}

// Handle a client->server window operation (WINDOW_CTL). Window ops drive the
// active window of the TARGET viewport, so viewers/tabs can sit on different
// windows independently; the workspace pushes each affected viewport its own
// window-state and repaints. The op names its viewport via `op.sid` (additive
// field): with several pty viewports on one connection, "the first viewport" is
// no longer a valid assumption. A legacy op without a sid falls back to the
// session's first/only viewport. The workspace is resolved BY that sid, so an op
// always lands on the workspace the viewport is actually attached to.
async function handleWindowCtl(
  session: MultiSession,
  message: WindowCtlOpMessage
): Promise<void> {
  const op = message.msg;
  const sid = op.sid ?? firstViewerSid(session);
  if (!sid) return;
  const workspace = session.viewerWorkspaces?.get(sid);
  if (!workspace) return;
  switch (op.op) {
    case 'new-window': workspace.newWindowForViewport(sid); break;
    case 'next-window': workspace.nextWindowForViewport(sid); break;
    case 'prev-window': workspace.prevWindowForViewport(sid); break;
    case 'select-window': workspace.selectWindowForViewport(sid, op.index); break;
    case 'close-window': workspace.closeWindowFromViewport(sid, op.index); break;
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

    // WINDOW_CTL and KEEPALIVE ride the SESSION GLOBAL counter, never a
    // per-stream one — even though a WINDOW_CTL op now carries a `sid` (the
    // target VIEWPORT for attribution, not a stream-counter selector). Keying the
    // counter off `msg.sid` here would route these onto a per-stream sequence the
    // client never uses and trip the replay defense. Only genuine STREAM_* frames
    // (which carry the stream's own sid) use the per-stream counter.
    const streamScoped =
      frame.type !== FrameType.WINDOW_CTL &&
      frame.type !== FrameType.KEEPALIVE &&
      message.msg && typeof message.msg.sid === 'string';
    if (streamScoped) {
      const sid = message.msg.sid;
      const expectedCounter = session.streamCounters.getNext(sid, 'incoming');
      if (message.ctr !== expectedCounter) {
        terminateSession(session, `Stream counter mismatch for ${sid}: expected=${expectedCounter}, received=${message.ctr}`);
        return;
      }
      session.streamCounters.increment(sid, 'incoming');
    } else {
      // Non-stream messages (incl. WINDOW_CTL / KEEPALIVE) use the global counter.
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
        // Echo keepalive back so the client's liveness watchdog sees a reply.
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
  // Detach this invoker's viewports from their workspaces without killing
  // windows. Each viewport may belong to a DIFFERENT workspace (multi-workspace),
  // so detach each on the workspace it actually attached to.
  if (session.viewerWorkspaces) {
    for (const [sid, ws] of session.viewerWorkspaces) {
      try { ws.detachViewport(sid); } catch { /* best effort */ }
    }
    session.viewerWorkspaces.clear();
  }
  if (session.streamManager) {
    session.streamManager.closeAllStreams('Session cleanup');
  }
}
