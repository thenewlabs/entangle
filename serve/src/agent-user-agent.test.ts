import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgent } from './agent.js';

/**
 * Regression test for the CrowdSec ban: `entangle-serve` registered at `/agent/register` over a
 * Node `ws` client, which sends NO `User-Agent` unless one is passed explicitly. Every
 * registration — and the reconnect loop retries it — logged upstream as user-agent "-", which
 * reads as UA-less bot polling and got the source IP banned.
 *
 * This drives the real registration path against a real WebSocket server and asserts the header
 * arrives on the upgrade request. No network: 127.0.0.1 on an ephemeral port.
 */
describe('/agent/register outbound User-Agent', () => {
  let wss: WebSocketServer | undefined;

  afterEach(() => {
    wss?.close();
    wss = undefined;
  });

  it('sends an entangle-serve User-Agent on the registration upgrade request', async () => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const { port } = wss.address() as AddressInfo;

    const upgrade = new Promise<{ url: string; userAgent: string | undefined }>((resolve) => {
      wss!.once('connection', (_ws, req) => {
        resolve({ url: req.url ?? '', userAgent: req.headers['user-agent'] });
      });
    });

    await startAgent({ serverUrl: `http://127.0.0.1:${port}`, outputMode: 'json' });
    const { url, userAgent } = await upgrade;

    expect(url).toBe('/agent/register');
    // The bug: this was undefined, and the relay logged "-".
    expect(userAgent).toBeDefined();
    expect(userAgent).not.toBe('');
    expect(userAgent).toMatch(/^entangle-serve\/\S+ \(\+https:\/\/github\.com\/thenewlabs\/entangle\)$/);
  }, 15000);
});
