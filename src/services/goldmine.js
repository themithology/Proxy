/**
 * Goldmine — TMDB-Embed-API source resolver.
 *
 * The Goldmine server resolves streams through a self-hosted TMDB-Embed-API
 * instance (https://github.com/themithology/TMDB-Embed-API). That API
 * aggregates a dozen providers (Showbox/FebBox, 4KHDHub, VidLink, Videasy,
 * DahmerMovies, …) behind JSON endpoints:
 *
 *   GET {base}/api/providers
 *   GET {base}/api/streams/{movie|series}/{tmdbId}[?season=&episode=]
 *   GET {base}/api/streams/{provider}/{movie|series}/{tmdbId}[?season=&episode=]
 *
 *   -> { success, tmdbId, imdbId, count, providerTimings,
 *        streams: [{ name, title, url, quality, provider, headers?, subtitles? }] }
 *
 * Why per-provider fan-out instead of the aggregate endpoint?
 *   TMDB-Embed-API's aggregate `/api/streams/:type/:tmdbId` awaits `Promise.all`
 *   across all 13 providers, so a single slow/timing-out provider (15–30s)
 *   stalls every resolve. Querying enabled providers individually in two fast
 *   waves lets us return in ~1.5–4.5s as soon as multi-audio MKV + backup
 *   streams arrive and abort stragglers, while falling back transparently to
 *   the aggregate route if `/api/providers` or per-provider routes are absent.
 *
 * Pure JS (fetch + URL only, no Buffer, no Node APIs) so BOTH runtimes share it:
 *   - Node backend:  src/services/resolver.js  -> resolveStreamForServer()
 *   - CF Worker:     cloudflare-worker/worker.js -> resolveStreamWaterfall()
 */

const {
  parseAudioLanguageHints,
  normalizeLanguageCode,
  languageLabelForCode,
  mapLanguageNameToCode
} = require('./languages');

/** Default deployment of the TMDB-Embed-API (owner-hosted on Render). */
const GOLDMINE_DEFAULT_API_BASE = 'https://rdp-running-campion.onrender.com';

/** Provider id -> internal label. NEVER rendered in the player (anonymity
 *  policy: the UI only says "Source N" + quality/language descriptors). */
const GOLDMINE_PROVIDER_LABELS = {
  showbox: 'Showbox/FebBox',
  pstream: 'Showbox/PStream',
  'febbox fid': 'Showbox/FebBox',
  '4khdhub': '4KHDHub',
  vixsrc: 'VixSrc',
  videasy: 'Videasy',
  vidlink: 'VidLink',
  dahmermovies: 'DahmerMovies',
  streamflix: 'StreamFlix',
  vaplayer: 'VaPlayer',
  castletv: 'CastleTV',
  hdghartv: 'HDGharTV',
  netmirror: 'NetMirror',
  onetouchtv: 'OneTouchTV',
  zxcstreams: 'ZXCStreams'
};

/**
 * Fast primary wave: direct multi-audio MKV extractors + fast non-IP-bound backups.
 * Providers whose direct CDN links are IP-bound to the TMDB-Embed-API host
 * (`vidlink` MP4 ladder, `vixsrc` IP-stamped tokens) sit in Wave 2 so they
 * cannot trigger an early settle and abort MKV extractors like `4khdhub`.
 */
const FAST_WAVE_PROVIDERS = [
  'dahmermovies',
  '4khdhub',
  'castletv',
  'showbox',
  'videasy'
];

const SECONDARY_WAVE_PROVIDERS = [
  'streamflix',
  'vaplayer',
  'netmirror',
  'onetouchtv',
  'hdghartv',
  'zxcstreams',
  'vixsrc',
  'vidlink'
];
const SECONDARY_WAVE_SET = new Set(SECONDARY_WAVE_PROVIDERS);
const MKV_EXTRACTOR_PROVIDERS = new Set(['dahmermovies', '4khdhub', 'castletv', 'showbox']);

const PROVIDERS_CACHE_TTL_MS = 10 * 60 * 1000;
const providersCache = new Map();

/** Headers a browser fetch is not allowed to set — they must go through the
 *  server-side proxy instead of movi-player's `headers` attribute. */
const FORBIDDEN_BROWSER_HEADERS = new Set([
  'referer', 'referrer', 'origin', 'user-agent', 'cookie', 'host',
  'connection', 'content-length', 'date', 'dnt', 'upgrade-insecure-requests',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'sec-fetch-dest',
  'accept-encoding', 'accept-language', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'via', 'keep-alive', 'set-cookie'
]);

/** Transport/range negotiation headers managed by the browser / movi HttpSource
 *  itself (e.g. DahmerMovies attaches `Range: bytes=0-` and `Accept: *\/*`,
 *  which would override movi-player's own byte-range probes if forwarded). */
const TRANSPORT_STRIP_HEADERS = new Set([
  'range', 'if-range', 'accept', 'cache-control', 'pragma'
]);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Map the LOL Embed media type onto the TMDB-Embed-API type segment. */
function goldmineTypeFor(mediaType) {
  return String(mediaType || '').toLowerCase() === 'movie' ? 'movie' : 'series';
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

/** Combine an optional caller AbortSignal with a per-call timeout. */
function createTimedSignal(timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(250, timeoutMs));

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    wasTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };
}

/** Quality string ("1080p", "4K", "Auto", "HD") -> pixel height (0 = unknown). */
function qualityToHeight(quality) {
  const value = String(quality || '').toLowerCase();
  if (/2160|4k|uhd/.test(value)) return 2160;
  if (/1440|2k/.test(value)) return 1440;
  if (/1080|fhd/.test(value)) return 1080;
  if (/720|\bhd\b/.test(value)) return 720;
  if (/576/.test(value)) return 576;
  if (/480|\bsd\b/.test(value)) return 480;
  if (/360/.test(value)) return 360;
  if (/240/.test(value)) return 240;
  const numeric = value.match(/(\d{3,4})\s*p?/);
  if (numeric) return parseInt(numeric[1], 10);
  return 0; // Auto / unknown
}

function heightToLabel(height) {
  if (height === 2160) return '4K';
  if (height > 0) return `${height}p`;
  return 'Auto';
}

/**
 * Container of a stream, from the URL extension first and the title second.
 * 'hls' / 'dash' keep the player on its native engine; everything else is a
 * progressive file the movi engine plays (MKV, HEVC MP4, AVI, TS, WebM…).
 */
