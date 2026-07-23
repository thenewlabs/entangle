import WebSocket from 'ws';
import { randomBytes } from 'crypto';
import { getConfig, OutputHandler, parseOutputMode, userAgentHeaders, type PipeEndpoint } from '@thenewlabs/entangle-utils';
import { hashPassword } from '@thenewlabs/entangle-crypto';
import { handleInvokerConnection } from './session.js';
import { createCapability, type CapabilityInfo } from './capability.js';
import { PublicShareController } from './public-share.js';
import type { SharedWorkspace } from './shared-workspace.js';
import type { WorkspaceResolver } from './multi-session.js';

interface AgentOptions {
  serverUrl: string;
  outputMode?: string;
  password?: string;
  pinnedCapability?: CapabilityInfo;
  // Registered forwarded-channel endpoints (allow-list). Merged with any parsed
  // from the ENTANGLE_PIPES env; explicit entries here win on name collision.
  pipeEndpoints?: Map<string, PipeEndpoint>;
  // When set, serve a SINGLE shared workspace: every client's viewport binds to
  // it (and sees the active window) instead of spawning its own shell. Shorthand
  // for a constant `getWorkspace` resolver; ignored if `getWorkspace` is given.
  sharedWorkspace?: SharedWorkspace;
  // When set, serve MULTIPLE shared workspaces over one capability: each pty
  // viewport's workspace is resolved from the key+cwd in its open message. This
  // is what lets an embedder (Locus) give each top-level tab its own durable
  // terminals. Takes precedence over `sharedWorkspace`. With no key the resolver
  // must return the single default workspace (back-compat).
  getWorkspace?: WorkspaceResolver;
  // Called once the served capability's URL is known (used by the host UI to
  // show it). When provided, the verbose capability block is suppressed.
  onCapabilityReady?: (info: { link: string; capId: string; S: string }) => void;
  // Called once with a controller for PLAINTEXT public shares (an agent-opt-in
  // HTTP tunnel on a relay subdomain, NO end-to-end encryption). An embedder
  // (Locus) uses it to announce/list/revoke shares and to check subdomain
  // availability. Omit to leave the feature entirely dormant.
  onPublicShareReady?: (controller: PublicShareController) => void;
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
  // The resolved workspace resolver (built from `getWorkspace`, or a constant
  // wrapper around `sharedWorkspace`). Undefined when not serving a workspace.
  getWorkspace?: WorkspaceResolver;
  onCapabilityReady?: (info: { link: string; capId: string; S: string }) => void;
  publicShare?: PublicShareController;
  /** Reconnect backoff attempt counter; reset to 0 on a successful registration. */
  reconnectAttempts?: number;
}

// Agent→relay reconnect backoff (ms): exponential with full jitter, capped.
const AGENT_RC_BASE = 1000;
const AGENT_RC_FACTOR = 1.8;
const AGENT_RC_CAP = 30000;
function agentPingIntervalMs(): number {
  const raw = Number(process.env.AGENT_WS_PING_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 20000;
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
  // A multi-workspace resolver wins; otherwise a single sharedWorkspace is served
  // via a constant resolver that ignores the key+cwd (back-compat). Either way
  // the rest of the agent only ever sees `getWorkspace`.
  const getWorkspace: WorkspaceResolver | undefined =
    options.getWorkspace ??
    (options.sharedWorkspace ? () => options.sharedWorkspace! : undefined);

  const state: AgentState = {
    capabilities: new Map(),
    serverUrl: options.serverUrl,
    output,
    pipeEndpoints,
    ...(options.outputMode && { outputMode: options.outputMode }),
    ...(options.password && { password: options.password }),
    ...(getWorkspace && { getWorkspace }),
    ...(options.onCapabilityReady && { onCapabilityReady: options.onCapabilityReady }),
  };

  // Public-share controller (plaintext HTTP tunnels on relay subdomains). It
  // sends over whatever the current agent socket is; the getter tracks reconnects.
  if (options.onPublicShareReady) {
    state.publicShare = new PublicShareController(() => state.ws, output);
    options.onPublicShareReady(state.publicShare);
  }

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
  
  // Node's `ws` sends no User-Agent unless told to. Without it the relay (and anything in front
  // of it) logs "-" for every registration, and because this connect is retried on a backoff
  // loop that reads as UA-less bot polling — enough to get the source IP banned by CrowdSec.
  const ws = new WebSocket(wsUrl, { headers: userAgentHeaders('entangle-serve', import.meta.url) });
  state.ws = ws;

  // Client-side ping watchdog: if the relay silently disappears (half-open, no
  // FIN, no server ping arriving), terminate so `close` fires and we reconnect
  // instead of sitting on a dead socket forever.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const pingTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!alive) { try { ws.terminate(); } catch {} return; }
    alive = false;
    try { ws.ping(); } catch { /* next tick terminates */ }
  }, agentPingIntervalMs());
  ws.on('close', () => clearInterval(pingTimer));

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
        state.reconnectAttempts = 0; // successful registration → reset backoff
        state.output.info(`Agent registered: ${msg.agentId}`);
        
        // Display the single served capability (pinned or ephemeral).
        displayCapability(state);

        // Announce all capabilities
        for (const capId of state.capabilities.keys()) {
          announceCapability(state, capId);
        }

        // Re-establish any public shares dropped when the previous socket closed.
        state.publicShare?.reannounceAll();
      } else if (state.publicShare && state.publicShare.handleMessage(msg)) {
        // Public-share control/proxy message — handled by the controller.
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
        const session = handleInvokerConnection(state.ws!, socketId, cap, state.passwordHash, state.pipeEndpoints, state.getWorkspace);
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
    // Tear down this connection's relay sessions so child processes / PTYs are
    // not orphaned. In shared-workspace mode `cleanup()` only DETACHES viewports
    // (the shells live on in the SharedWorkspace and are replayed when a viewer
    // re-attaches after reconnect); in per-session mode it kills the now
    // unreachable processes. Either way, no leak.
    for (const session of relaySessions.values()) {
      try { session?.cleanup?.(); } catch { /* best effort */ }
    }
    relaySessions.clear();

    // Exponential backoff + full jitter so a flapping relay / thundering herd of
    // agents doesn't hammer reconnects in lockstep.
    const attempt = state.reconnectAttempts ?? 0;
    const backoff = Math.min(AGENT_RC_CAP, AGENT_RC_BASE * Math.pow(AGENT_RC_FACTOR, attempt));
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    state.reconnectAttempts = attempt + 1;
    setTimeout(() => connectToServer(state, serverUrl), delay);
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