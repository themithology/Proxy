/**
 * LOL Embed Cloudflare Worker — embedded player page (/embed) + backend API
 * (TMDB Resolver + Stream Extractors + Edge M3U8 Proxy).
 *
 * This is the player Worker: it serves the embeddable player at exactly
 * /embed plus the player's assets. The main website is built separately and
 * embeds this Worker with an iframe. The landing/developer portal, demo page,
 * and admin dashboard UI are not served; `/` stays a JSON endpoint.
 *
 * The player's API base URL is configurable (API_BASE_URL var or `?api=`
 * query parameter) so the player and the API can run on different Workers.
 *
 * Deploy with:
 *   npx wrangler deploy
 * Or connect your GitHub repository directly in the Cloudflare Dashboard -> Workers & Pages.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
// Shared TMDB-anchored identity matching (single source of truth with the Node backend).
import identity from '../src/services/identity.js';
// Shared server catalog (single source of truth with the Node backend). The player renders the `servers` array returned by /api/resolve,
// so rebranding or re-prioritising a server must never require a second edit here.
import serverCatalog from '../src/services/serverCatalog.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Player-visible servers in waterfall priority order (shared catalog). */
const SERVERS = serverCatalog.workerServerList();


// Runtime-editable Upstream Config & Telemetry State in Cloudflare Worker
const runtimeState = {
  startedAt: new Date().toISOString(),
  upstreams: {
    castletvBase: 'https://api.hlowb.com',
    netmirrorBase: 'https://net27.cc',
    vidstuckBase: 'https://vidstuck.xyz',
    hicineApiBase: 'https://api.hicine.sbs'
  },
  externalProxyPool: [],
  domains: new Map(),
  blockedDomains: new Set(),
  customOverrides: new Map(),
  serverMetrics: new Map(
    SERVERS.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        badge: s.badge,
        enabled: true,
        priority: s.priority,
        status: 'online',
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastLatencyMs: 0,
        lastError: null
      }
    ])
  )
};

function extractCallerDomain(request, url) {
  const candidates = [
    url.searchParams.get('parent'),
    url.searchParams.get('domain'),
    request.headers.get('origin'),
    request.headers.get('referer')
  ].filter(Boolean);
  const selfHost = url.hostname.toLowerCase();
  for (const raw of candidates) {
    try {
      const h = raw.includes('://')
        ? new URL(raw).hostname.toLowerCase()
        : raw.split('/')[0].split(':')[0].toLowerCase();
      if (!h) continue;
      if (h === selfHost && candidates.length > 1) continue;
      return h;
    } catch {}
  }
  return selfHost || 'direct-access';
}

function recordWorkerDomainHit(request, url, type = 'embed', media = null) {
  const domain = extractCallerDomain(request, url);
  const now = new Date().toISOString();
  let d = runtimeState.domains.get(domain);
  if (!d) {
    d = { domain, embeds: 0, resolves: 0, proxyHits: 0, firstSeen: now, lastSeen: now, topTitles: new Map() };
    runtimeState.domains.set(domain, d);
  }
  d.lastSeen = now;
  if (type === 'embed') d.embeds += 1;
  else if (type === 'resolve') d.resolves += 1;
  else if (type === 'proxy') d.proxyHits += 1;
  if (media && (media.title || media.tmdbId)) {
    const label = media.title ? `${media.title} (#${media.tmdbId})` : `TMDB #${media.tmdbId}`;
    d.topTitles.set(label, (d.topTitles.get(label) || 0) + 1);
  }
}

function recordWorkerServerAttempt(srvId, ok, latencyMs = 0, errMsg = null) {
  const m = runtimeState.serverMetrics.get(srvId);
  if (!m) return;
  m.lastLatencyMs = Math.round(latencyMs);
  if (ok) {
    m.successCount += 1;
    m.lastError = null;
    m.avgLatencyMs = m.avgLatencyMs ? Math.round(m.avgLatencyMs * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);
    m.status = 'online';
  } else {
    m.failureCount += 1;
    m.lastError = errMsg || 'Upstream returned no stream';
    const total = m.successCount + m.failureCount;
    m.status = m.failureCount >= 3 && m.failureCount / total >= 0.75 ? 'dead' : 'degraded';
  }
}

function getWorkerAdminSnapshot() {
  const domains = Array.from(runtimeState.domains.values()).map((d) => ({
    domain: d.domain,
    embeds: d.embeds,
    resolves: d.resolves,
    proxyHits: d.proxyHits,
    totalRequests: d.embeds + d.resolves + d.proxyHits,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    blocked: runtimeState.blockedDomains.has(d.domain.replace(/^www\./, '')),
    topTitles: Array.from(d.topTitles.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([title, count]) => ({ title, count }))
  }));
  const servers = SERVERS.map((s) => {
    const m = runtimeState.serverMetrics.get(s.id) || {};
    const total = (m.successCount || 0) + (m.failureCount || 0);
    return {
      ...s,
      status: s.enabled === false ? 'disabled' : m.status || 'online',
      successCount: m.successCount || 0,
      failureCount: m.failureCount || 0,
      successRate: total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 100,
      avgLatencyMs: m.avgLatencyMs || 0,
      lastLatencyMs: m.lastLatencyMs || 0,
      lastError: m.lastError || null
    };
  });
  return {
    startedAt: runtimeState.startedAt,
    summary: {
      uniqueDomains: domains.length,
      blockedDomainsCount: runtimeState.blockedDomains.size,
      totalEmbeds: domains.reduce((a, d) => a + d.embeds, 0),
      totalResolves: domains.reduce((a, d) => a + d.resolves, 0),
      totalProxyHits: domains.reduce((a, d) => a + d.proxyHits, 0),
      activeServersCount: servers.filter((s) => s.enabled && s.status !== 'dead').length,
      deadOrDegradedCount: servers.filter((s) => s.status === 'dead' || s.status === 'degraded').length
    },
    domains,
    blockedDomains: Array.from(runtimeState.blockedDomains),
    servers,
    upstreams: { ...runtimeState.upstreams },
    externalProxyPool: [...runtimeState.externalProxyPool],
    customOverrides: Array.from(runtimeState.customOverrides.values())
  };
}

const NATIVE_LANG_LABELS = {
  ar: 'العربية', ara: 'العربية',
  bn: 'বাংলা', ben: 'বাংলা',
  en: 'English', eng: 'English',
  fil: 'Filipino', tl: 'Filipino', tgl: 'Filipino',
  fr: 'Français', fre: 'Français', fra: 'Français',
  de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch',
  hi: 'हिन्दी', hin: 'हिन्दी',
  id: 'Indonesian', ind: 'Indonesian',
  it: 'Italiano', ita: 'Italiano',
  ja: '日本語', jpn: '日本語',
  ko: '한국어', kor: '한국어',
  pt: 'Português', por: 'Português',
  ru: 'Русский', rus: 'Русский',
  es: 'Español', spa: 'Español',
  tr: 'Türkçe', tur: 'Türkçe',
  vi: 'Tiếng Việt', vie: 'Tiếng Việt',
  zh: '中文', chi: '中文', zho: '中文'
};

// In-isolate fast memory cache + Cloudflare Edge Cache API wrapper
const memoryCache = new Map();

async function edgeCacheGet(key) {
  const mem = memoryCache.get(key);
  if (mem && Date.now() < mem.exp) return mem.val;
  if (typeof caches !== 'undefined' && caches.default) {
    try {
      const cacheUrl = `https://edge-cache.internal/${encodeURIComponent(key)}`;
      const match = await caches.default.match(cacheUrl);
      if (match) {
        const val = await match.json();
        memoryCache.set(key, { val, exp: Date.now() + 300000 });
        return val;
      }
    } catch {}
  }
  return null;
}

async function edgeCacheSet(key, val, ttlSec = 1800) {
  if (memoryCache.size > 1000) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  if (typeof caches !== 'undefined' && caches.default) {
    try {
      const cacheUrl = `https://edge-cache.internal/${encodeURIComponent(key)}`;
      const resp = new Response(JSON.stringify(val), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttlSec}`
        }
      });
      await caches.default.put(cacheUrl, resp);
    } catch {}
  }
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
    'Content-Security-Policy': 'frame-ancestors *;',
    ...extra
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * Static assets the /embed player page is allowed to load. Everything else in
 * `public/` (notably no portal/admin UI) stays unserved.
 */
const PLAYER_ASSET_PATHS = new Set([
  '/css/embed.css',
  '/js/embed.js',
  '/vendor/hls.min.js',
  '/vendor/dash.all.min.js'
]);

/**
 * Normalize the configured API Worker base URL. Accepts an absolute http(s)
 * origin (optionally with a path prefix); returns '' to mean "same origin".
 */
function normalizeApiBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Easter egg for humans who open the Worker root URL in a browser: a
 * monochrome LOL Embed interstitial that rickrolls them. API clients (no
 * `text/html` Accept header) never see this and keep receiving the JSON
 * service descriptor.
 */
const RICKROLL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOL Embed</title>
<meta http-equiv="refresh" content="2;url=https://www.youtube.com/watch?v=dQw4w9WgXcQ">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  main{text-align:center;padding:24px}
  h1{font-size:1.35rem;letter-spacing:.14em;text-transform:uppercase;color:#a3a3a3;margin:0 0 14px;font-weight:600}
  p{color:#f5f5f5;font-size:1.05rem;margin:8px 0}
  a{color:#fff;text-decoration:underline;text-underline-offset:3px}
</style>
<script>window.setTimeout(function () { location.replace('https://www.youtube.com/watch?v=dQw4w9WgXcQ'); }, 1500);</script>
</head>
<body>
<main>
  <h1>LOL Embed</h1>
  <p>Loading something very important&hellip;</p>
  <p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Never gonna give you up</a></p>
</main>
</body>
</html>
`;

/**
 * OpenSSL EVP_BytesToKey (MD5) AES-256-CBC Decryptor (matches CryptoJS.AES.decrypt & openssl enc -d -aes-256-cbc -md md5)
 */
function decryptOpenSslAes256Cbc(cipherBase64, passphrase) {
  try {
    const raw = Buffer.from(cipherBase64, 'base64');
    if (raw.length < 16 || raw.subarray(0, 8).toString('utf8') !== 'Salted__') {
      return null;
    }
    const salt = raw.subarray(8, 16);
    const ciphertext = raw.subarray(16);
    const passBuf = Buffer.from(passphrase, 'utf8');

    let derived = Buffer.alloc(0);
    let block = Buffer.alloc(0);
    while (derived.length < 48) {
      const md5 = crypto.createHash('md5');
      md5.update(Buffer.concat([block, passBuf, salt]));
      block = md5.digest();
      derived = Buffer.concat([derived, block]);
    }

    const key = derived.subarray(0, 32);
    const iv = derived.subarray(32, 48);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Convert SubRip (.srt) text to WebVTT (.vtt)
 */
function srtToVtt(rawText) {
  if (!rawText || typeof rawText !== 'string') return 'WEBVTT\n\n';
  const clean = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (clean.startsWith('WEBVTT')) return clean + '\n';
  const vttBody = clean
    .replace(/^\d+\s*\n(?=\d{2}:\d{2}:\d{2})/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/(\d{1,2}:\d{2}),(\d{3})/g, '00:$1.$2');
  return `WEBVTT\n\n${vttBody}\n`;
}

/**
 * Build proxy URL pointing to this Worker's /api/proxy endpoint.
 *
 * `mode`:
 *   'manifest' (default) — only nested playlists/keys are rewritten through the
 *                          proxy, .ts/.m4s segments stream straight from the CDN.
 *   'full'               — every playlist AND segment URI is rewritten through
 *                          the proxy (needed for Origin/Referer-gated hosts).
 *   'direct'             — pass through untouched.
 *
 * `cookie` (optional) is forwarded upstream — required by Origin/Referer-gated
 * origins such as vidstuck.xyz which also pin a session cookie.
 */
function buildWorkerProxyUrl(targetUrl, referer = '', mode = 'manifest', cookie = '') {
  const params = new URLSearchParams({ url: targetUrl, mode });
  if (referer) params.set('referer', referer);
  if (cookie) params.set('cookie', cookie);
  return `/api/proxy?${params.toString()}`;
}

/**
 * 1. Resolve TMDB ID -> Unified Metadata + External IDs (IMDb, TVDB, MAL) + Episodes
 */
async function resolveTmdbMetadata(type, tmdbId, season = 1, episode = 1, env = {}) {
  const normalizedType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
  const cleanId = String(tmdbId).trim();
  const sNum = Math.max(1, parseInt(season || 1, 10));
  const eNum = Math.max(1, parseInt(episode || 1, 10));

  const cacheKey = `cf:tmdb:${normalizedType}:${cleanId}:s${sNum}:e${eNum}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const tmdbKey = env.TMDB_API_KEY || '47a1a7df542d3d483227f758a7317dff';
  const tmdbBase = (
    (env && env.TMDB_BASE_URL) ||
    runtimeState.tmdbBaseUrl ||
    'https://api.themoviedb.org/3'
  ).replace(/\/$/, '');
  let result = null;

  // A single failed TMDB call used to hand back a title-less metadata stub,
  // which silently disables every search-by-title server — the search-by-title
  // tiers then probe nothing and the waterfall slides to the TMDB-id keyed
  // NetMirror tier. Retry once
  // quickly: Cloudflare's shared egress IPs hit TMDB rate limits more often
  // than a dedicated host would.
  let detailsData = null;
  const detailsUrl = `${tmdbBase}/${normalizedType}/${cleanId}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids,alternative_titles&language=en-US`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const detailsRes = await fetch(detailsUrl, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
      });
      if (detailsRes.ok) detailsData = await detailsRes.json();
    } catch {}
    if (detailsData && (detailsData.id || detailsData.title || detailsData.name)) break;
    if (attempt === 0) await new Promise((wait) => setTimeout(wait, 300));
  }

  try {
    if (detailsData && (detailsData.id || detailsData.title || detailsData.name)) {
      const data = detailsData;
      const releaseDate = data.release_date || data.first_air_date || '';
      const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;
      const genres = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
      const isAnimation =
        genres.some((g) => /animation|anime/i.test(g)) ||
        (Array.isArray(data.origin_country) && data.origin_country.includes('JP'));

      let seasons = [];
      let episodes = [];

      if (normalizedType === 'tv') {
        seasons = (data.seasons || [])
          .filter((s) => s.season_number > 0)
          .map((s) => ({
            season_number: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episode_count: s.episode_count || 0
          }));

        const sRes = await fetch(
          `${tmdbBase}/tv/${cleanId}/season/${sNum}?api_key=${encodeURIComponent(tmdbKey)}&language=en-US`,
          { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
        );
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData.episodes)) {
            episodes = sData.episodes.map((ep) => ({
              episode: ep.episode_number,
              season: sNum,
              title: ep.name || `Episode ${ep.episode_number}`,
              runtime: ep.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
              date: ep.air_date || '',
              still: ep.still_path
                ? `https://image.tmdb.org/t/p/w500${ep.still_path}`
                : data.backdrop_path
                  ? `https://image.tmdb.org/t/p/w780${data.backdrop_path}`
                  : null,
              overview: ep.overview || ''
            }));
          }
        }
      }

      const title = data.title || data.name;
      const alternativeTitles = (data.alternative_titles?.titles || [])
        .map((entry) => entry && entry.title)
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .slice(0, 25);
      let malId = null;
      if (isAnimation && title) {
        try {
          const jRes = await fetch(
            `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=3`,
            { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
          );
          if (jRes.ok) {
            const jData = await jRes.json();
            malId = jData?.data?.[0]?.mal_id || null;
          }
        } catch {}
      }

      result = {
        tmdbId: Number(cleanId) || cleanId,
        type: normalizedType,
        title,
        originalTitle: data.original_title || data.original_name || title,
        alternativeTitles,
        releaseYear,
        runtime: data.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
        genres,
        overview: data.overview || '',
        backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
        externalIds: {
          imdb_id: data.imdb_id || data.external_ids?.imdb_id || null,
          tvdb_id: data.external_ids?.tvdb_id || null,
          mal_id: malId,
          anilist_id: null
        },
        seasons,
        episodes,
        season: sNum,
        episode: eNum,
        activeEpisode:
          normalizedType === 'tv'
            ? episodes.find((e) => Number(e.episode) === eNum) || episodes[0] || null
            : null
      };
    }
  } catch {}

  if (!result) {
    // Secondary live fallback (mirrors the Node backend): the VidStuck backend
    // proxies TMDB details, so a TMDB outage/rate-limit on the Worker's shared
    // egress IP does not strip the title from metadata. Without a title every
    // search-by-title cascade instantly reports "nothing to probe"
    // while TMDB-id keyed tiers keep answering — exactly the "Server 3 falls
    // back to Server 1" symptom.
    const vidstuckBase = (
      (env && env.VIDSTUCK_BASE_URL) ||
      runtimeState.upstreams.vidstuckBase ||
      ''
    ).replace(/\/$/, '');
    if (vidstuckBase) {
      try {
        const vsRes = await fetch(
          `${vidstuckBase}/backend/tmdb/details/${normalizedType}/${cleanId}?language=en-US`,
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': USER_AGENT,
              Referer: `${vidstuckBase}/`
            }
          }
        );
        if (vsRes.ok) {
          const vsData = await vsRes.json();
          if (vsData && (vsData.id || vsData.title || vsData.name)) {
            const vsReleaseDate = vsData.release_date || vsData.first_air_date || '';
            result = {
              tmdbId: Number(cleanId) || cleanId,
              type: normalizedType,
              title: vsData.title || vsData.name || null,
              originalTitle: vsData.original_title || vsData.original_name || vsData.title || vsData.name || null,
              alternativeTitles: [],
              releaseYear: vsReleaseDate ? parseInt(vsReleaseDate.slice(0, 4), 10) : null,
              runtime: vsData.runtime || (Array.isArray(vsData.episode_run_time) && vsData.episode_run_time[0]) || null,
              genres: Array.isArray(vsData.genres) ? vsData.genres.map((g) => g.name) : [],
              overview: vsData.overview || '',
              backdrop: vsData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${vsData.backdrop_path}` : null,
              poster: vsData.poster_path ? `https://image.tmdb.org/t/p/w500${vsData.poster_path}` : null,
              externalIds: {
                imdb_id: vsData.imdb_id || vsData.external_ids?.imdb_id || null,
                tvdb_id: vsData.external_ids?.tvdb_id || null,
                mal_id: null,
                anilist_id: null
              },
              seasons: Array.isArray(vsData.seasons)
                ? vsData.seasons
                    .filter((s) => s.season_number > 0)
                    .map((s) => ({
                      season_number: s.season_number,
                      name: s.name || `Season ${s.season_number}`,
                      episode_count: s.episode_count || 0
                    }))
                : [],
              episodes: [],
              season: sNum,
              episode: eNum,
              activeEpisode: null,
              tmdbFallback: 'vidstuck'
            };
          }
        }
      } catch {}
    }
  }

  if (!result) {
    return {
      tmdbId: Number(cleanId) || cleanId,
      type: normalizedType,
      title: null,
      releaseYear: null,
      genres: [],
      externalIds: { imdb_id: null, tvdb_id: null, mal_id: null },
      seasons: [],
      episodes: [],
      season: sNum,
      episode: eNum,
      unresolvedTmdb: true
    };
  }

  await edgeCacheSet(cacheKey, result, 3600);
  return result;
}

