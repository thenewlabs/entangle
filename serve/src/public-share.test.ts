import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { OutputHandler } from '@thenewlabs/entangle-utils';
import { WebSocketServer } from 'ws';
import { PublicShareController } from './public-share.js';

/** A ws stub that records every JSON frame the controller sends. */
function fakeWs() {
  const sent: any[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
  } as any;
  return { ws, sent };
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('PublicShareController', () => {
  let server: http.Server;
  let port: number;
  const output = new OutputHandler({ mode: 'silent' as any });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/echo-host') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`host=${req.headers.host} xfh=${req.headers['x-forwarded-host'] ?? ''}`);
        return;
      }
      res.writeHead(201, { 'content-type': 'text/plain', 'x-test': 'yes' });
      res.end('hello ' + req.url);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('announces a subdomain and resolves on SHARE_ASSIGNED', async () => {
    const { ws, sent } = fakeWs();
    const c = new PublicShareController(() => ws, output);
    const p = c.announce('demo', { host: '127.0.0.1', port });
    const announced = sent.find((m) => m.type === 'ANNOUNCE_SHARE');
    expect(announced).toMatchObject({ subdomain: 'demo' });
    c.handleMessage({ type: 'SHARE_ASSIGNED', shareId: announced.shareId, subdomain: 'demo', url: 'https://demo.x' });
    await expect(p).resolves.toMatchObject({ ok: true, url: 'https://demo.x' });
    expect(c.list()).toHaveLength(1);
  });

  it('proxies a request to the local target and streams the response back', async () => {
    const { ws, sent } = fakeWs();
    const c = new PublicShareController(() => ws, output);
    const p = c.announce('demo', { host: '127.0.0.1', port });
    const shareId = sent.find((m) => m.type === 'ANNOUNCE_SHARE').shareId;
    c.handleMessage({ type: 'SHARE_ASSIGNED', shareId, subdomain: 'demo', url: 'https://demo.x' });
    await p;

    c.handleMessage({
      type: 'SHARE_REQUEST',
      reqId: 'r1',
      shareId,
      method: 'GET',
      url: '/thing',
      headers: { host: 'demo.share.test' },
    });
    c.handleMessage({ type: 'SHARE_REQ_END', reqId: 'r1' });

    await waitFor(() => sent.find((m) => m.type === 'SHARE_RES_END' && m.reqId === 'r1'));
    const resp = sent.find((m) => m.type === 'SHARE_RESPONSE' && m.reqId === 'r1');
    expect(resp.status).toBe(201);
    const body = sent
      .filter((m) => m.type === 'SHARE_RES_BODY' && m.reqId === 'r1')
      .map((m) => Buffer.from(m.chunk, 'base64').toString())
      .join('');
    expect(body).toBe('hello /thing');
  });

  it('rewrites Host to the target and preserves the public host as X-Forwarded-Host', async () => {
    const { ws, sent } = fakeWs();
    const c = new PublicShareController(() => ws, output);
    const p = c.announce('demo', { host: '127.0.0.1', port });
    const shareId = sent.find((m) => m.type === 'ANNOUNCE_SHARE').shareId;
    c.handleMessage({ type: 'SHARE_ASSIGNED', shareId, subdomain: 'demo', url: 'https://demo.x' });
    await p;

    c.handleMessage({
      type: 'SHARE_REQUEST',
      reqId: 'r2',
      shareId,
      method: 'GET',
      url: '/echo-host',
      headers: { host: 'demo.share.test' },
    });
    c.handleMessage({ type: 'SHARE_REQ_END', reqId: 'r2' });

    await waitFor(() => sent.find((m) => m.type === 'SHARE_RES_END' && m.reqId === 'r2'));
    const body = sent
      .filter((m) => m.type === 'SHARE_RES_BODY' && m.reqId === 'r2')
      .map((m) => Buffer.from(m.chunk, 'base64').toString())
      .join('');
    expect(body).toBe(`host=127.0.0.1:${port} xfh=demo.share.test`);
  });

  it('errors a request whose share is unknown', () => {
    const { ws, sent } = fakeWs();
    const c = new PublicShareController(() => ws, output);
    c.handleMessage({ type: 'SHARE_REQUEST', reqId: 'r3', shareId: 'nope', method: 'GET', url: '/', headers: {} });
    expect(sent.find((m) => m.type === 'SHARE_ERROR' && m.reqId === 'r3')).toBeTruthy();
  });

  it('resolves availability checks from SHARE_CHECK_RESULT', async () => {
    const { ws, sent } = fakeWs();
    const c = new PublicShareController(() => ws, output);
    const p = c.checkAvailability('demo');
    const check = sent.find((m) => m.type === 'CHECK_SHARE');
    expect(check).toMatchObject({ subdomain: 'demo' });
    c.handleMessage({ type: 'SHARE_CHECK_RESULT', reqId: check.reqId, subdomain: 'demo', available: false, reason: 'taken' });
    await expect(p).resolves.toEqual({ available: false, reason: 'taken' });
  });

  it('tunnels a WebSocket to the local target and relays frames both ways', async () => {
    // A local "dev server" WebSocket that echoes every message (like a vite HMR endpoint).
    const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    echo.on('connection', (ws) => ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary })));
    await new Promise<void>((r) => echo.once('listening', r));
    const echoPort = (echo.address() as AddressInfo).port;

    try {
      const { ws, sent } = fakeWs();
      const c = new PublicShareController(() => ws, output);
      const p = c.announce('mac', { host: '127.0.0.1', port: echoPort });
      const shareId = sent.find((m) => m.type === 'ANNOUNCE_SHARE').shareId;
      c.handleMessage({ type: 'SHARE_ASSIGNED', shareId, subdomain: 'mac', url: 'https://mac.x' });
      await p;

      // Relay asks the agent to open a tunnelled WS (with a query + a subprotocol, like vite).
      c.handleMessage({ type: 'SHARE_WS_OPEN', wsId: 'w1', shareId, url: '/?token=abc', headers: {}, protocol: 'vite-hmr' });
      // The agent dialled the local server and confirms.
      await waitFor(() => (sent.some((m) => m.type === 'SHARE_WS_OPENED' && m.wsId === 'w1') ? true : undefined));

      // Client → local: a frame arriving as SHARE_WS_DATA is written to the local socket…
      c.handleMessage({ type: 'SHARE_WS_DATA', wsId: 'w1', chunk: Buffer.from('ping').toString('base64'), binary: false });
      // …the echo comes back out as SHARE_WS_DATA the relay would forward to the public client.
      const echoed = await waitFor(() => sent.find((m) => m.type === 'SHARE_WS_DATA' && m.wsId === 'w1'));
      expect(Buffer.from(echoed.chunk, 'base64').toString()).toBe('ping');

      // Closing from the relay side tears the local socket down.
      c.handleMessage({ type: 'SHARE_WS_CLOSE', wsId: 'w1', code: 1000 });
    } finally {
      await new Promise<void>((r) => echo.close(() => r()));
    }
  });

  it('closes the tunnelled WS when the local target is unreachable', async () => {
    const { ws, sent } = fakeWs();
    const c = new PublicShareController(() => ws, output);
    const p = c.announce('down', { host: '127.0.0.1', port: 1 }); // port 1: nothing listening
    const shareId = sent.find((m) => m.type === 'ANNOUNCE_SHARE').shareId;
    c.handleMessage({ type: 'SHARE_ASSIGNED', shareId, subdomain: 'down', url: 'x' });
    await p;
    c.handleMessage({ type: 'SHARE_WS_OPEN', wsId: 'w9', shareId, url: '/', headers: {} });
    const closed = await waitFor(() => sent.find((m) => m.type === 'SHARE_WS_CLOSE' && m.wsId === 'w9'));
    expect(closed.code).toBe(1011);
  });
});
