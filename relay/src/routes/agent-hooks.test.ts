import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { setupAgentRoute } from './agent.js';
import { setupRelayRoute } from './relay.js';
import { RoutingState } from '../state/routing.js';
import { setRelayHooks, type RelayHooks } from '../hooks.js';

/**
 * Minimal `ws` stand-in: EventEmitter (has on/off/emit) plus the surface the
 * relay routes and installLiveness touch (send/close/ping/terminate/readyState).
 * `close`/`terminate` flip readyState and emit 'close' so disposers/removeAgent
 * run exactly as they would on a real socket.
 */
class FakeWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: unknown[] = [];
  closed?: { code: number; reason: string };

  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
  ping(): void {
    /* no-op */
  }
  terminate(): void {
    this.close(1006, 'terminated');
  }

  /** JSON control messages this socket received, parsed. */
  jsonSent(): any[] {
    return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m as string));
  }
  /** Binary frames this socket received. */
  bufSent(): Buffer[] {
    return this.sent.filter((m): m is Buffer => Buffer.isBuffer(m));
  }
}

/** Let the async message handler settle. */
const flush = () => new Promise((r) => setImmediate(r));

const VALID_CAP = 'cap_test1234';

function envSnapshot(...keys: string[]): () => void {
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe('setupAgentRoute — default (no hooks)', () => {
  let routing: RoutingState;
  let restore: () => void;

  beforeEach(() => {
    setRelayHooks({});
    routing = new RoutingState();
    restore = envSnapshot('RELAY_AGENT_TOKEN', 'RELAY_REQUIRE_AGENT_TOKEN', 'NODE_ENV');
    delete process.env.RELAY_AGENT_TOKEN;
    delete process.env.RELAY_REQUIRE_AGENT_TOKEN;
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    setRelayHooks({});
    restore();
  });

  it('registers with a valid flat RELAY_AGENT_TOKEN', async () => {
    process.env.RELAY_AGENT_TOKEN = 'secret';
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'secret', machineId: 'm1' }));
    await flush();

    expect(ws.closed).toBeUndefined();
    const assign = ws.jsonSent().find((m) => m.type === 'ASSIGN');
    expect(assign).toBeDefined();
    expect(routing.getAgentCount()).toBe(1);
  });

  it('closes 1008 on an invalid flat token', async () => {
    process.env.RELAY_AGENT_TOKEN = 'secret';
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'wrong', machineId: 'm1' }));
    await flush();

    expect(ws.closed).toEqual({ code: 1008, reason: 'Invalid agent token' });
    expect(routing.getAgentCount()).toBe(0);
  });

  it('fails closed (1008) when a token is required but none is configured', async () => {
    delete process.env.RELAY_AGENT_TOKEN;
    process.env.RELAY_REQUIRE_AGENT_TOKEN = '1';
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'anything', machineId: 'm1' }));
    await flush();

    expect(ws.closed).toEqual({ code: 1008, reason: 'Agent authentication required' });
    expect(routing.getAgentCount()).toBe(0);
  });

  it('registers with no token when none is required (today\'s open default)', async () => {
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', machineId: 'm1' }));
    await flush();

    expect(ws.closed).toBeUndefined();
    expect(routing.getAgentCount()).toBe(1);
  });
});

describe('setupAgentRoute — verifyAgentToken hook', () => {
  let routing: RoutingState;

  beforeEach(() => {
    routing = new RoutingState();
    // A configured flat token that the verifier hook must OVERRIDE (never consult).
    process.env.RELAY_AGENT_TOKEN = 'flat-token-should-be-ignored';
  });
  afterEach(() => {
    setRelayHooks({});
    delete process.env.RELAY_AGENT_TOKEN;
  });

  it('accepts when the verifier returns an opaque id, and binds the capability', async () => {
    const seenTokens: Array<[string, string]> = [];
    const registered: any[] = [];
    const closed: any[] = [];
    setRelayHooks({
      verifyAgentToken: async (token, machineId) => {
        seenTokens.push([token, machineId]);
        return token === 'good' ? { id: 'ident-42' } : null;
      },
      onCapabilityRegistered: (info) => registered.push(info),
      onCapabilityClosed: (info) => closed.push(info),
    });

    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'good', machineId: 'box-1' }));
    await flush();
    expect(ws.closed).toBeUndefined();
    expect(seenTokens).toEqual([['good', 'box-1']]);
    expect(routing.getAgentCount()).toBe(1);

    ws.emit('message', JSON.stringify({ type: 'ANNOUNCE_CAP', capId: VALID_CAP }));
    await flush();
    expect(registered).toEqual([{ identityId: 'ident-42', capId: VALID_CAP, machineId: 'box-1' }]);

    // Disconnect → onCapabilityClosed for each announced cap.
    ws.close();
    expect(closed).toEqual([{ capId: VALID_CAP, identityId: 'ident-42' }]);
  });

  it('closes 1008 when the verifier returns null', async () => {
    setRelayHooks({
      verifyAgentToken: async () => null,
    });
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'good', machineId: 'box-1' }));
    await flush();

    expect(ws.closed).toEqual({ code: 1008, reason: 'Invalid agent token' });
    expect(routing.getAgentCount()).toBe(0);
  });

  it('closes 1008 when the verifier throws', async () => {
    setRelayHooks({
      verifyAgentToken: async () => {
        throw new Error('backend down');
      },
    });
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'good', machineId: 'box-1' }));
    await flush();

    expect(ws.closed).toEqual({ code: 1008, reason: 'Invalid agent token' });
    expect(routing.getAgentCount()).toBe(0);
  });

  it('does not fire onCapabilityRegistered for an unverified (flat-token) socket', async () => {
    const registered: any[] = [];
    setRelayHooks({ onCapabilityRegistered: (info) => registered.push(info) });
    // No verifier → flat-token path; identity stays unknown so no binding hook.
    const ws = new FakeWs();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', token: 'flat-token-should-be-ignored', machineId: 'm' }));
    await flush();
    ws.emit('message', JSON.stringify({ type: 'ANNOUNCE_CAP', capId: VALID_CAP }));
    await flush();

    expect(routing.getAgentCount()).toBe(1);
    expect(registered).toEqual([]);
  });
});

