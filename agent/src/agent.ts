import WebSocket from 'ws';
import { createLogger, getConfig } from '@sunpix/entangle-utils';
import { handleInvokerConnection } from './session.js';
import { loadCapabilities, createCapability } from './capability.js';

interface AgentOptions {
  serverUrl: string;
  outputMode?: string;
}

interface AgentState {
  agentId?: string;
  ws?: WebSocket;
  capabilities: Map<string, any>;
  serverUrl: string;
  logger: ReturnType<typeof createLogger>;
  outputMode?: string;
}

export async function startAgent(options: AgentOptions): Promise<void> {
  const logger = createLogger('agent', options.outputMode);
  const config = getConfig();
  const state: AgentState = {
    capabilities: new Map(),
    serverUrl: options.serverUrl,
    logger,
    ...(options.outputMode && { outputMode: options.outputMode }),
  };
  
  logger.info('Starting agent');
  
  const caps = await loadCapabilities();
  for (const cap of caps) {
    state.capabilities.set(cap.capId, cap);
  }
  
  await connectToServer(state, options.serverUrl);
  
  setInterval(() => {
    sendHeartbeat(state);
  }, config.agentHeartbeatMs || 15000);
  
  process.on('SIGINT', () => {
    state.logger.info('Shutting down');
    state.ws?.close();
    process.exit(0);
  });
}

async function connectToServer(state: AgentState, serverUrl: string): Promise<void> {
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/agent/register';
  
  state.logger.info({ url: wsUrl }, 'Connecting to server');
  
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  
  ws.on('open', () => {
    state.logger.info('Connected to server');
    
    const hello = {
      type: 'CLIENT_HELLO',
      machineId: getMachineId(),
    };
    
    ws.send(JSON.stringify(hello));
  });
  
  // Store active relay sessions
  const relaySessions = new Map<string, any>();
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ASSIGN') {
        state.agentId = msg.agentId;
        state.logger.info({ agentId: msg.agentId }, 'Agent registered');
        
        // Create capability if none exist
        if (state.capabilities.size === 0) {
          await createAndDisplayCapability(state);
        } else {
          // Display existing capabilities
          displayCapabilities(state);
        }
        
        // Announce all capabilities
        for (const capId of state.capabilities.keys()) {
          announceCapability(state, capId);
        }
      } else if (msg.type === 'INVOKER_CONNECT') {
        const { capId, socketId } = msg;
        const cap = state.capabilities.get(capId);
        
        if (!cap) {
          state.logger.warn({ capId }, 'Unknown capability');
          return;
        }
        
        state.logger.info({ capId, socketId }, 'Invoker connected');
        
        const session = await handleInvokerConnection(state.ws!, socketId, cap);
        relaySessions.set(socketId, session);
      } else if (msg.type === 'RELAY_MSG') {
        // Handle forwarded frame from invoker
        const session = relaySessions.get(msg.socketId);
        if (session && session.handleFrame) {
          const frameData = Buffer.from(msg.frame, 'base64');
          session.handleFrame(frameData);
        }
      } else if (msg.type === 'INVOKER_DISCONNECT') {
        // Clean up relay session
        const session = relaySessions.get(msg.socketId);
        if (session && session.cleanup) {
          session.cleanup();
        }
        relaySessions.delete(msg.socketId);
      }
    } catch (error) {
      // If it's not JSON, it might be a legacy binary frame - ignore it
      if (data instanceof Buffer) {
        return;
      }
      state.logger.error({ error }, 'Failed to handle message');
    }
  });
  
  ws.on('error', (error) => {
    state.logger.error({ error }, 'WebSocket error');
  });
  
  ws.on('close', () => {
    state.logger.info('Disconnected from server');
    setTimeout(() => connectToServer(state, serverUrl), 5000);
  });
}

async function createAndDisplayCapability(state: AgentState): Promise<void> {
  const config = getConfig();
  const relayUrl = config.relayUrl || state.serverUrl || config.publicOrigin || 'https://suncoder.dev';
  
  const cap = await createCapability({
    singleRun: false,
    ...(state.outputMode && { outputMode: state.outputMode }),
  });
  
  state.capabilities.set(cap.capId, cap);
  
  const link = `${relayUrl}/cap/${cap.capId}#S=${cap.S}`;
  
  state.logger.info('');
  state.logger.info('=====================================');
  state.logger.info('Capability created');
  state.logger.info(`capId: ${cap.capId}`);
  state.logger.info(`S: ${cap.S}`);
  state.logger.info('');
  state.logger.info(`Web URL: ${link}`);
  state.logger.info('=====================================');
  state.logger.info('');
}

function announceCapability(state: AgentState, capId: string): void {
  if (!state.ws) return;
  
  const announce = {
    type: 'ANNOUNCE_CAP',
    capId,
  };
  
  state.ws.send(JSON.stringify(announce));
  state.logger.info({ capId }, 'Capability announced');
}

function sendHeartbeat(state: AgentState): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  
  const heartbeat = {
    type: 'HEARTBEAT',
    timestamp: Date.now(),
  };
  
  state.ws.send(JSON.stringify(heartbeat));
}

function getMachineId(): string {
  return require('crypto').randomBytes(16).toString('hex');
}

function displayCapabilities(state: AgentState): void {
  if (state.capabilities.size === 0) return;
  
  const config = getConfig();
  const relayUrl = config.relayUrl || state.serverUrl || config.publicOrigin || 'https://suncoder.dev';
  
  state.logger.info('');
  state.logger.info('=====================================');
  state.logger.info('Using existing capabilities:');
  
  for (const [capId, cap] of state.capabilities) {
    state.logger.info('');
    state.logger.info(`capId: ${capId}`);
    state.logger.info(`S: ${cap.S}`);
    
    const link = `${relayUrl}/cap/${capId}#S=${cap.S}`;
    state.logger.info('');
    state.logger.info(`Web URL: ${link}`);
  }
  state.logger.info('=====================================');
  state.logger.info('');
}