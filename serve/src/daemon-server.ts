import * as net from 'net';
import * as fs from 'fs';
import type { OutputHandler } from '@thenewlabs/entangle-utils';
import type { SharedWorkspace } from './shared-workspace.js';
import type { LocalHostSession } from './host-session.js';
import { addSession, assertSocketPathUsable, logPath, removeSession, type SessionInfo } from './session-registry.js';
import {
  createMessageReader,
  decodeChunk,
  encodeChunk,
  writeMessage,
  type ClientToDaemon,
  type DaemonToClient,
} from './ipc.js';

/**
 * The reusable socket-server half of a detachable session daemon: everything a
 * daemon does BETWEEN owning a workspace and connecting it to a relay.
 *
 * Extracted from daemon.ts so embedders (Locus's `locus __daemon`) can compose
 * the same detach/reattach machinery around their own boot sequence: it listens
 * on a unix socket where zero or more terminal CLIENTS (RemoteHostSession)
 * attach, fans the session's events out to every attached client, applies each
 * client's input/resize/window ops to the one shared workspace, and keeps the
 * session registry entry current. Detaching a client leaves the daemon (and
 * the session) running.
 *
 * The caller stays responsible for constructing the SharedWorkspace +
 * LocalHostSession, starting the relay agent, and reporting the session URL
 * via {@link DaemonServer.setUrl} once the relay announces it.
 */
/**
 * Fallback text for a shutdown whose caller named no reason. Every in-tree
 * caller names one; this only covers an embedder calling `shutdown(code)`.
 */
const REASON_UNSPECIFIED = 'requested by the host (no reason given)';

export interface DaemonServerOptions {
  /** Session name — the registry key and the log/socket basename. */
  name: string;
  /** Absolute path of the unix socket to listen on. */
  socketPath: string;
  workspace: SharedWorkspace;
  session: LocalHostSession;
  output: OutputHandler;
  /** What the registry entry records about this session. */
  registry: { capId: string; kind: 'entangle' | 'locus'; workspaceRoot?: string };
  /**
   * Extra async teardown run during shutdown, after the workspace and clients
   * are torn down but before the process exits (Locus: close locusd + remove
   * its pipe sockets). Best-effort: a throw here never blocks the exit.
   */
  beforeExit?: () => Promise<void> | void;
  /** Install SIGTERM/SIGINT → shutdown handlers (default true; off for tests). */
  installSignalHandlers?: boolean;
  /** Process exit hook (default process.exit; replaced by tests). */
  exit?: (code: number) => void;
}

export interface DaemonServer {
  /** Record the session URL: pushes it to attached clients and the registry. */
  setUrl(url: string): void;
  /**
   * Tear the daemon down (idempotent): broadcast exit, deregister, exit(0).
   *
   * `reason` is recorded in the session log and forwarded to every attached
   * client so a session that ends is never a mystery — see {@link ShutdownReason}.
   */
  shutdown(code: number | null, reason?: string): void;
}

/**
 * Listen on `socketPath`, register the session, and serve attach/detach
 * clients over the IPC protocol (ipc.ts). Resolves once the socket is
 * listening and the registry entry is written (url filled in via setUrl).
 */
