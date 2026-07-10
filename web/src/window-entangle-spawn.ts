import { FrameType, FrameReader, encodeFrame } from '@thenewlabs/entangle-protocol';
import {
  deriveKeyMaterial,
  deriveBootstrapKeys,
  deriveSessionKeys,
  extractSaltFromCapId,
  aeadDecrypt,
  aeadEncrypt,
  computeHmac,
  frameAad,
  AeadDir,
  streamAeadEncrypt,
  streamAeadDecrypt,
} from '@thenewlabs/entangle-crypto';
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

type DataHandler = (chunk: Uint8Array, channel?: 'stdout' | 'stderr') => void;
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
  private K_raw: Uint8Array | null = null;
  private bootstrapKeys: any | null = null;
  private keys: any | null = null; // session keys, set after AUTH2
  private nonceB: string | null = null;
  private authenticated = false;
  private requiresPassword = false;
  private passwordVerified = false;
  private counters = new BidirectionalCounters();
  private streamCounters = new StreamCounters();
  private children = new Map<string, BrowserChildProcess>();
  private pendingOpens: BrowserChildProcess[] = [];
  // In-flight password verification: sent once, awaited by every stream open so
  // no STREAM_OPEN races ahead of the agent's AUTH_PW verification.
  private pwVerifyPromise: Promise<void> | null = null;
  private pwResolve: (() => void) | null = null;
  private pwReject: ((err: Error) => void) | null = null;

  constructor(private capId: string, private S: string) {}

  async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) return;
    await this.connect();
  }

  private getPassword(): string | undefined {
    // The password is supplied interactively (the UI stores it here); it is
    // never read from the URL, so a second factor can't travel with S.
    return (window as any).entangle?.password || undefined;
  }

  // Resolve/reject the in-flight password verification and clear its state.
  private _settlePassword(err?: Error): void {
    const resolve = this.pwResolve;
    const reject = this.pwReject;
    this.pwVerifyPromise = null;
    this.pwResolve = null;
    this.pwReject = null;
    if (err) reject?.(err);
    else resolve?.();
  }

  /**
   * Send AUTH_PW (once) and resolve only when the agent confirms it, so callers
   * can await verification before opening a stream. Throws if no password is
   * available yet (the UI then prompts for one).
   */
  private verifyPasswordIfNeeded(): Promise<void> {
    if (!this.requiresPassword || this.passwordVerified) return Promise.resolve();
    if (this.pwVerifyPromise) return this.pwVerifyPromise;
    if (!this.ws || !this.keys) return Promise.reject(new Error('Not connected'));

    const password = this.getPassword();
    if (!password) return Promise.reject(new Error('Password verification required'));

    this.pwVerifyPromise = new Promise<void>((resolve, reject) => {
      this.pwResolve = resolve;
      this.pwReject = reject;
    });
    const ctr = this.counters.outgoing.next();
    const pwEncrypted = aeadEncrypt(this.keys.K_enc, FrameType.AUTH_PW, ctr, { password }, AeadDir.ClientToServer);
    this.ws.send(encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted)));
    return this.pwVerifyPromise;
  }

  private async connect(): Promise<void> {
    const saltCap = extractSaltFromCapId(this.capId);
    this.K_raw = await deriveKeyMaterial(this.S, saltCap);
    this.bootstrapKeys = deriveBootstrapKeys(this.K_raw);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/relay/${this.capId}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not created'));

      this.ws.onopen = () => {
        // AUTH1: HMAC(bootstrap K_auth, 'hello' + capId + nonceB) || nonceB
        const nonceRaw = crypto.getRandomValues(new Uint8Array(16));
        this.nonceB = Array.from(nonceRaw).map(b => b.toString(16).padStart(2, '0')).join('');
        const auth1Data = new TextEncoder().encode('hello' + this.capId + this.nonceB);
        const hmac = computeHmac(this.bootstrapKeys!.K_auth, auth1Data);
        const nonceBBytes = new TextEncoder().encode(this.nonceB);
        const payload = new Uint8Array(32 + nonceBBytes.length);
        payload.set(hmac, 0);
        payload.set(nonceBBytes, 32);
        this.ws!.send(encodeFrame(FrameType.AUTH1, payload));
      };

      this.ws!.onmessage = async (event) => {
        const frames = this.reader.push(new Uint8Array(await (event.data as ArrayBuffer)));
        for (const frame of frames) {
          if (!this.authenticated && frame.type === FrameType.AUTH2) {
            if (!this.bootstrapKeys || !this.nonceB || !this.K_raw) continue;
            const encrypted = decode(frame.payload) as any;
            // AUTH2 is protected with the bootstrap key.
            const decrypted = aeadDecrypt(this.bootstrapKeys.K_enc, FrameType.AUTH2, encrypted.nonce, encrypted.cipher, AeadDir.ServerToClient);
            const auth2 = decrypted.msg as { nonceB: string; nonceC: string; expiryTs: number; requiresPassword?: boolean };

            // Freshness checks defeat a relay replaying a stale AUTH2.
            if (auth2.nonceB !== this.nonceB) { reject(new Error('AUTH2 nonce mismatch')); return; }
            if (typeof auth2.expiryTs !== 'number' || auth2.expiryTs <= Date.now()) { reject(new Error('AUTH2 expired')); return; }

            this.keys = deriveSessionKeys(this.K_raw, this.nonceB, auth2.nonceC);
            this.requiresPassword = !!auth2.requiresPassword;

            const auth3Data = new TextEncoder().encode('ready' + auth2.nonceC);
            const auth3Hmac = computeHmac(this.keys.K_auth, auth3Data);
            this.ws!.send(encodeFrame(FrameType.AUTH3, auth3Hmac));
            this.authenticated = true;

            // Password (if required) is verified lazily and awaited in
            // _openChild before any stream opens, so a STREAM_OPEN can't race
            // ahead of the agent's AUTH_PW verification.
            resolve();
            continue;
          }
          if (!this.keys) continue;
          if (frame.type === FrameType.AUTH_PW && this.requiresPassword && !this.passwordVerified) {
            // Handle password verification response
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(this.keys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher, AeadDir.ServerToClient);
            this.counters.incoming.validate(decrypted.ctr);
            if (decrypted.msg && decrypted.msg.ok) {
              this.passwordVerified = true;
              this._settlePassword();
            } else {
              this._settlePassword(new Error('Invalid password'));
            }
            continue;
          }
          if (frame.type === FrameType.ERROR) {
            // The agent reports a rejected password (and other faults) as an
            // ERROR frame, not an AUTH_PW ok:false. Surface it so a bad password
            // rejects the pending verification (and re-prompts) instead of
            // hanging, and dead pending opens don't wait forever.
            let detail = 'error';
            try {
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(this.keys.K_enc, FrameType.ERROR, encrypted.nonce, encrypted.cipher, AeadDir.ServerToClient);
              detail = decrypted.msg?.detail || decrypted.msg?.code || 'error';
            } catch {}
            if (this.pwReject) {
              this._settlePassword(new Error(detail));
            } else {
              for (const child of this.pendingOpens.splice(0)) child._onError(detail);
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
        if (this.pwReject) this._settlePassword(new Error('disconnect'));
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
        // Stream frames: session-key AEAD with direction-bound AAD.
        const aad = frameAad(frame.type, AeadDir.ServerToClient);
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
          child?._onData(new Uint8Array(msg.chunk), msg.channel === 'stderr' ? 'stderr' : 'stdout');
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
    // Complete password verification BEFORE opening the stream, otherwise the
    // STREAM_OPEN races the agent's AUTH_PW check and is rejected with
    // "Password verification required".
    if (this.requiresPassword && !this.passwordVerified) {
      try {
        await this.verifyPasswordIfNeeded();
      } catch (err: any) {
        child._onError(err?.message || 'Password verification required');
        return;
      }
    }
    const sid = child._sid;
    // Start counters for this stream
    const ctr = this.streamCounters.getNext(sid, 'outgoing');

    let openMsg: any;
    if (child._mode === 'pty') {
      openMsg = {
        v: 1 as const,
        kind: 'open' as const,
        sid,
        mode: 'pty' as const,
        pty: { cols: child._ptyOptions!.cols, rows: child._ptyOptions!.rows },
        ...(child._options.cwd ? { exec: { argv: [], cwd: child._options.cwd } } : {}),
      };
    } else {
      const argv = child._options.shell
        ? ['sh', '-lc', [child._command, ...child._args].join(' ')]
        : [child._command, ...child._args];
      openMsg = {
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
      };
    }
    const msg = { ctr, msg: openMsg };
    const plaintext = encode(msg);
    const aad = frameAad(FrameType.STREAM_OPEN, AeadDir.ClientToServer);
    const ciphertext = await streamAeadEncrypt(this.keys.K_enc, plaintext, aad);

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
    const aad = frameAad(FrameType.STREAM_DATA, AeadDir.ClientToServer);
    const plaintext = encode(msg);
    (async () => {
      const ct = await streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_DATA, ct));
      this.streamCounters.increment(sid, 'outgoing');
    })();
  }

  _sendSignal(sid: string, signal: SignalName): void {
    if (!this.ws || !this.keys) return;
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const msg = { ctr, msg: { v: 1 as const, kind: 'signal' as const, sid, signal } };
    const aad = frameAad(FrameType.STREAM_SIGNAL, AeadDir.ClientToServer);
    const plaintext = encode(msg);
    (async () => {
      const ct = await streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_SIGNAL, ct));
      this.streamCounters.increment(sid, 'outgoing');
    })();
  }

  _sendResize(sid: string, cols: number, rows: number): void {
    if (!this.ws || !this.keys) return;
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const msg = { ctr, msg: { v: 1 as const, kind: 'pty-resize' as const, sid, cols, rows } };
    const aad = frameAad(FrameType.STREAM_RESIZE, AeadDir.ClientToServer);
    const plaintext = encode(msg);
    (async () => {
      const ct = await streamAeadEncrypt(this.keys!.K_enc, plaintext, aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_RESIZE, ct));
      this.streamCounters.increment(sid, 'outgoing');
    })();
  }

  spawnPty(options: { cols: number; rows: number; cwd?: string }): BrowserChildProcess {
    return new BrowserChildProcess(this, '', [], options.cwd ? { cwd: options.cwd } : {}, 'pty', { cols: options.cols, rows: options.rows });
  }

  _sendClose(sid: string): void {
    if (!this.ws || !this.keys) return;
    const ctr = this.streamCounters.getNext(sid, 'outgoing');
    const msg = { ctr, msg: { v: 1 as const, kind: 'close' as const, sid } };
    const aad = frameAad(FrameType.STREAM_CLOSE, AeadDir.ClientToServer);
    const plaintext = encode(msg);
    (async () => {
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
    public _options: SpawnOptions,
    public _mode: 'cmd' | 'pty' = 'cmd',
    public _ptyOptions?: { cols: number; rows: number }
  ) {
    this._sid = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    // Initiate open asap
    this.conn._openChild(this);
    if (this._options.signal) {
      const onAbort = () => this.kill('SIGTERM');
      if (this._options.signal.aborted) onAbort();
      else this._options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  resize(cols: number, rows: number) {
    this.conn._sendResize(this._sid, cols, rows);
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
  _onOpened() { this.emitter.emit('opened'); }
  _onData(chunk: Uint8Array, channel: 'stdout' | 'stderr' = 'stdout') { this.emitter.emit('data', chunk, channel); }
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
  // Interactive PTY session (used by the terminal UI).
  entangle.openTerminal = (options: { cols: number; rows: number; cwd?: string }) => conn.spawnPty(options);

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
