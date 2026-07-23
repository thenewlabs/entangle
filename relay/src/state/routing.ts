import type WebSocket from 'ws';
import { randomBytes } from 'crypto';
import { OutputHandler, parseOutputMode, getConfig, isValidCapId, isBoundedString } from '@thenewlabs/entangle-utils';
import { validateSubdomain, normalizeSubdomain, type SubdomainRejection } from './share-validation.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

// Unguessable routing identifier (CSPRNG) so a malicious agent cannot target
// another relay's invoker by guessing ids.
function newId(): string {
  return randomBytes(12).toString('base64url');
}

interface AgentInfo {
  ws: WebSocket;
  machineId: string;
  capabilities: Set<string>;
  // Public-share subdomains reserved by this agent. Released wholesale when the
  // agent's socket closes so a dropped agent frees its subdomains immediately.
  shares: Set<string>;
  lastHeartbeat: number;
}

/**
 * A reserved public-share subdomain, routed to a plaintext HTTP tunnel on the
 * owning agent. `shareId` is minted agent-side; the relay only routes by it.
 */
export interface ShareInfo {
  subdomain: string;
  agentId: string;
  shareId: string;
  createdAt: number;
}

export type ShareReserveResult =
  | { ok: true; subdomain: string }
  | { ok: false; reason: SubdomainRejection | 'taken' | 'limit' };

interface InvokerInfo {
  ws: WebSocket;
  capId: string;
  connectedAt: number;
}

export class RoutingState {
  private agents = new Map<string, AgentInfo>();
  private invokers = new Map<string, InvokerInfo>();
  private capIdToAgent = new Map<string, string>(); // capId -> agentId
  private shares = new Map<string, ShareInfo>(); // subdomain -> ShareInfo

  registerAgent(ws: WebSocket, machineId: string): string | null {
    // Ceilings come from the validated config so a malformed RELAY_MAX_* value
    // falls back to a safe default instead of NaN (which disables the check).
    const maxAgents = getConfig().relayMaxAgents;
    if (this.agents.size >= maxAgents) {
      output.warn(`Rejecting agent registration: at capacity (${this.agents.size}/${maxAgents})`);
      return null;
    }

    const agentId = newId();

    const agent: AgentInfo = {
      ws,
      machineId,
      capabilities: new Set(),
      shares: new Set(),
      lastHeartbeat: Date.now(),
    };
    
    this.agents.set(agentId, agent);
    
    output.info(`Agent registered: ${agentId} (machine: ${machineId})`);
    
    ws.on('close', () => {
      this.removeAgent(agentId);
    });
    
    return agentId;
  }
  
  announceCapability(agentId: string, capId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Reject malformed / oversized capability ids before they enter any map or
    // log line.
    if (!isValidCapId(capId)) {
      output.warn(`Rejecting capability announcement with invalid capId from agent ${agentId}`);
      return false;
    }

    // Check if another agent already owns this capId
    const existingAgentId = this.capIdToAgent.get(capId);
    if (existingAgentId && existingAgentId !== agentId) {
      output.warn(`Capability ${capId} already owned by agent ${existingAgentId} (requested by ${agentId})`);
      return false;
    }

    // Bound the per-agent capability set so a single connection cannot announce
    // unlimited capabilities into the routing maps.
    const maxCaps = getConfig().relayMaxCapsPerAgent;
    if (!agent.capabilities.has(capId) && agent.capabilities.size >= maxCaps) {
      output.warn(`Rejecting capability ${capId}: agent ${agentId} at cap limit (${maxCaps})`);
      return false;
    }

    agent.capabilities.add(capId);
    this.capIdToAgent.set(capId, agentId);
    output.info(`Capability announced: ${capId} by agent ${agentId}`);
    
    return true;
  }
  
  findAgent(capId: string): WebSocket | null {
    const agentId = this.capIdToAgent.get(capId);
    if (!agentId) return null;
    
    const agent = this.agents.get(agentId);
    if (!agent || !agent.capabilities.has(capId)) return null;
    
    return agent.ws;
  }
  
  registerInvoker(ws: WebSocket, capId: string): string {
    // Basic per-capability concurrency limiting using relayBurst as a cap
    const relayBurst = parseInt(process.env.RELAY_BURST || '50', 10);
    const current = this.countInvokersForCap(capId);
    if (current >= relayBurst) {
      output.warn(`Too many concurrent invokers for capability ${capId}: ${current}/${relayBurst}`);
      // Proactively close
      try { ws.close(1013, 'Over capacity'); } catch {}
      throw new Error('Over capacity');
    }
    const invokerId = newId();
    
    const invoker: InvokerInfo = {
      ws,
      capId,
      connectedAt: Date.now(),
    };
    
    this.invokers.set(invokerId, invoker);
    
    output.info(`Invoker registered: ${invokerId} for capability ${capId}`);
    
    ws.on('close', () => {
      this.removeInvoker(invokerId);
    });
    
    return invokerId;
  }

  // ---------------------------------------------------------------------------
  // Public shares (plaintext HTTP tunnels on a user-chosen subdomain).
  //
  // Unlike a capability, a share carries NO end-to-end encryption: the relay
  // terminates HTTP on `<subdomain>.<RELAY_SHARE_HOST>` and forwards it to the
  // owning agent over the (agent-token-authenticated) control channel. Routing
  // is purely by subdomain → agent; the relay never holds a capability secret.
  // ---------------------------------------------------------------------------

