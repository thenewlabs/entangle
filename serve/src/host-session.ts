import { OutputHandler } from '@thenewlabs/entangle-utils';
import type { WindowStateBody } from '@thenewlabs/entangle-protocol';
import type { SharedWorkspace } from './shared-workspace.js';

/** Cap on the host's captured-log ring buffer backing the debug tab. */
const DEBUG_MAX_LINES = 1000;

/**
 * The data source the host terminal UI renders against, decoupled from the
 * concrete {@link SharedWorkspace}/{@link OutputHandler} it runs on today.
 *
 * The blue-bar host UI (see host-terminal.ts) only ever touches this surface:
 * the active window's byte stream, the window set + operations, the viewer
 * count, the captured agent-log tail (debug tab), the session URL, and the
 * lifecycle exit. Keeping the UI on this interface lets the SAME UI later run
 * against a socket-backed session (a daemon/client split) instead of the
 * in-process workspace, with no UI changes.
 */
export interface HostSession {
  // --- terminal (active window byte stream) --------------------------------
  /** Register the callback fired with the active window's output chunks. */
  onHostData(cb: (chunk: Buffer) => void): void;
  /** Merge input (host keystrokes) into the active window. */
  write(data: Uint8Array | string): void;
  /** Resize the session (host is authoritative) to `cols` x `rows`. */
  resize(cols: number, rows: number): void;
  /**
   * Serialized current frame of the active window (initial/repaint screen).
   * `opts.scrollback` requests N lines of history ahead of the frame (default 0).
   *
   * NOTE: in daemon mode ({@link RemoteHostSession}) this returns a value cached
   * from the daemon's post-attach `replay` frame and can be STALE; prefer
   * {@link requestFrame} + {@link onFrame} for repaints that must reflect the
   * window's live screen (e.g. after a full-screen app quits). getReplay is kept
   * for the go-live paint, where the attach frame is current.
   */
  getReplay(opts?: { scrollback?: number }): Uint8Array;
  /**
   * Ask for a FRESH serialized frame of the active window; the frame is
   * delivered to the {@link onFrame} callback (synchronously in-process, or
   * after an IPC round-trip in daemon mode). `opts.scrollback` requests N lines
   * of history ahead of the frame (default 0).
   */
  requestFrame(opts?: { scrollback?: number }): void;
  /** Register the callback fired when a fresh frame (from {@link requestFrame}) arrives. */
  onFrame(cb: (frame: Uint8Array) => void): void;
  /**
   * Ask for the FULL scrollback of the active window as plain-text lines
   * (history + current screen, oldest first); delivered to {@link onScrollback}
   * (synchronously in-process, or after an IPC round-trip in daemon mode). The
   * source for the host's copy-mode/scrollback pager — plain text only, no SGR.
   */
  requestScrollback(): void;
  /** Register the callback fired when scrollback lines (from {@link requestScrollback}) arrive. */
  onScrollback(cb: (lines: string[]) => void): void;

  // --- windows -------------------------------------------------------------
  /** Register the callback fired whenever the window set changes. */
  onWindowState(cb: (s: WindowStateBody) => void): void;
  /** Current window state (windows + active index) for the tab bar. */
  windowState(): WindowStateBody;
  /** Create a new window and switch to it. */
  newWindow(): void;
  /** Switch to the next window (wraps). */
  nextWindow(): void;
  /** Switch to the previous window (wraps). */
  prevWindow(): void;
  /** Switch the active window to `i` (no-op if out of range). */
  selectWindow(i: number): void;
  /** Close the window at `i`. */
  closeWindow(i: number): void;

  // --- viewers -------------------------------------------------------------
  /** Register the callback fired whenever the attached-viewer count changes. */
  onViewersChange(cb: (n: number) => void): void;
  /** Number of attached client viewers. */
  viewerCount(): number;

  // --- logs (debug tab) ----------------------------------------------------
  /** Register a callback fired with each newly captured `[level] message` line. */
  onLog(cb: (line: string) => void): void;
  /** The captured agent-log ring buffer (tail of which the debug tab shows). */
  getLogBuffer(): readonly string[];

  // --- url -----------------------------------------------------------------
  /** The session URL once the relay assigns it, else null. */
  getUrl(): string | null;
  /** Register a callback fired when the session URL is set (or refreshed). */
  onUrl(cb: (url: string) => void): void;

  // --- lifecycle -----------------------------------------------------------
  /** Register the callback fired once when the session ends. */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  /** Tear down any owned resources (e.g. release the captured-log sink). */
  dispose(): void;
  /** Detach without ending the session (unused for now). */
  detach?(): void;
}

