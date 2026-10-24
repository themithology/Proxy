// This suite is hermetic: every upstream (TMDB, the Goldmine TMDB-Embed-API,
// skip-segment providers, subtitle sources) is mocked locally, so neither the
// Node backend nor the Cloudflare Worker ever touches the internet here.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const config = require('../src/config');
const { app } = require('../src/server');
const {
  signProxyParams,
  verifyProxySignature,
  generateHandshakeToken,
  verifyHandshakeToken
} = require('../src/utils/crypto');
const { srtToVtt } = require('../src/utils/srtToVtt');
const { rewriteM3u8Manifest } = require('../src/services/proxy');
const { applyPreferredAudio } = require('../src/services/resolver');
const goldmineSvc = require('../src/services/goldmine');
const languagesSvc = require('../src/services/languages');


/** Provider-shaped TMDB-Embed-API fixture streams (mirrors the real provider
 *  response shapes: name/title/url/quality/provider/headers?/subtitles?). */
function goldmineFixtureStreams(cdnOrigin) {
  return [
    {
      // Showbox/Dahmer-style: multi-audio MKV, languages named in the title,
      // plus an external subtitle file.
      name: 'Arcane S01E01 - Multi Audio',
      title: 'Arcane.S01E01.1080p.Multi.Audio.English.Hindi.Tamil.MKV',
      url: `${cdnOrigin}/cdn/files/arcane-multi.mkv`,
      quality: '1080',
      provider: 'mockbox',
      subtitles: [{ url: `${cdnOrigin}/cdn/files/arcane-eng.vtt`, lang: 'English', id: 'sub-en' }]
    },
    {
      // Per-language file from the same provider (Hindi-only 720p dub).
      name: 'Arcane S01E01 - Hindi',
      title: 'Arcane.S01E01.720p.Hindi.DUB.MKV',
      url: `${cdnOrigin}/cdn/files/arcane-hin.mkv`,
      quality: '720',
      provider: 'mockbox'
    },
    {
      // 4khdhub-style: language info only in the release filename tags.
      name: '4KHDHub - FSL Server1080p',
      title: 'Arcane.S01E01.1080p.WEB-DL.HIN.TAM.DUB.x264',
      url: `${cdnOrigin}/cdn/files/arcane-mp4.mp4`,
      quality: '1080',
      provider: '4khdhub',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    },
    {
      // Vidlink-style: Referer-gated direct file, no language info at all.
      name: 'Vidlink - 1080p',
      title: 'Vidlink - 1080p',
      url: `${cdnOrigin}/cdn/files/arcane-multi.mkv`,
      quality: '1080',
      provider: 'vidlink',
      headers: { Referer: 'https://vidlink.pro' }
    },
    {
      // External header-gated CDN (never fetched by the suite — used for the
      // proxy-wrapping + header-splitting assertions).
      name: 'External CDN copy',
      title: 'Arcane.S01E01.1080p.MKV',
      url: 'https://cdn.external.example/files/arcane-ext.mkv',
      quality: '1080',
      provider: 'mockbox',
      headers: { Referer: 'https://gate.example', 'X-Api-Key': 'secret-key' }
    }
  ];
}

function httpRequest(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // non-JSON response
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function verifyPayloadLinksOneByOne(label, payload, requestLink) {
  const links = Array.from(new Set([
    payload?.streamUrl,
    payload?.rawUrl,
    ...(Array.isArray(payload?.qualities) ? payload.qualities.map((quality) => quality && quality.url) : []),
    ...(Array.isArray(payload?.backupUrls) ? payload.backupUrls : []),
    ...(Array.isArray(payload?.audioTracks)
      ? payload.audioTracks.flatMap((track) => [track && track.streamUrl, track && track.rawUrl])
      : [])
  ].filter((url) => typeof url === 'string' && url)));
  assert.ok(links.length > 0, `${label} must expose quality or backup URLs`);

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const response = await requestLink(link);
    assert.ok(
      [200, 206].includes(response.status),
      `${label} candidate ${index + 1}/${links.length} failed (${response.status}): ${link}`
    );
    const contentType = typeof response.headers?.get === 'function'
      ? response.headers.get('content-type') || ''
      : response.headers?.['content-type'] || '';
    assert.ok(
      !/text\/html|application\/(?:json|xhtml\+xml)/i.test(contentType),
      `${label} candidate ${index + 1}/${links.length} returned ${contentType || 'an unknown content type'}: ${link}`
    );
    console.log(`    ✔ ${label} candidate ${index + 1}/${links.length}: ${response.status} ${new URL(link, 'http://player.test').pathname}`);
    try { await response.body?.cancel?.(); } catch {}
  }
}

/**
 * Create a local upstream simulation server that speaks the exact wire protocols of:
 * - TMDB v3 API (/tv/:id, /tv/:id/season/:s, /movie/:id)
 * - IntroDB (/intro?imdb_id=...)
 * - OpenSubtitles Stremio v3 addon + .srt.gz / .zip subtitle downloads
 * - TMDB-Embed-API (/goldmine/api/streams/...) + its fixture file CDN
 */
function startUpstreamMockServer() {
  return new Promise((resolve) => {
    let goldmineHits = 0;
    const mockSrv = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const mockOrigin = `http://${req.headers.host}`;

      // 0. TMDB /find — IMDb id translation (movie + tv fixtures)
      if (u.pathname === '/tmdb/find/tt15239678') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ movie_results: [{ id: 693134, title: 'Dune: Part Two' }], tv_results: [] }));
      }
      if (u.pathname === '/tmdb/find/tt11126994') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ movie_results: [], tv_results: [{ id: 94605, name: 'Arcane' }] }));
      }

      // 1. TMDB v3 TV Details
      if (u.pathname === '/tmdb/tv/94605') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 94605,
            name: 'Arcane',
            original_name: 'Arcane',
            first_air_date: '2021-11-06',
            episode_run_time: [42],
            genres: [{ id: 16, name: 'Animation' }, { id: 10765, name: 'Sci-Fi & Fantasy' }],
            overview: 'Amid the stark discord of twin cities Piltover and Zaun, two sisters fight on rival sides.',
            backdrop_path: '/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg',
            poster_path: '/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg',
            tagline: 'The future of the city is in their hands.',
            vote_average: 8.746,
            vote_count: 5134,
            // `images` is only present when the backend asked for it with
            // include_image_language=en,null (the player's logo artwork).
            images: u.searchParams.get('append_to_response')?.includes('images') && u.searchParams.get('include_image_language') === 'en,null'
              ? {
                  logos: [
                    { file_path: '/arcane-fr.png', iso_639_1: 'fr', vote_average: 9 },
                    { file_path: '/arcane-en.svg', iso_639_1: 'en', vote_average: 6 },
                    { file_path: '/arcane-en.png', iso_639_1: 'en', vote_average: 5.3 },
                    { file_path: '/arcane-null.png', iso_639_1: null, vote_average: 7 }
                  ]
                }
              : undefined,
            external_ids: { imdb_id: 'tt11126994', tvdb_id: 371028 },
            seasons: [
              { season_number: 1, name: 'Season 1', episode_count: 9 },
              { season_number: 2, name: 'Season 2', episode_count: 9 }
            ]
          })
        );
      }

      // 2. TMDB v3 TV Season Details
      if (u.pathname === '/tmdb/tv/94605/season/1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            episodes: [
              {
                episode_number: 1,
                name: 'Welcome to the Playground',
                runtime: 43,
                air_date: '2021-11-06',
                still_path: '/g5a3J6E9V0lU1fB8z2iC7xH9wQ4.jpg',
                overview: 'Orphaned sisters Vi and Powder bring trouble to Zaun.'
              },
              {
                episode_number: 2,
                name: 'Some Mysteries Are Better Left Unsolved',
                runtime: 40,
                air_date: '2021-11-06',
                still_path: '/xYz987.jpg',
                overview: 'Idealistic inventor Jayce attempts to harness magic.'
              }
            ]
          })
        );
      }

      // Extra TMDB metadata fixture used by the worker resolve tests.
      if (u.pathname === '/tmdb/movie/550') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 550,
            title: 'Fight Club',
            original_title: 'Fight Club',
            release_date: '1999-10-15',
            runtime: 139,
            genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }],
            imdb_id: 'tt0137523',
            external_ids: { imdb_id: 'tt0137523' },
            alternative_titles: { titles: [{ title: 'Fight Club' }, { title: 'Fight Club (1999)' }] }
          })
        );
      }

      // 3. TMDB v3 Movie Details
      if (u.pathname === '/tmdb/movie/693134') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 693134,
            title: 'Dune: Part Two',
            release_date: '2024-02-27',
            runtime: 167,
            genres: [{ id: 878, name: 'Science Fiction' }],
            imdb_id: 'tt15239678',
            external_ids: { imdb_id: 'tt15239678' }
          })
        );
      }

      // 4a. TheIntroDB v3 (TMDB-keyed). Real shape: arrays per type with
      // millisecond boundaries; `end_ms: null` means "until the end"; 404 when
      // the title has no data at all.
      if (u.pathname === '/theintrodb/v3/media') {
        const tmdbId = u.searchParams.get('tmdb_id');
        if (tmdbId === '94605' && u.searchParams.get('season') === '1' && u.searchParams.get('episode') === '1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              tmdb_id: 94605,
              type: 'tv',
              season: 1,
              episode: 1,
              intro: [{ start_ms: 200000, end_ms: 266000 }],
              recap: [{ start_ms: null, end_ms: 45000 }],
              credits: [{ start_ms: 2400000, end_ms: null }]
            })
          );
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Media not found' }));
      }

      // 4b. IntroDB `/segments` (IMDb-keyed). Real shape: one object (or null)
      // per type with both `_ms` and `_sec` boundaries. Boundaries deliberately
      // disagree with TheIntroDB by a second so the merge precedence is
      // observable. `post_credits` must never become a skip target.
      if (u.pathname === '/introdb/segments') {
        const imdbId = u.searchParams.get('imdb_id');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (u.searchParams.get('is_movie') === 'true') {
          return res.end(
            JSON.stringify({
              imdb_id: imdbId,
              media_type: 'movie',
              season: null,
              episode: null,
              intro: null,
              recap: null,
              outro: imdbId === 'tt15239678'
                ? { start_ms: 9600000, end_ms: 10020000, start_sec: 9600, end_sec: 10020, confidence: 0.8, submission_count: 3 }
                : null,
              post_credits: null
            })
          );
        }
        return res.end(
          JSON.stringify({
            imdb_id: imdbId,
            media_type: 'tv',
            season: Number(u.searchParams.get('season') || 1),
            episode: Number(u.searchParams.get('episode') || 1),
            intro: { start_ms: 201000, end_ms: 267000, start_sec: 201, end_sec: 267, confidence: 0.92, submission_count: 14 },
            recap: null,
            outro: { start_ms: 2399000, end_ms: 2460000, start_sec: 2399, end_sec: 2460, confidence: 0.7, submission_count: 2 },
            post_credits: { start_ms: 2460000, end_ms: 2500000, start_sec: 2460, end_sec: 2500, confidence: 0.5, submission_count: 1 }
          })
        );
      }

      // 4c. IntroDB legacy `/intro`: the real endpoint only ever returned
      // millisecond fields. (The old resolver read `start_sec` here and so
      // never produced a single segment in production.)
      if (u.pathname === '/introdb/intro') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            imdb_id: u.searchParams.get('imdb_id'),
            season: Number(u.searchParams.get('season') || 1),
            episode: Number(u.searchParams.get('episode') || 1),
            start_ms: 200000,
            end_ms: 266000,
            confidence: 0.9,
            submission_count: 12
          })
        );
      }

      // 5. OpenSubtitles via Stremio's v3 addon (the only keyless source left:
      //    rest.opensubtitles.org is retired) + .srt.gz download fixtures.
      //    Shape mirrors the live addon: {subtitles:[{id,url,lang(ISO 639-2),SubEncoding}]}.
      const stremioMatch = u.pathname.match(/^\/stremio\/subtitles\/(movie|series)\/([^/]+)\.json$/);
      if (stremioMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            subtitles: [
              { id: '1957433621', url: `${mockOrigin}/opensubtitles/download/1957433621.gz`, lang: 'eng', SubEncoding: 'UTF-8', m: 'i', g: 'fileid' },
              { id: '1957433622', url: `${mockOrigin}/opensubtitles/download/1957433622.gz`, lang: 'eng', SubEncoding: 'UTF-8' },
              { id: '1957440969', url: `${mockOrigin}/opensubtitles/download/1957440969.gz`, lang: 'ara', SubEncoding: 'UTF-8' },
              { id: '1957440970', url: `${mockOrigin}/opensubtitles/download/vip-notice.gz`, lang: 'pob', SubEncoding: 'UTF-8' },
              { id: 'bogus', url: 'not a url', lang: 'fre' }
            ]
          })
        );
      }

      if (u.pathname === '/opensubtitles/download/vip-notice.gz') {
        // What the retired OpenSubtitles.org downloads answer with today.
        const notice = '1\r\n00:00:01,000 --> 00:00:30,000\r\nSubtitles downloaded from opensubtitles.org - become a VIP member\r\n';
        res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
        return res.end(zlib.gzipSync(Buffer.from(notice, 'utf8')));
      }

      if (u.pathname.startsWith('/opensubtitles/download/')) {
        const sampleSrt =
          '1\r\n00:00:01,000 --> 00:00:04,500\r\nWelcome to Piltover and Zaun.\r\n\r\n2\r\n00:03:20,000 --> 00:04:26,000\r\n[ Enemy by Imagine Dragons playing ]\r\n';
        const gzBuf = zlib.gzipSync(Buffer.from(sampleSrt, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
        return res.end(gzBuf);
      }

      // Windows-1251 Russian subtitle served as a deflated ZIP (SubDL style).
      if (u.pathname === '/subdl-dl/subtitle/ru.zip') {
        const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет"
        const srt = Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:04,000\r\n'), cp1251, Buffer.from('\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nok\r\n')]);
        const nameBuf = Buffer.from('Film.ru.srt');
        const data = zlib.deflateRawSync(srt);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(srt.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(srt.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(0, 42);
        const cdOffset = lh.length + nameBuf.length + data.length;
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(ch.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16);
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        return res.end(Buffer.concat([lh, nameBuf, data, ch, nameBuf, eocd]));
      }

      // --- TMDB-Embed-API (the Goldmine upstream) ---------------------------
      // GET /goldmine/api/health | /api/providers | /api/streams/{...}
      // Stream files are served from the "localhost" spelling of this host on
      // purpose: the API base is 127.0.0.1, so the resolver sees CDN host !=
      // API host and wraps every file in the signed proxy — exactly like the
      // real deployment (enableProxy=false -> direct header-gated file URLs).
      // Special tmdb ids exercise the failure modes:
      //   555001 -> zero streams          555002 -> HTTP 500
      //   555003 -> malformed JSON        555004 -> slow (timeout)
      //   555005 -> provider disabled (503, single-provider route only)
      //   /goldmine-down/* -> everything answers HTTP 500
      goldmineHits += 1;
      if (u.pathname === '/goldmine/api/health' || u.pathname === '/goldmine/api/providers') {
        goldmineHits -= 1; // only stream fetches count for the cache test
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (u.pathname.endsWith('/health')) {
          return res.end(JSON.stringify({ ok: true, service: 'tmdb-embed-api', mock: true }));
        }
        return res.end(JSON.stringify({
          success: true,
          providers: [
            { id: 'mockbox', name: 'MockBox', enabled: true },
            { id: '4khdhub', name: '4KHDHub', enabled: true },
            { id: 'vidlink', name: 'VidLink', enabled: true }
          ]
        }));
      }
      if (u.pathname === '/goldmine-down/api/health') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false }));
      }
      const goldmineMatch = u.pathname.match(
        /^\/goldmine(-down)?\/api\/streams\/(?:(mockbox|4khdhub|vidlink|nosuch)\/)?(movie|series)\/([^/]+)$/
      );
      if (goldmineMatch) {
        const [, down, provider, type, tmdbId] = goldmineMatch;
        const json = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (down) return json(500, 'upstream down');
        if (provider === 'nosuch') return json(404, { success: false, error: 'PROVIDER_NOT_FOUND' });
        if (provider && tmdbId === '555005') return json(503, { success: false, error: 'PROVIDER_DISABLED' });
        if (tmdbId === '555002') return json(500, 'boom');
        if (tmdbId === '555003') return json(200, '{not json');
        if (tmdbId === '555004') {
          await new Promise((wait) => setTimeout(wait, 3000));
          return json(200, { success: true, tmdbId, count: 0, streams: [] });
        }
        const cdnOrigin = `http://localhost:${u.port || 80}`;
        const all = goldmineFixtureStreams(cdnOrigin);
        const streams = tmdbId === '555001' ? [] : all.filter((s) => !provider || s.provider === provider);
        return json(200, {
          success: true,
          tmdbId,
          imdbId: type === 'series' ? 'tt11126994' : 'tt15239678',
          count: streams.length,
          providerTimings: { mock: 5 },
          streams
        });
      }

      // Hotlink-gated mirror: 403 whenever a Referer is sent (a wrong Referer is
      // the classic instant-403) and a normal ranged file without one.
      if (u.pathname === '/cdn/gated/file.mp4') {
        if (req.headers.referer || req.headers.origin) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<html><body>hotlink denied</body></html>');
        }
        const body = Buffer.alloc(4096, 5);
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && (range[1] || range[2])) {
          const start = range[1] ? parseInt(range[1], 10) : 0;
          const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), body.length - 1) : body.length - 1;
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1)
          });
          return res.end(body.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length) });
        return res.end(body);
      }

      // Same-origin-only mirror: rejects a missing OR foreign Referer; only its
      // own origin passes (the third rung of the proxy retry ladder).
      if (u.pathname === '/cdn/selfref/file.mp4') {
        const ownOrigin = `http://127.0.0.1:${req.socket.localPort}`;
        if (req.headers.referer !== `${ownOrigin}/`) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<html><body>bad referer</body></html>');
        }
        const body = Buffer.alloc(1024, 3);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length) });
        return res.end(body);
      }

      // A 200 that is really an HTML gate page (never a stream).
      if (u.pathname === '/cdn/html/file.mp4') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<html><body>Sign in to continue</body></html>');
      }

      // A hotlink filter that returns 200 text/html (instead of 403) when a
      // foreign Referer is sent, and serves the real MP4 once Referer is dropped.
      if (u.pathname === '/cdn/htmlgate/file.mp4') {
        if (req.headers.referer || req.headers.origin) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<html><body>hotlink gate page</body></html>');
        }
        const body = Buffer.alloc(1024, 9);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(body.length)
        });
        return res.end(body);
      }

      // Stealth HLS provider serving #EXTM3U at a .txt /playlist path as text/plain.
      if (u.pathname === '/cdn/stealth/playlist/main.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(
          '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080\n1080p/index.m3u8\n'
        );
      }

      // Expired / IP-rejected upstream link returning 403 HTML on every attempt.
      if (u.pathname === '/cdn/dead403/file.mp4') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<html><body>403 Forbidden</body></html>');
      }

      // Tiny binary "media files" for the proxy/Range tests + one real VTT.
      if (u.pathname.startsWith('/cdn/files/')) {
        goldmineHits -= 1;
        const name = u.pathname.replace('/cdn/files/', '');
        if (name === 'arcane-eng.vtt') {
          const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to Piltover and Zaun.\n';
          res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          return res.end(vtt);
        }
        if (!['arcane-multi.mkv', 'arcane-hin.mkv', 'arcane-mp4.mp4'].includes(name)) {
          res.statusCode = 404;
          return res.end('no such fixture');
        }
        const body = Buffer.alloc(64 * 1024, 7);
        const headers = {
          'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'video/x-matroska',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        };
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && (range[1] || range[2])) {
          const start = range[1] ? parseInt(range[1], 10) : Math.max(0, body.length - parseInt(range[2], 10));
          const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), body.length - 1) : body.length - 1;
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1)
          });
          return res.end(body.subarray(start, end + 1));
        }
        res.writeHead(200, { ...headers, 'Content-Length': String(body.length) });
        return res.end(body);
      }

      if (u.pathname.startsWith('/cdn/hls/')) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n1080p/index.m3u8\n`
        );
      }

      // 8e. TMDB failover fixture
      if (u.pathname === '/tmdb/movie/cascade-test-fail-all') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'cascade-test-fail-all',
            title: 'cascade-test-fail-all',
            release_date: '2024-01-01',
            runtime: 120,
            imdb_id: 'tt9999999',
            external_ids: { imdb_id: 'tt9999999' }
          })
        );
      }

      res.writeHead(404);
      res.end('Not found');
    });

    mockSrv.listen(0, '127.0.0.1', () => {
      const addr = mockSrv.address();
      resolve({
        server: mockSrv,
        url: `http://127.0.0.1:${addr.port}`,
        get goldmineHits() {
          return goldmineHits;
        }
      });
    });
  });
}

