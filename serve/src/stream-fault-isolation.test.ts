import { describe, it, expect, beforeEach } from 'vitest';
import { FrameType, FrameReader } from '@thenewlabs/entangle-protocol';
import { streamAeadEncrypt, streamAeadDecrypt, frameAad, AeadDir } from '@thenewlabs/entangle-crypto';
import { BidirectionalCounters, StreamCounters } from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';
import { randomBytes } from 'crypto';
import { handleMultiStreamFrame } from './multi-session.js';

/**
 * Regression: a browser render crash cut the Locus `glass` pipe mid-flight. The
 * agent read the truncated stream as "Stream counter mismatch: expected=0,
 * received=26" and terminated the ENTIRE invoker session — terminal, files, git
 * and chat all died because one pipe was cut, and the reconnecting client looped
 * on the same crash forever.
 *
 * Two distinct faults produced that, and both are covered here:
 *
 *  1. `expected=0` was its own bug. Teardown called removeStream(), which
 *     FORGETS a sid, so a frame still in flight on a just-closed stream
 *     recreated the counter at 0 and read as the first frame of a new stream
 *     bearing an impossible counter. Retirement fixes that.
 *  2. Any per-stream counter fault was fatal to the whole connection. Frames are
 *     independently AEAD-sealed with a random per-frame nonce and no chaining,
 *     and the sid is sealed INSIDE the plaintext, so a fault on one stream says
 *     nothing about another's integrity. It now closes just that stream.
 *
 * What deliberately stays fatal is asserted at the bottom: AEAD failure and a
 * session-global counter fault are not attributable to a stream, so there is
 * nothing to isolate them to.
 */

const CHUNK = new Uint8Array([1, 2, 3]);

type Sent = { type: FrameType; ctr: number; msg: any };

function makeSession(K_enc: Uint8Array, raw: string[]) {
  const writes: Array<{ sid: string; chunk: Uint8Array }> = [];
  const closed: Array<{ sid: string; reason?: string }> = [];
  const session: any = {
    socketId: 'sock-1',
    ws: { readyState: 1, send: (data: string) => raw.push(data) },
    cap: {},
    keys: { K_enc },
    counters: new BidirectionalCounters(),
    streamCounters: new StreamCounters(),
    authenticated: true,
    terminated: false,
    streamManager: {
      writeToStream: (sid: string, chunk: Uint8Array) => { writes.push({ sid, chunk }); },
      closeStream: (sid: string, reason?: string) => { closed.push({ sid, reason }); },
      closeAllStreams: () => { closed.push({ sid: '*ALL*' }); },
    },
  };
  return { session, writes, closed };
}

/** Encrypt a client->server stream frame carrying an explicit counter. */
async function clientFrame(
  K_enc: Uint8Array,
  type: FrameType,
  ctr: number,
  msg: any
): Promise<Uint8Array> {
  return streamAeadEncrypt(K_enc, encode({ ctr, msg }), frameAad(type, AeadDir.ClientToServer));
}

function dataMsg(sid: string) {
  return { v: 1 as const, kind: 'data' as const, sid, chunk: CHUNK, channel: 'stdout' as const };
}

/** Decrypt everything the agent pushed back to the client. */
async function decodeSent(K_enc: Uint8Array, raw: string[]): Promise<Sent[]> {
  const out: Sent[] = [];
  for (const line of raw) {
    const envelope = JSON.parse(line);
    const frames = new FrameReader().push(Buffer.from(envelope.frame, 'base64'));
    for (const frame of frames) {
      const pt = await streamAeadDecrypt(
        K_enc,
        frame.payload,
        frameAad(frame.type, AeadDir.ServerToClient),
      );
      const { ctr, msg } = decode(pt) as { ctr: number; msg: any };
      out.push({ type: frame.type, ctr, msg });
    }
  }
  return out;
}

