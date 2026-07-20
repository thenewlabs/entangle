import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import type { WindowStateBody } from '@thenewlabs/entangle-protocol';
import { SharedWorkspace, type Viewport } from './shared-workspace.js';

// Integration tests: SharedWorkspace owns N real shell PTYs (one SharedSession
// per window). As in shared-session.test.ts we never use fixed sleeps to decide
// correctness — we poll for expected output/state with a timeout — and we always
// kill() every workspace in afterEach so no PTY leaks, even on a mid-test throw.

const output = new OutputHandler({ mode: parseOutputMode('text') });

const live: SharedWorkspace[] = [];

function makeWorkspace(opts?: {
  cols?: number;
  rows?: number;
  cwd?: string;
  maxWindows?: number;
  persistent?: boolean;
  viewerResizeAuthoritative?: boolean;
}): SharedWorkspace {
  const w = new SharedWorkspace(output, {
    cols: opts?.cols ?? 80,
    rows: opts?.rows ?? 24,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.maxWindows !== undefined ? { maxWindows: opts.maxWindows } : {}),
    ...(opts?.persistent !== undefined ? { persistent: opts.persistent } : {}),
    ...(opts?.viewerResizeAuthoritative !== undefined
      ? { viewerResizeAuthoritative: opts.viewerResizeAuthoritative }
      : {}),
  });
  live.push(w);
  return w;
}

