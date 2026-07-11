import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { randomBytes } from 'crypto';
import { getConfig, buildChildEnv, OutputHandler } from '@thenewlabs/entangle-utils';

/**
 * A viewer attached to the shared session. `onData` receives every byte the
 * shared shell emits; `onExit` fires once when the shell terminates.
 */
export interface Viewer {
  sid: string;
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

/**
 * A single shared PTY — the per-window unit of a {@link SharedWorkspace}.
 *
 * Unlike the per-stream shells the StreamManager spawns, there is exactly ONE
 * shell here: its output fans out to the host renderer and all viewers, and its
 * input is merged from the host and all viewers (collaborative). Late joiners
 * get a bounded replay of recent output so their screen syncs on attach.
 *
 * The host terminal size is authoritative — the shell is sized to the host's
 * (inner) region and viewers render that stream in their own terminals.
 *
 * In the multi-window model a SharedWorkspace owns N of these (one per window)
 * and taps the ACTIVE one via {@link onHostData} + {@link getReplay}; `id` and
 * `title` identify the window in the WINDOW_CTL window-state broadcast.
 */
export class SharedSession {
  private ptyProcess: pty.IPty;
  private viewers = new Map<string, Viewer>();
  private replay: Buffer[] = [];
  private replayBytes = 0;
  private readonly maxReplayBytes: number;
  private exited = false;

  private hostDataCb?: (chunk: Buffer) => void;
  private exitCb?: (code: number | null, signal: string | null) => void;
  private viewersChangedCb?: (count: number) => void;

  public cols: number;
  public rows: number;

  /** Stable identifier for this window (used in window-state broadcasts). */
  public readonly id: string;
  /** Human-readable window title (shown in client tab bars; renamable). */
  public title: string;

  constructor(
    private output: OutputHandler,
    opts: { cols: number; rows: number; cwd?: string; maxReplayBytes?: number; id?: string; title?: string }
  ) {
    const config = getConfig();
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.maxReplayBytes = opts.maxReplayBytes ?? 256 * 1024;
    this.id = opts.id ?? randomBytes(6).toString('base64url');
    this.title = opts.title ?? 'shell';

    const env = buildChildEnv(config.agentEnvPassthrough, {});
    env.TERM = 'xterm-256color';

    this.ptyProcess = pty.spawn(config.agentShell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: opts.cwd || config.agentDefaultCwd,
      env,
    });

    this.ptyProcess.onData((data) => {
      const buf = Buffer.from(data, 'utf8');
      this.appendReplay(buf);
      this.hostDataCb?.(buf);
      const bytes = new Uint8Array(buf);
      for (const v of this.viewers.values()) {
        try { v.onData(bytes); } catch {}
      }
    });

    this.ptyProcess.onExit((e) => {
      this.exited = true;
      const code = e.exitCode ?? null;
      const signal = e.signal !== undefined && e.signal !== null ? String(e.signal) : null;
      for (const v of this.viewers.values()) {
        try { v.onExit(code, signal); } catch {}
      }
      this.viewers.clear();
      this.exitCb?.(code, signal);
    });

    this.output.info(`Shared session started: shell=${config.agentShell}, cols=${this.cols}, rows=${this.rows}`);
  }

  /** Register a callback for the host's local rendering of the shell output. */
  onHostData(cb: (chunk: Buffer) => void): void { this.hostDataCb = cb; }

  /** Register a callback fired once when the shared shell exits. */
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }

  /** Register a callback fired whenever the attached-viewer count changes. */
  onViewersChange(cb: (count: number) => void): void { this.viewersChangedCb = cb; }

  get hasExited(): boolean { return this.exited; }

  /** Merge input (from host or a viewer) into the shared shell. */
  write(data: Uint8Array | string): void {
    if (this.exited) return;
    this.ptyProcess.write(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  }

  /** Resize the shared shell (host is authoritative). */
  resize(cols: number, rows: number): void {
    if (this.exited || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    try { this.ptyProcess.resize(cols, rows); } catch {}
  }

  /**
   * Attach a viewer. Returns the current replay snapshot so the caller can send
   * it to the viewer as the initial output and sync its screen.
   */
  attach(viewer: Viewer): { replay: Uint8Array } {
    this.viewers.set(viewer.sid, viewer);
    this.output.info(`Viewer attached: ${viewer.sid} (${this.viewers.size} total)`);
    this.viewersChangedCb?.(this.viewers.size);
    return { replay: this.replaySnapshot() };
  }

  /** Detach a viewer (disconnect / stream close). */
  detach(sid: string): void {
    if (this.viewers.delete(sid)) {
      this.output.info(`Viewer detached: ${sid} (${this.viewers.size} remaining)`);
      this.viewersChangedCb?.(this.viewers.size);
    }
  }

  viewerCount(): number { return this.viewers.size; }

  /** Current replay snapshot (recent output), e.g. for the host's initial paint. */
  getReplay(): Uint8Array { return this.replaySnapshot(); }

  kill(): void {
    if (this.exited) return;
    try { this.ptyProcess.kill(); } catch {}
  }

  private appendReplay(buf: Buffer): void {
    this.replay.push(buf);
    this.replayBytes += buf.length;
    // Drop oldest chunks once the bounded buffer is exceeded. Keep at least one
    // chunk so a single large burst still replays something.
    while (this.replayBytes > this.maxReplayBytes && this.replay.length > 1) {
      const dropped = this.replay.shift()!;
      this.replayBytes -= dropped.length;
    }
  }

  private replaySnapshot(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.replay, this.replayBytes));
  }
}
