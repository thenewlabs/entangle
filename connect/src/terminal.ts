import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import type { WindowStateBody } from '@thenewlabs/entangle-protocol';
import { InvokeConnection } from './connection.js';
import { promptHidden } from './prompt.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// Prefix key: Ctrl-B (like tmux). After it, a single command byte drives windows.
const PREFIX = 0x02; // Ctrl-B

// ANSI helpers for the reserved tmux-style bar on the BOTTOM row.
const SAVE_CURSOR = '\x1b7'; // DECSC: cursor position + attributes
const RESTORE_CURSOR = '\x1b8'; // DECRC
// Blue tmux-style bar to match the host: dim blue bar background, brighter blue
// for the active tab, bright white text, and a full reset at the end.
const BAR_BG = '\x1b[48;5;25m'; // bar background (blue)
const ACTIVE_BG = '\x1b[48;5;33m'; // active tab background (brighter blue)
const TEXT = '\x1b[97m'; // bright white text
const RESET = '\x1b[0m';

// Build the full-width bottom bar, e.g. ` 1:shell  2:logs  3:build ` on a blue
// background, with the active window's tab in a brighter blue. The line is
// padded/truncated to exactly `cols` visible columns so it fills the row.
function renderTabBar(state: WindowStateBody, cols: number): string {
  let out = `${BAR_BG}${TEXT}`;
  let width = 0;
  state.windows.forEach((w, i) => {
    if (width >= cols) return;
    const title = w.title || 'window';
    let label = ` ${i + 1}:${title} `;
    const remaining = cols - width;
    if (label.length > remaining) label = label.slice(0, remaining);
    width += label.length;
    out += i === state.activeIndex ? `${ACTIVE_BG}${label}${BAR_BG}` : label;
  });
  if (width < cols) out += ' '.repeat(cols - width); // pad the rest of the bar
  return `${out}${RESET}`;
}

// Repaint the bottom bar (row `rows`) without disturbing the shell's cursor. The
// scroll region keeps shell output off row `rows`; absolute CUP (`\x1b[<rows>;1H`)
// ignores the scroll region because origin mode (DECOM) is off by default.
function drawTabBar(state: WindowStateBody, cols: number, rows: number): void {
  const bar = renderTabBar(state, cols);
  process.stdout.write(`${SAVE_CURSOR}\x1b[${rows};1H\x1b[2K${bar}${RESTORE_CURSOR}`);
}

