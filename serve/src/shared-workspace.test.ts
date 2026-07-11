import { describe, it, expect, afterEach } from 'vitest';
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
  maxReplayBytes?: number;
  maxWindows?: number;
}): SharedWorkspace {
  const w = new SharedWorkspace(output, {
    cols: opts?.cols ?? 80,
    rows: opts?.rows ?? 24,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.maxReplayBytes !== undefined ? { maxReplayBytes: opts.maxReplayBytes } : {}),
    ...(opts?.maxWindows !== undefined ? { maxWindows: opts.maxWindows } : {}),
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

// Screen clear + home the workspace writes on a window switch (see CLEAR in
// shared-workspace.ts). We assert on the leading \x1b[2J (erase display).
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
