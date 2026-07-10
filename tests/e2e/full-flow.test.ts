import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { initCrypto, generateCapId, generateSecret } from '@thenewlabs/entangle-crypto';
import { InvokeConnection } from '../../invoke/src/connection.js';

// Real end-to-end: relay + agent as child processes, driven by the actual
// InvokeConnection client. Exercises the v2 handshake (per-session keys,
// direction-bound AAD), stream open/data/exit, and stdout/stderr channels.
describe('E2E Full Flow (v2 protocol)', () => {
  const port = 8100 + Math.floor(Date.now() % 800);
  const wsBase = `ws://127.0.0.1:${port}`;
  const httpBase = `http://127.0.0.1:${port}`;
  const home = join(tmpdir(), `entangle-e2e-${Date.now()}`);
  const repoRoot = process.cwd();

  let capId: string;
  let S: string;
  let server: ChildProcess | undefined;
  let agent: ChildProcess | undefined;

  const waitFor = async (fn: () => Promise<boolean>, ms: number, label: string) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { if (await fn()) return; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  beforeAll(async () => {
    await initCrypto();
    // Seed a known capability into a temp HOME the agent will read.
    mkdirSync(join(home, '.entangle'), { recursive: true });
    capId = generateCapId().capId;
    S = generateSecret();
    writeFileSync(
      join(home, '.entangle', 'capabilities.json'),
      JSON.stringify([{ capId, S, policy: { singleRun: false, maxStreams: 4 } }], null, 2),
      { mode: 0o600 }
    );

    server = spawn('node', [join(repoRoot, 'server/dist/index.js'), 'start'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
      stdio: 'ignore',
    });

    await waitFor(async () => (await fetch(`${httpBase}/__health`)).ok, 10000, 'relay health');

    agent = spawn('node', [join(repoRoot, 'agent/dist/index.js'), 'start', '--server', httpBase], {
      env: {
        ...process.env,
        HOME: home,
        LOG_LEVEL: 'warn',
        // Run inside the temp home; allow it (repo .env otherwise restricts cwd).
        AGENT_DEFAULT_CWD: home,
        AGENT_ALLOWED_CWD: home,
      },
      stdio: 'ignore',
    });

    // Wait until the relay reports the agent registered its capability.
    await waitFor(async () => {
      const h = await (await fetch(`${httpBase}/__health`)).json();
      return h.agents >= 1;
    }, 10000, 'agent registration');
  }, 30000);

  afterAll(async () => {
    for (const p of [agent, server]) {
      if (!p) continue;
      p.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const p of [agent, server]) p?.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });

  it('runs a command end-to-end and separates stdout from stderr', async () => {
    const conn = new InvokeConnection(capId, S);

    // The agent may still be announcing; retry the initial connect briefly.
    await waitFor(async () => {
      try { await conn.connect(`${wsBase}/relay/${capId}`); return true; } catch { return false; }
    }, 10000, 'authenticated connection');

    const out: string[] = [];
    const err: string[] = [];
    const decoder = new TextDecoder();

    const exit = await new Promise<{ code: number | null }>((resolve, reject) => {
      conn.openCmd(['sh', '-c', 'echo out-line; echo err-line 1>&2'], {}, {
        onData: (chunk, channel) => {
          (channel === 'stderr' ? err : out).push(decoder.decode(chunk));
        },
        onExit: (code) => resolve({ code }),
        onError: (m) => reject(new Error(m)),
      });
    });

    conn.disconnect();

    expect(out.join('')).toContain('out-line');
    expect(err.join('')).toContain('err-line');
    // stderr must not bleed into stdout (channel separation).
    expect(out.join('')).not.toContain('err-line');
    expect(exit.code).toBe(0);
  }, 20000);

  it('supports many concurrent invoker sessions on one capability', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E'];
    const results = await Promise.all(labels.map(async (label) => {
      const conn = new InvokeConnection(capId, S);
      await conn.connect(`${wsBase}/relay/${capId}`);
      const out: string[] = [];
      const decoder = new TextDecoder();
      const code = await new Promise<number | null>((resolve, reject) => {
        conn.openCmd(['sh', '-c', `echo RESULT_${label}`], {}, {
          onData: (chunk) => out.push(decoder.decode(chunk)),
          onExit: (c) => resolve(c),
          onError: (m) => reject(new Error(m)),
        });
      });
      conn.disconnect();
      return { label, text: out.join('').trim(), code };
    }));

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.text).toBe(`RESULT_${r.label}`);
    }
  }, 20000);

  it('rejects a command whose cwd is outside the allow-list (H1 enforced end-to-end)', async () => {
    const conn = new InvokeConnection(capId, S);
    await waitFor(async () => {
      try { await conn.connect(`${wsBase}/relay/${capId}`); return true; } catch { return false; }
    }, 10000, 'authenticated connection');

    const err = await new Promise<string>((resolve, reject) => {
      conn.openCmd(['echo', 'nope'], { cwd: '/etc' }, {
        onError: (m) => resolve(m),
        onExit: () => reject(new Error('command should not have run in /etc')),
      });
    });

    conn.disconnect();
    expect(err).toMatch(/allowed|cwd/i);
  }, 20000);
});