afterEach(() => {
  while (live.length) {
    try { live.pop()!.kill(); } catch { /* already dead */ }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `pred` until true or `timeout` ms elapse. Returns as soon as it holds. */
async function waitFor(
  pred: () => boolean,
  { timeout = 8000, interval = 20, message = 'condition not met' }: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {}
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(interval);
  }
  if (pred()) return;
  throw new Error(`waitFor timed out after ${timeout}ms: ${message}`);
}

const decode = (u: Uint8Array): string => Buffer.from(u).toString('utf8');

/** A test viewport that accumulates onData bytes and records window-states/exit. */
interface TestViewport extends Viewport {
  data: string;
  states: WindowStateBody[];
  exited: boolean;
}

function makeViewport(sid: string): TestViewport {
  const vp: TestViewport = {
    sid,
    data: '',
    states: [],
    exited: false,
    onData: (chunk) => { vp.data += decode(chunk); },
    onExit: () => { vp.exited = true; },
    onWindowState: (state) => { vp.states.push(state); },
  };
  return vp;
}

// The workspace writes a switch payload (leave alt + clear screen/scrollback +
// serialized frame — see switchPayload in shared-workspace.ts) on a window
// switch. We assert on the \x1b[2J (erase display) it contains.
const CLEAR_ERASE = '\x1b[2J';

describe('SharedWorkspace (integration, real PTYs)', () => {
  it('starts with exactly one window, activeIndex 0', () => {
    const ws = makeWorkspace();
    const st = ws.windowState();
    expect(st.kind).toBe('window-state');
    expect(st.windows).toHaveLength(1);
    expect(st.activeIndex).toBe(0);
    expect(ws.hasExited).toBe(false);
  });

  it('newWindow() appends a window, makes it active, and broadcasts window-state', () => {
    const ws = makeWorkspace();

    // Host-side window-state observer (analogue of the client push).
    const hostStates: WindowStateBody[] = [];
    ws.onWindowState((s) => { hostStates.push(s); });

    // onViewersChange must NOT fire for a window create (viewer set is unchanged).
    let viewerChanges = 0;
    ws.onViewersChange(() => { viewerChanges += 1; });

    const vp = makeViewport('v1');
    ws.attachViewport(vp);
    expect(viewerChanges).toBe(1); // attach fired it once
    expect(ws.viewerCount()).toBe(1);

    ws.newWindow();

    const st = ws.windowState();
    expect(st.windows).toHaveLength(2);
    expect(st.activeIndex).toBe(1); // the new window is the HOST's active

    // The list changed, so everyone gets a window-state — but each with its OWN
    // active index: the host follows its new window (1); the viewport, which did
    // not move, stays on its own active window (0).
    expect(hostStates.at(-1)).toMatchObject({ windows: st.windows, activeIndex: 1 });
    expect(vp.states.at(-1)).toMatchObject({ windows: st.windows, activeIndex: 0 });

    // A window create does not touch the viewer count / callback.
    expect(viewerChanges).toBe(1);
  });

  it('selectWindow / nextWindow / prevWindow move activeIndex with wrap', () => {
    const ws = makeWorkspace();
    ws.newWindow(); // -> 2 windows, active 1
    ws.newWindow(); // -> 3 windows, active 2
    expect(ws.windowState().windows).toHaveLength(3);
    expect(ws.windowState().activeIndex).toBe(2);

    ws.selectWindow(0);
    expect(ws.windowState().activeIndex).toBe(0);

    // selecting the current index is a no-op (no throw, unchanged).
    ws.selectWindow(0);
    expect(ws.windowState().activeIndex).toBe(0);

    ws.nextWindow();
    expect(ws.windowState().activeIndex).toBe(1);
    ws.nextWindow();
    expect(ws.windowState().activeIndex).toBe(2);
    ws.nextWindow(); // wraps 2 -> 0
    expect(ws.windowState().activeIndex).toBe(0);
    ws.prevWindow(); // wraps 0 -> 2
    expect(ws.windowState().activeIndex).toBe(2);
    ws.prevWindow();
    expect(ws.windowState().activeIndex).toBe(1);
  });

  it('next/prevWindow are no-ops with a single window', () => {
    const ws = makeWorkspace();
    ws.nextWindow();
    expect(ws.windowState().activeIndex).toBe(0);
    ws.prevWindow();
    expect(ws.windowState().activeIndex).toBe(0);
    expect(ws.windowState().windows).toHaveLength(1);
  });

  it('renameWindow updates the window title in windowState', () => {
    const ws = makeWorkspace();
    ws.newWindow(); // 2 windows

    const hostStates: WindowStateBody[] = [];
    ws.onWindowState((s) => { hostStates.push(s); });

    ws.renameWindow(0, 'build');
    ws.renameWindow(1, 'logs');

    const st = ws.windowState();
    expect(st.windows[0]!.title).toBe('build');
    expect(st.windows[1]!.title).toBe('logs');
    // Each rename broadcasts the new state to the host.
    expect(hostStates.at(-1)!.windows.map((w) => w.title)).toEqual(['build', 'logs']);
  });

  it('runs an independent shell per window (distinct PIDs; input routed to viewport active)', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // Viewport starts on window 0: its output taps onto the viewport. Echo PID.
    ws.writeFromViewport('v1', 'echo P0=$$\n');
    await waitFor(() => /P0=\d+/.test(vp.data), { message: 'window-0 marker never reached viewport' });
    const pid0 = /P0=(\d+)/.exec(vp.data)![1];

    // The viewport creates a new window and moves onto it; input now routes there.
    ws.newWindowForViewport('v1');
    expect(ws.windowStateForViewport('v1').activeIndex).toBe(1);
    ws.writeFromViewport('v1', 'echo P1=$$\n');
    await waitFor(() => /P1=\d+/.test(vp.data), { message: 'window-1 marker never reached viewport' });
    const pid1 = /P1=(\d+)/.exec(vp.data)![1];

    // Two distinct shells => two distinct PIDs.
    expect(pid0).not.toBe(pid1);
    // The viewport saw window-0's marker (while it was active) and window-1's
    // marker (after the switch).
    expect(vp.data).toContain('P0=' + pid0);
    expect(vp.data).toContain('P1=' + pid1);
  }, 12000);

  it('delivers window-state updates to a viewport on create/select/close', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');

    // attachViewport itself returns the replay but does not push an initial
    // window-state (by design: the caller sends the current windowState after
    // attach — see attachViewport docs). So no state yet.
    const { replay } = ws.attachViewport(vp);
    expect(replay).toBeInstanceOf(Uint8Array);
    expect(vp.states).toHaveLength(0);

    ws.newWindowForViewport('v1'); // create + move this viewport -> update (own active 1)
    expect(vp.states.at(-1)).toMatchObject({ activeIndex: 1 });
    expect(vp.states.at(-1)!.windows).toHaveLength(2);

    ws.selectWindowForViewport('v1', 0); // select -> update (own active 0)
    expect(vp.states.at(-1)).toMatchObject({ activeIndex: 0 });

    const beforeClose = vp.states.length;
    ws.closeWindowFromViewport('v1', 1); // close -> update (async: PTY exit drives the broadcast)
    await waitFor(() => vp.states.length > beforeClose, { message: 'no window-state after close' });
    expect(vp.states.at(-1)!.windows).toHaveLength(1);
    expect(vp.states.at(-1)!.activeIndex).toBe(0);
  }, 12000);

  it('repaints the viewport on a window switch (clear + new active replay)', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // Window 0 produces a distinctive marker.
    ws.writeFromViewport('v1', 'echo ALPHA_REPAINT\n');
    await waitFor(() => vp.data.includes('ALPHA_REPAINT'), { message: 'ALPHA never seen' });

    // Second window (this viewport moves onto it), produce its own marker.
    ws.newWindowForViewport('v1');
    ws.writeFromViewport('v1', 'echo BETA_REPAINT\n');
    await waitFor(() => vp.data.includes('BETA_REPAINT'), { message: 'BETA never seen' });

    // Isolate the switch: reset the collector, then switch back to window 0.
    vp.data = '';
    ws.selectWindowForViewport('v1', 0);

    // The switch writes a clear + window-0's replay onto the viewport in one go.
    await waitFor(() => vp.data.includes(CLEAR_ERASE) && vp.data.includes('ALPHA_REPAINT'), {
      message: 'switch did not repaint viewport with clear + active replay',
    });
    expect(vp.data).toContain(CLEAR_ERASE);
    expect(vp.data).toContain('ALPHA_REPAINT'); // window 0's prior output replayed
  }, 12000);

  it('resize repaint preserves scrollback (no \\x1b[3J) while a switch erases it (\\x1b[3J)', () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // A window-switch repaint wipes AND rebuilds the consumer's scrollback, so it
    // carries the erase-scrollback control (\x1b[3J).
    vp.data = '';
    ws.repaintViewport('v1');
    expect(vp.data).toContain('\x1b[3J');

    // A viewer-resize repaint redraws only the visible screen and leaves the
    // client's own accumulated scrollback intact: it clears the screen (\x1b[2J)
    // but must NOT emit \x1b[3J.
    vp.data = '';
    ws.repaintViewportScreen('v1');
    expect(vp.data).toContain(CLEAR_ERASE);   // screen is still cleared
    expect(vp.data).not.toContain('\x1b[3J'); // ...but scrollback is preserved
  });

  // Regression: SerializeAddon.serialize() is ADDITIVE-ONLY — it emits the
  // ENABLE sequence for each non-default DECSET private mode and nothing at all
  // for a mode that is off. Replaying a frame over a consumer still holding
  // ANOTHER window's modes therefore left those modes latched forever: a window
  // running a mouse-aware app (vim `set mouse=a`, htop) left mouse REPORTING on,
  // so in the plain-shell window the user switched to, the wheel went to the PTY
  // instead of the scrollback ("scrolling back doesn't work"), drag-to-select was
  // swallowed ("copy/paste doesn't work") and the shell echoed raw report tails
  // like `0;29;8M`. The switch payload must start from a known-default state.
  it('a window switch resets the private modes serialize() can set', () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    vp.data = '';
    ws.repaintViewport('v1');

    // Every mouse TRACKING mode is turned off before the frame is replayed.
    for (const mode of ['\x1b[?9l', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l']) {
      expect(vp.data).toContain(mode);
    }
    // ...as is every other mode the serialize addon is able to re-enable.
    for (const mode of [
      '\x1b[?1l',    // application cursor keys
      '\x1b[?66l',   // application keypad
      '\x1b[?2004l', // bracketed paste
      '\x1b[4l',     // insert mode
      '\x1b[?6l',    // origin mode
      '\x1b[?45l',   // reverse wraparound
      '\x1b[?1004l', // focus reporting
      '\x1b[?7h',    // wraparound back ON (its default)
    ]) {
      expect(vp.data).toContain(mode);
    }

    // The mouse ENCODING is deliberately left alone: serialize() cannot restore
    // it (xterm exposes no encoding in `modes`), so resetting it would strip SGR
    // from a live mouse app instead of repairing anything.
    expect(vp.data).not.toContain('\x1b[?1006l');
    expect(vp.data).not.toContain('\x1b[?1005l');
    expect(vp.data).not.toContain('\x1b[?1015l');

    // The reset must land BEFORE the frame, or it would undo the modes the frame
    // legitimately re-enables for the window being switched TO.
    expect(vp.data.indexOf('\x1b[?1000l')).toBeLessThan(vp.data.indexOf(CLEAR_ERASE));
  });

  it('the attach replay also starts from default modes', () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    const { replay } = ws.attachViewport(vp);
    const text = decode(replay);
    expect(text).toContain('\x1b[?1000l');
    expect(text).toContain('\x1b[?2004l');
    // An attach syncs a fresh client terminal, so it must NOT erase anything.
    expect(text).not.toContain('\x1b[3J');
  });

  // End-to-end proof against a real PTY: turn mouse reporting on in window 0,
  // switch a viewport to a second (plain) window, and assert the bytes that
  // reach the consumer leave it with tracking OFF.
  it('mouse reporting enabled in one window does not leak into another', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    ws.write("stty -echo; PS1=''\n");
    // Window 0's app turns on mouse tracking + SGR encoding, as vim/htop would.
    ws.write("printf '\\033[?1000h\\033[?1006h'\n");

    // Poll the emulator's own frame rather than any echoed text: the mode is set
    // once the headless terminal has PARSED the sequence, which is exactly the
    // state the frame is built from.
    await waitFor(() => decode(ws.snapshotForViewport('v1')).includes('\x1b[?1000h'), {
      message: 'window 0 never entered mouse-tracking mode',
    });

    // A second window: a plain shell that never enabled anything.
    ws.newWindowForViewport('v1');
    await waitFor(() => ws.windowState().windows.length === 2, {
      message: 'second window never appeared',
    });

    vp.data = '';
    ws.repaintViewport('v1');
    // Tracking is turned off and the plain window's frame does not turn it back
    // on — so the consumer ends up with mouse reporting OFF.
    expect(vp.data).toContain('\x1b[?1000l');
    expect(vp.data).not.toContain('\x1b[?1000h');

    // The other direction is the guarantee that this is a RESTORE and not a
    // blanket disable: switching BACK onto the mouse-aware window must re-enable
    // reporting, because that window's own frame carries the mode. The enable
    // has to come after the reset or it would be cancelled by it.
    ws.selectWindowForViewport('v1', 0);
    vp.data = '';
    ws.repaintViewport('v1');
    expect(vp.data).toContain('\x1b[?1000h');
    expect(vp.data.lastIndexOf('\x1b[?1000l')).toBeLessThan(vp.data.lastIndexOf('\x1b[?1000h'));
  }, 15000);

  it('scrollbackLines(For)Viewport returns the active window buffer history', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // Quiet echo/prompt, then overflow the screen with numbered lines so an early
    // one lands in scrollback (host + viewport both sit on window 0 here).
    ws.write("stty -echo; PS1=''\n");
    ws.write('for i in $(seq 0 71); do printf "WSLINE-%03d\\n" "$i"; done\n');

    await waitFor(() => ws.scrollbackLines().some((l) => l.includes('WSLINE-071')), {
      message: 'host scrollbackLines never showed the last line',
    });

    const hostLines = ws.scrollbackLines();
    const hEarly = hostLines.findIndex((l) => l.includes('WSLINE-000'));
    const hLate = hostLines.findIndex((l) => l.includes('WSLINE-071'));
    expect(hEarly).toBeGreaterThanOrEqual(0);
    expect(hLate).toBeGreaterThan(hEarly);

    // The viewport (also on window 0) sees the same history via its own accessor.
    const vpLines = ws.scrollbackLinesForViewport('v1');
    expect(vpLines.some((l) => l.includes('WSLINE-000'))).toBe(true);
    expect(vpLines.some((l) => l.includes('WSLINE-071'))).toBe(true);
  }, 15000);

  it('closeWindow removes a window and re-homes activeIndex', async () => {
    const ws = makeWorkspace();
    ws.newWindow();
    ws.newWindow(); // 3 windows, active 2
    ws.renameWindow(0, 'A');
    ws.renameWindow(1, 'B');
    ws.renameWindow(2, 'C');
    expect(ws.windowState().windows.map((w) => w.title)).toEqual(['A', 'B', 'C']);
    expect(ws.windowState().activeIndex).toBe(2);

    // Close a window BEFORE the active one: the active window (C) stays active,
    // its index shifts down by one.
    ws.closeWindow(1); // remove B
    await waitFor(() => ws.windowState().windows.length === 2, { message: 'B never removed' });
    expect(ws.windowState().windows.map((w) => w.title)).toEqual(['A', 'C']);
    expect(ws.windowState().activeIndex).toBe(1); // still pointing at C

    // Close the ACTIVE window (C): active re-homes onto the surviving neighbor.
    ws.closeWindow(1); // remove C
    await waitFor(() => ws.windowState().windows.length === 1, { message: 'C never removed' });
    expect(ws.windowState().windows.map((w) => w.title)).toEqual(['A']);
    expect(ws.windowState().activeIndex).toBe(0);
    expect(ws.hasExited).toBe(false);
  }, 12000);

  it('closing the last window ends the workspace (onExit + viewport onExit)', async () => {
    const ws = makeWorkspace();
    let exited = false;
    ws.onExit(() => { exited = true; });
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    ws.closeWindow(0); // last window

    await waitFor(() => exited, { message: 'workspace onExit never fired' });
    expect(exited).toBe(true);
    expect(ws.hasExited).toBe(true);
    await waitFor(() => vp.exited, { message: 'viewport onExit never fired' });
    expect(vp.exited).toBe(true);

    // Post-exit writes / ops are ignored (no throw).
    expect(() => ws.write('echo IGNORED\n')).not.toThrow();
    expect(() => ws.newWindow()).not.toThrow();
  }, 12000);

  it('ends the workspace when the last shell exits via `exit` (single-shell parity)', async () => {
    const ws = makeWorkspace();
    let exited = false;
    ws.onExit(() => { exited = true; });

    ws.write('exit\n');

    await waitFor(() => exited, { message: 'workspace onExit never fired on shell exit' });
    expect(ws.hasExited).toBe(true);
  }, 12000);

  it('treats out-of-range select/close/rename as safe no-ops', async () => {
    const ws = makeWorkspace();
    ws.newWindow(); // 2 windows, active 1
    const before = ws.windowState();

    expect(() => ws.selectWindow(-1)).not.toThrow();
    expect(() => ws.selectWindow(99)).not.toThrow();
    expect(() => ws.closeWindow(-1)).not.toThrow();
    expect(() => ws.closeWindow(99)).not.toThrow();
    expect(() => ws.renameWindow(99, 'nope')).not.toThrow();
    expect(() => ws.renameWindow(-1, 'nope')).not.toThrow();

    // Nothing changed and the workspace is intact.
    const after = ws.windowState();
    expect(after.windows.map((w) => w.id)).toEqual(before.windows.map((w) => w.id));
    expect(after.activeIndex).toBe(before.activeIndex);
    expect(after.windows).toHaveLength(2);
    expect(ws.hasExited).toBe(false);

    // Give any (erroneous) async close a chance to land, then re-confirm.
    await delay(150);
    expect(ws.windowState().windows).toHaveLength(2);
  }, 12000);

  it('honors the maxWindows cap', () => {
    const ws = makeWorkspace({ maxWindows: 2 });
    ws.newWindow(); // 2 windows (at cap)
    expect(ws.windowState().windows).toHaveLength(2);
    ws.newWindow(); // ignored — cap reached
    expect(ws.windowState().windows).toHaveLength(2);
  });

  // --- per-viewport independence -------------------------------------------

  it('delivers each window output only to the consumers viewing that window', async () => {
    const ws = makeWorkspace();
    const a = makeViewport('a');
    const b = makeViewport('b');
    ws.attachViewport(a); // starts on window 0
    ws.attachViewport(b); // starts on window 0

    // b creates a second window and moves onto it; a stays on window 0.
    ws.newWindowForViewport('b');
    expect(ws.windowStateForViewport('a').activeIndex).toBe(0);
    expect(ws.windowStateForViewport('b').activeIndex).toBe(1);

    // Ignore the create-time repaint payloads.
    a.data = '';
    b.data = '';

    // Window 0 output (a's active) reaches only a.
    ws.writeFromViewport('a', 'echo ONLY_A\n');
    await waitFor(() => a.data.includes('ONLY_A'), { message: 'A never saw its own window output' });

    // Window 1 output (b's active) reaches only b.
    ws.writeFromViewport('b', 'echo ONLY_B\n');
    await waitFor(() => b.data.includes('ONLY_B'), { message: 'B never saw its own window output' });

    // Give any stray cross-delivery a chance to land, then assert isolation.
    await delay(200);
    expect(a.data).not.toContain('ONLY_B');
    expect(b.data).not.toContain('ONLY_A');
  }, 15000);

  it('a viewport switching windows does not move any other consumer', () => {
    const ws = makeWorkspace();
    ws.newWindow(); // host creates window 1 and switches the HOST to it
    expect(ws.windowState().activeIndex).toBe(1);

    const a = makeViewport('a');
    const b = makeViewport('b');
    ws.attachViewport(a); // window 0
    ws.attachViewport(b); // window 0

    ws.selectWindowForViewport('a', 1); // only a moves

    expect(ws.windowStateForViewport('a').activeIndex).toBe(1); // a moved
    expect(ws.windowStateForViewport('b').activeIndex).toBe(0); // b untouched
    expect(ws.windowState().activeIndex).toBe(1);               // host untouched

    // next/prev for a viewport wrap over its OWN active, independently.
    ws.nextWindowForViewport('b'); // b: 0 -> 1
    expect(ws.windowStateForViewport('b').activeIndex).toBe(1);
    ws.prevWindowForViewport('b'); // b: 1 -> 0
    expect(ws.windowStateForViewport('b').activeIndex).toBe(0);
    expect(ws.windowStateForViewport('a').activeIndex).toBe(1); // still a's own
  });

  it('newWindowForViewport switches only that viewport but tells everyone the list grew', () => {
    const ws = makeWorkspace();
    const a = makeViewport('a');
    const b = makeViewport('b');
    ws.attachViewport(a);
    ws.attachViewport(b);

    const hostStates: WindowStateBody[] = [];
    ws.onWindowState((s) => { hostStates.push(s); });

    ws.newWindowForViewport('a'); // creates window 1, moves a onto it

    expect(ws.windowState().windows).toHaveLength(2);
    expect(ws.windowStateForViewport('a').activeIndex).toBe(1); // a moved
    expect(ws.windowStateForViewport('b').activeIndex).toBe(0); // b stayed
    expect(ws.windowState().activeIndex).toBe(0);               // host stayed

    // Every consumer was told the list changed, each with its OWN active index.
    expect(hostStates.at(-1)).toMatchObject({ activeIndex: 0 });
    expect(hostStates.at(-1)!.windows).toHaveLength(2);
    expect(a.states.at(-1)).toMatchObject({ activeIndex: 1 });
    expect(b.states.at(-1)).toMatchObject({ activeIndex: 0 });
  });

  it('re-homes the host and each viewport independently when a window closes', async () => {
    const ws = makeWorkspace({ maxWindows: 8 });
    ws.newWindow(); // window 1, host active 1
    ws.newWindow(); // window 2, host active 2  (windows: 0,1,2)
    expect(ws.windowState().activeIndex).toBe(2);

    const a = makeViewport('a');
    const b = makeViewport('b');
    const c = makeViewport('c');
    ws.attachViewport(a);
    ws.attachViewport(b);
    ws.attachViewport(c);
    ws.selectWindowForViewport('a', 1); // a EXACTLY on the window we'll close
    ws.selectWindowForViewport('b', 2); // b after the closed window
    // c stays on window 0 (before the closed window)

    // Close window 1. Post-removal the surviving windows are [orig-0, orig-2].
    //  - a (== closed idx) re-homes onto neighbor min(1, len-1)=1 -> orig-2
    //  - b (> idx) decrements 2 -> 1  (still orig-2)
    //  - c (< idx) unchanged at 0
    //  - host (> idx) decrements 2 -> 1
    ws.closeWindow(1);
    await waitFor(() => ws.windowState().windows.length === 2, { message: 'window 1 never closed' });

    expect(ws.windowState().activeIndex).toBe(1);               // host decremented
    expect(ws.windowStateForViewport('a').activeIndex).toBe(1); // a re-homed onto neighbor
    expect(ws.windowStateForViewport('b').activeIndex).toBe(1); // b decremented
    expect(ws.windowStateForViewport('c').activeIndex).toBe(0); // c unchanged
    expect(ws.hasExited).toBe(false);
  }, 15000);
});

