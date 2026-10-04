const crypto = require('crypto');
const config = require('../config');

/**
 * Derive 32-byte key and 16-byte IV using OpenSSL EVP_BytesToKey (MD5)
 * Matches `openssl enc -aes-256-cbc -md md5` and `CryptoJS.AES` without needing external packages.
 */
function evpBytesToKeyMd5(passphrase, salt) {
  const passBuf = Buffer.from(String(passphrase), 'utf8');
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.concat([block, passBuf, salt]));
    block = md5.digest();
    derived = Buffer.concat([derived, block]);
  }
  return {
    key: derived.subarray(0, 32),
    iv: derived.subarray(32, 48)
  };
}

/**
 * Generates an HMAC-SHA256 signature for proxy URLs (`url|referer|exp`).
 */
function signProxyParams(targetUrl, referer = '', exp = 0, secret = config.proxySecret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${targetUrl}|${referer || ''}|${exp}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Verifies an HMAC-SHA256 proxy signature.
 */
function verifyProxySignature(targetUrl, referer = '', exp = 0, sig = '') {
  if (!targetUrl || !exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) < now) return false;
  const expected = signProxyParams(targetUrl, referer, exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Creates a signed proxy URL with an expiration timestamp.
 */
function createSignedProxyUrl(targetUrl, options = {}) {
  const {
    referer = '',
    origin = '',
    baseUrl = '',
    ttlSeconds = config.tokenTtlSeconds || 14400
  } = options;

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signProxyParams(targetUrl, referer, exp);

  const params = new URLSearchParams();
  params.set('url', targetUrl);
  if (referer) params.set('referer', referer);
  if (origin) params.set('origin', origin);
  params.set('exp', String(exp));
  params.set('sig', sig);

  return `${baseUrl}/api/proxy?${params.toString()}`;
}

/**
 * Generates a short-lived signed session handshake token (like VidStuck's /backend/meow).
 */
function generateHandshakeToken(payload = {}) {
  const exp = Math.floor(Date.now() / 1000) + (config.tokenTtlSeconds || 14400);
  const body = Buffer.from(JSON.stringify({ ...payload, exp }), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.proxySecret)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifies a session handshake token.
 */
function verifyHandshakeToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto
    .createHmac('sha256', config.proxySecret)
    .update(body)
    .digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = {
  signProxyParams,
  verifyProxySignature,
  createSignedProxyUrl,
  generateHandshakeToken,
  verifyHandshakeToken
};