async function runTests() {
  console.log('==========================================================');
  console.log('  LOL Embed Backend — Verification Suite');
  console.log('==========================================================\n');

  // 1. Cryptographic Unit Tests (AES-256-CBC + HMAC-SHA256 + Handshake Token)
  console.log('[1/14] Testing HMAC proxy signing & handshake tokens...');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signProxyParams('https://cdn.example.com/hls/master.m3u8', 'https://gate.example/', exp);
  assert.strictEqual(
    verifyProxySignature('https://cdn.example.com/hls/master.m3u8', 'https://gate.example/', exp, sig),
    true,
    'Valid HMAC proxy signature must verify'
  );
  assert.strictEqual(
    verifyProxySignature('https://evil.example.com/hls/master.m3u8', 'https://gate.example/', exp, sig),
    false,
    'Tampered URL must fail HMAC verification'
  );

  const hsToken = generateHandshakeToken({ type: 'tv', id: '94605', season: 1, episode: 1 });
  const hsPayload = verifyHandshakeToken(hsToken);
  assert.ok(hsPayload && hsPayload.id === '94605', 'Handshake token must verify');
  console.log('  ✔ Passed cryptographic verification.');

  // 2. Language helpers + Goldmine stream normalization unit tests
  console.log('[2/14] Testing language helpers & Goldmine stream normalization...');
  assert.strictEqual(languagesSvc.normalizeLanguageCode('en-dub'), 'en');
  assert.strictEqual(languagesSvc.normalizeLanguageCode('HIN'), 'hi');
  assert.strictEqual(languagesSvc.normalizeLanguageCode('unknown'), 'und');
  assert.strictEqual(languagesSvc.mapLanguageNameToCode('Telugu'), 'te');
  assert.strictEqual(languagesSvc.languageLabelForCode('ta'), 'Tamil');
  assert.strictEqual(languagesSvc.threeLetterCode('hi'), 'hin');

  const hints = languagesSvc.parseAudioLanguageHints('RRR (2022) Hindi+Telugu [DD 5.1] 2160p Multi Audio WEB-DL');
  assert.deepStrictEqual(hints.languages.map((l) => l.code), ['hi', 'te']);
  assert.strictEqual(hints.multi, true);
  const orgHints = languagesSvc.parseAudioLanguageHints('1080p ORG. Audio Eng WEB-DL');
  assert.deepStrictEqual(orgHints.languages.map((l) => l.code), ['en']);
  assert.strictEqual(orgHints.original, true);
  const cdnNoise = languagesSvc.parseAudioLanguageHints('720p : https://english.workers.dev/?vcloud=https://vcloud.fit/eng/rrr');
  assert.deepStrictEqual(cdnNoise.languages, [], 'CDN host names and token paths must not be mistaken for language hints');

  // Stream normalization: language hints come from name + title + filename
  // (some providers put the language in `name`, others only in the release
  // filename tags).
  const norm = goldmineSvc.normalizeGoldmineStream({
    name: 'Provider Tamil | 1080p',
    title: 'Movie.2023.720p.WEB-DL.HIN.DUB.x264',
    url: 'https://cdn.example/files/movie.mkv',
    quality: '1080',
    provider: 'mockbox'
  }, 0);
  assert.ok(norm, 'a valid stream row must normalize');
  assert.ok(norm.languages.some((l) => l.code === 'ta'), 'the language in `name` must be parsed');
  assert.ok(norm.languages.some((l) => l.code === 'hi'), 'the filename tag HIN must be parsed');
  assert.strictEqual(norm.container, 'mkv');
  assert.strictEqual(norm.height, 1080, 'the quality field wins over a contradicting filename');
  assert.strictEqual(goldmineSvc.normalizeGoldmineStream({ name: 'x', title: 'x', url: 'ftp://bad', quality: '', provider: 'p' }, 0), null, 'non-HTTP rows are dropped');

  // Container + engine mapping: the MKV family rides movi, streaming stays native.
  assert.strictEqual(goldmineSvc.containerForStream('https://x.example/a.mkv', ''), 'mkv');
  assert.strictEqual(goldmineSvc.containerForStream('https://x.example/master.m3u8', ''), 'hls');
  assert.strictEqual(goldmineSvc.containerForStream('https://x.example/f.mp4', ''), 'mp4');
  assert.strictEqual(goldmineSvc.containerForStream('https://api.example/ts-proxy?url=https%3A%2F%2Fc%2Fx.mkv', ''), 'mkv', 'proxy-rewritten URLs keep their container');
  // MP4 is native-first (browser decode + native Range); movi only takes over
  // when the native element rejects the file (HEVC/10-bit MP4).
  assert.strictEqual(goldmineSvc.MOVI_CONTAINERS.has('mp4'), false, 'MP4 must not be routed through the WASM demuxer by default');
  assert.strictEqual(goldmineSvc.MOVI_CONTAINERS.has('mkv'), true);
  assert.strictEqual(goldmineSvc.qualityToHeight('1080'), 1080);
  assert.strictEqual(goldmineSvc.heightToLabel(720), '720p');

  // Header split: forbidden browser headers stay server-side (the proxy applies
  // them), browser-safe custom headers ride in movi-player's `headers` attr.
  const split = goldmineSvc.splitHeaders({ Referer: 'https://r.example', 'X-Api-Key': 'k1', 'User-Agent': 'UA' });
  assert.deepStrictEqual(split.browserSafe, { 'X-Api-Key': 'k1' });
  assert.strictEqual(split.serverSide.Referer, 'https://r.example');
  assert.ok('User-Agent' in split.serverSide, 'User-Agent is a forbidden browser header');

  // Scoring: a multi-audio named-language 1080p MKV beats a plain 720p file.
  const multi = goldmineSvc.normalizeGoldmineStream({ name: 'Multi Audio', title: 'Show.1080p.Multi.Audio.English.Hindi.Tamil.MKV', url: 'https://c.example/a.mkv', quality: '1080', provider: 'p1' }, 0);
  const single = goldmineSvc.normalizeGoldmineStream({ name: 'x', title: 'Show.720p.MKV', url: 'https://c.example/b.mkv', quality: '720', provider: 'p1' }, 1);
  assert.ok(goldmineSvc.scoreGoldmineStream(multi) > goldmineSvc.scoreGoldmineStream(single));
  const label = goldmineSvc.sourceLabelFor(multi);
  assert.ok(label.includes('1080p') && label.includes('MKV') && label.includes('English'), `source label must describe quality+container+languages, got "${label}"`);
  console.log('  ✔ Passed language helper & Goldmine normalization tests.');

  console.log('[3/14] Testing SubRip (.srt) to WebVTT (.vtt) Converter...');
  const sampleSrt = `1\r\n00:00:02,500 --> 00:00:05,800\r\nWelcome to Piltover.\r\n\r\n2\r\n00:00:06,100 --> 00:00:09,450\r\nThe City of Progress.\r\n`;
  const convertedVtt = srtToVtt(sampleSrt);
  assert.ok(convertedVtt.startsWith('WEBVTT'), 'Output must start with WEBVTT header');
  assert.ok(
    convertedVtt.includes('00:00:02.500 --> 00:00:05.800'),
    'Comma timestamps must convert to dots'
  );
  console.log('  ✔ Passed SRT -> VTT conversion.');

  // 4. M3U8 Manifest Rewriter Unit Test
  console.log('[4/14] Testing M3U8 Master & Media Playlist Rewriter...');
  const sampleMasterM3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio/en/prog.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,AUDIO="audio"',
    '1080p/index.m3u8',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
    'seg-001.ts'
  ].join('\n');

  const rewritten = rewriteM3u8Manifest(
    sampleMasterM3u8,
    'https://cdn.upstream.xyz/streams/94605/master.m3u8',
    'https://gate.example/'
  );
  assert.ok(
    rewritten.includes('/api/proxy?url=https%3A%2F%2Fcdn.upstream.xyz%2Fstreams%2F94605%2F1080p%2Findex.m3u8'),
    'Relative variant playlist URL must be rewritten through /api/proxy'
  );
  assert.ok(
    rewritten.includes('URI="/api/proxy?url=https%3A%2F%2Fcdn.upstream.xyz%2Fstreams%2F94605%2Faudio%2Fen%2Fprog.m3u8'),
    'EXT-X-MEDIA audio URI must be rewritten through /api/proxy'
  );
  assert.ok(
    rewritten.includes('URI="/api/proxy?url=https%3A%2F%2Fcdn.upstream.xyz%2Fstreams%2F94605%2Fkeys%2Fenc.key'),
    'EXT-X-KEY URI must be rewritten through /api/proxy'
  );
  console.log('  ✔ Passed M3U8 manifest rewriting.');

  // Start Mock Upstream Server & Application HTTP Server for End-to-End Integration Tests
  // 4b. Mock upstream wiring: TMDB metadata, skip segments, subtitles and the
  // Goldmine TMDB-Embed-API all answer from the local mock server — nothing
  // reaches the internet.
  const mockUpstream = await startUpstreamMockServer();
  config.tmdbBaseUrl = `${mockUpstream.url}/tmdb`;
  config.upstreams.introDbUrl = `${mockUpstream.url}/introdb`;
  config.upstreams.theIntroDbUrl = `${mockUpstream.url}/theintrodb/v3`;
  config.upstreams.theIntroDbApiKey = '';
  config.upstreams.openSubtitlesStremioUrl = `${mockUpstream.url}/stremio`;
  config.upstreams.subdlDownloadUrl = `${mockUpstream.url}/subdl-dl`;
  config.goldmine.apiBase = `${mockUpstream.url}/goldmine`;
  config.goldmine.timeoutMs = 4000;
  config.goldmine.proxyStreams = true;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 5. Health, servers list & handshake endpoints
    // 5. Health & Handshake Endpoints
    console.log('[5/14] Testing /api/health, /api/servers & /api/handshake...');
    const health = await httpRequest(baseUrl, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);
    assert.strictEqual(health.json.brand, 'LOL Embed');
    assert.strictEqual(health.json.service, 'lol-embed-backend');
    assert.deepStrictEqual(health.json.servers, ['goldmine'], 'the catalog is MKV-only now');

    const serversList = await httpRequest(baseUrl, '/api/servers');
    assert.strictEqual(serversList.status, 200);
    assert.deepStrictEqual(serversList.json.servers.map((s) => s.id), ['goldmine']);

    // The legacy ffmpeg remux endpoints are gone with the movi-player engine.
    const goneMultiTrack = await httpRequest(
      baseUrl,
      '/api/multitrack/master.m3u8?url=https%3A%2F%2Fpub-abc.r2.dev%2Fmovies%2FRRR.mkv'
    );
    assert.strictEqual(goneMultiTrack.status, 404, 'multi-track remux routes must be removed');

    const hs = await httpRequest(baseUrl, '/api/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', id: '94605', season: 1, episode: 1 })
    });
    assert.strictEqual(hs.status, 200);
    assert.strictEqual(hs.json.ok, true);
    console.log('  ✔ Passed /api/health, /api/servers & /api/handshake.');

    // 6. TMDB-ID Metadata & Real IntroDB Skip Segments Resolution
    console.log('[6/14] Testing TMDB ID -> External IDs (IMDb/TVDB) & IntroDB Skip Intro Segments...');
    const infoRes = await httpRequest(baseUrl, '/api/info/tv/94605?season=1&episode=1');
    assert.strictEqual(infoRes.status, 200);
    assert.strictEqual(infoRes.json.ok, true);
    assert.strictEqual(infoRes.json.metadata.title, 'Arcane');
    assert.strictEqual(infoRes.json.metadata.externalIds.imdb_id, 'tt11126994');
    assert.strictEqual(infoRes.json.metadata.externalIds.tvdb_id, 371028);
    assert.ok(infoRes.json.metadata.episodes.length >= 2, 'Episodes list must be populated from TMDB');
    const assertArcaneArtwork = (metadata, label) => {
      assert.strictEqual(
        metadata.logo,
        'https://image.tmdb.org/t/p/w500/arcane-en.png',
        `${label}: the English PNG logo must win over SVG, other languages and language-less logos`
      );
      assert.strictEqual(metadata.tagline, 'The future of the city is in their hands.', `${label}: tagline exposed`);
      assert.strictEqual(metadata.rating, 8.7, `${label}: rating rounded to one decimal`);
      assert.strictEqual(metadata.voteCount, 5134, `${label}: vote count exposed`);
    };
    assertArcaneArtwork(infoRes.json.metadata, 'Node /api/info');
    const assertArcaneSegments = (segments, label) => {
      assert.ok(Array.isArray(segments), `${label}: segments must be an array`);
      assert.deepStrictEqual(
        segments.map((s) => [s.type, s.label, s.start, s.end, s.source]),
        [
          ['recap', 'Skip Recap', 0, 45, 'theintrodb'],
          ['intro', 'Skip Intro', 200, 266, 'theintrodb'],
          ['outro', 'Next Episode', 2400, null, 'theintrodb']
        ],
        `${label}: segments must be converted from milliseconds, merged across providers (TheIntroDB wins ` +
          'overlapping IntroDB entries), sorted by start, keep an open-ended credits segment and drop post_credits'
      );
    };
    assertArcaneSegments(infoRes.json.segments, 'Node /api/info');

    const segmentsRes = await httpRequest(baseUrl, '/api/segments/tv/94605?season=1&episode=1');
    assert.strictEqual(segmentsRes.status, 200);
    assertArcaneSegments(segmentsRes.json.segments, 'Node /api/segments');

    // Movies get credits segments too (TheIntroDB 404 -> IntroDB `is_movie` lookup).
    const movieSegmentsRes = await httpRequest(baseUrl, '/api/segments/movie/693134');
    assert.strictEqual(movieSegmentsRes.status, 200);
    assert.deepStrictEqual(
      movieSegmentsRes.json.segments.map((s) => [s.type, s.label, s.start, s.end, s.source]),
      [['outro', 'Skip Credits', 9600, 10020, 'introdb']],
      'movie credits must resolve through IntroDB with is_movie=true'
    );

    // Parser regressions against the providers' real payloads.
    const skipSegments = require('../src/services/skipSegments');
    assert.deepStrictEqual(
      skipSegments
        .parseIntroDb({ imdb_id: 'tt11126994', season: 1, episode: 1, start_ms: 200000, end_ms: 266000 }, 'tv')
        .map((s) => [s.type, s.start, s.end]),
      [['intro', 200, 266]],
      'legacy IntroDB /intro payloads only carry *_ms fields and must still parse'
    );
    assert.deepStrictEqual(
      skipSegments
        .parseAniSkip(
          {
            found: true,
            results: [
              { interval: { startTime: 60.44, endTime: 150.2 }, skipType: 'op' },
              { interval: { startTime: 1300, endTime: 1390 }, skipType: 'mixed-ed' },
              { interval: { startTime: 0, endTime: 0.5 }, skipType: 'recap' }
            ]
          },
          'tv'
        )
        .map((s) => [s.type, s.start, s.end]),
      [['intro', 60.4, 150.2], ['outro', 1300, 1390]],
      'AniSkip op/ed/mixed types must map to intro/outro and sub-second noise must be dropped'
    );
    assert.strictEqual(
      skipSegments.buildAniSkipUrl('https://api.aniskip.com/v2', { malId: 48583, episode: 3 }),
      'https://api.aniskip.com/v2/skip-times/48583/3?types=op&types=ed&types=mixed-op&types=mixed-ed&types=recap&episodeLength=0'
    );
    assert.strictEqual(
      skipSegments.buildIntroDbUrl('https://api.introdb.app', { imdbId: 'not-an-id', type: 'tv', season: 1, episode: 1 }),
      null,
      'IntroDB must not be queried without a valid IMDb id'
    );
    console.log('  ✔ Passed TMDB -> IMDb/TVDB bridging & TheIntroDB/IntroDB/AniSkip segments.');

    // 7. Full production stream resolution through the mocked TMDB-Embed-API:
    //    MKV payload, dub languages up front, labeled sources for manual
    //    switching, subtitles and the CORS+Range stream proxy movi needs.
    console.log('[7/14] Testing /api/resolve/movie/693134 (Goldmine MKV), subtitles & /api/proxy...');
    const resolveRes = await httpRequest(baseUrl, '/api/resolve/movie/693134');
    assert.strictEqual(resolveRes.status, 200);
    assert.strictEqual(resolveRes.json.ok, true);
    const stream = resolveRes.json.stream;
    assert.strictEqual(stream.server, 'goldmine');
    assert.strictEqual(stream.engine, 'movi', 'progressive MKV must ride the movi-player engine');
    assert.strictEqual(stream.format, 'mkv');
    assert.ok(stream.streamUrl.startsWith('/api/proxy?url='), 'direct files must be wrapped in the signed proxy');
    assert.ok(decodeURIComponent(stream.streamUrl).includes('arcane-multi.mkv'), 'the multi-audio MKV must win the source scoring');
    assert.ok(
      !JSON.stringify(stream).includes('Sintel') && !JSON.stringify(stream).includes('BigBuckBunny'),
      'Zero test/demo videos allowed in stream output'
    );

    // Dub languages up front: one row per language, flagged for in-file switching.
    assert.deepStrictEqual(
      stream.audioTracks.map((t) => [t.id, t.lang, t.inFile]),
      [['goldmine-en', 'en', true], ['goldmine-hi', 'hi', true], ['goldmine-ta', 'ta', true]]
    );
    assert.strictEqual(stream.audioTracks.filter((t) => t.default).length, 1, 'exactly one default audio track');
    assert.strictEqual(stream.audioTracks.find((t) => t.default).lang, 'en');
    assert.deepStrictEqual(
      stream.languages.map((l) => [l.code, l.count]),
      [['hi', 3], ['ta', 2], ['en', 1]],
      'the payload must report every dub language with its source count up front'
    );

    // Manual source switching: every distinct playable URL carries a label.
    assert.strictEqual(stream.backupUrls.length, 3, 'hin file + mp4 + external cdn copy are the alternates');
    const labelValues = Object.values(stream.sourceLabels || {});
    assert.strictEqual(labelValues.length, 4);
    assert.ok(labelValues.some((l) => /1080p/.test(l) && /MKV/i.test(l) && /English/.test(l)));
    assert.ok(labelValues.some((l) => /Hindi/i.test(l)), 'the per-language file keeps its language in the label');

    // Qualities only offer real variants (same provider, different height) —
    // same-height mirrors are backup sources, not quality options.
    assert.deepStrictEqual(stream.qualities.map((q) => q.label), ['1080p']);

    // Provider-supplied subtitles ride along, wrapped in the proxy.
    assert.ok(Array.isArray(stream.embeddedSubtitles) && stream.embeddedSubtitles.length === 1);
    assert.strictEqual(stream.embeddedSubtitles[0].lang, 'en');
    assert.ok(stream.embeddedSubtitles[0].url.startsWith('/api/proxy?url='));

    // The stream proxy serves the MKV with CORS + Range support (the movi
    // engine demuxes over HTTP Range requests).
    const rangeRes = await httpRequest(baseUrl, stream.streamUrl, { headers: { Range: 'bytes=0-1023' } });
    assert.strictEqual(rangeRes.status, 206, 'the proxy must answer Range requests with 206');
    assert.match(rangeRes.headers['content-range'] || '', /^bytes 0-1023\//);
    assert.strictEqual(rangeRes.headers['access-control-allow-origin'], '*');
    assert.match(rangeRes.headers['content-type'] || '', /video\/x-matroska/);

    // Proxy resilience: a mirror that rejects the Referer it was given is
    // retried without the hotlink headers instead of failing the source, and a
    // 200 HTML gate page never reaches the player as if it were a stream.
    const gatedProxy = await httpRequest(
      baseUrl,
      `/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/gated/file.mp4`)}&referer=${encodeURIComponent('https://wrong.example/watch')}`,
      { headers: { Range: 'bytes=0-15' } }
    );
    assert.strictEqual(gatedProxy.status, 206, 'a hotlink-403 mirror must be re-fetched without the Referer');
    assert.strictEqual(gatedProxy.headers['x-proxy-relaxed'], 'hotlink');
    assert.strictEqual(gatedProxy.headers['x-upstream-status'], '206');
    const selfRefProxy = await httpRequest(
      baseUrl,
      `/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/selfref/file.mp4`)}&referer=${encodeURIComponent('https://wrong.example/watch')}`
    );
    assert.strictEqual(selfRefProxy.status, 200, 'a same-origin-only mirror must be retried with its own Referer');
    assert.strictEqual(selfRefProxy.headers['x-proxy-relaxed'], 'same-origin-referer');
    const gateHtml = await httpRequest(
      baseUrl,
      `/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/html/file.mp4`)}`
    );
    assert.strictEqual(gateHtml.status, 502, 'an HTML gate page is not a stream');
    assert.match(gateHtml.json && gateHtml.json.error ? gateHtml.json.error : '', /non-media/i);

    // MP4 rides the native <video> (hardware decode, native Range) — movi is only
    // the automatic fallback when the browser rejects the file.
    const mp4Meta = Object.entries(stream.sourceMeta || {}).find(([key]) => key.includes('arcane-mp4.mp4'));
    assert.ok(mp4Meta, 'the MP4 fixture must have per-URL metadata');
    assert.strictEqual(mp4Meta[1].engine, 'native', 'progressive MP4 must not be forced through the WASM demuxer');
    assert.strictEqual(stream.engine, 'movi', 'the MKV primary still rides movi');

    // Audio preference: the cached payload is shared, each caller's default flips.
    const taRes = await httpRequest(baseUrl, '/api/resolve/movie/693134?audio=ta');
    assert.strictEqual(taRes.status, 200);
    assert.strictEqual(taRes.json.stream.activeAudioTrack.lang, 'ta');
    assert.ok(
      taRes.json.stream.audioTracks.every((t) => t.default === (t.lang === 'ta')),
      'Cached resolver responses must still apply each caller\u2019s audio preference'
    );
    const enAgainRes = await httpRequest(baseUrl, '/api/resolve/movie/693134');
    assert.strictEqual(
      enAgainRes.json.stream.activeAudioTrack.lang,
      'en',
      'the canonical cached default must not be poisoned by one caller'
    );

    // Subtitles come from OpenSubtitles' Stremio v3 addon (keyless), merged
    // to one plain track per language with English first and as the default.
    const subs = resolveRes.json.subtitles;
    assert.ok(subs.length >= 3, `OpenSubtitles (Stremio v3) tracks must be returned, got ${subs.length}`);
    assert.deepStrictEqual(
      subs.map((t) => [t.lang, t.label, t.default]),
      [['en', 'English', true], ['ar', 'العربية', false], ['pt', 'Português (BR)', false]],
      'one track per language, native labels, English default, bogus entries dropped'
    );
    assert.ok(subs.every((t) => t.url.startsWith('/api/subtitles/proxy?url=') && t.url.includes('&lang=')), 'tracks are served through the subtitle proxy');
    assert.ok(!JSON.stringify(subs).includes('rest.opensubtitles.org'), 'the retired OpenSubtitles REST API must not be used');

    // Test /api/subtitles/proxy decompressing .srt.gz and converting to WebVTT
    const subProxyRes = await httpRequest(baseUrl, subs[0].url);
    assert.strictEqual(subProxyRes.status, 200);
    assert.ok(subProxyRes.body.startsWith('WEBVTT'), 'Proxied .srt.gz must decompress and convert to WEBVTT');
    assert.ok(subProxyRes.body.includes('Welcome to Piltover and Zaun.'));
    assert.match(subProxyRes.headers['content-type'] || '', /text\/vtt/);

    // A "become a VIP" placeholder must fail the track, not play as subtitles.
    const vipRes = await httpRequest(baseUrl, subs[2].url);
    assert.strictEqual(vipRes.status, 502, 'placeholder subtitle files are rejected');

    // ZIP (SubDL-style) + legacy charset: unpacked and decoded via the lang hint.
    const zipRes = await httpRequest(
      baseUrl,
      `/api/subtitles/proxy?url=${encodeURIComponent(`${mockUpstream.url}/subdl-dl/subtitle/ru.zip`)}&lang=ru`
    );
    assert.strictEqual(zipRes.status, 200, zipRes.body);
    assert.ok(zipRes.body.includes('Привет'), 'windows-1251 subtitle inside a zip must decode');

    // The proxy is not an open relay: unknown hosts are refused.
    const relayRes = await httpRequest(baseUrl, `/api/subtitles/proxy?url=${encodeURIComponent('https://evil.example/x.srt')}`);
    assert.strictEqual(relayRes.status, 403, 'subtitle proxy must refuse non-subtitle hosts');


    // HLS playlists through the proxy: nested variant URIs are rewritten
    // (the signature only guards against tampering when one is present).
    const m3u8ProxyRes = await httpRequest(
      baseUrl,
      `/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/hls/master.m3u8`)}`
    );
    assert.strictEqual(m3u8ProxyRes.status, 200);
    assert.ok(
      m3u8ProxyRes.body.includes('/api/proxy?url='),
      'Proxied M3U8 playlist must rewrite variant URLs through /api/proxy'
    );

    console.log('  ✔ Passed Goldmine MKV resolution, subtitle pipelines & stream proxy.');

    // 8. Backend-only public surface: service metadata + social image, no web UI.
    // 8. Node API public surface: service metadata + social image, JSON-only.
    // (The /embed player page ships with the Cloudflare Worker; suite 10 covers it.)
    console.log('[8/14] Testing LOL Embed branding, meta image, and JSON-only Node surface...');
    const rootInfo = await httpRequest(baseUrl, '/');
    assert.strictEqual(rootInfo.status, 200);
    assert.strictEqual(rootInfo.json.brand, 'LOL Embed');
    assert.strictEqual(rootInfo.json.service, 'lol-embed-backend');
    assert.strictEqual(rootInfo.json.mode, 'backend-only');
    assert.strictEqual(rootInfo.json.metaImage, '/meta-image.gif');

    const metaImage = await httpRequest(baseUrl, '/meta-image.gif');
    assert.strictEqual(metaImage.status, 200);
    assert.match(metaImage.headers['content-type'], /^image\/gif(?:;|$)/i);
    assert.ok(Number(metaImage.headers['content-length']) > 1000, 'GIF meta image should be served as a real asset');
    const metaImageFile = fs.readFileSync(path.join(__dirname, '../public/lol-embed-meta.gif'));
    assert.ok(['GIF87a', 'GIF89a'].includes(metaImageFile.subarray(0, 6).toString('ascii')));

    for (const removedPath of ['/index.html', '/admin', '/embed', '/embed/tv/94605/1/1', '/js/embed.js']) {
      const response = await httpRequest(baseUrl, removedPath);
      assert.strictEqual(response.status, 404, `${removedPath} must not be served by the JSON-only Node API`);
      assert.strictEqual(response.json && response.json.error, 'Not found');
    }
    console.log('  ✔ Passed backend-only root, metadata image, and JSON-only Node surface checks.');

    // 9. Owner Admin Panel (telemetry, Goldmine hot-swap, probes, diagnostic,
    //    domain firewall, custom overrides)
    console.log('[9/14] Testing JSON Admin API, Domain Telemetry, Goldmine Hot-Swap & Firewall...');

    // Simulate API requests from an external client domain (there is no embed page).
    await httpRequest(baseUrl, '/api/resolve/tv/94605?season=1&episode=1&parent=https://partner-cinema.to', {
      headers: { Referer: 'https://partner-cinema.to/' }
    });

    // Unauthorized admin access is rejected.
    const unauthAdmin = await httpRequest(baseUrl, '/api/admin/overview');
    assert.strictEqual(unauthAdmin.status, 401, 'Admin API must reject requests without X-Admin-Key');

    const adminHeaders = { 'X-Admin-Key': 'admin123', 'Content-Type': 'application/json' };
    const overview = await httpRequest(baseUrl, '/api/admin/overview', { headers: adminHeaders });
    assert.strictEqual(overview.status, 200);
    assert.strictEqual(overview.json.ok, true);
    assert.ok(overview.json.stats && overview.json.stats.totals, 'overview must embed the stats block too');
    assert.ok(
      overview.json.domains.some((d) => d.domain === 'partner-cinema.to' && d.resolves >= 1),
      'Admin API must track external API client domain stats'
    );

    // Dashboard feed (same contract as the Worker's /api/admin/stats).
    assert.strictEqual((await httpRequest(baseUrl, '/api/admin/stats')).status, 401);
    const nodeStats = await httpRequest(baseUrl, '/api/admin/stats?limit=5', { headers: adminHeaders });
    assert.strictEqual(nodeStats.status, 200);
    assert.strictEqual(nodeStats.json.stats.storage, 'process-memory');
    assert.ok(nodeStats.json.stats.totals.resolves >= 1, 'successful resolves must be counted');
    assert.ok(
      nodeStats.json.stats.domains.some((d) => d.domain === 'partner-cinema.to' && d.resolves >= 1),
      'the embedding site must be attributed from ?parent=/Referer'
    );
    assert.ok(nodeStats.json.stats.topTitles.some((t) => t.tmdbId === '94605' && t.label.startsWith('Arcane')));
    assert.ok(
      nodeStats.json.stats.servers.some((srv) => srv.id === 'goldmine' && srv.ok >= 1),
      'server attempts must feed the dashboard'
    );
    assert.deepStrictEqual(nodeStats.json.catalog.map((c) => c.id), ['goldmine']);
    const nodeServers = await httpRequest(baseUrl, '/api/servers');
    assert.strictEqual(nodeServers.status, 200);
    assert.deepStrictEqual(nodeServers.json.servers.map((s) => [s.id, s.name]), [['goldmine', 'Goldmine MKV']]);

    // Blocking & unblocking a domain.
    const blockRes = await httpRequest(baseUrl, '/api/admin/domains/block', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ domain: 'leecher-site.org', blocked: true })
    });
    assert.strictEqual(blockRes.status, 200);
    const blockedCheck = await httpRequest(
      baseUrl,
      '/api/resolve/tv/94605?season=1&episode=2&parent=https://leecher-site.org'
    );
    assert.strictEqual(blockedCheck.status, 403, 'Blocked domain must receive HTTP 403 Forbidden');
    await httpRequest(baseUrl, '/api/admin/domains/block', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ domain: 'leecher-site.org', blocked: false })
    });

    // Live Goldmine hot-swap: the TMDB-Embed-API base URL and the server
    // priority/enabled state are admin-editable at runtime.
    const savedGoldmineBase = config.goldmine.apiBase;
    const savedGoldmineRow = config.servers.find((s) => s.id === 'goldmine');
    const savedGoldminePriority = savedGoldmineRow ? savedGoldmineRow.priority : null;
    try {
      const replaceRes = await httpRequest(baseUrl, '/api/admin/upstreams', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          upstreams: { goldmineBase: `${mockUpstream.url}/goldmine` },
          servers: [{ id: 'goldmine', priority: 5, enabled: true }]
        })
      });
      assert.strictEqual(replaceRes.status, 200);
      assert.strictEqual(
        replaceRes.json.snapshot.upstreams.goldmineBase,
        `${mockUpstream.url}/goldmine`,
        'the hot-swapped Goldmine base must show up in the snapshot'
      );
      const infoAfter = await httpRequest(baseUrl, '/api/info/tv/94605');
      assert.strictEqual(infoAfter.status, 200);
      assert.deepStrictEqual(
        infoAfter.json.servers.map((s) => s.id),
        ['goldmine'],
        'a re-prioritised catalog must reach the player list immediately'
      );
    } finally {
      config.goldmine.apiBase = savedGoldmineBase;
      if (savedGoldmineRow && savedGoldminePriority !== null) savedGoldmineRow.priority = savedGoldminePriority;
    }

    // Live health probes hit the Goldmine API's own health endpoints.
    const probeRes = await httpRequest(baseUrl, '/api/admin/probe', { method: 'POST', headers: adminHeaders });
    assert.strictEqual(probeRes.status, 200);
    assert.ok(Array.isArray(probeRes.json.probeResults) && probeRes.json.probeResults.length >= 2);
    assert.ok(probeRes.json.probeResults.every((r) => r.serverId === 'goldmine'), 'probes target the Goldmine API');
    assert.ok(probeRes.json.probeResults.some((r) => r.ok === true), 'the mocked Goldmine API must probe healthy');

    // Owner diagnostic: per-provider report for one title (admin-key protected).
    const diagRes = await httpRequest(baseUrl, '/api/admin/goldmine/diagnose/tv/94605?season=1&episode=1', {
      headers: adminHeaders
    });
    assert.strictEqual(diagRes.status, 200);
    assert.strictEqual(diagRes.json.ok, true);
    assert.ok(diagRes.json.streamCount >= 4, 'diagnose must count the fixture streams');
    assert.deepStrictEqual(diagRes.json.providers.map((p) => p.id).sort(), ['4khdhub', 'mockbox', 'vidlink']);
    assert.ok(diagRes.json.languages.some((l) => l.code === 'hi' && l.count >= 2));
    assert.strictEqual((await httpRequest(baseUrl, '/api/admin/goldmine/diagnose/tv/94605')).status, 401);

    // Custom TMDB stream override (+ the proxied M3U8 rewrite through it).
    const overrideRes = await httpRequest(baseUrl, '/api/admin/overrides', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        type: 'movie',
        tmdbId: '999999',
        streamUrl: `${mockUpstream.url}/cdn/hls/custom-override.m3u8`,
        label: 'Owner Direct 4K HLS'
      })
    });
    assert.strictEqual(overrideRes.status, 200);
    const resolvedOverride = await httpRequest(baseUrl, '/api/resolve/movie/999999');
    assert.strictEqual(resolvedOverride.status, 200);
    assert.strictEqual(resolvedOverride.json.stream.server, 'custom');
    assert.ok(resolvedOverride.json.stream.rawUrl.includes('custom-override.m3u8'));
    const overrideStream = await httpRequest(baseUrl, resolvedOverride.json.stream.streamUrl);
    assert.strictEqual(overrideStream.status, 200);
    assert.ok(overrideStream.body.includes('/api/proxy?url='), 'override playlists are rewritten through the proxy too');
    const deleteOverride = await httpRequest(baseUrl, '/api/admin/overrides/movie:999999:1:1', {
      method: 'DELETE',
      headers: adminHeaders
    });
    assert.strictEqual(deleteOverride.status, 200);
    console.log('  ✔ Passed JSON Admin API, telemetry, Goldmine hot-swap, probes & firewall.');

    // 10. Worker player page: /embed serves the player, player assets load,
    // the API base URL is configurable for a separate API Worker, `/` stays
    // JSON for API clients (with a browser-only rickroll easter egg), and the
    // portal/admin UI stays removed.
    console.log('[10/14] Testing Worker /embed player page, assets, API base config & root behavior...');
    const workerModule = await import('../cloudflare-worker/worker.js');
    const workerFetch = workerModule.default.fetch;

    const PUBLIC_DIR = path.join(__dirname, '..', 'public');
    const embedPlayerSource = fs.readFileSync(path.join(PUBLIC_DIR, 'js/embed.js'), 'utf8');
    assert.ok(embedPlayerSource.includes('const qualityUrls'), 'Player fallback ladder must include quality URLs, not only mirrors');
    assert.ok(embedPlayerSource.includes('dashErrorEvent'), 'DASH decoder errors must advance to the next stream candidate');
    assert.ok(embedPlayerSource.includes("if (errData.fatal)"), 'Fatal HLS decode/network errors must trigger mirror fallback');
    assert.ok(embedPlayerSource.includes("video.onerror = () =>"), 'Native video decode errors must trigger mirror fallback');
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
    const callWorker = (target, env = {}, headers = {}) =>
      workerFetch(new Request(target, { headers }), { ASSETS: mockAssets, ...env }, { waitUntil() {} });

    // 10a. /embed serves the player page with the separately configured API Worker URL injected.
    const embedRes = await callWorker(
      'http://player.test/embed?type=tv&tmdb=94605&s=1&e=1',
      { API_BASE_URL: `${baseUrl}/` } // trailing slash must be normalized away
    );
    assert.strictEqual(embedRes.status, 200, '/embed must serve the player page');
    assert.match(embedRes.headers.get('content-type') || '', /^text\/html/i);
    assert.match(
      embedRes.headers.get('content-security-policy') || '',
      /frame-ancestors \*/,
      '/embed must be iframe-embeddable by the separate main site'
    );
    assert.strictEqual(embedRes.headers.get('access-control-allow-origin'), '*');
    const embedHtml = await embedRes.text();
    assert.ok(embedHtml.includes('id="player-root"'), 'embed page must render the player root');
    for (const assetRef of ['/css/embed.css', '/js/embed.js', '/vendor/hls.min.js', '/vendor/dash.all.min.js']) {
      assert.ok(embedHtml.includes(assetRef), `embed page must reference ${assetRef}`);
    }
    assert.ok(embedHtml.includes('window.__LOL_EMBED_CONFIG__'), 'Worker must inject the player config');
    const readInjectedConfig = (html) => {
      const match = html.match(/window\.__LOL_EMBED_CONFIG__=(.*?);<\/script>/);
      assert.ok(match, 'Injected config script must be present');
      return JSON.parse(match[1]);
    };
    const injectedConfig = readInjectedConfig(embedHtml);
    assert.strictEqual(injectedConfig.apiBaseUrl, baseUrl, 'Injected config must carry the normalized API Worker URL');
    assert.strictEqual(injectedConfig.mkvHlsEnabled, false, 'ordinary Workers must not advertise host-only ffmpeg');
    const workerOnlyFlagHtml = await (await callWorker(
      'http://player.test/embed?type=movie&tmdb=693134',
      { MKV_HLS_ENABLED: 'true', ADS_ENABLED: 'false' }
    )).text();
    assert.strictEqual(
      readInjectedConfig(workerOnlyFlagHtml).mkvHlsEnabled,
      false,
      'the public flag alone must not advertise ffmpeg on a Worker'
    );
    const nodeEmbedHtml = await (await callWorker(
      'http://player.test/embed?type=movie&tmdb=693134',
      { MKV_HLS_ENABLED: 'true', MKV_HLS_NODE_HOST: 'true', ADS_ENABLED: 'false' }
    )).text();
    assert.strictEqual(
      readInjectedConfig(nodeEmbedHtml).mkvHlsEnabled,
      true,
      'an explicitly configured Node host may advertise MKV to HLS'
    );
    assert.ok(!embedHtml.includes('<!--LOL_EMBED_CONFIG-->'), 'Config placeholder must be replaced');
    assert.ok(!/vidstuck/i.test(embedHtml), 'Player page must be rebranded to LOL Embed');

    // 10a-1. Ads: the popunder tag ships by default and ADS_ENABLED="false" strips it.
    const AD_TAG = '<script data-cfasync="false" src="https://4xfreedom.com/1/7bdb1e6b0498fdfa2a41c002db4e3a55"></script>';
    assert.ok(embedHtml.includes(AD_TAG), 'embed page must carry the ad tag by default');
    assert.ok(embedHtml.indexOf('/js/embed.js') < embedHtml.indexOf(AD_TAG), 'ad tag must load after the player script');
    for (const off of ['false', '0', 'off']) {
      const adFreeRes = await callWorker('http://player.test/embed?type=tv&tmdb=94605&s=1&e=1', { ADS_ENABLED: off });
      const adFreeHtml = await adFreeRes.text();
      assert.ok(!adFreeHtml.includes('4xfreedom.com') && !adFreeHtml.includes('LOL_EMBED_ADS'), `ADS_ENABLED=${off} must serve an ad-free page`);
      assert.ok(adFreeHtml.includes('/js/embed.js') && adFreeHtml.includes('</body>'), 'stripping the ad block must leave the page intact');
    }
    const adsOnRes = await callWorker('http://player.test/embed?type=tv&tmdb=94605&s=1&e=1', { ADS_ENABLED: 'true' });
    assert.ok((await adsOnRes.text()).includes(AD_TAG), 'ADS_ENABLED=true keeps the ad tag');

    // Per-site ad settings are admin-only and use the host page domain.
    const adsAdminKey = { 'X-Admin-Key': 'admin123' };
    assert.strictEqual((await callWorker('http://player.test/api/admin/domains/ad-free')).status, 401, 'ad settings need the admin key');
    const addAdFree = await workerFetch(new Request('http://player.test/api/admin/domains/ad-free', {
      method: 'POST',
      headers: { ...adsAdminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://WWW.PARTNER-ADFREE.EXAMPLE/watch', adFree: true })
    }), { ASSETS: mockAssets }, { waitUntil() {} });
    assert.strictEqual(addAdFree.status, 200);
    assert.deepStrictEqual((await addAdFree.json()).adFreeDomains, ['partner-adfree.example'], 'ad-free domains should normalize URLs and www');
    const partnerAdFreeEmbed = await callWorker(
      'http://player.test/embed?type=tv&tmdb=94605&s=1&e=1',
      {},
      { Referer: 'https://www.partner-adfree.example/watch' }
    );
    assert.ok(!(await partnerAdFreeEmbed.text()).includes(AD_TAG), 'listed host sites should receive an ad-free page');
    const unrelatedAdsEmbed = await callWorker(
      'http://player.test/embed?type=tv&tmdb=94605&s=1&e=1',
      {},
      { Referer: 'https://other-partner.example/watch' }
    );
    assert.ok((await unrelatedAdsEmbed.text()).includes(AD_TAG), 'unlisted sites should keep ads');
    const removeAdFree = await workerFetch(new Request('http://player.test/api/admin/domains/ad-free', {
      method: 'POST',
      headers: { ...adsAdminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'partner-adfree.example', adFree: false })
    }), { ASSETS: mockAssets }, { waitUntil() {} });
    assert.deepStrictEqual((await removeAdFree.json()).adFreeDomains, [], 'turning the exception off should restore ads');
    const restoredAdsEmbed = await callWorker(
      'http://player.test/embed?type=tv&tmdb=94605&s=1&e=1',
      {},
      { Referer: 'https://partner-adfree.example/watch' }
    );
    assert.ok((await restoredAdsEmbed.text()).includes(AD_TAG), 'removed domains should receive ads again');

    // 10a-2. The player bundle must revalidate so a server rebrand (or any player
    // fix) reaches viewers on their next load, while vendor libraries keep the
    // long TTL. Stale player JS is what made earlier rebrands invisible.
    const playerJsRes = await callWorker('http://player.test/js/embed.js');
    assert.strictEqual(playerJsRes.status, 200, '/js/embed.js must be served');
    assert.strictEqual(
      playerJsRes.headers.get('cache-control'),
      'no-cache',
      'the player bundle must revalidate instead of being pinned for a day'
    );
    assert.match(playerJsRes.headers.get('content-type') || '', /javascript/i);
    const playerJsBody = await playerJsRes.text();
    assert.match(playerJsBody, /server: 'goldmine'/, 'the served player bundle must carry the priority-1 default server');
    const vendorJsRes = await callWorker('http://player.test/vendor/hls.min.js');
    assert.strictEqual(vendorJsRes.status, 200);
    assert.match(
      vendorJsRes.headers.get('cache-control') || '',
      /max-age=86400/,
      'vendor libraries keep the long cache TTL'
    );

    // 10b. Without API_BASE_URL the player defaults to same-origin API calls.
    const embedDefaultRes = await callWorker('http://player.test/embed?type=movie&tmdb=693134');
    assert.strictEqual(embedDefaultRes.status, 200);
    const embedDefaultHtml = await embedDefaultRes.text();
    assert.strictEqual(
      readInjectedConfig(embedDefaultHtml).apiBaseUrl,
      '',
      'Unset API_BASE_URL must inject an empty same-origin base'
    );

    // 10c. Required player assets load with sensible content types (including
    // the 12 MB movi-player WASM/WebCodecs ES module bundle for Goldmine MKV).
    for (const [assetPath, typePattern] of [
      ['/css/embed.css', '^text/css'],
      ['/js/embed.js', '^(?:text|application)/javascript'],
      ['/vendor/hls.min.js', '^(?:text|application)/javascript'],
      ['/vendor/dash.all.min.js', '^(?:text|application)/javascript'],
      ['/vendor/movi/element.js', '^(?:text|application)/javascript']
    ]) {
      const assetRes = await callWorker(`http://player.test${assetPath}`);
      assert.strictEqual(assetRes.status, 200, `${assetPath} must be served`);
      assert.match(assetRes.headers.get('content-type') || '', new RegExp(typePattern, 'i'));
      assert.strictEqual(assetRes.headers.get('access-control-allow-origin'), '*');
      const assetBody = await assetRes.text();
      assert.ok(assetBody.length > 500, `${assetPath} must serve real content`);
    }

    // 10c-2. Fallback Content-Type safety: ES modules fail under strict MIME
    // checking if env.ASSETS returns a response with no Content-Type header.
    {
      const bareAssets = {
        async fetch() {
          return new Response('export const ok = true;\n', { status: 200 });
        }
      };
      const bareMoviRes = await workerFetch(
        new Request('http://player.test/vendor/movi/element.js'),
        { ASSETS: bareAssets }
      );
      assert.strictEqual(bareMoviRes.status, 200);
      assert.match(
        bareMoviRes.headers.get('content-type') || '',
        /javascript/i,
        'Worker must synthesize a JavaScript Content-Type for /vendor/movi/element.js when ASSETS omits it'
      );
    }

    // 10d. Worker `/` stays a JSON descriptor for API clients and rickrolls browsers.
    const workerRoot = await callWorker('http://player.test/');
    assert.match(workerRoot.headers.get('content-type') || '', /application\/json/);
    const workerRootJson = await workerRoot.json();
    assert.strictEqual(workerRootJson.brand, 'LOL Embed');
    assert.strictEqual(workerRootJson.mode, 'player-and-api');
    assert.strictEqual(workerRootJson.embed, '/embed');
    const browserRoot = await callWorker('http://player.test/', {}, { Accept: 'text/html' });
    assert.match(browserRoot.headers.get('content-type') || '', /^text\/html/);
    const browserRootHtml = await browserRoot.text();
    assert.ok(browserRootHtml.includes('dQw4w9WgXcQ'), 'Browser visitors to / get rickrolled');
    assert.ok(!browserRootHtml.includes('player-root'), '/ must not serve the old portal/player');

    // 10e. Worker health + meta image.
    const workerHealth = await callWorker('http://player.test/api/health');
    assert.strictEqual(workerHealth.status, 200);
    const workerHealthJson = await workerHealth.json();
    assert.strictEqual(workerHealthJson.ok, true);
    assert.strictEqual(workerHealthJson.embed, '/embed');
    const workerMeta = await callWorker('http://player.test/meta-image.gif');
    assert.strictEqual(workerMeta.status, 200);
    assert.match(workerMeta.headers.get('content-type') || '', /^image\/gif/);

    // 10f. Path-style and legacy player URLs serve the same player page as /embed.
    for (const playerPath of [
      '/embed/tv/94605/2/1',
      '/embed/movie/693134',
      '/tv/94605/2/1',
      '/movie/693134'
    ]) {
      const pathRes = await callWorker(`http://player.test${playerPath}`);
      assert.strictEqual(pathRes.status, 200, `${playerPath} must serve the player page`);
      assert.match(pathRes.headers.get('content-type') || '', /^text\/html/i, `${playerPath} must be HTML`);
      assert.match(
        pathRes.headers.get('content-security-policy') || '',
        /frame-ancestors \*/,
        `${playerPath} must be iframe-embeddable`
      );
      const pathHtml = await pathRes.text();
      assert.ok(pathHtml.includes('id="player-root"'), `${playerPath} must render the player root`);
      assert.ok(
        pathHtml.includes('window.__LOL_EMBED_CONFIG__'),
        `${playerPath} must carry the injected player config`
      );
      assert.ok(!pathHtml.includes('<!--LOL_EMBED_CONFIG-->'), `${playerPath} config placeholder must be replaced`);
    }

    // 10g. The old portal / `/admin` UI and raw asset paths stay removed on the
    // Worker (the owner dashboard lives at /reze, the docs at /docs — tested in 13).
    for (const removedPath of [
      '/index.html',
      '/admin.html',
      '/admin',
      '/css/portal.css',
      '/css/admin.css',
      '/js/portal.js',
      '/js/admin.js'
    ]) {
      const response = await callWorker(`http://player.test${removedPath}`);
      assert.strictEqual(response.status, 404, `${removedPath} must stay removed on the Worker`);
      const removedJson = await response.json();
      assert.strictEqual(removedJson.error, 'Not found');
    }

    // 10h. Separate-API-Worker contract: the relative URLs returned by
    // /api/resolve must work when prefixed with the configured API base —
    // exactly what the player does with a foreign API_BASE_URL.
    assert.ok(resolveRes.json.stream.streamUrl.startsWith('/api/proxy?url='));
    const crossOriginStream = await httpRequest(baseUrl, resolveRes.json.stream.streamUrl);
    assert.strictEqual(crossOriginStream.status, 200, 'Absolutized stream URL must be served by the API Worker');
    const crossOriginSub = await httpRequest(baseUrl, resolveRes.json.subtitles[0].url);
    assert.strictEqual(crossOriginSub.status, 200);
    assert.ok(crossOriginSub.body.startsWith('WEBVTT'), 'Absolutized subtitle URL must return WebVTT');
    console.log('  ✔ Passed Worker player page, asset, API-base, and root-behavior checks.');

    // 11. Goldmine source resolution end-to-end: the shared TMDB-Embed-API
    //     service, failure reasons, ?source= pinning, resolver caching and the
    //     honest error contract of /api/resolve.
    console.log('[11/14] Testing Goldmine service failures, ?source= pinning & resolver caching...');

    const goldmineApiBase = `${mockUpstream.url}/goldmine`;

    // Happy path through the shared service (the same code both runtimes use).
    const okFetch = await goldmineSvc.fetchGoldmineStreams({
      apiBase: goldmineApiBase, type: 'tv', tmdbId: 94605, season: 1, episode: 1, timeoutMs: 4000
    });
    assert.strictEqual(okFetch.ok, true);
    assert.strictEqual(okFetch.json.count, 5);
    assert.ok(
      okFetch.url.includes('/api/streams/series/94605') && okFetch.url.includes('season=1') && okFetch.url.includes('episode=1'),
      'series fetches must carry season/episode'
    );

    // Failure reasons map 1:1 onto the API's error contract.
    const emptyFetch = await goldmineSvc.fetchGoldmineStreams({ apiBase: goldmineApiBase, type: 'movie', tmdbId: '555001', timeoutMs: 4000 });
    assert.strictEqual(emptyFetch.ok, true, 'an empty stream list is a valid answer, not an HTTP error');
    const emptyResolved = await goldmineSvc.resolveGoldmineServer({ type: 'movie', tmdbId: '555001' }, { apiBase: goldmineApiBase, timeoutMs: 4000 });
    assert.strictEqual(emptyResolved.reason, 'goldmine_no_streams');
    const httpErr = await goldmineSvc.fetchGoldmineStreams({ apiBase: goldmineApiBase, type: 'movie', tmdbId: '555002', timeoutMs: 4000 });
    assert.strictEqual(httpErr.reason, 'goldmine_http_error');
    const badJson = await goldmineSvc.fetchGoldmineStreams({ apiBase: goldmineApiBase, type: 'movie', tmdbId: '555003', timeoutMs: 4000 });
    assert.strictEqual(badJson.reason, 'goldmine_bad_response');
    const unknownProvider = await goldmineSvc.fetchGoldmineStreams({ apiBase: goldmineApiBase, type: 'movie', tmdbId: '693134', provider: 'nosuch', timeoutMs: 4000 });
    assert.strictEqual(unknownProvider.reason, 'goldmine_source_unknown');
    const disabledProvider = await goldmineSvc.resolveGoldmineServer(
      { type: 'movie', tmdbId: '555005' },
      { apiBase: goldmineApiBase, onlySource: 'mockbox', timeoutMs: 4000 }
    );
    assert.strictEqual(disabledProvider.reason, 'goldmine_source_disabled');
    const unreachable = await goldmineSvc.fetchGoldmineStreams({ apiBase: 'http://127.0.0.1:1/goldmine', type: 'movie', tmdbId: '693134', timeoutMs: 2500 });
    assert.strictEqual(unreachable.reason, 'goldmine_unreachable');
    const slow = await goldmineSvc.fetchGoldmineStreams({ apiBase: goldmineApiBase, type: 'movie', tmdbId: '555004', timeoutMs: 1200 });
    assert.strictEqual(slow.reason, 'goldmine_timeout', 'a cold-starting instance must time out, not hang the waterfall');

    // Source pinning: onlySource filters to one provider.
    const pinned = await goldmineSvc.resolveGoldmineServer(
      { type: 'tv', tmdbId: 94605, season: 1, episode: 1 },
      { apiBase: goldmineApiBase, onlySource: 'vidlink', timeoutMs: 4000 }
    );
    assert.ok(pinned.streamUrl, 'the pinned provider must resolve');
    assert.strictEqual(pinned.audioTracks.length, 1, 'vidlink carries no language hints -> one honest row');
    assert.strictEqual(pinned.audioTracks[0].lang, 'und');
    assert.strictEqual(pinned.referer, 'https://vidlink.pro', 'the referer of the pinned source must survive');
    const pinnedEmpty = await goldmineSvc.resolveGoldmineServer(
      { type: 'movie', tmdbId: '555001' },
      { apiBase: goldmineApiBase, onlySource: 'mockbox', timeoutMs: 4000 }
    );
    assert.strictEqual(pinnedEmpty.reason, 'goldmine_source_empty');

    // Proxy wrapping: the runtime callback gets (url, referer) per source.
    const wrappedCalls = [];
    const wrapped = await goldmineSvc.resolveGoldmineServer(
      { type: 'tv', tmdbId: 94605, season: 1, episode: 1 },
      {
        apiBase: goldmineApiBase,
        timeoutMs: 4000,
        proxyUrl: (targetUrl, referer) => {
          wrappedCalls.push({ targetUrl, referer });
          return `WRAPPED(${referer || 'none'})${targetUrl}`;
        }
      }
    );
    assert.ok(wrapped.streamUrl.startsWith('WRAPPED(none)'), 'no-header sources are wrapped without a referer');
    const extBackup = wrapped.backupUrls.find((u) => u.includes('cdn.external.example'));
    assert.ok(
      extBackup && extBackup.startsWith('WRAPPED(https://gate.example)'),
      'Referer-gated sources must hand their referer to the proxy'
    );
    assert.ok(wrappedCalls.length >= 4, 'every external source URL goes through the proxy builder');

    // Resolver caching: the second identical call must not hit the upstream.
    const hitsBefore = mockUpstream.goldmineHits;
    const first = await httpRequest(baseUrl, '/api/resolve/tv/94605?season=2&episode=3');
    assert.strictEqual(first.status, 200);
    const hitsAfterFirst = mockUpstream.goldmineHits;
    assert.ok(hitsAfterFirst > hitsBefore, 'the first resolve must query the TMDB-Embed-API');
    const second = await httpRequest(baseUrl, '/api/resolve/tv/94605?season=2&episode=3');
    assert.strictEqual(second.status, 200);
    assert.strictEqual(mockUpstream.goldmineHits, hitsAfterFirst, 'the cached payload must replay without an upstream call');
    assert.deepStrictEqual(
      second.json.stream.audioTracks.map((t) => t.id),
      first.json.stream.audioTracks.map((t) => t.id)
    );

    // `?fresh=1` (the player's Retry) must bypass that cache: provider URLs are
    // signed and short-lived, so replaying them makes every retry fail the same way.
    const freshRes = await httpRequest(baseUrl, '/api/resolve/tv/94605?season=2&episode=3&fresh=1');
    assert.strictEqual(freshRes.status, 200);
    assert.ok(mockUpstream.goldmineHits > hitsAfterFirst, 'fresh=1 must query the TMDB-Embed-API again');
    assert.deepStrictEqual(
      freshRes.json.stream.audioTracks.map((t) => t.id),
      first.json.stream.audioTracks.map((t) => t.id),
      'a fresh resolve must return the same shape'
    );

    // A pinned ?source= is its own cache entry and never falls through.
    const pinnedRes = await httpRequest(baseUrl, '/api/resolve/tv/94605?season=2&episode=4&source=vidlink');
    assert.strictEqual(pinnedRes.status, 200);
    assert.strictEqual(pinnedRes.json.stream.audioTracks.length, 1);
    assert.ok(mockUpstream.goldmineHits > hitsAfterFirst, 'a pinned source is a separate cache key');

    // An invalid ?source= slug is ignored -> the full aggregate answers.
    const badSourceRes = await httpRequest(baseUrl, `/api/resolve/tv/94605?season=2&episode=5&source=${encodeURIComponent('EVIL!!')}`);
    assert.strictEqual(badSourceRes.status, 200);
    assert.strictEqual(badSourceRes.json.stream.audioTracks.length, 3);

    // A stale/unknown ?server= id falls back to the catalog, never 404s.
    const legacyServerRes = await httpRequest(baseUrl, '/api/resolve/movie/693134?server=centaurus');
    assert.strictEqual(legacyServerRes.status, 200);
    assert.strictEqual(legacyServerRes.json.stream.server, 'goldmine');

    // Empty upstream answer -> honest 502 naming the goldmine reason.
    const emptyRes = await httpRequest(baseUrl, '/api/resolve/movie/555001');
    assert.strictEqual(emptyRes.status, 502);
    assert.strictEqual(emptyRes.json.failedReason, 'goldmine_no_streams');
    assert.match(emptyRes.json.explanation || '', /No provider on the TMDB-Embed-API/);

    // applyPreferredAudio flips exactly one default on a clone.
    const prefBase = {
      streamUrl: 'u1',
      audioTracks: [
        { id: 'a', lang: 'en', streamUrl: 'u1', default: true },
        { id: 'b', lang: 'ta', streamUrl: 'u1', default: false }
      ]
    };
    const prefApplied = applyPreferredAudio(prefBase, 'ta');
    assert.strictEqual(prefApplied.activeAudioTrack.id, 'b');
    assert.deepStrictEqual(prefApplied.audioTracks.map((t) => t.default), [false, true]);
    console.log('  ✔ Passed Goldmine service, pinning, caching & failure-reason tests.');

    // 12. Shared catalog parity: Node config, the Worker's SERVERS, the player
    //     bundle defaults and the live API payloads must all agree — and the
    //     Worker's resolve must run the same shared goldmine service.
    console.log('[12/14] Testing shared server catalog, worker servers array & player defaults...');
    {
      const catalog = require('../src/services/serverCatalog');
      const expected = [['goldmine', 'Goldmine MKV', 'Multi-Audio Dubs \u2022 MKV', 1]];

      // 12a. The Node backend serves the catalog order verbatim.
      assert.deepStrictEqual(
        config.servers.filter((s) => s.listed !== false).map((s) => [s.id, s.name, s.badge, s.priority]),
        expected,
        'Node config must expose the catalog names/badges/priorities in order'
      );
      assert.deepStrictEqual(catalog.WATERFALL_PRIORITY, ['goldmine']);
      assert.deepStrictEqual(
        catalog.nodeServerList().map((s) => s.id),
        catalog.workerServerList().map((s) => s.id),
        'both runtimes must derive the same server list from the shared catalog'
      );

      // 12b. The API payload the player renders: one active row, honest order.
      const payload = catalog.buildServerPayload(catalog.workerServerList(), 'goldmine');
      assert.deepStrictEqual(payload.map((s) => s.id), ['goldmine']);
      assert.strictEqual(payload[0].active, true);
      assert.strictEqual(payload.filter((s) => s.active).length, 1, 'exactly one server may ever be active');
      assert.strictEqual(
        catalog.resolveServerId(catalog.workerServerList(), 'centaurus'),
        'goldmine',
        'unknown/legacy ids must fall back to the catalog top'
      );
      assert.strictEqual(catalog.resolveServerId(catalog.workerServerList(), ''), 'goldmine');

      // 12c. The player bundle: default server, defensive sorting and the
      // movi engine + language-chip wiring.
      const embedJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'embed.js'), 'utf8');
      assert.match(embedJs, /server: 'goldmine'/, 'player default server must be the priority-1 server');
      assert.ok(!/server: '(andromeda|centaurus|atlas|ursa)'/.test(embedJs), 'player must not default to a removed server');
      assert.ok(
        /\.sort\(\(a, b\) => \(Number\(a\.priority\) \|\| 999\)/.test(embedJs),
        'player must re-sort the API server array by priority before rendering'
      );
      for (const marker of ['ensureMoviPlayer', 'attachMoviStream', 'detachMoviPlayer', 'syncMoviAudioTracks', 'renderLangChips', 'selectMoviAudioLang']) {
        assert.ok(embedJs.includes(marker), `player must keep the movi integration (${marker})`);
      }
      const embedHtmlFile = fs.readFileSync(path.join(__dirname, '..', 'public', 'embed.html'), 'utf8');
      assert.ok(embedHtmlFile.includes('id="movi-mount"'), 'embed page must carry the movi-player mount');
      assert.ok(embedHtmlFile.includes('id="lang-chips"'), 'embed page must carry the dub-language chips');
      assert.ok(!/andromeda|centaurus|Connecting to Atlas/i.test(embedHtmlFile), 'player page must not reference removed servers');

      // 12d. Cloudflare Worker (the deployment that serves /embed) reports the
      // same list through /api/health, /api/info and the resolve payload.
      const catalogWorkerEnv = {
        GOLDMINE_API_BASE: `${mockUpstream.url}/goldmine`,
        TMDB_BASE_URL: `${mockUpstream.url}/tmdb`,
        THEINTRODB_URL: `${mockUpstream.url}/theintrodb/v3`,
        INTRODB_URL: `${mockUpstream.url}/introdb`,
        OPENSUBTITLES_STREMIO_URL: `${mockUpstream.url}/stremio`,
        SUBDL_DOWNLOAD_URL: `${mockUpstream.url}/subdl-dl`
      };

      const healthRes = await callWorker('http://player.test/api/health');
      assert.strictEqual(healthRes.status, 200);
      assert.deepStrictEqual((await healthRes.json()).servers, ['goldmine']);

      const workerInfoRes = await callWorker('http://player.test/api/info/tv/94605', catalogWorkerEnv);
      assert.strictEqual(workerInfoRes.status, 200);
      const workerInfoJson = await workerInfoRes.json();
      assert.deepStrictEqual(
        workerInfoJson.servers.map((s) => [s.id, s.name, s.priority]),
        [['goldmine', 'Goldmine MKV', 1]],
        'worker /api/info must expose the catalog server objects'
      );
      // The Worker must resolve the exact same skip segments and artwork as
      // the Node backend through the shared helpers.
      assertArcaneSegments(workerInfoJson.segments, 'Worker /api/info');
      assertArcaneArtwork(workerInfoJson.metadata, 'Worker /api/info');
      const workerMovieSegmentsRes = await callWorker('http://player.test/api/segments/movie/693134', catalogWorkerEnv);
      assert.strictEqual(workerMovieSegmentsRes.status, 200);
      assert.deepStrictEqual(
        (await workerMovieSegmentsRes.json()).segments.map((s) => [s.type, s.label, s.start, s.end, s.source]),
        [['outro', 'Skip Credits', 9600, 10020, 'introdb']],
        'worker movie credits must resolve through IntroDB with is_movie=true'
      );

      // 12e. The worker waterfall: the same shared goldmine service, the same
      // payload shape the player consumes.
      const workerResolveRes = await callWorker('http://player.test/api/resolve/movie/693134?server=goldmine', catalogWorkerEnv);
      assert.strictEqual(workerResolveRes.status, 200);
      const workerResolveJson = await workerResolveRes.json();
      assert.strictEqual(workerResolveJson.ok, true);
      assert.strictEqual(workerResolveJson.stream.server, 'goldmine');
      assert.strictEqual(workerResolveJson.stream.engine, 'movi', 'the worker must flag MKV streams for the movi engine');
      assert.ok(workerResolveJson.stream.streamUrl.startsWith('/api/proxy?url='));
      assert.deepStrictEqual(workerResolveJson.stream.audioTracks.map((t) => t.lang), ['en', 'hi', 'ta']);
      assert.deepStrictEqual(workerResolveJson.servers.map((s) => s.id), ['goldmine']);
      assert.strictEqual(workerResolveJson.servers.find((s) => s.active).id, workerResolveJson.stream.server);

      // ?source= pinning works on the worker too (separate cache entry).
      const workerPinnedRes = await callWorker('http://player.test/api/resolve/tv/94605?season=3&episode=1&source=vidlink', catalogWorkerEnv);
      assert.strictEqual(workerPinnedRes.status, 200);
      assert.strictEqual((await workerPinnedRes.json()).stream.audioTracks.length, 1);

      // Worker failure path: honest goldmine reason in the explanation.
      const workerEmptyRes = await callWorker('http://player.test/api/resolve/movie/555001', catalogWorkerEnv);
      assert.strictEqual(workerEmptyRes.status, 502);
      assert.match((await workerEmptyRes.json()).explanation || '', /No provider on the TMDB-Embed-API/);

      // 12f. Worker admin: live probes + the Goldmine diagnostic route.
      const workerProbeRes = await workerFetch(
        new Request('http://player.test/api/admin/probe', { method: 'POST', headers: { 'X-Admin-Key': 'admin123' } }),
        { ASSETS: mockAssets, ...catalogWorkerEnv },
        { waitUntil() {} }
      );
      assert.strictEqual(workerProbeRes.status, 200);
      const workerProbeJson = await workerProbeRes.json();
      assert.ok(workerProbeJson.probeResults.length >= 2);
      assert.ok(workerProbeJson.probeResults.every((r) => r.serverId === 'goldmine'));
      assert.ok(workerProbeJson.probeResults.some((r) => r.ok === true));

      const workerDiagRes = await callWorker(
        'http://player.test/api/admin/goldmine/diagnose/tv/94605?season=1&episode=1',
        catalogWorkerEnv,
        { 'X-Admin-Key': 'admin123' }
      );
      assert.strictEqual(workerDiagRes.status, 200);
      const workerDiagJson = await workerDiagRes.json();
      assert.strictEqual(workerDiagJson.ok, true);
      assert.deepStrictEqual(workerDiagJson.providers.map((p) => p.id).sort(), ['4khdhub', 'mockbox', 'vidlink']);
      assert.strictEqual(
        (await callWorker('http://player.test/api/admin/goldmine/diagnose/tv/94605')).status,
        401,
        'the diagnostic route must be admin-keyed'
      );

      // 12g. Worker subtitles: same sources, merge and proxy as the Node API.
      assert.deepStrictEqual(
        workerResolveJson.subtitles.map((t) => [t.lang, t.label, t.default]),
        [['en', 'English', true], ['ar', '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', false], ['pt', 'Portugu\u00eas (BR)', false]],
        'worker must resolve subtitles through the Stremio v3 addon'
      );
      const workerSubRes = await callWorker(`http://player.test${workerResolveJson.subtitles[0].url}`, catalogWorkerEnv);
      assert.strictEqual(workerSubRes.status, 200);
      const workerVtt = await workerSubRes.text();
      assert.ok(workerVtt.startsWith('WEBVTT') && workerVtt.includes('Welcome to Piltover and Zaun.'), 'worker subtitle proxy must return WebVTT');
      assert.strictEqual(workerSubRes.headers.get('access-control-allow-origin'), '*');
      const workerVipRes = await callWorker(`http://player.test${workerResolveJson.subtitles[2].url}`, catalogWorkerEnv);
      assert.strictEqual(workerVipRes.status, 502, 'worker must reject VIP placeholder subtitles');
      const workerRelayRes = await callWorker(
        `http://player.test/api/subtitles/proxy?url=${encodeURIComponent('https://evil.example/x.srt')}`,
        catalogWorkerEnv
      );
      assert.strictEqual(workerRelayRes.status, 403, 'worker subtitle proxy must not be an open relay');
      const workerZipRes = await callWorker(
        `http://player.test/api/subtitles/proxy?url=${encodeURIComponent(`${mockUpstream.url}/subdl-dl/subtitle/ru.zip`)}&lang=ru`,
        catalogWorkerEnv
      );
      assert.strictEqual(workerZipRes.status, 200);
      assert.ok((await workerZipRes.text()).includes('\u041f\u0440\u0438\u0432\u0435\u0442'), 'worker must unpack zip + decode windows-1251');

      // 12h. The worker must build its server list + Goldmine resolver from the
      // shared modules, and the legacy resolvers must stay deleted.
      const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudflare-worker', 'worker.js'), 'utf8');
      assert.ok(/serverCatalog\.workerServerList\(\)/.test(workerSrc), 'worker must build its server list from the shared catalog');
      assert.ok(workerSrc.includes("from '../src/services/goldmine.js'"), 'worker must import the shared goldmine service');
      assert.ok(workerSrc.includes("from '../src/services/languages.js'"), 'worker must import the shared language helpers');
      assert.ok(
        !/resolveHicineUpstream|resolveCastletvUpstream|resolveNetmirrorUpstream|resolveAndromedaUpstream|unrollHubcloudUrl/.test(workerSrc),
        'the legacy resolvers must stay deleted from the worker'
      );
    }
    console.log('  ✔ Passed shared server catalog, worker servers array & player default tests.');

    // 13. Documentation page, owner dashboard (/reze), usage statistics & persistence
    console.log('[13/14] Testing /docs, the /reze dashboard, usage statistics, blocking, ad-free sites & persistence...');
    {
      const adminKey = { 'X-Admin-Key': 'admin123' };
      const callWorkerWith = (target, env = {}, init = {}) =>
        workerFetch(new Request(target, init), { ASSETS: mockAssets, ...env }, { waitUntil() {} });
      const statsEnv = {
        GOLDMINE_API_BASE: `${mockUpstream.url}/goldmine`,
        TMDB_BASE_URL: `${mockUpstream.url}/tmdb`,
        THEINTRODB_URL: `${mockUpstream.url}/theintrodb/v3`,
        INTRODB_URL: `${mockUpstream.url}/introdb`,
        OPENSUBTITLES_STREMIO_URL: `${mockUpstream.url}/stremio`
      };
      const allDownEnv = {
        ...statsEnv,
        GOLDMINE_API_BASE: `${mockUpstream.url}/goldmine-down`
      };

      // 13g. /docs (+ /documentation, trailing slash) serve public/docs.html with the runtime config injected.
      for (const docsPath of ['/docs', '/documentation', '/docs/']) {
        const docsRes = await callWorker(`http://player.test${docsPath}`, { API_BASE_URL: 'https://api.player.test/' });
        assert.strictEqual(docsRes.status, 200, `${docsPath} must serve the documentation`);
        assert.match(docsRes.headers.get('content-type') || '', /^text\/html/);
        const docsHtml = await docsRes.text();
        assert.ok(docsHtml.includes('<h2>Documentation</h2>'), 'docs page must render the reference');
        assert.ok(docsHtml.includes('/embed/tv/') && docsHtml.includes('/embed/movie/'), 'docs must document both embed endpoints');
        assert.ok(docsHtml.includes('LOL_EMBED_PLAYER_COMMAND') && docsHtml.includes('LOL_EMBED_PLAYER_EVENT'), 'docs must cover the postMessage API');
        assert.ok(!docsHtml.includes('<!--LOL_EMBED_CONFIG-->'), 'docs config placeholder must be replaced');
        assert.ok(docsHtml.includes('"apiBaseUrl":"https://api.player.test"'), 'docs must receive the normalized API base');
        assert.ok(docsHtml.includes('"servers":[{"id":"goldmine"'), 'docs must receive the player-visible server catalog');
        for (const provider of [
          'CastleTV', 'HiCine', 'NetMirror', 'hlowb', 'net27', 'hicine.sbs', 'vcloud',
          'TMDB-Embed-API', 'onrender', 'rdp-running-campion', 'Showbox', 'Vidlink', 'vidlink',
          'DahmerMovies', '4KHDHub', '4khdhub', 'VixSrc'
        ]) {
          assert.ok(!docsHtml.includes(provider), `docs must not leak the upstream provider ${provider}`);
        }
      }

      // 13h. /reze: the dashboard shell is served privately; every number comes from the key-protected API.
      const rezeRes = await callWorker('http://player.test/reze');
      assert.strictEqual(rezeRes.status, 200, '/reze must serve the dashboard');
      assert.strictEqual(rezeRes.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.strictEqual(rezeRes.headers.get('x-frame-options'), 'DENY');
      const rezeHtml = await rezeRes.text();
      for (const heading of ['Most requested titles', 'Most failing titles', 'Who is using the API (sites)', 'Countries', 'Ad-free sites']) {
        assert.ok(rezeHtml.includes(heading), `dashboard must render the "${heading}" card`);
      }
      assert.ok(rezeHtml.includes('/api/admin/stats'), 'dashboard must load its numbers from the admin API');
      assert.ok(rezeHtml.includes('/api/admin/domains/ad-free'), 'dashboard must load and update per-site ad settings');
      assert.ok(!rezeHtml.includes('admin123'), 'dashboard must not embed the admin key');
      for (const removedPath of ['/docs.html', '/reze.html', '/admin', '/admin.html', '/reze/x']) {
        const removedRes = await callWorker(`http://player.test${removedPath}`);
        assert.strictEqual(removedRes.status, 404, `${removedPath} must stay unreachable`);
      }
      const rootStill = await callWorker('http://player.test/', {}, { Accept: 'text/html' });
      assert.ok((await rootStill.text()).includes('dQw4w9WgXcQ'), '/ must still rickroll browsers');

      // 13h-2. IMDb ids are accepted wherever a TMDB id is (docs: "TMDB or IMDb id").
      const imdbInfo = await callWorker('http://player.test/api/info/movie/tt15239678', statsEnv);
      assert.strictEqual(imdbInfo.status, 200);
      const imdbInfoJson = await imdbInfo.json();
      assert.strictEqual(imdbInfoJson.metadata.tmdbId, 693134, 'worker must translate IMDb ids through TMDB /find');
      assert.strictEqual(imdbInfoJson.metadata.title, 'Dune: Part Two');
      const imdbTv = await (await callWorker('http://player.test/api/info/tv/TT11126994?season=1&episode=1', statsEnv)).json();
      assert.strictEqual(imdbTv.metadata.tmdbId, 94605);
      const imdbEmbed = await callWorker('http://player.test/embed/movie/tt15239678', statsEnv);
      assert.strictEqual(imdbEmbed.status, 200, 'the player page must accept IMDb ids in the path');
      const nodeImdb = await httpRequest(baseUrl, '/api/info/movie/tt15239678');
      assert.strictEqual(nodeImdb.status, 200);
      assert.strictEqual(nodeImdb.json.metadata.tmdbId, 693134, 'node backend must translate IMDb ids too');

      // 13i. Public server list without provider names (what the docs render).
      const serversRes = await callWorker('http://player.test/api/servers');
      assert.strictEqual(serversRes.status, 200);
      const serversJson = await serversRes.json();
      assert.deepStrictEqual(serversJson.servers.map((s) => s.id), ['goldmine']);
      assert.ok(serversJson.servers.every((s) => s.name && s.badge && Object.keys(s).length === 4), 'server list must be id/name/badge/priority only');

      // 13j. Usage statistics (in-isolate fallback when no STATS Durable Object is bound).
      assert.strictEqual((await callWorker('http://player.test/api/admin/stats')).status, 401, 'stats need the admin key');
      const embedHit = await callWorker('http://player.test/embed/tv/94605/1/1', statsEnv, { Referer: 'https://fan-site.example/watch/arcane', 'CF-IPCountry': 'IN' });
      assert.strictEqual(embedHit.status, 200);
      const okResolve = await callWorker('http://player.test/api/resolve/movie/693134?server=goldmine&parent=https://fan-site.example', statsEnv, { 'CF-IPCountry': 'IN' });
      assert.strictEqual(okResolve.status, 200);
      const failT0 = Date.now();
      const failResolve = await callWorker('http://player.test/api/resolve/movie/550?server=goldmine&parent=https://fan-site.example', allDownEnv, { 'CF-IPCountry': 'PK' });
      assert.strictEqual(failResolve.status, 502, 'all-down upstreams must produce a failed resolve');
      assert.ok(Date.now() - failT0 < 8000, 'down upstreams must fail fast');
      await callWorker(`http://player.test/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/hls/master.m3u8`)}`, statsEnv, { Referer: 'http://player.test/embed/tv/94605/1/1' });

      const statsRes = await callWorker('http://player.test/api/admin/stats?limit=10', statsEnv, adminKey);
      assert.strictEqual(statsRes.status, 200);
      const statsJson = await statsRes.json();
      assert.strictEqual(statsJson.ok, true);
      assert.strictEqual(statsJson.stats.persistent, false, 'without the STATS binding the dashboard must say the counters are in-memory');
      const totals = statsJson.stats.totals;
      assert.ok(totals.embeds >= 1 && totals.resolves >= 1 && totals.resolveErrors >= 1 && totals.proxyHits >= 1, `totals must count every kind: ${JSON.stringify(totals)}`);
      assert.strictEqual(totals.requests, totals.embeds + totals.resolves + totals.resolveErrors);
      const dune = statsJson.stats.topTitles.find((t) => t.tmdbId === '693134');
      assert.ok(dune && dune.requests >= 1 && dune.label.startsWith('Dune: Part Two'), 'most requested titles must carry TMDB titles');
      const arcane = statsJson.stats.topTitles.find((t) => t.tmdbId === '94605');
      assert.ok(arcane && arcane.type === 'tv', 'embed loads must count towards the title');
      const failing = statsJson.stats.failingTitles.find((t) => t.tmdbId === '550');
      assert.ok(failing && failing.fails >= 1 && failing.label.startsWith('Fight Club'), 'failed resolves must rank the title under most failing');
      const site = statsJson.stats.domains.find((d) => d.domain === 'fan-site.example');
      assert.ok(site && site.embeds >= 1 && site.resolves >= 1 && site.fails >= 1 && site.requests === site.embeds + site.resolves + site.fails, `site attribution: ${JSON.stringify(site)}`);
      assert.ok(!statsJson.stats.domains.some((d) => d.domain === 'player.test'), 'the worker host itself must never be listed as a site');
      assert.ok(statsJson.stats.countries.some((c) => c.code === 'IN') && statsJson.stats.countries.some((c) => c.code === 'PK'), 'viewer countries must be counted from CF-IPCountry');
      const latestError = statsJson.stats.errors[0];
      assert.ok(latestError && latestError.reason && latestError.title.startsWith('Fight Club') && latestError.domain === 'fan-site.example' && latestError.country === 'PK', `recent failures: ${JSON.stringify(latestError)}`);
      const goldmineStats = statsJson.stats.servers.find((srv) => srv.id === 'goldmine');
      assert.ok(goldmineStats && goldmineStats.ok >= 1 && goldmineStats.fails >= 1 && goldmineStats.successRate !== null, `server health: ${JSON.stringify(goldmineStats)}`);
      assert.ok(statsJson.stats.days.length >= 1 && statsJson.stats.days[statsJson.stats.days.length - 1].fails >= 1);
      assert.deepStrictEqual(statsJson.catalog.map((c) => c.id), ['goldmine'], 'dashboard feed must carry the live catalog for server names');
      const overviewRes = await callWorker('http://player.test/api/admin/overview', statsEnv, adminKey);
      assert.ok((await overviewRes.json()).stats.totals.requests >= 3, 'legacy overview must include the stats block');

      // 13k. Blocking a site from the dashboard: player + API answer 403 until it is unblocked.
      const blockRes = await callWorkerWith('http://player.test/api/admin/domains/block', statsEnv, {
        method: 'POST', headers: { ...adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'https://Leech.example/some/page', blocked: true })
      });
      assert.strictEqual(blockRes.status, 200);
      assert.deepStrictEqual((await blockRes.json()).blockedDomains, ['leech.example']);
      const blockedResolve = await callWorker('http://player.test/api/resolve/movie/693134?server=goldmine&parent=https://www.leech.example', statsEnv);
      assert.strictEqual(blockedResolve.status, 403, 'blocked sites must not resolve streams');
      const blockedEmbed = await callWorker('http://player.test/embed/movie/693134', statsEnv, { Referer: 'https://leech.example/watch' });
      assert.strictEqual(blockedEmbed.status, 403, 'blocked sites must not get the player page');
      assert.ok((await blockedEmbed.text()).includes('leech.example'));
      const otherEmbed = await callWorker('http://player.test/embed/movie/693134', statsEnv, { Referer: 'https://fan-site.example/' });
      assert.strictEqual(otherEmbed.status, 200, 'other sites keep working');
      const unblockRes = await callWorkerWith('http://player.test/api/admin/domains/block', statsEnv, {
        method: 'POST', headers: { ...adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'leech.example', blocked: false })
      });
      assert.deepStrictEqual((await unblockRes.json()).blockedDomains, []);
      assert.strictEqual((await callWorker('http://player.test/api/resolve/movie/693134?server=goldmine&parent=https://leech.example', statsEnv)).status, 200);
      const blockedSiteRow = (await (await callWorker('http://player.test/api/admin/stats', statsEnv, adminKey)).json()).stats.domains.find((d) => d.domain === 'leech.example');
      assert.ok(blockedSiteRow && blockedSiteRow.blocked === false);

      // 13l. Stats persistence: the StatsStore Durable Object over real SQLite (node:sqlite), restart included.
      let DatabaseSync = null;
      try {
        ({ DatabaseSync } = require('node:sqlite'));
      } catch {}
      if (DatabaseSync) {
        const db = new DatabaseSync(':memory:');
        const makeState = () => {
          let alarm = null;
          return {
            storage: {
              sql: {
                exec: (query, ...params) => {
                  const stmt = db.prepare(query);
                  if (/^\s*(SELECT|PRAGMA)/i.test(query)) return { toArray: () => stmt.all(...params) };
                  stmt.run(...params);
                  return { toArray: () => [] };
                }
              },
              getAlarm: async () => alarm,
              setAlarm: async (ts) => { alarm = ts; },
              transactionSync: (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }
            },
            blockConcurrencyWhile: (fn) => fn(),
            get alarm() { return alarm; }
          };
        };
        const { StatsStore } = workerModule;
        assert.strictEqual(typeof StatsStore, 'function', 'worker must export the StatsStore Durable Object class');
        const state1 = makeState();
        const store1 = new StatsStore(state1);
        const doPost = (store, path, body) => store.fetch(new Request(`https://stats.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
        const rec = await doPost(store1, '/record', [
          { kind: 'embed', domain: 'watch.example', country: 'IN', type: 'tv', tmdbId: 94605 },
          { kind: 'resolve', domain: 'watch.example', country: 'IN', type: 'tv', tmdbId: 94605, title: 'Arcane', year: 2021, season: 1, episode: 1, server: 'goldmine' },
          { kind: 'resolve_error', domain: 'other.example', country: 'US', type: 'movie', tmdbId: 1, title: 'Nope', server: 'goldmine', reason: 'goldmine_no_streams' },
          { kind: 'server_attempt', server: 'goldmine', ok: true, latencyMs: 210 },
          { kind: 'proxy', domain: '' }
        ]);
        assert.strictEqual(rec.status, 200);
        assert.ok(state1.alarm, 'a record must schedule the flush alarm');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM stats_rows').get().n, 0, 'events are batched: nothing is written before the alarm fires');
        await store1.alarm();
        assert.ok(db.prepare('SELECT COUNT(*) AS n FROM stats_rows').get().n >= 6, 'the alarm must persist the touched rows');
        await doPost(store1, '/block', { domain: 'other.example', blocked: true }); // block-list changes are written immediately
        assert.strictEqual(db.prepare("SELECT data FROM stats_meta WHERE key = 'blocked'").get().data, '["other.example"]');
        await doPost(store1, '/ad-free', { domain: 'https://www.partner.example/watch', adFree: true });
        assert.deepStrictEqual(
          (await (await store1.fetch(new Request('https://stats.internal/ad-free'))).json()).adFreeDomains,
          ['partner.example']
        );
        const snap1 = await (await store1.fetch(new Request('https://stats.internal/snapshot?limit=10'))).json();
        assert.strictEqual(snap1.totals.requests, 3);
        assert.strictEqual(snap1.topTitles[0].label, 'Arcane (2021)');
        assert.deepStrictEqual(snap1.blockedDomains, ['other.example']);
        // "Restart": a fresh object over the same database must come back with identical numbers.
        const store2 = new StatsStore(makeState());
        const snap2 = await (await store2.fetch(new Request('https://stats.internal/snapshot?limit=10'))).json();
        assert.deepStrictEqual(snap2.totals, snap1.totals, 'totals must survive a Durable Object restart');
        assert.deepStrictEqual(snap2.topTitles, snap1.topTitles);
        assert.deepStrictEqual(snap2.domains, snap1.domains);
        assert.deepStrictEqual(snap2.countries, snap1.countries);
        assert.deepStrictEqual(snap2.errors, snap1.errors);
        assert.deepStrictEqual(snap2.blockedDomains, ['other.example']);
        assert.deepStrictEqual((await (await store2.fetch(new Request('https://stats.internal/blocked'))).json()).blockedDomains, ['other.example']);
        assert.deepStrictEqual(
          (await (await store2.fetch(new Request('https://stats.internal/ad-free'))).json()).adFreeDomains,
          ['partner.example'],
          'per-site ad settings must survive a Durable Object restart'
        );
        // Incremental flush: only the rows touched since the last flush are rewritten.
        await doPost(store2, '/record', [{ kind: 'proxy', domain: '' }]);
        await store2.alarm();
        assert.strictEqual((await (await new StatsStore(makeState()).fetch(new Request('https://stats.internal/snapshot'))).json()).totals.proxyHits, 2);
        // Reset wipes the tables but keeps the block-list.
        await doPost(store2, '/reset', {});
        const snap3 = await (await new StatsStore(makeState()).fetch(new Request('https://stats.internal/snapshot'))).json();
        assert.strictEqual(snap3.totals.requests, 0);
        assert.deepStrictEqual(snap3.blockedDomains, ['other.example']);
        assert.deepStrictEqual(
          (await (await new StatsStore(makeState()).fetch(new Request('https://stats.internal/ad-free'))).json()).adFreeDomains,
          ['partner.example'],
          'resetting statistics must preserve the ad-free list'
        );

        // The Worker talks to the object through the binding: events arrive in the background, the dashboard says "persistent".
        const stub = { fetch: (input, init) => store2.fetch(input instanceof Request ? input : new Request(input, init)) };
        const pending = [];
        const doEnv = { ...statsEnv, STATS: { idFromName: (name) => name, get: () => stub } };
        const doCtx = { waitUntil: (p) => pending.push(p) };
        const doEmbed = await workerFetch(new Request('http://player.test/embed/movie/693134', { headers: { Referer: 'https://durable.example/' } }), { ASSETS: mockAssets, ...doEnv }, doCtx);
        assert.strictEqual(doEmbed.status, 200);
        const doAdFreeEmbed = await workerFetch(new Request('http://player.test/embed/movie/693134', { headers: { Referer: 'https://www.partner.example/watch' } }), { ASSETS: mockAssets, ...doEnv }, doCtx);
        assert.ok(!(await doAdFreeEmbed.text()).includes(AD_TAG), 'Durable Object settings must suppress ads after an isolate restart');
        const doAdFreeSettings = await workerFetch(new Request('http://player.test/api/admin/domains/ad-free', { headers: adminKey }), { ASSETS: mockAssets, ...doEnv }, doCtx);
        assert.deepStrictEqual((await doAdFreeSettings.json()).adFreeDomains, ['partner.example']);
        await Promise.all(pending);
        const doStats = await (await workerFetch(new Request('http://player.test/api/admin/stats', { headers: adminKey }), { ASSETS: mockAssets, ...doEnv }, doCtx)).json();
        assert.strictEqual(doStats.stats.persistent, true, 'with the binding the dashboard must report durable storage');
        assert.ok(doStats.stats.domains.some((d) => d.domain === 'durable.example' && d.embeds === 1), 'embed events must reach the Durable Object');
        assert.ok(!doStats.stats.domains.some((d) => d.domain === 'fan-site.example'), 'the durable snapshot must not mix in the in-isolate fallback counters');
        const doBlocked = await workerFetch(new Request('http://player.test/api/resolve/movie/693134?server=goldmine&parent=https://other.example'), { ASSETS: mockAssets, ...doEnv }, doCtx);
        assert.strictEqual(doBlocked.status, 403, 'the block-list persisted in the object must gate resolves');
        db.close();
      } else {
        console.log('  (node:sqlite unavailable — skipped the Durable Object persistence checks)');
      }
    }
    console.log('  ✔ Passed documentation, dashboard, statistics, blocking, per-site ads & persistence tests.');

    // 14. MKV WASM demuxing, fast two-wave provider fan-out, proxy MIME/header
    //     forwarding, 50+ audio languages & smooth source-shifting contracts.
    console.log('[14/14] Testing MKV WASM demuxing, fast two-wave fan-out, proxy headers & multi-audio source shifting...');
    {
      const langSvc = require('../src/services/languages');

      // 14a. Expanded ISO-639-1 / 639-2 / 639-3 / release-title language support.
      const expectedLangPairs = [
        ['eng', 'en', 'English'],
        ['hin', 'hi', 'Hindi'],
        ['tam', 'ta', 'Tamil'],
        ['tel', 'te', 'Telugu'],
        ['mal', 'ml', 'Malayalam'],
        ['kan', 'kn', 'Kannada'],
        ['ben', 'bn', 'Bengali'],
        ['mar', 'mr', 'Marathi'],
        ['guj', 'gu', 'Gujarati'],
        ['pan', 'pa', 'Punjabi'],
        ['odi', 'or', 'Odia'],
        ['asm', 'as', 'Assamese'],
        ['nep', 'ne', 'Nepali'],
        ['sin', 'si', 'Sinhala'],
        ['urd', 'ur', 'Urdu'],
        ['fas', 'fa', 'Persian'],
        ['heb', 'he', 'Hebrew'],
        ['jpn', 'ja', 'Japanese'],
        ['kor', 'ko', 'Korean'],
        ['zho', 'zh', 'Chinese'],
        ['spa', 'es', 'Spanish'],
        ['latino', 'es', 'Spanish'],
        ['por', 'pt', 'Portuguese'],
        ['pb', 'pt', 'Portuguese'],
        ['deu', 'de', 'German'],
        ['ger', 'de', 'German'],
        ['fra', 'fr', 'French'],
        ['fre', 'fr', 'French'],
        ['rus', 'ru', 'Russian'],
        ['ukr', 'uk', 'Ukrainian'],
        ['pol', 'pl', 'Polish'],
        ['tgl', 'tl', 'Filipino'],
        ['fil', 'tl', 'Filipino']
      ];
      for (const [input, code, label] of expectedLangPairs) {
        assert.strictEqual(langSvc.normalizeLanguageCode(input), code, `${input} must normalize to ${code}`);
        assert.strictEqual(langSvc.languageLabelForCode(code), label, `${code} must label as ${label}`);
      }
      const parsedHint = langSvc.parseAudioLanguageHints(
        'Movie.2025.2160p.WEB-DL.Multi.Audio.[Tam+Tel+Mal+Kan+Hin+Eng].HEVC.mkv'
      );
      assert.strictEqual(parsedHint.multi, true);
      assert.deepStrictEqual(
        parsedHint.languages.map((l) => l.code),
        ['ta', 'te', 'ml', 'kn', 'hi', 'en']
      );

      // 14b. Two-wave fast provider fan-out: settles in <700ms and aborts 15s stragglers.
      goldmineSvc.clearGoldmineProviderCache();
      let wave1StragglerAborted = false;
      let wave2Called = false;
      const fastMockFetch = async (input, init = {}) => {
        const u = new URL(typeof input === 'string' ? input : input.url);
        if (u.pathname.endsWith('/api/providers')) {
          return new Response(
            JSON.stringify({
              providers: [
                { name: 'dahmermovies', enabled: true },
                { name: 'showbox', enabled: true },
                { name: '4khdhub', enabled: true },
                { name: 'streamflix', enabled: true }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.pathname.includes('/api/streams/dahmermovies/')) {
          await new Promise((r) => setTimeout(r, 20));
          return new Response(
            JSON.stringify({
              imdbId: 'tt15239678',
              streams: [
                {
                  title: 'Dune.2024.1080p.Multi.Audio.Hindi.English.mkv',
                  url: 'https://cdn-a.example/dune.mkv',
                  quality: '1080p'
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.pathname.includes('/api/streams/showbox/')) {
          await new Promise((r) => setTimeout(r, 25));
          return new Response(
            JSON.stringify({
              streams: [
                {
                  title: 'Dune.2024.720p.English.mkv',
                  url: 'https://cdn-b.example/dune720.mkv',
                  quality: '720p'
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.pathname.includes('/api/streams/4khdhub/')) {
          return new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('should have been aborted')), 15000);
            if (typeof timer.unref === 'function') timer.unref();
            if (init.signal) {
              init.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                wave1StragglerAborted = true;
                const abortErr = new Error('Aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            }
          });
        }
        if (u.pathname.includes('/api/streams/streamflix/')) {
          wave2Called = true;
          return new Response(JSON.stringify({ streams: [] }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      };

      const tFastStart = Date.now();
      const fastResult = await goldmineSvc.resolveGoldmineServer(
        { type: 'movie', tmdbId: '693134' },
        {
          apiBase: 'http://goldmine-fast.test',
          preferredAudio: 'hi',
          timeoutMs: 15000,
          fetchImpl: fastMockFetch,
          proxyStreams: false
        }
      );
      const fastElapsed = Date.now() - tFastStart;
      assert.ok(fastResult && fastResult.streamUrl, 'fast two-wave resolve must return a stream bundle');
      assert.ok(fastElapsed < 1200, `expected <1200ms early settle despite 15s straggler, got ${fastElapsed}ms`);
      assert.strictEqual(wave1StragglerAborted, true, 'slow Wave 1 straggler must be aborted once fast MKV streams settle');
      assert.strictEqual(wave2Called, false, 'Wave 2 slow providers must not even launch when Wave 1 settles quickly');
      assert.strictEqual(fastResult.activeAudioTrack.lang, 'hi', 'preferredAudio=hi must select the Hindi track');
      for (const metaEntry of Object.values(fastResult.sourceMeta || {})) {
        assert.strictEqual('provider' in metaEntry, false, 'sourceMeta must stay provider-anonymous');
      }

      // Wave 1 empty -> Wave 2 launches immediately without waiting full wave2Delay.
      goldmineSvc.clearGoldmineProviderCache();
      const wave2FallbackFetch = async (input) => {
        const u = new URL(typeof input === 'string' ? input : input.url);
        if (u.pathname.endsWith('/api/providers')) {
          return new Response(
            JSON.stringify({
              providers: [
                { name: 'dahmermovies', enabled: true },
                { name: 'netmirror', enabled: true }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.pathname.includes('/api/streams/dahmermovies/')) {
          return new Response(JSON.stringify({ streams: [] }), { status: 200 });
        }
        if (u.pathname.includes('/api/streams/netmirror/')) {
          return new Response(
            JSON.stringify({
              streams: [{ title: '1080p HLS', url: 'https://cdn-c.example/master.m3u8', quality: '1080p' }]
            }),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      };
      const tWave2 = Date.now();
      const wave2Res = await goldmineSvc.resolveGoldmineServer(
        { type: 'movie', tmdbId: '693134' },
        { apiBase: 'http://goldmine-w2.test', timeoutMs: 8000, fetchImpl: wave2FallbackFetch, proxyStreams: false }
      );
      assert.strictEqual(wave2Res.streamUrl, 'https://cdn-c.example/master.m3u8');
      assert.strictEqual(wave2Res.format, 'hls');
      assert.ok(Date.now() - tWave2 < 500, 'Wave 2 must start immediately when Wave 1 finishes empty');

      // 14c. Transport header stripping + proxy header forwarding & MKV MIME inference.
      const rawProviderHeaders = {
        Referer: 'https://host.example/watch',
        Origin: 'https://host.example',
        Cookie: 'sid=xyz',
        'User-Agent': 'CustomUA/1.0',
        Connection: 'keep-alive',
        'Accept-Encoding': 'gzip',
        Authorization: 'Bearer tok-1',
        'X-Client-Token': 'abc-99'
      };
      const split = goldmineSvc.splitHeaders(rawProviderHeaders);
      const pMeta = goldmineSvc.proxyMetaFromHeaders(rawProviderHeaders);
      assert.strictEqual(pMeta.referer, 'https://host.example/watch');
      assert.strictEqual(pMeta.origin, 'https://host.example');
      assert.strictEqual(pMeta.cookie, 'sid=xyz');
      assert.strictEqual(pMeta.userAgent, 'CustomUA/1.0');
      assert.strictEqual('Connection' in split.browserSafe, false);
      assert.strictEqual('Accept-Encoding' in split.browserSafe, false);
      assert.strictEqual('Referer' in split.browserSafe, false);
      assert.deepStrictEqual(split.browserSafe, {
        Authorization: 'Bearer tok-1',
        'X-Client-Token': 'abc-99'
      });

      // CORS preflight reflects custom headers requested by movi-player.
      const preflightRes = await workerFetch(
        new Request('http://player.test/api/proxy', {
          method: 'OPTIONS',
          headers: { 'Access-Control-Request-Headers': 'Range, X-Client-Token, Authorization' }
        }),
        {}
      );
      assert.strictEqual(preflightRes.status, 204);
      assert.match(preflightRes.headers.get('access-control-allow-headers') || '', /X-Client-Token/i);

      // 14c-2. Worker proxy resilience: the hotlink-403 retry and the non-media guard.
      const workerGated = await workerFetch(
        new Request(
          `http://player.test/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/gated/file.mp4`)}&referer=${encodeURIComponent('https://wrong.example/watch')}`,
          { headers: { Range: 'bytes=0-15' } }
        ),
        {}
      );
      assert.strictEqual(workerGated.status, 206, 'worker proxy must retry a hotlink-403 without Referer/Origin');
      assert.strictEqual(workerGated.headers.get('x-proxy-relaxed'), 'hotlink');
      assert.strictEqual(workerGated.headers.get('x-upstream-status'), '206');
      assert.match(workerGated.headers.get('content-type') || '', /video\/mp4/);
      const workerGateHtml = await workerFetch(
        new Request(`http://player.test/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/html/file.mp4`)}`),
        {}
      );
      assert.strictEqual(workerGateHtml.status, 502, 'worker proxy must not pass an HTML gate page through as a stream');
      assert.match((await workerGateHtml.json()).error || '', /non-media/i);

      // The worker resolve cache is bypassed by `?fresh=1` (player Retry).
      const workerResolveFirst = await workerFetch(
        new Request('http://player.test/api/resolve/movie/693134?server=goldmine&fresh=1'),
        { GOLDMINE_API_BASE: `${mockUpstream.url}/goldmine` },
        { waitUntil() {} }
      );
      assert.strictEqual(workerResolveFirst.status, 200);
      assert.ok((await workerResolveFirst.json()).stream.streamUrl, 'fresh worker resolves must still answer with a stream');

      // 14d. Real FFmpeg WASM Demuxer (`public/vendor/movi/element.js`) over Worker `/api/proxy`
      //      streaming a multi-audio + multi-subtitle Matroska container via HTTP Range requests.
      const buildTestMkv = () => {
        const vint = (num, width) => {
          let w = width;
          if (!w) {
            if (num < 0x7f) w = 1;
            else if (num < 0x3fff) w = 2;
            else if (num < 0x1fffff) w = 3;
            else w = 4;
          }
          const buf = Buffer.alloc(w);
          let v = num;
          for (let i = w - 1; i >= 0; i -= 1) {
            buf[i] = v & 0xff;
            v = Math.floor(v / 256);
          }
          buf[0] |= 1 << (8 - w);
          return buf;
        };
        const mkEl = (idHex, payload) => {
          const id = Buffer.from(idHex, 'hex');
          const data = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
          return Buffer.concat([id, vint(data.length), data]);
        };
        const uintEl = (idHex, n) => {
          const bytes = [];
          let v = n;
          do {
            bytes.unshift(v & 0xff);
            v = Math.floor(v / 256);
          } while (v > 0);
          return mkEl(idHex, Buffer.from(bytes));
        };
        const float64El = (idHex, f) => {
          const b = Buffer.alloc(8);
          b.writeDoubleBE(f, 0);
          return mkEl(idHex, b);
        };
        const strEl = (idHex, s) => mkEl(idHex, Buffer.from(s, 'utf8'));
        const aacPriv = Buffer.from([0x11, 0x90]);
        const mkAudio = (num, lang, name) => {
          const parts = [
            uintEl('d7', num),
            uintEl('73c5', 100 + num),
            uintEl('83', 2),
            strEl('86', 'A_AAC'),
            mkEl('63a2', aacPriv),
            mkEl('e1', [float64El('b5', 48000), uintEl('9f', 2)])
          ];
          if (lang) parts.push(strEl('22b59c', lang));
          if (name) parts.push(strEl('536e', name));
          return mkEl('ae', parts);
        };
        const mkSub = (num, lang, name) =>
          mkEl('ae', [
            uintEl('d7', num),
            uintEl('73c5', 200 + num),
            uintEl('83', 0x11),
            strEl('86', 'S_TEXT/UTF8'),
            strEl('22b59c', lang),
            strEl('536e', name)
          ]);
        const silentAac = Buffer.from([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80]);
        const mkBlock = (trackNum, payload) => {
          const hdr = Buffer.alloc(4);
          hdr[0] = 0x80 | trackNum;
          hdr.writeInt16BE(0, 1);
          hdr[3] = 0x80;
          return mkEl('a3', Buffer.concat([hdr, payload]));
        };
        const ebml = mkEl('1a45dfa3', [
          uintEl('4286', 1),
          uintEl('42f7', 1),
          uintEl('42f2', 4),
          uintEl('42f3', 8),
          strEl('4282', 'matroska'),
          uintEl('4287', 4),
          uintEl('4285', 2)
        ]);
        const info = mkEl('1549a966', [uintEl('2ad7b1', 1000000), float64El('4489', 60000.0)]);
        const tracks = mkEl('1654ae6b', [
          mkAudio(1, 'eng', 'English Stereo'),
          mkAudio(2, 'hin', 'Hindi Dub'),
          mkAudio(3, 'jpn', 'Japanese Original'),
          mkAudio(4, 'und', 'Spanish Dub'),
          mkSub(5, 'eng', 'English SDH')
        ]);
        const cluster = mkEl('1f43b675', [
          uintEl('e7', 0),
          mkBlock(1, silentAac),
          mkBlock(2, silentAac),
          mkBlock(3, silentAac),
          mkBlock(4, silentAac),
          mkBlock(5, Buffer.from('Hello!', 'utf8'))
        ]);
        return Buffer.concat([ebml, mkEl('18538067', [info, tracks, cluster])]);
      };

      const mkvBytes = buildTestMkv();
      const seenUpstreamMkvHeaders = [];
      const origGlobalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (input, init = {}) => {
          const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (reqUrl.startsWith('http://wasm-player.test/')) {
            const reqObj = input instanceof Request ? input : new Request(reqUrl, init);
            return workerFetch(reqObj, {});
          }
          if (reqUrl.startsWith('https://mkv-cdn.invalid/movie.mkv')) {
            const hdrs = new Headers(input instanceof Request ? input.headers : init.headers);
            seenUpstreamMkvHeaders.push({
              referer: hdrs.get('referer'),
              origin: hdrs.get('origin'),
              cookie: hdrs.get('cookie'),
              ua: hdrs.get('user-agent'),
              xClientToken: hdrs.get('x-client-token'),
              xAdminKey: hdrs.get('x-admin-key'),
              range: hdrs.get('range')
            });
            const range = hdrs.get('range');
            if (range) {
              const m = /bytes=(\d+)-(\d*)/.exec(range);
              const s = Number(m[1]);
              const e = m[2] ? Math.min(Number(m[2]), mkvBytes.length - 1) : mkvBytes.length - 1;
              return new Response(mkvBytes.subarray(s, e + 1), {
                status: 206,
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'Accept-Ranges': 'bytes',
                  'Content-Range': `bytes ${s}-${e}/${mkvBytes.length}`,
                  'Content-Length': String(e - s + 1),
                  'Content-Disposition': 'attachment; filename="movie.mkv"'
                }
              });
            }
            return new Response(mkvBytes, {
              status: 200,
              headers: {
                'Content-Type': 'application/octet-stream',
                'Accept-Ranges': 'bytes',
                'Content-Length': String(mkvBytes.length)
              }
            });
          }
          return origGlobalFetch(input, init);
        };

        // Direct check on Worker /api/proxy MIME inference + Content-Disposition exposure
        const proxyProbeUrl =
          'http://wasm-player.test/api/proxy?' +
          new URLSearchParams({
            url: 'https://mkv-cdn.invalid/movie.mkv',
            referer: 'https://dahmer.example/',
            origin: 'https://dahmer.example',
            cookie: 'cf=123',
            ua: 'CustomMoviUA/2.0'
          }).toString();
        const rangeProbe = await globalThis.fetch(proxyProbeUrl, {
          headers: {
            Range: 'bytes=0-63',
            'X-Client-Token': 'tok-mkv-77',
            'X-Admin-Key': 'should-never-leak'
          }
        });
        assert.strictEqual(rangeProbe.status, 206);
        assert.strictEqual(rangeProbe.headers.get('content-type'), 'video/x-matroska');
        assert.strictEqual(rangeProbe.headers.get('content-disposition'), 'attachment; filename="movie.mkv"');
        assert.match(rangeProbe.headers.get('access-control-expose-headers') || '', /Content-Disposition/i);
        assert.strictEqual(seenUpstreamMkvHeaders[0].referer, 'https://dahmer.example/');
        assert.strictEqual(seenUpstreamMkvHeaders[0].origin, 'https://dahmer.example');
        assert.strictEqual(seenUpstreamMkvHeaders[0].cookie, 'cf=123');
        assert.strictEqual(seenUpstreamMkvHeaders[0].ua, 'CustomMoviUA/2.0');
        assert.strictEqual(seenUpstreamMkvHeaders[0].xClientToken, 'tok-mkv-77');
        assert.strictEqual(seenUpstreamMkvHeaders[0].xAdminKey, null, 'X-Admin-Key must never leak to upstream CDNs');

        // Open the proxied MKV with the real FFmpeg WASM Demuxer from public/vendor/movi/element.js!
        if (!globalThis.HTMLElement) globalThis.HTMLElement = class {};
        if (!globalThis.customElements) globalThis.customElements = { get: () => null, define: () => {} };
        if (!globalThis.document) {
          globalThis.document = {
            documentElement: {},
            querySelector: () => null,
            addEventListener: () => {},
            createElement: () => ({ style: {} })
          };
        }
        if (!globalThis.window) {
          globalThis.window = globalThis;
          globalThis.getComputedStyle = () => ({});
          globalThis.addEventListener = () => {};
        }
        const moviMod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'public', 'vendor', 'movi', 'element.js')).href);
        const httpSource = new moviMod.HttpSource(proxyProbeUrl, { 'X-Client-Token': 'tok-mkv-77' });
        const demuxer = new moviMod.Demuxer(httpSource);
        await demuxer.open();
        const wasmAudio = demuxer.getAudioTracks();
        const wasmSubs = demuxer.getSubtitleTracks();
        demuxer.close();
        assert.strictEqual(wasmAudio.length, 4, 'FFmpeg WASM must demux all 4 audio tracks over Worker /api/proxy');
        assert.deepStrictEqual(
          wasmAudio.map((t) => [t.id, t.language || 'und', t.label]),
          [
            [0, 'eng', 'English Stereo'],
            [1, 'hin', 'Hindi Dub'],
            [2, 'jpn', 'Japanese Original'],
            [3, 'und', 'Spanish Dub']
          ]
        );
        assert.strictEqual(wasmSubs.length, 1, 'FFmpeg WASM must demux embedded MKV subtitle track');
        assert.strictEqual(wasmSubs[0].language, 'eng');
      } finally {
        globalThis.fetch = origGlobalFetch;
      }

      // 14e. Player bundle invariants for ES-module loading, muxed track switching & smooth source shifts.
      const embedJsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'embed.js'), 'utf8');
      assert.match(embedJsSrc, /script\.type\s*=\s*'module'/, 'ensureMoviPlayer must load element.js as an ES module');
      assert.match(embedJsSrc, /whenDefined\('movi-player'\)/, 'ensureMoviPlayer must await customElements.whenDefined');
      assert.match(embedJsSrc, /setAttribute\('sw',\s*'auto'\)/, 'movi-player must enable automatic software decode fallback');
      assert.match(embedJsSrc, /errordisplay/, 'movi-player must fail over on errordisplay events');
      assert.match(embedJsSrc, /MOVI_CONNECT_TIMEOUT_MS/, 'movi-player must enforce a startup watchdog timer');
      assert.match(embedJsSrc, /unwrapProxiedTargetUrl/, 'source classifier must unwrap /api/proxy?url= before choosing engine');
      assert.match(embedJsSrc, /pickAudioTrack/, 'muxed MKV audio switching must call pickAudioTrack');
      assert.match(embedJsSrc, /pickSubtitleTrack/, 'embedded MKV subtitle switching must call pickSubtitleTrack');
      assert.match(embedJsSrc, /evt\.currentTarget !== video/, 'media listener registry must ignore stale inactive-element events');
      assert.match(embedJsSrc, /setAttribute\('objectfit'/, 'aspect ratio must propagate objectfit attribute to movi-player');

      // 14f. `/api/status` cookie filtering when `/api/providers` omits `cookieOk`.
      const statusFilteredSlugs = await goldmineSvc.fetchGoldmineProviders({
        apiBase: 'http://goldmine-status.mock',
        fetchImpl: async (reqUrl) => {
          const pathName = new URL(reqUrl).pathname;
          if (pathName === '/api/providers') {
            return new Response(
              JSON.stringify({
                providers: [
                  { name: 'showbox', enabled: true },
                  { name: 'dahmermovies', enabled: true },
                  { name: '4khdhub', enabled: true }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (pathName === '/api/status') {
            return new Response(
              JSON.stringify({
                providers: [
                  { name: 'showbox', enabled: true, cookieRequired: true, cookieOk: false },
                  { name: 'dahmermovies', enabled: true, cookieRequired: false, cookieOk: true },
                  { name: '4khdhub', enabled: true, cookieRequired: false, cookieOk: true }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response('not found', { status: 404 });
        }
      });
      assert.deepStrictEqual(
        statusFilteredSlugs,
        ['dahmermovies', '4khdhub'],
        'fetchGoldmineProviders must drop showbox when /api/status reports cookieOk=false'
      );

      // 14g. Ephemeral Render-IP-bound MP4 demotion, provider-diverse backups & <720p pruning.
      const mixedNorm = goldmineSvc.normalizeGoldminePayload({
        streams: [
          { provider: 'PStream', url: 'https://hk1.shegu.net/feb/1080.mp4', quality: '1080p', title: 'Movie 1080p' },
          { provider: 'PStream', url: 'https://hk1.shegu.net/feb/720.mp4', quality: '720p', title: 'Movie 720p' },
          { provider: 'PStream', url: 'https://hk1.shegu.net/feb/480.mp4', quality: '480p', title: 'Movie 480p' },
          { provider: 'PStream', url: 'https://hk1.shegu.net/feb/360.mp4', quality: '360p', title: 'Movie 360p' },
          { provider: 'vidlink', url: 'https://cdn.vidlink.example/1080.mp4', quality: '1080p', title: 'Vidlink 1080p' },
          { provider: 'vidlink', url: 'https://cdn.vidlink.example/480.mp4', quality: '480p', title: 'Vidlink 480p' },
          { provider: 'videasy', url: 'https://hls.videasy.example/master.m3u8', quality: 'Auto', title: 'Videasy HLS' },
          { provider: 'dahmermovies', url: 'https://p.111477.xyz/Movie.2024.1080p.Hindi.English.Multi-Audio.mkv', quality: '1080p' },
          { provider: 'dahmermovies', url: 'https://p.111477.xyz/Movie.2024.720p.Hindi.English.Multi-Audio.mkv', quality: '720p' },
          { provider: '4khdhub', url: 'https://pixeldrain.dev/api/file/abc123?download', title: 'Movie.2024.1080p.Hindi.mkv', quality: '1080p' }
        ]
      });
      const builtMixed = goldmineSvc.buildGoldminePayload(mixedNorm, {
        proxyStreams: true,
        proxyUrl: (u) => `/api/proxy?url=${encodeURIComponent(u)}`
      });
      assert.ok(builtMixed.rawUrl.includes('p.111477.xyz/Movie.2024.1080p'), 'portable multi-audio MKV must win primary');
      assert.strictEqual(builtMixed.ephemeralOnly, undefined, 'mixed payload with MKV/HLS must not be marked ephemeralOnly');
      assert.ok(
        builtMixed.backupUrls[0].includes(encodeURIComponent('https://pixeldrain.dev/api/file/abc123?download')),
        'first backup must switch to a distinct provider (4khdhub) before repeating primary provider rungs'
      );
      assert.ok(
        !builtMixed.backupUrls.some((u) => u.includes('480.mp4') || u.includes('360.mp4')),
        '<720p ephemeral IP-bound MP4 rungs must be pruned when portable MKV/HLS sources exist'
      );
      const videasyStream = mixedNorm.streams.find((s) => s.provider === 'videasy');
      const pstream1080 = mixedNorm.streams.find((s) => s.url.endsWith('/1080.mp4') && s.provider === 'pstream');
      assert.ok(videasyStream.score > pstream1080.score, 'portable Auto HLS must outscore Render-IP-bound PStream 1080p MP4');
      assert.strictEqual(
        goldmineSvc.isEphemeralIpBoundStream({
          provider: 'pstream',
          container: 'mp4',
          url: 'https://rdp-running-campion.onrender.com/ts-proxy?url=https%3A%2F%2Fhk1.shegu.net%2Ffeb%2F1080.mp4'
        }),
        false,
        'streams already wrapped in TMDB-Embed-API /ts-proxy share Render egress IP and are not IP-mismatched'
      );
      const ephOnlyNorm = goldmineSvc.normalizeGoldminePayload({
        streams: [
          { provider: 'vidlink', url: 'https://cdn.vidlink.example/720.mp4', quality: '720p' },
          { provider: 'vidlink', url: 'https://cdn.vidlink.example/360.mp4', quality: '360p' }
        ]
      });
      const builtEphOnly = goldmineSvc.buildGoldminePayload(ephOnlyNorm, { proxyStreams: false });
      assert.strictEqual(builtEphOnly.ephemeralOnly, true, 'payload with only IP-bound streams must flag ephemeralOnly');
      assert.strictEqual(builtEphOnly.backupUrls.length, 1, '360p rung stays available when no portable streams exist');

      // 14h. Fast ephemeral MP4s must NOT trigger an early abort of in-flight MKV extractors or skip Wave 2.
      let mkvAbortedPrematurely = false;
      const fastWaitRes = await goldmineSvc.fetchGoldmineStreamsFast({
        apiBase: 'http://goldmine-fast-wait.mock',
        type: 'movie',
        tmdbId: '693134',
        timeoutMs: 8000,
        fetchImpl: async (reqUrl, init = {}) => {
          const parsedReq = new URL(reqUrl);
          if (parsedReq.pathname === '/api/providers') {
            await new Promise((r) => setTimeout(r, 40));
            return new Response(
              JSON.stringify({
                providers: [
                  { id: '4khdhub', enabled: true },
                  { id: 'showbox', enabled: true, cookieOk: true },
                  { id: 'streamflix', enabled: true }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          const provMatch = parsedReq.pathname.match(/^\/api\/streams\/([^/]+)\/movie\//);
          const prov = provMatch ? provMatch[1] : '';
          if (prov === 'showbox') {
            return new Response(
              JSON.stringify({
                success: true,
                streams: [{ provider: 'PStream', url: 'https://hk1.shegu.net/feb/1080.mp4', quality: '1080p' }]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (prov === '4khdhub') {
            await new Promise((resolveDelay, rejectDelay) => {
              const t = setTimeout(resolveDelay, 150);
              if (init && init.signal) {
                init.signal.addEventListener('abort', () => {
                  clearTimeout(t);
                  mkvAbortedPrematurely = true;
                  const err = new Error('Aborted');
                  err.name = 'AbortError';
                  rejectDelay(err);
                });
              }
            });
            return new Response(
              JSON.stringify({
                success: true,
                streams: [{ provider: '4khdhub', url: 'https://hub.example/Movie.1080p.Hindi.English.mkv', quality: '1080p' }]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (prov === 'streamflix') {
            return new Response(JSON.stringify({ success: true, streams: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return new Response('not found', { status: 404 });
        }
      });
      assert.strictEqual(mkvAbortedPrematurely, false, '4khdhub MKV must not be aborted when PStream MP4 arrives first');
      assert.strictEqual(fastWaitRes.ok, true);
      assert.ok(
        fastWaitRes.json.streams.some((s) => s.provider === '4khdhub'),
        'fetchGoldmineStreamsFast must wait for 4khdhub MKV instead of settling early on PStream MP4s'
      );

      // When Wave 1 finishes with ONLY ephemeral MP4s, Wave 2 must launch immediately instead of settling.
      let wave2LaunchedOnEphOnly = false;
      const ephWaveRes = await goldmineSvc.fetchGoldmineStreamsFast({
        apiBase: 'http://goldmine-eph-wave2.mock',
        type: 'movie',
        tmdbId: '693134',
        timeoutMs: 8000,
        fetchImpl: async (reqUrl) => {
          const parsedReq = new URL(reqUrl);
          if (parsedReq.pathname === '/api/providers') {
            return new Response(
              JSON.stringify({
                providers: [
                  { id: 'showbox', enabled: true, cookieOk: true },
                  { id: 'streamflix', enabled: true }
                ]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          const provMatch = parsedReq.pathname.match(/^\/api\/streams\/([^/]+)\/movie\//);
          const prov = provMatch ? provMatch[1] : '';
          if (prov === 'showbox') {
            return new Response(
              JSON.stringify({
                success: true,
                streams: [{ provider: 'PStream', url: 'https://hk1.shegu.net/feb/720.mp4', quality: '720p' }]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (prov === 'streamflix') {
            wave2LaunchedOnEphOnly = true;
            return new Response(
              JSON.stringify({
                success: true,
                streams: [{ provider: 'streamflix', url: 'https://hls.streamflix.example/master.m3u8', quality: '1080p' }]
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response('not found', { status: 404 });
        }
      });
      assert.strictEqual(wave2LaunchedOnEphOnly, true, 'Wave 2 must launch immediately when Wave 1 only yielded IP-bound MP4s');
      assert.ok(ephWaveRes.json.streams.some((s) => s.provider === 'streamflix'));

      // 14i. Node + Worker `/api/proxy`: 200-HTML hotlink gate relaxation, stealth text/plain #EXTM3U rewriting & clean 403 JSON.
      const nodeHtmlGate = await httpRequest(
        baseUrl,
        `/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/htmlgate/file.mp4`)}&referer=${encodeURIComponent('https://wrong.example/watch')}`
      );
      assert.strictEqual(nodeHtmlGate.status, 200, 'Node proxy must retry 200 text/html hotlink gate without Referer');
      assert.strictEqual(nodeHtmlGate.headers['x-proxy-relaxed'], 'hotlink');

      const workerHtmlGate = await workerFetch(
        new Request(
          `http://player.test/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/htmlgate/file.mp4`)}&referer=${encodeURIComponent('https://wrong.example/watch')}`
        ),
        {}
      );
      assert.strictEqual(workerHtmlGate.status, 200, 'Worker proxy must retry 200 text/html hotlink gate without Referer');
      assert.strictEqual(workerHtmlGate.headers.get('x-proxy-relaxed'), 'hotlink');

      const nodeStealthM3u8 = await httpRequest(
        baseUrl,
        `/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/stealth/playlist/main.txt`)}`
      );
      assert.strictEqual(nodeStealthM3u8.status, 200, 'Node proxy must accept text/plain #EXTM3U playlists');
      assert.match(nodeStealthM3u8.headers['content-type'] || '', /mpegurl/i);
      assert.ok(nodeStealthM3u8.body.includes('/api/proxy?url='), 'Node proxy must rewrite stealth #EXTM3U variant URIs');

      const workerStealthM3u8 = await workerFetch(
        new Request(
          `http://player.test/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/stealth/playlist/main.txt`)}`
        ),
        {}
      );
      assert.strictEqual(workerStealthM3u8.status, 200, 'Worker proxy must accept text/plain #EXTM3U playlists');
      assert.match(workerStealthM3u8.headers.get('content-type') || '', /mpegurl/i);
      assert.ok(
        (await workerStealthM3u8.text()).includes('/api/proxy?url='),
        'Worker proxy must rewrite stealth #EXTM3U variant URIs'
      );

      const workerDead403 = await workerFetch(
        new Request(`http://player.test/api/proxy?url=${encodeURIComponent(`${mockUpstream.url}/cdn/dead403/file.mp4`)}`),
        {}
      );
      assert.strictEqual(workerDead403.status, 403, 'Worker proxy must return clean 403 JSON without reusing cancelled body');
      assert.strictEqual(workerDead403.headers.get('access-control-allow-origin'), '*');

      // 14j. Player bundle invariants for direct fallback, WASM probe guard & all-failed popover status.
      assert.match(embedJsSrc, /function directFallbackUrlFor/, 'player must unwrap failed /api/proxy streams for direct open-CORS fallback');
      assert.match(embedJsSrc, /function probeProxiedMediaBytes/, 'player must probe /api/proxy before loading 12 MB WASM on failed MP4s');
      assert.match(embedJsSrc, /allStreamsFailed/, 'player must track allStreamsFailed so the final dead source never shows Playing');
      assert.match(
        embedJsSrc,
        /isPlayingSource && state\.activeSourceLive\s*\?\s*'is-playing'/,
        'green is-playing badge must only appear once media playback is genuinely live'
      );
    }

    // Direct-provider, extensionless-MKV, HLS-rendition and audio-source
    // regressions.  These use their own hermetic fetch fixtures and never
    // contact the public providers.
    await require('./audio-regressions')();
    console.log('  ✔ Passed direct-provider and multi-audio regression fixtures.');
    console.log('  ✔ Passed MKV WASM demuxing, fast two-wave fan-out, proxy headers & multi-audio source shifting.');

    console.log('\n==========================================================');
    console.log('  ALL PRODUCTION VERIFICATION SUITES PASSED (0 TEST VIDEOS)');
    console.log('==========================================================');
  } finally {
    server.close();
    mockUpstream.server.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Verification failed:', err);
  process.exit(1);
});
