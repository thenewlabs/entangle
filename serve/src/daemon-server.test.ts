import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { SharedWorkspace } from './shared-workspace.js';
import { LocalHostSession } from './host-session.js';
import { createDaemonServer, type DaemonServer } from './daemon-server.js';
import { FrameDecoder, writeMessage, type ClientToDaemon, type DaemonToClient } from './ipc.js';
import { findSession, socketPath } from './session-registry.js';

// Integration tests for the reusable daemon socket-server half. Like
// shared-workspace.test.ts these own a real shell PTY per workspace, poll for
// expected state instead of sleeping fixed amounts, and tear everything down in
// afterEach so no PTY/socket leaks even on a mid-test throw.

const output = new OutputHandler({ mode: parseOutputMode('text') });

let runDir: string;
const savedRunDir = process.env.ENTANGLE_RUN_DIR;

interface Harness {
  workspace: SharedWorkspace;
  session: LocalHostSession;
  server: DaemonServer;
  exitSpy: ReturnType<typeof vi.fn>;
  events: string[];
  sock: string;
}

const harnesses: Harness[] = [];
const clients: TestClient[] = [];

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entangle-dsrv-'));
  process.env.ENTANGLE_RUN_DIR = runDir;
});

afterEach(() => {
  while (clients.length) {
    try { clients.pop()!.socket.destroy(); } catch { /* already gone */ }
  }
  while (harnesses.length) {
    const h = harnesses.pop()!;
    // shutdown is idempotent and exit is stubbed, so this is safe even for
    // tests that already shut the server down.
    try { h.server.shutdown(0); } catch { /* already down */ }
    try { h.workspace.kill(); } catch { /* already dead */ }
  }
  if (savedRunDir === undefined) delete process.env.ENTANGLE_RUN_DIR;
  else process.env.ENTANGLE_RUN_DIR = savedRunDir;
  fs.rmSync(runDir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `pred` until true or `timeout` ms elapse. Returns as soon as it holds. */
async function waitFor(
  pred: () => boolean,
  { timeout = 8000, interval = 20, message = 'condition not met' }: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {}
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(interval);
  }
  if (pred()) return;
  throw new Error(`waitFor timed out after ${timeout}ms: ${message}`);
}

async function makeServer(opts?: {
  name?: string;
  registry?: { capId: string; kind: 'entangle' | 'locus'; workspaceRoot?: string };
  beforeExit?: () => Promise<void> | void;
  events?: string[];
}): Promise<Harness> {
  const name = opts?.name ?? 'test-session';
  const workspace = new SharedWorkspace(output, { cols: 80, rows: 24 });
  const session = new LocalHostSession(workspace, output);
  const exitSpy = vi.fn();
  const events: string[] = opts?.events ?? [];
  const sock = socketPath(name);
  const server = await createDaemonServer({
    name,
    socketPath: sock,
    workspace,
    session,
    output,
    registry: opts?.registry ?? { capId: 'cap-test-123', kind: 'entangle' },
    installSignalHandlers: false,
    exit: (code) => { events.push(`exit(${code})`); exitSpy(code); },
    ...(opts?.beforeExit ? { beforeExit: opts.beforeExit } : {}),
  });
  const h: Harness = { workspace, session, server, exitSpy, events, sock };
  harnesses.push(h);
  return h;
}

/** A raw IPC client: connects, decodes daemon frames, records them in order. */
interface TestClient {
  socket: net.Socket;
  messages: DaemonToClient[];
  send(msg: ClientToDaemon): void;
}

async function connectClient(sock: string): Promise<TestClient> {
  const socket = net.connect(sock);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(); });
  });
  const client: TestClient = {
    socket,
    messages: [],
    send: (msg) => { writeMessage(socket, msg); },
  };
  const decoder = new FrameDecoder();
  socket.on('data', (chunk) => {
    for (const msg of decoder.push(chunk)) client.messages.push(msg as DaemonToClient);
  });
  socket.on('error', () => { /* teardown races are fine */ });
  clients.push(client);
  return client;
}

const types = (c: TestClient): string[] => c.messages.map((m) => m.t);

