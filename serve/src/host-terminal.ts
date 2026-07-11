import { OutputHandler } from '@thenewlabs/entangle-utils';
// The host binds to the shared WORKSPACE via the same host-facing surface it
// used on a single SharedSession (onHostData/onViewersChange/onExit/resize/
// write/getReplay/viewerCount), so it renders the ACTIVE window and repaints
// automatically on a remote window switch (the workspace pushes a clear+replay
// through onHostData). The host also renders its own tab bar by subscribing to
// the workspace's onWindowState and drives window ops via a Ctrl-B prefix keymap.
import type { WindowInfo } from '@thenewlabs/entangle-protocol';
import type { SharedWorkspace } from './shared-workspace.js';
import { VtGrid } from './vt-grid.js';
import { BoxRenderer } from './box-renderer.js';

/** Minimum terminal size that can hold the session frame with a usable interior. */
const MIN_COLS = 20;
const MIN_ROWS = 6;

/** Repaint cadence: coalesce shell output into ~30ms frames rather than per byte. */
const FRAME_MS = 30;

/** Host window-management prefix (Ctrl-B), tmux-style. */
const PREFIX = 0x02;

/**
 * Handle returned by {@link attachHostTerminal}. The session URL is only known
 * once the relay assigns the capability, so index.ts feeds it in later via
 * {@link HostTerminalHandle.setUrl}; until then the bottom bar shows a
 * "connecting…" placeholder.
 */
export interface HostTerminalHandle {
  setUrl(link: string): void;
}

/**
 * Wire the host's own terminal to the shared session.
 *
 * On a real, big-enough terminal the host sees their shell rendered *inside* a
 * bordered session frame (side rails, a title bar with the live viewer count,
 * and a bottom bar with the join URL). The shell output is parsed into a
 * {@link VtGrid} sized to the box interior and repainted on a throttle so a
 * left rail is never overwritten. Elsewhere (too small, or not a TTY) it falls
 * back to raw pass-through.
 */
export function attachHostTerminal(shared: SharedWorkspace, output: OutputHandler): HostTerminalHandle {
  const stdout = process.stdout;
  const stdin = process.stdin;

  const cols = stdout.columns || 0;
  const rows = stdout.rows || 0;
  const boxable =
    !!stdout.isTTY && !!stdin.isTTY && cols >= MIN_COLS && rows >= MIN_ROWS;

  return boxable
    ? attachBoxTerminal(shared, output, cols, rows)
    : attachRawTerminal(shared, output);
}

