const express = require('express');
const config = require('../config');
const { resolveTmdbMetadata } = require('../services/tmdb');
const { resolveSkipSegments } = require('../services/segments');
const { resolveSubtitles, fetchAndConvertSubtitleToVtt, isProxyableSubtitleUrl } = require('../services/subtitles');
const { resolveStreamForServer, resolveAndromedaServer, diagnoseCentaurus } = require('../services/resolver');
const serverCatalog = require('../services/serverCatalog');
const { handleStreamProxy } = require('../services/proxy');
const { serveMasterPlaylist, serveGeneratedFile } = require('../services/multitrack');
const { generateHandshakeToken } = require('../utils/crypto');
const { constantTimeEqual, inspectMediaTarget } = require('../utils/proxySign');
const { createRateLimiter, expressClientKey } = require('../utils/rateLimit');
const { sanitizeResolveBody } = require('../services/publicPayload');
const { srtToVtt } = require('../utils/srtToVtt');
const { circuitBreaker } = require('../utils/cache');
const { telemetry } = require('../services/telemetry');

const router = express.Router();

/* ------------------------------------------------------------------------ */
/* Rate limiting                                                             */
/* ------------------------------------------------------------------------ */

const MINUTE = 60 * 1000;
const limits = config.rateLimit;

const resolveLimiter = createRateLimiter({ name: 'resolve', limit: limits.resolvePerMinute, windowMs: MINUTE });
const proxyLimiter = createRateLimiter({ name: 'proxy', limit: limits.proxyPerMinute, windowMs: MINUTE });
const metadataLimiter = createRateLimiter({ name: 'metadata', limit: limits.metadataPerMinute, windowMs: MINUTE });
const handshakeLimiter = createRateLimiter({ name: 'handshake', limit: limits.handshakePerMinute, windowMs: MINUTE });
// Failed admin-key attempts, keyed by client. This is a brute-force oracle:
// the admin key guards live upstream/AES-key swaps and arbitrary stream
// overrides, so guessing must be slow.
const adminAuthLimiter = createRateLimiter({ name: 'admin-auth', limit: limits.adminAuthPerMinute, windowMs: MINUTE });

/**
 * Express middleware enforcing one of the named limiters per client.
 *
 * The key is the least-spoofable identity available (see utils/rateLimit.js):
 * `cf-connecting-ip` when behind Cloudflare, else the trusted-proxy-reduced
 * `req.ip`. Raw client-supplied X-Forwarded-For is only a last resort, and
 * `trust proxy` is pinned to a hop count in src/server.js so it cannot be
 * forged into a fresh bucket on every request.
 */
function rateLimit(limiter) {
  return (req, res, next) => {
    if (!limits.enabled) return next();
    const decision = limiter.check(
      expressClientKey(req, { trustForwardedHeaders: limits.trustForwardedHeaders })
    );
    for (const [header, value] of Object.entries(limiter.headers(decision))) {
      res.setHeader(header, value);
    }
    if (!decision.allowed) {
      return res.status(429).json({
        ok: false,
        error: 'Rate limit exceeded. Slow down.',
        scope: limiter.name,
        limit: decision.limit,
        retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
      });
    }
    return next();
  };
}

/* ------------------------------------------------------------------------ */
/* Admin authentication                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Middleware: authenticate owner admin requests.
 *
 * Accepted: `X-Admin-Key: <secret>` or `Authorization: Bearer <secret>`.
 *
 * The `?key=<secret>` query form was REMOVED. Query strings end up in proxy and
 * access logs, in `Referer` headers sent to third parties, and in browser
 * history — an admin secret in a URL leaks through every one of them. The /reze
 * dashboard already sends `X-Admin-Key` (public/reze.html), and still accepts
 * `/reze?key=…` to seed sessionStorage, so nothing in the owner UI regressed.
 *
 * Comparison is constant-time, and failures are rate-limited per client.
 */
function requireAdminAuth(req, res, next) {
  const provided =
    req.headers['x-admin-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (typeof provided === 'string' && provided && constantTimeEqual(provided, config.adminSecret)) {
    return next();
  }

  // Only FAILED attempts consume the budget. Counting successes too would lock
  // the owner out of /reze, which fires several admin calls per dashboard load.
  const throttle = adminAuthLimiter.check(
    expressClientKey(req, { trustForwardedHeaders: limits.trustForwardedHeaders })
  );
  if (!throttle.allowed) {
    return res.status(429).json({
      ok: false,
      error: 'Too many admin authentication attempts. Try again later.',
      retryAfterSeconds: Math.max(1, Math.ceil(throttle.retryAfterMs / 1000))
    });
  }
  return res.status(401).json({
    ok: false,
    error: 'Unauthorized: Invalid or missing Admin Key (X-Admin-Key)'
  });
}

