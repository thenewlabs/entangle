import { FrameType, type Frame } from './types.js';
import { MAX_FRAME_BYTES } from './constants.js';

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(9 + payload.length);
  const view = new DataView(frame.buffer);
  
  frame[0] = type;
  view.setBigUint64(1, BigInt(payload.length), false);
  frame.set(payload, 9);
  
  return frame;
}

export function decodeFrameHeader(header: Uint8Array): { type: FrameType; length: bigint } | null {
  if (header.length < 9) return null;
  
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const type = header[0] as FrameType;
  const length = view.getBigUint64(1, false);
  
  return { type, length };
}

export class FrameReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private headerParsed = false;
  private currentType: FrameType | undefined;
  private currentLength = 0;
  // Bytes of an oversize payload still to be discarded. While > 0 incoming
  // bytes are dropped WITHOUT ever entering `buffer`, so a frame declaring a
  // huge (e.g. UINT64_MAX) length cannot grow memory while we wait for a
  // payload that never fully arrives.
  private discardRemaining = 0;

  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];

    // Consume any pending oversize payload straight from the incoming chunk;
    // only the unconsumed tail is ever buffered.
    if (this.discardRemaining > 0) {
      const drop = Math.min(this.discardRemaining, chunk.length);
      this.discardRemaining -= drop;
      chunk = chunk.subarray(drop);
      if (this.discardRemaining > 0) return frames;
    }

    const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
    newBuffer.set(this.buffer);
    newBuffer.set(chunk, this.buffer.length);
    this.buffer = newBuffer;

    while (true) {
      if (!this.headerParsed) {
        if (this.buffer.length < 9) break;

        const header = decodeFrameHeader(this.buffer.slice(0, 9));
        if (!header) break;

        this.currentType = header.type;
        this.headerParsed = true;
        this.buffer = this.buffer.slice(9);

        // Reject oversize frames up front so we never buffer more than a single
        // frame's worth. Discard exactly `length` payload bytes across chunks
        // and emit nothing. BigInt comparison avoids precision loss for lengths
        // beyond 2^53.
        if (header.length > BigInt(MAX_FRAME_BYTES)) {
          const available = BigInt(this.buffer.length);
          const dropNow = header.length < available ? header.length : available;
          this.buffer = this.buffer.slice(Number(dropNow));
          this.discardRemaining = Number(header.length - dropNow);
          this.headerParsed = false;
          this.currentType = undefined;
          if (this.discardRemaining > 0) break;
          continue;
        }

        this.currentLength = Number(header.length);
      }

      if (this.headerParsed) {
        if (this.buffer.length < this.currentLength) break;

        frames.push({
          type: this.currentType!,
          payload: this.buffer.slice(0, this.currentLength),
        });

        this.buffer = this.buffer.slice(this.currentLength);
        this.headerParsed = false;
        this.currentType = undefined;
      }
    }

    return frames;
  }
}
