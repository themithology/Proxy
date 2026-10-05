const { Readable } = require('stream');
const config = require('../config');
const { createSignedProxyUrl, verifyProxyRequest } = require('../utils/crypto');
const { inspectMediaTarget, duplicatedSignedParamsFromQuery } = require('../utils/proxySign');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Redirects are followed by hand so every hop can be re-checked for SSRF. */
const MAX_UPSTREAM_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Picks a proxy base URL from the configured Edge Proxy Pool (round-robin)
 * or defaults to the current server's own /api/proxy route.
 */
let poolCounter = 0;
function getProxyNodeBase(reqBaseUrl = '') {
  if (config.externalProxyPool && config.externalProxyPool.length > 0) {
    const picked = config.externalProxyPool[poolCounter % config.externalProxyPool.length];
    poolCounter = (poolCounter + 1) % 100000;
    return picked.replace(/\/+$/, '');
  }
  return reqBaseUrl || config.publicBaseUrl || '';
}

/**
 * Build a signed proxy URL for a target M3U8/MP4/MPD stream.
 *
 * options:
 *   mode  — 'manifest' (rewrite nested playlists/keys only), 'full' (rewrite every
 *           playlist AND segment URI — required for Origin/Referer + JWT gated
 *           hosts), or 'direct'.
 *   token — per-host JWT (from <host>/generate.php) stamped onto every rewritten
 *           manifest/segment URI by the proxy.
 *   cookie — upstream session cookie forwarded by the proxy (vidstuck.xyz).
 *
 * Every one of those parameters is part of the signature. They used to be
 * appended to the query string after signing, which let anyone holding a valid
 * signed URL add `&cookie=`/`&origin=` and use this server as an authenticated
 * request relay.
 */
function buildProxyStreamUrl(targetUrl, referer = '', origin = '', options = {}) {
  if (!targetUrl) return '';
  if (targetUrl.startsWith('/api/proxy?')) return targetUrl;
  const { mode = '', token = '', cookie = '', vidsrcStamp = '' } = options || {};
  const baseUrl = getProxyNodeBase('');
  return createSignedProxyUrl(targetUrl, {
    referer,
    origin,
    cookie,
    mode,
    token,
    vidsrcStamp,
    baseUrl
  });
}

/**
 * Fetch a per-host JWT from `<host>/generate.php` (token-gated CDN).
 * The endpoint answers either a bare text/plain JWT or `{"token": "..."}` JSON.
 * Tokens are IP bound with a ~4h TTL, so a short process-local cache is safe.
 */
const jwTokenCache = new Map();
async function fetchVidsrcHostToken(hostOrigin, referer = '') {
  if (!hostOrigin) return '';
  const cached = jwTokenCache.get(hostOrigin);
  if (cached && Date.now() < cached.exp) return cached.token;

  // The host origin comes from a caller-supplied URL, so guard it the same way
  // as the media target: no loopback/link-local/metadata token minting.
  const guarded = inspectMediaTarget(`${hostOrigin}/generate.php`, {
    allowPrivateTargets: config.proxyAllowPrivateTargets
  });
  if (!guarded.ok) return '';

  let token = '';
  try {
    const res = await fetch(`${hostOrigin}/generate.php`, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        ...(referer ? { Referer: referer } : {})
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const raw = (await res.text()).trim();
      if (raw.startsWith('{')) {
        token = JSON.parse(raw)?.token || '';
      } else if (!raw.startsWith('<')) {
        token = raw.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    token = '';
  }

  if (token) jwTokenCache.set(hostOrigin, { token, exp: Date.now() + 600000 });
  return token;
}

/**
 * Replace a `__TOKEN__` placeholder or append `?token=` to a target URL.
 */
function stampTokenOnUrl(target, token, force = false) {
  if (!target || !token) return target;
  const enc = encodeURIComponent(token);
  if (target.includes('__TOKEN__')) return target.replace(/__TOKEN__/g, enc);
  if (/[?&]token=/i.test(target)) return target;
  if (!force && !/\.m3u8|\.key|\.ts|\.m4s|\.mp4|\.mpd/i.test(target)) return target;
  return `${target}${target.includes('?') ? '&' : '?'}token=${enc}`;
}

/**
 * Rewrites an HLS (.m3u8) Master or Media playlist so that nested playlists,
 * audio tracks (#EXT-X-MEDIA), encryption keys (#EXT-X-KEY), fMP4 init maps (#EXT-X-MAP),
 * and media segments (.ts / .m4s) route through the stream proxy.
 */
function rewriteM3u8Manifest(m3u8Content, baseManifestUrl, refererOrOpts = '') {
  const opts =
    typeof refererOrOpts === 'string'
      ? { referer: refererOrOpts, origin: '', reqBaseUrl: '' }
      : refererOrOpts || {};

  const { referer = '', origin = '', reqBaseUrl = '', token = '', mode = 'manifest' } = opts;
  const lines = m3u8Content.split(/\r?\n/);

  const resolveAbsolute = (rawUri) => {
    try {
      return new URL(rawUri.trim(), baseManifestUrl).toString();
    } catch {
      return rawUri.trim();
    }
  };

  const wrapInProxy = (targetUrl, isSegmentOverride = false) => {
    let absoluteUrl = resolveAbsolute(targetUrl);
    // Per-host JWT gate: every rewritten playlist / key / segment
    // must carry the token or the CDN answers 403.
    if (token) absoluteUrl = stampTokenOnUrl(absoluteUrl, token, isSegmentOverride || true);
    const proxyBase = getProxyNodeBase(reqBaseUrl);
    // mode and token are signed here, not appended afterwards: an unsigned
    // `mode=full`/`token=` on a signed URL would let a caller redirect our
    // rewrite behavior or inject a token we never issued.
    return createSignedProxyUrl(absoluteUrl, {
      referer,
      origin,
      mode,
      token,
      baseUrl: proxyBase
    });
  };

  const rewrittenLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." attributes inside #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP, #EXT-X-I-FRAME-STREAM-INF
    if (trimmed.startsWith('#EXT-X-') && trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (_, uriValue) => {
        const proxied = wrapInProxy(uriValue);
        return `URI="${proxied}"`;
      });
    }

    if (trimmed.startsWith('#')) {
      return line;
    }

    // In 'full' mode even plain .ts/.m4s segments are rewritten (JWT/Referer
    // gated hosts reject bare segment requests).
    return wrapInProxy(trimmed, mode === 'full');
  });

  return rewrittenLines.join('\n');
}

