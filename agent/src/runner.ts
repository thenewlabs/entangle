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
import type { Session } from './relay.js';

const logger = createLogger('runner');

export async function runCommand(
  session: Session,
  runMsg: any
): Promise<void> {
  // const config = getConfig();
  const { commandId, tool, argv, cwd, limits } = runMsg;
  
  logger.info({ commandId, tool, argv, cwd }, 'Running command');
  
  const startTime = Date.now();
  let bytesOut = 0;
  const maxOutBytes = limits?.maxOutBytes || 10485760;
  
  const child = spawn(tool, argv, {
    cwd: cwd || process.cwd(),
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
  
  session.ws.send(frame);
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
  
  session.ws.send(frame);
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
  
  session.ws.send(frame);
}

function getMinimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/',
    USER: process.env.USER || 'nobody',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
  };
}