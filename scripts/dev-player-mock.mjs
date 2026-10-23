// Local end-to-end harness for the /embed player (Goldmine / movi-player era).
//
// One process, three faces:
//
//   1. http://0.0.0.0:8790 — serves `public/` (player page + assets, ads
//      stripped by default) and mounts the REAL backend app (src/server.js),
//      so /api/resolve, the waterfall, the Goldmine resolver, /api/proxy and
//      the telemetry all run exactly as in production.
//
//   2. Mock upstreams (so no internet/keys are needed):
//        /mock/tmdb/3/...          tiny TMDB v3 stand-in (metadata fixtures)
//        /mock/tmdb-embed-api/...  tiny TMDB-Embed-API stand-in answering
//                                  /api/streams/... with provider-shaped JSON
//        /mock/introdb/v3/media    skip-segment fixture (intro + credits)
//
//   3. http://127.0.0.1:8791 — the fixture "CDN": small generated multi-audio
//      MKV/MP4 files + a VTT, served with HTTP Range support (what the
//      movi-player engine and the stream proxy need). Generated on first
//      start with @ffmpeg-installer/ffmpeg into scripts/.mock-media/
//      (gitignored).
//
// Run:
//   npm run dev:player        (or: node scripts/dev-player-mock.mjs)
//   http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1
//
// Useful URLs:
//   /embed?type=tv&tmdb=94605&s=1&e=1           Goldmine MKV via movi-player,
//                                               dub-language chips (English /
//                                               Hindi / Tamil), skip segments,
//                                               embedded subtitle fixture
//   /embed?type=tv&tmdb=94605&s=1&e=1&lang=ta   Tamil preselected
//   /embed?type=tv&tmdb=94605&s=1&e=1&source=vidlink   pinned provider
//   /embed?type=movie&tmdb=693134               movie fixture
//   /embed?type=movie&tmdb=0                    every source empty -> error screen
//   /host                                       iframe host demo (postMessage API)
//   /reze?key=admin123                          owner dashboard (real backend)
//   /docs                                       public documentation page
//   ADS=1 node scripts/dev-player-mock.mjs      serve the popunder ad tag too

