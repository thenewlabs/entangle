import { describe, it, expect, beforeAll } from 'vitest';

// The module attaches window.entangle at import time and reads the capability off `location`, so
// the stub must carry one BEFORE the dynamic import (same pattern as the session/watchdog suites).
// A throwing WebSocket keeps every connect attempt fast and deterministic: `_doConnect` rejects,
// which is exactly the "agent unreachable" path these tests care about.
// capIds must be real: the first 16 bytes ARE the Argon2 salt, so `extractSaltFromCapId` rejects
// anything that isn't 32 bytes of base64url and the connection never reaches the socket.
const CAP_A = 'A'.repeat(43);
const CAP_B = 'B'.repeat(43);
const CAP_C = 'C'.repeat(43);
const CAP_OTHER = 'D'.repeat(43);

(globalThis as Record<string, unknown>)['window'] = Object.assign(Object.create(null), {
  location: {
    pathname: `/cap/${CAP_A}`,
    hash: '#S=secretA',
    origin: 'http://test',
    protocol: 'http:',
    host: 'test',
  },
  addEventListener: () => {},
});
/**
 * Records the relay URL each dial attempt targets, then fails. The URL carries the capId, so
 * `dialled` is a direct answer to "which connection did that call actually reach?" — a stronger
 * proof of routing than asserting a spy went untouched.
 */
const dialled: string[] = [];
class DeadSocket {
  constructor(url: string) {
    dialled.push(url);
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
  password?: string | undefined;
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

  it('keeps its password to itself', () => {
    // Each agent may carry its own second factor, so the password is per-connection and a value
    // on the window must never bleed into an unrelated one. `window.entangle.password` is an
    // accessor onto the DEFAULT client: writing it targets that client only.
    const conn = new EntangleConnection('cap', 'S') as unknown as TestConn;
    entangle.entangle.password = 'default-client-pw';

    expect((conn as unknown as { getPassword(): string | undefined }).getPassword()).toBeUndefined();

    conn.setPassword('own-pw');
    expect((conn as unknown as { getPassword(): string | undefined }).getPassword()).toBe('own-pw');
    expect(entangle.entangle.password).toBe('default-client-pw');

    // Assign, never `delete` — deleting would drop the accessor real embedders rely on.
    entangle.entangle.password = undefined;
  });
});

type Registry = {
  connect(capId: string, S: string): any;
  getClient(capId: string): any;
  clients(): any[];
  disconnectClient(capId: string): void;
  onClientsChanged(cb: (ids: string[]) => void): () => void;
  onAnyStatus(cb: (capId: string, s: string) => void): () => void;
  setCapability(capId: string, S: string): boolean;
  capId?: string;
  features?: string[];
};
const registry = entangle.entangle as unknown as Registry;

describe('multi-capability registry', () => {
  it('exposes the URL capability as the default client', () => {
    expect(registry.capId).toBe(CAP_A);
    expect(registry.getClient(CAP_A)).toBeDefined();
  });

  it('re-exports the default client methods as the flat surface', () => {
    // Every pre-multi-connect consumer calls window.entangle.openPipe(...) directly. Those must
    // remain the DEFAULT client's methods, not stubs and not another capability's.
    const def = registry.getClient(CAP_A);
    for (const key of ['spawn', 'exec', 'openPipe', 'openTerminal', 'onStatus', 'disconnect']) {
      expect((entangle.entangle as any)[key]).toBe(def[key]);
    }
  });

  it('is idempotent by capId', () => {
    const first = registry.connect(CAP_B, 'secretB');
    const second = registry.connect(CAP_B, 'secretB');
    expect(second).toBe(first);
    // A re-pasted URL may carry a stale secret; returning the live client beats tearing down its
    // streams, since a wrong secret could not authenticate against this capId anyway.
    expect(registry.connect(CAP_B, 'a-different-secret')).toBe(first);
  });

  it('connect() on the URL capability returns the default client, not a second connection', () => {
    expect(registry.connect(CAP_A, 'secretA')).toBe(registry.getClient(CAP_A));
  });

  it('keeps clients distinct per capability', () => {
    const a = registry.getClient(CAP_A);
    const b = registry.connect(CAP_B, 'secretB');
    expect(a).not.toBe(b);
    expect(a.capId).toBe(CAP_A);
    expect(b.capId).toBe(CAP_B);
  });

  it('isolates passwords per client', () => {
    const a = registry.getClient(CAP_A);
    const b = registry.connect(CAP_B, 'secretB');
    a.password = 'pw-a';
    b.password = 'pw-b';
    expect(a.password).toBe('pw-a');
    expect(b.password).toBe('pw-b');
    // The flat surface proxies the DEFAULT client's password.
    expect((entangle.entangle as any).password).toBe('pw-a');
    a.password = undefined;
    b.password = undefined;
  });

  it('stamps status events with their capId', () => {
    const seen: string[] = [];
    const off = registry.onAnyStatus((capId) => seen.push(capId));
    expect(seen).toContain(CAP_A);
    off();
  });

  it('forgets a disconnected non-default client but keeps the default', () => {
    registry.connect(CAP_C, 'secretC');
    expect(registry.getClient(CAP_C)).toBeDefined();
    registry.disconnectClient(CAP_C);
    expect(registry.getClient(CAP_C)).toBeUndefined();

    registry.disconnectClient(CAP_A);
    // Closing the default must not delete it — the flat surface still points at its methods.
    expect(registry.getClient(CAP_A)).toBeDefined();
  });
});

describe('setCapability', () => {
  it('accepts the capability it already has', () => {
    expect(registry.setCapability(CAP_A, 'secretA')).toBe(true);
  });

  it('refuses to re-point the default to a different capability', () => {
    // Live pipes and terminals are bound to the default client; silently swapping the capability
    // underneath them would strand every one. Multi-host callers use connect() instead.
    expect(registry.setCapability(CAP_OTHER, 'secretOther')).toBe(false);
    expect(registry.capId).toBe(CAP_A);
    expect(registry.getClient(CAP_OTHER)).toBeUndefined();
  });

  it('rejects malformed input', () => {
    expect(registry.setCapability('', 'S')).toBe(false);
    expect(registry.setCapability('cap', '')).toBe(false);
  });
});

describe('a second client executes on its OWN connection', () => {
  it('dials the capability it belongs to', async () => {
    // The routing bug this guards is silent: helpers that read `exec` off the window global would
    // run host B's command against host A's machine with no error anywhere. The dial log makes
    // the destination explicit.
    const b = registry.connect(CAP_B, 'secretB');
    dialled.length = 0;

    await b.execCommand('ls').catch(() => {});

    expect(dialled.length).toBeGreaterThan(0);
    expect(dialled.every((u) => u.includes(`/relay/${CAP_B}`))).toBe(true);
    expect(dialled.some((u) => u.includes(`/relay/${CAP_A}`))).toBe(false);
  });

  it('routes withCwd helpers to its own connection too', async () => {
    const b = registry.connect(CAP_B, 'secretB');
    dialled.length = 0;

    await b.withCwd('/tmp').execCommand('ls').catch(() => {});

    expect(dialled.length).toBeGreaterThan(0);
    expect(dialled.every((u) => u.includes(`/relay/${CAP_B}`))).toBe(true);
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