export async function openTerminal(
  wsUrl: string,
  S: string,
  options: { cwd?: string | undefined; cols?: number | undefined; rows?: number | undefined },
  password?: string
): Promise<void> {
  const { cwd, cols = 80, rows = 24 } = options;

  const capId = wsUrl.split('/').pop()!;
  const conn = new InvokeConnection(capId, S, password, () => promptHidden('Agent password: '));

  await conn.connect(wsUrl);
  output.info('Authenticated');

  await new Promise<void>((resolve) => {
    let scrollRegionSet = false;
    let repaintTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      // Restore the terminal: stop the tab-bar repaint, drop the scroll region,
      // clear, home the cursor, then return stdin to cooked mode.
      if (repaintTimer) { clearInterval(repaintTimer); repaintTimer = undefined; }
      if (scrollRegionSet) {
        try { process.stdout.write('\x1b[r\x1b[2J\x1b[H'); } catch {}
        scrollRegionSet = false;
      }
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdin.pause();
    };

    // Physical terminal geometry, falling back to the negotiated size.
    const termCols = () => process.stdout.columns || cols;
    const termRows = () => process.stdout.rows || rows;
    // Reserve the BOTTOM row for the bar: the shell area is rows 1..rows-1, so
    // the pty gets one fewer row than the physical terminal.
    const shellRows = () => Math.max(1, termRows() - 1);

    // Last window-state the server sent us; drives the tab bar and `prefix-x`.
    let lastState: WindowStateBody | undefined;
    let tabBarDirty = false;
    conn.onWindowState((state) => {
      lastState = state;
      tabBarDirty = false; // a fresh full repaint below supersedes any pending one
      drawTabBar(state, termCols(), termRows());
    });

    // A shell `clear`, a full-screen app, or the server's switch repaint emits a
    // full-screen clear that blanks the reserved bottom row until the next
    // window-state (which may never arrive for a plain `clear`). So after any pty
    // output we mark the tab bar dirty and repaint it from the last known state
    // on a small coalescing interval (unref'd so it never keeps the process up).
    repaintTimer = setInterval(() => {
      if (!tabBarDirty || !lastState) return;
      tabBarDirty = false;
      drawTabBar(lastState, termCols(), termRows());
    }, 60);
    repaintTimer.unref?.();

    // Ctrl-B prefix state machine over stdin. When the prefix is seen, the next
    // byte is a window command; every other byte forwards to the shell pty.
    let prefixArmed = false;
    const onStdin = (d: Buffer) => {
      const bytes = new Uint8Array(d);
      let passthrough: number[] = [];
      const flush = () => {
        if (passthrough.length) { handle.write(new Uint8Array(passthrough)); passthrough = []; }
      };
      for (const b of bytes) {
        if (prefixArmed) {
          prefixArmed = false;
          if (b === PREFIX) {
            // Ctrl-B Ctrl-B: send a literal Ctrl-B to the shell.
            passthrough.push(PREFIX);
            continue;
          }
          flush(); // deliver any queued shell input before acting on the command
          if (b === 0x63) conn.newWindow();            // 'c'
          else if (b === 0x6e) conn.nextWindow();       // 'n'
          else if (b === 0x70) conn.prevWindow();       // 'p'
          else if (b === 0x78) {                        // 'x' close active
            if (lastState && lastState.activeIndex >= 0) conn.closeWindow(lastState.activeIndex);
          } else if (b >= 0x30 && b <= 0x39) {          // '1'..'9' -> 0..8, '0' -> 9
            // Tabs are labelled 1-based ("1:shell" = index 0), so digit 1..9
            // selects window 0..8 and 0 selects window 9 (ignored if OOR).
            const digit = b - 0x30;
            conn.selectWindow(digit === 0 ? 9 : digit - 1);
          }
          // Any other byte after the prefix is ignored.
          continue;
        }
        if (b === PREFIX) {
          flush();
          prefixArmed = true;
          continue;
        }
        passthrough.push(b);
      }
      flush();
    };

    const handle = conn.openPty({ cols, rows: shellRows(), ...(cwd ? { cwd } : {}) }, {
      onOpened: () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        // Reserve the bottom row: scroll region = rows 1..rows-1, so the shell
        // can never scroll over the bar.
        process.stdout.write(`\x1b[1;${shellRows()}r`);
        scrollRegionSet = true;
        if (lastState) drawTabBar(lastState, termCols(), termRows());
        process.stdin.resume();
        process.stdin.on('data', onStdin);
        process.stdout.on('resize', () => {
          // (a) Drop the scroll region so the resize can't corrupt the reserved
          // row, (b) resize the pty — this emits a STREAM_RESIZE which the server
          // answers with a clear + active-window replay, so we do NOT locally
          // reconstruct the screen, (c) re-establish the reserved region for the
          // new size, and (d) redraw the bottom bar.
          process.stdout.write('\x1b[r');
          handle.resize(termCols(), shellRows());
          process.stdout.write(`\x1b[1;${shellRows()}r`);
          if (lastState) drawTabBar(lastState, termCols(), termRows());
        });
      },
      onData: (chunk) => {
        process.stdout.write(Buffer.from(chunk));
        // Shell output may have cleared the bottom row; schedule a coalesced repaint.
        tabBarDirty = true;
      },
      onExit: (code, signal) => {
        output.info(`Terminal exited: code=${code}, signal=${signal}`);
        cleanup();
        conn.disconnect();
        resolve();
      },
      onError: (message) => {
        output.error('Stream error', message);
        cleanup();
        conn.disconnect();
        resolve();
      },
    });

    process.on('SIGINT', () => handle.signal('SIGINT'));
    process.on('exit', cleanup);
    conn.onClose(() => { cleanup(); resolve(); });
  });
}
