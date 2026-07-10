import type WebSocket from 'ws';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

interface AgentInfo {
  ws: WebSocket;
  machineId: string;
  capabilities: Set<string>;
  lastHeartbeat: number;
}

interface InvokerInfo {
  ws: WebSocket;
  capId: string;
  connectedAt: number;
}

export class RoutingState {
  private agents = new Map<string, AgentInfo>();
  private invokers = new Map<string, InvokerInfo>();
  private capIdToAgent = new Map<string, string>(); // capId -> agentId
  
  registerAgent(ws: WebSocket, machineId: string): string {
    const agentId = Math.random().toString(36).substr(2, 9);
    
    const agent: AgentInfo = {
      ws,
      machineId,
      capabilities: new Set(),
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
    
    // Check if another agent already owns this capId
    const existingAgentId = this.capIdToAgent.get(capId);
    if (existingAgentId && existingAgentId !== agentId) {
      output.warn(`Capability ${capId} already owned by agent ${existingAgentId} (requested by ${agentId})`);
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
    const invokerId = Math.random().toString(36).substr(2, 9);
    
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
