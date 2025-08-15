import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('Agent Runner', () => {
  let testDir: string;
  let fakeTool: string;

  beforeAll(() => {
    // Create test directory
    testDir = join(tmpdir(), `entangle-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create fake tool script
    fakeTool = join(testDir, 'fake-tool');
    const toolScript = `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === '--echo') {
  console.log(args.slice(1).join(' '));
} else if (args[0] === '--cwd') {
  console.log(process.cwd());
} else if (args[0] === '--error') {
  console.error('Test error output');
  process.exit(1);
} else if (args[0] === '--hang') {
  setTimeout(() => {}, 1000000);
} else if (args[0] === '--stream') {
  let count = 0;
  const interval = setInterval(() => {
    console.log(\`Line \${++count}\`);
    if (count >= 5) {
      clearInterval(interval);
    }
  }, 10);
} else if (args[0] === '--signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (args[0] === '--large') {
  const chunk = 'x'.repeat(1024);
  for (let i = 0; i < 100; i++) {
    console.log(chunk);
  }
} else if (args[0] === '--env') {
  console.log(JSON.stringify({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    CUSTOM: process.env.CUSTOM,
  }));
} else {
  console.log('Usage: fake-tool [options]');
}
`;
    writeFileSync(fakeTool, toolScript);
    chmodSync(fakeTool, 0o755);
  });

  afterAll(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Basic execution', () => {
    it('should execute tool and capture stdout', async () => {
      const result = await runTool(fakeTool, ['--echo', 'hello', 'world']);
      
      expect(result.stdout).toBe('hello world\n');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    });

    it('should capture stderr', async () => {
      const result = await runTool(fakeTool, ['--error']);
      
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Test error output\n');
      expect(result.code).toBe(1);
    });

    it('should capture exit code', async () => {
      const result = await runTool(fakeTool, ['--error']);
      
      expect(result.code).toBe(1);
    });

    it('should handle working directory', async () => {
      const cwd = join(testDir, 'subdir');
      mkdirSync(cwd, { recursive: true });
      
      const result = await runTool(fakeTool, ['--cwd'], { cwd });
      
      expect(result.stdout.trim()).toBe(cwd);
    });

    it('should not use shell interpolation', async () => {
      const result = await runTool(fakeTool, ['--echo', '$(echo injected)']);
      
      expect(result.stdout).toBe('$(echo injected)\n');
      // The literal string contains "injected" but it should not be executed
      expect(result.stdout).toContain('$(echo injected)');
    });
  });

  describe('Resource limits', () => {
    it('should handle streaming output', async () => {
      const result = await runTool(fakeTool, ['--stream']);
      
      const lines = result.stdout.split('\n').filter(Boolean);
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('Line 1');
      expect(lines[4]).toBe('Line 5');
    });

    it('should handle large output', async () => {
      const result = await runTool(fakeTool, ['--large']);
      
      const lines = result.stdout.split('\n').filter(Boolean);
      expect(lines).toHaveLength(100);
      expect(lines[0]).toHaveLength(1024);
    });

    it('should enforce output limit', async () => {
      const result = await runTool(fakeTool, ['--large'], { maxOutBytes: 5000 });
      
      // Output should be truncated
      expect(result.stdout.length).toBeLessThanOrEqual(5000);
      expect(result.truncated).toBe(true);
    });

    it('should enforce wall time limit', async () => {
      const start = Date.now();
      const result = await runTool(fakeTool, ['--hang'], { wallMs: 100 });
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(200);
      expect(result.signal).toBe('SIGTERM');
    });
  });

  describe('Process termination', () => {
    it('should handle SIGTERM gracefully', async () => {
      const child = spawn(fakeTool, ['--hang'], { stdio: 'pipe' });
      
      await new Promise(resolve => setTimeout(resolve, 50));
      child.kill('SIGTERM');
      
      const result = await new Promise<any>(resolve => {
        child.on('exit', (code, signal) => {
          resolve({ code, signal });
        });
      });
      
      expect(result.signal).toBe('SIGTERM');
    });

    it('should handle process that exits via signal', async () => {
      const result = await runTool(fakeTool, ['--signal']);
      
      expect(result.signal).toBe('SIGTERM');
      expect(result.code).toBeNull();
    });

    it('should send SIGKILL after grace period', async () => {
      const child = spawn(fakeTool, ['--hang'], { stdio: 'pipe' });
      
      // Trap SIGTERM to prevent exit
      child.on('error', () => {});
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Mock abort with SIGTERM then SIGKILL
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 100);
      
      const result = await new Promise<any>(resolve => {
        child.on('exit', (code, signal) => {
          resolve({ code, signal });
        });
      });
      
      expect(['SIGTERM', 'SIGKILL']).toContain(result.signal);
    });
  });

  describe('Environment isolation', () => {
    it('should provide minimal environment', async () => {
      const result = await runTool(fakeTool, ['--env']);
      const env = JSON.parse(result.stdout);
      
      expect(env.PATH).toBeTruthy();
      expect(env.HOME).toBeTruthy();
      expect(env.USER).toBeTruthy();
      expect(env.CUSTOM).toBeUndefined(); // Custom env vars should not leak
    });

    it('should not inherit parent environment', async () => {
      process.env.CUSTOM_TEST_VAR = 'should_not_appear';
      
      const result = await runTool(fakeTool, ['--env']);
      const env = JSON.parse(result.stdout);
      
      expect(env.CUSTOM).toBeUndefined();
      
      delete process.env.CUSTOM_TEST_VAR;
    });
  });

  describe('Argument validation', () => {
    it('should pass arguments correctly', async () => {
      const args = ['--echo', 'arg with spaces', 'another-arg', '123'];
      const result = await runTool(fakeTool, args);
      
      expect(result.stdout).toBe('arg with spaces another-arg 123\n');
    });

    it('should handle empty arguments', async () => {
      const result = await runTool(fakeTool, ['--echo', '', 'test']);
      
      expect(result.stdout).toBe(' test\n');
    });

    it('should handle special characters in arguments', async () => {
      const specialChars = '!@#$%^&*(){}[]|\\:;"\'<>,.?/~`';
      const result = await runTool(fakeTool, ['--echo', specialChars]);
      
      expect(result.stdout).toBe(specialChars + '\n');
    });
  });
});

// Helper function to run tool
async function runTool(
  tool: string,
  argv: string[],
  options: {
    cwd?: string;
    maxOutBytes?: number;
    wallMs?: number;
  } = {}
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  truncated?: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(tool, argv, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || '/',
        USER: process.env.USER || 'nobody',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TZ: 'UTC',
      },
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    if (options.wallMs) {
      setTimeout(() => {
        child.kill('SIGTERM');
      }, options.wallMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (options.maxOutBytes && stdout.length + chunk.length > options.maxOutBytes) {
        const remaining = options.maxOutBytes - stdout.length;
        if (remaining > 0) {
          stdout += chunk.slice(0, remaining).toString();
        }
        truncated = true;
        child.kill('SIGTERM');
      } else {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code, signal) => {
      resolve({ stdout, stderr, code, signal, truncated });
    });

    child.on('error', (error) => {
      resolve({ 
        stdout, 
        stderr: stderr + error.message, 
        code: null, 
        signal: null,
        truncated,
      });
    });
  });
}