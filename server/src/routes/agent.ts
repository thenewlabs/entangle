import type WebSocket from 'ws';
import { getConfig, OutputHandler, parseOutputMode } from '@sunpix/entangle-utils';
import type { RoutingState } from '../state/routing.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

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
        
        output.info(`Agent registered: ${agentId}`);
      } else if (msg.type === 'ANNOUNCE_CAP' && agentId) {
        const success = routing.announceCapability(agentId, msg.capId);
        
        if (success) {
          output.info(`Capability announced: ${msg.capId} by agent ${agentId}`);
        } else {
          output.warn(`Failed to announce capability ${msg.capId} for agent ${agentId}`);
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
            output.warn(`Dropping oversize frame from agent: size=${buf.length}, max=${max}, socketId=${msg.socketId}`);
            return;
          }
          // Send the unwrapped frame to the invoker
          invoker.ws.send(buf);
        }
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
