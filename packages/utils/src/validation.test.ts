import { describe, it, expect } from 'vitest';
import { validateArguments, validateCwd, validateLimits } from './validation';

describe('Validation Utils', () => {
  describe('validateArguments', () => {
    it('should accept valid arguments', () => {
      const argv = ['--help', 'test', 'file.txt'];
      
      expect(() => validateArguments(argv, 10, 100)).not.toThrow();
    });

    it('should reject too many arguments', () => {
      const argv = new Array(10).fill('arg');
      
      expect(() => validateArguments(argv, 5, 100))
        .toThrow('Too many arguments: 10 > 5');
    });

    it('should reject arguments that are too long', () => {
      const argv = ['x'.repeat(101)];
      
      expect(() => validateArguments(argv, 10, 100))
        .toThrow('Argument too long: 101 > 100');
    });

    it('should reject arguments with NUL bytes', () => {
      const argv = ['test\0arg'];
      
      expect(() => validateArguments(argv, 10, 100))
        .toThrow('Arguments cannot contain NUL bytes');
    });

    it('should reject arguments with unpaired surrogates', () => {
      const argv = ['test\uD800'];
      
      expect(() => validateArguments(argv, 10, 100))
        .toThrow('Arguments cannot contain unpaired surrogates');
    });

    it('should accept empty arguments array', () => {
      expect(() => validateArguments([], 10, 100)).not.toThrow();
    });

    it('should accept arguments with paired surrogates', () => {
      const argv = ['test\uD800\uDC00']; // Valid surrogate pair
      
      expect(() => validateArguments(argv, 10, 100)).not.toThrow();
    });
  });

  describe('validateCwd', () => {
    it('should accept any cwd when no prefixes specified', () => {
      expect(() => validateCwd('/any/path')).not.toThrow();
      expect(() => validateCwd('/etc/passwd')).not.toThrow();
    });

    it('should accept cwd with empty prefixes array', () => {
      expect(() => validateCwd('/any/path', [])).not.toThrow();
    });

    it('should accept cwd matching allowed prefix', () => {
      const prefixes = ['/home', '/srv'];
      
      expect(() => validateCwd('/home/user/project', prefixes)).not.toThrow();
      expect(() => validateCwd('/srv/app', prefixes)).not.toThrow();
    });

    it('should reject cwd not matching any prefix', () => {
      const prefixes = ['/home', '/srv'];
      
      expect(() => validateCwd('/etc/passwd', prefixes))
        .toThrow('CWD not in allowed directories: /etc/passwd');
    });

    it('should normalize Windows paths', () => {
      const prefixes = ['/home'];
      
      expect(() => validateCwd('\\home\\user', prefixes)).not.toThrow();
    });

    it('should handle trailing slashes', () => {
      const prefixes = ['/home/'];
      
      expect(() => validateCwd('/home/user', prefixes)).not.toThrow();
    });
  });

  describe('validateLimits', () => {
    it('should accept undefined limits', () => {
      expect(() => validateLimits()).not.toThrow();
    });

    it('should accept valid limits', () => {
      const limits = {
        cpuMs: 1000,
        memMB: 256,
        wallMs: 5000,
        maxOutBytes: 1024,
      };
      
      expect(() => validateLimits(limits)).not.toThrow();
    });

    it('should reject zero CPU limit', () => {
      expect(() => validateLimits({ cpuMs: 0 }))
        .toThrow('Invalid CPU limit: 0');
    });

    it('should reject negative CPU limit', () => {
      expect(() => validateLimits({ cpuMs: -1 }))
        .toThrow('Invalid CPU limit: -1');
    });

    it('should reject CPU limit exceeding max', () => {
      expect(() => validateLimits({ cpuMs: 100000 }))
        .toThrow('Invalid CPU limit: 100000');
    });

    it('should reject zero memory limit', () => {
      expect(() => validateLimits({ memMB: 0 }))
        .toThrow('Invalid memory limit: 0');
    });

    it('should reject memory limit exceeding max', () => {
      expect(() => validateLimits({ memMB: 1024 }))
        .toThrow('Invalid memory limit: 1024');
    });

    it('should reject zero wall time limit', () => {
      expect(() => validateLimits({ wallMs: 0 }))
        .toThrow('Invalid wall time limit: 0');
    });

    it('should reject wall time limit exceeding max', () => {
      expect(() => validateLimits({ wallMs: 400000 }))
        .toThrow('Invalid wall time limit: 400000');
    });

    it('should reject zero output limit', () => {
      expect(() => validateLimits({ maxOutBytes: 0 }))
        .toThrow('Invalid output limit: 0');
    });

    it('should reject output limit exceeding max', () => {
      expect(() => validateLimits({ maxOutBytes: 20000000 }))
        .toThrow('Invalid output limit: 20000000');
    });

    it('should accept partial limits', () => {
      expect(() => validateLimits({ cpuMs: 1000 })).not.toThrow();
      expect(() => validateLimits({ memMB: 256 })).not.toThrow();
      expect(() => validateLimits({ wallMs: 5000 })).not.toThrow();
      expect(() => validateLimits({ maxOutBytes: 1024 })).not.toThrow();
    });
  });
});