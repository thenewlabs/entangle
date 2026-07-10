import { generateCapId, generateSecret, initCrypto, extractSaltFromCapId } from '@thenewlabs/entangle-crypto';
import { type Policy } from '@thenewlabs/entangle-protocol';

export interface CapabilityInfo {
  capId: string;
  S: string;
  policy: Policy;
}

export async function createCapability(options: {
  singleRun?: boolean;
  outputMode?: string;
}): Promise<CapabilityInfo> {
  await initCrypto();

  const { capId } = generateCapId();
  const S = generateSecret();

  const policy: Policy = {
    singleRun: options.singleRun ?? false,
    maxStreams: 1, // Default to single stream for backward compatibility
  };

  return {
    capId,
    S,
    policy,
  };
}

/**
 * Parse a capability URL into a CapabilityInfo. Accepts either a full URL of
 * the form `https://host[:port]/cap/<capId>#S=<secret>` or the compact form
 * `<capId>#S=<secret>`. For a full URL, `relayOrigin` is set to the URL origin
 * so the caller can point the agent at the same relay that minted the
 * capability.
 */
export async function parseCapabilityUrl(
  input: string
): Promise<CapabilityInfo & { relayOrigin?: string }> {
  await initCrypto();

  let capId: string | undefined;
  let fragment: string | undefined;
  let relayOrigin: string | undefined;

  const hashIndex = input.indexOf('#');
  const beforeHash = hashIndex >= 0 ? input.slice(0, hashIndex) : input;
  fragment = hashIndex >= 0 ? input.slice(hashIndex + 1) : undefined;

  if (/^https?:\/\//i.test(beforeHash)) {
    // Full URL form.
    try {
      const url = new URL(input);
      relayOrigin = url.origin;
      const match = url.pathname.match(/\/cap\/([^/]+)$/);
      if (match) {
        capId = decodeURIComponent(match[1]!);
      }
    } catch {
      // Fall through to the "expected ..." error below.
    }
  } else {
    // Compact form: everything before the '#' is the capId.
    if (beforeHash) {
      capId = beforeHash;
    }
  }

  let secret: string | undefined;
  if (fragment) {
    const params = new URLSearchParams(fragment);
    secret = params.get('S') ?? undefined;
  }

  if (!capId || !secret) {
    throw new Error('Invalid capability URL: expected .../cap/<capId>#S=<secret>');
  }

  try {
    extractSaltFromCapId(capId);
  } catch {
    throw new Error('Invalid capability URL: malformed capId');
  }

  if (typeof secret !== 'string' || secret.length < 8) {
    throw new Error('Invalid capability URL: missing or malformed secret');
  }

  return {
    capId,
    S: secret,
    policy: { singleRun: false, maxStreams: 1 },
    ...(relayOrigin !== undefined && { relayOrigin }),
  };
}

/**
 * A full capability URL carries a `/cap/<id>` path and/or an `#S=<secret>`
 * fragment (or the compact `<capId>#S=<secret>` form). A bare relay origin
 * (`https://relay`) has neither and selects only the relay to mint on.
 */
export function looksLikeCapabilityUrl(input: string): boolean {
  return input.includes('/cap/') || input.includes('#');
}

/** Reduce a URL to its origin (`https://host[:port]`), tolerating trailing paths. */
function normalizeOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return input;
  }
}

/**
 * Decide the relay to register with and whether to pin a specific capability,
 * from the (optional) positional URL and flags that `serve` accepts:
 *
 *   serve https://relay                         -> mint fresh cap, relay = origin
 *   serve https://relay/cap/<capId>#S=<secret>  -> pin that cap, relay = origin
 *   serve --capability <full-url>               -> pin that cap (positional ignored for the cap)
 *   serve --server <url>                        -> force the relay regardless of the above
 *   serve                                       -> mint fresh cap on the configured/default relay
 *
 * A full positional URL and a bare relay origin are disambiguated by
 * {@link looksLikeCapabilityUrl}; a malformed cap URL surfaces the parse error
 * rather than being silently treated as a bare relay.
 */
export async function resolveServeTarget(opts: {
  positionalUrl?: string | undefined;
  capabilityFlag?: string | undefined;
  serverFlag?: string | undefined;
  envCapability?: string | undefined;
  configRelayUrl?: string | undefined;
}): Promise<{ serverUrl: string; pinnedCapability?: CapabilityInfo & { relayOrigin?: string } }> {
  const { positionalUrl, capabilityFlag, serverFlag, envCapability, configRelayUrl } = opts;

  const positionalIsCap = !!positionalUrl && looksLikeCapabilityUrl(positionalUrl);
  const capUrl = capabilityFlag || (positionalIsCap ? positionalUrl : undefined) || envCapability;
  const pinned = capUrl ? await parseCapabilityUrl(capUrl) : undefined;

  // A bare positional origin (not a cap URL) selects only the relay; a fresh
  // capability gets minted downstream.
  const relayFromPositional =
    !positionalIsCap && positionalUrl ? normalizeOrigin(positionalUrl) : undefined;

  const serverUrl =
    serverFlag ||
    pinned?.relayOrigin ||
    relayFromPositional ||
    configRelayUrl ||
    'http://localhost:8080';

  return pinned ? { serverUrl, pinnedCapability: pinned } : { serverUrl };
}