  /**
   * Reserve a subdomain for an agent's share. Fails closed on an invalid or
   * reserved label, an already-taken subdomain (owned by anyone else), or when
   * the agent is at its per-agent share limit. Re-reserving the SAME subdomain
   * with the SAME agent+shareId is idempotent (survives an agent reconnect that
   * re-announces its shares).
   */
  reserveShare(agentId: string, rawSubdomain: string, shareId: string): ShareReserveResult {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, reason: 'taken' };

    const rejection = validateSubdomain(rawSubdomain);
    if (rejection) return { ok: false, reason: rejection };
    const subdomain = normalizeSubdomain(rawSubdomain);

    if (!isBoundedString(shareId, 64)) return { ok: false, reason: 'invalid' };

    const existing = this.shares.get(subdomain);
    if (existing) {
      // Idempotent re-announce by the same owner is fine; anyone else is denied.
      if (existing.agentId === agentId && existing.shareId === shareId) {
        return { ok: true, subdomain };
      }
      return { ok: false, reason: 'taken' };
    }

    const maxShares = getConfig().relayMaxSharesPerAgent;
    if (agent.shares.size >= maxShares) {
      output.warn(`Rejecting share ${subdomain}: agent ${agentId} at share limit (${maxShares})`);
      return { ok: false, reason: 'limit' };
    }

    this.shares.set(subdomain, { subdomain, agentId, shareId, createdAt: Date.now() });
    agent.shares.add(subdomain);
    output.info(`Share reserved: ${subdomain} by agent ${agentId}`);
    return { ok: true, subdomain };
  }

  /** Release a subdomain, but only if `agentId` currently owns it. */
  releaseShare(agentId: string, rawSubdomain: string): boolean {
    const subdomain = normalizeSubdomain(rawSubdomain);
    const info = this.shares.get(subdomain);
    if (!info || info.agentId !== agentId) return false;
    this.shares.delete(subdomain);
    this.agents.get(agentId)?.shares.delete(subdomain);
    output.info(`Share released: ${subdomain} by agent ${agentId}`);
    return true;
  }

  /** Look up the share routed to a subdomain, if any. */
  lookupShare(rawSubdomain: string): ShareInfo | null {
    return this.shares.get(normalizeSubdomain(rawSubdomain)) ?? null;
  }

  /**
   * Whether a subdomain could be reserved right now: well-formed, non-reserved,
   * and not already taken. Returns a reason when not available.
   */
  shareAvailability(rawSubdomain: string): { available: boolean; reason?: SubdomainRejection | 'taken' } {
    const rejection = validateSubdomain(rawSubdomain);
    if (rejection) return { available: false, reason: rejection };
    if (this.shares.has(normalizeSubdomain(rawSubdomain))) return { available: false, reason: 'taken' };
    return { available: true };
  }

  /** The live agent socket for an agentId, or null. */
  getAgentWs(agentId: string): WebSocket | null {
    return this.agents.get(agentId)?.ws ?? null;
  }

  countInvokersForCap(capId: string): number {
    let count = 0;
    for (const inv of this.invokers.values()) {
      if (inv.capId === capId) count++;
    }
    return count;
  }
  
  private removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    
    // Remove all capabilities owned by this agent
    for (const capId of agent.capabilities) {
      this.capIdToAgent.delete(capId);
    }

    // Release all public-share subdomains owned by this agent so a dropped
    // agent frees its subdomains for immediate reuse.
    for (const subdomain of agent.shares) {
      this.shares.delete(subdomain);
    }

    this.agents.delete(agentId);
    
    output.info(`Agent removed: ${agentId}`);
  }
  
  private removeInvoker(invokerId: string): void {
    const invoker = this.invokers.get(invokerId);
    if (!invoker) return;
    
    this.invokers.delete(invokerId);
    
    output.info(`Invoker removed: ${invokerId}`);
  }
  
  updateHeartbeat(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastHeartbeat = Date.now();
    }
  }
  
  getAgentCount(): number {
    return this.agents.size;
  }
  
  findInvoker(invokerId: string): InvokerInfo | null {
    return this.invokers.get(invokerId) || null;
  }

  /**
   * True only if `invokerId` is connected for a capability currently owned by
   * `agentId`. Used to stop an agent from delivering frames to an invoker that
   * belongs to a different agent's relay.
   */
  invokerBelongsToAgent(invokerId: string, agentId: string): boolean {
    const invoker = this.invokers.get(invokerId);
    if (!invoker) return false;
    return this.capIdToAgent.get(invoker.capId) === agentId;
  }
  
  cleanupStale(maxAge: number = 300000): void {
    const now = Date.now();
    const staleAgents: string[] = [];
    
    for (const [agentId, agent] of this.agents) {
      if (now - agent.lastHeartbeat > maxAge) {
        output.warn(`Removing stale agent: ${agentId}`);
        staleAgents.push(agentId);
      }
    }
    
    // Remove stale agents in a separate loop to avoid iterator issues
    for (const agentId of staleAgents) {
      const agent = this.agents.get(agentId);
      if (agent) {
        // Close the WebSocket, which will trigger the 'close' event
        // that calls removeAgent automatically
        agent.ws.close();
      }
    }
  }
}
