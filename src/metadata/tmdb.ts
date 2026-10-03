import { config } from '../config.js';
import { logFor } from '../logger.js';
import { cache, ck } from '../cache/index.js';
import { fetchJson } from '../util/http.js';
import type { MediaType } from '../providers/types.js';

/**
 * TMDB metadata client.
 *
 * Entirely optional: with no API key every method returns null and the API
 * falls back to title/year matching. With a key you get proper ids, artwork,
 * episode lists and — importantly — reliable IMDB↔TMDB translation, which is
 * what lets one request fan out across providers that key on either id.
 */

const log = logFor('tmdb');

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

export interface TmdbMedia {
  tmdbId: number;
  imdbId?: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  votes?: number;
  runtime?: number;
  genres: string[];
  tagline?: string;
  status?: string;
  /** Series only. */
  seasons?: TmdbSeason[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  releaseDate?: string;
}

export interface TmdbSeason {
  seasonNumber: number;
  name?: string;
  episodeCount?: number;
  airDate?: string;
  poster?: string;
  overview?: string;
}

export interface TmdbEpisode {
  episodeNumber: number;
  seasonNumber: number;
  name?: string;
  overview?: string;
  still?: string;
  airDate?: string;
  runtime?: number;
  rating?: number;
}

export interface TmdbSearchHit {
  tmdbId: number;
  imdbId?: string;
  type: MediaType;
  title: string;
  year?: number;
  overview?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
}

const available = () => config.hasTmdb;

function key(): string {
  return config.TMDB_API_KEY;
}

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  if (!available()) return null;
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', key());
  url.searchParams.set('language', config.TMDB_LANGUAGE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return fetchJson<T>(url.toString(), { timeout: 10_000, retries: 1 });
}

const img = (p?: string | null, size = 'w500') =>
  p ? `${IMG}/${size}${p.startsWith('/') ? p : `/${p}`}` : undefined;

interface RawMovie {
  id: number;
  imdb_id?: string;
  title?: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  runtime?: number;
  genres?: { id: number; name: string }[];
  tagline?: string;
  status?: string;
}

interface RawTv {
  id: number;
  external_ids?: { imdb_id?: string | null };
  name?: string;
  original_name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  episode_run_time?: number[];
  genres?: { id: number; name: string }[];
  tagline?: string;
  status?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
  seasons?: {
    season_number: number;
    name?: string;
    episode_count?: number;
    air_date?: string | null;
    poster_path?: string | null;
    overview?: string;
  }[];
}

function mapMovie(m: RawMovie): TmdbMedia {
  return {
    tmdbId: m.id,
    imdbId: m.imdb_id || undefined,
    type: 'movie',
    title: m.title ?? m.original_title ?? 'Untitled',
    originalTitle: m.original_title,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) || undefined : undefined,
    overview: m.overview,
    poster: img(m.poster_path),
    backdrop: img(m.backdrop_path, 'w1280'),
    rating: m.vote_average ? Number(m.vote_average.toFixed(1)) : undefined,
    votes: m.vote_count,
    runtime: m.runtime,
    genres: (m.genres ?? []).map((g) => g.name),
    tagline: m.tagline,
    status: m.status,
    releaseDate: m.release_date,
  };
}

function mapTv(t: RawTv): TmdbMedia {
  return {
    tmdbId: t.id,
    imdbId: t.external_ids?.imdb_id || undefined,
    type: 'series',
    title: t.name ?? t.original_name ?? 'Untitled',
    originalTitle: t.original_name,
    year: t.first_air_date ? Number(t.first_air_date.slice(0, 4)) || undefined : undefined,
    overview: t.overview,
    poster: img(t.poster_path),
    backdrop: img(t.backdrop_path, 'w1280'),
    rating: t.vote_average ? Number(t.vote_average.toFixed(1)) : undefined,
    votes: t.vote_count,
    runtime: t.episode_run_time?.[0],
    genres: (t.genres ?? []).map((g) => g.name),
    tagline: t.tagline,
    status: t.status,
    releaseDate: t.first_air_date,
    numberOfSeasons: t.number_of_seasons,
    numberOfEpisodes: t.number_of_episodes,
    seasons: (t.seasons ?? [])
      .filter((s) => (s.season_number ?? 0) >= 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        airDate: s.air_date ?? undefined,
        poster: img(s.poster_path, 'w300'),
        overview: s.overview,
      })),
  };
}