import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = parseInt(process.env.PLAYER_PORT || '8790', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MEDIA_PORT = parseInt(process.env.PLAYER_MEDIA_PORT || '8791', 10);
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_DIR = path.join(ROOT, 'scripts', '.mock-media');
const STRIP_ADS = String(process.env.ADS || '0') !== '1';

const MOCK_ORIGIN = `http://127.0.0.1:${PORT}`;
const CDN_ORIGIN = `http://127.0.0.1:${MEDIA_PORT}`;

// ---------------------------------------------------------------------------
// 1. Point the REAL backend at the mocks BEFORE the app caches the config.
//    src/config.js exports a plain object and every service reads it at call
//    time, so mutating it here reroutes TMDB, the Goldmine API, skip segments
//    and subtitle lookups into this process.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const config = require(path.join(ROOT, 'src', 'config.js'));
config.tmdbBaseUrl = `${MOCK_ORIGIN}/mock/tmdb/3`;
config.goldmine.apiBase = `${MOCK_ORIGIN}/mock/tmdb-embed-api`;
config.upstreams.theIntroDbUrl = `${MOCK_ORIGIN}/mock/introdb/v3`;
// Fail the optional lookups fast and locally instead of hitting the internet.
config.upstreams.introDbUrl = `${MOCK_ORIGIN}/mock/disabled`;
config.upstreams.aniSkipUrl = `${MOCK_ORIGIN}/mock/disabled`;
config.upstreams.wyzieSubsUrl = `${MOCK_ORIGIN}/mock/disabled`;
config.upstreams.openSubtitlesStremioUrl = `${MOCK_ORIGIN}/mock/disabled`;
config.upstreams.subdlApiUrl = `${MOCK_ORIGIN}/mock/disabled`;
config.upstreams.subdlDownloadUrl = `${MOCK_ORIGIN}/mock/disabled`;
config.upstreams.cinemetaUrl = `${MOCK_ORIGIN}/mock/disabled`;
const backendApp = require(path.join(ROOT, 'src', 'server.js'));

// ---------------------------------------------------------------------------
// 2. Media fixtures (generated once with ffmpeg; tiny: 640x360, 16 s).
// ---------------------------------------------------------------------------
const FIXTURE_FILES = ['arcane-multi.mkv', 'arcane-hin.mkv', 'arcane-mp4.mp4', 'arcane-eng.vtt'];

const VTT_FIXTURE = `WEBVTT

00:00:01.000 --> 00:00:04.500
[mock subtitle] This VTT came from the Goldmine
provider payload (embeddedSubtitles).

00:00:05.000 --> 00:00:09.000
It is served by the fixture CDN, wrapped in the
backend stream proxy, and merged into the popover.

00:00:10.000 --> 00:00:15.000
Multi-audio MKV playback runs through movi-player
(WebCodecs + FFmpeg WASM) — switch dubs with the chips.
`;

function ffmpegBin() {
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch (_) {
    return process.env.FFMPEG_PATH || 'ffmpeg';
  }
}

function runFfmpeg(args, label) {
  const res = spawnSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (res.status !== 0) {
    const err = String(res.stderr || '').slice(0, 500);
    throw new Error(`ffmpeg failed for ${label}: ${err || `exit ${res.status}`}`);
  }
  console.log(`[fixtures] generated ${label}`);
}

function ensureFixtures() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const missing = FIXTURE_FILES.filter((name) => !fs.existsSync(path.join(MEDIA_DIR, name)));
  if (missing.length === 0) return;

  const dur = 16;
  const video = ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${dur}`];
  const vcodec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-pix_fmt', 'yuv420p'];
  const acodec = ['-c:a', 'aac', '-b:a', '48k'];
  const sine = (freq) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`];

  console.log('[fixtures] generating multi-audio MKVs with ffmpeg (first start only)...');

  // Main fixture: one MKV with THREE tagged dub tracks (eng/hin/tam) — this is
  // what movi-player switches in place via selectAudioLang().
  runFfmpeg(
    [
      ...video, ...sine(440), ...sine(660), ...sine(880),
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
      ...vcodec, ...acodec,
      '-metadata', 'title=Arcane S01E01 Multi-Audio Fixture',
      '-metadata:s:a:0', 'language=eng',
      '-metadata:s:a:1', 'language=hin',
      '-metadata:s:a:2', 'language=tam',
      path.join(MEDIA_DIR, 'arcane-multi.mkv')
    ],
    'arcane-multi.mkv (3 dubs: eng/hin/tam)'
  );

  // A per-language file (Hindi only): picking that chip swaps the src and
  // keeps the playhead, exactly like the real per-dub provider files.
  runFfmpeg(
    [
      ...video, ...sine(660),
      '-map', '0:v', '-map', '1:a',
      ...vcodec, ...acodec,
      '-metadata', 'title=Arcane S01E01 Hindi Dub Fixture',
      '-metadata:s:a:0', 'language=hin',
      path.join(MEDIA_DIR, 'arcane-hin.mkv')
    ],
    'arcane-hin.mkv (hindi dub file)'
  );

  // An MP4 source from a second "provider" (4khdhub-style filename hints).
  runFfmpeg(
    [
      ...video, ...sine(440),
      '-map', '0:v', '-map', '1:a',
      ...vcodec, ...acodec,
      '-movflags', '+faststart',
      '-metadata', 'title=Arcane S01E01 MP4 Fixture',
      path.join(MEDIA_DIR, 'arcane-mp4.mp4')
    ],
    'arcane-mp4.mp4'
  );

  fs.writeFileSync(path.join(MEDIA_DIR, 'arcane-eng.vtt'), VTT_FIXTURE, 'utf8');
  console.log('[fixtures] generated arcane-eng.vtt');
}

// ---------------------------------------------------------------------------
// 3. Fixture CDN (127.0.0.1 only) — files WITH HTTP Range support.
// ---------------------------------------------------------------------------
const MEDIA_TYPES = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8'
};

