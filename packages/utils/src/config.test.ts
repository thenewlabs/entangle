import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { getConfig, resetConfigCache } from './config.js';

// getConfig() loads .env via dotenv, which does NOT override variables already
// present in process.env, so setting them here reliably exercises the parser.
const KEYS = ['MAX_FRAME_BYTES', 'RELAY_BURST', 'PORT', 'AGENT_DEFAULT_CWD', 'AGENT_ALLOWED_CWD', 'RELAY_MAX_AGENTS', 'RELAY_REQUIRE_AGENT_TOKEN'];

describe('config integer validation', () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    // Restore the harness default so requireAgentToken assertions elsewhere hold.
    process.env.NODE_ENV = 'test';
  });

  it('accepts a valid integer', () => {
    process.env.MAX_FRAME_BYTES = '2048';
    expect(getConfig().maxFrameBytes).toBe(2048);
  });

  it('falls back to the default on a non-numeric value (never NaN)', () => {
    process.env.MAX_FRAME_BYTES = 'not-a-number';
    const v = getConfig().maxFrameBytes;
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(1048576);
  });

  it('falls back to the default on a negative / out-of-range value', () => {
    process.env.RELAY_BURST = '-5';
    expect(getConfig().relayBurst).toBe(50);
  });

  it('rejects a non-integer float', () => {
    process.env.MAX_FRAME_BYTES = '1024.5';
    expect(getConfig().maxFrameBytes).toBe(1048576);
  });

  it('enforces the PORT upper bound', () => {
    process.env.PORT = '70000';
    expect(getConfig().port).toBe(8080);
  });

  it('binds cwd to the launch directory when unset', () => {
    delete process.env.AGENT_DEFAULT_CWD;
    const cfg = getConfig();
    expect(cfg.agentDefaultCwd).toBe(process.cwd());
    // Execution boundary is exactly the working directory.
    expect(cfg.agentAllowedCwd).toEqual([process.cwd()]);
  });

  it('uses AGENT_DEFAULT_CWD as both working dir and boundary', () => {
    process.env.AGENT_DEFAULT_CWD = '/srv/work';
    const cfg = getConfig();
    expect(cfg.agentDefaultCwd).toBe('/srv/work');
    expect(cfg.agentAllowedCwd).toEqual(['/srv/work']);
  });

  it('validates routing ceilings (bad value -> default)', () => {
    process.env.RELAY_MAX_AGENTS = 'nope';
    expect(getConfig().relayMaxAgents).toBe(10000);
  });

  it('requires the agent token in production or when explicitly set', () => {
    expect(getConfig().requireAgentToken).toBe(false); // NODE_ENV=test
    process.env.RELAY_REQUIRE_AGENT_TOKEN = '1';
    expect(getConfig().requireAgentToken).toBe(true);
    delete process.env.RELAY_REQUIRE_AGENT_TOKEN;
    process.env.NODE_ENV = 'production';
    expect(getConfig().requireAgentToken).toBe(true);
  });
});

describe('config .env read is not on the hot path', () => {
  const require = createRequire(import.meta.url);
  const fs = require('fs');

  /** Count readFileSync calls that target a .env file while `fn` runs. */
  function countEnvReads(fn: () => void): number {
    const orig = fs.readFileSync;
    let n = 0;
    fs.readFileSync = function (p: unknown, ...rest: unknown[]) {
      if (typeof p === 'string' && p.endsWith('.env')) n++;
      return orig.call(this, p, ...rest);
    };
    try {
      fn();
    } finally {
      fs.readFileSync = orig;
    }
    return n;
  }

  afterEach(() => {
    delete process.env.RELAY_BURST;
    resetConfigCache();
  });

  it('reads .env from disk at most once across many getConfig() calls', () => {
    // getConfig() sits on the relay's WS-upgrade hot path, so every upgrade
    // attempt — including an attacker's — used to force a synchronous
    // readFileSync of .env. That is both a throughput problem and a DoS
    // amplifier. Before the fix this counted 5000; the loop below is the same
    // shape as the real hot path.
    resetConfigCache();
    const reads = countEnvReads(() => {
      for (let i = 0; i < 5000; i++) getConfig();
    });
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('still observes process.env changes made after the first getConfig()', () => {
    // The reason this was never simply memoized: nine test files (and any
    // programmatic embedder) mutate process.env and expect the NEXT getConfig()
    // to see it. Only the disk read is cached — the env is re-read every call.
    resetConfigCache();
    expect(getConfig().relayBurst).toBe(50);
    process.env.RELAY_BURST = '7';
    expect(getConfig().relayBurst).toBe(7);
    process.env.RELAY_BURST = '9';
    expect(getConfig().relayBurst).toBe(9);
    delete process.env.RELAY_BURST;
    expect(getConfig().relayBurst).toBe(50);
  });

  it('resetConfigCache() forces the next getConfig() to re-read .env', () => {
    resetConfigCache();
    getConfig();
    // Cached: no further reads.
    expect(countEnvReads(() => getConfig())).toBe(0);
    // Explicitly invalidated: reads again.
    expect(countEnvReads(() => { resetConfigCache(); getConfig(); })).toBe(1);
  });
});
