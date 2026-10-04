// Local UI harness for the /embed player.
//
// Serves `public/` exactly like the Worker does (player page + assets) but
// answers `/api/*` from an in-memory mock, so the player UI can be iterated on
// without TMDB keys or reachable upstreams. The mock stream is the public
// hls.js demo asset (Big Buck Bunny, multi-quality HLS); the browser fetches it
// directly, nothing is proxied.
//
//   node scripts/dev-player-mock.mjs            # http://0.0.0.0:8790/embed?type=tv&tmdb=94605&s=1&e=1
//   PLAYER_PORT=9000 node scripts/dev-player-mock.mjs
//   ADS=0 node scripts/dev-player-mock.mjs      # ad-free page (what ADS_ENABLED="false" serves)
//
// Useful URLs:
//   /embed?type=tv&tmdb=94605&s=1&e=1                 happy path (recap + intro + open-ended credits segments, subtitles)
//   /embed?type=tv&tmdb=94605&s=1&e=1&server=centaurus  server 2 fails -> automatic failover toast
//   /embed?type=movie&tmdb=693134                     movie (no episodes UI)
//   /embed?type=movie&tmdb=0                          every server fails -> error screen with the server list inline
//   /embed?type=tv&tmdb=94605&s=1&e=1&color=e50914    accent override (contrast-aware pills)
//   /embed?type=tv&tmdb=94605&s=1&e=1&t=1m30s&autoskip=1  start offset + auto-skip on
//   /host                                             host page: the player in an iframe + the postMessage control API
//   /docs  (alias /documentation)                     public documentation page
//   /reze?key=admin123                                owner dashboard fed with seeded demo statistics

import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const statsAggregate = require('../src/services/statsAggregate.js');

const PORT = parseInt(process.env.PLAYER_PORT || '8790', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve('public');
const ASSET_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.gif': 'image/gif'
};

const DEMO_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const DEMO_MP4 = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

const SERVERS = [
  { id: 'andromeda', name: 'Fiber Optic Speedrun', badge: 'Multi-Audio • Primary', priority: 1, enabled: true },
  { id: 'centaurus', name: 'Gigachad Node', badge: 'Adaptive • Multi-Quality', priority: 2, enabled: true }
];

// Seeded demo statistics for /reze (deterministic, so the dashboard looks the
// same on every start). Mirrors what the Worker's StatsStore accumulates.
const demoStats = statsAggregate.createStatsAggregate();
const adFreeDomains = new Set();

function normalizeSiteDomain(raw) {
  const value = String(raw || '').trim();
  if (!value || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value))) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!host || host.length > 253 || host.split('.').some((label) =>
      !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )) return '';
    return host;
  } catch {
    return '';
  }
}

function callerSite(req, url) {
  const candidates = [url.searchParams.get('parent'), url.searchParams.get('domain'), req.headers.origin, req.headers.referer].filter(Boolean);
  for (const raw of candidates) {
    try {
      const host = normalizeSiteDomain(raw);
      if (host) return host;
    } catch {}
  }
  return normalizeSiteDomain(url.hostname);
}

