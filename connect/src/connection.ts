import WebSocket from 'ws';
import { randomBytes } from 'crypto';
import {
  FrameType,
  FrameReader,
  encodeFrame,
} from '@thenewlabs/entangle-protocol';
import {
  deriveKeyMaterial,
  deriveBootstrapKeys,
  deriveSessionKeys,
  extractSaltFromCapId,
  aeadEncrypt,
  aeadDecrypt,
  computeHmac,
  streamAeadEncrypt,
  streamAeadDecrypt,
  frameAad,
  AeadDir,
  type DerivedKeys,
} from '@thenewlabs/entangle-crypto';
import { BidirectionalCounters, StreamCounters } from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';

export type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL';

export interface StreamHandlers {
  onOpened?: () => void;
  onData?: (chunk: Uint8Array, channel: 'stdout' | 'stderr') => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onError?: (message: string) => void;
}

/**
 * A live stream. `sid` starts as a provisional client id and is rebound to the
 * agent-assigned id once the `opened` confirmation arrives; all writes use the
 * current `sid`, so callers should write after `onOpened`.
 */
export class StreamHandle {
  constructor(public sid: string, private conn: InvokeConnection) {}
  write(chunk: Uint8Array): void { this.conn.sendData(this.sid, chunk); }
  signal(sig: SignalName): void { this.conn.sendSignal(this.sid, sig); }
  resize(cols: number, rows: number): void { this.conn.sendResize(this.sid, cols, rows); }
  close(): void { this.conn.close(this.sid); }
}

interface PendingStream {
  handle: StreamHandle;
  handlers: StreamHandlers;
}

/**
 * Node-side connection to an entangle agent via the blind relay. Implements
 * the v2 handshake (per-session keys bound to the fresh nonces, client-side
 * verification of the echoed nonceB and expiry) and the multi-stream data
 * protocol. Both single-command and terminal invokers build on this.
 */
export class InvokeConnection {
  private ws!: WebSocket;
  private reader = new FrameReader();
  private K_raw!: Uint8Array;
  private bootstrapKeys!: DerivedKeys;
  private sessionKeys!: DerivedKeys;
  private counters = new BidirectionalCounters();
  private streamCounters = new StreamCounters();
  private nonceB!: string;
  private authenticated = false;
  private passwordVerified = false;
  private requiresPassword = false;
  private streams = new Map<string, StreamHandlers>();
  private pendingOpens: PendingStream[] = [];
  private onCloseCb?: () => void;

  constructor(
    private capId: string,
    private S: string,
    private password?: string,
    // Called when the agent requires a password and none was supplied up front
    // (e.g. to prompt interactively). Its result is used for this session.
    private promptPassword?: () => Promise<string>
  ) {}

  /** Connect and complete the handshake (including password if required). */
  async connect(wsUrl: string): Promise<void> {
    const saltCap = extractSaltFromCapId(this.capId);
    this.K_raw = await deriveKeyMaterial(this.S, saltCap);
    this.bootstrapKeys = deriveBootstrapKeys(this.K_raw);

    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => { try { this.ws.close(); } catch {} reject(err); };

      this.ws.on('open', () => {
        // AUTH1 = HMAC(bootstrap K_auth, "hello"+capId+nonceB) || nonceB
        this.nonceB = randomBytes(16).toString('hex');
        const auth1Data = new TextEncoder().encode('hello' + this.capId + this.nonceB);
        const hmac = computeHmac(this.bootstrapKeys.K_auth, auth1Data);
        const nonceBBytes = new TextEncoder().encode(this.nonceB);
        const payload = new Uint8Array(32 + nonceBBytes.length);
        payload.set(hmac, 0);
        payload.set(nonceBBytes, 32);
        this.ws.send(encodeFrame(FrameType.AUTH1, payload));
      });

      this.ws.on('message', async (data) => {
        if (!(data instanceof Buffer)) return;
        for (const frame of this.reader.push(data)) {
          try {
            await this.handleHandshakeFrame(frame, resolve, fail);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });

      this.ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      this.ws.on('close', () => { this.onCloseCb?.(); });
    });
  }

