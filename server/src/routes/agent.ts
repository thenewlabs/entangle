import type WebSocket from 'ws';
import { createLogger } from '@sunpix/entangle-utils';
import type { RoutingState } from '../state/routing.js';

const logger = createLogger('agent-route');

export function setupAgentRoute(ws: WebSocket, routing: RoutingState): void {
  let agentId: string | undefined;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'CLIENT_HELLO') {
        agentId = routing.registerAgent(ws, msg.machineId);
        
        ws.send(JSON.stringify({
          type: 'ASSIGN',
          // No namespace needed anymore
        }));
        
        logger.info({ agentId }, 'Agent registered');
      } else if (msg.type === 'ANNOUNCE_CAP' && agentId) {
        const success = routing.announceCapability(agentId, msg.capId);
        
        if (success) {
          logger.info({ agentId, capId: msg.capId }, 'Capability announced');
        } else {
          logger.warn({ agentId, capId: msg.capId }, 'Failed to announce capability');
        }
      } else if (msg.type === 'HEARTBEAT' && agentId) {
        routing.updateHeartbeat(agentId);
      } else if (msg.type === 'RELAY_RESPONSE') {
        // Route the message to the appropriate invoker
        const invoker = routing.findInvoker(msg.socketId);
        if (invoker && invoker.ws.readyState === ws.OPEN) {
          const buf = Buffer.from(msg.frame, 'base64');
          const max = getConfig().maxFrameBytes;
          if (buf.length > max) {
            logger.warn({ size: buf.length, max, socketId: msg.socketId }, 'Dropping oversize frame from agent');
            return;
          }
          // Send the unwrapped frame to the invoker
          invoker.ws.send(buf);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to handle agent message');
    }
  });
  
  ws.on('error', (error) => {
    logger.error({ error, agentId }, 'Agent WebSocket error');
  });
  
  ws.on('close', () => {
    logger.info({ agentId }, 'Agent disconnected');
  });
}
