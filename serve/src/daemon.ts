import * as net from 'net';
import * as fs from 'fs';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { startAgent } from './agent.js';
import type { CapabilityInfo } from './capability.js';
import { SharedWorkspace } from './shared-workspace.js';
import { LocalHostSession } from './host-session.js';
import { addSession, logPath, removeSession, type SessionInfo } from './session-registry.js';
import {
  createMessageReader,
  decodeChunk,
  encodeChunk,
  writeMessage,
  type ClientToDaemon,
  type DaemonToClient,
} from './ipc.js';

/**
 * The DAEMON half of the tmux-style detach/reattach split for `entangle serve`.
 *
 * Runs headless (no TTY): it owns a {@link SharedWorkspace} + {@link LocalHostSession}
 * and connects to the relay via {@link startAgent}, serving the pinned capability
 * handed to it. It listens on a local unix socket where zero or more terminal
 * CLIENTS ({@link RemoteHostSession}) attach; it fans the session's events out to
 * every attached client and applies each client's input/resize/window ops to the
 * one shared session. Detaching a client leaves the daemon (and the session)
 * running; the daemon exits only when the workspace's last shell exits or it is
 * signalled.
 *
 * Config comes entirely from the environment (set by the index wiring that spawns
 * the daemon):
 *
 *   ENTANGLE_DAEMON_SESSION   session name (registry key + log/socket basename)
 *   ENTANGLE_DAEMON_SOCKET    absolute path of the unix socket to listen on
 *   ENTANGLE_DAEMON_SERVER    relay server URL to register with
 *   ENTANGLE_DAEMON_CAP       JSON-encoded CapabilityInfo ({capId,S,policy}) to pin
 *   ENTANGLE_DAEMON_PASSWORD  optional connect password
 */
export async function runDaemon(): Promise<void> {
  const name = requireEnv('ENTANGLE_DAEMON_SESSION');
  const socketPathValue = requireEnv('ENTANGLE_DAEMON_SOCKET');
  const serverUrl = requireEnv('ENTANGLE_DAEMON_SERVER');
  const cap = parseCap(requireEnv('ENTANGLE_DAEMON_CAP'));
  const password = process.env.ENTANGLE_DAEMON_PASSWORD;

  const output = new OutputHandler({ mode: parseOutputMode('text') });

  // A sane default size; the first attaching client resizes the session to its
  // real terminal via its `hello`.
  const workspace = new SharedWorkspace(output, { cols: 80, rows: 24 });
  // Installs the log sink (agent logs → ring buffer, fanned out to clients as
  // `log` frames) and owns the session URL via setUrl().
  const localSession = new LocalHostSession(workspace, output);

  const createdAt = Date.now();
  const register = (url: string): void => {
    const info: SessionInfo = {
      name,
      socket: socketPathValue,
      logFile: logPath(name),
      pid: process.pid,
      capId: cap.capId,
      url,
      createdAt,
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
  const shutdown = (code: number | null): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    broadcast({ t: 'exit', code });
    try { localSession.dispose(); } catch { /* best-effort */ }
    try { workspace.kill(); } catch { /* best-effort */ }
    for (const socket of clients) { try { socket.end(); } catch { /* already gone */ } }
    clients.clear();
    try { server?.close(); } catch { /* not listening */ }
    removeSession(name);
    try { fs.unlinkSync(socketPathValue); } catch { /* already gone */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  // Subscribe ONCE to the SESSION-GLOBAL streams and fan each out to every
  // client. Terminal output and window-state are NOT global anymore: each client
  // gets its own workspace viewport (see onConnection) so it can sit on its own
  // active window, so we deliberately do NOT broadcast onHostData/onWindowState.
  localSession.onViewersChange((n) => broadcast({ t: 'viewers', n }));
  localSession.onLog((line) => broadcast({ t: 'log', line }));
  localSession.onUrl((url) => broadcast({ t: 'url', url }));
  // Workspace ended (last window's shell exited) → tear the daemon down.
  localSession.onExit((code) => shutdown(code));

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
      case 'detach':
        // Drop just this client's viewport; the daemon (and session) keep running.
        clients.delete(socket);
        workspace.detachViewport(vpId);
        try { socket.end(); } catch { /* already ending */ }
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

  // Register now (url filled in once the relay assigns it).
  register('');

  // Connect to the relay and serve the pinned capability. onCapabilityReady sets
  // the session URL (fanned out as a `url` frame) and records it in the registry.
  await startAgent({
    serverUrl,
    sharedWorkspace: workspace,
    onCapabilityReady: ({ link }) => {
      localSession.setUrl(link);
      register(link);
    },
    ...(password ? { password } : {}),
    pinnedCapability: cap,
  });
}

/** Read a required env var or throw a clear configuration error. */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Daemon misconfigured: ${key} is not set`);
  return value;
}

/** Parse the pinned capability JSON from the environment. */
function parseCap(raw: string): CapabilityInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Daemon misconfigured: ENTANGLE_DAEMON_CAP is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Daemon misconfigured: ENTANGLE_DAEMON_CAP is not a capability object');
  }
  const c = parsed as Record<string, unknown>;
  if (typeof c.capId !== 'string' || typeof c.S !== 'string' || typeof c.policy !== 'object' || c.policy === null) {
    throw new Error('Daemon misconfigured: ENTANGLE_DAEMON_CAP is missing capId/S/policy');
  }
  return parsed as CapabilityInfo;
}
