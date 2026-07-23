import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type WebSocket from 'ws';
import { OutputHandler } from '@thenewlabs/entangle-utils';

/**
 * Agent-side public-share controller.
 *
 * A public share exposes a LOCAL http target (e.g. 127.0.0.1:3000) on a
 * user-chosen subdomain of the relay, as PLAINTEXT — there is deliberately no
 * end-to-end encryption here (a capability's `#S=` secret is not involved). The
 * relay terminates public HTTP and forwards each request to this agent over the
 * agent-token-authenticated control socket; this controller dials the local
 * target and streams the response back.
 *
 * Security posture:
 *  - The target host:port is supplied ONLY by the embedder via `announce()`
 *    (in-process, i.e. the local user's own choice). The wire protocol carries a
 *    `shareId`, never a target, so a public client cannot point the tunnel at an
 *    arbitrary address — there is no SSRF surface reachable from outside.
 *  - This path never touches the E2E-encrypted STREAM_* machinery or any
 *    capability secret; it is a separate, explicitly-plaintext feature.
 */

export interface ShareTarget {
  host: string;
  port: number;
}

export interface ShareEntry {
  shareId: string;
  subdomain: string;
  target: ShareTarget;
  url?: string;
}

export type AnnounceResult =
  | { ok: true; shareId: string; subdomain: string; url: string }
  | { ok: false; reason: string };

export type AvailabilityResult = { available: boolean; reason?: string };

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MAX_BODY_CHUNK = 256 * 1024;
const CONTROL_TIMEOUT_MS = 10000;

function newId(): string {
  return randomBytes(9).toString('base64url');
}

export class PublicShareController {
  private shares = new Map<string, ShareEntry>(); // shareId -> entry
  private activeRequests = new Map<string, http.ClientRequest>(); // reqId -> upstream
  private pendingAnnounce = new Map<string, (r: AnnounceResult) => void>(); // shareId
  private pendingChecks = new Map<string, (r: AvailabilityResult) => void>(); // reqId

  constructor(
    private getWs: () => WebSocket | undefined,
    private output: OutputHandler,
  ) {}

  /** Currently-registered shares (for `share.list`). */
  list(): ShareEntry[] {
    return Array.from(this.shares.values());
  }

  /**
   * Reserve `subdomain` on the relay and route it to `target`. Resolves once the
   * relay confirms (or rejects) the reservation.
   */
  announce(subdomain: string, target: ShareTarget): Promise<AnnounceResult> {
    const shareId = newId();
    const entry: ShareEntry = { shareId, subdomain, target };
    this.shares.set(shareId, entry);
    return new Promise<AnnounceResult>((resolve) => {
      const done = (r: AnnounceResult) => {
        this.pendingAnnounce.delete(shareId);
        if (!r.ok) this.shares.delete(shareId);
        else entry.url = r.url;
        resolve(r);
      };
      this.pendingAnnounce.set(shareId, done);
      if (!this.send({ type: 'ANNOUNCE_SHARE', shareId, subdomain })) {
        done({ ok: false, reason: 'offline' });
        return;
      }
      setTimeout(() => {
        if (this.pendingAnnounce.has(shareId)) done({ ok: false, reason: 'timeout' });
      }, CONTROL_TIMEOUT_MS);
    });
  }

  /** Ask the relay whether `subdomain` is free. */
  checkAvailability(subdomain: string): Promise<AvailabilityResult> {
    const reqId = newId();
    return new Promise<AvailabilityResult>((resolve) => {
      const done = (r: AvailabilityResult) => {
        this.pendingChecks.delete(reqId);
        resolve(r);
      };
      this.pendingChecks.set(reqId, done);
      if (!this.send({ type: 'CHECK_SHARE', reqId, subdomain })) {
        done({ available: false, reason: 'offline' });
        return;
      }
      setTimeout(() => {
        if (this.pendingChecks.has(reqId)) done({ available: false, reason: 'timeout' });
      }, CONTROL_TIMEOUT_MS);
    });
  }

  /** Release a share by id. */
  revoke(shareId: string): boolean {
    const entry = this.shares.get(shareId);
    if (!entry) return false;
    this.shares.delete(shareId);
    this.send({ type: 'REVOKE_SHARE', subdomain: entry.subdomain });
    return true;
  }

