import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

// Regression guards for bugs found while driving the real binaries:
//  - ESM `require is not defined` crash in the agent (getMachineId / session cleanup)
//  - relay refusing to start under Express 5 (`app.get('*')` path-to-regexp error)
//  - entangle-connect rejecting dashed command args ("unknown option '-c'")
// These run the COMPILED output, so they require a prior `npm run build`.
const root = process.cwd();
const agentBin = join(root, 'agent/dist/index.js');
const connectBin = join(root, 'invoke/dist/index.js');
const relayBin = join(root, 'server/dist/index.js');
const built = existsSync(agentBin) && existsSync(connectBin) && existsSync(relayBin);

describe.skipIf(!built)('Built binaries — startup & CLI regressions', () => {
  it('entangle-agent --version runs (no ESM `require is not defined`)', () => {
    const r = spawnSync('node', [agentBin, '--version'], { encoding: 'utf8', timeout: 10000 });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out).not.toMatch(/require is not defined/i);
    expect(r.status).toBe(0);
  });

  it('entangle-connect --version runs (no ESM `require is not defined`)', () => {
    const r = spawnSync('node', [connectBin, '--version'], { encoding: 'utf8', timeout: 10000 });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out).not.toMatch(/require is not defined/i);
    expect(r.status).toBe(0);
  });

  it('entangle-connect passes dashed args through to the remote command', () => {
    // Points at a dead port: this must fail with a CONNECTION error, never a
    // commander "unknown option" error — proving `sh -c '...'` parses.
    const r = spawnSync(
      'node',
      [connectBin, 'http://127.0.0.1:1/cap/abc#S=xyz', 'sh', '-c', 'echo hi'],
      { encoding: 'utf8', timeout: 10000 }
    );
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out).not.toMatch(/unknown option/i);
  });

  it('entangle-relay actually starts and serves /__health (Express 5 route fix)', async () => {
    const port = 8300 + Math.floor(Date.now() % 90);
    const proc = spawn('node', [relayBin, 'start'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
      stdio: 'ignore',
    });
    try {
      let ok = false;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/__health`);
          if (res.ok) { ok = true; break; }
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(ok).toBe(true);
    } finally {
      proc.kill('SIGKILL');
    }
  }, 15000);
});
