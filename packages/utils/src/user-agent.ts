/**
 * The `User-Agent` every entangle component puts on its OWN outbound requests.
 *
 * Node sets no `User-Agent` by default — neither global `fetch` (undici) nor the `ws` client
 * send one, unlike a browser. Relays and reverse proxies in front of them log the header as
 * "-", and intrusion-prevention layers (CrowdSec et al.) treat a stream of UA-less requests as
 * bot traffic and ban the source IP. `serve`'s registration WebSocket reconnects on a backoff
 * loop, so a single unhappy relay produced exactly that pattern against `/agent/register`.
 *
 * The string is product + version only. It MUST NOT carry capIds, tokens, secrets, machine ids
 * or paths: the relay is blind by design, and the header is the one part of a connection it
 * always sees in cleartext. Distinguishing the products (`entangle-serve` vs `entangle-connect`)
 * tells a relay operator which component is calling without telling them anything about who.
 */
import { packageVersion } from './version.js';

/** Project URL appended so an operator seeing the UA in a log can identify it. */
export const USER_AGENT_URL = 'https://github.com/thenewlabs/entangle';

/** Product token for the component making the request. Add a member per new outbound caller. */
export type UserAgentProduct = 'entangle-serve' | 'entangle-connect' | 'entangle-relay' | 'entangle';

/**
 * Build-time product→version map, injected by the bundling scripts via esbuild `define`
 * (see main/scripts/build-dist.js and locus/scripts/build-dist.js). Undeclared in tsc and
 * workspace builds, where `typeof` on the undeclared global safely yields 'undefined'.
 *
 * `version.ts`'s scalar `ENTANGLE_BUILD_VERSION` cannot serve this purpose: it names the ONE
 * version of the binary being built, which is right for entangle's one-bundle-per-package
 * executables but wrong for a binary that embeds several packages at once. `locus` bundles
 * locus-cli, the locus daemon AND entangle's serve/connect into a single file, so a scalar
 * would make every embedded component announce whichever version won. A map keyed by product
 * keeps each caller's version accurate inside a multi-package bundle.
 */
declare const ENTANGLE_BUILD_UA_VERSIONS: Record<string, string> | undefined;

function buildTimeVersion(product: UserAgentProduct): string | undefined {
  // `typeof` first and short-circuit: the identifier is undeclared outside a bundle, where any
  // other reference to it would throw a ReferenceError at module load.
  if (typeof ENTANGLE_BUILD_UA_VERSIONS !== 'object' || ENTANGLE_BUILD_UA_VERSIONS === null) {
    return undefined;
  }
  const version = (ENTANGLE_BUILD_UA_VERSIONS as Record<string, unknown>)[product];
  return typeof version === 'string' ? version : undefined;
}

/**
 * Coerce a version to a single safe HTTP token, falling back to 'unknown'. Guards the two ways
 * a bundle can degrade — a missing manifest yields `undefined`, and a lookup against an empty
 * `import.meta` yields `''` — so the header is never `product/` or `product/undefined`. Also
 * rejects whitespace and control characters, which would split or inject a header.
 */
function safeVersion(raw: string | undefined): string {
  if (typeof raw !== 'string') return 'unknown';
  const version = raw.trim();
  return version !== '' && /^[\x21-\x7e]+$/.test(version) ? version : 'unknown';
}

/**
 * Build the UA for `product` at the CALLING package's version. Pass the calling module's
 * `import.meta.url`; as with `packageVersion()`, the manifest is expected one level up, which
 * holds for any module directly under `src/` (tsx dev) or `dist/` (tsc output).
 *
 * In a standalone bundle the runtime manifest lookup CANNOT be trusted: `import.meta.url` is
 * empty under the CJS output format, and even once a bundler rewrites it, it points at the
 * bundle — so `../package.json` resolves to whichever package happens to sit above the output
 * directory rather than to the calling package. That is how a bundled `locus` came to announce
 * `entangle-serve/0.1.0` (the Locus root manifest) instead of serve's own 2.15.1. The injected
 * map therefore WINS over the runtime read, which stays as the tsx/tsc-build path.
 *
 * e.g. `entangle-serve/2.15.1 (+https://github.com/thenewlabs/entangle)`
 */
export function buildUserAgent(product: UserAgentProduct, callerModuleUrl: string): string {
  const version = safeVersion(buildTimeVersion(product) ?? packageVersion(callerModuleUrl));
  return `${product}/${version} (+${USER_AGENT_URL})`;
}

/**
 * Headers object for a Node `ws` client or `fetch`. Lowercase key: HTTP/1.1 header names are
 * case-insensitive, and `ws` merges its own defaults case-sensitively.
 */
export function userAgentHeaders(
  product: UserAgentProduct,
  callerModuleUrl: string,
): { 'user-agent': string } {
  return { 'user-agent': buildUserAgent(product, callerModuleUrl) };
}
