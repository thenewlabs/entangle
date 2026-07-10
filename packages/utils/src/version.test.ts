import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

// Guards against the two-sources-of-truth drift: the runtime VERSION constant
// must always match this package's package.json version. Bumping package.json
// without updating version.ts (or vice versa) makes the binaries report a stale
// version at runtime — this test fails the release if that happens.
describe('VERSION', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(VERSION).toBe(pkg.version);
  });
});
