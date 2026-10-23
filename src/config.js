const os = require('os');
const path = require('path');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional when environment variables are provided by the host/container
}

const serverCatalog = require('./services/serverCatalog');

const parseBoolean = (value, fallback = true) => {
  if (value == null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
};
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'production',

  // Public base URL of this server (used for absolute M3U8 segment rewriting when needed)
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  // TMDB API Configuration (Used to resolve TMDB ID -> IMDb ID, TVDB ID, Seasons, Episodes, Metadata)
  // Includes a working default public TMDB v3 key so the server works out-of-the-box in production,
  // while allowing override via TMDB_API_KEY or TMDB_BEARER_TOKEN in .env
  tmdbApiKey: process.env.TMDB_API_KEY || '47a1a7df542d3d483227f758a7317dff',
  tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || '',
  tmdbBaseUrl: 'https://api.themoviedb.org/3',
  tmdbImageBase: 'https://image.tmdb.org/t/p',

  // Optional keyed subtitle sources. OpenSubtitles (via Stremio's v3 addon)
  // needs no key; Wyzie (free key: https://store.wyzie.io/redeem) and SubDL
  // (free key from a SubDL account) add coverage when configured.
  wyzieApiKey: process.env.WYZIE_API_KEY || '',
  subdlApiKey: process.env.SUBDL_API_KEY || '',
  // Extra host suffixes the subtitle proxy may fetch from (comma-separated).
  subtitleProxyHosts: process.env.SUBTITLE_PROXY_HOSTS || '',

  // Security & Handshake Signing
  adminSecret: process.env.ADMIN_SECRET || 'admin123',
  proxySecret: process.env.PROXY_SECRET || 'lol-embed-edge-hmac-secret-key-2026-9f8e7d6c5b4a',
  tokenTtlSeconds: parseInt(process.env.TOKEN_TTL_SECONDS || '14400', 10), // 4 hours

  // External Cloudflare Worker M3U8 Proxy Pool (Comma-separated URLs for load balancing)
  // Example: https://proxy-1.yourname.workers.dev,https://proxy-2.yourname.workers.dev
  externalProxyPool: (process.env.EXTERNAL_PROXY_POOL || '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean),

  // Optional Upstash Redis REST cache for serverless / multi-instance deployments
  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',

  // Goldmine server — the owner-hosted TMDB-Embed-API instance
  // (https://github.com/themithology/TMDB-Embed-API). It aggregates a dozen
  // stream providers behind one JSON API and answers with direct MKV/MP4
  // files (multi-audio dubs) plus HLS sources. The player runs the files
  // through the bundled movi-player engine (FFmpeg WASM).
  goldmine: {
    apiBase: (
      process.env.GOLDMINE_API_BASE ||
      process.env.TMDB_EMBED_API_BASE ||
      'https://rdp-running-campion.onrender.com'
    ).replace(/\/+$/, ''),
    // Generous by default: free-tier hosts (Render) cold-start slowly and the
    // aggregate endpoint fans out to every enabled provider.
    timeoutMs: parsePositiveInteger(process.env.GOLDMINE_TIMEOUT_MS, 30000),
    // Wrap direct file URLs in this backend's signed /api/proxy (CORS +
    // Range + server-side Referer/User-Agent — providers like Vidlink,
    // CastleTV and VixSrc gate on headers a browser cannot send). URLs the
    // TMDB-Embed-API already proxied itself (its own /ts-proxy host, when
    // `enableProxy` is on there) always pass through untouched.
    proxyStreams: parseBoolean(process.env.GOLDMINE_PROXY_STREAMS, true)
  },

  // External metadata endpoints (subtitles + skip segments)
  upstreams: {
    wyzieSubsUrl: process.env.WYZIE_SUBS_URL || 'https://sub.wyzie.ru',
    openSubtitlesStremioUrl: process.env.OPENSUBTITLES_STREMIO_URL || 'https://opensubtitles-v3.strem.io',
    subdlApiUrl: process.env.SUBDL_API_URL || 'https://api.subdl.com/api/v1',
    subdlDownloadUrl: process.env.SUBDL_DOWNLOAD_URL || 'https://dl.subdl.com',
    // Skip-segment providers (intro / recap / credits). TheIntroDB is keyed by
    // TMDB id, IntroDB by IMDb id, AniSkip by MAL id. The API key is optional
    // and only raises TheIntroDB's daily quota (500 -> 1000 requests per IP).
    theIntroDbUrl: process.env.THEINTRODB_URL || 'https://api.theintrodb.org/v3',
    theIntroDbApiKey: process.env.THEINTRODB_API_KEY || '',
    introDbUrl: process.env.INTRODB_URL || 'https://api.introdb.app',
    aniSkipUrl: process.env.ANISKIP_URL || 'https://api.aniskip.com/v2',
    cinemetaUrl: 'https://v3-cinemeta.strem.io'
  },

  // Server definitions (names, badges, priorities) live in the shared catalog so
  // the Worker that serves the player and this backend can never drift apart.
  // `servers` is kept in priority order, which is also the implicit waterfall
  // order.
  servers: serverCatalog.nodeServerList()
};

module.exports = config;
