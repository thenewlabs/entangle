import { validateArguments, validateCwd, buildChildEnv, getConfig, OutputHandler } from '@thenewlabs/entangle-utils';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { realpathSync } from 'fs';
import { resolve as resolvePath } from 'path';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { 
  StreamMode, 
  StreamMetadata, 
  StreamUsage,
  StreamPtyOptions,
  StreamExecOptions,
  Policy
} from '@thenewlabs/entangle-protocol';

export interface Stream {
  sid: string;
  mode: StreamMode;
  startedAt: number;
  endedAt?: number;
  process?: ChildProcess | pty.IPty;
  usage: StreamUsage;
  aborted: boolean;
  limits: {
    cpuMs?: number;
    memMB?: number;
    wallMs?: number;
    maxOutBytes?: number;
  };
  wallTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface StreamManagerOptions {
  policy: Policy;
  output: OutputHandler;
  onStreamData?: (sid: string, data: Uint8Array, channel: 'stdout' | 'stderr') => void;
  onStreamExit?: (sid: string, code: number | null, signal: string | null, usage?: StreamUsage) => void;
  onStreamError?: (sid: string, error: string) => void;
}

export class StreamManager extends EventEmitter {
  private streams = new Map<string, Stream>();
  private policy: Policy;
  private output: OutputHandler;
  private aggregateUsage: StreamUsage = {
    cpuMs: 0,
    rssMaxBytes: 0,
    wallMs: 0,
    outBytes: 0,
  };

  constructor(private options: StreamManagerOptions) {
    super();
    this.policy = options.policy;
    this.output = options.output;
  }

  /**
   * Generate a unique stream ID
   */
  private generateStreamId(): string {
    return randomBytes(8).toString('base64url');
  }

  /**
   * Resolve a requested cwd and enforce the AGENT_ALLOWED_CWD allow-list.
   * Symlinks are resolved (realpath) BEFORE the prefix check so a symlink
   * inside an allowed dir can't point the process outside it. Throws if the
   * resolved path is not within an allowed prefix.
   */
  private resolveCwd(requestedCwd?: string): string {
    const config = getConfig();
    const base = requestedCwd
      ? resolvePath(config.agentDefaultCwd, requestedCwd)
      : config.agentDefaultCwd;

    let real = base;
    try {
      real = realpathSync(base);
    } catch {
      // Path may not exist yet; validate the resolved (non-symlink) form.
    }

    // Boundary-aware prefix check (see utils validateCwd).
    validateCwd(real, config.agentAllowedCwd);
    return real;
  }

  /**
   * Check if we can open a new stream
   */
  private canOpenStream(): { allowed: boolean; reason?: string } {
    const maxStreams = this.policy.maxStreams || 1;
    
    if (this.streams.size >= maxStreams) {
      return { allowed: false, reason: `Maximum streams (${maxStreams}) reached` };
    }

    return { allowed: true };
  }

  /**
   * Get stream-specific limits
   */
  private getStreamLimits(): Stream['limits'] {
    if (this.policy.perStream) {
      const limits: Stream['limits'] = {};
      if (this.policy.perStream.maxCpuMs !== undefined) {
        limits.cpuMs = this.policy.perStream.maxCpuMs;
      }
      if (this.policy.perStream.maxMemMB !== undefined) {
        limits.memMB = this.policy.perStream.maxMemMB;
      }
      if (this.policy.perStream.maxWallMs !== undefined) {
        limits.wallMs = this.policy.perStream.maxWallMs;
      }
      if (this.policy.perStream.maxOutBytes !== undefined) {
        limits.maxOutBytes = this.policy.perStream.maxOutBytes;
      }
      return limits;
    }
    
    // Fallback to global limits divided by max streams. Where the policy is
    // silent we still apply the operator-configured ceilings so every stream is
    // bounded by default (a capability created without explicit limits must not
    // run unbounded).
    const maxStreams = this.policy.maxStreams || 1;
    const config = getConfig();
    const limits: Stream['limits'] = {};

    if (this.policy.maxCpuMs !== undefined) {
      limits.cpuMs = Math.floor(this.policy.maxCpuMs / maxStreams);
    }
    if (this.policy.maxMemMB !== undefined) {
      limits.memMB = Math.floor(this.policy.maxMemMB / maxStreams);
    }

    const wallMs = this.policy.maxWallMs ?? config.cmdDefaultWallMs;
    if (wallMs > 0) {
      limits.wallMs = Math.floor(wallMs / maxStreams);
    }

    const maxOutBytes = this.policy.maxOutBytes ?? config.maxOutBytes;
    if (maxOutBytes > 0) {
      limits.maxOutBytes = Math.floor(maxOutBytes / maxStreams);
    }

    return limits;
  }

