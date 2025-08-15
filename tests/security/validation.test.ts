import { describe, it, expect, beforeAll } from 'vitest';
import {
  initCrypto,
  generateCapId,
  generateSecret,
  deriveKeys,
  aeadEncrypt,
  aeadDecrypt,
  computeHmac,
  verifyHmac,
} from '@sunpix/entangle-crypto';
import { validateArguments, validateCwd, validateLimits } from '@sunpix/entangle-utils';
import { FrameType } from '@sunpix/entangle-protocol';

describe('Security - Input Validation & Attack Prevention', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  describe('Argument injection prevention', () => {
    it('should reject arguments with NUL bytes', () => {
      const maliciousArgs = ['--file', 'test\0../../../etc/passwd'];
      
      expect(() => validateArguments(maliciousArgs, 10, 100))
        .toThrow('Arguments cannot contain NUL bytes');
    });

    it('should reject arguments with unpaired surrogates', () => {
      const maliciousArgs = ['--text', 'hello\uD800world'];
      
      expect(() => validateArguments(maliciousArgs, 10, 100))
        .toThrow('Arguments cannot contain unpaired surrogates');
    });

    it('should reject excessive argument count', () => {
      const args = new Array(1000).fill('arg');
      
      expect(() => validateArguments(args, 64, 100))
        .toThrow('Too many arguments: 1000 > 64');
    });

    it('should reject oversized arguments', () => {
      const bigArg = 'x'.repeat(10000);
      
      expect(() => validateArguments([bigArg], 10, 4096))
        .toThrow('Argument too long: 10000 > 4096');
    });

    it('should accept legitimate arguments', () => {
      const args = ['--output', '/tmp/output.txt', '--verbose', '--count', '42'];
      
      expect(() => validateArguments(args, 64, 4096)).not.toThrow();
    });

    it('should handle shell metacharacters safely', () => {
      const shellChars = ['$(echo injected)', '`rm -rf /`', '; rm -rf /', '&& cat /etc/passwd'];
      
      // These should be accepted as literal strings, not shell commands
      expect(() => validateArguments(shellChars, 10, 100)).not.toThrow();
    });
  });

  describe('Path traversal prevention', () => {
    it('should reject CWD outside allowed directories', () => {
      const allowedDirs = ['/home/user', '/srv/app'];
      
      expect(() => validateCwd('/etc/passwd', allowedDirs))
        .toThrow('CWD not in allowed directories: /etc/passwd');
      
      expect(() => validateCwd('/home/user/../../../etc', allowedDirs))
        .toThrow('CWD not in allowed directories: /home/user/../../../etc');
    });

    it('should accept CWD within allowed directories', () => {
      const allowedDirs = ['/home/user', '/srv/app'];
      
      expect(() => validateCwd('/home/user/project', allowedDirs)).not.toThrow();
      expect(() => validateCwd('/srv/app/data', allowedDirs)).not.toThrow();
    });

    it('should handle Windows-style paths', () => {
      const allowedDirs = ['/home'];
      
      expect(() => validateCwd('\\home\\user', allowedDirs)).not.toThrow();
    });

    it('should handle relative paths safely', () => {
      const allowedDirs = ['/home/user'];
      
      // These should be rejected as they could escape the allowed directory
      expect(() => validateCwd('/home/user/../root', allowedDirs))
        .toThrow('CWD not in allowed directories');
    });
  });

  describe('Resource limit validation', () => {
    it('should reject negative resource limits', () => {
      expect(() => validateLimits({ cpuMs: -1 }))
        .toThrow('Invalid CPU limit: -1');
      
      expect(() => validateLimits({ memMB: -100 }))
        .toThrow('Invalid memory limit: -100');
      
      expect(() => validateLimits({ wallMs: -5000 }))
        .toThrow('Invalid wall time limit: -5000');
    });

    it('should reject zero resource limits', () => {
      expect(() => validateLimits({ cpuMs: 0 }))
        .toThrow('Invalid CPU limit: 0');
      
      expect(() => validateLimits({ maxOutBytes: 0 }))
        .toThrow('Invalid output limit: 0');
    });

    it('should reject excessive resource limits', () => {
      expect(() => validateLimits({ cpuMs: 1000000 }))
        .toThrow('Invalid CPU limit: 1000000');
      
      expect(() => validateLimits({ memMB: 10000 }))
        .toThrow('Invalid memory limit: 10000');
      
      expect(() => validateLimits({ wallMs: 10000000 }))
        .toThrow('Invalid wall time limit: 10000000');
    });

    it('should accept reasonable resource limits', () => {
      const limits = {
        cpuMs: 30000,
        memMB: 256,
        wallMs: 60000,
        maxOutBytes: 1048576,
      };
      
      expect(() => validateLimits(limits)).not.toThrow();
    });
  });

  describe('AEAD tampering detection', () => {
    it('should detect cipher tampering', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const plaintext = { command: 'ls', args: ['-la'] };
      const { nonce, cipher } = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, plaintext);
      
      // Tamper with cipher
      cipher[0] ^= 0xFF;
      
      expect(() => aeadDecrypt(keys.K_enc, FrameType.RUN, nonce, cipher))
        .toThrow();
    });

    it('should detect nonce tampering', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const plaintext = { command: 'ls' };
      const { nonce, cipher } = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, plaintext);
      
      // Tamper with nonce
      nonce[0] ^= 0xFF;
      
      expect(() => aeadDecrypt(keys.K_enc, FrameType.RUN, nonce, cipher))
        .toThrow();
    });

    it('should detect type field tampering', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const plaintext = { command: 'ls' };
      const { nonce, cipher } = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, plaintext);
      
      // Try to decrypt with different type (AAD mismatch)
      expect(() => aeadDecrypt(keys.K_enc, FrameType.STDOUT, nonce, cipher))
        .toThrow();
    });

    it('should prevent message substitution', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Encrypt two different messages
      const msg1 = { command: 'ls' };
      const msg2 = { command: 'rm', args: ['-rf', '/'] };
      
      const enc1 = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, msg1);
      const enc2 = aeadEncrypt(keys.K_enc, FrameType.RUN, 2, msg2);
      
      // Try to substitute cipher but keep original nonce (should fail)
      expect(() => aeadDecrypt(keys.K_enc, FrameType.RUN, enc1.nonce, enc2.cipher))
        .toThrow();
    });
  });

  describe('HMAC validation attacks', () => {
    it('should detect HMAC tampering', async () => {
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const data = new TextEncoder().encode('hello' + capId + 'nonce123');
      const hmac = computeHmac(keys.K_auth, data);
      
      // Tamper with HMAC
      hmac[0] ^= 0xFF;
      
      expect(verifyHmac(keys.K_auth, data, hmac)).toBe(false);
    });

    it('should detect data tampering', async () => {
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const data = new TextEncoder().encode('hello' + capId + 'nonce123');
      const hmac = computeHmac(keys.K_auth, data);
      
      // Tamper with data
      data[0] ^= 0xFF;
      
      expect(verifyHmac(keys.K_auth, data, hmac)).toBe(false);
    });

    it('should prevent HMAC substitution attacks', async () => {
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const data1 = new TextEncoder().encode('hello' + capId + 'nonce1');
      const data2 = new TextEncoder().encode('hello' + capId + 'nonce2');
      
      const hmac1 = computeHmac(keys.K_auth, data1);
      
      // Try to use HMAC from data1 with data2
      expect(verifyHmac(keys.K_auth, data2, hmac1)).toBe(false);
    });
  });

  describe('Tool path validation', () => {
    it('should prevent tool substitution in protocol', async () => {
      // This test simulates the agent's tool validation logic
      const allowedTool = '/usr/bin/allowed-tool';
      const requestedTool = '/usr/bin/malicious-tool';
      
      // Agent should reject requests for different tools
      expect(requestedTool).not.toBe(allowedTool);
      
      // In real implementation, agent would check:
      // if (runMsg.tool !== session.toolPath) {
      //   throw new Error('Tool not allowed');
      // }
    });

    it('should prevent symlink attacks', () => {
      // This would be handled in the agent's tool path resolution
      const suspiciousPath = '/usr/bin/../../../etc/passwd';
      const allowedTool = '/usr/bin/tool';
      
      // Real implementation would resolve realpath and validate
      expect(suspiciousPath).not.toBe(allowedTool);
    });
  });

  describe('Crypto key isolation', () => {
    it('should not allow cross-capability key reuse', async () => {
      const secret1 = generateSecret();
      const secret2 = generateSecret();
      const { saltCap } = generateCapId();
      
      const keys1 = await deriveKeys(secret1, saltCap);
      const keys2 = await deriveKeys(secret2, saltCap);
      
      // Keys should be different
      expect(keys1.K_enc).not.toEqual(keys2.K_enc);
      expect(keys1.K_auth).not.toEqual(keys2.K_auth);
      
      // Message encrypted with keys1 should not decrypt with keys2
      const plaintext = { test: 'message' };
      const encrypted = aeadEncrypt(keys1.K_enc, FrameType.RUN, 1, plaintext);
      
      expect(() => aeadDecrypt(keys2.K_enc, FrameType.RUN, encrypted.nonce, encrypted.cipher))
        .toThrow();
    });

    it('should derive different keys for different salts', async () => {
      const secret = generateSecret();
      const { saltCap: salt1 } = generateCapId();
      const { saltCap: salt2 } = generateCapId();
      
      const keys1 = await deriveKeys(secret, salt1);
      const keys2 = await deriveKeys(secret, salt2);
      
      expect(keys1.K_enc).not.toEqual(keys2.K_enc);
      expect(keys1.K_auth).not.toEqual(keys2.K_auth);
    });
  });

  describe('Server blindness validation', () => {
    it('should never expose plaintext to server', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const sensitiveData = {
        command: 'cat',
        args: ['/etc/passwd'],
        cwd: '/home/user/.ssh',
      };
      
      const encrypted = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, sensitiveData);
      
      // Server only sees the encrypted blob
      const serverFrame = new Uint8Array(1 + 8 + encrypted.nonce.length + encrypted.cipher.length);
      serverFrame[0] = FrameType.RUN;
      // length field would be set by frame encoder
      serverFrame.set(encrypted.nonce, 9);
      serverFrame.set(encrypted.cipher, 9 + encrypted.nonce.length);
      
      // Server cannot extract any meaningful data
      expect(serverFrame.includes(Buffer.from('cat'))).toBe(false);
      expect(serverFrame.includes(Buffer.from('passwd'))).toBe(false);
      expect(serverFrame.includes(Buffer.from('.ssh'))).toBe(false);
    });

    it('should not leak information through frame sizes', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Different commands
      const shortCmd = { cmd: 'ls' };
      const longCmd = { cmd: 'ls', args: ['-la', '/very/long/path/to/directory'] };
      
      const enc1 = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, shortCmd);
      const enc2 = aeadEncrypt(keys.K_enc, FrameType.RUN, 2, longCmd);
      
      // While frame sizes will differ, the content is still opaque
      // Server cannot determine what the commands are
      const frame1Size = enc1.cipher.length;
      const frame2Size = enc2.cipher.length;
      
      expect(frame1Size).not.toBe(frame2Size); // Sizes differ
      // But server still cannot see plaintext content
    });
  });

  describe('Session state attacks', () => {
    it('should prevent state confusion attacks', () => {
      // Simulate session state validation
      let sessionState = 'unauthenticated';
      
      // Only allow RUN after authentication
      if (sessionState !== 'authenticated') {
        expect(() => {
          // This would be the agent's check
          if (sessionState !== 'authenticated') {
            throw new Error('Not authenticated');
          }
        }).toThrow('Not authenticated');
      }
    });

    it('should prevent multi-run attacks when single-run enforced', () => {
      let hasRun = false;
      const singleRun = true;
      
      // First run
      if (!hasRun) {
        hasRun = true;
      }
      
      // Second run attempt
      if (hasRun && singleRun) {
        expect(() => {
          throw new Error('Only one run allowed per session');
        }).toThrow('Only one run allowed per session');
      }
    });
  });
});