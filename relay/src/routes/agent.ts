import type WebSocket from 'ws';
import { getConfig, OutputHandler, parseOutputMode, isValidCapId, isBoundedString } from '@thenewlabs/entangle-utils';
import type { RoutingState } from '../state/routing.js';
import type { ShareBridge } from './share.js';
import { installLiveness, pingIntervalMs } from '../utils/liveness.js';
import { getRelayHooks } from '../hooks.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// Live agent sockets grouped by the opaque identity a verifier bound them to. The verifier is only
// consulted once (at registration), so this is the LIVE kill path: an embedder (e.g. locus-server,
// on suspend / password reset / token revoke) can force-close every current connection of an
// identity instead of waiting for its long-lived durable socket to drop on its own.
const identitySockets = new Map<string, Set<WebSocket>>();

/**
 * Force-close every live agent socket bound to `identityId`. Returns the number closed. Generic and
 * account-agnostic — `identityId` is the same opaque id the verifier returned; the relay learns no
 * domain model. Safe to call with an unknown id (no-op).
 */
export function closeIdentity(identityId: string, reason = 'account revoked'): number {
  const set = identitySockets.get(identityId);
  if (!set) return 0;
  let closed = 0;
  for (const ws of [...set]) {
    try { ws.close(1008, reason); closed++; } catch {}
  }
  return closed;
}

