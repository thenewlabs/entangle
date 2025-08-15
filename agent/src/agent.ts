import WebSocket from 'ws';
import { createLogger, getConfig } from '@sunpix/entangle-utils';
import { FrameType, encodeFrame } from '@sunpix/entangle-protocol';
// import { generateNamespace } from '@sunpix/entangle-crypto';
import { encode } from 'cborg';
import { handleInvokerConnection } from './relay.js';
import { loadCapabilities, createCapability } from './capability.js';

const logger = createLogger('agent');

interface AgentOptions {
  tools: string[];
  serverUrl: string;
  policyFile?: string;
}

interface AgentState {
  namespace?: string;
  ws?: WebSocket;
  tools: string[];
  capabilities: Map<string, any>;
  serverUrl: string;
}

export async function startAgent(options: AgentOptions): Promise<void> {
  const config = getConfig();
  const state: AgentState = {
    tools: options.tools,
    capabilities: new Map(),
    serverUrl: options.serverUrl,
  };
  
  logger.info({ tools: options.tools }, 'Starting agent with tools');
  
  const caps = await loadCapabilities();
  for (const cap of caps) {
    state.capabilities.set(cap.capId, cap);
  }
  
  await connectToServer(state, options.serverUrl);
  
  setInterval(() => {
    sendHeartbeat(state);
  }, config.agentHeartbeatMs);
  
  process.on('SIGINT', () => {
    logger.info('Shutting down');
    state.ws?.close();
    process.exit(0);
  });
}

async function connectToServer(state: AgentState, serverUrl: string): Promise<void> {
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/agent/register';
  
  logger.info({ url: wsUrl }, 'Connecting to server');
  
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  
  ws.on('open', () => {
    logger.info('Connected to server');
    
    const hello = {
      type: 'CLIENT_HELLO',
      machineId: getMachineId(),
      tools: state.tools,
    };
    
    ws.send(JSON.stringify(hello));
  });
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ASSIGN') {
        state.namespace = msg.namespace;
        logger.info({ namespace: msg.namespace }, 'Namespace assigned');
        
        // Create capabilities for each tool if none exist
        if (state.capabilities.size === 0) {
          await createCapabilitiesForTools(state);
        }
        
        for (const capId of state.capabilities.keys()) {
          announceCapability(state, capId);
        }
      } else if (msg.type === 'INVOKER_CONNECT') {
        const { capId, socketId } = msg;
        const cap = state.capabilities.get(capId);
        
        if (!cap) {
          logger.warn({ capId }, 'Unknown capability');
          return;
        }
        
        logger.info({ capId, socketId }, 'Invoker connected');
        
        // Find the tool path from the capability
        const toolPath = cap.tool || state.tools[0];
        handleInvokerConnection(state.ws!, socketId, cap, toolPath);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to handle message');
    }
  });
  
  ws.on('error', (error) => {
    logger.error({ error }, 'WebSocket error');
  });
  
  ws.on('close', () => {
    logger.info('Disconnected from server');
    setTimeout(() => connectToServer(state, serverUrl), 5000);
  });
}

async function createCapabilitiesForTools(state: AgentState): Promise<void> {
  const config = getConfig();
  const relayUrl = config.relayUrl || config.publicOrigin || 'http://localhost:8080';
  
  for (const tool of state.tools) {
    const cap = await createCapability({
      namespace: state.namespace!,
      tool,
      singleRun: true,
    });
    
    state.capabilities.set(cap.capId, cap);
    
    const toolName = tool.split('/').pop() || 'tool';
    const link = `${relayUrl}/${cap.namespace}/${cap.capId}#S=${cap.S}`;
    
    console.log('\n=====================================');
    console.log(`Capability created for tool: ${tool}`);
    console.log(`namespace: ${cap.namespace}`);
    console.log(`capId: ${cap.capId}`);
    console.log(`S: ${cap.S}`);
    console.log(`\nWeb link: ${link}`);
    console.log(`\nInvoke command example:`);
    console.log(`entangle-invoke "${link}" ${toolName} --help`);
    console.log('=====================================\n');
  }
}

function announceCapability(state: AgentState, capId: string): void {
  if (!state.ws || !state.namespace) return;
  
  const announce = {
    type: 'ANNOUNCE_CAP',
    capId,
  };
  
  state.ws.send(JSON.stringify(announce));
  logger.info({ capId }, 'Capability announced');
}

function sendHeartbeat(state: AgentState): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  
  const frame = encodeFrame(FrameType.KEEPALIVE, encode({ t: Date.now() }));
  state.ws.send(frame);
}

function getMachineId(): string {
  return require('crypto').randomBytes(16).toString('hex');
}