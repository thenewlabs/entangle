import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import type { WindowStateBody } from '@thenewlabs/entangle-protocol';
import { InvokeConnection } from './connection.js';
import { promptHidden } from './prompt.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// Prefix key: Ctrl-B (like tmux). After it, a single command byte drives windows.
const PREFIX = 0x02; // Ctrl-B

// ANSI helpers for the reserved tab-bar line (row 1).
const SAVE_CURSOR = '\x1b7'; // DECSC: cursor position + attributes
const RESTORE_CURSOR = '\x1b8'; // DECRC
const REVERSE = '\x1b[7m';
const RESET = '\x1b[0m';

// Build the tab bar text for row 1, e.g. ` 1:shell  2:logs  3:build `, with the
// active window in reverse video, truncated to the terminal width.
function renderTabBar(state: WindowStateBody, cols: number): string {
  let out = '';
  let width = 0;
  state.windows.forEach((w, i) => {
    if (width >= cols) return;
    const title = w.title || 'window';
    let label = ` ${i + 1}:${title} `;
    const remaining = cols - width;
    if (label.length > remaining) label = label.slice(0, remaining);
    width += label.length;
    out += i === state.activeIndex ? `${REVERSE}${label}${RESET}` : label;
  });
  return out;
}

// Repaint row 1 with the tab bar without disturbing the shell's cursor. The
// scroll region keeps shell output off row 1; absolute CUP (`\x1b[1;1H`) ignores
// the scroll region because origin mode (DECOM) is off by default.
function drawTabBar(state: WindowStateBody, cols: number): void {
  const bar = renderTabBar(state, cols);
  process.stdout.write(`${SAVE_CURSOR}\x1b[1;1H\x1b[2K${bar}${RESTORE_CURSOR}`);
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

    // Last window-state the server sent us; drives the tab bar and `prefix-x`.
    let lastState: WindowStateBody | undefined;
    let tabBarDirty = false;
    conn.onWindowState((state) => {
      lastState = state;
      tabBarDirty = false; // a fresh full repaint below supersedes any pending one
      drawTabBar(state, process.stdout.columns || cols);
    });

    // A shell `clear`, a full-screen app, or the server's switch repaint emits a
    // full-screen clear that blanks the reserved row 1 until the next
    // window-state (which may never arrive for a plain `clear`). So after any pty
    // output we mark the tab bar dirty and repaint it from the last known state
    // on a small coalescing interval (unref'd so it never keeps the process up).
    repaintTimer = setInterval(() => {
      if (!tabBarDirty || !lastState) return;
      tabBarDirty = false;
      drawTabBar(lastState, process.stdout.columns || cols);
    }, 60);
    repaintTimer.unref?.();

    // Reserve row 1 for the tab bar: the shell area is rows 2..rows, so the pty
    // gets one fewer row than the physical terminal.
    const shellRows = () => Math.max(1, (process.stdout.rows || rows) - 1);

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
        // Reserve row 1: scroll region = rows 2..rows, so the shell can never
        // scroll over the tab bar.
        process.stdout.write(`\x1b[2;${process.stdout.rows || rows}r`);
        scrollRegionSet = true;
        if (lastState) drawTabBar(lastState, process.stdout.columns || cols);
        process.stdin.resume();
        process.stdin.on('data', onStdin);
        process.stdout.on('resize', () => {
          handle.resize(process.stdout.columns || 80, shellRows());
          // Re-establish the reserved region for the new size and repaint.
          process.stdout.write(`\x1b[2;${process.stdout.rows || rows}r`);
          if (lastState) drawTabBar(lastState, process.stdout.columns || cols);
        });
      },
      onData: (chunk) => {
        process.stdout.write(Buffer.from(chunk));
        // Shell output may have cleared row 1; schedule a coalesced repaint.
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
