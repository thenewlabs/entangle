import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The module attaches window.entangle at import time, so give it a minimal window BEFORE the
// dynamic import. Everything the attach IIFE touches must exist; the connection under test is
// constructed directly and never opens a real socket.
(globalThis as Record<string, unknown>)['window'] = Object.assign(Object.create(null), {
  location: { pathname: '/', hash: '', origin: 'http://test', protocol: 'http:', host: 'test' },
  addEventListener: () => {},
});

const { EntangleConnection } = await import('./window-entangle-spawn.js');

/**
 * Watchdog starvation guard: the client shares its main thread with heavy same-origin iframes
 * (code-server's workbench blocks it for 30s+ during extension installs) and with background-tab
 * timer throttling. A stale lastRecvTs after such a stall is NOT a dead path — closing there
 * caused a reconnect + app-frame reload exactly when the app was busiest. The watchdog must
 * detect the stall (by its own missed tick cadence), grant one fresh window, and only close when
 * silence persists at a NORMAL cadence.
 */
describe('EntangleConnection heartbeat watchdog', () => {
  interface TestConn {
    ws: { readyState: number; close: () => void } | null;
    lastRecvTs: number;
    _startHeartbeat(): void;
    _stopHeartbeat(): void;
  }
  let conn: TestConn;
  let closed: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    conn = new EntangleConnection('cap', 'S') as unknown as TestConn;
    closed = 0;
    conn.ws = { readyState: 1 /* OPEN */, close: () => { closed += 1; } };
    conn.lastRecvTs = Date.now();
    conn._startHeartbeat();
  });

  afterEach(() => {
    conn._stopHeartbeat();
    vi.useRealTimers();
  });

  it('closes a genuinely silent connection at normal tick cadence', () => {
    // Ticks run every 10s as scheduled; no inbound frame for >45s → half-open → close.
    vi.advanceTimersByTime(60_000);
    expect(closed).toBeGreaterThan(0);
  });

  it('does NOT close after an event-loop stall (regression: busy iframe killed a healthy socket)', () => {
    // Simulate a 60s main-thread block: the wall clock jumps but no timer ran in between.
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(10_000); // first tick after the stall
    expect(closed).toBe(0);
  });

  it('still closes when silence persists after the post-stall grace window', () => {
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(10_000); // wake tick: grace, no close
    expect(closed).toBe(0);
    vi.advanceTimersByTime(60_000); // normal cadence resumes, still no inbound frames
    expect(closed).toBeGreaterThan(0);
  });

  it('a fresh inbound frame after the stall keeps the connection open', () => {
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(10_000); // wake tick
    conn.lastRecvTs = Date.now(); // keepalive echo arrives
    vi.advanceTimersByTime(30_000);
    expect(closed).toBe(0);
  });
});
