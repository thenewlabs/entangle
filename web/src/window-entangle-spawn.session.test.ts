import { describe, it, expect, beforeEach } from 'vitest';
import { FrameType, FrameReader } from '@thenewlabs/entangle-protocol';
import { frameAad, AeadDir, streamAeadDecrypt } from '@thenewlabs/entangle-crypto';
import { decode } from 'cborg';

// The module attaches window.entangle at import time — stub window BEFORE the dynamic import
// (same pattern as window-entangle-spawn.watchdog.test.ts).
(globalThis as Record<string, unknown>)['window'] = Object.assign(Object.create(null), {
  location: { pathname: '/', hash: '', origin: 'http://test', protocol: 'http:', host: 'test' },
  addEventListener: () => {},
});

const { EntangleConnection } = await import('./window-entangle-spawn.js');

const K_ENC = new Uint8Array(32).fill(7);

interface TestConn {
  ws: { readyState: number; send: (f: Uint8Array) => void; close?: () => void } | null;
  keys: { K_enc: Uint8Array } | null;
  authenticated: boolean;
  passwordVerified: boolean;
  children: Map<string, { _onError: (m: string) => void }>;
  sendChain: Promise<void>;
  _sendData(sid: string, chunk: Uint8Array): void;
  _sendKeepalive(): void;
  _handleDisconnected(): void;
}

/** Decrypt one captured `[type][len][payload]` frame and return its `{ ctr, msg }` body. */
async function decryptFrame(frame: Uint8Array): Promise<{ type: number; ctr: number }> {
  const reader = new FrameReader();
  const [parsed] = reader.push(frame);
  const aad = frameAad(parsed!.type, AeadDir.ClientToServer);
  const plaintext = await streamAeadDecrypt(K_ENC, parsed!.payload, aad);
  const { ctr } = decode(plaintext) as { ctr: number };
  return { type: parsed!.type, ctr };
}

function liveConn(sent: Uint8Array[]): TestConn {
  const conn = new EntangleConnection('cap', 'S') as unknown as TestConn;
  conn.ws = { readyState: 1 /* OPEN */, send: (f: Uint8Array) => sent.push(f.slice()) };
  conn.keys = { K_enc: K_ENC };
  conn.authenticated = true;
  return conn;
}

describe('EntangleConnection send ordering', () => {
  let sent: Uint8Array[];
  let conn: TestConn;

  beforeEach(() => {
    sent = [];
    conn = liveConn(sent);
    conn.children.set('sid1', { _onError: () => {} } as never);
  });

  it('wire order always equals counter order, even with wildly different payload sizes', async () => {
    // Regression: encrypt is async and does not resolve in call order; taking the counter
    // synchronously but sending after the await let a small frame overtake a large one —
    // the agent then terminated the session ("counter mismatch: expected=N, received=N+1").
    const sizes = [200_000, 10, 150_000, 1, 80_000, 3, 120_000, 2];
    for (const size of sizes) conn._sendData('sid1', new Uint8Array(size));
    await conn.sendChain;

    expect(sent).toHaveLength(sizes.length);
    const ctrs: number[] = [];
    for (const f of sent) ctrs.push((await decryptFrame(f)).ctr);
    const sorted = [...ctrs].sort((a, b) => a - b);
    expect(ctrs).toEqual(sorted); // strictly the order they hit the wire
    expect(new Set(ctrs).size).toBe(ctrs.length); // no skips consumed by dropped sends
  });

  it('splits an oversized write into <=256KB frames (a >1MB frame is silently DROPPED by the receiver)', async () => {
    // Regression: vscode wrote a multi-MB message through the tunnel as ONE frame; the agent's
    // FrameReader discarded it (> MAX_FRAME_BYTES) and the counter gap killed the session.
    const big = new Uint8Array(1_500_000).fill(9);
    conn._sendData('sid1', big);
    await conn.sendChain;

    expect(sent.length).toBe(Math.ceil(big.length / (256 * 1024)));
    let total = 0;
    let lastCtr = -1;
    for (const f of sent) {
      expect(f.length).toBeLessThan(1_048_576); // every wire frame under MAX_FRAME_BYTES
      const reader = new FrameReader();
      const [parsed] = reader.push(f);
      const aad = frameAad(parsed!.type, AeadDir.ClientToServer);
      const plaintext = await streamAeadDecrypt(K_ENC, parsed!.payload, aad);
      const { ctr, msg } = decode(plaintext) as { ctr: number; msg: { chunk: Uint8Array } };
      expect(ctr).toBeGreaterThan(lastCtr); // contiguous ascending counters
      lastCtr = ctr;
      total += msg.chunk.length;
    }
    expect(total).toBe(big.length); // byte-exact reassembly
  });

  it('a send for an unknown stream consumes no counter and sends nothing', async () => {
    conn._sendData('ghost-sid', new Uint8Array(4));
    conn._sendData('sid1', new Uint8Array(4));
    await conn.sendChain;
    expect(sent).toHaveLength(1);
    expect((await decryptFrame(sent[0]!)).type).toBe(FrameType.STREAM_DATA);
  });
});

describe('EntangleConnection disconnect invalidation', () => {
  it('clears session keys, auth, counters, and streams so nothing stale reaches a new session', async () => {
    const sent: Uint8Array[] = [];
    const conn = liveConn(sent);
    const errors: string[] = [];
    conn.children.set('sid1', { _onError: (m: string) => errors.push(m) } as never);
    conn.passwordVerified = true;

    conn._handleDisconnected();

    expect(conn.keys).toBeNull();
    expect(conn.authenticated).toBe(false);
    expect(conn.passwordVerified).toBe(false); // the new session must re-verify
    expect(conn.children.size).toBe(0);
    expect(errors).toEqual(['disconnect']);

    // Stale writers (a consumer still holding the old pipe) become no-ops...
    conn._sendData('sid1', new Uint8Array(8));
    // ...and so do keepalives queued against the dead session.
    conn._sendKeepalive();
    await conn.sendChain;
    expect(sent).toHaveLength(0);
  });

  it('a send queued BEFORE the disconnect no-ops after it (gates run inside the queued task)', async () => {
    const sent: Uint8Array[] = [];
    const conn = liveConn(sent);
    conn.children.set('sid1', { _onError: () => {} } as never);

    conn._sendData('sid1', new Uint8Array(4)); // queued against the live session
    conn._handleDisconnected(); // drops before the task's encrypt+send completes? No —
    // the task runs after this synchronous frame, and must observe the dead session.
    await conn.sendChain;
    expect(sent).toHaveLength(0);
  });
});