export async function createDaemonServer(opts: DaemonServerOptions): Promise<DaemonServer> {
  const { name, socketPath: socketPathValue, workspace, session: localSession, output } = opts;
  // Refuse a path bind() would silently truncate — a truncated socket looks
  // dead to every liveness check that stats the full path.
  assertSocketPathUsable(socketPathValue);
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const createdAt = Date.now();
  const register = (url: string): void => {
    const info: SessionInfo = {
      name,
      socket: socketPathValue,
      logFile: logPath(name),
      pid: process.pid,
      capId: opts.registry.capId,
      url,
      createdAt,
      kind: opts.registry.kind,
      ...(opts.registry.workspaceRoot ? { workspaceRoot: opts.registry.workspaceRoot } : {}),
    };
    addSession(info);
  };

  // --- client set + fan-out -------------------------------------------------

  const clients = new Set<net.Socket>();

  const broadcast = (msg: DaemonToClient): void => {
    for (const socket of clients) {
      try { writeMessage(socket, msg); } catch { /* dropped client; its close handler cleans up */ }
    }
  };

  // --- lifecycle / cleanup (idempotent) ------------------------------------

  let server: net.Server | undefined;
  let shuttingDown = false;
  const shutdown = (code: number | null, reason: string = REASON_UNSPECIFIED): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Tell attached clients WHY first (the `exit` frame carries the reason, so
    // the host terminal can print it instead of a bare "Shared session ended").
    broadcast({ t: 'exit', code, reason });
    try { localSession.dispose(); } catch { /* best-effort */ }
    // THEN log it — dispose() released the captured-log sink, so this lands in
    // the session's log FILE (the durable forensic record) rather than in the
    // in-memory ring buffer nobody can read once the process is gone. A daemon
    // signalled from outside (a stray `pkill` from an unrelated dev script is
    // the real-world case) otherwise leaves a log indistinguishable from a
    // crash: viewports detach, pipes close, process gone, nothing explaining it.
    output.info(`Session shutting down: ${reason}`);
    try { workspace.kill(); } catch { /* best-effort */ }
    for (const socket of clients) { try { socket.end(); } catch { /* already gone */ } }
    clients.clear();
    try { server?.close(); } catch { /* not listening */ }
    removeSession(name);
    try { fs.unlinkSync(socketPathValue); } catch { /* already gone */ }
    // The embedder's teardown may be async (Locus closes locusd); exit after it
    // either way. With no beforeExit this is an immediate exit, as before.
    void (async () => {
      try { await opts.beforeExit?.(); } catch { /* best-effort */ }
      exit(0);
    })();
  };

  if (opts.installSignalHandlers !== false) {
    // A session must only ever end on an EXPLICIT host-side action, so name the
    // signal (and that it came from outside this process) in the log and in
    // every attached client's exit line.
    process.on('SIGTERM', () => shutdown(0, 'SIGTERM (terminated by another process)'));
    process.on('SIGINT', () => shutdown(0, 'SIGINT (interrupted)'));
  }

  // Subscribe ONCE to the SESSION-GLOBAL streams and fan each out to every
  // client. Terminal output and window-state are NOT global anymore: each client
  // gets its own workspace viewport (see onConnection) so it can sit on its own
  // active window, so we deliberately do NOT broadcast onHostData/onWindowState.
  localSession.onViewersChange((n) => broadcast({ t: 'viewers', n }));
  localSession.onLog((line) => broadcast({ t: 'log', line }));
  localSession.onUrl((url) => broadcast({ t: 'url', url }));
  // Workspace ended (last window's shell exited) → tear the daemon down. Note a
  // PERSISTENT workspace never gets here: it respawns its shell instead, so a
  // Locus session cannot end this way.
  localSession.onExit((code) => shutdown(code, 'the workspace ended (last window exited)'));

  // --- inbound client handling ---------------------------------------------

  // A client's messages drive ITS OWN workspace viewport (keyed by `vpId`), so
  // input/window ops only move that client's active window. Sizing stays global
  // (the host/workspace size is authoritative), so hello/resize resize the whole
  // workspace as before.
  const handleClientMessage = (msg: ClientToDaemon, socket: net.Socket, vpId: string): void => {
    switch (msg.t) {
      case 'hello':
        workspace.resize(msg.cols, msg.rows);
        break;
      case 'input':
        workspace.writeFromViewport(vpId, decodeChunk(msg.data));
        break;
      case 'resize':
        workspace.resize(msg.cols, msg.rows);
        break;
      case 'win':
        switch (msg.op) {
          case 'new': workspace.newWindowForViewport(vpId); break;
          case 'next': workspace.nextWindowForViewport(vpId); break;
          case 'prev': workspace.prevWindowForViewport(vpId); break;
          case 'select': if (msg.index !== undefined) workspace.selectWindowForViewport(vpId, msg.index); break;
          case 'close': if (msg.index !== undefined) workspace.closeWindowFromViewport(vpId, msg.index); break;
        }
        break;
      case 'refresh':
        // Serialize the viewport's active window NOW and send it back as a
        // `replay` frame (getReplay()'s source client-side). Because this is a
        // full IPC round-trip after the client's own bytes were fed to the
        // emulator, the serialize reflects the window's live screen — this is
        // what lets a host repaint (e.g. after a full-screen app quits) paint
        // the CURRENT primary instead of the stale attach-time cache.
        try {
          const frame = workspace.snapshotForViewport(
            vpId,
            msg.scrollback !== undefined ? { scrollback: msg.scrollback } : undefined,
          );
          writeMessage(socket, { t: 'replay', chunk: encodeChunk(frame) });
        } catch { /* dropped client; its close handler cleans up */ }
        break;
      case 'scrollback':
        // Serialize the viewport's active window buffer to plain-text lines NOW
        // and send them back for the client's copy-mode pager.
        try {
          writeMessage(socket, { t: 'scrollback', lines: workspace.scrollbackLinesForViewport(vpId) });
        } catch { /* dropped client; its close handler cleans up */ }
        break;
      case 'detach':
        // Drop just this client's viewport; the daemon (and session) keep running.
        clients.delete(socket);
        workspace.detachViewport(vpId);
        try { socket.end(); } catch { /* already ending */ }
        break;
      case 'kill':
        // End the whole session on a client's request (host UI Ctrl-B q): the
        // exit broadcast inside shutdown() tells every attached client first.
        shutdown(0, 'ended by an attached terminal (Ctrl-B q)');
        break;
    }
  };

  let nextVpId = 0;

  const onConnection = (socket: net.Socket): void => {
    // Each connection is its own workspace viewport with an independent active
    // window; reuse the connection counter as the viewport key.
    const vpId = `client-${nextVpId++}`;
    clients.add(socket);
    const remove = (): void => {
      clients.delete(socket);
      workspace.detachViewport(vpId);
    };
    socket.on('close', remove);
    socket.on('error', remove);

    // Attach this client's viewport: the workspace multiplexes ITS active
    // window's output onto this socket and pushes ITS own window-state.
    const { replay } = workspace.attachViewport({
      sid: vpId,
      onData: (chunk) => { try { writeMessage(socket, { t: 'data', chunk: encodeChunk(chunk) }); } catch { /* dropped */ } },
      onWindowState: (state) => { try { writeMessage(socket, { t: 'window-state', state }); } catch { /* dropped */ } },
      onExit: (code) => { try { writeMessage(socket, { t: 'exit', code }); } catch { /* dropped */ } },
    });

    createMessageReader(
      socket,
      (msg) => {
        // Only ClientToDaemon frames are expected inbound; a single bad message
        // must not take down the daemon.
        try { handleClientMessage(msg as ClientToDaemon, socket, vpId); }
        catch (err) { output.warn('Client message failed', err instanceof Error ? err.message : String(err)); }
      },
      () => { remove(); try { socket.destroy(); } catch { /* already gone */ } },
    );

    // Push this viewport's current state immediately so the client's UI
    // populates fast. Sent synchronously (no await) right after attach, so live
    // onData frames can't slip in before the replay.
    try {
      const url = localSession.getUrl();
      if (url) writeMessage(socket, { t: 'url', url });
      writeMessage(socket, { t: 'window-state', state: workspace.windowStateForViewport(vpId) });
      writeMessage(socket, { t: 'viewers', n: workspace.viewerCount() });
      for (const line of localSession.getLogBuffer()) writeMessage(socket, { t: 'log', line });
      writeMessage(socket, { t: 'replay', chunk: encodeChunk(replay) });
    } catch {
      remove();
    }
  };

  // --- listen ---------------------------------------------------------------

  try { fs.unlinkSync(socketPathValue); } catch { /* no stale socket to remove */ }

  server = net.createServer(onConnection);
  server.on('error', (err) => output.error('Daemon socket server error', err.message));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server!.once('error', onError);
    server!.listen(socketPathValue, () => {
      server!.off('error', onError);
      resolve();
    });
  });
  try { fs.chmodSync(socketPathValue, 0o600); } catch { /* best-effort tightening */ }

  // Register now (url filled in via setUrl once the relay assigns it).
  register('');

  return {
    setUrl(url: string): void {
      localSession.setUrl(url);
      register(url);
    },
    shutdown,
  };
}
