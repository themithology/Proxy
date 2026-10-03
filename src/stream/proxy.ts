import { Readable } from 'node:stream';
import { fetch, type Dispatcher } from 'undici';
import { config } from '../config.js';
import { logFor } from '../logger.js';
import { cache } from '../store/cache.js';
import { signToken, type ProxyTokenPayload } from '../util/crypto.js';
import { hostOf, hostMatches, resolveUrl } from '../util/url.js';
import { currentOrigin } from '../util/origin.js';
import { AppError } from '../util/errors.js';
import { getDispatcher } from '../util/http.js';
import { rewriteM3u8, parseM3u8, type UriContext } from './m3u8.js';
import { rewriteMpd, parseMpd } from './mpd.js';
import { toVtt, detectFormat, decodeText } from './subtitles.js';
import type { StreamKind } from '../providers/types.js';

const log = logFor('proxy');

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Build a signed URL on our own origin that will fetch `upstream` later.
 * `headers` are the per-upstream headers (Referer/Origin/Cookie) needed to
 * fetch it — they travel inside the HMAC-signed token, never in the clear.
 */
export function proxyUrl(
  upstream: string,
  headers: Record<string, string> = {},
  kind: ProxyTokenPayload['k'] = 'other',
  ttlMs = DEFAULT_TTL_MS,
): string {
  const token = signToken({ u: upstream, h: normaliseHeaders(headers), e: Date.now() + ttlMs, k: kind });

  // Derive the origin per request when PUBLIC_URL was left unset.
  const origin = config.PUBLIC_URL ? config.publicOrigin : currentOrigin();

  switch (kind) {
    case 'manifest':
      return `${origin}/proxy/manifest?token=${token}`;
    case 'segment':
    case 'key':
      return `${origin}/proxy/segment?token=${token}`;
    case 'subtitle':
      return `${origin}/proxy/subtitle?token=${token}`;
    default:
      return `${origin}/proxy/media?token=${token}`;
  }
}

/**
 * Proxy URL that keeps DASH `$Number$` / `$Time$` / `$Bandwidth$` /
 * `$RepresentationID$` placeholders visible in the query string.
 *
 * The player substitutes these before requesting, so they cannot live inside
 * the signed token (which is opaque to it). Our route re-injects them from
 * `_n` / `_t` / `_b` / `_r` when the request comes back.
 */
