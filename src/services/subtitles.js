const zlib = require('zlib');
const config = require('../config');
const { cache } = require('../utils/cache');
const { srtToVtt } = require('../utils/srtToVtt');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Native script labels matching VidStuck's Subtitles popover UI
const NATIVE_LANG_LABELS = {
  ar: 'العربية',
  ara: 'العربية',
  bn: 'বাংলা',
  ben: 'বাংলা',
  en: 'English',
  eng: 'English',
  fil: 'Filipino',
  tl: 'Filipino',
  tgl: 'Filipino',
  fr: 'Français',
  fre: 'Français',
  fra: 'Français',
  de: 'Deutsch',
  ger: 'Deutsch',
  deu: 'Deutsch',
  hi: 'हिन्दी',
  hin: 'हिन्दी',
  id: 'Indonesian',
  ind: 'Indonesian',
  it: 'Italiano',
  ita: 'Italiano',
  ja: '日本語',
  jpn: '日本語',
  ko: '한국어',
  kor: '한국어',
  pt: 'Português',
  por: 'Português',
  pob: 'Português (BR)',
  ru: 'Русский',
  rus: 'Русский',
  es: 'Español',
  spa: 'Español',
  tr: 'Türkçe',
  tur: 'Türkçe',
  vi: 'Tiếng Việt',
  vie: 'Tiếng Việt',
  zh: '中文',
  chi: '中文',
  zho: '中文',
  nl: 'Nederlands',
  dut: 'Nederlands',
  pl: 'Polski',
  pol: 'Polski'
};

/**
 * Fetch real subtitles from OpenSubtitles REST API, OpenSubtitles v3 Stremio Addon, and Wyzie Subs.
 * Zero synthetic/test subtitles — 100% real upstream subtitle tracks converted to WebVTT.
 */
async function resolveSubtitles(metadata) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata;
  const cacheKey = `subs:v2:${type}:${tmdbId}:s${season}:e${episode}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const tracks = [];
  const seenLangs = new Set();

  // 1. OpenSubtitles Official REST API (Keyless with X-User-Agent: TemporaryUserAgent)
  if (externalIds.imdb_id) {
    const imdbDigits = String(externalIds.imdb_id).replace(/^tt/i, '');
    const osPath =
      type === 'tv'
        ? `/search/episode-${episode}/imdbid-${imdbDigits}/season-${season}`
        : `/search/imdbid-${imdbDigits}`;
    const osUrl = `${config.upstreams.openSubtitlesRestUrl}${osPath}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6500);
      const res = await fetch(osUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-User-Agent': 'TemporaryUserAgent'
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          // Sort by download count descending so official/trusted subs come first
          const sorted = [...data].sort(
            (a, b) => Number(b.SubDownloadsCnt || 0) - Number(a.SubDownloadsCnt || 0)
          );

          for (const item of sorted) {
            const downloadLink = item.SubDownloadLink;
            if (!downloadLink) continue;

            const iso = (item.ISO639 || item.SubLanguageID || 'en').toLowerCase();
            const isHI = String(item.SubHearingImpaired) === '1';
            const langKey = isHI ? `${iso}-hi` : iso;

            if (seenLangs.has(langKey)) continue;
            seenLangs.add(langKey);

            const baseLabel =
              NATIVE_LANG_LABELS[iso] ||
              NATIVE_LANG_LABELS[item.SubLanguageID] ||
              item.LanguageName ||
              iso.toUpperCase();
            const label = isHI ? `${baseLabel} [CC]` : baseLabel;

            tracks.push({
              id: `os-${item.IDSubtitleFile || langKey}`,
              lang: iso.slice(0, 2),
              label,
              format: 'vtt',
              url: `/api/subtitles/proxy?url=${encodeURIComponent(downloadLink)}`,
              default: iso === 'en' && !isHI,
              downloads: Number(item.SubDownloadsCnt || 0),
              source: 'opensubtitles'
            });

            if (tracks.length >= 24) break;
          }
        }
      }
    } catch {
      // Fall through to secondary subtitle sources
    }
  }

  // 2. Wyzie Subs API (when WYZIE_API_KEY is configured or available)
  if (tracks.length === 0) {
    try {
      const keyParam = config.wyzieApiKey ? `&key=${encodeURIComponent(config.wyzieApiKey)}` : '';
      const wyzieQuery =
        type === 'tv'
          ? `${config.upstreams.wyzieSubsUrl}/search?id=${encodeURIComponent(tmdbId)}&season=${season}&episode=${episode}${keyParam}`
          : `${config.upstreams.wyzieSubsUrl}/search?id=${encodeURIComponent(tmdbId)}${keyParam}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(wyzieQuery, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          for (const item of data) {
            const code = (item.language || item.lang || 'en').toLowerCase();
            if (seenLangs.has(code) || !item.url) continue;
            seenLangs.add(code);
            tracks.push({
              id: `wyzie-${code}-${tracks.length}`,
              lang: code,
              label: NATIVE_LANG_LABELS[code] || item.display || item.language || code.toUpperCase(),
              format: 'vtt',
              url: `/api/subtitles/proxy?url=${encodeURIComponent(item.url)}`,
              default: code === 'en',
              source: 'wyzie'
            });
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  // 3. OpenSubtitles v3 Stremio Addon fallback
  if (tracks.length === 0 && externalIds.imdb_id) {
    try {
      const stremioType = type === 'tv' ? 'series' : 'movie';
      const stremioId =
        type === 'tv'
          ? `${externalIds.imdb_id}:${season}:${episode}`
          : externalIds.imdb_id;
      const stremioUrl = `${config.upstreams.openSubtitlesStremioUrl}/subtitles/${stremioType}/${encodeURIComponent(stremioId)}.json`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(stremioUrl, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.subtitles)) {
          for (const sub of data.subtitles) {
            const langCode = (sub.lang || 'en').toLowerCase();
            if (seenLangs.has(langCode) || !sub.url) continue;
            seenLangs.add(langCode);
            tracks.push({
              id: `stremio-${sub.id || langCode}`,
              lang: langCode.slice(0, 2),
              label: NATIVE_LANG_LABELS[langCode] || langCode.toUpperCase(),
              format: 'vtt',
              url: `/api/subtitles/proxy?url=${encodeURIComponent(sub.url)}`,
              default: langCode === 'en' || langCode === 'eng',
              source: 'opensubtitles-v3'
            });
            if (tracks.length >= 20) break;
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  if (tracks.length > 0) {
    await cache.set(cacheKey, tracks, 3600);
  }

  return tracks;
}

/**
 * Fetch, decompress (.gz if needed), and convert remote .srt/.vtt subtitle file into WebVTT
 */
async function fetchAndConvertSubtitleToVtt(targetUrl) {
  const cacheKey = `subfile:v2:${targetUrl}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'X-User-Agent': 'TemporaryUserAgent'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Upstream subtitle HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    let buffer = Buffer.from(arrayBuffer);

    // Detect gzip magic bytes (0x1f 0x8b) or .gz extension (used by dl.opensubtitles.org)
    if (
      (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) ||
      targetUrl.endsWith('.gz')
    ) {
      buffer = zlib.gunzipSync(buffer);
    }

    const rawText = buffer.toString('utf8');
    const vtt = srtToVtt(rawText);
    await cache.set(cacheKey, vtt, 7200);
    return vtt;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveSubtitles,
  fetchAndConvertSubtitleToVtt,
  NATIVE_LANG_LABELS
};
