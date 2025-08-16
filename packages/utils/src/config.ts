import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig(): void {
  const rootDir = resolve(__dirname, '../../..');
  const envPath = resolve(rootDir, '.env');
  console.log(`Loading .env from: ${envPath}`);
  const result = config({ path: envPath });
  console.log('.env load result:', result.error ? `Error: ${result.error}` : `Parsed ${Object.keys(result.parsed || {}).length} variables`);
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
}

export function getConfig(): Config {
  loadConfig();
  
  console.log('Environment PORT:', process.env.PORT);
  console.log('Environment HOST:', process.env.HOST);
  
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
  };
}