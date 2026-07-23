import { describe, it, expect } from 'vitest';
import {
  normalizeSubdomain,
  validateSubdomain,
  isValidSubdomain,
  RESERVED_SUBDOMAINS,
} from './share-validation.js';

describe('share subdomain validation', () => {
  it('accepts well-formed labels', () => {
    for (const ok of ['a', 'my-demo', 'demo3000', 'a1', 'x'.repeat(63)]) {
      expect(validateSubdomain(ok), ok).toBeNull();
      expect(isValidSubdomain(ok)).toBe(true);
    }
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(normalizeSubdomain('  MyDemo ')).toBe('mydemo');
    expect(validateSubdomain('  MyDemo ')).toBeNull();
  });

  it('rejects empty, over-length, and bad characters', () => {
    expect(validateSubdomain('')).toBe('invalid');
    expect(validateSubdomain('x'.repeat(64))).toBe('invalid');
    expect(validateSubdomain('-lead')).toBe('invalid');
    expect(validateSubdomain('trail-')).toBe('invalid');
    expect(validateSubdomain('has.dot')).toBe('invalid');
    expect(validateSubdomain('under_score')).toBe('invalid');
    expect(validateSubdomain('sp ace')).toBe('invalid');
  });

  it('rejects punycode-prefixed labels (homograph guard)', () => {
    expect(validateSubdomain('xn--abc')).toBe('invalid');
  });

  it('rejects reserved role labels', () => {
    for (const name of RESERVED_SUBDOMAINS) {
      expect(validateSubdomain(name), name).toBe('reserved');
    }
    expect(validateSubdomain('PREVIEW')).toBe('reserved');
  });
});
