import sodium from 'libsodium-wrappers-sumo';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { encode, decode } from 'cborg';
import { CRYPTO_PARAMS } from '@thenewlabs/entangle-protocol';

export interface DerivedKeys {
  K_enc: Uint8Array;
  K_auth: Uint8Array;
}

/**
 * AEAD direction discriminator. Bound into the AAD of every frame so a
 * ciphertext produced for one direction can never be reflected back and
 * accepted in the other direction (both peers share the same K_enc).
 */
export enum AeadDir {
  ServerToClient = 1, // agent -> invoker
  ClientToServer = 2, // invoker -> agent
}

let sodiumReady = false;

export async function initCrypto(): Promise<void> {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
}

export function extractSaltFromCapId(capId: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(capId);
  } catch (error) {
    throw new Error('Invalid capId length');
  }
  
  if (decoded.length !== CRYPTO_PARAMS.SALT_CAP_BYTES + CRYPTO_PARAMS.CAP_RAND_BYTES) {
    throw new Error('Invalid capId length');
  }
  return decoded.slice(0, CRYPTO_PARAMS.SALT_CAP_BYTES);
}

export function generateCapId(): { capId: string; saltCap: Uint8Array } {
  const saltCap = sodium.randombytes_buf(CRYPTO_PARAMS.SALT_CAP_BYTES);
  const capRand = sodium.randombytes_buf(CRYPTO_PARAMS.CAP_RAND_BYTES);
  const combined = new Uint8Array(CRYPTO_PARAMS.SALT_CAP_BYTES + CRYPTO_PARAMS.CAP_RAND_BYTES);
  combined.set(saltCap, 0);
  combined.set(capRand, CRYPTO_PARAMS.SALT_CAP_BYTES);
  return {
    capId: base64UrlEncode(combined),
    saltCap,
  };
}

export function generateSecret(): string {
  const secret = sodium.randombytes_buf(32);
  return base64UrlEncode(secret);
}

/**
 * Derive the root key material from the capability secret. This is the
 * expensive Argon2id step; callers should run it once per connection and
 * reuse the returned `K_raw` for both bootstrap and session key derivation.
 */
export async function deriveKeyMaterial(S: Uint8Array | string, saltCap: Uint8Array): Promise<Uint8Array> {
  await initCrypto();

  const secretBytes = typeof S === 'string' ? base64UrlDecode(S) : S;

  return sodium.crypto_pwhash(
    32,
    secretBytes,
    saltCap,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

function hkdfKeys(K_raw: Uint8Array, salt: Uint8Array, info: string): DerivedKeys {
  const derived = hkdf(sha256, K_raw, salt, new TextEncoder().encode(info), 64);
  return {
    K_enc: derived.slice(0, 32),
    K_auth: derived.slice(32, 64),
  };
}

/**
 * Bootstrap keys — derived purely from the capability secret, identical for
 * every session. Used ONLY to authenticate AUTH1 and to protect the AUTH2
 * handshake message that carries the fresh session nonces. Never used for
 * command data.
 */
export function deriveBootstrapKeys(K_raw: Uint8Array): DerivedKeys {
  return hkdfKeys(K_raw, new Uint8Array(0), 'entangle-capability');
}

/**
 * Per-session keys — bound to the fresh handshake nonces (nonceB from the
 * client, nonceC from the agent). Because both nonces are random per
 * connection, every session gets distinct K_enc/K_auth, so ciphertext
 * captured from one session cannot be replayed into another (each side's
 * counters also reset per session). This is what actually defeats the
 * cross-session replay / stale-output-injection attack.
 */
export function deriveSessionKeys(K_raw: Uint8Array, nonceB: string, nonceC: string): DerivedKeys {
  const salt = new TextEncoder().encode(`${nonceB}|${nonceC}`);
  return hkdfKeys(K_raw, salt, 'entangle-session-v2');
}

/**
 * Convenience: bootstrap keys directly from the secret. Kept for callers that
 * only need the capability-static keys (e.g. AUTH1 HMAC before nonces exist).
 */
export async function deriveKeys(S: Uint8Array | string, saltCap: Uint8Array): Promise<DerivedKeys> {
  const K_raw = await deriveKeyMaterial(S, saltCap);
  return deriveBootstrapKeys(K_raw);
}

export interface AeadEncResult {
  nonce: Uint8Array;
  cipher: Uint8Array;
}

/**
 * Canonical AAD for a frame: binds both the frame type and the direction so
 * a peer can never accept its own ciphertext reflected back.
 */
export function frameAad(type: number, dir: AeadDir): Uint8Array {
  return encode({ type, dir });
}

export function aeadEncrypt(
  K_enc: Uint8Array,
  type: number,
  ctr: number,
  plaintext: any,
  dir: AeadDir
): AeadEncResult {
  const nonce = sodium.randombytes_buf(CRYPTO_PARAMS.NONCE_BYTES);
  const aad = frameAad(type, dir);
  const pt = encode({ ctr, msg: plaintext });

  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    pt,
    aad,
    null,
    nonce,
    K_enc
  );

  return { nonce, cipher };
}

export function aeadDecrypt(
  K_enc: Uint8Array,
  type: number,
  nonce: Uint8Array,
  cipher: Uint8Array,
  dir: AeadDir
): { ctr: number; msg: any } {
  const aad = frameAad(type, dir);

  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    cipher,
    aad,
    nonce,
    K_enc
  );

  const decoded = decode(pt) as { ctr: number; msg: any };
  return decoded;
}

/**
 * Password hashing for the optional second-factor. Uses Argon2id with a
 * random salt (via libsodium's crypto_pwhash_str), so the stored value is not
 * a password-equivalent secret and cracking a leaked value is expensive.
 */
export async function hashPassword(password: string): Promise<string> {
  await initCrypto();
  return sodium.crypto_pwhash_str(
    password,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  );
}

/** Constant-time verification of a password against a stored Argon2id hash. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  await initCrypto();
  try {
    return sodium.crypto_pwhash_str_verify(storedHash, password);
  } catch {
    return false;
  }
}

export function computeHmac(K_auth: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, K_auth, data);
}

export function verifyHmac(K_auth: Uint8Array, data: Uint8Array, mac: Uint8Array): boolean {
  const computed = computeHmac(K_auth, data);
  return sodium.compare(computed, mac) === 0;
}

// Convenience: SHA-256 of UTF-8 string, returned as lowercase hex
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const hash = sha256(bytes);
  let hex = '';
  // Iterate without indexed access to satisfy noUncheckedIndexedAccess
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function base64UrlEncode(data: Uint8Array): string {
  // Use Node Buffer when available to avoid relying on btoa (not in Node)
  let base64: string;
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    base64 = Buffer.from(data).toString('base64');
  } else {
    // Browser fallback
    base64 = btoa(String.fromCharCode(...data));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function hashPolicy(policy: any): string {
  const encoded = encode(policy);
  const hash = sha256(encoded);
  return base64UrlEncode(hash);
}

export * from './stream-crypto.js';
