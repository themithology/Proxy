'use strict';

/**
 * TMDB-anchored identity matching for upstream catalogs that only support
 * plain-name search (CastleTV, Moviebox, ...).
 *
 * Why this exists: a bare title search is ambiguous. CastleTV returns TWO
 * different "Fight Club" entries and the 2023 Indian film (which carries a
 * Hindi dub) outranks the 1999 film the viewer asked for. Picking the first
 * row therefore plays the wrong movie. Instead we resolve the TMDB id to a
 * full identity (title + original title + alternative titles + release year +
 * type) and only accept an upstream candidate that provably IS that title.
 *
 * Guarantees:
 *  - A candidate is accepted only when its title matches the TMDB title (or an
 *    original/alternative title) after canonicalization.
 *  - For movies a known candidate year must be within +/- 1 year of TMDB.
 *  - A movie candidate is never accepted for a TV request (and vice versa).
 *  - Substring/sequel neighbours ("Female Fight Club", "Fight Club - Members
 *    Only") are rejected even when the preferred audio language is available.
 *  - Preferred-audio availability is only ever a tie-breaker between two
 *    identity-valid candidates; it never overrides identity.
 *
 * The module is intentionally dependency-free so the Cloudflare Worker build
 * can carry the same logic inline.
 */

const NUMBER_WORDS = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12'
};

const ROMAN_NUMERALS = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12'
};

// Dub/quality/container noise that upstream catalogs append to titles.
const TITLE_NOISE_WORDS =
  /\b(dubbed|dub|dual[-\s]?audio|multi[-\s]?audio|multi|original|hindi|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|urdu|english|korean|japanese|anime|hd|fhd|uhd|sd|4k|1080p|720p|480p|2160p|bluray|web[-\s]?dl|webrip|hevc|avc|x264|x265|aac|ddp?5?[.\s]?1|esub|esubs?|subs?)\b/gi;

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'at', 'for', 'with', 'de', 'la', 'le', 'el', 'der', 'die', 'das']);

/**
 * Loose normalization used for exact-ish comparisons: punctuation, case,
 * bracketed noise ([Hindi Dub], (2019)) and language/quality tags removed.
 */
function normalizeTitleKey(value) {
  return String(value == null ? '' : value)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
    .replace(TITLE_NOISE_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical token form: number words and simple roman numerals become digits,
 * stop words are dropped, tokens sorted for order-insensitive comparison of
 * "Part Two" vs "2 Part" style upstream titles.
 */
function canonicalTitleKey(value) {
  const key = normalizeTitleKey(value);
  if (!key) return '';
  const tokens = key
    .split(' ')
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] || ROMAN_NUMERALS[token] || token)
    .filter((token) => !STOP_WORDS.has(token));
  return tokens.sort().join(' ');
}

/**
 * Extract a release year from numbers, epoch timestamps and ISO date strings.
 */
function extractYearFromValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const n = Number(value);
    // A plain release year first, then epoch milliseconds, then epoch seconds.
    // (CastleTV publishes epoch-ms timestamps; 1999 is ~9.4e11, so the ms range
    // must start below 1e12.)
    if (n >= 1900 && n <= 2100) return n;
    if (n >= 1e11 && n <= 4.2e12) return new Date(n).getUTCFullYear();
    if (n >= 1e9 && n < 1e11) return new Date(n * 1000).getUTCFullYear();
    return null;
  }
  const match = String(value).match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

/** Pull "(1999)" / "[2024]" out of an upstream title when no year field exists. */
function extractYearFromTitle(title) {
  const match = String(title || '').match(/[([-]\s*((?:19|20)\d{2})\s*[)\]]?/);
  return match ? Number(match[1]) : null;
}

/** Year of a whole season (upstream TV rows report the latest season year). */
function isYearCompatible(candidateYear, tmdbYear, type) {
  if (!candidateYear || !tmdbYear) return true; // unknown -> no evidence either way
  const diff = Math.abs(Number(candidateYear) - Number(tmdbYear));
  if (type === 'tv') {
    // TV rows carry the newest season year (Arcane 2024 for a 2021 show), so
    // only a candidate OLDER than the show start is a red flag.
    return Number(candidateYear) >= Number(tmdbYear) - 1 || diff <= 1;
  }
  return diff <= 1;
}