describe('createDaemonServer', () => {
  it('registers the session (url empty until setUrl) with kind and workspaceRoot', async () => {
    await makeServer({
      name: 'reg-test',
      registry: { capId: 'cap-abc', kind: 'locus', workspaceRoot: '/some/workspace' },
    });
    const info = findSession('reg-test');
    expect(info).toBeDefined();
    expect(info?.capId).toBe('cap-abc');
    expect(info?.kind).toBe('locus');
    expect(info?.workspaceRoot).toBe('/some/workspace');
    expect(info?.url).toBe('');
    expect(info?.pid).toBe(process.pid);
    expect(fs.existsSync(info!.socket)).toBe(true);
  });

  it('pushes window-state and viewers before the replay to a fresh client (no url before setUrl)', async () => {
    const h = await makeServer();
    const client = await connectClient(h.sock);
    await waitFor(() => types(client).includes('replay'), { message: 'no replay frame' });
    // attachViewport itself may broadcast log/viewers frames before the initial
    // push, so assert the invariant the client UI relies on — everything it
    // needs to paint arrives no later than the replay — not an exact prefix.
    const seq = types(client);
    expect(seq.indexOf('window-state')).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf('window-state')).toBeLessThan(seq.indexOf('replay'));
    expect(seq.indexOf('viewers')).toBeLessThan(seq.indexOf('replay'));
    // No url frame yet — the relay has not assigned one.
    expect(seq).not.toContain('url');
  });

  it('setUrl broadcasts a url frame and records the url in the registry', async () => {
    const h = await makeServer({ name: 'url-test' });
    const client = await connectClient(h.sock);
    await waitFor(() => types(client).includes('replay'), { message: 'no replay frame' });

    h.server.setUrl('https://relay.test/cap/xyz#S=sec');
    await waitFor(() => types(client).includes('url'), { message: 'no url frame' });
    const urlMsg = client.messages.find((m): m is Extract<DaemonToClient, { t: 'url' }> => m.t === 'url');
    expect(urlMsg?.url).toBe('https://relay.test/cap/xyz#S=sec');
    expect(findSession('url-test')?.url).toBe('https://relay.test/cap/xyz#S=sec');

    // A client attaching after setUrl gets the url pushed with the initial
    // state (before its replay), not only on the next relay announcement.
    const late = await connectClient(h.sock);
    await waitFor(() => types(late).includes('replay'), { message: 'no replay for late client' });
    const seq = types(late);
    expect(seq.indexOf('url')).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf('url')).toBeLessThan(seq.indexOf('replay'));
  });

  it('hello resizes the whole workspace', async () => {
    const h = await makeServer();
    const resize = vi.spyOn(h.workspace, 'resize');
    const client = await connectClient(h.sock);
    await waitFor(() => types(client).includes('replay'), { message: 'no replay frame' });
    client.send({ t: 'hello', cols: 132, rows: 43 });
    await waitFor(() => resize.mock.calls.some(([c, r]) => c === 132 && r === 43), {
      message: 'hello did not resize',
    });
  });

  it('detach drops only that client; the daemon keeps serving new clients', async () => {
    const h = await makeServer();
    const first = await connectClient(h.sock);
    await waitFor(() => types(first).includes('replay'), { message: 'no replay for first' });
    first.send({ t: 'detach' });
    await waitFor(() => first.socket.destroyed || first.socket.readableEnded, {
      message: 'detach did not end the socket',
    });

    // No exit was broadcast and a second client attaches fine.
    expect(types(first)).not.toContain('exit');
    const second = await connectClient(h.sock);
    await waitFor(() => types(second).includes('replay'), { message: 'no replay for second' });
    expect(h.exitSpy).not.toHaveBeenCalled();
  });

  it('shutdown broadcasts exit, runs beforeExit before exit(0), deregisters and unlinks', async () => {
    const events: string[] = [];
    const h = await makeServer({
      name: 'down-test',
      events,
      beforeExit: async () => { await delay(20); events.push('beforeExit'); },
    });

    const client = await connectClient(h.sock);
    await waitFor(() => types(client).includes('replay'), { message: 'no replay frame' });

    h.server.shutdown(0);
    await waitFor(() => h.exitSpy.mock.calls.length > 0, { message: 'exit hook not called' });

    expect(types(client)).toContain('exit');
    expect(events).toEqual(['beforeExit', 'exit(0)']);
    expect(h.exitSpy).toHaveBeenCalledWith(0);
    expect(findSession('down-test')).toBeUndefined();
    expect(fs.existsSync(h.sock)).toBe(false);

    // Idempotent: a second shutdown neither throws nor exits again.
    h.server.shutdown(0);
    await delay(50);
    expect(h.exitSpy).toHaveBeenCalledTimes(1);
  });
});
