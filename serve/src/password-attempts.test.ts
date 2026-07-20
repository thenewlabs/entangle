import { describe, it, expect, beforeAll } from 'vitest';
import { FrameType, FrameReader } from '@thenewlabs/entangle-protocol';
import { aeadEncrypt, aeadDecrypt, hashPassword, AeadDir } from '@thenewlabs/entangle-crypto';
import { BidirectionalCounters } from '@thenewlabs/entangle-utils';
import { encode, decode } from 'cborg';
import { randomBytes } from 'crypto';
import { handleAuthPw, MAX_PASSWORD_ATTEMPTS, type Session } from './session.js';

/**
 * Security regression: AUTH_PW had NO attempt limit. A holder of the capability
 * URL (which is only the FIRST factor) could stream unlimited password guesses
 * down one authenticated socket, and every guess costs the agent a full Argon2id
 * verification (~64 MiB) — so the same hole was both a brute-force and a
 * resource-exhaustion vector. The session must now die after
 * MAX_PASSWORD_ATTEMPTS failures.
 *
 * Argon2id at interactive limits is deliberately expensive, so the cases that
 * only exercise the COUNTER drive it with undecryptable payloads (which count,
 * and cost nothing); only the two cases that genuinely need a verification pay
 * for one. Hence the long timeouts and the single shared hash.
 */
describe('serve: AUTH_PW attempt limiting', () => {
  const PASSWORD = 'correct horse';
  const SLOW = 120_000; // one Argon2id op is seconds, not milliseconds
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  }, SLOW);

  const makeSession = (): { session: Session; sent: string[]; K_enc: Uint8Array } => {
    const K_enc = randomBytes(32);
    const sent: string[] = [];
    const session = {
      socketId: 'sock-pw',
      ws: { readyState: 1, send: (data: string) => sent.push(data) },
      cap: {},
      keys: { K_enc },
      counters: new BidirectionalCounters(),
      authenticated: true,
      passwordVerified: false,
      requiresPassword: true,
      passwordHash,
      passwordAttempts: 0,
    } as unknown as Session;
    return { session, sent, K_enc };
  };

  /** Encrypt one client->server AUTH_PW frame body. */
  const pwPayload = (K_enc: Uint8Array, counters: BidirectionalCounters, password: string): Uint8Array =>
    encode(aeadEncrypt(K_enc, FrameType.AUTH_PW, counters.outgoing.next(), { password }, AeadDir.ClientToServer));

  /** An AUTH_PW the agent cannot decrypt — the cheap way to spend an attempt. */
  const garbagePayload = (): Uint8Array => encode({ nonce: 0, cipher: randomBytes(48) });

  /** Decode the `detail` of the last ERROR frame the agent wrapped in a RELAY_RESPONSE. */
  const lastErrorDetail = (sent: string[], K_enc: Uint8Array): string | undefined => {
    const envelope = JSON.parse(sent[sent.length - 1]!);
    const [frame] = new FrameReader().push(Buffer.from(envelope.frame, 'base64'));
    if (frame!.type !== FrameType.ERROR) return undefined;
    const encrypted = decode(frame!.payload) as { nonce: number; cipher: Uint8Array };
    const decrypted = aeadDecrypt(
      K_enc,
      FrameType.ERROR,
      encrypted.nonce,
      encrypted.cipher,
      AeadDir.ServerToClient,
    );
    return (decrypted.msg as { detail?: string }).detail;
  };

  it('counts an undecryptable AUTH_PW as an attempt (probing must not be free)', async () => {
    const { session } = makeSession();

    await handleAuthPw(session, {}, garbagePayload());

    expect(session.passwordAttempts).toBe(1);
    expect(session.terminated).toBeFalsy();
  });

  it('terminates the session after MAX_PASSWORD_ATTEMPTS failures', async () => {
    const { session, sent, K_enc } = makeSession();
    const store: { multiSession?: unknown } = { multiSession: { socketId: 'sock-pw' } };

    for (let i = 0; i < MAX_PASSWORD_ATTEMPTS; i++) {
      expect(session.terminated).toBeFalsy(); // still alive on every attempt up to the last
      await handleAuthPw(session, store, garbagePayload());
    }

    expect(session.passwordAttempts).toBe(MAX_PASSWORD_ATTEMPTS);
    expect(session.terminated).toBe(true);
    expect(lastErrorDetail(sent, K_enc)).toMatch(/Too many password attempts/);
    // Anything the session had opened is torn down with it.
    expect(store.multiSession).toBeUndefined();
  });

  it(
    'rejects a wrong password generically and spends one attempt',
    async () => {
      const { session, sent, K_enc } = makeSession();
      const clientCounters = new BidirectionalCounters();

      await handleAuthPw(session, {}, pwPayload(K_enc, clientCounters, 'wrong'));

      expect(session.passwordAttempts).toBe(1);
      expect(session.passwordVerified).toBe(false);
      expect(session.terminated).toBeFalsy();
      // Never leaks whether the guess was close, nor how many tries remain.
      expect(lastErrorDetail(sent, K_enc)).toBe('Invalid password');
    },
    SLOW,
  );

  it(
    'accepts the correct password and leaves the attempt budget unspent',
    async () => {
      const { session, K_enc } = makeSession();
      const clientCounters = new BidirectionalCounters();

      await handleAuthPw(session, {}, pwPayload(K_enc, clientCounters, PASSWORD));

      expect(session.passwordVerified).toBe(true);
      expect(session.passwordAttempts).toBe(0);
      expect(session.terminated).toBeFalsy();
    },
    SLOW,
  );
});