/**
 * Follow redirects by hand so every hop is re-validated against the SSRF guard.
 *
 * `redirect: 'follow'` alone is not enough: an allowlisted public host can 302
 * to `http://169.254.169.254/latest/meta-data/` or `http://127.0.0.1:6379/`, and
 * the fetch would happily follow it. Returns `{ response, finalUrl, blocked }`.
 */
async function fetchWithGuardedRedirects(startUrl, init, options = {}) {
  const { allowPrivateTargets = false, maxRedirects = MAX_UPSTREAM_REDIRECTS } = options;
  let currentUrl = startUrl;
  let lastInspection = inspectMediaTarget(currentUrl, { allowPrivateTargets });
  if (!lastInspection.ok) {
    return { response: null, finalUrl: currentUrl, blocked: lastInspection.reason };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl, blocked: '' };
    }
    const location = response.headers.get('location');
    if (!location) {
      return { response, finalUrl: currentUrl, blocked: '' };
    }
    if (hop === maxRedirects) {
      return { response: null, finalUrl: currentUrl, blocked: 'too_many_redirects' };
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      return { response: null, finalUrl: currentUrl, blocked: 'malformed_redirect' };
    }
    lastInspection = inspectMediaTarget(nextUrl, { allowPrivateTargets });
    if (!lastInspection.ok) {
      // Do not leak the blocked destination back to the caller.
      return { response: null, finalUrl: currentUrl, blocked: lastInspection.reason };
    }
    // 303 (and historically 301/302) downgrade to GET and drop the body.
    currentUrl = nextUrl;
  }
  return { response: null, finalUrl: currentUrl, blocked: 'too_many_redirects' };
}

/**
 * Express route handler for /api/proxy
 */
