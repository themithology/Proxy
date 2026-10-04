const express = require('express');
const config = require('../config');
const { resolveTmdbMetadata } = require('../services/tmdb');
const { resolveSkipSegments } = require('../services/segments');
const { resolveSubtitles, fetchAndConvertSubtitleToVtt } = require('../services/subtitles');
const { resolveStreamForServer, resolveAndromedaServer, resolveUrsaServer } = require('../services/resolver');
const serverCatalog = require('../services/serverCatalog');
const { buildDubCatalog } = require('../services/dubCatalog');
const { handleStreamProxy } = require('../services/proxy');
const { serveMasterPlaylist, serveGeneratedFile } = require('../services/multitrack');
const { generateHandshakeToken } = require('../utils/crypto');
const { srtToVtt } = require('../utils/srtToVtt');
const { circuitBreaker } = require('../utils/cache');
const { telemetry } = require('../services/telemetry');

const router = express.Router();

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
    version: '2.0.0',
    metaImage: '/meta-image.gif',
    timestamp: new Date().toISOString(),
    servers: config.servers.map((s) => s.id),
    proxyPoolCount: config.externalProxyPool.length,
    multitrack: {
      enabled: config.multitrack.enabled,
      maxConcurrentJobs: config.multitrack.maxJobs
    },
    circuitBreaker: circuitBreaker.status()
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
 * Generates short-lived session token (like VidStuck's /backend/meow)
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
 * GET /api/subtitles/proxy
 * Proxies remote .srt.gz / .srt / .vtt subtitles (OpenSubtitles / Wyzie) and converts to WebVTT on the fly
 */
router.get('/subtitles/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing subtitle url');
  }
  try {
    const vtt = await fetchAndConvertSubtitleToVtt(targetUrl);
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
 * Input: TMDB ID (+ season & episode for TV, + optional server & audio track)
 * Output: Metadata, External IDs, Stream URL (proxied M3U8/MP4), Audio Tracks, Qualities, Subtitles, Skip Segments
 */
router.get('/resolve/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);
    const server = String(req.query.server || 'andromeda').toLowerCase();
    const audio = String(req.query.audio || '');

    const callerDomain = telemetry.extractDomain(req);
    if (telemetry.isDomainBlocked(callerDomain)) {
      return res.status(403).json({
        ok: false,
        error: `Domain "${callerDomain}" has been blocked by the embed owner.`
      });
    }

    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    telemetry.recordDomainActivity(req, 'resolve', metadata);

    const [streamData, subtitles, segmentsData] = await Promise.all([
      resolveStreamForServer(metadata, server, audio),
      resolveSubtitles(metadata),
      resolveSkipSegments(metadata)
    ]);

    if (!streamData || !streamData.streamUrl) {
      // Return structured failure detail so an API client can explain which
      // upstream failed instead of showing a generic error.
      const attempts = (streamData && streamData.serverAttempts) || [];
      const firstFailed = attempts.find((a) => a.server === server) || attempts[0];
      const reasonMap = {
        circuit_open: 'Server paused (too many recent failures).',
        meow_403: 'Upstream rejected the session token (Origin/Referer or session expired).',
        meow_404: 'Upstream endpoint not found (VidStuck domain may have changed).',
        meow_5xx: 'Upstream 5xx while issuing the session token.',
        meow_no_token: 'Upstream returned no session token.',
        servers_403: 'Upstream refused the server lookup (stale token).',
        servers_404: 'Upstream has no record for this server.',
        servers_5xx: 'Upstream 5xx on the server lookup.',
        servers_no_link: 'Upstream has no stream link for this title on this server.',
        aes_decrypt_failed: 'Stream link decryption failed (ZXC_AES_KEY rotated).',
        upstream_timeout: 'Timed out talking to the upstream provider.',
        upstream_exception: 'Unhandled error contacting the upstream provider.',
        ursa_metadata_missing:
          'TMDB metadata (title/year) could not be resolved, so this server had nothing to search for — no 4K tier was probed.',
        ursa_all_4k_sources_exhausted:
          'None of the four 4K tiers (4KHDHub, MoviesDrive 4K, HiCine 4K, DahmerMovies 4K) yielded a verified playable stream for this title.',
        ursa_upstream_timeout: 'The 4K cascade exceeded its resolve budget before any tier produced a verified stream.'
      };
      const humanReason = firstFailed
        ? reasonMap[firstFailed.reason] || firstFailed.reason
        : 'No working server in the waterfall.';
      const humanDiag = firstFailed && firstFailed.diag ? firstFailed.diag.message : null;
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
 * GET /api/dubs/:type/:tmdbId
 * TMDB-id keyed dub inventory. Every provider answer is identity-checked
 * against the TMDB title, so a same-name film (e.g. the 2023 "Fight Club")
 * can never be reported as a dub source for the 1999 film.
 *
 *   ?deep=1     also probe MoviesDrive / 4KHDHub / HiCine / Dahmer / HiAnime
 *   ?audio=hi   preferred audio used for the returned default track
 */
router.get('/dubs/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);
    const deep = /^(1|true|yes)$/i.test(String(req.query.deep || ''));
    const audio = String(req.query.audio || 'hi').toLowerCase();

    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    if (metadata.unresolvedTmdb) {
      return res.status(404).json({
        ok: false,
        error: `TMDB id ${tmdbId} could not be resolved; refusing to fall back to a name search.`
      });
    }

    const catalog = await buildDubCatalog(metadata, { deep, preferredAudio: audio });
    return res.json({
      ok: true,
      metadata: {
        tmdbId: metadata.tmdbId,
        type: metadata.type,
        title: metadata.title,
        originalTitle: metadata.originalTitle,
        releaseYear: metadata.releaseYear,
        imdbId: metadata.externalIds?.imdb_id || null,
        season: metadata.season,
        episode: metadata.episode
      },
      ...catalog
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/multitrack/master.m3u8
 * Lazily remuxes a signed, allowlisted direct media URL to fMP4 HLS audio renditions.
 */
router.get('/multitrack/master.m3u8', (req, res) => serveMasterPlaylist(req, res));

/**
 * GET /api/multitrack/file/:jobId/:filename
 * Serves generated playlists/segments only when their per-resource HMAC is valid.
 */
router.get('/multitrack/file/:jobId/:filename', (req, res) => serveGeneratedFile(req, res));

/**
 * GET /api/proxy
 * M3U8 Manifest Rewriter & TS/MP4/MPD Segment Stream Proxy with CORS & Range support
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
 * POST /api/admin/probe
 * Actively probes all 5 upstream stream providers to detect stale or dead domains
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
 * Hot-swaps upstream provider base URLs, AES keys, proxy pools, and server priority/enabled state
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

/**
 * GET /api/debug/andromeda/:type/:tmdbId
 * Owner-only diagnostic: walks the same Andromeda resolution path as /api/resolve
 * and returns structured failure details
 * instead of a generic 502. Hit this on the live worker to know whether the
 * upstream is dead, the AES key rotated, the catalog is missing this title, etc.
 */
router.get('/debug/andromeda/:type/:tmdbId', requireAdminAuth, async (req, res) => {
  const { type, tmdbId } = req.params;
  const season = parseInt(req.query.season || '1', 10);
  const episode = parseInt(req.query.episode || '1', 10);
  try {
    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    const result = await resolveAndromedaServer(metadata, 'andromeda', '');
    return res.json({
      ok: !!(result && result.streamUrl),
      metadata: {
        title: metadata.title,
        releaseYear: metadata.releaseYear,
        unresolvedTmdb: !!metadata.unresolvedTmdb,
        externalIds: metadata.externalIds
      },
      upstream: {
        castletvBase: config.upstreams.castletvBase,
        netmirrorBase: config.upstreams.netmirrorBase,
        vidstuckBase: config.upstreams.vidstuckBase,
        zxcBase: config.upstreams.zxcBase,
        aesKeySet: !!config.zxcAesKey,
        tmdbKeySet: !!config.tmdbApiKey
      },
      result
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/debug/ursa/:type/:tmdbId (and /api/debug/4k/:type/:tmdbId)
 * Owner-only diagnostic for Server 2 (Ursa 4K UHD Multi-Audio cascade:
 * 4KHDHub -> MoviesDrive 4K -> HiCine 4K -> DahmerMovies 4K).
 */
router.get(['/debug/ursa/:type/:tmdbId', '/debug/4k/:type/:tmdbId'], requireAdminAuth, async (req, res) => {
  const { type, tmdbId } = req.params;
  const season = parseInt(req.query.season || '1', 10);
  const episode = parseInt(req.query.episode || '1', 10);
  try {
    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    const result = await resolveUrsaServer(metadata, 'ursa', '');
    return res.json({
      ok: !!(result && result.streamUrl),
      metadata: {
        title: metadata.title,
        releaseYear: metadata.releaseYear,
        unresolvedTmdb: !!metadata.unresolvedTmdb,
        externalIds: metadata.externalIds
      },
      upstream: {
        fourkhdhubBase: config.upstreams.fourkhdhubBase,
        moviesdriveBase: config.upstreams.moviesdriveBase,
        hicineApiBase: config.upstreams.hicineApiBase,
        dahmerBase: config.upstreams.dahmerBase,
        vidsrcDataUrl: config.upstreams.vidsrcDataUrl
      },
      result
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
