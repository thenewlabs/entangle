import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The directory the process was launched in, captured once at startup (before
// anything can chdir). By default the agent binds both its working directory
// and its execution boundary to this, so a run cannot escape the directory the
// operator started the agent in.
const LAUNCH_DIR = process.cwd();

export function loadConfig(): void {
  const rootDir = resolve(__dirname, '../../..');
  const envPath = resolve(rootDir, '.env');
  config({ path: envPath });
}

/**
 * A resolved forwarded-channel (pipe) target. Either a unix domain socket path
 * or a TCP host:port. Only registered endpoints are reachable — an allow-list in
 * the spirit of the existing cwd boundary.
 */
export type PipeEndpoint =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; host: string; port: number };

/**
 * Parse pipe endpoint specs of the form `name=unix:/abs/path.sock` or
 * `name=tcp:127.0.0.1:7060` into a name→endpoint map. Throws on any malformed
 * spec (unknown scheme, empty name/path/host, out-of-range port, duplicate name)
 * — pipe registration fails closed rather than silently dropping an endpoint.
 */
export function parsePipeEndpoints(specs: string[]): Map<string, PipeEndpoint> {
  const map = new Map<string, PipeEndpoint>();
  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) continue;

    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error(`Malformed pipe spec (expected name=target): ${raw}`);
    const name = spec.slice(0, eq).trim();
    const target = spec.slice(eq + 1).trim();
    if (!name) throw new Error(`Malformed pipe spec (empty name): ${raw}`);
    if (map.has(name)) throw new Error(`Duplicate pipe name: ${name}`);

    if (target.startsWith('unix:')) {
      const path = target.slice('unix:'.length);
      if (!path) throw new Error(`Malformed pipe target (empty unix path): ${raw}`);
      map.set(name, { kind: 'unix', path });
    } else if (target.startsWith('tcp:')) {
      const rest = target.slice('tcp:'.length);
      const lastColon = rest.lastIndexOf(':');
      if (lastColon <= 0) throw new Error(`Malformed pipe target (expected tcp:host:port): ${raw}`);
      const host = rest.slice(0, lastColon).trim();
      const port = Number(rest.slice(lastColon + 1));
      if (!host) throw new Error(`Malformed pipe target (empty tcp host): ${raw}`);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Malformed pipe target (invalid tcp port): ${raw}`);
      }
      map.set(name, { kind: 'tcp', host, port });
    } else {
      throw new Error(`Malformed pipe target (expected unix: or tcp: scheme): ${raw}`);
    }
  }
  return map;
}

/**
 * Read the ENTANGLE_PIPES env (comma- or whitespace-separated specs) into an
 * endpoint map. A malformed value warns once and yields an empty map so an
 * unrelated consumer of getConfig() (e.g. the relay) never crashes on it.
 */
function pipeEndpointsFromEnv(): Map<string, PipeEndpoint> {
  const raw = process.env.ENTANGLE_PIPES;
  if (!raw) return new Map();
  const specs = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  try {
    return parsePipeEndpoints(specs);
  } catch (err) {
    warnedKeys ??= new Set();
    if (!warnedKeys.has('ENTANGLE_PIPES')) {
      warnedKeys.add('ENTANGLE_PIPES');
      // eslint-disable-next-line no-console
      console.warn(`[config] Invalid ENTANGLE_PIPES: ${err instanceof Error ? err.message : String(err)}; ignoring`);
    }
    return new Map();
  }
}

export interface Config {
  port: number;
  host: string;
  publicOrigin: string;
  maxFrameBytes: number;
  relayIdleTimeoutMs: number;
  agentHeartbeatMs: number;
  cmdDefaultWallMs: number;
  ttyIdleTimeoutMs: number;
  // Idle timeout (ms) for pipe/forwarded-channel streams. 0 disables reaping
  // (pipes follow the PTY exemption model — long-lived, unbounded by cmd caps).
  pipeIdleTimeoutMs: number;
  maxOutBytes: number;
  logLevel: string;
  relayRateRps: number;
  relayBurst: number;
  agentShell: string;
  agentDefaultCwd: string;
  agentAllowedCwd: string[] | undefined;
  spawnSandbox: string;
  maxArgCount: number;
  maxArgLen: number;
  relayUrl: string | undefined;
  // Comma-separated list of allowed CORS origins for the HTTP surface.
  // Empty (default) disables cross-origin access entirely.
  corsOrigins: string[];
  // Only trust the X-Forwarded-For header (for client IP / rate limiting) when
  // the relay sits behind a proxy you control.
  trustProxy: boolean;
  // Optional shared secret required to register an agent. When set, random
  // clients can no longer claim /agent/register and squat capabilities.
  agentToken: string | undefined;
  // When true, /agent/register is refused unless a token is configured (fail
  // closed). Defaults on in production or via RELAY_REQUIRE_AGENT_TOKEN.
  requireAgentToken: boolean;
  // Ceilings on the routing maps, validated like other numeric settings so a
  // malformed value cannot disable the comparison.
  relayMaxAgents: number;
  relayMaxCapsPerAgent: number;
  // Passthrough allow-list of env var names a caller may set on spawned
  // processes. Everything else is dropped; children otherwise get a minimal env.
  agentEnvPassthrough: string[];
  // Registered forwarded-channel endpoints, parsed from ENTANGLE_PIPES. Named
  // pipes an invoker may bridge to via `mode: 'pipe'` (an allow-list).
  pipeEndpoints: Map<string, PipeEndpoint>;
}

let warnedKeys: Set<string> | undefined;

/**
 * Parse a security-sensitive integer setting, failing CLOSED to the default on
 * a malformed or out-of-range value instead of silently propagating NaN (which
 * would disable comparisons like `size > limit` and turn a limit off). A value
 * below `min` or above `max` is clamped back to the default.
 */
function intEnv(name: string, def: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    warnedKeys ??= new Set();
    if (!warnedKeys.has(name)) {
      warnedKeys.add(name);
      // eslint-disable-next-line no-console
      console.warn(`[config] Invalid ${name}=${JSON.stringify(raw)}; using default ${def}`);
    }
    return def;
  }
  return n;
}

export function getConfig(): Config {
  loadConfig();

  // AGENT_ALLOWED_CWD was merged into AGENT_DEFAULT_CWD (the working directory
  // is now the boundary). Warn once if the old var is still set so it does not
  // silently do nothing.
  if (process.env.AGENT_ALLOWED_CWD) {
    warnedKeys ??= new Set();
    if (!warnedKeys.has('AGENT_ALLOWED_CWD')) {
      warnedKeys.add('AGENT_ALLOWED_CWD');
      // eslint-disable-next-line no-console
      console.warn('[config] AGENT_ALLOWED_CWD is deprecated and ignored; use AGENT_DEFAULT_CWD (it is both the working directory and the execution boundary).');
    }
  }

  return {
    port: intEnv('PORT', 8080, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:8080',
    maxFrameBytes: intEnv('MAX_FRAME_BYTES', 1048576),
    relayIdleTimeoutMs: intEnv('RELAY_IDLE_TIMEOUT_MS', 120000),
    agentHeartbeatMs: intEnv('AGENT_HEARTBEAT_MS', 15000),
    cmdDefaultWallMs: intEnv('CMD_DEFAULT_WALL_MS', 60000),
    ttyIdleTimeoutMs: intEnv('TTY_IDLE_TIMEOUT_MS', 1200000),
    pipeIdleTimeoutMs: intEnv('PIPE_IDLE_TIMEOUT_MS', 0, 0),
    maxOutBytes: intEnv('MAX_OUT_BYTES', 10485760),
    logLevel: process.env.LOG_LEVEL || 'info',
    relayRateRps: intEnv('RELAY_RATE_RPS', 10),
    relayBurst: intEnv('RELAY_BURST', 50),
    agentShell: process.env.AGENT_SHELL || process.env.SHELL || '/bin/bash',
    // One directory knob: runs start here AND are confined here. Defaults to the
    // directory the agent was launched in (not $HOME). The execution boundary is
    // simply the working directory — there is no separate allow-list.
    agentDefaultCwd: process.env.AGENT_DEFAULT_CWD || LAUNCH_DIR,
    agentAllowedCwd: [process.env.AGENT_DEFAULT_CWD || LAUNCH_DIR],
    spawnSandbox: process.env.SPAWN_SANDBOX || 'none',
    maxArgCount: intEnv('MAX_ARG_COUNT', 256),
    maxArgLen: intEnv('MAX_ARG_LEN', 16384),
    relayUrl: process.env.RELAY_URL,
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
    agentToken: process.env.RELAY_AGENT_TOKEN || undefined,
    requireAgentToken:
      process.env.RELAY_REQUIRE_AGENT_TOKEN === '1' ||
      process.env.RELAY_REQUIRE_AGENT_TOKEN === 'true' ||
      process.env.NODE_ENV === 'production',
    relayMaxAgents: intEnv('RELAY_MAX_AGENTS', 10000),
    relayMaxCapsPerAgent: intEnv('RELAY_MAX_CAPS_PER_AGENT', 256),
    agentEnvPassthrough: (process.env.AGENT_ENV_PASSTHROUGH || '').split(',').map(s => s.trim()).filter(Boolean),
    pipeEndpoints: pipeEndpointsFromEnv(),
  };
}