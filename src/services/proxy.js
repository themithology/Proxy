const { Readable } = require('stream');
const config = require('../config');
const { createSignedProxyUrl, verifyProxySignature } = require('../utils/crypto');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
 *   cookie — upstream session cookie forwarded by the proxy (session-gated hosts).
 */
function buildProxyStreamUrl(targetUrl, referer = '', origin = '', options = {}) {
  if (!targetUrl) return '';
  if (targetUrl.startsWith('/api/proxy?')) return targetUrl;
  const { mode = '', token = '', cookie = '', userAgent = '' } = options || {};
  const baseUrl = getProxyNodeBase('');
  const signed = createSignedProxyUrl(targetUrl, {
    referer,
    origin,
    baseUrl
  });
  if (!mode && !token && !cookie && !userAgent) return signed;
  const [path, query = ''] = signed.split('?');
  const params = new URLSearchParams(query);
  if (mode) params.set('mode', mode);
  if (token) params.set('token', token);
  if (cookie) params.set('cookie', cookie);
  if (userAgent) params.set('ua', userAgent);
  return `${path}?${params.toString()}`;
}

function inferMediaContentType(pathname = '', fallbackUrl = '') {
  const probe = `${pathname} ${fallbackUrl}`.toLowerCase();
  if (/\.mkv(?:$|[?#&\s])/.test(probe)) return 'video/x-matroska';
  if (/\.webm(?:$|[?#&\s])/.test(probe)) return 'video/webm';
  if (/\.mpd(?:$|[?#&\s])/.test(probe)) return 'application/dash+xml';
  if (/\.ts(?:$|[?#&\s])/.test(probe)) return 'video/mp2t';
  if (/\.avi(?:$|[?#&\s])/.test(probe)) return 'video/x-msvideo';
  if (/\.mov(?:$|[?#&\s])/.test(probe)) return 'video/quicktime';
  return 'video/mp4';
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

  const { referer = '', origin = '', reqBaseUrl = '', token = '', mode = 'manifest', cookie = '', userAgent = '' } = opts;
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
    const signed = createSignedProxyUrl(absoluteUrl, {
      referer,
      origin,
      baseUrl: proxyBase
    });
    if (!token && !cookie && !userAgent && mode === 'manifest') return signed;
    const [path, query = ''] = signed.split('?');
    const params = new URLSearchParams(query);
    if (mode) params.set('mode', mode);
    if (token) params.set('token', token);
    if (cookie) params.set('cookie', cookie);
    if (userAgent) params.set('ua', userAgent);
    return `${path}?${params.toString()}`;
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
 * Upstream statuses that mean "this request shape is not welcome" rather than
 * "this file does not exist": hotlink filters reject an unexpected Referer,
 * picky CDNs reject HEAD, a few hosts answer 416 to the first range probe.
 */
const PROXY_RETRY_STATUSES = new Set([
  400, 401, 403, 404, 405, 406, 410, 412, 415, 416, 429, 451, 500, 502, 503, 504
]);

/** 200 OK bodies that are hotlink/WAF gates rather than media or text/plain HLS. */
const GATE_BODY_CONTENT_TYPE = /^(?:text\/html|text\/xml|application\/(?:json|xml|xhtml\+xml))/i;

/**
 * Peek the first bytes of a non-Range 200 stream when Content-Type is
 * `text/plain` or `application/octet-stream` so disguised `#EXTM3U` HLS
 * playlists (StreamFlix, VaPlayer, Videasy, CastleTV, OneTouchTV, VixSrc) can
 * be rewritten instead of rejected or streamed raw, without buffering binary media.
 */
async function sniffDisguisedM3u8(body, maxManifestBytes = 2 * 1024 * 1024) {
  if (!body || typeof body.getReader !== 'function') {
    return { isPlaylist: false, body };
  }
  const reader = body.getReader();
  const headChunks = [];
  let headLen = 0;
  while (headLen < 32) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      headChunks.push(value);
      headLen += value.byteLength;
    }
  }
  if (headLen === 0) {
    try { reader.releaseLock(); } catch {}
    return { isPlaylist: false, body: new ReadableStream({ start(c) { c.close(); } }) };
  }
  const headBuf = new Uint8Array(Math.min(headLen, 64));
  let offset = 0;
  for (const ch of headChunks) {
    const slice = ch.subarray(0, Math.min(ch.byteLength, headBuf.byteLength - offset));
    headBuf.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= headBuf.byteLength) break;
  }
  const headText = new TextDecoder('utf-8', { fatal: false })
    .decode(headBuf)
    .replace(/^\uFEFF/, '')
    .trimStart();

  if (!headText.startsWith('#EXTM3U')) {
    let idx = 0;
    const rebuilt = new ReadableStream({
      pull(controller) {
        if (idx < headChunks.length) {
          controller.enqueue(headChunks[idx++]);
          return;
        }
        return reader.read().then(({ value, done }) => {
          if (done) controller.close();
          else controller.enqueue(value);
        });
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
    return { isPlaylist: false, body: rebuilt };
  }

  let totalBytes = headLen;
  while (totalBytes <= maxManifestBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      headChunks.push(value);
      totalBytes += value.byteLength;
    }
  }
  if (totalBytes > maxManifestBytes) {
    try { await reader.cancel(); } catch {}
    return { isPlaylist: false, body: null, tooLarge: true };
  }
  const full = new Uint8Array(totalBytes);
  let pos = 0;
  for (const ch of headChunks) {
    full.set(ch, pos);
    pos += ch.byteLength;
  }
  return {
    isPlaylist: true,
    text: new TextDecoder('utf-8', { fatal: false }).decode(full),
    body: null
  };
}

/**
 * Fetch the upstream stream, relaxing request details one at a time when the
 * CDN rejects the first attempt: the exact request first, then without the
 * hotlink headers (a wrong Referer is the most common instant 403), then
 * without the Range, then both, then HEAD retried as GET.
 *
 * Returns `{ resp, relaxed }`; a network-level failure leaves `resp` null.
 */
async function fetchUpstreamWithFallbacks(targetUrl, headers, method, { hasReferer = false, hasRange = false } = {}) {
  // A CDN that rejects the provider's Referer often accepts its own: try that
  // before giving up on the source entirely.
  let selfOrigin = '';
  try {
    selfOrigin = new URL(targetUrl).origin;
  } catch {}
  const canSelfRefer = /^https?:\/\//i.test(selfOrigin);

  const variants = [{ relax: [], method }];
  if (hasReferer) variants.push({ relax: ['hotlink'], method });
  if (hasReferer && canSelfRefer) variants.push({ relax: ['same-origin-referer'], method });
  if (hasRange) variants.push({ relax: ['range'], method });
  if (hasReferer && hasRange) variants.push({ relax: ['hotlink', 'range'], method });
  if (method === 'HEAD') variants.push({ relax: [], method: 'GET' });

  let last = null;
  let gateResp = null;
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    const attemptHeaders = { ...headers };
    if (variant.relax.includes('hotlink')) {
      delete attemptHeaders.Referer;
      delete attemptHeaders.Origin;
    }
    if (variant.relax.includes('same-origin-referer')) {
      attemptHeaders.Referer = `${selfOrigin}/`;
      attemptHeaders.Origin = selfOrigin;
    }
    if (variant.relax.includes('range')) delete attemptHeaders.Range;

    // The timeout only guards the CONNECT/headers phase: `AbortSignal.timeout`
    // would otherwise keep ticking and kill the streaming body 15 seconds into
    // playback (which looks exactly like "it played for a moment, then died").
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 15000);
    let resp = null;
    try {
      resp = await fetch(targetUrl, {
        method: variant.method,
        headers: attemptHeaders,
        redirect: 'follow',
        signal: controller.signal
      });
    } catch {
      clearTimeout(connectTimer);
      continue;
    }
    clearTimeout(connectTimer);

    if (resp.ok || resp.status === 206) {
      const respCt = (resp.headers.get('content-type') || '').toLowerCase();
      if (resp.status === 200 && GATE_BODY_CONTENT_TYPE.test(respCt) && i < variants.length - 1) {
        try {
          if (resp.body) await resp.body.cancel();
        } catch {
          try { resp.body?.destroy?.(); } catch {}
        }
        if (!gateResp) gateResp = resp;
        continue;
      }
      return { resp, relaxed: variant.relax.join('+') };
    }
    // Release the rejected body before retrying.
    try {
      if (resp.body) await resp.body.cancel();
    } catch {
      try { resp.body?.destroy?.(); } catch {}
    }
    last = resp;
    if (!PROXY_RETRY_STATUSES.has(resp.status)) break;
  }
  return { resp: gateResp || last, relaxed: null };
}

/** Bodies that are never a playable stream (hotlink gates, error pages, JSON). */
const NON_MEDIA_CONTENT_TYPE = /^(?:text\/html|text\/plain|text\/xml|application\/(?:json|xml|xhtml\+xml))/i;

/**
 * Express route handler for /api/proxy
 */
async function handleStreamProxy(req, res) {
  const targetUrl = req.query.url;
  const referer = req.query.referer || '';
  const origin = req.query.origin || '';
  const cookie = req.query.cookie || '';
  const ua = req.query.ua || '';
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
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Missing ?url= query parameter'
    });
  }

  // Verify HMAC signature if both exp and sig are provided
  if (exp && sig && !verifyProxySignature(targetUrl, referer, exp, sig)) {
    return res.status(403).json({ error: 'Invalid or expired proxy signature' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http:// and https:// URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Malformed target URL' });
  }

  // Only ever send Referer/Origin when the caller explicitly asked for them — a
  // synthesized Referer is exactly what trips release-host hotlink filters
  // (Pixeldrain-style 403s).
  const upstreamHeaders = {
    'User-Agent': ua || DEFAULT_USER_AGENT,
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

  // Forward custom safe headers (Authorization, X-Client-Token, X-Requested-With, …)
  // sent by movi-player without leaking infra/admin headers.
  const proxySkipX = /^x-(?:admin-key|forwarded-|real-ip|amzn-|vercel-|railway-)/i;
  for (const [key, val] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || (lower.startsWith('x-') && !proxySkipX.test(lower))) {
      const headerVal = Array.isArray(val) ? val.join(', ') : val;
      if (headerVal) upstreamHeaders[key] = headerVal;
    }
  }

  try {
    const requestedMethod = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const { resp: upstreamRes, relaxed } = await fetchUpstreamWithFallbacks(
      upstreamUrl,
      upstreamHeaders,
      requestedMethod,
      {
        hasReferer: !!(referer || origin),
        hasRange: !!(req.headers.range && requestedMethod === 'GET')
      }
    );

    if (!upstreamRes) {
      return res.status(502).json({
        error: 'Upstream stream host could not be reached',
        target: parsedUrl.hostname
      });
    }
    if (relaxed) res.setHeader('X-Proxy-Relaxed', relaxed);
    res.setHeader('X-Upstream-Status', String(upstreamRes.status));

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      return res.status(upstreamRes.status).json({
        error: `Upstream returned HTTP ${upstreamRes.status}`,
        target: parsedUrl.hostname
      });
    }

    const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
    const finalUrl = upstreamRes.url || parsedUrl.toString();
    const isM3u8 =
      contentType.includes('mpegurl') ||
      contentType.includes('m3u8') ||
      parsedUrl.pathname.endsWith('.m3u8');

    if (isM3u8 && req.method !== 'HEAD') {
      const text = await upstreamRes.text();
      if (text.trim().startsWith('#EXTM3U')) {
        // 'full' mode (or a JWT-stamped response) rewrites every variant AND
        // segment URI through the proxy with the host token attached.
        const rewritten = rewriteM3u8Manifest(text, finalUrl, {
          referer,
          origin,
          reqBaseUrl: '',
          mode,
          token,
          cookie,
          userAgent: ua
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=15');
        return res.status(200).send(rewritten);
      }
    }

    let responseBody = upstreamRes.body;
    const declaredLen = parseInt(upstreamRes.headers.get('content-length') || '0', 10);
    const canSniffM3u8 =
      !isM3u8 &&
      requestedMethod !== 'HEAD' &&
      upstreamRes.status === 200 &&
      !req.headers.range &&
      (!declaredLen || declaredLen <= 2 * 1024 * 1024) &&
      (contentType.startsWith('text/plain') ||
        !contentType ||
        contentType.includes('octet-stream') ||
        contentType.includes('binary/'));

    if (canSniffM3u8 && responseBody) {
      const sniffed = await sniffDisguisedM3u8(responseBody);
      if (sniffed.isPlaylist && sniffed.text) {
        const rewritten = rewriteM3u8Manifest(sniffed.text, finalUrl, {
          referer,
          origin,
          reqBaseUrl: '',
          mode,
          token,
          cookie,
          userAgent: ua
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=15');
        return res.status(200).send(rewritten);
      }
      responseBody = sniffed.body;
    }

    // A 200 that answers with an HTML/JSON body is a hotlink gate or an error
    // page; passing it through only shows up later as a mysterious decode
    // failure in the player.
    if (upstreamRes.ok && NON_MEDIA_CONTENT_TYPE.test(contentType)) {
      try {
        if (responseBody) await responseBody.cancel();
      } catch {
        try { responseBody?.destroy?.(); } catch {}
      }
      return res.status(502).json({
        error: 'Upstream answered with a non-media body instead of the stream',
        upstreamStatus: upstreamRes.status,
        upstreamType: contentType,
        target: parsedUrl.hostname
      });
    }

    // Forward streaming headers for MP4 / MKV / TS / fMP4 / DASH MPD
    res.status(upstreamRes.status);
    res.setHeader(
      'Content-Type',
      !contentType || contentType.includes('octet-stream')
        ? inferMediaContentType(parsedUrl.pathname, finalUrl)
        : contentType
    );
    res.setHeader('Accept-Ranges', 'bytes');

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentDisposition = upstreamRes.headers.get('content-disposition');
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

    // A HEAD answer stays body-less even when it was retried as a GET.
    if (requestedMethod === 'HEAD' || !responseBody) {
      return res.end();
    }

    Readable.fromWeb(responseBody).pipe(res);
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
