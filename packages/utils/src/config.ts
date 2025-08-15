import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig(): void {
  const rootDir = resolve(__dirname, '../../..');
  config({ path: resolve(rootDir, '.env') });
  config({ override: true });
}

export interface Config {
  port: number;
  host: string;
  publicOrigin: string;
  maxFrameBytes: number;
  relayIdleTimeoutMs: number;
  agentHeartbeatMs: number;
  maxConcurrentRunsPerCap: number;
  logLevel: string;
  spaBasePath: string;
  relayRateRps: number;
  relayBurst: number;
  agentTool: string | undefined;
  agentAllowedCwd: string[] | undefined;
  maxArgCount: number;
  maxArgLen: number;
  relayUrl: string | undefined;
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
    maxConcurrentRunsPerCap: parseInt(process.env.MAX_CONCURRENT_RUNS_PER_CAP || '1', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    spaBasePath: process.env.SPA_BASE_PATH || '/',
    relayRateRps: parseInt(process.env.RELAY_RATE_RPS || '10', 10),
    relayBurst: parseInt(process.env.RELAY_BURST || '50', 10),
    agentTool: process.env.AGENT_TOOL,
    agentAllowedCwd: process.env.AGENT_ALLOWED_CWD?.split(':').filter(Boolean),
    maxArgCount: parseInt(process.env.MAX_ARG_COUNT || '64', 10),
    maxArgLen: parseInt(process.env.MAX_ARG_LEN || '4096', 10),
    relayUrl: process.env.RELAY_URL,
  };
}