import { FrameType, FrameReader, encodeFrame, type WindowStateBody } from '@thenewlabs/entangle-protocol';
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

// Exported for unit tests (heartbeat/watchdog behavior); browser consumers use `window.entangle`.
export class EntangleConnection {
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
  // Serializes every counter-consuming send. AEAD encryption is async and does NOT resolve in
  // call order, so "take counter now, send after await" lets two concurrent sends hit the wire
  // out of order — the agent's replay defense then terminates the session on the first
  // inversion (seen as "Stream counter mismatch: expected=N, received=N+1" under load). Each
  // sender runs its counter take + encrypt + send as one queued task, so counter order always
  // equals wire order. Liveness gates run INSIDE the task: a task queued before a disconnect
  // must no-op after it, never consume a counter it can't send.
  private sendChain: Promise<void> = Promise.resolve();
  private _enqueueSend(task: () => Promise<void> | void): Promise<void> {
    const run = this.sendChain.then(() => task());
    this.sendChain = run.catch(() => { /* a failed send must not stall the queue */ });
    return run;
  }
  /** Whether a queued stream-frame send is still valid (session live AND the stream is live). */
  private _canSendStream(sid: string): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.keys &&
      this.authenticated && this.children.has(sid);
  }
  // In-flight password verification: sent once, awaited by every stream open so
  // no STREAM_OPEN races ahead of the agent's AUTH_PW verification.
  private pwVerifyPromise: Promise<void> | null = null;
  private pwResolve: (() => void) | null = null;
  private pwReject: ((err: Error) => void) | null = null;
  // Subscribers to shared-workspace window-state broadcasts (drive the tab bar).
  private windowStateHandlers = new Set<(state: WindowStateBody) => void>();
  private lastWindowState: WindowStateBody | null = null;

  // --- Connection resilience: auto-reconnect (exp backoff + jitter), app-level
  // heartbeat (KEEPALIVE round-trip, since browsers can't send WS pings), and a
  // receive-watchdog that force-closes a half-open socket so onclose reconnects.
  private intentionalClose = false;
  private reconnecting = false;
  private hadConnection = false; // true once we've authed at least once
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private connectInFlight: Promise<void> | null = null;
  private lastRecvTs = 0;
  private lastWatchdogTickTs = 0;
  private connStatus: 'connecting' | 'open' | 'reconnecting' | 'closed' = 'connecting';
  private statusHandlers = new Set<(s: string) => void>();
  private reconnectedHandlers = new Set<() => void>();
  // Backoff/heartbeat tuning (ms).
  private static readonly RC_BASE = 300;
  private static readonly RC_FACTOR = 1.8;
  private static readonly RC_CAP = 15000;
  private static readonly HB_INTERVAL = 20000;
  private static readonly HB_WATCHDOG = 45000; // > 2 missed heartbeats

  constructor(private capId: string, private S: string) {}

  /** Subscribe to connection-status transitions; fires immediately with the current state. */
  onStatus(cb: (s: string) => void): () => void {
    this.statusHandlers.add(cb);
    try { cb(this.connStatus); } catch {}
    return () => this.statusHandlers.delete(cb);
  }
  /** Fires after the socket transparently re-establishes following a drop (re-open your pipes here). */
  onReconnected(cb: () => void): () => void {
    this.reconnectedHandlers.add(cb);
    return () => this.reconnectedHandlers.delete(cb);
  }
  getStatus(): string { return this.connStatus; }
  private setStatus(s: 'connecting' | 'open' | 'reconnecting' | 'closed'): void {
    if (this.connStatus === s) return;
    this.connStatus = s;
    for (const cb of this.statusHandlers) { try { cb(s); } catch {} }
  }

  async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) return;
    await this.connect();
  }

  /** Dedupe concurrent connects (reconnect timer + a lazy ensureConnected can race). */
  private async connect(): Promise<void> {
    if (this.connectInFlight) return this.connectInFlight;
    this.intentionalClose = false; // any explicit connect re-enables reconnect
    this.connectInFlight = this._doConnect().finally(() => { this.connectInFlight = null; });
    return this.connectInFlight;
  }

  /** Called once auth completes on a fresh socket: reset backoff, start heartbeat, emit events. */
  private _handleConnected(): void {
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.lastRecvTs = Date.now();
    this._startHeartbeat();
    const wasReconnect = this.hadConnection;
    this.hadConnection = true;
    this.setStatus('open');
    if (wasReconnect) {
      for (const cb of this.reconnectedHandlers) { try { cb(); } catch {} }
    }
  }

  /** Schedule a reconnect with exponential backoff + jitter (idempotent while one is pending). */
  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnecting) return;
    this.reconnecting = true;
    this.setStatus(this.hadConnection ? 'reconnecting' : 'connecting');
    const backoff = Math.min(
      EntangleConnection.RC_CAP,
      EntangleConnection.RC_BASE * Math.pow(EntangleConnection.RC_FACTOR, this.reconnectAttempts),
    );
    // Full jitter over [backoff/2, backoff] to avoid reconnect stampedes.
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // A handshake-time rejection may not fire onclose; reschedule ourselves.
        this.reconnecting = false;
        if (!this.intentionalClose) this.scheduleReconnect();
      });
    }, delay);
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this._sendKeepalive(), EntangleConnection.HB_INTERVAL);
    this.lastWatchdogTickTs = Date.now();
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      // Event-loop starvation guard: this page can share its main thread with a HEAVY app in a
      // same-origin iframe (code-server's workbench blocks it for 30s+ while installing
      // extensions), and background tabs get their timers throttled. During such a stall inbound
      // frames sit unprocessed, so a stale lastRecvTs is NOT evidence of a dead path — killing
      // the (healthy) socket here caused a reconnect+frame-reload loop exactly when the app was
      // busiest. Detect the stall by our own tick cadence; on wake, grant one fresh heartbeat
      // window and probe with an immediate keepalive instead of closing. A genuinely dead path
      // still gets closed by the following ticks when the probe goes unanswered.
      const starved = now - this.lastWatchdogTickTs > 30000; // 3× the 10s tick cadence
      this.lastWatchdogTickTs = now;
      if (starved) {
        this.lastRecvTs = Math.max(this.lastRecvTs, now - EntangleConnection.HB_INTERVAL);
        this._sendKeepalive();
        return;
      }
      if (
        this.ws && this.ws.readyState === WebSocket.OPEN &&
        now - this.lastRecvTs > EntangleConnection.HB_WATCHDOG
      ) {
        // No keepalive echo in the watchdog window → the path is half-open. Force
        // a close so onclose kicks off reconnection.
        try { this.ws.close(); } catch {}
      }
    }, 10000);
  }
  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }
  /** Round-trip liveness: the agent echoes KEEPALIVE, so receiving it confirms the whole path. */
  private _sendKeepalive(): void {
    void this._enqueueSend(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keys || !this.authenticated) return;
      const ctr = this.counters.outgoing.next(); // session-global (agent validates counters.incoming)
      const msg = { ctr, msg: { v: 1 as const, kind: 'keepalive' as const } };
      const aad = frameAad(FrameType.KEEPALIVE, AeadDir.ClientToServer);
      try {
        const ct = await streamAeadEncrypt(this.keys.K_enc, encode(msg), aad);
        this.ws.send(encodeFrame(FrameType.KEEPALIVE, ct));
      } catch { /* next watchdog tick handles a dead socket */ }
    });
  }

  /** Intentional teardown: stop reconnecting and close. */
  close(): void {
    this.intentionalClose = true;
    this.reconnecting = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._stopHeartbeat();
    this.setStatus('closed');
    try { this.ws?.close(); } catch {}
  }

  /** Per-connection password. Each agent may have its own, so this cannot live on the window. */
  private password: string | undefined;
  setPassword(p: string | undefined): void { this.password = p; }

  getPassword(): string | undefined {
    // The password is supplied interactively (the UI stores it here); it is
    // never read from the URL, so a second factor can't travel with S.
    //
    // Deliberately does NOT fall back to `window.entangle.password`: that property is an accessor
    // onto the DEFAULT client, so reading it here would recurse forever on that connection. Writes
    // to the window global still land on this field via that accessor's setter, and a value set
    // before this script ran is captured by `attachDefault`.
    return this.password || undefined;
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
    // Rides the session-global counter, so it must go through the send queue like every other
    // counter-consuming send (a queued keepalive holding an earlier counter must ship first).
    void this._enqueueSend(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keys || !this.authenticated) return;
      const ctr = this.counters.outgoing.next();
      const pwEncrypted = aeadEncrypt(this.keys.K_enc, FrameType.AUTH_PW, ctr, { password }, AeadDir.ClientToServer);
      this.ws.send(encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted)));
    });
    return this.pwVerifyPromise;
  }

  private async _doConnect(): Promise<void> {
    // `K_raw` derives from (S, capId) only — both immutable for the lifetime of this connection —
    // so it is stable across reconnects and must NOT be re-derived on each attempt: Argon2id at
    // INTERACTIVE limits is a ~64 MiB, few-hundred-ms hash ON THE MAIN THREAD, and a flapping
    // agent would pay it on every backoff tick. `_handleDisconnected` deliberately clears only the
    // per-session `keys`, never this, so memoising here is safe.
    if (!this.K_raw || !this.bootstrapKeys) {
      const saltCap = extractSaltFromCapId(this.capId);
      this.K_raw = await deriveKeyMaterial(this.S, saltCap);
      this.bootstrapKeys = deriveBootstrapKeys(this.K_raw);
    }

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
        this.lastRecvTs = Date.now(); // any inbound frame (incl. KEEPALIVE echo) proves liveness
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
            // Reset backoff, start the heartbeat, and fire onReconnected if this
            // socket replaced a dropped one.
            this._handleConnected();

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
          // WINDOW_CTL is a session-scoped control channel (no per-stream sid),
          // so intercept it here BEFORE the per-stream dispatch. It rides the
          // SESSION GLOBAL counter (like AUTH_PW), not a per-stream counter.
          if (frame.type === FrameType.WINDOW_CTL) {
            try {
              const aad = frameAad(FrameType.WINDOW_CTL, AeadDir.ServerToClient);
              const plaintext = await streamAeadDecrypt(this.keys.K_enc, frame.payload, aad);
              const decrypted = decode(plaintext) as any;
              this.counters.incoming.validate(decrypted.ctr);
              const msg = decrypted.msg;
              if (msg && msg.kind === 'window-state') {
                const state = msg as WindowStateBody;
                // PER-VIEWPORT routing: with multiple pty streams on one
                // connection, a window-state carries the viewport's `sid` so it
                // reaches the OWNING terminal handle's own subscribers. Missing
                // sid (legacy single-viewport server) falls through to the global
                // handlers below.
                const sid = (state as { sid?: string }).sid;
                if (sid) {
                  const child = this.children.get(sid);
                  if (child) child._onWindowState(state);
                }
                // Global handlers stay for back-compat (single-workspace tab bar).
                this.lastWindowState = state;
                for (const cb of this.windowStateHandlers) {
                  try { cb(state); } catch {}
                }
              }
            } catch {
              // Ignore malformed/out-of-order window-state; the next broadcast
              // resyncs the tab bar.
            }
            continue;
          }
          // After auth, dispatch frames to children
          await this.dispatchFrame(frame);
        }
      };

      this.ws!.onerror = () => reject(new Error('WebSocket error'));
      this.ws!.onclose = () => {
        this.ws = null;
        this._stopHeartbeat();
        this._handleDisconnected();
        // Auto-reconnect unless this was an intentional close.
        if (!this.intentionalClose) this.scheduleReconnect();
      };
    });
  }

  /**
   * Invalidate EVERY piece of per-session state the moment the socket drops. Session keys and
   * counters are per-session by design (fresh HKDF salt each AUTH), so nothing from the old
   * session may leak into the next one: a send with stale keys arrives "before authentication",
   * and a stale stream id / counter trips the agent's replay defense, which terminates the NEW
   * session — a reconnect loop. (The old frame-reload-on-reconnect design rebuilt this object on
   * every drop, which is why none of this state used to need explicit invalidation.)
   */
  private _handleDisconnected(): void {
    this.authenticated = false;
    this.keys = null; // gate every send until the new session's keys exist
    this.passwordVerified = false; // the agent re-verifies per session
    this.counters = new BidirectionalCounters();
    this.streamCounters = new StreamCounters();
    this.reader = new FrameReader(); // a partial frame from the cut socket must not prefix the next one
    if (this.pwReject) this._settlePassword(new Error('disconnect'));
    // Inform children of disconnect (their streams are dead; consumers re-open
    // fresh pipes on the onReconnected event).
    for (const child of this.children.values()) child._onError('disconnect');
    this.children.clear();
    // Fail any in-flight opens so awaiters don't hang forever.
    for (const child of this.pendingOpens.splice(0)) child._onError('disconnect');
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

  /**
   * Open a forwarded-channel ('pipe') stream to a named agent-side endpoint.
   * Mirrors the Node connect client's `openPipe`: sends STREAM_OPEN
   * { v:1, kind:'open', sid, mode:'pipe', pipe:{ name } }, rebinds the sid on
   * `opened`, and routes inbound STREAM_DATA (channel 'stdout') to onData.
   * Returns an ergonomic Uint8Array duplex handle.
   */
  openPipe(name: string): BrowserPipe {
    const child = new BrowserChildProcess(this, '', [], {}, 'pipe', undefined, name);
    return new BrowserPipe(child);
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
    await this._enqueueSend(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keys || !this.authenticated) {
        child._onError('disconnect');
        return;
      }
      const sid = child._sid;
      // Start counters for this stream
      const ctr = this.streamCounters.increment(sid, 'outgoing');

      let openMsg: any;
    if (child._mode === 'pty') {
      // Multi-workspace selection: a `workspaceKey` (Locus tab id) rides
      // exec.argv[0] and the tab's directory rides exec.cwd, so the agent's
      // workspace resolver can pick/lazily-create the right SharedWorkspace
      // WITHOUT a protocol change. Both are optional: with neither, `exec` is
      // omitted entirely and the agent uses its single default workspace
      // (identical to the pre-multi-workspace wire).
      const wk = child._workspaceKey;
      const cwd = child._options.cwd;
      const argv = wk !== undefined ? [wk] : [];
      const needExec = wk !== undefined || cwd !== undefined;
      openMsg = {
        v: 1 as const,
        kind: 'open' as const,
        sid,
        mode: 'pty' as const,
        pty: { cols: child._ptyOptions!.cols, rows: child._ptyOptions!.rows },
        ...(needExec ? { exec: { argv, ...(cwd ? { cwd } : {}) } } : {}),
      };
    } else if (child._mode === 'pipe') {
      openMsg = {
        v: 1 as const,
        kind: 'open' as const,
        sid,
        mode: 'pipe' as const,
        pipe: { name: child._pipeName! },
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

      this.ws.send(encodeFrame(FrameType.STREAM_OPEN, ciphertext));
      // Track pending open to bind when 'opened' arrives with actual sid
      this.pendingOpens.push(child);
    });
  }

  // Split outbound stream bytes so no wire frame can approach the protocol's MAX_FRAME_BYTES
  // (1MB): the receiving FrameReader silently DISCARDS an oversized frame, and the resulting
  // counter gap trips the agent's replay defense, which terminates the whole session — seen
  // live when vscode wrote its multi-MB extensions cache through the preview tunnel. 256KB
  // leaves ample headroom for CBOR + AEAD overhead. Pipes are byte streams, so splitting is
  // invisible to the receiver.
  private static readonly DATA_CHUNK_MAX = 256 * 1024;

  _sendData(sid: string, chunk: Uint8Array): void {
    // Copy before queueing: encryption is deferred to the send queue, and the caller may reuse
    // its buffer the moment write() returns. Splitting shares the same copy via subarrays.
    const bytes = chunk.slice();
    for (let off = 0; ; off += EntangleConnection.DATA_CHUNK_MAX) {
      const part = bytes.subarray(off, off + EntangleConnection.DATA_CHUNK_MAX);
      this._sendDataFrame(sid, part);
      if (off + EntangleConnection.DATA_CHUNK_MAX >= bytes.length) break;
    }
  }

  private _sendDataFrame(sid: string, chunk: Uint8Array): void {
    void this._enqueueSend(async () => {
      if (!this._canSendStream(sid)) return;
      const ctr = this.streamCounters.increment(sid, 'outgoing');
      const msg = { ctr, msg: { v: 1 as const, kind: 'data' as const, sid, chunk } };
      const aad = frameAad(FrameType.STREAM_DATA, AeadDir.ClientToServer);
      const ct = await streamAeadEncrypt(this.keys!.K_enc, encode(msg), aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_DATA, ct));
    });
  }

  _sendSignal(sid: string, signal: SignalName): void {
    void this._enqueueSend(async () => {
      if (!this._canSendStream(sid)) return;
      const ctr = this.streamCounters.increment(sid, 'outgoing');
      const msg = { ctr, msg: { v: 1 as const, kind: 'signal' as const, sid, signal } };
      const aad = frameAad(FrameType.STREAM_SIGNAL, AeadDir.ClientToServer);
      const ct = await streamAeadEncrypt(this.keys!.K_enc, encode(msg), aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_SIGNAL, ct));
    });
  }

  _sendResize(sid: string, cols: number, rows: number): void {
    void this._enqueueSend(async () => {
      if (!this._canSendStream(sid)) return;
      const ctr = this.streamCounters.increment(sid, 'outgoing');
      const msg = { ctr, msg: { v: 1 as const, kind: 'pty-resize' as const, sid, cols, rows } };
      const aad = frameAad(FrameType.STREAM_RESIZE, AeadDir.ClientToServer);
      const ct = await streamAeadEncrypt(this.keys!.K_enc, encode(msg), aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_RESIZE, ct));
    });
  }

  spawnPty(options: { cols: number; rows: number; cwd?: string; workspaceKey?: string }): BrowserChildProcess {
    return new BrowserChildProcess(
      this,
      '',
      [],
      options.cwd ? { cwd: options.cwd } : {},
      'pty',
      { cols: options.cols, rows: options.rows },
      undefined,
      options.workspaceKey
    );
  }

  _sendClose(sid: string): void {
    void this._enqueueSend(async () => {
      if (!this._canSendStream(sid)) return;
      const ctr = this.streamCounters.increment(sid, 'outgoing');
      const msg = { ctr, msg: { v: 1 as const, kind: 'close' as const, sid } };
      const aad = frameAad(FrameType.STREAM_CLOSE, AeadDir.ClientToServer);
      const ct = await streamAeadEncrypt(this.keys!.K_enc, encode(msg), aad);
      this.ws!.send(encodeFrame(FrameType.STREAM_CLOSE, ct));
    });
  }

  // Register a tab-bar subscriber. Immediately replays the last known state (if
  // any) so a late-mounting React component doesn't miss the initial broadcast.
  // Returns an unsubscribe function.
  onWindowState(cb: (state: WindowStateBody) => void): () => void {
    this.windowStateHandlers.add(cb);
    if (this.lastWindowState) {
      try { cb(this.lastWindowState); } catch {}
    }
    return () => { this.windowStateHandlers.delete(cb); };
  }

  // Send a client->server window operation on the WINDOW_CTL channel. Framed
  // like STREAM_* (stream AEAD + CBOR `{ ctr, msg }`) but on the SESSION GLOBAL
  // counter (like AUTH_PW), since window ops are not stream-scoped. `sid` is the
  // optional target pty-viewport: with multiple terminals on one connection the
  // op must name which one it drives (additive protocol field). Omitted for the
  // legacy global controls, where the agent applies it to its only viewport.
  async sendWindowOp(op: string, extra: Record<string, unknown> = {}, sid?: string): Promise<void> {
    await this.ensureConnected();
    await this._enqueueSend(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.keys || !this.authenticated) return;
      const plaintext = encode({
        ctr: this.counters.outgoing.next(),
        msg: { v: 1 as const, kind: 'op' as const, op, ...extra, ...(sid !== undefined ? { sid } : {}) },
      });
      const aad = frameAad(FrameType.WINDOW_CTL, AeadDir.ClientToServer);
      const ct = await streamAeadEncrypt(this.keys.K_enc, plaintext, aad);
      this.ws.send(encodeFrame(FrameType.WINDOW_CTL, ct));
    });
  }
}

