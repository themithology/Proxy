/**
 * VidStuck Full-Stack Cloudflare Worker (Embed UI + TMDB Resolver + 5 Stream Extractors + Edge M3U8 Proxy)
 * 100% Free Tier Compatible — Zero Credit Card Required.
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
 * Build proxy URL pointing to this Worker's /api/proxy endpoint
 */
function buildWorkerProxyUrl(targetUrl, referer = '', mode = 'manifest') {
  const params = new URLSearchParams({ url: targetUrl, mode });
  if (referer) params.set('referer', referer);
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
async function resolveVidstuckUpstream(metadata, serverId, env) {
  try {
    const warmup = await fetch('https://zxcstream.icu/movie', {
      headers: { 'User-Agent': USER_AGENT }
    }).catch(() => null);
    const cookie = warmup?.headers?.get('set-cookie')?.split(';')[0] || '';

    const meowRes = await fetch('https://vidstuck.xyz/backend/meow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://zxcstream.icu/',
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify({
        type: metadata.type,
        id: String(metadata.tmdbId),
        title: metadata.title || '',
        season: String(metadata.season || 1),
        episode: String(metadata.episode || 1),
        releaseYear: String(metadata.releaseYear || '')
      })
    });
    if (!meowRes.ok) return null;
    const { token } = await meowRes.json();
    if (!token) return null;

    const qs = new URLSearchParams({
      id: String(metadata.tmdbId),
      type: metadata.type,
      title: metadata.title || '',
      token,
      season: String(metadata.season || 1),
      episode: String(metadata.episode || 1),
      year: String(metadata.releaseYear || '')
    });

    const srvRes = await fetch(`https://vidstuck.xyz/backend/servers/${serverId}?${qs.toString()}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://zxcstream.icu/',
        ...(cookie ? { Cookie: cookie } : {})
      }
    });
    if (!srvRes.ok) return null;
    const srvJson = await srvRes.json();
    const encLink = srvJson?.data?.link || srvJson?.link;
    if (!encLink) return null;

    const aesKey = env.ZXC_AES_KEY || '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';
    let rawUrl = encLink;
    if (!/^https?:\/\//i.test(encLink) && !encLink.startsWith('/')) {
      const dec = decryptOpenSslAes256Cbc(encLink, aesKey);
      if (dec) rawUrl = dec.startsWith('http') ? dec : `https://vidstuck.xyz${dec}`;
    } else if (encLink.startsWith('/')) {
      rawUrl = `https://vidstuck.xyz${encLink}`;
    }

    const referer = 'https://zxcstream.icu/';
    const streamUrl = buildWorkerProxyUrl(rawUrl, referer);

    return {
      server: serverId,
      format: rawUrl.includes('.mp4') ? 'mp4' : 'hls',
      rawUrl,
      streamUrl,
      referer,
      audioTracks: [
        { id: 'orig', lang: 'en', label: 'Original Audio', type: 'sub', streamUrl, rawUrl, default: true }
      ],
      qualities: [{ label: 'Auto', height: 0, url: streamUrl }]
    };
  } catch {
    return null;
  }
}

