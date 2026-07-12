import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { randomBytes } from 'crypto';
// @xterm/headless + @xterm/addon-serialize are CommonJS. Under Node's ESM loader
// (how the published serve/dist runs) only their default export (module.exports)
// is reliably visible — a named `import { Terminal }` throws at runtime — so we
// import the default for the runtime VALUES and a type-only named import (erased
// at compile time) for the TYPES. esbuild's CJS bundle handles this the same.
import xtermHeadless from '@xterm/headless';
import xtermAddonSerialize from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { getConfig, buildChildEnv, OutputHandler } from '@thenewlabs/entangle-utils';

const XtermTerminal = xtermHeadless.Terminal;
const XtermSerializeAddon = xtermAddonSerialize.SerializeAddon;

/** Scrollback the per-window emulator retains (lines of history for serialize). */
const EMULATOR_SCROLLBACK = 5000;

/** Default scrollback lines a fresh attach/repaint replays (see shared-workspace). */
const DEFAULT_SCROLLBACK_LINES = 1000;

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
 * are synced with a SERIALIZED current frame produced by an authoritative
 * headless xterm emulator that consumes the PTY byte stream in lockstep.
 *
 * The emulator (one per window) is what makes window-switch repaints and attach
 * syncs correct: instead of replaying a truncated ring of raw bytes — which
 * cannot reconstruct a full-screen (alt-screen) app's current frame — we ask
 * {@link SerializeAddon} for the terminal's current screen (plus optional
 * scrollback). Replaying that reproduces exactly what the app is showing now,
 * alt-screen and all (serialize emits the `\x1b[?1049h` + alt content when the
 * app is on the alt buffer, or just the restored primary once it has quit).
 *
 * The host terminal size is authoritative — the shell is sized to the host's
 * (inner) region and viewers render that stream in their own terminals.
 *
 * In the multi-window model a SharedWorkspace owns N of these (one per window)
 * and taps the ACTIVE one via {@link onHostData} + {@link snapshot}; `id` and
 * `title` identify the window in the WINDOW_CTL window-state broadcast.
 */
export class SharedSession {
  private ptyProcess: pty.IPty;
  private viewers = new Map<string, Viewer>();
  /** Authoritative emulator fed the PTY stream; source of serialized frames. */
  private readonly term: Terminal;
  private readonly serializeAddon: SerializeAddon;
  private termDisposed = false;
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
    opts: { cols: number; rows: number; cwd?: string; id?: string; title?: string }
  ) {
    const config = getConfig();
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.id = opts.id ?? randomBytes(6).toString('base64url');
    this.title = opts.title ?? 'shell';

    // Authoritative headless emulator: fed every PTY byte so a snapshot can
    // reconstruct the current frame. SerializeAddon requires allowProposedApi.
    this.term = new XtermTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: EMULATOR_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializeAddon = new XtermSerializeAddon();
    this.term.loadAddon(this.serializeAddon);

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
      // Feed the emulator so a later snapshot reflects this output. xterm parses
      // writes asynchronously (on a microtask), so a snapshot taken in the SAME
      // tick as a write can miss the last chunk; that's fine here because
      // snapshots only ever happen on a window switch or an attach — a different
      // tick than the last live write — by which time the parse has drained. The
      // live fan-out below is unchanged and byte-exact (streaming is not routed
      // through the emulator).
      if (!this.termDisposed) this.term.write(buf);
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
      this.disposeTerm();
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

  /** Resize the shared shell (host is authoritative) and its emulator. */
  resize(cols: number, rows: number): void {
    if (this.exited || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    try { this.ptyProcess.resize(cols, rows); } catch {}
    if (!this.termDisposed) { try { this.term.resize(cols, rows); } catch {} }
  }

  /**
   * Attach a viewer. Returns the current serialized frame (with a page of
   * scrollback) so the caller can send it as the viewer's initial output and
   * sync its screen — including recent history — to the window's current state.
   */
  attach(viewer: Viewer): { replay: Uint8Array } {
    this.viewers.set(viewer.sid, viewer);
    this.output.info(`Viewer attached: ${viewer.sid} (${this.viewers.size} total)`);
    this.viewersChangedCb?.(this.viewers.size);
    return { replay: this.snapshot({ scrollback: DEFAULT_SCROLLBACK_LINES }) };
  }

  /** Detach a viewer (disconnect / stream close). */
  detach(sid: string): void {
    if (this.viewers.delete(sid)) {
      this.output.info(`Viewer detached: ${sid} (${this.viewers.size} remaining)`);
      this.viewersChangedCb?.(this.viewers.size);
    }
  }

  viewerCount(): number { return this.viewers.size; }

  /**
   * A serialized snapshot of the window's CURRENT frame (what the emulator is
   * showing right now), optionally prefixed with `opts.scrollback` lines of
   * history. Replaying these bytes into a fresh/cleared terminal reproduces the
   * window's screen — full-screen/alt-buffer apps included. Callers are sync, so
   * this is sync; see the {@link ptyProcess} onData comment on why the emulator
   * is guaranteed to be flushed by the time a switch/attach takes a snapshot.
   */
  snapshot(opts?: { scrollback?: number }): Uint8Array {
    if (this.termDisposed) return new Uint8Array(0);
    const text = this.serializeAddon.serialize({ scrollback: opts?.scrollback ?? 0 });
    return new Uint8Array(Buffer.from(text, 'utf8'));
  }

  /** Back-compat alias for {@link snapshot} (host's initial paint / repaints). */
  getReplay(opts?: { scrollback?: number }): Uint8Array { return this.snapshot(opts); }

  /**
   * All buffer lines of the emulator — scrollback history plus the current
   * screen, oldest first — each trimmed of trailing whitespace. This is the
   * source for the host's copy-mode/scrollback pager: unlike {@link snapshot}
   * (which serializes SGR-styled bytes for a terminal to REPLAY), this returns
   * PLAIN TEXT for a pager to render. Colour/SGR reconstruction is an explicit
   * non-goal here; the pager shows history text only.
   *
   * `buf.length` includes scrollback. If a full-screen (alt-screen) app is
   * active the active buffer is the alt buffer, which has no scrollback — so the
   * lines are just its current screen; that edge case is acceptable and not
   * special-cased.
   */
  scrollbackLines(): string[] {
    if (this.termDisposed) return [];
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines;
  }

  kill(): void {
    if (this.exited) { this.disposeTerm(); return; }
    try { this.ptyProcess.kill(); } catch {}
    // The emulator is released on the onExit path; if the PTY never reports exit
    // the double-dispose guard makes an eventual dispose idempotent.
  }

  /** Release the emulator's resources exactly once. */
  private disposeTerm(): void {
    if (this.termDisposed) return;
    this.termDisposed = true;
    try { this.term.dispose(); } catch {}
  }
}