const mediaServer = http.createServer((req, res) => {
  const url = new URL(req.url, CDN_ORIGIN);
  const match = url.pathname.match(/^\/files\/([a-z0-9._-]+)$/i);
  if (!match || !FIXTURE_FILES.includes(match[1])) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const file = path.join(MEDIA_DIR, match[1]);
  const stat = fs.statSync(file);
  const type = MEDIA_TYPES[path.extname(file)] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600'
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : Math.max(0, stat.size - parseInt(range[2], 10));
    let end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': String(end - start + 1)
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------------------
// 4. Mock upstreams: TMDB v3, TMDB-Embed-API, TheIntroDB.
// ---------------------------------------------------------------------------
const ARCANE_EPISODES = [
  'Welcome to the Playground',
  'Some Mysteries Are Better Left Unsolved',
  'The Base Violence Necessary for Change',
  'Happy Progress Day!',
  'Everybody Wants to Be My Enemy',
  'When These Walls Crumble',
  'The Boy Savior',
  'Oil and Water',
  'The Monster You Created'
];

function tmdbTvDetails(id) {
  return {
    id: Number(id) || 94605,
    name: 'Arcane',
    original_name: 'Arcane',
    first_air_date: '2021-11-06',
    status: 'Returning Series',
    tagline: 'The future is what you make of it.',
    overview:
      'Amid the stark disparity of Piltover and the undercity of Zaun, two sisters fight on ' +
      'opposite sides of a war between magic technologies and clashing convictions.',
    genres: [
      { id: 16, name: 'Animation' },
      { id: 18, name: 'Drama' },
      { id: 10765, name: 'Sci-Fi & Fantasy' }
    ],
    episode_run_time: [25],
    vote_average: 8.7,
    poster_path: null,
    backdrop_path: null,
    external_ids: { imdb_id: 'tt11126994', tvdb_id: 4081139 },
    alternative_titles: { results: [] },
    images: { logos: { results: [] }, backdrops: { results: [] }, posters: { results: [] } },
    seasons: [
      { season_number: 1, name: 'Season 1', episode_count: 9, air_date: '2021-11-06' },
      { season_number: 2, name: 'Season 2', episode_count: 9, air_date: '2024-11-09' }
    ],
    number_of_seasons: 2
  };
}

function tmdbMovieDetails(id) {
  return {
    id: Number(id) || 693134,
    title: 'Dune: Part Two',
    original_title: 'Dune: Part Two',
    release_date: '2024-02-27',
    runtime: 167,
    status: 'Released',
    tagline: 'Long live the fighters.',
    overview:
      'Paul Atreides unites with Chani and the Fremen while seeking revenge against the ' +
      'conspirators who destroyed his family.',
    genres: [
      { id: 878, name: 'Science Fiction' },
      { id: 12, name: 'Adventure' }
    ],
    vote_average: 8.1,
    poster_path: null,
    backdrop_path: null,
    external_ids: { imdb_id: 'tt15239678' },
    alternative_titles: { results: [] },
    images: { logos: { results: [] }, backdrops: { results: [] }, posters: { results: [] } }
  };
}

function tmdbSeason(id, season) {
  const sNum = parseInt(season, 10) || 1;
  return {
    id: 100000 + sNum,
    season_number: sNum,
    name: `Season ${sNum}`,
    air_date: sNum === 1 ? '2021-11-06' : '2024-11-09',
    overview: '',
    episodes: ARCANE_EPISODES.map((name, idx) => ({
      id: 2000000 + sNum * 100 + idx,
      episode_number: idx + 1,
      season_number: sNum,
      name,
      overview: `Mock episode ${idx + 1} of season ${sNum}.`,
      air_date: sNum === 1 ? '2021-11-06' : '2024-11-09',
      runtime: 25,
      still_path: null,
      vote_average: 8.5
    }))
  };
}

function goldmineFixtureStreams() {
  // Mirrors the real provider response shapes (grepped from the TMDB-Embed-API
  // provider sources): { name, title, url, quality, provider, headers?, subtitles? }.
  return [
    {
      // Showbox/Dahmer-style: multi-audio MKV, languages named in the title,
      // plus an external subtitle file.
      name: 'Arcane S01E01 - Multi Audio',
      title: 'Arcane.S01E01.1080p.Multi.Audio.English.Hindi.Tamil.MKV',
      url: `${CDN_ORIGIN}/files/arcane-multi.mkv`,
      quality: '1080',
      provider: 'mockbox',
      subtitles: [{ url: `${CDN_ORIGIN}/files/arcane-eng.vtt`, lang: 'English', id: 'sub-en' }]
    },
    {
      // Per-language file from the same provider (Hindi-only 720p dub).
      name: 'Arcane S01E01 - Hindi',
      title: 'Arcane.S01E01.720p.Hindi.DUB.MKV',
      url: `${CDN_ORIGIN}/files/arcane-hin.mkv`,
      quality: '720',
      provider: 'mockbox'
    },
    {
      // 4khdhub-style: language info only in the release filename tags.
      name: '4KHDHub - FSL Server1080p',
      title: 'Arcane.S01E01.1080p.WEB-DL.HIN.TAM.DUB.x264',
      url: `${CDN_ORIGIN}/files/arcane-mp4.mp4`,
      quality: '1080',
      provider: '4khdhub',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    },
    {
      // Vidlink-style: Referer-gated direct file, no language info at all.
      name: 'Vidlink - 1080p',
      title: 'Vidlink - 1080p',
      url: `${CDN_ORIGIN}/files/arcane-multi.mkv`,
      quality: '1080',
      provider: 'vidlink',
      headers: { Referer: 'https://vidlink.pro' }
    }
  ];
}

const MOCK_PROVIDERS = ['mockbox', '4khdhub', 'vidlink'];

function goldmineStreamsPayload(url) {
  const parts = url.pathname.split('/').filter(Boolean); // mock tmdb-embed-api api streams ...
  // /api/streams/:type/:tmdbId  or  /api/streams/:provider/:type/:tmdbId
  const tail = parts.slice(parts.indexOf('streams') + 1);
  let provider = '';
  let type = '';
  let tmdbId = '';
  if (tail.length === 2) {
    [type, tmdbId] = tail;
  } else if (tail.length === 3) {
    [provider, type, tmdbId] = tail;
    if (!MOCK_PROVIDERS.includes(provider)) {
      return { status: 404, body: { success: false, error: 'PROVIDER_NOT_FOUND' } };
    }
  } else {
    return { status: 404, body: { success: false, error: 'NOT_FOUND' } };
  }
  if (!['movie', 'series'].includes(type)) {
    return { status: 400, body: { success: false, error: 'INVALID_TYPE' } };
  }
  // tmdbId 0 = the "nothing anywhere" demo (player error screen).
  const streams = tmdbId === '0' ? [] : goldmineFixtureStreams().filter((s) => !provider || s.provider === provider);
  return {
    status: 200,
    body: {
      success: true,
      tmdbId,
      imdbId: type === 'series' ? 'tt11126994' : 'tt15239678',
      count: streams.length,
      providerTimings: { mock: 12 },
      streams
    }
  };
}

function handleMock(req, res, url) {
  const p = url.pathname;
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };

  if (p.startsWith('/mock/tmdb/3/')) {
    const rel = p.replace('/mock/tmdb/3/', '');
    const find = rel.match(/^find\/(.+)$/);
    if (find) return json(200, { movie_results: [], tv_results: [] });
    const season = rel.match(/^tv\/([^/]+)\/season\/(\d+)$/);
    if (season) return json(200, tmdbSeason(season[1], season[2]));
    const tv = rel.match(/^tv\/([^/]+)$/);
    if (tv) {
      if (tv[1] === '0') return json(404, { status_code: 34, status_message: 'The resource you requested could not be found.' });
      return json(200, tmdbTvDetails(tv[1]));
    }
    const movie = rel.match(/^movie\/([^/]+)$/);
    if (movie) {
      if (movie[1] === '0') return json(404, { status_code: 34, status_message: 'The resource you requested could not be found.' });
      return json(200, tmdbMovieDetails(movie[1]));
    }
    return json(404, { status_code: 34, status_message: 'The resource you requested could not be found.' });
  }

  if (p.startsWith('/mock/tmdb-embed-api/')) {
    if (p === '/mock/tmdb-embed-api/api/health') return json(200, { ok: true, service: 'tmdb-embed-api', mock: true });
    if (p === '/mock/tmdb-embed-api/api/providers') {
      return json(200, {
        success: true,
        providers: MOCK_PROVIDERS.map((id) => ({ id, name: id, enabled: true }))
      });
    }
    if (p === '/mock/tmdb-embed-api/api/config') {
      return json(200, { success: true, config: { mock: true, enableProxy: false, defaultProviders: [] } });
    }
    if (p.startsWith('/mock/tmdb-embed-api/api/streams/')) {
      const out = goldmineStreamsPayload(url);
      return json(out.status, out.body);
    }
    return json(404, { success: false, error: 'NOT_FOUND' });
  }

  if (p.startsWith('/mock/introdb/v3/')) {
    // TheIntroDB shape: { intro|recap|credits|preview: [{ start_sec, end_sec }] }.
    // Timings sit inside the 16 s fixture so the skip buttons actually appear.
    return json(200, {
      intro: [{ start_sec: 1, end_sec: 7, confidence: 0.95 }],
      credits: [{ start_sec: 10, end_sec: 16, confidence: 0.9 }]
    });
  }

  if (p.startsWith('/mock/disabled')) return json(404, { error: 'disabled in mock mode' });

  return json(404, { error: 'unknown mock route' });
}

// ---------------------------------------------------------------------------
// 5. Static player assets + the /embed, /host, /reze, /docs pages.
// ---------------------------------------------------------------------------
const ASSET_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.vtt': 'text/vtt; charset=utf-8'
};

