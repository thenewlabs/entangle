import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { installLiveness, pingIntervalMs } from './liveness.js';

/** Minimal ws stand-in: EventEmitter (has on/off) + ping/terminate spies. */
class FakeWs extends EventEmitter {
  pings = 0;
  terminated = false;
  ping(): void {
    this.pings++;
  }
  terminate(): void {
    this.terminated = true;
    this.emit('close');
  }
}

describe('installLiveness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pings on the interval and keeps a ponging socket alive', () => {
    const ws = new FakeWs();
    installLiveness(ws as never, 1000);

    vi.advanceTimersByTime(1000);
    expect(ws.pings).toBe(1);
    ws.emit('pong'); // socket answered → stays alive

    vi.advanceTimersByTime(1000);
    expect(ws.pings).toBe(2);
    expect(ws.terminated).toBe(false);
  });

  it('terminates a half-open socket that misses a pong', () => {
    const ws = new FakeWs();
    installLiveness(ws as never, 1000);

    vi.advanceTimersByTime(1000); // ping, mark not-alive
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    vi.advanceTimersByTime(1000); // no pong arrived → terminate
    expect(ws.terminated).toBe(true);
  });

  it('stops pinging once the socket closes', () => {
    const ws = new FakeWs();
    installLiveness(ws as never, 1000);
    ws.emit('close');
    vi.advanceTimersByTime(5000);
    expect(ws.pings).toBe(0);
  });
});

describe('pingIntervalMs', () => {
  const prev = process.env.RELAY_WS_PING_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.RELAY_WS_PING_MS;
    else process.env.RELAY_WS_PING_MS = prev;
  });

  it('defaults to 20s and honors a valid override', () => {
    delete process.env.RELAY_WS_PING_MS;
    expect(pingIntervalMs()).toBe(20000);
    process.env.RELAY_WS_PING_MS = '5000';
    expect(pingIntervalMs()).toBe(5000);
    process.env.RELAY_WS_PING_MS = '10'; // too small → ignored
    expect(pingIntervalMs()).toBe(20000);
  });
});
