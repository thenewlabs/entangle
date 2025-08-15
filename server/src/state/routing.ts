import type WebSocket from 'ws';
import { createLogger } from '@sunpix/entangle-utils';
import { generateNamespace } from '@sunpix/entangle-crypto';

const logger = createLogger('routing');

interface AgentInfo {
  ws: WebSocket;
  namespace: string;
  machineId: string;
  capabilities: Set<string>;
  lastHeartbeat: number;
}

interface InvokerInfo {
  ws: WebSocket;
  namespace: string;
  capId: string;
  connectedAt: number;
}

export class RoutingState {
  private agents = new Map<string, AgentInfo>();
  private invokers = new Map<string, InvokerInfo>();
  private namespaceToAgent = new Map<string, string>();
  
  registerAgent(ws: WebSocket, machineId: string): string {
    const namespace = generateNamespace();
    const agentId = Math.random().toString(36).substr(2, 9);
    
    const agent: AgentInfo = {
      ws,
      namespace,
      machineId,
      capabilities: new Set(),
      lastHeartbeat: Date.now(),
    };
    
    this.agents.set(agentId, agent);
    this.namespaceToAgent.set(namespace, agentId);
    
    logger.info({ namespace, agentId, machineId }, 'Agent registered');
    
    ws.on('close', () => {
      this.removeAgent(agentId);
    });
    
    return namespace;
  }
  
  announceCapability(namespace: string, capId: string): boolean {
    const agentId = this.namespaceToAgent.get(namespace);
    if (!agentId) return false;
    
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    
    agent.capabilities.add(capId);
    logger.info({ namespace, capId }, 'Capability announced');
    
    return true;
  }
  
  findAgent(namespace: string, capId: string): WebSocket | null {
    const agentId = this.namespaceToAgent.get(namespace);
    if (!agentId) return null;
    
    const agent = this.agents.get(agentId);
    if (!agent || !agent.capabilities.has(capId)) return null;
    
    return agent.ws;
  }
  
  registerInvoker(ws: WebSocket, namespace: string, capId: string): string {
    const invokerId = Math.random().toString(36).substr(2, 9);
    
    const invoker: InvokerInfo = {
      ws,
      namespace,
      capId,
      connectedAt: Date.now(),
    };
    
    this.invokers.set(invokerId, invoker);
    
    logger.info({ namespace, capId, invokerId }, 'Invoker registered');
    
    ws.on('close', () => {
      this.removeInvoker(invokerId);
    });
    
    return invokerId;
  }
  
  private removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    
    this.namespaceToAgent.delete(agent.namespace);
    this.agents.delete(agentId);
    
    logger.info({ namespace: agent.namespace, agentId }, 'Agent removed');
  }
  
  private removeInvoker(invokerId: string): void {
    const invoker = this.invokers.get(invokerId);
    if (!invoker) return;
    
    this.invokers.delete(invokerId);
    
    logger.info({ invokerId }, 'Invoker removed');
  }
  
  updateHeartbeat(namespace: string): void {
    const agentId = this.namespaceToAgent.get(namespace);
    if (!agentId) return;
    
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastHeartbeat = Date.now();
    }
  }
  
  getNamespaceCount(): number {
    return this.namespaceToAgent.size;
  }
  
  cleanupStale(maxAge: number = 300000): void {
    const now = Date.now();
    
    for (const [agentId, agent] of this.agents) {
      if (now - agent.lastHeartbeat > maxAge) {
        logger.warn({ agentId, namespace: agent.namespace }, 'Removing stale agent');
        agent.ws.close();
        this.removeAgent(agentId);
      }
    }
  }
}