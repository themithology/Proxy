'use strict';

/**
 * Shared request signing, secret hygiene and SSRF guard.
 *
 * This module is the single source of truth for proxy/handshake/multi-track
 * signatures. It is CommonJS with NO dependency on `../config`, so both the
 * Node backend and the Cloudflare Worker (via `nodejs_compat`) can load the
 * exact same implementation. That matters: a signed URL produced by one
 * runtime must verify on the other whenever `API_BASE_URL` or
 * `EXTERNAL_PROXY_POOL` points across them.
 *
 * Every function takes the secret explicitly. Nothing here reads process.env,
 * so a caller can never accidentally sign with a fallback value it did not
 * choose.
 */

const crypto = require('node:crypto');

/* ------------------------------------------------------------------------ */
/* Secret hygiene                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Values that have shipped in this repository as samples/defaults. A
 * deployment still using one of these is UNCONFIGURED, not configured: anyone
 * who has read the repo can forge every signature and authenticate to
 * /api/admin/*. Treat them as missing.
 */
const KNOWN_INSECURE_SECRETS = new Set([
  '',
  'admin123',
  'vidstuck-edge-hmac-secret-key-2026-9f8e7d6c5b4a',
  'change-this-to-a-random-hmac-secret-key'
]);

/** Placeholder-ish values: not the committed defaults, but obviously not real. */
const SAMPLE_SECRET_PATTERN = /(changeme|change-this|replace[-_ ]?me|your[-_ ]?secret|example|placeholder|dummy|not-production|preview-only)/i;

const MIN_SECRET_LENGTH = 32;

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * True when the secret is one of the known committed defaults / empty.
 * These must never be accepted in a real deployment.
 */
function isInsecureSecret(value) {
  return KNOWN_INSECURE_SECRETS.has(normalizeSecret(value));
}

/**
 * True when the secret is long enough and is not a known default. Sample-ish
 * strings are reported separately by `describeSecretProblem` so previews can
 * be told apart from a genuinely unconfigured production deploy.
 */
function isUsableSecret(value) {
  const secret = normalizeSecret(value);
  if (!secret || isInsecureSecret(secret)) return false;
  return secret.length >= MIN_SECRET_LENGTH;
}

/**
 * Human-readable reason a secret was rejected, or '' when it is fine.
 */
function describeSecretProblem(value) {
  const secret = normalizeSecret(value);
  if (!secret) return 'is not set';
  if (KNOWN_INSECURE_SECRETS.has(secret)) return 'is a published sample/default value from this repository';
  if (secret.length < MIN_SECRET_LENGTH) return `is shorter than ${MIN_SECRET_LENGTH} characters`;
  return '';
}

/** True when the secret is usable but still looks like a placeholder. */
function looksLikeSampleSecret(value) {
  const secret = normalizeSecret(value);
  return isUsableSecret(secret) && SAMPLE_SECRET_PATTERN.test(secret);
}

/** Generate a cryptographically strong secret (URL-safe, 256-bit). */
function generateSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/* ------------------------------------------------------------------------ */
/* Constant-time comparison                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Length-independent constant-time string comparison. `a !== b` leaks both the
 * value and the length through timing, which is exactly what an admin-key or
 * signature oracle needs.
 */
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bufB = Buffer.from(String(b == null ? '' : b), 'utf8');
  // Hashing first normalizes the length so timingSafeEqual cannot throw and so
  // the comparison cost does not depend on input length.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/* ------------------------------------------------------------------------ */
/* Proxy URL signing (HMAC-SHA256 over `url|referer|exp`, hex, first 32)      */
/* ------------------------------------------------------------------------ */

const SIGNATURE_HEX_LENGTH = 32;

function signProxyParams(targetUrl, referer = '', exp = 0, secret) {
  if (!isUsableSecret(secret)) {
    throw new Error('signProxyParams requires a configured secret');
  }
  return crypto
    .createHmac('sha256', normalizeSecret(secret))
    .update(`${targetUrl}|${referer || ''}|${exp}`)
    .digest('hex')
    .slice(0, SIGNATURE_HEX_LENGTH);
}

/**
 * Verify a proxy signature. Fail-closed by design: a request with NO exp/sig is
 * rejected, not treated as "signature not requested". That single missing check
 * is what used to turn /api/proxy into an unauthenticated open relay.
 */
function verifyProxySignature(targetUrl, referer = '', exp = 0, sig = '', secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!targetUrl) return false;
  if (!isUsableSecret(secret)) return false;
  const expNumber = Number(exp);
  if (!Number.isFinite(expNumber) || expNumber <= 0) return false;
  if (expNumber < nowSeconds) return false;
  if (typeof sig !== 'string' || sig.length !== SIGNATURE_HEX_LENGTH) return false;
  let expected;
  try {
    expected = signProxyParams(targetUrl, referer || '', expNumber, secret);
  } catch {
    return false;
  }
  return constantTimeEqual(sig, expected);
}

/* ------------------------------------------------------------------------ */
/* Proxy REQUEST signing (v2)                                                */
/* ------------------------------------------------------------------------ */