(function seedDemoStats() {
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = (weights) => {
    const total = weights.reduce((a, w) => a + w[1], 0);
    let r = rand() * total;
    for (const [value, weight] of weights) {
      r -= weight;
      if (r <= 0) return value;
    }
    return weights[0][0];
  };
  const titles = [
    ['tv', 94605, 'Arcane', 2021, 40], ['tv', 1396, 'Breaking Bad', 2008, 30], ['movie', 693134, 'Dune: Part Two', 2024, 26],
    ['tv', 66732, 'Stranger Things', 2016, 18], ['movie', 533535, 'Deadpool & Wolverine', 2024, 15], ['tv', 1399, 'Game of Thrones', 2011, 12],
    ['movie', 1184918, 'The Wild Robot', 2024, 8], ['tv', 95396, 'Severance', 2022, 7], ['movie', 912649, 'Venom: The Last Dance', 2024, 4], ['tv', 60625, 'Rick and Morty', 2013, 3]
  ];
  const sites = [['theogpiratebot.online', 70], ['honeymovies.onrender.com', 8], ['localhost:5173', 6], ['livetgtv.lovable.app', 5], ['iris-3.vercel.app', 4], ['100.89.36.110:45267', 3], ['watch.example', 2], ['cinema.test', 2]];
  const countries = [['IN', 60], ['PK', 10], ['BD', 8], ['US', 6], ['NP', 4], ['SG', 3], ['AE', 3], ['GB', 2], ['DE', 2], ['ZZ', 2]];
  const reasons = ['servers_no_link', 'upstream_timeout', 'hicine_no_stream', 'meow_403'];
  for (let i = 0; i < 1400; i += 1) {
    const title = pick(titles.map((t) => [t, t[4]]));
    const at = new Date(Date.now() - rand() * 13 * 86400000).toISOString();
    const base = {
      at, domain: pick(sites), country: pick(countries), type: title[0], tmdbId: title[1], title: title[2], year: title[3],
      season: title[0] === 'tv' ? 1 + Math.floor(rand() * 3) : null, episode: title[0] === 'tv' ? 1 + Math.floor(rand() * 9) : null
    };
    demoStats.record({ kind: 'embed', ...base });
    const failed = rand() < (title[1] === 912649 ? 0.6 : title[1] === 60625 ? 0.5 : 0.07);
    const server = rand() < 0.75 ? 'andromeda' : 'centaurus';
    const reason = failed ? reasons[Math.floor(rand() * reasons.length)] : null;
    demoStats.record({ kind: 'server_attempt', at, server, ok: !failed, latencyMs: 300 + rand() * 900, reason });
    if (failed) demoStats.record({ kind: 'resolve_error', ...base, server, reason });
    else demoStats.record({ kind: 'resolve', ...base, server });
    for (let p = 0; p < 6; p += 1) demoStats.record({ kind: 'proxy', at, domain: '' });
  }
  demoStats.setBlocked('leecher.example', true);
})();

const SHOW = {
  title: 'Mock Show',
  releaseYear: 2021,
  genres: ['Animation', 'Drama'],
  runtime: 10,
  tagline: 'In the shadow of Piltover, the undercity rises.',
  rating: 8.7,
  voteCount: 5134,
  overview: 'Amid the stark discord of twin cities, two sisters fight on rival sides of a war between magic technologies and clashing convictions.',
  // Real TMDB artwork: the browser fetches it directly, so the preview shows
  // the blurred backdrop even though this sandbox has no outbound network.
  backdrop: 'https://image.tmdb.org/t/p/w1280/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg',
  seasons: [{ season_number: 1 }, { season_number: 2 }]
};

// Transparent wordmark standing in for the TMDB title logo (served by this
// mock at /mock/logo.svg; the player only accepts absolute http(s) URLs).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 210" width="640" height="210">
  <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9b9c2"/></linearGradient></defs>
  <text x="320" y="122" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-size="128" letter-spacing="6" fill="url(#g)" stroke="#111" stroke-width="3">MOCK SHOW</text>
  <text x="320" y="178" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="30" letter-spacing="18" fill="#e6e6e6">THE SERIES</text>
</svg>`;

// Artificial resolve latency so the connect screen can actually be seen.
const RESOLVE_DELAY_MS = Math.max(0, parseInt(process.env.RESOLVE_DELAY_MS || '1400', 10) || 0);

function publicOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || (String(host).includes('e2b.app') ? 'https' : 'http');
  return `${proto}://${host}`;
}

