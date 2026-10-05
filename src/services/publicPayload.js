'use strict';

/**
 * Public-response sanitizer for resolve payloads.
 *
 * CommonJS and dependency-free so the Node backend and the Cloudflare Worker
 * apply the SAME policy — a field hidden by one runtime must not leak from the
 * other.
 *
 * Why a whitelist and not a blacklist: the resolver accumulates diagnostic
 * fields as upstreams are debugged (`diag.steps`, `rejectedCandidates`,
 * `matchedTitle`, `sourceName`, `provider`, `upstreamId`, `rawUrl`, ...). A
 * blacklist has to be updated every time one is added, and the failure mode of
 * forgetting is silent disclosure of upstream topology to every anonymous
 * caller. A whitelist fails closed: new internal fields are dropped until
 * someone deliberately publishes them.
 *
 * Scope note — what this does NOT do: for the Centaurus (HiCine) server the
 * playable `streamUrl` is intentionally the provider's direct CDN URL, not a
 * proxied one ("Root Cause D: direct CDN playback"). That is a deliberate
 * bandwidth/architecture decision in the resolver, so the sanitizer preserves
 * `streamUrl` exactly as resolved. Closing that requires changing where the
 * browser pulls media from, not filtering the JSON. See README "Security model".
 */

/** Top-level fields a public caller may see on the stream object. */
const PUBLIC_STREAM_FIELDS = [
  'server',
  'requestedServer',
  'format',
  'progressiveFormat',
  'streamUrl',
  'backupUrls',
  'qualities',
  'audioTracks',
  'activeAudioTrack',
  'progressiveAudioTrack',
  'serverAttempts',
  'reason',
  'servers'
];

/** A quality row: label/height/id and the (already signed or direct) play URL. */
const PUBLIC_QUALITY_FIELDS = ['id', 'label', 'height', 'url'];

/** An audio track. `rawUrl` is deliberately absent. */
const PUBLIC_AUDIO_TRACK_FIELDS = ['id', 'lang', 'label', 'type', 'streamUrl', 'default', 'audioIndex'];

/**
 * A waterfall attempt. The player only reads `.server` (to mark a server as
 * failed); `reason` stays as a coarse machine-readable code. `diag` — which
 * carries per-step upstream traces, provider hostnames and failure messages —
 * is dropped, and so is `latencyMs`, which fingerprints upstream performance.
 */
const PUBLIC_ATTEMPT_FIELDS = ['server', 'reason'];

/** Fields on the top-level resolve body. */
const PUBLIC_RESOLVE_FIELDS = ['ok', 'metadata', 'stream', 'subtitles', 'segments', 'servers'];

