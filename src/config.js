const os = require('os');
const path = require('path');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional when environment variables are provided by the host/container
}

const serverCatalog = require('./services/serverCatalog');
const proxySign = require('./utils/proxySign');

const parseBoolean = (value, fallback = true) => {
  if (value == null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
};
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const nodeEnv = process.env.NODE_ENV || 'production';
const isProduction = String(nodeEnv).toLowerCase() === 'production';

/**
 * Resolve a signing/admin secret, refusing to fall back to a value that has
 * ever been published in this repository.
 *
 * Why this is a hard failure and not a warning: `ADMIN_SECRET` guards routes
 * that hot-swap upstream URLs and AES keys and inject arbitrary stream URLs for
 * any TMDB id, and `PROXY_SECRET` signs every proxy URL and multi-track master
 * (including the `trusted=1` flag that relaxes the remux host allowlist). The
 * previous defaults were committed to git, so any deployment that silently
 * inherited them was fully controllable by anyone who had read the repo.
 *
 * - production: throw at boot with the exact env var to set.
 * - other envs: generate an ephemeral random secret so `npm run dev` and the
 *   hermetic test suite work with zero configuration, and say so loudly.
 */
function resolveSecret(name, { allowEphemeral = true } = {}) {
  const provided = String(process.env[name] || '').trim();
  const problem = proxySign.describeSecretProblem(provided);

  if (!problem) {
    if (proxySign.looksLikeSampleSecret(provided)) {
      console.warn(
        `[LOL Embed] WARNING: ${name} looks like a placeholder ("${provided.slice(0, 12)}..."). ` +
        'Generate a real one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
      );
    }
    return provided;
  }

  if (isProduction) {
    throw new Error(
      `[LOL Embed] Refusing to start: ${name} ${problem}.\n` +
      `  Set it to a strong random value, e.g.:\n` +
      `    ${name}=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")\n` +
      `  On Cloudflare Workers use \`npx wrangler secret put ${name}\` (never [vars] in wrangler.toml).\n` +
      `  PROXY_SECRET must be IDENTICAL on every runtime that signs or verifies proxy URLs.`
    );
  }

  if (!allowEphemeral) return '';
  const generated = proxySign.generateSecret();
  console.warn(
    `[LOL Embed] ${name} ${problem}; generated an ephemeral one for this ${nodeEnv} process. ` +
    'Signed URLs will not survive a restart. Set it explicitly for anything real.'
  );
  return generated;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv,
  isProduction,

  // Public base URL of this server (used for absolute M3U8 segment rewriting when needed)
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),

  // How many reverse-proxy hops to trust for X-Forwarded-For. `true` used to be
  // set here, which makes Express trust the LEFTMOST (client-supplied) entry, so
  // any caller could forge its own IP and walk straight through per-IP rate
  // limits. 1 = trust only the proxy directly in front of this process.
  trustProxyHops: parsePositiveInteger(process.env.TRUST_PROXY_HOPS, 1),

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

  // Security & Handshake Signing. Both values are mandatory in production and
  // must never equal a value that has been committed to this repository.
  adminSecret: resolveSecret('ADMIN_SECRET'),
  proxySecret: resolveSecret('PROXY_SECRET'),
  tokenTtlSeconds: parseInt(process.env.TOKEN_TTL_SECONDS || '14400', 10), // 4 hours
  // Signed proxy URLs handed to a player must outlive a paused/large download.
  proxyUrlTtlSeconds: parsePositiveInteger(process.env.PROXY_URL_TTL_SECONDS, 4 * 60 * 60),

  // SSRF guard escape hatch. The media proxy refuses loopback/private/link-local
  // targets (169.254.169.254, 127.0.0.1:6379, the Docker socket, ...). This flag
  // exists ONLY so the hermetic test suite can proxy to a 127.0.0.1 mock and so
  // local development can point at a LAN box — it is NEVER honored in
  // production, whatever the environment says.
  proxyAllowPrivateTargets:
    !isProduction && parseBoolean(process.env.PROXY_ALLOW_PRIVATE_TARGETS, false),

  // Per-client rate limits (fixed window). `/api/resolve` is the scrapeable
  // surface: TMDB ids are sequential integers, so an unauthenticated crawler can
  // walk the whole catalog. It stays public by design (this is an embed API) but
  // it is throttled, and the throttle key is the least-spoofable identity
  // available (see utils/rateLimit.js).
  rateLimit: {
    enabled: parseBoolean(process.env.RATE_LIMIT_ENABLED, true),
    resolvePerMinute: parsePositiveInteger(process.env.RATE_LIMIT_RESOLVE_PER_MINUTE, 30),
    proxyPerMinute: parsePositiveInteger(process.env.RATE_LIMIT_PROXY_PER_MINUTE, 600),
    metadataPerMinute: parsePositiveInteger(process.env.RATE_LIMIT_METADATA_PER_MINUTE, 120),
    handshakePerMinute: parsePositiveInteger(process.env.RATE_LIMIT_HANDSHAKE_PER_MINUTE, 30),
    // Failed admin-key attempts. Much tighter: this is a brute-force oracle.
    adminAuthPerMinute: parsePositiveInteger(process.env.RATE_LIMIT_ADMIN_AUTH_PER_MINUTE, 10),
    // OPT-IN ONLY. Client identity for limits is taken from unforgeable sources
    // (cf-connecting-ip, then the socket peer). Enable this only when a reverse
    // proxy that is NOT Cloudflare rewrites X-Forwarded-For with the real client
    // address (nginx `proxy_set_header X-Forwarded-For $remote_addr`, an ALB...).
    // Enabling it without such a proxy lets a caller rotate XFF and get a fresh
    // bucket on every request, defeating the limit entirely.
    trustForwardedHeaders: parseBoolean(process.env.RATE_LIMIT_TRUST_FORWARDED_HEADERS, false)
  },

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

    vidstuckBase: process.env.VIDSTUCK_BASE_URL || 'https://vidstuck.xyz',
    hicineApiBase: process.env.HICINE_API_BASE || 'https://api.hicine.sbs',
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