  /**
   * Arm a wall-clock deadline that force-closes the stream if it outlives its
   * limit. Unref'd so the timer never keeps the process alive on its own.
   */
  private armWallClock(stream: Stream): void {
    const wallMs = stream.limits.wallMs;
    if (!wallMs || wallMs <= 0) return;
    stream.wallTimer = setTimeout(() => {
      const current = this.streams.get(stream.sid);
      if (current && current.endedAt === undefined) {
        this.output.warn(`Stream wall-clock limit exceeded for ${stream.sid}: limit=${wallMs}ms`);
        this.closeStream(stream.sid, 'Wall-clock limit exceeded');
      }
    }, wallMs);
    if (typeof stream.wallTimer.unref === 'function') stream.wallTimer.unref();
  }

  /**
   * (Re)arm the PTY idle timeout. Called on every byte of PTY output so an
   * interactive session is only reaped after genuine inactivity.
   */
  private armIdleTimeout(stream: Stream, idleMs: number): void {
    if (!idleMs || idleMs <= 0) return;
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => {
      const current = this.streams.get(stream.sid);
      if (current && current.endedAt === undefined) {
        this.output.warn(`PTY idle timeout for ${stream.sid}: idle=${idleMs}ms`);
        this.closeStream(stream.sid, 'Idle timeout');
      }
    }, idleMs);
    if (typeof stream.idleTimer.unref === 'function') stream.idleTimer.unref();
  }

  private clearTimers(stream: Stream): void {
    if (stream.wallTimer) { clearTimeout(stream.wallTimer); delete stream.wallTimer; }
    if (stream.idleTimer) { clearTimeout(stream.idleTimer); delete stream.idleTimer; }
  }

  /**
   * Open a new PTY stream
   */
  async openPtyStream(options: StreamPtyOptions & { cwd?: string }): Promise<string> {
    const check = this.canOpenStream();
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    const sid = this.generateStreamId();
    const limits = this.getStreamLimits();
    const config = getConfig();
    const cwd = this.resolveCwd(options.cwd);
    const env = buildChildEnv(config.agentEnvPassthrough, options.env);
    env.TERM = 'xterm-256color';

    // Create PTY
    const ptyProcess = pty.spawn(config.agentShell, [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd,
      env,
    });

    const stream: Stream = {
      sid,
      mode: 'pty',
      startedAt: Date.now(),
      process: ptyProcess,
      usage: { cpuMs: 0, rssMaxBytes: 0, wallMs: 0, outBytes: 0 },
      aborted: false,
      limits,
    };

    const idleMs = config.ttyIdleTimeoutMs;

    // Handle PTY data
    ptyProcess.onData((data) => {
      if (stream.aborted) return;

      const chunk = Buffer.from(data);
      stream.usage.outBytes += chunk.length;

      // Check output limit
      if (limits.maxOutBytes && stream.usage.outBytes > limits.maxOutBytes) {
        this.output.warn(`Stream output limit exceeded for ${sid}: limit=${limits.maxOutBytes}`);
        this.closeStream(sid, 'Output limit exceeded');
        return;
      }

      this.armIdleTimeout(stream, idleMs);
      this.options.onStreamData?.(sid, chunk, 'stdout');
    });

    // Handle PTY exit
    ptyProcess.onExit((exitCode) => {
      stream.endedAt = Date.now();
      stream.usage.wallMs = stream.endedAt - stream.startedAt;
      this.clearTimers(stream);

      this.output.info(`PTY stream exited for ${sid}: code=${exitCode.exitCode}, signal=${exitCode.signal}`);
      this.options.onStreamExit?.(sid, exitCode.exitCode ?? null, exitCode.signal ? String(exitCode.signal) : null, stream.usage);
      this.streams.delete(sid);
    });

    this.streams.set(sid, stream);
    this.armWallClock(stream);
    this.armIdleTimeout(stream, idleMs);
    this.output.info(`Opened PTY stream ${sid}: cols=${options.cols}, rows=${options.rows}`);

    return sid;
  }

