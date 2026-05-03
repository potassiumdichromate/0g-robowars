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
  ZG_PRIVATE_KEY: required('ZG_PRIVATE_KEY'),
  ZG_EXPECTED_REPLICAS: parseInt(optional('ZG_EXPECTED_REPLICAS', '3'), 10),

  // 0G DA — mainnet
  ZG_DA_DISPERSER: optional('ZG_DA_DISPERSER', 'disperser.0g.ai:51001'),
  ZG_DA_TLS: optional('ZG_DA_TLS', 'true') === 'true',
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
