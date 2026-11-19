// Loads .env (if present) and exposes typed configuration.
try {
  process.loadEnvFile();
} catch {
  // No .env file: fall back to process env / defaults below.
}

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  port: int(env.PORT, 3000),
  // Default lifetime for OAuth tokens; each OAuth client can override it in the UI.
  tokenTtlSeconds: int(env.TOKEN_TTL_SECONDS, 3600),
  rateLimitMax: int(env.RATE_LIMIT_MAX, 30),
  rateLimitWindowSeconds: int(env.RATE_LIMIT_WINDOW_SECONDS, 60),
  vmCount: int(env.VM_COUNT, 450),
  dataSeed: int(env.DATA_SEED, 20261119),
  mongoUri: env.MONGODB_URI || '',
  mongoDb: env.MONGODB_DB || 'cloud_inventory_mock',
  requireMongo: env.REQUIRE_MONGODB === 'true',
  maxPageSize: 200,
};
