import { describe, it, expect, beforeAll } from 'vitest';

// The module attaches window.entangle at import time and reads the capability off `location`, so
// the stub must carry one BEFORE the dynamic import (same pattern as the session/watchdog suites).
// A throwing WebSocket keeps every connect attempt fast and deterministic: `_doConnect` rejects,
// which is exactly the "agent unreachable" path these tests care about.
(globalThis as Record<string, unknown>)['window'] = Object.assign(Object.create(null), {
  location: {
    pathname: '/cap/capA',
    hash: '#S=secretA',
    origin: 'http://test',
    protocol: 'http:',
    host: 'test',
  },
  addEventListener: () => {},
});
class DeadSocket {
  constructor() {
    throw new Error('socket unavailable');
  }
}
(globalThis as Record<string, unknown>)['WebSocket'] = DeadSocket;
((globalThis as Record<string, unknown>)['window'] as Record<string, unknown>)['WebSocket'] = DeadSocket;

const mod = await import('./window-entangle-spawn.js');
const { EntangleConnection } = mod;

type Entangle = {
  exec: (...a: unknown[]) => Promise<unknown>;
  execCommand: (line: string, o?: unknown) => Promise<unknown>;
  withCwd: (cwd: string) => {
    exec: (...a: unknown[]) => Promise<unknown>;
    execCommand: (line: string, o?: unknown) => Promise<unknown>;
  };
  password?: string;
};
const entangle = (globalThis as Record<string, unknown>)['window'] as unknown as { entangle: Entangle };

beforeAll(() => {
  expect(typeof entangle.entangle?.execCommand).toBe('function');
});

/**
 * Regression: `execCommand` and `withCwd()` used to call `entangle.exec` — the WINDOW GLOBAL —
 * rather than the connection they were built for. With a single connection that is invisible,
 * because the global IS that connection. The moment a page holds two, every one of these helpers
 * silently executes on whichever connection owns the global: the wrong machine, no error.
 *
 * The probe poisons the global with a sentinel-returning spy. If any helper routes through it, the
 * call resolves to the sentinel; a correctly-routed helper instead reaches the (dead) socket and
 * rejects. Asserting "never called" is what pins the routing.
 */
describe('exec helpers route through their own connection, not the window global', () => {
  const SENTINEL = { wrongConnection: true };

  async function withPoisonedGlobal<T>(body: () => Promise<T>): Promise<{ hits: number }> {
    const original = entangle.entangle.exec;
    let hits = 0;
    entangle.entangle.exec = async () => {
      hits += 1;
      return SENTINEL;
    };
    try {
      const result = await body().catch((e: unknown) => e);
      expect(result).not.toBe(SENTINEL);
    } finally {
      entangle.entangle.exec = original;
    }
    return { hits };
  }

  it('execCommand does not read exec off the window', async () => {
    const { hits } = await withPoisonedGlobal(() => entangle.entangle.execCommand('ls'));
    expect(hits).toBe(0);
  });

  it('withCwd().exec does not read exec off the window', async () => {
    const { hits } = await withPoisonedGlobal(() => entangle.entangle.withCwd('/tmp').exec('ls'));
    expect(hits).toBe(0);
  });

  it('withCwd().execCommand does not read exec off the window', async () => {
    const { hits } = await withPoisonedGlobal(() =>
      entangle.entangle.withCwd('/tmp').execCommand('ls')
    );
    expect(hits).toBe(0);
  });
});

interface TestConn {
  K_raw: Uint8Array | null;
  bootstrapKeys: unknown;
  keys: unknown;
  password?: string;
  setPassword(p: string | undefined): void;
  _handleDisconnected(): void;
}

describe('per-connection state', () => {
  it('keeps K_raw across a disconnect so reconnects skip Argon2', () => {
    // K_raw derives from (S, capId) only, so it is stable for the connection's lifetime and
    // `_doConnect` memoises it. That is only sound while `_handleDisconnected` leaves it alone —
    // it must clear the per-SESSION keys and nothing more. This pins that split: without it, a
    // flapping agent pays a ~64MiB main-thread hash on every backoff tick.
    const conn = new EntangleConnection('cap', 'S') as unknown as TestConn;
    conn.K_raw = new Uint8Array(32).fill(3);
    conn.bootstrapKeys = { K_auth: new Uint8Array(32) };
    conn.keys = { K_enc: new Uint8Array(32) };

    conn._handleDisconnected();

    expect(conn.K_raw).not.toBeNull();
    expect(conn.bootstrapKeys).not.toBeNull();
    expect(conn.keys).toBeNull();
  });

  it('prefers its own password over the window global', () => {
    const conn = new EntangleConnection('cap', 'S') as unknown as TestConn;
    entangle.entangle.password = 'from-window';
    conn.setPassword('from-connection');

    // getPassword is private; read it the way the suite reads other internals.
    const read = (conn as unknown as { getPassword(): string | undefined }).getPassword();
    expect(read).toBe('from-connection');

    conn.setPassword(undefined);
    expect((conn as unknown as { getPassword(): string | undefined }).getPassword()).toBe('from-window');
    delete entangle.entangle.password;
  });
});

describe('fault isolation', () => {
  it('surfaces a failed open as a stream error instead of an unhandled rejection', async () => {
    // `_openChild` is fire-and-forget in the BrowserChildProcess constructor. It awaits
    // `ensureConnected()`, which rejects whenever the handshake fails, so an unreachable agent
    // used to raise one unhandled rejection per spawn — fatal to the page under Playwright and
    // some embedders, and unavoidable once one host among several is offline.
    const conn = new EntangleConnection('cap', 'S');
    const child = conn.spawn('ls', []);

    const message = await new Promise<string>((resolve) => {
      child.on('error', (m: string) => resolve(m));
    });
    expect(message).toBeTruthy();
  });
});
