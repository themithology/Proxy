const os = require('os');
const path = require('path');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional when environment variables are provided by the host/container
}

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

  // Wyzie Subtitles optional API key (free key from https://store.wyzie.io/redeem)
  wyzieApiKey: process.env.WYZIE_API_KEY || '',

  // Security & Handshake Signing
  adminSecret: process.env.ADMIN_SECRET || 'admin123',
  proxySecret: process.env.PROXY_SECRET || 'vidstuck-edge-hmac-secret-key-2026-9f8e7d6c5b4a',
  zxcAesKey: process.env.ZXC_AES_KEY || '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c',
  tokenTtlSeconds: parseInt(process.env.TOKEN_TTL_SECONDS || '14400', 10), // 4 hours

  // Node-only MKV/MP4 audio remuxing. `enabled` is finalized by the multitrack
  // service after it detects both ffmpeg and ffprobe at startup.
  multitrack: {
    enabled: false,
    requested: parseBoolean(process.env.MULTITRACK_ENABLED, true),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    cacheDir: process.env.MULTITRACK_CACHE_DIR || path.join(os.tmpdir(), 'proxy-multitrack'),
    probeCacheTtlMs: parsePositiveInteger(process.env.MULTITRACK_PROBE_CACHE_TTL_MS, 10 * 60 * 1000),
    cacheTtlMs: parsePositiveInteger(process.env.MULTITRACK_CACHE_TTL_MS, 2 * 60 * 60 * 1000),
    probeTimeoutMs: parsePositiveInteger(process.env.MULTITRACK_PROBE_TIMEOUT_MS, 8000),
    startupTimeoutMs: parsePositiveInteger(process.env.MULTITRACK_STARTUP_TIMEOUT_MS, 30 * 1000),
    jobTimeoutMs: parsePositiveInteger(process.env.MULTITRACK_JOB_TIMEOUT_MS, 20 * 60 * 1000),
    maxJobs: Math.min(2, parsePositiveInteger(process.env.MULTITRACK_MAX_JOBS, 1)),
    allowedHosts: (process.env.MULTITRACK_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase().replace(/^\.|\.$/g, ''))
      .filter(Boolean)
  },

  // External Cloudflare Worker M3U8 Proxy Pool (Comma-separated URLs for load balancing)
  // Example: https://proxy-1.yourname.workers.dev,https://proxy-2.yourname.workers.dev
  externalProxyPool: (process.env.EXTERNAL_PROXY_POOL || '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean),

  // Optional Upstash Redis REST cache for serverless / multi-instance deployments
  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',

  // Upstream Provider Endpoints (Real Production Providers with Dynamic Discovery)
  upstreams: {
    castletvBase: process.env.CASTLETV_BASE_URL || 'https://api.hlowb.com',
    castletvHosts: (process.env.CASTLETV_HOSTS || 'https://api.hlowb.com')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),

    // MovieBox dynamic cluster pool (replaces deprecated api3.aoneroom.com / uwu.eat-peach.sbs)
    // NetMirror dynamic discovery & rotating web mirror (replaces static net27.cc)
    netmirrorBase: process.env.NETMIRROR_BASE_URL || 'https://net27.cc',
    // Web mirrors that serve the TMDB-id keyed /api/embed-tmdb endpoint. The
    // NewTV discovery API base (tv.imgcdn.kim) is regressed upstream, so these
    // are tried directly (and rotated) before giving up on NetMirror.
    netmirrorWebMirrors: (
      process.env.NETMIRROR_WEB_MIRRORS ||
      'https://net27.cc,https://net52.cc,https://net77.cc,https://netmiror.com'
    )
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    netmirrorDiscoveryUrls: (
      process.env.NETMIRROR_DISCOVERY_URLS ||
      'https://mobiledetect.app,https://mobiledetects.com,https://mobidetect.cc,https://mobidetects.top,https://getimgcdn.com,https://mobidetect.art,https://mobidetect.click'
    )
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),

    // Ursa (4K UHD Multi-Audio Server) 4-Tier Cascade Upstreams
    fourkhdhubBase: process.env.FOURKHDHUB_BASE_URL || 'https://4khdhub.one',
    fourkhdhubHosts: (
      process.env.FOURKHDHUB_HOSTS ||
      'https://4khdhub.one,https://4khdhub.link,https://4khdhub.fans,https://4khdhub.ink,https://4khdhub.click'
    )
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    moviesdriveBase: process.env.MOVIESDRIVE_BASE_URL || 'https://new5.moviesdrive.christmas',
    moviesdriveHosts: (
      process.env.MOVIESDRIVE_HOSTS ||
      'https://new5.moviesdrive.christmas,https://new4.moviesdrive.christmas,https://moviesdrives.cfd,https://moviesdrive.world,https://moviesdrive.design'
    )
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    dahmerBase: process.env.DAHMER_BASE_URL || 'https://a.111477.xyz',
    domainDiscoveryUrl:
      process.env.DOMAIN_DISCOVERY_URL ||
      'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json',

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
    cinemetaUrl: 'https://v3-cinemeta.strem.io'
  },

  // Server definitions matching VidStuck's cloud server switcher
  servers: [
    {
      id: 'andromeda',
      name: 'Fiber Optic Speedrun',
      badge: 'Multi-Audio • Primary',
      priority: 1,
      supportsMultiAudio: true
    },
    {
      id: 'ursa',
      name: 'FBI Surveillance Van',
      badge: '4K UHD • Multi-Audio',
      priority: 3,
      supportsMultiAudio: true
    },
    {
      id: 'centaurus',
      name: 'Gigachad Node',
      badge: 'Adaptive • Multi-Quality',
      priority: 2,
      supportsMultiAudio: true
    },
    {
      id: 'atlas',
      name: 'Atlas',
      badge: 'Adaptive • Backup',
      priority: 5,
      supportsMultiAudio: true
    },
    {
      id: 'hamster',
      name: 'Hamster Wheel',
      badge: 'Multi-Language • OMSS Cascade',
      priority: 4,
      supportsMultiAudio: true
    }
  ]
};

module.exports = config;
