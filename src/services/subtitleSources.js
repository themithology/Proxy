'use strict';

/**
 * Subtitle sources shared by the Node backend and the Cloudflare Worker.
 *
 * The legacy OpenSubtitles.org REST API (rest.opensubtitles.org) was switched
 * off at the end of 2023 and its download links now return a "buy VIP" notice
 * instead of a subtitle, so it is gone. Sources today:
 *
 *   1. OpenSubtitles via Stremio's official v3 addon — keyless, IMDb-keyed,
 *      serves UTF-8 SRT through its own download proxy. The default source.
 *   2. Wyzie Subs — TMDB/IMDb-keyed aggregator (OpenSubtitles.com, SubDL,
 *      Podnapisi, …). Needs a free API key (`WYZIE_API_KEY`).
 *   3. SubDL — TMDB-keyed, needs a free API key (`SUBDL_API_KEY`); downloads
 *      are ZIP archives, unpacked by the proxy.
 *
 * Only URL building, response parsing, merging, archive/charset handling and
 * the proxy host allow-list live here; fetching, caching and HTTP stay in the
 * runtimes. Pure functions, no I/O, no Node-only globals.
 */

const DEFAULT_URLS = {
  openSubtitlesStremioUrl: 'https://opensubtitles-v3.strem.io',
  wyzieSubsUrl: 'https://sub.wyzie.ru',
  subdlApiUrl: 'https://api.subdl.com/api/v1',
  subdlDownloadUrl: 'https://dl.subdl.com'
};

const PROXY_PATH = '/api/subtitles/proxy';
const MAX_TRACKS = 40;
const MAX_PER_LANGUAGE = 2;

// Native-script labels for the subtitles menu (ISO 639-1 keys).
const NATIVE_LANG_LABELS = {
  af: 'Afrikaans', am: 'አማርኛ', ar: 'العربية', az: 'Azərbaycanca', be: 'Беларуская', bg: 'Български',
  bn: 'বাংলা', bs: 'Bosanski', ca: 'Català', cs: 'Čeština', cy: 'Cymraeg', da: 'Dansk', de: 'Deutsch',
  el: 'Ελληνικά', en: 'English', eo: 'Esperanto', es: 'Español', et: 'Eesti', eu: 'Euskara', fa: 'فارسی',
  fi: 'Suomi', fr: 'Français', ga: 'Gaeilge', gl: 'Galego', gu: 'ગુજરાતી', he: 'עברית', hi: 'हिन्दी',
  hr: 'Hrvatski', hu: 'Magyar', hy: 'Հայերեն', id: 'Bahasa Indonesia', is: 'Íslenska', it: 'Italiano',
  ja: '日本語', ka: 'ქართული', kk: 'Қазақша', km: 'ខ្មែរ', kn: 'ಕನ್ನಡ', ko: '한국어', ku: 'Kurdî', lt: 'Lietuvių',
  lv: 'Latviešu', mk: 'Македонски', ml: 'മലയാളം', mn: 'Монгол', mr: 'मराठी', ms: 'Bahasa Melayu', my: 'မြန်မာ',
  ne: 'नेपाली', nl: 'Nederlands', no: 'Norsk', pa: 'ਪੰਜਾਬੀ', pl: 'Polski', ps: 'پښتو', pt: 'Português',
  'pt-br': 'Português (BR)', ro: 'Română', ru: 'Русский', si: 'සිංහල', sk: 'Slovenčina', sl: 'Slovenščina',
  so: 'Soomaali', sq: 'Shqip', sr: 'Српски', sv: 'Svenska', sw: 'Kiswahili', ta: 'தமிழ்', te: 'తెలుగు',
  th: 'ไทย', tl: 'Filipino', tr: 'Türkçe', uk: 'Українська', ur: 'اردو', uz: 'Oʻzbekcha', vi: 'Tiếng Việt',
  zh: '中文', 'zh-tw': '中文（繁體）'
};