  /**
   * Open a new command stream
   */
  async openCmdStream(options: StreamExecOptions): Promise<string> {
    const check = this.canOpenStream();
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    // Validate arguments
    try {
      const config = getConfig();
      validateArguments(options.argv, config.maxArgCount, config.maxArgLen);
    } catch (err: any) {
      throw new Error(`Invalid arguments: ${err.message}`);
    }

    const sid = this.generateStreamId();
    const limits = this.getStreamLimits();
    const config = getConfig();

    // Spawn process with a validated cwd and a minimal, curated environment.
    const spawnOptions: SpawnOptions = {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.resolveCwd(options.cwd),
      env: buildChildEnv(config.agentEnvPassthrough, options.env) as NodeJS.ProcessEnv,
    };

    if (!options.argv || options.argv.length === 0) {
      throw new Error('No command specified');
    }
    
    const [command, ...args] = options.argv;
    if (!command) {
      throw new Error('No command specified');
    }
    
    const childProcess = spawn(command, args, spawnOptions) as any;

    const stream: Stream = {
      sid,
      mode: 'cmd',
      startedAt: Date.now(),
      process: childProcess,
      usage: { cpuMs: 0, rssMaxBytes: 0, wallMs: 0, outBytes: 0 },
      aborted: false,
      limits,
    };

    // Handle stdout / stderr (both count toward the output ceiling, but are
    // tagged so the invoker can route them to the right fd).
    const handleOutput = (channel: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (stream.aborted) return;

      stream.usage.outBytes += chunk.length;

      // Check output limit
      if (limits.maxOutBytes && stream.usage.outBytes > limits.maxOutBytes) {
        this.output.warn(`Stream output limit exceeded for ${sid}: limit=${limits.maxOutBytes}`);
        this.closeStream(sid, 'Output limit exceeded');
        return;
      }

      this.options.onStreamData?.(sid, chunk, channel);
    };

    if (childProcess.stdout) {
      childProcess.stdout.on('data', handleOutput('stdout'));
    }

    if (childProcess.stderr) {
      childProcess.stderr.on('data', handleOutput('stderr'));
    }

    // Use 'close' (not 'exit') so all stdout/stderr 'data' events have been
    // emitted before we report exit. Otherwise a fast command can emit EXIT
    // ahead of its final output, and the client — which tears the stream down
    // on exit — would drop that trailing data.
    childProcess.on('close', (code: number | null, signal: string | null) => {
      stream.endedAt = Date.now();
      stream.usage.wallMs = stream.endedAt - stream.startedAt;
      this.clearTimers(stream);

      this.output.info(`Command stream exited for ${sid}: code=${code}, signal=${signal}`);
      this.options.onStreamExit?.(sid, code, signal, stream.usage);
      this.streams.delete(sid);
    });

    // Handle process errors
    childProcess.on('error', (err: Error) => {
      this.clearTimers(stream);
      this.output.error(`Command stream error for ${sid}`, err.message);
      this.options.onStreamError?.(sid, err.message);
      this.streams.delete(sid);
    });

    this.streams.set(sid, stream);
    this.armWallClock(stream);
    // Log the command name and arg count only; full argv can carry secrets.
    this.output.info(`Opened command stream ${sid}: ${command} (${args.length} args)`);

    return sid;
  }

