import type WebSocket from 'ws';
import { createLogger } from '@sunpix/entangle-utils';
import type { RoutingState } from '../state/routing.js';

const logger = createLogger('agent-route');

export function setupAgentRoute(ws: WebSocket, routing: RoutingState): void {
  let namespace: string | undefined;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'CLIENT_HELLO') {
        namespace = routing.registerAgent(ws, msg.machineId);
        
        ws.send(JSON.stringify({
          type: 'ASSIGN',
          namespace,
        }));
        
        logger.info({ namespace }, 'Namespace assigned to agent');
      } else if (msg.type === 'ANNOUNCE_CAP' && namespace) {
        const success = routing.announceCapability(namespace, msg.capId);
        
        if (success) {
          logger.info({ namespace, capId: msg.capId }, 'Capability announced');
        } else {
          logger.warn({ namespace, capId: msg.capId }, 'Failed to announce capability');
        }
      } else if (msg.type === 'HEARTBEAT' && namespace) {
        routing.updateHeartbeat(namespace);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to handle agent message');
    }
  });
  
  ws.on('error', (error) => {
    logger.error({ error, namespace }, 'Agent WebSocket error');
  });
  
  ws.on('close', () => {
    logger.info({ namespace }, 'Agent disconnected');
  });
}