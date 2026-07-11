import { OutputHandler } from '@thenewlabs/entangle-utils';
import type { WindowInfo, WindowStateBody } from '@thenewlabs/entangle-protocol';
import { SharedSession } from './shared-session.js';

/**
 * A client's viewport onto the shared workspace.
 *
 * Each client keeps ONE pty stream (the sid from STREAM_OPEN) but views ONE
 * window of its own choosing — its "active" window. The workspace multiplexes
 * that window's output onto the stream via {@link onData}, repaints it on a
 * per-viewport window switch (also via {@link onData}: a clear + the new
 * window's replay), and pushes that viewport's own {@link WindowStateBody} to
 * it via {@link onWindowState} on every change. Different viewports can sit on
 * different windows independently (or share one by being on the same window).
 * `onExit` fires only when the workspace as a whole ends (its last window
 * exits) — closing a non-last window just re-homes/repaints, it does not end
 * the viewport.
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
 * A shared, tmux-style workspace of windows with a PER-CONSUMER active window.
 *
 * The workspace holds N windows, each its own {@link SharedSession} PTY. Every
 * window keeps running in the background and its output is tapped once (in
 * {@link spawnWindow}); each chunk is routed only to the CONSUMERS whose active
 * window is the one that emitted it. A "consumer" is either the HOST (the
 * host-channel callbacks, with its own {@link hostActiveIndex}) or a viewport
 * (each with its own active index tracked in {@link viewportActive}). This lets
 * connected viewers work on different windows independently instead of all
 * following a single global active window.
 *
 * The host terminal binds to a workspace exactly as it used to bind to a single
 * SharedSession — {@link onHostData}, {@link onViewersChange}, {@link onExit},
 * {@link resize}, {@link write}, {@link getReplay}, {@link viewerCount}, and the
 * window ops {@link newWindow}/{@link selectWindow}/{@link nextWindow}/
 * {@link prevWindow}/{@link closeWindow}/{@link renameWindow} — which now drive
 * the HOST's own active window. So from the host's point of view a single-window
 * workspace behaves identically to the old shared terminal.
 *
 * Window sizing stays global: the host terminal size is authoritative and every
 * window is sized to it (per-viewport sizing is out of scope).
 */
export class SharedWorkspace {
  private windows: SharedSession[] = [];
  /** The HOST consumer's active window (host is just one consumer). */
  private hostActiveIndex = 0;
  private viewports = new Map<string, Viewport>();
  /** Per-viewport active window index, keyed by sid. Defaults to 0 on attach. */
  private viewportActive = new Map<string, number>();
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
    this.hostActiveIndex = 0;

