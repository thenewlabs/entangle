import type WebSocket from 'ws';
import { createLogger, getConfig } from '@sunpix/entangle-utils';
import type { RoutingState } from '../state/routing.js';
// import { FrameReader } from '@sunpix/entangle-protocol';

const logger = createLogger('relay-route');

export function setupRelayRoute(
  invokerWs: WebSocket,
  routing: RoutingState,
  namespace: string,
  capId: string
): void {
  const config = getConfig();
  const agentWs = routing.findAgent(namespace, capId);
  
  if (!agentWs) {
    logger.warn({ namespace, capId }, 'Agent not found for capability');
    invokerWs.close(1008, 'Capability not found');
    return;
  }
  
  const invokerId = routing.registerInvoker(invokerWs, namespace, capId);
  
  logger.info({ namespace, capId, invokerId }, 'Relay established');
  
  agentWs.send(JSON.stringify({
    type: 'INVOKER_CONNECT',
    capId,
    socketId: invokerId,
  }));
  
  // const invokerReader = new FrameReader();
  // const agentReader = new FrameReader();
  
  let lastActivity = Date.now();
  
  invokerWs.on('message', (data) => {
    if (!(data instanceof Buffer)) return;
    
    lastActivity = Date.now();
    
    if (agentWs.readyState === invokerWs.OPEN) {
      // Wrap the frame with metadata so agent knows which invoker it's from
      agentWs.send(JSON.stringify({
        type: 'RELAY_MSG',
        socketId: invokerId,
        frame: data.toString('base64')
      }));
    }
  });
  
  // Note: Agent responses are handled by the agent route's central message handler
  // This avoids duplicate listeners on the agent WebSocket
  
  const idleCheck = setInterval(() => {
    if (Date.now() - lastActivity > config.relayIdleTimeoutMs) {
      logger.info({ invokerId }, 'Closing idle relay');
      invokerWs.close(1000, 'Idle timeout');
      clearInterval(idleCheck);
    }
  }, 10000);
  
  invokerWs.on('close', () => {
    clearInterval(idleCheck);
    logger.info({ invokerId }, 'Invoker disconnected');
    
    agentWs.send(JSON.stringify({
      type: 'INVOKER_DISCONNECT',
      socketId: invokerId,
    }));
  });
  
  invokerWs.on('error', (error) => {
    logger.error({ error, invokerId }, 'Invoker WebSocket error');
  });
}