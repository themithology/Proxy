const express = require('express');
const config = require('../config');
const { resolveTmdbMetadata } = require('../services/tmdb');
const { resolveSkipSegments } = require('../services/segments');
const { resolveSubtitles, fetchAndConvertSubtitleToVtt, isProxyableSubtitleUrl } = require('../services/subtitles');
const { resolveStreamForServer } = require('../services/resolver');
const goldmine = require('../services/goldmine');
const serverCatalog = require('../services/serverCatalog');
const { handleStreamProxy } = require('../services/proxy');
const { generateHandshakeToken } = require('../utils/crypto');
const { srtToVtt } = require('../utils/srtToVtt');
const { circuitBreaker } = require('../utils/cache');
const { telemetry } = require('../services/telemetry');

const router = express.Router();

/** The catalog's top-priority live server — what an unpinned resolve uses. */
function defaultServerId() {
  const [top] = serverCatalog.waterfallEnabledServers(config.servers);
  return top ? top.id : 'goldmine';
}

/**
 * Middleware: Authenticate Owner Admin Requests via `X-Admin-Key` header or `?key=` query
 */
function requireAdminAuth(req, res, next) {
  const provided =
    req.headers['x-admin-key'] ||
    req.query.key ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!provided || provided !== config.adminSecret) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: Invalid or missing Admin Key (X-Admin-Key)'
    });
  }
  return next();
}

/**
 * GET /api/health
 * Health check & upstream circuit-breaker status
 */
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    brand: 'LOL Embed',
    service: 'lol-embed-backend',
    runtime: 'node',
    version: '3.0.0',
    metaImage: '/meta-image.gif',
    timestamp: new Date().toISOString(),
    servers: config.servers.map((s) => s.id),
    goldmineApiBase: config.goldmine.apiBase,
    proxyPoolCount: config.externalProxyPool.length,
    circuitBreaker: circuitBreaker.status()
  });
});

/**
 * GET /api/servers
 * Public, cacheable list of the player-visible servers (ids are what
 * `?server=` accepts). Never carries upstream/provider names.
 */
router.get('/servers', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    ok: true,
    servers: serverCatalog
      .listableServers(config.servers)
      .map((s) => ({ id: s.id, name: s.name, badge: s.badge, priority: s.priority }))
  });
});

/**
 * GET /api/catalog
 * Returns a small list of popular TMDB titles for API clients and smoke tests
 */
router.get('/catalog', async (req, res) => {
  const defaultCatalog = [
    {
      tmdbId: 94605,
      type: 'tv',
      title: 'Arcane',
      releaseYear: 2021,
      genres: ['Animation', 'Sci-Fi & Fantasy', 'Action & Adventure'],
      imdbId: 'tt11126994',
      seasonsCount: 2
    },
    {
      tmdbId: 1396,
      type: 'tv',
      title: 'Breaking Bad',
      releaseYear: 2008,
      genres: ['Drama', 'Crime'],
      imdbId: 'tt0903747',
      seasonsCount: 5
    },
    {
      tmdbId: 95479,
      type: 'tv',
      title: 'Jujutsu Kaisen',
      releaseYear: 2020,
      genres: ['Animation', 'Action & Adventure', 'Sci-Fi & Fantasy'],
      imdbId: 'tt12343534',
      seasonsCount: 2
    },
    {
      tmdbId: 693134,
      type: 'movie',
      title: 'Dune: Part Two',
      releaseYear: 2024,
      genres: ['Science Fiction', 'Adventure'],
      imdbId: 'tt15239678',
      seasonsCount: 0
    },
    {
      tmdbId: 872585,
      type: 'movie',
      title: 'Oppenheimer',
      releaseYear: 2023,
      genres: ['Drama', 'History'],
      imdbId: 'tt15398776',
      seasonsCount: 0
    },
    {
      tmdbId: 157336,
      type: 'movie',
      title: 'Interstellar',
      releaseYear: 2014,
      genres: ['Adventure', 'Drama', 'Science Fiction'],
      imdbId: 'tt0816692',
      seasonsCount: 0
    }
  ];

  res.json({
    ok: true,
    items: defaultCatalog
  });
});

/**
 * POST /api/handshake
 * Generates a short-lived, HMAC-signed session token
 */
router.post('/handshake', express.json(), (req, res) => {
  const { type = 'movie', id = '', season = 1, episode = 1 } = req.body || {};
  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing TMDB id' });
  }
  const token = generateHandshakeToken({
    type,
    id: String(id),
    season: Number(season),
    episode: Number(episode)
  });
  return res.json({
    ok: true,
    token,
    expiresIn: config.tokenTtlSeconds
  });
});

