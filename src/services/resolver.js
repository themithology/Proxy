/**
 * Stream resolution waterfall (Node tier).
 *
 * The lineup is MKV-only now: every catalog server resolves through the
 * shared `goldmine.js` service (owner-hosted TMDB-Embed-API → direct
 * MKV/MP4/HLS sources, multi-audio dubs, per-provider sources). The legacy
 * HLS-only upstreams (CastleTV, NetMirror, VidStuck, HiCine) and the Node
 * ffmpeg remux tier (multitrack.js) were removed with the move to the
 * movi-player engine, which plays MKV/multi-audio in the browser directly.
 *
 * The waterfall machinery itself stays generic: it walks the shared server
 * catalog in priority order, records attempts for the dashboard, caches
 * payloads, applies the viewer's audio preference and honours per-source
 * pinning (`?source=<provider>`). The Cloudflare Worker keeps its own copy
 * of this flow (worker.js → resolveStreamWaterfall) using the same shared
 * services.
 */

const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { buildProxyStreamUrl } = require('./proxy');
const { telemetry } = require('./telemetry');
const serverCatalog = require('./serverCatalog');
const goldmine = require('./goldmine');
const languages = require('./languages');

const {
  normalizeLanguageCode
} = languages;

/**
 * Goldmine resolution with the Node tier's circuit breaker, config and
 * signed-proxy URL building. The shared service does the fetch + normalize.
 */
async function resolveGoldmineServerNode(metadata, options = {}) {
  const providerKey = 'goldmine:tmdb-embed-api';
  if (!circuitBreaker.isAvailable(providerKey)) {
    return { reason: 'circuit_open', diag: 'TMDB-Embed-API paused after repeated failures' };
  }
  const { onlySource = '', preferredAudio = '' } = options;
  try {
    const resolved = await goldmine.resolveGoldmineServer(metadata, {
      apiBase: config.goldmine.apiBase,
      timeoutMs: config.goldmine.timeoutMs,
      onlySource,
      preferredAudio,
      proxyStreams: config.goldmine.proxyStreams,
      // Streams whose host requires Referer/Origin/Cookie/UA get every nested URL
      // rewritten through the proxy ('full'); open hosts only get their
      // manifests/keys rewritten so segments stream straight from the CDN.
      proxyUrl: (url, referer, meta = {}) => {
        const needsFull = !!(referer || (meta && (meta.origin || meta.cookie || meta.userAgent)));
        return buildProxyStreamUrl(url, referer || '', (meta && meta.origin) || '', {
          ...(needsFull ? { mode: 'full' } : {}),
          ...((meta && meta.cookie) ? { cookie: meta.cookie } : {}),
          ...((meta && meta.userAgent) ? { userAgent: meta.userAgent } : {})
        });
      }
    });
    if (resolved && resolved.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      return resolved;
    }
    const reason = (resolved && resolved.reason) || 'goldmine_no_streams';
    // Only infrastructure failures trip the breaker — a title simply not
    // existing on the providers is not the API's fault.
    if (['goldmine_timeout', 'goldmine_unreachable', 'goldmine_http_error', 'goldmine_bad_response'].includes(reason)) {
      circuitBreaker.recordFailure(providerKey);
    }
    return { reason, diag: (resolved && resolved.diag) || 'no streams' };
  } catch (error) {
    circuitBreaker.recordFailure(providerKey);
    return { reason: 'goldmine_exception', diag: error instanceof Error ? error.message : String(error) };
  }
}

/** Apply the viewer's `?audio=`/remembered language to a resolved payload. */
function applyPreferredAudio(resolved, preferredAudio) {
  if (!resolved || !preferredAudio || !Array.isArray(resolved.audioTracks)) return resolved;
  const wanted = String(preferredAudio).trim().toLowerCase();
  const wantedLanguage = normalizeLanguageCode(wanted);
  const matchTrack = resolved.audioTracks.find((track) =>
    String(track.id || '').toLowerCase() === wanted ||
    (wantedLanguage !== 'und' && normalizeLanguageCode(track.lang) === wantedLanguage)
  );
  if (!matchTrack) return resolved;

  const audioTracks = resolved.audioTracks.map((track) => ({
    ...track,
    default: track.id === matchTrack.id
  }));
  return {
    ...resolved,
    audioTracks,
    streamUrl: matchTrack.streamUrl || resolved.streamUrl,
    rawUrl: matchTrack.rawUrl || resolved.rawUrl,
    activeAudioTrack: audioTracks.find((track) => track.id === matchTrack.id) || null
  };
}

/**
 * Resolve stream for a specific server ID, or waterfall across all production
 * servers until a working stream is found.
 *
 * @param {object} metadata
 * @param {string} requestedServerId Empty/unknown ids fall back to the
 *   catalog's top-priority server (see serverCatalog.resolveServerId).
 * @param {string} preferredAudio
 * @param {{ onlySource?: string }} [options] `onlySource` pins one source of
 *   a multi-source server (goldmine: a TMDB-Embed-API provider id such as
 *   `vidlink` or `dahmermovies`). A pinned request does not fall through to
 *   the other servers in the waterfall.
 */
