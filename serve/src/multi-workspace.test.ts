import { describe, it, expect, afterEach } from 'vitest';
import { FrameType, FrameReader } from '@thenewlabs/entangle-protocol';
import { streamAeadEncrypt, streamAeadDecrypt, frameAad, AeadDir } from '@thenewlabs/entangle-crypto';
import { BidirectionalCounters, StreamCounters, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';
import { randomBytes } from 'crypto';
import { handleMultiStreamFrame, type WorkspaceResolver } from './multi-session.js';
import { SharedWorkspace } from './shared-workspace.js';

/**
 * Multi-workspace hosting: a single capability/connection can host SEVERAL durable
 * SharedWorkspaces, selected by a KEY that rides the pty STREAM_OPEN's exec.argv[0]
 * (with the tab's cwd on exec.cwd). Each pty viewport binds to its OWN workspace,
 * and window ops route to the right workspace by the viewport's sid. With no key a
 * viewport binds to the single default workspace (back-compat).
 *
 * These drive handleMultiStreamFrame directly (as keepalive-echo.test.ts does) with
 * encrypted client->server frames and a real resolver over real SharedWorkspaces.
 */

const output = new OutputHandler({ mode: parseOutputMode('text') });

const liveWorkspaces: SharedWorkspace[] = [];
afterEach(() => {
  while (liveWorkspaces.length) {
    try { liveWorkspaces.pop()!.kill(); } catch { /* already dead */ }
  }
});

/** A resolver that lazily creates one workspace per key (undefined key => 'default'). */
function makeResolver() {
  const byKey = new Map<string, SharedWorkspace>();
  const calls: Array<{ key: string | undefined; cwd: string | undefined }> = [];
  const resolver: WorkspaceResolver = (key, cwd) => {
    calls.push({ key, cwd });
    const k = key ?? '__default__';
    let ws = byKey.get(k);
    if (!ws) {
      ws = new SharedWorkspace(output, { cols: 80, rows: 24 });
      byKey.set(k, ws);
      liveWorkspaces.push(ws);
    }
    return ws;
  };
  return { resolver, byKey, calls };
}

function makeSession(getWorkspace: WorkspaceResolver) {
  const K_enc = randomBytes(32);
  const sent: string[] = [];
  const session: any = {
    socketId: 'sock-mw',
    ws: { readyState: 1, send: (data: string) => sent.push(data) },
    cap: {},
    keys: { K_enc },
    counters: new BidirectionalCounters(),
    streamCounters: new StreamCounters(),
    authenticated: true,
    getWorkspace,
    viewerWorkspaces: new Map<string, SharedWorkspace>(),
  };
  return { session, K_enc, sent };
}

/** Encrypt + dispatch a client->server frame with an explicit counter. */
async function send(session: any, K_enc: Uint8Array, type: FrameType, msg: any, ctr: number) {
  const ct = await streamAeadEncrypt(K_enc, encode({ ctr, msg }), frameAad(type, AeadDir.ClientToServer));
  await handleMultiStreamFrame(session, { type, payload: ct });
}

/** Decode every captured outbound RELAY_RESPONSE frame to { type, msg }. */
async function drain(sent: string[], K_enc: Uint8Array): Promise<Array<{ type: FrameType; msg: any }>> {
  const out: Array<{ type: FrameType; msg: any }> = [];
  for (const raw of sent) {
    const env = JSON.parse(raw);
    const [frame] = new FrameReader().push(Buffer.from(env.frame, 'base64'));
    if (!frame) continue;
    const pt = await streamAeadDecrypt(K_enc, frame.payload, frameAad(frame.type, AeadDir.ServerToClient));
    out.push({ type: frame.type, msg: (decode(pt) as any).msg });
  }
  return out;
}

/** Open a pty viewport carrying an optional workspace key + cwd; returns the agent-assigned sid. */
async function openPty(
  session: any,
  K_enc: Uint8Array,
  sent: string[],
  provisionalSid: string,
  opts: { key?: string; cwd?: string } = {}
): Promise<string> {
  const before = sent.length;
  const exec =
    opts.key !== undefined || opts.cwd !== undefined
      ? { argv: opts.key !== undefined ? [opts.key] : [], ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) }
      : undefined;
  const msg: any = { v: 1, kind: 'open', sid: provisionalSid, mode: 'pty', pty: { cols: 80, rows: 24 }, ...(exec ? { exec } : {}) };
  await send(session, K_enc, FrameType.STREAM_OPEN, msg, 0);
  const frames = await drain(sent.slice(before), K_enc);
  const opened = frames.find((f) => f.type === FrameType.STREAM_OPEN && f.msg?.kind === 'opened');
  expect(opened, 'agent must confirm the pty open').toBeTruthy();
  return String(opened!.msg.sid);
}