// ISO 639-2 (B and T) and other codes the sources use -> ISO 639-1.
const ISO639_2_TO_1 = {
  afr: 'af', amh: 'am', ara: 'ar', aze: 'az', bel: 'be', bul: 'bg', ben: 'bn', bos: 'bs', cat: 'ca',
  ces: 'cs', cze: 'cs', cym: 'cy', wel: 'cy', dan: 'da', deu: 'de', ger: 'de', ell: 'el', gre: 'el',
  eng: 'en', epo: 'eo', spa: 'es', est: 'et', eus: 'eu', baq: 'eu', fas: 'fa', per: 'fa', fin: 'fi',
  fra: 'fr', fre: 'fr', gle: 'ga', glg: 'gl', guj: 'gu', heb: 'he', hin: 'hi', hrv: 'hr', scr: 'hr',
  hun: 'hu', hye: 'hy', arm: 'hy', ind: 'id', isl: 'is', ice: 'is', ita: 'it', jpn: 'ja', kat: 'ka',
  geo: 'ka', kaz: 'kk', khm: 'km', kan: 'kn', kor: 'ko', kur: 'ku', lit: 'lt', lav: 'lv', mkd: 'mk',
  mac: 'mk', mal: 'ml', mon: 'mn', mar: 'mr', msa: 'ms', may: 'ms', mya: 'my', bur: 'my', nep: 'ne',
  nld: 'nl', dut: 'nl', nor: 'no', nob: 'no', nno: 'no', pan: 'pa', pol: 'pl', pus: 'ps', por: 'pt',
  pob: 'pt-br', ron: 'ro', rum: 'ro', rus: 'ru', sin: 'si', slk: 'sk', slo: 'sk', slv: 'sl', som: 'so',
  sqi: 'sq', alb: 'sq', srp: 'sr', scc: 'sr', swe: 'sv', swa: 'sw', tam: 'ta', tel: 'te', tha: 'th',
  tgl: 'tl', fil: 'tl', tur: 'tr', ukr: 'uk', urd: 'ur', uzb: 'uz', vie: 'vi', zho: 'zh', chi: 'zh',
  zht: 'zh-tw', zhe: 'zh', 'pt-pt': 'pt', 'es-mx': 'es', 'es-es': 'es', 'en-us': 'en', 'en-gb': 'en',
  'zh-cn': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh-tw', 'sr-latn': 'sr', 'ms-my': 'ms', 'br': 'pt-br'
};

// Language names as the sources spell them (Wyzie `display`, SubDL `lang`).
const LANGUAGE_NAME_TO_CODE = {
  english: 'en', arabic: 'ar', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt',
  'brazillian portuguese': 'pt-br', 'brazilian portuguese': 'pt-br', 'portuguese (brazil)': 'pt-br',
  russian: 'ru', japanese: 'ja', korean: 'ko', chinese: 'zh', 'chinese bg code': 'zh', 'chinese (simplified)': 'zh',
  'chinese (traditional)': 'zh-tw', 'big 5 code': 'zh-tw', hindi: 'hi', turkish: 'tr', vietnamese: 'vi',
  indonesian: 'id', dutch: 'nl', polish: 'pl', bengali: 'bn', tamil: 'ta', telugu: 'te', malayalam: 'ml',
  kannada: 'kn', marathi: 'mr', punjabi: 'pa', urdu: 'ur', hebrew: 'he', greek: 'el', swedish: 'sv',
  norwegian: 'no', danish: 'da', finnish: 'fi', hungarian: 'hu', czech: 'cs', romanian: 'ro', bulgarian: 'bg',
  ukrainian: 'uk', thai: 'th', malay: 'ms', filipino: 'tl', tagalog: 'tl', persian: 'fa', farsi: 'fa',
  'farsi/persian': 'fa', serbian: 'sr', croatian: 'hr', slovenian: 'sl', slovak: 'sk', lithuanian: 'lt',
  latvian: 'lv', estonian: 'et', catalan: 'ca', basque: 'eu', galician: 'gl', mongolian: 'mn', burmese: 'my',
  khmer: 'km', sinhala: 'si', sinhalese: 'si', nepali: 'ne', georgian: 'ka', armenian: 'hy', azerbaijani: 'az',
  kazakh: 'kk', uzbek: 'uz', albanian: 'sq', macedonian: 'mk', bosnian: 'bs', icelandic: 'is', irish: 'ga',
  welsh: 'cy', afrikaans: 'af', swahili: 'sw', amharic: 'am', somali: 'so', kurdish: 'ku', pashto: 'ps',
  gujarati: 'gu', belarusian: 'be', esperanto: 'eo'
};

