import { FrameType, FrameReader, encodeFrame } from '@thenewlabs/entangle-protocol';
import { deriveKeys, extractSaltFromCapId, aeadDecrypt, aeadEncrypt, computeHmac, sha256Hex } from '@thenewlabs/entangle-crypto';
import { StreamCounters, BidirectionalCounters } from '@thenewlabs/entangle-utils/browser';
import { encode, decode } from 'cborg';

type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL';

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  // If true, run via shell (sh -lc)
  shell?: boolean;
}

type DataHandler = (chunk: Uint8Array) => void;
type ExitHandler = (code: number | null, signal: string | null) => void;
type ErrorHandler = (message: string) => void;

class Emitter {
  private listeners = new Map<string, Set<Function>>();
  on(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  off(event: string, fn: Function) {
    this.listeners.get(event)?.delete(fn);
  }
  emit(event: string, ...args: any[]) {
    for (const fn of this.listeners.get(event) || []) fn(...args);
  }
}

class EntangleConnection {
  private ws: WebSocket | null = null;
  private reader = new FrameReader();
  private keys: any | null = null;
  private authenticated = false;
  private requiresPassword = false;
  private passwordVerified = false;
  private counters = new BidirectionalCounters();
  private streamCounters = new StreamCounters();
  private children = new Map<string, BrowserChildProcess>();
  private pendingOpens: BrowserChildProcess[] = [];

  constructor(private capId: string, private S: string) {}

  async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) return;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const saltCap = extractSaltFromCapId(this.capId);
    this.keys = await deriveKeys(this.S, saltCap);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/relay/${this.capId}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not created'));

      this.ws.onopen = () => {
        // AUTH1: HMAC(K_auth, 'hello' + capId + nonceBHex) || HMAC and nonceBHex payload
        const nonceB = crypto.getRandomValues(new Uint8Array(16));
        const nonceBHex = Array.from(nonceB).map(b => b.toString(16).padStart(2, '0')).join('');
        const auth1Data = new TextEncoder().encode('hello' + this.capId + nonceBHex);
        const hmac = computeHmac(this.keys!.K_auth, auth1Data);
        const nonceBBytes = new TextEncoder().encode(nonceBHex);
        const payload = new Uint8Array(32 + nonceBBytes.length);
        payload.set(hmac, 0);
        payload.set(nonceBBytes, 32);
        this.ws!.send(encodeFrame(FrameType.AUTH1, payload));
      };

