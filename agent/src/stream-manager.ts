import { validateArguments, getConfig, OutputHandler } from '@thenewlabs/entangle-utils';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
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
}

interface StreamManagerOptions {
  policy: Policy;
  output: OutputHandler;
  onStreamData?: (sid: string, data: Uint8Array) => void;
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
    
    // Fallback to global limits divided by max streams
    const maxStreams = this.policy.maxStreams || 1;
    const limits: Stream['limits'] = {};
    
    if (this.policy.maxCpuMs !== undefined) {
      limits.cpuMs = Math.floor(this.policy.maxCpuMs / maxStreams);
    }
    if (this.policy.maxMemMB !== undefined) {
      limits.memMB = Math.floor(this.policy.maxMemMB / maxStreams);
    }
    if (this.policy.maxWallMs !== undefined) {
      limits.wallMs = Math.floor(this.policy.maxWallMs / maxStreams);
    }
    if (this.policy.maxOutBytes !== undefined) {
      limits.maxOutBytes = Math.floor(this.policy.maxOutBytes / maxStreams);
    }
    
    return limits;
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

    // Create PTY
    const ptyProcess = pty.spawn(process.env.SHELL || '/bin/bash', [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
      },
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

      this.options.onStreamData?.(sid, chunk);
    });

    // Handle PTY exit
    ptyProcess.onExit((exitCode) => {
      stream.endedAt = Date.now();
      stream.usage.wallMs = stream.endedAt - stream.startedAt;
      
      this.output.info(`PTY stream exited for ${sid}: code=${exitCode.exitCode}, signal=${exitCode.signal}`);
      this.options.onStreamExit?.(sid, exitCode.exitCode ?? null, exitCode.signal ? String(exitCode.signal) : null, stream.usage);
      this.streams.delete(sid);
    });

    this.streams.set(sid, stream);
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

    // Spawn process
    const spawnOptions: SpawnOptions = {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (options.cwd) {
      spawnOptions.cwd = options.cwd;
    }
    if (options.env) {
      spawnOptions.env = { ...process.env, ...options.env } as NodeJS.ProcessEnv;
    }
    
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

    // Handle stdout
    const handleOutput = (chunk: Buffer) => {
      if (stream.aborted) return;

      stream.usage.outBytes += chunk.length;

      // Check output limit
      if (limits.maxOutBytes && stream.usage.outBytes > limits.maxOutBytes) {
        this.output.warn(`Stream output limit exceeded for ${sid}: limit=${limits.maxOutBytes}`);
        this.closeStream(sid, 'Output limit exceeded');
        return;
      }

      this.options.onStreamData?.(sid, chunk);
    };
    
    if (childProcess.stdout) {
      childProcess.stdout.on('data', handleOutput);
    }

    // Handle stderr (also counts toward output)
    if (childProcess.stderr) {
      childProcess.stderr.on('data', handleOutput);
    }

    // Handle process exit
    childProcess.on('exit', (code: number | null, signal: string | null) => {
      stream.endedAt = Date.now();
      stream.usage.wallMs = stream.endedAt - stream.startedAt;
      
      this.output.info(`Command stream exited for ${sid}: code=${code}, signal=${signal}`);
      this.options.onStreamExit?.(sid, code, signal, stream.usage);
      this.streams.delete(sid);
    });

    // Handle process errors
    childProcess.on('error', (err: Error) => {
      this.output.error(`Command stream error for ${sid}`, err.message);
      this.options.onStreamError?.(sid, err.message);
      this.streams.delete(sid);
    });

    this.streams.set(sid, stream);
    this.output.info(`Opened command stream ${sid}: ${options.argv.join(' ')}`);

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
        // Give it time to clean up
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
          }
        }, 5000);
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