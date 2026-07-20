import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { validateCwd, buildChildEnv } from '@thenewlabs/entangle-utils';
import { RoutingState } from '../../relay/src/state/routing.js';
import { setupAgentRoute } from '../../relay/src/routes/agent.js';
import { MAX_BUCKETS, PerIpRateLimiter } from '../../relay/src/utils/rate-limit.js';

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
  const ip = (i: number): string => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

  /**
   * A limiter with the cap shrunk and the clock made explicit.
   *
   * The clock advances by `tickMs` per call. Some advance is required: the
   * eviction pass's `now - lastRefill > 0` guard only considers a bucket
   * evictable once time has moved since it was touched. Driving that explicitly
   * is why these tests no longer depend on how long the host takes per
   * iteration. `tickMs` is settable because the cooldown test needs its whole
   * flood to fit inside the abuser's backoff window.
   */
  function makeLimiter(maxBuckets: number, tickMs = 1): PerIpRateLimiter {
    let clock = 1_000_000;
    return new PerIpRateLimiter({ maxBuckets, now: () => (clock += tickMs) });
  }

  it('ships the documented hard cap by default', () => {
    // The tests below shrink the cap to keep the flood cheap, so this pins the
    // value production actually runs with. Without it, MAX_BUCKETS could be
    // raised to infinity and every other test here would still pass.
    expect(MAX_BUCKETS).toBe(50_000);
    expect(new PerIpRateLimiter().size).toBe(0);
  });

  it('does not grow the bucket map without bound under many distinct IPs', () => {
    // Assert the PROPERTY (the map stays bounded), not a proxy for it. The
    // previous version flooded 60k IPs and then checked that a fresh IP was
    // still allowed — but a fresh IP is served unconditionally, so that
    // assertion held even with eviction removed entirely and the map grown to
    // 60k entries. It could only ever fail by exceeding the 10s timeout, which
    // it did on a loaded machine: ~99% of those 10s was getConfig() re-reading
    // .env from disk once per check, not the code under test.
    //
    // Hence 1000 checks rather than 60_000. With the cap injected, a 10x
    // overflow already drives ~10 eviction passes — the same code path any
    // larger number would take, for 1/60th of the wall-clock.
    const cap = 100;
    const limiter = makeLimiter(cap);

    let peak = 0;
    for (let i = 0; i < cap * 10; i++) {
      limiter.check(ip(i));
      peak = Math.max(peak, limiter.size);
    }

    // 1000 distinct IPs went in and the map never exceeded the cap — sampled
    // every iteration, so growth cannot hide between checks.
    expect(peak).toBeLessThanOrEqual(cap);
    // ...and it really did evict rather than, say, refusing to admit new IPs:
    // the most recent IP must still be tracked.
    expect(limiter.size).toBeGreaterThan(cap * 0.5);

    // Secondary: eviction does not break service for a brand-new IP.
    expect(limiter.check('203.0.113.7').allowed).toBe(true);
    // Generous timeout on purpose. A real regression fails on the assertions
    // above in milliseconds (verified by injecting one), so the only thing this
    // headroom can absorb is getConfig()'s per-check disk read grinding under a
    // loaded machine — which is not the behaviour under test.
  }, 30000);

  it('does not let eviction reset a misbehaving IP: buckets in cooldown are kept', () => {
    // The documented reason evictIfNeeded skips cooling-down buckets. Without
    // it, an attacker could flush their own backoff by flooding distinct IPs.
    // A sub-millisecond tick keeps the entire flood below (and it must stay
    // below) the abuser's first backoff of 2^1 * 100 = 200ms, so a still-active
    // cooldown afterwards means the bucket SURVIVED eviction rather than merely
    // outliving its cooldown. ~1100 requests inside ~55ms is a realistic flood.
    const cap = 100;
    const limiter = makeLimiter(cap, 0.05);

    // Burn the abuser's tokens (burst defaults to 50) until it is rejected.
    const abuser = '198.51.100.9';
    let rejected = false;
    for (let i = 0; i < 200 && !rejected; i++) rejected = !limiter.check(abuser).allowed;
    expect(rejected).toBe(true);

    // Now flood enough distinct IPs to drive ~10 eviction passes over it.
    for (let i = 0; i < cap * 10; i++) limiter.check(ip(i));

    // Still cooling down — it was not evicted and re-admitted with fresh tokens.
    const after = limiter.check(abuser);
    expect(after.allowed).toBe(false);
    expect(after.retryAfterMs).toBeGreaterThan(0);
  });

  it('holds the cap when the clock does not advance (a whole flood inside one ms)', () => {
    // The eviction pass used to require `now - lastRefill > 0`, so buckets all
    // created within the SAME millisecond were never evictable and the map grew
    // without bound past maxBuckets. A frozen clock is the deterministic,
    // worst-case form of that: no bucket ever ages at all.
    const cap = 100;
    const limiter = new PerIpRateLimiter({ maxBuckets: cap, now: () => 1_000_000 });

    let peak = 0;
    for (let i = 0; i < cap * 10; i++) {
      limiter.check(ip(i));
      peak = Math.max(peak, limiter.size);
    }

    expect(peak).toBeLessThanOrEqual(cap);
    // Still evicting rather than refusing new IPs.
    expect(limiter.size).toBeGreaterThan(cap * 0.5);
  });

  it('holds the cap even when EVERY tracked bucket is in active cooldown', () => {
    // Sparing cooling-down buckets is deliberate (see the test above), but it
    // cannot be unconditional: if it were, an attacker who drives every tracked
    // IP into cooldown would make the whole map unevictable and grow it without
    // bound. The cap is a memory-safety ceiling and must hold absolutely; the
    // last-resort pass therefore evicts the OLDEST-inserted bucket even when it
    // is cooling down. A frozen clock keeps every cooldown permanently active.
    const cap = 100;
    const limiter = new PerIpRateLimiter({ maxBuckets: cap, now: () => 1_000_000 });

    let peak = 0;
    // burst defaults to 50; 60 checks per IP guarantees rejection + cooldown.
    for (let i = 0; i < cap * 1.5; i++) {
      for (let n = 0; n < 60; n++) limiter.check(ip(i));
      peak = Math.max(peak, limiter.size);
    }

    expect(peak).toBeLessThanOrEqual(cap);
  });
});
