import { describe, it, expect } from 'vitest';
import { FrameType } from './types.js';
import { encodeFrame, decodeFrameHeader, FrameReader } from './frame.js';
import { MAX_FRAME_BYTES } from './constants.js';

// Build a 9-byte frame header with an arbitrary declared length (which
// encodeFrame won't do, since it derives length from the payload).
function makeHeader(type: FrameType, length: bigint): Uint8Array {
  const h = new Uint8Array(9);
  h[0] = type;
  new DataView(h.buffer).setBigUint64(1, length, false);
  return h;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('Frame Codec', () => {
  describe('encodeFrame', () => {
    it('should encode frame with correct header', () => {
      const type = FrameType.RUN;
      const payload = new Uint8Array([1, 2, 3, 4]);
      
      const frame = encodeFrame(type, payload);
      
      expect(frame).toHaveLength(9 + payload.length);
      expect(frame[0]).toBe(type);
      
      const view = new DataView(frame.buffer);
      const length = view.getBigUint64(1, false);
      expect(length).toBe(BigInt(payload.length));
      
      const extractedPayload = frame.slice(9);
      expect(extractedPayload).toEqual(payload);
    });

    it('should handle empty payload', () => {
      const type = FrameType.KEEPALIVE;
      const payload = new Uint8Array(0);
      
      const frame = encodeFrame(type, payload);
      
      expect(frame).toHaveLength(9);
      expect(frame[0]).toBe(type);
      
      const view = new DataView(frame.buffer);
      const length = view.getBigUint64(1, false);
      expect(length).toBe(0n);
    });

    it('should handle large payload', () => {
      const type = FrameType.STDOUT;
      const payload = new Uint8Array(100000);
      payload.fill(42);
      
      const frame = encodeFrame(type, payload);
      
      expect(frame).toHaveLength(9 + 100000);
      expect(frame[0]).toBe(type);
      
      const view = new DataView(frame.buffer, 0, 9);
      const length = view.getBigUint64(1, false);
      expect(length).toBe(100000n);
    });
  });

  describe('decodeFrameHeader', () => {
    it('should decode valid header', () => {
      const type = FrameType.AUTH1;
      const payloadLength = 1234n;
      
      const header = new Uint8Array(9);
      header[0] = type;
      const view = new DataView(header.buffer);
      view.setBigUint64(1, payloadLength, false);
      
      const decoded = decodeFrameHeader(header);
      
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(type);
      expect(decoded!.length).toBe(payloadLength);
    });

    it('should return null for incomplete header', () => {
      const header = new Uint8Array(8);
      
      const decoded = decodeFrameHeader(header);
      
      expect(decoded).toBeNull();
    });

    it('should handle all frame types', () => {
      const types = [
        FrameType.AUTH1, FrameType.AUTH2, FrameType.AUTH3,
        FrameType.RUN, FrameType.STDIN, FrameType.STDOUT,
        FrameType.STDERR, FrameType.EXIT, FrameType.ERROR,
        FrameType.ABORT, FrameType.KEEPALIVE,
      ];
      
      for (const type of types) {
        const header = new Uint8Array(9);
        header[0] = type;
        
        const decoded = decodeFrameHeader(header);
        expect(decoded).not.toBeNull();
        expect(decoded!.type).toBe(type);
      }
    });
  });

  describe('FrameReader', () => {
    it('should parse single complete frame', () => {
      const reader = new FrameReader();
      const type = FrameType.RUN;
      const payload = new Uint8Array([1, 2, 3]);
      
      const frame = encodeFrame(type, payload);
      const frames = reader.push(frame);
      
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(type);
      expect(frames[0]!.payload).toEqual(payload);
    });

    it('should handle fragmented frames', () => {
      const reader = new FrameReader();
      const type = FrameType.STDOUT;
      const payload = new Uint8Array([10, 20, 30, 40]);
      
      const frame = encodeFrame(type, payload);
      
      // Split frame into chunks
      const chunk1 = frame.slice(0, 5);
      const chunk2 = frame.slice(5, 9);
      const chunk3 = frame.slice(9);
      
      let frames = reader.push(chunk1);
      expect(frames).toHaveLength(0);
      
      frames = reader.push(chunk2);
      expect(frames).toHaveLength(0);
      
      frames = reader.push(chunk3);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(type);
      expect(frames[0]!.payload).toEqual(payload);
    });

    it('should handle multiple frames in one push', () => {
      const reader = new FrameReader();
      
      const frame1 = encodeFrame(FrameType.AUTH1, new Uint8Array([1]));
      const frame2 = encodeFrame(FrameType.AUTH2, new Uint8Array([2, 3]));
      const frame3 = encodeFrame(FrameType.AUTH3, new Uint8Array([4, 5, 6]));
      
      const combined = new Uint8Array(frame1.length + frame2.length + frame3.length);
      combined.set(frame1, 0);
      combined.set(frame2, frame1.length);
      combined.set(frame3, frame1.length + frame2.length);
      
      const frames = reader.push(combined);
      
      expect(frames).toHaveLength(3);
      expect(frames[0]!.type).toBe(FrameType.AUTH1);
      expect(frames[0]!.payload).toEqual(new Uint8Array([1]));
      expect(frames[1]!.type).toBe(FrameType.AUTH2);
      expect(frames[1]!.payload).toEqual(new Uint8Array([2, 3]));
      expect(frames[2]!.type).toBe(FrameType.AUTH3);
      expect(frames[2]!.payload).toEqual(new Uint8Array([4, 5, 6]));
    });

    it('should handle partial header then complete frame', () => {
      const reader = new FrameReader();
      const type = FrameType.EXIT;
      const payload = new Uint8Array([99]);
      
      const frame = encodeFrame(type, payload);
      
      // Send partial header first
      let frames = reader.push(frame.slice(0, 3));
      expect(frames).toHaveLength(0);
      
      // Send rest of frame
      frames = reader.push(frame.slice(3));
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(type);
      expect(frames[0]!.payload).toEqual(payload);
    });

    it('should handle zero-length payload', () => {
      const reader = new FrameReader();
      const type = FrameType.KEEPALIVE;
      const payload = new Uint8Array(0);
      
      const frame = encodeFrame(type, payload);
      const frames = reader.push(frame);
      
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(type);
      expect(frames[0]!.payload).toHaveLength(0);
    });

    it('should discard an oversize-but-finite frame and then recover', () => {
      const reader = new FrameReader();
      const over = MAX_FRAME_BYTES + 100;

      // Header declaring an over-limit length: no frame emitted.
      expect(reader.push(makeHeader(FrameType.STDOUT, BigInt(over)))).toHaveLength(0);

      // Stream the oversize payload in chunks; every push must drop it.
      let remaining = over;
      const chunk = new Uint8Array(4096);
      while (remaining > 0) {
        const n = Math.min(chunk.length, remaining);
        expect(reader.push(chunk.subarray(0, n))).toHaveLength(0);
        remaining -= n;
      }

      // A valid frame arriving right after must still parse.
      const good = encodeFrame(FrameType.RUN, new Uint8Array([7, 8, 9]));
      const frames = reader.push(good);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(FrameType.RUN);
      expect(frames[0]!.payload).toEqual(new Uint8Array([7, 8, 9]));
    });

    it('should not buffer a frame declaring an impossibly large length', () => {
      const reader = new FrameReader();
      // 2^60 bytes will never arrive; the reader must keep discarding without
      // retaining data (the memory-exhaustion guard) and never emit a frame.
      const header = makeHeader(FrameType.STDOUT, 1n << 60n);
      const mib = new Uint8Array(1024 * 1024);

      expect(reader.push(concat(header, mib))).toHaveLength(0);
      for (let i = 0; i < 8; i++) {
        expect(reader.push(mib)).toHaveLength(0);
      }
    });

    it('should maintain state across multiple pushes', () => {
      const reader = new FrameReader();
      
      const frame1 = encodeFrame(FrameType.RUN, new Uint8Array([1, 2]));
      const frame2 = encodeFrame(FrameType.STDOUT, new Uint8Array([3, 4, 5]));
      
      // Split across weird boundaries
      const chunk1 = frame1.slice(0, 7);
      const chunk2 = new Uint8Array(frame1.length - 7 + 4);
      chunk2.set(frame1.slice(7), 0);
      chunk2.set(frame2.slice(0, 4), frame1.length - 7);
      const chunk3 = frame2.slice(4);
      
      let frames = reader.push(chunk1);
      expect(frames).toHaveLength(0);
      
      frames = reader.push(chunk2);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(FrameType.RUN);
      
      frames = reader.push(chunk3);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.type).toBe(FrameType.STDOUT);
    });
  });
});