export function proxyUrlWithTemplate(
  upstream: string,
  headers: Record<string, string> = {},
  kind: ProxyTokenPayload['k'] = 'other',
  ttlMs = DEFAULT_TTL_MS,
): string {
  const base = proxyUrl(upstream, headers, kind, ttlMs);

  const params: string[] = [];
  if (upstream.includes('$Number$')) params.push('_n=$Number$');
  if (upstream.includes('$Time$')) params.push('_t=$Time$');
  if (upstream.includes('$Bandwidth$')) params.push('_b=$Bandwidth$');
  if (upstream.includes('$RepresentationID$')) params.push('_r=$RepresentationID$');

  if (!params.length) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${params.join('&')}`;
}

/** Drop hop-by-hop and already-default headers we should not forward. */
function normaliseHeaders(h: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!v) continue;
    if (blocked.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** Guard against the server being used as an open proxy for internal targets. */
export function assertUpstreamAllowed(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw AppError.badRequest('Invalid upstream URL');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw AppError.badRequest('Only http/https upstreams are supported');
  }

  const allow = config.allowedOrigins;
  if (allow.length) {
    const host = hostOf(url);
    if (!allow.some((p) => hostMatches(host, p))) {
      throw AppError.forbidden(`Upstream host "${host}" is not allow-listed`);
    }
    return;
  }

  // With no allow-list, still refuse obviously-internal targets.
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    /^169\.254\.\d+\.\d+$/.test(host);

  if (blocked && !config.isProd) {
    // In dev we still allow it so local fixture servers can be tested.
    return;
  }
  if (blocked) throw AppError.forbidden('Refusing to proxy internal addresses');
}

// ---------------------------------------------------------------------------
// Upstream fetch (with Range passthrough)
// ---------------------------------------------------------------------------

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
}

const PASS_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-range',
  'etag',
  'last-modified',
  'accept-ranges',
  'cache-control',
  'expires',
  'date',
  'age',
  'vary',
]);

function pickResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) {
    if (PASS_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Headers we send upstream for a proxied fetch. */
function upstreamRequestHeaders(
  extra: Record<string, string>,
  range?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': config.UPSTREAM_USER_AGENT,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    ...normaliseHeaders(extra),
  };
  if (range) h.range = range;
  if (config.UPSTREAM_REFERER && !h.referer && !h.Referer) h.referer = config.UPSTREAM_REFERER;
  return h;
}

function dispatcherFor(): Dispatcher {
  return getDispatcher();
}

/**
 * Stream an upstream resource, forwarding Range so seeking works.
 * Throws AppError on failure.
 */
export async function fetchUpstream(
  url: string,
  headers: Record<string, string>,
  range?: string,
  timeout = 30_000,
): Promise<UpstreamResult> {
  assertUpstreamAllowed(url);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: upstreamRequestHeaders(headers, range),
      redirect: 'follow',
      dispatcher: dispatcherFor(),
      signal: ac.signal,
    });

    if (!res.ok && res.status >= 400) {
      const body = await res.text().catch(() => '');
      throw new AppError(
        res.status === 404 ? 404 : 502,
        `Upstream returned ${res.status}`,
        'upstream_error',
        body.slice(0, 200),
      );
    }

    if (!res.body) {
      throw AppError.upstream('Upstream returned an empty body');
    }

    return {
      status: res.status,
      headers: pickResponseHeaders(res.headers),
      stream: Readable.fromWeb(res.body as never) as Readable,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const name = (err as Error)?.name;
    if (name === 'AbortError') throw AppError.timeout();
    throw AppError.upstream((err as Error)?.message ?? 'Upstream fetch failed');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

export interface ManifestResult {
  body: string;
  contentType: string;
  kind: 'hls' | 'dash' | 'unknown';
  /** Diagnostics surfaced in the API for debugging. */
  info?: Record<string, unknown>;
}

const MANIFEST_CACHE_MAX = 512 * 1024;

/**
 * Fetch an upstream manifest and rewrite every URI to point back at us.
 *
 * VOD manifests are cached (they never change); live ones are not.
 */
export async function fetchManifest(
  url: string,
  headers: Record<string, string>,
): Promise<ManifestResult> {
  assertUpstreamAllowed(url);

  const cacheKey = `manifest:v1:${url.slice(0, 200)}:${JSON.stringify(
    normaliseHeaders(headers),
  ).slice(0, 200)}`;

  const cachedBody = await cache.get<string>(cacheKey);
  const raw = cachedBody ?? (await downloadText(url, headers));

  const isDash =
    raw.trimStart().startsWith('<') || /\.mpd(\?|$)/i.test(url) || raw.includes('<MPD');
  const isHls = raw.trimStart().startsWith('#EXTM3U') || /\.m3u8(\?|$)/i.test(url);

  if (!isHls && !isDash) {
    return { body: raw, contentType: 'text/plain', kind: 'unknown' };
  }

  const rewrite = (absolute: string, ctx: UriContext) => {
    const k: ProxyTokenPayload['k'] =
      ctx === 'variant' || ctx === 'media' || ctx === 'subtitle' ? 'manifest' : 'segment';
    return proxyUrl(absolute, headers, k);
  };

  let body: string;
  let contentType: string;
  const info: Record<string, unknown> = {};

  if (isHls) {
    const parsed = parseM3u8(raw, url);
    body = rewriteM3u8(raw, url, rewrite);
    contentType = 'application/vnd.apple.mpegurl';

    info.isMaster = parsed.isMaster;
    info.variants = parsed.variants.length;
    info.renditions = parsed.renditions.length;
    info.subtitleTracks = parsed.subtitlePlaylists.length;
    info.encrypted = parsed.encrypted;
    info.fmp4 = parsed.usesFmp4;
    info.segments = parsed.segmentUris.length;

    // Cache VOD manifests only; live ones change on every request.
    const isLive = !parsed.endlist && !parsed.isMaster;
    if (!isLive && raw.length < MANIFEST_CACHE_MAX) {
      await cache.set(cacheKey, raw, config.CACHE_TTL_PROXY);
    }
  } else {
    body = rewriteMpd(raw, url, (absolute) =>
      proxyUrlWithTemplate(absolute, headers, 'segment'),
    );
    contentType = 'application/dash+xml';

    const parsed = parseMpd(raw, url);
    info.representations = parsed.representations.length;
    info.subtitleReps = parsed.subtitleReps.length;
    info.durationSeconds = parsed.durationSeconds;
    info.isLive = parsed.isLive;

    if (!parsed.isLive && raw.length < MANIFEST_CACHE_MAX) {
      await cache.set(cacheKey, raw, config.CACHE_TTL_PROXY);
    }
  }

  return { body, contentType, kind: isHls ? 'hls' : 'dash', info };
}

async function downloadText(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: upstreamRequestHeaders(headers),
      redirect: 'follow',
      dispatcher: dispatcherFor(),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new AppError(res.status === 404 ? 404 : 502, `Upstream returned ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') ?? '';
    const charset = /charset=([\w-]+)/i.exec(ct)?.[1];
    return decodeText(buf, charset);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as Error)?.name === 'AbortError') throw AppError.timeout();
    throw AppError.upstream((err as Error)?.message ?? 'Manifest download failed');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export async function fetchSubtitle(
  url: string,
  headers: Record<string, string>,
): Promise<{ body: string; contentType: string }> {
  const raw = await downloadText(url, headers);
  const format = detectFormat(raw, url);
  const body = toVtt(raw, format);
  return { body, contentType: 'text/vtt; charset=utf-8' };
}

