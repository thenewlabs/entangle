import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingState } from '../../server/src/state/routing.js';
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
    it('should register agent and assign namespace', () => {
      const ws = new MockWebSocket() as any;
      const machineId = 'test-machine-123';
      
      const namespace = routing.registerAgent(ws, machineId);
      
      expect(namespace).toMatch(/^ns_[A-Z2-7]{10}$/);
      expect(routing.getNamespaceCount()).toBe(1);
    });

    it('should generate unique namespaces', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      const ns1 = routing.registerAgent(ws1, 'machine-1');
      const ns2 = routing.registerAgent(ws2, 'machine-2');
      
      expect(ns1).not.toBe(ns2);
      expect(routing.getNamespaceCount()).toBe(2);
    });

    it('should clean up on agent disconnect', () => {
      const ws = new MockWebSocket() as any;
      const namespace = routing.registerAgent(ws, 'test-machine');
      
      expect(routing.getNamespaceCount()).toBe(1);
      
      ws.emit('close');
      
      expect(routing.getNamespaceCount()).toBe(0);
    });
  });

  describe('Capability announcement', () => {
    it('should allow agent to announce capabilities', () => {
      const ws = new MockWebSocket() as any;
      const namespace = routing.registerAgent(ws, 'test-machine');
      const capId = 'test-cap-id-123';
      
      const success = routing.announceCapability(namespace, capId);
      
      expect(success).toBe(true);
    });

    it('should reject announcement for unknown namespace', () => {
      const success = routing.announceCapability('ns_UNKNOWN', 'cap-id');
      
      expect(success).toBe(false);
    });

    it('should find agent by namespace and capId', () => {
      const ws = new MockWebSocket() as any;
      const namespace = routing.registerAgent(ws, 'test-machine');
      const capId = 'test-cap-id';
      
      routing.announceCapability(namespace, capId);
      
      const foundWs = routing.findAgent(namespace, capId);
      expect(foundWs).toBe(ws);
    });

    it('should not find agent for unannounced capability', () => {
      const ws = new MockWebSocket() as any;
      const namespace = routing.registerAgent(ws, 'test-machine');
      
      const foundWs = routing.findAgent(namespace, 'unknown-cap');
      expect(foundWs).toBeNull();
    });
  });

  describe('Invoker registration', () => {
    it('should register invoker', () => {
      const ws = new MockWebSocket() as any;
      const namespace = 'ns_TEST123456';
      const capId = 'test-cap-id';
      
      const invokerId = routing.registerInvoker(ws, namespace, capId);
      
      expect(invokerId).toBeTruthy();
      expect(invokerId).toMatch(/^[a-z0-9]{9}$/);
    });

    it('should generate unique invoker IDs', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      const id1 = routing.registerInvoker(ws1, 'ns_TEST1', 'cap1');
      const id2 = routing.registerInvoker(ws2, 'ns_TEST2', 'cap2');
      
      expect(id1).not.toBe(id2);
    });

    it('should clean up on invoker disconnect', () => {
      const ws = new MockWebSocket() as any;
      
      routing.registerInvoker(ws, 'ns_TEST', 'cap-id');
      
      // Should not throw
      ws.emit('close');
    });
  });

  describe('Heartbeat tracking', () => {
    it('should update heartbeat timestamp', () => {
      const ws = new MockWebSocket() as any;
      const namespace = routing.registerAgent(ws, 'test-machine');
      
      // Should not throw
      routing.updateHeartbeat(namespace);
    });

    it('should ignore heartbeat for unknown namespace', () => {
      // Should not throw
      routing.updateHeartbeat('ns_UNKNOWN');
    });

    it('should clean up stale agents', async () => {
      const ws = new MockWebSocket() as any;
      const namespace = routing.registerAgent(ws, 'test-machine');
      
      expect(routing.getNamespaceCount()).toBe(1);
      
      // Wait a bit to ensure the heartbeat timestamp is set
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Simulate stale agent (older than maxAge)
      routing.cleanupStale(0); // maxAge = 0 means everything is stale
      
      // Allow event loop to process the close event
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(routing.getNamespaceCount()).toBe(0);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle multiple agents with multiple capabilities', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      const ns1 = routing.registerAgent(ws1, 'machine-1');
      const ns2 = routing.registerAgent(ws2, 'machine-2');
      
      routing.announceCapability(ns1, 'cap-1');
      routing.announceCapability(ns1, 'cap-2');
      routing.announceCapability(ns2, 'cap-3');
      
      expect(routing.findAgent(ns1, 'cap-1')).toBe(ws1);
      expect(routing.findAgent(ns1, 'cap-2')).toBe(ws1);
      expect(routing.findAgent(ns2, 'cap-3')).toBe(ws2);
      
      expect(routing.findAgent(ns1, 'cap-3')).toBeNull();
      expect(routing.findAgent(ns2, 'cap-1')).toBeNull();
    });

    it('should handle agent reconnection with same capabilities', () => {
      const ws1 = new MockWebSocket() as any;
      const ws2 = new MockWebSocket() as any;
      
      // First connection
      const ns1 = routing.registerAgent(ws1, 'machine-1');
      routing.announceCapability(ns1, 'cap-1');
      
      expect(routing.findAgent(ns1, 'cap-1')).toBe(ws1);
      
      // Disconnect
      ws1.emit('close');
      expect(routing.getNamespaceCount()).toBe(0);
      
      // Reconnect with new namespace (new agent instance)
      const ns2 = routing.registerAgent(ws2, 'machine-1');
      routing.announceCapability(ns2, 'cap-1');
      
      expect(routing.findAgent(ns2, 'cap-1')).toBe(ws2);
      expect(routing.findAgent(ns1, 'cap-1')).toBeNull(); // Old namespace invalid
    });

    it('should handle rapid connect/disconnect cycles', () => {
      const agents: MockWebSocket[] = [];
      const namespaces: string[] = [];
      
      // Create multiple agents
      for (let i = 0; i < 10; i++) {
        const ws = new MockWebSocket() as any;
        const ns = routing.registerAgent(ws, `machine-${i}`);
        agents.push(ws);
        namespaces.push(ns);
        routing.announceCapability(ns, `cap-${i}`);
      }
      
      expect(routing.getNamespaceCount()).toBe(10);
      
      // Disconnect half
      for (let i = 0; i < 5; i++) {
        agents[i].emit('close');
      }
      
      expect(routing.getNamespaceCount()).toBe(5);
      
      // Check remaining agents still work
      for (let i = 5; i < 10; i++) {
        expect(routing.findAgent(namespaces[i], `cap-${i}`)).toBe(agents[i]);
      }
    });

    it('should handle concurrent invokers for same capability', () => {
      const agentWs = new MockWebSocket() as any;
      const namespace = routing.registerAgent(agentWs, 'machine');
      const capId = 'shared-cap';
      
      routing.announceCapability(namespace, capId);
      
      const invoker1 = new MockWebSocket() as any;
      const invoker2 = new MockWebSocket() as any;
      
      const id1 = routing.registerInvoker(invoker1, namespace, capId);
      const id2 = routing.registerInvoker(invoker2, namespace, capId);
      
      expect(id1).not.toBe(id2);
      expect(routing.findAgent(namespace, capId)).toBe(agentWs);
    });
  });
});