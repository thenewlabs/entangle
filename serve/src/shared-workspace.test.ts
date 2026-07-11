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
    expect(st.activeIndex).toBe(1); // the new window is active

    // Host + the viewport both received the new window-state.
    expect(hostStates.at(-1)).toMatchObject({ windows: st.windows, activeIndex: 1 });
    expect(vp.states.at(-1)).toMatchObject({ windows: st.windows, activeIndex: 1 });

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

  it('runs an independent shell per window (distinct PIDs; input routed to active)', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // Window 0 is active: its output taps onto the viewport. Echo its PID.
    ws.write('echo P0=$$\n');
    await waitFor(() => /P0=\d+/.test(vp.data), { message: 'window-0 marker never reached viewport' });
    const pid0 = /P0=(\d+)/.exec(vp.data)![1];

    // New window becomes active; input now routes to it (via writeFromViewport).
    ws.newWindow();
    expect(ws.windowState().activeIndex).toBe(1);
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

    ws.newWindow(); // create -> update
    expect(vp.states.at(-1)).toMatchObject({ activeIndex: 1 });
    expect(vp.states.at(-1)!.windows).toHaveLength(2);

    ws.selectWindow(0); // select -> update
    expect(vp.states.at(-1)).toMatchObject({ activeIndex: 0 });

    const beforeClose = vp.states.length;
    ws.closeWindow(1); // close -> update (async: PTY exit drives the broadcast)
    await waitFor(() => vp.states.length > beforeClose, { message: 'no window-state after close' });
    expect(vp.states.at(-1)!.windows).toHaveLength(1);
    expect(vp.states.at(-1)!.activeIndex).toBe(0);
  }, 12000);

  it('repaints the viewport on a window switch (clear + new active replay)', async () => {
    const ws = makeWorkspace();
    const vp = makeViewport('v1');
    ws.attachViewport(vp);

    // Window 0 produces a distinctive marker.
    ws.write('echo ALPHA_REPAINT\n');
    await waitFor(() => vp.data.includes('ALPHA_REPAINT'), { message: 'ALPHA never seen' });

    // Second window, produce its own marker.
    ws.newWindow();
    ws.write('echo BETA_REPAINT\n');
    await waitFor(() => vp.data.includes('BETA_REPAINT'), { message: 'BETA never seen' });

    // Isolate the switch: reset the collector, then switch back to window 0.
    vp.data = '';
    ws.selectWindow(0);

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
});