// ---------------------------------------------------------------------------
// Kind sniffing
// ---------------------------------------------------------------------------

/**
 * Determine what a candidate URL actually is. We trust the URL extension and
 * content-type, and fall back to sniffing the first bytes.
 */
export async function sniffKind(
  url: string,
  headers: Record<string, string>,
  declared?: StreamKind,
): Promise<{ kind: StreamKind; contentType?: string }> {
  if (declared && declared !== 'unknown') return { kind: declared };

  if (/\.m3u8(\?|$)/i.test(url)) return { kind: 'hls' };
  if (/\.mpd(\?|$)/i.test(url)) return { kind: 'dash' };
  if (/magnet:|\.torrent(\?|$)/i.test(url)) return { kind: 'torrent' };
  if (/\.(mp4|m4v|webm|mkv|avi|mov|ts)(\?|$)/i.test(url)) return { kind: 'mp4' };

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...upstreamRequestHeaders(headers), range: 'bytes=0-1023' },
      redirect: 'follow',
      dispatcher: dispatcherFor(),
      signal: ac.signal,
    });
    clearTimeout(timer);

    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('mpegurl') || ct.includes('m3u8')) return { kind: 'hls', contentType: ct };
    if (ct.includes('dash')) return { kind: 'dash', contentType: ct };
    if (ct.startsWith('video/') || ct.includes('mp4') || ct.includes('octet-stream')) {
      return { kind: 'mp4', contentType: ct };
    }
    if (ct.startsWith('text/html')) return { kind: 'embed', contentType: ct };

    // Last resort: peek at the payload.
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trimStart();
    if (head.startsWith('#EXTM3U')) return { kind: 'hls', contentType: ct };
    if (head.startsWith('<MPD') || head.startsWith('<?xml')) return { kind: 'dash', contentType: ct };
    return { kind: 'unknown', contentType: ct };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Resolve a possibly-relative upstream URL against a page URL. */
export const absoluteUpstream = (pageUrl: string, ref: string) => resolveUrl(pageUrl, ref);
