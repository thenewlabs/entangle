import { OutputHandler } from '@thenewlabs/entangle-utils';
// The host binds to the shared WORKSPACE via the same host-facing surface it
// used on a single SharedSession (onHostData/onViewersChange/onExit/resize/
// write/getReplay/viewerCount), so it renders the ACTIVE window and repaints
// automatically on a remote window switch (the workspace pushes a clear+replay
// through onHostData). The host also renders its own tmux-style status bar by
// subscribing to the workspace's onWindowState and drives window ops via a
// Ctrl-B prefix keymap.
import type { WindowInfo } from '@thenewlabs/entangle-protocol';
import type { SharedWorkspace } from './shared-workspace.js';

/** Minimum terminal size that can hold the shell plus a bottom status bar. */
const MIN_COLS = 20;
const MIN_ROWS = 6;

/** Repaint cadence for the status bar: coalesce shell output into ~30ms frames. */
const FRAME_MS = 30;

/** Cap on the host's captured-log ring buffer backing the debug tab. */
const DEBUG_MAX_LINES = 1000;

/** Host window-management prefix (Ctrl-B), tmux-style. */
const PREFIX = 0x02;

/** Status-bar palette (tmux-style blue). */
const BAR_BG = '\x1b[48;5;25m'; // base blue background
const BAR_ACTIVE_BG = '\x1b[48;5;33m'; // brighter blue for the active tab
const BAR_FG = '\x1b[97m'; // bright white text
const RESET = '\x1b[0m';

/**
 * Handle returned by {@link attachHostTerminal}. The session URL is only known
 * once the relay assigns the capability, so index.ts feeds it in later via
 * {@link HostTerminalHandle.setUrl}; until then the host shows a brief
 * "connecting…" screen and only goes live once the URL arrives.
 */
export interface HostTerminalHandle {
  setUrl(link: string): void;
}

/**
 * Wire the host's own terminal to the shared workspace.
 *
 * On a real, big-enough terminal the host sees their shell rendered RAW at full
 * width, using rows 1..(rows-1), with a blue tmux-style status bar pinned to the
 * bottom row. The shell is authoritative-sized to (cols, rows-1) and a scroll
 * region keeps its scrolling clear of the bar; because output is passed through
 * byte-for-byte (no VtGrid), resizes stay clean. Elsewhere (too small, or not a
 * TTY) it falls back to raw pass-through.
 */
export function attachHostTerminal(shared: SharedWorkspace, output: OutputHandler): HostTerminalHandle {
  const stdout = process.stdout;
  const stdin = process.stdin;

  const cols = stdout.columns || 0;
  const rows = stdout.rows || 0;
  const barCapable =
    !!stdout.isTTY && !!stdin.isTTY && cols >= MIN_COLS && rows >= MIN_ROWS;

  return barCapable
    ? attachBarTerminal(shared, output, cols, rows)
    : attachRawTerminal(shared, output);
}

/**
 * Blue-bottom-bar UI (the normal interactive host experience).
 *
 * Launch sequence: clear + "connecting…" on attach; then on setUrl clear again,
 * print an info banner (brand, share URL, key hint) at the top, set the scroll
 * region, size the shell to rows-1, paint its current screen from the replay,
 * draw the bar, and go live (raw pass-through + status bar).
 */
