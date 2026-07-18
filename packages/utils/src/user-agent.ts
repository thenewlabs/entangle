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
 * Build the UA for `product` at the CALLING package's version. Pass the calling module's
 * `import.meta.url`; as with `packageVersion()`, the manifest is expected one level up, which
 * holds for any module directly under `src/` (tsx dev) or `dist/` (tsc output). The bundling
 * scripts rewrite `import.meta.url` at build time, so this is safe in the standalone bundles too.
 *
 * e.g. `entangle-serve/2.15.1 (+https://github.com/thenewlabs/entangle)`
 */
export function buildUserAgent(product: UserAgentProduct, callerModuleUrl: string): string {
  return `${product}/${packageVersion(callerModuleUrl)} (+${USER_AGENT_URL})`;
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
