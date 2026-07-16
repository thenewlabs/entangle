import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { startAgent } from './agent.js';
import type { CapabilityInfo } from './capability.js';
import { SharedWorkspace } from './shared-workspace.js';
import { LocalHostSession } from './host-session.js';
import { createDaemonServer } from './daemon-server.js';

/**
 * The DAEMON half of the tmux-style detach/reattach split for `entangle serve`.
 *
 * Runs headless (no TTY): it owns a {@link SharedWorkspace} + {@link LocalHostSession}
 * and connects to the relay via {@link startAgent}, serving the pinned capability
 * handed to it. The socket server that terminal CLIENTS ({@link RemoteHostSession})
 * attach to — fan-out, per-client viewports, registry bookkeeping, shutdown — lives
 * in daemon-server.ts (shared with embedders like Locus); this file is just the
 * entangle-specific composition around it. Detaching a client leaves the daemon
 * (and the session) running; the daemon exits only when the workspace's last
 * shell exits or it is signalled.
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

  const server = await createDaemonServer({
    name,
    socketPath: socketPathValue,
    workspace,
    session: localSession,
    output,
    registry: { capId: cap.capId, kind: 'entangle' },
  });

  // Connect to the relay and serve the pinned capability. onCapabilityReady sets
  // the session URL (fanned out as a `url` frame) and records it in the registry.
  await startAgent({
    serverUrl,
    sharedWorkspace: workspace,
    onCapabilityReady: ({ link }) => server.setUrl(link),
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