/**
 * The in-process {@link HostSession}: a thin adapter over a {@link SharedWorkspace}
 * (for terminal/window/viewer/exit) that additionally OWNS the two sources the
 * workspace doesn't provide:
 *
 * - the captured agent logs — it installs an {@link OutputHandler} log sink and
 *   appends `[level] message` lines to a capped ring buffer for the debug tab
 *   (this responsibility used to live in host-terminal); {@link dispose} clears
 *   the sink so late logs print to stdout normally again;
 * - the session URL — {@link setUrl} stores it and notifies {@link onUrl}
 *   subscribers (the relay assigns it only after attach).
 */
export class LocalHostSession implements HostSession {
  private readonly logBuf: string[] = [];
  private readonly logCbs: Array<(line: string) => void> = [];
  private readonly urlCbs: Array<(url: string) => void> = [];
  private url: string | null = null;
  private frameCb?: (frame: Uint8Array) => void;
  private scrollbackCb?: (lines: string[]) => void;

  // `output` is accepted for symmetry with the workspace's construction (and so
  // a future session variant can log through it); the log sink it installs is a
  // process-global static, so the instance itself isn't retained.
  constructor(
    private readonly workspace: SharedWorkspace,
    _output: OutputHandler,
  ) {
    // Redirect all agent text-mode logs into the ring buffer instead of stdout
    // (which the host UI owns) so they don't trample the terminal, and feed the
    // debug tab. Cleared again in dispose().
    OutputHandler.setLogSink((level, message, data) => this.pushLog(level, message, data));
  }

  private pushLog(level: string, message: string, data?: unknown): void {
    let line = `[${level}] ${message}`;
    if (data !== undefined && data !== null) {
      let extra: string;
      try { extra = typeof data === 'string' ? data : JSON.stringify(data); }
      catch { extra = String(data); }
      if (extra) line += ` ${extra}`;
    }
    this.logBuf.push(line);
    if (this.logBuf.length > DEBUG_MAX_LINES) this.logBuf.splice(0, this.logBuf.length - DEBUG_MAX_LINES);
    for (const cb of this.logCbs) cb(line);
  }

  // --- terminal ------------------------------------------------------------
  onHostData(cb: (chunk: Buffer) => void): void { this.workspace.onHostData(cb); }
  write(data: Uint8Array | string): void { this.workspace.write(data); }
  resize(cols: number, rows: number): void { this.workspace.resize(cols, rows); }
  getReplay(opts?: { scrollback?: number }): Uint8Array { return this.workspace.getReplay(opts); }
  onFrame(cb: (frame: Uint8Array) => void): void { this.frameCb = cb; }
  // In-process: no round trip — the workspace snapshot is already live, so
  // deliver it to the onFrame callback synchronously.
  requestFrame(opts?: { scrollback?: number }): void { this.frameCb?.(this.workspace.getReplay(opts)); }
  onScrollback(cb: (lines: string[]) => void): void { this.scrollbackCb = cb; }
  // In-process: no round trip — the workspace already has the buffer lines, so
  // deliver them to the onScrollback callback synchronously.
  requestScrollback(): void { this.scrollbackCb?.(this.workspace.scrollbackLines()); }

  // --- windows -------------------------------------------------------------
  onWindowState(cb: (s: WindowStateBody) => void): void { this.workspace.onWindowState(cb); }
  windowState(): WindowStateBody { return this.workspace.windowState(); }
  newWindow(): void { this.workspace.newWindow(); }
  nextWindow(): void { this.workspace.nextWindow(); }
  prevWindow(): void { this.workspace.prevWindow(); }
  selectWindow(i: number): void { this.workspace.selectWindow(i); }
  closeWindow(i: number): void { this.workspace.closeWindow(i); }

  // --- viewers -------------------------------------------------------------
  onViewersChange(cb: (n: number) => void): void { this.workspace.onViewersChange(cb); }
  viewerCount(): number { return this.workspace.viewerCount(); }

  // --- logs ----------------------------------------------------------------
  onLog(cb: (line: string) => void): void { this.logCbs.push(cb); }
  getLogBuffer(): readonly string[] { return this.logBuf; }

  // --- url -----------------------------------------------------------------
  getUrl(): string | null { return this.url; }
  onUrl(cb: (url: string) => void): void { this.urlCbs.push(cb); }
  /** Store the session URL (once the relay assigns it) and notify subscribers. */
  setUrl(link: string): void {
    this.url = link;
    for (const cb of this.urlCbs) cb(link);
  }

  // --- lifecycle -----------------------------------------------------------
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.workspace.onExit(cb); }
  dispose(): void { OutputHandler.setLogSink(null); }
}