    this.output.info(`Shared workspace started: 1 window, cols=${this.cols}, rows=${this.rows}`);
  }

  // --- host-facing API (mirrors the old SharedSession surface) -------------

  /** Register the host's local rendering callback for the host's active window. */
  onHostData(cb: (chunk: Buffer) => void): void { this.hostDataCb = cb; }

  /** Register a callback fired once when the workspace ends (last window exits). */
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }

  /** Register a callback fired whenever the attached-viewport count changes. */
  onViewersChange(cb: (count: number) => void): void { this.viewersChangedCb = cb; }

  /**
   * Register a host callback fired whenever the host's window view changes —
   * create, close, switch, or rename. Lets the host render its own tab bar
   * in-process (the analogue of the {@link Viewport.onWindowState} push sent to
   * clients). Fires with the host's current {@link windowState}.
   */
  onWindowState(cb: (state: WindowStateBody) => void): void { this.hostWindowStateCb = cb; }

  get hasExited(): boolean { return this.exited; }

  /** Merge input (from the host) into the HOST's active window. */
  write(data: Uint8Array | string): void {
    if (this.exited) return;
    this.windows[this.hostActiveIndex]?.write(data);
  }

  /** Resize the workspace (host is authoritative) — every window is sized to it. */
  resize(cols: number, rows: number): void {
    if (this.exited || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    for (const w of this.windows) w.resize(cols, rows);
  }

  /** Recent-output snapshot of the HOST's active window (host's initial paint). */
  getReplay(): Uint8Array {
    return this.windows[this.hostActiveIndex]?.getReplay() ?? new Uint8Array(0);
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
   * Attach a client viewport. The viewport starts on window 0. Returns window
   * 0's replay so the caller can send it as the viewport's initial output. The
   * caller should then send {@link windowStateForViewport} so the client's tab
   * bar populates with the viewport's own active index.
   */
  attachViewport(v: Viewport): { replay: Uint8Array } {
    this.viewports.set(v.sid, v);
    this.viewportActive.set(v.sid, 0);
    this.output.info(`Viewport attached: ${v.sid} (${this.viewports.size} total)`);
    this.viewersChangedCb?.(this.viewports.size);
    return { replay: this.windows[0]?.getReplay() ?? new Uint8Array(0) };
  }

  /** Detach a client viewport (disconnect / stream close). */
  detachViewport(sid: string): void {
    if (this.viewports.delete(sid)) {
      this.viewportActive.delete(sid);
      this.output.info(`Viewport detached: ${sid} (${this.viewports.size} remaining)`);
      this.viewersChangedCb?.(this.viewports.size);
    }
  }

  /** Route a viewport's keystrokes to THAT viewport's active window. */
  writeFromViewport(sid: string, data: Uint8Array | string): void {
    if (this.exited || !this.viewports.has(sid)) return;
    this.windows[this.viewportActive.get(sid) ?? 0]?.write(data);
  }

  /**
   * Repaint a SINGLE viewport with ITS OWN active window's screen (the same
   * clear + replay a per-viewport window switch sends, scoped to one sid). The
   * host stays authoritative over the shell size, so when a remote viewer
   * resizes we can't resize the PTY under everyone else; instead we re-send that
   * viewer's active window's screen so its locally-corrupted display is redrawn.
   */
  repaintViewport(sid: string): void {
    if (this.exited) return;
    const v = this.viewports.get(sid);
    if (!v) return;
    const active = this.windows[this.viewportActive.get(sid) ?? 0];
    if (!active) return;
    const payload = Buffer.concat([CLEAR, Buffer.from(active.getReplay())]);
    try { v.onData(new Uint8Array(payload)); } catch {}
  }

  /**
   * Switch a viewport's active window to `index` and repaint just it (no-op if
   * out of range or already there). Only the given viewport moves; the host and
   * every other viewport keep their own active window.
   */
  selectWindowForViewport(sid: string, index: number): void {
    if (this.exited || !this.viewports.has(sid)) return;
    if (index < 0 || index >= this.windows.length) return;
    if (index === (this.viewportActive.get(sid) ?? 0)) return;
    this.viewportActive.set(sid, index);
    this.repaintViewport(sid);
    this.pushViewportWindowState(sid);
  }

  /** Switch a viewport to its next window (wraps). */
  nextWindowForViewport(sid: string): void {
    if (this.exited || !this.viewports.has(sid) || this.windows.length < 2) return;
    const cur = this.viewportActive.get(sid) ?? 0;
    this.selectWindowForViewport(sid, (cur + 1) % this.windows.length);
  }

  /** Switch a viewport to its previous window (wraps). */
  prevWindowForViewport(sid: string): void {
    if (this.exited || !this.viewports.has(sid) || this.windows.length < 2) return;
    const cur = this.viewportActive.get(sid) ?? 0;
    this.selectWindowForViewport(sid, (cur - 1 + this.windows.length) % this.windows.length);
  }

  /**
   * Create a new (global) window and switch ONLY this viewport onto it. The
   * window list changed, so broadcast window-state to every consumer (each gets
   * its OWN active index); the creating viewport is also repainted onto the new
   * window. Respects the {@link maxWindows} cap.
   */
  newWindowForViewport(sid: string): void {
    if (this.exited || !this.viewports.has(sid)) return;
    const win = this.spawnAndAppend();
    if (!win) return;
    this.viewportActive.set(sid, this.windows.length - 1);
    this.repaintViewport(sid);
    this.broadcastWindowState();
  }

  /**
   * Close the (global) window at `index` on behalf of a viewport. Killing its
   * PTY drives the shared exit path, which removes the window and re-homes every
   * consumer's active index. Closing the last window ends the whole workspace.
   */
  closeWindowFromViewport(sid: string, index: number): void {
    if (this.exited || !this.viewports.has(sid)) return;
    if (index < 0 || index >= this.windows.length) return;
    try { this.windows[index]!.kill(); } catch {}
  }

  /** Current window state as seen by a viewport (shared list + its own active). */
  windowStateForViewport(sid: string): WindowStateBody {
    const windows: WindowInfo[] = this.windows.map((w) => ({ id: w.id, title: w.title }));
    return { v: 1, kind: 'window-state', windows, activeIndex: this.viewportActive.get(sid) ?? 0 };
  }

  // --- window operations (drive the HOST's active window) ------------------

  /** Create a new window and switch the HOST to it. */
  newWindow(): void {
    if (this.exited) return;
    const win = this.spawnAndAppend();
    if (!win) return;
    this.hostActiveIndex = this.windows.length - 1;
    this.repaintHost();
    this.broadcastWindowState();
  }

  /** Switch the HOST's active window to `index` (no-op if out of range/current). */
  selectWindow(index: number): void {
    if (this.exited) return;
    if (index < 0 || index >= this.windows.length || index === this.hostActiveIndex) return;
    this.hostActiveIndex = index;
    this.repaintHost();
    this.sendHostWindowState();
  }

  /** Switch the HOST to the next window (wraps). */
  nextWindow(): void {
    if (this.windows.length < 2) return;
    this.selectWindow((this.hostActiveIndex + 1) % this.windows.length);
  }

  /** Switch the HOST to the previous window (wraps). */
  prevWindow(): void {
    if (this.windows.length < 2) return;
    this.selectWindow((this.hostActiveIndex - 1 + this.windows.length) % this.windows.length);
  }

  /**
   * Close the window at `index`. Killing its PTY drives the shared exit path,
   * which removes the window, re-homes every consumer's active index, and
   * broadcasts. Closing the last window ends the whole workspace.
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

  /** Current window state from the HOST's point of view (activeIndex = host's). */
  windowState(): WindowStateBody {
    const windows: WindowInfo[] = this.windows.map((w) => ({ id: w.id, title: w.title }));
    return { v: 1, kind: 'window-state', windows, activeIndex: this.hostActiveIndex };
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
    // Tap EVERY window once, for its whole lifetime; the router delivers each
    // chunk only to the consumers whose active window is this one.
    win.onHostData((chunk) => this.routeWindowOutput(win, chunk));
    return win;
  }

  /** Spawn + append a window, honoring the cap. Returns undefined at the cap. */
  private spawnAndAppend(): SharedSession | undefined {
    if (this.windows.length >= this.maxWindows) {
      this.output.warn(`Window cap reached (${this.maxWindows}); ignoring new-window`);
      return undefined;
    }
    const win = this.spawnWindow();
    this.windows.push(win);
    return win;
  }

  /**
   * Route one window's output to the consumers currently viewing it: the host
   * (if its active window is `win`) and each viewport whose active window is
   * `win`. Background windows keep running; a consumer only sees its own active.
   */
  private routeWindowOutput(win: SharedSession, chunk: Buffer): void {
    if (this.exited) return;
    if (this.windows[this.hostActiveIndex] === win) this.hostDataCb?.(chunk);
    if (this.viewports.size === 0) return;
    let bytes: Uint8Array | undefined;
    for (const [sid, v] of this.viewports) {
      if (this.windows[this.viewportActive.get(sid) ?? 0] === win) {
        if (bytes === undefined) bytes = new Uint8Array(chunk);
        try { v.onData(bytes); } catch {}
      }
    }
  }

  /** Repaint the HOST with a clear + its active window's replay. */
  private repaintHost(): void {
    const active = this.windows[this.hostActiveIndex];
    if (!active) return;
    const payload = Buffer.concat([CLEAR, Buffer.from(active.getReplay())]);
    this.hostDataCb?.(payload);
  }

  /** Push the host its own window-state (host's active index). */
  private sendHostWindowState(): void {
    this.hostWindowStateCb?.(this.windowState());
  }

  /** Push a single viewport its own window-state (its active index). */
  private pushViewportWindowState(sid: string): void {
    const v = this.viewports.get(sid);
    if (!v) return;
    try { v.onWindowState(this.windowStateForViewport(sid)); } catch {}
  }

  /**
   * Notify EVERY consumer of the current window-state: the host with its own
   * active index, and each viewport with its own. Called when the shared window
   * list changes (create / close / rename).
   */
  broadcastWindowState(): void {
    this.sendHostWindowState();
    for (const sid of this.viewports.keys()) this.pushViewportWindowState(sid);
  }

  /**
   * Re-home one consumer's active index after the window at `idx` was removed.
   * `len` is the post-removal window count. Returns the new active index and
   * whether the consumer must be repainted (only when its active window was the
   * one that vanished).
   */
  private rehomeAfterClose(active: number, idx: number, len: number): { active: number; repaint: boolean } {
    if (active === idx) return { active: Math.min(idx, len - 1), repaint: true };
    if (active > idx) return { active: active - 1, repaint: false };
    return { active, repaint: false };
  }

  private handleWindowExit(win: SharedSession, code: number | null, signal: string | null): void {
    const idx = this.windows.indexOf(win);
    if (idx === -1) return;
    this.windows.splice(idx, 1);

    // Last window gone: the whole workspace ends. Tell every viewport and the
    // host so the client streams and host process wind down.
    if (this.windows.length === 0) {
      this.exited = true;
      for (const v of this.viewports.values()) {
        try { v.onExit(code, signal); } catch {}
      }
      this.viewports.clear();
      this.viewportActive.clear();
      this.exitCb?.(code, signal);
      return;
    }

    const len = this.windows.length;

    // Re-home the HOST: if it was viewing the closed window, move it onto a
    // surviving neighbor and repaint it; if it was after the closed one, shift
    // down to keep pointing at the same window.
    const host = this.rehomeAfterClose(this.hostActiveIndex, idx, len);
    this.hostActiveIndex = host.active;
    if (host.repaint) this.repaintHost();

    // Re-home every viewport the same way, each independently.
    for (const sid of this.viewports.keys()) {
      const r = this.rehomeAfterClose(this.viewportActive.get(sid) ?? 0, idx, len);
      this.viewportActive.set(sid, r.active);
      if (r.repaint) this.repaintViewport(sid);
    }

    this.broadcastWindowState();
  }
}