/**
 * The v1 signature above covers only `url|referer|exp`. That is not enough for
 * /api/proxy, because the route also honors `origin`, `cookie`, `mode`, `token`
 * and `vidsrcStamp` — parameters that change WHAT WE SEND UPSTREAM. Historically
 * those were appended to the query string AFTER signing, so anyone holding a
 * legitimate signed URL (and every signed URL is visible in a viewer's network
 * tab) could add `&cookie=...` and turn our proxy into an authenticated request
 * relay against that host.
 *
 * v2 binds the whole effective parameter set into one canonical string. Signer
 * and verifier both go through `normalizeProxyRequestParams`, so an absent
 * parameter and an empty parameter sign identically.
 */
const PROXY_REQUEST_SIGNATURE_VERSION = 'proxy-v2';

function normalizeProxyRequestParams(input = {}) {
  const source = input || {};
  const mode = String(source.mode || '').trim();
  return {
    url: String(source.url || ''),
    referer: String(source.referer || ''),
    origin: String(source.origin || ''),
    cookie: String(source.cookie || ''),
    // The route defaults a missing mode to 'manifest'; sign the effective value
    // so "omitted" and "manifest" cannot be swapped after signing.
    mode: mode || 'manifest',
    token: String(source.token || ''),
    vidsrcStamp: String(source.vidsrcStamp || '') === '1' || String(source.vidsrcStamp || '') === 'true' ? '1' : '0',
    exp: Number(source.exp || 0)
  };
}

function proxyRequestSignaturePayload(params) {
  const p = normalizeProxyRequestParams(params);
  return [
    PROXY_REQUEST_SIGNATURE_VERSION,
    p.url,
    p.referer,
    p.origin,
    p.cookie,
    p.mode,
    p.token,
    p.vidsrcStamp,
    p.exp
  ].join('|');
}

/**
 * Query parameters that make up a signed proxy request.
 *
 * Express and the Workers runtime disagree about duplicates: `req.query.mode`
 * becomes an ARRAY when `mode` appears twice, while `searchParams.get('mode')`
 * returns the FIRST value. That divergence is the classic HTTP parameter
 * pollution setup — one layer validates one value and another layer acts on a
 * different one. Both runtimes therefore reject any request that repeats one of
 * these parameters, before signature verification.
 */
const SIGNED_PROXY_PARAMS = ['url', 'referer', 'origin', 'cookie', 'mode', 'token', 'vidsrcStamp', 'exp', 'sig'];

/** Duplicate check for a WHATWG URLSearchParams (Cloudflare Worker). */
function duplicatedSignedParams(searchParams) {
  if (!searchParams || typeof searchParams.getAll !== 'function') return [];
  return SIGNED_PROXY_PARAMS.filter((key) => searchParams.getAll(key).length > 1);
}

/** Duplicate check for an Express `req.query` object (repeated keys parse as arrays). */
function duplicatedSignedParamsFromQuery(query) {
  if (!query || typeof query !== 'object') return [];
  return SIGNED_PROXY_PARAMS.filter((key) => Array.isArray(query[key]));
}

function signProxyRequest(params, secret) {
  if (!isUsableSecret(secret)) {
    throw new Error('signProxyRequest requires a configured secret');
  }
  return crypto
    .createHmac('sha256', normalizeSecret(secret))
    .update(proxyRequestSignaturePayload(params))
    .digest('hex')
    .slice(0, SIGNATURE_HEX_LENGTH);
}

/**
 * Fail-closed verification of a /api/proxy request. Missing exp or sig is a
 * rejection — this is the check whose absence made /api/proxy an open relay.
 */
function verifyProxyRequest(params, sig, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!isUsableSecret(secret)) return false;
  const normalized = normalizeProxyRequestParams(params);
  if (!normalized.url) return false;
  if (!Number.isFinite(normalized.exp) || normalized.exp <= 0) return false;
  if (normalized.exp < nowSeconds) return false;
  if (typeof sig !== 'string' || sig.length !== SIGNATURE_HEX_LENGTH) return false;
  let expected;
  try {
    expected = signProxyRequest(normalized, secret);
  } catch {
    return false;
  }
  return constantTimeEqual(sig, expected);
}

/**
 * Build a signed /api/proxy URL. `url` stays the first parameter (the manifest
 * rewriter and the test suite both rely on `/api/proxy?url=` appearing first).
 */
function createSignedProxyUrl(targetUrl, options = {}) {
  const {
    referer = '',
    origin = '',
    cookie = '',
    mode = '',
    token = '',
    vidsrcStamp = '',
    baseUrl = '',
    ttlSeconds = 14400,
    secret,
    exp: explicitExp = 0
  } = options;

  const exp = Number(explicitExp) > 0
    ? Number(explicitExp)
    : Math.floor(Date.now() / 1000) + Number(ttlSeconds || 14400);

  const normalized = normalizeProxyRequestParams({
    url: targetUrl,
    referer,
    origin,
    cookie,
    mode,
    token,
    vidsrcStamp,
    exp
  });
  const sig = signProxyRequest(normalized, secret);

  const params = new URLSearchParams();
  params.set('url', normalized.url);
  if (normalized.referer) params.set('referer', normalized.referer);
  if (normalized.origin) params.set('origin', normalized.origin);
  if (normalized.cookie) params.set('cookie', normalized.cookie);
  if (mode) params.set('mode', normalized.mode);
  if (normalized.token) params.set('token', normalized.token);
  if (normalized.vidsrcStamp === '1') params.set('vidsrcStamp', '1');
  params.set('exp', String(exp));
  params.set('sig', sig);

  return `${baseUrl}/api/proxy?${params.toString()}`;
}