      this.ws!.onmessage = async (event) => {
        const frames = this.reader.push(new Uint8Array(await (event.data as ArrayBuffer)));
        for (const frame of frames) {
          if (!this.keys) continue;
          if (!this.authenticated && frame.type === FrameType.AUTH2) {
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(this.keys.K_enc, FrameType.AUTH2, encrypted.nonce, encrypted.cipher);
            const nonceC = decrypted.msg.nonceC as string;
            this.requiresPassword = !!decrypted.msg.requiresPassword;
            const auth3Data = new TextEncoder().encode('ready' + nonceC);
            const auth3Hmac = computeHmac(this.keys.K_auth, auth3Data);
            this.ws!.send(encodeFrame(FrameType.AUTH3, auth3Hmac));
            this.authenticated = true;
            // If password is required and present in URL, send it now
            if (this.requiresPassword) {
              const hash = new URLSearchParams(window.location.hash.slice(1));
              const urlPw = hash.get('PW');
              const pwHash = (window as any).entangle?.passwordHash || (urlPw ? sha256Hex(urlPw) : undefined);
              if (pwHash) {
                const pwMsg = { ctr: this.counters.outgoing.next(), msg: { passwordHash: pwHash } };
                const pwEncrypted = aeadEncrypt(this.keys.K_enc, FrameType.AUTH_PW, pwMsg.ctr, pwMsg.msg);
                this.ws!.send(encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted)));
              }
            }
            resolve();
            continue;
          }
          if (frame.type === FrameType.AUTH_PW && this.requiresPassword && !this.passwordVerified) {
            // Handle password verification response
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(this.keys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher);
            this.counters.incoming.validate(decrypted.ctr);
            if (decrypted.msg && decrypted.msg.ok) {
              this.passwordVerified = true;
            } else {
              // Surface an error to all pending children
              for (const child of this.pendingOpens.splice(0)) child._onError('Invalid password');
            }
            continue;
          }
          // After auth, dispatch frames to children
          await this.dispatchFrame(frame);
        }
      };

      this.ws!.onerror = () => reject(new Error('WebSocket error'));
      this.ws!.onclose = () => {
        this.authenticated = false;
        // Inform children of disconnect
        for (const child of this.children.values()) child._onError('disconnect');
        this.children.clear();
      };
    });
  }

  private async dispatchFrame(frame: { type: FrameType; payload: Uint8Array }) {
    if (!this.keys) return;
    try {
      // AUTH2 uses classic AEAD + CBOR, all other frames use stream AEAD
      let decrypted: any;
      if (frame.type === FrameType.AUTH2) {
        // This shouldn't happen in normal flow as AUTH2 is handled during connection
        return;
      } else {
        // Stream frames are sent with stream AEAD (raw bytes: nonce|cipher)
        const { streamAeadDecrypt } = await import('@thenewlabs/entangle-crypto');
        const aad = encode({ type: frame.type });
        const plaintext = await streamAeadDecrypt(this.keys.K_enc, frame.payload, aad);
        decrypted = decode(plaintext) as any;
      }
      
      const { ctr, msg } = decrypted as any;
      const sid = msg?.sid as string | undefined;
      if (sid) {
        // Validate per-stream counter (optional client-side check)
        const expected = this.streamCounters.getNext(sid, 'incoming');
        if (ctr !== expected) {
          // Drop out-of-order frames silently
          return;
        }
        this.streamCounters.increment(sid, 'incoming');
      }

      switch (frame.type) {
        case FrameType.STREAM_OPEN: {
          // opened: bind first pending child to the actual sid from agent
          if (msg.kind === 'opened') {
            const child = this.pendingOpens.shift();
            if (child) {
              // Remove provisional mapping if set
              if (this.children.has(child._sid)) this.children.delete(child._sid);
              // Update child sid to actual
              child._sid = String(msg.sid);
              this.children.set(child._sid, child);
              child._onOpened();
            }
          }
          break;
        }
        case FrameType.STREAM_DATA: {
          const child = this.children.get(msg.sid);
          child?._onData(new Uint8Array(msg.chunk));
          break;
        }
        case FrameType.STREAM_EXIT: {
          const child = this.children.get(msg.sid);
          child?._onExit(msg.code ?? null, msg.signal ?? null);
          // After exit, stop tracking counters for this stream
          this.streamCounters.removeStream(msg.sid);
          this.children.delete(msg.sid);
          break;
        }
        case FrameType.STREAM_ERROR: {
          let child = this.children.get(msg.sid);
          if (!child) {
            const idx = this.pendingOpens.findIndex(c => c._sid === msg.sid);
            if (idx >= 0) {
              child = this.pendingOpens.splice(idx, 1)[0];
              if (this.children.has(msg.sid)) this.children.delete(msg.sid);
            }
          }
          child?._onError(msg.message || 'error');
          break;
        }
        case FrameType.STREAM_CLOSE: {
          // closed ack from agent
          const child = this.children.get(msg.sid);
          child?._onClosed();
          break;
        }
      }
    } catch (e) {
      // Ignore frame errors to avoid breaking others
    }
  }

  spawn(command: string, args: string[] = [], options: SpawnOptions = {}): BrowserChildProcess {
    const child = new BrowserChildProcess(this, command, args, options);
    return child;
  }

  async _openChild(child: BrowserChildProcess): Promise<void> {
    await this.ensureConnected();
    if (!this.ws || !this.keys) throw new Error('Not connected');
    if (this.requiresPassword && !this.passwordVerified) {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const urlPw = hash.get('PW');
      const pwHash = (window as any).entangle?.passwordHash || (urlPw ? sha256Hex(urlPw) : undefined);
      if (pwHash) {
        const pwMsg = { ctr: this.counters.outgoing.next(), msg: { passwordHash: pwHash } };
        const pwEncrypted = aeadEncrypt(this.keys.K_enc, FrameType.AUTH_PW, pwMsg.ctr, pwMsg.msg);
        this.ws!.send(encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted)));
      } else {
        child._onError('Password verification required');
        return;
      }
    }
    const sid = child._sid;
    // Start counters for this stream
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    // Build argv based on shell option
    const argv = child._options.shell
      ? ['sh', '-lc', [child._command, ...child._args].join(' ')]
      : [child._command, ...child._args];

    const msg = {
      ctr,
      msg: {
        v: 1 as const,
        kind: 'open' as const,
        sid,
        mode: 'cmd' as const,
        exec: {
          argv,
          cwd: child._options.cwd,
          env: child._options.env,
          stdin: true,
        },
      },
    };
    const ciphertext = await (async () => {
      const plaintext = encode(msg);
      const aad = encode({ type: FrameType.STREAM_OPEN });
      return await (await import('@thenewlabs/entangle-crypto')).streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
    })();
    
    const frame = encodeFrame(FrameType.STREAM_OPEN, ciphertext);

    this.ws.send(frame);
    // Track pending open to bind when 'opened' arrives with actual sid
    this.pendingOpens.push(child);
    this.streamCounters.increment(sid, 'outgoing');
  }

  _sendData(sid: string, chunk: Uint8Array): void {
    if (!this.ws || !this.keys) return;
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const msg = { ctr, msg: { v: 1 as const, kind: 'data' as const, sid, chunk } };
    const aad = encode({ type: FrameType.STREAM_DATA });
    const plaintext = encode(msg);
    (async () => {
      const { streamAeadEncrypt } = await import('@thenewlabs/entangle-crypto');
      const ct = await streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_DATA, ct));
      this.streamCounters.increment(sid, 'outgoing');
    })();
  }

  _sendSignal(sid: string, signal: SignalName): void {
    if (!this.ws || !this.keys) return;
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const msg = { ctr, msg: { v: 1 as const, kind: 'signal' as const, sid, signal } };
    const aad = encode({ type: FrameType.STREAM_SIGNAL });
    const plaintext = encode(msg);
    (async () => {
      const { streamAeadEncrypt } = await import('@thenewlabs/entangle-crypto');
      const ct = await streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_SIGNAL, ct));
      this.streamCounters.increment(sid, 'outgoing');
    })();
  }

  _sendClose(sid: string): void {
    if (!this.ws || !this.keys) return;
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const msg = { ctr, msg: { v: 1 as const, kind: 'close' as const, sid } };
    const aad = encode({ type: FrameType.STREAM_CLOSE });
    const plaintext = encode(msg);
    (async () => {
      const { streamAeadEncrypt } = await import('@thenewlabs/entangle-crypto');
      const ct = await streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_CLOSE, ct));
      this.streamCounters.increment(sid, 'outgoing');
    })();
  }
}

