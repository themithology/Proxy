'use strict';

/**
 * Hindi-first dub catalog.
 *
 * The Hindi tiers in this backend are name-search providers, so a plain title
 * lookup can (and did) return a different film that merely shares the name -
 * e.g. the 2023 Indian "Fight Club" instead of the 1999 film (TMDB 550).
 * Everything here is keyed on the TMDB id: metadata is resolved from the id,
 * each provider result is identity-checked against that metadata, and only
 * then are the available dub languages reported.
 *
 * Two modes:
 *   fast (default)  - CastleTV + Moviebox + NetMirror (the Hindi workhorses)
 *   deep (?deep=1)  - adds MoviesDrive, 4KHDHub, HiCine, DahmerMovies, HiAnime
 */

const config = require('../config');
const { telemetry } = require('./telemetry');
const {
  resolveCastletv,
  resolveMoviebox,
  resolveNetmirror,
  resolveMoviesdrive4k,
  resolve4khdhub,
  resolveHicineServer,
  resolveHicine4k,
  resolveDahmer4k,
  resolveHianimeServer
} = require('./resolver');

const ANIME_GENRE = /animation|anime|cartoon/i;

const PROVIDERS = [
  {
    id: 'castletv',
    label: 'CastleTV',
    identity: 'tmdb-verified',
    modes: ['fast', 'deep'],
    supports: () => true,
    resolve: (metadata, audio) => resolveCastletv(metadata, audio)
  },
  {
    id: 'moviebox',
    label: 'Moviebox',
    identity: 'tmdb-verified',
    modes: ['fast', 'deep'],
    supports: () => true,
    resolve: (metadata, audio) => resolveMoviebox(metadata, audio)
  },
  {
    id: 'netmirror',
    label: 'NetMirror (Netflix/Prime/Hotstar)',
    identity: 'tmdb-id',
    modes: ['fast', 'deep'],
    supports: () => true,
    resolve: (metadata, audio) => resolveNetmirror(metadata, audio)
  },
  {
    id: 'moviesdrive',
    label: 'MoviesDrive',
    identity: 'imdb-id',
    modes: ['deep'],
    supports: () => true,
    resolve: (metadata, audio) => resolveMoviesdrive4k(metadata, audio)
  },
  {
    id: '4khdhub',
    label: '4KHDHub',
    // Matches the title + release year parsed from the search page; IMDb ids
    // are not part of the 4KHDHub search path.
    identity: 'title-year',
    modes: ['deep'],
    supports: () => true,
    resolve: (metadata, audio) => resolve4khdhub(metadata, audio)
  },
  {
    id: 'hicine',
    label: 'HiCine',
    identity: 'title-hint',
    modes: ['deep'],
    supports: () => true,
    resolve: (metadata, audio) =>
      metadata.type === 'tv' ? resolveHicine4k(metadata, audio) : resolveHicineServer(metadata, audio)
  },
  {
    id: 'dahmer',
    label: 'DahmerMovies',
    // Open directory: matched by title (+year) path, not by an id.
    identity: 'title-year',
    modes: ['deep'],
    supports: () => true,
    resolve: (metadata, audio) => resolveDahmer4k(metadata, audio)
  },
  {
    id: 'hianime',
    label: 'HiAnime (Anime sub/dub)',
    identity: 'mal-id',
    modes: ['deep'],
    supports: (metadata) =>
      metadata.type === 'tv' || (metadata.genres || []).some((g) => ANIME_GENRE.test(g)),
    resolve: (metadata) => resolveHianimeServer(metadata)
  }
];

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true, label }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Does a resolved payload carry a Hindi audio track? */
function collectLanguages(resolved = {}) {
  const languages = new Map();
  const add = (code, label, extra = {}) => {
    const key = String(code || label || '').toLowerCase();
    if (!key) return;
    const existing = languages.get(key);
    if (existing) {
      existing.playable = existing.playable || Boolean(extra.playable);
      if (!existing.label && label) existing.label = label;
      return;
    }
    languages.set(key, {
      code: code || null,
      label: label || code || null,
      playable: Boolean(extra.playable),
      default: Boolean(extra.default)
    });
  };

  (resolved.audioTracks || []).forEach((track) => {
    const codes = Array.isArray(track.languages) && track.languages.length
      ? track.languages
      : track.lang
        ? [track.lang]
        : [];
    codes.forEach((code) => add(code, track.label || code, { playable: Boolean(track.streamUrl || track.rawUrl), default: track.default }));
  });

  (resolved.dubs || []).forEach((dub) => add(dub.code, dub.label, { playable: true }));
  return Array.from(languages.values());
}