  private async handleHandshakeFrame(
    frame: { type: FrameType; payload: Uint8Array },
    resolve: () => void,
    fail: (e: Error) => void
  ): Promise<void> {
    if (frame.type === FrameType.AUTH2 && !this.authenticated) {
      const encrypted = decode(frame.payload) as any;
      // AUTH2 is protected with the bootstrap key.
      const decrypted = aeadDecrypt(this.bootstrapKeys.K_enc, FrameType.AUTH2, encrypted.nonce, encrypted.cipher, AeadDir.ServerToClient);
      const auth2 = decrypted.msg as { nonceB: string; nonceC: string; expiryTs: number; requiresPassword?: boolean };

      // Freshness checks: the agent must echo OUR nonceB and the session must
      // not be expired. This is what rejects a relay replaying a stale AUTH2.
      if (auth2.nonceB !== this.nonceB) {
        return fail(new Error('AUTH2 nonce mismatch (possible replay)'));
      }
      if (typeof auth2.expiryTs !== 'number' || auth2.expiryTs <= Date.now()) {
        return fail(new Error('AUTH2 expired'));
      }

      this.sessionKeys = deriveSessionKeys(this.K_raw, this.nonceB, auth2.nonceC);
      this.requiresPassword = !!auth2.requiresPassword;

      // AUTH3 HMAC keyed with the SESSION key.
      const auth3Data = new TextEncoder().encode('ready' + auth2.nonceC);
      const auth3Hmac = computeHmac(this.sessionKeys.K_auth, auth3Data);
      this.ws.send(encodeFrame(FrameType.AUTH3, auth3Hmac));
      this.authenticated = true;

      if (this.requiresPassword) {
        // Prefer an up-front password; otherwise prompt (never read from the
        // URL). The password rides an AEAD frame, so the relay never sees it.
        if (!this.password && this.promptPassword) {
          this.password = await this.promptPassword();
        }
        if (!this.password) return fail(new Error('Password required but not provided'));
        const ctr = this.counters.outgoing.next();
        const enc = aeadEncrypt(this.sessionKeys.K_enc, FrameType.AUTH_PW, ctr, { password: this.password }, AeadDir.ClientToServer);
        this.ws.send(encodeFrame(FrameType.AUTH_PW, encode(enc)));
      } else {
        this.passwordVerified = true;
        resolve();
      }
      return;
    }

    if (frame.type === FrameType.AUTH_PW && this.authenticated && !this.passwordVerified) {
      const encrypted = decode(frame.payload) as any;
      const decrypted = aeadDecrypt(this.sessionKeys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher, AeadDir.ServerToClient);
      this.counters.incoming.validate(decrypted.ctr);
      if (decrypted.msg?.ok) {
        this.passwordVerified = true;
        resolve();
      } else {
        fail(new Error('Password verification failed'));
      }
      return;
    }

    if (frame.type === FrameType.ERROR) {
      const encrypted = decode(frame.payload) as any;
      const decrypted = aeadDecrypt(this.sessionKeys?.K_enc ?? this.bootstrapKeys.K_enc, FrameType.ERROR, encrypted.nonce, encrypted.cipher, AeadDir.ServerToClient);
      fail(new Error(`Server error: ${decrypted.msg?.code} - ${decrypted.msg?.detail}`));
      return;
    }

    // Post-handshake stream frames.
    await this.dispatchStreamFrame(frame);
  }

