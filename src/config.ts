import 'dotenv/config';
import { z } from 'zod';
import { resolve } from 'node:path';

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no', ''])])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return v === 'true' || v === '1' || v === 'yes';
    });

const int = (def: number) =>
  z.coerce.number().int().nonnegative().optional().default(def);

const Schema = z.object({
  PORT: int(3000),
  HOST: z.string().default('0.0.0.0'),
  // Empty = derive the origin from each request (see util/origin.ts).
  PUBLIC_URL: z.union([z.literal(''), z.string().url()]).default(''),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  TRUST_PROXY: bool(true),

  PROXY_SECRET: z.string().min(1).default('dev-insecure-secret-change-me'),
  API_KEY: z.string().default(''),
  ALLOWED_ORIGINS: z.string().default(''),

  CACHE_DRIVER: z.enum(['memory', 'sqlite', 'redis', 'none']).default('sqlite'),
  CACHE_DIR: z.string().default('./data'),
  CACHE_TTL_META: int(86_400),
  CACHE_TTL_STREAMS: int(3_600),
  CACHE_TTL_PROXY: int(21_600),
  CACHE_TTL_SEARCH: int(21_600),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  TMDB_API_KEY: z.string().default(''),
  TMDB_LANGUAGE: z.string().default('en-US'),

  PROVIDERS_CONFIG: z.string().default('./config/providers.json'),
  PROVIDER_FANOUT_CONCURRENCY: int(8),
  PROVIDER_TIMEOUT: int(15_000),
  PROVIDER_COOLDOWN: int(120_000),
  PROVIDER_FAILURE_THRESHOLD: int(4),

  EGRESS_PROXY: z.string().default(''),
  UPSTREAM_REFERER: z.string().default(''),
  UPSTREAM_USER_AGENT: z.string().default(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ),
  MAX_SEGMENT_BYTES: int(0),

  RATE_LIMIT_MAX: int(300),
  RATE_LIMIT_WINDOW: int(60_000),

  NODE_ENV: z.string().default('development'),
});

const parsed = Schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  /** Absolute path to the provider config file. */
  providersConfigPath: resolve(process.cwd(), env.PROVIDERS_CONFIG),
  /** Absolute path for on-disk state (sqlite cache, etc). */
  cacheFile: resolve(process.cwd(), env.CACHE_DIR, 'proxy-cache.sqlite'),
  /** Public origin with no trailing slash. */
  publicOrigin: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  allowedOrigins: env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  hasApiKey: env.API_KEY.length > 0,
  hasTmdb: env.TMDB_API_KEY.length > 0,
} as const;

export type Config = typeof config;
