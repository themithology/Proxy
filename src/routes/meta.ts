import type { FastifyInstance } from 'fastify';
import { tmdb } from '../metadata/tmdb.js';
import { registry } from '../providers/registry.js';
import { parseId, parseLanguages, parseType } from '../util/ids.js';
import { AppError } from '../util/errors.js';
import type { MediaType } from '../providers/types.js';

/**
 * Metadata + discovery routes.
 *
 * TMDB is used when configured; otherwise we fall back to fanning the query
 * out across providers that implement search/catalog.
 */
export async function metaRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/search?q=matrix&type=movie&page=1
  app.get('/api/search', async (req, reply) => {
    const q = req.query as {
      q?: string;
      query?: string;
      type?: string;
      page?: string;
    };
    const query = (q.q ?? q.query ?? '').trim();
    if (!query) throw AppError.badRequest('Query parameter "q" is required');

    const type = q.type ? parseType(q.type) : undefined;
    const page = Math.max(1, Number(q.page ?? 1) || 1);

    if (tmdb.enabled) {
      const results = await tmdb.search(query, type, page);
      return reply.send({
        ok: true,
        source: 'tmdb',
        query,
        page,
        count: results.length,
        results,
      });
    }

    const results = await registry.search({ query, type, page });
    return reply.send({
      ok: true,
      source: 'providers',
      query,
      page,
      count: results.length,
      results,
    });
  });

  // GET /api/catalog/:type?category=trending&page=1
  app.get('/api/catalog/:type', async (req, reply) => {
    const { type } = req.params as { type: string };
    const q = req.query as { category?: string; page?: string };
    const mediaType = parseType(type);
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const category = q.category ?? 'trending';

    if (tmdb.enabled) {
      const kind =
        category === 'popular' || category === 'top_rated' ? category : 'trending';
      const results = await tmdb.list(kind, mediaType, page);
      return reply.send({
        ok: true,
        source: 'tmdb',
        type: mediaType,
        category,
        page,
        count: results.length,
        results,
      });
    }

    const results = await registry.catalog({
      type: mediaType,
      category: category === 'trending' ? undefined : category,
      page,
    });
    return reply.send({
      ok: true,
      source: 'providers',
      type: mediaType,
      category,
      page,
      count: results.length,
      results,
    });
  });

  // GET /api/meta/:type/:id  → tt0111161 | tmdb:278 | 278
  app.get('/api/meta/:type/:id', async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const mediaType = parseType(type);
    const parsed = parseId(id);

    if (!parsed.imdbId && !parsed.tmdbId && !parsed.native) {
      throw AppError.badRequest(
        'Id must be an IMDB id (tt0111161), a TMDB id (278 or tmdb:278) or prefixed (kitsu:123)',
      );
    }

    let media = null;
    if (parsed.imdbId) media = await tmdb.byImdb(parsed.imdbId);
    else if (parsed.tmdbId) media = await tmdb.byId(mediaType, Number(parsed.tmdbId));

    if (!media) {
      return reply.send({
        ok: true,
        source: tmdb.enabled ? 'tmdb' : 'none',
        id: parsed.imdbId ?? parsed.tmdbId ?? id,
        type: mediaType,
        title: null,
        note: tmdb.enabled
          ? 'No TMDB match for this id'
          : 'TMDB_API_KEY is not configured — set it to enable metadata lookups',
      });
    }

    return reply.send({ ok: true, source: 'tmdb', ...media });
  });

  // GET /api/meta/:type/:id/season/:n  → episode list
  app.get('/api/meta/:type/:id/season/:season', async (req, reply) => {
    const { type, id, season } = req.params as {
      type: string;
      id: string;
      season: string;
    };
    const mediaType = parseType(type);
    const parsed = parseId(id);
    const seasonNo = Number(season);

    if (!Number.isFinite(seasonNo) || seasonNo < 0) {
      throw AppError.badRequest('Season must be a non-negative number');
    }

    let tmdbId = parsed.tmdbId ? Number(parsed.tmdbId) : undefined;
    if (!tmdbId && parsed.imdbId) tmdbId = (await tmdb.byImdb(parsed.imdbId))?.tmdbId;
    if (!tmdbId) {
      return reply.code(404).send({
        ok: false,
        error: 'Episode listings require TMDB (set TMDB_API_KEY) or a TMDB id',
      });
    }

    const episodes = await tmdb.season(tmdbId, seasonNo);
    return reply.send({
      ok: true,
      type: mediaType,
      tmdbId,
      season: seasonNo,
      count: episodes.length,
      episodes,
    });
  });

  // GET /api/languages — the language codes the ranking understands
  app.get('/api/languages', async (_req, reply) => {
    const langs = registry.all.flatMap((p) => p.languages).filter((l) => l !== '*');
    return reply.send({
      ok: true,
      count: new Set(langs).size,
      languages: [...new Set(langs)].sort(),
    });
  });
}