function pick(source, fields) {
  if (!source || typeof source !== 'object') return source === undefined ? undefined : source;
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function sanitizeAudioTrack(track) {
  if (!track || typeof track !== 'object') return track;
  return pick(track, PUBLIC_AUDIO_TRACK_FIELDS);
}

function sanitizeAudioTrackList(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map(sanitizeAudioTrack).filter((track) => track !== undefined && track !== null);
}

function sanitizeQualities(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .map((quality) => (quality && typeof quality === 'object' ? pick(quality, PUBLIC_QUALITY_FIELDS) : quality))
    .filter((quality) => quality !== undefined && quality !== null);
}

function sanitizeUrls(list) {
  if (!Array.isArray(list)) return undefined;
  return list.filter((url) => typeof url === 'string' && url.length > 0);
}

/**
 * Coarse, provider-neutral failure categories.
 *
 * The resolver's internal reason codes name upstream machinery: `meow_403` is
 * VidStuck's `/backend/meow` handshake, `centaurus_no_source` names a source,
 * `servers_no_link` is an upstream endpoint. Publishing them teaches a scraper
 * the whole provider map, which is what `GET /api/servers` deliberately never
 * does. Public callers get the category; the owner gets the code via `?detail=1`.
 */
const PUBLIC_REASON_FOR = (reason) => {
  const code = String(reason || '').toLowerCase();
  if (code === 'circuit_open') return 'temporarily_unavailable';
  if (/403/.test(code)) return 'upstream_rejected';
  if (/no_title/.test(code)) return 'metadata_unavailable';
  if (/timeout|exception|5xx|_5\d\d/.test(code)) return 'upstream_error';
  if (/404|no_source|no_link|no_token|no_stream|all_servers_failed/.test(code)) return 'no_source';
  return 'unavailable';
};

function sanitizeAttempts(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .map((attempt) => {
      if (!attempt || typeof attempt !== 'object') return attempt;
      const picked = pick(attempt, PUBLIC_ATTEMPT_FIELDS);
      // `diag` (per-step upstream traces) and `latencyMs` are dropped by the
      // whitelist; the reason is downgraded to a neutral category.
      if (picked.reason !== undefined) picked.reason = PUBLIC_REASON_FOR(picked.reason);
      return picked;
    })
    .filter((attempt) => attempt !== undefined && attempt !== null);
}

/**
 * Sanitize one resolved stream payload. Returns a NEW object; the input is
 * untouched so the resolver's cache and the admin diagnostics keep full detail.
 */
function sanitizeStreamPayload(stream) {
  if (!stream || typeof stream !== 'object') return stream;

  const out = pick(stream, PUBLIC_STREAM_FIELDS);

  if (Array.isArray(stream.backupUrls)) out.backupUrls = sanitizeUrls(stream.backupUrls);
  if (Array.isArray(stream.qualities)) out.qualities = sanitizeQualities(stream.qualities);
  if (Array.isArray(stream.audioTracks)) out.audioTracks = sanitizeAudioTrackList(stream.audioTracks);
  if (Array.isArray(stream.serverAttempts)) out.serverAttempts = sanitizeAttempts(stream.serverAttempts);
  if (out.reason !== undefined) out.reason = PUBLIC_REASON_FOR(out.reason);
  if (stream.activeAudioTrack) out.activeAudioTrack = sanitizeAudioTrack(stream.activeAudioTrack);
  if (stream.progressiveAudioTrack) out.progressiveAudioTrack = sanitizeAudioTrack(stream.progressiveAudioTrack);

  // The multitrack remux block, when present, is itself a stream-shaped payload
  // (and its audio tracks carry `rawUrl`), so it goes through the same filter.
  if (stream.multitrack && typeof stream.multitrack === 'object') {
    out.multitrack = sanitizeStreamPayload(stream.multitrack);
  }

  return out;
}

/**
 * Sanitize a whole `/api/resolve` response body.
 *
 * `detailed` bypasses filtering for an authenticated owner request
 * (`?detail=1` + admin key), which is how the operator keeps the upstream
 * diagnostics that used to be served to everyone.
 */
function sanitizeResolveBody(body, options = {}) {
  const { detailed = false } = options || {};
  if (detailed) return body;
  if (!body || typeof body !== 'object') return body;

  const out = pick(body, PUBLIC_RESOLVE_FIELDS);
  if (body.stream) out.stream = sanitizeStreamPayload(body.stream);
  // The failure path puts the attempt list at the top level as well.
  if (Array.isArray(body.serverAttempts)) out.serverAttempts = sanitizeAttempts(body.serverAttempts);
  if (typeof body.requestedServer === 'string') out.requestedServer = body.requestedServer;
  if (typeof body.failedReason === 'string') out.failedReason = PUBLIC_REASON_FOR(body.failedReason);
  // `explanation` / `serverExplanation` are human-readable strings built from the
  // resolver's reason map and they name upstream providers. Owner-only.
  return out;
}

/**
 * Deep-scan a serialized payload for fields that must never be public. Used by
 * the test suite as a regression tripwire: if a future resolver change adds a
 * raw upstream URL or provider name to the response, this fails loudly.
 */
function findLeaks(value, path = '$') {
  const LEAK_KEYS = [
    'rawUrl',
    'diag',
    'sourceName',
    'provider',
    'upstreamId',
    'activeUpstreamId',
    'centaurusSource',
    'centaurusSources',
    'rejectedCandidates',
    'altMatches',
    'matchedTitle',
    'matchedYear',
    'tokenType',
    'progressiveFallbackUrls',
    'latencyMs',
    'isHotlinkBlocked'
  ];
  const found = [];

  const walk = (node, currentPath) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (LEAK_KEYS.includes(key)) found.push(`${currentPath}.${key}`);
      walk(child, `${currentPath}.${key}`);
    }
  };

  walk(value, path);
  return found;
}

module.exports = {
  PUBLIC_REASON_FOR,
  PUBLIC_STREAM_FIELDS,
  PUBLIC_QUALITY_FIELDS,
  PUBLIC_AUDIO_TRACK_FIELDS,
  PUBLIC_ATTEMPT_FIELDS,
  PUBLIC_RESOLVE_FIELDS,
  sanitizeStreamPayload,
  sanitizeResolveBody,
  findLeaks
};