/** Map upstream type labels to the TMDB vocabulary. */
function normalizeTypeToken(rawType, rawTypeName) {
  const combined = `${rawType == null ? '' : rawType} ${rawTypeName == null ? '' : rawTypeName}`.toLowerCase();
  if (/anime/.test(combined)) return 'anime';
  if (/series|tv|show|drama|variety/.test(combined)) return 'tv';
  if (/movie|film/.test(combined)) return 'movie';
  return 'unknown';
}

function isTypeCompatible(candidateType, wantedType) {
  if (!candidateType || candidateType === 'unknown') return true;
  if (!wantedType) return true;
  const wanted = wantedType === 'series' ? 'tv' : wantedType;
  if (wanted === 'tv') return candidateType === 'tv' || candidateType === 'anime';
  return candidateType === 'movie';
}

function buildTitleVariants(metadata = {}) {
  const variants = [];
  const push = (value, source, weight) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const key = normalizeTitleKey(raw);
    if (!key) return;
    if (variants.some((v) => v.key === key && v.source === source)) return;
    variants.push({ raw, key, canonical: canonicalTitleKey(raw), source, weight });
  };
  push(metadata.title, 'title', 100);
  push(metadata.originalTitle, 'original', 96);
  push(metadata.originalName, 'original', 96);
  const alts = Array.isArray(metadata.alternativeTitles)
    ? metadata.alternativeTitles
    : Array.isArray(metadata.altTitles)
      ? metadata.altTitles
      : [];
  alts.forEach((alt) => {
    const value = typeof alt === 'string' ? alt : alt && (alt.title || alt.name);
    push(value, 'alt', 88);
  });
  return variants;
}

/**
 * Score how well an upstream title matches the TMDB identity.
 * Returns { score, source, matched } where score is 0..100.
 */
function scoreTitleMatch(candidateTitle, metadata) {
  const variants = buildTitleVariants(metadata);
  const candidateRaw = String(candidateTitle || '').trim();
  if (!candidateRaw || variants.length === 0) return { score: 0, source: null, matched: null };

  const key = normalizeTitleKey(candidateRaw);
  const canonical = canonicalTitleKey(candidateRaw);
  let best = { score: 0, source: null, matched: null };

  for (const variant of variants) {
    let score = 0;
    if (variant.key && key === variant.key) {
      score = variant.weight;
    } else if (variant.canonical && canonical && variant.canonical === canonical) {
      score = variant.source === 'alt' ? 82 : 90;
    } else if (
      variant.key &&
      key &&
      (key.startsWith(`${variant.key} `) || variant.key.startsWith(`${key} `))
    ) {
      // Whole-word prefix/extension only (never inside words). This is a weak
      // signal on purpose: "Female Fight Club" must not match "fight club".
      score = 40;
    }
    if (score > best.score) {
      best = { score, source: variant.source, matched: candidateRaw };
    }
  }
  return best;
}

function genreOverlapScore(candidateTags, metadata) {
  const genres = Array.isArray(metadata.genres) ? metadata.genres.map((g) => String(g).toLowerCase()) : [];
  const tags = Array.isArray(candidateTags) ? candidateTags.map((t) => String(t).toLowerCase().trim()) : [];
  if (!genres.length || !tags.length) return 0;
  let hits = 0;
  for (const genre of genres) {
    if (tags.some((tag) => tag.includes(genre) || genre.includes(tag))) hits += 1;
  }
  return Math.min(15, hits * 5);
}

/**
 * Score an upstream candidate against the TMDB identity.
 *
 * candidate: { title, year?, type?, languages?, tags?, runtime? }
 * metadata:  { title, originalTitle?, alternativeTitles?/altTitles?, releaseYear?, type, genres? }
 */