/**
 * 2. Resolve Skip Intro / Recap / Next Episode Segments (IntroDB + AniSkip)
 */
async function resolveSkipSegments(metadata) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata;
  const cacheKey = `cf:seg:${type}:${tmdbId}:s${season}:e${episode}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const segments = [];

  if (externalIds.imdb_id && type === 'tv') {
    try {
      const res = await fetch(
        `https://api.introdb.app/intro?imdb_id=${encodeURIComponent(externalIds.imdb_id)}&season=${season}&episode=${episode}`,
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
      );
      if (res.ok) {
        const data = await res.json();
        const start = data.start_sec ?? data.start;
        const end = data.end_sec ?? data.end;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          segments.push({
            type: 'intro',
            label: 'Skip Intro',
            start: Math.round(start * 10) / 10,
            end: Math.round(end * 10) / 10,
            source: 'introdb'
          });
        }
      }
    } catch {}
  }

  if (externalIds.mal_id) {
    try {
      const res = await fetch(
        `https://api.aniskip.com/v2/skip-times/${encodeURIComponent(externalIds.mal_id)}/${episode}?types[]=op&types[]=ed&types[]=recap&episodeLength=0`,
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
      );
      if (res.ok) {
        const data = await res.json();
        if (data?.found && Array.isArray(data.results)) {
          for (const item of data.results) {
            const st = item.interval?.startTime;
            const et = item.interval?.endTime;
            if (typeof st === 'number' && typeof et === 'number' && et > st) {
              const isOutro = item.skipType === 'ed';
              segments.push({
                type: isOutro ? 'outro' : 'intro',
                label: isOutro ? 'Next Episode' : 'Skip Intro',
                start: Math.round(st * 10) / 10,
                end: Math.round(et * 10) / 10,
                source: 'aniskip'
              });
            }
          }
        }
      }
    } catch {}
  }

  if (segments.length > 0) {
    await edgeCacheSet(cacheKey, segments, 3600);
  }
  return segments;
}

/**
 * 3. Resolve Real Subtitles (OpenSubtitles REST API + OpenSubtitles Stremio v3)
 */
async function resolveSubtitles(metadata) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata;
  const cacheKey = `cf:subs:${type}:${tmdbId}:s${season}:e${episode}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const tracks = [];
  const seenLangs = new Set();

  if (externalIds.imdb_id) {
    const imdbDigits = String(externalIds.imdb_id).replace(/^tt/i, '');
    const osPath =
      type === 'tv'
        ? `/search/episode-${episode}/imdbid-${imdbDigits}/season-${season}`
        : `/search/imdbid-${imdbDigits}`;

    try {
      const res = await fetch(`https://rest.opensubtitles.org${osPath}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-User-Agent': 'TemporaryUserAgent'
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const sorted = [...data].sort(
            (a, b) => Number(b.SubDownloadsCnt || 0) - Number(a.SubDownloadsCnt || 0)
          );
          for (const item of sorted) {
            if (!item.SubDownloadLink) continue;
            const iso = (item.ISO639 || item.SubLanguageID || 'en').toLowerCase();
            if (seenLangs.has(iso)) continue;
            seenLangs.add(iso);
            const label =
              NATIVE_LANG_LABELS[iso] ||
              NATIVE_LANG_LABELS[item.SubLanguageID] ||
              item.LanguageName ||
              iso.toUpperCase();

            tracks.push({
              id: `os-${item.IDSubtitleFile || iso}`,
              lang: iso.slice(0, 2),
              label,
              format: 'vtt',
              url: `/api/subtitles/proxy?url=${encodeURIComponent(item.SubDownloadLink)}`,
              default: iso === 'en',
              source: 'opensubtitles'
            });
            if (tracks.length >= 24) break;
          }
        }
      }
    } catch {}
  }

  if (tracks.length > 0) {
    await edgeCacheSet(cacheKey, tracks, 3600);
  }
  return tracks;
}

/**
 * 4. Upstream Stream Extractors (Andromeda/CastleTV+NetMirror, Centaurus/HiCine)
 */

/**
 * Common Language Name -> ISO-639-1 code mapping for multi-audio tracks
 */
const LANGUAGE_NAME_TO_CODE = {
  hindi: 'hi', hin: 'hi',
  tamil: 'ta', tam: 'ta',
  telugu: 'te', tel: 'te',
  malayalam: 'ml', mal: 'ml',
  kannada: 'kn', kan: 'kn',
  bengali: 'bn', ben: 'bn', beng: 'bn',
  marathi: 'mr', mar: 'mr',
  punjabi: 'pa', pan: 'pa',
  urdu: 'ur', urd: 'ur',
  english: 'en', eng: 'en',
  korean: 'ko', kor: 'ko',
  japanese: 'ja', jpn: 'ja',
  chinese: 'zh', zho: 'zh', chi: 'zh', mandarin: 'zh', cantonese: 'zh',
  spanish: 'es', spa: 'es',
  french: 'fr', fra: 'fr', fre: 'fr',
  german: 'de', deu: 'de', ger: 'de',
  italian: 'it', ita: 'it',
  portuguese: 'pt', por: 'pt',
  russian: 'ru', rus: 'ru',
  thai: 'th', tha: 'th',
  indonesian: 'id', ind: 'id',
  turkish: 'tr', tur: 'tr',
  arabic: 'ar', ara: 'ar',
  vietnamese: 'vi', vie: 'vi'
};

function mapLanguageNameToCode(name) {
  if (!name) return 'und';
  const clean = String(name).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (LANGUAGE_NAME_TO_CODE[clean]) return LANGUAGE_NAME_TO_CODE[clean];
  return clean.slice(0, 2) || 'und';
}

function applyPreferredAudio(resolved, preferredAudio) {
  if (!resolved || !preferredAudio || !Array.isArray(resolved.audioTracks)) return resolved;
  const wanted = String(preferredAudio).trim().toLowerCase();
  const wantedLanguage = mapLanguageNameToCode(wanted);
  const matchTrack = resolved.audioTracks.find((track) =>
    String(track.id || '').toLowerCase() === wanted ||
    (wantedLanguage !== 'und' && mapLanguageNameToCode(track.lang) === wantedLanguage)
  );
  if (!matchTrack) return resolved;

  const audioTracks = resolved.audioTracks.map((track) => ({
    ...track,
    default: track.id === matchTrack.id
  }));
  return {
    ...resolved,
    audioTracks,
    streamUrl: matchTrack.streamUrl || resolved.streamUrl,
    rawUrl: matchTrack.rawUrl || resolved.rawUrl,
    activeAudioTrack: audioTracks.find((track) => track.id === matchTrack.id) || null
  };
}

// In-memory cache for CastleTV AES security key on Worker
let workerCachedCastleKey = null;
let workerCachedCastleKeyExp = 0;

function buildCastleKey(securityKeyB64) {
  let km = Buffer.from(String(securityKeyB64 || ''), 'base64');
  km = Buffer.concat([km, Buffer.from('T!BgJB', 'utf8')]);
  if (km.length > 16) km = km.subarray(0, 16);
  else if (km.length < 16) km = Buffer.concat([km, Buffer.alloc(16 - km.length, 0)]);
  return km;
}

function decryptCastleAes(dataB64, key) {
  const raw = Buffer.from(String(dataB64 || '').trim(), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  decipher.setAutoPadding(true);
  try {
    return Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
  } catch {
    const d2 = crypto.createDecipheriv('aes-128-cbc', key, key);
    d2.setAutoPadding(false);
    return Buffer.concat([d2.update(raw), d2.final()]).toString('utf8');
  }
}

async function getCastleSecurityKeyWorker(castletvBase, signal) {
  if (workerCachedCastleKey && Date.now() < workerCachedCastleKeyExp) {
    return workerCachedCastleKey;
  }
  const url = `${castletvBase}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal
  });
  if (!res.ok) throw new Error(`Castle security key request failed HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 200 || !json.data) throw new Error('Castle security key empty');

  const km = buildCastleKey(json.data);
  workerCachedCastleKey = km;
  workerCachedCastleKeyExp = Date.now() + 15 * 60 * 1000;
  return km;
}

/**
 * Sub-provider 1 for Andromeda: CastleTV API
 *
 * Identity: CastleTV search is plain-name only and ranks by popularity, so a
 * name search for "Fight Club" returns the 2023 Indian film (which carries a
 * Hindi dub) before the 1999 film. Every row is validated against the TMDB
 * identity (title + original/alternative titles + year + movie/series type)
 * before use; an unverifiable result is a miss, never wrong content.
 */
const CASTLETV_RESOLVE_DEADLINE_MS = 9000;
const CASTLETV_TRACK_CONCURRENCY = 6;

function buildCastleSearchKeywordsWorker(metadata) {
  const seen = new Set();
  const keywords = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    keywords.push(text);
  };
  const title = metadata.title || '';
  const year = metadata.releaseYear || metadata.year || '';
  push(year ? `${title} ${year}` : title);
  push(title);
  push(metadata.originalTitle);
  const alts = Array.isArray(metadata.alternativeTitles)
    ? metadata.alternativeTitles
    : Array.isArray(metadata.altTitles)
      ? metadata.altTitles
      : [];
  alts.slice(0, 2).forEach((alt) => push(typeof alt === 'string' ? alt : alt && (alt.title || alt.name)));
  return keywords.filter(Boolean).slice(0, 4);
}

function castleRowToCandidateWorker(row) {
  return {
    id: String(row.id || row.redirectId || row.redirectIdStr || ''),
    title: row.title || row.name || '',
    year: row.publishTime || row.releaseDate || row.year || null,
    movieType: row.movieType,
    movieTypeName: row.movieTypeName,
    // Season/episode metadata lets the identity gate tell an anime film from
    // an anime series when the provider tags both as "anime".
    seasonDescription: row.seasonDescription || null,
    lastEpisodeCount: row.lastEpisodeCount != null ? row.lastEpisodeCount : null,
    isSeries: row.seasonDescription != null || Number(row.lastEpisodeCount) > 0 || null,
    languages: Array.isArray(row.languages) ? row.languages : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    rating: row.rating,
    popularity: row.score
  };
}