/* ------------------------------------------------------------------------ */
/* Handshake session tokens (`base64url(payload).base64url(hmac)`)            */
/* ------------------------------------------------------------------------ */

function generateHandshakeToken(payload = {}, options = {}) {
  const { secret, ttlSeconds = 14400 } = options;
  const exp = Math.floor(Date.now() / 1000) + Number(ttlSeconds || 14400);
  const body = Buffer.from(JSON.stringify({ ...payload, exp }), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', normalizeSecret(secret))
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyHandshakeToken(token, options = {}) {
  const { secret, nowSeconds = Math.floor(Date.now() / 1000) } = options;
  if (!isUsableSecret(secret)) return null;
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', normalizeSecret(secret))
    .update(body)
    .digest('base64url');
  if (!constantTimeEqual(sig, expectedSig)) return null;

  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object') return null;
    if (data.exp && Number(data.exp) < nowSeconds) return null;
    return data;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* SSRF / target-safety guard                                                */
/* ------------------------------------------------------------------------ */

/** Reserved IPv4 ranges a media proxy must never be pointed at. */
const PRIVATE_IPV4_RANGES = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local + cloud metadata
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 multicast
  [0xf0000000, 0xffffffff]  // 240.0.0.0/4 reserved + broadcast
];

function ipv4ToInt(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function isPrivateIpv4(host) {
  const value = ipv4ToInt(host);
  if (value === null) return false;
  return PRIVATE_IPV4_RANGES.some(([low, high]) => value >= low && value <= high);
}

/** Strip an IPv6 zone id / brackets, then test against reserved space. */
function isPrivateIpv6(host) {
  const raw = host.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!raw.includes(':')) return false;
  if (raw === '::' || raw === '::1') return true;
  if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') || raw.startsWith('feb')) return true; // fe80::/10
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true; // fc00::/7 ULA
  if (raw.startsWith('ff')) return true; // multicast
  if (raw.startsWith('2001:db8')) return true; // documentation
  if (raw.startsWith('100::')) return true; // discard-only
  // IPv4-mapped (::ffff:127.0.0.1) — decide using the embedded IPv4.
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'docker',
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc'
]);

function isPrivateOrReservedHost(host) {
  const hostname = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) return true;
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  if (hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local')) return true;
  if (ipv4ToInt(hostname) !== null) return isPrivateIpv4(hostname);
  if (hostname.includes(':')) return isPrivateIpv6(hostname);
  return false;
}

/**
 * Validate an outbound media target. Returns `{ ok, reason, url }`.
 *
 * Rejected: non-http(s) schemes (file://, gopher://, dict://), embedded
 * credentials (a classic `http://trusted@evil/` allowlist bypass), and any
 * private/loopback/link-local/reserved destination — which is what stops the
 * proxy from being aimed at 169.254.169.254, 127.0.0.1:6379 or the Docker
 * socket on a single-machine deployment.
 *
 * `allowPrivateTargets` exists ONLY so the hermetic test suite can proxy to a
 * 127.0.0.1 mock upstream, and local development can point at a LAN test box.
 * It is never honored in a production Node runtime (see config.js).
 *
 * Residual risk: a public hostname that resolves to a private address (DNS
 * rebinding) is not caught here, because this check is synchronous and does no
 * DNS lookup. Callers that follow redirects MUST re-run this guard on every
 * hop — `src/services/proxy.js` does exactly that.
 */
function inspectMediaTarget(rawUrl, options = {}) {
  const { allowPrivateTargets = false } = options || {};
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, reason: 'malformed_url', url: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol', url };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials_in_url', url };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'missing_host', url };
  if (!allowPrivateTargets && isPrivateOrReservedHost(host)) {
    return { ok: false, reason: 'private_or_reserved_host', url };
  }
  return { ok: true, reason: '', url };
}

module.exports = {
  MIN_SECRET_LENGTH,
  KNOWN_INSECURE_SECRETS,
  isInsecureSecret,
  isUsableSecret,
  looksLikeSampleSecret,
  describeSecretProblem,
  generateSecret,
  constantTimeEqual,
  signProxyParams,
  verifyProxySignature,
  PROXY_REQUEST_SIGNATURE_VERSION,
  SIGNED_PROXY_PARAMS,
  duplicatedSignedParams,
  duplicatedSignedParamsFromQuery,
  normalizeProxyRequestParams,
  proxyRequestSignaturePayload,
  signProxyRequest,
  verifyProxyRequest,
  createSignedProxyUrl,
  generateHandshakeToken,
  verifyHandshakeToken,
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateOrReservedHost,
  inspectMediaTarget
};
