const config = require('../config');
const { cache } = require('../utils/cache');
const skipSegments = require('./skipSegments');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const POSITIVE_TTL_SECONDS = 6 * 3600;
// Confirmed misses are cached too: TheIntroDB allows 500 unauthenticated
// requests per day per IP and every player load would otherwise re-ask for a
// title that has no data.
const NEGATIVE_TTL_SECONDS = 15 * 60;
// When a provider was unreachable (timeout, 5xx, 429) we only hold the empty
// answer briefly so a transient outage cannot hide segments for long.
const FAILED_TTL_SECONDS = 60;

/**
 * Fetch one provider. Resolves `{ answered, data }`:
 *   - 200          -> answered: true, data: parsed JSON
 *   - 404          -> answered: true, data: null ("no data for this title")
 *   - anything else-> answered: false (outage / rate limit / timeout)
 */
async function fetchProviderJson(url, { timeoutMs = 4500, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...headers
      },
      signal: controller.signal
    });
    if (res.status === 404) return { answered: true, data: null };
    if (!res.ok) return { answered: false, data: null };
    return { answered: true, data: await res.json() };
  } catch {
    return { answered: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve Skip Intro / Recap / Credits timestamps for one title.
 *
 * Sources (queried in parallel, merged by `skipSegments.mergeSegments`):
 *   1. TheIntroDB v3 — keyed by the TMDB id we already have (movies + TV).
 *   2. IntroDB       — keyed by IMDb id from TMDB external ids (movies + TV).
 *   3. AniSkip v2    — keyed by MAL id when the metadata bridge found one.
 *
 * Returns `{ tmdbId, type, season, episode, segments }` where `segments` is
 * the normalised array the player consumes (see skipSegments.js).
 */
async function resolveSkipSegments(metadata) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata || {};
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  const cacheKey = `segments:v3:${mediaType}:${tmdbId}:s${season}:e${episode}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const upstreams = config.upstreams;
  const lookups = [];
  let allAnswered = true;
  const parsed = (promise, parse) =>
    promise.then(({ answered, data }) => {
      if (!answered) allAnswered = false;
      return parse(data, mediaType);
    });

  const theIntroDbUrl = skipSegments.buildTheIntroDbUrl(upstreams.theIntroDbUrl, {
    tmdbId,
    type: mediaType,
    season,
    episode
  });
  if (theIntroDbUrl) {
    const headers = upstreams.theIntroDbApiKey
      ? { Authorization: `Bearer ${upstreams.theIntroDbApiKey}` }
      : {};
    lookups.push(parsed(fetchProviderJson(theIntroDbUrl, { headers }), skipSegments.parseTheIntroDb));
  }

  const introDbUrl = skipSegments.buildIntroDbUrl(upstreams.introDbUrl, {
    imdbId: externalIds.imdb_id,
    type: mediaType,
    season,
    episode
  });
  if (introDbUrl) {
    lookups.push(parsed(fetchProviderJson(introDbUrl), skipSegments.parseIntroDb));
  }

  if (mediaType === 'tv') {
    const aniSkipUrl = skipSegments.buildAniSkipUrl(upstreams.aniSkipUrl, {
      malId: externalIds.mal_id,
      episode
    });
    if (aniSkipUrl) {
      lookups.push(parsed(fetchProviderJson(aniSkipUrl), skipSegments.parseAniSkip));
    }
  }

  const results = await Promise.all(lookups);
  const segments = skipSegments.mergeSegments(results);

  const output = {
    tmdbId,
    type: mediaType,
    season,
    episode,
    segments
  };

  const ttl = segments.length > 0
    ? POSITIVE_TTL_SECONDS
    : allAnswered
      ? NEGATIVE_TTL_SECONDS
      : FAILED_TTL_SECONDS;
  await cache.set(cacheKey, output, ttl);
  return output;
}

module.exports = {
  resolveSkipSegments
};
