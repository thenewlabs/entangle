import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { StreamManager } from './stream-manager.js';
import { OutputHandler, parseOutputMode, type PipeEndpoint } from '@thenewlabs/entangle-utils';

interface Collected {
  data: string[];
  exit: (number | null)[];
  error: string[];
}

function makeManager(c: Collected, pipeEndpoints: Map<string, PipeEndpoint>, maxStreams = 4): StreamManager {
  return new StreamManager({
    policy: { singleRun: false, maxStreams } as any,
    output: new OutputHandler({ mode: parseOutputMode('text') }),
    pipeEndpoints,
    onStreamData: (_sid, data) => c.data.push(Buffer.from(data).toString()),
    onStreamExit: (_sid, code) => c.exit.push(code),
    onStreamError: (_sid, err) => c.error.push(err),
  });
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

describe('StreamManager pipe (unix socket)', () => {
  it('bridges bytes both directions and maps socket close to exit', async () => {
    const sockPath = join(tmpdir(), `entangle-pipe-${randomBytes(6).toString('hex')}.sock`);
    const received: Buffer[] = [];
    let serverConn: net.Socket | undefined;

    // Echo-ish server: greet on connect, then echo whatever it receives.
    const server = net.createServer((conn) => {
      serverConn = conn;
      conn.write('server-hello');
      conn.on('data', (chunk) => {
        received.push(chunk);
        conn.write(Buffer.concat([Buffer.from('echo:'), chunk]));
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const c: Collected = { data: [], exit: [], error: [] };
      const sm = makeManager(c, new Map([['glass', { kind: 'unix', path: sockPath }]]));

      const sid = await sm.openPipeStream({ name: 'glass' });
      expect(typeof sid).toBe('string');

      // Server greeting should arrive as stdout data.
      await waitFor(() => c.data.join('').includes('server-hello'));

      // Bytes written via writeToStream must reach the server and echo back.
      sm.writeToStream(sid, new Uint8Array(Buffer.from('ping')));
      await waitFor(() => received.map((b) => b.toString()).join('').includes('ping'));
      await waitFor(() => c.data.join('').includes('echo:ping'));

      // Server-side close of the connection maps to onStreamExit(code 0).
      serverConn?.end();
      await waitFor(() => c.exit.length > 0);
      expect(c.exit[0]).toBe(0);
      expect(c.error).toHaveLength(0);
    } finally {
      try { server.close(); } catch {}
    }
  });

  it('closeStream destroys the socket', async () => {
    const sockPath = join(tmpdir(), `entangle-pipe-${randomBytes(6).toString('hex')}.sock`);
    let serverConnClosed = false;
    const server = net.createServer((conn) => {
      conn.on('close', () => { serverConnClosed = true; });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const c: Collected = { data: [], exit: [], error: [] };
      const sm = makeManager(c, new Map([['glass', { kind: 'unix', path: sockPath }]]));
      const sid = await sm.openPipeStream({ name: 'glass' });
      await waitFor(() => sm.getStream(sid) !== undefined);

      sm.closeStream(sid, 'test close');
      await waitFor(() => serverConnClosed);
      expect(serverConnClosed).toBe(true);
    } finally {
      try { server.close(); } catch {}
    }
  });
});

describe('StreamManager pipe (tcp)', () => {
  it('bridges over a TCP endpoint', async () => {
    const server = net.createServer((conn) => {
      conn.on('data', (chunk) => conn.write(Buffer.concat([Buffer.from('tcp:'), chunk])));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const c: Collected = { data: [], exit: [], error: [] };
      const sm = makeManager(c, new Map([['preview', { kind: 'tcp', host: '127.0.0.1', port }]]));
      const sid = await sm.openPipeStream({ name: 'preview' });
      sm.writeToStream(sid, new Uint8Array(Buffer.from('hi')));
      await waitFor(() => c.data.join('').includes('tcp:hi'));
    } finally {
      try { server.close(); } catch {}
    }
  });
});

describe('StreamManager pipe concurrency (maxStreams)', () => {
  it('rejects a second concurrent pipe when maxStreams is 1', async () => {
    const sockPath = join(tmpdir(), `entangle-pipe-${randomBytes(6).toString('hex')}.sock`);
    const server = net.createServer((conn) => { conn.write('hi'); });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const c: Collected = { data: [], exit: [], error: [] };
      // maxStreams: 1 is entangle's backward-compatible default — the blocker Locus hit.
      const sm = makeManager(c, new Map([['glass', { kind: 'unix', path: sockPath }]]), 1);
      const sid1 = await sm.openPipeStream({ name: 'glass' });
      expect(typeof sid1).toBe('string');
      await expect(sm.openPipeStream({ name: 'glass' })).rejects.toThrow(/Maximum streams \(1\) reached/);
    } finally {
      try { server.close(); } catch {}
    }
  });

  it('opens glass + preview + a terminal-style pipe concurrently when maxStreams is raised', async () => {
    // Mirrors Locus's real fan-out over ONE capability: a glass protocol channel,
    // a preview tunnel, and a terminal PTY pipe — all live at once.
    const mkServer = async (): Promise<string> => {
      const p = join(tmpdir(), `entangle-pipe-${randomBytes(6).toString('hex')}.sock`);
      const s = net.createServer((conn) => { conn.write('ready'); });
      await new Promise<void>((resolve) => s.listen(p, resolve));
      servers.push(s);
      return p;
    };
    const servers: net.Server[] = [];
    try {
      const glass = await mkServer();
      const preview = await mkServer();
      const term = await mkServer();
      const c: Collected = { data: [], exit: [], error: [] };
      // 32 = LOCUS_MAX_STREAMS; here any value >= 3 proves the fix.
      const sm = makeManager(c, new Map<string, PipeEndpoint>([
        ['glass', { kind: 'unix', path: glass }],
        ['preview', { kind: 'unix', path: preview }],
        ['terminal', { kind: 'unix', path: term }],
      ]), 32);

      const sids = await Promise.all([
        sm.openPipeStream({ name: 'glass' }),
        sm.openPipeStream({ name: 'preview' }),
        sm.openPipeStream({ name: 'terminal' }),
      ]);

      expect(new Set(sids).size).toBe(3); // three distinct live streams
      expect(c.error).toHaveLength(0);    // none rejected with "Maximum streams"
      await waitFor(() => c.data.filter((d) => d.includes('ready')).length >= 3);
    } finally {
      for (const s of servers) { try { s.close(); } catch {} }
    }
  });
});

describe('StreamManager pipe allow-list', () => {
  it('throws Unknown pipe for an unregistered name', async () => {
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c, new Map());
    await expect(sm.openPipeStream({ name: 'nope' })).rejects.toThrow(/Unknown pipe: nope/);
  });

  it('reports a connection error via onStreamError for a dead endpoint', async () => {
    const sockPath = join(tmpdir(), `entangle-pipe-dead-${randomBytes(6).toString('hex')}.sock`);
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c, new Map([['glass', { kind: 'unix', path: sockPath }]]));

    // No server is listening on sockPath, so connect fails asynchronously.
    await sm.openPipeStream({ name: 'glass' });
    await waitFor(() => c.error.length > 0);
    expect(c.error[0]).toBeTruthy();
    expect(c.exit).toHaveLength(0);
  });
});
