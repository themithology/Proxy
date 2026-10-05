'use strict';

/**
 * Shared fixed-window rate limiter + client identity.
 *
 * CommonJS with no dependencies so the Node backend and the Cloudflare Worker
 * enforce the same limits with the same code. State is per-process (Node) or
 * per-isolate (Worker): that is a deliberate trade-off — it is free, adds no
 * latency and no storage, and it stops the naive case (`for id in 1..1000000`)
 * cold. It is NOT a global quota; a determined client spread across many
 * Workers isolates sees a limit per isolate. For a true global quota, back this
 * with the existing STATS Durable Object (see README "Rate limits").
 */

const DEFAULT_MAX_KEYS = 20000;

function createRateLimiter(options = {}) {
  const {
    name = 'default',
    limit = 60,
    windowMs = 60000,
    maxKeys = DEFAULT_MAX_KEYS
  } = options;

  const buckets = new Map();

  function prune(now) {
    if (buckets.size <= maxKeys) return;
    // Drop expired entries first; if still over the cap, evict the oldest
    // reset time so a flood of unique keys cannot exhaust memory.
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
      if (buckets.size <= maxKeys) return;
    }
    if (buckets.size <= maxKeys) return;
    const sorted = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    const overflow = buckets.size - maxKeys;
    for (let i = 0; i < overflow; i += 1) buckets.delete(sorted[i][0]);
  }

  function check(key, now = Date.now()) {
    const identity = String(key == null || key === '' ? 'anonymous' : key);
    let entry = buckets.get(identity);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(identity, entry);
      prune(now);
    }
    entry.count += 1;
    const allowed = entry.count <= limit;
    return {
      allowed,
      name,
      limit,
      remaining: Math.max(0, limit - entry.count),
      retryAfterMs: allowed ? 0 : Math.max(0, entry.resetAt - now),
      resetAt: entry.resetAt
    };
  }

  /**
   * Standard `RateLimit-*` headers plus `Retry-After`, as plain key/value pairs
   * so Express and the Worker can both apply them without an adapter.
   */
  function headers(decision) {
    if (!decision) return {};
    const out = {
      'RateLimit-Limit': String(decision.limit),
      'RateLimit-Remaining': String(decision.remaining),
      'RateLimit-Reset': String(Math.max(1, Math.ceil(windowMs / 1000)))
    };
    if (!decision.allowed) {
      out['Retry-After'] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
    return out;
  }

  function reset() {
    buckets.clear();
  }

  return { name, limit, windowMs, check, headers, reset, get size() { return buckets.size; } };
}

/* ------------------------------------------------------------------------ */
/* Cloudflare peer verification                                              */
/* ------------------------------------------------------------------------ */

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/).
 *
 * Why this matters: `cf-connecting-ip` is trustworthy ONLY when Cloudflare set
 * it, and the TCP peer address is the one piece of client identity that cannot be
 * forged. So instead of trusting the header on faith (which lets a directly
 * exposed Node process be rate-limit-bypassed with one header) we verify the
 * socket peer actually belongs to Cloudflare.
 *
 * Staleness fails SAFE: if a range is missing, we fall back to the socket peer
 * address — coarser, but never bypassable.
 */
const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];
const CLOUDFLARE_IPV6_PREFIXES = [
  '2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:',
  '2405:8100:', '2a06:98c0:', '2c0f:f248:'
];

function cidrContains(cidr, ip) {
  const [range, bitsText] = String(cidr).split('/');
  const bits = Number(bitsText);
  const rangeParts = range.split('.').map(Number);
  const ipParts = String(ip).split('.').map(Number);
  if (rangeParts.length !== 4 || ipParts.length !== 4) return false;
  if (rangeParts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  if (ipParts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const toInt = (parts) => ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = bits <= 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(rangeParts) & mask) === (toInt(ipParts) & mask);
}

/** Normalize `::ffff:1.2.3.4` and `::1`-style values to something comparable. */
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  return ip.replace(/^\[|\]$/g, '').toLowerCase();
}

