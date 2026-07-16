import type { Duplex } from 'stream';
import type { WindowStateBody } from '@thenewlabs/entangle-protocol';

// Local unix-socket IPC framing between the `entangle serve` daemon and an
// attached terminal client. This is a *local* transport (a filesystem socket
// secured by directory permissions — see session-registry.ts), so there is no
// encryption here: confidentiality is the registry's job.
//
// Framing: a 4-byte big-endian (network order) unsigned length prefix followed
// by exactly that many bytes of a UTF-8 JSON payload. Terminal data (which is
// binary) travels as base64 strings inside the JSON so the wire is always valid
// JSON and we never have to deal with mixed binary/text framing.
//
//   +----------------+----------------------------+
//   | uint32 BE len  | JSON payload (len bytes)    |
//   +----------------+----------------------------+

/** Bytes of the length prefix that precedes every JSON payload. */
export const HEADER_BYTES = 4;

/**
 * Maximum accepted payload size. A frame declaring a larger payload is rejected
 * (the decoder errors) rather than buffering an unbounded amount of memory for
 * a payload that may never fully arrive. 8 MB comfortably fits a full-screen
 * replay while capping a hostile/framed-wrong peer.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// --- Message unions --------------------------------------------------------

/** A window operation requested by the client (tmux-style window control). */
export type WindowOp = 'new' | 'next' | 'prev' | 'select' | 'close';

/** Messages sent from an attached terminal client to the daemon. */
export type ClientToDaemon =
  | { t: 'hello'; cols: number; rows: number }
  /** Keystrokes / raw terminal input, base64-encoded. */
  | { t: 'input'; data: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'win'; op: WindowOp; index?: number }
  /**
   * Ask the daemon for a FRESH serialized frame of this client's active window
   * (optionally `scrollback` lines of history). The daemon replies with the
   * existing `replay` frame — it already means "a serialized frame for
   * getReplay()" — serialized on receipt, so it reflects the window's live
   * screen at request time rather than the stale post-attach cache.
   */
  | { t: 'refresh'; scrollback?: number }
  /**
   * Ask the daemon for the FULL scrollback of this client's active window as
   * plain-text lines (history + current screen, oldest first), for the host's
   * copy-mode pager. The daemon replies with a `scrollback` frame.
   */
  | { t: 'scrollback' }
  | { t: 'detach' }
  /**
   * End the WHOLE session (daemon shutdown: workspace, registry entry, every
   * attached client) — the in-band equivalent of `entangle kill`. The daemon
   * answers with an `exit` broadcast before the sockets close.
   */
  | { t: 'kill' };

/** Messages sent from the daemon to an attached terminal client. */
export type DaemonToClient =
  /** Live terminal output, base64-encoded. */
  | { t: 'data'; chunk: string }
  /** Scrollback replay sent right after attach, base64-encoded. */
  | { t: 'replay'; chunk: string }
  | { t: 'window-state'; state: WindowStateBody }
  /** Number of currently attached viewers. */
  | { t: 'viewers'; n: number }
  | { t: 'log'; line: string }
  | { t: 'url'; url: string }
  /** Plain-text scrollback lines answering a client `scrollback` request. */
  | { t: 'scrollback'; lines: string[] }
  | { t: 'exit'; code: number | null };

/** Any framed IPC message, in either direction. */
export type IpcMessage = ClientToDaemon | DaemonToClient;

// --- base64 helpers for binary chunks --------------------------------------

/** Encode a binary terminal chunk as a base64 string for the JSON wire. */
export function encodeChunk(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

/** Decode a base64 chunk string back into a Buffer of terminal bytes. */
export function decodeChunk(chunk: string): Buffer {
  return Buffer.from(chunk, 'base64');
}

// --- Encoding --------------------------------------------------------------

/**
 * Serialize a message to a length-prefixed frame: a 4-byte big-endian payload
 * length followed by the UTF-8 JSON payload.
 *
 * @throws if the resulting payload exceeds {@link MAX_FRAME_BYTES}.
 */
export function encodeMessage(msg: IpcMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`IPC frame too large to encode: ${payload.length} > ${MAX_FRAME_BYTES}`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

/** Encode and write a single message to a socket/stream. */
export function writeMessage(socket: Duplex, msg: IpcMessage): boolean {
  return socket.write(encodeMessage(msg));
}

// --- Decoding --------------------------------------------------------------

/**
 * Incrementally decodes length-prefixed frames from a byte stream, tolerating
 * partial reads (a frame split across chunks) and coalesced reads (many frames
 * in one chunk). A frame whose declared length exceeds {@link MAX_FRAME_BYTES}
 * makes {@link push} throw rather than buffering unbounded memory — callers
 * should treat that as a fatal protocol error and close the socket.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed received bytes; returns every message that became fully available.
   * @throws if a frame declares a payload larger than {@link MAX_FRAME_BYTES}
   *         or if a completed payload is not valid JSON.
   */
  push(chunk: Uint8Array): IpcMessage[] {
    const messages: IpcMessage[] = [];
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.concat([this.buffer, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);

    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`IPC frame too large: ${length} > ${MAX_FRAME_BYTES}`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break; // wait for more bytes

      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      messages.push(JSON.parse(payload.toString('utf8')) as IpcMessage);
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }

    return messages;
  }
}

/**
 * Attach a {@link FrameDecoder} to a socket and invoke `onMessage` for each
 * decoded message. A decode error (oversize frame or malformed JSON) is routed
 * to `onError` if provided, otherwise emitted on the socket as an `'error'`.
 *
 * @returns a detach function that removes the installed `'data'` listener.
 */
export function createMessageReader(
  socket: Duplex,
  onMessage: (msg: IpcMessage) => void,
  onError?: (err: Error) => void,
): () => void {
  const decoder = new FrameDecoder();
  const onData = (chunk: Buffer): void => {
    let messages: IpcMessage[];
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (onError) onError(error);
      else socket.emit('error', error);
      return;
    }
    for (const msg of messages) onMessage(msg);
  };
  socket.on('data', onData);
  return () => socket.off('data', onData);
}
