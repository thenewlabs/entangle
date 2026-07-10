import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseCapabilityUrl,
  createCapability,
  looksLikeCapabilityUrl,
  resolveServeTarget,
} from './capability.js';
import { generateCapId, generateSecret, initCrypto } from '@thenewlabs/entangle-crypto';

describe('parseCapabilityUrl', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it('parses a full capability URL', async () => {
    const capId = generateCapId().capId;
    const S = generateSecret();
    const url = `https://relay.example.com/cap/${capId}#S=${S}`;

    const parsed = await parseCapabilityUrl(url);
    expect(parsed.capId).toBe(capId);
    expect(parsed.S).toBe(S);
    expect(parsed.relayOrigin).toBe('https://relay.example.com');
    expect(parsed.policy.maxStreams).toBe(1);
  });

  it('parses the compact form with relayOrigin undefined', async () => {
    const capId = generateCapId().capId;
    const S = generateSecret();

    const parsed = await parseCapabilityUrl(`${capId}#S=${S}`);
    expect(parsed.capId).toBe(capId);
    expect(parsed.S).toBe(S);
    expect(parsed.relayOrigin).toBeUndefined();
  });

  it('rejects a malformed capId', async () => {
    const S = generateSecret();
    await expect(parseCapabilityUrl(`https://r/cap/short#S=${S}`)).rejects.toThrow();
  });

  it('rejects a missing secret', async () => {
    const capId = generateCapId().capId;
    await expect(parseCapabilityUrl(`https://relay.example.com/cap/${capId}`)).rejects.toThrow();
  });
});

describe('createCapability', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it('mints an in-memory capability', async () => {
    const cap = await createCapability({ singleRun: false });
    expect(typeof cap.capId).toBe('string');
    expect(typeof cap.S).toBe('string');
    expect(cap.policy.maxStreams).toBe(1);
    expect(cap.policy.singleRun).toBe(false);
  });
});

describe('looksLikeCapabilityUrl', () => {
  it('treats a bare relay origin as not a capability URL', () => {
    expect(looksLikeCapabilityUrl('https://entangle.thenewlabs.com')).toBe(false);
    expect(looksLikeCapabilityUrl('https://entangle.thenewlabs.com/')).toBe(false);
  });

  it('recognises full and compact capability URLs', () => {
    expect(looksLikeCapabilityUrl('https://relay/cap/abc#S=secret')).toBe(true);
    expect(looksLikeCapabilityUrl('abc#S=secret')).toBe(true);
    expect(looksLikeCapabilityUrl('https://relay/cap/abc')).toBe(true);
  });
});

describe('resolveServeTarget', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it('mints on a bare relay origin and uses it as the relay', async () => {
    const r = await resolveServeTarget({ positionalUrl: 'https://entangle.thenewlabs.com' });
    expect(r.serverUrl).toBe('https://entangle.thenewlabs.com');
    expect(r.pinnedCapability).toBeUndefined();
  });

  it('normalises a bare origin with a trailing path to its origin', async () => {
    const r = await resolveServeTarget({ positionalUrl: 'https://relay.example.com:8443/foo' });
    expect(r.serverUrl).toBe('https://relay.example.com:8443');
    expect(r.pinnedCapability).toBeUndefined();
  });

  it('pins a full positional capability URL and uses its origin as the relay', async () => {
    const capId = generateCapId().capId;
    const S = generateSecret();
    const r = await resolveServeTarget({
      positionalUrl: `https://relay.example.com/cap/${capId}#S=${S}`,
    });
    expect(r.serverUrl).toBe('https://relay.example.com');
    expect(r.pinnedCapability?.capId).toBe(capId);
    expect(r.pinnedCapability?.S).toBe(S);
  });

  it('lets --server override the positional origin', async () => {
    const r = await resolveServeTarget({
      positionalUrl: 'https://origin.example.com',
      serverFlag: 'https://forced.example.com',
    });
    expect(r.serverUrl).toBe('https://forced.example.com');
  });

  it('lets --capability pin even with a bare positional relay', async () => {
    const capId = generateCapId().capId;
    const S = generateSecret();
    const r = await resolveServeTarget({
      positionalUrl: 'https://bare.example.com',
      capabilityFlag: `https://cap.example.com/cap/${capId}#S=${S}`,
    });
    // --capability wins for the cap; its origin becomes the relay.
    expect(r.pinnedCapability?.capId).toBe(capId);
    expect(r.serverUrl).toBe('https://cap.example.com');
  });

  it('falls back to the configured relay and mints when nothing is passed', async () => {
    const r = await resolveServeTarget({ configRelayUrl: 'https://configured.example.com' });
    expect(r.serverUrl).toBe('https://configured.example.com');
    expect(r.pinnedCapability).toBeUndefined();
  });

  it('surfaces a parse error for a malformed positional capability URL', async () => {
    await expect(
      resolveServeTarget({ positionalUrl: 'https://relay/cap/short#S=secret' }),
    ).rejects.toThrow();
  });
});