function containerForStream(url, title) {
  const haystack = `${fileNameFromUrl(url)} ${String(title || '')}`.toLowerCase();
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return String(url || '').toLowerCase();
    }
  })();
  if (/\.m3u8(?:$|[?#])/.test(pathname) || /\.m3u8\b/.test(haystack)) return 'hls';
  if (/\.mpd(?:$|[?#])/.test(pathname) || /\.mpd\b/.test(haystack)) return 'dash';
  if (/\.ism(?:$|[?#])/.test(pathname)) return 'ism';
  if (/\.mkv\b/.test(haystack)) return 'mkv';
  if (/\.webm\b/.test(haystack)) return 'webm';
  if (/\.avi\b/.test(haystack)) return 'avi';
  if (/\.mov\b/.test(haystack)) return 'mov';
  if (/\.ts\b/.test(haystack)) return 'ts';
  if (/\.mp4\b/.test(haystack)) return 'mp4';
  // Proxy-rewritten URLs (…/ts-proxy?url=…) hide the extension in the query.
  const query = (() => {
    try {
      const parsed = new URL(url);
      const inner = parsed.searchParams.get('url') || '';
      return `${inner} ${parsed.search}`.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (/\.m3u8/.test(query)) return 'hls';
  if (/\.mpd/.test(query)) return 'dash';
  if (/\.mkv/.test(query)) return 'mkv';
  if (/\.webm/.test(query)) return 'webm';
  if (/\.mp4/.test(query)) return 'mp4';
  if (/\/playlist\b|\/master\b|hls/i.test(pathname)) return 'hls';
  return 'unknown';
}

/**
 * Progressive containers the movi engine takes over from the native <video>.
 *
 * MP4 is deliberately absent: every browser demuxes progressive MP4 itself
 * (hardware decode, native HTTP Range/seek handling, no 12 MB WASM bundle to
 * download first), and the player still escalates to movi automatically when
 * the native element rejects a file (HEVC / 10-bit MP4 → `MEDIA_ERR_SRC_NOT_SUPPORTED`).
 * Sending ordinary H.264 MP4 through the WASM demuxer is what made plain
 * "720p · MP4" sources die a few seconds into playback on mobile.
 */
const MOVI_CONTAINERS = new Set(['mkv', 'webm', 'avi', 'mov', 'ts', 'unknown']);

/**
 * Detect streams whose direct CDN URLs are signed for the TMDB-Embed-API
 * server's IP (e.g. Render's US datacenter IP) when `enableProxy=false` on the
 * upstream API. When a Cloudflare Worker or residential browser fetches those
 * links from a different IP/ASN, FebBox (`shegu.net`/`febbox.com`), Vidlink's
 * MP4 ladder, and VixSrc's `?token=` gate reject them with HTTP 403/410.
 *
 * URLs that the TMDB-Embed-API already wrapped in its own `/ts-proxy` or
 * `/m3u8-proxy` (`enableProxy=true`) exit from the same Render IP that minted
 * the signature, so they are NOT treated as IP-mismatched here.
 */
function isEphemeralIpBoundStream(stream) {
  if (!stream || !stream.url) return false;
  if (/\/(?:ts|m3u8)-proxy\b/i.test(stream.url)) return false;
  const prov = String(stream.provider || '').toLowerCase();
  if (prov === 'pstream' || /\b(?:shegu\.net|febbox\.com)\b/i.test(stream.url)) return true;
  if (prov === 'vidlink' && stream.container === 'mp4') return true;
  if (prov === 'vixsrc') return true;
  return false;
}

/**
 * Normalize one TMDB-Embed-API stream object.
 * Returns null for rows that can never play (missing/invalid URL).
 */
function normalizeGoldmineStream(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const provider = String(raw.provider || 'unknown').toLowerCase();
  const title = String(raw.title || raw.name || '');
  const qualityLabel = String(raw.quality || '') || (qualityToHeight(title) ? heightToLabel(qualityToHeight(title)) : 'Auto');
  const height = qualityToHeight(raw.quality) || qualityToHeight(title);
  const container = containerForStream(url, title);

  // Dub languages hide in titles/names/filenames ("… 1080p [Hindi + English]
  // …", "CastleTV Tamil | 1080p", "… HIN TAM TEL Multi-Audio …").
  const hints = parseAudioLanguageHints(`${String(raw.name || '')} ${title} ${fileNameFromUrl(url)}`);

  const headers =
    raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
      ? raw.headers
      : null;

  const subtitles = Array.isArray(raw.subtitles)
    ? raw.subtitles
        .filter((sub) => sub && typeof sub === 'object' && /^https?:\/\//i.test(String(sub.url || '')))
        .map((sub) => ({
          url: String(sub.url),
          lang: normalizeLanguageCode(sub.lang || sub.language || mapLanguageNameToCode(sub.label || sub.name || '')),
          label: String(sub.label || sub.name || '') || languageLabelForCode(normalizeLanguageCode(sub.lang || sub.language || ''))
        }))
    : [];

  const stream = {
    index,
    provider,
    providerLabel: GOLDMINE_PROVIDER_LABELS[provider] || provider,
    url,
    title,
    qualityLabel,
    height,
    container,
    languages: hints.languages,
    multi: hints.multi,
    original: hints.original,
    headers,
    subtitles,
    ephemeralIpBound: false
  };
  stream.ephemeralIpBound = isEphemeralIpBoundStream(stream);
  return stream;
}

/**
 * Rank a stream for "which one plays first".
 * Dub coverage dominates (the Goldmine server exists for multi-audio MKVs),
 * then a sane resolution (1080p — 4K HEVC is heavy on a WASM decoder), then
 * container preference, while demoting Render-IP-bound links behind portable
 * MKV/HLS/MP4 sources.
 */
function scoreGoldmineStream(stream) {
  let score = 0;
  score += Math.min(stream.languages.length, 3) * 300;
  if (stream.multi) score += 150;
  if (stream.original) score += 40;

  const height = stream.height;
  if (height === 1080) score += 120;
  else if (height === 720) score += 100;
  else if (height === 0) score += 90; // "Auto" — usually the provider default
  else if (height === 2160 || height === 1440) score += 60;
  else if (height === 576 || height === 480) score += 40;
  else score += 20;

  if (stream.container === 'mkv') score += 45; // multi-audio releases live in MKV
  else if (stream.container === 'hls') score += 35; // adaptive HLS beats bare untagged MP4 ladders
  else if (stream.container === 'mp4') score += 25;
  else if (stream.container === 'webm' || stream.container === 'ts') score += 10;
  else if (stream.container === 'dash' || stream.container === 'ism') score += 5;
  else score += 15; // unknown progressive — movi can still open it

  if (stream.ephemeralIpBound || isEphemeralIpBoundStream(stream)) {
    const prov = String(stream.provider || '').toLowerCase();
    if (prov === 'pstream' || /\b(?:shegu\.net|febbox\.com)\b/i.test(stream.url || '')) score -= 220;
    else if (prov === 'vidlink') score -= 180;
    else score -= 140;
  }

  // Earlier rows come from the aggregator's own provider priority order.
  score -= Math.min(stream.index, 40);
  return score;
}

/** Normalize a whole TMDB-Embed-API response into scored, grouped streams. */
function normalizeGoldminePayload(json) {
  const rawStreams = Array.isArray(json && json.streams) ? json.streams : [];
  const streams = [];
  rawStreams.forEach((raw, index) => {
    const normalized = normalizeGoldmineStream(raw, index);
    if (normalized) streams.push(normalized);
  });
  streams.forEach((stream) => {
    stream.score = scoreGoldmineStream(stream);
  });

  // Provider groups keep the aggregator's order (its configured provider
  // priority); streams inside a group are best-first.
  const providerOrder = [];
  const byProvider = new Map();
  for (const stream of streams) {
    if (!byProvider.has(stream.provider)) {
      byProvider.set(stream.provider, []);
      providerOrder.push(stream.provider);
    }
    byProvider.get(stream.provider).push(stream);
  }
  for (const list of byProvider.values()) {
    list.sort((a, b) => b.score - a.score);
  }

  const providers = providerOrder.map((id) => ({
    id,
    label: GOLDMINE_PROVIDER_LABELS[id] || id,
    streams: byProvider.get(id),
    timingMs: json && json.providerTimings ? json.providerTimings[id] ?? null : null
  }));

  return { streams, providers, imdbId: (json && json.imdbId) || null };
}

/** Split a stream's headers into proxy-side (forbidden) and browser-safe sets. */
function splitHeaders(headers) {
  const serverSide = {};
  const browserSafe = {};
  if (!headers || typeof headers !== 'object') return { serverSide, browserSafe };
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    if (FORBIDDEN_BROWSER_HEADERS.has(lower)) serverSide[key] = String(value);
    else if (!TRANSPORT_STRIP_HEADERS.has(lower)) browserSafe[key] = String(value);
  }
  return { serverSide, browserSafe };
}

function proxyMetaFromHeaders(headers) {
  const meta = { referer: '', origin: '', cookie: '', userAgent: '' };
  if (!headers || typeof headers !== 'object') return meta;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    const str = String(value);
    if (lower === 'referer' || lower === 'referrer') meta.referer = str;
    else if (lower === 'origin') meta.origin = str;
    else if (lower === 'cookie') meta.cookie = str;
    else if (lower === 'user-agent') meta.userAgent = str;
  }
  return meta;
}

function refererFromHeaders(headers) {
  return proxyMetaFromHeaders(headers).referer;
}

/** Human descriptor for one source row in the servers popover. */
function sourceLabelFor(stream) {
  const parts = [];
  const quality = stream.height > 0 ? heightToLabel(stream.height) : String(stream.qualityLabel || 'Auto');
  parts.push(quality);
  if (stream.container && stream.container !== 'unknown') parts.push(stream.container.toUpperCase());
  if (stream.languages.length > 0) {
    parts.push(stream.languages.map((language) => language.label).join(' + '));
  } else if (stream.multi) {
    parts.push('Multi-Audio');
  }
  return parts.join(' · ');
}

/**
 * Build the resolver payload (the shape `/api/resolve` answers with) from a
 * normalized TMDB-Embed-API response.
 *
 * `options`:
 *   - apiBase       — TMDB-Embed-API origin (its own /ts-proxy URLs pass through)
 *   - proxyStreams  — wrap direct file URLs in the runtime's /api/proxy (default true)
 *   - proxyUrl(url, referer, proxyMeta) — runtime callback that builds the proxied URL
 *   - onlySource    — pin one provider id
 *   - preferredAudio — language code/name the viewer asked for (?lang=)
 */
function buildGoldminePayload(normalized, options = {}) {
  const {
    apiBase = GOLDMINE_DEFAULT_API_BASE,
    proxyStreams = true,
    proxyUrl = null,
    onlySource = '',
    preferredAudio = ''
  } = options;

  const apiHost = hostOf(stripTrailingSlash(apiBase) || 'https://invalid');
  let candidateStreams = normalized.streams;
  if (onlySource) {
    candidateStreams = candidateStreams.filter((stream) => stream.provider === onlySource);
  }
  if (candidateStreams.length === 0) {
    return {
      reason: onlySource ? 'goldmine_source_empty' : 'goldmine_no_streams',
      diag: onlySource
        ? `provider "${onlySource}" returned no playable streams`
        : 'TMDB-Embed-API answered with zero playable streams'
    };
  }

  const ordered = [...candidateStreams].sort((a, b) => b.score - a.score);
  const primary = ordered[0];

  // URL preparation: the API's own proxied URLs (ts-proxy on the API host)
  // already carry CORS+Range; anything else goes through OUR signed proxy so
  // the browser can fetch it (CORS, Range, and forbidden headers like Referer
  // are handled server-side).
  const playableCache = new Map();
  const sourceMeta = {};

  const mapSubtitlesForStream = (stream, proxyMeta) =>
    stream.subtitles.map((sub, index) => ({
      id: `goldmine-sub-${index}`,
      lang: sub.lang || 'und',
      label: sub.label || languageLabelForCode(sub.lang),
      url:
        proxyStreams && hostOf(sub.url) !== apiHost && typeof proxyUrl === 'function'
          ? proxyUrl(sub.url, proxyMeta.referer, proxyMeta) || sub.url
          : sub.url
    }));

  const playableUrl = (stream) => {
    if (playableCache.has(stream.url)) return playableCache.get(stream.url);
    const proxyMeta = proxyMetaFromHeaders(stream.headers);
    const sameHostAsApi = hostOf(stream.url) === apiHost;
    let playable = stream.url;
    if (!sameHostAsApi && proxyStreams && typeof proxyUrl === 'function') {
      // The container rides along so the runtime can build an engine-appropriate
      // proxy URL (progressive files are demuxed over HTTP Range, playlists not).
      playable = proxyUrl(stream.url, proxyMeta.referer, { ...proxyMeta, container: stream.container }) || stream.url;
    }
    playableCache.set(stream.url, playable);
    if (!sourceMeta[playable]) {
      const { browserSafe } = splitHeaders(stream.headers);
      const subs = mapSubtitlesForStream(stream, proxyMeta);
      sourceMeta[playable] = {
        rawUrl: stream.url,
        container: stream.container,
        format: stream.container === 'hls' ? 'hls' : stream.container === 'dash' ? 'dash' : stream.container,
        engine: MOVI_CONTAINERS.has(stream.container) ? 'movi' : 'native',
        height: stream.height,
        qualityLabel: stream.height > 0 ? heightToLabel(stream.height) : String(stream.qualityLabel || 'Auto'),
        languages: stream.languages.map((l) => l.code),
        multi: !!stream.multi,
        moviHeaders: Object.keys(browserSafe).length > 0 ? browserSafe : undefined,
        subtitles: subs.length > 0 ? subs : undefined
      };
    }
    return playable;
  };

  const primaryPlayable = playableUrl(primary);
  const { browserSafe: primaryBrowserHeaders } = splitHeaders(primary.headers);

  // --- Dub languages across the whole fetch -------------------------------
  // "How many total dub languages are there?" — union every hinted language
  // over every candidate stream, and map each to the best stream that has it.
  const languageRows = new Map(); // code -> { code, label, count, best }
  for (const stream of ordered) {
    for (const language of stream.languages) {
      const existing = languageRows.get(language.code);
      if (existing) {
        existing.count += 1;
        if (stream.score > existing.best.score) existing.best = stream;
      } else {
        languageRows.set(language.code, {
          code: language.code,
          label: language.label,
          count: 1,
          best: stream
        });
      }
    }
  }
  const languages = [...languageRows.values()]
    .sort((a, b) => b.count - a.count || b.best.score - a.best.score)
    .map((row) => ({ code: row.code, label: row.label, count: row.count }));

  // --- Audio tracks --------------------------------------------------------
  // One row per known dub language. Rows whose file muxes several tracks
  // (`inFile: true`) are switched inside the running file by movi-player;
  // rows that live in their own file switch the src and keep the playhead.
  const audioTracks = [];
  if (languageRows.size > 0) {
    const wantedCode = preferredAudio ? normalizeLanguageCode(preferredAudio) : 'und';
    const primaryFirstLang = primary.languages[0] ? primary.languages[0].code : '';
    const defaultCode =
      (wantedCode !== 'und' && languageRows.has(wantedCode) ? wantedCode : '') ||
      (primaryFirstLang && languageRows.has(primaryFirstLang) ? primaryFirstLang : '') ||
      [...languageRows.keys()][0];
    for (const row of languageRows.values()) {
      const bestPlayable = playableUrl(row.best);
      audioTracks.push({
        id: `goldmine-${row.code}`,
        lang: row.code,
        label: row.label,
        type: 'dub',
        streamUrl: bestPlayable,
        rawUrl: row.best.url,
        // The hinted languages of a multi-audio file all mux inside that one
        // file: try an in-file track switch before reloading anything.
        inFile: row.best.multi || row.best.languages.length > 1,
        qualityLabel: row.best.height > 0 ? heightToLabel(row.best.height) : row.best.qualityLabel,
        default: row.code === defaultCode
      });
    }
    // Keep the playing file's own languages first, matching what plays now.
    audioTracks.sort((a, b) => {
      const aPrimary = a.streamUrl === primaryPlayable ? 0 : 1;
      const bPrimary = b.streamUrl === primaryPlayable ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return (b.default ? 1 : 0) - (a.default ? 1 : 0);
    });
  } else {
    audioTracks.push({
      id: 'goldmine-default',
      lang: 'und',
      label: primary.multi ? 'Multi-Audio (dubs detected on load)' : 'Default Audio',
      type: 'dub',
      streamUrl: primaryPlayable,
      rawUrl: primary.url,
      inFile: !!primary.multi,
      default: true
    });
  }

  // --- Qualities (variants of the primary's own provider group) ------------
  const groupStreams = (normalized.providers.find((p) => p.id === primary.provider) || { streams: [] }).streams;
  const seenHeights = new Set(primary.height > 0 ? [primary.height] : []);
  const qualities = [];
  for (const stream of groupStreams) {
    if (stream === primary) continue;
    if (stream.height === 0 || seenHeights.has(stream.height)) continue;
    const primaryLangs = primary.languages.map((l) => l.code).sort().join(',');
    const streamLangs = stream.languages.map((l) => l.code).sort().join(',');
    if (primaryLangs && streamLangs && primaryLangs !== streamLangs) continue;
    seenHeights.add(stream.height);
    qualities.push({ label: heightToLabel(stream.height), height: stream.height, url: playableUrl(stream) });
  }
  qualities.sort((a, b) => b.height - a.height);
  qualities.unshift({
    label: primary.height > 0 ? heightToLabel(primary.height) : String(primary.qualityLabel || 'Auto'),
    height: primary.height,
    url: primaryPlayable
  });

  // --- Backups + labeled sources -------------------------------------------
  // Interleave across distinct providers first so a single dead/IP-locked CDN
  // (e.g. a 4-rung 1080p/720p/480p/360p MP4 ladder) never occupies every top
  // backup slot before the player tries a different upstream host.
  const backupUrls = [];
  const sourceLabels = {};
  sourceLabels[primaryPlayable] = sourceLabelFor(primary);

  const hasReliableCandidate = ordered.some((s) => !s.ephemeralIpBound);
  const interleaveByProvider = (list) => {
    const buckets = new Map();
    const otherProviders = [];
    for (const s of list) {
      if (!buckets.has(s.provider)) {
        buckets.set(s.provider, []);
        if (s.provider !== primary.provider) otherProviders.push(s.provider);
      }
      buckets.get(s.provider).push(s);
    }
    const providerRing = buckets.has(primary.provider)
      ? [...otherProviders, primary.provider]
      : otherProviders;
    const out = [];
    let cursor = 0;
    let moved = true;
    while (moved) {
      moved = false;
      for (const pid of providerRing) {
        const bucket = buckets.get(pid);
        if (bucket && cursor < bucket.length) {
          out.push(bucket[cursor]);
          moved = true;
        }
      }
      cursor += 1;
    }
    return out;
  };

  const reliableAlternates = ordered.filter((s) => s !== primary && !s.ephemeralIpBound);
  const ephemeralAlternates = ordered.filter((s) => {
    if (s === primary || !s.ephemeralIpBound) return false;
    // When portable MKV/HLS/MP4 sources exist, drop low-res (<720p) rungs from
    // Render-IP-bound ladders so dead 480p/360p MP4s never clutter the menu.
    if (hasReliableCandidate && !onlySource && s.height > 0 && s.height < 720) return false;
    return true;
  });

  const diversifiedAlternates = [
    ...interleaveByProvider(reliableAlternates),
    ...interleaveByProvider(ephemeralAlternates)
  ];

  for (const stream of diversifiedAlternates) {
    const playable = playableUrl(stream);
    if (playable === primaryPlayable) continue;
    if (!sourceLabels[playable]) sourceLabels[playable] = sourceLabelFor(stream);
    if (!backupUrls.includes(playable)) backupUrls.push(playable);
    if (backupUrls.length >= 16) break;
  }

  // --- Embedded subtitles from the primary stream ---------------------------
  const primaryProxyMeta = proxyMetaFromHeaders(primary.headers);
  const embeddedSubtitles = mapSubtitlesForStream(primary, primaryProxyMeta);

  const engine = MOVI_CONTAINERS.has(primary.container) ? 'movi' : undefined;

  return {
    server: 'goldmine',
    engine,
    format: primary.container === 'hls' ? 'hls' : primary.container === 'dash' ? 'dash' : primary.container,
    rawUrl: primary.url,
    streamUrl: primaryPlayable,
    referer: primaryProxyMeta.referer,
    headers: {},
    // Browser-safe custom headers only (Authorization, X-Api-Key…) — the
    // player passes these to movi-player's `headers` attribute. Forbidden
    // headers (Referer/UA/Cookie) are applied server-side by the proxy.
    moviHeaders: Object.keys(primaryBrowserHeaders).length > 0 ? primaryBrowserHeaders : undefined,
    progressiveFormat: engine === 'movi' ? primary.container : undefined,
    activeAudioTrack: audioTracks.find((t) => t.default) || audioTracks[0] || null,
    audioTracks,
    qualities,
    backupUrls,
    sourceLabels,
    sourceMeta,
    languages,
    ephemeralOnly: !hasReliableCandidate ? true : undefined,
    embeddedSubtitles: embeddedSubtitles.length > 0 ? embeddedSubtitles : undefined,
    goldmineImdbId: normalized.imdbId,
    goldmineSources: normalized.providers.map((provider) => ({
      id: provider.id,
      streams: provider.streams.length,
      ms: provider.timingMs
    }))
  };
}

/**
 * Fetch streams from the TMDB-Embed-API instance (either aggregate or single provider).
 * Resolves `{ ok, json, reason, diag }` — never throws.
 */
async function fetchGoldmineStreams(options = {}) {
  const {
    apiBase = GOLDMINE_DEFAULT_API_BASE,
    type = 'movie',
    tmdbId = '',
    season = null,
    episode = null,
    provider = '',
    timeoutMs = 30000,
    fetchImpl = null,
    signal = null
  } = options;

  const base = stripTrailingSlash(apiBase) || GOLDMINE_DEFAULT_API_BASE;
  const goldType = goldmineTypeFor(type);
  const path = provider
    ? `/api/streams/${encodeURIComponent(provider)}/${goldType}/${encodeURIComponent(tmdbId)}`
    : `/api/streams/${goldType}/${encodeURIComponent(tmdbId)}`;
  const query = new URLSearchParams();
  if (goldType === 'series') {
    if (season) query.set('season', String(season));
    if (episode) query.set('episode', String(episode));
  }
  const url = `${base}${path}${query.toString() ? `?${query}` : ''}`;

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const timed = createTimedSignal(Math.max(500, timeoutMs), signal);
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
      signal: timed.signal
    });
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        body = '';
      }
      if (res.status === 404) {
        return { ok: false, reason: 'goldmine_source_unknown', diag: `HTTP 404 from ${path} ${body}`.trim() };
      }
      if (res.status === 503) {
        return { ok: false, reason: 'goldmine_source_disabled', diag: `provider disabled upstream (HTTP 503)` };
      }
      return { ok: false, reason: 'goldmine_http_error', diag: `HTTP ${res.status} from ${path} ${body}`.trim() };
    }
    const rawBody = await res.text();
    let json = null;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: 'goldmine_bad_response', diag: `non-JSON body from ${path}` };
    }
    if (!json || json.success === false) {
      return { ok: false, reason: 'goldmine_bad_response', diag: json && json.error ? String(json.error) : 'success=false' };
    }
    return { ok: true, json, url };
  } catch (error) {
    const name = error && error.name ? error.name : '';
    if (timed.wasTimeout() || name === 'TimeoutError') {
      return { ok: false, reason: 'goldmine_timeout', diag: `TMDB-Embed-API did not answer within ${timeoutMs}ms (cold start?)` };
    }
    if (name === 'AbortError') {
      return { ok: false, reason: 'goldmine_aborted', diag: 'provider request aborted after fast settle' };
    }
    return { ok: false, reason: 'goldmine_unreachable', diag: error && error.message ? error.message : String(error) };
  } finally {
    timed.cleanup();
  }
}

/**
 * Discover enabled provider slugs from `GET {base}/api/providers`, cached per
 * `apiBase` for 10 minutes. Returns `null` if the endpoint is unavailable so
 * callers fall back cleanly to the aggregate `/api/streams/:type/:tmdbId`.
 */
async function fetchGoldmineProviders(options = {}) {
  const {
    apiBase = GOLDMINE_DEFAULT_API_BASE,
    timeoutMs = 8000,
    fetchImpl = null
  } = options;
  const base = stripTrailingSlash(apiBase) || GOLDMINE_DEFAULT_API_BASE;

  // Only share the module cache when using the default fetch implementation.
  if (!fetchImpl) {
    const cached = providersCache.get(base);
    if (cached && Date.now() < cached.exp) return cached.providers;
  }

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const timed = createTimedSignal(Math.min(Math.max(800, timeoutMs), 12000));
  try {
    const res = await doFetch(`${base}/api/providers`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
      signal: timed.signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    const list = Array.isArray(json && json.providers) ? json.providers : null;
    if (!list || list.length === 0) return null;

    let slugs = [];
    const seen = new Set();
    let showboxMissingCookieStatus = false;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.enabled === false || entry.cookieOk === false) continue;
      const slug = String(entry.id || entry.name || '').trim().toLowerCase();
      if (!/^[a-z0-9]{2,28}$/.test(slug) || seen.has(slug)) continue;
      if (slug === 'showbox' && typeof entry.cookieOk !== 'boolean') {
        showboxMissingCookieStatus = true;
      }
      seen.add(slug);
      slugs.push(slug);
    }

    // TMDB-Embed-API's `/api/providers` only emits `{ name, enabled }`, whereas
    // `/api/status` reports `cookieOk: false` when `FEBBOX_COOKIES` is unset.
    // Without cookies, Showbox skips FebBox MKVs and hits unauthenticated PStream,
    // which returns Render-IP-bound 1080p/720p/480p/360p MP4 links that 403 on
    // any other IP. Probe `/api/status` when present; 404/unreachable keeps `slugs`.
    if (showboxMissingCookieStatus) {
      const statusTimed = createTimedSignal(Math.min(Math.max(600, timeoutMs), 3500));
      try {
        const statusRes = await doFetch(`${base}/api/status`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          redirect: 'follow',
          signal: statusTimed.signal
        });
        if (statusRes && statusRes.ok) {
          const statusJson = await statusRes.json();
          const statusProviders = Array.isArray(statusJson && statusJson.providers)
            ? statusJson.providers
            : null;
          if (statusProviders) {
            const cookieBlocked = new Set();
            for (const sp of statusProviders) {
              if (!sp || typeof sp !== 'object') continue;
              if (sp.enabled === false || sp.cookieOk === false) {
                const sSlug = String(sp.id || sp.name || '').trim().toLowerCase();
                if (sSlug) cookieBlocked.add(sSlug);
              }
            }
            if (cookieBlocked.size > 0) {
              slugs = slugs.filter((s) => !cookieBlocked.has(s));
            }
          }
        }
      } catch {
        // Ignore status-endpoint errors; fall back to /api/providers list.
      } finally {
        statusTimed.cleanup();
      }
    }

    if (slugs.length === 0) return null;
    if (!fetchImpl) {
      providersCache.set(base, { providers: slugs, exp: Date.now() + PROVIDERS_CACHE_TTL_MS });
    }
    return slugs;
  } catch {
    return null;
  } finally {
    timed.cleanup();
  }
}

function clearGoldmineProviderCache() {
  providersCache.clear();
}

/** Partition enabled provider ids into Wave 1 (fast MKV + reliable backups) and Wave 2 (slow stragglers). */
function partitionProviderWaves(enabledSlugs) {
  const available = new Set(enabledSlugs);
  const wave1 = [];
  const wave2 = [];
  const added = new Set();

  // Keep any custom / non-catalog providers (e.g. test fixtures) at the front of Wave 1.
  for (const slug of enabledSlugs) {
    if (!FAST_WAVE_PROVIDERS.includes(slug) && !SECONDARY_WAVE_SET.has(slug)) {
      wave1.push(slug);
      added.add(slug);
    }
  }
  for (const slug of FAST_WAVE_PROVIDERS) {
    if (available.has(slug) && !added.has(slug)) {
      wave1.push(slug);
      added.add(slug);
    }
  }
  for (const slug of SECONDARY_WAVE_PROVIDERS) {
    if (available.has(slug) && !added.has(slug)) {
      wave2.push(slug);
      added.add(slug);
    }
  }

  if (wave1.length === 0 && wave2.length > 0) {
    return { wave1: wave2, wave2: [] };
  }
  return { wave1, wave2 };
}

/**
 * Fast two-wave per-provider resolution:
 *   1. Query `/api/providers` (cached 10 min) to list enabled providers.
 *   2. Fire Wave 1 (`dahmermovies`, `4khdhub`, `showbox`, `vidlink`, `videasy`,
 *      `vixsrc`) in parallel immediately.
 *   3. Return early (~1.5–4.2s) once strong MKV/multi-audio + backup streams
 *      settle, aborting slow 15–30s stragglers instead of blocking on them.
 *   4. Launch Wave 2 only if Wave 1 hasn't settled within 2.2s (or finishes empty).
 *   5. Fall back transparently to aggregate `/api/streams/:type/:tmdbId` if
 *      `/api/providers` or per-provider routes are unsupported.
 */
async function fetchGoldmineStreamsFast(options = {}) {
  const {
    apiBase = GOLDMINE_DEFAULT_API_BASE,
    type = 'movie',
    tmdbId = '',
    season = null,
    episode = null,
    preferredAudio = '',
    timeoutMs = 30000,
    fetchImpl = null
  } = options;

  const startedAt = Date.now();
  const totalBudgetMs = Math.max(1000, timeoutMs);
  const remainingMs = () => Math.max(250, totalBudgetMs - (Date.now() - startedAt));

  const enabledProviders = await fetchGoldmineProviders({
    apiBase,
    timeoutMs: Math.min(remainingMs(), 10000),
    fetchImpl
  });

  if (!enabledProviders || enabledProviders.length === 0) {
    return fetchGoldmineStreams({
      apiBase,
      type,
      tmdbId,
      season,
      episode,
      timeoutMs: remainingMs(),
      fetchImpl
    });
  }

  const { wave1, wave2 } = partitionProviderWaves(enabledProviders);
  const orderedProviders = [...wave1, ...wave2];
  const wantedAudioCode = preferredAudio ? normalizeLanguageCode(preferredAudio) : 'und';
  // Start the fan-out settle clock AFTER `/api/providers` returns so a Render
  // cold-start on provider discovery never steals budget from Wave 1 MKV scrapers.
  const fanoutStartedAt = Date.now();

  return new Promise((resolve) => {
    let finished = false;
    let wave2Launched = wave2.length === 0;
    let inFlight = 0;
    let settleTimer = null;
    let settleDeadline = Infinity;
    let wave2Timer = null;
    let hardTimer = null;

    const controllers = new Map();
    const streamsByProvider = new Map();
    const providerTimings = {};
    const failureReasons = [];
    let okResponses = 0;
    let unknownRouteCount = 0;
    let launchedCount = 0;
    let resolvedImdbId = null;

    const cleanupTimers = () => {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (wave2Timer) {
        clearTimeout(wave2Timer);
        wave2Timer = null;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
    };

    const abortRemaining = () => {
      for (const ctrl of controllers.values()) {
        try { ctrl.abort(); } catch {}
      }
      controllers.clear();
    };

    const collectCurrentState = () => {
      const mergedRaw = [];
      let providersWithStreams = 0;
      let reliableProviders = 0;
      let reliableCount = 0;
      let hasMkvOrMulti = false;
      let hasWantedAudio = wantedAudioCode === 'und';

      for (const providerId of orderedProviders) {
        const list = streamsByProvider.get(providerId);
        if (!Array.isArray(list) || list.length === 0) continue;
        providersWithStreams += 1;
        let providerHasReliable = false;
        for (const raw of list) {
          mergedRaw.push(raw);
          const norm = normalizeGoldmineStream(raw, mergedRaw.length - 1);
          if (!norm) continue;
          if (!norm.ephemeralIpBound) {
            reliableCount += 1;
            providerHasReliable = true;
            if (norm.container === 'mkv' || norm.multi || norm.languages.length > 1) {
              hasMkvOrMulti = true;
            }
            if (
              !hasWantedAudio &&
              (norm.multi || norm.languages.some((l) => l.code === wantedAudioCode))
            ) {
              hasWantedAudio = true;
            }
          }
        }
        if (providerHasReliable) reliableProviders += 1;
      }

      let mkvExtractorInFlight = false;
      for (const activeId of controllers.keys()) {
        if (MKV_EXTRACTOR_PROVIDERS.has(activeId)) {
          mkvExtractorInFlight = true;
          break;
        }
      }

      return {
        mergedRaw,
        providersWithStreams,
        reliableProviders,
        reliableCount,
        hasMkvOrMulti,
        hasWantedAudio,
        mkvExtractorInFlight
      };
    };

    const finalize = () => {
      if (finished) return;
      finished = true;
      cleanupTimers();
      abortRemaining();

      // If every per-provider call returned 404, the server only implements the aggregate route.
      if (launchedCount > 0 && unknownRouteCount === launchedCount) {
        resolve(
          fetchGoldmineStreams({
            apiBase,
            type,
            tmdbId,
            season,
            episode,
            timeoutMs: remainingMs(),
            fetchImpl
          })
        );
        return;
      }

      const { mergedRaw } = collectCurrentState();
      if (mergedRaw.length > 0 || okResponses > 0) {
        resolve({
          ok: true,
          json: {
            success: true,
            tmdbId,
            imdbId: resolvedImdbId,
            count: mergedRaw.length,
            providerTimings,
            streams: mergedRaw
          }
        });
        return;
      }

      const nonAbortFailure =
        failureReasons.find((f) => f.reason === 'goldmine_bad_response') ||
        failureReasons.find((f) => f.reason === 'goldmine_http_error') ||
        failureReasons.find((f) => f.reason === 'goldmine_timeout') ||
        failureReasons.find((f) => f.reason === 'goldmine_unreachable') ||
        failureReasons[0];

      resolve({
        ok: false,
        reason: (nonAbortFailure && nonAbortFailure.reason) || 'goldmine_timeout',
        diag: (nonAbortFailure && nonAbortFailure.diag) || 'All Goldmine provider requests failed'
      });
    };

    const scheduleSettleIn = (delayMs) => {
      const clamped = Math.max(0, delayMs);
      const targetAt = Date.now() + clamped;
      if (targetAt >= settleDeadline) return;
      settleDeadline = targetAt;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finalize, clamped);
    };

    const evaluateProgress = () => {
      if (finished) return;
      const {
        mergedRaw,
        reliableProviders,
        reliableCount,
        hasMkvOrMulti,
        hasWantedAudio,
        mkvExtractorInFlight
      } = collectCurrentState();

      // If Wave 1 completely finished without any portable streams and Wave 2 is
      // still waiting, launch Wave 2 right away instead of settling on IP-bound MP4s.
      if (inFlight === 0 && reliableCount === 0 && !wave2Launched) {
        launchWave2();
        return;
      }

      // Nothing left in flight (and either we already have streams or Wave 2 also ran): settle now.
      if (inFlight === 0 && (wave2Launched || mergedRaw.length > 0)) {
        finalize();
        return;
      }

      // Never let Render-IP-bound MP4 ladders (PStream / Vidlink) start the
      // abort countdown before portable MKV/HLS providers have answered.
      if (reliableCount === 0) return;

      const fanoutElapsed = Date.now() - fanoutStartedAt;
      if (hasMkvOrMulti && reliableProviders >= 2 && hasWantedAudio) {
        scheduleSettleIn(320);
      } else if (hasMkvOrMulti && hasWantedAudio) {
        scheduleSettleIn(850);
      } else if (mkvExtractorInFlight) {
        // A fast HLS/MP4 backup arrived while 4khdhub/dahmermovies/castletv is
        // still scraping MKV mirrors (typically 5–8s): give MKV extractors room.
        scheduleSettleIn(Math.max(600, 7500 - fanoutElapsed));
      } else {
        scheduleSettleIn(Math.max(400, 3500 - fanoutElapsed));
      }
    };

    const launchProvider = (providerId) => {
      if (finished) return;
      const ctrl = new AbortController();
      controllers.set(providerId, ctrl);
      inFlight += 1;
      launchedCount += 1;
      const t0 = Date.now();
      const perProviderBudget = Math.min(remainingMs(), 15000);

      fetchGoldmineStreams({
        apiBase,
        type,
        tmdbId,
        season,
        episode,
        provider: providerId,
        timeoutMs: perProviderBudget,
        fetchImpl,
        signal: ctrl.signal
      })
        .then((res) => {
          controllers.delete(providerId);
          inFlight = Math.max(0, inFlight - 1);
          if (finished) return;

          if (res.ok && res.json) {
            okResponses += 1;
            const list = Array.isArray(res.json.streams) ? res.json.streams : [];
            const tagged = list.map((s) => (s && typeof s === 'object' && !s.provider ? { ...s, provider: providerId } : s));
            streamsByProvider.set(providerId, tagged);
            const upstreamMs =
              res.json.providerTimings && typeof res.json.providerTimings[providerId] === 'number'
                ? res.json.providerTimings[providerId]
                : Date.now() - t0;
            providerTimings[providerId] = upstreamMs;
            if (!resolvedImdbId && res.json.imdbId) resolvedImdbId = res.json.imdbId;
          } else {
            providerTimings[providerId] = null;
            if (res.reason === 'goldmine_source_unknown') unknownRouteCount += 1;
            if (res.reason && res.reason !== 'goldmine_aborted') {
              failureReasons.push({ provider: providerId, reason: res.reason, diag: res.diag });
            }
          }
          evaluateProgress();
        })
        .catch((err) => {
          controllers.delete(providerId);
          inFlight = Math.max(0, inFlight - 1);
          if (finished) return;
          providerTimings[providerId] = null;
          failureReasons.push({
            provider: providerId,
            reason: 'goldmine_unreachable',
            diag: err && err.message ? err.message : String(err)
          });
          evaluateProgress();
        });
    };

    const launchWave2 = () => {
      if (finished || wave2Launched) return;
      wave2Launched = true;
      if (wave2Timer) {
        clearTimeout(wave2Timer);
        wave2Timer = null;
      }
      for (const providerId of wave2) launchProvider(providerId);
      if (inFlight === 0) finalize();
    };

    hardTimer = setTimeout(finalize, remainingMs());
    for (const providerId of wave1) launchProvider(providerId);

    if (!wave2Launched) {
      const wave2Delay = Math.min(2200, Math.max(300, Math.floor(remainingMs() * 0.4)));
      wave2Timer = setTimeout(launchWave2, wave2Delay);
    }
  });
}

/**
 * Full Goldmine resolution for one title — the entry both runtimes call.
 *
 * `options` (all optional):
 *   apiBase, timeoutMs, fetchImpl     — how to reach the TMDB-Embed-API
 *   onlySource                        — pin one provider id (manual source pick)
 *   preferredAudio                    — viewer language preference (?lang=)
 *   proxyStreams / proxyUrl           — runtime URL proxying (see module head)
 *
 * Returns the resolver payload on success, or `{ reason, diag }` on failure —
 * the waterfall's per-attempt diagnostics pick those up.
 */
async function resolveGoldmineServer(metadata, options = {}) {
  const {
    apiBase = GOLDMINE_DEFAULT_API_BASE,
    timeoutMs = 25000,
    fetchImpl = null,
    onlySource = '',
    preferredAudio = '',
    proxyStreams = true,
    proxyUrl = null
  } = options;

  if (!metadata || !metadata.tmdbId) {
    return { reason: 'goldmine_no_title', diag: 'missing TMDB id' };
  }

  const provider = String(onlySource || '').toLowerCase();
  const mediaType = metadata.type === 'movie' ? 'movie' : 'series';
  const fetched = provider
    ? await fetchGoldmineStreams({
        apiBase,
        type: mediaType,
        tmdbId: metadata.tmdbId,
        season: metadata.season || null,
        episode: metadata.episode || null,
        provider,
        timeoutMs,
        fetchImpl
      })
    : await fetchGoldmineStreamsFast({
        apiBase,
        type: mediaType,
        tmdbId: metadata.tmdbId,
        season: metadata.season || null,
        episode: metadata.episode || null,
        preferredAudio,
        timeoutMs,
        fetchImpl
      });

  if (!fetched.ok) {
    return { reason: fetched.reason, diag: fetched.diag };
  }

  const normalized = normalizeGoldminePayload(fetched.json);
  if (normalized.streams.length === 0) {
    return {
      reason: provider ? 'goldmine_source_empty' : 'goldmine_no_streams',
      diag: provider
        ? `TMDB-Embed-API provider "${provider}" returned no playable streams`
        : 'TMDB-Embed-API returned no playable streams for this title'
    };
  }

  const payload = buildGoldminePayload(normalized, {
    apiBase,
    proxyStreams,
    proxyUrl,
    onlySource: provider,
    preferredAudio
  });
  if (payload && payload.reason) return payload;
  return payload;
}

/**
 * Owner diagnostic — answers "is the TMDB-Embed-API up and what does it have
 * for this title?" with data instead of logs. Exposed via
 * `GET /api/admin/goldmine/diagnose/:type/:tmdbId`.
 */
async function diagnoseGoldmine(metadata, options = {}) {
  const {
    apiBase = GOLDMINE_DEFAULT_API_BASE,
    timeoutMs = 30000,
    fetchImpl = null
  } = options;
  const startedAt = Date.now();
  const report = {
    ok: false,
    apiBase,
    metadata: {
      type: metadata.type,
      tmdbId: metadata.tmdbId,
      title: metadata.title,
      season: metadata.season || null,
      episode: metadata.episode || null
    },
    providers: []
  };

  const fetched = await fetchGoldmineStreams({
    apiBase,
    type: metadata.type === 'movie' ? 'movie' : 'series',
    tmdbId: metadata.tmdbId,
    season: metadata.season || null,
    episode: metadata.episode || null,
    timeoutMs,
    fetchImpl
  });
  report.totalMs = Date.now() - startedAt;
  if (!fetched.ok) {
    report.reason = fetched.reason;
    report.diag = fetched.diag;
    return report;
  }

  const normalized = normalizeGoldminePayload(fetched.json);
  report.ok = normalized.streams.length > 0;
  report.imdbId = normalized.imdbId;
  report.streamCount = normalized.streams.length;
  report.languages = [];
  const languageCounts = new Map();
  for (const stream of normalized.streams) {
    for (const language of stream.languages) {
      languageCounts.set(language.code, (languageCounts.get(language.code) || 0) + 1);
    }
  }
  for (const [code, count] of languageCounts) {
    report.languages.push({ code, label: languageLabelForCode(code), count });
  }
  report.providers = normalized.providers.map((provider) => {
    const best = provider.streams[0];
    return {
      id: provider.id,
      streams: provider.streams.length,
      ms: provider.timingMs,
      best: best
        ? {
            url: best.url,
            quality: best.height > 0 ? heightToLabel(best.height) : best.qualityLabel,
            container: best.container,
            languages: best.languages.map((language) => language.code),
            multi: best.multi
          }
        : null
    };
  });
  return report;
}

module.exports = {
  GOLDMINE_DEFAULT_API_BASE,
  GOLDMINE_PROVIDER_LABELS,
  MOVI_CONTAINERS,
  FAST_WAVE_PROVIDERS,
  SECONDARY_WAVE_PROVIDERS,
  goldmineTypeFor,
  qualityToHeight,
  heightToLabel,
  containerForStream,
  isEphemeralIpBoundStream,
  normalizeGoldmineStream,
  scoreGoldmineStream,
  normalizeGoldminePayload,
  buildGoldminePayload,
  sourceLabelFor,
  splitHeaders,
  proxyMetaFromHeaders,
  fetchGoldmineProviders,
  clearGoldmineProviderCache,
  fetchGoldmineStreams,
  fetchGoldmineStreamsFast,
  resolveGoldmineServer,
  diagnoseGoldmine
};
