const config = require('../config');
const tmdbArtwork = require('./tmdbArtwork');
const { cache } = require('../utils/cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Fetch helper with timeout and automatic headers
 */
async function safeFetchJson(url, options = {}, timeoutMs = 8500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(options.headers || {})
    };
    if (config.tmdbBearerToken && url.includes('api.themoviedb.org')) {
      headers.Authorization = `Bearer ${config.tmdbBearerToken}`;
    }
    const res = await fetch(url, {
      ...options,
      headers,
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
 * Resolve MyAnimeList (MAL) ID via Jikan v4 API when title is an anime / animation
 */
async function resolveMalId(title, releaseYear, type) {
  if (!title) return null;
  const cacheKey = `mal:${type}:${title.toLowerCase()}:${releaseYear || ''}`;
  const cached = await cache.get(cacheKey);
  if (cached !== null) return cached;

  const jikanType = type === 'movie' ? 'movie' : 'tv';
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&type=${jikanType}&limit=5`;
  const data = await safeFetchJson(url, {}, 5000);
  if (!data || !Array.isArray(data.data) || data.data.length === 0) {
    return null;
  }

  let best = data.data[0];
  if (releaseYear) {
    const matchByYear = data.data.find((item) => {
      const airedYear = item.year || (item.aired?.from ? Number(item.aired.from.slice(0, 4)) : null);
      return airedYear && Math.abs(airedYear - Number(releaseYear)) <= 1;
    });
    if (matchByYear) best = matchByYear;
  }

  const malId = best?.mal_id || null;
  if (malId) {
    await cache.set(cacheKey, malId, 86400);
  }
  return malId;
}

/**
 * Resolve TMDB ID -> Unified Metadata + External IDs (IMDb, TVDB, MAL) + Season/Episode Details.
 * Users only pass TMDB ID; this service bridges every external ID automatically.
 */
async function resolveTmdbMetadata(type, tmdbId, season = 1, episode = 1) {
  const normalizedType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
  const cleanId = String(tmdbId).trim();
  const sNum = Math.max(1, parseInt(season || 1, 10));
  const eNum = Math.max(1, parseInt(episode || 1, 10));

  const cacheKey = `tmdb:v3:${normalizedType}:${cleanId}:s${sNum}:e${eNum}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  let result = null;

  // 1. Primary: Official TMDB API v3 with append_to_response=external_ids
  if (config.tmdbApiKey || config.tmdbBearerToken) {
    const apiKeyParam = config.tmdbApiKey ? `api_key=${encodeURIComponent(config.tmdbApiKey)}&` : '';
    // alternative_titles powers the TMDB-anchored identity gate used by the
    // name-search upstreams (CastleTV): a localized or original
    // title must be provably the same film, not just a title collision.
    // `images` (logos) + tagline + rating feed the player's connect / paused
    // screens; the selection logic is shared with the Worker (tmdbArtwork.js).
    const detailsUrl = `${config.tmdbBaseUrl}/${normalizedType}/${cleanId}?${apiKeyParam}${tmdbArtwork.DETAILS_APPEND}&language=en-US`;
    const data = await safeFetchJson(detailsUrl);

    if (data && (data.id || data.title || data.name)) {
      const releaseDate = data.release_date || data.first_air_date || '';
      const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;
      const genres = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
      const isAnimation =
        genres.some((g) => /animation|anime/i.test(g)) ||
        (Array.isArray(data.origin_country) && data.origin_country.includes('JP'));

      let seasons = [];
      let episodes = [];

      if (normalizedType === 'tv') {
        seasons = (data.seasons || [])
          .filter((s) => s.season_number > 0)
          .map((s) => ({
            season_number: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episode_count: s.episode_count || 0,
            poster: s.poster_path ? `${config.tmdbImageBase}/w342${s.poster_path}` : null
          }));

        const seasonUrl = `${config.tmdbBaseUrl}/tv/${cleanId}/season/${sNum}?${apiKeyParam}language=en-US`;
        const seasonData = await safeFetchJson(seasonUrl);
        if (seasonData && Array.isArray(seasonData.episodes)) {
          episodes = seasonData.episodes.map((ep) => ({
            episode: ep.episode_number,
            season: sNum,
            title: ep.name || `Episode ${ep.episode_number}`,
            runtime: ep.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
            date: ep.air_date || '',
            still: ep.still_path
              ? `${config.tmdbImageBase}/w500${ep.still_path}`
              : data.backdrop_path
                ? `${config.tmdbImageBase}/w780${data.backdrop_path}`
                : null,
            overview: ep.overview || ''
          }));
        }
      }

      const title = data.title || data.name;
      const imdbId = data.imdb_id || data.external_ids?.imdb_id || null;
      const tvdbId = data.external_ids?.tvdb_id || null;
      const malId = isAnimation ? await resolveMalId(title, releaseYear, normalizedType) : null;
      const alternativeTitles = (data.alternative_titles?.titles || [])
        .map((entry) => entry && entry.title)
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .slice(0, 25);

      result = {
        tmdbId: Number(cleanId) || cleanId,
        type: normalizedType,
        title,
        originalTitle: data.original_title || data.original_name || title,
        alternativeTitles,
        releaseYear,
        runtime: data.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
        genres,
        overview: data.overview || '',
        backdrop: data.backdrop_path ? `${config.tmdbImageBase}/w1280${data.backdrop_path}` : null,
        poster: data.poster_path ? `${config.tmdbImageBase}/w500${data.poster_path}` : null,
        ...tmdbArtwork.presentationFields(data, config.tmdbImageBase),
        externalIds: {
          imdb_id: imdbId,
          tvdb_id: tvdbId,
          mal_id: malId,
          anilist_id: null
        },
        seasons,
        episodes
      };
    }
  }

  // 2. Secondary Live Fallback: VidStuck Backend TMDB Proxy + Cinemeta Episode Resolver
  if (!result) {
    const vidstuckUrl = `${config.upstreams.vidstuckBase}/backend/tmdb/details/${normalizedType}/${cleanId}?language=en-US`;
    const vsData = await safeFetchJson(vidstuckUrl, {
      headers: { Referer: `${config.upstreams.vidstuckBase}/` }
    });

    if (vsData && (vsData.id || vsData.title || vsData.name)) {
      const releaseDate = vsData.release_date || vsData.first_air_date || '';
      const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;
      const genres = Array.isArray(vsData.genres) ? vsData.genres.map((g) => g.name) : [];
      const title = vsData.title || vsData.name;
      const imdbId = vsData.imdb_id || vsData.external_ids?.imdb_id || null;

      let seasons = [];
      let episodes = [];

      if (normalizedType === 'tv') {
        seasons = (vsData.seasons || [])
          .filter((s) => s.season_number > 0)
          .map((s) => ({
            season_number: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episode_count: s.episode_count || 0
          }));

        // Populate episodes via Cinemeta if IMDb ID is present
        if (imdbId) {
          const cineData = await safeFetchJson(
            `${config.upstreams.cinemetaUrl}/meta/series/${imdbId}.json`
          );
          if (cineData?.meta?.videos) {
            episodes = cineData.meta.videos
              .filter((v) => Number(v.season) === sNum)
              .map((v) => ({
                episode: Number(v.episode || v.number),
                season: sNum,
                title: v.name || v.title || `Episode ${v.episode || v.number}`,
                runtime: parseInt(cineData.meta.runtime, 10) || null,
                date: v.released ? String(v.released).slice(0, 10) : '',
                still: v.thumbnail || (vsData.backdrop_path ? `${config.tmdbImageBase}/w780${vsData.backdrop_path}` : null),
                overview: v.overview || v.description || ''
              }));
          }
        }
      }

      result = {
        tmdbId: Number(cleanId) || cleanId,
        type: normalizedType,
        title,
        originalTitle: vsData.original_title || vsData.original_name || title,
        releaseYear,
        runtime: vsData.runtime || (Array.isArray(vsData.episode_run_time) && vsData.episode_run_time[0]) || null,
        genres,
        overview: vsData.overview || '',
        backdrop: vsData.backdrop_path ? `${config.tmdbImageBase}/w1280${vsData.backdrop_path}` : null,
        poster: vsData.poster_path ? `${config.tmdbImageBase}/w500${vsData.poster_path}` : null,
        externalIds: {
          imdb_id: imdbId,
          tvdb_id: vsData.external_ids?.tvdb_id || null,
          mal_id: null,
          anilist_id: null
        },
        seasons,
        episodes
      };
    }
  }

  // If neither API could be reached (e.g., offline environment or invalid TMDB ID), return minimal structural descriptor
  if (!result) {
    return {
      tmdbId: Number(cleanId) || cleanId,
      type: normalizedType,
      title: null,
      originalTitle: null,
      releaseYear: null,
      runtime: null,
      genres: [],
      overview: '',
      backdrop: null,
      poster: null,
      externalIds: {
        imdb_id: null,
        tvdb_id: null,
        mal_id: null,
        anilist_id: null
      },
      seasons: [],
      episodes: [],
      season: sNum,
      episode: eNum,
      activeEpisode: null,
      unresolvedTmdb: true
    };
  }

  const activeEpisode =
    normalizedType === 'tv'
      ? result.episodes.find((ep) => Number(ep.episode) === eNum) || result.episodes[0] || null
      : null;

  const finalPayload = {
    ...result,
    season: sNum,
    episode: eNum,
    activeEpisode
  };

  await cache.set(cacheKey, finalPayload, 3600);
  return finalPayload;
}

module.exports = {
  resolveTmdbMetadata,
  resolveMalId
};
