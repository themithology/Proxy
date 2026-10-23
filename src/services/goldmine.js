/**
 * Goldmine — TMDB-Embed-API source resolver.
 *
 * The Goldmine server resolves streams through a self-hosted TMDB-Embed-API
 * instance (https://github.com/themithology/TMDB-Embed-API). That API
 * aggregates a dozen providers (Showbox/FebBox, 4KHDHub, VidLink, Videasy,
 * DahmerMovies, …) behind one JSON endpoint:
 *
 *   GET {base}/api/streams/{movie|series}/{tmdbId}[?season=&episode=]
 *   GET {base}/api/streams/{provider}/{movie|series}/{tmdbId}[?season=&episode=]
 *
 *   -> { success, tmdbId, imdbId, count, providerTimings,
 *        streams: [{ name, title, url, quality, provider, headers?, subtitles? }] }
 *
 * Most of those streams are progressive MKV/MP4 files — several with multiple
 * audio tracks (dubs) muxed inside one file, others as one file per language.
 * The browser cannot play MKV (or switch dubs inside one) natively, so the
 * player runs them through the bundled movi-player element (FFmpeg WASM +
 * WebCodecs): `engine: 'movi'` in the payload tells `public/js/embed.js` to
 * attach the movi-player instead of the native <video>.
 *
 * This module is the single source of truth for that resolution. It is pure
 * JS (fetch + URL only, no Buffer, no Node APIs) so BOTH runtimes share it:
 *
 *   - Node backend:  src/services/resolver.js  -> resolveStreamForServer()
 *   - CF Worker:     cloudflare-worker/worker.js -> resolveStreamWaterfall()
 *
 * The runtime injects what it owns: the API base URL, a timeout, and a
 * `proxyUrl(url, referer)` callback that wraps direct file URLs in that
 * runtime's signed /api/proxy URL (CORS + Range + upstream headers). URLs the
 * TMDB-Embed-API already proxied itself (`enableProxy` on → `{base}/ts-proxy?…`)
 * are passed through untouched — they already answer with `Access-Control-
 * Allow-Origin: *` and Range support.
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

/** Headers a browser fetch is not allowed to set — they must go through the
 *  server-side proxy instead of movi-player's `headers` attribute. */
const FORBIDDEN_BROWSER_HEADERS = new Set([
  'referer', 'referrer', 'origin', 'user-agent', 'cookie', 'host',
  'connection', 'content-length', 'date', 'dnt', 'upgrade-insecure-requests',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'sec-fetch-dest',
  'accept-encoding', 'accept-language', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'via', 'keep-alive', 'set-cookie'
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
      return new URL(url).search.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (/\.m3u8/.test(query)) return 'hls';
  if (/\.mpd/.test(query)) return 'dash';
  if (/\.mkv/.test(query)) return 'mkv';
  if (/\.mp4/.test(query)) return 'mp4';
  return 'unknown';
}

/** Progressive containers the movi engine takes over from the native <video>. */
const MOVI_CONTAINERS = new Set(['mkv', 'mp4', 'webm', 'avi', 'mov', 'ts', 'unknown']);

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

  return {
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
    subtitles
  };
}

