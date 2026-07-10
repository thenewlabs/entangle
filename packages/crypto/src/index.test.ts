import { describe, it, expect, beforeAll } from 'vitest';
import {
  initCrypto,
  generateCapId,
  generateSecret,
  extractSaltFromCapId,
  deriveKeys,
  deriveKeyMaterial,
  deriveBootstrapKeys,
  deriveSessionKeys,
  aeadEncrypt,
  aeadDecrypt,
  computeHmac,
  verifyHmac,
  hashPassword,
  verifyPassword,
  base64UrlEncode,
  base64UrlDecode,
  hashPolicy,
  AeadDir,
} from './index.js';

const DIR = AeadDir.ServerToClient;

describe('Crypto Package', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  describe('CapId generation', () => {
    it('should generate valid capId with embedded salt', () => {
      const { capId, saltCap } = generateCapId();
      
      expect(capId).toBeTruthy();
      expect(saltCap).toHaveLength(16);
      
      const extracted = extractSaltFromCapId(capId);
      expect(extracted).toEqual(saltCap);
    });

    it('should generate unique capIds', () => {
      const cap1 = generateCapId();
      const cap2 = generateCapId();
      
      expect(cap1.capId).not.toEqual(cap2.capId);
      expect(cap1.saltCap).not.toEqual(cap2.saltCap);
    });

    it('should fail on invalid capId length', () => {
      expect(() => extractSaltFromCapId('short')).toThrow('Invalid capId length');
    });
  });

  describe('Secret generation', () => {
    it('should generate base64url encoded secrets', () => {
      const secret = generateSecret();
      
      expect(secret).toBeTruthy();
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
      
      const decoded = base64UrlDecode(secret);
      expect(decoded).toHaveLength(32);
    });
  });

  describe('Key derivation', () => {
    it('should derive consistent keys from same inputs', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      
      const keys1 = await deriveKeys(secret, saltCap);
      const keys2 = await deriveKeys(secret, saltCap);
      
      expect(keys1.K_enc).toEqual(keys2.K_enc);
      expect(keys1.K_auth).toEqual(keys2.K_auth);
    });

    it('should derive different keys from different secrets', async () => {
      const secret1 = generateSecret();
      const secret2 = generateSecret();
      const { saltCap } = generateCapId();
      
      const keys1 = await deriveKeys(secret1, saltCap);
      const keys2 = await deriveKeys(secret2, saltCap);
      
      expect(keys1.K_enc).not.toEqual(keys2.K_enc);
      expect(keys1.K_auth).not.toEqual(keys2.K_auth);
    });

    it('should derive different keys from different salts', async () => {
      const secret = generateSecret();
      const { saltCap: salt1 } = generateCapId();
      const { saltCap: salt2 } = generateCapId();
      
      const keys1 = await deriveKeys(secret, salt1);
      const keys2 = await deriveKeys(secret, salt2);
      
      expect(keys1.K_enc).not.toEqual(keys2.K_enc);
    });
  });

  describe('AEAD encryption', () => {
    it('should encrypt and decrypt successfully', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const plaintext = { test: 'data', number: 42 };
      const type = 0x10;
      const ctr = 1;

      const { nonce, cipher } = aeadEncrypt(keys.K_enc, type, ctr, plaintext, DIR);

      expect(nonce).toHaveLength(24);
      expect(cipher).toBeTruthy();

      const decrypted = aeadDecrypt(keys.K_enc, type, nonce, cipher, DIR);

      expect(decrypted.ctr).toEqual(ctr);
      expect(decrypted.msg).toEqual(plaintext);
    });

    it('should fail decryption with wrong key', async () => {
      const secret1 = generateSecret();
      const secret2 = generateSecret();
      const { saltCap } = generateCapId();

      const keys1 = await deriveKeys(secret1, saltCap);
      const keys2 = await deriveKeys(secret2, saltCap);

      const plaintext = { test: 'data' };
      const { nonce, cipher } = aeadEncrypt(keys1.K_enc, 0x10, 1, plaintext, DIR);

      expect(() => aeadDecrypt(keys2.K_enc, 0x10, nonce, cipher, DIR)).toThrow();
    });

    it('should fail decryption with wrong type', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);

      const plaintext = { test: 'data' };
      const { nonce, cipher } = aeadEncrypt(keys.K_enc, 0x10, 1, plaintext, DIR);

      expect(() => aeadDecrypt(keys.K_enc, 0x11, nonce, cipher, DIR)).toThrow();
    });

    it('should fail decryption with wrong direction (no reflection)', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);

      const { nonce, cipher } = aeadEncrypt(keys.K_enc, 0x10, 1, { test: 'data' }, AeadDir.ServerToClient);

      // A frame encrypted server->client must not verify as client->server.
      expect(() => aeadDecrypt(keys.K_enc, 0x10, nonce, cipher, AeadDir.ClientToServer)).toThrow();
    });

    it('should fail decryption with tampered cipher', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);

      const plaintext = { test: 'data' };
      const { nonce, cipher } = aeadEncrypt(keys.K_enc, 0x10, 1, plaintext, DIR);

      cipher[0]! ^= 0xFF; // Tamper with first byte

      expect(() => aeadDecrypt(keys.K_enc, 0x10, nonce, cipher, DIR)).toThrow();
    });
  });

  describe('Session keys (per-session, nonce-bound)', () => {
    it('derives different session keys for different handshake nonces', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const K_raw = await deriveKeyMaterial(secret, saltCap);

      const s1 = deriveSessionKeys(K_raw, 'nonceB-1', 'nonceC-1');
      const s2 = deriveSessionKeys(K_raw, 'nonceB-2', 'nonceC-2');

      expect(s1.K_enc).not.toEqual(s2.K_enc);
      expect(s1.K_auth).not.toEqual(s2.K_auth);
    });

    it('session keys differ from bootstrap keys', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const K_raw = await deriveKeyMaterial(secret, saltCap);

      const bootstrap = deriveBootstrapKeys(K_raw);
      const session = deriveSessionKeys(K_raw, 'a', 'b');

      expect(session.K_enc).not.toEqual(bootstrap.K_enc);
    });

    it('ciphertext from one session cannot be decrypted in another (defeats cross-session replay)', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const K_raw = await deriveKeyMaterial(secret, saltCap);

      const sessionA = deriveSessionKeys(K_raw, 'A-nonceB', 'A-nonceC');
      const sessionB = deriveSessionKeys(K_raw, 'B-nonceB', 'B-nonceC');

      const { nonce, cipher } = aeadEncrypt(sessionA.K_enc, 0x12, 3, { chunk: 'stale output' }, AeadDir.ServerToClient);

      // Replaying session A's ciphertext into a fresh session B must fail even
      // though the counter (3) would satisfy B's reset counter.
      expect(() => aeadDecrypt(sessionB.K_enc, 0x12, nonce, cipher, AeadDir.ServerToClient)).toThrow();
    });
  });

  describe('Password hashing (Argon2id)', () => {
    it('verifies a correct password and rejects a wrong one', async () => {
      const hash = await hashPassword('correct horse battery staple');
      expect(hash).not.toContain('correct'); // not a plaintext-equivalent
      expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
      expect(await verifyPassword(hash, 'wrong password')).toBe(false);
    });

    it('produces distinct hashes for the same password (random salt)', async () => {
      const h1 = await hashPassword('same');
      const h2 = await hashPassword('same');
      expect(h1).not.toEqual(h2);
      expect(await verifyPassword(h1, 'same')).toBe(true);
      expect(await verifyPassword(h2, 'same')).toBe(true);
    });
  });

  describe('HMAC', () => {
    it('should compute and verify HMAC', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const data = new TextEncoder().encode('test message');
      const mac = computeHmac(keys.K_auth, data);
      
      expect(mac).toHaveLength(32);
      expect(verifyHmac(keys.K_auth, data, mac)).toBe(true);
    });

    it('should fail verification with wrong key', async () => {
      const secret1 = generateSecret();
      const secret2 = generateSecret();
      const { saltCap } = generateCapId();
      
      const keys1 = await deriveKeys(secret1, saltCap);
      const keys2 = await deriveKeys(secret2, saltCap);
      
      const data = new TextEncoder().encode('test message');
      const mac = computeHmac(keys1.K_auth, data);
      
      expect(verifyHmac(keys2.K_auth, data, mac)).toBe(false);
    });

    it('should fail verification with tampered data', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      const data1 = new TextEncoder().encode('test message');
      const data2 = new TextEncoder().encode('test message!');
      const mac = computeHmac(keys.K_auth, data1);
      
      expect(verifyHmac(keys.K_auth, data2, mac)).toBe(false);
    });
  });

  describe('Base64URL encoding', () => {
    it('should encode and decode correctly', () => {
      const data = new Uint8Array([1, 2, 3, 255, 0, 128]);
      const encoded = base64UrlEncode(data);
      
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
      
      const decoded = base64UrlDecode(encoded);
      expect(decoded).toEqual(data);
    });

    it('should handle empty data', () => {
      const data = new Uint8Array(0);
      const encoded = base64UrlEncode(data);
      const decoded = base64UrlDecode(encoded);
      
      expect(decoded).toEqual(data);
    });
  });

  describe('Policy hashing', () => {
    it('should hash policy consistently', () => {
      const policy = { singleRun: true };
      
      const hash1 = hashPolicy(policy);
      const hash2 = hashPolicy(policy);
      
      expect(hash1).toEqual(hash2);
    });

    it('should produce different hashes for different policies', () => {
      const policy1 = { singleRun: true };
      const policy2 = { singleRun: false };
      
      const hash1 = hashPolicy(policy1);
      const hash2 = hashPolicy(policy2);
      
      expect(hash1).not.toEqual(hash2);
    });
  });
});