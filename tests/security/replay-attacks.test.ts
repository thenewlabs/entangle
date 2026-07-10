import { describe, it, expect, beforeAll } from 'vitest';
import {
  initCrypto,
  generateCapId,
  generateSecret,
  deriveKeys,
  aeadEncrypt,
  aeadDecrypt,
  computeHmac,
  verifyHmac,
} from '@thenewlabs/entangle-crypto';
import { FrameType } from '@thenewlabs/entangle-protocol';
import { MonotonicCounter, BidirectionalCounters } from '@thenewlabs/entangle-utils';
import { encode } from 'cborg';

describe('Security - Replay Attack Prevention', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  describe('Monotonic counter validation', () => {
    it('should reject replayed messages with same counter', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      // First message with counter 0
      const msg1 = { test: 'message1' };
      const encrypted1 = aeadEncrypt(keys.K_enc, FrameType.RUN, 0, msg1);
      
      // Validate counter 0
      counter.validate(0);
      const decrypted1 = aeadDecrypt(keys.K_enc, FrameType.RUN, encrypted1.nonce, encrypted1.cipher);
      expect(decrypted1.ctr).toBe(0);
      expect(decrypted1.msg).toEqual(msg1);
      
      // Try to replay message with counter 0 - should fail
      expect(() => counter.validate(0))
        .toThrow('Counter not strictly increasing: 0 <= 0');
    });

    it('should reject out-of-order messages', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      // Accept counter 5
      counter.validate(5);
      
      // Try to accept counter 3 (older) - should fail
      expect(() => counter.validate(3))
        .toThrow('Counter not strictly increasing: 3 <= 5');
      
      // Try to accept counter 5 again - should fail
      expect(() => counter.validate(5))
        .toThrow('Counter not strictly increasing: 5 <= 5');
      
      // Accept counter 6 - should succeed
      expect(() => counter.validate(6)).not.toThrow();
    });

    it('should handle large counter gaps', async () => {
      const counter = new MonotonicCounter();
      
      counter.validate(100);
      counter.validate(1000000);
      
      // Should still reject old values
      expect(() => counter.validate(999999))
        .toThrow('Counter not strictly increasing: 999999 <= 1000000');
    });
  });

  describe('Bidirectional counter isolation', () => {
    it('should maintain separate counters for each direction', async () => {
      const counters = new BidirectionalCounters();
      
      // Incoming: 0, 1, 2
      counters.incoming.validate(0);
      counters.incoming.validate(1);
      counters.incoming.validate(2);
      
      // Outgoing: 0, 1 (independent sequence)
      counters.outgoing.validate(0);
      counters.outgoing.validate(1);
      
      // Should reject replay in incoming
      expect(() => counters.incoming.validate(1))
        .toThrow('Counter not strictly increasing: 1 <= 2');
      
      // Should accept next in outgoing
      expect(() => counters.outgoing.validate(2)).not.toThrow();
    });

    it('should not allow cross-direction counter reuse', async () => {
      const counters = new BidirectionalCounters();
      
      counters.incoming.validate(5);
      
      // Using counter 5 in outgoing should be fine (different direction)
      expect(() => counters.outgoing.validate(5)).not.toThrow();
      
      // But repeating in same direction should fail
      expect(() => counters.incoming.validate(5))
        .toThrow('Counter not strictly increasing: 5 <= 5');
    });
  });

  describe('AEAD replay protection', () => {
    it('should prevent replay of encrypted frames', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      const originalMsg = { command: 'sensitive-action', args: ['delete', 'all'] };
      
      // Encrypt message with counter 1
      const encrypted = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, originalMsg);
      
      // First decryption should succeed
      counter.validate(1);
      const decrypted1 = aeadDecrypt(keys.K_enc, FrameType.RUN, encrypted.nonce, encrypted.cipher);
      expect(decrypted1.msg).toEqual(originalMsg);
      
      // Attempting to "replay" by decrypting again would require validation
      // The counter validation should prevent this
      expect(() => counter.validate(1))
        .toThrow('Counter not strictly increasing: 1 <= 1');
    });

    it('should prevent reordering of messages', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      // Create messages with counters 1, 2, 3
      const msg1 = { action: 'step1' };
      const msg2 = { action: 'step2' };
      const msg3 = { action: 'step3' };
      
      const enc1 = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, msg1);
      const enc2 = aeadEncrypt(keys.K_enc, FrameType.RUN, 2, msg2);
      const enc3 = aeadEncrypt(keys.K_enc, FrameType.RUN, 3, msg3);
      
      // Process in order: 1, 2, 3
      counter.validate(1);
      counter.validate(2);
      counter.validate(3);
      
      // Now if attacker tries to replay message 2, counter should reject
      expect(() => counter.validate(2))
        .toThrow('Counter not strictly increasing: 2 <= 3');
    });

    it('should detect message injection attempts', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      // Legitimate sequence: 1, 2
      counter.validate(1);
      counter.validate(2);
      
      // Attacker tries to inject with counter 1.5 (impossible with integers)
      // or tries to inject between 2 and next expected (3)
      
      // If legitimate message 3 arrives
      counter.validate(3);
      
      // Attacker cannot inject anything with counter <= 3
      expect(() => counter.validate(0)).toThrow();
      expect(() => counter.validate(1)).toThrow();
      expect(() => counter.validate(2)).toThrow();
      expect(() => counter.validate(3)).toThrow();
    });
  });

  describe('HMAC replay protection (AUTH flow)', () => {
    it('should prevent AUTH1 replay attacks', async () => {
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Simulate AUTH1 with nonce
      const nonceB = 'random-nonce-123';
      const auth1Data = new TextEncoder().encode('hello' + capId + nonceB);
      const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
      
      // First verification should succeed
      expect(verifyHmac(keys.K_auth, auth1Data, auth1Hmac)).toBe(true);
      
      // Replay of same AUTH1 would have same nonce, but server should
      // generate new nonce for each session, making replay ineffective
      
      // Simulate different nonce for new session
      const nonceB2 = 'different-nonce-456';
      const auth1Data2 = new TextEncoder().encode('hello' + capId + nonceB2);
      
      // Old HMAC should not work with new nonce
      expect(verifyHmac(keys.K_auth, auth1Data2, auth1Hmac)).toBe(false);
    });

    it('should prevent AUTH3 replay with different nonce', async () => {
      const secret = generateSecret();
      const { capId, saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // First session
      const nonceC1 = 'challenge-nonce-1';
      const auth3Data1 = new TextEncoder().encode('ready' + nonceC1);
      const auth3Hmac1 = computeHmac(keys.K_auth, auth3Data1);
      
      // Verify works for correct nonce
      expect(verifyHmac(keys.K_auth, auth3Data1, auth3Hmac1)).toBe(true);
      
      // Different session with different nonce
      const nonceC2 = 'challenge-nonce-2';
      const auth3Data2 = new TextEncoder().encode('ready' + nonceC2);
      
      // Replayed HMAC from first session should not work
      expect(verifyHmac(keys.K_auth, auth3Data2, auth3Hmac1)).toBe(false);
    });
  });

  describe('Session isolation', () => {
    it('should not allow cross-session message replay', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      
      // Session 1 counters
      const session1 = new BidirectionalCounters();
      // Session 2 counters
      const session2 = new BidirectionalCounters();
      
      // Both sessions can start from 0 independently
      session1.incoming.validate(0);
      session2.incoming.validate(0);
      
      // Progress session 1
      session1.incoming.validate(1);
      session1.incoming.validate(2);
      
      // Session 2 should still be independent
      expect(() => session2.incoming.validate(1)).not.toThrow();
      
      // But replay within session should be prevented
      expect(() => session1.incoming.validate(1))
        .toThrow('Counter not strictly increasing: 1 <= 2');
    });

    it('should isolate counter state between different capabilities', async () => {
      // Simulate different capability sessions
      const counter1 = new MonotonicCounter(); // Capability 1
      const counter2 = new MonotonicCounter(); // Capability 2
      
      counter1.validate(5);
      counter2.validate(3);
      
      // Each should track independently
      expect(() => counter1.validate(6)).not.toThrow();
      expect(() => counter2.validate(4)).not.toThrow();
      
      // Replay should be prevented within each
      expect(() => counter1.validate(5))
        .toThrow('Counter not strictly increasing: 5 <= 6');
      expect(() => counter2.validate(3))
        .toThrow('Counter not strictly increasing: 3 <= 4');
    });
  });

  describe('Time-based attack prevention', () => {
    it('should handle rapid-fire replay attempts', async () => {
      const counter = new MonotonicCounter();
      
      // Accept initial message
      counter.validate(1);
      
      // Simulate rapid replay attempts
      for (let i = 0; i < 100; i++) {
        expect(() => counter.validate(1))
          .toThrow('Counter not strictly increasing: 1 <= 1');
      }
      
      // Should still accept next valid counter
      expect(() => counter.validate(2)).not.toThrow();
    });

    it('should handle delayed replay attempts', async () => {
      const counter = new MonotonicCounter();
      
      counter.validate(10);
      counter.validate(20);
      counter.validate(30);
      
      // Later attempt to replay old message should fail
      expect(() => counter.validate(15))
        .toThrow('Counter not strictly increasing: 15 <= 30');
    });
  });

  describe('Attack scenario simulations', () => {
    it('should prevent man-in-the-middle replay', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      // Legitimate message flow
      const msg1 = { command: 'ls' };
      const msg2 = { command: 'cat file.txt' };
      
      const enc1 = aeadEncrypt(keys.K_enc, FrameType.RUN, 1, msg1);
      const enc2 = aeadEncrypt(keys.K_enc, FrameType.RUN, 2, msg2);
      
      // Process legitimate messages
      counter.validate(1);
      const dec1 = aeadDecrypt(keys.K_enc, FrameType.RUN, enc1.nonce, enc1.cipher);
      expect(dec1.msg).toEqual(msg1);
      
      counter.validate(2);
      const dec2 = aeadDecrypt(keys.K_enc, FrameType.RUN, enc2.nonce, enc2.cipher);
      expect(dec2.msg).toEqual(msg2);
      
      // Attacker intercepts and tries to replay msg1
      // Counter validation should prevent this
      expect(() => counter.validate(1))
        .toThrow('Counter not strictly increasing: 1 <= 2');
    });

    it('should prevent command injection via replay', async () => {
      const secret = generateSecret();
      const { saltCap } = generateCapId();
      const keys = await deriveKeys(secret, saltCap);
      const counter = new MonotonicCounter();
      
      // Dangerous command that attacker wants to replay
      const dangerousMsg = { command: 'rm', args: ['-rf', '/'] };
      const encDangerous = aeadEncrypt(keys.K_enc, FrameType.RUN, 5, dangerousMsg);
      
      // Process some legitimate commands first
      counter.validate(1);
      counter.validate(2);
      counter.validate(3);
      counter.validate(4);
      counter.validate(5); // Process the dangerous command once
      
      // Continue with more commands
      counter.validate(6);
      counter.validate(7);
      
      // Attacker tries to replay the dangerous command
      // Even though they have the encrypted frame, counter prevents replay
      expect(() => counter.validate(5))
        .toThrow('Counter not strictly increasing: 5 <= 7');
      
      // The encrypted message itself would still decrypt correctly if processed
      // But the counter mechanism prevents it from being accepted
      const decrypted = aeadDecrypt(keys.K_enc, FrameType.RUN, encDangerous.nonce, encDangerous.cipher);
      expect(decrypted.ctr).toBe(5);
      expect(decrypted.msg).toEqual(dangerousMsg);
      
      // However, the replay protection ensures this cannot be replayed
    });
  });
});