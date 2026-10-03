const config = require('../config');
const { cache } = require('../utils/cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
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
 * Resolve Skip Intro / Recap / Outro timestamps using real IntroDB & AniSkip APIs.
 * Automatically bridges from TMDB metadata (imdb_id and mal_id).
 */
async function resolveSkipSegments(metadata) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata;
  const cacheKey = `segments:v2:${type}:${tmdbId}:s${season}:e${episode}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const segments = [];

  // 1. Query IntroDB (https://api.introdb.app/intro?imdb_id=tt...&season=1&episode=1)
  if (externalIds.imdb_id && type === 'tv') {
    const introUrl = `${config.upstreams.introDbUrl}/intro?imdb_id=${encodeURIComponent(externalIds.imdb_id)}&season=${season}&episode=${episode}`;
    const introData = await fetchJsonWithTimeout(introUrl);
    if (introData) {
      const start = introData.start_sec ?? introData.start;
      const end = introData.end_sec ?? introData.end;
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
  }

  // 2. Query AniSkip v2 API when MAL ID is available
  if (externalIds.mal_id) {
    const aniUrl = `${config.upstreams.aniSkipUrl}/skip-times/${encodeURIComponent(externalIds.mal_id)}/${episode}?types[]=op&types[]=ed&types[]=recap&types[]=mixed-op&types[]=mixed-ed&episodeLength=0`;
    const aniData = await fetchJsonWithTimeout(aniUrl);
    if (aniData && aniData.found && Array.isArray(aniData.results)) {
      for (const item of aniData.results) {
        const st = item.interval?.startTime;
        const et = item.interval?.endTime;
        if (typeof st === 'number' && typeof et === 'number' && et > st) {
          const isOutro = item.skipType === 'ed' || item.skipType === 'mixed-ed';
          const isRecap = item.skipType === 'recap';
          segments.push({
            type: isOutro ? 'outro' : isRecap ? 'recap' : 'intro',
            label: isOutro ? 'Next Episode' : isRecap ? 'Skip Recap' : 'Skip Intro',
            start: Math.round(st * 10) / 10,
            end: Math.round(et * 10) / 10,
            source: 'aniskip'
          });
        }
      }
    }
  }

  const output = {
    tmdbId,
    type,
    season,
    episode,
    segments
  };

  if (segments.length > 0) {
    await cache.set(cacheKey, output, 3600);
  }
  return output;
}

module.exports = {
  resolveSkipSegments
};