// Fallback charsets per language for files that are not valid UTF-8 and carry
// no encoding hint (the classic SRT problem).
const LEGACY_CHARSET_BY_LANG = {
  ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256', ps: 'windows-1256',
  ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', be: 'windows-1251', sr: 'windows-1251',
  mk: 'windows-1251', kk: 'windows-1251', mn: 'windows-1251',
  el: 'windows-1253', he: 'windows-1255', tr: 'windows-1254', az: 'windows-1254',
  pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250',
  hr: 'windows-1250', sl: 'windows-1250', bs: 'windows-1250', sq: 'windows-1250',
  th: 'windows-874', vi: 'windows-1258', ja: 'shift_jis', ko: 'euc-kr', zh: 'gbk', 'zh-tw': 'big5',
  lt: 'windows-1257', lv: 'windows-1257', et: 'windows-1257'
};

/**
 * Canonical language key: ISO 639-1 (`en`), or a labelled variant (`pt-br`,
 * `zh-tw`). Unknown 3-letter codes pass through unchanged.
 */
function normalizeLangCode(raw) {
  if (raw == null) return '';
  const text = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (!text) return '';
  if (ISO639_2_TO_1[text]) return ISO639_2_TO_1[text];
  if (LANGUAGE_NAME_TO_CODE[text]) return LANGUAGE_NAME_TO_CODE[text];
  if (/^[a-z]{2}$/.test(text)) return text;
  if (/^[a-z]{2}-[a-z]{2,4}$/.test(text)) {
    return NATIVE_LANG_LABELS[text] ? text : text.slice(0, 2);
  }
  if (/^[a-z]{3}$/.test(text)) return text;
  return text.slice(0, 2);
}

/** The code the player matches `?sub=` and per-title memory against (`pt` for `pt-br`). */
function baseLang(key) {
  const text = String(key || '');
  const dash = text.indexOf('-');
  return dash === -1 ? text : text.slice(0, dash);
}

function languageLabel(code, fallback) {
  const normalized = normalizeLangCode(code);
  if (NATIVE_LANG_LABELS[normalized]) return NATIVE_LANG_LABELS[normalized];
  if (fallback && String(fallback).trim()) return String(fallback).trim();
  return normalized ? normalized.toUpperCase() : 'Unknown';
}

function trimBase(base, fallback) {
  const value = String(base || fallback || '').trim().replace(/\/+$/, '');
  return value;
}

function isImdbId(value) {
  return /^tt\d{6,9}$/i.test(String(value || '').trim());
}

function imdbId(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  return text.startsWith('tt') ? text : `tt${text}`;
}

/* ------------------------------------------------------------------------ */
/* 1. OpenSubtitles via Stremio's v3 addon                                   */
/* ------------------------------------------------------------------------ */

function buildStremioUrl(base, { imdbId: rawImdb, type, season = 1, episode = 1 } = {}) {
  const id = imdbId(rawImdb);
  if (!isImdbId(id)) return null;
  const root = trimBase(base, DEFAULT_URLS.openSubtitlesStremioUrl);
  if (type === 'tv') {
    return `${root}/subtitles/series/${id}:${Number(season) || 1}:${Number(episode) || 1}.json`;
  }
  return `${root}/subtitles/movie/${id}.json`;
}

function parseStremio(data) {
  const list = data && Array.isArray(data.subtitles) ? data.subtitles : [];
  const tracks = [];
  for (const item of list) {
    if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
    const variant = normalizeLangCode(item.lang);
    if (!variant) continue;
    const encoding = String(item.SubEncoding || item.encoding || '').trim().toLowerCase();
    tracks.push({
      id: `os-${String(item.id || tracks.length)}`,
      lang: baseLang(variant),
      variant,
      label: languageLabel(variant, item.label),
      url: item.url,
      // Stremio's download proxy transcodes to UTF-8 (`subencoding-stremio-utf8`).
      encoding: /subencoding-stremio-utf8|subencoding-utf8/i.test(item.url) ? 'utf-8' : encoding,
      // The addon has no hearing-impaired flag; the file / release names carry it.
      hi: /\[cc\]|hearing|\b(?:sdh|hi|cc)\b/i.test([item.label, item.subtitleFileName, item.movieReleaseName].filter(Boolean).join(' ')),
      source: 'opensubtitles-v3'
    });
  }
  return tracks;
}