  private async dispatchStreamFrame(frame: { type: FrameType; payload: Uint8Array }): Promise<void> {
    if (!this.sessionKeys) return;
    const aad = frameAad(frame.type, AeadDir.ServerToClient);
    const plaintext = await streamAeadDecrypt(this.sessionKeys.K_enc, frame.payload, aad);
    const message: any = decode(plaintext);
    const sid = message?.msg?.sid as string | undefined;
    if (!sid) return;

    // Per-stream incoming counter (drop out-of-order/replayed frames).
    const expected = this.streamCounters.getNext(sid, 'incoming');
    if (message.ctr !== expected) return;
    this.streamCounters.increment(sid, 'incoming');

    switch (frame.type) {
      case FrameType.STREAM_OPEN: {
        if (message.msg.kind === 'opened') {
          const pending = this.pendingOpens.shift();
          if (pending) {
            pending.handle.sid = sid; // rebind to agent-assigned id
            this.streams.set(sid, pending.handlers);
            pending.handlers.onOpened?.();
          }
        }
        break;
      }
      case FrameType.STREAM_DATA:
        this.streams.get(sid)?.onData?.(new Uint8Array(message.msg.chunk), message.msg.channel === 'stderr' ? 'stderr' : 'stdout');
        break;
      case FrameType.STREAM_EXIT: {
        const h = this.streams.get(sid);
        this.streamCounters.removeStream(sid);
        this.streams.delete(sid);
        h?.onExit?.(message.msg.code ?? null, message.msg.signal ?? null);
        break;
      }
      case FrameType.STREAM_ERROR: {
        // An error can arrive before `opened` (e.g. the agent rejected the
        // open); in that case the stream is still pending under this sid.
        let handlers = this.streams.get(sid);
        if (!handlers) {
          const idx = this.pendingOpens.findIndex((p) => p.handle.sid === sid);
          if (idx >= 0) handlers = this.pendingOpens.splice(idx, 1)[0]!.handlers;
        }
        handlers?.onError?.(message.msg.message || 'stream error');
        break;
      }
    }
  }

  private async sendStream(type: FrameType, sid: string, msgBody: any): Promise<void> {
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const plaintext = encode({ ctr, msg: { v: 1, sid, ...msgBody } });
    const aad = frameAad(type, AeadDir.ClientToServer);
    const ct = await streamAeadEncrypt(this.sessionKeys.K_enc, plaintext, aad);
    this.ws.send(encodeFrame(type, ct));
    this.streamCounters.increment(sid, 'outgoing');
  }

  /** Open a command stream. */
  openCmd(argv: string[], options: { cwd?: string } = {}, handlers: StreamHandlers = {}): StreamHandle {
    const handle = new StreamHandle(randomBytes(8).toString('hex'), this);
    this.pendingOpens.push({ handle, handlers });
    void this.sendStream(FrameType.STREAM_OPEN, handle.sid, {
      kind: 'open',
      mode: 'cmd',
      exec: { argv, ...(options.cwd ? { cwd: options.cwd } : {}), stdin: true },
    });
    return handle;
  }

  /** Open a PTY stream. */
  openPty(options: { cols: number; rows: number; cwd?: string }, handlers: StreamHandlers = {}): StreamHandle {
    const handle = new StreamHandle(randomBytes(8).toString('hex'), this);
    this.pendingOpens.push({ handle, handlers });
    void this.sendStream(FrameType.STREAM_OPEN, handle.sid, {
      kind: 'open',
      mode: 'pty',
      pty: { cols: options.cols, rows: options.rows },
      ...(options.cwd ? { exec: { argv: [], cwd: options.cwd } } : {}),
    });
    return handle;
  }

  /**
   * Open a forwarded-channel ('pipe') stream to a named agent-side endpoint.
   * Mirrors openCmd/openPty: returns a handle immediately; write() sends
   * STREAM_DATA and close() sends STREAM_CLOSE over the same plumbing. Data
   * flows on channel 'stdout' in both directions.
   */
  openPipe(name: string, handlers: StreamHandlers = {}): StreamHandle {
    const handle = new StreamHandle(randomBytes(8).toString('hex'), this);
    this.pendingOpens.push({ handle, handlers });
    void this.sendStream(FrameType.STREAM_OPEN, handle.sid, {
      kind: 'open',
      mode: 'pipe',
      pipe: { name },
    });
    return handle;
  }

  sendData(sid: string, chunk: Uint8Array): void {
    void this.sendStream(FrameType.STREAM_DATA, sid, { kind: 'data', chunk });
  }

  sendSignal(sid: string, signal: SignalName): void {
    void this.sendStream(FrameType.STREAM_SIGNAL, sid, { kind: 'signal', signal });
  }

  sendResize(sid: string, cols: number, rows: number): void {
    void this.sendStream(FrameType.STREAM_RESIZE, sid, { kind: 'pty-resize', cols, rows });
  }

  close(sid: string): void {
    void this.sendStream(FrameType.STREAM_CLOSE, sid, { kind: 'close' });
  }

  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }

  disconnect(): void {
    try { this.ws.close(); } catch {}
  }
}