/**
 * True when the caller is the authenticated owner and explicitly asked for
 * unfiltered internals (`?detail=1`). Diagnostics stay available to the owner
 * instead of being served to every anonymous caller.
 */
function wantsAdminDetail(req) {
  const requested = String(req.query.detail || '') === '1';
  if (!requested) return false;
  const provided =
    req.headers['x-admin-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return typeof provided === 'string' && !!provided && constantTimeEqual(provided, config.adminSecret);
}

/**
 * Internal error responses never echo `err.message`. Resolver errors routinely
 * contain upstream hostnames, endpoint paths and provider responses — exactly
 * the topology that should not be handed to an anonymous caller. The real
 * message is logged server-side and returned only to an authenticated owner.
 */
function internalError(req, res, err, context) {
  const message = err && err.message ? err.message : String(err);
  console.error(`[LOL Embed] ${context || 'request'} failed:`, message);
  return res.status(500).json({
    ok: false,
    error: 'Internal error while resolving this request.',
    ...(wantsAdminDetail(req) ? { detail: message } : {})
  });
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
 * GET /api/servers
 * Public, cacheable list of the player-visible servers (ids are what
 * `?server=` accepts). Never carries upstream/provider names.
 */
router.get('/servers', rateLimit(metadataLimiter), (req, res) => {
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
router.get('/catalog', rateLimit(metadataLimiter), async (req, res) => {
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
router.post('/handshake', rateLimit(handshakeLimiter), express.json(), (req, res) => {
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
router.get('/info/:type/:tmdbId', rateLimit(metadataLimiter), async (req, res) => {
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
    return internalError(req, res, err, 'request');
  }
});

/**
 * GET /api/segments/:type/:tmdbId
 * Returns Skip Intro / Recap / Next Episode timestamps using only TMDB ID
 */
router.get('/segments/:type/:tmdbId', rateLimit(metadataLimiter), async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);

    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    const segments = await resolveSkipSegments(metadata);
    return res.json({ ok: true, ...segments });
  } catch (err) {
    return internalError(req, res, err, 'request');
  }
});

/**
 * GET /api/subtitles/proxy?url=...&enc=<charset>&lang=<code>
 * Fetches a remote .srt / .vtt (.gz / .zip, any charset) from a subtitle host
 * and converts it to WebVTT on the fly. Not a general relay: only subtitle
 * hosts and the configured source mirrors are allowed.
 */
router.get('/subtitles/proxy', rateLimit(metadataLimiter), async (req, res) => {
  const targetUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!targetUrl) {
    return res.status(400).send('Missing subtitle url');
  }
  if (!isProxyableSubtitleUrl(targetUrl)) {
    return res.status(403).send('Subtitle host not allowed');
  }
  // SUBTITLE_PROXY_HOSTS accepts `*` (any host), so the allowlist alone can be
  // widened into a relay by configuration. The SSRF guard is unconditional.
  if (!inspectMediaTarget(targetUrl, { allowPrivateTargets: config.proxyAllowPrivateTargets }).ok) {
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
    // err.message can contain the upstream subtitle URL; keep it server-side.
    console.warn('[LOL Embed] subtitle proxy error:', err && err.message ? err.message : err);
    return res.status(502).send('Subtitle fetch failed');
  }
});

/**
 * POST /api/subtitles/convert
 * Converts uploaded .srt or .vtt text into normalized WebVTT (for local subtitle upload)
 */
router.post('/subtitles/convert', rateLimit(metadataLimiter), express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
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
router.get('/subtitles/:type/:tmdbId', rateLimit(metadataLimiter), async (req, res) => {
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
    return internalError(req, res, err, 'request');
  }
});

/**
 * GET /api/resolve/:type/:tmdbId
 * Full unified resolver endpoint:
 * Input: TMDB ID (+ season & episode for TV, + optional server & audio track)
 * Output: Metadata, External IDs, Stream URL (proxied M3U8/MP4), Audio Tracks, Qualities, Subtitles, Skip Segments
 */
router.get('/resolve/:type/:tmdbId', rateLimit(resolveLimiter), async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);
    const server = String(req.query.server || 'andromeda').toLowerCase();
    const audio = String(req.query.audio || '');
    // Multi-source servers (centaurus) accept `?source=` to pin one source;
    // pinned requests do not fall through to the other servers.
    const requestedSource = String(req.query.source || '').toLowerCase();
    const onlySource = /^[a-z]{3,24}$/.test(requestedSource) ? requestedSource : '';

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
      resolveStreamForServer(metadata, server, audio, onlySource ? { onlySource } : {}),
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
        upstream_timeout: 'Timed out talking to the upstream provider.',
        upstream_exception: 'Unhandled error contacting the upstream provider.',
        no_title: 'Title metadata could not be resolved (TMDB unreachable?), so upstreams were not queried.',
        centaurus_no_source: 'Centaurus (HiCine) found nothing for this title.',
      };
      const humanReason = firstFailed
        ? reasonMap[firstFailed.reason] || firstFailed.reason
        : 'No working server in the waterfall.';
      const humanDiag = firstFailed && firstFailed.diag ? firstFailed.diag.message : null;
      telemetry.recordResolveOutcome(req, metadata, false, {
        server: firstFailed ? firstFailed.server : server,
        reason: firstFailed ? firstFailed.reason : (streamData && streamData.reason) || 'no_stream',
        season,
        episode
      });
      // The detailed failure report (per-upstream diag traces, latencies, the
      // human-readable upstream explanation) is owner-only. Anonymous callers
      // get the coarse machine-readable reason, which is all the player needs to
      // mark a server as failed and fall through.
      const detailed = wantsAdminDetail(req);
      const failureBody = {
        ok: false,
        error: 'Unable to resolve stream from upstream providers for this title.',
        requestedServer: (streamData && streamData.requestedServer) || server,
        failedReason: firstFailed ? firstFailed.reason : null,
        serverAttempts: attempts,
        metadata,
        subtitles,
        segments: segmentsData.segments,
        servers: (streamData && streamData.servers) || config.servers
      };
      // Provider-naming explanations are owner-only (see publicPayload.js).
      if (detailed) {
        failureBody.explanation = humanReason;
        failureBody.serverExplanation = humanDiag;
      } else {
        console.warn(
          `[LOL Embed] resolve failed for ${type}/${tmdbId} s${season}e${episode}: ${humanReason}` +
          (humanDiag ? ` | ${humanDiag}` : '')
        );
      }
      return res.status(502).json(sanitizeResolveBody(failureBody, { detailed }));
    }

    telemetry.recordResolveOutcome(req, metadata, true, { server: streamData.server || server, season, episode });
    // Whitelist filter: drops rawUrl, diag, sourceName/provider, upstreamId and
    // the rest of the resolver's internal bookkeeping from the public body.
    return res.json(
      sanitizeResolveBody(
        {
          ok: true,
          metadata,
          stream: streamData,
          subtitles,
          segments: segmentsData.segments,
          servers: streamData.servers
        },
        { detailed: wantsAdminDetail(req) }
      )
    );
  } catch (err) {
    return internalError(req, res, err, 'request');
  }
});

