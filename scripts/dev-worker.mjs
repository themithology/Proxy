import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import workerModule from '../cloudflare-worker/worker.js';

/**
 * Load `.dev.vars` the way `wrangler dev` does. The Worker has no secret
 * fallbacks any more (ADMIN_SECRET / PROXY_SECRET used to default to published
 * values), so a local harness has to supply them or every signed route fails
 * closed with a 503.
 */
function loadDevVars() {
  const file = path.resolve('.dev.vars');
  const vars = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .dev.vars is fine; fall back to generated ephemeral secrets below.
  }
  return vars;
}

const devVars = loadDevVars();
const workerEnv = { ...devVars, ...process.env };

if (!workerEnv.PROXY_SECRET || !workerEnv.ADMIN_SECRET) {
  console.warn(
    '[dev-worker] PROXY_SECRET/ADMIN_SECRET missing from .dev.vars and the environment; ' +
    'generating ephemeral ones. Copy .dev.vars.example to .dev.vars to make them stable.'
  );
  workerEnv.PROXY_SECRET = workerEnv.PROXY_SECRET || crypto.randomBytes(32).toString('base64url');
  workerEnv.ADMIN_SECRET = workerEnv.ADMIN_SECRET || crypto.randomBytes(32).toString('base64url');
}

const PORT = parseInt(process.env.PLAYER_PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve('public');
const ASSET_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.gif': 'image/gif'
};

const mockAssets = {
  fetch: async (req) => {
    const assetPath = new URL(req.url).pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, assetPath));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = fs.readFileSync(filePath);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': ASSET_TYPES[path.extname(filePath)] || 'application/octet-stream' }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body && body.length > 0 ? body : undefined
    });
    const webRes = await workerModule.fetch(
      webReq,
      { ASSETS: mockAssets, ...workerEnv },
      { waitUntil() {} }
    );
    res.statusCode = webRes.status;
    for (const [key, val] of webRes.headers.entries()) {
      res.setHeader(key, val);
    }
    const arrayBuf = await webRes.arrayBuffer();
    res.end(Buffer.from(arrayBuf));
  } catch (err) {
    res.statusCode = 500;
    res.end(err.stack || err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[LOL Embed Player] Listening on http://${HOST}:${PORT}`);
  console.log(`[LOL Embed Player] admin key (X-Admin-Key): ${workerEnv.ADMIN_SECRET}`);
  console.log(`[LOL Embed Player] dashboard: http://localhost:${PORT}/reze?key=${workerEnv.ADMIN_SECRET}`);
});
