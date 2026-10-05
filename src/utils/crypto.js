'use strict';

/**
 * Config-bound signing facade for the Node backend.
 *
 * The algorithms live in `./proxySign.js`, which is dependency-free and shared
 * with the Cloudflare Worker so a URL signed by one runtime verifies on the
 * other. This file only injects `config.proxySecret` / `config.tokenTtlSeconds`
 * so existing Node call sites keep their shorter signatures.
 *
 * Do NOT add a fallback secret here. `config.js` refuses to boot in production
 * unless a strong `PROXY_SECRET` is configured, and `proxySign.signProxyParams`
 * throws rather than signing with a published default.
 */

const config = require('../config');
const proxySign = require('./proxySign');

/**
 * Derive 32-byte key and 16-byte IV using OpenSSL EVP_BytesToKey (MD5).
 * Matches `openssl enc -aes-256-cbc -md md5` and `CryptoJS.AES` without needing
 * external packages. Retained for the CastleTV AES-128-CBC upstream handshake.
 */
const crypto = require('crypto');

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

/** HMAC-SHA256 signature for proxy payloads (`url|referer|exp`). */
function signProxyParams(targetUrl, referer = '', exp = 0, secret = config.proxySecret) {
  return proxySign.signProxyParams(targetUrl, referer, exp, secret);
}

/**
 * Verify a proxy signature. Fail-closed: a missing exp or sig is a rejection,
 * never a bypass.
 */
function verifyProxySignature(targetUrl, referer = '', exp = 0, sig = '', secret = config.proxySecret) {
  return proxySign.verifyProxySignature(targetUrl, referer, exp, sig, secret);
}

/** Create a signed proxy URL with an expiration timestamp. */
function createSignedProxyUrl(targetUrl, options = {}) {
  return proxySign.createSignedProxyUrl(targetUrl, {
    ttlSeconds: config.tokenTtlSeconds || 14400,
    secret: config.proxySecret,
    ...options
  });
}

/** Short-lived signed session handshake token (like VidStuck's /backend/meow). */
function generateHandshakeToken(payload = {}, options = {}) {
  return proxySign.generateHandshakeToken(payload, {
    ttlSeconds: config.tokenTtlSeconds || 14400,
    secret: config.proxySecret,
    ...options
  });
}

/** Verify a session handshake token. */
function verifyHandshakeToken(token, options = {}) {
  return proxySign.verifyHandshakeToken(token, {
    secret: config.proxySecret,
    ...options
  });
}

module.exports = {
  evpBytesToKeyMd5,
  signProxyParams,
  verifyProxySignature,
  createSignedProxyUrl,
  generateHandshakeToken,
  verifyHandshakeToken,
  // v2 request signing: binds url + referer + origin + cookie + mode + token +
  // vidsrcStamp + exp, so no unsigned parameter can be appended to a signed URL.
  signProxyRequest: proxySign.signProxyRequest,
  verifyProxyRequest: (params, sig, secret = config.proxySecret) =>
    proxySign.verifyProxyRequest(params, sig, secret),
  normalizeProxyRequestParams: proxySign.normalizeProxyRequestParams,
  // Re-exported so Node call sites can reach the SSRF guard and secret checks
  // without a second import path.
  isInsecureSecret: proxySign.isInsecureSecret,
  isUsableSecret: proxySign.isUsableSecret,
  inspectMediaTarget: proxySign.inspectMediaTarget,
  isPrivateOrReservedHost: proxySign.isPrivateOrReservedHost,
  constantTimeEqual: proxySign.constantTimeEqual
};