/** True when the socket peer is a Cloudflare edge address. */
function isCloudflarePeer(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return false;
  if (ip.includes(':')) {
    // Compare on the /32 (first two groups), which is how CF publishes them.
    return CLOUDFLARE_IPV6_PREFIXES.some((prefix) => ip.startsWith(prefix));
  }
  return CLOUDFLARE_IPV4_RANGES.some((cidr) => cidrContains(cidr, ip));
}

/**
 * Pick an UNFORGEABLE client identity from an Express request.
 *
 * This deliberately ignores `x-forwarded-for`, `x-real-ip` and Express's
 * `req.ip`. All three are derived from headers the client sends. Pinning
 * `trust proxy` to a hop count does NOT make them safe when the process is
 * directly reachable: with `trust proxy: 1` and no proxy actually in front,
 * Express still takes `req.ip` from the caller's own XFF value, so a scraper can
 * rotate `X-Forwarded-For` and get a fresh bucket on every request. Verified:
 * that bypass worked against the first version of this limiter.
 *
 * Precedence:
 *   1. `cf-connecting-ip` — set by Cloudflare from the real TCP peer; Cloudflare
 *      strips any client-supplied copy, so behind CF this is trustworthy.
 *   2. the socket peer address — unforgeable, and correct when the process is
 *      directly exposed.
 *
 * `trustForwardedHeaders` is an explicit operator opt-in for the case where a
 * reverse proxy that is NOT Cloudflare rewrites XFF (nginx `proxy_set_header
 * X-Forwarded-For $remote_addr`, an ALB, ...). It is OFF by default, because
 * enabling it without such a proxy re-opens the bypass above.
 */
function expressClientKey(req, options = {}) {
  const { trustForwardedHeaders = false } = options || {};
  const headers = (req && req.headers) || {};

  const socketIp = normalizeIp(req && req.socket && req.socket.remoteAddress);

  // `cf-connecting-ip` is honored only when the TCP peer is genuinely a
  // Cloudflare edge node (or the operator asserts a CF-equivalent proxy with
  // trustForwardedHeaders). Otherwise it is just another forgeable header.
  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) {
    if (isCloudflarePeer(socketIp) || trustForwardedHeaders) {
      return `ip:${cf.trim().split(',')[0].trim()}`;
    }
  }

  if (trustForwardedHeaders) {
    if (req && req.ip) return `ip:${req.ip}`;
    const real = headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return `ip:${real.trim()}`;
    const xff = headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return `ip:${xff.split(',')[0].trim()}`;
  }

  return `ip:${socketIp || 'unknown'}`;
}

/**
 * Same policy for a WHATWG Request (Cloudflare Worker). `cf-connecting-ip` is
 * always present and authoritative on Cloudflare's edge; the forwarding headers
 * are only consulted when the operator opts in, and the fallback is the target
 * hostname so local dev still gets one shared bucket rather than no limit at all.
 */
function requestClientKey(request, url, options = {}) {
  const { trustForwardedHeaders = false } = options || {};
  const headers = (request && request.headers) || null;
  const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : '');

  const cf = get('cf-connecting-ip');
  if (cf && cf.trim()) return `ip:${cf.trim().split(',')[0].trim()}`;

  if (trustForwardedHeaders) {
    const real = get('x-real-ip');
    if (real && real.trim()) return `ip:${real.trim()}`;
    const xff = get('x-forwarded-for');
    if (xff && xff.trim()) return `ip:${xff.split(',')[0].trim()}`;
  }

  let host = 'unknown';
  try {
    host = new URL((url && url.href) || (request && request.url) || 'http://unknown').hostname;
  } catch {
    host = 'unknown';
  }
  return `host:${host}`;
}

module.exports = {
  createRateLimiter,
  expressClientKey,
  requestClientKey,
  isCloudflarePeer,
  normalizeIp,
  CLOUDFLARE_IPV4_RANGES,
  DEFAULT_MAX_KEYS
};