export const tmdb = {
  get enabled(): boolean {
    return available();
  },

  /** Look up by TMDB id. */
  async byId(type: MediaType, id: number): Promise<TmdbMedia | null> {
    if (!available()) return null;
    const ckKey = ck.meta(type, String(id), config.TMDB_LANGUAGE);
    return cache.wrap<TmdbMedia | null>(ckKey, config.CACHE_TTL_META, async () => {
      if (type === 'movie') {
        const r = await get<RawMovie>(`/movie/${id}`);
        return r ? mapMovie(r) : null;
      }
      const r = await get<RawTv>(`/tv/${id}`, { append_to_response: 'external_ids' });
      return r ? mapTv(r) : null;
    });
  },

  /** Resolve an IMDB id (tt…) to full TMDB metadata. */
  async byImdb(imdbId: string): Promise<TmdbMedia | null> {
    if (!available() || !/^tt\d+$/i.test(imdbId)) return null;
    const ckKey = ck.meta('imdb', imdbId, config.TMDB_LANGUAGE);

    return cache.wrap<TmdbMedia | null>(ckKey, config.CACHE_TTL_META, async () => {
      const find = await get<{
        movie_results?: RawMovie[];
        tv_results?: (RawTv & { name?: string })[];
      }>(`/find/${imdbId}`, { external_source: 'imdb_id' });

      if (!find) return null;

      if (find.movie_results?.length) {
        const full = await get<RawMovie>(`/movie/${find.movie_results[0]!.id}`);
        return full ? mapMovie(full) : mapMovie(find.movie_results[0]!);
      }
      if (find.tv_results?.length) {
        const r0 = find.tv_results[0]!;
        const full = await get<RawTv>(`/tv/${r0.id}`, { append_to_response: 'external_ids' });
        const mapped = full ? mapTv(full) : mapTv(r0);
        return { ...mapped, imdbId };
      }
      return null;
    });
  },

  /** Search movies + series. */
  async search(query: string, type?: MediaType, page = 1): Promise<TmdbSearchHit[]> {
    if (!available() || !query.trim()) return [];
    const ckKey = ck.search(query, type ?? 'multi', config.TMDB_LANGUAGE);

    return (
      (await cache.wrap<TmdbSearchHit[]>(ckKey, config.CACHE_TTL_SEARCH, async () => {
        const out: TmdbSearchHit[] = [];

        if (!type || type === 'movie') {
          const r = await get<{ results?: RawMovie[] }>('/search/movie', {
            query,
            page,
            include_adult: 'false',
          });
          for (const m of r?.results ?? []) {
            const mapped = mapMovie(m);
            out.push({
              tmdbId: mapped.tmdbId,
              imdbId: mapped.imdbId,
              type: 'movie',
              title: mapped.title,
              year: mapped.year,
              overview: mapped.overview?.slice(0, 300),
              poster: mapped.poster,
              backdrop: mapped.backdrop,
              rating: mapped.rating,
            });
          }
        }

        if (!type || type === 'series' || type === 'anime') {
          const r = await get<{ results?: RawTv[] }>('/search/tv', { query, page });
          for (const t of r?.results ?? []) {
            const mapped = mapTv(t);
            out.push({
              tmdbId: mapped.tmdbId,
              imdbId: mapped.imdbId,
              type: 'series',
              title: mapped.title,
              year: mapped.year,
              overview: mapped.overview?.slice(0, 300),
              poster: mapped.poster,
              backdrop: mapped.backdrop,
              rating: mapped.rating,
            });
          }
        }

        return out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      })) ?? []
    );
  },

  /** Full episode list for a season. */
  async season(tmdbId: number, season: number): Promise<TmdbEpisode[]> {
    if (!available()) return [];
    return (
      (await cache.wrap<TmdbEpisode[]>(
        ck.meta('season', `${tmdbId}:${season}`, config.TMDB_LANGUAGE),
        config.CACHE_TTL_META,
        async () => {
          const r = await get<{
            episodes?: {
              episode_number: number;
              season_number: number;
              name?: string;
              overview?: string;
              still_path?: string | null;
              air_date?: string | null;
              runtime?: number;
              vote_average?: number;
            }[];
          }>(`/tv/${tmdbId}/season/${season}`);

          return (r?.episodes ?? []).map((e) => ({
            episodeNumber: e.episode_number,
            seasonNumber: e.season_number,
            name: e.name,
            overview: e.overview,
            still: img(e.still_path, 'w500'),
            airDate: e.air_date ?? undefined,
            runtime: e.runtime,
            rating: e.vote_average ? Number(e.vote_average.toFixed(1)) : undefined,
          }));
        },
      )) ?? []
    );
  },

  /** Trending / popular catalogues. */
  async list(kind: 'trending' | 'popular' | 'top_rated', type: MediaType, page = 1): Promise<TmdbSearchHit[]> {
    if (!available()) return [];
    const path =
      kind === 'trending'
        ? `/trending/${type === 'movie' ? 'movie' : 'tv'}/week`
        : `/${type === 'movie' ? 'movie' : 'tv'}/${kind}`;

    return (
      (await cache.wrap<TmdbSearchHit[]>(
        ck.meta('list', `${kind}:${type}:${page}`, config.TMDB_LANGUAGE),
        config.CACHE_TTL_SEARCH,
        async () => {
          const r = await get<{ results?: (RawMovie | RawTv)[] }>(path, { page });
          return (r?.results ?? []).map((item) => {
            const isMovie = 'title' in item;
            const m = isMovie ? mapMovie(item as RawMovie) : mapTv(item as RawTv);
            return {
              tmdbId: m.tmdbId,
              imdbId: m.imdbId,
              type: m.type,
              title: m.title,
              year: m.year,
              overview: m.overview?.slice(0, 300),
              poster: m.poster,
              backdrop: m.backdrop,
              rating: m.rating,
            };
          });
        },
      )) ?? []
    );
  },
};

if (!available()) {
  log.warn('TMDB_API_KEY not set — metadata lookups disabled (title/year fallback in use)');
}
