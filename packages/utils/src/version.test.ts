import { readFileSync } from 'fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageVersion, getVersionInfo } from './version.js';

// Guards against version drift: every binary must report ITS OWN package.json version. The old
// design (a hardcoded VERSION constant in utils, shared by every CLI) made serve/relay/connect
// all announce utils' version — serve 2.12.0 shipped reporting "v2.11.1". packageVersion()
// resolves the manifest relative to the CALLER's entry module, so each package has exactly one
// place its version lives: its own package.json.

const REPO_ROOT = resolve(new URL('../../..', import.meta.url).pathname);

function manifestVersion(pkgDir: string): string {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, pkgDir, 'package.json'), 'utf8')).version;
}

describe('packageVersion', () => {
  it.each([
    ['packages/utils'],
    ['serve'],
    ['relay'],
    ['connect'],
    ['cli'],
  ])('resolves %s to its own package.json version', (pkgDir) => {
    const entryUrl = pathToFileURL(resolve(REPO_ROOT, pkgDir, 'src', 'index.ts')).href;
    expect(packageVersion(entryUrl)).toBe(manifestVersion(pkgDir));
  });

  it('the same entry resolves identically from dist/ (tsc output depth matches src/)', () => {
    const entryUrl = pathToFileURL(resolve(REPO_ROOT, 'serve', 'dist', 'index.js')).href;
    expect(packageVersion(entryUrl)).toBe(manifestVersion('serve'));
  });

  it('returns "unknown" instead of throwing when no manifest is found', () => {
    expect(packageVersion('file:///nonexistent/dir/index.js')).toBe('unknown');
  });

  it('getVersionInfo formats as v<version>', () => {
    const entryUrl = pathToFileURL(resolve(REPO_ROOT, 'serve', 'src', 'index.ts')).href;
    expect(getVersionInfo(entryUrl)).toBe(`v${manifestVersion('serve')}`);
  });
});
