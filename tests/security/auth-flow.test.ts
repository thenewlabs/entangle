import { describe, it, expect, beforeAll } from 'vitest';
import {
  initCrypto,
  generateCapId,
  generateSecret,
  deriveKeys,
  extractSaltFromCapId,
  computeHmac,
  verifyHmac,
} from '@thenewlabs/entangle-crypto';

describe('Security - Authentication Flow', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  describe('AUTH1 HMAC verification', () => {
    it('should generate and verify AUTH1 with nonceB', async () => {
      // Setup
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Simulate invoker side
      const nonceB = Math.random().toString(36).substr(2);
      const auth1Data = new TextEncoder().encode('hello' + capId + nonceB);
      const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
      
      // Create AUTH1 payload (HMAC + nonceB)
      const nonceBBytes = new TextEncoder().encode(nonceB);
      const auth1Payload = new Uint8Array(32 + nonceBBytes.length);
      auth1Payload.set(auth1Hmac, 0);
      auth1Payload.set(nonceBBytes, 32);
      
      // Simulate agent side
      const receivedHmac = auth1Payload.slice(0, 32);
      const receivedNonceBBytes = auth1Payload.slice(32);
      const receivedNonceB = new TextDecoder().decode(receivedNonceBBytes);
      
      // Verify HMAC
      const expectedAuth1Data = new TextEncoder().encode('hello' + capId + receivedNonceB);
      const isValid = verifyHmac(keys.K_auth, expectedAuth1Data, receivedHmac);
      
      expect(isValid).toBe(true);
      expect(receivedNonceB).toBe(nonceB);
    });

    it('should reject AUTH1 with invalid HMAC', async () => {
      // Setup
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Create invalid HMAC
      const nonceB = Math.random().toString(36).substr(2);
      const wrongData = new TextEncoder().encode('goodbye' + capId + nonceB);
      const wrongHmac = computeHmac(keys.K_auth, wrongData);
      
      // Create AUTH1 payload with wrong HMAC
      const nonceBBytes = new TextEncoder().encode(nonceB);
      const auth1Payload = new Uint8Array(32 + nonceBBytes.length);
      auth1Payload.set(wrongHmac, 0);
      auth1Payload.set(nonceBBytes, 32);
      
      // Simulate agent side verification
      const receivedHmac = auth1Payload.slice(0, 32);
      const receivedNonceBBytes = auth1Payload.slice(32);
      const receivedNonceB = new TextDecoder().decode(receivedNonceBBytes);
      
      const expectedAuth1Data = new TextEncoder().encode('hello' + capId + receivedNonceB);
      const isValid = verifyHmac(keys.K_auth, expectedAuth1Data, receivedHmac);
      
      expect(isValid).toBe(false);
    });

    it('should reject AUTH1 with wrong secret', async () => {
      // Setup
      const { capId, saltCap } = generateCapId();
      const correctSecret = generateSecret();
      const wrongSecret = generateSecret();
      
      const correctKeys = await deriveKeys(correctSecret, saltCap);
      const wrongKeys = await deriveKeys(wrongSecret, saltCap);
      
      // Invoker uses wrong secret
      const nonceB = Math.random().toString(36).substr(2);
      const auth1Data = new TextEncoder().encode('hello' + capId + nonceB);
      const wrongHmac = computeHmac(wrongKeys.K_auth, auth1Data);
      
      // Create AUTH1 payload
      const nonceBBytes = new TextEncoder().encode(nonceB);
      const auth1Payload = new Uint8Array(32 + nonceBBytes.length);
      auth1Payload.set(wrongHmac, 0);
      auth1Payload.set(nonceBBytes, 32);
      
      // Agent verifies with correct secret
      const receivedHmac = auth1Payload.slice(0, 32);
      const receivedNonceBBytes = auth1Payload.slice(32);
      const receivedNonceB = new TextDecoder().decode(receivedNonceBBytes);
      
      const expectedAuth1Data = new TextEncoder().encode('hello' + capId + receivedNonceB);
      const isValid = verifyHmac(correctKeys.K_auth, expectedAuth1Data, receivedHmac);
      
      expect(isValid).toBe(false);
    });

    it('should handle hex-encoded nonceB from web client', async () => {
      // Setup
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Simulate web client using hex-encoded nonce
      const nonceB = new Uint8Array(16);
      crypto.getRandomValues(nonceB);
      const nonceBHex = Array.from(nonceB).map(b => b.toString(16).padStart(2, '0')).join('');
      
      const auth1Data = new TextEncoder().encode('hello' + capId + nonceBHex);
      const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
      
      // Create AUTH1 payload (HMAC + hex string as bytes)
      const nonceBBytes = new TextEncoder().encode(nonceBHex);
      const auth1Payload = new Uint8Array(32 + nonceBBytes.length);
      auth1Payload.set(auth1Hmac, 0);
      auth1Payload.set(nonceBBytes, 32);
      
      // Simulate agent side
      const receivedHmac = auth1Payload.slice(0, 32);
      const receivedNonceBBytes = auth1Payload.slice(32);
      const receivedNonceB = new TextDecoder().decode(receivedNonceBBytes);
      
      // Verify HMAC
      const expectedAuth1Data = new TextEncoder().encode('hello' + capId + receivedNonceB);
      const isValid = verifyHmac(keys.K_auth, expectedAuth1Data, receivedHmac);
      
      expect(isValid).toBe(true);
      expect(receivedNonceB).toBe(nonceBHex);
    });
  });
});