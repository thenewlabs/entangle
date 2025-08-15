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
  
  // Store active relay sessions
  const relaySessions = new Map<string, any>();
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ASSIGN') {
        state.namespace = msg.namespace;
        logger.info({ namespace: msg.namespace }, 'Namespace assigned');
        
        // Create capabilities for each tool if none exist
        if (state.capabilities.size === 0) {
          await createCapabilitiesForTools(state);
        } else {
          // Display existing capabilities
          displayCapabilities(state);
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
        
        // Pass the whitelisted tools from the capability or agent state
        const whitelistedTools = cap.tools || state.tools;
        const session = await handleInvokerConnection(state.ws!, socketId, cap, whitelistedTools);
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
  // Use the server URL provided when starting the agent
  const relayUrl = config.relayUrl || state.serverUrl || config.publicOrigin || 'http://localhost:8080';
  
  // Create a single capability that works for all whitelisted tools
  const cap = await createCapability({
    namespace: state.namespace!,
    tool: '*', // Special marker for multi-tool capability
    singleRun: false,
  });
  
  // Store the capability with reference to all tools
  cap.tools = state.tools; // Add tools array to capability
  state.capabilities.set(cap.capId, cap);
  
  const link = `${relayUrl}/${cap.namespace}/${cap.capId}#S=${cap.S}`;
  
  console.log('\n=====================================');
  console.log(`Multi-tool capability created`);
  console.log(`namespace: ${cap.namespace}`);
  console.log(`capId: ${cap.capId}`);
  console.log(`S: ${cap.S}`);
  console.log(`\nWhitelisted tools:`);
  for (const tool of state.tools) {
    console.log(`  - ${tool}`);
  }
  console.log(`\nWeb link: ${link}`);
  console.log(`\nInvoke command example:`);
  console.log(`entangle-invoke --namespace ${cap.namespace} --cap-id ${cap.capId} --secret-s ${cap.S} --tool <toolname> --argv '["--help"]'`);
  console.log('=====================================\n');
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

function displayCapabilities(state: AgentState): void {
  if (state.capabilities.size === 0) return;
  
  const config = getConfig();
  const relayUrl = config.relayUrl || state.serverUrl || config.publicOrigin || 'http://localhost:8080';
  
  console.log('\n=====================================');
  console.log('Using existing capabilities:');
  
  for (const [capId, cap] of state.capabilities) {
    console.log(`\nnamespace: ${state.namespace}`);
    console.log(`capId: ${capId}`);
    console.log(`S: ${cap.S}`);
    
    if (cap.tools) {
      console.log(`\nWhitelisted tools:`);
      for (const tool of cap.tools) {
        console.log(`  - ${tool}`);
      }
    } else if (cap.tool) {
      console.log(`tool: ${cap.tool}`);
    }
    
    const link = `${relayUrl}/${state.namespace}/${capId}#S=${cap.S}`;
    console.log(`\nWeb link: ${link}`);
    console.log(`\nInvoke command example:`);
    console.log(`entangle-invoke --namespace ${state.namespace} --cap-id ${capId} --secret-s ${cap.S} --tool <toolname> --argv '["--help"]'`);
  }
  console.log('=====================================\n');
}