async function handleStreamProxy(req, res) {
  const targetUrl = req.query.url;
  const referer = req.query.referer || '';
  const origin = req.query.origin || '';
  const cookie = req.query.cookie || '';
  const mode = req.query.mode || 'manifest';
  const passthroughToken = req.query.token || '';
  const vidsrcStamp = req.query.vidsrcStamp === '1';
  const exp = req.query.exp || '';
  const sig = req.query.sig || '';

  // Permissive CORS headers on every proxy response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Range, Content-Type, Authorization, X-Requested-With'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Missing ?url= query parameter'
    });
  }

  // Reject HTTP parameter pollution before anything else is evaluated.
  const duplicated = duplicatedSignedParamsFromQuery(req.query);
  if (duplicated.length > 0) {
    return res.status(400).json({ error: 'Duplicate proxy parameters are not allowed' });
  }

  // MANDATORY signature check. This used to run only when the caller supplied
  // both `exp` and `sig`, which meant omitting them skipped verification
  // entirely and exposed an unauthenticated open proxy. Every parameter that
  // influences the upstream request is covered by the v2 signature, so none of
  // them can be appended to a legitimately signed URL afterwards.
  const signatureValid = verifyProxyRequest(
    { url: targetUrl, referer, origin, cookie, mode, token: passthroughToken, vidsrcStamp, exp },
    sig,
    config.proxySecret
  );
  if (!signatureValid) {
    return res.status(403).json({ error: 'Invalid or expired proxy signature' });
  }

  // SSRF guard: http(s) only, no embedded credentials, and no
  // loopback/link-local/private/reserved destination.
  const targetInspection = inspectMediaTarget(targetUrl, {
    allowPrivateTargets: config.proxyAllowPrivateTargets
  });
  if (!targetInspection.ok) {
    const status = targetInspection.reason === 'malformed_url' ? 400 : 403;
    return res.status(status).json({ error: 'Target URL is not permitted' });
  }
  const parsedUrl = targetInspection.url;

  // Only ever send Referer/Origin when the caller explicitly asked for them — a
  // synthesized Referer is exactly what trips Pixeldrain's hotlink filter and the
  // VidStuck/Pixeldrain 403s.
  const upstreamHeaders = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  if (referer) upstreamHeaders.Referer = referer;
  if (origin) {
    upstreamHeaders.Origin = origin;
  } else if (referer) {
    try {
      upstreamHeaders.Origin = new URL(referer).origin;
    } catch {
      // ignore malformed referer
    }
  }

  if (cookie) {
    upstreamHeaders.Cookie = cookie;
  }

  // JWT gate: `vidsrcStamp=1` (or an __TOKEN__ placeholder) triggers a
  // <host>/generate.php lookup and stamps the outgoing URL + rewritten manifest.
  let token = passthroughToken;
  if (vidsrcStamp || targetUrl.includes('__TOKEN__')) {
    token = token || (await fetchVidsrcHostToken(parsedUrl.origin, referer));
  }

  let upstreamUrl = targetUrl;
  if (token) upstreamUrl = stampTokenOnUrl(targetUrl, token, true);

  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  try {
    const { response: upstreamRes, finalUrl, blocked } = await fetchWithGuardedRedirects(
      upstreamUrl,
      {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(15000)
      },
      { allowPrivateTargets: config.proxyAllowPrivateTargets }
    );

    if (blocked) {
      // Never echo the destination: that would turn the guard into a port/host
      // scanner for whoever is probing us.
      return res.status(403).json({ error: 'Upstream target is not permitted' });
    }

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      // The upstream hostname is deliberately not echoed back: it is provider
      // topology, and the caller does not need it to play media.
      return res.status(upstreamRes.status).json({
        error: `Upstream returned HTTP ${upstreamRes.status}`
      });
    }

    const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
    // `finalUrl` comes from the guarded redirect walk, so it is a URL we have
    // already re-validated for SSRF on the last hop.
    const resolvedFinalUrl = finalUrl || upstreamRes.url || parsedUrl.toString();
    const isM3u8 =
      contentType.includes('mpegurl') ||
      contentType.includes('m3u8') ||
      parsedUrl.pathname.endsWith('.m3u8');

    if (isM3u8 && req.method !== 'HEAD') {
      const text = await upstreamRes.text();
      if (text.trim().startsWith('#EXTM3U')) {
        // 'full' mode (or a JWT-stamped response) rewrites every variant AND
        // segment URI through the proxy with the host token attached.
        const rewritten = rewriteM3u8Manifest(text, resolvedFinalUrl, {
          referer,
          origin,
          reqBaseUrl: '',
          mode,
          token
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=15');
        return res.status(200).send(rewritten);
      }
    }

    // Forward streaming headers for MP4 / MKV / TS / fMP4 / DASH MPD
    res.status(upstreamRes.status);
    res.setHeader(
      'Content-Type',
      contentType.includes('octet-stream') && parsedUrl.pathname.endsWith('.mp4')
        ? 'video/mp4'
        : contentType || 'video/mp4'
    );
    res.setHeader('Accept-Ranges', 'bytes');

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    if (req.method === 'HEAD' || !upstreamRes.body) {
      return res.end();
    }

    Readable.fromWeb(upstreamRes.body).pipe(res);
  } catch (err) {
    return res.status(502).json({
      error: 'Proxy upstream fetch failed',
      message: err.message
    });
  }
}

module.exports = {
  buildProxyStreamUrl,
  rewriteM3u8Manifest,
  handleStreamProxy
};
