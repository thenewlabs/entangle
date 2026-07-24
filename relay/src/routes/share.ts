import type WebSocket from 'ws';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import type { RoutingState } from '../state/routing.js';
import { getRelayHooks } from '../hooks.js';
import { identityForAgent } from './agent.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// Headers that describe a specific hop's connection, not the message, and must
// not be forwarded across the proxy in either direction (RFC 7230 §6.1). Node
// manages framing/keep-alive itself.
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

/** Cap on the raw bytes carried per SHARE_REQ_BODY frame (base64 inflates ~4/3). */
const MAX_BODY_CHUNK = 256 * 1024;

/** How long a proxied request may run before the relay gives up (504). */
function shareTimeoutMs(): number {
  const raw = Number(process.env.RELAY_SHARE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
}

/** Global ceiling on concurrently in-flight proxied requests (memory guard). */
function maxPendingShares(): number {
  const raw = Number(process.env.RELAY_MAX_PENDING_SHARES);
  return Number.isFinite(raw) && raw > 0 ? raw : 2048;
}

interface PendingRequest {
  res: Response;
  agentId: string;
  // Subdomain (metering label) + shareId (routing id), remembered so response
  // bytes can be metered from the agent-message side where only reqId is known.
  subdomain: string;
  shareId: string;
  timeout: ReturnType<typeof setTimeout>;
  headersSent: boolean;
}

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function stripHopByHop(headers: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v as string | string[];
  }
  return out;
}

/**
 * Bridges public HTTP requests on a share subdomain to the owning agent over the
 * agent control WebSocket, and threads the agent's streamed response back to the
 * public client.
 *
 * This is the ONE place the relay is not blind: a public share is plaintext, so
 * the relay sees the proxied bytes (it never sees a capability secret, though —
 * routing is purely by subdomain → agent). The framing here is a small JSON
 * control protocol layered on the SAME agent socket used for capability routing;
 * it does not touch the E2E-encrypted STREAM_* path.
 */
export class ShareBridge {
  private pending = new Map<string, PendingRequest>();

  /**
   * @param enabled Whether public sharing is configured on this relay
   *   (RELAY_SHARE_HOST is set). When false, reservations and availability
   *   checks fail closed with reason `disabled` — nothing can be reserved that
   *   could never be routed.
   */
  constructor(private routing: RoutingState, private enabled = true) {}

  /**
   * Handle one public HTTP request addressed to `subdomain`. Fully owns the
   * response; never calls `next`.
   */
  handleHttpRequest(req: Request, res: Response, subdomain: string): void {
    const info = this.routing.lookupShare(subdomain);
    if (!info) {
      res.status(404).type('text/plain').send('No such share');
      return;
    }
    const agentWs = this.routing.getAgentWs(info.agentId);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
      res.status(502).type('text/plain').send('Share offline');
      return;
    }
    if (this.pending.size >= maxPendingShares()) {
      res.status(503).type('text/plain').send('Relay busy');
      return;
    }

    const reqId = newId();
    const timeout = setTimeout(() => {
      const p = this.pending.get(reqId);
      if (!p) return;
      this.finish(reqId);
      try { this.send(agentWs, { type: 'SHARE_ABORT', reqId }); } catch { /* best effort */ }
      if (!p.headersSent) p.res.status(504).type('text/plain').send('Share timed out');
      else p.res.end();
    }, shareTimeoutMs());

    this.pending.set(reqId, {
      res,
      agentId: info.agentId,
      subdomain,
      shareId: info.shareId,
      timeout,
      headersSent: false,
    });

    // If the public client goes away, abort the upstream request too.
    res.on('close', () => {
      if (!this.pending.has(reqId)) return;
      this.finish(reqId);
      try { this.send(agentWs, { type: 'SHARE_ABORT', reqId }); } catch { /* best effort */ }
    });

    this.send(agentWs, {
      type: 'SHARE_REQUEST',
      reqId,
      shareId: info.shareId,
      method: req.method,
      url: req.url,
      headers: stripHopByHop(req.headers as Record<string, unknown>),
    });

