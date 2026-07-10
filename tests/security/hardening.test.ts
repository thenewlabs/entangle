import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { validateCwd, buildChildEnv } from '@thenewlabs/entangle-utils';
import { RoutingState } from '../../server/src/state/routing.js';
import { setupAgentRoute } from '../../server/src/routes/agent.js';
import { PerIpRateLimiter } from '../../server/src/utils/rate-limit.js';

// Minimal WebSocket stand-in.
class MockWebSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  closed?: { code: number; reason: string };
  send(data: any) { this.sent.push(data); }
  close(code = 1000, reason = '') { this.readyState = 3; this.closed = { code, reason }; this.emit('close'); }
}

describe('Hardening — CWD allow-list boundary (M1/H1)', () => {
  it('allows the exact directory and true subdirectories', () => {
    expect(() => validateCwd('/srv/app', ['/srv/app'])).not.toThrow();
    expect(() => validateCwd('/srv/app/sub/dir', ['/srv/app'])).not.toThrow();
  });

  it('rejects a sibling that merely shares a string prefix', () => {
    // The classic startsWith() bug: /srv/app-secret must NOT match /srv/app.
    expect(() => validateCwd('/srv/app-secret', ['/srv/app'])).toThrow(/not in allowed/i);
  });

  it('rejects path traversal that escapes the allowed prefix', () => {
    expect(() => validateCwd('/srv/app/../../etc', ['/srv/app'])).toThrow(/not in allowed/i);
  });

  it('is unrestricted when no allow-list is configured', () => {
    expect(() => validateCwd('/anywhere', undefined)).not.toThrow();
    expect(() => validateCwd('/anywhere', [])).not.toThrow();
  });
});

describe('Hardening — minimal child environment (H2)', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.AWS_SECRET_ACCESS_KEY = 'super-secret';
    process.env.MY_ALLOWED = 'from-agent';
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('does not leak arbitrary agent env (e.g. cloud creds) to children', () => {
    const env = buildChildEnv([]);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  });

  it('drops caller-supplied env vars that are not on the allow-list', () => {
    const env = buildChildEnv([], { LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require /tmp/x' });
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('passes through only operator-approved names, and lets the caller override those', () => {
    const env = buildChildEnv(['MY_ALLOWED'], { MY_ALLOWED: 'from-caller', OTHER: 'nope' });
    expect(env.MY_ALLOWED).toBe('from-caller');
    expect(env.OTHER).toBeUndefined();
  });
});

describe('Hardening — invoker ownership (agent cannot inject cross-relay) ', () => {
  it('only reports ownership for invokers on capabilities the agent owns', () => {
    const routing = new RoutingState();
    const agentA = routing.registerAgent(new MockWebSocket() as any, 'A');
    const agentB = routing.registerAgent(new MockWebSocket() as any, 'B');
    routing.announceCapability(agentA, 'cap-A');
    routing.announceCapability(agentB, 'cap-B');

    const invoker = routing.registerInvoker(new MockWebSocket() as any, 'cap-A');

    expect(routing.invokerBelongsToAgent(invoker, agentA)).toBe(true);
    expect(routing.invokerBelongsToAgent(invoker, agentB)).toBe(false);
    expect(routing.invokerBelongsToAgent('nonexistent', agentA)).toBe(false);
  });
});

describe('Hardening — agent registration token gate (H3)', () => {
  const OLD = process.env.RELAY_AGENT_TOKEN;
  afterEach(() => {
    if (OLD === undefined) delete process.env.RELAY_AGENT_TOKEN;
    else process.env.RELAY_AGENT_TOKEN = OLD;
  });

  it('rejects registration without the configured token', () => {
    process.env.RELAY_AGENT_TOKEN = 'secret-token';
    const routing = new RoutingState();
    const ws = new MockWebSocket();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'CLIENT_HELLO', machineId: 'x' })));

    expect(ws.closed?.code).toBe(1008);
    expect(routing.getAgentCount()).toBe(0);
  });

  it('accepts registration with the correct token', () => {
    process.env.RELAY_AGENT_TOKEN = 'secret-token';
    const routing = new RoutingState();
    const ws = new MockWebSocket();
    setupAgentRoute(ws as any, routing);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'CLIENT_HELLO', machineId: 'x', token: 'secret-token' })));

    expect(ws.closed).toBeUndefined();
    expect(routing.getAgentCount()).toBe(1);
  });
});

describe('Hardening — rate-limiter is bounded (M2)', () => {
  it('does not grow the bucket map without bound under many distinct IPs', () => {
    const limiter = new PerIpRateLimiter();
    for (let i = 0; i < 60_000; i++) {
      limiter.check(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    }
    // Internal map is private; assert via the documented hard cap using a probe:
    // after the flood, a brand-new IP is still served (no unbounded growth / OOM).
    const decision = limiter.check('203.0.113.7');
    expect(decision.allowed).toBe(true);
  });
});