  /**
   * Re-announce all live shares after an agent reconnect. The relay dropped this
   * agent's reservations when the previous socket closed, so they must be
   * re-established on the new socket (idempotent on the relay side).
   */
  reannounceAll(): void {
    for (const entry of this.shares.values()) {
      this.send({ type: 'ANNOUNCE_SHARE', shareId: entry.shareId, subdomain: entry.subdomain });
    }
  }

  /**
   * Handle a share control message from the relay. Returns true iff `msg` was a
   * share message (and has been handled here).
   */
  handleMessage(msg: any): boolean {
    switch (msg?.type) {
      case 'SHARE_ASSIGNED':
        this.pendingAnnounce.get(msg.shareId)?.({
          ok: true,
          shareId: msg.shareId,
          subdomain: msg.subdomain,
          url: msg.url,
        });
        return true;
      case 'SHARE_REJECTED':
        this.pendingAnnounce.get(msg.shareId)?.({ ok: false, reason: String(msg.reason ?? 'rejected') });
        return true;
      case 'SHARE_CHECK_RESULT':
        this.pendingChecks.get(msg.reqId)?.({
          available: !!msg.available,
          ...(msg.reason && { reason: String(msg.reason) }),
        });
        return true;
      case 'SHARE_REQUEST':
        this.startProxy(msg);
        return true;
      case 'SHARE_REQ_BODY': {
        const up = this.activeRequests.get(msg.reqId);
        if (up) up.write(Buffer.from(String(msg.chunk ?? ''), 'base64'));
        return true;
      }
      case 'SHARE_REQ_END': {
        const up = this.activeRequests.get(msg.reqId);
        if (up) up.end();
        return true;
      }
      case 'SHARE_ABORT': {
        const up = this.activeRequests.get(msg.reqId);
        if (up) up.destroy();
        this.activeRequests.delete(msg.reqId);
        return true;
      }
      default:
        return false;
    }
  }

  private startProxy(msg: any): void {
    const reqId: string = msg.reqId;
    const entry = this.shares.get(msg.shareId);
    if (!entry) {
      this.send({ type: 'SHARE_ERROR', reqId, message: 'unknown share' });
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries((msg.headers ?? {}) as Record<string, string | string[]>)) {
      if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    // Point Host at the local target so dev servers with host allow-lists (Vite,
    // webpack-dev-server) accept the request; preserve the public host for apps
    // that build absolute URLs from X-Forwarded-*.
    const originalHost = typeof headers.host === 'string' ? headers.host : undefined;
    headers.host = `${entry.target.host}:${entry.target.port}`;
    if (originalHost) headers['x-forwarded-host'] = originalHost;
    headers['x-forwarded-proto'] = 'https';

    const upstream = http.request(
      {
        host: entry.target.host,
        port: entry.target.port,
        method: msg.method || 'GET',
        path: msg.url || '/',
        headers,
      },
      (res) => {
        this.send({
          type: 'SHARE_RESPONSE',
          reqId,
          status: res.statusCode ?? 502,
          headers: this.filterResHeaders(res.rawHeaders),
        });
        res.on('data', (chunk: Buffer) => {
          for (let off = 0; off < chunk.length; off += MAX_BODY_CHUNK) {
            const slice = chunk.subarray(off, off + MAX_BODY_CHUNK);
            this.send({ type: 'SHARE_RES_BODY', reqId, chunk: slice.toString('base64') });
          }
        });
        res.on('end', () => {
          this.activeRequests.delete(reqId);
          this.send({ type: 'SHARE_RES_END', reqId });
        });
      },
    );
    upstream.on('error', (err) => {
      this.activeRequests.delete(reqId);
      this.output.warn(`Share upstream error: ${err instanceof Error ? err.message : String(err)}`);
      this.send({ type: 'SHARE_ERROR', reqId, message: 'upstream error' });
    });
    this.activeRequests.set(reqId, upstream);
  }

  private filterResHeaders(rawHeaders: string[]): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      const key = rawHeaders[i]!;
      const val = rawHeaders[i + 1]!;
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      const existing = out[key];
      if (existing === undefined) out[key] = val;
      else if (Array.isArray(existing)) existing.push(val);
      else out[key] = [existing, val];
    }
    return out;
  }

  private send(msg: unknown): boolean {
    const ws = this.getWs();
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.output.warn(`Failed to send share frame: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