  /**
   * Write data to a stream (stdin)
   */
  writeToStream(sid: string, data: Uint8Array): void {
    const stream = this.streams.get(sid);
    if (!stream) {
      throw new Error(`Unknown stream: ${sid}`);
    }

    if (stream.aborted) {
      throw new Error(`Stream ${sid} is aborted`);
    }

    if (stream.mode === 'pty') {
      const ptyProcess = stream.process as pty.IPty;
      ptyProcess.write(Buffer.from(data).toString());
    } else {
      const childProcess = stream.process as ChildProcess;
      if (childProcess.stdin && !childProcess.stdin.destroyed) {
        childProcess.stdin.write(data);
      }
    }
  }

  /**
   * Resize a PTY stream
   */
  resizePtyStream(sid: string, cols: number, rows: number): void {
    const stream = this.streams.get(sid);
    if (!stream) {
      throw new Error(`Unknown stream: ${sid}`);
    }

    if (stream.mode !== 'pty') {
      throw new Error(`Stream ${sid} is not a PTY`);
    }

    const ptyProcess = stream.process as pty.IPty;
    ptyProcess.resize(cols, rows);
    this.output.debug(`Resized PTY stream ${sid}: cols=${cols}, rows=${rows}`);
  }

  /**
   * Send signal to a stream
   */
  signalStream(sid: string, signal: NodeJS.Signals): void {
    const stream = this.streams.get(sid);
    if (!stream) {
      throw new Error(`Unknown stream: ${sid}`);
    }

    if (stream.mode === 'pty') {
      const ptyProcess = stream.process as pty.IPty;
      ptyProcess.kill(signal as string);
    } else {
      const childProcess = stream.process as ChildProcess;
      childProcess.kill(signal);
    }

    this.output.info(`Sent signal ${signal} to stream ${sid}`);
  }

  /**
   * Close a stream
   */
  closeStream(sid: string, reason?: string): void {
    const stream = this.streams.get(sid);
    if (!stream) {
      return; // Already closed
    }

    stream.aborted = true;
    this.clearTimers(stream);

    if (stream.mode === 'pty') {
      const ptyProcess = stream.process as pty.IPty;
      try {
        ptyProcess.kill();
      } catch (err) {
        this.output.error(`Failed to kill PTY for stream ${sid}`, err instanceof Error ? err.message : String(err));
      }
    } else {
      const childProcess = stream.process as ChildProcess;
      try {
        childProcess.kill('SIGTERM');
        // Escalate to SIGKILL if the process has not actually exited. Note:
        // childProcess.killed only means "a signal was delivered", so it is
        // true right after SIGTERM and must NOT gate escalation. We key off the
        // real exit state instead: the 'close' handler deletes the stream from
        // the map and sets endedAt, so a still-present, not-yet-ended stream is
        // one that ignored SIGTERM.
        const timer = setTimeout(() => {
          const current = this.streams.get(sid);
          if (current && current.endedAt === undefined) {
            try { childProcess.kill('SIGKILL'); } catch {}
          }
        }, 5000);
        // Don't keep the event loop alive just for the escalation timer.
        if (typeof timer.unref === 'function') timer.unref();
      } catch (err) {
        this.output.error(`Failed to kill process for stream ${sid}`, err instanceof Error ? err.message : String(err));
      }
    }

    this.output.info(`Closed stream ${sid}: reason=${reason}`);
  }

  /**
   * Close all streams
   */
  closeAllStreams(reason?: string): void {
    for (const sid of this.streams.keys()) {
      this.closeStream(sid, reason);
    }
  }

  /**
   * Get stream info
   */
  getStream(sid: string): Stream | undefined {
    return this.streams.get(sid);
  }

  /**
   * Get all active streams
   */
  getActiveStreams(): StreamMetadata[] {
    return Array.from(this.streams.values()).map(stream => {
      const metadata: StreamMetadata = {
        sid: stream.sid,
        mode: stream.mode,
        startedAt: stream.startedAt,
      };
      if (stream.endedAt !== undefined) {
        metadata.endedAt = stream.endedAt;
      }
      return metadata;
    });
  }

  /**
   * Get aggregate usage across all streams
   */
  getAggregateUsage(): StreamUsage {
    return this.aggregateUsage;
  }
}