async function castletvSearchRowsWorker(castletvBase, keyword, key, signal) {
  const params = new URLSearchParams({
    channel: 'IndiaA',
    clientType: '1',
    keyword,
    lang: 'en',
    mode: '1',
    packageName: 'com.external.castle',
    page: '1',
    size: '30'
  });
  const res = await fetch(
    `${castletvBase}/film-api/v1.1.0/movie/searchByKeyword?${params.toString()}`,
    {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${castletvBase}/` },
      signal
    }
  );
  if (!res.ok) return [];
  try {
    const json = JSON.parse(decryptCastleAes(await res.text(), key));
    return (json?.data?.rows || []).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveCastletvUpstream(metadata, preferredAudio = '', env = null) {
  const castletvBase = (
    (env && env.CASTLETV_BASE_URL) ||
    runtimeState.upstreams.castletvBase ||
    'https://api.hlowb.com'
  ).replace(/\/$/, '');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CASTLETV_RESOLVE_DEADLINE_MS);

  try {
    if (!metadata || !metadata.title) return null;
    const key = await getCastleSecurityKeyWorker(castletvBase, controller.signal);

    // 1. Union the results of several identity keys before validating them.
    const rowsById = new Map();
    for (const keyword of buildCastleSearchKeywordsWorker(metadata)) {
      const rows = await castletvSearchRowsWorker(castletvBase, keyword, key, controller.signal);
      rows.forEach((row) => {
        const id = String(row.id || row.redirectId || row.redirectIdStr || '');
        if (id && !rowsById.has(id)) rowsById.set(id, row);
      });
      if (!rowsById.size) continue;
      const early = identity.pickIdentityMatch(
        Array.from(rowsById.values()).map(castleRowToCandidateWorker),
        metadata,
        { preferredAudio }
      );
      if (early.winner) break;
    }

    const candidates = Array.from(rowsById.values()).map(castleRowToCandidateWorker);
    if (!candidates.length) return null;

    // 2. TMDB-anchored identity gate. No first-row fallback.
    const picked = identity.pickIdentityMatch(candidates, metadata, { preferredAudio });
    if (!picked.winner) return null;

    const matched = picked.winner;
    const movieId = matched.id;
    if (!movieId) return null;

    const detRes = await fetch(
      `${castletvBase}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en&movieId=${movieId}&packageName=com.external.castle`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${castletvBase}/` },
        signal: controller.signal
      }
    );
    if (!detRes.ok) return null;
    let detJson = JSON.parse(decryptCastleAes(await detRes.text(), key));

    const isTv = metadata.type === 'tv';
    let activeId = movieId;
    if (isTv) {
      const seasonNumber = Number(metadata.season || 1);
      const seasonEntry = (detJson?.data?.seasons || []).find((s) => Number(s.number) === seasonNumber);
      if (seasonEntry && seasonEntry.movieId && String(seasonEntry.movieId) !== String(movieId)) {
        const seasonRes = await fetch(
          `${castletvBase}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en&movieId=${seasonEntry.movieId}&packageName=com.external.castle`,
          {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${castletvBase}/` },
            signal: controller.signal
          }
        );
        if (seasonRes.ok) {
          const seasonJson = JSON.parse(decryptCastleAes(await seasonRes.text(), key));
          if (seasonJson?.data?.episodes?.length) {
            detJson = seasonJson;
            activeId = String(seasonEntry.movieId);
          }
        }
      }
    }

    const episodes = detJson?.data?.episodes || [];
    const wantedEpisode = Number(metadata.episode || 1);
    const targetEpisode = isTv
      ? episodes.find((e) => Number(e.number) === wantedEpisode) || episodes[0]
      : episodes[0];
    if (!targetEpisode) return null;
    const episodeId = targetEpisode.id;

    const rawTracks =
      targetEpisode.tracks && targetEpisode.tracks.length > 0
        ? targetEpisode.tracks
        : [{ languageId: null, languageName: 'Original', videos: targetEpisode.videos || [] }];
    const withIndividualVideo = rawTracks.filter((t) => t.existIndividualVideo === true);
    const tracks = withIndividualVideo.length > 0 ? withIndividualVideo : rawTracks;

    const referer = `${castletvBase}/`;
    const APK_SIGN_KEY = 'ED0955EB04E67A1D9F3305B95454FED485261475';

    // CastleTV answers one quality per `resolution` rung; the first rung that
    // produced a URL used to end the loop, which collapsed the player's quality
    // menu to "Auto" whenever the response carried no `data.videos` array.
    // Merge the rungs into a real ladder (breaks as soon as two heights exist).
    const CASTLE_HEIGHTS_BY_RESOLUTION = { 1: 480, 2: 720, 3: 1080, 4: 2160 };
    const castleVideoHeight = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) return 0;
      return num <= 4 ? CASTLE_HEIGHTS_BY_RESOLUTION[num] || 0 : num;
    };
    const containerFormatForUrl = (url) => {
      const path = String(url || '').split('#')[0].split('?')[0].toLowerCase();
      if (path.endsWith('.m3u8')) return 'hls';
      if (path.endsWith('.mp4')) return 'mp4';
      if (path.endsWith('.mkv')) return 'mkv';
      if (path.endsWith('.mpd')) return 'dash';
      return 'hls';
    };

    const fetchTrackStream = async (track) => {
      const ladder = new Map();
      let base = null;
      for (const resolution of [3, 2, 1]) {
        try {
          const body = {
            mode: '1',
            appMarket: 'GuanWang',
            clientType: '1',
            woolUser: 'false',
            apkSignKey: APK_SIGN_KEY,
            androidVersion: '13',
            movieId: String(activeId),
            episodeId: String(episodeId),
            isNewUser: 'true',
            resolution: String(resolution),
            packageName: 'com.external.castle'
          };
          if (track.languageId != null) body.languageId = String(track.languageId);

          const vRes = await fetch(
            `${castletvBase}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en`,
            {
              method: 'POST',
              headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal
            }
          );
          if (!vRes.ok) continue;
          const vJson = JSON.parse(decryptCastleAes(await vRes.text(), key));
          const rows = (vJson?.data?.videos || [])
            .filter((v) => v && v.url)
            .map((v) => ({
              url: v.url,
              // `resolution` may be a rung number (1-4) or an explicit pixel
              // height depending on the upstream build; accept both.
              height: castleVideoHeight(v.resolution != null ? v.resolution : v.height)
            }))
            .filter((v) => v.height > 0);
          const videoUrl = vJson?.data?.videoUrl || rows[0]?.url || '';
          if (!videoUrl && rows.length === 0) continue;

          if (!base) {
            base = {
              languageId: track.languageId,
              languageName: track.languageName || track.abbreviate || 'Original',
              videoUrl: videoUrl || rows[0].url
            };
          }
          rows.forEach((row) => {
            if (!ladder.has(row.height)) ladder.set(row.height, row.url);
          });
          const requestedHeight = CASTLE_HEIGHTS_BY_RESOLUTION[resolution] || 0;
          if (videoUrl && requestedHeight && !ladder.has(requestedHeight)) {
            ladder.set(requestedHeight, videoUrl);
          }
          if (ladder.size >= 2) break;
        } catch {
          // next resolution rung
        }
      }
      if (!base) return null;
      base.videos = Array.from(ladder, ([height, url]) => ({ height, url }))
        .sort((a, b) => b.height - a.height);
      return base;
    };

    const streamByTrack = new Array(tracks.length).fill(null);
    for (let start = 0; start < tracks.length; start += CASTLETV_TRACK_CONCURRENCY) {
      const slice = tracks.slice(start, start + CASTLETV_TRACK_CONCURRENCY);
      const settled = await Promise.allSettled(slice.map((track) => fetchTrackStream(track)));
      settled.forEach((entry, index) => {
        if (entry.status === 'fulfilled' && entry.value) streamByTrack[start + index] = entry.value;
      });
      if (streamByTrack.some(Boolean) && controller.signal.aborted) break;
    }

    const resolvedTracks = streamByTrack.filter(Boolean);
    if (!resolvedTracks.length) {
      const shared = await fetchTrackStream({ languageId: null, languageName: 'Original' });
      if (!shared) return null;
      resolvedTracks.push(shared);
    }

    const wantedCode = preferredAudio ? mapLanguageNameToCode(String(preferredAudio).trim().toLowerCase()) : '';

    const audioTracks = resolvedTracks.map((track, index) => {
      const langCode = mapLanguageNameToCode(track.languageName);
      return {
        id: `castle-${track.languageId || langCode || index}`,
        lang: langCode,
        label: track.languageName || 'Original Audio',
        type: 'dub',
        streamUrl: buildWorkerProxyUrl(track.videoUrl, referer, 'full'),
        rawUrl: track.videoUrl,
        default: false
      };
    });

    const hindiTrack = audioTracks.find((track) => track.lang === 'hi');
    const preferredTrack = wantedCode ? audioTracks.find((track) => track.lang === wantedCode) : null;
    const defaultTrack = preferredTrack || hindiTrack || audioTracks[0];
    audioTracks.forEach((track) => {
      track.default = track === defaultTrack;
    });

    const activeTrack = defaultTrack;
    // Prefer the active track's ladder, then any track that actually carries
    // one. Falling straight to `resolvedTracks[0]` produced an "Auto"-only menu
    // whenever the first resolved language had no `videos` array.
    const qualitySource =
      resolvedTracks.find((t) => buildWorkerProxyUrl(t.videoUrl, referer, 'full') === activeTrack.streamUrl) ||
      resolvedTracks.find((t) => Array.isArray(t.videos) && t.videos.length > 0) ||
      resolvedTracks[0];
    const seenHeights = new Set();
    const qualities = [
      { label: 'Auto', height: 0, url: activeTrack.streamUrl },
      ...(qualitySource.videos || [])
        .slice()
        .sort((a, b) => (b.height || 0) - (a.height || 0))
        .filter((v) => {
          if (!v.height || seenHeights.has(v.height)) return false;
          seenHeights.add(v.height);
          return true;
        })
        .map((v) => ({ label: `${v.height}p`, height: v.height, url: buildWorkerProxyUrl(v.url, referer, 'full') }))
    ];

    return {
      server: 'andromeda',
      sourceName: 'CastleTV',
      // Honest container: MKV/MP4 entries must reach the progressive <video>
      // path (the Worker cannot remux, and hls.js cannot parse those files).
      format: containerFormatForUrl(activeTrack.rawUrl),
      rawUrl: activeTrack.rawUrl,
      streamUrl: activeTrack.streamUrl,
      referer,
      headers: { Referer: referer },
      backupUrls: [buildWorkerProxyUrl(activeTrack.rawUrl, referer, 'manifest')],
      audioTracks,
      qualities,
      identity: {
        provider: 'castletv',
        verified: true,
        matchedTitle: matched.title,
        matchedYear: matched.year ? identity.extractYearFromValue(matched.year) : null,
        upstreamId: String(movieId),
        activeUpstreamId: String(activeId),
        score: picked.winnerMatch ? picked.winnerMatch.score : null,
        reasons: picked.winnerMatch ? picked.winnerMatch.reasons : [],
        candidates: picked.ranked,
        rejectedCandidates: picked.rejected
      }
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sub-provider 3 for Andromeda: NetMirror
 */
let workerCachedNetmirrorApi = '';
let workerCachedNetmirrorExpiry = 0;
let workerCachedNetmirrorReferer = '';

function getWorkerNetmirrorDiscoveryPool(env = null) {
  const envUrls = (env && env.NETMIRROR_DISCOVERY_URLS) ? env.NETMIRROR_DISCOVERY_URLS.split(',') : [];
  const pool = [
    ...envUrls,
    'https://mobiledetect.app',
    'https://mobiledetects.com',
    'https://mobidetect.cc',
    'https://mobidetects.top',
    'https://getimgcdn.com',
    'https://mobidetect.art',
    'https://mobidetect.click',
    'https://mobidetect.ink',
    'https://mobidetect.live',
    'https://mobidetect.pro',
    'https://mobidetect.shop',
    'https://mobidetect.site',
    'https://mobidetect.space',
    'https://mobidetect.store',
    'https://mobidetect.vip',
    'https://mobidetect.wiki',
    'https://mobidetect.xyz',
    'https://mobidetects.art',
    'https://mobidetects.info',
    'https://mobidetects.pro',
    'https://mobidetects.store',
    'https://mobidetects.xyz'
  ]
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return [...new Set(pool)];
}

async function getWorkerNetmirrorApiBase(signal, env = null) {
  if (workerCachedNetmirrorApi && Date.now() < workerCachedNetmirrorExpiry) {
    return workerCachedNetmirrorApi;
  }
  const checkDomains = getWorkerNetmirrorDiscoveryPool(env);
  for (const base of checkDomains) {
    try {
      const res = await fetch(`${base}/checknewtv.php`, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*'
        },
        signal
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.token_hash) {
          const decoded = (typeof atob === 'function' ? atob(data.token_hash) : Buffer.from(data.token_hash, 'base64').toString('utf8')).replace(/\/$/, '');
          if (decoded.startsWith('http')) {
            workerCachedNetmirrorApi = decoded;
            workerCachedNetmirrorExpiry = Date.now() + 3600000;
            return decoded;
          }
        }
      }
    } catch {}
  }
  return workerCachedNetmirrorApi || '';
}

async function resolveNetmirrorUpstream(metadata, preferredAudio = '', env = null) {
  const configuredBase = (
    (env && env.NETMIRROR_BASE_URL) ||
    runtimeState.upstreams.netmirrorBase ||
    ''
  ).replace(/\/$/, '');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    const isTv = metadata.type === 'tv';

    // 1. NewTV dynamic OTT mirror API flow (Netflix, Prime, Hotstar)
    try {
      const apiBase = await getWorkerNetmirrorApiBase(controller.signal, env);
      if (apiBase) {
        const ottList = ['nf', 'pv', 'hs'];
        for (const ott of ottList) {
          try {
            const searchUrl = `${apiBase}/newtv/search.php?s=${encodeURIComponent(metadata.title || '')}`;
            const sRes = await fetch(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
                Accept: 'application/json, text/plain, */*',
                'X-Requested-With': 'NetmirrorNewTV v1.0',
                Ott: ott
              },
              signal: controller.signal
            });
            if (!sRes.ok) continue;
            const sJson = await sRes.json().catch(() => null);
            if (sJson?.img_referer) {
              workerCachedNetmirrorReferer = sJson.img_referer.replace(/\/$/, '');
            }
            const results = sJson?.searchResult || [];
            if (!results.length) continue;

            const match = results[0];
            let targetId = match.id;

            if (isTv) {
              const postUrl = `${apiBase}/newtv/post.php?id=${match.id}`;
              const postRes = await fetch(postUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
                  Accept: 'application/json, text/plain, */*',
                  'X-Requested-With': 'NetmirrorNewTV v1.0',
                  Ott: ott
                },
                signal: controller.signal
              });
              if (postRes.ok) {
                const postJson = await postRes.json().catch(() => null);
                if (postJson?.img_referer) {
                  workerCachedNetmirrorReferer = postJson.img_referer.replace(/\/$/, '');
                }
                const eps = (postJson?.episodes || []).filter(Boolean);
                const wantedS = metadata.season || 1;
                const wantedE = metadata.episode || 1;
                const found = eps.find((e) => {
                  const epNum = e.ep ? parseInt(e.ep) : e.epNum ? parseInt(e.epNum.replace(/[^0-9]/g, '')) : null;
                  const sNum = e.sNum ? parseInt(e.sNum.replace(/[^0-9]/g, '')) : null;
                  return (sNum ? sNum === wantedS : true) && epNum === wantedE;
                });
                if (found?.id) targetId = found.id;
              }
            }

            const playerUrl = `${apiBase}/newtv/player.php?id=${targetId}`;
            const pRes = await fetch(playerUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
                Accept: 'application/json, text/plain, */*',
                'X-Requested-With': 'NetmirrorNewTV v1.0',
                Ott: ott
              },
              signal: controller.signal
            });
            if (!pRes.ok) continue;
            const pJson = await pRes.json().catch(() => null);
            if (pJson && pJson.video_link) {
              const streamUrl = pJson.video_link;
              const dynamicReferer = pJson.referer ? pJson.referer.replace(/\/$/, '') : workerCachedNetmirrorReferer;
              workerCachedNetmirrorReferer = dynamicReferer;
              const referer = `${dynamicReferer}/`;
              const proxiedUrl = buildWorkerProxyUrl(streamUrl, referer, 'full');
              return {
                server: 'andromeda',
                sourceName: `NetMirror (${ott.toUpperCase()})`,
                format: 'hls',
                rawUrl: streamUrl,
                streamUrl: proxiedUrl,
                referer,
                headers: { Referer: referer },
                backupUrls: [buildWorkerProxyUrl(streamUrl, referer, 'manifest')],
                audioTracks: [
                  {
                    id: 'nm-default',
                    lang: 'en',
                    label: 'Original Audio (Multi-Track HLS)',
                    type: 'dub',
                    streamUrl: proxiedUrl,
                    rawUrl: streamUrl,
                    default: true
                  }
                ],
                qualities: [{ label: 'Auto', height: 0, url: proxiedUrl }]
              };
            }
          } catch {}
        }
      }
    } catch {}

    // 2. Direct embed-tmdb endpoint (TMDB-id keyed). The NewTV API base is
    // regressed upstream, so rotate through the web mirror pool until one
    // answers. `?type=tv&se=&ep=` (not s/e) is what the API honours.
    const webBases = [];
    const pushWebBase = (value) => {
      const clean = String(value || '').replace(/\/$/, '');
      if (clean.startsWith('http') && !webBases.includes(clean)) webBases.push(clean);
    };
    pushWebBase(configuredBase);
    pushWebBase(workerCachedNetmirrorReferer);
    const mirrorEnv = env && env.NETMIRROR_WEB_MIRRORS ? String(env.NETMIRROR_WEB_MIRRORS).split(',') : [];
    [...mirrorEnv, 'https://net27.cc', 'https://net52.cc', 'https://net77.cc', 'https://netmiror.com'].forEach(pushWebBase);

    for (const effectiveWebBase of webBases.slice(0, 5)) {
      try {
      const netflixUrl = isTv
        ? `${effectiveWebBase}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}?type=tv&se=${metadata.season || 1}&ep=${metadata.episode || 1}`
        : `${effectiveWebBase}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}`;

      const res = await fetch(netflixUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `${effectiveWebBase}/`,
          'User-Agent': USER_AGENT
        },
        redirect: 'follow',
        signal: controller.signal
      });

      if (!res.ok) continue;
      if (res.url) {
        try {
          const finalOrigin = new URL(res.url).origin;
          if (finalOrigin && finalOrigin.startsWith('http')) {
            workerCachedNetmirrorReferer = finalOrigin;
          }
        } catch {}
      }
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        const streamUrl = data.streams?.[0]?.url || data.mp4;
        // NetMirror's primary CDN can rate-limit (HTTP 429); it also hands out
        // an HLS fallback and direct links, which are kept as backups.
        const alternateUrls = [
          typeof data.fallbackHls === 'string' ? data.fallbackHls : data.fallbackHls?.url,
          typeof data.direct === 'string' ? data.direct : data.direct?.url,
          data.cdn
        ].filter((value) => typeof value === 'string' && /^https?:/i.test(value));
        if (streamUrl) {
          const referer = `${workerCachedNetmirrorReferer}/`;
          const proxiedUrl = buildWorkerProxyUrl(streamUrl, referer, 'full');
          const qualities = (data.streams || [])
            .filter((s) => s.url)
            .map((s) => ({
              label: s.resolution ? `${s.resolution}p` : 'Auto',
              height: Number(s.resolution || 1080),
              url: buildWorkerProxyUrl(s.url, referer, 'full')
            }));
          if (!qualities.length) {
            qualities.push({ label: 'Auto', height: 0, url: proxiedUrl });
          }

          const audioTracks = [
            {
              id: 'nm-default',
              lang: 'en',
              label: 'Original Audio (Multi-Track HLS)',
              type: 'dub',
              streamUrl: proxiedUrl,
              rawUrl: streamUrl,
              default: true
            }
          ];

          return {
            server: 'andromeda',
            sourceName: 'NetMirror',
            format: 'hls',
            rawUrl: streamUrl,
            streamUrl: proxiedUrl,
            referer,
            headers: { Referer: referer },
            backupUrls: [
              buildWorkerProxyUrl(streamUrl, referer, 'manifest'),
              ...alternateUrls.map((alt) => buildWorkerProxyUrl(alt, referer, 'full'))
            ],
            audioTracks,
            qualities
          };
        }
      }
      } catch {
        // dead mirror: try the next one
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Server 1 — Andromeda Multi-Audio Orchestrator (Cloudflare Worker)
 * Cascades: CastleTV -> NetMirror -> failover to Server 2 (Centaurus)
 */
async function resolveAndromedaUpstream(metadata, requestedServer = 'andromeda', preferredAudio = '', env = null) {
  const diag = { stage: 'init', steps: [] };
  const stamp = (stage, message, extra) => {
    diag.stage = stage;
    diag.steps.push({ stage, message, ...(extra || {}) });
    diag.message = message;
  };

  // 1. Priority 1: CastleTV
  stamp('castletv_attempt', 'Querying CastleTV multi-audio upstream...');
  try {
    const castleRes = await resolveCastletvUpstream(metadata, preferredAudio, env);
    if (castleRes && castleRes.streamUrl) {
      stamp('castletv_success', `CastleTV resolved ${castleRes.audioTracks.length} audio track(s).`);
      return { ok: true, ...castleRes, diag };
    }
    stamp('castletv_miss', 'CastleTV returned no playable streams for this title.');
  } catch (err) {
    stamp('castletv_error', `CastleTV failed: ${err.message}`);
  }

  // 2. Priority 2: NetMirror
  stamp('netmirror_attempt', 'Querying NetMirror OTT upstream...');
  try {
    const nmRes = await resolveNetmirrorUpstream(metadata, preferredAudio, env);
    if (nmRes && nmRes.streamUrl) {
      stamp('netmirror_success', 'NetMirror resolved official OTT stream.');
      return { ok: true, ...nmRes, diag };
    }
    stamp('netmirror_miss', 'NetMirror returned no playable streams for this title.');
  } catch (err) {
    stamp('netmirror_error', `NetMirror failed: ${err.message}`);
  }

  // All sub-providers failed: signal failure so waterfall advances to Server 2 (Centaurus)
  stamp('andromeda_exhausted', 'All Andromeda sub-providers (CastleTV, NetMirror) failed to resolve a stream.');
  return {
    ok: false,
    reason: 'andromeda_all_sources_exhausted',
    diag
  };
}

function unwrapRedirectVideoUrl(loc) {
  if (!loc || typeof loc !== 'string') return '';
  const inner = loc.match(/[?&]link=(https?:\/\/[^\s&"']+)/i);
  if (inner && inner[1] && !/gamerxyt\.com/i.test(inner[1])) {
    try {
      return decodeURIComponent(inner[1]);
    } catch {
      return inner[1];
    }
  }
  return loc;
}

/**
 * HubCloud generator unroller (Centaurus / HiCine).
 *
 * Root Cause E: HiCine's `ten` tokens terminate on a HubCloud *link generator*
 * landing page instead of a media file:
 *
 *   /go → https://gpdl2.hubcloud.ist/?id=…::token   (3-4s countdown HTML page)
 *       → https://gamerxyt.com/dl.php?link=<video-downloads.googleusercontent.com/…>
 *       → direct MKV/MP4 on a real CDN
 *
 * The landing page only reveals its "Download Here" target via client-side JS,
 * which `<video src>` / `fetch()` cannot execute, so every quality and backup
 * URL answered `text/html`, the player walked the whole ladder, and the embed
 * toasted "All upstream servers failed to play this stream."
 *
 * The unroll is pure HTTP — ground truth: MNTGXO/hubcloud-bypasser performs no
 * countdown wait at all, because the generator either 302-redirects to
 * `dl.php?link=<direct>` (final URL rides in the query string) or embeds the
 * final CDN link in the landing HTML (R2 / cloudflarestorage / cloudfront /
 * workers.dev / pixeldrain / video-downloads.googleusercontent.com / direct
 * media files). Nested generators (`hubcloud.<tld>/drive/<id>` → `<a id="download">`
 * → another generator) are followed up to HUBCLOUD_UNROLL_MAX_DEPTH hops, and
 * results are cached for 10 minutes because HubCloud tokens are short-lived.
 */
const HUBCLOUD_UNROLL_TTL_MS = 600000; // 10 minutes
const HUBCLOUD_UNROLL_MAX_DEPTH = 4;
const HUBCLOUD_UNROLL_BUDGET_MS = 6000; // hard cap per resolve-step
const HUBCLOUD_UNROLL_BODY_CAP = 600 * 1024;
const HUBCLOUD_UNROLL_ALT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const hubcloudUnrollCache = new Map(); // generatorUrl -> { direct, exp }

function isHubcloudGeneratorUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (
      /\.(mp4|mkv|webm|m4v|m3u8|mpd)$/i.test(url.pathname) &&
      !url.searchParams.has('link') &&
      !url.searchParams.has('id')
    ) {
      return false;
    }
    return (
      /(^|\.)hubcloud\./.test(host) ||
      /(^|\.)hubcdn\./.test(host) ||
      /(^|\.)gamerxyt\.com$/.test(host) ||
      /^gpdl\d*\./.test(host) ||
      // Legacy download hosts now link through HubCloud's browser-only recovery path;
      // keep recognizing it even when the page resolves a relative href on a
      // download host before the endpoint redirects to hubcloud.ist.
      /\/drive\/search-recover\.php$/i.test(url.pathname) ||
      (/\/drive\/[A-Za-z0-9_-]+$/i.test(url.pathname) && /(?:hubcloud|moviesdrive)/i.test(host)) ||
      // third-party hosts reuse the HubCloud wrapper scripts verbatim
      /\/(?:hubcloud|hubcdn)\.php(?:\?|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Extract the target of a `dl.php?link=…`-style wrapper without corrupting
 * already-encoded targets: a value that literally starts with `http(s)://`
 * is returned untouched (its `%xx` sequences belong to the target), only a
 * percent-encoded value is decoded.
 */
function extractQueryHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* malformed encoding — keep looking */
  }
  return '';
}