function payloadStreamSummary(resolved) {
  if (!resolved || !resolved.streamUrl) return null;
  return {
    server: resolved.server,
    sourceName: resolved.sourceName,
    format: resolved.format,
    streamUrl: resolved.streamUrl,
    rawUrl: resolved.rawUrl,
    referer: resolved.referer || '',
    headers: resolved.headers || {},
    qualities: resolved.qualities || [],
    audioTracks: resolved.audioTracks || [],
    activeAudioTrack: resolved.activeAudioTrack || (resolved.audioTracks || []).find((t) => t.default) || null,
    backupUrls: resolved.backupUrls || []
  };
}

function describeProvider(provider, resolved, error) {
  if (!resolved) {
    return {
      id: provider.id,
      label: provider.label,
      ok: false,
      identity: { verified: false, method: provider.identity },
      reason: error ? String(error.message || error) : resolved === null ? 'no_identity_match_or_no_stream' : 'unknown'
    };
  }

  const languages = collectLanguages(resolved);
  const hindiTrack = languages.find((l) => l.code === 'hi' || /hindi/i.test(l.label || ''));
  const identityInfo = resolved.identity || null;
  return {
    id: provider.id,
    label: provider.label,
    ok: Boolean(resolved.streamUrl),
    identity: {
      verified: identityInfo ? Boolean(identityInfo.verified) : provider.identity === 'tmdb-id',
      method: identityInfo ? provider.identity : provider.identity,
      matchedTitle: identityInfo ? identityInfo.matchedTitle : resolved.matchedTitle || null,
      matchedYear: identityInfo ? identityInfo.matchedYear : resolved.matchedYear || null,
      upstreamId: identityInfo ? identityInfo.upstreamId : resolved.upstreamId || null,
      score: identityInfo ? identityInfo.score : null,
      reasons: identityInfo ? identityInfo.reasons : [],
      // Include the losing candidates so callers can see *why* a same-name
      // title (e.g. the 2023 "Fight Club") was rejected instead of trusting
      // the provider blindly.
      candidates: identityInfo ? (identityInfo.candidates || []).slice(0, 10) : [],
      rejectedCandidates: identityInfo ? (identityInfo.rejectedCandidates || []).slice(0, 10) : []
    },
    languages,
    hindi: Boolean(hindiTrack),
    sourceName: resolved.sourceName || provider.label,
    format: resolved.format || null,
    stream: payloadStreamSummary(resolved)
  };
}

/**
 * Build the dub inventory for a TMDB title.
 * `metadata` must be the resolved TMDB metadata (id-anchored).
 */
