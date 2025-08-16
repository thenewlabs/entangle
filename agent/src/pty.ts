import { spawn as ptySpawn, IPty } from 'node-pty';
import { createLogger } from '@sunpix/entangle-utils';
import { FrameType, TtyOpenMessage, TtyDataMessage, TtyResizeMessage, TtySignalMessage } from '@sunpix/entangle-protocol';
// import type { Session } from './session.js';
import { resolveCwd, validateCwd } from './runner.js';

const logger = createLogger('pty');

interface PtySession {
  sessionId: string;
  pty: IPty;
  lastActivity: number;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private idleCheckInterval?: NodeJS.Timeout;

  constructor() {
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleSessions();
    }, 30000); // Check every 30 seconds
  }

  async handleTtyOpen(session: any, msg: TtyOpenMessage): Promise<void> {
    const { sessionId, cwd: requestedCwd, cols, rows } = msg.msg;

    // Check if session already exists
    if (this.sessions.has(sessionId)) {
      await session.sendError('SESSION_EXISTS', `Session ${sessionId} already exists`);
      return;
    }

    // Resolve and validate CWD
    let cwd: string;
    try {
      cwd = resolveCwd(requestedCwd);
      await validateCwd(cwd);
    } catch (error: any) {
      await session.sendError('CWD_NOT_ALLOWED', error.message);
      return;
    }

    // Get shell from environment
    const shell = process.env.AGENT_SHELL || process.env.SHELL || '/bin/bash';

    // Spawn PTY
    try {
      const ptyProcess = ptySpawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: this.getMinimalEnv(),
      });

      const ptySession: PtySession = {
        sessionId,
        pty: ptyProcess,
        lastActivity: Date.now(),
      };

      this.sessions.set(sessionId, ptySession);

      // Handle PTY output
      ptyProcess.onData((data: string) => {
        ptySession.lastActivity = Date.now();
        const chunk = Buffer.from(data);
        session.sendEncrypted(FrameType.TTY_DATA, {
          sessionId,
          chunk,
        }).catch((error: any) => {
          logger.error({ error, sessionId }, 'Failed to send TTY_DATA');
        });
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        logger.info({ sessionId, exitCode, signal }, 'PTY process exited');
        session.sendEncrypted(FrameType.TTY_EXIT, {
          sessionId,
          code: exitCode,
          signal,
        }).catch((error: any) => {
          logger.error({ error, sessionId }, 'Failed to send TTY_EXIT');
        });
        this.sessions.delete(sessionId);
      });

      logger.info({ sessionId, cwd, cols, rows }, 'PTY session opened');
    } catch (error: any) {
      logger.error({ error, sessionId }, 'Failed to spawn PTY');
      await session.sendError('INTERNAL_ERROR', 'Failed to spawn PTY');
    }
  }

  async handleTtyData(session: any, msg: TtyDataMessage): Promise<void> {
    const { sessionId, chunk } = msg.msg;
    const ptySession = this.sessions.get(sessionId);

    if (!ptySession) {
      await session.sendError('UNKNOWN_SESSION', `Session ${sessionId} not found`);
      return;
    }

    ptySession.lastActivity = Date.now();
    ptySession.pty.write(Buffer.from(chunk).toString('utf-8'));
  }

  async handleTtyResize(session: any, msg: TtyResizeMessage): Promise<void> {
    const { sessionId, cols, rows } = msg.msg;
    const ptySession = this.sessions.get(sessionId);

    if (!ptySession) {
      await session.sendError('UNKNOWN_SESSION', `Session ${sessionId} not found`);
      return;
    }

    ptySession.lastActivity = Date.now();
    ptySession.pty.resize(cols, rows);
    logger.debug({ sessionId, cols, rows }, 'PTY resized');
  }

  async handleTtySignal(session: any, msg: TtySignalMessage): Promise<void> {
    const { sessionId, signal } = msg.msg;
    const ptySession = this.sessions.get(sessionId);

    if (!ptySession) {
      await session.sendError('UNKNOWN_SESSION', `Session ${sessionId} not found`);
      return;
    }

    ptySession.lastActivity = Date.now();
    
    // Map signal names to kill signals
    const signalMap: Record<string, NodeJS.Signals> = {
      'SIGINT': 'SIGINT',
      'SIGTERM': 'SIGTERM',
      'SIGHUP': 'SIGHUP',
      'SIGQUIT': 'SIGQUIT',
    };

    const killSignal = signalMap[signal];
    if (killSignal) {
      ptySession.pty.kill(killSignal);
      logger.info({ sessionId, signal }, 'Signal sent to PTY');
    }
  }

  private getMinimalEnv(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      TERM: 'xterm-256color',
      LANG: process.env.LANG || 'en_US.UTF-8',
      HOME: process.env.HOME || '/tmp',
      USER: process.env.USER || 'user',
    };

    // Add any additional safe environment variables
    const safeVars = ['TZ', 'LC_ALL', 'LC_CTYPE'];
    for (const varName of safeVars) {
      if (process.env[varName]) {
        env[varName] = process.env[varName];
      }
    }

    return env;
  }

  private checkIdleSessions(): void {
    const idleTimeout = parseInt(process.env.TTY_IDLE_TIMEOUT_MS || '1200000', 10); // 20 minutes default
    const now = Date.now();

    for (const [sessionId, ptySession] of this.sessions) {
      if (now - ptySession.lastActivity > idleTimeout) {
        logger.info({ sessionId }, 'Closing idle PTY session');
        ptySession.pty.kill('SIGHUP');
        // Let the onExit handler clean up the session
      }
    }
  }

  cleanup(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    for (const [sessionId, ptySession] of this.sessions) {
      logger.info({ sessionId }, 'Cleaning up PTY session');
      ptySession.pty.kill('SIGTERM');
    }
    this.sessions.clear();
  }
}