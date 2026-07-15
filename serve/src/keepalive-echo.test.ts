import { describe, it, expect } from 'vitest';
import { FrameType, FrameReader } from '@thenewlabs/entangle-protocol';
import { streamAeadEncrypt, streamAeadDecrypt, frameAad, AeadDir } from '@thenewlabs/entangle-crypto';
import { BidirectionalCounters, StreamCounters } from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';
import { randomBytes } from 'crypto';
import { handleMultiStreamFrame } from './multi-session.js';

/**
 * Regression: KEEPALIVE is not a STREAM_* frame, so it used to fall through session.ts's local
 * switch (`case KEEPALIVE: break` — a silent no-op) and was NEVER echoed. The client's liveness
 * watchdog then saw no reply and force-closed every otherwise-idle connection ~45s later — a
 * reconnect storm on any preview/workbench left sitting (and, on the old bootstrap, a frame reload
 * that reset the preview to its base URL). KEEPALIVE now routes to the multi-session handler, which
 * echoes it. This test drives that handler directly with an encrypted keepalive and asserts the
 * echo comes back.
 */
describe('serve: KEEPALIVE echo', () => {
  it('echoes an encrypted KEEPALIVE back to the client', async () => {
    const K_enc = randomBytes(32);
    const sent: string[] = [];
    const session: any = {
      socketId: 'sock-1',
      ws: { readyState: 1, send: (data: string) => sent.push(data) },
      cap: {},
      keys: { K_enc },
      counters: new BidirectionalCounters(),
      streamCounters: new StreamCounters(),
      authenticated: true,
    };

    // Encrypt a client->server KEEPALIVE (first session-global frame → ctr 0).
    const msg = { ctr: 0, msg: { v: 1 as const, kind: 'keepalive' as const } };
    const ct = await streamAeadEncrypt(
      K_enc,
      encode(msg),
      frameAad(FrameType.KEEPALIVE, AeadDir.ClientToServer),
    );

    await handleMultiStreamFrame(session, { type: FrameType.KEEPALIVE, payload: ct });

    // Exactly one echo, wrapped in the RELAY_RESPONSE envelope the relay forwards to the invoker.
    expect(sent).toHaveLength(1);
    const envelope = JSON.parse(sent[0]!);
    expect(envelope.type).toBe('RELAY_RESPONSE');
    expect(envelope.socketId).toBe('sock-1');

    const frameBuf = Buffer.from(envelope.frame, 'base64');
    const [frame] = new FrameReader().push(frameBuf);
    expect(frame!.type).toBe(FrameType.KEEPALIVE);

    const plaintext = await streamAeadDecrypt(
      K_enc,
      frame!.payload,
      frameAad(FrameType.KEEPALIVE, AeadDir.ServerToClient),
    );
    const echoed = decode(plaintext) as { msg: { kind: string } };
    expect(echoed.msg.kind).toBe('keepalive');
  });
});
