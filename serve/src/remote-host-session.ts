import type { Socket } from 'net';
import type { WindowStateBody } from '@thenewlabs/entangle-protocol';
import type { HostSession } from './host-session.js';
import {
  createMessageReader,
  decodeChunk,
  encodeChunk,
  writeMessage,
  type DaemonToClient,
  type IpcMessage,
} from './ipc.js';

/** Cap on the client-side mirror of the captured-log ring buffer. */
const DEBUG_MAX_LINES = 1000;

/** Empty window-state used before the daemon's first window-state frame arrives. */
const EMPTY_WINDOW_STATE: WindowStateBody = {
  v: 1,
  kind: 'window-state',
  windows: [],
  activeIndex: 0,
};

/**
 * The socket-backed {@link HostSession}: the CLIENT half of the daemon/client
 * split. It renders the SAME host UI (host-terminal.ts) that {@link LocalHostSession}
 * does, but every read is a cached value fed by the daemon over a local unix
 * socket and every action is a framed message written back to it.
 *
 * On construction it sends a `hello` (so the daemon learns the client's terminal
 * size) and starts decoding {@link DaemonToClient} frames: live output, the
 * post-attach replay, window-state, viewer count, captured logs, the session URL
 * and the terminal exit. State the UI reads synchronously ({@link getReplay},
 * {@link windowState}, {@link viewerCount}, {@link getUrl}, {@link getLogBuffer})
 * is cached from those frames; the daemon sends the current state immediately on
 * connect so these populate before the first paint.
 */
export class RemoteHostSession implements HostSession {
  private readonly socket: Socket;

  // Cached state fed by daemon frames; read synchronously by the host UI.
  private replay: Uint8Array = new Uint8Array(0);
  private winState: WindowStateBody = EMPTY_WINDOW_STATE;
  private viewers = 0;
  private url: string | null = null;
  private readonly logBuf: string[] = [];

  // The host UI registers exactly one callback per event; mirror the
  // SharedWorkspace single-callback surface it binds against.
  private hostDataCb?: (chunk: Buffer) => void;
  private windowStateCb?: (s: WindowStateBody) => void;
  private viewersCb?: (n: number) => void;
  private logCb?: (line: string) => void;
  private urlCb?: (url: string) => void;
  private exitCb?: (code: number | null, signal: string | null) => void;
  private frameCb?: (frame: Uint8Array) => void;
  private scrollbackCb?: (lines: string[]) => void;

  // Guards: `exited` makes the onExit path fire at most once (a clean `exit`
  // frame or an unexpected socket close, whichever comes first); `closed` stops
  // any send after the socket is gone.
  private exited = false;
  private closed = false;
  private pendingExitCode: number | null = null;
  /** Why the daemon said it was ending, from its `exit` frame (see exitReason). */
  private reason: string | null = null;

  constructor(socket: Socket, initial: { cols: number; rows: number }) {
    this.socket = socket;

    createMessageReader(
      socket,
      (msg) => this.dispatch(msg),
      () => this.handleClose(null), // protocol error → treat as an unexpected close
    );
    socket.on('close', () => this.handleClose(this.pendingExitCode));
    socket.on('error', () => { /* surfaced via 'close'; nothing to do here */ });

    this.send({ t: 'hello', cols: initial.cols, rows: initial.rows });
  }

  // --- inbound daemon → client ---------------------------------------------

  private dispatch(msg: IpcMessage): void {
    // Only DaemonToClient frames arrive on a client socket; the daemon never
    // sends ClientToDaemon frames back, so narrow by the discriminants we own.
    const m = msg as DaemonToClient;
    switch (m.t) {
      case 'data':
        this.hostDataCb?.(decodeChunk(m.chunk));
        break;
      case 'replay':
        // Cached for getReplay(); NOT fed to onHostData — the host UI writes the
        // replay itself once, via getReplay(), at go-live. ALSO fire onFrame so a
        // `refresh` response repaints (the daemon answers `refresh` with a fresh
        // `replay` frame). The post-attach replay also lands here, but the host's
        // onFrame handler ignores frames unless it's live and on the shell view,
        // so that initial one is a harmless no-op.
        this.replay = decodeChunk(m.chunk);
        this.frameCb?.(this.replay);
        break;
      case 'window-state':
        this.winState = m.state;
        this.windowStateCb?.(m.state);
        break;
      case 'viewers':
        this.viewers = m.n;
        this.viewersCb?.(m.n);
        break;
      case 'log':
        this.logBuf.push(m.line);
        if (this.logBuf.length > DEBUG_MAX_LINES) {
          this.logBuf.splice(0, this.logBuf.length - DEBUG_MAX_LINES);
        }
        this.logCb?.(m.line);
        break;
      case 'url':
        this.url = m.url;
        this.urlCb?.(m.url);
        break;
      case 'scrollback':
        this.scrollbackCb?.(m.lines);
        break;
      case 'exit':
        // Record the clean exit code (and the daemon's stated reason) so a
        // following socket 'close' reports it, then fire the exit path now.
        this.pendingExitCode = m.code;
        if (m.reason) this.reason = m.reason;
        this.fireExit(m.code, null);
        break;
    }
  }

