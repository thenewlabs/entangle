import type WebSocket from 'ws';
import { getConfig, OutputHandler, parseOutputMode, isValidCapId } from '@thenewlabs/entangle-utils';
import type { RoutingState } from '../state/routing.js';
// import { FrameReader } from '@thenewlabs/entangle-protocol';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export function setupRelayRoute(
  invokerWs: WebSocket,
  routing: RoutingState,
  capId: string
): void {
  const config = getConfig();

  // The capId arrives straight from the URL path; reject malformed/oversized
  // values before any map lookup or log line.
  if (!isValidCapId(capId)) {
    invokerWs.close(1008, 'Invalid capability');
    return;
  }

  const agentWs = routing.findAgent(capId);

  if (!agentWs) {
    output.warn(`Agent not found for capability: ${capId}`);
    invokerWs.close(1008, 'Capability not found');
    return;
  }
  
  let invokerId: string;
  try {
    invokerId = routing.registerInvoker(invokerWs, capId);
  } catch (_err) {
    try { invokerWs.close(1013, 'Over capacity'); } catch {}
    return;
  }
  
  output.info(`Relay established: capability=${capId}, invokerId=${invokerId}`);
  
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
    
    // Enforce max frame size on incoming chunks to avoid amplification
    if (data.length > config.maxFrameBytes) {
      output.warn(`Dropping oversize message from invoker: size=${data.length}, max=${config.maxFrameBytes}, invokerId=${invokerId}`);
      try { invokerWs.close(1009, 'Frame too large'); } catch {}
      return;
    }

    try {
      // Minimal frame header parse for diagnostics
      if (data.length >= 9) {
        const type = data[0];
        const len = Number(data.readBigUInt64BE(1));
        const payloadLen = data.length - 9;
        if (type === 0x30 /* STREAM_OPEN */) {
          output.info(`Relay forwarding STREAM_OPEN: headerLen=${len}, actualPayload=${payloadLen}, invokerId=${invokerId}`);
        }
      }
    } catch {}

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
      output.info(`Closing idle relay: ${invokerId}`);
      invokerWs.close(1000, 'Idle timeout');
      clearInterval(idleCheck);
    }
  }, 10000);
  
  invokerWs.on('close', () => {
    clearInterval(idleCheck);
    output.info(`Invoker disconnected: ${invokerId}`);
    
    agentWs.send(JSON.stringify({
      type: 'INVOKER_DISCONNECT',
      socketId: invokerId,
    }));
  });
  
  invokerWs.on('error', (error) => {
    output.error(`Invoker WebSocket error (invokerId: ${invokerId})`, error instanceof Error ? error.message : String(error));
  });
}
