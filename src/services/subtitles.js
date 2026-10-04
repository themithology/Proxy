const zlib = require('zlib');
const config = require('../config');
const { cache } = require('../utils/cache');
const { srtToVtt } = require('../utils/srtToVtt');
const subtitleSources = require('./subtitleSources');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT_MS = 6500;
const DOWNLOAD_TIMEOUT_MS = 10000;
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

const { NATIVE_LANG_LABELS } = subtitleSources;

function sourceConfig() {
  const up = config.upstreams || {};
  const D = subtitleSources.DEFAULT_URLS;
  return {
    stremioBase: up.openSubtitlesStremioUrl || D.openSubtitlesStremioUrl,
    wyzieBase: up.wyzieSubsUrl || D.wyzieSubsUrl,
    wyzieKey: config.wyzieApiKey || '',
    subdlBase: up.subdlApiUrl || D.subdlApiUrl,
    subdlDownloadBase: up.subdlDownloadUrl || D.subdlDownloadUrl,
    subdlKey: config.subdlApiKey || '',
    extraProxyHosts: config.subtitleProxyHosts || ''
  };
}

async function fetchJson(url, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Subtitle tracks for a title: OpenSubtitles through Stremio's keyless v3
 * addon, plus Wyzie / SubDL when their API keys are configured. The retired
 * rest.opensubtitles.org API is gone (its downloads became "buy VIP" notices).
 * Zero synthetic tracks — every entry is a real upstream file, converted to
 * WebVTT by /api/subtitles/proxy.
 */
async function resolveSubtitles(metadata) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata;
  const cacheKey = `subs:v3:${type}:${tmdbId}:s${season}:e${episode}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const cfg = sourceConfig();
  const ids = { tmdbId, imdbId: externalIds.imdb_id, type, season, episode };
  const lookups = [];

  const stremioUrl = subtitleSources.buildStremioUrl(cfg.stremioBase, ids);
  if (stremioUrl) lookups.push(fetchJson(stremioUrl).then(subtitleSources.parseStremio));

  const wyzieUrl = subtitleSources.buildWyzieUrl(cfg.wyzieBase, { ...ids, key: cfg.wyzieKey });
  if (wyzieUrl) lookups.push(fetchJson(wyzieUrl).then(subtitleSources.parseWyzie));

  const subdlUrl = subtitleSources.buildSubdlUrl(cfg.subdlBase, { ...ids, key: cfg.subdlKey });
  if (subdlUrl) {
    lookups.push(fetchJson(subdlUrl).then((data) => subtitleSources.parseSubdl(data, cfg.subdlDownloadBase)));
  }

  const lists = await Promise.all(lookups);
  const tracks = subtitleSources.toApiTracks(subtitleSources.mergeSubtitleTracks(lists));
  // An empty answer is cached only briefly so a source hiccup does not pin
  // "no subtitles" on a title for an hour.
  await cache.set(cacheKey, tracks, tracks.length > 0 ? 3600 : 120);
  return tracks;
}

/** Whether /api/subtitles/proxy may fetch this URL (subtitle hosts + configured mirrors only). */
function isProxyableSubtitleUrl(targetUrl) {
  const cfg = sourceConfig();
  return subtitleSources.isAllowedSubtitleUrl(targetUrl, {
    bases: [cfg.stremioBase, cfg.wyzieBase, cfg.subdlBase, cfg.subdlDownloadBase],
    extraHosts: cfg.extraProxyHosts
  });
}

/**
 * Fetch a remote subtitle (.srt / .vtt, optionally .gz or .zip, any charset)
 * and return WebVTT text.
 */
async function fetchAndConvertSubtitleToVtt(targetUrl, { encoding = '', lang = '' } = {}) {
  const cacheKey = `subfile:v3:${targetUrl}:${encoding}:${lang}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Upstream subtitle HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_SUBTITLE_BYTES) {
      throw new Error('Subtitle file too large');
    }
    const bytes = subtitleSources.unwrapSubtitlePayload(new Uint8Array(arrayBuffer), {
      gunzip: (b) => zlib.gunzipSync(Buffer.from(b)),
      inflateRaw: (b) => zlib.inflateRawSync(Buffer.from(b))
    });
    const text = subtitleSources.decodeSubtitleBytes(bytes, { encoding, lang });
    if (subtitleSources.looksLikePlaceholderSubtitle(text)) {
      throw new Error('Upstream returned a placeholder instead of a subtitle');
    }
    const vtt = srtToVtt(text);
    await cache.set(cacheKey, vtt, 7200);
    return vtt;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveSubtitles,
  fetchAndConvertSubtitleToVtt,
  isProxyableSubtitleUrl,
  NATIVE_LANG_LABELS
};
