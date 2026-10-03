try {
  require('dotenv').config();
} catch {
  // dotenv is optional when environment variables are provided by the host/container
}

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

  // Wyzie Subtitles optional API key (free key from https://store.wyzie.io/redeem)
  wyzieApiKey: process.env.WYZIE_API_KEY || '',

  // Security & Handshake Signing
  adminSecret: process.env.ADMIN_SECRET || 'admin123',
  proxySecret: process.env.PROXY_SECRET || 'vidstuck-edge-hmac-secret-key-2026-9f8e7d6c5b4a',
  zxcAesKey: process.env.ZXC_AES_KEY || '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c',
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

  // Upstream Provider Endpoints (Real Production Providers)
  upstreams: {
    vidstuckBase: process.env.VIDSTUCK_BASE_URL || 'https://vidstuck.xyz',
    zxcBase: process.env.ZXC_BASE_URL || 'https://zxcstream.icu',
    vidsrcDataUrl: process.env.VIDSRC_DATA_URL || 'https://data.vidsrc.sh/api.php',
    hicineApiBase: process.env.HICINE_API_BASE || 'https://api.hicine.sbs',
    hianimeBase: process.env.HIANIME_BASE_URL || 'https://hianime.at',
    wyzieSubsUrl: process.env.WYZIE_SUBS_URL || 'https://sub.wyzie.ru',
    openSubtitlesRestUrl: 'https://rest.opensubtitles.org',
    openSubtitlesStremioUrl: 'https://opensubtitles-v3.strem.io',
    introDbUrl: process.env.INTRODB_URL || 'https://api.introdb.app',
    aniSkipUrl: process.env.ANISKIP_URL || 'https://api.aniskip.com/v2',
    cinemetaUrl: 'https://v3-cinemeta.strem.io',

    // Internet Archive (public-domain films) — the lawful default source.
    // Set ARCHIVE_ALLOW_CC=1 to also accept Creative Commons (attribution) items.
    archiveSearchUrl: process.env.ARCHIVE_SEARCH_URL || 'https://archive.org/advancedsearch.php',
    archiveMetadataUrl: process.env.ARCHIVE_METADATA_URL || 'https://archive.org/metadata',
    archiveDownloadBase: process.env.ARCHIVE_DOWNLOAD_BASE || 'https://archive.org/download',
    archiveDetailsBase: process.env.ARCHIVE_DETAILS_BASE || 'https://archive.org/details'
  },

  // Server definitions matching VidStuck's cloud server switcher
  servers: [
    {
      id: 'archive',
      name: 'Archive',
      badge: 'Public Domain • Internet Archive',
      priority: 0,
      supportsMultiAudio: false
    },
    {
      id: 'andromeda',
      name: 'Andromeda',
      badge: 'Primary • Multi-Audio HLS',
      priority: 1,
      supportsMultiAudio: true
    },
    {
      id: 'ursa',
      name: 'Ursa',
      badge: 'VidSrc • Fast CDN HLS',
      priority: 2,
      supportsMultiAudio: false
    },
    {
      id: 'centaurus',
      name: 'Centaurus',
      badge: 'HiCine • Direct 1080p/720p MP4',
      priority: 3,
      supportsMultiAudio: true
    },
    {
      id: 'atlas',
      name: 'Atlas',
      badge: 'ZXC Backup • Adaptive HLS',
      priority: 4,
      supportsMultiAudio: true
    },
    {
      id: 'strings',
      name: 'Strings',
      badge: 'Anime Sub/Dub • Zoko HLS',
      priority: 5,
      supportsMultiAudio: true
    }
  ]
};

module.exports = config;
