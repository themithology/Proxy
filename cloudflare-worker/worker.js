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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SERVERS = [
  { id: 'andromeda', name: 'Andromeda', badge: 'Primary • Multi-Audio HLS', priority: 1, enabled: true, supportsMultiAudio: true },
  { id: 'ursa', name: 'Ursa', badge: 'VidSrc • Fast CDN HLS', priority: 2, enabled: true, supportsMultiAudio: false },
  { id: 'centaurus', name: 'Centaurus', badge: 'HiCine • Direct 1080p/720p MP4', priority: 3, enabled: true, supportsMultiAudio: true },
  { id: 'atlas', name: 'Atlas', badge: 'ZXC Backup • Adaptive HLS', priority: 4, enabled: true, supportsMultiAudio: true },
  { id: 'strings', name: 'Strings', badge: 'Anime Sub/Dub • Zoko HLS', priority: 5, enabled: true, supportsMultiAudio: true }
];

// Runtime-editable Upstream Config & Telemetry State in Cloudflare Worker
const runtimeState = {
  startedAt: new Date().toISOString(),
  upstreams: {
    vidstuckBase: 'https://vidstuck.xyz',
    zxcBase: 'https://zxcstream.icu',
    vidsrcDataUrl: 'https://data.vidsrc.sh/api.php',
    hicineApiBase: 'https://api.hicine.sbs',
    hianimeBase: 'https://hianime.at'
  },
  zxcAesKey: '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c',
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
    zxcAesKey: runtimeState.zxcAesKey,
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
  let result = null;

  try {
    const detailsRes = await fetch(
      `https://api.themoviedb.org/3/${normalizedType}/${cleanId}?api_key=${encodeURIComponent(tmdbKey)}&append_to_response=external_ids&language=en-US`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
    );
    if (detailsRes.ok) {
      const data = await detailsRes.json();
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
          `https://api.themoviedb.org/3/tv/${cleanId}/season/${sNum}?api_key=${encodeURIComponent(tmdbKey)}&language=en-US`,
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
      episode: eNum
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
 * 4. Upstream Stream Extractors (Andromeda/Atlas, Ursa/VidSrc, Centaurus/HiCine, Strings/HiAnime)
 */

/**
 * vidstuck.xyz backend "keys": the player talks to its own API with randomly
 * obfuscated JSON-field / query-parameter names (anti-bot obfuscation baked into
 * their bundle). These are field names, not secrets — the exact same constants
 * are mirrored by vicine v1.5.2's zxc provider:
 *
 *   POST /backend/meow          { <UO>: tmdbId, <UP>: type, <UG>: server }
 *   GET  /backend/servers/:id?  <UO>=id&<UG>=server&<UP>=type&<UL>=ts&<UU>=token
 *                               &<UD>=title&<UC>=year&<UM>=releaseDate&<IM>=imdbId
 *   -> links[0].link is an OpenSSL AES-256-CBC (md5 EVP_BytesToKey) base64 blob
 *      whose plaintext is the internal stream path.
 *
 * The backend rejects every request that does not carry
 * `Origin`/`Referer: https://vidstuck.xyz`.
 */
const ZXC_UO = 'a7f39c821d604e5b9c71f36e1547b'; // tmdb id
const ZXC_UP = 'c285f91ab306d28147a35632e816b'; // media type (movie|tv)
const ZXC_UG = '6b491e7253ad84d392e7561a9384c'; // server id (andromeda|atlas)
const ZXC_UL = '61d9a5274c8e3b29afd6384c291e6'; // token timestamp from /backend/meow
const ZXC_UU = 'c492f7a183d6502b1e7436c538a716d'; // session token from /backend/meow
const ZXC_UD = '5e28c9147a306d1e829f3674b392a1'; // title
const ZXC_UC = 'b731e6c94f08269d725f8341c306e'; // release year
const ZXC_UM = 'e164932c50216a39e5814b3027'; // release date (YYYY-MM-DD)
const ZXC_IM = 'f35a8c19d674b3265e871c4933a725f'; // imdb id

const ZXC_AES_KEY_DEFAULT =
  '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';

/**
 * Sniff the real container of a resolved stream URL (HLS vs DASH vs progressive
 * MP4). VidStuck hands out `/backend/...` paths with no extension, so the only
 * reliable signal is the upstream `Content-Type` + post-redirect URL.
 */
async function sniffStreamFormat(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-2047' },
      redirect: 'follow'
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const finalUrl = res.url || url;
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    } catch {}
    const format =
      contentType.includes('dash') || /\.mpd(\?|$)/i.test(finalUrl)
        ? 'dash'
        : contentType.includes('mpegurl') ||
            contentType.includes('m3u8') ||
            /\.m3u8(\?|$)/i.test(finalUrl)
          ? 'hls'
          : /\.(mp4|mkv|m4v)(\?|$)/i.test(finalUrl)
            ? 'mp4'
            : '';
    return { format, finalUrl };
  } catch {
    return { format: '', finalUrl: url };
  }
}

async function resolveVidstuckUpstream(metadata, serverId, env) {
  // Internal diagnostic — every failure branch stamps a stage + reason so
  // the owner debug endpoint can tell us exactly where the upstream broke.
  // We never throw / swallow silently anymore: we always return either
  // { server, format, streamUrl, ... } on success or
  // { ok: false, reason, diag } on failure. The dispatcher in
  // resolveWorkerStream picks this up and aggregates it.
  const diag = { stage: 'init', steps: [] };
  const stamp = (stage, message, extra) => {
    diag.stage = stage;
    diag.steps.push({ stage, message, ...(extra || {}) });
    diag.message = message;
  };
  stamp('init', `resolveVidstuckUpstream(server=${serverId})`);

  try {
    const isTv = metadata.type === 'tv';
    const apiBase = 'https://vidstuck.xyz';
    const referer = `${apiBase}/`;
    const aesKey = env?.ZXC_AES_KEY || runtimeState.zxcAesKey || ZXC_AES_KEY_DEFAULT;

    // Step 1: earn the Cloudflare/session cookies the vidstuck backend requires
    const [zxcWarm, embedWarm] = await Promise.all([
      fetch('https://zxcstream.icu/movie', {
        headers: { 'User-Agent': USER_AGENT, Referer: 'https://zxcstream.icu/' }
      }).catch(() => null),
      fetch(`${apiBase}/embed/${isTv ? 'tv' : 'movie'}/${encodeURIComponent(metadata.tmdbId)}`, {
        headers: { 'User-Agent': USER_AGENT, Referer: referer }
      }).catch(() => null)
    ]);
    const cookieParts = [];
    for (const res of [zxcWarm, embedWarm]) {
      if (!res) continue;
      const list =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of list) cookieParts.push(String(c).split(';')[0]);
    }
    const cookie = Array.from(new Set(cookieParts)).join('; ');
    const baseHeaders = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Origin: 'https://vidstuck.xyz',
      Referer: referer,
      ...(cookie ? { Cookie: cookie } : {})
    };

    // Step 2: details (title / release date / imdb id) — feeds the servers query
    let title = metadata.title || '';
    let releaseDate = '';
    let imdbId = '';
    const detRes = await fetch(
      `${apiBase}/backend/tmdb/details/${isTv ? 'tv' : 'movie'}/${encodeURIComponent(metadata.tmdbId)}?language=en-US`,
      { headers: baseHeaders }
    ).catch(() => null);
    if (detRes?.ok) {
      const det = await detRes.json().catch(() => null);
      if (det) {
        title = det.title || det.name || title;
        releaseDate = det.release_date || det.first_air_date || '';
        imdbId = det.imdb_id || det.external_ids?.imdb_id || '';
      }
    }
    const releaseYear = String(
      metadata.releaseYear || (releaseDate ? releaseDate.slice(0, 4) : '') || ''
    );
    if (!releaseDate) releaseDate = releaseYear;

    // Step 3: /backend/meow -> { token, ts }
    const meowBody = {
      [ZXC_UO]: String(metadata.tmdbId),
      [ZXC_UP]: isTv ? 'tv' : 'movie',
      [ZXC_UG]: serverId
    };
    // The published client bundle only covers movies; TV keeps the plain
    // season/episode fields the older API accepted.
    if (isTv) {
      meowBody.season = String(metadata.season || 1);
      meowBody.episode = String(metadata.episode || 1);
    }

    const meowRes = await fetch(`${apiBase}/backend/meow`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(meowBody)
    }).catch(() => null);
    if (!meowRes?.ok) {
      stamp('meow', `VidStuck /backend/meow returned HTTP ${meowRes ? meowRes.status : 0}. Upstream is blocking the request (often a stale Origin/Referer or dead session).`);
      return { ok: false, reason: meowRes ? `meow_${meowRes.status}` : 'meow_unreachable', diag };
    }
    const meow = await meowRes.json().catch(() => null);
    if (!meow?.token) {
      stamp('meow_token', 'VidStuck /backend/meow responded 200 but no session token was returned (upstream contract changed or key is stale).');
      return { ok: false, reason: 'meow_no_token', diag };
    }

    // Step 4: /backend/servers/:serverId -> links[0].link
    const qs = new URLSearchParams({
      [ZXC_UO]: String(metadata.tmdbId),
      [ZXC_UG]: serverId,
      [ZXC_UP]: isTv ? 'tv' : 'movie',
      ...(meow.ts ? { [ZXC_UL]: String(meow.ts) } : {}),
      [ZXC_UU]: String(meow.token),
      [ZXC_UD]: title,
      [ZXC_UC]: releaseYear,
      [ZXC_UM]: releaseDate
    });
    if (imdbId) qs.set(ZXC_IM, imdbId);
    if (isTv) {
      qs.set('season', String(metadata.season || 1));
      qs.set('episode', String(metadata.episode || 1));
    }

    const srvRes = await fetch(
      `${apiBase}/backend/servers/${encodeURIComponent(serverId)}?${qs.toString()}`,
      { headers: baseHeaders }
    ).catch(() => null);
    if (!srvRes?.ok) {
      stamp('servers_lookup', `VidStuck /backend/servers/${serverId} returned HTTP ${srvRes ? srvRes.status : 0}. Token probably expired or this server is not provisioned for this title.`);
      return { ok: false, reason: srvRes ? `servers_${srvRes.status}` : 'servers_unreachable', diag };
    }
    const srvJson = await srvRes.json().catch(() => null);
    const encLink = srvJson?.links?.[0]?.link || srvJson?.data?.link || srvJson?.link;
    if (!encLink) {
      stamp('servers_empty', `VidStuck has no stream link for this title on server "${serverId}" (it may be missing in their catalog or restricted by region).`);
      return { ok: false, reason: 'servers_no_link', diag };
    }

    // Step 5: AES-256-CBC decrypt the internal stream path
    let rawUrl = String(encLink);
    if (!/^https?:\/\//i.test(rawUrl)) {
      const dec = decryptOpenSslAes256Cbc(rawUrl, aesKey);
      if (dec) {
        rawUrl = dec.startsWith('http')
          ? dec
          : `${apiBase}${dec.startsWith('/') ? '' : '/'}${dec}`;
      } else if (rawUrl.startsWith('/')) {
        rawUrl = `${apiBase}${rawUrl}`;
      } else {
        stamp('aes_decrypt', 'AES-256-CBC decryption of the stream link failed. The ZXC_AES_KEY has likely been rotated by the upstream.');
        return { ok: false, reason: 'aes_decrypt_failed', diag };
      }
    }

    // Step 6: playable container? (VidStuck serves DASH/HLS from the same path)
    let format = /\.mpd(\?|$)/i.test(rawUrl)
      ? 'dash'
      : /\.(mp4|mkv|m4v)(\?|$)/i.test(rawUrl)
        ? 'mp4'
        : '';
    if (!format) {
      const sniff = await sniffStreamFormat(rawUrl, baseHeaders);
      format = sniff.format || 'hls';
    }

    // The vidstuck backend is Origin/Referer gated (and needs the session
    // cookie), so the stream is streamed through this Worker's /api/proxy.
    const streamUrl = buildWorkerProxyUrl(rawUrl, referer, 'full', cookie);
    const upstreamAudioTracks = Array.isArray(srvJson?.data?.audioTracks)
      ? srvJson.data.audioTracks
      : [];
    const upstreamDefaultAudioIndex = upstreamAudioTracks.findIndex(
      (track) => track.default === true || track.default === 1 || track.default === '1'
    );
    const audioTracks = upstreamAudioTracks.length
      ? upstreamAudioTracks.map((track, index) => {
          let trackRawUrl = rawUrl;
          if (track.url) {
            try {
              trackRawUrl = new URL(track.url, apiBase).toString();
            } catch {
              trackRawUrl = rawUrl;
            }
          }
          return {
            id: track.id || `audio-${index}`,
            lang: track.lang || 'en',
            label: track.label || track.name || `Audio ${index + 1}`,
            type: track.type || 'sub',
            streamUrl: track.url
              ? buildWorkerProxyUrl(trackRawUrl, referer, 'full', cookie)
              : streamUrl,
            rawUrl: trackRawUrl,
            default: upstreamDefaultAudioIndex === -1
              ? index === 0
              : index === upstreamDefaultAudioIndex
          };
        })
      : [
          {
            id: 'orig',
            lang: 'en',
            label: 'Original Audio',
            type: 'sub',
            streamUrl,
            rawUrl,
            default: true
          }
        ];

    return {
      server: serverId,
      format,
      rawUrl,
      streamUrl,
      referer,
      headers: { Referer: referer, Origin: apiBase },
      backupUrls: [buildWorkerProxyUrl(rawUrl, referer, 'manifest', cookie)],
      audioTracks,
      qualities: [{ label: 'Auto', height: 0, url: streamUrl }]
    };
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
    stamp(
      isAbort ? 'timeout' : 'exception',
      isAbort
        ? `Timed out talking to VidStuck upstream. The host may be unreachable from this region.`
        : `Unhandled error talking to VidStuck upstream: ${err && err.message ? err.message : 'unknown'}`
    );
    return { ok: false, reason: isAbort ? 'upstream_timeout' : 'upstream_exception', diag };
  }
}

