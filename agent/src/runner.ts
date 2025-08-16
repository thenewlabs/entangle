import { spawn } from 'child_process';
import { createLogger } from '@sunpix/entangle-utils';
import { 
  FrameType, 
  encodeFrame,
  type ExitMessage,
  type StdoutMessage,
  type StderrMessage,
} from '@sunpix/entangle-protocol';
import { aeadEncrypt } from '@sunpix/entangle-crypto';
import { encode } from 'cborg';
import { type Session, sendRelayResponse } from './session.js';
import { realpath } from 'fs/promises';
import { resolve } from 'path';

const logger = createLogger('runner');

export function resolveCwd(requestedCwd?: string): string {
  if (requestedCwd) {
    return resolve(requestedCwd);
  }
  return process.env.AGENT_DEFAULT_CWD || process.cwd();
}

export async function validateCwd(cwd: string): Promise<void> {
  const allowedPrefixes = process.env.AGENT_ALLOWED_CWD?.split(':') || [];
  
  if (allowedPrefixes.length === 0) {
    // No restrictions
    return;
  }
  
  const realCwd = await realpath(cwd);
  
  for (const prefix of allowedPrefixes) {
    const realPrefix = await realpath(prefix).catch(() => prefix);
    if (realCwd.startsWith(realPrefix)) {
      return;
    }
  }
  
  throw new Error(`CWD ${cwd} not in allowed prefixes`);
}

export async function runCommand(
  session: Session,
  runMsg: any
): Promise<void> {
  const { commandId, argv, cwd: requestedCwd, limits } = runMsg;
  
  if (!argv || argv.length === 0) {
    throw new Error('No command provided');
  }
  
  // Resolve and validate CWD
  let cwd: string;
  try {
    cwd = resolveCwd(requestedCwd);
    await validateCwd(cwd);
  } catch (error: any) {
    logger.error({ error, requestedCwd }, 'CWD validation failed');
    throw error;
  }
  
  const tool = argv[0];
  const args = argv.slice(1);
  
  logger.info({ commandId, tool, args, cwd }, 'Running command');
  
  const startTime = Date.now();
  let bytesOut = 0;
  const maxOutBytes = limits?.maxOutBytes || parseInt(process.env.MAX_OUT_BYTES || '10485760', 10);
  
  // No user switching - run as same OS user as agent
  const child = spawn(tool, args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: getMinimalEnv(),
    signal: session.abortController?.signal,
  });
  
  if (limits?.wallMs) {
    setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, limits.wallMs);
  }
  
  child.stdout?.on('data', (chunk: Buffer) => {
    if (bytesOut + chunk.length > maxOutBytes) {
      const remaining = maxOutBytes - bytesOut;
      if (remaining > 0) {
        sendStdout(session, commandId, chunk.slice(0, remaining));
        bytesOut = maxOutBytes;
      }
      child.kill('SIGTERM');
      return;
    }
    
    bytesOut += chunk.length;
    sendStdout(session, commandId, chunk);
  });
  
  child.stderr?.on('data', (chunk: Buffer) => {
    if (bytesOut + chunk.length > maxOutBytes) {
      const remaining = maxOutBytes - bytesOut;
      if (remaining > 0) {
        sendStderr(session, commandId, chunk.slice(0, remaining));
        bytesOut = maxOutBytes;
      }
      child.kill('SIGTERM');
      return;
    }
    
    bytesOut += chunk.length;
    sendStderr(session, commandId, chunk);
  });
  
  child.on('exit', (code, signal) => {
    const duration = Date.now() - startTime;
    logger.info({ commandId, code, signal, duration, bytesOut }, 'Command exited');
    
    sendExit(session, commandId, code, signal, bytesOut);
    delete session.currentCommand;
    delete session.abortController;
  });
  
  child.on('error', (error) => {
    logger.error({ commandId, error }, 'Command error');
    sendExit(session, commandId, null, null, bytesOut);
  });
}

function sendStdout(session: Session, commandId: string, chunk: Buffer): void {
  if (!session.keys) return;
  
  const msg: StdoutMessage = {
    ctr: session.counters.outgoing.next(),
    msg: {
      commandId,
      chunk: new Uint8Array(chunk),
    },
  };
  
  const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.STDOUT, msg.ctr, msg.msg);
  const frame = encodeFrame(FrameType.STDOUT, encode(encrypted));
  
  sendRelayResponse(session, frame);
}

function sendStderr(session: Session, commandId: string, chunk: Buffer): void {
  if (!session.keys) return;
  
  const msg: StderrMessage = {
    ctr: session.counters.outgoing.next(),
    msg: {
      commandId,
      chunk: new Uint8Array(chunk),
    },
  };
  
  const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.STDERR, msg.ctr, msg.msg);
  const frame = encodeFrame(FrameType.STDERR, encode(encrypted));
  
  sendRelayResponse(session, frame);
}

function sendExit(
  session: Session,
  commandId: string,
  code: number | null,
  signal: string | null,
  bytesOut: number
): void {
  if (!session.keys) return;
  
  const msg: ExitMessage = {
    ctr: session.counters.outgoing.next(),
    msg: {
      commandId,
      code,
      signal,
      bytesOut,
    },
  };
  
  const encrypted = aeadEncrypt(session.keys.K_enc, FrameType.EXIT, msg.ctr, msg.msg);
  const frame = encodeFrame(FrameType.EXIT, encode(encrypted));
  
  sendRelayResponse(session, frame);
}

export function getMinimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/',
    USER: process.env.USER || 'nobody',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    // Terminal settings to help commands format output properly
    TERM: 'xterm-256color',
    COLUMNS: '120',  // Wider default to reduce column wrapping
    LINES: '40',
  };
}