async function resolveStreamForServer(metadata, requestedServerId = '', preferredAudio = '', options = {}) {
  // 1. Check whether the owner configured a custom stream override for this TMDB ID via /api/admin
  const customOverride = telemetry.getCustomOverride(
    metadata.type,
    metadata.tmdbId,
    metadata.season || 1,
    metadata.episode || 1
  );
  if (!options.onlySource && customOverride && customOverride.streamUrl) {
    const proxied = buildProxyStreamUrl(customOverride.streamUrl, '');
    return {
      server: 'custom',
      requestedServer: requestedServerId,
      format: customOverride.format || 'hls',
      rawUrl: customOverride.streamUrl,
      streamUrl: proxied,
      referer: '',
      headers: {},
      audioTracks: [
        {
          id: 'custom-orig',
          lang: 'en',
          label: customOverride.label || 'Custom Admin Source',
          type: 'sub',
          streamUrl: proxied,
          rawUrl: customOverride.streamUrl,
          default: true
        }
      ],
      qualities: [{ label: 'Auto', height: 0, url: proxied }],
      servers: serverCatalog.buildServerPayload(config.servers, null)
    };
  }

  // Catalog order is authoritative: the player renders the array in this order,
  // so a re-prioritised server must never linger in its old slot.
  const enabledServers = serverCatalog.sortByPriority(
    config.servers.filter((s) => s.enabled !== false)
  );
  const validServer = serverCatalog.resolveServerId(config.servers, requestedServerId);

  const onlySource = String(options.onlySource || '').toLowerCase() || '';
  // `fresh` (the player's Retry / manual server pick) skips the cache read:
  // provider URLs are signed and short-lived, so replaying a 15-minute-old
  // payload makes every retry fail the same way the first attempt did.
  const fresh = !!options.fresh;
  const cacheKey = `resolve:v5:${metadata.type}:${metadata.tmdbId}:s${metadata.season || 1}:e${metadata.episode || 1}:${validServer}${
    onlySource ? `:${onlySource}` : ''
  }`;
  const cached = fresh ? null : await cache.get(cacheKey);
  // Stream payloads are cached for 15 minutes, but the displayed server list is
  // not: rebuilding it here means a rebrand is visible immediately instead of
  // being replayed from cache.
  if (cached) {
    const payload = applyPreferredAudio(cached, preferredAudio);
    return {
      ...payload,
      servers: serverCatalog.buildServerPayload(config.servers, payload.server)
    };
  }

  // Build the ordered waterfall starting with the user's selected server, then
  // the live priority order. Reading it from config.servers (instead of a frozen
  // constant) is what makes an owner re-prioritisation via /api/admin/upstreams
  // show up in the player immediately.
  const prioritized = enabledServers
    .filter((s) => s.fallback !== false)
    .map((s) => s.id);
  const serverOrder = onlySource
    ? [validServer]
    : [validServer, ...prioritized.filter((id) => id !== validServer)];
  const serverAttempts = [];

  for (const srvId of serverOrder) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'goldmine') {
      resolved = await resolveGoldmineServerNode(metadata, { onlySource, preferredAudio });
    } else {
      resolved = { reason: 'unknown_server', diag: `no resolver for "${srvId}"` };
    }
    const latencyMs = Date.now() - t0;

    if (resolved && resolved.streamUrl) {
      telemetry.recordServerAttempt(srvId, true, latencyMs);
      const payload = {
        ...resolved,
        requestedServer: validServer,
        serverAttempts,
        activeAudioTrack:
          (resolved.audioTracks || []).find((t) => t.default) || (resolved.audioTracks || [])[0] || null,
        servers: serverCatalog.buildServerPayload(config.servers, resolved.server)
      };

      // Cache the canonical source selection; apply each caller's audio preference
      // on a clone so one viewer cannot change the next viewer's cached default.
      await cache.set(cacheKey, payload, 900);
      return applyPreferredAudio(payload, preferredAudio);
    } else {
      const reason =
        resolved && resolved.reason ? resolved.reason : 'no_stream';
      const diag = resolved && resolved.diag ? resolved.diag : null;
      telemetry.recordServerAttempt(srvId, false, latencyMs, reason);
      // Preserve the reason so API consumers can report why this server failed
      // instead of returning "All upstream servers failed" with no context.
      serverAttempts.push({ server: srvId, latencyMs, reason, diag });
    }
  }

  return {
    server: null,
    streamUrl: null,
    // The normalized id, so an error body never echoes a removed/legacy server.
    requestedServer: validServer,
    reason: 'all_servers_failed',
    serverAttempts,
    servers: serverCatalog.buildServerPayload(config.servers, null)
  };
}

module.exports = {
  resolveStreamForServer,
  resolveGoldmineServerNode,
  applyPreferredAudio,
  // Language helpers re-exported for existing call sites/tests.
  mapLanguageNameToCode: languages.mapLanguageNameToCode,
  parseAudioLanguageHints: languages.parseAudioLanguageHints
};
