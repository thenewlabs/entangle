import type WebSocket from 'ws';
import { getConfig, OutputHandler, parseOutputMode, isValidCapId } from '@thenewlabs/entangle-utils';
import type { RoutingState } from '../state/routing.js';
import { installLiveness, pingIntervalMs } from '../utils/liveness.js';
import { getRelayHooks } from '../hooks.js';
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
  
  // Ping/pong keepalive: reap a half-open viewer socket quickly.
  installLiveness(invokerWs, pingIntervalMs());

  let lastActivity = Date.now();
  // A viewer that is only WATCHING output (a long build) sends no frames, so the
  // idle timer must not kill it. A live socket pongs our keepalive pings, so
  // count that as activity — only a truly dead socket (no pong, terminated by
  // installLiveness) or a genuinely idle+silent one trips the backstop timeout.
  invokerWs.on('pong', () => { lastActivity = Date.now(); });

  invokerWs.on('message', (data) => {
    if (!(data instanceof Buffer)) return;
    
    lastActivity = Date.now();
    
    // Enforce max frame size on incoming chunks to avoid amplification
    if (data.length > config.maxFrameBytes) {
      output.warn(`Dropping oversize message from invoker: size=${data.length}, max=${config.maxFrameBytes}, invokerId=${invokerId}`);
      try { invokerWs.close(1009, 'Frame too large'); } catch {}
      return;
    }

    if (agentWs.readyState === invokerWs.OPEN) {
      // Wrap the frame with metadata so agent knows which invoker it's from
      agentWs.send(JSON.stringify({
        type: 'RELAY_MSG',
        socketId: invokerId,
        frame: data.toString('base64')
      }));
      // Meter the invoker→agent (up) direction. `data` is an opaque ciphertext
      // frame — only its byte length is observed, never the plaintext.
      try {
        getRelayHooks().meter?.({
          capId,
          source: 'capability',
          direction: 'up',
          bytes: data.length,
          label: capId,
        });
      } catch { /* metering must never break the data path */ }
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