/* ------------------------------------------------------------------------ */
/* 2. Wyzie Subs (API key required)                                          */
/* ------------------------------------------------------------------------ */

function buildWyzieUrl(base, { tmdbId, imdbId: rawImdb, type, season = 1, episode = 1, key } = {}) {
  if (!key) return null;
  const id = tmdbId ? String(tmdbId) : isImdbId(imdbId(rawImdb)) ? imdbId(rawImdb) : '';
  if (!id) return null;
  const root = trimBase(base, DEFAULT_URLS.wyzieSubsUrl);
  const params = new URLSearchParams({ id, key: String(key) });
  if (type === 'tv') {
    params.set('season', String(Number(season) || 1));
    params.set('episode', String(Number(episode) || 1));
  }
  params.set('format', 'srt,vtt');
  return `${root}/search?${params.toString()}`;
}

function parseWyzie(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.results) ? data.results : [];
  const tracks = [];
  for (const item of list) {
    if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
    const variant = normalizeLangCode(item.language || item.lang || item.display);
    if (!variant) continue;
    tracks.push({
      id: `wyzie-${String(item.id || tracks.length)}`,
      lang: baseLang(variant),
      variant,
      label: languageLabel(variant, item.display),
      url: item.url,
      encoding: String(item.encoding || '').trim().toLowerCase(),
      hi: item.isHearingImpaired === true || item.hearingImpaired === true,
      source: 'wyzie'
    });
  }
  return tracks;
}

/* ------------------------------------------------------------------------ */
/* 3. SubDL (API key required)                                               */
/* ------------------------------------------------------------------------ */

function buildSubdlUrl(base, { tmdbId, imdbId: rawImdb, type, season = 1, episode = 1, key } = {}) {
  if (!key) return null;
  const root = trimBase(base, DEFAULT_URLS.subdlApiUrl);
  const params = new URLSearchParams({ api_key: String(key), type: type === 'tv' ? 'tv' : 'movie', subs_per_page: '30', hi: '1' });
  if (tmdbId) params.set('tmdb_id', String(tmdbId));
  else if (isImdbId(imdbId(rawImdb))) params.set('imdb_id', imdbId(rawImdb));
  else return null;
  if (type === 'tv') {
    params.set('season_number', String(Number(season) || 1));
    params.set('episode_number', String(Number(episode) || 1));
  }
  return `${root}/subtitles?${params.toString()}`;
}

function parseSubdl(data, downloadBase) {
  if (!data || data.status === false || !Array.isArray(data.subtitles)) return [];
  const root = trimBase(downloadBase, DEFAULT_URLS.subdlDownloadUrl);
  const tracks = [];
  for (const item of data.subtitles) {
    if (!item || typeof item.url !== 'string') continue;
    if (item.full_season === true) continue;
    const variant = normalizeLangCode(item.lang || item.language);
    if (!variant) continue;
    const url = /^https?:\/\//i.test(item.url) ? item.url : `${root}${item.url.startsWith('/') ? '' : '/'}${item.url}`;
    tracks.push({
      id: `subdl-${String(item.sd_id || item.id || tracks.length)}-${tracks.length}`,
      lang: baseLang(variant),
      variant,
      label: languageLabel(variant, item.lang),
      url,
      encoding: '',
      hi: item.hi === true,
      source: 'subdl'
    });
  }
  return tracks;
}

/* ------------------------------------------------------------------------ */
/* Merge + API shape                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Merge per-source lists in priority order: at most `perLanguage` tracks per
 * language variant (one plain + one hearing-impaired), English first, `max`
 * overall.
 */
