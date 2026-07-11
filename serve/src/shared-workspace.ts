import { OutputHandler } from '@thenewlabs/entangle-utils';
import type { WindowInfo, WindowStateBody } from '@thenewlabs/entangle-protocol';
import { SharedSession } from './shared-session.js';

/**
 * A client's viewport onto the shared workspace.
 *
 * Each client keeps ONE pty stream (the sid from STREAM_OPEN); the workspace
 * multiplexes the ACTIVE window's output onto it via {@link onData}, repaints it
 * on a window switch (also via {@link onData}: a clear + the new window's
 * replay), and pushes the current {@link WindowStateBody} to it via
 * {@link onWindowState} on every change. `onExit` fires only when the workspace
 * as a whole ends (its last window exits) — closing a non-last window just
 * repaints, it does not end the viewport.
 */
export interface Viewport {
  sid: string;
  onData: (chunk: Uint8Array) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onWindowState: (state: WindowStateBody) => void;
}

/** Screen clear + home used to repaint a viewport/host on a window switch. */
const CLEAR = Buffer.from('\x1b[2J\x1b[3J\x1b[H', 'utf8');

/** Hard cap on concurrent windows so a client can't spawn unbounded shells. */
const DEFAULT_MAX_WINDOWS = 16;

/**
 * A shared, tmux-style workspace of windows synced across every attached client.
 *
 * The workspace holds N windows, each its own {@link SharedSession} PTY; every
 * window keeps running in the background but only the ONE global active window's
 * output is streamed to clients' viewports and to the host terminal. Client
 * keystrokes go to the active window; the host terminal size is authoritative
 * and every window is sized to it.
 *
 * The host terminal binds to a workspace exactly as it used to bind to a single
 * SharedSession — {@link onHostData}, {@link onViewersChange}, {@link onExit},
 * {@link resize}, {@link write}, {@link getReplay}, {@link viewerCount} — so a
 * single-window workspace behaves identically to the old shared terminal.
 */
export class SharedWorkspace {
  private windows: SharedSession[] = [];
  private activeIndex = 0;
  private viewports = new Map<string, Viewport>();
  private exited = false;

  private readonly cwd?: string;
  private readonly maxReplayBytes?: number;
  private readonly maxWindows: number;

  private hostDataCb?: (chunk: Buffer) => void;
  private exitCb?: (code: number | null, signal: string | null) => void;
  private viewersChangedCb?: (count: number) => void;
  private hostWindowStateCb?: (state: WindowStateBody) => void;

  public cols: number;
  public rows: number;

  constructor(
    private output: OutputHandler,
    opts: { cols: number; rows: number; cwd?: string; maxReplayBytes?: number; maxWindows?: number }
  ) {
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    if (opts.cwd !== undefined) this.cwd = opts.cwd;
    if (opts.maxReplayBytes !== undefined) this.maxReplayBytes = opts.maxReplayBytes;
    this.maxWindows = opts.maxWindows ?? DEFAULT_MAX_WINDOWS;

    // Start with a single window so the existing single-shell behavior is
    // preserved when nobody ever creates a second one.
    const first = this.spawnWindow();
    this.windows.push(first);
    this.activeIndex = 0;
    this.bindActiveOutput();

    this.output.info(`Shared workspace started: 1 window, cols=${this.cols}, rows=${this.rows}`);
  }

  // --- host-facing API (mirrors the old SharedSession surface) -------------

  /** Register the host's local rendering callback for the active window. */
  onHostData(cb: (chunk: Buffer) => void): void { this.hostDataCb = cb; }

