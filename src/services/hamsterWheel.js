/**
 * Hamster Wheel server — Node backend entry point.
 *
 * The cascade itself lives in `hamsterCore.js`, which is shared with the
 * Cloudflare Worker (the deployment that normally serves the player). This file
 * only wires the Node runtime in — the shared circuit breaker so the provider
 * state stays visible in the admin snapshot, and the Node stream-proxy builder.
 *
 * Providers, in priority order:
 *   1. Videasy  — 6+ OMSS servers, explicit multi-language sources
 *   2. Peachify — 6 servers, dub/sub labels (AES-encrypted responses)
 *   3. VidSrc   — 4 CDN domains behind vsembed.ru, English-only fallback
 */

const { circuitBreaker } = require('../utils/cache');
const { buildProxyStreamUrl } = require('./proxy');
const {
  configureHamsterCore,
  resolveHamsterWheelServer: runHamsterWheel,
  resolveVideasy: runVideasy,
  resolvePeachify: runPeachify,
  resolveVidsrc: runVidsrc
} = require('./hamsterCore');

configureHamsterCore({
  // Host contract: (rawUrl, referer) -> URL the player can load through /api/proxy.
  buildProxyStreamUrl: (url, referer) => buildProxyStreamUrl(url, referer, '', { mode: 'full' }),
  breaker: circuitBreaker
});

async function resolveHamsterWheelServer(metadata, requestedServerId = 'hamster', preferredAudio = '') {
  return runHamsterWheel(metadata, requestedServerId, preferredAudio);
}

module.exports = {
  resolveHamsterWheelServer,
  resolveVideasy: (metadata, preferredAudio = '') => runVideasy(metadata, preferredAudio),
  resolvePeachify: (metadata, preferredAudio = '') => runPeachify(metadata, preferredAudio),
  resolveVidsrc: (metadata, preferredAudio = '') => runVidsrc(metadata, preferredAudio)
};