export function setupAgentRoute(ws: WebSocket, routing: RoutingState, shareBridge?: ShareBridge): void {
  let agentId: string | undefined;
  // Set (to an OPAQUE id) only when a verifyAgentToken hook accepts this socket.
  // Never a "user" — the relay stays account-agnostic.
  let identityId: string | undefined;
  let machineId = 'unknown';
  // Guards the async verifier window so a second CLIENT_HELLO can't slip through
  // while the first is still awaiting verification.
  let registering = false;
  // Bound capabilities this socket has announced (only tracked for verified
  // sockets, so onCapabilityClosed can fire per cap on disconnect).
  const announcedCaps = new Set<string>();
  const cfg = getConfig();
  const requiredToken = cfg.agentToken;

  // Ping/pong keepalive so a half-open agent (dead network, no FIN) is detected
  // and terminated in ~2 intervals instead of black-holing its capId until the
  // OS times the socket out.
  installLiveness(ws, pingIntervalMs());

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'CLIENT_HELLO') {
        // One registration per socket: a second CLIENT_HELLO would orphan the
        // first agent entry and let one connection inflate the routing maps.
        // `registering` closes the async-verifier window against the same race.
        if (agentId || registering) {
          output.warn(`Ignoring duplicate CLIENT_HELLO on socket for agent ${agentId ?? '(registering)'}`);
          return;
        }

        // Bound the untrusted machineId before it enters maps/logs/hooks.
        machineId = isBoundedString(msg.machineId, 128) ? msg.machineId : 'unknown';

        const hooks = getRelayHooks();
        if (hooks.verifyAgentToken) {
          // An injected verifier REPLACES the flat-token compare. It receives
          // only the opaque bearer token and the self-reported machineId — never
          // the capability secret. Returns an opaque `{ id }` or null.
          registering = true;
          let verified: { id: string } | null;
          try {
            const token = typeof msg.token === 'string' ? msg.token : '';
            verified = await hooks.verifyAgentToken(token, machineId);
          } catch (err) {
            registering = false;
            output.warn(`Rejected agent registration: verifier error: ${err instanceof Error ? err.message : String(err)}`);
            try { ws.close(1008, 'Invalid agent token'); } catch {}
            return;
          }
          registering = false;
          // The socket may have gone away (or re-registered) during the await.
          if (ws.readyState !== ws.OPEN || agentId) return;
          if (!verified) {
            output.warn('Rejected agent registration: invalid or missing token');
            try { ws.close(1008, 'Invalid agent token'); } catch {}
            return;
          }
          identityId = verified.id;
          // Track this socket under its identity so it can be force-closed on revoke.
          let set = identitySockets.get(identityId);
          if (!set) { set = new Set(); identitySockets.set(identityId, set); }
          set.add(ws);
        } else {
          // No verifier injected — preserve today's flat-token behaviour exactly.

          // Fail closed when configured to require authentication but no token is
          // set: an unauthenticated control plane lets arbitrary clients register.
          if (!requiredToken && cfg.requireAgentToken) {
            output.warn('Rejected agent registration: authentication required but RELAY_AGENT_TOKEN is not set');
            try { ws.close(1008, 'Agent authentication required'); } catch {}
            return;
          }

          // Gate agent registration behind a shared token when configured, so
          // random clients cannot register and squat capabilities.
          if (requiredToken && msg.token !== requiredToken) {
            output.warn('Rejected agent registration: invalid or missing token');
            try { ws.close(1008, 'Invalid agent token'); } catch {}
            return;
          }
        }

        const newAgentId = routing.registerAgent(ws, machineId);
        if (!newAgentId) {
          try { ws.close(1013, 'Server at capacity'); } catch {}
          return;
        }
        agentId = newAgentId;

        ws.send(JSON.stringify({
          type: 'ASSIGN',
          agentId, // Provide agentId for logging/diagnostics on the agent
        }));

        output.info(`Agent registered: ${agentId}`);
      } else if (msg.type === 'ANNOUNCE_CAP' && agentId) {
        // Reject malformed capability ids up front (also bounds log size).
        if (!isValidCapId(msg.capId)) {
          output.warn(`Ignoring ANNOUNCE_CAP with invalid capId from agent ${agentId}`);
          return;
        }
        const success = routing.announceCapability(agentId, msg.capId);

        if (success) {
          output.info(`Capability announced: ${msg.capId} by agent ${agentId}`);
          // Bind the capability to the verified opaque identity (if any). Only
          // the routing capId + machineId leave the relay — never the secret.
          // Idempotent: a repeat ANNOUNCE_CAP for a cap this socket already bound
          // must NOT re-fire the hook (routing.announceCapability returns true on a
          // re-announce, which would otherwise open duplicate sessions embedder-side).
          if (identityId && !announcedCaps.has(msg.capId)) {
            announcedCaps.add(msg.capId);
            try {
              getRelayHooks().onCapabilityRegistered?.({ identityId, capId: msg.capId, machineId });
            } catch (err) {
              output.warn(`onCapabilityRegistered hook threw: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else {
          output.warn(`Failed to announce capability ${msg.capId} for agent ${agentId}`);
        }
      } else if (msg.type === 'HEARTBEAT' && agentId) {
        routing.updateHeartbeat(agentId);
      } else if (msg.type === 'RELAY_RESPONSE' && agentId) {
        // Reject malformed routing ids before any map lookup.
        if (!isBoundedString(msg.socketId, 64)) {
          output.warn('Dropping RELAY_RESPONSE with invalid socketId');
          return;
        }
        // Route the message to the appropriate invoker — but only if that
        // invoker belongs to a capability THIS agent owns.
        if (!routing.invokerBelongsToAgent(msg.socketId, agentId)) {
          output.warn(`Dropping RELAY_RESPONSE to non-owned invoker: ${msg.socketId}`);
          return;
        }
        const invoker = routing.findInvoker(msg.socketId);
        if (invoker && invoker.ws.readyState === ws.OPEN) {
          const buf = Buffer.from(msg.frame, 'base64');
          const max = getConfig().maxFrameBytes;
          if (buf.length > max) {
            output.warn(`Dropping oversize frame from agent: size=${buf.length}, max=${max}, socketId=${msg.socketId}`);
            return;
          }
          // Send the unwrapped frame to the invoker
          invoker.ws.send(buf);
          // Meter the agent→invoker (down) direction. `buf` is an opaque
          // ciphertext frame — only its byte length is observed.
          try {
            getRelayHooks().meter?.({
              capId: invoker.capId,
              source: 'capability',
              direction: 'down',
              bytes: buf.length,
              label: invoker.capId,
            });
          } catch { /* metering must never break the data path */ }
        }
      } else if (agentId && shareBridge && shareBridge.handleAgentMessage(agentId, msg, ws)) {
        // Public-share control/response message — handled by the share bridge.
      }
    } catch (error) {
      output.error('Failed to handle agent message', error instanceof Error ? error.message : String(error));
    }
  });
  
  ws.on('error', (error) => {
    output.error(`Agent WebSocket error (agentId: ${agentId})`, error instanceof Error ? error.message : String(error));
  });
  
  ws.on('close', () => {
    output.info(`Agent disconnected: ${agentId}`);
    // Notify the embedder that each bound capability of this verified socket is
    // gone (final byte tallies etc. live embedder-side).
    if (identityId) {
      // Drop this socket from the identity registry (clean up the set when empty).
      const set = identitySockets.get(identityId);
      if (set) { set.delete(ws); if (set.size === 0) identitySockets.delete(identityId); }

      const hooks = getRelayHooks();
      for (const capId of announcedCaps) {
        try {
          hooks.onCapabilityClosed?.({ capId, identityId });
        } catch (err) {
          output.warn(`onCapabilityClosed hook threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  });
}
