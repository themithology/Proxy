/**
 * Hamster Wheel — server #3 provider layer.
 *
 * WHAT THIS IS
 * ------------
 * Three Hindi-first upstreams behind one candidate list. Unlike Andromeda and
 * Centaurus (which are hand-written cascades against a single vendor), Hamster
 * Wheel is a fan-out: every provider is queried in parallel, every provider
 * returns *candidates* (URL + quality + audio + headers), and the caller
 * (`resolver.resolveHamsterServer`) unrolls, probes and ranks them before a
 * stream is handed to the player. A dead provider therefore degrades into a
 * diagnostic instead of a failed playback.
 *
 * PROVIDERS
 * ---------
 *  1. moviebox  — MovieBox mobile BFF (`api*.aoneroom.com`, HMAC-signed).
 *                 Same upstream family the NetMirror tier already uses for dub
 *                 metadata, so it is reachable from datacenter IPs. Returns
 *                 direct MP4/DASH links. Multi-audio (Hindi dubs included).
 *  2. hindmoviez — hindmovie.dev (Hindi movie/series releases) → gdshine /
 *                 hubcloud release links.
 *  3. 4khdhub   — 4khdhub.one (Indian 4K + Hindi-dubbed South releases) →
 *                 hubcloud / hubdrive / greenmotors / pixeldrain links.
 *
 * DOMAIN ROTATION
 * ---------------
 * Indian release sites rotate domains every few weeks. Instead of hardcoding
 * them, the site bases are resolved through a public `domains.json` (refreshed
 * by the phisher98/TVVVV repo and used by the ZORO/SkyStream plugin line) and
 * cached for `HAMSTER_DOMAINS_TTL_MS`. Env fallbacks are used when the list is
 * unreachable.
 *
 * ATTRIBUTION
 * -----------
 * The MovieBox signing scheme and the 4KHDHub/HubCloud extraction flow are
 * ports of Shawon727/StreamHub-Api (MIT). The HindMoviez flow is a port of
 * `hindmoviez/plugin.js` from likhithkrishna1103-tech/Hindmovie (ZORO for
 * SkyStream). Both were rewritten for this codebase; see
 * docs/hamster-wheel-upstream-research.md.
 */

'use strict';

const crypto = require('crypto');
const cheerio = require('cheerio');
const config = require('../config');
const { circuitBreaker } = require('../utils/cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** Provider ids in fan-out order (also the ranking tie-breaker). */
const HAMSTER_PROVIDERS = ['moviebox', 'hindmoviez', '4khdhub'];

/** MovieBox HMAC secret — a fixed public client key, overridable by env. */
const MOVIEBOX_DEFAULT_SECRET_HEX =
  'efa891974eecd3148df63aa611602defd101259ba521022c57ae0566bd8e';

const MOVIEBOX_DEFAULT_HOSTS = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com'
];

const GDShineApi = 'https://gdshine.org';
const HDHUB_FALLBACK = 'https://4khdhub.one';
const HINDMOVIEZ_FALLBACK = 'https://hindmovie.dev';

const siteBaseCache = { value: null, expires: 0, inflight: null };

/* ------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* ------------------------------------------------------------------------- */

