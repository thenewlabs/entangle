import WebSocket from 'ws';
import { randomBytes } from 'crypto';
import { getConfig, OutputHandler, parseOutputMode, type PipeEndpoint } from '@thenewlabs/entangle-utils';
import { hashPassword } from '@thenewlabs/entangle-crypto';
import { handleInvokerConnection } from './session.js';
import { createCapability, type CapabilityInfo } from './capability.js';
import type { SharedSession } from './shared-session.js';

interface AgentOptions {
  serverUrl: string;
  outputMode?: string;
  password?: string;
  pinnedCapability?: CapabilityInfo;
  // Registered forwarded-channel endpoints (allow-list). Merged with any parsed
  // from the ENTANGLE_PIPES env; explicit entries here win on name collision.
  pipeEndpoints?: Map<string, PipeEndpoint>;
  // When set, serve a single shared terminal: every viewer attaches to this PTY
  // instead of spawning its own shell.
  sharedSession?: SharedSession;
  // Called once the served capability's URL is known (used by the host UI to
  // show it). When provided, the verbose capability block is suppressed.
  onCapabilityReady?: (info: { link: string; capId: string; S: string }) => void;
}

interface AgentState {
  agentId?: string;
  ws?: WebSocket;
  capabilities: Map<string, any>;
  serverUrl: string;
  output: OutputHandler;
  outputMode?: string;
  password?: string;
  passwordHash?: string;
  pinned?: boolean;
  pipeEndpoints: Map<string, PipeEndpoint>;
  sharedSession?: SharedSession;
  onCapabilityReady?: (info: { link: string; capId: string; S: string }) => void;
}

export async function startAgent(options: AgentOptions): Promise<void> {
  const output = new OutputHandler({ mode: parseOutputMode(options.outputMode || process.env.OUTPUT_MODE || 'text') });
  const config = getConfig();
  // Forwarded-channel allow-list: env-configured endpoints, overlaid with any
  // supplied programmatically (the Locus team calls startAgent directly).
  const pipeEndpoints = new Map<string, PipeEndpoint>(config.pipeEndpoints);
  if (options.pipeEndpoints) {
    for (const [name, endpoint] of options.pipeEndpoints) pipeEndpoints.set(name, endpoint);
  }
  const state: AgentState = {
    capabilities: new Map(),
    serverUrl: options.serverUrl,
    output,
    pipeEndpoints,
    ...(options.outputMode && { outputMode: options.outputMode }),
    ...(options.password && { password: options.password }),
    ...(options.sharedSession && { sharedSession: options.sharedSession }),
    ...(options.onCapabilityReady && { onCapabilityReady: options.onCapabilityReady }),
  };

  output.info('Starting agent');
  if (pipeEndpoints.size > 0) {
    output.info(`Registered pipes: ${Array.from(pipeEndpoints.keys()).join(', ')}`);
  }
  
  // Hash password if provided (Argon2id with a random salt).
  if (state.password) {
    state.passwordHash = await hashPassword(state.password);
    output.info('Password protection enabled');
  }
  
  // Exactly one capability is served: a pinned one supplied by the caller, or a
  // fresh ephemeral one minted in memory (never written to disk).
  let cap: CapabilityInfo;
  if (options.pinnedCapability) {
    cap = options.pinnedCapability;
    state.pinned = true;
  } else {
    cap = await createCapability({
      singleRun: false,
      ...(state.outputMode && { outputMode: state.outputMode }),
    });
  }
  state.capabilities.set(cap.capId, cap);

  await connectToServer(state, options.serverUrl);
  
  setInterval(() => {
    sendHeartbeat(state);
  }, config.agentHeartbeatMs || 15000);
  
  process.on('SIGINT', () => {
    state.output.info('Shutting down');
    state.ws?.close();
    process.exit(0);
  });
}

async function connectToServer(state: AgentState, serverUrl: string): Promise<void> {
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/agent/register';
  
  state.output.info(`Connecting to server: ${wsUrl}`);
  
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  
  ws.on('open', () => {
    state.output.info('Connected to server');

    const hello = {
      type: 'CLIENT_HELLO',
      machineId: getMachineId(),
      // Shared secret gating agent registration (RELAY_AGENT_TOKEN). Undefined
      // when the relay does not require one.
      token: getConfig().agentToken,
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
        state.output.info(`Agent registered: ${msg.agentId}`);
        
        // Display the single served capability (pinned or ephemeral).
        displayCapability(state);

        // Announce all capabilities
        for (const capId of state.capabilities.keys()) {
          announceCapability(state, capId);
        }
      } else if (msg.type === 'INVOKER_CONNECT') {
        const { capId, socketId } = msg;
        const cap = state.capabilities.get(capId);
        
        if (!cap) {
          state.output.warn(`Unknown capability: ${capId}`);
          return;
        }
        
        state.output.info(`Invoker connected: socketId=${socketId}, capId=${capId}`);

        // Register synchronously (no await) so the session exists before this
        // invoker's AUTH1 arrives on the next relay message.
        const session = handleInvokerConnection(state.ws!, socketId, cap, state.passwordHash, state.pipeEndpoints, state.sharedSession);
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
      state.output.error('Failed to handle message', error instanceof Error ? error.message : String(error));
    }
  });
  
  ws.on('error', (error) => {
    state.output.error('WebSocket error', error instanceof Error ? error.message : String(error));
  });
  
  ws.on('close', () => {
    state.output.info('Disconnected from server');
    setTimeout(() => connectToServer(state, serverUrl), 5000);
  });
}

function displayCapability(state: AgentState): void {
  const config = getConfig();
  const relayUrl = config.relayUrl || state.serverUrl || config.publicOrigin || 'https://suncoder.dev';

  // There is exactly one capability. Print its full URL block including the
  // secret S: this capability is ephemeral (or explicitly pinned by the
  // operator) and the secret is intentionally shown here so it can be copied
  // and handed to an invoker — without it the capability is unusable.
  const cap = state.capabilities.values().next().value as CapabilityInfo | undefined;
  if (!cap) return;

  const link = `${relayUrl}/cap/${cap.capId}#S=${cap.S}`;

  // In shared-terminal mode the host UI owns the display (it shows the URL in
  // the session frame), so hand it the link instead of printing the block.
  if (state.onCapabilityReady) {
    state.onCapabilityReady({ link, capId: cap.capId, S: cap.S });
    return;
  }

  state.output.info('');
  state.output.info('=====================================');
  state.output.info(state.pinned ? 'Using pinned capability' : 'Ephemeral capability created (not stored)');
  state.output.info(`capId: ${cap.capId}`);
  state.output.info(`S: ${cap.S}`);
  state.output.info('');
  state.output.info(`Web URL: ${link}`);
  state.output.info('=====================================');
  state.output.info('');
}

function announceCapability(state: AgentState, capId: string): void {
  if (!state.ws) return;
  
  const announce = {
    type: 'ANNOUNCE_CAP',
    capId,
  };
  
  state.ws.send(JSON.stringify(announce));
  state.output.info(`Capability announced: ${capId}`);
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
  return randomBytes(16).toString('hex');
}