const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const apiRouter = require('./routes/api');
const { telemetry } = require('./services/telemetry');

const app = express();

// Trust reverse proxies (Cloudflare, Vercel, Render, E2B preview)
app.set('trust proxy', true);

// Enable permissive CORS & iframe embedding headers for all routes
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'HEAD', 'OPTIONS'] }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  // Explicitly allow embedding in any <iframe> across all domains
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *;');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Mount API routes
app.use('/api', apiRouter);

// Serve static assets from /public
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Embed player routes (supports VidStuck, VidBolt, and ScreenScape URL patterns using TMDB ID)
const sendEmbedPage = (req, res) => {
  const callerDomain = telemetry.extractDomain(req);
  if (telemetry.isDomainBlocked(callerDomain)) {
    return res
      .status(403)
      .send(`<!DOCTYPE html><html><body style="background:#090b10;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h3>Embed access blocked for domain: ${callerDomain}</h3></body></html>`);
  }

  telemetry.recordDomainActivity(req, 'embed', {
    tmdbId: req.params.tmdbId || req.query.tmdb || req.query.id || ''
  });

  if (config.enforceIframeOnly) {
    const fetchDest = req.headers['sec-fetch-dest'];
    if (fetchDest && fetchDest !== 'iframe' && !req.query.preview) {
      return res.status(403).sendFile(path.join(publicDir, 'embed.html'));
    }
  }
  res.sendFile(path.join(publicDir, 'embed.html'));
};

// Owner Admin Dashboard route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// 1. VidStuck style: /embed/movie/:tmdbId and /embed/tv/:tmdbId/:season/:episode
app.get('/embed/movie/:tmdbId', sendEmbedPage);
app.get('/embed/tv/:tmdbId/:season/:episode', sendEmbedPage);
app.get('/embed/tv/:tmdbId/:season', sendEmbedPage);
app.get('/embed/tv/:tmdbId', sendEmbedPage);

// 2. VidBolt style: /movie/:tmdbId and /tv/:tmdbId/:season/:episode
app.get('/movie/:tmdbId', sendEmbedPage);
app.get('/tv/:tmdbId/:season/:episode', sendEmbedPage);
app.get('/tv/:tmdbId', sendEmbedPage);

// 3. ScreenScape style: /embed?tmdb=94605&type=tv&s=1&e=1
app.get('/embed', sendEmbedPage);

// 4. Demo / Playground route
app.get('/demo', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`[VidStuck Embed & Proxy API] Listening on http://${config.host}:${config.port}`);
  });
}

app.app = app;
module.exports = app;
