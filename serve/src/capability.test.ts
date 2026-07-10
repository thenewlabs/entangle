import { describe, it, expect, beforeAll } from 'vitest';
import { parseCapabilityUrl, createCapability } from './capability.js';
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