function attachBarTerminal(
  shared: SharedWorkspace,
  output: OutputHandler,
  initialCols: number,
  initialRows: number,
): HostTerminalHandle {
  const stdout = process.stdout;
  const stdin = process.stdin;

  const write = (s: string) => { try { stdout.write(s); } catch {} };
  const writeRaw = (b: Uint8Array) => { try { stdout.write(Buffer.from(b)); } catch {} };

  let cols = initialCols;
  let rows = initialRows;

  let live = false; // true once the URL is known and we're in pass-through
  let viewers = shared.viewerCount();
  let barDirty = false;
  // The capability URL, once the relay assigns it. Stored so the debug view's
  // pinned header can always show it (and refresh on a later setUrl).
  let url: string | null = null;

  // Which surface fills the shell area (rows 1..rows-1). 'shell' is the normal
  // raw pass-through; 'debug' shows the captured agent-log tail (Ctrl-B d).
  let viewMode: 'shell' | 'debug' = 'shell';
  // Capped ring of captured agent logs. While the host owns stdout, agent logs
  // are redirected here (via the OutputHandler sink) instead of trampling the
  // terminal; the debug tab renders the tail of this buffer.
  const debugBuf: string[] = [];
  let debugDirty = false;
  const pushLog = (level: string, message: string, data?: unknown) => {
    let line = `[${level}] ${message}`;
    if (data !== undefined && data !== null) {
      let extra: string;
      try { extra = typeof data === 'string' ? data : JSON.stringify(data); }
      catch { extra = String(data); }
      if (extra) line += ` ${extra}`;
    }
    debugBuf.push(line);
    if (debugBuf.length > DEBUG_MAX_LINES) debugBuf.splice(0, debugBuf.length - DEBUG_MAX_LINES);
    if (viewMode === 'debug') debugDirty = true;
  };

  // Local mirror of the workspace's window set, kept in sync via onWindowState
  // and rendered as the tab row of the bar. Seeded with the current state.
  const initialState = shared.windowState();
  let windows: readonly WindowInfo[] = initialState.windows;
  let activeIndex = initialState.activeIndex;

  /**
   * Compose the status bar for the bottom row: ` ⧉ entangle ` then 1-based
   * window tabs (the active one in brighter blue) and a right-aligned viewer
   * count, all on blue and padded/truncated to exactly `cols` visible columns.
   */
  const buildBar = (): string => {
    const segs: Array<{ text: string; active: boolean }> = [
      { text: ' ⧉ entangle ', active: false },
    ];
    for (let i = 0; i < windows.length; i++) {
      const title = (windows[i]!.title || '').replace(/[\x00-\x1f\x7f]/g, '');
      segs.push({ text: ` ${i + 1}:${title} `, active: viewMode === 'shell' && i === activeIndex });
    }
    // A distinct debug tab after the window tabs; active while in debug view.
    segs.push({ text: ' debug ', active: viewMode === 'debug' });
    const viewerSeg = ` ${viewers} viewer${viewers === 1 ? '' : 's'} `;

    // Reserve room on the right for the viewer count when it fits.
    const showViewer = viewerSeg.length + 1 <= cols;
    const leftBudget = showViewer ? cols - viewerSeg.length : cols;

    // Emit the left segments up to leftBudget visible columns, truncating the
    // last one that overflows (each active segment is wrapped in its own bg).
    let left = '';
    let leftVis = 0;
    for (const s of segs) {
      if (leftVis >= leftBudget) break;
      const room = leftBudget - leftVis;
      const text = s.text.length > room ? s.text.slice(0, room) : s.text;
      left += s.active ? `${BAR_ACTIVE_BG}${text}${BAR_BG}` : text;
      leftVis += text.length;
    }

    const fill = ' '.repeat(Math.max(0, cols - leftVis - (showViewer ? viewerSeg.length : 0)));
    const right = showViewer ? viewerSeg : '';
    return `${BAR_BG}${BAR_FG}${left}${fill}${right}${RESET}`;
  };

  // Draw the bar on the bottom row without disturbing the shell: save the cursor
  // and its attributes (DECSC), jump to the last row, clear it, paint the bar,
  // then restore (DECRC). No-op until live so the connecting screen stays clean.
  const drawBar = () => {
    if (!live) return;
    barDirty = false;
    write(`\x1b7\x1b[${rows};1H\x1b[2K${buildBar()}\x1b8`);
  };

  // The info banner lines (brand, share URL, key hint), shared by the launch
  // banner printed on go-live and the debug view's pinned header so they match
  // exactly. Shows `connecting…` for the URL until it's known.
  const bannerLines = (link: string | null): string[] => [
    `${BAR_FG}⧉ entangle${RESET} — live shared session`,
    `Share this live session:`,
    `  ${BAR_FG}${link ?? 'connecting…'}${RESET}`,
    `Windows: Ctrl-B then c=new  n/p=prev/next  1-9=select  x=close  d=debug`,
  ];

  // Render the debug tab: a PINNED HEADER (the info banner: brand, share URL,
  // key hint) at the top so the URL is always findable, then a blank separator,
  // then the tail of the log buffer that fits, then repaint the bar. No
  // scrollback — just the last rows.
  const renderDebug = () => {
    if (!live) return;
    debugDirty = false;
    const shellRows = Math.max(1, rows - 1);
    const header = bannerLines(url);
    const headerRows = header.length + 1; // banner lines + one blank separator
    const tailRows = Math.max(0, shellRows - headerRows);
    const lines = tailRows > 0 ? debugBuf.slice(-tailRows) : [];
    let out = '';
    let r = 0;
    for (; r < header.length && r < shellRows; r++) {
      out += `\x1b[${r + 1};1H\x1b[2K${header[r]}`; // header lines print as-is
    }
    if (r < shellRows) { out += `\x1b[${r + 1};1H\x1b[2K`; r++; } // blank separator
    for (let i = 0; r < shellRows; r++, i++) {
      out += `\x1b[${r + 1};1H\x1b[2K`; // move to row, clear it
      const line = lines[i];
      if (line !== undefined) out += line.length > cols ? line.slice(0, cols) : line;
    }
    write(out);
    drawBar();
  };

  // Repaint the live shell area from the workspace replay (used when leaving the
  // debug view). Clears rows 1..rows-1, re-writes the active window's screen.
  const repaintShell = () => {
    if (!live) return;
    const shellRows = Math.max(1, rows - 1);
    let out = '';
    for (let r = 1; r <= shellRows; r++) out += `\x1b[${r};1H\x1b[2K`;
    out += '\x1b[H';
    write(out);
    const replay = shared.getReplay();
    if (replay.length > 0) writeRaw(replay);
    drawBar();
  };

  const enterDebug = () => {
    if (viewMode === 'debug') return;
    viewMode = 'debug';
    renderDebug();
  };
  // Leave the debug view for the shell, repainting the live screen. A no-op
  // (beyond the repaint) when already in shell view.
  const enterShell = () => {
    const wasDebug = viewMode === 'debug';
    viewMode = 'shell';
    if (wasDebug) repaintShell();
  };

  // Coalesce shell output into throttled bar redraws so a full-screen app or a
  // `clear` can't leave the bar blank; in debug view, coalesce log-tail repaints.
  const timer = setInterval(() => {
    if (viewMode === 'debug') { if (debugDirty) renderDebug(); }
    else if (barDirty) drawBar();
  }, FRAME_MS);
  timer.unref?.();

  shared.onHostData((chunk) => {
    if (!live) return; // pre-live output is captured in the replay; painted on go-live
    if (viewMode === 'debug') return; // still buffered in replay; not shown while in debug
    writeRaw(chunk);
    barDirty = true;
  });
  shared.onViewersChange((n) => { viewers = n; drawBar(); });
  shared.onWindowState((state) => {
    windows = state.windows;
    activeIndex = state.activeIndex;
    drawBar();
  });

  // Redirect all agent text-mode logs into the debug ring buffer instead of
  // stdout (which this bar UI owns). This both stops the logs from trampling
  // the terminal / scrolling the banner away and feeds the debug tab.
  OutputHandler.setLogSink(pushLog);

  const wasRaw = !!stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  // Window-management commands after a Ctrl-B prefix. Unknown keys are swallowed.
  // `d` opens the debug view; every workspace op returns to (and repaints) the
  // shell view before running, so acting on a window always shows its output.
  const runCommand = (byte: number) => {
    const ch = String.fromCharCode(byte);
    if (ch === 'd') { enterDebug(); return; }
    if (ch === 'c') { enterShell(); shared.newWindow(); }
    else if (ch === 'n') { enterShell(); shared.nextWindow(); }
    else if (ch === 'p') { enterShell(); shared.prevWindow(); }
    else if (ch === 'x') { enterShell(); shared.closeWindow(activeIndex); }
    else if (ch >= '0' && ch <= '9') {
      // Tabs are labelled 1-based ("1:shell" = index 0), so digit 1..9 selects
      // window 0..8 and 0 selects window 9 (ignored if out of range).
      enterShell();
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

  // Clean resize: drop the scroll region, clear, re-arm the region one row short,
  // resize the shell (which SIGWINCHes it into redrawing itself), then repaint
  // the bar. No banner reprint — the shell's own redraw fills the screen.
  const onResize = () => {
    cols = stdout.columns || cols;
    rows = stdout.rows || rows;
    if (!live) return;
    const shellRows = Math.max(1, rows - 1);
    write('\x1b[r');
    write('\x1b[2J\x1b[H');
    write(`\x1b[1;${shellRows}r`);
    shared.resize(cols, shellRows);
    // In debug view the shell won't redraw itself, so re-render the tail for the
    // new size; in shell view the shell's own SIGWINCH redraw fills the screen.
    if (viewMode === 'debug') renderDebug();
    else drawBar();
  };
  stdout.on('resize', onResize);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearInterval(timer);
    OutputHandler.setLogSink(null); // let any final logs print to stdout normally
    stdin.removeListener('data', onInput);
    stdout.removeListener('resize', onResize);
    write('\x1b[r'); // reset scroll region
    write('\x1b[2J\x1b[H'); // clear screen + home, so no stale bar/shell is left behind
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

  // Info banner shown at the top when the session goes live. `\r\n` because raw
  // mode does not translate a bare `\n` into a carriage return. Reuses the same
  // `bannerLines` the debug view pins so the two always match.
  const writeBanner = (link: string) => {
    write(bannerLines(link).map((l) => `${l}\r\n`).join(''));
  };

  // Connecting screen until the relay hands us the capability URL.
  write('\x1b[2J\x1b[H');
  write(`${BAR_FG}⧉ entangle — connecting…${RESET}`);

  return {
    setUrl(link: string) {
      url = link; // stored so the debug view's pinned header can always show it
      if (live) { // URL refresh after we're already live
        barDirty = true;
        if (viewMode === 'debug') debugDirty = true; // repaint the pinned header
        return;
      }
      cols = stdout.columns || cols;
      rows = stdout.rows || rows;
      const shellRows = Math.max(1, rows - 1);
      write('\x1b[2J\x1b[H');
      writeBanner(link);
      write(`\x1b[1;${shellRows}r`); // reserve the bottom row for the bar
      shared.resize(cols, shellRows); // shell is authoritative-sized to rows-1
      const replay = shared.getReplay(); // paint the shell's current screen below the banner
      if (replay.length > 0) writeRaw(replay);
      live = true;
      drawBar();
    },
  };
}

/**
 * Raw pass-through: mirror the shell byte-for-byte and forward keystrokes, with
 * no status bar. Used when the terminal is too small for a bar (or not a TTY).
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