describe('SharedWorkspace — persistent mode (headless daemons, e.g. Locus)', () => {
  it('defaults are off: persistent=false, viewerResizeAuthoritative=false', () => {
    const ws = makeWorkspace();
    expect(ws.persistent).toBe(false);
    expect(ws.viewerResizeAuthoritative).toBe(false);
  });

  it('respawns a fresh shell when the last window is closed (workspace never ends)', async () => {
    const ws = makeWorkspace({ persistent: true });
    let exited = false;
    ws.onExit(() => { exited = true; });
    const vp = makeViewport('v1');
    ws.attachViewport(vp);
    const firstId = ws.windowState().windows[0]!.id;

    ws.closeWindow(0); // last window

    await waitFor(
      () => ws.windowState().windows.length === 1 && ws.windowState().windows[0]!.id !== firstId,
      { message: 'persistent workspace never respawned a window' },
    );
    expect(exited).toBe(false);
    expect(ws.hasExited).toBe(false);
    expect(vp.exited).toBe(false);
    // The surviving viewport was re-homed onto the fresh window and repainted.
    expect(ws.windowStateForViewport('v1').activeIndex).toBe(0);
    // …and the fresh shell is live: input still lands somewhere real.
    ws.writeFromViewport('v1', 'echo RESPAWNED_OK\n');
    await waitFor(() => vp.data.includes('RESPAWNED_OK'), { message: 'respawned shell not interactive' });
  }, 15000);

  it('respawns when the last shell exits via `exit` too', async () => {
    const ws = makeWorkspace({ persistent: true });
    let exited = false;
    ws.onExit(() => { exited = true; });
    const firstId = ws.windowState().windows[0]!.id;

    ws.write('exit\n');

    await waitFor(
      () => ws.windowState().windows.length === 1 && ws.windowState().windows[0]!.id !== firstId,
      { message: 'persistent workspace never respawned after shell exit' },
    );
    expect(exited).toBe(false);
    expect(ws.hasExited).toBe(false);
  }, 15000);

  it('closing a NON-last window in persistent mode behaves as before (no respawn)', async () => {
    const ws = makeWorkspace({ persistent: true });
    ws.newWindow(); // 2 windows
    ws.closeWindow(1);
    await waitFor(() => ws.windowState().windows.length === 1, { message: 'window close never settled' });
    expect(ws.hasExited).toBe(false);
  }, 15000);

  it('viewerResizeAuthoritative resizes the whole workspace via resize()', () => {
    const ws = makeWorkspace({ viewerResizeAuthoritative: true });
    expect(ws.viewerResizeAuthoritative).toBe(true);
    ws.resize(133, 41);
    expect(ws.cols).toBe(133);
    expect(ws.rows).toBe(41);
  });

  // Regression: a persistent workspace whose shell CANNOT stay up — here its cwd
  // is deleted mid-session (a per-tab dir renamed/removed in a coding workbench)
  // so every fresh bash exits the instant it starts — must NOT tight-loop its
  // respawns. The old code respawned synchronously and unconditionally, spinning
  // at PTY-fork speed: it pegged a core, churned PTYs + headless emulators, and
  // eventually exhausted fds/PIDs, crashing the whole daemon and dropping every
  // attached client ("Shared session ended") — i.e. the "durable" workspace ENDED
  // after a while. It must instead back off, stay alive, and never fire onExit.
  it('does NOT tight-loop respawns when the shell keeps exiting (unusable cwd); backs off and stays alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'entangle-cwd-'));

    // A dedicated counting output so we can assert the respawn rate is bounded.
    let respawns = 0;
    let backoffs = 0;
    const spyOut = new OutputHandler({ mode: parseOutputMode('text') });
    const origInfo = spyOut.info.bind(spyOut);
    const origWarn = spyOut.warn.bind(spyOut);
    (spyOut as unknown as { info: OutputHandler['info'] }).info = (msg: string, data?: unknown) => {
      if (typeof msg === 'string' && msg.includes('respawned a fresh shell')) respawns++;
      return origInfo(msg, data as never);
    };
    (spyOut as unknown as { warn: OutputHandler['warn'] }).warn = (msg: string, data?: unknown) => {
      if (typeof msg === 'string' && msg.includes('retrying in')) backoffs++;
      return origWarn(msg, data as never);
    };

    const ws = new SharedWorkspace(spyOut, { cols: 80, rows: 24, cwd: dir, persistent: true });
    live.push(ws);
    let exited = false;
    ws.onExit(() => { exited = true; });
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // Pull the cwd out from under the shell, then force the last window to exit:
    // every respawn now spawns a bash whose cwd no longer exists -> instant exit.
    rmSync(dir, { recursive: true, force: true });
    ws.closeWindow(0);

    // Let the fast-fail loop run for a bit. With backoff this is only a handful
    // of attempts; the OLD unconditional loop managed dozens-to-hundreds here.
    await delay(1500);

    expect(backoffs).toBeGreaterThan(0);        // backoff actually engaged
    expect(respawns).toBeLessThan(15);          // bounded — NOT a tight loop
    expect(exited).toBe(false);                 // workspace never ended
    expect(ws.hasExited).toBe(false);
    expect(vp.exited).toBe(false);              // the viewport was never dropped

    // Recovery: restore the cwd; the next (backed-off) respawn succeeds and the
    // workspace is live and interactive again — it never gave up.
    mkdirSync(dir, { recursive: true });
    await waitFor(() => ws.windowState().windows.length === 1, {
      timeout: 12000,
      message: 'persistent workspace never recovered a live window after cwd was restored',
    });
    ws.writeFromViewport('v1', 'echo RECOVERED_OK\n');
    await waitFor(() => vp.data.includes('RECOVERED_OK'), {
      timeout: 12000,
      message: 'recovered shell is not interactive',
    });
    expect(exited).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  }, 30000);
});