class BrowserChildProcess {
  private emitter = new Emitter();
  public _sid: string;
  constructor(
    private conn: EntangleConnection,
    public _command: string,
    public _args: string[],
    public _options: SpawnOptions
  ) {
    this._sid = Math.random().toString(36).slice(2, 10);
    // Initiate open asap
    this.conn._openChild(this);
    if (this._options.signal) {
      const onAbort = () => this.kill('SIGTERM');
      if (this._options.signal.aborted) onAbort();
      else this._options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  stdin = {
    write: (data: Uint8Array | string) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      this.conn._sendData(this._sid, bytes);
    },
    end: () => {
      // No explicit half-close supported; request close
      this.conn._sendClose(this._sid);
    },
  };
  on(event: 'data', handler: DataHandler): this;
  on(event: 'exit', handler: ExitHandler): this;
  on(event: 'error', handler: ErrorHandler): this;
  on(event: string, handler: any): this {
    this.emitter.on(event, handler);
    return this;
  }
  off(event: string, handler: any): this {
    this.emitter.off(event, handler);
    return this;
  }
  kill(signal: SignalName = 'SIGTERM') {
    this.conn._sendSignal(this._sid, signal);
  }
  close() {
    this.conn._sendClose(this._sid);
  }
  // Internal events from connection
  _onOpened() {}
  _onData(chunk: Uint8Array) { this.emitter.emit('data', chunk); }
  _onExit(code: number | null, signal: string | null) { this.emitter.emit('exit', code, signal); }
  _onError(message: string) { this.emitter.emit('error', message); }
  _onClosed() {}
}

function parseCapabilityFromUrl(): { capId: string; S: string } | null {
  const match = window.location.pathname.match(/\/cap\/([^/]+)/);
  if (!match) return null;
  const capId = match[1]!;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const S = hash.get('S');
  if (!S) return null;
  return { capId, S: S };
}

declare global {
  interface Window {
    entangle?: any;
  }
}

// Attach to window
(() => {
  const cap = parseCapabilityFromUrl();
  const entangle: any = window.entangle || (window.entangle = {});
  if (!cap) {
    // Expose a lazy erroring spawn
    entangle.spawn = () => { throw new Error('Capability not found in URL'); };
    entangle.exec = async () => { throw new Error('Capability not found in URL'); };
    return;
  }
  const conn = new EntangleConnection(cap.capId, cap.S);
  entangle.spawn = (command: string, args: string[] = [], options: SpawnOptions = {}) => conn.spawn(command, args, options);

  // Helper: execute a command line via shell and await completion
  entangle.execCommand = async (
    commandLine: string,
    options: Omit<SpawnOptions, 'shell'> & { encoding?: 'utf-8' | null } = {}
  ) => {
    return await entangle.exec('sh', ['-lc', commandLine], options);
  };

  // Helper: bind a default working directory
  entangle.withCwd = (cwd: string) => {
    return {
      spawn: (command: string, args: string[] = [], options: SpawnOptions = {}) => conn.spawn(command, args, { ...options, cwd }),
      exec: async (command: string, args: string[] = [], options: SpawnOptions & { encoding?: 'utf-8' | null } = {}) =>
        await entangle.exec(command, args, { ...options, cwd }),
      execCommand: async (commandLine: string, options: Omit<SpawnOptions, 'shell'> & { encoding?: 'utf-8' | null } = {}) =>
        await entangle.exec('sh', ['-lc', commandLine], { ...options, cwd }),
    };
  };

  // Awaitable convenience: run a command and resolve with output and exit
  // Note: stdout and stderr are merged in the current protocol.
  entangle.exec = async (
    command: string,
    args: string[] = [],
    options: SpawnOptions & { encoding?: 'utf-8' | null } = {}
  ): Promise<{ code: number | null; signal: string | null; stdout: Uint8Array; text?: string }> => {
    const child = conn.spawn(command, args, options);
    const chunks: Uint8Array[] = [];
    let done = false;

    return await new Promise((resolve, reject) => {
      child.on('data', (chunk: Uint8Array) => {
        // Ensure chunk is Uint8Array
        chunks.push(new Uint8Array(chunk));
      });
      child.on('error', (message: string) => {
        if (done) return;
        done = true;
        reject(new Error(message));
      });
      child.on('exit', (code: number | null, signal: string | null) => {
        if (done) return;
        done = true;
        const totalLen = chunks.reduce((n, c) => n + c.length, 0);
        const buf = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        if (options.encoding === 'utf-8' || options.encoding === undefined) {
          resolve({ code, signal, stdout: buf, text: new TextDecoder().decode(buf) });
        } else {
          resolve({ code, signal, stdout: buf });
        }
      });
    });
  };
})();

export {};
