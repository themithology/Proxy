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

  // Wyzie Subtitles optional API key (free key from https://store.wyzie.io/redeem)
  wyzieApiKey: process.env.WYZIE_API_KEY || '',

  // Security & Handshake Signing
  adminSecret: process.env.ADMIN_SECRET || 'admin123',
  proxySecret: process.env.PROXY_SECRET || 'vidstuck-edge-hmac-secret-key-2026-9f8e7d6c5b4a',
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

    vidstuckBase: process.env.VIDSTUCK_BASE_URL || 'https://vidstuck.xyz',
    hicineApiBase: process.env.HICINE_API_BASE || 'https://api.hicine.sbs',
    wyzieSubsUrl: process.env.WYZIE_SUBS_URL || 'https://sub.wyzie.ru',
    openSubtitlesRestUrl: 'https://rest.opensubtitles.org',
    openSubtitlesStremioUrl: 'https://opensubtitles-v3.strem.io',
    introDbUrl: process.env.INTRODB_URL || 'https://api.introdb.app',
    aniSkipUrl: process.env.ANISKIP_URL || 'https://api.aniskip.com/v2',
    cinemetaUrl: 'https://v3-cinemeta.strem.io'
  },

  // Hamster Wheel (server #3) — Hindi-first fan-out across MovieBox (HMAC mobile
  // API), HindMoviez and 4KHDHub. Indian release sites rotate domains every few
  // weeks, so site bases are resolved through a public domains.json instead of
  // being hardcoded; env values below are the fallbacks used when it is
  // unreachable. See docs/hamster-wheel-upstream-research.md.
  hamster: {
    enabled: parseBoolean(process.env.HAMSTER_ENABLED, true),
    timeoutMs: parsePositiveInteger(process.env.HAMSTER_TIMEOUT_MS, 12000),
    providerTimeoutMs: parsePositiveInteger(process.env.HAMSTER_PROVIDER_TIMEOUT_MS, 9000),
    probeTimeoutMs: parsePositiveInteger(process.env.HAMSTER_PROBE_TIMEOUT_MS, 3500),
    unrollBudgetMs: parsePositiveInteger(process.env.HAMSTER_UNROLL_BUDGET_MS, 7000),
    maxCandidates: parsePositiveInteger(process.env.HAMSTER_MAX_CANDIDATES, 10),
    maxProbeCandidates: parsePositiveInteger(process.env.HAMSTER_MAX_PROBE_CANDIDATES, 5),
    domainsUrl:
      process.env.HAMSTER_DOMAINS_URL ||
      'https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json',
    domainsTtlMs: parsePositiveInteger(process.env.HAMSTER_DOMAINS_TTL_MS, 30 * 60 * 1000),
    hindmoviezBase: process.env.HINDMOVIEZ_BASE_URL || 'https://hindmovie.dev',
    fourKhdhubBase: process.env.FOURKHDHUB_BASE_URL || 'https://4khdhub.one',
    movieboxHosts: (
      process.env.MOVIEBOX_HOSTS ||
      'https://api6.aoneroom.com,https://api5.aoneroom.com,https://api4.aoneroom.com,https://api4sg.aoneroom.com,https://api3.aoneroom.com,https://api6sg.aoneroom.com,https://api.inmoviebox.com'
    )
      .split(',')
      .map((host) => host.trim().replace(/\/$/, ''))
      .filter(Boolean),
    // Fixed public client key used by the MovieBox mobile app; override only if
    // the upstream rotates it (see docs/hamster-wheel-upstream-research.md).
    movieboxSecretHex: process.env.MOVIEBOX_SECRET_HEX || '',
    movieboxRegion: process.env.MOVIEBOX_REGION || 'IN'
  },

  // Server 2 ("Centaurus") source #2 — Anime Dub Hindi. A WordPress release
  // blog: search → post → new.adhlinks.com episode page → HubCloud/GDFlix.
  // Post and episode slugs are followed, never constructed (`blubox-s1`), so
  // only the blog base is configurable. See docs §9.
  animedubhindi: {
    enabled: parseBoolean(process.env.ANIMEDUBHINDI_ENABLED, true),
    baseUrl: process.env.ANIMEDUBHINDI_BASE_URL || 'https://www.animedubhindi.link',
    // The Worker delegates this source with its own upstream timeout, so the
    // whole flow (search → post → episode page → unroll → probe) must fit in
    // less than that; 8s leaves headroom for the response transfer.
    timeoutMs: parsePositiveInteger(process.env.ANIMEDUBHINDI_TIMEOUT_MS, 8000),
    unrollBudgetMs: parsePositiveInteger(process.env.ANIMEDUBHINDI_UNROLL_BUDGET_MS, 6000),
    probeTimeoutMs: parsePositiveInteger(process.env.ANIMEDUBHINDI_PROBE_TIMEOUT_MS, 3500),
    maxProbeCandidates: parsePositiveInteger(process.env.ANIMEDUBHINDI_MAX_PROBE_CANDIDATES, 5),
    pageBodyCap: parsePositiveInteger(process.env.ANIMEDUBHINDI_PAGE_BODY_CAP, 1400 * 1024)
  },

  // Server 2 (Centaurus) source #3: AnimeDrive — a Hindi-dub anime release
  // blog. Flow: search (`/?s=`) → post → link.animedrive.cc landing page →
  // `EP NN` blocks → per-quality HubCloud/GDFlix rows. Row links are wrapped as
  // `link.animedrive.cc/dl/<base64url(reverse(targetUrl))>` and are decoded in
  // src/services/animedrive.js, then unrolled by the shared HubCloud/GDFlix
  // helpers. Only the blog base is configurable; every path is followed. §10.
  animedrive: {
    enabled: parseBoolean(process.env.ANIMEDRIVE_ENABLED, true),
    baseUrl: process.env.ANIMEDRIVE_BASE_URL || 'https://animedrive.cc',
    linksBaseUrl: process.env.ANIMEDRIVE_LINKS_BASE_URL || 'https://link.animedrive.cc',
    // Same budget shape as Anime Dub Hindi: the whole flow must fit inside the
    // Worker's upstream timeout with headroom for the response transfer.
    timeoutMs: parsePositiveInteger(process.env.ANIMEDRIVE_TIMEOUT_MS, 8000),
    unrollBudgetMs: parsePositiveInteger(process.env.ANIMEDRIVE_UNROLL_BUDGET_MS, 6000),
    probeTimeoutMs: parsePositiveInteger(process.env.ANIMEDRIVE_PROBE_TIMEOUT_MS, 3500),
    maxProbeCandidates: parsePositiveInteger(process.env.ANIMEDRIVE_MAX_PROBE_CANDIDATES, 6),
    pageBodyCap: parsePositiveInteger(process.env.ANIMEDRIVE_PAGE_BODY_CAP, 1600 * 1024)
  },

  // Server definitions (names, badges, priorities) live in the shared catalog so
  // the Worker that serves the player and this backend can never drift apart.
  // `servers` is kept in priority order, which is also the implicit waterfall
  // order.
  servers: serverCatalog.nodeServerList()
};

module.exports = config;
