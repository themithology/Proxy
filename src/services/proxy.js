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
 * Build a signed proxy URL for a target M3U8/MP4/MPD stream
 */
function buildProxyStreamUrl(targetUrl, referer = '', origin = '') {
  if (!targetUrl) return '';
  if (targetUrl.startsWith('/api/proxy?')) return targetUrl;
  const baseUrl = getProxyNodeBase('');
  return createSignedProxyUrl(targetUrl, {
    referer,
    origin,
    baseUrl
  });
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

  const { referer = '', origin = '', reqBaseUrl = '' } = opts;
  const lines = m3u8Content.split(/\r?\n/);

  const resolveAbsolute = (rawUri) => {
    try {
      return new URL(rawUri.trim(), baseManifestUrl).toString();
    } catch {
      return rawUri.trim();
    }
  };

  const wrapInProxy = (targetUrl) => {
    const absoluteUrl = resolveAbsolute(targetUrl);
    const proxyBase = getProxyNodeBase(reqBaseUrl);
    return createSignedProxyUrl(absoluteUrl, {
      referer,
      origin,
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

    return wrapInProxy(trimmed);
  });

  return rewrittenLines.join('\n');
}

/**
 * Express route handler for /api/proxy
 */
async function handleStreamProxy(req, res) {
  const targetUrl = req.query.url;
  const referer = req.query.referer || '';
  const origin = req.query.origin || '';
  const cookie = req.query.cookie || '';
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

  const upstreamHeaders = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  if (referer) {
    upstreamHeaders.Referer = referer;
  } else {
    upstreamHeaders.Referer = `${parsedUrl.origin}/`;
  }

  if (origin) {
    upstreamHeaders.Origin = origin;
  } else if (referer) {
    try {
      upstreamHeaders.Origin = new URL(referer).origin;
    } catch {
      upstreamHeaders.Origin = parsedUrl.origin;
    }
  }

  if (cookie) {
    upstreamHeaders.Cookie = cookie;
  }

  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  try {
    const upstreamRes = await fetch(parsedUrl.toString(), {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });

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
        const rewritten = rewriteM3u8Manifest(text, finalUrl, {
          referer,
          origin,
          reqBaseUrl: ''
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