/**
 * Rank a stream for "which one plays first".
 * Dub coverage dominates (the Goldmine server exists for multi-audio MKVs),
 * then a sane resolution (1080p — 4K HEVC is heavy on a WASM decoder), then
 * container preference.
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

  if (stream.container === 'mkv') score += 40; // multi-audio releases live in MKV
  else if (stream.container === 'mp4') score += 30;
  else if (stream.container === 'hls') score += 20;
  else if (stream.container === 'webm' || stream.container === 'ts') score += 10;
  else if (stream.container === 'dash' || stream.container === 'ism') score += 5;
  else score += 15; // unknown progressive — movi can still open it

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
    else browserSafe[key] = String(value);
  }
  return { serverSide, browserSafe };
}

function refererFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'referer' || String(key).toLowerCase() === 'referrer') {
      return String(value || '');
    }
  }
  return '';
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
 *   - proxyUrl(url, referer) — runtime callback that builds the proxied URL
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
  const playableUrl = (stream) => {
    if (playableCache.has(stream.url)) return playableCache.get(stream.url);
    const referer = refererFromHeaders(stream.headers);
    const sameHostAsApi = hostOf(stream.url) === apiHost;
    let playable = stream.url;
    if (!sameHostAsApi && proxyStreams && typeof proxyUrl === 'function') {
      playable = proxyUrl(stream.url, referer) || stream.url;
    }
    playableCache.set(stream.url, playable);
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
  // (`inFile: true`) are switched inside the running file by movi-player
  // (selectAudioLang); rows that live in their own file switch the src and
  // keep the playhead. When the primary only says "Multi-Audio" without
  // naming languages, emit a single discovery row — the player replaces it
  // with the real tracks once movi-player demuxes the file (getAudioLangs).
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
      lang: primary.multi ? 'und' : 'und',
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
  // Seed with the primary's own height: a mirror of the SAME resolution is a
  // backup source, not a quality variant.
  const seenHeights = new Set(primary.height > 0 ? [primary.height] : []);
  const qualities = [];
  for (const stream of groupStreams) {
    if (stream === primary) continue;
    if (stream.height === 0 || seenHeights.has(stream.height)) continue;
    // Only offer variants that keep the primary's language coverage, so a
    // quality switch never silently drops the viewer's dub.
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
  const backupUrls = [];
  const sourceLabels = {};
  sourceLabels[primaryPlayable] = sourceLabelFor(primary);
  for (const stream of ordered) {
    if (stream === primary) continue;
    const playable = playableUrl(stream);
    if (playable === primaryPlayable) continue;
    if (!sourceLabels[playable]) sourceLabels[playable] = sourceLabelFor(stream);
    if (!backupUrls.includes(playable)) backupUrls.push(playable);
    if (backupUrls.length >= 12) break;
  }

  // --- Embedded subtitles from the primary stream ---------------------------
  const embeddedSubtitles = primary.subtitles.map((sub, index) => ({
    id: `goldmine-sub-${index}`,
    lang: sub.lang || 'und',
    label: sub.label || languageLabelForCode(sub.lang),
    url:
      proxyStreams && hostOf(sub.url) !== apiHost && typeof proxyUrl === 'function'
        ? proxyUrl(sub.url, refererFromHeaders(primary.headers)) || sub.url
        : sub.url
  }));

  const engine = MOVI_CONTAINERS.has(primary.container) ? 'movi' : undefined;

  return {
    server: 'goldmine',
    engine,
    format: primary.container === 'hls' ? 'hls' : primary.container === 'dash' ? 'dash' : primary.container,
    rawUrl: primary.url,
    streamUrl: primaryPlayable,
    referer: refererFromHeaders(primary.headers),
    headers: {},
    // Browser-safe custom headers only (Authorization, X-Api-Key…) — the
    // player passes these to movi-player's `headers` attribute. Forbidden
    // headers (Referer/UA/Cookie) are applied server-side by the proxy.
    moviHeaders: Object.keys(primaryBrowserHeaders).length > 0 ? primaryBrowserHeaders : undefined,
    progressiveFormat: engine === 'movi' ? primary.container : undefined,
    audioTracks,
    qualities,
    backupUrls,
    sourceLabels,
    languages,
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
 * Fetch streams from the TMDB-Embed-API instance.
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
    fetchImpl = null
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
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.max(3000, timeoutMs))
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
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, reason: 'goldmine_timeout', diag: `TMDB-Embed-API did not answer within ${timeoutMs}ms (cold start?)` };
    }
    return { ok: false, reason: 'goldmine_unreachable', diag: error && error.message ? error.message : String(error) };
  }
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
    timeoutMs = 30000,
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
  const fetched = await fetchGoldmineStreams({
    apiBase,
    type: metadata.type === 'movie' ? 'movie' : 'series',
    tmdbId: metadata.tmdbId,
    season: metadata.season || null,
    episode: metadata.episode || null,
    provider,
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
  goldmineTypeFor,
  qualityToHeight,
  heightToLabel,
  containerForStream,
  normalizeGoldmineStream,
  scoreGoldmineStream,
  normalizeGoldminePayload,
  buildGoldminePayload,
  sourceLabelFor,
  splitHeaders,
  fetchGoldmineStreams,
  resolveGoldmineServer,
  diagnoseGoldmine
};
