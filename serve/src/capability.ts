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
