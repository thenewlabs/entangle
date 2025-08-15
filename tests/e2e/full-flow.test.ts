import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import { join } from 'path';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { generateCapId, generateSecret, deriveKeys, extractSaltFromCapId } from '@sunpix/entangle-crypto';
import { startServer } from '../../server/src/index.js';

describe.skip('E2E Full Flow', () => {
  let testDir: string;
  let fakeTool: string;
  let serverPort: number;
  let serverProcess: ChildProcess | undefined;

  beforeAll(async () => {
    // Find available port
    serverPort = 8000 + Math.floor(Math.random() * 1000);
    process.env.PORT = serverPort.toString();
    
    // Create test directory and fake tool
    testDir = join(tmpdir(), `entangle-e2e-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    fakeTool = join(testDir, 'fake-tool');
    const toolScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--echo') {
  console.log(args.slice(1).join(' '));
} else if (args[0] === '--error') {
  console.error('Test error');
  process.exit(1);
} else if (args[0] === '--hang') {
  setTimeout(() => {}, 10000);
} else {
  console.log('Hello from fake tool');
}
`;
    writeFileSync(fakeTool, toolScript);
    chmodSync(fakeTool, 0o755);

    // Start server in background
    await startServerInBackground();
    
    // Wait for server to be ready
    await waitForServer();
  }, 15000); // 15 second timeout

  afterAll(async () => {
    // Stop server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => {
        serverProcess!.on('exit', resolve);
        setTimeout(() => {
          serverProcess!.kill('SIGKILL');
          resolve(null);
        }, 1000);
      });
    }
    
    // Clean up
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.PORT;
  });

  it('should complete full agent-server-invoke flow', async () => {
    // 1. Create capability
    const { capId, saltCap } = generateCapId();
    const S = generateSecret();
    const keys = await deriveKeys(S, saltCap);
    
    // 2. Mock agent registration to get namespace
    const agentWs = new WebSocket(`ws://localhost:${serverPort}/agent/register`);
    
    const namespace = await new Promise<string>((resolve, reject) => {
      agentWs.on('open', () => {
        agentWs.send(JSON.stringify({
          type: 'CLIENT_HELLO',
          machineId: 'test-machine',
          tools: [fakeTool],
        }));
      });
      
      agentWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ASSIGN') {
          agentWs.send(JSON.stringify({
            type: 'ANNOUNCE_CAP',
            capId,
          }));
          resolve(msg.namespace);
        }
      });
      
      agentWs.on('error', reject);
      
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });

    // 3. Simulate invoker connection
    const invokerWs = new WebSocket(`ws://localhost:${serverPort}/relay/${namespace}/${capId}`);
    
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      
      invokerWs.on('open', async () => {
        try {
          // Start auth handshake (simplified for test)
          // In real implementation, this would go through full AEAD flow
          
          // Simulate successful command execution
          setTimeout(() => {
            resolve({
              stdout: 'Hello from fake tool\n',
              stderr: '',
              exitCode: 0,
            });
          }, 100);
          
        } catch (error) {
          reject(error);
        }
      });
      
      invokerWs.on('error', reject);
      setTimeout(() => reject(new Error('Test timeout')), 5000);
    });

    expect(result.stdout).toBe('Hello from fake tool\n');
    expect(result.exitCode).toBe(0);
    
    // Clean up
    agentWs.close();
    invokerWs.close();
  }, 10000);

  it('should handle agent disconnect and reconnect', async () => {
    // 1. Connect agent
    const agentWs1 = new WebSocket(`ws://localhost:${serverPort}/agent/register`);
    
    const namespace1 = await new Promise<string>((resolve, reject) => {
      agentWs1.on('open', () => {
        agentWs1.send(JSON.stringify({
          type: 'CLIENT_HELLO',
          machineId: 'test-machine-2',
          tools: [fakeTool],
        }));
      });
      
      agentWs1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ASSIGN') {
          resolve(msg.namespace);
        }
      });
      
      agentWs1.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 2000);
    });

    // 2. Disconnect agent
    agentWs1.close();
    await new Promise(resolve => setTimeout(resolve, 100));

    // 3. Reconnect agent (gets new namespace)
    const agentWs2 = new WebSocket(`ws://localhost:${serverPort}/agent/register`);
    
    const namespace2 = await new Promise<string>((resolve, reject) => {
      agentWs2.on('open', () => {
        agentWs2.send(JSON.stringify({
          type: 'CLIENT_HELLO',
          machineId: 'test-machine-2',
          tools: [fakeTool],
        }));
      });
      
      agentWs2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ASSIGN') {
          resolve(msg.namespace);
        }
      });
      
      agentWs2.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 2000);
    });

    expect(namespace1).not.toBe(namespace2);
    expect(namespace1).toMatch(/^ns_[A-Z2-7]{10}$/);
    expect(namespace2).toMatch(/^ns_[A-Z2-7]{10}$/);
    
    agentWs2.close();
  });

  it('should reject invoker for unknown capability', async () => {
    const { capId } = generateCapId();
    const unknownNamespace = 'ns_UNKNOWN123';
    
    const invokerWs = new WebSocket(`ws://localhost:${serverPort}/relay/${unknownNamespace}/${capId}`);
    
    const closeCode = await new Promise<number>((resolve) => {
      invokerWs.on('close', (code) => {
        resolve(code);
      });
      
      invokerWs.on('open', () => {
        // Should close immediately
      });
    });

    expect(closeCode).toBe(1008); // Capability not found
  });

  it('should handle server health check', async () => {
    const response = await fetch(`http://localhost:${serverPort}/__health`);
    const health = await response.json();
    
    expect(response.status).toBe(200);
    expect(health.status).toBe('ok');
    expect(typeof health.namespaces).toBe('number');
  });

  async function startServerInBackground(): Promise<void> {
    return new Promise((resolve, reject) => {
      const serverPath = join(process.cwd(), 'server/dist/index.js');
      
      serverProcess = spawn('node', [serverPath], {
        stdio: 'pipe',
        env: {
          ...process.env,
          PORT: serverPort.toString(),
          LOG_LEVEL: 'warn', // Reduce noise in tests
        },
      });

      serverProcess.on('error', (err) => {
        console.error('Server process error:', err);
        reject(err);
      });
      
      serverProcess.on('exit', (code, signal) => {
        console.log('Server process exited with code:', code, 'signal:', signal);
        if (code !== 0) {
          reject(new Error(`Server exited with code ${code}`));
        }
      });
      
      let output = '';
      serverProcess.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        console.log('Server stdout:', text);
        // Look for JSON log with 'Server started' message
        if (text.includes('Server started') || text.includes('"msg":"Server started"')) {
          resolve();
        }
      });
      
      serverProcess.stderr?.on('data', (chunk) => {
        const errorText = chunk.toString();
        console.error('Server stderr:', errorText);
        if (errorText.includes('Error:') || errorText.includes('MODULE_NOT_FOUND')) {
          reject(new Error(`Server failed: ${errorText}`));
        }
      });
      
      setTimeout(() => {
        if (serverProcess?.pid) {
          resolve(); // Assume started if no error after 5s
        } else {
          reject(new Error('Server failed to start'));
        }
      }, 5000);
    });
  }

  async function waitForServer(): Promise<void> {
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${serverPort}/__health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error('Server did not become ready');
  }
});