/**
 * GET /api/admin/centaurus/diagnose/:type/:tmdbId
 * Runs the Centaurus source (HiCine) and reports what it produced — including
 * per-step diag strings (search hit, quality rows, unroll/probe outcome).
 * Answers "is Centaurus working for this title?" with data instead of logs.
 * Protected by the admin key like the other /api/admin routes.
 */
router.get('/admin/centaurus/diagnose/:type/:tmdbId', requireAdminAuth, async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const season = parseInt(req.query.season || '1', 10);
    const episode = parseInt(req.query.episode || '1', 10);
    const metadata = await resolveTmdbMetadata(type, tmdbId, season, episode);
    if (!metadata) return res.status(404).json({ ok: false, error: 'Metadata not found' });
    const report = await diagnoseCentaurus(metadata);
    return res.json(report);
  } catch (err) {
    return internalError(req, res, err, 'request');
  }
});

/**
 * GET /api/multitrack/master.m3u8
 * Lazily remuxes a signed, allowlisted direct media URL to fMP4 HLS audio renditions.
 */
router.get('/multitrack/master.m3u8', rateLimit(proxyLimiter), (req, res) => serveMasterPlaylist(req, res));

/**
 * GET /api/multitrack/file/:jobId/:filename
 * Serves generated playlists/segments only when their per-resource HMAC is valid.
 */
router.get('/multitrack/file/:jobId/:filename', rateLimit(proxyLimiter), (req, res) => serveGeneratedFile(req, res));

/**
 * GET /api/proxy
 * M3U8 Manifest Rewriter & TS/MP4/MPD Segment Stream Proxy with CORS & Range support
 */
router.get('/proxy', rateLimit(proxyLimiter), (req, res, next) => {
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
    runtime: { startedAt: telemetry.startedAt, version: '2.0.0' }
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
    return internalError(req, res, err, 'request');
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
        tmdbKeySet: !!config.tmdbApiKey
      },
      result
    });
  } catch (err) {
    return internalError(req, res, err, 'request');
  }
});

// Exposed so the verification suite can reset limiter state and assert the
// throttling contract deterministically. Not part of the HTTP surface.
router.rateLimiters = {
  resolve: resolveLimiter,
  proxy: proxyLimiter,
  metadata: metadataLimiter,
  handshake: handshakeLimiter,
  adminAuth: adminAuthLimiter
};

module.exports = router;
