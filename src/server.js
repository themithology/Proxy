const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const apiRouter = require('./routes/api');

const app = express();

// Trust reverse proxies (Cloudflare, Vercel, Render, E2B preview)
app.set('trust proxy', true);

// This service is API-only; the browser client is intentionally maintained separately.
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

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`[LOL Embed backend] Listening on http://${config.host}:${config.port}`);
  });
}

app.app = app;
module.exports = app;