function scoreIdentityCandidate(candidate = {}, metadata = {}, options = {}) {
  const wantedType = String(metadata.type || options.type || '').toLowerCase();
  const preferredCode = String(options.preferredAudio || '').trim().toLowerCase();

  const titleMatch = scoreTitleMatch(candidate.title || candidate.name, metadata);
  const candidateYear =
    extractYearFromValue(candidate.year) ||
    extractYearFromValue(candidate.releaseYear) ||
    extractYearFromValue(candidate.releaseDate) ||
    extractYearFromTitle(candidate.title || candidate.name);
  const tmdbYear = extractYearFromValue(metadata.releaseYear) || extractYearFromValue(metadata.year);
  const candidateType = normalizeTypeToken(
    candidate.movieType != null ? candidate.movieType : candidate.subjectType,
    candidate.movieTypeName || candidate.typeName || candidate.type
  );

  const typeOk = isTypeCompatible(candidateType, wantedType);
  const yearOk = isYearCompatible(candidateYear, tmdbYear, wantedType === 'series' ? 'tv' : wantedType);

  const reasons = [];
  if (titleMatch.score >= 100) reasons.push('exact-title');
  else if (titleMatch.score >= 88) reasons.push(`title-${titleMatch.source}`);
  else if (titleMatch.score >= 80) reasons.push('title-variant');
  else if (titleMatch.score > 0) reasons.push('title-prefix-only');
  if (candidateYear && tmdbYear && candidateYear !== tmdbYear) {
    reasons.push(yearOk ? `year-off-by-${Math.abs(candidateYear - tmdbYear)}` : `year-mismatch:${candidateYear}!=${tmdbYear}`);
  } else if (candidateYear && tmdbYear) {
    reasons.push('year-match');
  }
  if (!typeOk) reasons.push(`type-mismatch:${candidateType}!=${wantedType}`);

  let score = titleMatch.score;
  if (candidateYear && tmdbYear && candidateYear === tmdbYear) score += 30;
  else if (yearOk && candidateYear && tmdbYear) score += 12;

  score += genreOverlapScore(candidate.tags || candidate.genres, metadata);

  const runtime = Number(candidate.runtime || candidate.duration || 0);
  const wantedRuntime = Number(metadata.runtime || 0);
  if (runtime && wantedRuntime) {
    const diff = Math.abs(runtime - wantedRuntime);
    if (diff <= 4) {
      score += 10;
      reasons.push('runtime-match');
    } else if (diff >= 20) {
      score -= 20;
      reasons.push('runtime-mismatch');
    }
  }

  const languages = Array.isArray(candidate.languages)
    ? candidate.languages.map((l) => String(l).toLowerCase())
    : [];
  if (preferredCode && languages.some((l) => l.includes(preferredCode))) {
    // Tie-breaker only: identity is decided before audio preference.
    score += 6;
    reasons.push('preferred-audio-present');
  }

  // Acceptance gate: identity, not score, decides. A weak title signal can
  // never be rescued by year/genre/audio bonuses (they are capped well below
  // the 80-point title threshold).
  const accepted = titleMatch.score >= 80 && typeOk && yearOk;

  return {
    accepted,
    score,
    titleScore: titleMatch.score,
    matchedTitleSource: titleMatch.source,
    candidateYear,
    tmdbYear,
    candidateType,
    typeOk,
    yearOk,
    reasons,
    title: candidate.title || candidate.name || null
  };
}

/**
 * Rank candidates and return the identity-valid winner (or null).
 * Never falls back to "first row" when nothing proves the identity.
 */
function pickIdentityMatch(candidates, metadata, options = {}) {
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && (c.title || c.name))
    .map((candidate) => ({ candidate, match: scoreIdentityCandidate(candidate, metadata, options) }))
    .sort((a, b) => {
      if (b.match.accepted !== a.match.accepted) return b.match.accepted ? 1 : -1;
      if (b.match.score !== a.match.score) return b.match.score - a.match.score;
      return 0;
    });

  const winner = ranked.find((entry) => entry.match.accepted) || null;
  return {
    winner: winner ? winner.candidate : null,
    winnerMatch: winner ? winner.match : null,
    rejected: ranked.filter((entry) => !entry.match.accepted).map((entry) => ({
      title: entry.match.title,
      year: entry.match.candidateYear,
      reason: entry.match.reasons.join(',') || 'no-title-match'
    })),
    ranked: ranked.map((entry) => ({
      title: entry.match.title,
      year: entry.match.candidateYear,
      accepted: entry.match.accepted,
      score: entry.match.score
    }))
  };
}

module.exports = {
  normalizeTitleKey,
  canonicalTitleKey,
  extractYearFromValue,
  extractYearFromTitle,
  isYearCompatible,
  normalizeTypeToken,
  isTypeCompatible,
  buildTitleVariants,
  scoreTitleMatch,
  scoreIdentityCandidate,
  pickIdentityMatch
};
