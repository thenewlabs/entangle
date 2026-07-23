import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RoutingState } from './routing.js';

/** Minimal ws stub: captures the 'close' handler so a disconnect can be simulated. */
function fakeWs() {
  const handlers: Record<string, () => void> = {};
  return {
    ws: { on: (ev: string, fn: () => void) => { handlers[ev] = fn; }, readyState: 1, OPEN: 1 } as any,
    close: () => handlers.close?.(),
  };
}

describe('RoutingState public shares', () => {
  let routing: RoutingState;

  beforeEach(() => {
    routing = new RoutingState();
  });
  afterEach(() => {
    delete process.env.RELAY_MAX_SHARES_PER_AGENT;
  });

  it('reserves, looks up, and reports availability', () => {
    const { ws } = fakeWs();
    const agentId = routing.registerAgent(ws, 'm')!;

    expect(routing.shareAvailability('demo')).toEqual({ available: true });
    const r = routing.reserveShare(agentId, 'Demo', 'sid1');
    expect(r).toEqual({ ok: true, subdomain: 'demo' });

    const info = routing.lookupShare('demo');
    expect(info).toMatchObject({ subdomain: 'demo', agentId, shareId: 'sid1' });
    expect(routing.shareAvailability('demo')).toEqual({ available: false, reason: 'taken' });
  });

  it('rejects invalid and reserved labels', () => {
    const { ws } = fakeWs();
    const agentId = routing.registerAgent(ws, 'm')!;
    expect(routing.reserveShare(agentId, 'bad_name', 's')).toEqual({ ok: false, reason: 'invalid' });
    expect(routing.reserveShare(agentId, 'preview', 's')).toEqual({ ok: false, reason: 'reserved' });
  });

  it('denies a subdomain taken by another agent but is idempotent for the owner', () => {
    const a = fakeWs();
    const b = fakeWs();
    const agentA = routing.registerAgent(a.ws, 'a')!;
    const agentB = routing.registerAgent(b.ws, 'b')!;

    expect(routing.reserveShare(agentA, 'x', 'sidA').ok).toBe(true);
    expect(routing.reserveShare(agentB, 'x', 'sidB')).toEqual({ ok: false, reason: 'taken' });
    // Same owner + same shareId re-announce (reconnect) is accepted.
    expect(routing.reserveShare(agentA, 'x', 'sidA')).toEqual({ ok: true, subdomain: 'x' });
    // Same owner, DIFFERENT shareId is treated as a conflict.
    expect(routing.reserveShare(agentA, 'x', 'other')).toEqual({ ok: false, reason: 'taken' });
  });

  it('only the owner can release a subdomain', () => {
    const a = fakeWs();
    const b = fakeWs();
    const agentA = routing.registerAgent(a.ws, 'a')!;
    const agentB = routing.registerAgent(b.ws, 'b')!;
    routing.reserveShare(agentA, 'y', 's');
    expect(routing.releaseShare(agentB, 'y')).toBe(false);
    expect(routing.lookupShare('y')).not.toBeNull();
    expect(routing.releaseShare(agentA, 'y')).toBe(true);
    expect(routing.lookupShare('y')).toBeNull();
  });

  it('enforces the per-agent share limit', () => {
    process.env.RELAY_MAX_SHARES_PER_AGENT = '2';
    const { ws } = fakeWs();
    const agentId = routing.registerAgent(ws, 'm')!;
    expect(routing.reserveShare(agentId, 'a', '1').ok).toBe(true);
    expect(routing.reserveShare(agentId, 'b', '2').ok).toBe(true);
    expect(routing.reserveShare(agentId, 'c', '3')).toEqual({ ok: false, reason: 'limit' });
  });

  it('releases all of an agent\'s shares when its socket closes', () => {
    const { ws, close } = fakeWs();
    const agentId = routing.registerAgent(ws, 'm')!;
    routing.reserveShare(agentId, 'one', '1');
    routing.reserveShare(agentId, 'two', '2');
    expect(routing.lookupShare('one')).not.toBeNull();

    close(); // simulate the agent WebSocket closing

    expect(routing.lookupShare('one')).toBeNull();
    expect(routing.lookupShare('two')).toBeNull();
    expect(routing.shareAvailability('one')).toEqual({ available: true });
  });
});