const AD_BLOCK_RE = /<!--LOL_EMBED_ADS-->[\s\S]*?<!--\/LOL_EMBED_ADS-->/g;

function serveFile(res, filePath, { stripAds = false } = {}) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = ASSET_TYPES[ext] || 'application/octet-stream';
  if (stripAds && ext === '.html') {
    body = Buffer.from(String(body).replace(AD_BLOCK_RE, ''), 'utf8');
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(body.length),
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
  });
  res.end(body);
}

const HOST_DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LOL Embed — host demo</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0e0e11; color: #eee; }
    header { padding: 14px 18px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    header strong { margin-right: auto; }
    button { background: #1e1e24; color: #eee; border: 1px solid #333; border-radius: 8px; padding: 7px 12px; cursor: pointer; }
    button:hover { border-color: #666; }
    .wrap { aspect-ratio: 16 / 9; max-width: 1100px; margin: 0 auto 16px; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #000; border-radius: 10px; }
    #log { max-width: 1100px; margin: 0 auto; padding: 0 18px 24px; font: 12px/1.5 ui-monospace, monospace; color: #9ad; max-height: 220px; overflow: auto; }
    #log div { border-bottom: 1px solid #1b1b20; padding: 3px 0; }
  </style>
</head>
<body>
  <header>
    <strong>Host page — the player in an iframe + the postMessage control API</strong>
    <button data-cmd="play">play</button>
    <button data-cmd="pause">pause</button>
    <button data-cmd="setAudio" data-arg="hi">audio: Hindi</button>
    <button data-cmd="setAudio" data-arg="ta">audio: Tamil</button>
    <button data-cmd="nextEpisode">next episode</button>
  </header>
  <div class="wrap"><iframe id="player" src="__EMBED_SRC__" allowfullscreen allow="autoplay; fullscreen; picture-in-picture"></iframe></div>
  <div id="log"></div>
  <script>
    const frame = document.getElementById('player');
    const log = document.getElementById('log');
    window.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.source !== 'lol-embed-player') return;
      const row = document.createElement('div');
      row.textContent = (d.event || d.type || 'message') + ' — ' + JSON.stringify({ state: d.state, t: d.currentTime && Math.round(d.currentTime), server: d.server, audio: d.audio && d.audio.label });
      log.prepend(row);
      while (log.children.length > 60) log.lastChild.remove();
    });
    document.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        frame.contentWindow.postMessage({
          source: 'lol-embed-host',
          type: 'LOL_EMBED_PLAYER_COMMAND',
          command: btn.dataset.cmd,
          value: btn.dataset.arg || undefined
        }, '*');
      });
    });
  </script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// 6. Main server: mocks + static first, then the REAL backend app.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  const p = url.pathname;

  if (p.startsWith('/mock/')) return handleMock(req, res, url);

  if (p === '/embed' || p.startsWith('/embed/')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'embed.html'), { stripAds: STRIP_ADS });
  }
  if (p === '/host') {
    const embedSrc = '/embed?type=tv&tmdb=94605&s=1&e=1&origin=' + encodeURIComponent(url.origin);
    const body = Buffer.from(HOST_DEMO_HTML.replace('__EMBED_SRC__', embedSrc), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) });
    return res.end(body);
  }
  if (p === '/reze') return serveFile(res, path.join(PUBLIC_DIR, 'reze.html'));
  if (p === '/docs' || p === '/documentation') return serveFile(res, path.join(PUBLIC_DIR, 'docs.html'));

  // Static assets from public/ (css/js/vendor incl. the movi-player bundle).
  if (p !== '/' && !p.startsWith('/api/')) {
    const rel = p.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveFile(res, filePath);
    }
  }

  // Everything else (/api/*, /, /meta-image.gif, 404 JSON) is the REAL backend.
  backendApp(req, res);
});

ensureFixtures();
mediaServer.listen(MEDIA_PORT, '127.0.0.1', () => {
  console.log(`[fixtures CDN] http://127.0.0.1:${MEDIA_PORT}/files/...`);
});
server.listen(PORT, HOST, () => {
  console.log(`[LOL Embed dev harness] http://${HOST}:${PORT}/embed?type=tv&tmdb=94605&s=1&e=1`);
  console.log(`[LOL Embed dev harness] goldmine apiBase -> ${config.goldmine.apiBase}`);
});