function mergeSubtitleTracks(lists, { max = MAX_TRACKS, perLanguage = MAX_PER_LANGUAGE } = {}) {
  const perLang = new Map();
  const seenUrls = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const track of list) {
      if (!track || !track.url || !track.lang || seenUrls.has(track.url)) continue;
      const key = track.variant || track.lang;
      const bucket = perLang.get(key) || [];
      if (bucket.length >= perLanguage) continue;
      if (bucket.some((t) => !!t.hi === !!track.hi)) continue; // one plain + one [CC] per language
      seenUrls.add(track.url);
      bucket.push(track);
      perLang.set(key, bucket);
    }
  }
  const languages = [...perLang.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === 'en') return -1;
    if (b === 'en') return 1;
    return 0; // keep source order for the rest
  });
  const merged = [];
  for (const lang of languages) {
    const bucket = perLang.get(lang).sort((a, b) => Number(!!a.hi) - Number(!!b.hi));
    for (const track of bucket) {
      merged.push(track);
      if (merged.length >= max) return merged;
    }
  }
  return merged;
}

/** Shape consumed by the player: proxied URL, `format: 'vtt'`, one default. */
function toApiTracks(tracks, { proxyPath = PROXY_PATH } = {}) {
  let defaultAssigned = false;
  const ids = new Set();
  return tracks.map((track, index) => {
    let id = String(track.id || `sub-${index}`);
    while (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    const params = new URLSearchParams({ url: track.url });
    if (track.encoding && track.encoding !== 'utf-8' && track.encoding !== 'utf8') params.set('enc', track.encoding);
    params.set('lang', track.lang);
    const isDefault = !defaultAssigned && track.lang === 'en' && !track.hi;
    if (isDefault) defaultAssigned = true;
    return {
      id,
      lang: track.lang,
      label: track.hi ? `${track.label} [CC]` : track.label,
      format: 'vtt',
      url: `${proxyPath}?${params.toString()}`,
      default: isDefault,
      source: track.source
    };
  });
}

/* ------------------------------------------------------------------------ */
/* Proxy: host allow-list                                                    */
/* ------------------------------------------------------------------------ */

// Hosts the subtitle proxy may fetch from. The proxy is otherwise an open
// relay, which is not something a public Worker should offer.
const DEFAULT_PROXY_HOSTS = [
  'strem.io',
  'opensubtitles.org',
  'opensubtitles.com',
  'wyzie.ru',
  'wyzie.io',
  'subdl.com',
  'subsource.net',
  'podnapisi.net',
  'gestdown.info'
];

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(hostname, allowed) {
  const host = String(hostname || '').toLowerCase();
  const suffix = String(allowed || '').toLowerCase().replace(/^\*?\./, '');
  if (!host || !suffix) return false;
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * `bases`: configured source base URLs (their hosts are allowed, which is what
 * lets a test or self-hosted mirror stand in for a source). `extraHosts`:
 * comma-separated or array of additional host suffixes (SUBTITLE_PROXY_HOSTS).
 */
function isAllowedSubtitleUrl(target, { bases = [], extraHosts = [] } = {}) {
  let url;
  try {
    url = new URL(String(target));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;
  const extras = (Array.isArray(extraHosts) ? extraHosts : String(extraHosts || '').split(','))
    .map((h) => String(h || '').trim())
    .filter(Boolean);
  if (extras.includes('*')) return true;
  const baseHosts = bases.map(hostOf).filter(Boolean);
  if (baseHosts.some((h) => h === host)) return true;
  return [...DEFAULT_PROXY_HOSTS, ...extras].some((allowed) => hostMatches(host, allowed));
}

/* ------------------------------------------------------------------------ */
/* Proxy: archive + charset handling                                         */
/* ------------------------------------------------------------------------ */

function isGzip(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isZip(bytes) {
  return bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const SUBTITLE_EXT_PRIORITY = ['.srt', '.vtt', '.ass', '.ssa', '.sub', '.txt'];

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) + bytes[offset + 3] * 0x1000000;
}

/**
 * Pick the subtitle file out of a ZIP archive (SubDL / Podnapisi downloads).
 * Reads the central directory, so data descriptors are not a problem.
 * `inflateRaw(Uint8Array) -> Uint8Array` handles method 8 (deflate).
 */
function extractSubtitleFromZip(bytes, inflateRaw) {
  const minEocd = bytes.length - 22;
  let eocd = -1;
  for (let i = minEocd; i >= Math.max(0, minEocd - 65557); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP central directory not found');
  const entryCount = readU16(bytes, eocd + 10);
  let offset = readU32(bytes, eocd + 16);
  const entries = [];
  for (let n = 0; n < entryCount && offset + 46 <= bytes.length; n++) {
    if (readU32(bytes, offset) !== 0x02014b50) break;
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const name = latin1(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const candidates = entries
    .filter((e) => !e.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\./.test(e.name))
    .map((e) => ({ ...e, rank: SUBTITLE_EXT_PRIORITY.findIndex((ext) => e.name.toLowerCase().endsWith(ext)) }))
    .filter((e) => e.rank !== -1)
    .sort((a, b) => a.rank - b.rank);
  const entry = candidates[0];
  if (!entry) throw new Error('No subtitle file inside the archive');
  const lo = entry.localOffset;
  if (readU32(bytes, lo) !== 0x04034b50) throw new Error('Corrupt ZIP entry');
  const dataStart = lo + 30 + readU16(bytes, lo + 26) + readU16(bytes, lo + 28);
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    if (typeof inflateRaw !== 'function') throw new Error('Deflated ZIP entry but no inflate available');
    return inflateRaw(data);
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method}`);
}

function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Unwrap gzip / zip payloads. `codecs = { gunzip, inflateRaw }` are the
 * runtime's zlib functions (Uint8Array|Buffer -> Uint8Array|Buffer).
 */
function unwrapSubtitlePayload(bytes, codecs = {}) {
  let out = bytes;
  for (let guard = 0; guard < 3; guard++) {
    if (isGzip(out)) {
      if (typeof codecs.gunzip !== 'function') throw new Error('gzip payload but no gunzip available');
      out = codecs.gunzip(out);
      continue;
    }
    if (isZip(out)) {
      out = extractSubtitleFromZip(out, codecs.inflateRaw);
      continue;
    }
    break;
  }
  return out;
}

function tryDecode(bytes, label, fatal) {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Bytes -> text. BOMs win, then valid UTF-8, then the source's encoding hint,
 * then a per-language legacy charset, then windows-1252.
 */
function decodeSubtitleBytes(bytes, { encoding = '', lang = '' } = {}) {
  if (!bytes || bytes.length === 0) return '';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return (tryDecode(bytes, 'utf-16le', false) || '').replace(/^\uFEFF/, '');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return (tryDecode(bytes, 'utf-16be', false) || '').replace(/^\uFEFF/, '');
  const utf8 = tryDecode(bytes, 'utf-8', true);
  if (utf8 !== null) return utf8.replace(/^\uFEFF/, '');
  const hint = String(encoding || '').trim().toLowerCase();
  if (hint && hint !== 'utf-8' && hint !== 'utf8') {
    const decoded = tryDecode(bytes, hint, false);
    if (decoded) return decoded;
  }
  const byLang = LEGACY_CHARSET_BY_LANG[normalizeLangCode(lang)];
  if (byLang) {
    const decoded = tryDecode(bytes, byLang, false);
    if (decoded) return decoded;
  }
  return tryDecode(bytes, 'windows-1252', false) || tryDecode(bytes, 'utf-8', false) || '';
}

/* ------------------------------------------------------------------------ */
/* Sanity checks                                                             */
/* ------------------------------------------------------------------------ */

function countCues(text) {
  const matches = String(text || '').match(/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/g);
  return matches ? matches.length : 0;
}

/**
 * The retired OpenSubtitles.org downloads answer with a 1–3 cue "become a VIP"
 * file. Serving that as a subtitle track is worse than failing the track.
 */
function looksLikePlaceholderSubtitle(text) {
  const body = String(text || '');
  if (!body.trim()) return true;
  const cues = countCues(body);
  if (cues === 0) return true;
  if (cues <= 4 && /\bvip\b|opensubtitles\.(org|com)/i.test(body)) return true;
  return false;
}

module.exports = {
  DEFAULT_URLS,
  DEFAULT_PROXY_HOSTS,
  PROXY_PATH,
  NATIVE_LANG_LABELS,
  normalizeLangCode,
  baseLang,
  languageLabel,
  buildStremioUrl,
  parseStremio,
  buildWyzieUrl,
  parseWyzie,
  buildSubdlUrl,
  parseSubdl,
  mergeSubtitleTracks,
  toApiTracks,
  isAllowedSubtitleUrl,
  unwrapSubtitlePayload,
  extractSubtitleFromZip,
  decodeSubtitleBytes,
  countCues,
  looksLikePlaceholderSubtitle
};