  /** Register a callback fired once when the workspace ends (last window exits). */
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }

  /** Register a callback fired whenever the attached-viewport count changes. */
  onViewersChange(cb: (count: number) => void): void { this.viewersChangedCb = cb; }

  /**
   * Register a host callback fired whenever the window set changes — create,
   * close, switch, or rename. Lets the host render its own tab bar in-process
   * (the analogue of the {@link Viewport.onWindowState} push sent to clients).
   * Fires with the current {@link windowState}.
   */
  onWindowState(cb: (state: WindowStateBody) => void): void { this.hostWindowStateCb = cb; }

  get hasExited(): boolean { return this.exited; }

  /** Merge input (from the host) into the ACTIVE window. */
  write(data: Uint8Array | string): void {
    if (this.exited) return;
    this.windows[this.activeIndex]?.write(data);
  }

  /** Resize the workspace (host is authoritative) — every window is sized to it. */
  resize(cols: number, rows: number): void {
    if (this.exited || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    for (const w of this.windows) w.resize(cols, rows);
  }

  /** Recent-output snapshot of the ACTIVE window (host's initial paint). */
  getReplay(): Uint8Array {
    return this.windows[this.activeIndex]?.getReplay() ?? new Uint8Array(0);
  }

  /** Number of attached client viewports. */
  viewerCount(): number { return this.viewports.size; }

  /** Kill every window (which drives the workspace to exit). */
  kill(): void {
    for (const w of this.windows) {
      try { w.kill(); } catch {}
    }
  }

  // --- viewport-facing API (clients) ---------------------------------------

  /**
   * Attach a client viewport. Returns the current active-window replay so the
   * caller can send it as the viewport's initial output. The caller should then
   * send the current {@link windowState} so the client's tab bar populates.
   */
  attachViewport(v: Viewport): { replay: Uint8Array } {
    this.viewports.set(v.sid, v);
    this.output.info(`Viewport attached: ${v.sid} (${this.viewports.size} total)`);
    this.viewersChangedCb?.(this.viewports.size);
    return { replay: this.getReplay() };
  }

  /** Detach a client viewport (disconnect / stream close). */
  detachViewport(sid: string): void {
    if (this.viewports.delete(sid)) {
      this.output.info(`Viewport detached: ${sid} (${this.viewports.size} remaining)`);
      this.viewersChangedCb?.(this.viewports.size);
    }
  }

  /** Route a viewport's keystrokes to the ACTIVE window. */
  writeFromViewport(sid: string, data: Uint8Array | string): void {
    if (this.exited || !this.viewports.has(sid)) return;
    this.windows[this.activeIndex]?.write(data);
  }

  /**
   * Repaint a SINGLE viewport with the ACTIVE window's screen (the same
   * clear + replay a window switch sends, scoped to one sid). The host stays
   * authoritative over the shell size, so when a remote viewer resizes we can't
   * resize the PTY under everyone else; instead we re-send the active window's
   * screen to that viewer so its locally-corrupted display is redrawn clean.
   */
  repaintViewport(sid: string): void {
    if (this.exited) return;
    const v = this.viewports.get(sid);
    if (!v) return;
    const active = this.windows[this.activeIndex];
    if (!active) return;
    const payload = Buffer.concat([CLEAR, Buffer.from(active.getReplay())]);
    try { v.onData(new Uint8Array(payload)); } catch {}
  }

  // --- window operations (WINDOW_CTL client->server) -----------------------

  /** Create a new window and switch to it. */
  newWindow(): void {
    if (this.exited) return;
    if (this.windows.length >= this.maxWindows) {
      this.output.warn(`Window cap reached (${this.maxWindows}); ignoring new-window`);
      return;
    }
    const win = this.spawnWindow();
    this.windows.push(win);
    this.setActive(this.windows.length - 1);
    this.broadcastWindowState();
  }

  /** Switch the global active window to `index` (no-op if out of range/current). */
  selectWindow(index: number): void {
    if (this.exited) return;
    if (index < 0 || index >= this.windows.length || index === this.activeIndex) return;
    this.setActive(index);
    this.broadcastWindowState();
  }

  /** Switch to the next window (wraps). */
  nextWindow(): void {
    if (this.windows.length < 2) return;
    this.selectWindow((this.activeIndex + 1) % this.windows.length);
  }

  /** Switch to the previous window (wraps). */
  prevWindow(): void {
    if (this.windows.length < 2) return;
    this.selectWindow((this.activeIndex - 1 + this.windows.length) % this.windows.length);
  }

  /**
   * Close the window at `index`. Killing its PTY drives the shared exit path,
   * which removes the window, re-homes the active index, and broadcasts. Closing
   * the last window ends the whole workspace.
   */
  closeWindow(index: number): void {
    if (this.exited) return;
    if (index < 0 || index >= this.windows.length) return;
    try { this.windows[index]!.kill(); } catch {}
  }

  /** Rename the window at `index` and broadcast the change. */
  renameWindow(index: number, title: string): void {
    if (this.exited) return;
    const win = this.windows[index];
    if (!win) return;
    win.title = title;
    this.broadcastWindowState();
  }

  /** Current window state (the `msg` body of a window-state frame). */
  windowState(): WindowStateBody {
    const windows: WindowInfo[] = this.windows.map((w) => ({ id: w.id, title: w.title }));
    return { v: 1, kind: 'window-state', windows, activeIndex: this.activeIndex };
  }

  // --- internals -----------------------------------------------------------

  private spawnWindow(): SharedSession {
    const win = new SharedSession(this.output, {
      cols: this.cols,
      rows: this.rows,
      ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
      ...(this.maxReplayBytes !== undefined ? { maxReplayBytes: this.maxReplayBytes } : {}),
    });
    win.onExit((code, signal) => this.handleWindowExit(win, code, signal));
    return win;
  }

  /**
   * Tap the active window's output and fan it out to the host + every viewport.
   * Only the active window is tapped; background windows keep running silently.
   */
  private bindActiveOutput(): void {
    const active = this.windows[this.activeIndex];
    if (!active) return;
    active.onHostData((chunk) => {
      this.hostDataCb?.(chunk);
      if (this.viewports.size === 0) return;
      const bytes = new Uint8Array(chunk);
      for (const v of this.viewports.values()) {
        try { v.onData(bytes); } catch {}
      }
    });
  }

  /**
   * Switch the active window: detach the old window's output tap, tap the new
   * one, and repaint the host + every viewport (clear + new window's replay).
   * Does NOT broadcast window-state — callers pair this with broadcastWindowState.
   */
  private setActive(index: number): void {
    const prev = this.windows[this.activeIndex];
    if (prev) prev.onHostData(() => {}); // stop tapping the now-background window
    this.activeIndex = index;
    this.bindActiveOutput();
    this.repaintAll();
  }

  /** Repaint the host + every viewport with a clear + the active window's replay. */
  private repaintAll(): void {
    const active = this.windows[this.activeIndex];
    if (!active) return;
    const payload = Buffer.concat([CLEAR, Buffer.from(active.getReplay())]);
    this.hostDataCb?.(payload);
    if (this.viewports.size > 0) {
      const bytes = new Uint8Array(payload);
      for (const v of this.viewports.values()) {
        try { v.onData(bytes); } catch {}
      }
    }
  }

  /** Notify the host + every attached client of the current window-state. */
  broadcastWindowState(): void {
    const state = this.windowState();
    this.hostWindowStateCb?.(state);
    if (this.viewports.size === 0) return;
    for (const v of this.viewports.values()) {
      try { v.onWindowState(state); } catch {}
    }
  }

  private handleWindowExit(win: SharedSession, code: number | null, signal: string | null): void {
    const idx = this.windows.indexOf(win);
    if (idx === -1) return;
    const wasActive = idx === this.activeIndex;
    this.windows.splice(idx, 1);

    // Last window gone: the whole workspace ends. Tell every viewport and the
    // host so the client streams and host process wind down.
    if (this.windows.length === 0) {
      this.exited = true;
      for (const v of this.viewports.values()) {
        try { v.onExit(code, signal); } catch {}
      }
      this.viewports.clear();
      this.exitCb?.(code, signal);
      return;
    }

    if (wasActive) {
      // Re-home the active index onto a surviving neighbor and repaint everyone.
      this.activeIndex = Math.min(idx, this.windows.length - 1);
      this.bindActiveOutput();
      this.repaintAll();
    } else if (idx < this.activeIndex) {
      // A window before the active one vanished; keep pointing at the same window.
      this.activeIndex -= 1;
    }
    this.broadcastWindowState();
  }
}