describe('serve: multi-workspace hosting', () => {
  it('binds two keyed viewports to INDEPENDENT workspaces (a new-window on A does not affect B)', async () => {
    const { resolver, byKey } = makeResolver();
    const { session, K_enc, sent } = makeSession(resolver);

    const sidA = await openPty(session, K_enc, sent, 'prov-a', { key: 'tab-A', cwd: '/tmp/a' });
    const sidB = await openPty(session, K_enc, sent, 'prov-b', { key: 'tab-B', cwd: '/tmp/b' });

    const wsA = byKey.get('tab-A')!;
    const wsB = byKey.get('tab-B')!;
    expect(wsA).toBeTruthy();
    expect(wsB).toBeTruthy();
    expect(wsA).not.toBe(wsB); // distinct keys => distinct workspaces
    expect(wsA.windowState().windows.length).toBe(1);
    expect(wsB.windowState().windows.length).toBe(1);

    // WINDOW_CTL new-window targeting viewport A's sid (session-global ctr 0).
    await send(session, K_enc, FrameType.WINDOW_CTL, { v: 1, kind: 'op', op: 'new-window', sid: sidA }, 0);

    // Only workspace A grew a window; B is untouched — the op routed by sid.
    expect(wsA.windowState().windows.length).toBe(2);
    expect(wsB.windowState().windows.length).toBe(1);

    // And a second new-window on B's sid grows only B.
    await send(session, K_enc, FrameType.WINDOW_CTL, { v: 1, kind: 'op', op: 'new-window', sid: sidB }, 1);
    expect(wsA.windowState().windows.length).toBe(2);
    expect(wsB.windowState().windows.length).toBe(2);
  });

  it('carries the viewport sid on each window-state push so a client can route it', async () => {
    const { resolver } = makeResolver();
    const { session, K_enc, sent } = makeSession(resolver);

    const sidA = await openPty(session, K_enc, sent, 'prov-a', { key: 'tab-A' });
    const frames = await drain(sent, K_enc);
    const states = frames.filter((f) => f.type === FrameType.WINDOW_CTL && f.msg?.kind === 'window-state');
    expect(states.length).toBeGreaterThan(0);
    // The post-attach state is attributed to the viewport it belongs to.
    expect(states.every((s) => s.msg.sid === sidA)).toBe(true);
  });

  it('passes the workspace key AND cwd from the open message to the resolver', async () => {
    const { resolver, calls } = makeResolver();
    const { session, K_enc, sent } = makeSession(resolver);

    await openPty(session, K_enc, sent, 'prov-a', { key: 'tab-Z', cwd: '/work/z' });
    expect(calls).toContainEqual({ key: 'tab-Z', cwd: '/work/z' });
  });

  it('BACK-COMPAT: a pty open with NO key binds the single default workspace', async () => {
    const { resolver, byKey, calls } = makeResolver();
    const { session, K_enc, sent } = makeSession(resolver);

    // No exec at all (identical to the pre-multi-workspace wire).
    const sid = await openPty(session, K_enc, sent, 'prov-def');
    expect(sid).toBeTruthy();
    expect(calls).toContainEqual({ key: undefined, cwd: undefined });
    expect(byKey.get('__default__')).toBeTruthy();

    // A second no-key viewport shares the SAME default workspace.
    await openPty(session, K_enc, sent, 'prov-def2');
    expect(byKey.size).toBe(1);
  });

  it('BACK-COMPAT: a window op with NO sid falls back to the only viewport', async () => {
    const { resolver, byKey } = makeResolver();
    const { session, K_enc, sent } = makeSession(resolver);

    await openPty(session, K_enc, sent, 'prov-def'); // one default viewport
    const ws = byKey.get('__default__')!;
    expect(ws.windowState().windows.length).toBe(1);

    // Legacy op: no sid on the WINDOW_CTL op → server applies it to the sole viewport.
    await send(session, K_enc, FrameType.WINDOW_CTL, { v: 1, kind: 'op', op: 'new-window' }, 0);
    expect(ws.windowState().windows.length).toBe(2);
  });
});