/** Bordered session-frame UI (the normal interactive host experience). */
function attachBoxTerminal(
  shared: SharedWorkspace,
  output: OutputHandler,
  cols: number,
  rows: number,
): HostTerminalHandle {
  const stdout = process.stdout;
  const stdin = process.stdin;

  const write = (s: string) => { try { stdout.write(s); } catch {} };

  const grid = new VtGrid(cols - 2, rows - 2);
  const renderer = new BoxRenderer(grid, cols, rows);

  // The shell is authoritative-sized to the box interior, not the full terminal.
  shared.resize(renderer.innerCols, renderer.innerRows);

  // Paint whatever the shell emitted before we attached.
  const initial = shared.getReplay();
  if (initial.length > 0) grid.write(Buffer.from(initial).toString('utf8'));

  let url: string | undefined;
  let viewers = shared.viewerCount();
  let dirty = true;
  let clearFirst = true;

  // Local mirror of the workspace's window set, kept in sync via onWindowState
  // and rendered as the tab bar. Seeded with the current state.
  const initialState = shared.windowState();
  let windows: readonly WindowInfo[] = initialState.windows;
  let activeIndex = initialState.activeIndex;

  const paint = () => {
    if (!dirty) return;
    dirty = false;
    if (clearFirst) { write('\x1b[2J\x1b[H'); clearFirst = false; }
    write(renderer.frame({ viewers, url, windows, activeIndex }));
  };

  // Coalesce shell output and title changes into throttled frames.
  const timer = setInterval(paint, FRAME_MS);
  timer.unref?.();

  shared.onHostData((chunk) => { grid.write(chunk.toString('utf8')); dirty = true; });
  shared.onViewersChange((n) => { viewers = n; dirty = true; });
  shared.onWindowState((state) => {
    windows = state.windows;
    activeIndex = state.activeIndex;
    dirty = true;
  });

  const wasRaw = !!stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  // Window-management commands after a Ctrl-B prefix. Unknown keys are swallowed.
  const runCommand = (byte: number) => {
    const ch = String.fromCharCode(byte);
    if (ch === 'c') shared.newWindow();
    else if (ch === 'n') shared.nextWindow();
    else if (ch === 'p') shared.prevWindow();
    else if (ch === 'x') shared.closeWindow(activeIndex);
    else if (ch >= '0' && ch <= '9') {
      // Tabs are labelled 1-based ("1:shell" = index 0), so digit 1..9 selects
      // window 0..8 and 0 selects window 9 (ignored if out of range).
      const digit = byte - 0x30;
      shared.selectWindow(digit === 0 ? 9 : digit - 1);
    }
  };

  // Ctrl-B prefix state machine: a lone Ctrl-B arms the prefix; the next byte is
  // a command (Ctrl-B again = a literal Ctrl-B to the active window). All other
  // bytes forward to the active window, flushed around each prefix boundary so
  // ordering across a window switch is preserved.
  let pendingPrefix = false;
  const onInput = (d: Buffer) => {
    let start = 0;
    for (let i = 0; i < d.length; i++) {
      const byte = d[i]!;
      if (pendingPrefix) {
        pendingPrefix = false;
        if (byte === PREFIX) shared.write(new Uint8Array([PREFIX]));
        else runCommand(byte);
        start = i + 1;
        continue;
      }
      if (byte === PREFIX) {
        if (i > start) shared.write(new Uint8Array(d.subarray(start, i)));
        pendingPrefix = true;
        start = i + 1;
      }
    }
    if (d.length > start) shared.write(new Uint8Array(d.subarray(start)));
  };
  stdin.on('data', onInput);

  const onResize = () => {
    const nextCols = stdout.columns || 0;
    const nextRows = stdout.rows || 0;
    renderer.resize(nextCols, nextRows);
    grid.resize(renderer.innerCols, renderer.innerRows);
    shared.resize(renderer.innerCols, renderer.innerRows);
    clearFirst = true;
    dirty = true;
  };
  stdout.on('resize', onResize);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearInterval(timer);
    stdin.removeListener('data', onInput);
    stdout.removeListener('resize', onResize);
    write('\x1b[?25h'); // show cursor
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch {} }
    stdin.pause();
  };

  shared.onExit((code) => {
    restore();
    write('\n');
    output.info('Shared session ended.');
    process.exit(code ?? 0);
  });

  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });

  // Clear once and draw the first frame immediately.
  paint();

  return { setUrl(link: string) { url = link; dirty = true; } };
}

/**
 * Raw pass-through: mirror the shell byte-for-byte and forward keystrokes, with
 * no frame. Used when the terminal is too small for a box (or not a TTY).
 */
function attachRawTerminal(shared: SharedWorkspace, output: OutputHandler): HostTerminalHandle {
  const stdin = process.stdin;
  const stdout = process.stdout;

  const initial = shared.getReplay();
  if (initial.length > 0) { try { stdout.write(Buffer.from(initial)); } catch {} }

  shared.onHostData((chunk) => { try { stdout.write(chunk); } catch {} });

  const wasRaw = !!stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const onInput = (d: Buffer) => shared.write(new Uint8Array(d));
  stdin.on('data', onInput);

  const onResize = () => shared.resize(stdout.columns || 80, stdout.rows || 24);
  stdout.on('resize', onResize);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdin.removeListener('data', onInput);
    stdout.removeListener('resize', onResize);
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch {} }
    stdin.pause();
  };

  shared.onExit((code) => {
    restore();
    output.info(`Shared session ended (code=${code ?? 0}).`);
    process.exit(code ?? 0);
  });

  process.on('exit', restore);

  return {
    setUrl(link: string) {
      output.info(`⧉ entangle session shared — open to collaborate:\n  ${link}\n`);
    },
  };
}
