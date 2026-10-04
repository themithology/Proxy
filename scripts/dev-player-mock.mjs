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
//
// Useful URLs:
//   /embed?type=tv&tmdb=94605&s=1&e=1                 happy path (recap + intro + open-ended credits segments, subtitles)
//   /embed?type=tv&tmdb=94605&s=1&e=1&server=centaurus  server 2 fails -> automatic failover toast
//   /embed?type=movie&tmdb=693134                     movie (no episodes UI)
//   /embed?type=movie&tmdb=0                          every server fails -> error state with Retry
//   /embed?type=tv&tmdb=94605&s=1&e=1&color=e50914    accent override (contrast-aware pills)

import http from 'http';
import fs from 'fs';
import path from 'path';

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
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': 'frame-ancestors *;'
    });
    res.end(html);
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
