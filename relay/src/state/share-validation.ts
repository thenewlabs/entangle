/**
 * Subdomain validation + normalization for public shares.
 *
 * A public share is reachable at `<subdomain>.<RELAY_SHARE_HOST>`. The subdomain
 * is user-chosen, so it must be validated as a single safe DNS label before it
 * can enter the routing map or a Host-header comparison. Kept as a pure,
 * dependency-free module so it can be unit-tested in isolation and reused by any
 * caller that needs the same rules.
 *
 * NOTE: a public share is plaintext end-to-end — the relay terminates HTTP and
 * proxies it to the agent, so unlike a capability it is NOT E2E-encrypted. The
 * validation here is purely about producing a safe, unambiguous DNS label; it is
 * not a confidentiality boundary.
 */

/** Max length of a single DNS label. */
export const MAX_SUBDOMAIN_LENGTH = 63;

/**
 * Labels that would collide with relay-internal roles or read as an attempt to
 * impersonate one. Compared case-insensitively against the normalized label.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'preview',
  'www',
  'api',
  'admin',
  'relay',
  'agent',
  'health',
  'localhost',
]);

export type SubdomainRejection = 'invalid' | 'reserved';

/** Lowercase + trim; does not validate. */
export function normalizeSubdomain(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Validate a normalized subdomain label. Returns `null` when acceptable, or a
 * reason code otherwise. Rules: a single LDH DNS label (letters/digits/hyphen),
 * no leading/trailing hyphen, no `xn--` punycode prefix (avoids homograph
 * squatting), length 1..63, and not a reserved role label.
 */
export function validateSubdomain(raw: string): SubdomainRejection | null {
  const label = normalizeSubdomain(raw);
  if (label.length === 0 || label.length > MAX_SUBDOMAIN_LENGTH) return 'invalid';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return 'invalid';
  if (label.startsWith('xn--')) return 'invalid';
  if (RESERVED_SUBDOMAINS.has(label)) return 'reserved';
  return null;
}

/** True iff the subdomain is a well-formed, non-reserved label. */
export function isValidSubdomain(raw: string): boolean {
  return validateSubdomain(raw) === null;
}
