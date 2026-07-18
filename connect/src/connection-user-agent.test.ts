import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { InvokeConnection } from './connection.js';

/**
 * Companion to serve's /agent/register regression test. The browser client reaching the same
 * `/relay/<capId>` route arrives with a real browser UA, which is why the incident report only
 * flagged /agent/register — but the CLI invoker uses Node's `ws`, which sends no `User-Agent`
 * at all. Left unfixed it would reproduce the ban from a different code path.
 */
describe('invoker connection outbound User-Agent', () => {
  let wss: WebSocketServer | undefined;

  afterEach(() => {
    wss?.close();
    wss = undefined;
  });

  it('sends an entangle-connect User-Agent on the relay upgrade request', async () => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const { port } = wss.address() as AddressInfo;

    const upgrade = new Promise<string | undefined>((resolve) => {
      wss!.once('connection', (ws, req) => {
        resolve(req.headers['user-agent']);
        ws.close();
      });
    });

    // A syntactically valid capId: 16B cap salt + 16B randomness, base64url.
    const capId = randomBytes(32).toString('base64url');
    const conn = new InvokeConnection(capId, randomBytes(32).toString('base64url'));

    // connect() only settles once the handshake completes; the upgrade request — all this test
    // cares about — has already been sent by then, so race it and ignore the handshake.
    const userAgent = await Promise.race([
      upgrade,
      conn.connect(`ws://127.0.0.1:${port}/relay/${capId}`).then(() => undefined),
    ]);

    expect(userAgent).toBeDefined();
    expect(userAgent).not.toBe('');
    expect(userAgent).toMatch(/^entangle-connect\/\S+ \(\+https:\/\/github\.com\/thenewlabs\/entangle\)$/);
  }, 20000);
});
