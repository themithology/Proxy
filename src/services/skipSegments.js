/**
 * Skip-segment providers (intro / recap / credits) shared by the Node backend
 * and the Cloudflare Worker.
 *
 * Everything here is pure: URL builders and response parsers only. The
 * callers own fetching, timeouts and caching. No Node-only APIs are used on
 * purpose — the Worker bundles this file through nodejs_compat alongside the
 * rest of src/, exactly like serverCatalog.js.
 *
 * Why this exists: the previous resolvers read `start_sec`/`end_sec` from
 * IntroDB's `/intro` endpoint, which only ever returned `start_ms`/`end_ms`.
 * Every segment was silently dropped, so "Skip Intro" never appeared. The
 * parsers below accept every unit the upstreams actually emit and are covered
 * by the verification suite with the real response shapes.
 *
 * Providers (all keyed by the ids TMDB already gives us):
 *  - TheIntroDB v3  — TMDB id (+season/episode). Arrays per type with
 *                     `{start_ms, end_ms}`; `start_ms: null` = from the
 *                     beginning, `end_ms: null` = until the end of the file.
 *  - IntroDB        — IMDb id. `/segments` → `{intro, recap, outro,
 *                     post_credits}` objects (or null) with `start_ms/_sec`.
 *                     Legacy `/intro` → flat `{start_ms, end_ms}`.
 *  - AniSkip v2     — MyAnimeList id. `results[].interval.startTime/endTime`
 *                     in seconds with `skipType` op/ed/mixed-op/mixed-ed/recap.
 *
 * Normalised output (what the player consumes):
 *   { type: 'intro'|'recap'|'outro'|'preview', label, start, end, source }
 *   `start`/`end` are seconds; `end` may be `null` when the provider says
 *   "until the end" (the player resolves that against the media duration).
 */

const DEFAULT_URLS = {
  theIntroDbUrl: 'https://api.theintrodb.org/v3',
  introDbUrl: 'https://api.introdb.app',
  aniSkipUrl: 'https://api.aniskip.com/v2'
};

/** Provider priority: earlier wins when two providers describe the same segment. */
const PROVIDER_ORDER = ['theintrodb', 'introdb', 'aniskip'];

const SEGMENT_TYPES = ['intro', 'recap', 'outro', 'preview'];

/** Segments shorter than this are noise (a 0.4s "intro" is a data-entry error). */
const MIN_SEGMENT_SECONDS = 1;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function numeric(v) {
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
  return null;
}

/**
 * Read a boundary from an object that may use any of the upstream spellings:
 * `${base}_sec`, `${base}_ms`, `${base}` (seconds), or `${base}Time`.
 */
function pickSeconds(obj, base) {
  if (!obj || typeof obj !== 'object') return null;
  const sec = numeric(obj[`${base}_sec`]);
  if (sec !== null) return sec;
  const ms = numeric(obj[`${base}_ms`]);
  if (ms !== null) return ms / 1000;
  const plain = numeric(obj[base]);
  if (plain !== null) return plain;
  const camel = numeric(obj[`${base}Time`]);
  if (camel !== null) return camel;
  return null;
}

function labelFor(type, mediaType) {
  switch (type) {
    case 'intro':
      return 'Skip Intro';
    case 'recap':
      return 'Skip Recap';
    case 'preview':
      return 'Skip Preview';
    case 'outro':
      return mediaType === 'movie' ? 'Skip Credits' : 'Next Episode';
    default:
      return 'Skip';
  }
}

/**
 * Build one normalised segment or return null when the data is unusable.
 * `end: null` is only accepted when `allowOpenEnd` is set (TheIntroDB defines
 * it as "until the end of the media"); every other provider must give a
 * finite end or the segment is dropped.
 */
function makeSegment({ type, start, end, source, mediaType, confidence, allowOpenEnd = false }) {
  if (!SEGMENT_TYPES.includes(type)) return null;
  let s = numeric(start);
  let e = numeric(end);
  if (s === null && e === null) return null;
  if (s === null) s = 0;
  if (s < 0) s = 0;
  if (e === null) {
    if (!allowOpenEnd) return null;
  } else {
    if (e - s < MIN_SEGMENT_SECONDS) return null;
    e = round1(e);
  }
  const seg = {
    type,
    label: labelFor(type, mediaType),
    start: round1(s),
    end: e,
    source
  };
  const conf = numeric(confidence);
  if (conf !== null) seg.confidence = conf;
  return seg;
}

/* ------------------------------------------------------------------------ */
/* TheIntroDB v3 (TMDB-keyed)                                                */
/* ------------------------------------------------------------------------ */

function buildTheIntroDbUrl(baseUrl, { tmdbId, type, season, episode, durationMs } = {}) {
  const base = (baseUrl || DEFAULT_URLS.theIntroDbUrl).replace(/\/$/, '');
  const id = String(tmdbId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const params = new URLSearchParams();
  params.set('tmdb_id', id);
  if (type === 'tv') {
    const s = Number(season);
    const e = Number(episode);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 1) return null;
    params.set('season', String(s));
    params.set('episode', String(e));
  }
  const dur = numeric(durationMs);
  if (dur !== null && dur > 0) params.set('duration_ms', String(Math.round(dur)));
  return `${base}/media?${params.toString()}`;
}

const THEINTRODB_TYPE_MAP = {
  intro: 'intro',
  recap: 'recap',
  credits: 'outro',
  outro: 'outro',
  preview: 'preview'
};

