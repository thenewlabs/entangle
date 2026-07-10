import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingState } from '../../relay/src/state/routing.js';
import { EventEmitter } from 'events';

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  
  send(data: any) {
    this.emit('mockSend', data);
  }
  
  close() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

describe('Server Routing', () => {
  let routing: RoutingState;

  beforeEach(() => {
    routing = new RoutingState();
  });

  describe('Agent registration', () => {
    it('should register agent and return agentId', () => {
      const ws = new MockWebSocket() as any;
      const machineId = 'test-machine-123';
      
      const agentId = routing.registerAgent(ws, machineId);
      
      expect(agentId).toBeTruthy();
      expect(agentId).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(routing.getAgentCount()).toBe(1);
    });

    it('should generate unique agent IDs', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      const id1 = routing.registerAgent(ws1, 'machine-1');
      const id2 = routing.registerAgent(ws2, 'machine-2');
      
      expect(id1).not.toBe(id2);
      expect(routing.getAgentCount()).toBe(2);
    });

    it('should clean up on agent disconnect', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');
      
      expect(routing.getAgentCount()).toBe(1);
      
      ws.emit('close');
      
      expect(routing.getAgentCount()).toBe(0);
    });
  });

  describe('Capability announcement', () => {
    it('should announce capability for registered agent', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');
      const capId = 'test-cap-id';
      
      const success = routing.announceCapability(agentId, capId);
      
      expect(success).toBe(true);
    });

    it('should reject announcement for unknown agent', () => {
      const success = routing.announceCapability('unknown-agent', 'cap-id');
      
      expect(success).toBe(false);
    });

    it('should find agent by capId', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');
      const capId = 'test-cap-id';
      
      routing.announceCapability(agentId, capId);
      
      const foundWs = routing.findAgent(capId);
      expect(foundWs).toBe(ws);
    });

    it('should not find agent for unannounced capability', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');
      
      const foundWs = routing.findAgent('unknown-cap');
      expect(foundWs).toBeNull();
    });

    it('should reject duplicate capId from different agent', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      const agentId1 = routing.registerAgent(ws1, 'machine-1');
      const agentId2 = routing.registerAgent(ws2, 'machine-2');
      const capId = 'shared-cap-id';
      
      const success1 = routing.announceCapability(agentId1, capId);
      expect(success1).toBe(true);
      
      const success2 = routing.announceCapability(agentId2, capId);
      expect(success2).toBe(false);
    });

    it('should cap the number of capabilities per agent', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');

      // Default RELAY_MAX_CAPS_PER_AGENT is 256; announcing up to the cap works.
      for (let i = 0; i < 256; i++) {
        expect(routing.announceCapability(agentId, `cap-${i}`)).toBe(true);
      }
      // The 257th distinct capability is rejected so one connection cannot grow
      // the routing maps without bound.
      expect(routing.announceCapability(agentId, 'cap-over')).toBe(false);
      // Re-announcing an already-owned capId is still allowed (idempotent).
      expect(routing.announceCapability(agentId, 'cap-0')).toBe(true);
    });

    it('should clean up capabilities when agent disconnects', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');
      const capId = 'test-cap-id';
      
      routing.announceCapability(agentId, capId);
      expect(routing.findAgent(capId)).toBe(ws);
      
      ws.emit('close');
      
      expect(routing.findAgent(capId)).toBeNull();
    });
  });

  describe('Invoker registration', () => {
    it('should register invoker', () => {
      const ws = new MockWebSocket() as any;
      const capId = 'test-cap-id';
      
      const invokerId = routing.registerInvoker(ws, capId);
      
      expect(invokerId).toBeTruthy();
      expect(invokerId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    });

    it('should generate unique invoker IDs', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      const id1 = routing.registerInvoker(ws1, 'cap1');
      const id2 = routing.registerInvoker(ws2, 'cap2');
      
      expect(id1).not.toBe(id2);
    });

    it('should clean up on invoker disconnect', () => {
      const ws = new MockWebSocket() as any;
      const invokerId = routing.registerInvoker(ws, 'test-cap');
      
      const invoker = routing.findInvoker(invokerId);
      expect(invoker).toBeTruthy();
      
      ws.emit('close');
      
      const invokerAfter = routing.findInvoker(invokerId);
      expect(invokerAfter).toBeNull();
    });

    it('should find invoker by ID', () => {
      const ws = new MockWebSocket() as any;
      const capId = 'test-cap-id';
      
      const invokerId = routing.registerInvoker(ws, capId);
      const found = routing.findInvoker(invokerId);
      
      expect(found).toBeTruthy();
      expect(found?.ws).toBe(ws);
      expect(found?.capId).toBe(capId);
    });
  });

  describe('Heartbeat tracking', () => {
    it('should update heartbeat', () => {
      const ws = new MockWebSocket() as any;
      const agentId = routing.registerAgent(ws, 'test-machine');
      
      // Wait a bit to ensure the heartbeat timestamp changes
      const before = Date.now();
      setTimeout(() => {
        routing.updateHeartbeat(agentId);
      }, 10);
    });

    it('should clean up stale agents', async () => {
      const ws = new MockWebSocket() as any;
      let closeCalled = false;
      ws.close = () => {
        closeCalled = true;
        ws.readyState = 3;
        ws.emit('close');
      };
      
      const agentId = routing.registerAgent(ws, 'test-machine');
      
      expect(routing.getAgentCount()).toBe(1);
      
      // Wait a bit to ensure heartbeat ages
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Clean up with very short max age (1ms)
      routing.cleanupStale(1);
      
      expect(closeCalled).toBe(true);
      expect(routing.getAgentCount()).toBe(0);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle multiple agents with multiple capabilities', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      const agentId1 = routing.registerAgent(ws1, 'machine-1');
      const agentId2 = routing.registerAgent(ws2, 'machine-2');
      
      routing.announceCapability(agentId1, 'cap-1');
      routing.announceCapability(agentId1, 'cap-2');
      routing.announceCapability(agentId2, 'cap-3');
      
      expect(routing.findAgent('cap-1')).toBe(ws1);
      expect(routing.findAgent('cap-2')).toBe(ws1);
      expect(routing.findAgent('cap-3')).toBe(ws2);
    });

    it('should handle agent reconnection with same capabilities', () => {
      const ws1 = new MockWebSocket() as any;
      const agentId1 = routing.registerAgent(ws1, 'machine-1');
      const capId = 'cap-1';
      
      routing.announceCapability(agentId1, capId);
      
      expect(routing.findAgent(capId)).toBe(ws1);
      
      // Disconnect
      ws1.emit('close');
      expect(routing.findAgent(capId)).toBeNull();
      
      // Reconnect
      const ws2 = new MockWebSocket() as any;
      const agentId2 = routing.registerAgent(ws2, 'machine-1');
      routing.announceCapability(agentId2, capId);
      
      expect(routing.findAgent(capId)).toBe(ws2);
    });

    it('should handle rapid connect/disconnect cycles', () => {
      const sockets: MockWebSocket[] = [];
      const agentIds: string[] = [];
      
      // Connect 10 agents
      for (let i = 0; i < 10; i++) {
        const ws = new MockWebSocket() as any;
        sockets.push(ws);
        const agentId = routing.registerAgent(ws, `machine-${i}`);
        agentIds.push(agentId);
        routing.announceCapability(agentId, `cap-${i}`);
      }
      
      expect(routing.getAgentCount()).toBe(10);
      
      // Disconnect half
      for (let i = 0; i < 5; i++) {
        sockets[i].emit('close');
      }
      
      expect(routing.getAgentCount()).toBe(5);
      
      // Verify remaining capabilities
      for (let i = 0; i < 5; i++) {
        expect(routing.findAgent(`cap-${i}`)).toBeNull();
      }
      for (let i = 5; i < 10; i++) {
        expect(routing.findAgent(`cap-${i}`)).toBe(sockets[i]);
      }
    });

    it('should handle concurrent invokers for same capability', () => {
      const agentWs = new MockWebSocket() as any;
      const agentId = routing.registerAgent(agentWs, 'machine');
      const capId = 'shared-cap';
      
      routing.announceCapability(agentId, capId);
      
      const invokerWs1 = new MockWebSocket() as any;
      const invokerWs2 = new MockWebSocket() as any;
      
      const invokerId1 = routing.registerInvoker(invokerWs1, capId);
      const invokerId2 = routing.registerInvoker(invokerWs2, capId);
      
      expect(invokerId1).not.toBe(invokerId2);
      expect(routing.findInvoker(invokerId1)?.ws).toBe(invokerWs1);
      expect(routing.findInvoker(invokerId2)?.ws).toBe(invokerWs2);
    });
  });
});