function episodesFor(season) {
  const count = season === 2 ? 4 : 6;
  return Array.from({ length: count }, (_, i) => ({
    episode: i + 1,
    season,
    title: season === 2 ? `Season Two, Part ${i + 1}` : ['Welcome to the Playground', 'Some Mysteries Are Better Left Unsolved', 'The Base Violence Necessary for Change', 'Happy Progress Day!', 'Everybody Wants to Be My Enemy', 'When These Walls Come Tumbling Down'][i],
    runtime: 40 + i,
    date: `2021-11-${String(6 + i).padStart(2, '0')}`,
    still: '',
    overview: i % 3 === 2 ? '' : 'Two sisters from the undercity find themselves on opposite sides of a brewing conflict. <b>Markup here must render as text.</b>'
  }));
}

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Big Buck Bunny &amp; friends
<i>second line of the cue</i>

00:00:05.000 --> 00:00:09.000
{\\an8}Subtitles are rendered by the player,
not by the browser.

00:00:12.000 --> 00:00:16.000
This cue arrives from the mock API.
`;

const HOST_DEMO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>LOL Embed - host control API demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; background: #0b0b0d; color: #e7e7ea; font: 13px/1.45 system-ui, sans-serif; }
  .wrap { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; padding: 14px; height: 100vh; box-sizing: border-box; }
  iframe { width: 100%; aspect-ratio: 16 / 9; border: 0; background: #000; border-radius: 10px; }
  .panel { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  button { background: #1d1e23; color: #f1f1f3; border: 1px solid #34363d; border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
  button:hover { background: #2a2c33; }
  input { background: #141518; color: inherit; border: 1px solid #34363d; border-radius: 8px; padding: 6px 8px; width: 72px; font: inherit; }
  .state { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; background: #141518; border-radius: 10px; padding: 10px; font-family: ui-monospace, monospace; font-size: 12px; }
  .state b { color: #9aa0a6; font-weight: 500; }
  #state-badge { font-weight: 700; }
  #state-badge[data-state="playing"] { color: #4ade80; }
  #state-badge[data-state="buffering"] { color: #facc15; }
  #state-badge[data-state="paused"], #state-badge[data-state="ready"] { color: #e7e7ea; }
  #state-badge[data-state="error"] { color: #f87171; }
  pre { flex: 1; margin: 0; overflow: auto; background: #141518; border-radius: 10px; padding: 10px; font-size: 11px; line-height: 1.4; min-height: 0; }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; height: auto; } pre { max-height: 40vh; } }
</style></head>
<body>
<div class="wrap">
  <div><iframe id="player" src="__EMBED_SRC__" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>
  <div class="panel">
    <div class="row">
      <button data-cmd="play">play</button>
      <button data-cmd="pause">pause</button>
      <button data-cmd="togglePlay">togglePlay</button>
      <button data-cmd="seekBy" data-args='{"delta":-15}'>-15s</button>
      <button data-cmd="seekBy" data-args='{"delta":15}'>+15s</button>
      <input id="seek-to" type="number" min="0" step="1" value="90" aria-label="seconds"><button id="seek-btn">seek</button>
      <button data-cmd="setMuted" data-args='{"muted":true}'>mute</button>
      <button data-cmd="setMuted" data-args='{"muted":false}'>unmute</button>
      <button data-cmd="setPlaybackRate" data-args='{"rate":1.5}'>1.5x</button>
      <button data-cmd="setPlaybackRate" data-args='{"rate":1}'>1x</button>
      <button data-cmd="setSubtitle" data-args='{"lang":"en"}'>subs en</button>
      <button data-cmd="setSubtitle" data-args='{"lang":"off"}'>subs off</button>
      <button data-cmd="setServer" data-args='{"server":"centaurus"}'>server 2</button>
      <button data-cmd="setServer" data-args='{"server":"andromeda"}'>server 1</button>
      <button data-cmd="nextEpisode">nextEpisode</button>
      <button data-cmd="skipSegment">skipSegment</button>
      <button data-cmd="setAutoSkip" data-args='{"enabled":true}'>autoskip on</button>
      <button data-cmd="getState">getState</button>
    </div>
    <div class="state">
      <b>state</b><span id="state-badge">-</span>
      <b>time</b><span id="s-time">-</span>
      <b>mediaDuration</b><span id="s-dur">-</span>
      <b>sourceId</b><span id="s-src">-</span>
      <b>episode</b><span id="s-ep">-</span>
      <b>last event</b><span id="s-ev">-</span>
    </div>
    <pre id="log"></pre>
  </div>
</div>
<script>
  const iframe = document.getElementById('player');
  const playerOrigin = location.origin;
  const log = document.getElementById('log');
  let seq = 0;
  const pending = new Map();
  function line(text) {
    log.textContent = (text + '\n' + log.textContent).slice(0, 20000);
  }
  function send(command, args = {}) {
    const requestId = 'req-' + (++seq);
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      iframe.contentWindow.postMessage({ type: 'LOL_EMBED_PLAYER_COMMAND', command, requestId, ...args }, playerOrigin);
    });
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.origin !== playerOrigin || !m || m.source !== 'lol-embed-player') return;
    if (m.type === 'LOL_EMBED_PLAYER_RESPONSE') {
      line('<- response ' + m.command + ' ok=' + m.ok + (m.error ? ' error=' + m.error : '') + ' state=' + m.state + ' t=' + (m.currentTime || 0).toFixed(1));
      const r = pending.get(m.requestId); if (r) { pending.delete(m.requestId); r(m); }
    }
    if (m.type === 'LOL_EMBED_PLAYER_EVENT') {
      if (m.event !== 'timeupdate') line('<- ' + m.event + (m.previousState ? ' (' + m.previousState + ' -> ' + m.state + ')' : '') + ' t=' + (m.currentTime || 0).toFixed(1));
      const badge = document.getElementById('state-badge');
      badge.textContent = m.state; badge.dataset.state = m.state;
      document.getElementById('s-time').textContent = (m.currentTime || 0).toFixed(1) + ' / ' + (m.duration || 0).toFixed(0);
      document.getElementById('s-dur').textContent = m.mediaDuration == null ? 'null (not known yet)' : m.mediaDuration.toFixed(2);
      document.getElementById('s-src').textContent = (m.sourceId || '-') + '  hash ' + (m.sourceHash || '-');
      document.getElementById('s-ep').textContent = m.mediaType === 'tv' ? 'S' + m.season + 'E' + m.episode : 'movie';
      document.getElementById('s-ev').textContent = m.event;
    }
  });
  document.querySelectorAll('button[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const args = btn.dataset.args ? JSON.parse(btn.dataset.args) : {};
      line('-> ' + btn.dataset.cmd + ' ' + JSON.stringify(args));
      send(btn.dataset.cmd, args);
    });
  });
  document.getElementById('seek-btn').addEventListener('click', () => {
    const time = Number(document.getElementById('seek-to').value);
    line('-> seek ' + time);
    send('seek', { time });
  });
</script>
</body></html>`;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function serveAsset(res, assetPath) {
  const filePath = path.normalize(path.join(PUBLIC_DIR, assetPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': ASSET_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  res.end(fs.readFileSync(filePath));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  const isEmbedRoute = pathname === '/embed' || /^\/(?:embed\/)?(?:movie|tv)\/[^/]+(?:\/\d+(?:\/\d+)?)?\/?$/i.test(pathname);
  if (isEmbedRoute) {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'embed.html'), 'utf8');
    html = html.replace('<!--LOL_EMBED_CONFIG-->', '<script>window.__LOL_EMBED_CONFIG__={"apiBaseUrl":""};</script>');
    // ADS=0 previews the globally ad-free page; dashboard exceptions apply per host site.
    if (process.env.ADS === '0' || adFreeDomains.has(callerSite(req, url))) {
      html = html.replace(/[ \t]*<!--LOL_EMBED_ADS-->[\s\S]*?<!--\/LOL_EMBED_ADS-->\n?/g, '');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': 'frame-ancestors *;'
    });
    res.end(html);
    return;
  }

  // Documentation + owner dashboard, served like the Worker does (same config
  // placeholder, same server list).
  const ownerPage = { '/docs': 'docs.html', '/documentation': 'docs.html', '/reze': 'reze.html' }[pathname.replace(/\/+$/, '') || '/'];
  if (ownerPage) {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, ownerPage), 'utf8');
    const config = { apiBaseUrl: '', adsEnabled: process.env.ADS !== '0', servers: SERVERS.map(({ id, name, badge }) => ({ id, name, badge })) };
    html = html.replace('<!--LOL_EMBED_CONFIG-->', `<script>window.__LOL_EMBED_CONFIG__=${JSON.stringify(config)};</script>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, brand: 'LOL Embed', runtime: 'player-mock', servers: SERVERS.map((s) => s.id) });
  }
  if (pathname === '/api/servers') {
    return json(res, 200, { ok: true, servers: SERVERS.map(({ id, name, badge, priority }) => ({ id, name, badge, priority })) });
  }

  if (pathname.startsWith('/api/admin/')) {
    const provided = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
    if (provided !== 'admin123') return json(res, 401, { ok: false, error: 'Unauthorized: Invalid Admin Key' });
    const adminPayload = () => ({
      ok: true,
      stats: { persistent: false, ...demoStats.snapshot({ limit: 25 }) },
      catalog: SERVERS.map(({ id, name, badge, priority }) => ({ id, name, badge, priority, enabled: true })),
      servers: SERVERS.map((s) => ({ ...s, status: s.id === 'centaurus' ? 'degraded' : 'online' })),
      adFreeDomains: Array.from(adFreeDomains).sort(),
      runtime: { startedAt: demoStats.startedAt, version: 'mock' }
    });
    if (pathname === '/api/admin/domains/ad-free' && req.method === 'GET') {
      return json(res, 200, { ok: true, adFreeDomains: Array.from(adFreeDomains).sort(), adsEnabled: process.env.ADS !== '0' });
    }
    if (pathname === '/api/admin/domains/ad-free' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        const domain = normalizeSiteDomain(parsed.domain);
        if (!domain || typeof parsed.adFree !== 'boolean') return json(res, 400, { ok: false, error: 'domain and boolean adFree are required' });
        if (parsed.adFree) adFreeDomains.add(domain);
        else adFreeDomains.delete(domain);
        json(res, 200, { ok: true, domain, adFree: parsed.adFree, adFreeDomains: Array.from(adFreeDomains).sort() });
      });
      return;
    }
    if (pathname === '/api/admin/stats' && req.method === 'GET') return json(res, 200, adminPayload());
    if (pathname === '/api/admin/stats/reset' && req.method === 'POST') {
      demoStats.reset();
      return json(res, 200, adminPayload());
    }
    if (pathname === '/api/admin/probe' && req.method === 'POST') {
      return json(res, 200, { ok: true, probeResults: SERVERS.map((s) => ({ serverId: s.id, ok: s.id !== 'centaurus', latencyMs: 120 })) });
    }
    if (pathname === '/api/admin/domains/block' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch {}
        if (!demoStats.setBlocked(parsed.domain, parsed.blocked !== false)) return json(res, 400, { ok: false, error: 'domain is required' });
        json(res, 200, { ok: true, blockedDomains: demoStats.blockedDomains() });
      });
      return;
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  }

  if (pathname === '/host') {
    // Host-page demo for the postMessage control API (README: "Host control API").
    const embedSrc = `/embed?type=tv&tmdb=94605&s=1&e=1&origin=${encodeURIComponent(publicOrigin(req))}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(HOST_DEMO_HTML.replace('__EMBED_SRC__', embedSrc));
    return;
  }

  if (pathname === '/meta-image.gif') return serveAsset(res, 'lol-embed-meta.gif');
  if (pathname === '/mock/logo.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    res.end(LOGO_SVG);
    return;
  }
  if (/^\/(css|js|vendor)\//.test(pathname)) return serveAsset(res, pathname.slice(1));

  const apiMatch = pathname.match(/^\/api\/(info|resolve)\/(movie|tv)\/([^/]+)$/i);
  if (apiMatch) {
    const [, action, type, tmdbId] = apiMatch;
    const season = parseInt(url.searchParams.get('season') || '1', 10) || 1;
    const episode = parseInt(url.searchParams.get('episode') || '1', 10) || 1;
    const isTv = type === 'tv';
    const metadata = {
      ...SHOW,
      type,
      tmdbId,
      title: isTv ? SHOW.title : 'Mock Movie',
      // `?nologo=1` previews the text fallback of the connect / paused screens.
      logo: url.searchParams.get('nologo') ? null : `${publicOrigin(req)}/mock/logo.svg`,
      season,
      episode,
      seasons: isTv ? SHOW.seasons : [],
      episodes: isTv ? episodesFor(season) : []
    };
    // Same shape the real resolvers emit (see src/services/skipSegments.js);
    // the credits segment is open-ended on purpose (`end: null` = media end).
    const segments = [
      { type: 'recap', start: 0, end: 8, label: 'Skip Recap', source: 'theintrodb' },
      { type: 'intro', start: 20, end: 60, label: 'Skip Intro', source: 'theintrodb' },
      { type: 'outro', start: 560, end: null, label: 'Next Episode', source: 'theintrodb' }
    ];

    if (action === 'info') return json(res, 200, { ok: true, metadata, segments, servers: SERVERS });

    const requested = (url.searchParams.get('server') || 'andromeda').toLowerCase();
    const everythingFails = tmdbId === '0';
    const serverFails = everythingFails || requested === 'centaurus';
    const servers = SERVERS.map((s) => ({ ...s, active: !serverFails && s.id === requested }));

    // `/api/resolve` answers after a short delay so the connect screen's
    // phases (resolving -> source picked -> playable) are visible.
    const respond = (status, body) => setTimeout(() => json(res, status, body), RESOLVE_DELAY_MS);

    if (serverFails) {
      return respond(everythingFails ? 502 : 200, {
        ok: false,
        error: everythingFails ? 'All upstream servers failed for this title.' : 'Gigachad Node has no source for this title.',
        explanation: 'HiCine search returned no quality ladder',
        requestedServer: requested,
        serverExplanation: everythingFails ? 'Every configured server was tried.' : 'Pick Fiber Optic Speedrun or wait for the automatic failover.',
        metadata,
        segments,
        subtitles: [],
        servers
      });
    }

    return respond(200, {
      ok: true,
      metadata,
      segments,
      subtitles: [
        { id: 'os-1', lang: 'en', label: 'English', format: 'vtt', url: '/api/subtitles/proxy?lang=en' },
        { id: 'os-2', lang: 'ar', label: 'العربية', format: 'vtt', url: '/api/subtitles/proxy?lang=ar' },
        { id: 'os-3', lang: 'hi', label: 'हिन्दी', format: 'vtt', url: '/api/subtitles/proxy?lang=hi' }
      ],
      servers,
      stream: {
        server: requested,
        format: 'hls',
        streamUrl: DEMO_HLS,
        backupUrls: [DEMO_MP4],
        audioTracks: [{ id: 'en-dub', lang: 'en', label: 'English (Original)', default: true, streamUrl: DEMO_HLS }],
        activeAudioTrack: { id: 'en-dub' },
        qualities: [
          { label: 'Auto' },
          { label: '1080p', height: 1080, url: DEMO_HLS },
          { label: '720p', height: 720, url: DEMO_HLS },
          { label: '480p', height: 480, url: DEMO_HLS }
        ]
      }
    });
  }

  if (pathname === '/api/subtitles/proxy') {
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(VTT);
    return;
  }

  if (pathname === '/') {
    return json(res, 200, { ok: true, service: 'LOL Embed player mock', embed: '/embed?type=tv&tmdb=94605&s=1&e=1' });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[LOL Embed Player mock] http://${HOST}:${PORT}/embed?type=tv&tmdb=94605&s=1&e=1`);
});