async function resolveVidsrcUpstream(metadata) {
  try {
    const isTv = metadata.type === 'tv';
    const qs = isTv
      ? `type=tv&tmdb=${metadata.tmdbId}&season=${metadata.season || 1}&episode=${metadata.episode || 1}&stream_urls`
      : `type=movie&tmdb=${metadata.tmdbId}&stream_urls`;
    const referer = 'https://vidsrc.sh/';
    const res = await fetch(`https://data.vidsrc.sh/api.php?${qs}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Referer: referer }
    });
    if (!res.ok) return null;
    const json = await res.json();

    let urls = [];
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
        const np = ex.malloc(nb.length + 1);
        new Uint8Array(mem.buffer).set(nb, np);
        new Uint8Array(mem.buffer)[np + nb.length] = 0;
        ex.nonce(np);
        ex.free(np);

        const ct = Buffer.from(json.data.stream_urls, 'base64');
        const ptr = ex.malloc(ct.length);
        new Uint8Array(mem.buffer).set(ct, ptr);
        const outPtr = ex.decrypt(ptr, ct.length);
        if (outPtr) {
          const u8 = new Uint8Array(mem.buffer);
          let end = outPtr;
          while (end < u8.length && u8[end] !== 0) end++;
          urls = JSON.parse(Buffer.from(mem.buffer, outPtr, end - outPtr).toString('utf8'));
        }
      }
    }

    urls = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (urls.length === 0) return null;

    let rawUrl = urls[0];
    try {
      const origin = new URL(rawUrl).origin;
      const genRes = await fetch(`${origin}/generate.php`, {
        headers: { 'User-Agent': USER_AGENT, Referer: referer }
      });
      if (genRes.ok) {
        const gen = await genRes.json();
        if (gen?.token) {
          urls = urls.map((u) => `${u.split('?')[0]}?token=${encodeURIComponent(gen.token)}`);
          rawUrl = urls[0];
        }
      }
    } catch {}

    const streamUrl = buildWorkerProxyUrl(rawUrl, referer);
    return {
      server: 'ursa',
      format: rawUrl.includes('.mp4') || rawUrl.includes('.mkv') ? 'mp4' : 'hls',
      rawUrl,
      streamUrl,
      referer,
      audioTracks: [
        { id: 'vidsrc-orig', lang: 'en', label: 'Original Audio', type: 'sub', streamUrl, rawUrl, default: true }
      ],
      qualities: [
        { label: 'Auto', height: 0, url: streamUrl },
        ...urls.map((u, idx) => ({
          label: idx === 0 ? '1080p' : '720p',
          height: idx === 0 ? 1080 : 720,
          url: buildWorkerProxyUrl(u, referer)
        }))
      ]
    };
  } catch {
    return null;
  }
}

async function resolveHicineUpstream(metadata) {
  if (!metadata.title) return null;
  try {
    const res = await fetch(
      `https://api.hicine.sbs/api/search/${encodeURIComponent(metadata.title)}`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
    );
    if (!res.ok) return null;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) return null;

    const isTv = metadata.type === 'tv';
    const candidates = items.filter((i) =>
      isTv ? i.contentType === 'series' || i.season_1 : i.contentType === 'movies' || i.links
    );
    const chosen = candidates[0] || items[0];
    const rawText = isTv
      ? chosen[`season_${metadata.season || 1}`] || chosen.season_1 || ''
      : chosen.links || '';
    if (!rawText) return null;

    let block = rawText;
    if (isTv) {
      const epRegex = new RegExp(`^\\s*Episode\\s+0*${Number(metadata.episode || 1)}(?:\\b|\\s|:)`, 'i');
      const anyEp = /^\s*Episode\s+\d+/i;
      const lines = rawText.split(/\r?\n/);
      const matched = [];
      let inside = false;
      for (const l of lines) {
        if (epRegex.test(l)) {
          inside = true;
          matched.push(l);
        } else if (inside && anyEp.test(l)) {
          break;
        } else if (inside) {
          matched.push(l);
        }
      }
      if (matched.length > 0) block = matched.join('\n');
    }

    const qualities = [];
    for (const line of block.split(/\r?\n/)) {
      const qMatch = line.match(/(2160p|1080p|720p|480p)/i);
      const qLabel = qMatch ? qMatch[1].toLowerCase() : '720p';
      const height = parseInt(qLabel, 10) || 720;

      const workerMatch = line.match(/(https?:\/\/[^\s,"']+\/\?vcloud=[^\s,"']+)/i);
      if (workerMatch && qualities.length < 3) {
        try {
          const parsed = new URL(workerMatch[1]);
          const vcloud = parsed.searchParams.get('vcloud');
          const lRes = await fetch(
            `${parsed.origin}/api/links?vcloud=${encodeURIComponent(vcloud)}`,
            { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
          );
          if (lRes.ok) {
            const lData = await lRes.json();
            for (const tType of ['pixel', 'ten', 'r2', 'DDL']) {
              const tok = lData?.tokens?.[tType];
              if (!tok?.ts || !tok?.sig) continue;
              const goRes = await fetch(
                `${parsed.origin}/go?type=${tType}&vcloud=${encodeURIComponent(vcloud)}&ts=${tok.ts}&sig=${tok.sig}`,
                { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' }
              );
              const loc = goRes.headers.get('location');
              if (loc && /^https?:\/\//i.test(loc)) {
                const directUrl = loc.includes('pixeldrain.') && loc.includes('/u/')
                  ? `https://pixeldrain.dev/api/file/${loc.split('/u/')[1].split(/[?#]/)[0]}`
                  : loc;
                qualities.push({
                  label: qLabel,
                  height,
                  rawUrl: directUrl,
                  url: buildWorkerProxyUrl(directUrl, '')
                });
                break;
              }
            }
          }
        } catch {}
      }
    }

    if (qualities.length === 0) return null;
    qualities.sort((a, b) => b.height - a.height);
    const primary = qualities[0];

    return {
      server: 'centaurus',
      format: 'mp4',
      rawUrl: primary.rawUrl,
      streamUrl: primary.url,
      referer: '',
      audioTracks: [
        { id: 'hicine-orig', lang: 'en', label: 'Original Audio', type: 'dub', streamUrl: primary.url, rawUrl: primary.rawUrl, default: true }
      ],
      qualities: qualities.map((q) => ({ label: q.label, height: q.height, url: q.url }))
    };
  } catch {
    return null;
  }
}

async function resolveStreamWaterfall(metadata, requestedServer, preferredAudio, env) {
  const validServer = SERVERS.find((s) => s.id === requestedServer)?.id || 'andromeda';
  const cacheKey = `cf:resolve:${metadata.type}:${metadata.tmdbId}:s${metadata.season}:e${metadata.episode}:${validServer}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const order = [validServer, ...SERVERS.map((s) => s.id).filter((id) => id !== validServer)];
  for (const srvId of order) {
    let resolved = null;
    if (srvId === 'andromeda' || srvId === 'atlas') {
      resolved = await resolveVidstuckUpstream(metadata, srvId, env);
    } else if (srvId === 'ursa') {
      resolved = await resolveVidsrcUpstream(metadata);
    } else if (srvId === 'centaurus') {
      resolved = await resolveHicineUpstream(metadata);
    }
    if (resolved && resolved.streamUrl) {
      const payload = {
        ...resolved,
        requestedServer: validServer,
        servers: SERVERS.map((s) => ({ ...s, active: s.id === resolved.server }))
      };
      await edgeCacheSet(cacheKey, payload, 900);
      return payload;
    }
  }
  return null;
}

/**
 * 5. M3U8 Manifest Rewriter & Edge Stream Proxy
 */
function rewriteManifest(m3u8, baseUrl, workerProxyBase, referer, origin, mode) {
  const resolveAbs = (u) => {
    try {
      return new URL(u.trim(), baseUrl).toString();
    } catch {
      return u.trim();
    }
  };

  const proxyUri = (target, isPlaylistOrKey) => {
    const abs = resolveAbs(target);
    // In 'manifest' mode (default on Cloudflare), only proxy nested .m3u8 playlists & keys;
    // let heavy .ts/.m4s video segments stream directly from upstream CDN to save Worker request quota!
    if (mode === 'manifest' && !isPlaylistOrKey) return abs;
    const p = new URLSearchParams({ url: abs, mode });
    if (referer) p.set('referer', referer);
    if (origin) p.set('origin', origin);
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

  if (!targetUrl) {
    return jsonResponse({
      ok: true,
      worker: 'VidStuck Cloudflare Edge Proxy',
      usage: '/api/proxy?url=https://example.com/master.m3u8&referer=https://upstream.site/'
    });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid ?url= parameter' }, 400);
  }

  const upstreamHeaders = new Headers({
    'User-Agent': request.headers.get('User-Agent') || USER_AGENT,
    Accept: '*/*',
    Referer: referer || `${parsed.origin}/`,
    Origin: origin || (referer ? new URL(referer).origin : parsed.origin)
  });

  const range = request.headers.get('Range');
  if (range) upstreamHeaders.set('Range', range);

  const upstreamResp = await fetch(parsed.toString(), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: upstreamHeaders,
    redirect: 'follow'
  });

  const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstreamResp.url || parsed.toString();
  const isM3u8 =
    contentType.includes('mpegurl') ||
    contentType.includes('m3u8') ||
    parsed.pathname.endsWith('.m3u8');

  if (isM3u8 && request.method !== 'HEAD') {
    const text = await upstreamResp.text();
    if (text.trim().startsWith('#EXTM3U')) {
      const workerProxyBase = `${url.origin}/api/proxy`;
      const rewritten = rewriteManifest(text, finalUrl, workerProxyBase, referer, origin, mode);
      return new Response(rewritten, {
        status: 200,
        headers: corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'public, max-age=15'
        })
      });
    }
  }

  const respHeaders = new Headers(corsHeaders());
  respHeaders.set('Accept-Ranges', 'bytes');
  respHeaders.set(
    'Content-Type',
    contentType.includes('octet-stream') ? 'video/mp4' : contentType || 'video/mp4'
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
        runtime: 'cloudflare-workers-edge',
        service: 'vidstuck-proxy-engine',
        version: '2.0.0',
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
          return jsonResponse(
            {
              ok: false,
              error: 'Unable to resolve stream from upstream providers for this title.',
              metadata,
              subtitles,
              segments,
              servers: SERVERS
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

    // --- Owner Admin Dashboard Page (/admin) ---
    if (pathname === '/admin' && env.ASSETS) {
      const adminReq = new Request(new URL('/admin.html', url.origin), request);
      return env.ASSETS.fetch(adminReq);
    }

    // --- Embed Player Routes (/embed/tv/:id/:s/:e, /embed/movie/:id, /tv/:id/:s/:e, /movie/:id) ---
    const isEmbedRoute =
      pathname === '/embed' ||
      /^\/(?:embed\/)?(movie|tv)\/[^/]+/i.test(pathname);

    if (isEmbedRoute && env.ASSETS) {
      recordWorkerDomainHit(request, url, 'embed');
      const embedReq = new Request(new URL('/embed.html', url.origin), request);
      const assetRes = await env.ASSETS.fetch(embedReq);
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Security-Policy', 'frame-ancestors *;');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.delete('X-Frame-Options');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    // --- Static Assets (/index.html, /css/*, /js/*, /vendor/*) ---
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Security-Policy', 'frame-ancestors *;');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    return jsonResponse({
      ok: true,
      message: 'VidStuck Cloudflare Edge Worker is active. Bind [assets] in wrangler.toml to serve the UI.'
    });
  }
};