function md5hex(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function randomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractYear(value) {
  const match = String(value || '').match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : 0;
}

function parseQuality(value) {
  const text = String(value || '').toLowerCase();
  if (/2160p|4k|uhd/.test(text)) return { label: '2160p', height: 2160 };
  if (/1080p/.test(text)) return { label: '1080p', height: 1080 };
  if (/720p/.test(text)) return { label: '720p', height: 720 };
  if (/480p/.test(text)) return { label: '480p', height: 480 };
  if (/360p/.test(text)) return { label: '360p', height: 360 };
  return { label: 'Auto', height: 0 };
}

/**
 * Coarse audio hint from release text. `multi` means the file (or track)
 * carries Hindi plus another language — treated as Hindi-primary downstream.
 */
function parseAudioHint(value) {
  const text = String(value || '').toLowerCase();
  const hindi = /hindi|हिन्दी|हिंदी/.test(text);
  const english = /english|\beng\b/.test(text);
  const dual = /dual[\s._-]*audio|multi[\s._-]*(?:audio|lang)/.test(text);
  if (hindi && (english || dual)) return 'multi';
  if (hindi) return 'hi';
  if (dual) return 'multi';
  if (english) return 'en';
  return 'und';
}

function kindFromUrl(url) {
  const path = String(url || '').split('#')[0].split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mp4')) return 'mp4';
  if (path.endsWith('.mkv')) return 'mkv';
  if (path.endsWith('.mpd')) return 'dash';
  return 'unknown';
}

function safeUrl(href, base) {
  try {
    return new URL(String(href || '').trim(), base).href;
  } catch {
    return '';
  }
}

/** PixelDrain file pages are rewritten to the direct API download URL. */
function pixeldrainDirect(url) {
  try {
    const parsed = new URL(url);
    if (!/pixeldrain\./i.test(parsed.hostname)) return '';
    const match = parsed.pathname.match(/^\/(?:u|api\/file)\/([A-Za-z0-9]+)/);
    if (!match) return '';
    return `https://${parsed.hostname}/api/file/${match[1]}?download`;
  } catch {
    return '';
  }
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.url) continue;
    const key = String(item.url).split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function hamsterConfig() {
  return (config && config.hamster) || {};
}

/**
 * Rank candidates before probing: Hindi first, then quality, then format
 * (direct MP4/HLS beat MKV, which needs an ffmpeg remux on the Node tier).
 * Provider order is the final tie-breaker so MovieBox (API, no scraping) wins
 * ties against the scrapers.
 */
function candidateScore(candidate) {
  let score = 0;
  const providerIndex = HAMSTER_PROVIDERS.indexOf(candidate.provider);
  score += providerIndex === -1 ? 0 : (HAMSTER_PROVIDERS.length - providerIndex) * 5;
  if (candidate.audio === 'hi') score += 30;
  else if (candidate.audio === 'multi') score += 22;
  else if (candidate.audio === 'und') score += 8;
  score += Math.min(40, Math.round((candidate.height || 0) / 100));
  if (candidate.kind === 'hls') score += 12;
  else if (candidate.kind === 'mp4') score += 10;
  else if (candidate.kind === 'mkv') score += 4;
  else if (candidate.kind === 'dash') score -= 20;
  if (candidate.needsUnroll) score -= 3;
  return score;
}

function sortCandidates(list) {
  return [...list].sort((a, b) => candidateScore(b) - candidateScore(a));
}

/** Timeout-bounded fetch that also honours an outer abort signal. */
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 9000, signal, headers = {}, method = 'GET', body } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  const abortOuter = () => controller.abort();
  signal?.addEventListener?.('abort', abortOuter, { once: true });
  try {
    return await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortOuter);
  }
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function postJson(url, body, options = {}) {
  const response = await fetchWithTimeout(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

/* ------------------------------------------------------------------------- */
/* Rotating site domains                                                      */
/* ------------------------------------------------------------------------- */

async function loadSiteBases(signal) {
  const settings = hamsterConfig();
  const ttl = Number(settings.domainsTtlMs) || 30 * 60 * 1000;
  if (siteBaseCache.value && Date.now() < siteBaseCache.expires) return siteBaseCache.value;
  if (siteBaseCache.inflight) return siteBaseCache.inflight;

  const url = settings.domainsUrl || 'https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json';
  siteBaseCache.inflight = (async () => {
    const bases = {};
    try {
      const json = await fetchJson(url, { timeoutMs: 6000, signal });
      for (const [key, value] of Object.entries(json || {})) {
        if (typeof value === 'string' && /^https?:\/\//i.test(value)) bases[key.toLowerCase()] = value.replace(/\/$/, '');
      }
    } catch {
      // Network-blocked or repo moved: fall back to env/default bases below.
    }
    siteBaseCache.value = bases;
    siteBaseCache.expires = Date.now() + ttl;
    siteBaseCache.inflight = null;
    return bases;
  })();

  try {
    return await siteBaseCache.inflight;
  } catch {
    siteBaseCache.inflight = null;
    return siteBaseCache.value || {};
  }
}

async function siteBase(key, fallback, signal) {
  const bases = await siteBaseCandidates(key, [fallback], signal);
  return bases[0];
}

/**
 * Same as `siteBase`, but returns every known base for a site in preference
 * order (domains.json value first, then env/default fallbacks). Release sites
 * rotate domains without notice, so callers walk this list until one answers.
 */
async function siteBaseCandidates(key, fallbacks = [], signal) {
  const bases = await loadSiteBases(signal);
  const flagged = bases[key] || bases[key.toLowerCase()];
  const list = [flagged, ...(Array.isArray(fallbacks) ? fallbacks : [fallbacks])]
    .filter(Boolean)
    .map((value) => String(value).replace(/\/$/, ''));
  return [...new Set(list)];
}

/* ------------------------------------------------------------------------- */
/* Provider 1 — MovieBox (HMAC mobile BFF)                                    */
/* ------------------------------------------------------------------------- */

const movieboxState = {
  token: null,
  tokenExp: 0,
  hostIndex: 0,
  deviceId: randomHex(32),
  gaid: crypto.randomUUID(),
  inflightSession: null
};

function movieboxSignature(method, url, body) {
  const settings = hamsterConfig();
  const ts = Date.now();
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalPath = parsed.pathname + (query ? `?${query}` : '');
  const bodyBuffer = Buffer.from(body || '', 'utf8');
  const bodyHash = bodyBuffer.length ? md5hex(bodyBuffer) : '';
  const bodyLength = bodyBuffer.length ? String(bodyBuffer.length) : '';
  const canonical = `${method.toUpperCase()}\napplication/json\napplication/json\n${bodyLength}\n${ts}\n${bodyHash}\n${canonicalPath}`;
  const secret = Buffer.from(settings.movieboxSecretHex || MOVIEBOX_DEFAULT_SECRET_HEX, 'hex');
  const signature = crypto.createHmac('md5', secret).update(canonical).digest('base64');
  const reversed = String(ts).split('').reverse().join('');

  const versionCode = 50020119;
  const clientInfo = JSON.stringify({
    package_name: 'com.community.oneroom',
    version_name: '4.0.01.0813.03',
    version_code: versionCode,
    os: 'android',
    os_version: '13',
    install_ch: 'ps',
    device_id: movieboxState.deviceId,
    install_store: 'ps',
    gaid: movieboxState.gaid,
    brand: 'Redmi',
    model: '23078RKD5C',
    system_language: 'en',
    net: 'NETWORK_WIFI',
    region: settings.movieboxRegion || 'IN',
    timezone: 'Asia/Kolkata',
    sp_code: '40401',
    'X-Play-Mode': '2'
  });

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'User-Agent': `com.community.oneroom/${versionCode} (Linux; U; Android 13; en_US; 23078RKD5C; Build/TQ2A.230405.003; Cronet/135.0.7012.3)`,
    'x-client-token': `${ts},${md5hex(reversed)}`,
    'x-tr-signature': `${ts}|2|${signature}`,
    'x-client-info': clientInfo,
    'x-client-status': '0',
    'x-forwarded-for': `103.241.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
  };
}

async function movieboxRequest(method, path, options = {}) {
  const settings = hamsterConfig();
  const hosts = (settings.movieboxHosts || MOVIEBOX_DEFAULT_HOSTS).map((h) => h.replace(/\/$/, ''));
  const body = options.body || (method === 'POST' ? '' : undefined);
  let lastError = 'no_hosts';

  for (let i = 0; i < hosts.length; i += 1) {
    const index = (movieboxState.hostIndex + i) % hosts.length;
    const base = hosts[index];
    const url = base + path;
    const headers = movieboxSignature(method, url, body);
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    try {
      const response = await fetchWithTimeout(url, {
        method,
        body,
        headers,
        timeoutMs: options.timeoutMs || 8000,
        signal: options.signal
      });
      if ([403, 406, 429, 500, 502, 503, 504].includes(response.status)) {
        lastError = `${base}->${response.status}`;
        continue;
      }
      if (!response.ok) {
        lastError = `${base}->${response.status}`;
        continue;
      }
      movieboxState.hostIndex = index;
      try {
        return await response.json();
      } catch {
        return { raw: (await response.text()).slice(0, 2000) };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'request_failed';
    }
  }
  throw new Error(`MovieBox upstream failed (${lastError})`);
}

function movieboxUnwrap(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') return payload.data;
  return payload && typeof payload === 'object' ? payload : {};
}

async function movieboxSession(signal) {
  if (movieboxState.token && Date.now() < movieboxState.tokenExp) return movieboxState.token;
  if (movieboxState.inflightSession) return movieboxState.inflightSession;
  movieboxState.inflightSession = (async () => {
    try {
      const data = await movieboxRequest('POST', '/wefeed-mobile-bff/user-api/visitor-login', { body: '{}', signal });
      const token = movieboxUnwrap(data).token || data.token;
      if (!token) throw new Error('MovieBox visitor-login returned no token');
      movieboxState.token = String(token);
      movieboxState.tokenExp = Date.now() + 3500 * 1000;
      return movieboxState.token;
    } finally {
      movieboxState.inflightSession = null;
    }
  })();
  return movieboxState.inflightSession;
}

function movieboxSearchItems(payload) {
  const inner = movieboxUnwrap(payload);
  const items = [];
  for (const block of inner.results || []) {
    for (const subject of block.subjects || []) {
      const cover = subject.cover;
      items.push({
        subjectId: subject.subjectId || subject.id,
        title: subject.title || subject.name || '',
        type: subject.subjectType,
        year: extractYear(subject.releaseDate || subject.year),
        cover: cover && typeof cover === 'object' ? cover.url : cover
      });
    }
  }
  return items;
}

function pickMovieBoxSubject(items, metadata) {
  const wantedTitle = normalizeTitle(metadata.title);
  const wantedYear = Number(metadata.releaseYear) || 0;
  const isTv = metadata.type === 'tv';
  let best = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const title = normalizeTitle(item.title);
    let score = 0;
    if (title === wantedTitle) score += 100;
    else if (title.startsWith(wantedTitle) || wantedTitle.startsWith(title)) score += 60;
    else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 35;
    else continue;
    if (wantedYear && item.year) {
      const delta = Math.abs(item.year - wantedYear);
      if (delta === 0) score += 80;
      else if (delta <= 1) score += 55;
      else if (delta <= 3) score += 15;
      else score -= 30;
    }
    const typeText = String(item.type ?? '').toLowerCase();
    if (isTv && /series|tv|show|season/.test(typeText)) score += 25;
    if (!isTv && /movie|film/.test(typeText)) score += 25;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 35 ? best : null;
}

function movieboxStreamCandidates(payload, subject, metadata) {
  const inner = movieboxUnwrap(payload);
  const streams = inner.streams || inner.list || [];
  const candidates = [];
  for (const stream of Array.isArray(streams) ? streams : []) {
    if (!stream || typeof stream !== 'object') continue;
    const url = stream.url || stream.playUrl || stream.streamUrl;
    if (!url) continue;
    const quality = parseQuality(stream.resolutions || stream.quality || stream.resolution);
    const kind = kindFromUrl(url) === 'unknown' ? 'mp4' : kindFromUrl(url);
    // DASH manifests are kept only as a last resort: the player pipeline is
    // HLS/MP4, and the Worker cannot remux.
    if (kind === 'dash') continue;
    const cookie = stream.signCookie || stream.cookie || '';
    candidates.push({
      provider: 'moviebox',
      url,
      kind,
      quality: quality.label,
      height: quality.height,
      audio: parseAudioHint(stream.language || stream.lang || stream.audioLang || subject.title),
      label: `MovieBox · ${quality.label}`,
      referer: 'https://moviebox.ph/',
      headers: cookie ? { Cookie: cookie } : {},
      needsUnroll: false,
      origin: `moviebox:${subject.subjectId}`
    });
  }
  return candidates;
}

function movieboxResourceCandidates(payload) {
  const inner = movieboxUnwrap(payload);
  const candidates = [];
  for (const item of inner.list || []) {
    const url = item.resourceLink || item.url;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const quality = parseQuality(item.resolution || item.title);
    const kind = kindFromUrl(url) === 'unknown' ? 'link' : kindFromUrl(url);
    if (kind === 'link') continue;
    candidates.push({
      provider: 'moviebox',
      url,
      kind,
      quality: quality.label,
      height: quality.height,
      audio: parseAudioHint(item.title),
      label: `MovieBox · ${quality.label}`,
      referer: 'https://moviebox.ph/',
      headers: {},
      needsUnroll: false,
      origin: 'moviebox:resource'
    });
  }
  return candidates;
}

async function movieboxCandidates(metadata, ctx) {
  const token = await movieboxSession(ctx.signal);
  const searchBody = JSON.stringify({ keyword: metadata.title, page: 1, perPage: 15 });
  const searchPayload = await movieboxRequest('POST', '/wefeed-mobile-bff/subject-api/search/v2', {
    body: searchBody,
    token,
    signal: ctx.signal,
    timeoutMs: ctx.providerTimeoutMs
  });
  const subject = pickMovieBoxSubject(movieboxSearchItems(searchPayload), metadata);
  if (!subject) return [];

  const isTv = metadata.type === 'tv';
  const suffix = isTv ? `&se=${metadata.season || 1}&ep=${metadata.episode || 1}` : '';
  const playPayload = await movieboxRequest(
    'GET',
    `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${encodeURIComponent(subject.subjectId)}${suffix}`,
    { token, signal: ctx.signal, timeoutMs: ctx.providerTimeoutMs }
  );
  let candidates = movieboxStreamCandidates(playPayload, subject, metadata);

  if (candidates.length === 0) {
    const resourcePayload = await movieboxRequest(
      'GET',
      `/wefeed-mobile-bff/subject-api/resource?subjectId=${encodeURIComponent(subject.subjectId)}${suffix}&page=1&perPage=20`,
      { token, signal: ctx.signal, timeoutMs: ctx.providerTimeoutMs }
    );
    candidates = movieboxResourceCandidates(resourcePayload);
  }
  return candidates;
}

/* ------------------------------------------------------------------------- */
/* Provider 2 — HindMoviez (hindmovie.dev → gdshine / hubcloud)               */
/* ------------------------------------------------------------------------- */

function parseHindMoviezArticles(html, base) {
  const $ = cheerio.load(html || '');
  const results = [];
  $('article').each((_, element) => {
    const $el = $(element);
    const $link = $el.find('h2 a, h3 a, .entry-title a').first().length
      ? $el.find('h2 a, h3 a, .entry-title a').first()
      : $el.find('a[href]').first();
    const href = $link.attr('href');
    const title = ($link.text() || $el.find('h2, h3').first().text() || '').replace(/\s+/g, ' ').trim();
    if (!href || !title) return;
    const url = safeUrl(href, base);
    if (!url) return;
    results.push({ title, url, year: extractYear($el.text()) });
  });
  if (results.length > 0) return results;

  // Fallback for theme changes: any anchor that looks like a post permalink.
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const title = ($(element).text() || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3) return;
    if (!/\/\d{4}\//.test(href) && !/\/(movie|series|web-series)\//i.test(href)) return;
    const url = safeUrl(href, base);
    if (url) results.push({ title, url, year: extractYear(title) });
  });
  return results;
}

function parseHindMoviezPageLinks(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const links = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const text = ($(element).text() || '').replace(/\s+/g, ' ').trim();
    const url = safeUrl(href, pageUrl);
    if (!url || !/^https?:/i.test(url)) return;
    links.push({ url, text, quality: parseQuality(`${text} ${url}`) });
  });
  // De-dupe by URL, keep the richest label.
  const seen = new Map();
  for (const link of links) {
    const existing = seen.get(link.url);
    if (!existing || (link.text || '').length > (existing.text || '').length) seen.set(link.url, link);
  }
  return [...seen.values()];
}

const RELEASE_HOST_RE = /(hubcloud|hubdrive|gdshine|gdtot|hshare|gdirect|gamerxyt|pixeldrain|gdflix|vcloud)/i;

function hindmoviezReleaseLinks(links) {
  return links.filter((link) => {
    if (RELEASE_HOST_RE.test(link.url)) return true;
    if (/\.(mkv|mp4|m3u8)(\?|$)/i.test(link.url)) return true;
    if (/(download|watch|480p|720p|1080p|2160p|4k)/i.test(link.text || '')) {
      // Only page-like links (not nav/anchors) qualify for a follow-up fetch.
      return /^https?:\/\//i.test(link.url);
    }
    return false;
  });
}

function gdshineFileId(url) {
  if (!/gdshine\./i.test(url)) return '';
  const id = String(url).replace(/[?#].*$/, '').split('/').filter(Boolean).pop();
  return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : '';
}

async function resolveGdshine(url, ctx) {
  const id = gdshineFileId(url);
  if (!id) return [];
  const headers = { Referer: `${GDShineApi}/`, Origin: GDShineApi };
  try {
    const filePayload = await fetchJson(`${GDShineApi}/api/files/s/${encodeURIComponent(id)}`, {
      headers,
      timeoutMs: ctx.providerTimeoutMs,
      signal: ctx.signal
    });
    const fileData = filePayload && filePayload.data ? filePayload.data : null;
    if (!fileData || !fileData.id) return [];
    const workerPayload = await postJson(`${GDShineApi}/api/downloads/${encodeURIComponent(fileData.id)}/via-worker`, {}, {
      headers,
      timeoutMs: ctx.providerTimeoutMs,
      signal: ctx.signal
    });
    const copyUrl = workerPayload && workerPayload.data ? workerPayload.data.copyUrl : '';
    if (!copyUrl || !/^https?:/i.test(copyUrl)) return [];
    const quality = parseQuality(fileData.name || '');
    const kind = kindFromUrl(copyUrl);
    return [
      {
        provider: 'hindmoviez',
        url: copyUrl,
        kind: kind === 'unknown' ? 'hls' : kind,
        quality: quality.label,
        height: quality.height,
        audio: parseAudioHint(fileData.name),
        label: `HindMoviez · Gdshine · ${quality.label}`,
        referer: `${GDShineApi}/`,
        headers: {},
        needsUnroll: false,
        origin: 'hindmoviez:gdshine'
      }
    ];
  } catch {
    return [];
  }
}

async function hindmoviezCandidates(metadata, ctx) {
  const base = await siteBase('hindmoviez', HINDMOVIEZ_FALLBACK, ctx.signal);
  const searchHtml = await fetchText(`${base}/?s=${encodeURIComponent(metadata.title)}`, {
    headers: { Referer: `${base}/` },
    timeoutMs: ctx.providerTimeoutMs,
    signal: ctx.signal
  });
  const articles = parseHindMoviezArticles(searchHtml, base);
  const wantedTitle = normalizeTitle(metadata.title);
  const wantedYear = Number(metadata.releaseYear) || 0;
  const ranked = articles
    .map((article) => {
      const title = normalizeTitle(article.title);
      let score = 0;
      if (title === wantedTitle) score += 100;
      else if (title.startsWith(wantedTitle) || title.includes(wantedTitle)) score += 60;
      else if (wantedTitle.includes(title)) score += 30;
      else return null;
      if (wantedYear && article.year) {
        const delta = Math.abs(article.year - wantedYear);
        score += delta === 0 ? 60 : delta <= 1 ? 40 : delta <= 2 ? 10 : -25;
      }
      return { ...article, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return [];
  const pageHtml = await fetchText(best.url, {
    headers: { Referer: `${base}/` },
    timeoutMs: ctx.providerTimeoutMs,
    signal: ctx.signal
  });

  const candidates = [];
  const pageLinks = hindmoviezReleaseLinks(parseHindMoviezPageLinks(pageHtml, best.url));
  for (const link of pageLinks) {
    if (/\.(mkv|mp4|m3u8)(\?|$)/i.test(link.url)) {
      candidates.push({
        provider: 'hindmoviez',
        url: link.url,
        kind: kindFromUrl(link.url),
        quality: link.quality.label,
        height: link.quality.height,
        audio: parseAudioHint(link.text),
        label: `HindMoviez · ${link.quality.label}`,
        referer: `${base}/`,
        headers: {},
        needsUnroll: false,
        origin: 'hindmoviez:direct'
      });
      continue;
    }
    if (gdshineFileId(link.url)) {
      candidates.push(...(await resolveGdshine(link.url, ctx)));
      continue;
    }
    if (RELEASE_HOST_RE.test(link.url)) {
      candidates.push({
        provider: 'hindmoviez',
        url: link.url,
        kind: 'unknown',
        quality: link.quality.label,
        height: link.quality.height,
        audio: parseAudioHint(link.text),
        label: `HindMoviez · ${link.quality.label}`,
        referer: `${base}/`,
        headers: {},
        needsUnroll: true,
        origin: 'hindmoviez:release'
      });
    }
  }

  // One follow-up hop for release/list pages that hide the real hosts.
  if (candidates.length === 0) {
    const followUps = pageLinks
      .filter((link) => !RELEASE_HOST_RE.test(link.url))
      .slice(0, 4);
    for (const link of followUps) {
      try {
        const html = await fetchText(link.url, {
          headers: { Referer: best.url },
          timeoutMs: ctx.providerTimeoutMs,
          signal: ctx.signal
        });
        const nested = hindmoviezReleaseLinks(parseHindMoviezPageLinks(html, link.url));
        for (const inner of nested) {
          if (gdshineFileId(inner.url)) candidates.push(...(await resolveGdshine(inner.url, ctx)));
          else if (/\.(mkv|mp4|m3u8)(\?|$)/i.test(inner.url) || RELEASE_HOST_RE.test(inner.url)) {
            candidates.push({
              provider: 'hindmoviez',
              url: inner.url,
              kind: kindFromUrl(inner.url),
              quality: inner.quality.label,
              height: inner.quality.height,
              audio: parseAudioHint(inner.text),
              label: `HindMoviez · ${inner.quality.label}`,
              referer: `${base}/`,
              headers: {},
              needsUnroll: RELEASE_HOST_RE.test(inner.url),
              origin: 'hindmoviez:nested'
            });
          }
        }
      } catch {
        // Ignore a single failed follow-up; other links may still resolve.
      }
    }
  }
  return candidates;
}

/* ------------------------------------------------------------------------- */
/* Provider 3 — 4KHDHub (Indian releases → hblinks → hubcloud → raw CDN link)  */
/* ------------------------------------------------------------------------- */
/*
 * The 2026 4KHDHub flow is three hops deep, and skipping any of them is why a
 * naive extractor "doesn't give a raw link":
 *
 *   search  →  title page  →  .download-item  →  hblinks / hubstream.dad
 *                                                   ↓ (link list, may recurse)
 *                                              hubcloud | hubdrive | direct
 *                                                   ↓
 *                                     `var url = '…'` indirection page
 *                                                   ↓
 *                                  10Gbps / PixelServer / R2 / ZipDisk / FSL
 *
 * Link-list hops also go through a redirect wrapper whose target hides behind
 * base64 → base64 → rot13 → base64 → JSON.o. `decodeReleaseRedirect()` undoes
 * that; the rest is plain HTML parsing. Reference: Nuvio `4khdhub.js`
 * (maintained, synced every 6 h) — see docs/hamster-wheel-upstream-research.md.
 */

const HDHUB_RELEASE_HINT = /hblinks|hubstream|hubcloud|hubdrive|hubcdn|gdflix|filepress/i;
const HDHUB_DIRECT_MEDIA = /\.(m3u8|mpd|mp4|mkv)(?:[?#]|$)/i;

function decodeBase64(value) {
  try {
    return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function rot13(value) {
  return String(value || '').replace(/[a-zA-Z]/g, (char) =>
    String.fromCharCode((char <= 'Z' ? 90 : 122) >= char.charCodeAt(0) + 13 ? char.charCodeAt(0) + 13 : char.charCodeAt(0) - 13)
  );
}

/**
 * Undo the 4KHDHub/gamerxyt-style redirect wrapper:
 * base64 → base64 → rot13 → base64 → JSON `{ o: <base64 target> }`.
 * Returns '' when the page is not a wrapper (i.e. it is already the target).
 */
function decodeReleaseRedirect(html) {
  const match = String(html || '').match(/'o'\s*,\s*'([^']+)'/);
  if (!match) return '';
  const step1 = decodeBase64(match[1]);
  if (!step1) return '';
  const step2 = decodeBase64(step1);
  if (!step2) return '';
  const step3 = rot13(step2);
  const step4 = decodeBase64(step3);
  if (!step4) return '';
  try {
    const parsed = JSON.parse(step4);
    const target = parsed && parsed.o ? decodeBase64(parsed.o) : '';
    return /^https?:\/\//i.test(target) ? target : '';
  } catch {
    return '';
  }
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Levenshtein distance — used to match `Jawan (2023)` against `Jawan`. */
function titleDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[t.length];
}

/** Search-result cards: `.movie-card` with format + year + title filters. */
function parseKHDHubCards(html, base) {
  const $ = cheerio.load(html || '');
  const cards = [];
  $('.movie-card').each((_, element) => {
    const $el = $(element);
    const href = $el.attr('href') || '';
    const url = safeUrl(href, base);
    const title = ($el.find('.movie-card-title').first().text() || $el.text() || '').replace(/\s+/g, ' ').trim();
    const format = ($el.find('.movie-card-format').first().text() || '').trim();
    const meta = ($el.find('.movie-card-meta').first().text() || '').replace(/\s+/g, ' ').trim();
    if (!url || !title) return;
    cards.push({
      url,
      title,
      format,
      meta,
      year: extractYear(meta) || extractYear(title),
      poster: $el.find('img').first().attr('src') || null
    });
  });
  if (cards.length > 0) return cards;

  // Theme-change fallback: post permalinks.
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    if (!/\/(movie|series|web-series)\//i.test(href)) return;
    const url = safeUrl(href, base);
    const title = ($(element).text() || '').replace(/\s+/g, ' ').trim();
    if (url && title.length > 2) cards.push({ url, title, format: '', meta: '', year: extractYear(title), poster: null });
  });
  return cards;
}

function pickKHDHubCard(cards, metadata, isSeries) {
  const wantedTitle = normalizeTitle(metadata.title);
  const wantedYear = Number(metadata.releaseYear) || 0;
  let best = null;
  let bestScore = -Infinity;
  for (const card of cards) {
    const cleanTitle = normalizeTitle(card.title.replace(/\[[^\]]*\]/g, ' '));
    const distance = titleDistance(cleanTitle, wantedTitle);
    // Accuracy first: an exact/contained title always qualifies; typo tolerance
    // is deliberately tight so "Jawan" can never resolve to "Pathaan".
    const allowedDistance = wantedTitle.length < 10 ? 2 : 4;
    if (!cleanTitle.includes(wantedTitle) && !wantedTitle.includes(cleanTitle)) {
      if (distance > allowedDistance) continue;
    }
    const cardFormat = String(card.format || '').toLowerCase();
    const formatMatches = isSeries ? /series/.test(cardFormat) : /movie/.test(cardFormat);
    let score = 100 - distance * 10;
    if (formatMatches) score += 35;
    if (wantedYear && card.year) {
      const delta = Math.abs(card.year - wantedYear);
      score += delta === 0 ? 40 : delta <= 1 ? 20 : delta <= 3 ? -10 : -40;
    }
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return best;
}

/**
 * Title page → release blocks. Each block carries a display title (quality /
 * size live there) and the raw anchors that lead deeper into the chain.
 */
function parseKHDHubItems(html, options = {}) {
  const { isSeries = false, season = 1, episode = 1 } = options;
  const $ = cheerio.load(html || '');
  const items = [];

  const collect = ($el) => {
    const title = ($el.find('.file-title, .episode-file-title').first().text() || '').replace(/\s+/g, ' ').trim();
    const containerHtml = $el.html() || '';
    const links = [];
    $el.find('a[href]').each((_, anchor) => {
      const url = ($(anchor).attr('href') || '').trim();
      if (!/^https?:|^\//i.test(url)) return;
      links.push({ url, text: ($(anchor).text() || '').replace(/\s+/g, ' ').trim() });
    });
    if (!title && links.length === 0) return;
    const sizeMatch = containerHtml.match(/([\d.]+\s?[GMK]B)/i);
    let height = (title.match(/\d{3,4}p/i) || [])[0];
    if (!height && /\b4k\b/i.test(title)) height = '2160p';
    items.push({
      title,
      size: sizeMatch ? sizeMatch[1].replace(/\s+/g, '') : '',
      height: height ? Number.parseInt(height, 10) : 0,
      links
    });
  };

  if (isSeries) {
    const seasonTag = `S${String(season).padStart(2, '0')}`;
    const episodeTag = `Episode-${String(episode).padStart(2, '0')}`;
    $('.episode-item').each((_, element) => {
      const $episode = $(element);
      if (seasonTag && !$episode.find('.episode-title').text().includes(seasonTag)) return;
      $episode.find('.episode-download-item').each((__, item) => {
        const $item = $(item);
        if (episodeTag && !$item.text().includes(episodeTag)) return;
        collect($item);
      });
    });
  } else {
    $('.download-item').each((_, element) => collect($(element)));
  }

  // Theme-change fallback: release-host anchors anywhere in the content.
  if (items.length === 0) {
    const links = [];
    $('a[href]').each((_, anchor) => {
      const url = ($(anchor).attr('href') || '').trim();
      if (!HDHUB_RELEASE_HINT.test(url) && !HDHUB_DIRECT_MEDIA.test(url)) return;
      links.push({ url, text: ($(anchor).text() || '').replace(/\s+/g, ' ').trim() });
    });
    if (links.length) items.push({ title: '', size: '', height: 0, links });
  }
  return items;
}

/** `hblinks` link-list page → its outbound release links. */
function parseHblinksPage(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const links = [];
  const seen = new Set();
  $('h3 a, h5 a, div.entry-content p a, div.entry-content a, a[href]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    const url = safeUrl(href, pageUrl);
    if (!url || seen.has(url)) return;
    if (!/^https?:/i.test(url)) return;
    seen.add(url);
    links.push({ url, text: ($(element).text() || '').replace(/\s+/g, ' ').trim() });
  });
  return links;
}

/**
 * HubCloud final page → raw links. Covers the four mirrors the site currently
 * exposes (10Gbps/PixelServer, R2, ZipDisk/workers.dev, FSL) plus PixelDrain.
 */
function parseHubCloudFinalLinks(html) {
  const $ = cheerio.load(html || '');
  const found = [];
  const seen = new Set();
  const push = (label, url) => {
    const clean = String(url || '').trim();
    if (!/^https?:/i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    found.push({ label, url: clean });
  };
  $('a[href]').each((_, element) => {
    const $el = $(element);
    const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
    const href = $el.attr('href') || '';
    const isDirect =
      /10Gbps|PixelServer/i.test(text) ||
      /Download File/i.test(text) ||
      /ZipDisk/i.test(text) ||
      /\bFSL\b/i.test(text) ||
      /r2\.dev|workers\.dev|hubcloud\.cx/i.test(href) ||
      HDHUB_DIRECT_MEDIA.test(href) ||
      /pixeldrain\./i.test(href);
    if (isDirect) push(text || 'Direct', href);
  });
  // Some mirrors print the raw URL as text instead of an anchor.
  for (const match of String(html || '').matchAll(/https?:\/\/[^\s"'<>]+(?:\.mkv|\.mp4|\.m3u8|r2\.dev[^\s"'<>]*|workers\.dev[^\s"'<>]*)/gi)) {
    push('Extracted', match[0]);
  }
  return found.map((entry) => ({
    ...entry,
    url: pixeldrainDirect(entry.url) || entry.url
  }));
}

/* -------------------------- async chain walkers --------------------------- */

function khdhubCtx(ctx, headers) {
  return {
    headers,
    timeoutMs: ctx.providerTimeoutMs,
    signal: ctx.signal,
    deadline: ctx.deadline
  };
}

function hasBudget(ctx, reserveMs = 800) {
  return !ctx.deadline || Date.now() < ctx.deadline - reserveMs;
}

/** Follow the base64/rot13 wrapper when the page is one; otherwise no-op. */
async function unwrapReleaseUrl(url, ctx, referer) {
  if (HDHUB_RELEASE_HINT.test(url) || HDHUB_DIRECT_MEDIA.test(url)) return url;
  try {
    const html = await fetchText(url, khdhubCtx(ctx, referer ? { Referer: referer } : {}));
    const target = decodeReleaseRedirect(html);
    return target || url;
  } catch {
    return url;
  }
}

/**
 * HubCloud: drive page → `var url = '…'` → mirror page → raw link(s).
 * A HubDrive page is handled by hopping to its HubCloud link first.
 */
async function extractHubCloudLinks(hubCloudUrl, ctx, depth = 0) {
  if (!hubCloudUrl || depth > 2 || !hasBudget(ctx)) return [];
  const referer = { Referer: hubCloudUrl };
  try {
    const page = await fetchText(hubCloudUrl, khdhubCtx(ctx, referer));

    // HubDrive pages link onward to HubCloud.
    if (/hubdrive\./i.test(hubCloudUrl)) {
      const next = parseHubCloudFinalLinks(page).map((l) => l.url).find((u) => /hubcloud\./i.test(u)) ||
        parseHblinksPage(page, hubCloudUrl).map((l) => l.url).find((u) => /hubcloud\./i.test(u));
      return next ? extractHubCloudLinks(next, ctx, depth + 1) : [];
    }

    const indirect = String(page || '').match(/var\s+url\s*=\s*'([^']+)'/);
    const finalHtml = indirect ? await fetchText(safeUrl(indirect[1], hubCloudUrl), khdhubCtx(ctx, referer)) : page;
    const links = parseHubCloudFinalLinks(finalHtml);
    if (links.length > 0) return links;
    // Newer layout prints the mirrors on a second hop.
    if (!indirect) {
      const nested = parseHblinksPage(page, hubCloudUrl).map((l) => l.url).find((u) => /hubcloud\./i.test(u));
      if (nested && nested !== hubCloudUrl) return extractHubCloudLinks(nested, ctx, depth + 1);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * `hblinks` link-list page → raw links. Recurses into nested link lists
 * (depth ≤ 2), unwraps redirects, follows HubDrive/HubCloud.
 */
async function extractHblinksLinks(hblinksUrl, ctx, depth = 0, seen = new Set()) {
  if (!hblinksUrl || depth > 2 || seen.has(hblinksUrl) || !hasBudget(ctx)) return [];
  seen.add(hblinksUrl);
  let html;
  try {
    html = await fetchText(hblinksUrl, khdhubCtx(ctx, { Referer: hblinksUrl }));
  } catch {
    return [];
  }
  const out = [];
  const links = parseHblinksPage(html, hblinksUrl)
    .slice(0, 14)
    .filter((link) => !/\.(css|js|png|jpe?g|webp|svg|gif|ico)(\?|$)/i.test(link.url));

  for (const link of links) {
    if (!hasBudget(ctx)) break;
    let url = link.url;
    if (!HDHUB_RELEASE_HINT.test(url) && !HDHUB_DIRECT_MEDIA.test(url)) {
      url = await unwrapReleaseUrl(url, ctx, hblinksUrl);
    }
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (/hblinks|hubstream/.test(host)) {
      out.push(...(await extractHblinksLinks(url, ctx, depth + 1, seen)));
      continue;
    }
    if (/hubcloud|hubdrive/.test(host)) {
      out.push(...(await extractHubCloudLinks(url, ctx)));
      continue;
    }
    if (HDHUB_DIRECT_MEDIA.test(url) || /pixeldrain\./i.test(url)) {
      out.push({ label: link.text || 'Direct', url: pixeldrainDirect(url) || url });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */

function fourKhdhubCandidates(metadata, ctx) {
  return (async () => {
    const settings = hamsterConfig();
    const bases = await siteBaseCandidates(
      '4khdhub',
      [settings.fourKhdhubBase, 'https://4khdhub.one', 'https://4khdhub.click'],
      ctx.signal
    );
    const isSeries = metadata.type === 'tv';
    const query = `${metadata.title}${metadata.releaseYear ? ` ${metadata.releaseYear}` : ''}`;

    let base = '';
    let searchHtml = '';
    let answered = false;
    const failures = [];
    for (const candidateBase of bases) {
      try {
        const html = await fetchText(`${candidateBase}/?s=${encodeURIComponent(query)}`, {
          headers: { Referer: `${candidateBase}/` },
          timeoutMs: ctx.providerTimeoutMs,
          signal: ctx.signal
        });
        answered = true;
        if (parseKHDHubCards(html, candidateBase).length > 0) {
          base = candidateBase;
          searchHtml = html;
          break;
        }
        failures.push(`${candidateBase}:no_cards`);
      } catch (error) {
        // Try the next known base (domains rotate without notice).
        failures.push(`${candidateBase}:${error instanceof Error ? error.message : 'fetch_failed'}`);
      }
    }
    if (!base) {
      // No base answered at all is a provider outage (trip the breaker and say
      // why); a base that answered but had no matching card is just a miss.
      if (!answered) throw new Error(`search failed (${failures.join(', ')})`);
      return [];
    }

    const card = pickKHDHubCard(parseKHDHubCards(searchHtml, base), metadata, isSeries);
    if (!card) return [];

    const pageHtml = await fetchText(card.url, {
      headers: { Referer: `${base}/` },
      timeoutMs: ctx.providerTimeoutMs,
      signal: ctx.signal
    });
    const items = parseKHDHubItems(pageHtml, {
      isSeries,
      season: metadata.season || 1,
      episode: metadata.episode || 1
    });
    if (items.length === 0) return [];

    const candidates = [];
    const seen = new Set();
    const push = (item, entry) => {
      const url = entry.url;
      if (!url || seen.has(url)) return;
      seen.add(url);
      const quality = item.height ? parseQuality(`${item.height}p`) : parseQuality(`${item.title} ${entry.label}`);
      const kind = kindFromUrl(url) === 'unknown' ? 'mkv' : kindFromUrl(url);
      if (kind === 'dash') return; // DASH is filtered out upstream in the pipeline.
      candidates.push({
        provider: '4khdhub',
        url,
        kind,
        quality: quality.label,
        height: quality.height || item.height || 0,
        audio: parseAudioHint(`${item.title} ${card.title}`),
        label: `4KHDHub · ${entry.label || quality.label}${item.height ? ` · ${item.height}p` : ''}`,
        referer: `${base}/`,
        headers: {},
        needsUnroll: false,
        origin: '4khdhub:direct'
      });
    };

    // Bounded fan-out: at most 6 release blocks, links handled sequentially
    // inside each, so the provider timeout is respected even on slow hosts.
    for (const item of items.slice(0, 6)) {
      if (!hasBudget(ctx, 1200)) break;
      for (const link of item.links.slice(0, 6)) {
        if (!hasBudget(ctx, 1200)) break;
        let url = link.url;
        if (/^\/\//.test(url)) url = `https:${url}`;
        else if (url.startsWith('/')) url = safeUrl(url, base);
        if (!/^https?:/i.test(url)) continue;

        let host = '';
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          continue;
        }

        if (/hblinks|hubstream/.test(host)) {
          for (const entry of await extractHblinksLinks(url, ctx)) push(item, entry);
          continue;
        }
        if (/hubcloud|hubdrive/.test(host)) {
          for (const entry of await extractHubCloudLinks(url, ctx)) push(item, entry);
          continue;
        }
        if (HDHUB_RELEASE_HINT.test(url)) {
          // gamerxyt / hubcdn style gateway: unwrap, then route by the target host.
          const target = await unwrapReleaseUrl(url, ctx, card.url);
          if (/hblinks|hubstream/.test(target)) {
            for (const entry of await extractHblinksLinks(target, ctx)) push(item, entry);
          } else if (/hubcloud|hubdrive/.test(target)) {
            for (const entry of await extractHubCloudLinks(target, ctx)) push(item, entry);
          }
          continue;
        }
        if (HDHUB_DIRECT_MEDIA.test(url) || /pixeldrain\./i.test(url)) {
          push(item, { label: link.text || 'Direct', url: pixeldrainDirect(url) || url });
        }
      }
    }
    return candidates;
  })();
}

/* ------------------------------------------------------------------------- */
/* Fan-out                                                                    */
/* ------------------------------------------------------------------------- */

const PROVIDER_TABLE = {
  moviebox: movieboxCandidates,
  hindmoviez: hindmoviezCandidates,
  '4khdhub': fourKhdhubCandidates
};

/**
 * Query every Hamster Wheel provider in parallel and return the merged,
 * ranked candidate list. Never throws: provider failures are reported in
 * `providers[]` so the resolver can surface them as diagnostics.
 */
async function resolveHamsterCandidates(metadata, options = {}) {
  const settings = hamsterConfig();
  if (settings.enabled === false) {
    return { candidates: [], providers: [{ id: 'hamster', ok: false, ms: 0, count: 0, diag: 'disabled' }] };
  }
  const timeoutMs = options.timeoutMs || settings.timeoutMs || 12000;
  const providerTimeoutMs = options.providerTimeoutMs || settings.providerTimeoutMs || 9000;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;

  const providers = [];
  const candidates = [];

  await Promise.all(
    HAMSTER_PROVIDERS.map(async (id) => {
      const providerKey = `hamster:${id}`;
      const started = Date.now();
      if (!circuitBreaker.isAvailable(providerKey)) {
        providers.push({ id, ok: false, ms: 0, count: 0, diag: 'circuit_open' });
        return;
      }
      try {
        const result = await PROVIDER_TABLE[id](metadata, {
          signal,
          deadline,
          providerTimeoutMs: Math.min(providerTimeoutMs, Math.max(1500, deadline - Date.now()))
        });
        const list = Array.isArray(result) ? result : [];
        if (list.length > 0) {
          circuitBreaker.recordSuccess(providerKey);
          candidates.push(...list);
          providers.push({ id, ok: true, ms: Date.now() - started, count: list.length, diag: null });
        } else {
          // No candidates is a soft failure: keep the breaker closed so a
          // temporarily empty catalog does not disable the provider.
          providers.push({ id, ok: false, ms: Date.now() - started, count: 0, diag: 'no_candidates' });
        }
      } catch (error) {
        circuitBreaker.recordFailure(providerKey);
        providers.push({
          id,
          ok: false,
          ms: Date.now() - started,
          count: 0,
          diag: error instanceof Error ? error.message : 'provider_failed'
        });
      }
    })
  );

  clearTimeout(timer);
  const maxCandidates = Number(settings.maxCandidates) || 10;
  return {
    candidates: sortCandidates(dedupeCandidates(candidates)).slice(0, maxCandidates),
    providers
  };
}

module.exports = {
  resolveHamsterCandidates,
  HAMSTER_PROVIDERS,
  // Exported for focused unit tests (parsers do not touch the network).
  parseQuality,
  parseAudioHint,
  kindFromUrl,
  candidateScore,
  sortCandidates,
  pixeldrainDirect,
  gdshineFileId,
  parseHindMoviezArticles,
  parseHindMoviezPageLinks,
  parseKHDHubCards,
  parseKHDHubItems,
  parseHblinksPage,
  parseHubCloudFinalLinks,
  decodeReleaseRedirect,
  decodeBase64,
  rot13,
  titleDistance,
  pickKHDHubCard,
  pickMovieBoxSubject,
  movieboxSignature
};
