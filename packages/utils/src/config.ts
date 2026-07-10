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

export interface Config {
  port: number;
  host: string;
  publicOrigin: string;
  maxFrameBytes: number;
  relayIdleTimeoutMs: number;
  agentHeartbeatMs: number;
  cmdDefaultWallMs: number;
  ttyIdleTimeoutMs: number;
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
  // Passthrough allow-list of env var names a caller may set on spawned
  // processes. Everything else is dropped; children otherwise get a minimal env.
  agentEnvPassthrough: string[];
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

  return {
    port: intEnv('PORT', 8080, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:8080',
    maxFrameBytes: intEnv('MAX_FRAME_BYTES', 1048576),
    relayIdleTimeoutMs: intEnv('RELAY_IDLE_TIMEOUT_MS', 120000),
    agentHeartbeatMs: intEnv('AGENT_HEARTBEAT_MS', 15000),
    cmdDefaultWallMs: intEnv('CMD_DEFAULT_WALL_MS', 60000),
    ttyIdleTimeoutMs: intEnv('TTY_IDLE_TIMEOUT_MS', 1200000),
    maxOutBytes: intEnv('MAX_OUT_BYTES', 10485760),
    logLevel: process.env.LOG_LEVEL || 'info',
    relayRateRps: intEnv('RELAY_RATE_RPS', 10),
    relayBurst: intEnv('RELAY_BURST', 50),
    agentShell: process.env.AGENT_SHELL || process.env.SHELL || '/bin/bash',
    // Default working directory is the launch directory (not $HOME), so runs
    // start where the agent was started unless explicitly overridden.
    agentDefaultCwd: process.env.AGENT_DEFAULT_CWD || LAUNCH_DIR,
    // When no explicit allow-list is set, bind execution to the launch
    // directory so a capability holder cannot cd/exec outside it. An explicit
    // AGENT_ALLOWED_CWD (colon-separated) widens or changes this boundary.
    agentAllowedCwd: process.env.AGENT_ALLOWED_CWD
      ? process.env.AGENT_ALLOWED_CWD.split(':').filter(Boolean)
      : [process.env.AGENT_DEFAULT_CWD || LAUNCH_DIR],
    spawnSandbox: process.env.SPAWN_SANDBOX || 'none',
    maxArgCount: intEnv('MAX_ARG_COUNT', 256),
    maxArgLen: intEnv('MAX_ARG_LEN', 16384),
    relayUrl: process.env.RELAY_URL,
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
    agentToken: process.env.RELAY_AGENT_TOKEN || undefined,
    agentEnvPassthrough: (process.env.AGENT_ENV_PASSTHROUGH || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}