/**
 * GET /api/info/:type/:tmdbId
 * Resolves TMDB ID -> Unified Metadata + External IDs (IMDb, TVDB, MAL) + Episodes
 */
router.get('/info/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);

    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    const segmentsData = await resolveSkipSegments(metadata);

    return res.json({
      ok: true,
      metadata,
      segments: segmentsData.segments,
      // Player-facing list: opt-in cascades stay resolvable but are not rendered.
      servers: serverCatalog.listableServers(config.servers)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/segments/:type/:tmdbId
 * Returns Skip Intro / Recap / Next Episode timestamps using only TMDB ID
 */
router.get('/segments/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);

    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    const segments = await resolveSkipSegments(metadata);
    return res.json({ ok: true, ...segments });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/subtitles/proxy?url=...&enc=<charset>&lang=<code>
 * Fetches a remote .srt / .vtt (.gz / .zip, any charset) from a subtitle host
 * and converts it to WebVTT on the fly. Not a general relay: only subtitle
 * hosts and the configured source mirrors are allowed.
 */
router.get('/subtitles/proxy', async (req, res) => {
  const targetUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!targetUrl) {
    return res.status(400).send('Missing subtitle url');
  }
  if (!isProxyableSubtitleUrl(targetUrl)) {
    return res.status(403).send('Subtitle host not allowed');
  }
  try {
    const vtt = await fetchAndConvertSubtitleToVtt(targetUrl, {
      encoding: typeof req.query.enc === 'string' ? req.query.enc : '',
      lang: typeof req.query.lang === 'string' ? req.query.lang : ''
    });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=7200');
    return res.send(vtt);
  } catch (err) {
    return res.status(502).send(`Subtitle proxy error: ${err.message}`);
  }
});

/**
 * POST /api/subtitles/convert
 * Converts uploaded .srt or .vtt text into normalized WebVTT (for local subtitle upload)
 */
router.post('/subtitles/convert', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : '';
  const vtt = srtToVtt(raw);
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.send(vtt);
});

/**
 * GET /api/subtitles/:type/:tmdbId
 * Returns multi-language subtitle tracks using only TMDB ID
 */
router.get('/subtitles/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);

    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    const tracks = await resolveSubtitles(metadata);
    return res.json({
      ok: true,
      tmdbId: metadata.tmdbId,
      imdbId: metadata.externalIds?.imdb_id || null,
      tracks
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/resolve/:type/:tmdbId
 * Full unified resolver endpoint:
 * Input: TMDB ID (+ season & episode for TV, + optional server, source & audio track)
 * Output: Metadata, External IDs, Stream URL (direct MKV/MP4 or proxied M3U8),
 *         playback engine hint, Audio Tracks (dub languages), Qualities,
 *         Sources (providers), Subtitles, Skip Segments
 */
router.get('/resolve/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);
    const server = String(req.query.server || '').toLowerCase() || defaultServerId();
    const audio = String(req.query.audio || '');
    // Multi-source servers (goldmine) accept `?source=` to pin one provider
    // (`vidlink`, `dahmermovies`, `4khdhub`, …); pinned requests do not fall
    // through to other servers.
    const requestedSource = String(req.query.source || '').toLowerCase();
    const onlySource = /^[a-z0-9]{3,24}$/.test(requestedSource) ? requestedSource : '';
    // `?fresh=1` / `?nocache=1` re-resolves live instead of replaying the cached
    // payload (the player sends it on Retry — provider URLs expire quickly).
    const freshParam = String(req.query.fresh || req.query.nocache || '').toLowerCase();
    const fresh = freshParam === '1' || freshParam === 'true' || freshParam === 'yes';
    const streamOptions = { ...(onlySource ? { onlySource } : {}), fresh };

    const callerDomain = telemetry.extractDomain(req);
    if (telemetry.isDomainBlocked(callerDomain)) {
      return res.status(403).json({
        ok: false,
        error: `Domain "${callerDomain}" has been blocked by the embed owner.`
      });
    }

    const withSoftTimeout = (promise, ms, fallback) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
      ]);

    const normalizedType = String(type || '').toLowerCase() === 'movie' ? 'movie' : 'tv';
    const trimmedId = String(tmdbId || '').trim();
    const isNumericTmdb = /^\d+$/.test(trimmedId);

    let metadata;
    let streamData;
    let subtitles;
    let segmentsData;

    if (isNumericTmdb) {
      const stubMeta = { type: normalizedType, tmdbId: trimmedId, season, episode };
      const metadataPromise = resolveTmdbMetadata(type, trimmedId, season, episode);
      const streamPromise = resolveStreamForServer(stubMeta, server, audio, streamOptions);
      const subtitlesPromise = metadataPromise.then((m) => resolveSubtitles(m)).catch(() => []);
      const segmentsPromise = metadataPromise.then((m) => resolveSkipSegments(m)).catch(() => ({ segments: [] }));

      [metadata, streamData] = await Promise.all([metadataPromise, streamPromise]);
      [subtitles, segmentsData] = await Promise.all([
        withSoftTimeout(subtitlesPromise, 2500, []),
        withSoftTimeout(segmentsPromise, 2500, { segments: [] })
      ]);
    } else {
      metadata = await resolveTmdbMetadata(type, trimmedId, season, episode);
      const subtitlesPromise = resolveSubtitles(metadata).catch(() => []);
      const segmentsPromise = resolveSkipSegments(metadata).catch(() => ({ segments: [] }));
      streamData = await resolveStreamForServer(metadata, server, audio, streamOptions);
      [subtitles, segmentsData] = await Promise.all([
        withSoftTimeout(subtitlesPromise, 2500, []),
        withSoftTimeout(segmentsPromise, 2500, { segments: [] })
      ]);
    }

    telemetry.recordDomainActivity(req, 'resolve', metadata);

    if (!streamData || !streamData.streamUrl) {
      // Return structured failure detail so an API client can explain which
      // upstream failed instead of showing a generic error.
      const attempts = (streamData && streamData.serverAttempts) || [];
      const firstFailed = attempts.find((a) => a.server === server) || attempts[0];
      const reasonMap = {
        circuit_open: 'Server paused (too many recent failures).',
        goldmine_unreachable: 'The TMDB-Embed-API instance could not be reached (is the Render service awake?).',
        goldmine_timeout: 'The TMDB-Embed-API took too long to answer (cold start or slow providers).',
        goldmine_http_error: 'The TMDB-Embed-API answered with an HTTP error.',
        goldmine_bad_response: 'The TMDB-Embed-API answered with an unexpected payload.',
        goldmine_no_streams: 'No provider on the TMDB-Embed-API has this title right now.',
        goldmine_source_empty: 'The pinned source (provider) returned no playable streams for this title.',
        goldmine_source_unknown: 'Unknown provider id — check /api/providers on the TMDB-Embed-API.',
        goldmine_source_disabled: 'That provider is disabled on the TMDB-Embed-API instance.',
        goldmine_exception: 'Unhandled error contacting the TMDB-Embed-API.',
        goldmine_no_title: 'Title metadata could not be resolved (TMDB unreachable?), so upstreams were not queried.',
        unknown_server: 'The requested server id has no resolver.',
        upstream_timeout: 'Timed out talking to the upstream provider.',
        upstream_exception: 'Unhandled error contacting the upstream provider.',
        no_title: 'Title metadata could not be resolved (TMDB unreachable?), so upstreams were not queried.'
      };
      const humanReason = firstFailed
        ? reasonMap[firstFailed.reason] || firstFailed.reason
        : 'No working server in the waterfall.';
      const humanDiag = firstFailed && firstFailed.diag ? firstFailed.diag.message || firstFailed.diag : null;
      telemetry.recordResolveOutcome(req, metadata, false, {
        server: firstFailed ? firstFailed.server : server,
        reason: firstFailed ? firstFailed.reason : (streamData && streamData.reason) || 'no_stream',
        season,
        episode
      });
      return res.status(502).json({
        ok: false,
        error: 'Unable to resolve stream from upstream providers for this title.',
        explanation: humanReason,
        serverExplanation: humanDiag,
        requestedServer: (streamData && streamData.requestedServer) || server,
        failedReason: firstFailed ? firstFailed.reason : null,
        serverAttempts: attempts,
        metadata,
        subtitles,
        segments: segmentsData.segments,
        servers: (streamData && streamData.servers) || config.servers
      });
    }

    telemetry.recordResolveOutcome(req, metadata, true, { server: streamData.server || server, season, episode });
    return res.json({
      ok: true,
      metadata,
      stream: streamData,
      subtitles,
      segments: segmentsData.segments,
      servers: streamData.servers
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/admin/goldmine/diagnose/:type/:tmdbId
 * Runs the Goldmine source (TMDB-Embed-API) and reports what it produced —
 * per-provider stream counts, timings, qualities and dub languages. Answers
 * "is the TMDB-Embed-API working for this title?" with data instead of logs.
 * Protected by the admin key like the other /api/admin routes.
 */
router.get('/admin/goldmine/diagnose/:type/:tmdbId', requireAdminAuth, async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);
    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    if (!metadata) return res.status(404).json({ ok: false, error: 'Metadata not found' });
    const report = await goldmine.diagnoseGoldmine(metadata, {
      apiBase: config.goldmine.apiBase,
      timeoutMs: config.goldmine.timeoutMs
    });
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/proxy
 * M3U8 Manifest Rewriter & MKV/MP4/TS Segment Stream Proxy with CORS & Range support
 */
router.get('/proxy', (req, res, next) => {
  telemetry.recordDomainActivity(req, 'proxy');
  return handleStreamProxy(req, res, next);
});

// ============================================================================
// OWNER ADMIN PANEL API ROUTES (Protected by X-Admin-Key / ADMIN_SECRET)
// ============================================================================

/**
 * GET /api/admin/overview
 * Returns domain statistics, upstream health & staleness status, and active overrides
 */
router.get('/admin/overview', requireAdminAuth, (req, res) => {
  res.json({
    ok: true,
    ...telemetry.getDashboardSnapshot()
  });
});

/**
 * GET /api/admin/stats
 * Dashboard feed (same shape as the Worker's): usage statistics + live catalog.
 */
router.get('/admin/stats', requireAdminAuth, (req, res) => {
  const limit = parseInt(req.query.limit || '25', 10);
  const snapshot = telemetry.getDashboardSnapshot();
  res.json({
    ok: true,
    stats: telemetry.getStatsSnapshot(Number.isFinite(limit) ? limit : 25),
    catalog: config.servers.map((s) => ({ id: s.id, name: s.name, badge: s.badge, priority: s.priority, enabled: s.enabled !== false })),
    servers: snapshot.servers,
    runtime: { startedAt: telemetry.startedAt, version: '3.0.0' }
  });
});

/**
 * POST /api/admin/stats/reset
 */
router.post('/admin/stats/reset', requireAdminAuth, (req, res) => {
  telemetry.resetStats();
  res.json({ ok: true, stats: telemetry.getStatsSnapshot() });
});

/**
 * POST /api/admin/probe
 * Actively probes the Goldmine upstream (TMDB-Embed-API health + providers)
 */
router.post('/admin/probe', requireAdminAuth, async (req, res) => {
  try {
    const probeResults = await telemetry.runLiveHealthProbes();
    return res.json({
      ok: true,
      probeResults,
      snapshot: telemetry.getDashboardSnapshot()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/admin/upstreams
 * Hot-swaps the Goldmine API base URL, proxy pools, and server priority/enabled state
 */
router.post('/admin/upstreams', requireAdminAuth, express.json(), (req, res) => {
  telemetry.updateUpstreamsAndServers(req.body || {});
  return res.json({
    ok: true,
    message: 'Upstream URLs and server configuration updated live.',
    snapshot: telemetry.getDashboardSnapshot()
  });
});

/**
 * POST /api/admin/domains/block
 * Blocks or unblocks an external website domain from embedding the player
 */
router.post('/admin/domains/block', requireAdminAuth, express.json(), (req, res) => {
  const { domain, blocked = true } = req.body || {};
  if (!domain) {
    return res.status(400).json({ ok: false, error: 'Missing domain' });
  }
  telemetry.setDomainBlocked(domain, Boolean(blocked));
  return res.json({
    ok: true,
    domain,
    blocked: Boolean(blocked),
    snapshot: telemetry.getDashboardSnapshot()
  });
});

/**
 * POST /api/admin/overrides
 * Adds or updates a custom direct stream URL override for any TMDB movie or TV episode
 */
router.post('/admin/overrides', requireAdminAuth, express.json(), (req, res) => {
  const { type = 'movie', tmdbId, season = 1, episode = 1, streamUrl, format = 'hls', label } =
    req.body || {};
  if (!tmdbId || !streamUrl) {
    return res.status(400).json({ ok: false, error: 'tmdbId and streamUrl are required' });
  }
  const entry = telemetry.setCustomOverride({
    type,
    tmdbId,
    season,
    episode,
    streamUrl,
    format,
    label
  });
  return res.json({
    ok: true,
    override: entry,
    snapshot: telemetry.getDashboardSnapshot()
  });
});

/**
 * DELETE /api/admin/overrides/:key
 * Removes a custom TMDB stream override
 */
router.delete('/admin/overrides/:key', requireAdminAuth, (req, res) => {
  telemetry.removeCustomOverride(req.params.key);
  return res.json({
    ok: true,
    snapshot: telemetry.getDashboardSnapshot()
  });
});

module.exports = router;
