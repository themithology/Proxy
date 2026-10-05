const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const config = require('./config');
const apiRouter = require('./routes/api');

const app = express();

// Trust exactly `TRUST_PROXY_HOPS` reverse proxies (default 1) instead of
// `true`. With `true`, Express trusts the LEFTMOST X-Forwarded-For entry — which
// is client-supplied — so every caller could invent a fresh source IP and reset
// any per-IP rate limit on each request. If you chain CF -> nginx -> node, set
// TRUST_PROXY_HOPS=2. Client identity for limits prefers the unforgeable
// cf-connecting-ip header (see utils/rateLimit.js).
app.set('trust proxy', config.trustProxyHops);
app.disable('x-powered-by');

// Security headers. This is an API + cross-origin media service, so the defaults
// need two deliberate overrides:
//   crossOriginResourcePolicy: cross-origin — proxied segments/playlists MUST be
//     readable by a player on another origin, or every embed breaks.
//   contentSecurityPolicy: false — this runtime serves JSON and media, no HTML,
//     so a CSP would add nothing and can break inlined media responses.
// helmet was listed as a dependency but never required, so none of this applied.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: false,
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: 'no-referrer-when-downgrade' }
  })
);

// This service is API-only; the browser client is intentionally maintained separately.
// `origin: '*'` is a product decision (any site may embed), NOT authentication:
// the real controls are the mandatory proxy signatures and the rate limits.
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'HEAD', 'OPTIONS'] }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Backend routes and service metadata only; no player, portal, or admin web UI.
app.use('/api', apiRouter);

app.get('/meta-image.gif', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.type('gif').sendFile(path.join(__dirname, '..', 'public', 'lol-embed-meta.gif'));
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    brand: 'LOL Embed',
    service: 'lol-embed-backend',
    runtime: 'node',
    mode: 'backend-only',
    version: '2.0.0',
    api: '/api',
    health: '/api/health',
    metaImage: '/meta-image.gif'
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Last-resort handler: never serialize `err.message` to the client. Express
// errors here commonly contain upstream hostnames or filesystem paths.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[LOL Embed] unhandled request error:', err && err.message ? err.message : err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`[LOL Embed backend] Listening on http://${config.host}:${config.port}`);
    // Say out loud which controls are active, so a misconfigured deploy is
    // visible in the very first log line instead of after an incident.
    console.log(
      `[LOL Embed backend] trust proxy hops=${config.trustProxyHops} ` +
      `rate limits=${config.rateLimit.enabled ? 'on' : 'OFF'} ` +
      `(resolve ${config.rateLimit.resolvePerMinute}/min, proxy ${config.rateLimit.proxyPerMinute}/min) ` +
      `ssrf guard=${config.proxyAllowPrivateTargets ? 'DISABLED (private targets allowed)' : 'on'}`
    );
  });
}

app.app = app;
module.exports = app;