function extractHttpLinkParam(u) {
  const value = String(u || '').replace(/&amp;/gi, '&');
  for (const name of ['link', 'url']) {
    const match = value.match(new RegExp(`[?&]${name}=([^&#\s]+)`, 'i'));
    if (match) {
      const target = extractQueryHttpUrl(match[1]);
      if (target) return target;
    }
    try {
      const parsed = new URL(value);
      const target = extractQueryHttpUrl(parsed.searchParams.get(name));
      if (target) return target;
    } catch {
      /* malformed URL */
    }
  }
  return '';
}

function decodeBase64UrlParam(value) {
  try {
    let clean = String(value || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!clean) return '';
    clean += '='.repeat((4 - (clean.length % 4)) % 4);
    const decoded = Buffer.from(clean, 'base64').toString('utf8').trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
    try {
      const uriDecoded = decodeURIComponent(decoded);
      if (/^https?:\/\//i.test(uriDecoded)) return uriDecoded;
    } catch {}
  } catch {
    /* invalid base64 */
  }
  return '';
}

/** Extract raw targets embedded in common HubCloud and pages.dev wrappers. */
function extractWrappedMediaTargets(u) {
  const targets = [];
  const add = (value) => {
    const target = extractQueryHttpUrl(value);
    if (target && !targets.includes(target)) targets.push(target);
  };
  const rawUrl = String(u || '').replace(/&amp;/gi, '&');
  for (const name of ['link', 'url']) {
    const match = rawUrl.match(new RegExp(`[?&]${name}=([^&#\s]+)`, 'i'));
    if (match) add(match[1]);
    try {
      const parsed = new URL(rawUrl);
      add(parsed.searchParams.get(name));
    } catch {}
  }
  try {
    const parsed = new URL(rawUrl);
    if (/(^|\.)pages\.dev$/i.test(parsed.hostname)) {
      const encoded = parsed.searchParams.get('u') || '';
      const decoded = decodeBase64UrlParam(encoded.replace(/\s/g, '+'));
      if (decoded && !targets.includes(decoded)) targets.push(decoded);
    }
  } catch {}
  return targets;
}

/** File hosts that answer with an HTML page no `<video>` element can play. */
const HUBCLOUD_UNPLAYABLE_HOST_RE =
  /(^|\.)(mega\.nz|mediafire\.com|dropbox\.com|gofile\.io|drive\.google\.com|docs\.google\.com)$/i;

/**
 * Score a candidate as a *terminal* playable URL. -1 = not playable directly
 * (generator page, HTML file host, or garbage). Higher = preferred source:
 * Google's video CDN first, then Cloudflare R2/CDN, then workers.dev, then
 * any direct media file, then pixeldrain (hotlink-gated, last resort).
 */
function scorePlayableUrl(u) {
  if (!u || typeof u !== 'string') return -1;
  let href;
  let host;
  let pathname;
  try {
    const parsed = new URL(u);
    href = parsed.href;
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return -1;
  }
  if (isHubcloudGeneratorUrl(href)) return -1;
  if (HUBCLOUD_UNPLAYABLE_HOST_RE.test(host)) return -1;

  // CDN hosts only earn their bonus when the URL points at a real object: a
  // media extension or at least one non-root path segment. A bare host plus a
  // query string — `https://d33f51dyacx7bd.cloudfront.net/?aydfd=1015073`,
  // which is what the legacy 4K redirector chains return — is a landing/gate page,
  // not media. It used to score 90 and outrank every real file candidate, so
  // Server 3 reported a JavaScript page as its "verified 4K" stream.
  const hasObjectPath = pathname.replace(/\/+$/, '') !== '';
  const cdnScore = (base) => (hasObjectPath ? base : 25);
  if (/(^|\.)workers\.dev$/i.test(host) && /[?&]vcloud=/i.test(href)) return -1;
  if (/(^|\.)googleusercontent\.com$/i.test(host)) return cdnScore(100);
  if (/(^|\.)r2\.dev$/i.test(host)) return cdnScore(95);
  if (/(^|\.)r2\.cloudflarestorage\.com$/i.test(host) || /(^|\.)cloudflarestorage\.com$/i.test(host)) return cdnScore(92);
  if (/(^|\.)cloudfront\.net$/i.test(host)) return cdnScore(90);
  if (/(^|\.)storage\.googleapis\.com$/i.test(host)) return cdnScore(88);
  if (/(^|\.)pixeldrain\.(?:com|dev)$/i.test(host) && /^\/(?:u|api\/file)\/[A-Za-z0-9_-]+/i.test(pathname)) return 75;
  if (/(^|\.)workers\.dev$/i.test(host)) return cdnScore(60);
  if (!/(^|\.)workers\.dev$/i.test(host) && /\.(?:mp4|mkv|webm|m4v|m3u8|mpd)$/i.test(pathname)) return 80;
  return -1;
}

/** Pixeldrain share pages `/u/ID` → direct download API endpoint. */
function normalizePlayableUrl(u) {
  try {
    const url = new URL(u);
    if (/(^|\.)pixeldrain\.(?:com|dev)$/i.test(url.hostname.toLowerCase())) {
      const share = url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)/i);
      const api = url.pathname.match(/^\/api\/file\/([A-Za-z0-9_-]+)/i);
      if (share) return `${url.origin}/api/file/${share[1]}?download`;
      if (api && !url.searchParams.has('download')) {
        return `${url.origin}${url.pathname}${url.search ? `${url.search}&download` : '?download'}`;
      }
    }
    return url.href;
  } catch {
    return u;
  }
}

function isLocalTestMediaUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.test') ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Media sniffing for the Range preflight.
 *
 * A 200/206 response is NOT proof of media. Legacy redirector chains answer
 * with a JavaScript landing page (no Content-Type, body starting with
 * `(function(){`), which the old "not HTML and not JSON" test accepted — so
 * The old 4K tier returned that page as its "verified 4K" stream and every
 * playback attempt failed. Accept a candidate only when the response carries a
 * real media Content-Type, or when the first bytes match a known container.
 */
const MEDIA_CONTENT_TYPE_RE =
  /^(?:video|audio)\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|matroska|x-matroska|ogg|mp2t|x-flv)/i;