    // Stream the request body to the agent in bounded chunks.
    req.on('data', (chunk: Buffer) => {
      // Meter the public inbound (up) direction. Shares are a plaintext proxy by
      // design; the subdomain is the sub-meter label so each shared app tallies
      // separately. No capability secret is involved here.
      try {
        getRelayHooks().meter?.({
          capId: info.shareId,
          source: 'share',
          direction: 'up',
          bytes: chunk.length,
          label: subdomain,
        });
      } catch { /* metering must never break the proxy */ }
      for (let off = 0; off < chunk.length; off += MAX_BODY_CHUNK) {
        const slice = chunk.subarray(off, off + MAX_BODY_CHUNK);
        this.send(agentWs, { type: 'SHARE_REQ_BODY', reqId, chunk: slice.toString('base64') });
      }
    });
    req.on('end', () => {
      if (this.pending.has(reqId)) this.send(agentWs, { type: 'SHARE_REQ_END', reqId });
    });
    req.on('error', () => {
      if (!this.pending.has(reqId)) return;
      this.finish(reqId);
      try { this.send(agentWs, { type: 'SHARE_ABORT', reqId }); } catch { /* best effort */ }
    });
  }

  /**
   * Handle a share control/response message arriving from an agent. `agentId` is
   * the authenticated owner of the socket; every response is checked against the
   * pending request's recorded owner so one agent cannot answer another's
   * request. Returns true iff the message was a share message (handled here).
   */
  handleAgentMessage(agentId: string, msg: any, agentWs: WebSocket): boolean {
    switch (msg?.type) {
      case 'ANNOUNCE_SHARE': {
        if (!this.enabled) {
          this.send(agentWs, { type: 'SHARE_REJECTED', shareId: msg.shareId, reason: 'disabled' });
          return true;
        }
        const result = this.routing.reserveShare(agentId, msg.subdomain, msg.shareId);
        if (result.ok) {
          this.send(agentWs, {
            type: 'SHARE_ASSIGNED',
            shareId: msg.shareId,
            subdomain: result.subdomain,
            url: shareUrl(result.subdomain),
          });
          // Bind the share to its owning identity so its metered bytes attribute to that user.
          const identityId = identityForAgent(agentId);
          if (identityId) {
            try {
              getRelayHooks().onShareRegistered?.({ shareId: String(msg.shareId), subdomain: result.subdomain, identityId });
            } catch { /* a hook must never break share reservation */ }
          }
        } else {
          this.send(agentWs, { type: 'SHARE_REJECTED', shareId: msg.shareId, reason: result.reason });
        }
        return true;
      }
      case 'REVOKE_SHARE': {
        const sub = String(msg.subdomain ?? '');
        const share = this.routing.lookupShare(sub);
        const identityId = identityForAgent(agentId);
        this.routing.releaseShare(agentId, sub);
        if (share && identityId) {
          try {
            getRelayHooks().onShareClosed?.({ shareId: share.shareId, identityId });
          } catch { /* never break release */ }
        }
        return true;
      }
      case 'CHECK_SHARE': {
        if (!this.enabled) {
          this.send(agentWs, {
            type: 'SHARE_CHECK_RESULT',
            reqId: msg.reqId,
            subdomain: msg.subdomain,
            available: false,
            reason: 'disabled',
          });
          return true;
        }
        const { available, reason } = this.routing.shareAvailability(String(msg.subdomain ?? ''));
        this.send(agentWs, {
          type: 'SHARE_CHECK_RESULT',
          reqId: msg.reqId,
          subdomain: msg.subdomain,
          available,
          ...(reason && { reason }),
        });
        return true;
      }
      case 'SHARE_RESPONSE': {
        const p = this.owned(msg.reqId, agentId);
        if (!p) return true;
        p.headersSent = true;
        const status = Number.isInteger(msg.status) ? msg.status : 502;
        try {
          p.res.writeHead(status, stripHopByHop((msg.headers ?? {}) as Record<string, unknown>));
        } catch { /* headers already sent / invalid */ }
        return true;
      }
      case 'SHARE_RES_BODY': {
        const p = this.owned(msg.reqId, agentId);
        if (!p) return true;
        const body = Buffer.from(String(msg.chunk ?? ''), 'base64');
        // Meter the public outbound (down) direction, labelled by subdomain.
        try {
          getRelayHooks().meter?.({
            capId: p.shareId,
            source: 'share',
            direction: 'down',
            bytes: body.length,
            label: p.subdomain,
          });
        } catch { /* metering must never break the proxy */ }
        try { p.res.write(body); } catch { /* client gone */ }
        return true;
      }
      case 'SHARE_RES_END': {
        const p = this.owned(msg.reqId, agentId);
        if (!p) return true;
        this.finish(msg.reqId);
        try { p.res.end(); } catch { /* already ended */ }
        return true;
      }
      case 'SHARE_ERROR': {
        const p = this.owned(msg.reqId, agentId);
        if (!p) return true;
        this.finish(msg.reqId);
        try {
          if (!p.headersSent) p.res.status(502).type('text/plain').send('Upstream error');
          else p.res.end();
        } catch { /* already ended */ }
        return true;
      }
      default:
        return false;
    }
  }

  private owned(reqId: unknown, agentId: string): PendingRequest | null {
    if (typeof reqId !== 'string') return null;
    const p = this.pending.get(reqId);
    if (!p || p.agentId !== agentId) return null;
    return p;
  }

  private finish(reqId: string): void {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(reqId);
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch (e) {
      output.warn(`Failed to send share frame: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The public URL a reserved subdomain is reachable at, from RELAY_SHARE_HOST. */
export function shareUrl(subdomain: string): string {
  const host = (process.env.RELAY_SHARE_HOST || '').trim().toLowerCase();
  const scheme = (process.env.RELAY_SHARE_SCHEME || 'https').trim().toLowerCase();
  return host ? `${scheme}://${subdomain}.${host}` : `${subdomain}.<share-host>`;
}
