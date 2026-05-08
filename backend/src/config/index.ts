import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  PORT: parseInt(optional('PORT', '3000'), 10),
  NODE_ENV: optional('NODE_ENV', 'development'),
  CORS_ORIGIN: optional('CORS_ORIGIN', '*'),

  MONGO_URI: optional('MONGO_URI', 'mongodb://localhost:27017/robowars'),

  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '24h'),

  // 0G Storage — mainnet (chain ID 16661)
  ZG_RPC_URL: optional('ZG_RPC_URL', 'https://evmrpc.0g.ai'),
  ZG_INDEXER_RPC: optional(
    'ZG_INDEXER_RPC',
    'https://indexer-storage-turbo.0g.ai'
  ),

  // ── Key separation ─────────────────────────────────────────────────────────
  // ZG_PRIVATE_KEY  : primary key — used for auth wallet recovery (ethers.verifyMessage),
  //                   on-chain lookups, and as the default fallback signer.
  // ZG_STORAGE_PRIVATE_KEY : dedicated storage upload key — signs 0G Flow contract
  //                   transactions for file uploads. Separate so a compromised
  //                   storage key cannot be used for auth/compute operations.
  //                   If not set, falls back to ZG_PRIVATE_KEY (backward-compatible).
  //
  // Recommended production setup:
  //   ZG_PRIVATE_KEY          = cold wallet, minimal on-chain permissions
  //   ZG_STORAGE_PRIVATE_KEY  = hot wallet, funded only for storage gas fees
  ZG_PRIVATE_KEY: required('ZG_PRIVATE_KEY'),
  ZG_STORAGE_PRIVATE_KEY:
    process.env['ZG_STORAGE_PRIVATE_KEY'] ?? process.env['ZG_PRIVATE_KEY']!,

  ZG_EXPECTED_REPLICAS: parseInt(optional('ZG_EXPECTED_REPLICAS', '3'), 10),

  // 0G DA — testnet (Galileo) only as of May 2026
  // Mainnet DA is under active development; no official mainnet disperser endpoint
  // has been published. Switch this default once 0G Labs publishes mainnet DA docs.
  ZG_DA_DISPERSER: optional('ZG_DA_DISPERSER', 'disperser-testnet.0g.ai:51001'),
  ZG_DA_TLS: optional('ZG_DA_TLS', 'false') === 'true',
  ZG_DA_POLL_TIMEOUT_MS: parseInt(optional('ZG_DA_POLL_TIMEOUT_MS', '120000'), 10),
  ZG_DA_POLL_INTERVAL_MS: parseInt(optional('ZG_DA_POLL_INTERVAL_MS', '5000'), 10),

  // 0G Compute Network
  ZG_COMPUTE_API_KEY: required('ZG_COMPUTE_API_KEY'),
  ZG_COMPUTE_BASE_URL: optional('ZG_COMPUTE_BASE_URL', 'https://router-api.0g.ai/v1'),
  // Best model for structured JSON output with large context
  ZG_COMPUTE_MODEL: optional('ZG_COMPUTE_MODEL', 'zai-org/GLM-5-FP8'),
  // Synchronous TEE verification on every compute call (set false to trust router only)
  ZG_COMPUTE_VERIFY_TEE: optional('ZG_COMPUTE_VERIFY_TEE', 'true') === 'true',
  // Independent TEE verification via EIP-191 signature check (adds ~500ms)
  ZG_COMPUTE_INDEPENDENT_VERIFY: optional('ZG_COMPUTE_INDEPENDENT_VERIFY', 'true') === 'true',
  // Max ms to wait for a compute response before timeout
  ZG_COMPUTE_TIMEOUT_MS: parseInt(optional('ZG_COMPUTE_TIMEOUT_MS', '30000'), 10),
  // Minimum confidence score the model must return for the save to be accepted
  ZG_COMPUTE_MIN_CONFIDENCE: parseFloat(optional('ZG_COMPUTE_MIN_CONFIDENCE', '0.7')),
  // Routing preference: "latency" | "price" | "" (auto)
  ZG_COMPUTE_ROUTING: optional('ZG_COMPUTE_ROUTING', 'latency'),

  // Upload constraints
  MAX_FILE_SIZE_BYTES: parseInt(optional('MAX_FILE_SIZE_MB', '50'), 10) * 1024 * 1024,
  NONCE_EXPIRY_MS: parseInt(optional('NONCE_EXPIRY_MS', '300000'), 10),
} as const;

export type Config = typeof config;