describe('serve: per-stream fault isolation', () => {
  let K_enc: Uint8Array;
  let raw: string[];

  beforeEach(() => {
    K_enc = randomBytes(32);
    raw = [];
  });

  it('a counter fault on one stream leaves the session and sibling streams alive', async () => {
    const { session, writes, closed } = makeSession(K_enc, raw);

    // Stream A and stream B each exchange one good frame (ctr 0).
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 0, dataMsg('A')),
    });
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 0, dataMsg('B')),
    });
    expect(writes.map((w) => w.sid)).toEqual(['A', 'B']);

    // Stream A now sends a wrong counter (expected 1, sends 26) — the shape of
    // the original glass-pipe truncation.
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 26, dataMsg('A')),
    });

    // A is closed...
    expect(closed.map((c) => c.sid)).toEqual(['A']);
    expect(writes.map((w) => w.sid)).toEqual(['A', 'B']); // the bad frame never reached the stream
    // ...but the session is NOT terminated and no blanket teardown happened.
    expect(session.terminated).toBe(false);
    expect(closed.some((c) => c.sid === '*ALL*')).toBe(false);

    // And sibling stream B keeps working: its next frame (ctr 1) still lands.
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 1, dataMsg('B')),
    });
    expect(writes.map((w) => w.sid)).toEqual(['A', 'B', 'B']);
    expect(session.terminated).toBe(false);
  });

  it('reports the reason to the client on the faulted stream', async () => {
    const { session } = makeSession(K_enc, raw);

    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 0, dataMsg('A')),
    });
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 26, dataMsg('A')),
    });

    const sent = await decodeSent(K_enc, raw);
    const err = sent.find((s) => s.type === FrameType.STREAM_ERROR);
    expect(err).toBeDefined();
    expect(err!.msg.sid).toBe('A');
    expect(err!.msg.message).toContain('Stream counter mismatch');
    // Diagnosable, and free of any frame body.
    expect(err!.msg.message).toContain('expected=1');
    expect(err!.msg.message).toContain('received=26');
    // The error rides the stream's own outgoing sequence, so the client accepts
    // it instead of dropping it as out-of-order.
    expect(err!.ctr).toBe(0);
  });

  it('drops late frames on a retired stream instead of killing the session', async () => {
    // The exact observed fault: the agent tears the stream down unilaterally,
    // then the client's already-in-flight frames arrive.
    const { session, writes, closed } = makeSession(K_enc, raw);

    for (const ctr of [0, 1, 2]) {
      await handleMultiStreamFrame(session, {
        type: FrameType.STREAM_DATA,
        payload: await clientFrame(K_enc, FrameType.STREAM_DATA, ctr, dataMsg('A')),
      });
    }
    // Agent-side teardown (process exit / pipe peer gone).
    session.streamCounters.retire('A');

    // Late frames land on the dead sid. Previously each of these recreated the
    // counter at 0 and produced "expected=0, received=3" -> session terminated.
    for (const ctr of [3, 4, 5]) {
      await handleMultiStreamFrame(session, {
        type: FrameType.STREAM_DATA,
        payload: await clientFrame(K_enc, FrameType.STREAM_DATA, ctr, dataMsg('A')),
      });
    }

    expect(session.terminated).toBe(false);
    expect(writes).toHaveLength(3); // only the three live frames were delivered
    expect(closed).toHaveLength(0); // dropping a late frame is not a fault

    // A sibling stream opened afterwards is entirely unaffected.
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 0, dataMsg('B')),
    });
    expect(writes[3]!.sid).toBe('B');
  });

  it('a retired stream can never restart its counter at 0 (no replay window)', async () => {
    const { session, writes } = makeSession(K_enc, raw);

    // Capture a legitimate frame history for stream A.
    const history: Uint8Array[] = [];
    for (const ctr of [0, 1, 2]) {
      const f = await clientFrame(K_enc, FrameType.STREAM_DATA, ctr, dataMsg('A'));
      history.push(f);
      await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload: f });
    }
    expect(writes).toHaveLength(3);

    // Teardown, then replay the whole captured history verbatim. If teardown had
    // merely FORGOTTEN the counter, frame ctr=0 would be accepted again and the
    // entire history would replay.
    session.streamCounters.retire('A');
    for (const f of history) {
      await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload: f });
    }

    expect(writes).toHaveLength(3); // not one replayed frame was delivered
    expect(session.terminated).toBe(false);
  });

  it('still fails closed on a replayed frame within a live stream', async () => {
    const { session, writes, closed } = makeSession(K_enc, raw);

    const first = await clientFrame(K_enc, FrameType.STREAM_DATA, 0, dataMsg('A'));
    await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload: first });
    await handleMultiStreamFrame(session, {
      type: FrameType.STREAM_DATA,
      payload: await clientFrame(K_enc, FrameType.STREAM_DATA, 1, dataMsg('A')),
    });
    expect(writes).toHaveLength(2);

    // Replay the very first frame, byte for byte.
    await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload: first });

    // The replay is REJECTED (not delivered) and costs the stream its life — the
    // control is intact, it just no longer takes the connection down with it.
    expect(writes).toHaveLength(2);
    expect(closed.map((c) => c.sid)).toEqual(['A']);
    expect(session.streamCounters.isRetired('A')).toBe(true);
  });

  it('STAYS FATAL: a forged/tampered frame terminates the session', async () => {
    const { session, closed } = makeSession(K_enc, raw);

    // Sealed under a different key — i.e. not authentic. The sid is inside the
    // sealed plaintext, so there is no stream to attribute this to.
    const forged = await clientFrame(randomBytes(32), FrameType.STREAM_DATA, 0, dataMsg('A'));
    await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload: forged });

    expect(session.terminated).toBe(true);
    expect(closed.some((c) => c.sid === '*ALL*')).toBe(true);
  });

  it('STAYS FATAL: a bit-flipped ciphertext terminates the session', async () => {
    const { session } = makeSession(K_enc, raw);

    const good = await clientFrame(K_enc, FrameType.STREAM_DATA, 0, dataMsg('A'));
    const tampered = good.slice();
    tampered[tampered.length - 1] ^= 0x01;
    await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload: tampered });

    expect(session.terminated).toBe(true);
  });

  it('STAYS FATAL: a session-global counter fault terminates the session', async () => {
    const { session, closed } = makeSession(K_enc, raw);

    // KEEPALIVE rides the session-global counter, not a per-stream one, so a
    // fault there is not attributable to any stream and must stay fatal.
    await handleMultiStreamFrame(session, {
      type: FrameType.KEEPALIVE,
      payload: await clientFrame(K_enc, FrameType.KEEPALIVE, 0, { v: 1, kind: 'keepalive' }),
    });
    expect(session.terminated).toBe(false);

    await handleMultiStreamFrame(session, {
      type: FrameType.KEEPALIVE,
      payload: await clientFrame(K_enc, FrameType.KEEPALIVE, 0, { v: 1, kind: 'keepalive' }),
    });

    expect(session.terminated).toBe(true);
    expect(closed.some((c) => c.sid === '*ALL*')).toBe(true);
  });

  it('STAYS FATAL: a malformed envelope terminates the session', async () => {
    const { session } = makeSession(K_enc, raw);

    // Authentic under the session key, but not a well-formed { ctr, msg }.
    const payload = await streamAeadEncrypt(
      K_enc,
      encode({ nonsense: true }),
      frameAad(FrameType.STREAM_DATA, AeadDir.ClientToServer),
    );
    await handleMultiStreamFrame(session, { type: FrameType.STREAM_DATA, payload });

    expect(session.terminated).toBe(true);
  });
});
