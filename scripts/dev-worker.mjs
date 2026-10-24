// Serve the real Worker player + API against the configured live upstreams.
// Only the static ASSETS binding is emulated; provider resolution and media
// proxying are not mocked. See .devcontainer/README.md for a hosted live test.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { createRequire } from 'module';
import workerModule from '../cloudflare-worker/worker.js';

const require = createRequire(import.meta.url);
const { createMkvHlsHandler } = require('../src/services/mkvHls.js');
const PORT = parseInt(process.env.PLAYER_PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const PUBLIC_DIR = path.resolve('public');
const mkvHls = createMkvHlsHandler({
  enabled: process.env.MKV_HLS_ENABLED === 'true',
  port: PORT
});
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
    // Node-only progressive-to-HLS conversion. This route never reaches the
    // Worker and is advertised only when MKV_HLS_ENABLED=true on this host.
    if (await mkvHls.handle(req, res)) return;

    // Codespaces and other preview proxies terminate HTTPS in front of this
    // Node process. Preserve that public origin so rewritten HLS playlists do
    // not emit browser-blocked http:// URLs.
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const requestOrigin =
      PUBLIC_BASE_URL ||
      `${forwardedProto === 'https' ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}`;
    const url = new URL(req.url || '/', requestOrigin).toString();
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
      {
        ASSETS: mockAssets,
        ...process.env,
        // Internal runtime proof, not a Cloudflare setting: the page may
        // advertise ffmpeg only when this Node harness actually mounts it.
        MKV_HLS_NODE_HOST: 'true'
      },
      { waitUntil() {} }
    );
    res.statusCode = webRes.status;
    for (const [key, val] of webRes.headers.entries()) {
      res.setHeader(key, val);
    }
    // Stream the Web Response body instead of buffering it. Buffering made a
    // real multi-GB MKV impossible to test and delayed the first byte until
    // the entire upstream file had downloaded.
    if (!webRes.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    const responseStream = Readable.fromWeb(webRes.body);
    res.once('close', () => {
      if (!res.writableEnded) responseStream.destroy();
    });
    responseStream.once('error', (err) => {
      if (!res.destroyed) res.destroy(err);
    });
    responseStream.pipe(res);
  } catch (err) {
    res.statusCode = 500;
    res.end(err.stack || err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[LOL Embed Player] Listening on http://${HOST}:${PORT}`);
  if (process.env.MKV_HLS_ENABLED === 'true') {
    console.log('[LOL Embed Player] Progressive-to-HLS conversion is enabled');
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  // Do not leave multi-GB transcode directories or orphan encoders behind
  // when a Codespace process is restarted.
  mkvHls.close().then(() => process.exit(0), () => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
