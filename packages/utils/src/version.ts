/**
 * Per-package version reporting with ONE source of truth: the package's own package.json.
 *
 * There is deliberately NO version constant in this module. A shared hardcoded string is how
 * every entangle binary ended up announcing utils' stale version instead of its own (serve
 * 2.12.0 shipped reporting "v2.11.1"); a drift-guard test can only pin such a constant to
 * THIS package's manifest, never to the caller's. Instead each CLI entry module calls
 * `getVersionInfo(import.meta.url)`:
 *
 * - workspace / tsc builds: the version is read at runtime from `../package.json` relative to
 *   the calling entry module — which is that package's OWN manifest for `src/` (tsx dev) and
 *   `dist/` (tsc output) alike;
 * - standalone bundles (main/dist/*.js are CJS/IIFE where `import.meta.url` is gone and a
 *   relative manifest lookup would find the wrong package.json): the bundling script injects
 *   the right version at build time via esbuild `define` (`ENTANGLE_BUILD_VERSION` — see
 *   scripts/build-dist.js and locus-server's build.mjs), which wins over the runtime read.
 */
import { readFileSync } from 'fs';

// Injected by the bundling scripts via esbuild `define`; undeclared in tsc/workspace builds
// (where `typeof` on the undeclared global safely yields 'undefined').
declare const ENTANGLE_BUILD_VERSION: string | undefined;

/**
 * The CALLING package's version. Pass the entry module's `import.meta.url`; the manifest is
 * expected one level up (`src/index.ts` and `dist/index.js` both sit directly under the package
 * root). Returns 'unknown' rather than throwing — a binary that cannot find its manifest should
 * still start, just visibly unversioned.
 */
export function packageVersion(entryModuleUrl: string): string {
  if (typeof ENTANGLE_BUILD_VERSION === 'string') return ENTANGLE_BUILD_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', entryModuleUrl), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Human-facing version string for banners and `--version`: `v<package version>`. */
export function getVersionInfo(entryModuleUrl: string): string {
  return `v${packageVersion(entryModuleUrl)}`;
}