/**
 * Ursa (VidSrc.sh) WASM envelope handoff marker.
 *
 * Cloudflare Workers V8 isolates refuse runtime `WebAssembly.compile()`
 * ("CompileError: Wasm code generation disallowed by embedder"), while a
 * browser client may allow it. When decryption cannot happen on the edge, the
 * raw envelope is returned in the stream payload for a trusted client to handle.
 */
const VSRC_WASM_ENVELOPE_URL = 'vidsrc://wasm-envelope';
const VSRC_REFERER = 'https://vidsrc.sh/';

async function resolveVidsrcUpstream(metadata) {
  try {
    const isTv = metadata.type === 'tv';
    const qs = isTv
      ? `type=tv&tmdb=${metadata.tmdbId}&season=${metadata.season || 1}&episode=${metadata.episode || 1}&stream_urls`
      : `type=movie&tmdb=${metadata.tmdbId}&stream_urls`;
    const referer = VSRC_REFERER;
    const res = await fetch(`https://data.vidsrc.sh/api.php?${qs}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Referer: referer }
    });
    if (!res.ok) return null;
    const json = await res.json();

    let urls = [];
    let vsEnvelope = null;

    if (Array.isArray(json?.data?.stream_urls)) {
      urls = json.data.stream_urls;
    } else if (typeof json?.data?.stream_urls === 'string' && json?.vs) {
      let wasmBytes = null;
      if (json.vs.wasm) {
        wasmBytes = Buffer.from(json.vs.wasm, 'base64');
      } else if (json.vs.wasm_url) {
        const wRes = await fetch(json.vs.wasm_url, {
          headers: { 'User-Agent': USER_AGENT, Referer: referer }
        });
        if (wRes.ok) wasmBytes = Buffer.from(await wRes.arrayBuffer());
      }
      if (wasmBytes) {
        try {
          const mod = await WebAssembly.compile(wasmBytes);
          const inst = await WebAssembly.instantiate(mod, {
            env: { emscripten_notify_memory_growth() {} }
          });
          const ex = inst.exports;
          const mem = ex.memory;
          if (typeof ex.key === 'function') {
            const kp = ex.key();
            const kb = new Uint8Array(mem.buffer, kp, 32);
            const kh = '91d803885852299907d44c2f92822699c62f8b0f0a5c8d208190e0f102131415';
            for (let i = 0; i < 32; i++) kb[i] = parseInt(kh.slice(i * 2, i * 2 + 2), 16);
          }
          const nonceStr = isTv
            ? `${metadata.tmdbId}_${metadata.season || 1}_${metadata.episode || 1}`
            : `stream_urls:${metadata.tmdbId}`;
          const nb = Buffer.from(nonceStr, 'utf8');
          const np = (typeof ex.alloc === 'function' ? ex.alloc : ex.malloc)(nb.length + 1);
          new Uint8Array(mem.buffer).set(nb, np);
          new Uint8Array(mem.buffer)[np + nb.length] = 0;
          ex.nonce(np);
          if (typeof ex.free === 'function') ex.free(np);

          // vicine v1.5.2 ABI: decrypt(ptr, len) returns the plaintext length and
          // the UTF-8 payload starts at `ptr + 12` (v1.5.x dropped the `malloc`
          // return-value convention and the NUL-terminated string read).
          const raw = Buffer.from(json.data.stream_urls, 'base64');
          const ptr = (typeof ex.alloc === 'function' ? ex.alloc : ex.malloc)(raw.length);
          new Uint8Array(mem.buffer, ptr, raw.length).set(raw);
          const len = ex.decrypt(ptr, raw.length);
          const decoded = new TextDecoder().decode(
            new Uint8Array(mem.buffer, ptr + 12, len)
          );
          const parsed = JSON.parse(decoded);
          if (Array.isArray(parsed)) urls = parsed;
        } catch {
          // "Wasm code generation disallowed by embedder" (Workers V8 isolates)
          // or an unexpected ABI — hand the envelope to the browser instead.
        }
      }

      if (urls.length === 0) {
        vsEnvelope = {
          streamUrls: json.data.stream_urls,
          wasmUrl: json.vs.wasm_url
            ? buildWorkerProxyUrl(json.vs.wasm_url, referer)
            : null,
          wasmBase64: json.vs.wasm || null
        };
      }
    }

    urls = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));

    // Browser-side WASM assist: the edge could not run WebAssembly.compile, so
    // ship the sealed envelope to the player and let it decrypt + stream.
    if (urls.length === 0 && vsEnvelope) {
      return {
        server: 'ursa',
        format: 'hls',
        rawUrl: VSRC_WASM_ENVELOPE_URL,
        streamUrl: VSRC_WASM_ENVELOPE_URL,
        referer,
        headers: {},
        transport: 'browser-wasm',
        vsEnvelope,
        audioTracks: [
          {
            id: 'vidsrc-orig',
            lang: 'en',
            label: 'Original Audio',
            type: 'sub',
            streamUrl: VSRC_WASM_ENVELOPE_URL,
            rawUrl: VSRC_WASM_ENVELOPE_URL,
            default: true
          }
        ],
        qualities: [{ label: 'Auto', height: 0, url: VSRC_WASM_ENVELOPE_URL }]
      };
    }

    if (urls.length === 0) return null;

    // VidSrc stream hosts require a per-host JWT (IP bound, ~4h). Plain-text
    // JWTs and `{"token": "..."}` JSON are both in the wild.
    let vsToken = '';
    try {
      const origin = new URL(urls[0]).origin;
      const genRes = await fetch(`${origin}/generate.php`, {
        headers: { 'User-Agent': USER_AGENT, Referer: referer }
      });
      if (genRes.ok) {
        const genText = (await genRes.text()).trim();
        if (genText.startsWith('{')) {
          vsToken = JSON.parse(genText)?.token || '';
        } else {
          vsToken = genText.replace(/^["']|["']$/g, '');
        }
      }
    } catch {}

    const stampUrl = (u) =>
      !vsToken
        ? u
        : u.includes('__TOKEN__')
          ? u.replace(/__TOKEN__/g, encodeURIComponent(vsToken))
          : `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(vsToken)}`;

    const stamped = urls.map(stampUrl);
    const rawUrl = stamped[0];
    // token=<JWT> makes the upstream CDN Origin/Referer + JWT gated.
    const streamUrl = buildWorkerProxyUrl(rawUrl, referer, 'full');

    const toQuality = (u, idx) => ({
      label: idx === 0 ? '1080p' : idx === 1 ? '720p' : `Mirror ${idx + 1}`,
      height: idx === 0 ? 1080 : 720,
      url: buildWorkerProxyUrl(u, referer, 'full')
    });

    return {
      server: 'ursa',
      format: rawUrl.includes('.mp4') || rawUrl.includes('.mkv') ? 'mp4' : 'hls',
      rawUrl,
      streamUrl,
      referer,
      headers: {},
      vsToken,
      backupUrls: [
        buildWorkerProxyUrl(rawUrl, referer, 'manifest'),
        rawUrl,
        ...stamped.slice(1).map((u) => buildWorkerProxyUrl(u, referer, 'manifest'))
      ],
      audioTracks: [
        { id: 'vidsrc-orig', lang: 'en', label: 'Original Audio', type: 'sub', streamUrl, rawUrl, default: true }
      ],
      qualities: [
        { label: 'Auto', height: 0, url: streamUrl },
        ...stamped.map(toQuality)
      ]
    };
  } catch {
    return null;
  }
}

/**
 * Unwrap a `/go` redirect wrapper: `ten` links bounce through
 * `https://gamerxyt.com/dl.php?link=https://video-downloads.googleusercontent.com/...`
 * and the inner Google CDN URL is the real, never hotlink-blocked stream.
 */
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
const HUBCLOUD_UNROLL_BUDGET_MS = 4500; // hard cap per resolve-step
const HUBCLOUD_UNROLL_BODY_CAP = 600 * 1024;
const HUBCLOUD_UNROLL_ALT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const hubcloudUnrollCache = new Map(); // generatorUrl -> { direct, exp }

function isHubcloudGeneratorUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return (
      /(^|\.)hubcloud\./.test(host) ||
      /(^|\.)hubcdn\./.test(host) ||
      /(^|\.)gamerxyt\.com$/.test(host) ||
      /^gpdl\d*\./.test(host) ||
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
function extractHttpLinkParam(u) {
  const m = String(u || '').match(/[?&]link=([^&#\s]+)/i);
  if (!m) return '';
  const raw = m[1];
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* malformed encoding — keep raw */
  }
  return '';
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
  if (/(^|\.)video-downloads\.googleusercontent\.com$/.test(host)) return 100;
  if (/(^|\.)r2\.dev$/.test(host)) return 95;
  if (/\.(cloudflarestorage\.com|cloudfront\.net)$/.test(host)) return 90;
  if (/(^|\.)workers\.dev$/.test(host)) return 85;
  if (/\.(mp4|mkv|webm|m4v|m3u8|mpd)([?#]|$)/i.test(href)) return 80;
  if (/(^|\.)pixeldrain\.(com|dev)$/.test(host) && /^\/(u|api\/file)\/[A-Za-z0-9]+/.test(pathname)) {
    return 70;
  }
  return -1;
}

/** Pixeldrain share pages `/u/ID` → direct API endpoint `/api/file/ID`. */
function normalizePlayableUrl(u) {
  try {
    const url = new URL(u);
    if (/(^|\.)pixeldrain\.(com|dev)$/.test(url.hostname.toLowerCase())) {
      const m = url.pathname.match(/^\/u\/([A-Za-z0-9]+)/);
      if (m) return `${url.origin}/api/file/${m[1]}`;
    }
    return url.href;
  } catch {
    return u;
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
  for (const m of normalized.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    tryAdd(m[0].replace(/[.,;:]+$/, ''));
  }
  for (const m of normalized.matchAll(/\batob\(\s*["']([A-Za-z0-9+/=]{16,})["']\s*\)/g)) {
    try {
      const decoded = atob(m[1]);
      for (const d of decoded.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
        tryAdd(d[0].replace(/[.,;:]+$/, ''));
      }
    } catch {
      /* not base64 */
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
  let direct = null;
  let directScore = -1;
  let generator = null;
  for (const cand of collectGeneratorCandidates(html, pageUrl)) {
    if (cand === pageUrl) continue;
    if (isHubcloudGeneratorUrl(cand) || extractHttpLinkParam(cand)) {
      if (!generator) generator = cand;
      continue;
    }
    const score = scorePlayableUrl(cand);
    if (score > directScore) {
      direct = cand;
      directScore = score;
    }
  }
  if (directScore >= 0) return { direct: normalizePlayableUrl(direct), generator: null };
  return { direct: null, generator };
}

/**
 * Fetch with a hard deadline: `deadline` (epoch ms) bounds the whole unroll,
 * `outerSignal` (when present) aborts together with the caller's controller.
 */
async function fetchWithDeadline(url, userAgent, outerSignal, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 400 || outerSignal?.aborted) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(3500, remaining));
  const onAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener?.('abort', onAbort);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
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

/** Follow one `?link=` hop: recurse into wrappers, accept terminal URLs. */
async function resolveLinkInner(inner, opts) {
  if (!inner) return null;
  if (isHubcloudGeneratorUrl(inner)) {
    return unrollHubcloudUrl(inner, { ...opts, depth: opts.depth + 1 });
  }
  if (scorePlayableUrl(inner) >= 0) return normalizePlayableUrl(inner);
  return null;
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

  const cached = hubcloudUnrollCache.get(startUrl);
  if (cached) {
    if (Date.now() < cached.exp) return cached.direct;
    hubcloudUnrollCache.delete(startUrl);
  }

  const deadline = options.deadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS;
  const direct = await unrollHubcloudUncached(startUrl, {
    signal: options.signal,
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
  const { signal, depth, deadline } = opts;
  try {
    // 1) `dl.php?link=…` wrappers carry the final URL in the query string —
    //    no fetch needed at all when the Location itself is one.
    const entryInner = extractHttpLinkParam(startUrl);
    if (entryInner) {
      const resolved = await resolveLinkInner(entryInner, opts);
      if (resolved) return resolved;
    }

    // 2) fetch the generator page, following HTTP redirects (some generator
    //    hosts 302 straight to `dl.php?link=<direct>` — no JS involved).
    const res = await fetchWithDeadline(startUrl, USER_AGENT, signal, deadline);
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
      // binary body after redirect → the final URL itself is the file
      return scorePlayableUrl(finalUrl) >= 0 ? normalizePlayableUrl(finalUrl) : null;
    }

    // 3) scan the raw landing HTML for the final CDN link — it is present in
    //    the source even while the countdown hides it (meta-refresh target,
    //    inline script, hidden/JS-filled anchor, atob payload).
    let html = '';
    if (res.ok) {
      html = await readCappedText(res);
      if (isCfChallengePage(html)) html = ''; // challenge interstitial — no links
    }
    const pick = pickFromGeneratorHtml(html, finalUrl);
    if (pick.direct) return pick.direct;
    if (pick.generator && pick.generator !== startUrl) {
      const next = await unrollHubcloudUrl(pick.generator, { ...opts, depth: depth + 1 });
      if (next) return next;
    }

    // 4) last resort: some generator hosts serve the countdown page to browser
    //    UAs but 302 directly for crawlers — retry once with a non-browser UA.
    if (depth === 0 && Date.now() < deadline - 1200 && !signal?.aborted) {
      const retry = await fetchWithDeadline(startUrl, HUBCLOUD_UNROLL_ALT_UA, signal, deadline);
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
        if (rPick.direct) return rPick.direct;
        if (rPick.generator && rPick.generator !== startUrl) {
          const next = await unrollHubcloudUrl(rPick.generator, { ...opts, depth: depth + 1 });
          if (next) return next;
        }
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

async function resolveHicineUpstream(metadata) {
  if (!metadata.title) return null;
  try {
    // Shared HubCloud-unroll budget: qualities resolve sequentially, so one
    // deadline (not per-hop timeouts) keeps the whole step inside the 9s
    // waterfall slot even when a generator page stalls.
    const unrollDeadline = Date.now() + 5000;
    const apiBase = 'https://api.hicine.sbs';
    const res = await fetch(`${apiBase}/api/search/${encodeURIComponent(metadata.title)}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
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
      const found = workerMatches.length > 0 ? workerMatches : directMatches;
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
        if (!vcloud) return null;

        const lRes = await fetch(`${url.origin}/api/links?vcloud=${encodeURIComponent(vcloud)}`, {
          headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
        });
        if (!lRes.ok) return null;
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
              const goRes = await fetch(
                `${url.origin}/go?type=${tType}&vcloud=${encodeURIComponent(vcloud)}&ts=${encodeURIComponent(tok.ts)}&sig=${encodeURIComponent(tok.sig)}`,
                { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' }
              );
              let loc = goRes.headers.get('location');
              if (!loc || !/^https?:\/\//i.test(loc)) return null;

              // Root Cause E: HubCloud link generators (`gpdl2.hubcloud.ist/?id=…`,
              // `gamerxyt.com/dl.php?link=…`, nested `hubcloud.<tld>/drive/<id>` pages) are
              // countdown HTML, not media — unroll them server-side to the real CDN
              // file before anything reaches `<video src>`.
              let unrollFailed = false;
              if (isHubcloudGeneratorUrl(loc) || extractHttpLinkParam(loc)) {
                const direct = await unrollHubcloudUrl(loc, { deadline: unrollDeadline });
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
                const pdId = loc.split('/u/')[1].split(/[?#]/)[0];
                if (pdId) loc = `https://pixeldrain.dev/api/file/${pdId}`;
              }

              let isHotlinkBlocked = unrollFailed;
              if (/pixeldrain\.(?:dev|com)\/api\/file\//i.test(loc)) {
                // Probe first: Pixeldrain answers 200
                // {"success":false,"value":"hotlink_detected"} for foreign referers.
                try {
                  const probe = await fetch(loc, {
                    headers: {
                      Accept: '*/*',
                      'User-Agent': USER_AGENT,
                      Range: 'bytes=0-64'
                    }
                  });
                  const probeText = (await probe.text()).slice(0, 400).toLowerCase();
                  if (
                    !probe.ok ||
                    probeText.includes('hotlink_detected') ||
                    probeText.includes('"success":false') ||
                    probeText.includes('captcha')
                  ) {
                    isHotlinkBlocked = true;
                  }
                } catch {
                  isHotlinkBlocked = true;
                }
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
  }
}

/**
 * Server priority for the automatic waterfall on Cloudflare Workers.
 * Centaurus first (single CDN request, direct MP4, sub-400ms), then Ursa, then
 * the heavier VidStuck/ZXC session dance (Andromeda/Atlas), Strings last.
 */
const WATERFALL_PRIORITY = ['centaurus', 'ursa', 'andromeda', 'atlas', 'strings'];
/** Hard per-upstream budget: the waterfall must stay fast and deterministic. */
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
  const validServer = SERVERS.find((s) => s.id === requestedServer)?.id || 'centaurus';
  const cacheKey = `cf:resolve:${metadata.type}:${metadata.tmdbId}:s${metadata.season}:e${metadata.episode}:${validServer}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const enabledIds = SERVERS.filter((s) => s.enabled).map((s) => s.id);
  // Default (and fallback) order: centaurus -> ursa -> andromeda -> atlas -> strings.
  // An explicitly requested server is still attempted first and remains authoritative.
  const prioritized = [
    ...WATERFALL_PRIORITY.filter((id) => enabledIds.includes(id)),
    ...enabledIds.filter((id) => !WATERFALL_PRIORITY.includes(id))
  ];
  const order = [validServer, ...prioritized.filter((id) => id !== validServer)];

  // Per-server diagnostic aggregation for API responses and the owner debug endpoint.
  const serverAttempts = [];

  for (const srvId of order) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'andromeda' || srvId === 'atlas') {
      resolved = await withTimeout(
        resolveVidstuckUpstream(metadata, srvId, env),
        WATERFALL_UPSTREAM_TIMEOUT_MS
      );
    } else if (srvId === 'ursa') {
      resolved = await withTimeout(
        resolveVidsrcUpstream(metadata),
        WATERFALL_UPSTREAM_TIMEOUT_MS
      );
    } else if (srvId === 'centaurus') {
      resolved = await withTimeout(
        resolveHicineUpstream(metadata),
        WATERFALL_UPSTREAM_TIMEOUT_MS
      );
    }
    const latencyMs = Date.now() - t0;

    if (resolved && resolved.streamUrl) {
      const payload = {
        ...resolved,
        requestedServer: validServer,
        servers: SERVERS.map((s) => ({ ...s, active: s.id === resolved.server }))
      };
      await edgeCacheSet(cacheKey, payload, 900);
      return payload;
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
    reason: 'all_servers_failed',
    serverAttempts,
    servers: SERVERS.map((s) => ({ ...s, active: false }))
  };
}

/**
 * 5. M3U8 Manifest Rewriter & Edge Stream Proxy
 */
/**
 * Per-host JWT cache for VidSrc-style stream hosts (`<host>/generate.php`).
 * Tokens are IP bound with a ~4h TTL, so a 10 minute edge cache is safe and
 * keeps the waterfall within the sub-400ms budget.
 */
const jwTokenCache = new Map();

async function fetchVidsrcHostToken(hostOrigin, referer = VSRC_REFERER) {
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

  // JWT stamping for X-frame/Origin gated hosts: `vidsrcStamp=1` (or an
  // __TOKEN__ placeholder in the URL) triggers a <host>/generate.php lookup.
  let token = passthroughToken;
  if (vidsrcStamp || targetUrl.includes('__TOKEN__')) {
    token = token || (await fetchVidsrcHostToken(parsed.origin, referer));
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
          { serverId: 'ursa', url: `${runtimeState.upstreams.vidsrcDataUrl}?type=tv&tmdb=94605&season=1&episode=1&stream_urls`, headers: { Referer: 'https://vidsrc.sh/' } },
          { serverId: 'centaurus', url: `${runtimeState.upstreams.hicineApiBase}/api/search/arcane` },
          { serverId: 'atlas', url: `${runtimeState.upstreams.zxcBase}/movie` },
          { serverId: 'strings', url: `${runtimeState.upstreams.hianimeBase}/search?keyword=arcane` }
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

      // Owner-only diagnostic for server 1 (Andromeda / VidStuck). Walks the
      // EXACT production code path and returns the structured failure reason
      // so the owner can see whether the upstream is dead, the AES key
      // rotated, the catalog is missing this title, etc.
      const andromedaDebugMatch = pathname.match(/^\/api\/debug\/andromeda\/(movie|tv)\/([^/]+)$/);
      if (andromedaDebugMatch && request.method === 'GET') {
        const [, dbgType, dbgTmdb] = andromedaDebugMatch;
        const dbgSeason = parseInt(url.searchParams.get('season') || '1', 10);
        const dbgEpisode = parseInt(url.searchParams.get('episode') || '1', 10);
        try {
          const meta = await resolveTmdbMetadata(dbgType, dbgTmdb, dbgSeason, dbgEpisode);
          // Bypass the waterfall: ask the andromeda resolver directly so the
          // diag reflects ONLY what server 1 saw, not what the next 4 did.
          const direct = await withTimeout(
            resolveVidstuckUpstream(meta, 'andromeda', env),
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
              vidstuckBase: runtimeState.upstreams.vidstuckBase,
              zxcBase: runtimeState.upstreams.zxcBase,
              aesKeySet: !!(env && env.ZXC_AES_KEY) || !!runtimeState.zxcAesKey,
              tmdbKeySet: !!(env && env.TMDB_API_KEY)
            },
            result: direct
          });
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      }

      if (pathname === '/api/admin/upstreams' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (body.upstreams && typeof body.upstreams === 'object') {
          for (const [k, v] of Object.entries(body.upstreams)) {
            if (typeof v === 'string' && v.trim() && k in runtimeState.upstreams) {
              runtimeState.upstreams[k] = v.trim().replace(/\/$/, '');
            }
          }
        }
        if (typeof body.zxcAesKey === 'string' && body.zxcAesKey.trim()) {
          runtimeState.zxcAesKey = body.zxcAesKey.trim();
        }
        if (typeof body.externalProxyPool === 'string') {
          runtimeState.externalProxyPool = body.externalProxyPool
            .split(',')
            .map((s) => s.trim().replace(/\/$/, ''))
            .filter(Boolean);
        }
        if (Array.isArray(body.servers)) {
          for (const u of body.servers) {
            const s = SERVERS.find((x) => x.id === u.id);
            if (s) {
              if (typeof u.enabled === 'boolean') s.enabled = u.enabled;
              if (typeof u.priority === 'number') s.priority = u.priority;
            }
          }
          SERVERS.sort((a, b) => (a.priority || 99) - (b.priority || 99));
        }
        return jsonResponse({ ok: true, snapshot: getWorkerAdminSnapshot() });
      }

      if (pathname === '/api/admin/domains/block' && request.method === 'POST') {
        const { domain, blocked = true } = await request.json().catch(() => ({}));
        const clean = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
        if (clean) {
          if (blocked) runtimeState.blockedDomains.add(clean);
          else runtimeState.blockedDomains.delete(clean);
        }
        return jsonResponse({ ok: true, snapshot: getWorkerAdminSnapshot() });
      }

      if (pathname === '/api/admin/overrides' && request.method === 'POST') {
        const { type = 'movie', tmdbId, season = 1, episode = 1, streamUrl, label = 'Custom' } =
          await request.json().catch(() => ({}));
        if (tmdbId && streamUrl) {
          const normType = type === 'tv' ? 'tv' : 'movie';
          const key = normType === 'tv' ? `tv:${tmdbId}:${season}:${episode}` : `movie:${tmdbId}:1:1`;
          runtimeState.customOverrides.set(key, {
            key,
            type: normType,
            tmdbId: String(tmdbId),
            season: Number(season),
            episode: Number(episode),
            streamUrl: String(streamUrl).trim(),
            format: streamUrl.includes('.mp4') ? 'mp4' : 'hls',
            label,
            updatedAt: new Date().toISOString()
          });
        }
        return jsonResponse({ ok: true, snapshot: getWorkerAdminSnapshot() });
      }

      if (pathname.startsWith('/api/admin/overrides/') && request.method === 'DELETE') {
        const key = decodeURIComponent(pathname.replace('/api/admin/overrides/', ''));
        runtimeState.customOverrides.delete(key);
        return jsonResponse({ ok: true, snapshot: getWorkerAdminSnapshot() });
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
        version: '2.1.0',
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
        return jsonResponse({ ok: true, metadata, segments, servers: SERVERS });
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
                servers: SERVERS.map((s) => ({ ...s, active: false }))
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
            aes_decrypt_failed: 'Stream link decryption failed (ZXC_AES_KEY rotated).',
            upstream_timeout: 'Timed out talking to the upstream provider.',
            upstream_exception: 'Unhandled error contacting the upstream provider.'
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
              requestedServer: server,
              failedReason: firstFailed ? firstFailed.reason : null,
              serverAttempts: attempts,
              metadata,
              subtitles,
              segments,
              servers: (streamData && streamData.servers) || SERVERS
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
      const headers = new Headers(assetRes.headers);
      headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      headers.set('Access-Control-Allow-Origin', '*');
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
        version: '2.1.0',
        embed: '/embed',
        api: '/api',
        health: '/api/health',
        metaImage: '/meta-image.gif'
      });
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  }
};