async function buildDubCatalog(metadata, options = {}) {
  const deep = Boolean(options.deep);
  const preferredAudio = options.preferredAudio || 'hi';
  const mode = deep ? 'deep' : 'fast';
  const perProviderTimeout = Number(options.perProviderTimeoutMs || (deep ? 20000 : 12000));

  const applicable = PROVIDERS.filter(
    (provider) => provider.modes.includes(mode) && provider.supports(metadata)
  );

  const results = await Promise.allSettled(
    applicable.map((provider) =>
      withTimeout(
        provider.resolve(metadata, preferredAudio).catch((error) => {
          telemetry.recordServerAttempt(`dubs:${provider.id}`, false, 0, error.message);
          throw error;
        }),
        perProviderTimeout,
        provider.id
      )
    )
  );

  const providers = results.map((entry, index) => {
    const provider = applicable[index];
    if (entry.status === 'rejected') return describeProvider(provider, null, entry.reason);
    if (entry.value && entry.value.__timeout) return describeProvider(provider, null, new Error('provider_timeout'));
    return describeProvider(provider, entry.value, null);
  });

  // Aggregate the union of dub languages across all identity-verified providers.
  const languageMap = new Map();
  providers.forEach((provider) => {
    (provider.languages || []).forEach((language) => {
      const key = language.code || language.label;
      if (!key) return;
      const existing = languageMap.get(key) || {
        code: language.code,
        label: language.label,
        playable: false,
        providers: []
      };
      existing.playable = existing.playable || language.playable;
      if (!existing.providers.includes(provider.id)) existing.providers.push(provider.id);
      if (!existing.label && language.label) existing.label = language.label;
      languageMap.set(key, existing);
    });
  });

  const dubs = Array.from(languageMap.values()).sort((a, b) => {
    const aHindi = a.code === 'hi' ? 0 : 1;
    const bHindi = b.code === 'hi' ? 0 : 1;
    if (aHindi !== bHindi) return aHindi - bHindi;
    return String(a.label).localeCompare(String(b.label));
  });

  const verifiedHindiProvider = providers.find(
    (provider) => provider.ok && provider.hindi && provider.identity.verified
  );
  const hindiProvider = providers.find((provider) => provider.ok && provider.hindi);
  const verifiedProvider = providers.find((provider) => provider.ok && provider.identity.verified);
  const fallbackProvider = providers.find((provider) => provider.ok);

  return {
    mode,
    tmdbId: metadata.tmdbId,
    type: metadata.type,
    title: metadata.title,
    year: metadata.releaseYear,
    hindi: Boolean(verifiedHindiProvider),
    hindiAnySource: Boolean(hindiProvider),
    dubs,
    providers,
    best: verifiedHindiProvider
      ? { providerId: verifiedHindiProvider.id, hindi: true, verified: true, stream: verifiedHindiProvider.stream }
      : hindiProvider
        ? {
            providerId: hindiProvider.id,
            hindi: true,
            verified: false,
            identityMethod: hindiProvider.identity.method,
            stream: hindiProvider.stream
          }
        : verifiedProvider
          ? { providerId: verifiedProvider.id, hindi: false, verified: true, stream: verifiedProvider.stream }
          : fallbackProvider
            ? { providerId: fallbackProvider.id, hindi: false, verified: false, stream: fallbackProvider.stream }
            : null,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Server "hindi": resolve the best stream that has a Hindi dub for the exact
 * TMDB title. Providers are tried in priority order and resolution stops at
 * the first identity-verified Hindi source; if none of them carries Hindi we
 * still return the identity-verified original-audio stream and flag it, so the
 * player never shows a different film.
 */
async function resolveHindiServer(metadata, preferredAudio = 'hi', options = {}) {
  const attempts = [];
  const configuredOrder = Array.isArray(config.upstreams.hindiProviders) && config.upstreams.hindiProviders.length
    ? config.upstreams.hindiProviders
    : null;
  const order = (options.providerIds ||
    configuredOrder ||
    ['castletv', 'moviebox', 'netmirror', 'moviesdrive', '4khdhub', 'dahmer', 'hicine', 'hianime'])
    .map((id) => PROVIDERS.find((provider) => provider.id === id))
    .filter((provider) => provider && provider.supports(metadata));

  let firstVerified = null;
  // A Hindi-carrying stream from a provider whose identity is only a title
  // hint. Kept as a last resort: a verified provider with Hindi is always
  // preferred, even if it answers later in the order.
  let hintHindi = null;

  for (const provider of order) {
    const startedAt = Date.now();
    let resolved = null;
    try {
      resolved = await withTimeout(
        provider.resolve(metadata, preferredAudio),
        provider.modes.includes('fast') ? 12000 : 20000,
        provider.id
      );
      if (resolved && resolved.__timeout) resolved = null;
    } catch (error) {
      attempts.push({ provider: provider.id, ok: false, reason: error.message, latencyMs: Date.now() - startedAt });
      continue;
    }

    if (!resolved || !resolved.streamUrl) {
      attempts.push({ provider: provider.id, ok: false, reason: 'no_stream', latencyMs: Date.now() - startedAt });
      continue;
    }

    const summary = describeProvider(provider, resolved);
    if (!firstVerified && summary.identity.verified) firstVerified = { provider, resolved, summary };
    attempts.push({
      provider: provider.id,
      ok: true,
      hindi: summary.hindi,
      identityMethod: summary.identity.method,
      identityVerified: summary.identity.verified,
      latencyMs: Date.now() - startedAt
    });

    if (summary.hindi && summary.identity.verified) {
      return {
        ...resolved,
        server: 'hindi',
        sourceName: resolved.sourceName || provider.label,
        hindiAvailable: true,
        hindiVerified: true,
        identityMethod: summary.identity.method,
        preferredAudio: 'hi',
        dubs: summary.languages,
        providerId: provider.id,
        attempts,
        identity: summary.identity
      };
    }
    if (summary.hindi && !hintHindi) hintHindi = { provider, resolved, summary };
  }

  if (hintHindi) {
    return {
      ...hintHindi.resolved,
      server: 'hindi',
      sourceName: hintHindi.resolved.sourceName || hintHindi.provider.label,
      hindiAvailable: true,
      hindiVerified: false,
      identityMethod: hintHindi.summary.identity.method,
      preferredAudio: 'hi',
      diagMessage:
        'Hindi was found on a provider that matches by title hints rather than a TMDB/IMDb id; verify the title before playback.',
      dubs: hintHindi.summary.languages,
      providerId: hintHindi.provider.id,
      attempts,
      identity: hintHindi.summary.identity
    };
  }

  if (firstVerified) {
    return {
      ...firstVerified.resolved,
      server: 'hindi',
      sourceName: firstVerified.resolved.sourceName || firstVerified.provider.label,
      hindiAvailable: false,
      hindiVerified: false,
      identityMethod: firstVerified.summary.identity.method,
      preferredAudio: 'hi',
      diagMessage: 'No identity-verified Hindi dub found; serving the verified original-audio stream.',
      dubs: firstVerified.summary.languages,
      providerId: firstVerified.provider.id,
      attempts,
      identity: firstVerified.summary.identity
    };
  }

  return { ok: false, reason: 'hindi_all_sources_failed', attempts };
}

function isHindiServerEnabled() {
  return !config.servers.find((server) => server.id === 'hindi')?.disabled;
}

module.exports = {
  buildDubCatalog,
  resolveHindiServer,
  collectLanguages,
  describeProvider,
  isHindiServerEnabled,
  PROVIDERS
};