describe('meter hook — capability forward sites', () => {
  let routing: RoutingState;
  const events: any[] = [];

  beforeEach(() => {
    routing = new RoutingState();
    events.length = 0;
    delete process.env.RELAY_AGENT_TOKEN;
    setRelayHooks({ meter: (e) => events.push(e) });
  });
  afterEach(() => setRelayHooks({}));

  it('meters invoker→agent (up) at the relay-route forward site', () => {
    const agentWs = new FakeWs();
    const agentId = routing.registerAgent(agentWs as any, 'm')!;
    routing.announceCapability(agentId, VALID_CAP);

    const invokerWs = new FakeWs();
    setupRelayRoute(invokerWs as any, routing, VALID_CAP);

    const frame = Buffer.from([1, 2, 3, 4, 5]);
    invokerWs.emit('message', frame);

    const up = events.find((e) => e.direction === 'up');
    expect(up).toEqual({
      capId: VALID_CAP,
      source: 'capability',
      direction: 'up',
      bytes: 5,
      label: VALID_CAP,
    });
    // The frame was actually forwarded to the agent as a RELAY_MSG envelope.
    expect(agentWs.jsonSent().some((m) => m.type === 'RELAY_MSG')).toBe(true);
  });

  it('meters agent→invoker (down) at the agent-route RELAY_RESPONSE site', async () => {
    const agentWs = new FakeWs();
    setupAgentRoute(agentWs as any, routing);
    agentWs.emit('message', JSON.stringify({ type: 'CLIENT_HELLO', machineId: 'm' }));
    await flush();
    const agentId = agentWs.jsonSent().find((m) => m.type === 'ASSIGN').agentId;

    routing.announceCapability(agentId, VALID_CAP);
    const invokerWs = new FakeWs();
    const invokerId = routing.registerInvoker(invokerWs as any, VALID_CAP);

    const payload = Buffer.from([9, 9, 9]);
    agentWs.emit(
      'message',
      JSON.stringify({ type: 'RELAY_RESPONSE', socketId: invokerId, frame: payload.toString('base64') }),
    );
    await flush();

    const down = events.find((e) => e.direction === 'down');
    expect(down).toEqual({
      capId: VALID_CAP,
      source: 'capability',
      direction: 'down',
      bytes: 3,
      label: VALID_CAP,
    });
    // The unwrapped frame reached the invoker byte-for-byte.
    expect(invokerWs.bufSent()).toEqual([payload]);
  });

  it('is a no-op when no meter hook is set (default)', () => {
    setRelayHooks({});
    const agentWs = new FakeWs();
    const agentId = routing.registerAgent(agentWs as any, 'm')!;
    routing.announceCapability(agentId, VALID_CAP);
    const invokerWs = new FakeWs();
    setupRelayRoute(invokerWs as any, routing, VALID_CAP);
    // Should not throw and should still forward.
    invokerWs.emit('message', Buffer.from([1, 2]));
    expect(agentWs.jsonSent().some((m) => m.type === 'RELAY_MSG')).toBe(true);
  });
});

// Compile-time sanity: the exported hook shape is what embedders inject.
const _typecheck: RelayHooks = {
  verifyAgentToken: (_t, _m) => null,
  onCapabilityRegistered: () => {},
  onCapabilityClosed: () => {},
  meter: () => {},
};
void _typecheck;
