import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

export function getConfig(): Config {
  loadConfig();
  
  return {
    port: parseInt(process.env.PORT || '8080', 10),
    host: process.env.HOST || '0.0.0.0',
    publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:8080',
    maxFrameBytes: parseInt(process.env.MAX_FRAME_BYTES || '1048576', 10),
    relayIdleTimeoutMs: parseInt(process.env.RELAY_IDLE_TIMEOUT_MS || '120000', 10),
    agentHeartbeatMs: parseInt(process.env.AGENT_HEARTBEAT_MS || '15000', 10),
    cmdDefaultWallMs: parseInt(process.env.CMD_DEFAULT_WALL_MS || '60000', 10),
    ttyIdleTimeoutMs: parseInt(process.env.TTY_IDLE_TIMEOUT_MS || '1200000', 10),
    maxOutBytes: parseInt(process.env.MAX_OUT_BYTES || '10485760', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    relayRateRps: parseInt(process.env.RELAY_RATE_RPS || '10', 10),
    relayBurst: parseInt(process.env.RELAY_BURST || '50', 10),
    agentShell: process.env.AGENT_SHELL || process.env.SHELL || '/bin/bash',
    agentDefaultCwd: process.env.AGENT_DEFAULT_CWD || process.env.HOME || process.cwd(),
    agentAllowedCwd: process.env.AGENT_ALLOWED_CWD?.split(':').filter(Boolean),
    spawnSandbox: process.env.SPAWN_SANDBOX || 'none',
    maxArgCount: parseInt(process.env.MAX_ARG_COUNT || '256', 10),
    maxArgLen: parseInt(process.env.MAX_ARG_LEN || '16384', 10),
    relayUrl: process.env.RELAY_URL,
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
    agentToken: process.env.RELAY_AGENT_TOKEN || undefined,
    agentEnvPassthrough: (process.env.AGENT_ENV_PASSTHROUGH || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}