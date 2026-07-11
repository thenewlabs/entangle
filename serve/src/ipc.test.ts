import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import {
  encodeMessage,
  writeMessage,
  encodeChunk,
  decodeChunk,
  createMessageReader,
  FrameDecoder,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  type IpcMessage,
  type ClientToDaemon,
  type DaemonToClient,
} from './ipc.js';

// A representative message from each direction of the union, exercising every
// variant so the round-trip test also acts as a shape sanity check.
const clientMsgs: ClientToDaemon[] = [
  { t: 'hello', cols: 120, rows: 40 },
  { t: 'input', data: encodeChunk(Buffer.from('ls -la\n')) },
  { t: 'resize', cols: 80, rows: 24 },
  { t: 'win', op: 'new' },
  { t: 'win', op: 'select', index: 3 },
  { t: 'detach' },
];

const daemonMsgs: DaemonToClient[] = [
  { t: 'data', chunk: encodeChunk(Buffer.from('hello world')) },
  { t: 'replay', chunk: encodeChunk(Buffer.from('scrollback')) },
  { t: 'window-state', state: { v: 1, kind: 'window-state', windows: [], activeIndex: 0 } },
  { t: 'viewers', n: 2 },
  { t: 'log', line: 'started' },
  { t: 'url', url: 'https://example.test/x' },
  { t: 'exit', code: 0 },
  { t: 'exit', code: null },
];

const allMsgs: IpcMessage[] = [...clientMsgs, ...daemonMsgs];

describe('ipc framing', () => {
  it('round-trips every message variant through one decoder', () => {
    const decoder = new FrameDecoder();
    const out: IpcMessage[] = [];
    for (const msg of allMsgs) out.push(...decoder.push(encodeMessage(msg)));
    expect(out).toEqual(allMsgs);
  });

  it('uses a 4-byte big-endian length prefix', () => {
    const frame = encodeMessage({ t: 'detach' });
    const payloadLen = frame.length - HEADER_BYTES;
    expect(frame.readUInt32BE(0)).toBe(payloadLen);
    expect(JSON.parse(frame.subarray(HEADER_BYTES).toString('utf8'))).toEqual({ t: 'detach' });
  });

  it('reassembles a frame split across many single-byte chunks', () => {
    const frame = encodeMessage({ t: 'log', line: 'a fairly long line of log output' });
    const decoder = new FrameDecoder();
    const out: IpcMessage[] = [];
    for (let i = 0; i < frame.length; i++) {
      out.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(out).toEqual([{ t: 'log', line: 'a fairly long line of log output' }]);
  });

  it('splits multiple frames coalesced into one chunk', () => {
    const combined = Buffer.concat(allMsgs.map(encodeMessage));
    const decoder = new FrameDecoder();
    expect(decoder.push(combined)).toEqual(allMsgs);
  });

  it('handles a chunk boundary in the middle of the length prefix', () => {
    const combined = Buffer.concat([
      encodeMessage({ t: 'viewers', n: 1 }),
      encodeMessage({ t: 'viewers', n: 2 }),
    ]);
    const decoder = new FrameDecoder();
    // Cut 2 bytes into the second frame's 4-byte header.
    const cut = encodeMessage({ t: 'viewers', n: 1 }).length + 2;
    const out: IpcMessage[] = [];
    out.push(...decoder.push(combined.subarray(0, cut)));
    out.push(...decoder.push(combined.subarray(cut)));
    expect(out).toEqual([{ t: 'viewers', n: 1 }, { t: 'viewers', n: 2 }]);
  });

  it('preserves binary chunk fidelity through base64', () => {
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i; // every byte value 0..255
    const msg: DaemonToClient = { t: 'data', chunk: encodeChunk(bytes) };
    const [decoded] = new FrameDecoder().push(encodeMessage(msg));
    expect(decoded).toEqual(msg);
    expect(decodeChunk((decoded as { chunk: string }).chunk).equals(bytes)).toBe(true);
  });

  it('rejects an oversized declared frame on decode without buffering it', () => {
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header)).toThrow(/too large/);
  });

  it('rejects encoding a payload larger than the cap', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(() => encodeMessage({ t: 'log', line: huge })).toThrow(/too large/);
  });

  it('accepts a frame exactly at the size cap', () => {
    // Build a payload whose byte length is exactly MAX_FRAME_BYTES.
    const filler = 'x'.repeat(MAX_FRAME_BYTES - JSON.stringify({ t: 'log', line: '' }).length);
    const msg: IpcMessage = { t: 'log', line: filler };
    const frame = encodeMessage(msg);
    expect(frame.readUInt32BE(0)).toBe(MAX_FRAME_BYTES);
    expect(new FrameDecoder().push(frame)).toEqual([msg]);
  });
});

describe('createMessageReader / writeMessage', () => {
  it('delivers messages written to a duplex stream', () => {
    const stream = new PassThrough();
    const received: IpcMessage[] = [];
    createMessageReader(stream, (m) => received.push(m));
    for (const msg of allMsgs) writeMessage(stream, msg);
    // PassThrough loops writes back to its readable side synchronously enough
    // that draining once suffices, but flush via end for determinism.
    return new Promise<void>((resolve) => {
      stream.on('end', () => {
        expect(received).toEqual(allMsgs);
        resolve();
      });
      stream.end();
    });
  });

  it('routes decode errors to onError instead of throwing', () => {
    const stream = new PassThrough();
    const errors: Error[] = [];
    createMessageReader(stream, () => { /* ignore */ }, (e) => errors.push(e));
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    stream.write(header);
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toMatch(/too large/);
        resolve();
      });
    });
  });

  it('detach() stops delivering further messages', () => {
    const stream = new PassThrough();
    const received: IpcMessage[] = [];
    const detach = createMessageReader(stream, (m) => received.push(m));
    detach();
    stream.write(encodeMessage({ t: 'detach' }));
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(received).toEqual([]);
        resolve();
      });
    });
  });
});