class BrowserChildProcess {
  private emitter = new Emitter();
  public _sid: string;
  // Per-stream window-state subscribers. A pty terminal that belongs to its own
  // workspace (multi-workspace) gets its OWN tab bar here, routed by sid, instead
  // of the connection-global handler which mixes every workspace together.
  private windowStateHandlers = new Set<(state: WindowStateBody) => void>();
  private lastWindowState: WindowStateBody | null = null;
  constructor(
    private conn: EntangleConnection,
    public _command: string,
    public _args: string[],
    public _options: SpawnOptions,
    public _mode: 'cmd' | 'pty' | 'pipe' = 'cmd',
    public _ptyOptions?: { cols: number; rows: number },
    public _pipeName?: string,
    // Multi-workspace selector (a Locus tab id) for pty streams; rides
    // exec.argv[0] in the open message so the agent's resolver picks the
    // workspace this terminal attaches to.
    public _workspaceKey?: string
  ) {
    this._sid = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    // Initiate open asap. The rejection MUST be handled here: `_openChild` awaits
    // `ensureConnected()`, which rejects whenever the handshake fails — so against an unreachable
    // agent every spawn/openPipe would otherwise raise an unhandled rejection. Surfacing it as a
    // stream 'error' is both the honest signal and what keeps one dead connection from taking the
    // page down (Playwright's `pageerror` and some embedders treat unhandled rejections as fatal).
    void this.conn._openChild(this).catch((e: any) => this._onError(e?.message || 'connect failed'));
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
  on(event: 'opened', handler: () => void): this;
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

  // --- Per-stream shared-workspace controls (this terminal's own tab bar) -----
  // These drive THIS pty viewport's window set on the agent, scoped by sending
  // the stream's own sid on the WINDOW_CTL op. Inbound window-state for this sid
  // is delivered to onWindowState subscribers, so each terminal handle manages
  // its workspace independently of any other terminal on the same connection.

  /**
   * Subscribe to this terminal's window-state (tab bar) pushes. Immediately
   * replays the last known state so a late subscriber isn't left blank. Returns
   * an unsubscribe function.
   */
  onWindowState(cb: (state: WindowStateBody) => void): () => void {
    this.windowStateHandlers.add(cb);
    if (this.lastWindowState) { try { cb(this.lastWindowState); } catch {} }
    return () => { this.windowStateHandlers.delete(cb); };
  }
  /** Create a new window and switch this terminal onto it. */
  newWindow(): Promise<void> { return this.conn.sendWindowOp('new-window', {}, this._sid); }
  /** Switch this terminal to its next window (wraps). */
  nextWindow(): Promise<void> { return this.conn.sendWindowOp('next-window', {}, this._sid); }
  /** Switch this terminal to its previous window (wraps). */
  prevWindow(): Promise<void> { return this.conn.sendWindowOp('prev-window', {}, this._sid); }
  /** Switch this terminal to window `index`. */
  selectWindow(index: number): Promise<void> { return this.conn.sendWindowOp('select-window', { index }, this._sid); }
  /** Close window `index` in this terminal's workspace. */
  closeWindow(index: number): Promise<void> { return this.conn.sendWindowOp('close-window', { index }, this._sid); }
  /** Rename window `index` in this terminal's workspace. */
  renameWindow(index: number, title: string): Promise<void> { return this.conn.sendWindowOp('rename-window', { index, title }, this._sid); }

  // Internal events from connection
  _onOpened() { this.emitter.emit('opened'); }
  _onData(chunk: Uint8Array, channel: 'stdout' | 'stderr' = 'stdout') { this.emitter.emit('data', chunk, channel); }
  _onExit(code: number | null, signal: string | null) { this.emitter.emit('exit', code, signal); }
  _onError(message: string) { this.emitter.emit('error', message); }
  _onClosed() {}
  /** Deliver a window-state push routed to this stream's sid. */
  _onWindowState(state: WindowStateBody) {
    this.lastWindowState = state;
    for (const cb of this.windowStateHandlers) { try { cb(state); } catch {} }
  }
}

/**
 * Ergonomic Uint8Array duplex over a `pipe`-mode stream — the browser sibling of
 * the Node connect client's pipe `StreamHandle`. Data is bytes in both
 * directions (no channels, no exit codes to speak of): `write()` sends
 * STREAM_DATA, inbound STREAM_DATA (channel 'stdout') fans out to onData
 * callbacks, socket close surfaces as onClose, and STREAM_ERROR as onError.
 * `@locus/web`'s entangle-transport adapts this to its `DuplexBytes` seam.
 */
class BrowserPipe {
  constructor(private child: BrowserChildProcess) {}
  /** Underlying stream id (provisional until `onOpen`, then agent-assigned). */
  get sid(): string { return this.child._sid; }
  /** Send bytes to the remote endpoint. */
  write(chunk: Uint8Array): void { this.child.stdin.write(chunk); }
  /** Register an inbound-bytes handler (may be called multiple times). */
  onData(cb: (chunk: Uint8Array) => void): this { this.child.on('data', (c: Uint8Array) => cb(c)); return this; }
  /** Fires once the agent confirms the pipe is bridged (STREAM_OPENED). */
  onOpen(cb: () => void): this { this.child.on('opened', cb); return this; }
  /** Fires when the pipe closes (socket close → STREAM_EXIT). */
  onClose(cb: () => void): this { this.child.on('exit', () => cb()); return this; }
  /** Fires on a bridge/allow-list error (e.g. Unknown pipe: <name>). */
  onError(cb: (message: string) => void): this { this.child.on('error', cb); return this; }
  /** Tear the pipe down (STREAM_CLOSE). */
  close(): void { this.child.close(); }
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

/**
 * The methods every capability connection exposes. `window.entangle` re-exports the DEFAULT
 * client's methods flat (the URL-derived capability), so single-capability pages are unaffected;
 * `window.entangle.connect(capId, S)` returns one of these per additional capability.
 */
const FLAT_KEYS = [
  'spawn', 'exec', 'execCommand', 'withCwd', 'openTerminal', 'openPipe',
  'onStatus', 'onReconnected', 'connectionStatus', 'disconnect', 'ensureConnected',
  'newWindow', 'nextWindow', 'prevWindow', 'selectWindow', 'closeWindow', 'onWindowState',
] as const;

// Attach to window
(() => {
  const entangle: any = window.entangle || (window.entangle = {});
  /** capId -> client. One connection per capability; `connect` is idempotent by capId. */
  const clients = new Map<string, any>();
  let defaultClient: any = null;
  const clientsChangedHandlers = new Set<(capIds: string[]) => void>();
  const anyStatusHandlers = new Set<(capId: string, status: string) => void>();

  function notifyClientsChanged(): void {
    const ids = [...clients.keys()];
    for (const cb of clientsChangedHandlers) { try { cb(ids); } catch {} }
  }

  /**
   * Open (or return the existing) client for a capability.
   *
   * Idempotent by capId, and deliberately does NOT check that a repeat call passes the same
   * secret: the capId IS the Argon2 salt, so a mismatched secret could never authenticate anyway,
   * and returning the live client beats tearing down its streams because a stale URL was re-pasted.
   *
   * Constructing a client is cheap — EntangleConnection dials lazily on first stream open — so a
   * host list may be connected up front without paying N handshakes. Do not call methods on a
   * client until you actually want that machine dialled.
   */
  entangle.connect = (capId: string, S: string): any => {
    if (typeof capId !== 'string' || capId === '') throw new Error('connect: capId required');
    if (typeof S !== 'string' || S === '') throw new Error('connect: secret required');
    const existing = clients.get(capId);
    if (existing) return existing;
    const client = createClient(new EntangleConnection(capId, S), capId);
    clients.set(capId, client);
    notifyClientsChanged();
    return client;
  };
  entangle.getClient = (capId: string): any => clients.get(capId);
  entangle.clients = (): any[] => [...clients.values()];
  /** Close and forget a client. The default client is closed but kept, so the flat surface stays valid. */
  entangle.disconnectClient = (capId: string): void => {
    const client = clients.get(capId);
    if (!client) return;
    try { client.disconnect(); } catch {}
    if (client !== defaultClient) { clients.delete(capId); notifyClientsChanged(); }
  };
  entangle.onClientsChanged = (cb: (capIds: string[]) => void): (() => void) => {
    clientsChangedHandlers.add(cb);
    try { cb([...clients.keys()]); } catch {}
    return () => clientsChangedHandlers.delete(cb);
  };
  /** Status fan-out across every client, present and future — for a host-list UI. */
  entangle.onAnyStatus = (cb: (capId: string, status: string) => void): (() => void) => {
    anyStatusHandlers.add(cb);
    for (const client of clients.values()) {
      try { cb(client.capId, client.connectionStatus()); } catch {}
    }
    return () => anyStatusHandlers.delete(cb);
  };
  /** Capability probe for embedders: feature-detect on this, never on a version string. */
  entangle.features = ['multi-connect', 'per-client-password'];

  /**
   * Late capability injection: a host page can supply the capability when the URL carries none —
   * e.g. Locus's preview bootstrap opened at the origin ROOT restores it from origin-scoped
   * storage (the preview origin is derived from the capId, so storage there can never yield a
   * foreign capability). The client itself never persists the secret; where it comes from is the
   * embedder's policy.
   *
   * Re-supplying the SAME capability is a no-op success, because the bootstrap can legitimately
   * run twice (bfcache restore, re-entrant boot). A DIFFERENT capability is refused: live pipes
   * and terminals are bound to the default client, so silently re-pointing it would strand them.
   * Callers wanting a second capability want `connect()` instead. (This previously returned true
   * in that case while ignoring the argument.)
   */
  entangle.setCapability = (capId: string, S: string): boolean => {
    if (typeof capId !== 'string' || capId === '' || typeof S !== 'string' || S === '') return false;
    if (defaultClient) return defaultClient.capId === capId;
    attachDefault(capId, S);
    return true;
  };

  const cap = parseCapabilityFromUrl();
  if (!cap) {
    // Lazy erroring stubs until (unless) a capability is injected via setCapability. Cover the
    // whole flat surface, so a capability-less page reports the real reason rather than
    // "openTerminal is not a function".
    for (const key of FLAT_KEYS) {
      entangle[key] = () => { throw new Error('Capability not found in URL'); };
    }
  } else {
    attachDefault(cap.capId, cap.S);
  }
  return;

  /**
   * Promote a capability to the DEFAULT client and re-export its methods as the flat
   * `window.entangle.*` surface, so every pre-multi-connect consumer keeps working verbatim.
   */
  function attachDefault(capId: string, S: string): void {
    const client = entangle.connect(capId, S);
    defaultClient = client;
    for (const key of FLAT_KEYS) entangle[key] = client[key];
    entangle.capId = capId;
    // `window.entangle.password = pw` (entangle's own SPA) must reach the default CONNECTION now
    // that each one carries its own. Capture any value set before this script ran.
    const preset = Object.getOwnPropertyDescriptor(entangle, 'password')?.value;
    Object.defineProperty(entangle, 'password', {
      get: () => client.password,
      set: (v: string | undefined) => { client.password = v; },
      enumerable: true,
      configurable: true,
    });
    if (preset !== undefined) client.password = preset;
  }

  function createClient(conn: EntangleConnection, capId: string): any {
  const api: any = { capId };
  conn.onStatus((s: string) => {
    for (const cb of anyStatusHandlers) { try { cb(capId, s); } catch {} }
  });
  Object.defineProperty(api, 'password', {
    get: () => conn.getPassword(),
    set: (v: string | undefined) => conn.setPassword(v),
    enumerable: true,
    configurable: true,
  });
  api.spawn = (command: string, args: string[] = [], options: SpawnOptions = {}) => conn.spawn(command, args, options);
  // Interactive PTY session (used by the terminal UI). `workspaceKey` selects
  // which durable SharedWorkspace this terminal attaches to (multi-workspace):
  // a single connection can host several, each keyed by a Locus tab id, with
  // `cwd` as that workspace's directory. Omit the key for the single default
  // workspace (back-compat). The returned handle exposes its OWN per-terminal
  // window controls + onWindowState, scoped to this stream.
  api.openTerminal = (options: { cols: number; rows: number; cwd?: string; workspaceKey?: string }) => conn.spawnPty(options);
  // Forwarded channel: open a named agent-side pipe as a byte duplex.
  api.openPipe = (name: string) => conn.openPipe(name);

  // --- Connection resilience surface ---
  // The socket now auto-reconnects (exp backoff + jitter) with an app-level
  // heartbeat. Consumers observe transitions via onStatus and, crucially,
  // re-open their pipes / re-attach on onReconnected (streams don't survive a
  // reconnect — the session keys and stream ids are renegotiated).
  api.onStatus = (cb: (s: string) => void) => conn.onStatus(cb);
  api.onReconnected = (cb: () => void) => conn.onReconnected(cb);
  api.connectionStatus = () => conn.getStatus();
  api.disconnect = () => conn.close();
  // Reconnect NOW, jumping the exponential backoff. A consumer that sees the network return (the
  // browser's `online` event) can call this so a woken laptop / regained signal reconnects at once
  // instead of sitting out a backoff window of up to RC_CAP. Idempotent — resolves immediately when
  // the socket is already open — and re-enables reconnection if a prior `disconnect()` disabled it.
  api.ensureConnected = () => conn.ensureConnected();

  // Shared-workspace window controls (tmux-style tab bar). These drive the
  // server SharedWorkspace over the WINDOW_CTL channel; window-state broadcasts
  // flow back through onWindowState so every client's tab bar stays in sync.
  api.newWindow = () => conn.sendWindowOp('new-window');
  api.nextWindow = () => conn.sendWindowOp('next-window');
  api.prevWindow = () => conn.sendWindowOp('prev-window');
  api.selectWindow = (index: number) => conn.sendWindowOp('select-window', { index });
  api.closeWindow = (index: number) => conn.sendWindowOp('close-window', { index });
  api.onWindowState = (cb: (state: WindowStateBody) => void) => conn.onWindowState(cb);

  // Helper: execute a command line via shell and await completion
  api.execCommand = async (
    commandLine: string,
    options: Omit<SpawnOptions, 'shell'> & { encoding?: 'utf-8' | null } = {}
  ) => {
    return await execImpl('sh', ['-lc', commandLine], options);
  };

  // Helper: bind a default working directory
  api.withCwd = (cwd: string) => {
    return {
      spawn: (command: string, args: string[] = [], options: SpawnOptions = {}) => conn.spawn(command, args, { ...options, cwd }),
      exec: async (command: string, args: string[] = [], options: SpawnOptions & { encoding?: 'utf-8' | null } = {}) =>
        await execImpl(command, args, { ...options, cwd }),
      execCommand: async (commandLine: string, options: Omit<SpawnOptions, 'shell'> & { encoding?: 'utf-8' | null } = {}) =>
        await execImpl('sh', ['-lc', commandLine], { ...options, cwd }),
    };
  };

  // Awaitable convenience: run a command and resolve with output and exit
  // Note: stdout and stderr are merged in the current protocol.
  //
  // `execImpl` is a hoisted declaration bound to THIS connection's `conn`, and every helper above
  // routes through it rather than through `api.exec`. Reading the method back off the window
  // global would send the command to whichever connection happens to own the global — which is
  // this one today, but silently the WRONG MACHINE once a second connection exists.
  api.exec = execImpl;
  async function execImpl(
    command: string,
    args: string[] = [],
    options: SpawnOptions & { encoding?: 'utf-8' | null } = {}
  ): Promise<{ code: number | null; signal: string | null; stdout: Uint8Array; text?: string }> {
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
  }
  return api;
  } // end createClient
})();

export {};
