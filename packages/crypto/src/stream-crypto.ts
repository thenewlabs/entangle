import sodium from 'libsodium-wrappers-sumo';
import { CRYPTO_PARAMS } from '@sunpix/entangle-protocol';

/**
 * Stream-aware AEAD encryption that handles counters separately
 */
export async function streamAeadEncrypt(
  K_enc: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;
  
  const nonce = sodium.randombytes_buf(CRYPTO_PARAMS.NONCE_BYTES);
  
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    K_enc
  );
  
  // Combine nonce and cipher for transport
  const result = new Uint8Array(nonce.length + cipher.length);
  result.set(nonce, 0);
  result.set(cipher, nonce.length);
  
  return result;
}

/**
 * Stream-aware AEAD decryption that handles counters separately
 */
export async function streamAeadDecrypt(
  K_enc: Uint8Array,
  payload: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;
  
  const minLength = CRYPTO_PARAMS.NONCE_BYTES + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
  if (payload.length < minLength) {
    throw new Error(`Payload too short: expected at least ${minLength} bytes, got ${payload.length}`);
  }
  
  const nonce = payload.slice(0, CRYPTO_PARAMS.NONCE_BYTES);
  const cipher = payload.slice(CRYPTO_PARAMS.NONCE_BYTES);
  
  try {
    // NOTE: libsodium-wrappers signature is (nsec, cipher, aad, nonce, key)
    // Keep it consistent with aeadDecrypt in index.ts
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      cipher,
      aad,
      nonce,
      K_enc
    );
    
    return plaintext;
  } catch (e: any) {
    // Add more context to the error
    throw new Error(`streamAeadDecrypt failed: ${e.message || e}. Payload length: ${payload.length}, Nonce length: ${nonce.length}, Cipher length: ${cipher.length}, Key length: ${K_enc.length}, AAD length: ${aad.length}`);
  }
}
