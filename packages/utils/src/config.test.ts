import { describe, it, expect, afterEach } from 'vitest';
import { getConfig } from './config.js';

// getConfig() loads .env via dotenv, which does NOT override variables already
// present in process.env, so setting them here reliably exercises the parser.
const KEYS = ['MAX_FRAME_BYTES', 'RELAY_BURST', 'PORT', 'AGENT_DEFAULT_CWD', 'AGENT_ALLOWED_CWD'];

describe('config integer validation', () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
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
    delete process.env.AGENT_ALLOWED_CWD;
    const cfg = getConfig();
    expect(cfg.agentDefaultCwd).toBe(process.cwd());
    // Execution boundary defaults to exactly the launch directory.
    expect(cfg.agentAllowedCwd).toEqual([process.cwd()]);
  });

  it('defaults the allow-list to an explicit AGENT_DEFAULT_CWD', () => {
    process.env.AGENT_DEFAULT_CWD = '/srv/work';
    delete process.env.AGENT_ALLOWED_CWD;
    const cfg = getConfig();
    expect(cfg.agentDefaultCwd).toBe('/srv/work');
    expect(cfg.agentAllowedCwd).toEqual(['/srv/work']);
  });

  it('honors an explicit AGENT_ALLOWED_CWD override', () => {
    process.env.AGENT_ALLOWED_CWD = '/home:/srv';
    expect(getConfig().agentAllowedCwd).toEqual(['/home', '/srv']);
  });
});