const JS_BODY_RE =
  /^\s*(?:<script|<!--|\(function|!function|function\s*\(|var\s|let\s|const\s|window\.|document\.|eval\()/i;
const MEDIA_MAGIC_HEADERS = [
  [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55], // #EXTM3U (HLS playlist)
  [0x1a, 0x45, 0xdf, 0xa3], // EBML header (Matroska / WebM)
  [0x4f, 0x67, 0x67, 0x53], // OggS
  [0x66, 0x4c, 0x61, 0x43], // fLaC
  [0x49, 0x44, 0x33], // ID3-tagged MP3
  [0x52, 0x49, 0x46, 0x46], // RIFF (WAV / AVI)
  [0x00, 0x00, 0x01, 0xba], // MPEG program stream
  [0x00, 0x00, 0x01, 0xb3] // MPEG video elementary stream
];

function bytesStartWith(bytes, magic, offset = 0) {
  if (!bytes || bytes.length < offset + magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic[index]) return false;
  }
  return true;
}

function looksLikeMediaSample(bytes, text) {
  if (!bytes || bytes.length < 8) return false;
  if (bytesStartWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return true; // `….ftyp` (MP4 / MOV)
  for (const magic of MEDIA_MAGIC_HEADERS) {
    if (bytesStartWith(bytes, magic)) return true;
  }
  // MPEG-TS: the 0x47 sync byte repeats every 188 bytes.
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return true;
  if (!text) return false;
  if (/#extm3u/.test(text)) return true;
  if (/<(?:mpd|manifest)[\s>]/.test(text)) return true;
  return false;
}

/**
 * First chunk of the body as raw bytes (container magic) and lowercased text.
 * Binary container headers never survive a UTF-8 round-trip, so the byte view
 * is what makes MP4/MKV/TS detection reliable.
 */
async function readProbeSample(response, maxBytes = 4096) {
  const reader = response?.body?.getReader?.();
  if (!reader) return { bytes: null, text: '' };
  try {
    const { value } = await reader.read();
    if (!value) return { bytes: null, text: '' };
    const bytes = value.subarray(0, maxBytes);
    return { bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes).toLowerCase() };
  } catch {
    return { bytes: null, text: '' };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

/**
 * Verify that a resolved candidate behaves like media before exposing it to
 * `<video>`. Local mock URLs are deliberately trusted so offline tests stay
 * deterministic; public candidates get a short byte-range GET.
 */
async function probePlayableMediaUrl(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let url;
  try {
    url = new URL(rawUrl).href;
  } catch {
    return false;
  }
  if (isLocalTestMediaUrl(url)) return true;
  const {
    signal,
    deadline,
    timeoutMs = 2500,
    headers = {},
    fetchImpl = fetch
  } = options;
  const remaining = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
  if (remaining < 100 || signal?.aborted) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Range: 'bytes=0-1023',
        ...headers
      },
      redirect: 'follow',
      signal: controller.signal
    });
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (
      response.status >= 400 ||
      ![200, 206].includes(response.status) ||
      /text\/html|application\/(?:xhtml\+xml|json)|javascript/i.test(contentType)
    ) {
      try { await response.body?.cancel?.(); } catch {}
      return false;
    }
    const sample = await readProbeSample(response);
    const prefix = sample.text;
    if (
      /<\s*!doctype\s+html|<\s*html\b|<\s*body\b|download\s*quota\s*exceeded|downloadquotaexceeded|access\s+denied|token\s+expired|file\s+not\s+found/i.test(prefix)
    ) return false;
    if (JS_BODY_RE.test(prefix)) return false;
    // Positive evidence only: a media Content-Type, or a real container magic.
    // Anything else (bare JavaScript landing pages, bot walls without a
    // Content-Type) must never be handed to <video>.
    return MEDIA_CONTENT_TYPE_RE.test(contentType) || looksLikeMediaSample(sample.bytes, prefix);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
    try { await response?.body?.cancel?.(); } catch {}
  }
}

/**
 * Collect every URL a generator page might be hiding: `href`/`src`/`action`
 * attributes, bare URLs in text/JS, and base64 `atob("…")` payloads. JS
 * string escapes (`\/`, `\u002F`, `\x2F`) are normalized first so URLs built
 * by obfuscated inline scripts become visible to the scanner.
 */
function collectGeneratorCandidates(html, pageUrl) {
  const normalized = String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002[Ff]/g, '/')
    .replace(/\\x2[Ff]/g, '/')
    .replace(/&amp;/g, '&');
  const out = new Set();
  const tryAdd = (cand) => {
    if (!cand) return;
    try {
      out.add(new URL(String(cand).trim(), pageUrl).href);
    } catch {
      /* not a URL */
    }
  };
  for (const m of normalized.matchAll(/(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)) {
    tryAdd(m[1]);
  }
  // Redirectors use all of these forms, including computed property access:
  // `var url = ...`, `location.href = ...`, `location['href'] = ...`, and
  // `window.location.replace(...)`. Keep this a parser, never execute page JS.
  for (const m of normalized.matchAll(/(?:\b(?:var|let|const)\s+)?url\s*=\s*["']([^"']+)["']/gi)) {
    tryAdd(m[1]);
  }
  for (const m of normalized.matchAll(/location\s*(?:\.\s*href|\[\s*["']href["']\s*\])\s*=\s*["']([^"']+)["']/gi)) {
    tryAdd(m[1]);
  }
  for (const m of normalized.matchAll(/(?:location|window\.location)\s*\.?(?:replace|assign)\s*\(\s*["']([^"']+)["']\s*\)/gi)) {
    tryAdd(m[1]);
  }
  for (const m of normalized.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    tryAdd(m[0].replace(/[.,;:]+$/, ''));
  }

  const inlineB64 = [...normalized.matchAll(/\batob\(\s*["']([A-Za-z0-9+/_=-]{12,})["']\s*\)/gi)];
  for (const m of inlineB64) {
    let payload = m[1];
    for (let depth = 0; depth < 4 && payload; depth += 1) {
      const decoded = b64DecodeUtf8(payload);
      if (!decoded) break;
      for (const d of decoded.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
        tryAdd(d[0].replace(/[.,;:]+$/, ''));
      }
      for (const d of decoded.matchAll(/(?:[?&](?:url|link)=)([^\s"'<>]+)/gi)) {
        tryAdd(d[1].replace(/[),;]+$/, ''));
      }
      const next = decoded.trim();
      if (/^https?:\/\//i.test(next)) break;
      if (!/^[A-Za-z0-9+/_=-]{12,}$/.test(next)) break;
      payload = next;
    }
  }
  return out;
}

/**
 * Pick the terminal CDN URL out of a generator page, or — when the page only
 * links to another wrapper — the next hop to recurse into. Countdown pages
 * link to themselves; self-references are skipped so the walk always moves.
 */
function pickFromGeneratorHtml(html, pageUrl) {
  const directByUrl = new Map();
  const generatorSet = new Set();
  const considerDirect = (candidate) => {
    const score = scorePlayableUrl(candidate);
    if (score < 0) return;
    const normalized = normalizePlayableUrl(candidate);
    const previous = directByUrl.get(normalized);
    if (!previous || score > previous.score) directByUrl.set(normalized, { url: normalized, score });
  };

  for (const cand of collectGeneratorCandidates(html, pageUrl)) {
    if (cand === pageUrl) continue;
    const wrappedTargets = extractWrappedMediaTargets(cand);
    if (wrappedTargets.length > 0) {
      for (const target of wrappedTargets) {
        if (scorePlayableUrl(target) >= 0) considerDirect(target);
        else if (isHubcloudGeneratorUrl(target) || extractWrappedMediaTargets(target).length) generatorSet.add(target);
      }
      if (isHubcloudGeneratorUrl(cand)) generatorSet.add(cand);
      continue;
    }
    if (isHubcloudGeneratorUrl(cand)) {
      generatorSet.add(cand);
      continue;
    }
    considerDirect(cand);
  }

  const directCandidates = [...directByUrl.values()]
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url);
  const generatorCandidates = [...generatorSet];
  return {
    direct: directCandidates[0] || null,
    directCandidates,
    generator: generatorCandidates[0] || null,
    generatorCandidates
  };
}

/** Discover the browser XHR behind HubCloud's query-locked recovery page. */
function extractHubcloudXhrEndpoints(html, pageUrl) {
  const normalized = String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002[Ff]/g, '/')
    .replace(/\\x2[Ff]/g, '/');
  const endpoints = new Set();
  const add = (candidate) => {
    if (!candidate || /\$\{|\b(?:javascript|data):/i.test(candidate)) return;
    try {
      const resolved = new URL(candidate, pageUrl);
      if (!/^https?:$/i.test(resolved.protocol)) return;
      if (/\/drive\/search-recover\.php$/i.test(resolved.pathname)) return;
      endpoints.add(resolved.href);
    } catch {}
  };
  const patterns = [
    /(?:fetch|axios\.(?:get|post|request)|\$\.(?:get|getJSON|post|ajax))\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\.open\s*\(\s*["'`][^"'`]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi,
    /(?:url|uri|endpoint|apiUrl|requestUrl)\s*:\s*["'`]([^"'`]+)["'`]/gi,
    /["'`](\/[^"'`]*(?:search|recover|ajax|api)[^"'`]*)["'`]/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) add(match[1]);
  }
  return [...endpoints];
}

function addHubcloudSearchContext(endpoint, startUrl) {
  try {
    const target = new URL(endpoint);
    const source = new URL(startUrl);
    for (const name of ['from_ac', 'q', 'query', 'key']) {
      if (!target.searchParams.has(name) && source.searchParams.has(name)) {
        target.searchParams.set(name, source.searchParams.get(name));
      }
    }
    return target.href;
  } catch {
    return endpoint;
  }
}

function extractHubcloudResponseTargets(body, pageUrl) {
  const targets = new Set();
  const add = (value) => {
    if (!value || /\$\{|\b(?:javascript|data):/i.test(value)) return;
    try {
      const resolved = new URL(value, pageUrl).href;
      if (/^https?:\/\//i.test(resolved)) targets.add(resolved);
    } catch {}
  };
  for (const match of String(body || '').matchAll(/(?:["'](?:url|link|href|location)["']\s*:\s*|\b(?:url|link|href|location)\s*=\s*["'])([^"']+)(?:["'])/gi)) {
    add(match[1]);
  }
  for (const match of String(body || '').matchAll(/(?:https?:\/\/|\/)(?:[^\s"'<>]+\/)?(?:drive|api|download)\/[^\s"'<>]+/gi)) {
    add(match[0]);
  }
  return [...targets];
}

async function resolveHubcloudSearchRecoverPage(html, pageUrl, options = {}) {
  const endpoints = extractHubcloudXhrEndpoints(html, pageUrl)
    .map((endpoint) => addHubcloudSearchContext(endpoint, pageUrl));
  for (const endpoint of Array.from(new Set(endpoints)).slice(0, 6)) {
    const response = await fetchWithDeadline(
      endpoint,
      USER_AGENT,
      options.signal,
      options.deadline,
      { headers: { ...options.headers, Referer: pageUrl, Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' } }
    );
    if (!response) continue;
    const finalUrl = response.url || endpoint;
    let body = '';
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (response.ok && (/json|html|text|javascript|xml/i.test(contentType) || !contentType)) {
      body = await readCappedText(response);
    }
    if (!body && extractHttpLinkParam(finalUrl)) body = finalUrl;
    if (!body) continue;
    for (const target of extractHubcloudResponseTargets(body, finalUrl).slice(0, 8)) {
      const normalized = normalizePlayableUrl(target);
      if (scorePlayableUrl(normalized) >= 0) {
        const playable = await pickPlayableGeneratorCandidate({ directCandidates: [normalized] }, options);
        if (playable) return playable;
      }
      if (isHubcloudGeneratorUrl(target) || /\/drive\//i.test(target)) {
        const unrolled = await unrollHubcloudUrl(target, {
          ...options,
          depth: (options.depth || 0) + 1
        });
        if (unrolled) return unrolled;
      }
    }
    const pick = pickFromGeneratorHtml(body, finalUrl);
    const direct = await validateGeneratorPick(pick, options);
    if (direct) return direct;
    for (const candidate of (pick?.generatorCandidates || []).slice(0, 4)) {
      const unrolled = await unrollHubcloudUrl(candidate, {
        ...options,
        depth: (options.depth || 0) + 1
      });
      if (unrolled) return unrolled;
    }
  }
  return null;
}

async function pickPlayableGeneratorCandidate(pick, options = {}) {
  if (!pick) return null;
  const candidates = Array.from(new Set(pick.directCandidates || (pick.direct ? [pick.direct] : [])));
  if (candidates.length === 0) return null;
  const checked = await Promise.all(
    candidates.slice(0, 8).map(async (url) => ({
      url,
      playable: await probePlayableMediaUrl(url, options)
    }))
  );
  const winner = checked.find((candidate) => candidate.playable);
  return winner ? normalizePlayableUrl(winner.url) : null;
}

/**
 * Fetch with a hard deadline: `deadline` (epoch ms) bounds the whole unroll,
 * `outerSignal` (when present) aborts together with the caller's controller.
 */
async function fetchWithDeadline(url, userAgent, outerSignal, deadline, fetchOptions = {}) {
  const remaining = deadline - Date.now();
  if (remaining < 400 || outerSignal?.aborted) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(4000, remaining));
  const onAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener?.('abort', onAbort);
  try {
    return await fetch(url, {
      ...fetchOptions,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(fetchOptions.headers || {})
      },
      redirect: fetchOptions.redirect || 'follow',
      signal: ctrl.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener?.('abort', onAbort);
  }
}

/** Read at most `cap` bytes of a response body (landing pages only). */
async function readCappedText(res, cap = HUBCLOUD_UNROLL_BODY_CAP) {
  try {
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > 2 * 1024 * 1024) return ''; // a binary file, not a landing page
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      const text = await res.text();
      return text.length > cap ? text.slice(0, cap) : text;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let out = '';
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    try {
      await reader.cancel();
    } catch {
      /* already consumed */
    }
    return out.length > cap ? out.slice(0, cap) : out;
  } catch {
    return '';
  }
}

/**
 * Cloudflare managed-challenge interstitial ("Just a moment…"). Datacenter
 * fetchers (Workers, VPS) get this instead of the landing page on some
 * generator zones — it never contains a download link, so scanning it is
 * wasted work and the fetch must be treated as failed (→ UA retry below).
 */
function isCfChallengePage(html) {
  const h = String(html || '').toLowerCase();
  if (!h) return false;
  return (
    h.includes('cf-chl') ||
    h.includes('_cf_chl') ||
    h.includes('challenge-platform') ||
    h.includes('cf-turnstile') ||
    h.includes('verify_turnstile') ||
    h.includes('just a moment') ||
    h.includes('performing security verification') ||
    h.includes('enable javascript and cookies to continue') ||
    h.includes('attention required') ||
    h.includes('checking your browser') ||
    h.includes('cf_mitigation')
  );
}

function isDdosGuardPage(html) {
  const h = String(html || '').toLowerCase();
  if (!h) return false;
  return (
    h.includes('ddos-guard') ||
    h.includes('ddos_guard') ||
    h.includes('ddosguard') ||
    h.includes('checking your browser before accessing') ||
    h.includes('please wait while your request is being verified') ||
    h.includes('jschl-answer') ||
    h.includes('ddos protection')
  );
}

function isAntiBotPage(html) {
  return isCfChallengePage(html) || isDdosGuardPage(html);
}

function fourKBrowserHeaders(referer = '', accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8') {
  return {
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {})
  };
}

/** Follow one `?link=` hop: recurse into wrappers, accept terminal URLs. */
async function resolveLinkInner(inner, opts = {}) {
  if (!inner || (opts.depth || 0) > HUBCLOUD_UNROLL_MAX_DEPTH) return null;
  const wrappedTargets = extractWrappedMediaTargets(inner).filter((target) => target !== inner);
  for (const target of wrappedTargets) {
    const resolved = await resolveLinkInner(target, { ...opts, depth: (opts.depth || 0) + 1 });
    if (resolved) return resolved;
  }
  if (isHubcloudGeneratorUrl(inner)) {
    return unrollHubcloudUrl(inner, { ...opts, depth: (opts.depth || 0) + 1 });
  }
  const playableUrl = normalizePlayableUrl(inner);
  if (scorePlayableUrl(playableUrl) >= 0 && await probePlayableMediaUrl(playableUrl, opts)) {
    return playableUrl;
  }
  return null;
}

async function validateGeneratorPick(pick, options = {}) {
  const direct = await pickPlayableGeneratorCandidate(pick, options);
  if (direct) return direct;
  if ((options.depth || 0) >= HUBCLOUD_UNROLL_MAX_DEPTH) return null;
  const generators = Array.from(new Set(pick?.generatorCandidates || (pick?.generator ? [pick.generator] : [])));
  const attempts = await Promise.all(
    generators.slice(0, 6).map((generator) =>
      unrollHubcloudUrl(generator, { ...options, depth: (options.depth || 0) + 1 })
    )
  );
  return attempts.find(Boolean) || null;
}

/**
 * Resolve a HubCloud generator URL to the direct, playable CDN URL.
 * Returns the original-style direct URL, or `null` when the generator could
 * not be unrolled (caller keeps the previous URL — no behaviour change).
 *
 * `options`: { signal?, depth?, deadline? } — deadline is an absolute epoch
 * ms budget shared across every hop of one resolve step.
 */
async function unrollHubcloudUrl(startUrl, options = {}) {
  if (!startUrl || typeof startUrl !== 'string') return null;
  const depth = options.depth || 0;
  if (depth > HUBCLOUD_UNROLL_MAX_DEPTH) return null;

  const deadline = options.deadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS;
  const cached = hubcloudUnrollCache.get(startUrl);
  if (cached) {
    if (Date.now() < cached.exp && await probePlayableMediaUrl(cached.direct, { ...options, deadline })) {
      return cached.direct;
    }
    hubcloudUnrollCache.delete(startUrl);
  }
  const direct = await unrollHubcloudUncached(startUrl, {
    signal: options.signal,
    headers: options.headers || {},
    depth,
    deadline
  });
  if (direct) {
    hubcloudUnrollCache.set(startUrl, { direct, exp: Date.now() + HUBCLOUD_UNROLL_TTL_MS });
    if (hubcloudUnrollCache.size > 256) {
      const oldest = hubcloudUnrollCache.keys().next().value;
      if (oldest) hubcloudUnrollCache.delete(oldest);
    }
  }
  return direct;
}

async function unrollHubcloudUncached(startUrl, opts) {
  const { signal, headers = {}, depth, deadline } = opts;
  try {
    // 1) `dl.php?link=…` wrappers carry the final URL in the query string —
    //    no fetch needed at all when the Location itself is one.
    const entryInner = extractHttpLinkParam(startUrl);
    if (entryInner) {
      const resolved = await resolveLinkInner(entryInner, opts);
      if (resolved) return resolved;
    }
    for (const target of extractWrappedMediaTargets(startUrl)) {
      if (target === entryInner) continue;
      const resolved = await resolveLinkInner(target, opts);
      if (resolved) return resolved;
    }

    // 2) fetch the generator page, following HTTP redirects (some generator
    //    hosts 302 straight to `dl.php?link=<direct>` — no JS involved).
    const res = await fetchWithDeadline(startUrl, USER_AGENT, signal, deadline, { headers });
    if (!res) return null;
    const finalUrl = res.url || startUrl;

    if (finalUrl !== startUrl) {
      const inner = extractHttpLinkParam(finalUrl);
      if (inner) {
        const resolved = await resolveLinkInner(inner, opts);
        if (resolved) return resolved;
      }
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isPage =
      !contentType ||
      /^(?:text\/|application\/(?:json|xhtml|xml|javascript))/i.test(contentType) ||
      /html|xml/i.test(contentType);
    if (!isPage) {
      // Binary body after redirect → verify the final URL before returning it.
      if (scorePlayableUrl(finalUrl) >= 0 && await probePlayableMediaUrl(finalUrl, { signal, deadline, headers })) {
        return normalizePlayableUrl(finalUrl);
      }
      return null;
    }

    // 3) scan the raw landing HTML for the final CDN link — it is present in
    //    the source even while the countdown hides it (meta-refresh target,
    //    inline script, hidden/JS-filled anchor, atob payload).
    let html = '';
    if (res.ok) {
      html = await readCappedText(res);
      if (isCfChallengePage(html)) html = ''; // challenge interstitial — no links
    }

    if (html && /\/drive\/search-recover\.php(?:\?|$)/i.test(finalUrl)) {
      const recovered = await resolveHubcloudSearchRecoverPage(html, finalUrl, {
        signal,
        deadline,
        headers,
        depth
      });
      if (recovered) return recovered;
    }

    const pick = pickFromGeneratorHtml(html, finalUrl);
    const pickedDirect = await validateGeneratorPick(pick, { signal, deadline, headers, depth });
    if (pickedDirect) return pickedDirect;

    // 4) last resort: some generator hosts serve the countdown page to browser
    //    UAs but 302 directly for crawlers — retry once with a non-browser UA.
    if (depth === 0 && Date.now() < deadline - 1200 && !signal?.aborted) {
      const retry = await fetchWithDeadline(startUrl, HUBCLOUD_UNROLL_ALT_UA, signal, deadline, { headers });
      if (retry) {
        const retryUrl = retry.url || startUrl;
        const inner = extractHttpLinkParam(retryUrl);
        if (inner) {
          const resolved = await resolveLinkInner(inner, { ...opts, depth });
          if (resolved) return resolved;
        }
        let rHtml = '';
        if (retry.ok) {
          rHtml = await readCappedText(retry);
          if (isCfChallengePage(rHtml)) rHtml = '';
        }
        const rPick = pickFromGeneratorHtml(rHtml, retryUrl);
        const retryDirect = await validateGeneratorPick(rPick, { signal, deadline, headers, depth });
        if (retryDirect) return retryDirect;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Centaurus (HiCine / api.hicine.sbs) candidate scoring.
 *
 * Mobile Chrome/Brave on Android cannot decode 10-bit HEVC, so a 720p x264
 * stereo-AAC line must win over a "better" resolution 10Bit HEVC line; 1080p and
 * 480p stay available in `qualities` for desktop + backup failover.
 */
function scoreHicineQuality(q) {
  let score = 0;
  if (!q.isHevc) score += 100;
  if (q.isX264) score += 60;
  if (q.isStereoAac) score += 40;
  // 720p x264 starts fast on mobile; 480p even faster; 1080p is the desktop pick
  if (q.height === 720) score += 30;
  else if (q.height === 480) score += 25;
  else if (q.height === 1080) score += 20;
  else score += 10;
  if (q.isHevc) score -= 50;
  if (q.isMultiChannel) score -= 30;
  return score;
}

const HICINE_AUDIO_LANGUAGE_ALIASES = [
  { code: 'en', label: 'English', aliases: ['English', 'Eng'] },
  { code: 'hi', label: 'Hindi', aliases: ['Hindi'] },
  { code: 'te', label: 'Telugu', aliases: ['Telugu'] },
  { code: 'bn', label: 'Bengali', aliases: ['Bengali', 'Bangla', 'Beng'] },
  { code: 'ta', label: 'Tamil', aliases: ['Tamil'] },
  { code: 'ml', label: 'Malayalam', aliases: ['Malayalam'] },
  { code: 'kn', label: 'Kannada', aliases: ['Kannada'] },
  { code: 'ja', label: 'Japanese', aliases: ['Japanese'] },
  { code: 'ko', label: 'Korean', aliases: ['Korean'] },
  { code: 'zh', label: 'Chinese', aliases: ['Chinese', 'Mandarin'] },
  { code: 'es', label: 'Spanish', aliases: ['Spanish'] },
  { code: 'fr', label: 'French', aliases: ['French'] },
  { code: 'ar', label: 'Arabic', aliases: ['Arabic'] },
  { code: 'ur', label: 'Urdu', aliases: ['Urdu'] },
  { code: 'mr', label: 'Marathi', aliases: ['Marathi'] },
  { code: 'pa', label: 'Punjabi', aliases: ['Punjabi'] },
  { code: 'pt', label: 'Portuguese', aliases: ['Portuguese'] },
  { code: 'ru', label: 'Russian', aliases: ['Russian'] },
  { code: 'de', label: 'German', aliases: ['German'] },
  { code: 'it', label: 'Italian', aliases: ['Italian'] },
  { code: 'id', label: 'Indonesian', aliases: ['Indonesian'] },
  { code: 'tr', label: 'Turkish', aliases: ['Turkish'] },
  { code: 'th', label: 'Thai', aliases: ['Thai'] },
  { code: 'fa', label: 'Persian', aliases: ['Persian', 'Farsi'] }
];

function parseHicineAudioHints(text) {
  const value = String(text || '');
  const aliases = HICINE_AUDIO_LANGUAGE_ALIASES.flatMap((language) =>
    language.aliases.map((alias) => ({ ...language, alias }))
  ).sort((a, b) => b.alias.length - a.alias.length);
  const matcher = new RegExp(
    `(^|[^A-Za-z])(${aliases.map((item) => item.alias).join('|')})(?=$|[^A-Za-z])`,
    'gi'
  );
  const languages = [];
  const seen = new Set();
  let match;
  while ((match = matcher.exec(value))) {
    const alias = match[2].toLowerCase();
    const language = aliases.find((item) => item.alias.toLowerCase() === alias);
    if (language && !seen.has(language.code)) {
      seen.add(language.code);
      languages.push({ code: language.code, label: language.label });
    }
  }
  const multi = /\b(?:dual[\s._-]*audio|multi(?:ple)?[\s._-]*(?:audio|language|lang|track|dub))\b/i.test(value) || languages.length > 1;
  const original = /\b(?:org\.?|original)[\s._-]*(?:audio|track)\b/i.test(value);
  return { languages, multi, original };
}

function hicineAudioHintText(text) {
  const filenames = [];
  const textWithoutUrls = String(text || '').replace(/https?:\/\/[^\s,"']+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl.replace(/[),;]+$/, ''));
      const filename = decodeURIComponent(parsed.pathname.split('/').pop() || '');
      if (/\.(?:mkv|mp4|m4v|webm|mov|avi)$/i.test(filename)) {
        filenames.push(filename.replace(/\.[^.]+$/, ''));
      }
    } catch {}
    return ' ';
  });
  return `${textWithoutUrls} ${filenames.join(' ')}`;
}

function buildHicineDefaultAudioTrack(audioHints, streamUrl) {
  const hints = audioHints || { languages: [], multi: false, original: false };
  const languages = Array.isArray(hints.languages) ? hints.languages : [];
  const language = languages.length === 1 && !hints.multi ? languages[0] : null;
  const label = languages.length > 1
    ? `${languages.map((item) => item.label).join(' + ')} — plays default track`
    : languages.length === 1
      ? `${languages[0].label}${hints.multi ? ' — plays default track' : ' — filename hint; plays default track'}`
      : hints.multi
        ? 'Dual Audio — plays default track'
        : hints.original
          ? 'Original Audio (default track)'
          : 'Default Audio (track selection unavailable)';
  return {
    id: 'hicine-default',
    lang: language ? language.code : 'und',
    label,
    type: 'dub',
    streamUrl,
    rawUrl: streamUrl,
    default: true
  };
}

async function resolveHicineUpstream(metadata, env = {}) {
  if (!metadata.title) return null;
  // Bound the HiCine search, token requests, generator unrolls, and probes as one operation.
  const unrollDeadline = Date.now() + 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), unrollDeadline - Date.now());
  try {
    const apiBase = (env && env.HICINE_API_BASE) || runtimeState.upstreams.hicineApiBase || 'https://api.hicine.sbs';
    const res = await fetchWithDeadline(
      `${apiBase}/api/search/${encodeURIComponent(metadata.title)}`,
      USER_AGENT,
      controller.signal,
      unrollDeadline,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) return null;

    const isTv = metadata.type === 'tv';
    const wantedYear = Number(metadata.releaseYear) || 0;
    const wantedTitle = String(metadata.title || '').toLowerCase().trim();

    // Score candidates so `Fight Club (1999)` beats `Fight Club (2023)`.
    const scoreItem = (item) => {
      let score = 0;
      const itemTitle = String(item.title || item.name || '').toLowerCase().trim();
      if (itemTitle === wantedTitle) score += 100;
      else if (itemTitle.startsWith(wantedTitle) || itemTitle.includes(wantedTitle)) score += 40;
      const itemYear = Number(item.releaseYear || item.year) || 0;
      if (wantedYear && itemYear) {
        const delta = Math.abs(itemYear - wantedYear);
        if (delta === 0) score += 100;
        else if (delta <= 1) score += 70;
        else if (delta <= 3) score += 30;
        else score -= 25;
      }
      if (isTv) {
        if (item.contentType === 'series' || item.season_1) score += 30;
        if (item.season_1 && /episode\s+1\b/i.test(String(item.season_1))) score += 10;
      } else if (item.contentType === 'movies' || item.links) {
        score += 30;
      }
      return score;
    };

    const candidates = items.filter((i) =>
      isTv ? i.contentType === 'series' || i.season_1 : i.contentType === 'movies' || i.links
    );
    const pool = candidates.length > 0 ? candidates : items;
    const chosen = [...pool].sort((a, b) => scoreItem(b) - scoreItem(a))[0];
    if (!chosen) return null;

    const rawText = isTv
      ? chosen[`season_${metadata.season || 1}`] || chosen.season_1 || ''
      : chosen.links || '';
    if (!rawText) return null;

    // Root Cause C (TV): HiCine packs every quality of one episode onto a single
    // line — `Episode 1 : https://.../?vcloud=...,480p : https://.../?vcloud=...,720p`
    // — so ` : ` separated variants must be exploded before quality parsing, and
    // `Episode N :` section matching must NOT depend on the trailing ` : `.
    const entries = [];
    const lines = String(rawText).split(/\r?\n/);
    if (isTv) {
      const epNum = Number(metadata.episode || 1);
      const epRegex = new RegExp(`^\\s*Episode\\s+0*${epNum}(?:\\b|\\s|:)`, 'i');
      const anyEp = /^\s*Episode\s+\d+/i;
      const epLines = [];
      let inside = false;
      for (const l of lines) {
        if (epRegex.test(l)) {
          inside = true;
          epLines.push(l);
        } else if (inside && anyEp.test(l)) {
          break;
        } else if (inside && l.trim()) {
          epLines.push(l);
        }
      }
      const poolLines = epLines.length > 0 ? epLines : lines.filter((l) => epRegex.test(l));
      for (const line of poolLines) {
        const body = line.replace(/^\s*Episode\s+\d+\s*:?\s*/i, '');
        for (const part of body.split(/\s+:\s+/)) {
          if (part.trim()) entries.push({ text: part.trim(), line });
        }
      }
    } else {
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const part of line.split(/\s+:\s+/)) {
          if (part.trim()) entries.push({ text: part.trim(), line });
        }
      }
    }

    // Pull every (quality, URL) pair out of the exploded entries. A single entry
    // can still carry a trailing quality label (",480p") — matchAll + the local
    // quality scan handle both orders.
    const parsedEntries = [];
    const seenUrls = new Set();
    for (const { text: entryText, line } of entries) {
      // the line-level label ("720p x264 : <url>") is the last-resort label when
      // the URL sits in its own ` : ` segment
      const lineQuality = ((line.match(/(2160p|4k|1080p|720p|480p)/i) || [])[1] || '').toLowerCase();
      const workerMatches = [...entryText.matchAll(/(https?:\/\/[^\s,"']+vcloud=[^\s,"']+)/gi)].map(
        (m) => m[1]
      );
      const directMatches = [
        ...entryText.matchAll(
          /(https?:\/\/[^\s,"']+\.(?:mp4|mkv|webm)(?:[?#][^\s,"']*)?|https?:\/\/[^\s,"']*pixeldrain\.[^\s,"']+)/gi
        )
      ].map((m) => m[1]);
      const found = Array.from(new Set([
        ...workerMatches,
        ...directMatches.filter((url) => !/[?&]vcloud=/i.test(url))
      ]));
      if (found.length === 0) continue;

      // every quality token found on the entry, in order, so `480p : <url>,720p`
      // can label the URL with the token that immediately precedes it
      const qualityTokens = [
        ...entryText.matchAll(/(2160p|4k|1080p|720p|480p)/gi)
      ].map((m) => m[1].toLowerCase());

      for (const rawUrlMatch of found) {
        if (seenUrls.has(rawUrlMatch)) continue;
        seenUrls.add(rawUrlMatch);
        const idx = entryText.indexOf(rawUrlMatch);
        const before = idx < 0 ? entryText : entryText.slice(0, idx);
        const trailingToken = [
          ...before.matchAll(/(2160p|4k|1080p|720p|480p)/gi)
        ].pop();
        const qLabel =
          trailingToken?.[1]?.toLowerCase() ||
          qualityTokens[0] ||
          (rawUrlMatch.match(/(2160p|4k|1080p|720p|480p)/i) || [])[1]?.toLowerCase() ||
          lineQuality ||
          '720p';
        const height = qLabel === '2160p' || qLabel === '4k' ? 2160 : parseInt(qLabel, 10) || 720;
        // `line` keeps the HEVC / 5.1 metadata that lives on the sibling segment
        parsedEntries.push({
          qLabel,
          height,
          rawUrlMatch,
          entry: line,
          audioHints: parseHicineAudioHints(hicineAudioHintText(line))
        });
      }
    }

    if (parsedEntries.length === 0) return null;

    // Root Cause A: token priority. `pixel` (pixeldrain) hotlink-403s
    // ("hotlink_detected") and is rate-limit-captcha gated, so the CDN tokens are
    // tried first and pixeldrain is kept only as a last resort. Every present
    // token is resolved in parallel instead of short-circuiting on the first.
    const TOKEN_PRIORITY = ['ten', 'fsl2', 'fsl', 'r2', 'DDL', 'server1'];

    const resolveEntry = async (parsed) => {
      try {
        const url = new URL(parsed.rawUrlMatch);
        const vcloud = url.searchParams.get('vcloud');
        if (!vcloud) {
          if (!/(^|\.)pixeldrain\.(?:dev|com)$/i.test(url.hostname) || !/^\/(?:u|api\/file)\/[A-Za-z0-9_-]+/i.test(url.pathname)) {
            return null;
          }
          const pixelUrl = normalizePlayableUrl(parsed.rawUrlMatch);
          const playable = await probePlayableMediaUrl(pixelUrl, {
            signal: controller.signal,
            deadline: unrollDeadline
          });
          return {
            url: pixelUrl,
            tokenType: 'pixel',
            format: 'mp4',
            isHotlinkBlocked: !playable
          };
        }

        const lRes = await fetchWithDeadline(
          `${url.origin}/api/links?vcloud=${encodeURIComponent(vcloud)}`,
          USER_AGENT,
          controller.signal,
          unrollDeadline,
          { headers: { Accept: 'application/json' } }
        );
        if (!lRes?.ok) return null;
        const lData = await lRes.json();
        const tokens = lData?.tokens || {};
        const tokenTypes = [
          ...TOKEN_PRIORITY.filter((t) => tokens[t]),
          ...Object.keys(tokens).filter((t) => !TOKEN_PRIORITY.includes(t) && t !== 'pixel'),
          ...(tokens.pixel ? ['pixel'] : [])
        ];
        if (tokenTypes.length === 0) return null;

        const attempts = await Promise.all(
          tokenTypes.map(async (tType) => {
            const tok = tokens[tType];
            if (!tok?.ts || !tok?.sig) return null;
            try {
              const goRes = await fetchWithDeadline(
                `${url.origin}/go?type=${tType}&vcloud=${encodeURIComponent(vcloud)}&ts=${encodeURIComponent(tok.ts)}&sig=${encodeURIComponent(tok.sig)}`,
                USER_AGENT,
                controller.signal,
                unrollDeadline,
                { redirect: 'manual' }
              );
              let loc = goRes?.headers.get('location');
              if (!loc || !/^https?:\/\//i.test(loc)) return null;

              // Root Cause E: HubCloud link generators (`gpdl2.hubcloud.ist/?id=…`,
              // `gamerxyt.com/dl.php?link=…`, nested `hubcloud.<tld>/drive/<id>` pages) are
              // countdown HTML, not media — unroll them server-side to the real CDN
              // file before anything reaches `<video src>`.
              let unrollFailed = false;
              if (isHubcloudGeneratorUrl(loc) || extractHttpLinkParam(loc) || extractWrappedMediaTargets(loc).length > 0) {
                const direct = await unrollHubcloudUrl(loc, { deadline: unrollDeadline, signal: controller.signal });
                if (direct) loc = direct;
                // A landing page that could not be unrolled is just as unplayable
                // as a hotlink-blocked URL: mark it dead so the attempts loop can
                // fall through to the next HiCine token (fsl/r2/DDL/…). If no
                // other token exists it stays the last resort, as before.
                else unrollFailed = true;
              }

              // Root Cause B: unwrap ?link= redirect wrappers down to the real CDN
              loc = unwrapRedirectVideoUrl(loc);
              if (!/^https?:\/\//i.test(loc)) return null;

              // pixeldrain `/u/ID` share pages -> direct API stream endpoint
              if (/pixeldrain\.(dev|com)/i.test(loc) && loc.includes('/u/')) {
                loc = normalizePlayableUrl(loc);
              }

              let isHotlinkBlocked = unrollFailed;
              if (!isHotlinkBlocked) {
                isHotlinkBlocked = !(await probePlayableMediaUrl(loc, { signal: controller.signal, deadline: unrollDeadline }));
              }

              return {
                url: loc,
                tokenType: tType,
                format: /\.mpd(\?|$)/i.test(loc)
                  ? 'dash'
                  : /\.m3u8(\?|$)/i.test(loc)
                    ? 'hls'
                    : 'mp4',
                isHotlinkBlocked
              };
            } catch {
              return null;
            }
          })
        );

        const viable = attempts.find((a) => a && !a.isHotlinkBlocked);
        if (viable) return viable;
        const blocked = attempts.find((a) => a);
        if (blocked) return blocked; // last-resort token URL
        return null;
      } catch {
        return null;
      }
    };

    const hasHevc = (label, entry) =>
      /hevc|x265|10\s*bit/i.test(String(label)) || /hevc|x265|10\s*bit/i.test(String(entry));
    const hasX264 = (label, entry) => /x264|h\.?264/i.test(`${label} ${entry}`);
    const hasMultiChannel = (entry) => /dd\s*5\.1|ac3|eac3|5\.1|7\.1/i.test(String(entry));
    const hasStereoAac = (entry) => /aac|stereo|2\.0/i.test(String(entry));

    const resolvedQualities = [];
    const seenDirect = new Set();
    for (const parsed of parsedEntries) {
      if (resolvedQualities.length >= 4) break;
      const resolved = await resolveEntry(parsed);
      if (!resolved?.url || seenDirect.has(resolved.url)) continue;
      seenDirect.add(resolved.url);
      resolvedQualities.push({
        label: parsed.qLabel,
        height: parsed.height,
        rawUrl: resolved.url,
        tokenType: resolved.tokenType,
        isHotlinkBlocked: !!resolved.isHotlinkBlocked,
        streamFormat: resolved.format,
        audioHints: parsed.audioHints,
        isHevc: hasHevc(parsed.qLabel, parsed.entry),
        isX264: hasX264(parsed.qLabel, parsed.entry),
        isMultiChannel: hasMultiChannel(parsed.entry),
        isStereoAac: hasStereoAac(parsed.entry),
        // Root Cause D: resolved direct CDN URLs play natively in <video> (no
        // CORS mode, no Range re-encoding on the edge). /api/proxy stays as the
        // backup ladder for ISP-blocked regions / hotlink-filtered hosts.
        url: resolved.url,
        proxyUrl: buildWorkerProxyUrl(resolved.url, '', 'manifest')
      });
    }

    if (resolvedQualities.length === 0) return null;

    const isDeadQuality = (q) => q.isHotlinkBlocked;

    // Score + sort: strongly prefer !isHevc (x264) + stereo AAC, then the 720p
    // mobile-friendly start, keeping 1080p/480p in `qualities`.
    const sorted = [...resolvedQualities].sort((a, b) => {
      const deadDelta = Number(isDeadQuality(a)) - Number(isDeadQuality(b));
      if (deadDelta !== 0) return deadDelta;
      return scoreHicineQuality(b) - scoreHicineQuality(a);
    });
    // Drop a 10-bit HEVC entry when an x264 line of the same resolution exists:
    // the duplicate label is useless on mobile and keeping it in `qualities`
    // invites a manual pick that cannot decode.
    const x264Heights = new Set(
      sorted.filter((q) => !q.isHevc && !q.isHotlinkBlocked).map((q) => q.height)
    );
    const playable = sorted.filter(
      (q) => !x264Heights.has(q.height) || (!q.isHevc && !q.isHotlinkBlocked)
    );
    if (playable.length === 0) playable.push(...sorted);
    const primary = playable[0];
    const ordered = [primary, ...playable.slice(1).sort((a, b) => b.height - a.height)];

    const backupUrls = [];
    for (const q of ordered.slice(1)) backupUrls.push(q.proxyUrl);
    if (primary.proxyUrl) backupUrls.push(primary.proxyUrl);
    // last resort: the raw CDN URL straight from the browser (no proxy at all),
    // for regions where the Worker itself is the bottleneck
    if (primary.rawUrl) backupUrls.push(primary.rawUrl);
    const uniqueBackups = Array.from(new Set(backupUrls.filter(Boolean)));

    return {
      server: 'centaurus',
      format: primary.streamFormat || 'mp4',
      rawUrl: primary.rawUrl,
      // Root Cause D: direct CDN playback, NOT wrapped in /api/proxy
      streamUrl: primary.rawUrl,
      referer: '',
      headers: {},
      tokenType: primary.tokenType,
      isHevc: primary.isHevc,
      backupUrls: uniqueBackups,
      // Workers cannot inspect/remux embedded MKV streams, so keep one honest
      // default row and use only the language hints present in HiCine text.
      audioTracks: [buildHicineDefaultAudioTrack(primary.audioHints, primary.rawUrl)],
      qualities: ordered.map((q) => ({
        label: q.label,
        height: q.height,
        url: q.rawUrl,
        tokenType: q.tokenType
      }))
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
/** Per-upstream budget keeps the waterfall deterministic. */
const WATERFALL_UPSTREAM_TIMEOUT_MS = 9000;

async function withTimeout(promise, ms, fallback = null) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveStreamWaterfall(metadata, requestedServer, preferredAudio, env) {
  const validServer = serverCatalog.resolveServerId(SERVERS, requestedServer);
  const cacheKey = `cf:resolve:v4:${metadata.type}:${metadata.tmdbId}:s${metadata.season}:e${metadata.episode}:${validServer}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) {
    // Rebuild the displayed server list from the live catalog: the stream payload
    // is cached for 15 minutes, but a rebrand/re-prioritisation must show up in
    // the player immediately instead of being replayed from cache.
    const payload = applyPreferredAudio(cached, preferredAudio);
    return { ...payload, servers: serverCatalog.buildServerPayload(SERVERS, payload.server) };
  }

  // Waterfall order comes from the shared catalog's live priority order, and an
  // explicitly requested server is always attempted first.
  const prioritized = serverCatalog.waterfallEnabledServers(SERVERS).map((s) => s.id);
  const order = [validServer, ...prioritized.filter((id) => id !== validServer)];

  // Per-server diagnostic aggregation for API responses and the owner debug endpoint.
  const serverAttempts = [];

  for (const srvId of order) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'andromeda') {
      resolved = await withTimeout(
        resolveAndromedaUpstream(metadata, srvId, preferredAudio, env),
        WATERFALL_UPSTREAM_TIMEOUT_MS
      );
    } else if (srvId === 'centaurus') {
      // HiCine-only source, resolved inside the Worker. HiCine itself returns
      // null on a miss (or on its timeout), so name the failure with the
      // hicine_ prefix — the player's error panel must say which source failed.
      const hicine = await withTimeout(
        resolveHicineUpstream(metadata, env),
        WATERFALL_UPSTREAM_TIMEOUT_MS
      );
      resolved = hicine || { reason: 'hicine_no_stream' };
    }
    const latencyMs = Date.now() - t0;

    if (resolved && resolved.streamUrl) {
      const payload = {
        ...resolved,
        requestedServer: validServer,
        serverAttempts,
        activeAudioTrack:
          resolved.audioTracks?.find((t) => t.default) || resolved.audioTracks?.[0] || null,
        servers: serverCatalog.buildServerPayload(SERVERS, resolved.server)
      };
      const finalPayload = applyPreferredAudio(payload, preferredAudio);
      await edgeCacheSet(cacheKey, finalPayload, 900);
      return finalPayload;
    } else {
      const reason =
        resolved && resolved.reason ? resolved.reason : 'no_stream';
      const diag = resolved && resolved.diag ? resolved.diag : null;
      recordWorkerServerAttempt(srvId, false, latencyMs, reason);
      serverAttempts.push({ server: srvId, latencyMs, reason, diag });
    }
  }

  return {
    server: null,
    streamUrl: null,
    // The normalized id, so an error body never echoes a removed/legacy server.
    requestedServer: validServer,
    reason: 'all_servers_failed',
    serverAttempts,
    servers: serverCatalog.buildServerPayload(SERVERS, null)
  };
}

/**
 * 5. M3U8 Manifest Rewriter & Edge Stream Proxy
 */
/**
 * Per-host JWT cache for token-gated stream hosts (`<host>/generate.php`).
 * Tokens are IP bound with a ~4h TTL, so a 10 minute edge cache is safe and
 * keeps the waterfall within the sub-400ms budget.
 */
const jwTokenCache = new Map();

async function fetchHostGateToken(hostOrigin, referer = '') {
  if (!hostOrigin) return '';
  const cached = jwTokenCache.get(hostOrigin);
  if (cached && Date.now() < cached.exp) return cached.token;
  let token = '';
  try {
    const res = await fetch(`${hostOrigin}/generate.php`, {
      headers: {
        'User-Agent': USER_AGENT,
        ...(referer ? { Referer: referer } : {})
      },
      redirect: 'follow'
    });
    if (res.ok) {
      const raw = (await res.text()).trim();
      if (raw) {
        if (raw.startsWith('{')) {
          token = JSON.parse(raw)?.token || '';
        } else if (raw.startsWith('<')) {
          token = '';
        } else {
          token = raw.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {
    token = '';
  }
  if (token) jwTokenCache.set(hostOrigin, { token, exp: Date.now() + 600000 });
  return token;
}

/**
 * Stamp a URL with an __TOKEN__ placeholder or a `?token=` query parameter.
 */
function stampTokenOnUrl(target, token, forUriAttribute = false) {
  if (!target) return target;
  const enc = encodeURIComponent(token);
  let out = target;
  if (out.includes('__TOKEN__')) {
    out = out.replace(/__TOKEN__/g, enc);
  } else if (!/[?&]token=/i.test(out)) {
    if (forUriAttribute || /\.m3u8|\.key|\.ts|\.m4s|\.mp4/i.test(out)) {
      out = `${out}${out.includes('?') ? '&' : '?'}token=${enc}`;
    }
  }
  return out;
}

/**
 * Rewrite an HLS manifest so every nested playlist / key / segment is routed
 * through this Worker (never leaking a bare segment URL that would 403 on
 * Origin/Referer + JWT gated hosts).
 */
function rewriteManifest(m3u8, baseUrl, workerProxyBase, referer, origin, mode, token = '') {
  const resolveAbs = (u) => {
    try {
      return new URL(u.trim(), baseUrl).toString();
    } catch {
      return u.trim();
    }
  };

  const proxyUri = (target, isPlaylistOrKey) => {
    let abs = resolveAbs(target);
    if (token && !abs.includes('__TOKEN__') && !/[?&]token=/i.test(abs)) {
      abs = stampTokenOnUrl(abs, token, true);
    }
    // In 'manifest' mode (default on Cloudflare), only proxy nested .m3u8 playlists & keys;
    // let heavy .ts/.m4s video segments stream directly from upstream CDN to save Worker request quota!
    if (mode === 'manifest' && !isPlaylistOrKey) return abs;
    const p = new URLSearchParams({ url: abs, mode });
    if (referer) p.set('referer', referer);
    if (origin) p.set('origin', origin);
    if (token) p.set('token', token);
    return `${workerProxyBase}?${p.toString()}`;
  };

  return m3u8
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#EXT-X-') && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUri(u, true)}"`);
      }
      if (trimmed.startsWith('#')) return line;
      const isPlaylist =
        trimmed.includes('.m3u8') || trimmed.includes('playlist') || trimmed.includes('index');
      return proxyUri(trimmed, isPlaylist);
    })
    .join('\n');
}

async function handleProxyRequest(request, url) {
  const targetUrl = url.searchParams.get('url');
  const referer = url.searchParams.get('referer') || '';
  const origin = url.searchParams.get('origin') || '';
  const mode = url.searchParams.get('mode') || 'manifest';
  const cookie = url.searchParams.get('cookie') || '';
  const passthroughToken = url.searchParams.get('token') || '';
  const vidsrcStamp = url.searchParams.get('vidsrcStamp') === '1';

  if (!targetUrl) {
    return jsonResponse({
      ok: true,
      brand: 'LOL Embed',
      worker: 'LOL Embed Cloudflare Worker',
      usage: '/api/proxy?url=https://example.com/master.m3u8&referer=https://upstream.site/'
    });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid ?url= parameter' }, 400);
  }

  // Only ever send Referer/Origin when the caller explicitly asked for them —
  // a synthesized Referer is what triggered Pixeldrain's hotlink filter and the
  // vidstuck/Pixeldrain 403s.
  const upstreamHeaders = new Headers({
    'User-Agent': request.headers.get('User-Agent') || USER_AGENT,
    Accept: '*/*'
  });
  if (referer) upstreamHeaders.set('Referer', referer);
  if (origin) {
    upstreamHeaders.set('Origin', origin);
  } else if (referer) {
    try {
      upstreamHeaders.set('Origin', new URL(referer).origin);
    } catch {}
  }
  if (cookie) upstreamHeaders.set('Cookie', cookie);

  // JWT stamping for X-frame/Origin gated hosts: `vidsrcStamp=1` (legacy flag)
  // or an __TOKEN__ placeholder in the URL triggers a <host>/generate.php lookup.
  let token = passthroughToken;
  if (vidsrcStamp || targetUrl.includes('__TOKEN__')) {
    token = token || (await fetchHostGateToken(parsed.origin, referer));
  }

  let upstreamTarget = targetUrl;
  if (token) upstreamTarget = stampTokenOnUrl(targetUrl, token, true);
  const upstreamUrl = new URL(upstreamTarget);

  const range = request.headers.get('Range');
  if (range) upstreamHeaders.set('Range', range);

  const upstreamResp = await fetch(upstreamUrl.toString(), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: upstreamHeaders,
    redirect: 'follow'
  });

  const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstreamResp.url || upstreamUrl.toString();
  const isM3u8 =
    contentType.includes('mpegurl') ||
    contentType.includes('m3u8') ||
    parsed.pathname.endsWith('.m3u8');

  if (isM3u8 && request.method !== 'HEAD') {
    const text = await upstreamResp.text();
    if (text.trim().startsWith('#EXTM3U')) {
      const workerProxyBase = `${url.origin}/api/proxy`;
      // `mode=full` (or a JWT-stamped response) rewrites every variant AND
      // segment URI through the Worker with the token attached.
      const effectiveMode = mode === 'full' ? 'full' : mode;
      const rewritten = rewriteManifest(
        text,
        finalUrl,
        workerProxyBase,
        referer,
        origin,
        effectiveMode,
        token
      );
      return new Response(rewritten, {
        status: 200,
        headers: corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'public, max-age=15'
        })
      });
    }
  }

  if (mode === 'full' && isM3u8 && request.method !== 'HEAD') {
    // Upstream answered with something other than an #EXTM3U playlist
    return jsonResponse(
      { ok: false, error: 'Upstream did not return an HLS manifest', target: parsed.hostname },
      502
    );
  }

  const respHeaders = new Headers(corsHeaders());
  respHeaders.set('Accept-Ranges', 'bytes');
  respHeaders.set(
    'Content-Type', contentType.includes('octet-stream') ? 'video/mp4' : contentType || 'video/mp4'
  );

  const cl = upstreamResp.headers.get('content-length');
  if (cl) respHeaders.set('Content-Length', cl);
  const cr = upstreamResp.headers.get('content-range');
  if (cr) respHeaders.set('Content-Range', cr);

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders
  });
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Support standalone proxy mode at root `/?url=https://...` or `/api/proxy?url=https://...`
    if (pathname === '/api/proxy' || (pathname === '/' && url.searchParams.has('url'))) {
      recordWorkerDomainHit(request, url, 'proxy');
      return handleProxyRequest(request, url);
    }

    // --- Owner Admin API Routes (/api/admin/*) ---
    if (pathname.startsWith('/api/admin/')) {
      const expectedKey = env.ADMIN_SECRET || 'admin123';
      const providedKey =
        request.headers.get('x-admin-key') ||
        url.searchParams.get('key') ||
        (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

      if (!providedKey || providedKey !== expectedKey) {
        return jsonResponse({ ok: false, error: 'Unauthorized: Invalid Admin Key' }, 401);
      }

      if (pathname === '/api/admin/overview' && request.method === 'GET') {
        return jsonResponse({ ok: true, ...getWorkerAdminSnapshot() });
      }

      if (pathname === '/api/admin/probe' && request.method === 'POST') {
        const targets = [
          { serverId: 'andromeda', url: `${runtimeState.upstreams.vidstuckBase}/backend/tmdb/details/tv/94605?language=en-US` },
          { serverId: 'centaurus', url: `${runtimeState.upstreams.hicineApiBase}/api/search/arcane` }
        ];
        const probeResults = [];
        for (const t of targets) {
          const t0 = Date.now();
          try {
            const r = await fetch(t.url, { headers: { 'User-Agent': USER_AGENT, ...(t.headers || {}) } });
            const ms = Date.now() - t0;
            const ok = r.status >= 200 && r.status < 400;
            recordWorkerServerAttempt(t.serverId, ok, ms, ok ? null : `HTTP ${r.status}`);
            probeResults.push({ serverId: t.serverId, url: t.url, ok, httpStatus: r.status, latencyMs: ms });
          } catch (e) {
            const ms = Date.now() - t0;
            recordWorkerServerAttempt(t.serverId, false, ms, e.message);
            probeResults.push({ serverId: t.serverId, url: t.url, ok: false, httpStatus: 0, latencyMs: ms, error: e.message });
          }
        }
        return jsonResponse({ ok: true, probeResults, snapshot: getWorkerAdminSnapshot() });
      }

      if (pathname.startsWith('/api/admin/overrides/') && request.method === 'DELETE') {
        const key = decodeURIComponent(pathname.replace('/api/admin/overrides/', ''));
        runtimeState.customOverrides.delete(key);
        return jsonResponse({ ok: true, snapshot: getWorkerAdminSnapshot() });
      }
    }

    // Owner/developer diagnostic for server 1 (Andromeda multi-audio). Walks the
    // EXACT production code path and returns the structured failure reason
    // so the owner can see whether upstream endpoints are dead, what audio tracks
    // were resolved, etc.
    const andromedaDebugMatch = pathname.match(/^\/api\/debug\/andromeda\/(movie|tv)\/([^/]+)$/);
    if (andromedaDebugMatch && request.method === 'GET') {
      const [, dbgType, dbgTmdb] = andromedaDebugMatch;
      const dbgSeason = parseInt(url.searchParams.get('season') || '1', 10);
      const dbgEpisode = parseInt(url.searchParams.get('episode') || '1', 10);
      try {
        const meta = await resolveTmdbMetadata(dbgType, dbgTmdb, dbgSeason, dbgEpisode, env);
        // Bypass the waterfall: ask the andromeda resolver directly so the
        // diag reflects ONLY what server 1 saw, not what the next 4 did.
        const direct = await withTimeout(
          resolveAndromedaUpstream(meta, 'andromeda', '', env),
          WATERFALL_UPSTREAM_TIMEOUT_MS
        );
        return jsonResponse({
          ok: !!(direct && direct.streamUrl),
          metadata: {
            title: meta.title,
            releaseYear: meta.releaseYear,
            unresolvedTmdb: !!meta.unresolvedTmdb,
            externalIds: meta.externalIds
          },
          upstream: {
            castletvBase: (env && env.CASTLETV_BASE_URL) || runtimeState.upstreams.castletvBase,
            netmirrorBase: (env && env.NETMIRROR_BASE_URL) || runtimeState.upstreams.netmirrorBase,
            vidstuckBase: (env && env.VIDSTUCK_BASE_URL) || runtimeState.upstreams.vidstuckBase,
            tmdbKeySet: !!(env && env.TMDB_API_KEY)
          },
          result: direct
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    
    // --- API Routes ---
    if (pathname === '/api/health') {
      return jsonResponse({
        ok: true,
        brand: 'LOL Embed',
        runtime: 'cloudflare-workers-edge',
        service: 'lol-embed-backend',
        mode: 'player-and-api',
        version: '2.2.0',
        embed: '/embed',
        metaImage: '/meta-image.gif',
        servers: SERVERS.map((s) => s.id)
      });
    }

    if (pathname === '/api/catalog') {
      return jsonResponse({
        ok: true,
        items: [
          { tmdbId: 94605, type: 'tv', title: 'Arcane', releaseYear: 2021, imdbId: 'tt11126994' },
          { tmdbId: 1396, type: 'tv', title: 'Breaking Bad', releaseYear: 2008, imdbId: 'tt0903747' },
          { tmdbId: 693134, type: 'movie', title: 'Dune: Part Two', releaseYear: 2024, imdbId: 'tt15239678' }
        ]
      });
    }

    // GET /api/subtitles/proxy?url=...
    if (pathname === '/api/subtitles/proxy') {
      const subUrl = url.searchParams.get('url');
      if (!subUrl) return new Response('Missing url', { status: 400, headers: corsHeaders() });
      try {
        const res = await fetch(subUrl, {
          headers: { 'User-Agent': USER_AGENT, 'X-User-Agent': 'TemporaryUserAgent' }
        });
        const arrBuf = await res.arrayBuffer();
        let buf = Buffer.from(arrBuf);
        if ((buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) || subUrl.endsWith('.gz')) {
          buf = zlib.gunzipSync(buf);
        }
        const vtt = srtToVtt(buf.toString('utf8'));
        return new Response(vtt, {
          status: 200,
          headers: corsHeaders({
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'public, max-age=7200'
          })
        });
      } catch (err) {
        return new Response(`Subtitle error: ${err.message}`, { status: 502, headers: corsHeaders() });
      }
    }

    // POST /api/subtitles/convert
    if (pathname === '/api/subtitles/convert' && request.method === 'POST') {
      const raw = await request.text();
      return new Response(srtToVtt(raw), {
        status: 200,
        headers: corsHeaders({ 'Content-Type': 'text/vtt; charset=utf-8' })
      });
    }


    // Match /api/(info|segments|subtitles|resolve)/:type/:tmdbId
    const apiMatch = pathname.match(/^\/api\/(info|segments|subtitles|resolve)\/(movie|tv|series)\/([^/]+)$/i);
    if (apiMatch) {
      const [, action, rawType, tmdbId] = apiMatch;
      const season = parseInt(url.searchParams.get('season') || url.searchParams.get('s') || '1', 10);
      const episode = parseInt(url.searchParams.get('episode') || url.searchParams.get('e') || '1', 10);
      const server = (url.searchParams.get('server') || 'andromeda').toLowerCase();
      const audio = url.searchParams.get('audio') || '';

      const metadata = await resolveTmdbMetadata(rawType, tmdbId, season, episode, env);

      if (action === 'info') {
        const segments = await resolveSkipSegments(metadata);
        return jsonResponse({ ok: true, metadata, segments, servers: serverCatalog.listableServers(SERVERS) });
      }

      if (action === 'segments') {
        const segments = await resolveSkipSegments(metadata);
        return jsonResponse({ ok: true, tmdbId: metadata.tmdbId, segments });
      }

      if (action === 'subtitles') {
        const tracks = await resolveSubtitles(metadata);
        return jsonResponse({ ok: true, tmdbId: metadata.tmdbId, tracks });
      }

      if (action === 'resolve') {
        const callerDomain = extractCallerDomain(request, url);
        if (runtimeState.blockedDomains.has(callerDomain.replace(/^www\./, ''))) {
          return jsonResponse({ ok: false, error: `Domain "${callerDomain}" is blocked by the embed owner.` }, 403);
        }

        recordWorkerDomainHit(request, url, 'resolve', metadata);

        // Check custom override first
        const ovKey =
          metadata.type === 'tv'
            ? `tv:${metadata.tmdbId}:${season}:${episode}`
            : `movie:${metadata.tmdbId}:1:1`;
        const customOv = runtimeState.customOverrides.get(ovKey);

        const [streamData, subtitles, segments] = await Promise.all([
          customOv
            ? Promise.resolve({
                server: 'custom',
                format: customOv.format || 'hls',
                rawUrl: customOv.streamUrl,
                streamUrl: buildWorkerProxyUrl(customOv.streamUrl, ''),
                audioTracks: [
                  {
                    id: 'custom-orig',
                    lang: 'en',
                    label: customOv.label || 'Custom Admin Source',
                    type: 'sub',
                    streamUrl: buildWorkerProxyUrl(customOv.streamUrl, ''),
                    rawUrl: customOv.streamUrl,
                    default: true
                  }
                ],
                qualities: [{ label: 'Auto', height: 0, url: buildWorkerProxyUrl(customOv.streamUrl, '') }],
                servers: serverCatalog.buildServerPayload(SERVERS, null)
              })
            : resolveStreamWaterfall(metadata, server, audio, env),
          resolveSubtitles(metadata),
          resolveSkipSegments(metadata)
        ]);

        if (!streamData || !streamData.streamUrl) {
          // Include a useful per-server explanation in this API error response.
          const attempts = (streamData && streamData.serverAttempts) || [];
          const firstFailed = attempts.find((a) => a.server === server) || attempts[0];
          const reasonMap = {
            circuit_open: 'Server paused (too many recent failures).',
            meow_403: 'Upstream rejected the session token (Origin/Referer or session expired).',
            meow_404: 'Upstream endpoint not found (VidStuck domain may have changed).',
            meow_5xx: 'Upstream 5xx while issuing the session token.',
            meow_no_token: 'Upstream returned no session token.',
            servers_403: 'Upstream refused the server lookup (stale token).',
            servers_404: 'Upstream has no record for this server.',
            servers_5xx: 'Upstream 5xx on the server lookup.',
            servers_no_link: 'Upstream has no stream link for this title on this server.',
            upstream_timeout: 'Timed out talking to the upstream provider.',
            upstream_exception: 'Unhandled error contacting the upstream provider.',
          };
          const humanReason = firstFailed
            ? reasonMap[firstFailed.reason] || firstFailed.reason
            : 'No working server in the waterfall.';
          const humanDiag = firstFailed && firstFailed.diag ? firstFailed.diag.message : null;
          return jsonResponse(
            {
              ok: false,
              error: 'Unable to resolve stream from upstream providers for this title.',
              explanation: humanReason,
              serverExplanation: humanDiag,
              requestedServer: (streamData && streamData.requestedServer) || server,
              failedReason: firstFailed ? firstFailed.reason : null,
              serverAttempts: attempts,
              metadata,
              subtitles,
              segments,
              servers: (streamData && streamData.servers) || serverCatalog.buildServerPayload(SERVERS, null)
            },
            502
          );
        }

        return jsonResponse({
          ok: true,
          metadata,
          stream: streamData,
          subtitles,
          segments,
          servers: streamData.servers
        });
      }
    }

    // --- Embedded Player Page (/embed) ---
    // The player Worker serves exactly one HTML page. The main website is a
    // separate project and embeds this URL with an iframe. Both the canonical
    // query form and the path/legacy forms route here:
    //   /embed?type=tv&tmdb=94605&s=1&e=1   /embed/movie/693134
    //   /embed/tv/94605/2/1                 /movie/693134
    //   /tv/94605/2/1
    const isEmbedRoute = pathname === '/embed' || /^\/(?:embed\/)?(?:movie|tv)\/[^/]+(?:\/\d+(?:\/\d+)?)?\/?$/i.test(pathname);
    if (isEmbedRoute && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Player assets are not configured' }, 503);
      }
      recordWorkerDomainHit(request, url, 'embed');
      const embedReq = new Request(new URL('/embed.html', url.origin), { method: 'GET' });
      const assetRes = await env.ASSETS.fetch(embedReq);
      if (!assetRes.ok) {
        return jsonResponse({ ok: false, error: 'Player page is unavailable' }, assetRes.status);
      }
      let html = await assetRes.text();
      const apiBaseUrl = normalizeApiBaseUrl(env.API_BASE_URL);
      // Inject the configured API Worker URL (may be '' for same-origin API).
      const configScript = `<script>window.__LOL_EMBED_CONFIG__=${JSON.stringify({
        apiBaseUrl
      }).replace(/</g, '\\u003c')};</script>`;
      html = html.includes('<!--LOL_EMBED_CONFIG-->')
        ? html.replace('<!--LOL_EMBED_CONFIG-->', configScript)
        : html.replace('</head>', `${configScript}\n</head>`);
      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        // Must be iframe-embeddable by the (separately built) main website.
        'Content-Security-Policy': 'frame-ancestors *;',
        'Access-Control-Allow-Origin': '*'
      });
      headers.delete('X-Frame-Options');
      return new Response(html, { status: 200, headers });
    }

    // --- Player Static Assets (only what the /embed page needs) ---
    if (PLAYER_ASSET_PATHS.has(pathname) && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Player assets are not configured' }, 503);
      }
      const assetRes = await env.ASSETS.fetch(new Request(new URL(pathname, url.origin), { method: 'GET' }));
      if (!assetRes.ok) {
        return jsonResponse({ ok: false, error: 'Player asset is unavailable' }, assetRes.status);
      }
      // The player bundle (embed.js / embed.css) must revalidate so a server
      // rebrand or player fix reaches viewers on their next load instead of
      // being pinned for a day behind max-age. Vendor libraries keep the long TTL.
      const isPlayerBundle = pathname === '/js/embed.js' || pathname === '/css/embed.css';
      const headers = new Headers();
      headers.set('Cache-Control', isPlayerBundle ? 'no-cache' : 'public, max-age=86400, stale-while-revalidate=604800');
      headers.set('Access-Control-Allow-Origin', '*');
      for (const headerName of ['Content-Type', 'ETag', 'Last-Modified']) {
        const value = assetRes.headers.get(headerName);
        if (value) headers.set(headerName, value);
      }
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    // The social/meta image stays browser-addressable.
    if (pathname === '/meta-image.gif' && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Meta-image asset is not configured' }, 503);
      }
      const assetReq = new Request(new URL('/lol-embed-meta.gif', url.origin), request);
      const assetRes = await env.ASSETS.fetch(assetReq);
      if (!assetRes.ok) {
        return jsonResponse({ ok: false, error: 'Meta-image asset is unavailable' }, assetRes.status);
      }
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Type', 'image/gif');
      headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    // `/` stays a JSON service descriptor for API clients — the main website
    // is a separate project and is not served from this Worker.
    if (pathname === '/' && request.method === 'GET') {
      // Easter egg: a human opening the Worker URL in a browser (Accept:
      // text/html) gets rickrolled; every non-browser client keeps the JSON.
      const acceptHeader = request.headers.get('accept') || '';
      if (acceptHeader.includes('text/html')) {
        return new Response(RICKROLL_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return jsonResponse({
        ok: true,
        brand: 'LOL Embed',
        service: 'lol-embed-backend',
        runtime: 'cloudflare-workers-edge',
        mode: 'player-and-api',
        version: '2.2.0',
        embed: '/embed',
        api: '/api',
        health: '/api/health',
        metaImage: '/meta-image.gif'
      });
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  }
};
