import { FrameType, type Frame } from './types.js';

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
  private currentType?: FrameType;
  private currentLength?: bigint;
  
  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    
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
        this.currentLength = header.length;
        this.headerParsed = true;
        this.buffer = this.buffer.slice(9);
      }
      
      if (this.headerParsed && this.currentLength !== undefined) {
        const length = Number(this.currentLength);
        if (this.buffer.length < length) break;
        
        frames.push({
          type: this.currentType!,
          payload: this.buffer.slice(0, length),
        });
        
        this.buffer = this.buffer.slice(length);
        this.headerParsed = false;
        this.currentType = undefined;
        this.currentLength = undefined;
      }
    }
    
    return frames;
  }
}