function parseTheIntroDb(data, mediaType) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out = [];
  for (const [key, type] of Object.entries(THEINTRODB_TYPE_MAP)) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const seg = makeSegment({
        type,
        start: pickSeconds(item, 'start'),
        end: pickSeconds(item, 'end'),
        source: 'theintrodb',
        mediaType,
        confidence: item.confidence,
        allowOpenEnd: true
      });
      if (seg) out.push(seg);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* IntroDB (IMDb-keyed)                                                      */
/* ------------------------------------------------------------------------ */

function normalizeImdbId(value) {
  const id = String(value || '').trim();
  return /^tt\d{7,8}$/.test(id) ? id : null;
}

function buildIntroDbUrl(baseUrl, { imdbId, type, season, episode } = {}) {
  const base = (baseUrl || DEFAULT_URLS.introDbUrl).replace(/\/$/, '');
  const id = normalizeImdbId(imdbId);
  if (!id) return null;
  const params = new URLSearchParams();
  params.set('imdb_id', id);
  if (type === 'movie') {
    params.set('is_movie', 'true');
  } else {
    const s = Number(season);
    const e = Number(episode);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 1) return null;
    params.set('season', String(s));
    params.set('episode', String(e));
  }
  return `${base}/segments?${params.toString()}`;
}

const INTRODB_TYPE_MAP = {
  intro: 'intro',
  recap: 'recap',
  outro: 'outro',
  credits: 'outro',
  preview: 'preview'
  // `post_credits` is deliberately ignored: nobody wants to skip the stinger.
};

function parseIntroDb(data, mediaType) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out = [];
  let sawStructured = false;
  for (const [key, type] of Object.entries(INTRODB_TYPE_MAP)) {
    if (!(key in data)) continue;
    sawStructured = true;
    const item = data[key];
    if (!item || typeof item !== 'object') continue;
    const seg = makeSegment({
      type,
      start: pickSeconds(item, 'start'),
      end: pickSeconds(item, 'end'),
      source: 'introdb',
      mediaType,
      confidence: item.confidence
    });
    if (seg) out.push(seg);
  }
  if (sawStructured) return out;

  // Legacy flat `/intro` payload: `{ imdb_id, season, episode, start_ms, end_ms }`.
  const start = pickSeconds(data, 'start');
  const end = pickSeconds(data, 'end');
  if (start !== null || end !== null) {
    const seg = makeSegment({
      type: 'intro',
      start,
      end,
      source: 'introdb',
      mediaType,
      confidence: data.confidence
    });
    if (seg) out.push(seg);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* AniSkip v2 (MAL-keyed)                                                    */
/* ------------------------------------------------------------------------ */

const ANISKIP_TYPES = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'];

function buildAniSkipUrl(baseUrl, { malId, episode } = {}) {
  const base = (baseUrl || DEFAULT_URLS.aniSkipUrl).replace(/\/$/, '');
  const id = String(malId || '').trim();
  const ep = Number(episode);
  if (!/^\d+$/.test(id) || !Number.isInteger(ep) || ep < 1) return null;
  const types = ANISKIP_TYPES.map((t) => `types=${t}`).join('&');
  return `${base}/skip-times/${id}/${ep}?${types}&episodeLength=0`;
}

const ANISKIP_TYPE_MAP = {
  op: 'intro',
  'mixed-op': 'intro',
  ed: 'outro',
  'mixed-ed': 'outro',
  recap: 'recap'
};

function parseAniSkip(data, mediaType) {
  if (!data || typeof data !== 'object') return [];
  const results = Array.isArray(data.results) ? data.results : [];
  const out = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const type = ANISKIP_TYPE_MAP[String(item.skipType || item.skip_type || '').toLowerCase()];
    if (!type) continue;
    const interval = item.interval || {};
    const seg = makeSegment({
      type,
      start: pickSeconds(interval, 'start'),
      end: pickSeconds(interval, 'end'),
      source: 'aniskip',
      mediaType
    });
    if (seg) out.push(seg);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Merge                                                                     */
/* ------------------------------------------------------------------------ */

/** Two providers describing the same break rarely agree to the second. */
const DEDUPE_GAP_SECONDS = 2;

function overlaps(a, b) {
  const aEnd = a.end === null ? Infinity : a.end;
  const bEnd = b.end === null ? Infinity : b.end;
  return a.start < bEnd + DEDUPE_GAP_SECONDS && b.start < aEnd + DEDUPE_GAP_SECONDS;
}

/**
 * Flatten provider results, drop duplicates of the same type that overlap
 * (higher-priority provider wins), and return them ordered by start time.
 */
function mergeSegments(lists) {
  const all = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const seg of list) {
      if (seg && SEGMENT_TYPES.includes(seg.type) && isFiniteNumber(seg.start)) all.push(seg);
    }
  }
  all.sort((a, b) => {
    const pa = PROVIDER_ORDER.indexOf(a.source);
    const pb = PROVIDER_ORDER.indexOf(b.source);
    if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.start - b.start;
  });
  const kept = [];
  for (const seg of all) {
    if (kept.some((k) => k.type === seg.type && overlaps(k, seg))) continue;
    kept.push(seg);
  }
  kept.sort((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity));
  return kept;
}

module.exports = {
  DEFAULT_URLS,
  SEGMENT_TYPES,
  labelFor,
  pickSeconds,
  makeSegment,
  normalizeImdbId,
  buildTheIntroDbUrl,
  parseTheIntroDb,
  buildIntroDbUrl,
  parseIntroDb,
  buildAniSkipUrl,
  parseAniSkip,
  mergeSegments
};