  /** Fire the one-shot exit callback (idempotent). */
  private fireExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.(code, signal);
  }

  /** Socket gone: fire exit (with a clean code if an `exit` frame preceded it). */
  private handleClose(code: number | null): void {
    this.closed = true;
    this.fireExit(code, null);
  }

  // --- outbound client → daemon --------------------------------------------

  /** Write a framed message, swallowing sends after the socket has closed. */
  private send(msg: IpcMessage): void {
    if (this.closed) return;
    try {
      writeMessage(this.socket, msg);
    } catch {
      // A write on a half-closed socket can throw; treat as closed.
      this.closed = true;
    }
  }

  // --- terminal ------------------------------------------------------------
  onHostData(cb: (chunk: Buffer) => void): void { this.hostDataCb = cb; }
  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.send({ t: 'input', data: encodeChunk(bytes) });
  }
  resize(cols: number, rows: number): void { this.send({ t: 'resize', cols, rows }); }
  // The daemon already serialized the frame it sent us; return that cached bytes
  // regardless of `opts` (the scrollback was chosen daemon-side at attach time).
  getReplay(_opts?: { scrollback?: number }): Uint8Array { return this.replay; }
  onFrame(cb: (frame: Uint8Array) => void): void { this.frameCb = cb; }
  // Ask the daemon to serialize this viewport's active window NOW; the fresh
  // frame arrives as a `replay` frame and fires onFrame (see dispatch).
  requestFrame(opts?: { scrollback?: number }): void {
    this.send(opts?.scrollback !== undefined ? { t: 'refresh', scrollback: opts.scrollback } : { t: 'refresh' });
  }
  onScrollback(cb: (lines: string[]) => void): void { this.scrollbackCb = cb; }
  // Ask the daemon for this viewport's active-window scrollback NOW; the lines
  // arrive as a `scrollback` frame and fire onScrollback (see dispatch).
  requestScrollback(): void { this.send({ t: 'scrollback' }); }

  // --- windows -------------------------------------------------------------
  onWindowState(cb: (s: WindowStateBody) => void): void { this.windowStateCb = cb; }
  windowState(): WindowStateBody { return this.winState; }
  newWindow(): void { this.send({ t: 'win', op: 'new' }); }
  nextWindow(): void { this.send({ t: 'win', op: 'next' }); }
  prevWindow(): void { this.send({ t: 'win', op: 'prev' }); }
  selectWindow(i: number): void { this.send({ t: 'win', op: 'select', index: i }); }
  closeWindow(i: number): void { this.send({ t: 'win', op: 'close', index: i }); }

  // --- viewers -------------------------------------------------------------
  onViewersChange(cb: (n: number) => void): void { this.viewersCb = cb; }
  viewerCount(): number { return this.viewers; }

  // --- logs (debug tab) ----------------------------------------------------
  onLog(cb: (line: string) => void): void { this.logCb = cb; }
  getLogBuffer(): readonly string[] { return this.logBuf; }

  // --- url -----------------------------------------------------------------
  getUrl(): string | null { return this.url; }
  onUrl(cb: (url: string) => void): void { this.urlCb = cb; }

  // --- lifecycle -----------------------------------------------------------
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCb = cb; }

  /**
   * Why the session ended, as stated by the daemon's `exit` frame — or null
   * when the socket simply dropped without one (an older daemon, or a daemon
   * that died without shutting down cleanly), which is itself diagnostic.
   */
  exitReason(): string | null { return this.reason; }

  /**
   * Detach without ending the daemon session: tell the daemon to drop this
   * client (it keeps running), end the socket, then run the local exit path so
   * the host UI tears its terminal down (host-terminal's restore() runs on exit).
   */
  detach(): void {
    this.send({ t: 'detach' });
    this.closed = true;
    try { this.socket.end(); } catch { /* already ending */ }
    this.fireExit(null, null);
  }

  /**
   * End the WHOLE session (host UI Ctrl-B q): ask the daemon to shut down. The
   * daemon broadcasts `exit` and closes the sockets, which drives this client's
   * normal exit path — so no local teardown here.
   */
  kill(): void {
    this.send({ t: 'kill' });
  }

  /** Tear down: end the socket (no exit fired — the caller is disposing us). */
  dispose(): void {
    this.closed = true;
    try { this.socket.end(); } catch { /* already ending */ }
  }
}
