import type WebSocket from 'ws';
import { getConfig, OutputHandler, parseOutputMode, isValidCapId, isBoundedString } from '@thenewlabs/entangle-utils';
import type { RoutingState } from '../state/routing.js';
import type { ShareBridge } from './share.js';
import { installLiveness, pingIntervalMs } from '../utils/liveness.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export function setupAgentRoute(ws: WebSocket, routing: RoutingState, shareBridge?: ShareBridge): void {
  let agentId: string | undefined;
  const cfg = getConfig();
  const requiredToken = cfg.agentToken;

  // Ping/pong keepalive so a half-open agent (dead network, no FIN) is detected
  // and terminated in ~2 intervals instead of black-holing its capId until the
  // OS times the socket out.
  installLiveness(ws, pingIntervalMs());

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'CLIENT_HELLO') {
        // One registration per socket: a second CLIENT_HELLO would orphan the
        // first agent entry and let one connection inflate the routing maps.
        if (agentId) {
          output.warn(`Ignoring duplicate CLIENT_HELLO on socket for agent ${agentId}`);
          return;
        }

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

        // Bound the untrusted machineId before it enters maps/logs.
        const machineId = isBoundedString(msg.machineId, 128) ? msg.machineId : 'unknown';

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
  });
}
