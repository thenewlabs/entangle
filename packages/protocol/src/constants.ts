export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1048576; // 1MB default
export const NAMESPACE_PREFIX = 'ns_';
export const NAMESPACE_LENGTH = 10; // base32 chars after prefix

export const DEFAULT_LIMITS = {
  MAX_ARG_COUNT: 64,
  MAX_ARG_LEN: 4096,
  MAX_CPU_MS: 60000,
  MAX_MEM_MB: 512,
  MAX_WALL_MS: 300000, // 5 minutes
  MAX_OUT_BYTES: 10485760, // 10MB
} as const;

export const CRYPTO_PARAMS = {
  SALT_CAP_BYTES: 16,
  CAP_RAND_BYTES: 16,
  NONCE_BYTES: 24,
  KEY_BYTES: 32,
  HMAC_BYTES: 32,
} as const;