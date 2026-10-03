import type { FastifyInstance } from 'fastify';
import { registry, type RankOptions } from '../providers/registry.js';
import { tmdb } from '../metadata/tmdb.js';
import { parseId, parseLanguages, parseType } from '../util/ids.js';
import { config } from '../config.js';
import { AppError } from '../util/errors.js';
import { buildResolved } from '../stream/playback.js';
import { currentOrigin } from '../util/origin.js';
import { cache, ck } from '../store/cache.js';
import type { MediaType, ResolveQuery, StreamCandidate } from '../providers/types.js';

/** Bounded-concurrency map. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    new Array(Math.min(limit, Math.max(items.length, 1))).fill(0).map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/streams/:type/:id
   *
   *   ?season=1&episode=2      — for series/anime
   *   &lang=hi,en              — preferred audio languages, in order
   *   &only=hi                 — hard filter
   *   &limit=25                — cap results
   *   &minHeight=720           — drop anything smaller
   *   &playable=true           — drop embeds/torrents
   *   &expose=direct           — include raw upstream URLs
   *   &title=…&year=…          — override metadata (used when TMDB is off)
   *   &diagnostics=true        — include per-provider timings
   *
   * This is the endpoint a player calls.
   */
  app.get('/api/streams/:type/:id', async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const q = req.query as Record<string, string | undefined>;

    const mediaType = parseType(type);
    const parsed = parseId(id);

    if (!parsed.imdbId && !parsed.tmdbId && !parsed.native && !q.title) {
      throw AppError.badRequest(
        'Provide an IMDB id (tt0111161), a TMDB id (278 / tmdb:278), a prefixed id, or ?title=',
      );
    }

    const season = q.season !== undefined ? Number(q.season) : undefined;
    const episode = q.episode !== undefined ? Number(q.episode) : undefined;
    if (mediaType !== 'movie' && (season === undefined || episode === undefined)) {
      throw AppError.badRequest('Series and anime requests require ?season= and ?episode=');
    }

    // --- resolve metadata (best-effort) ------------------------------------
    let title = q.title?.trim() || '';
    let year = q.year ? Number(q.year) : undefined;
    let imdbId = parsed.imdbId;
    let tmdbId = parsed.tmdbId;
    let meta: unknown = null;

    if (!title && tmdb.enabled) {
      const media = imdbId
        ? await tmdb.byImdb(imdbId)
        : tmdbId
          ? await tmdb.byId(mediaType, Number(tmdbId))
          : null;

      if (media) {
        title = media.title;
        year = year ?? media.year;
        imdbId = imdbId ?? media.imdbId;
        tmdbId = tmdbId ?? String(media.tmdbId);
        meta = media;
      }
    }

    if (!title && parsed.native) title = parsed.native.value;
    if (!title && !imdbId) {
      throw AppError.badRequest(
        'Could not resolve a title. Pass ?title=… (and optionally ?year=…), or set TMDB_API_KEY.',
      );
    }

    // --- fan out across providers -----------------------------------------
    const langs = parseLanguages(q.lang ?? q.languages);
    const only = parseLanguages(q.only);

    const rankOpts: RankOptions = {
      preferredLanguages: langs.length ? langs : undefined,
      onlyLanguages: only.length ? only : undefined,
      minHeight: q.minHeight ? Number(q.minHeight) : undefined,
      maxHeight: q.maxHeight ? Number(q.maxHeight) : undefined,
      playableOnly: q.playable === 'true' || q.playable === '1',
      limit: q.limit ? Math.max(1, Math.min(Number(q.limit) || 25, 200)) : 25,
    };

    const resolveQuery: ResolveQuery = {
      type: mediaType,
      imdbId,
      tmdbId,
      title: title || imdbId || tmdbId || '',
      year,
      season,
      episode,
      languages: langs.length ? langs : undefined,
      signal: req.raw.destroyed ? undefined : undefined,
    };

    // The cache key must cover every parameter that changes the response,
    // otherwise `?expose=direct` would be served a cached body without it.
    const cacheKey = ck.streams(
      mediaType,
      imdbId ?? tmdbId ?? title,
      String(season ?? ''),
      String(episode ?? ''),
      [
        langs.join(',') || 'any',
        only.join(',') || 'any',
        rankOpts.limit ?? 0,
        rankOpts.minHeight ?? 0,
        rankOpts.maxHeight ?? 0,
        rankOpts.playableOnly ? 1 : 0,
        q.expose === 'direct' ? 1 : 0,
        q.resolveEmbeds !== 'false' ? 1 : 0,
        title,
        year ?? '',
        // Playback URLs bake in the origin, so a response cached under one
        // hostname must never be replayed to another.
        config.PUBLIC_URL ? '' : currentOrigin(),
      ].join('|'),
    );

    const payload = await cache.wrap<{
      streams: unknown[];
      diagnostics: unknown[];
    }>(
      cacheKey,
      Number(process.env.CACHE_TTL_STREAMS ?? 3600),
      async () => {
        const { streams: candidates, diagnostics } = await registry.collectStreams(
          resolveQuery,
          rankOpts,
        );

        const resolved = await mapLimit(candidates, 8, (c) =>
          buildResolved(c, {
            exposeDirect: q.expose === 'direct',
            resolveEmbeds: q.resolveEmbeds !== 'false',
          }),
        );

        return {
          streams: resolved.filter(
            (r) => rankOpts.playableOnly ? ['hls', 'dash', 'mp4'].includes(r.playback.type) : true,
          ),
          diagnostics: diagnostics as unknown[],
        };
      },
      { allowNull: false },
    );

    return reply.send({
      ok: true,
      query: {
        type: mediaType,
        id,
        imdbId,
        tmdbId,
        title: title || undefined,
        year,
        season,
        episode,
        languages: langs.length ? langs : undefined,
      },
      meta,
      count: payload?.streams.length ?? 0,
      streams: payload?.streams ?? [],
      ...(q.diagnostics === 'true' ? { diagnostics: payload?.diagnostics ?? [] } : {}),
    });
  });

  /**
   * POST /api/resolve
   * Resolve one URL (m3u8, mpd, mp4, embed page, magnet) into a playable stream.
   * Body: { url, headers?, kind?, title?, language?, quality? }
   */
  app.post('/api/resolve', async (req, reply) => {
    const body = (req.body ?? {}) as {
      url?: string;
      headers?: Record<string, string>;
      kind?: string;
      title?: string;
      language?: string;
      quality?: string;
    };

    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) throw AppError.badRequest('Body must include { url }');
    if (!/^(https?:|magnet:)/i.test(url)) {
      throw AppError.badRequest('url must be http(s) or magnet');
    }

    const candidate: StreamCandidate = {
      provider: 'manual',
      providerName: 'Manual',
      url,
      kind: (body.kind as StreamCandidate['kind']) ?? 'unknown',
      title: body.title,
      language: body.language,
      quality: body.quality,
      headers: body.headers ?? {},
    };

    const resolved = await buildResolved(candidate, {
      exposeDirect: true,
      resolveEmbeds: true,
    });

    return reply.send({ ok: true, stream: resolved });
  });

  /**
   * GET /api/extract?url=… — pull media URLs out of a page.
   * Handy for debugging a provider that only returns embed links.
   */
  app.get('/api/extract', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) throw AppError.badRequest('Query parameter "url" is required');
    if (!/^https?:/i.test(url)) throw AppError.badRequest('url must be http(s)');

    const { extractFromPage } = await import('../stream/extract.js');
    const found = await extractFromPage(url);
    return reply.send({ ok: true, url, count: found.length, found });
  });
}
