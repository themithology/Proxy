const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const crypto = require('crypto');
const config = require('../src/config');
const { app } = require('../src/server');
const {
  encryptZxcLink,
  decryptZxcLink,
  signProxyParams,
  verifyProxySignature,
  generateHandshakeToken,
  verifyHandshakeToken
} = require('../src/utils/crypto');
const { srtToVtt } = require('../src/utils/srtToVtt');
const { cache } = require('../src/utils/cache');
const { rewriteM3u8Manifest } = require('../src/services/proxy');
const {
  decodeZokoAnimeXorPayload,
  parseHicineLinks,
  parseHicineAudioHints,
  isHubcloudGeneratorUrl,
  unrollHubcloudUrl,
  extractWrappedMediaTargets,
  normalizePlayableUrl,
  scorePlayableUrl,
  probePlayableMediaUrl,
  resolveHicineServer,
  resolveStreamForServer,
  resolveAndromedaServer,
  resolveCastletv,
  resolveNetmirror,
  resolveUrsaServer,
  resolve4khdhub,
  resolveMoviesdrive4k,
  resolveHicine4k,
  resolveDahmer4k,
  decode4khdhubRedirectHtml,
  rot13Cipher,
  buildCastleKey,
  decryptCastleAes,
  mapLanguageNameToCode,
} = require('../src/services/resolver');
const {
  parseProbeJson,
  mapAudioStreams,
  initializeMultitrack,
  isAllowedSourceUrl,
  sourceCacheKey,
  buildFfmpegArgs,
  buildMasterPlaylist,
  rewriteGeneratedPlaylist,
  createMultiTrackPayload,
  prepareMultiTrackStream,
  verifySignedMaster,
  verifySignedAsset
} = require('../src/services/multitrack');

const identity = require('../src/services/identity');
const { buildDubCatalog, resolveHindiServer } = require('../src/services/dubCatalog');

function encryptCastleAes(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]).toString('base64');
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
 * - OpenSubtitles REST API (/search/...) + Gzipped .srt.gz download (/download/sub.srt.gz)
 * - VidStuck / ZXC (/movie, /backend/meow, /backend/servers/andromeda)
 * - VidSrc.sh (/api.php, /generate.php)
 * - HiCine (/api/search/:q, /api/links, /go)
 */
function startUpstreamMockServer() {
  return new Promise((resolve) => {
    const metrics = { activeUrsaTierRequests: 0, peakUrsaTierRequests: 0 };
    const delayParallelUrsaTier = (marker, response, respond) => {
      if (!/ursa-parallel-test/i.test(String(marker || ''))) return false;
      metrics.activeUrsaTierRequests += 1;
      metrics.peakUrsaTierRequests = Math.max(metrics.peakUrsaTierRequests, metrics.activeUrsaTierRequests);
      setTimeout(() => {
        metrics.activeUrsaTierRequests -= 1;
        if (!response.destroyed && !response.writableEnded) respond();
      }, 180);
      return true;
    };
    const mockSrv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const mockOrigin = `http://${req.headers.host}`;

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

      // Delayed metadata used to verify Cloudflare Worker Ursa tier concurrency.
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

      if (u.pathname === '/tmdb/movie/555555') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 555555,
          title: 'ursa-parallel-test',
          release_date: '2024-01-01',
          runtime: 100,
          genres: [],
          external_ids: {}
        }));
      }

      // Worker-side fixture metadata forces the 4K resolver through Ursa tiers 2–4.
      const workerTierMovieFixtures = {
        '/tmdb/movie/555551': { title: 'fail-4khdhub Dune: Part Two', imdbId: 'tt15239678' },
        '/tmdb/movie/555552': { title: 'fail-4khdhub fail-moviesdrive Dune: Part Two', imdbId: 'fail-moviesdrive' },
        '/tmdb/movie/555553': { title: 'fail-4khdhub fail-moviesdrive fail-hicine4k Dune: Part Two', imdbId: 'fail-moviesdrive' }
      };
      const workerTierFixture = workerTierMovieFixtures[u.pathname];
      if (workerTierFixture) {
        const id = Number(u.pathname.split('/').pop());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id,
          title: workerTierFixture.title,
          release_date: '2024-02-27',
          runtime: 167,
          genres: [{ id: 878, name: 'Science Fiction' }],
          imdb_id: workerTierFixture.imdbId,
          external_ids: { imdb_id: workerTierFixture.imdbId }
        }));
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

      // 4. IntroDB Skip Intro API
      if (u.pathname === '/introdb/intro') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            imdb_id: u.searchParams.get('imdb_id'),
            season: Number(u.searchParams.get('season') || 1),
            episode: Number(u.searchParams.get('episode') || 1),
            start_sec: 200,
            end_sec: 266
          })
        );
      }

      // 5. OpenSubtitles REST API + .srt.gz Gzipped Subtitle Stream
      if (u.pathname.startsWith('/opensubtitles/search/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify([
            {
              IDSubtitleFile: '1957433621',
              ISO639: 'en',
              SubLanguageID: 'eng',
              LanguageName: 'English',
              SubHearingImpaired: '0',
              SubDownloadsCnt: '329244',
              SubDownloadLink: `${mockOrigin}/opensubtitles/download/1957433621.gz`
            },
            {
              IDSubtitleFile: '1957440969',
              ISO639: 'ar',
              SubLanguageID: 'ara',
              LanguageName: 'Arabic',
              SubHearingImpaired: '0',
              SubDownloadsCnt: '88178',
              SubDownloadLink: `${mockOrigin}/opensubtitles/download/1957440969.gz`
            }
          ])
        );
      }

      if (u.pathname.startsWith('/opensubtitles/download/')) {
        const sampleSrt =
          '1\r\n00:00:01,000 --> 00:00:04,500\r\nWelcome to Piltover and Zaun.\r\n\r\n2\r\n00:03:20,000 --> 00:04:26,000\r\n[ Enemy by Imagine Dragons playing ]\r\n';
        const gzBuf = zlib.gzipSync(Buffer.from(sampleSrt, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
        return res.end(gzBuf);
      }

      // 6. VidStuck / ZXC Upstream (/movie, /backend/meow, /backend/servers/andromeda)
      if (u.pathname === '/zxc/movie') {
        res.writeHead(200, { 'Set-Cookie': 'zxc_sess=live_ok; Path=/' });
        return res.end('ok');
      }

      if (u.pathname === '/vidstuck/backend/meow' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ token: 'meow-live-jwt-token' }));
      }

      if (u.pathname.startsWith('/vidstuck/backend/servers/')) {
        const encryptedPath = encryptZxcLink(`${mockOrigin}/cdn/hls/master.m3u8`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            data: {
              link: encryptedPath,
              audioTracks: [
                { id: 'en-sub', lang: 'en', label: 'English sub', type: 'sub', url: `${mockOrigin}/cdn/hls/master.m3u8` },
                { id: 'en-dub', lang: 'en', label: 'English dub', type: 'dub', url: `${mockOrigin}/cdn/hls/master-dub.m3u8` },
                { id: 'hi-dub', lang: 'hi', label: 'Hindi dub', type: 'dub', url: `${mockOrigin}/cdn/hls/master-hi.m3u8` },
                { id: 'fr-dub', lang: 'fr', label: 'French dub', type: 'dub', url: `${mockOrigin}/cdn/hls/master-fr.m3u8`, default: true }
              ],
              qualities: [
                { label: 'Auto', height: 0, url: `${mockOrigin}/cdn/hls/master.m3u8` },
                { label: '1080p', height: 1080, url: `${mockOrigin}/cdn/hls/1080p.m3u8` },
                { label: '720p', height: 720, url: `${mockOrigin}/cdn/hls/720p.m3u8` }
              ]
            }
          })
        );
      }

      // 7. VidSrc.sh Upstream (/vidsrc/api.php & /generate.php)
      if (u.pathname === '/vidsrc/api.php') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            data: {
              stream_urls: [`${mockOrigin}/cdn/hls/vidsrc-master.m3u8`]
            }
          })
        );
      }

      if (u.pathname === '/generate.php') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ token: 'vidsrc-short-lived-jwt' }));
      }

      // 8b. HubCloud generator landing pages (Centaurus unroller fixtures).
      //     Mirrors the live chain: gpdl2 302 → dl.php?link=<direct>, plus
      //     countdown pages that hide the CDN URL in JS / nested wrappers.
      if (u.pathname === '/hubcloud/gen-redirect') {
        res.writeHead(302, {
          Location: `/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}/cdn/hls/fight%20club.mkv`)}`
        });
        return res.end();
      }

      if (u.pathname === '/hubcloud/dl.php') {
        const target = u.searchParams.get('link') || '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><head><title>HubCloud — Link Generator</title></head><body>` +
            `<h1>Generating Download Link</h1>` +
            `<a id="download" href="${target}">Download Here</a>` +
            `</body></html>`
        );
      }

      if (u.pathname === '/hubcloud/countdown-js') {
        // The real CDN link lives inside obfuscated inline JS (`\/` escapes),
        // hidden behind a 3.5s setTimeout that only toggles the anchor href.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body><h1>Generating Download Link</h1>` +
            `<a id="download" href="${mockOrigin}/hubcloud/countdown-js">Download Here</a>` +
            `<script>setTimeout(function(){document.getElementById('download').href=` +
            `"https:\\/\\/pub-1a2b.r2.dev\\/movies\\/Fight-Club-1999.mkv";},3500);</script>` +
            `</body></html>`
        );
      }

      if (u.pathname === '/hubcloud/drive-page') {
        // Page 1 of the two-hop flow: <a id="download"> → another generator wrapper
        const nested = `/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}/cdn/hls/arcane-s1e1.mp4`)}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body><a id="download" href="${nested}">Download</a></body></html>`
        );
      }

      if (u.pathname === '/hubcloud/pixeldrain-page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<html><body><a href="https://pixeldrain.com/u/AbCdEf123">Download</a></body></html>'
        );
      }

      if (u.pathname === '/hubcloud/mirror-test') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<html><body>' +
            '<a href="https://dead-copy.r2.dev/dead.mkv">First mirror</a>' +
            '<a href="https://good-copy.r2.dev/good.mkv">Second mirror</a>' +
            '</body></html>'
        );
      }

      if (u.pathname === '/hubcloud/no-links') {
        // Countdown page that only links to itself → unroll must give up cleanly
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body><h1>Generating Download Link</h1>` +
            `<a id="download" href="${mockOrigin}/hubcloud/no-links">Download Here</a>` +
            `</body></html>`
        );
      }

      if (u.pathname === '/hubcloud/challenge') {
        // Cloudflare managed-challenge interstitial (what datacenter fetchers
        // see on gpdl2.hubcloud.ist) — must be detected and treated as failed.
        // Served with 200 on purpose so the marker-based detection runs.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<html><head><title>Just a moment...</title></head><body>' +
            '<h1>Performing security verification</h1>' +
            '<div id="challenge-platform"></div><div class="cf-turnstile"></div>' +
            'Verification successful. Waiting for gpdl2.hubcloud.ist to respond' +
            '</body></html>'
        );
      }

      // 8c. HiCine end-to-end: /go answers with a HubCloud dl.php wrapper
      //     (the exact live failure mode) instead of a media file.
      if (u.pathname === '/api/links') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            title: 'Fight Club (1999)',
            tokens: { ten: { ts: '1700000000', sig: 'deadbeefcafe' } }
          })
        );
      }

      if (u.pathname === '/go') {
        const vcloudParam = u.searchParams.get('vcloud') || '';
        const mediaPath = vcloudParam.includes('dune2160p')
          ? '/cdn/4k/hicine-dune-2160p-4k.mkv'
          : '/cdn/hls/fight%20club.mkv';
        res.writeHead(302, {
          Location: `${mockOrigin}/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}${mediaPath}`)}`
        });
        return res.end();
      }

      if (u.pathname.startsWith('/hicine/api/search/')) {
        const searchTitle = decodeURIComponent(u.pathname.split('/').pop() || '');
        const isRrr = /\brrr\b/i.test(searchTitle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify([
            {
              title: isRrr ? 'RRR' : 'Fight Club',
              releaseYear: isRrr ? 2022 : 1999,
              contentType: 'movies',
              links: isRrr
                ? `RRR (2022) Hindi+Telugu Dual Audio 720p : ${mockOrigin}/hicine/w?vcloud=https://vcloud.fit/rrr720`
                : `720p : ${mockOrigin}/hicine/w?vcloud=https://vcloud.fit/fightclub720`
            }
          ])
        );
      }

      // 8. Upstream HLS Playlist for Proxy Rewriter verification
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

      // 8b. Deliberately-down upstream mocks: used to prove tier cascading
      // without encoding failure markers into the (identity-validated) title.
      if (u.pathname.startsWith('/castletv-down')) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('castle down');
      }

      // 9. CastleTV Mock Upstream (/castletv/...)
      if (u.pathname === '/castletv/v0.1/system/getSecurityKey/1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ code: 200, data: 'MTIzNDU2Nzg5MA==' }));
      }

      if (u.pathname === '/castletv/film-api/v1.1.0/movie/searchByKeyword') {
        const keyword = (u.searchParams.get('keyword') || '').toLowerCase();
        const mockKey = buildCastleKey('MTIzNDU2Nzg5MA==');
        if (keyword.includes('fail-castle') || keyword.includes('cascade-test-fail-all')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(encryptCastleAes(JSON.stringify({ code: 200, data: { rows: [] } }), mockKey));
        }
        // Title-collision scenario (the real CastleTV catalog): the 2023 Indian
        // "Fight Club" (with a Hindi dub) outranks the 1999 film. Identity
        // validation must pick the 1999 film and never the 2023 one.
        if (keyword.includes('fight club')) {
          const collisionCipher = encryptCastleAes(
            JSON.stringify({
              code: 200,
              data: {
                rows: [
                  {
                    id: 'castle-fc-2023',
                    title: 'Fight Club',
                    name: 'Fight Club',
                    publishTime: Date.UTC(2023, 9, 1),
                    movieType: 2,
                    movieTypeName: 'Movies',
                    languages: ['Tamil', 'Hindi', 'Telugu'],
                    tags: ['Action']
                  },
                  {
                    id: 'castle-fc-1999',
                    title: 'Fight Club',
                    name: 'Fight Club',
                    publishTime: Date.UTC(1999, 9, 15),
                    movieType: 2,
                    movieTypeName: 'Movies',
                    languages: ['English'],
                    tags: ['Drama', 'Thriller']
                  },
                  {
                    id: 'castle-fc-members',
                    title: 'Fight Club - Members Only',
                    name: 'Fight Club - Members Only',
                    publishTime: Date.UTC(2006, 4, 1),
                    movieType: 2,
                    movieTypeName: 'Movies',
                    languages: ['Hindi'],
                    tags: ['Action', 'Drama']
                  }
                ]
              }
            }),
            mockKey
          );
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(collisionCipher);
        }
        const cipher = encryptCastleAes(
          JSON.stringify({
            code: 200,
            data: {
              rows: [
                {
                  id: 'castle-m-101',
                  title: 'Dune: Part Two',
                  name: 'Dune: Part Two'
                }
              ]
            }
          }),
          mockKey
        );
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(cipher);
      }

      if (u.pathname === '/castletv/film-api/v1.9.9/movie') {
        const mockKey = buildCastleKey('MTIzNDU2Nzg5MA==');
        const requestedMovieId = u.searchParams.get('movieId');
        if (requestedMovieId === 'castle-fc-1999') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(
            encryptCastleAes(
              JSON.stringify({
                code: 200,
                data: {
                  title: 'Fight Club',
                  episodes: [
                    {
                      id: 'castle-fc-1999-ep1',
                      number: 1,
                      tracks: [{ languageId: 'en', languageName: 'English', existIndividualVideo: false }]
                    }
                  ]
                }
              }),
              mockKey
            )
          );
        }
        if (requestedMovieId === 'castle-fc-2023') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(
            encryptCastleAes(
              JSON.stringify({
                code: 200,
                data: {
                  title: 'Fight Club',
                  episodes: [
                    {
                      id: 'castle-fc-2023-ep1',
                      number: 1,
                      tracks: [
                        { languageId: 'hi', languageName: 'Hindi', existIndividualVideo: true },
                        { languageId: 'ta', languageName: 'Tamil', existIndividualVideo: true }
                      ]
                    }
                  ]
                }
              }),
              mockKey
            )
          );
        }
        const cipher = encryptCastleAes(
          JSON.stringify({
            code: 200,
            data: {
              episodes: [
                {
                  id: 'castle-ep-1',
                  number: 1,
                  tracks: [
                    { languageId: 'en', languageName: 'English' },
                    { languageId: 'hi', languageName: 'Hindi' },
                    { languageId: 'ta', languageName: 'Tamil' },
                    { languageId: 'te', languageName: 'Telugu' }
                  ]
                }
              ]
            }
          }),
          mockKey
        );
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(cipher);
      }

      if (u.pathname === '/castletv/film-api/v2.0.1/movie/getVideo2') {
        let rawBody = '';
        req.on('data', (c) => { rawBody += c; });
        req.on('end', () => {
          let bodyObj = {};
          try { bodyObj = JSON.parse(rawBody); } catch {}
          const lang = bodyObj.languageId || 'en';
          const mockKey = buildCastleKey('MTIzNDU2Nzg5MA==');
          const cipher = encryptCastleAes(
            JSON.stringify({
              code: 200,
              data: {
                videoUrl: `${mockOrigin}/cdn/hls/castle-${lang}.m3u8`
              }
            }),
            mockKey
          );
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(cipher);
        });
        return;
      }

      // 11. NetMirror Mock Upstream (/netmirror/...)      // 11. NetMirror Mock Upstream (/netmirror/...)
      if (u.pathname === '/checknewtv.php') {
        const tokenHash = Buffer.from(mockOrigin).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ token_hash: tokenHash, var: '1.0' }));
      }

      if (u.pathname === '/newtv/search.php') {
        const query = u.searchParams.get('s') || '';
        if (query.includes('fail-netmirror') || query.includes('cascade-test-fail-all')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ searchResult: [], img_referer: 'https://net77.cc' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            searchResult: [{ id: 'nm-live-999', t: query }],
            img_referer: 'https://net77.cc'
          })
        );
      }

      if (u.pathname === '/newtv/player.php') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            status: 'ok',
            video_link: `${mockOrigin}/cdn/hls/netmirror-master.m3u8`,
            referer: 'https://net77.cc'
          })
        );
      }

      if (u.pathname.startsWith('/netmirror/api/embed-tmdb/')) {
        const pathParts = u.pathname.split('/');
        const tmdbParam = pathParts[pathParts.length - 1];
        if (tmdbParam.includes('fail-netmirror') || tmdbParam.includes('cascade-test-fail-all')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            ok: true,
            streams: [
              {
                resolution: 1080,
                url: `${mockOrigin}/cdn/hls/netmirror-embed.m3u8`
              }
            ],
            // NetMirror hands out alternates for its rate-limiting CDN.
            fallbackHls: `${mockOrigin}/cdn/hls/netmirror-fallback.m3u8`,
            direct: `${mockOrigin}/cdn/mp4/netmirror-direct.mp4`
          })
        );
      }

      // 12a. 4KHDHub Mock Upstream (/4khdhub/...)
      if (u.pathname === '/4khdhub/' || u.pathname === '/4khdhub') {
        const sQuery = (u.searchParams.get('s') || '').toLowerCase();
        if (delayParallelUrsaTier(sQuery, res, () => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><div class="card-grid"></div></body></html>');
        })) return;
        if (sQuery.includes('fail-4khdhub') || sQuery.includes('4k-cascade-fail-all') || sQuery.includes('cascade-test-fail-all')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<html><body><div class="card-grid"></div></body></html>');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (/arcane/i.test(sQuery)) {
          return res.end(
            `<html><body><div class="card-grid">` +
              `<a class="movie-card nested" href="/4khdhub/arcane-series-200/">` +
              `<div class="movie-card-content"><h3 class="movie-card-title"><span>Arcane</span></h3>` +
              `<p class="movie-card-meta"><span>2021</span> • Series</p></div></a>` +
              `</div></body></html>`
          );
        }
        return res.end(
          `<html><body><div class="card-grid">` +
            `<a href="${mockOrigin}/4khdhub/dune-part-two-movie-199/" class="movie-card">` +
            `<div class="movie-card-content"><h3 class="movie-card-title">Dune: Part Two</h3>` +
            `<p class="movie-card-meta">2024 • 167 min</p></div></a>` +
            `</div></body></html>`
        );
      }

      if (u.pathname === '/4khdhub/arcane-series-200/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body><main id="episodes">` +
            `<section class="episode-card"><div class="episode-number"><span>S01E01</span></div>` +
            `<div class="episode-info"><h3>Welcome to the Playground</h3>` +
            `<div class="episode-download-item nested"><div class="download-row">` +
            `<p class="file-title">Arcane.S01E01.2160p.WEB-DL.SDR.x264.AAC.[Hindi+English].8GB.mkv</p>` +
            `<a href="../redirect?id=arcane2160"><span>Download HubCloud</span></a></div></div>` +
            `<div class="episode-download-item"><div class="download-row">` +
            `<p class="file-title">Arcane.S01E01.1080p.WEB-DL.x264.[Hindi+English].3GB.mkv</p>` +
            `<a href="../redirect?id=arcane1080">Download HubCloud</a></div></div></section>` +
            `<section class="episode-card"><div class="episode-number">S01E02</div>` +
            `<div class="episode-download-item"><p class="file-title">Arcane.S01E02.2160p.REMUX.TrueHD.55GB.mkv</p>` +
            `<a href="../redirect?id=wrong-episode">Download</a></div></section>` +
            `</main></body></html>`
        );
      }

      if (u.pathname === '/4khdhub/dune-part-two-movie-199/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body>` +
            `<div class="download-item">` +
            `<div class="file-title">Dune.Part.Two.2024.2160p.4K.UHD.BluRay.REMUX.DV.HDR.[Hindi.DDP5.1+English.TrueHD.Atmos.7.1].H.265.mkv <span class="badge">61.6 GB</span></div>` +
            `<div class="grid"><a href="${mockOrigin}/4khdhub/redirect?id=chain4k-remux">Download HubCloud</a></div>` +
            `</div>` +
            `<div class="download-item">` +
            `<div class="file-title">Dune.Part.Two.2024.2160p.4K.WEB-DL.SDR.x264.AAC.[Hindi+English].11GB.mkv <span class="badge">11 GB</span></div>` +
            `<div class="grid"><a href="../redirect?id=chain4k-webdl">Download HubCloud</a></div>` +
            `</div>` +
            `<div class="download-item">` +
            `<div class="file-title">Dune.Part.Two.2024.1080p.BluRay.[Hindi+English].x264.mkv <span class="badge">4.2 GB</span></div>` +
            `<div class="grid"><a href="../redirect?id=chain1080">Download HubCloud</a></div>` +
            `</div>` +
            `</body></html>`
        );
      }

      if (u.pathname === '/4khdhub/redirect') {
        const id = u.searchParams.get('id') || 'chain4k';
        const directTargets = {
          'chain1080': `${mockOrigin}/cdn/4k/dune-1080p-dual.mkv`,
          'chain4k-remux': `${mockOrigin}/cdn/4k/dune-2160p-4k-dual.mkv`,
          'arcane2160': `${mockOrigin}/cdn/4k/arcane-s1e1-2160p.mkv`,
          'arcane1080': `${mockOrigin}/cdn/4k/arcane-s1e1-1080p.mkv`,
          'wrong-episode': `${mockOrigin}/cdn/4k/arcane-s1e2-wrong.mkv`
        };
        const directTarget = directTargets[id] || `${mockOrigin}/cdn/4k/dune-2160p-webdl.mkv`;
        const pageWrappedTarget = `https://dune-stream.pages.dev/?u=${Buffer.from(directTarget, 'utf8').toString('base64url')}`;
        const terminalTarget = id === 'chain4k-remux' || id === 'chain1080' || id.startsWith('arcane') || id === 'wrong-episode'
          ? directTarget
          : pageWrappedTarget;
        const targetHub = `${mockOrigin}/hubcloud/dl.php?link=${encodeURIComponent(terminalTarget)}`;
        const innerJson = JSON.stringify({ o: Buffer.from(targetHub, 'utf8').toString('base64') });
        const stepB64 = Buffer.from(innerJson, 'utf8').toString('base64');
        const stepRot = rot13Cipher(stepB64);
        const step2 = Buffer.from(stepRot, 'utf8').toString('base64');
        const encoded = Buffer.from(step2, 'utf8').toString('base64');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<html><body><script>s('o','${encoded}',1800);</script></body></html>`);
      }

      // 12b. MoviesDrive 4K Mock Upstream (/moviesdrive/... & /mdrive/archive/...)
      if (u.pathname === '/moviesdrive/search.php') {
        const q = (u.searchParams.get('q') || '').toLowerCase();
        if (delayParallelUrsaTier(q, res, () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: 0, hits: [] }));
        })) return;
        if (q.includes('fail-moviesdrive') || q.includes('4k-cascade-fail-all') || q.includes('cascade-test-fail-all')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ found: 0, hits: [] }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            found: 1,
            hits: [
              {
                document: {
                  imdb_id: 'tt15239678',
                  post_title: 'Dune: Part Two (2024) Dual Audio [Hindi + English] 4K 2160p BluRay',
                  permalink: '/moviesdrive/dune-part-two-2024/'
                }
              }
            ]
          })
        );
      }

      if (u.pathname === '/moviesdrive/dune-part-two-2024/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body>` +
            `<h5>Dune: Part Two (2024) [Hindi.DDP5.1 + English.DDPA5.1] 2160p 4K AMZN WEB-DL SDR H.265 [19GB]</h5>` +
            `<p><a href="${mockOrigin}/mdrive/archive/20906">2160p SDR [19GB]</a></p>` +
            `<h5>Dune: Part Two (2024) [Hindi + English] 1080p BluRay x264 [3.4GB]</h5>` +
            `<p><a href="${mockOrigin}/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}/cdn/4k/mdrive-1080p.mkv`)}">1080p HubCloud</a></p>` +
            `</body></html>`
        );
      }

      if (u.pathname === '/mdrive/archive/20906') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body>` +
            `<a href="${mockOrigin}/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}/cdn/4k/mdrive-dune-2160p-4k.mkv`)}">HubCloud [Fast DL]</a>` +
            `</body></html>`
        );
      }

      // 12c. HiCine 4K Mock Upstream (/hicine4k/...)
      if (u.pathname.startsWith('/hicine4k/api/search/')) {
        const searchTitle = decodeURIComponent(u.pathname.split('/').pop() || '').toLowerCase();
        if (delayParallelUrsaTier(searchTitle, res, () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
        })) return;
        if (searchTitle.includes('fail-hicine4k') || searchTitle.includes('4k-cascade-fail-all') || searchTitle.includes('cascade-test-fail-all')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify([]));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify([
            {
              title: 'Dune: Part Two',
              releaseYear: 2024,
              contentType: 'movies',
              links: [
                `Dune: Part Two (2024) [Hindi + English] 720p, ${mockOrigin}/hicine/w?vcloud=https://vcloud.fit/dune720`,
                `Dune: Part Two (2024) [Hindi + English] 1080p, ${mockOrigin}/hicine/w?vcloud=https://vcloud.fit/dune1080`,
                `Dune: Part Two (2024) [Hindi.DDP5.1 + English.DDPA5.1] [2160P] SDR 2160p [19GB], ${mockOrigin}/hicine4k/w?vcloud=https://vcloud.fit/dune2160p`
              ].join('\n')
            }
          ])
        );
      }

      if (u.pathname === '/hicine4k/go' || (u.pathname === '/go' && (u.searchParams.get('vcloud') || '').includes('dune2160p'))) {
        res.writeHead(302, {
          Location: `${mockOrigin}/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}/cdn/4k/hicine-dune-2160p-4k.mkv`)}`
        });
        return res.end();
      }

      // 12d. DahmerMovies 4K Open Directory Mock Upstream (/dahmer/...)
      if (u.pathname.startsWith('/dahmer/movies/')) {
        const decodedPath = decodeURIComponent(u.pathname).toLowerCase();
        if (delayParallelUrsaTier(decodedPath, res, () => {
          res.writeHead(404);
          res.end('Not found');
        })) return;
        if (decodedPath.includes('fail-dahmer') || decodedPath.includes('4k-cascade-fail-all') || decodedPath.includes('cascade-test-fail-all')) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><body><table>` +
            `<tr><td><a href="${mockOrigin}/cdn/4k/Dune.Part.Two.2024.HDR.2160p.Multi.Audio.Hindi.English.mkv">Dune.Part.Two.2024.HDR.2160p.Multi.Audio.Hindi.English.mkv</a></td><td data-sort="31366263767">29.21 GB</td></tr>` +
            `<tr><td><a href="${mockOrigin}/cdn/4k/Dune.Part.Two.2024.1080p.BluRay.REMUX.Multi.Audio.mkv">Dune.Part.Two.2024.1080p.BluRay.REMUX.Multi.Audio.mkv</a></td><td data-sort="15000000000">14.0 GB</td></tr>` +
            `</table></body></html>`
        );
      }

      if (u.pathname.startsWith('/cdn/4k/')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end('fake-4k-2160p-video-stream');
      }

      res.writeHead(404);
      res.end('Not found');
    });

    mockSrv.listen(0, '127.0.0.1', () => {
      const addr = mockSrv.address();
      resolve({
        server: mockSrv,
        url: `http://127.0.0.1:${addr.port}`,
        metrics
      });
    });
  });
}

async function runTests() {
  console.log('==========================================================');
  console.log('  LOL Embed Backend — Verification Suite');
  console.log('==========================================================\n');

  // 1. Cryptographic Unit Tests (AES-256-CBC + HMAC-SHA256 + Handshake Token)
  console.log('[1/10] Testing AES-256-CBC (ZXC OpenSSL EVP_BytesToKey) & HMAC Signing...');
  const sampleStreamPath = '/pl/token123/master.m3u8?exp=1790000000';
  const encrypted = encryptZxcLink(sampleStreamPath);
  const decrypted = decryptZxcLink(encrypted);
  assert.strictEqual(decrypted, sampleStreamPath, 'AES-256-CBC decrypted link must match original');

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signProxyParams('https://cdn.example.com/hls/master.m3u8', 'https://vidstuck.xyz/', exp);
  assert.strictEqual(
    verifyProxySignature('https://cdn.example.com/hls/master.m3u8', 'https://vidstuck.xyz/', exp, sig),
    true,
    'Valid HMAC proxy signature must verify'
  );
  assert.strictEqual(
    verifyProxySignature('https://evil.example.com/hls/master.m3u8', 'https://vidstuck.xyz/', exp, sig),
    false,
    'Tampered URL must fail HMAC verification'
  );

  const hsToken = generateHandshakeToken({ type: 'tv', id: '94605', season: 1, episode: 1 });
  const hsPayload = verifyHandshakeToken(hsToken);
  assert.ok(hsPayload && hsPayload.id === '94605', 'Handshake token must verify');
  console.log('  ✔ Passed cryptographic verification.');

  // 2. ZokoAnime XOR ("otaku-embed-v1") & HiCine Link Parser Unit Tests
  console.log('[2/10] Testing ZokoAnime XOR Decryptor & HiCine Multi-Quality Link Parser...');
  const rawZokoJson = JSON.stringify({
    data: {
      sources: { file: 'https://cdn.zokoanime.video/hls/arcane-ep1/master.m3u8' },
      tracks: [{ file: 'https://cdn.zokoanime.video/subs/en.vtt', label: 'English', kind: 'captions' }]
    }
  });
  const xorKey = Buffer.from('otaku-embed-v1', 'utf8');
  const plainBuf = Buffer.from(rawZokoJson, 'utf8');
  const xorBuf = Buffer.alloc(plainBuf.length);
  for (let i = 0; i < plainBuf.length; i++) {
    xorBuf[i] = plainBuf[i] ^ xorKey[i % xorKey.length];
  }
  const decodedZoko = decodeZokoAnimeXorPayload(xorBuf.toString('base64'));
  assert.strictEqual(
    decodedZoko.streamUrl,
    'https://cdn.zokoanime.video/hls/arcane-ep1/master.m3u8',
    'ZokoAnime XOR decryptor must extract .m3u8 master URL'
  );

  const sampleHicineSeason1 = [
    'Episode 1 : ',
    '480p : https://frosty-snowflake-407a.renker2364.workers.dev/?vcloud=https://vcloud.fit/ep1_480, https://pixeldrain.dev/u/AbCdEf123',
    '720p : https://frosty-snowflake-407a.renker2364.workers.dev/?vcloud=https://vcloud.fit/ep1_720',
    '1080p : https://frosty-snowflake-407a.renker2364.workers.dev/?vcloud=https://vcloud.fit/ep1_1080',
    'Episode 2 : ',
    '1080p : https://frosty-snowflake-407a.renker2364.workers.dev/?vcloud=https://vcloud.fit/ep2_1080'
  ].join('\n');
  const parsedEp1 = parseHicineLinks(sampleHicineSeason1, true, 1);
  assert.ok(parsedEp1.length === 4, 'HiCine parser must isolate Episode 1 links only');
  assert.ok(
    parsedEp1.some((l) => l.type === 'pixeldrain' && l.url === 'https://pixeldrain.dev/api/file/AbCdEf123?download'),
    'HiCine parser must convert pixeldrain.dev /u/ links to downloadable API URLs'
  );
  const pixelApiEntry = parseHicineLinks('2160p : https://pixeldrain.com/api/file/Ab_C-123')[0];
  assert.ok(pixelApiEntry && pixelApiEntry.url === 'https://pixeldrain.dev/api/file/Ab_C-123?download', 'Pixeldrain .com API URLs and URL-safe IDs must normalize');
  assert.ok(
    parsedEp1.some(
      (link) => link.type === 'vcloud_worker' &&
        link.url.includes('vcloud=https://vcloud.fit/ep1_480')
    ),
    'HiCine parser must preserve vCloud worker links as a separate resolvable source type'
  );
  const hintedVcloudLink = parseHicineLinks(
    'RRR Hindi+Telugu Dual Audio : https://frosty-snowflake.workers.dev/?vcloud=https://vcloud.fit/rrr'
  )[0];
  assert.ok(hintedVcloudLink && hintedVcloudLink.type === 'vcloud_worker');
  assert.deepStrictEqual(
    hintedVcloudLink.audioHints.languages.map((language) => language.code),
    ['hi', 'te'],
    'Filename language hints must flow through vCloud candidate parsing, not just Pixeldrain'
  );
  const urlOnlyLanguageWords = parseHicineLinks(
    '720p : https://english.workers.dev/?vcloud=https://vcloud.fit/eng/rrr'
  )[0];
  assert.deepStrictEqual(
    urlOnlyLanguageWords.audioHints.languages,
    [],
    'CDN host names and token paths must not be mistaken for filename language hints'
  );

  const dualAudioHints = parseHicineAudioHints(
    'RRR (2022) Hindi+Telugu [DD 5.1] 2160p 4K WEB-DL'
  );
  assert.deepStrictEqual(
    dualAudioHints.languages.map((language) => language.code),
    ['hi', 'te'],
    'HiCine filename hints must preserve Hindi+Telugu order as ISO language codes'
  );
  assert.strictEqual(dualAudioHints.multi, true, 'Two detected languages imply a multi-audio release');
  const originalEnglishHints = parseHicineAudioHints('1080p ORG. Audio Eng WEB-DL');
  assert.deepStrictEqual(
    originalEnglishHints.languages.map((language) => language.code),
    ['en'],
    'HiCine Eng token must map to English'
  );
  assert.strictEqual(originalEnglishHints.original, true, 'ORG. Audio is an original-audio hint');
  const bengaliDualHints = parseHicineAudioHints('Original Audio Beng Dual Audio WEB-DL');
  assert.deepStrictEqual(
    bengaliDualHints.languages.map((language) => language.code),
    ['bn'],
    'HiCine Beng alias must map to Bengali'
  );
  assert.strictEqual(bengaliDualHints.original, true, 'Original Audio must be detected as an original-track hint');
  assert.strictEqual(bengaliDualHints.multi, true, 'Dual Audio text must be retained as a multi-audio hint');

  const probeFixture = parseProbeJson({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { index: 1, codec_type: 'video', codec_name: 'hevc', disposition: { attached_pic: 0 } },
      {
        index: 2,
        codec_type: 'audio',
        codec_name: 'eac3',
        channels: 6,
        channel_layout: '5.1',
        tags: { language: 'hin', title: 'Hindi 5.1' },
        disposition: { default: 1 }
      },
      {
        index: 3,
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        tags: { language: 'und' },
        disposition: { default: 0 }
      }
    ]
  });
  assert.deepStrictEqual(
    probeFixture.videoStreams.map((stream) => stream.index),
    [1],
    'Attached cover art must not be mistaken for the video stream'
  );
  const mappedProbeTracks = mapAudioStreams(probeFixture.streams, dualAudioHints.languages);
  assert.deepStrictEqual(
    mappedProbeTracks.map((track) => track.lang),
    ['hi', 'te'],
    'ffprobe ISO-639-2 language tags and filename fallbacks must map to ISO-639-1'
  );
  const packagingArgs = buildFfmpegArgs(
    'https://pub-abc.r2.dev/movies/RRR.mkv',
    probeFixture,
    mappedProbeTracks,
    '/tmp/proxy-multitrack-test'
  );
  const outputMaps = packagingArgs.reduce((maps, argument, index) => {
    if (argument === '-map') maps.push(packagingArgs[index + 1]);
    return maps;
  }, []);
  assert.deepStrictEqual(outputMaps, ['0:1', '0:2', '0:3']);
  assert.strictEqual(
    isAllowedSourceUrl('https://pub-abc.r2.dev/movies/RRR.mkv?token=rotating'),
    true,
    'Public HTTPS media from an allowlisted R2 CDN must be eligible for remuxing'
  );
  assert.strictEqual(isAllowedSourceUrl('http://pub-abc.r2.dev/movies/RRR.mkv'), false);
  assert.strictEqual(isAllowedSourceUrl('https://r2.dev.attacker.example/RRR.mkv'), false);
  assert.strictEqual(isAllowedSourceUrl('https://pub-abc.r2.dev/movies/master.m3u8'), false);

  const multiTrackPayload = createMultiTrackPayload(
    'https://pub-abc.r2.dev/movies/RRR.mkv?token=rotating',
    probeFixture,
    dualAudioHints.languages
  );
  assert.ok(multiTrackPayload, 'Two ffprobe audio streams must create an HLS payload');
  assert.strictEqual(multiTrackPayload.format, 'hls');
  assert.strictEqual(multiTrackPayload.audioTracks.length, 2);
  assert.ok(multiTrackPayload.audioTracks.every((track) => track.streamUrl === multiTrackPayload.streamUrl));
  assert.strictEqual(
    sourceCacheKey('https://pub-abc.r2.dev/movies/RRR.mkv?token=old'),
    sourceCacheKey('https://pub-abc.r2.dev/movies/RRR.mkv?token=new'),
    'Rotating auth tokens must not duplicate cached packages'
  );
  assert.notStrictEqual(
    sourceCacheKey('https://download.googleusercontent.com/get?id=file-one&token=x'),
    sourceCacheKey('https://download.googleusercontent.com/get?id=file-two&token=x'),
    'Stable query parameters that identify another media object must remain in the cache key'
  );
  const masterParams = new URL(multiTrackPayload.streamUrl, 'https://proxy.example.test').searchParams;
  assert.strictEqual(
    verifySignedMaster(
      masterParams.get('url'),
      masterParams.get('lang'),
      masterParams.get('exp'),
      masterParams.get('sig')
    ),
    true,
    'Multi-track master URL must be protected by the existing HMAC signature'
  );
  const generatedMaster = buildMasterPlaylist(mappedProbeTracks);
  assert.ok(generatedMaster.includes('LANGUAGE="hi"'));
  assert.ok(generatedMaster.includes('URI="track_1.m3u8"'));
  const rewrittenMaster = rewriteGeneratedPlaylist(
    generatedMaster,
    'a'.repeat(64),
    masterParams.get('exp')
  );
  assert.ok(
    rewrittenMaster.includes(`/api/multitrack/file/${'a'.repeat(64)}/track_0.m3u8?`) &&
      rewrittenMaster.includes(`/api/multitrack/file/${'a'.repeat(64)}/track_1.m3u8?`),
    'Master and rendition playlist paths must be rewritten to signed asset URLs'
  );
  const rewrittenMediaPlaylist = rewriteGeneratedPlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init_2.mp4"\n#EXTINF:6,\nvariant_2_00001.m4s',
    'a'.repeat(64),
    masterParams.get('exp')
  );
  const signedSegmentUrl = new URL(
    rewrittenMediaPlaylist.split('\n').at(-1),
    'https://proxy.example.test'
  );
  assert.ok(signedSegmentUrl.pathname.includes('/api/multitrack/file/'));
  assert.strictEqual(
    verifySignedAsset(
      'a'.repeat(64),
      'variant_2_00001.m4s',
      signedSegmentUrl.searchParams.get('exp'),
      signedSegmentUrl.searchParams.get('sig')
    ),
    true,
    'Every generated HLS segment reference must be independently signed'
  );
  const assetUrl = new URL(
    require('../src/services/multitrack').createSignedAssetUrl(
      'a'.repeat(64),
      'variant_0_00001.m4s',
      masterParams.get('exp')
    ),
    'https://proxy.example.test'
  );
  assert.strictEqual(
    verifySignedAsset(
      'a'.repeat(64),
      'variant_0_00001.m4s',
      assetUrl.searchParams.get('exp'),
      assetUrl.searchParams.get('sig')
    ),
    true,
    'Generated media segments must have their own HMAC signature'
  );
  const savedMultitrackConfig = {
    enabled: config.multitrack.enabled,
    requested: config.multitrack.requested,
    ffmpegPath: config.multitrack.ffmpegPath,
    ffprobePath: config.multitrack.ffprobePath
  };
  config.multitrack.requested = true;
  config.multitrack.ffmpegPath = 'missing-ffmpeg-for-multitrack-test';
  config.multitrack.ffprobePath = 'missing-ffprobe-for-multitrack-test';
  assert.strictEqual(initializeMultitrack(), false, 'Missing ffmpeg binaries must disable remuxing at startup');
  assert.strictEqual(
    await prepareMultiTrackStream(
      'https://pub-abc.r2.dev/movies/RRR.mkv',
      dualAudioHints.languages
    ),
    null,
    'Multi-track resolution must gracefully fall back when ffmpeg is unavailable'
  );
  Object.assign(config.multitrack, savedMultitrackConfig);
  initializeMultitrack();

  const singleTrackResult = await prepareMultiTrackStream(
    'https://pub-abc.r2.dev/movies/RRR.mkv',
    dualAudioHints.languages,
    {
      enabled: true,
      probe: async () => ({
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } }
        ]
      })
    }
  );
  assert.strictEqual(singleTrackResult, null, 'Single audio stream must remain progressive');
  console.log('  ✔ Passed ZokoAnime, HiCine language parsing, and multi-track payload tests.');

  // 3. SRT -> WebVTT Converter Unit Test
  console.log('[3/10] Testing SubRip (.srt) to WebVTT (.vtt) Converter...');
  const sampleSrt = `1\r\n00:00:02,500 --> 00:00:05,800\r\nWelcome to Piltover.\r\n\r\n2\r\n00:00:06,100 --> 00:00:09,450\r\nThe City of Progress.\r\n`;
  const convertedVtt = srtToVtt(sampleSrt);
  assert.ok(convertedVtt.startsWith('WEBVTT'), 'Output must start with WEBVTT header');
  assert.ok(
    convertedVtt.includes('00:00:02.500 --> 00:00:05.800'),
    'Comma timestamps must convert to dots'
  );
  console.log('  ✔ Passed SRT -> VTT conversion.');

  // 4. M3U8 Manifest Rewriter Unit Test
  console.log('[4/10] Testing M3U8 Master & Media Playlist Rewriter...');
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
    'https://vidstuck.xyz/'
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
  const mockUpstream = await startUpstreamMockServer();
  config.tmdbBaseUrl = `${mockUpstream.url}/tmdb`;
  config.upstreams.introDbUrl = `${mockUpstream.url}/introdb`;
  config.upstreams.openSubtitlesRestUrl = `${mockUpstream.url}/opensubtitles`;
  config.upstreams.zxcBase = `${mockUpstream.url}/zxc`;
  config.upstreams.vidstuckBase = `${mockUpstream.url}/vidstuck`;
  config.upstreams.vidsrcDataUrl = `${mockUpstream.url}/vidsrc/api.php`;

  // 4b. HubCloud generator unroller (Centaurus "All upstream servers failed" fix)
  console.log('[4b/10] Testing HubCloud generator unroller (Centaurus)...');
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://gpdl2.hubcloud.ist/?id=abc::def'),
    true,
    'gpdl2.hubcloud.ist generator must be detected'
  );
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://gamerxyt.com/dl.php?link=x'),
    true,
    'gamerxyt.com dl.php wrapper must be detected'
  );
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://hubcdn.sbs/file'),
    true,
    'hubcdn.* generator must be detected'
  );
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://gpdl.hubcloud.cfd/x'),
    true,
    'gpdl.* hubcloud generator must be detected'
  );
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://pub-abc.r2.dev/file.mkv'),
    false,
    'direct R2 file must NOT be treated as a generator'
  );
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://pixeldrain.com/u/abc'),
    false,
    'pixeldrain must NOT be treated as a generator'
  );
  assert.strictEqual(
    isHubcloudGeneratorUrl('https://video-downloads.googleusercontent.com/x'),
    false,
    'Google video CDN must NOT be treated as a generator'
  );
  assert.strictEqual(isHubcloudGeneratorUrl('not-a-url'), false, 'garbage input must be rejected');

  // (a) 302 → dl.php?link=<direct>: percent-encoding inside the target
  //     (e.g. `%20`) must survive exactly one decode — never be double-decoded.
  const viaRedirect = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/gen-redirect`);
  assert.strictEqual(
    viaRedirect,
    `${mockUpstream.url}/cdn/hls/fight%20club.mkv`,
    'generator 302 → dl.php?link= must yield the direct URL with %20 intact'
  );

  // (b) countdown page hiding the CDN URL inside obfuscated inline JS
  const viaJs = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/countdown-js`, {
    fetchImpl: async () => new Response('video bytes', { status: 206, headers: { 'Content-Type': 'video/mp4' } })
  });
  assert.strictEqual(
    viaJs,
    'https://pub-1a2b.r2.dev/movies/Fight-Club-1999.mkv',
    'URL hidden in JS string escapes (\\/) must be extracted'
  );
  const testedMirrors = [];
  const mirrorFallback = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/mirror-test`, {
    fetchImpl: async (url) => {
      testedMirrors.push(url);
      return url.includes('dead-copy')
        ? new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } })
        : new Response('media bytes', { status: 206, headers: { 'Content-Type': 'video/mp4' } });
    }
  });
  assert.strictEqual(mirrorFallback, 'https://good-copy.r2.dev/good.mkv', 'HubCloud mirror selection must skip the failed top candidate');
  assert.strictEqual(testedMirrors.length, 2, 'All mirror candidates should be Range-probed concurrently');

  // (c) two-hop flow: drive page → <a id="download"> → dl.php?link= → direct
  const viaDrive = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/drive-page`);
  assert.strictEqual(
    viaDrive,
    `${mockUpstream.url}/cdn/hls/arcane-s1e1.mp4`,
    'nested <a id="download"> wrapper must be followed one hop'
  );

  // (d) pixeldrain /u/ share page → direct /api/file/ endpoint, including the
  // downloadable query parameter. Inject the probe to keep this offline test deterministic.
  let pixelProbeRange = '';
  const viaPixel = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/pixeldrain-page`, {
    fetchImpl: async (_url, init) => {
      pixelProbeRange = init.headers.Range;
      return new Response('media bytes', {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-10/100' }
      });
    }
  });
  assert.strictEqual(
    viaPixel,
    'https://pixeldrain.com/api/file/AbCdEf123?download',
    'pixeldrain.com share links must be normalized to a direct download URL'
  );
  assert.strictEqual(pixelProbeRange, 'bytes=0-1023', 'Resolved URLs must receive a bounded Range preflight');
  assert.strictEqual(
    normalizePlayableUrl('https://pixeldrain.dev/u/AbCdEf123'),
    'https://pixeldrain.dev/api/file/AbCdEf123?download',
    'pixeldrain.dev share URLs must normalize like pixeldrain.com'
  );
  assert.ok(scorePlayableUrl('https://pixeldrain.dev/api/file/AbCdEf123?download') >= 0);

  // Nested ?link= chains and base64 pages.dev/?u= links must unwrap without
  // mistaking their HTML wrappers for terminal media URLs.
  const nestedDirect = `${mockUpstream.url}/cdn/hls/nested-link.mkv`;
  const nestedLink = `${mockUpstream.url}/hubcloud/dl.php?link=${encodeURIComponent(
    `${mockUpstream.url}/hubcloud/dl.php?link=${encodeURIComponent(nestedDirect)}`
  )}`;
  assert.strictEqual(await unrollHubcloudUrl(nestedLink), nestedDirect, 'Nested ?link= wrappers must unwrap recursively');
  const pagesTarget = `${mockUpstream.url}/cdn/hls/pages-dev-wrapper.mkv`;
  const pagesUrl = `https://stream-wrapper.pages.dev/?u=${Buffer.from(pagesTarget, 'utf8').toString('base64url')}`;
  assert.deepStrictEqual(extractWrappedMediaTargets(pagesUrl), [pagesTarget]);
  const pagesLink = `${mockUpstream.url}/hubcloud/dl.php?link=${encodeURIComponent(pagesUrl)}`;
  assert.strictEqual(await unrollHubcloudUrl(pagesLink), pagesTarget, 'base64 pages.dev/?u= targets must unwrap');

  // Range preflight accepts media bytes and rejects an HTTP-200 JSON hotlink response.
  const rangeProbeOptions = {
    deadline: Date.now() + 1000,
    fetchImpl: async (_url, init) => {
      assert.strictEqual(init.headers.Range, 'bytes=0-1023');
      return new Response('video bytes', { status: 206, headers: { 'Content-Type': 'video/mp4' } });
    }
  };
  assert.strictEqual(await probePlayableMediaUrl('https://cdn.example.org/movie.mkv', rangeProbeOptions), true);
  assert.strictEqual(
    await probePlayableMediaUrl('https://cdn.example.org/hotlink', {
      deadline: Date.now() + 1000,
      fetchImpl: async () => new Response('{"success":false,"value":"hotlink_detected"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }),
    false,
    'Range preflight must reject 200 JSON/hotlink responses'
  );

  // The 4KHDHub redirector chain answers with a JavaScript landing page and no
  // Content-Type. It used to pass the "not HTML, not JSON" check, which made
  // Server 3 (ursa) return that page as a "verified 4K" stream. Only positive
  // media evidence may pass now.
  assert.strictEqual(
    await probePlayableMediaUrl('https://d33f51dyacx7bd.cloudfront.net/?aydfd=1015073', {
      deadline: Date.now() + 1000,
      fetchImpl: async () => new Response('(function(){var t=document.createElement("script");})();', { status: 206 })
    }),
    false,
    'Range preflight must reject a JavaScript landing page served without a Content-Type'
  );
  assert.strictEqual(
    await probePlayableMediaUrl('https://cdn.example.org/guard.js', {
      deadline: Date.now() + 1000,
      fetchImpl: async () => new Response('var go=1;', { status: 200, headers: { 'Content-Type': 'application/javascript' } })
    }),
    false,
    'Range preflight must reject JavaScript content types'
  );
  assert.strictEqual(
    await probePlayableMediaUrl('https://cdn.example.org/real.mkv', {
      deadline: Date.now() + 1000,
      fetchImpl: async () => new Response(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(512)]), { status: 206 })
    }),
    true,
    'Range preflight must accept a Matroska header even without a Content-Type'
  );
  assert.strictEqual(
    await probePlayableMediaUrl('https://cdn.example.org/master.m3u8', {
      deadline: Date.now() + 1000,
      fetchImpl: async () => new Response('#EXTM3U\n#EXT-X-VERSION:3\n', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }),
    true,
    'Range preflight must accept an HLS playlist body served as text/plain'
  );
  // A CDN host alone is not a "playable" score: a bare host with only a query
  // string must rank below real file candidates (4KHDHub gate-page regression).
  assert.ok(
    scorePlayableUrl('https://pub-abc.r2.dev/movies/RRR.mkv') >
      scorePlayableUrl('https://d33f51dyacx7bd.cloudfront.net/?aydfd=1015073'),
    'Object paths on CDN hosts must outrank bare-host gate pages'
  );

  // (e) countdown page with no reachable target → null (caller keeps old URL)
  const noLinks = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/no-links`);
  assert.strictEqual(
    noLinks,
    null,
    'unreachable generator must return null instead of a broken URL'
  );

  // (f) Cloudflare managed-challenge interstitial → detected, treated as failure
  const challenged = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/challenge`);
  assert.strictEqual(
    challenged,
    null,
    'CF challenge page must be detected and never parsed for links'
  );

  // (g) End-to-end Centaurus resolve: HiCine /go hands back a HubCloud
  //     dl.php wrapper (the live Fight Club failure mode) — the resolver must
  //     return the unrolled direct file, never the generator HTML.
  const prevHicineBase = config.upstreams.hicineApiBase;
  config.upstreams.hicineApiBase = `${mockUpstream.url}/hicine`;
  let hicineE2e = null;
  try {
    hicineE2e = await resolveHicineServer({
      title: 'Fight Club',
      releaseYear: 1999,
      type: 'movie',
      season: 1,
      episode: 1
    });
  } finally {
    config.upstreams.hicineApiBase = prevHicineBase;
  }
  assert.ok(hicineE2e, 'Centaurus must resolve the mocked HiCine title');
  assert.strictEqual(hicineE2e.server, 'centaurus', 'server must be centaurus');
  assert.strictEqual(
    hicineE2e.rawUrl,
    `${mockUpstream.url}/cdn/hls/fight%20club.mkv`,
    'stream rawUrl must be the unrolled direct file, not the generator page'
  );
  assert.strictEqual(
    hicineE2e.streamUrl,
    `${mockUpstream.url}/cdn/hls/fight%20club.mkv`,
    'streamUrl must point at the direct file'
  );
  assert.strictEqual(hicineE2e.format, 'mp4', 'unrecognized single-track fallback must stay progressive mp4');
  assert.strictEqual(hicineE2e.audioTracks.length, 1, 'Progressive MKV must not invent switchable audio rows');
  assert.ok(
    !/English|Dual Audio/.test(hicineE2e.audioTracks[0].label),
    'HiCine audio label must not guess English when the filename has no English hint'
  );
  assert.ok(
    hicineE2e.audioTracks[0].label.includes('Default Audio'),
    'Unknown HiCine track must be labeled as the default progressive audio'
  );
  assert.ok(
    Array.isArray(hicineE2e.qualities) && hicineE2e.qualities.length > 0,
    'qualities must be present'
  );
  for (const q of hicineE2e.qualities) {
    assert.ok(
      !/hubcloud|gamerxyt|gpdl/i.test(q.url),
      'no quality URL may point at a HubCloud generator'
    );
  }

  config.upstreams.hicineApiBase = `${mockUpstream.url}/hicine`;
  let hintedHicineE2e = null;
  try {
    hintedHicineE2e = await resolveHicineServer({
      title: 'RRR',
      releaseYear: 2022,
      type: 'movie',
      season: 1,
      episode: 1
    });
  } finally {
    config.upstreams.hicineApiBase = prevHicineBase;
  }
  assert.ok(hintedHicineE2e, 'Centaurus must resolve the separate vCloud Hindi+Telugu fixture');
  assert.strictEqual(hintedHicineE2e.audioTracks.length, 1);
  assert.strictEqual(
    hintedHicineE2e.audioTracks[0].lang,
    'und',
    'Progressive dual-audio hints must not claim which language the default track uses'
  );
  assert.strictEqual(
    hintedHicineE2e.audioTracks[0].label,
    'Hindi + Telugu — plays default track',
    'Progressive vCloud playback must show one honest row for filename-only dual-audio hints'
  );
  console.log('  ✔ Passed HubCloud generator unroller tests.');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 5. Health & Handshake Endpoints
    console.log('[5/10] Testing /api/health & /api/handshake...');
    const health = await httpRequest(baseUrl, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);
    assert.strictEqual(health.json.brand, 'LOL Embed');
    assert.strictEqual(health.json.service, 'lol-embed-backend');
    assert.ok(
      Array.isArray(health.json.servers) &&
        health.json.servers.length >= 5 &&
        health.json.servers.includes('hindi')
    );
    const unsignedMultiTrack = await httpRequest(
      baseUrl,
      '/api/multitrack/master.m3u8?url=https%3A%2F%2Fpub-abc.r2.dev%2Fmovies%2FRRR.mkv'
    );
    assert.strictEqual(unsignedMultiTrack.status, 403, 'Multi-track master endpoint must reject unsigned URLs');
    const unsignedMultiTrackAsset = await httpRequest(
      baseUrl,
      `/api/multitrack/file/${'a'.repeat(64)}/track_0.m3u8`
    );
    assert.strictEqual(
      unsignedMultiTrackAsset.status,
      403,
      'Generated multi-track assets must reject unsigned requests'
    );

    const hs = await httpRequest(baseUrl, '/api/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', id: '94605', season: 1, episode: 1 })
    });
    assert.strictEqual(hs.status, 200);
    assert.strictEqual(hs.json.ok, true);
    console.log('  ✔ Passed /api/health & /api/handshake.');

    // 6. TMDB-ID Metadata & Real IntroDB Skip Segments Resolution
    console.log('[6/10] Testing TMDB ID -> External IDs (IMDb/TVDB) & IntroDB Skip Intro Segments...');
    const infoRes = await httpRequest(baseUrl, '/api/info/tv/94605?season=1&episode=1');
    assert.strictEqual(infoRes.status, 200);
    assert.strictEqual(infoRes.json.ok, true);
    assert.strictEqual(infoRes.json.metadata.title, 'Arcane');
    assert.strictEqual(infoRes.json.metadata.externalIds.imdb_id, 'tt11126994');
    assert.strictEqual(infoRes.json.metadata.externalIds.tvdb_id, 371028);
    assert.ok(infoRes.json.metadata.episodes.length >= 2, 'Episodes list must be populated from TMDB');
    assert.ok(
      infoRes.json.segments.some((s) => s.type === 'intro' && s.start === 200 && s.end === 266),
      'IntroDB skip intro segment (200s -> 266s) must be present'
    );
    console.log('  ✔ Passed TMDB -> IMDb/TVDB bridging & IntroDB segments.');

    // 7. Full Production Stream Resolution + OpenSubtitles .srt.gz Decompression + M3U8 Proxy
    console.log('[7/10] Testing /api/resolve/tv/94605, OpenSubtitles .srt.gz -> .vtt, & /api/proxy...');
    const resolveRes = await httpRequest(
      baseUrl,
      '/api/resolve/tv/94605?season=1&episode=1&server=andromeda'
    );
    assert.strictEqual(resolveRes.status, 200);
    assert.strictEqual(resolveRes.json.ok, true);
    assert.strictEqual(resolveRes.json.stream.server, 'andromeda');
    assert.ok(resolveRes.json.stream.streamUrl.startsWith('/api/proxy?url='));
    assert.ok(
      !resolveRes.json.stream.rawUrl.includes('Sintel') &&
        !resolveRes.json.stream.rawUrl.includes('BigBuckBunny'),
      'Zero test/demo videos allowed in stream output'
    );
    assert.ok(resolveRes.json.stream.audioTracks.length >= 4, 'Multi-language audio tracks must be returned');
    const upstreamDefaultTracks = resolveRes.json.stream.audioTracks.filter((track) => track.default);
    assert.strictEqual(upstreamDefaultTracks.length, 1, 'VidStuck must map exactly one upstream default track');
    assert.strictEqual(upstreamDefaultTracks[0].lang, 'fr', 'Node must preserve the upstream default audio track');
    assert.ok(
      resolveRes.json.stream.audioTracks.some((track) => track.lang === 'hi' && /Hindi/.test(track.label)),
      'VidStuck Hindi audio metadata must survive Node resolution'
    );
    const preferredAudioRes = await httpRequest(
      baseUrl,
      '/api/resolve/tv/94605?season=1&episode=1&server=andromeda&audio=hi'
    );
    assert.strictEqual(preferredAudioRes.status, 200);
    assert.strictEqual(preferredAudioRes.json.stream.activeAudioTrack.lang, 'hi');
    assert.ok(
      preferredAudioRes.json.stream.audioTracks.every((track) => track.default === (track.lang === 'hi')),
      'Cached resolver responses must still apply each caller’s audio preference'
    );
    assert.ok(resolveRes.json.subtitles.length >= 2, 'OpenSubtitles tracks must be returned');

    // Test /api/subtitles/proxy decompressing .srt.gz and converting to WebVTT
    const subProxyRes = await httpRequest(baseUrl, resolveRes.json.subtitles[0].url);
    assert.strictEqual(subProxyRes.status, 200);
    assert.ok(subProxyRes.body.startsWith('WEBVTT'), 'Proxied .srt.gz must decompress and convert to WEBVTT');
    assert.ok(subProxyRes.body.includes('Welcome to Piltover and Zaun.'));

    // Test /api/proxy rewriting the upstream M3U8 playlist
    const m3u8ProxyRes = await httpRequest(baseUrl, resolveRes.json.stream.streamUrl);
    assert.strictEqual(m3u8ProxyRes.status, 200);
    assert.ok(
      m3u8ProxyRes.body.includes('/api/proxy?url='),
      'Proxied M3U8 playlist must rewrite variant URLs through /api/proxy'
    );

    // Test Ursa (VidSrc.sh) server resolution
    const ursaRes = await httpRequest(
      baseUrl,
      '/api/resolve/movie/693134?server=ursa'
    );
    assert.strictEqual(ursaRes.status, 200);
    assert.strictEqual(ursaRes.json.ok, true);
    assert.strictEqual(ursaRes.json.stream.server, 'ursa');
    assert.ok(
      ursaRes.json.stream.rawUrl.includes('token=vidsrc-short-lived-jwt'),
      'VidSrc stream URL must be stamped with generate.php JWT'
    );
    console.log('  ✔ Passed end-to-end stream resolution, .srt.gz -> .vtt, and M3U8 proxy.');

    // 8. Backend-only public surface: service metadata + social image, no web UI.
    // 8. Node API public surface: service metadata + social image, JSON-only.
    // (The /embed player page ships with the Cloudflare Worker; suite 10 covers it.)
    console.log('[8/10] Testing LOL Embed branding, meta image, and JSON-only Node surface...');
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

    // 9. Owner Admin Panel (/admin, Domain Telemetry, Source Replacer, Domain Blocking, Custom Overrides)
    console.log('[9/10] Testing JSON Admin API, Domain Telemetry, Source Replacement & Firewall...');

    // Simulate API requests from an external client domain (there is no embed page).
    await httpRequest(baseUrl, '/api/resolve/tv/94605?season=1&episode=1&parent=https://partner-cinema.to', {
      headers: { Referer: 'https://partner-cinema.to/' }
    });

    // Verify unauthorized request to /api/admin/overview is rejected
    const unauthAdmin = await httpRequest(baseUrl, '/api/admin/overview');
    assert.strictEqual(unauthAdmin.status, 401, 'Admin API must reject requests without X-Admin-Key');

    // Verify authorized /api/admin/overview includes partner-cinema.to telemetry
    const adminHeaders = { 'X-Admin-Key': 'admin123', 'Content-Type': 'application/json' };
    const overview = await httpRequest(baseUrl, '/api/admin/overview', { headers: adminHeaders });
    assert.strictEqual(overview.status, 200);
    assert.strictEqual(overview.json.ok, true);
    assert.ok(
      overview.json.domains.some((d) => d.domain === 'partner-cinema.to' && d.resolves >= 1),
      'Admin API must track external API client domain stats'
    );

    // Test Blocking & Unblocking a domain
    const blockRes = await httpRequest(baseUrl, '/api/admin/domains/block', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ domain: 'leecher-site.org', blocked: true })
    });
    assert.strictEqual(blockRes.status, 200);
    const blockedCheck = await httpRequest(
      baseUrl,
      '/api/resolve/tv/94605?season=1&episode=1&parent=https://leecher-site.org'
    );
    assert.strictEqual(blockedCheck.status, 403, 'Blocked domain must receive HTTP 403 Forbidden');

    // Test Live Upstream Source Replacement
    const savedServers = config.servers.map((s) => ({ ...s }));
    try {
      const replaceRes = await httpRequest(baseUrl, '/api/admin/upstreams', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          upstreams: { hicineApiBase: 'https://api-new.hicine.sbs' },
          servers: [{ id: 'ursa', priority: 1, enabled: true }]
        })
      });
      assert.strictEqual(replaceRes.status, 200);
      assert.strictEqual(replaceRes.json.snapshot.upstreams.hicineApiBase, 'https://api-new.hicine.sbs');

      // Re-prioritising a server must reach the player immediately: /api/info
      // feeds the same array the servers modal renders.
      const infoAfterPromotion = await httpRequest(baseUrl, '/api/info/tv/94605');
      assert.strictEqual(infoAfterPromotion.status, 200);
      assert.ok(
        infoAfterPromotion.json.servers.findIndex((s) => s.id === 'ursa') <
          infoAfterPromotion.json.servers.findIndex((s) => s.id === 'centaurus'),
        'a promoted server must move ahead of lower-priority servers in the player list'
      );
    } finally {
      config.servers = savedServers;
    }

    // Test Custom TMDB Stream Override
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
    console.log('  ✔ Passed JSON Admin API, Domain Telemetry, Firewall & Live Source Replacement.');

    // 10. Worker player page: /embed serves the player, player assets load,
    // the API base URL is configurable for a separate API Worker, `/` stays
    // JSON for API clients (with a browser-only rickroll easter egg), and the
    // portal/admin UI stays removed.
    console.log('[10/10] Testing Worker /embed player page, assets, API base config & root behavior...');
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
    assert.ok(
      embedHtml.includes(JSON.stringify({ apiBaseUrl: baseUrl })),
      'Injected config must carry the normalized API Worker URL'
    );
    assert.ok(!embedHtml.includes('<!--LOL_EMBED_CONFIG-->'), 'Config placeholder must be replaced');
    assert.ok(!/vidstuck/i.test(embedHtml), 'Player page must be rebranded to LOL Embed');

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
    assert.match(playerJsBody, /server: 'andromeda'/, 'the served player bundle must carry the priority-1 default server');
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
    assert.ok(
      embedDefaultHtml.includes(JSON.stringify({ apiBaseUrl: '' })),
      'Unset API_BASE_URL must inject an empty same-origin base'
    );

    // 10c. Required player assets load with sensible content types.
    for (const [assetPath, typePrefix] of [
      ['/css/embed.css', 'text/css'],
      ['/js/embed.js', 'text/javascript'],
      ['/vendor/hls.min.js', 'text/javascript'],
      ['/vendor/dash.all.min.js', 'text/javascript']
    ]) {
      const assetRes = await callWorker(`http://player.test${assetPath}`);
      assert.strictEqual(assetRes.status, 200, `${assetPath} must be served`);
      assert.match(assetRes.headers.get('content-type') || '', new RegExp(`^${typePrefix}`));
      assert.strictEqual(assetRes.headers.get('access-control-allow-origin'), '*');
      const assetBody = await assetRes.text();
      assert.ok(assetBody.length > 500, `${assetPath} must serve real content`);
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

    // 10g. Portal, admin dashboard UI, and non-player routes stay removed on the Worker.
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

    // 11. Server Andromeda Multi-Tier Architecture & Waterfall Failover
    // Priority 1: CastleTV (South Indian, Asian, Hollywood dubs)
    // Priority 2: NetMirror (Official OTT platform mirrors)
    // Waterfall Failover: When both tiers miss, cleanly hand off to Server 2 (Ursa / VidSrc)
    console.log('[11/11] Testing Server Andromeda Multi-Tier Architecture & Waterfall Failover...');

    // 11a. CastleTV Unit & Sub-resolver: Security key handshake, AES-128-CBC encryption, multi-audio tracks
    const castleKey = buildCastleKey('MTIzNDU2Nzg5MA==');
    assert.strictEqual(castleKey.length, 16, 'Castle key must be 16 bytes (AES-128)');
    const testPlain = JSON.stringify({ test: 'castle-crypto-verify' });
    const testEnc = encryptCastleAes(testPlain, castleKey);
    const testDec = decryptCastleAes(testEnc, castleKey);
    assert.strictEqual(testDec, testPlain, 'Castle AES encryption and decryption must roundtrip');

    const origCastleBase = config.upstreams.castletvBase;
    const origNetmirrorBase = config.upstreams.netmirrorBase;
    const origVidstuckBase = config.upstreams.vidstuckBase;

    try {
      config.upstreams.castletvBase = `${mockUpstream.url}/castletv`;
      config.upstreams.netmirrorBase = `${mockUpstream.url}/netmirror`;
      // Clear VidStuck base to verify the pure cascade and Ursa failover without old fallback
      config.upstreams.vidstuckBase = '';

      // Test Direct CastleTV Resolver
      const castleRes = await resolveCastletv(
        { title: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
        'hi'
      );
      assert.ok(castleRes, 'CastleTV resolver must succeed for mocked title');
      assert.strictEqual(castleRes.server, 'andromeda');
      assert.strictEqual(castleRes.sourceName, 'CastleTV');
      assert.strictEqual(castleRes.format, 'hls');
      assert.ok(castleRes.streamUrl.startsWith('/api/proxy?url='));
      assert.strictEqual(castleRes.audioTracks.length, 4, 'CastleTV must yield 4 discrete audio tracks');
      const hiCastleTrack = castleRes.audioTracks.find((t) => t.lang === 'hi');
      assert.ok(hiCastleTrack, 'Hindi track must be present in CastleTV tracks');
      assert.strictEqual(hiCastleTrack.default, true, 'Preferred audio "hi" must be marked default');

      // Identity engine unit checks (title canonicalization + year/type gates)
      const fcMeta = { title: 'Fight Club', originalTitle: 'Fight Club', releaseYear: 1999, type: 'movie' };
      assert.strictEqual(identity.normalizeTitleKey('Fight Club (1999) [Hindi Dub]'), 'fight club');
      assert.strictEqual(
        identity.scoreIdentityCandidate({ title: 'Fight Club', year: 2023 }, fcMeta).accepted,
        false,
        'a same-name different-year film must be rejected'
      );
      assert.strictEqual(
        identity.scoreIdentityCandidate({ title: 'Female Fight Club', year: 1999 }, fcMeta).accepted,
        false,
        'substring neighbours must never be accepted'
      );
      assert.strictEqual(
        identity.pickIdentityMatch([{ title: 'Fight Club', year: 2023 }], fcMeta).winner,
        null,
        'no identity proof must yield no winner'
      );

      // Year handling: providers publish release-ish years that can drift by a
      // year or two (CastleTV lists Spirited Away as 2003), so a +/-2 window is
      // accepted; collisions a decade apart are still rejected.
      const yearMeta = { title: 'Spirited Away', releaseYear: 2001, type: 'movie' };
      const yearRow = (year) => ({ title: 'Spirited Away', year, movieType: 2, movieTypeName: 'Movies' });
      assert.ok(
        identity.pickIdentityMatch([yearRow(2003)], yearMeta).winner,
        'a 2-year publish drift must still match the film'
      );
      assert.strictEqual(
        identity.pickIdentityMatch([yearRow(2004)], yearMeta).winner,
        null,
        'a 3-year drift is beyond the tolerance and must be rejected'
      );
      assert.strictEqual(
        identity.pickIdentityMatch([yearRow(2003), yearRow(2001)], yearMeta).winner.year,
        2001,
        'the exact-year candidate must outrank the drifted one'
      );

      // Anime movies are tagged as "anime" by CastleTV; that classification is
      // orthogonal to movie/series, so anime films must still match a movie
      // request while anime *series* must not.
      assert.ok(
        identity.pickIdentityMatch(
          [{ title: 'Spirited Away', year: 2001, movieType: 5, movieTypeName: 'Anime', isSeries: null }],
          { title: 'Spirited Away', releaseYear: 2001, type: 'movie' }
        ).winner,
        'an anime film must be able to match a movie request'
      );
      assert.strictEqual(
        identity.pickIdentityMatch(
          [
            {
              title: 'Spirited Away',
              year: 2001,
              movieType: 5,
              movieTypeName: 'Anime',
              seasonDescription: 'Season 1',
              lastEpisodeCount: 12,
              isSeries: true
            }
          ],
          { title: 'Spirited Away', releaseYear: 2001, type: 'movie' }
        ).winner,
        null,
        'an anime series must not match a movie request'
      );

      // 11b-3. Dub inventory endpoint (/api/dubs) + the "hindi" server must
      // report the verified 1999 film and never the 2023 film's Hindi dub.
      const dubsRes = await httpRequest(baseUrl, '/api/dubs/movie/550?audio=hi');
      assert.strictEqual(dubsRes.status, 200, 'GET /api/dubs/movie/550 must answer');
      assert.strictEqual(dubsRes.json.ok, true);
      assert.strictEqual(dubsRes.json.hindi, false, 'TMDB 550 has no Hindi dub on the mocked tiers');
      const castleProvider = (dubsRes.json.providers || []).find((p) => p.id === 'castletv');
      assert.ok(castleProvider && castleProvider.ok, 'CastleTV must appear in the dub inventory');
      assert.strictEqual(castleProvider.identity.verified, true, 'CastleTV entry must be identity-verified');
      assert.strictEqual(castleProvider.identity.matchedYear, 1999, 'CastleTV must have matched the 1999 film');
      assert.strictEqual(castleProvider.identity.upstreamId, 'castle-fc-1999');
      assert.ok(
        !JSON.stringify(dubsRes.json).includes('fight-club-2023'),
        'the 2023 film must never be reported for TMDB 550'
      );

      const fcMetadata = {
        tmdbId: 550,
        title: 'Fight Club',
        originalTitle: 'Fight Club',
        releaseYear: 1999,
        type: 'movie',
        genres: ['Drama', 'Thriller'],
        externalIds: { imdb_id: 'tt0137523' }
      };
      const hindiMiss = await resolveHindiServer(fcMetadata, 'hi', { providerIds: ['castletv', 'netmirror'] });
      assert.strictEqual(hindiMiss.server, 'hindi');
      assert.strictEqual(hindiMiss.hindiAvailable, false, 'no identity-verified Hindi source exists for the 1999 film');
      assert.strictEqual(hindiMiss.providerId, 'castletv', 'the verified original-audio stream is still returned');
      assert.strictEqual(hindiMiss.identity.upstreamId, 'castle-fc-1999');
      assert.ok(!String(hindiMiss.rawUrl).includes('2023'), 'wrong-title stream must never be returned');

      const hindiHit = await resolveHindiServer(
        {
          tmdbId: 693134,
          title: 'Dune: Part Two',
          originalTitle: 'Dune: Part Two',
          releaseYear: 2024,
          type: 'movie'
        },
        'hi',
        { providerIds: ['castletv', 'netmirror'] }
      );
      assert.strictEqual(hindiHit.hindiAvailable, true, 'verified Hindi dub must be reported as available');
      assert.strictEqual(hindiHit.providerId, 'castletv');
      assert.strictEqual(hindiHit.audioTracks.find((t) => t.default).lang, 'hi', 'Hindi must be the default track');
      assert.ok((hindiHit.dubs || []).some((d) => d.code === 'hi'), 'dub inventory must list Hindi');

      // The catalog object itself is usable standalone (worker parity).
      const catalog = await buildDubCatalog(
        { tmdbId: 693134, title: 'Dune: Part Two', originalTitle: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
        { preferredAudio: 'hi' }
      );
      assert.strictEqual(catalog.hindi, true);
      assert.ok(catalog.dubs.some((d) => d.code === 'hi' && d.providers.includes('castletv')));
      assert.ok(
        catalog.providers.every((p) => p.ok === false || p.identity.verified === true),
        'every reported provider must be identity-verified'
      );

      // The Hindi server end-to-end over HTTP, using the HINDI_PROVIDERS knob.
      const prevHindiProviders = config.upstreams.hindiProviders;
      config.upstreams.hindiProviders = ['castletv', 'netmirror'];
      try {
        const hindiHttp = await httpRequest(baseUrl, '/api/resolve/movie/550?server=hindi&audio=hi');
        assert.strictEqual(hindiHttp.status, 200, 'GET /api/resolve?server=hindi must answer');
        assert.strictEqual(hindiHttp.json.ok, true);
        assert.strictEqual(hindiHttp.json.stream.server, 'hindi');
        assert.strictEqual(hindiHttp.json.stream.requestedServer, 'hindi');
        assert.strictEqual(
          hindiHttp.json.stream.hindiAvailable,
          false,
          'the 1999 film has no Hindi source on the mocked tiers'
        );
        assert.strictEqual(hindiHttp.json.stream.hindiVerified, false);
        assert.strictEqual(hindiHttp.json.stream.identity.upstreamId, 'castle-fc-1999');
        assert.ok(
          !String(hindiHttp.json.stream.rawUrl).includes('2023'),
          'the HTTP Hindi path must never serve the wrong-title stream'
        );
      } finally {
        config.upstreams.hindiProviders = prevHindiProviders;
      }

      // `hindi` is opt-in: it must never take part in the implicit waterfall,
      // so a default request resolves through the normal tiers only.
      const defaultWaterfall = await resolveStreamForServer(fcMetadata, 'andromeda', 'hi');
      assert.strictEqual(defaultWaterfall.server, 'andromeda', 'default waterfall must resolve Andromeda');
      assert.ok(
        !(defaultWaterfall.serverAttempts || []).some((attempt) => attempt.server === 'hindi'),
        'the hindi server must not be attempted unless explicitly requested'
      );
      assert.strictEqual(
        config.servers.find((server) => server.id === 'hindi').fallback,
        false,
        'the hindi server must be marked as an opt-in (fallback:false) server'
      );

      // 11c. NetMirror Dynamic Sub-resolver: Discovery checknewtv.php & rotating referer tracker
      config.upstreams.netmirrorDiscoveryUrls = [mockUpstream.url];
      config.upstreams.netmirrorBase = ''; // clear static netmirror base to enforce dynamic discovery

      const nmRes = await resolveNetmirror(
        { tmdbId: '693134', title: 'Dune: Part Two', type: 'movie' },
        'en'
      );
      assert.ok(nmRes, 'NetMirror resolver must succeed via dynamic discovery');
      assert.strictEqual(nmRes.server, 'andromeda');
      assert.ok(nmRes.sourceName.startsWith('NetMirror'));
      assert.strictEqual(nmRes.format, 'hls');
      assert.ok(nmRes.streamUrl.startsWith('/api/proxy?url='));
      assert.ok(nmRes.referer.includes('net77.cc'), 'Referer must dynamically adapt to active mirror (net77.cc)');
      assert.ok(nmRes.audioTracks.length >= 1);

      // NetMirror web-mirror rotation: the NewTV API base and the first mirror
      // are dead, so the resolver must rotate to the next /api/embed-tmdb host.
      config.upstreams.netmirrorBase = '';
      config.upstreams.netmirrorDiscoveryUrls = [];
      config.upstreams.netmirrorWebMirrors = ['http://127.0.0.1:1', `${mockUpstream.url}/netmirror`];
      const nmRotated = await resolveNetmirror(
        // "fail-netmirror" makes the mocked NewTV search return no results, so
        // the resolver must fall through to the /api/embed-tmdb mirror pool.
        { tmdbId: '693134', title: 'fail-netmirror Dune: Part Two', type: 'movie' },
        'hi'
      );
      assert.ok(nmRotated, 'NetMirror must rotate to a working web mirror');
      assert.ok(nmRotated.streamUrl.startsWith('/api/proxy?url='));
      assert.ok(
        nmRotated.rawUrl.includes('netmirror-embed.m3u8'),
        'rotated mirror must serve the embed-tmdb payload'
      );
      assert.ok(
        (nmRotated.backupUrls || []).some((url) => String(url).includes('netmirror-fallback.m3u8')),
        'NetMirror fallbackHls must be exposed as a backup URL'
      );
      assert.ok(
        (nmRotated.backupUrls || []).some((url) => String(url).includes('netmirror-direct.mp4')),
        'NetMirror direct link must be exposed as a backup URL'
      );
      config.upstreams.netmirrorWebMirrors = [`${mockUpstream.url}/netmirror`];

      // Restore static netmirrorBase as fallback
      config.upstreams.netmirrorBase = `${mockUpstream.url}/netmirror`;

      // 11d. Andromeda Multi-Tier Internal Cascading (Priority 1: Castle -> Priority 2: NetMirror)
      // Tier 1: When CastleTV succeeds, Andromeda returns CastleTV
      const andromedaTier1 = await resolveAndromedaServer({
        title: 'Dune: Part Two',
        releaseYear: 2024,
        tmdbId: '693134',
        type: 'movie'
      });
      assert.ok(andromedaTier1 && andromedaTier1.streamUrl, 'Andromeda must resolve Tier 1');
      assert.strictEqual(andromedaTier1.sourceName, 'CastleTV', 'Priority 1 must be CastleTV');

      // Tier 2: When CastleTV fails, Andromeda cascades to NetMirror
      config.upstreams.castletvBase = `${mockUpstream.url}/castletv-down`;
      const andromedaTier2 = await resolveAndromedaServer({
        title: 'Dune: Part Two',
        releaseYear: 2024,
        tmdbId: '693134',
        type: 'movie'
      });
      assert.ok(andromedaTier2 && andromedaTier2.streamUrl, 'Andromeda must resolve Tier 2 when Tier 1 misses');
      assert.ok(andromedaTier2.sourceName.startsWith('NetMirror'), 'Priority 2 must be NetMirror');

      // Restore the healthy tiers for the remaining Andromeda assertions.
      config.upstreams.castletvBase = `${mockUpstream.url}/castletv`;

      // Exhaustion: when every tier fails, Andromeda returns a clean failure
      const andromedaExhausted = await resolveAndromedaServer({
        title: 'cascade-test-fail-all',
        releaseYear: 2024,
        tmdbId: 'cascade-test-fail-all',
        type: 'movie'
      });
      assert.strictEqual(andromedaExhausted.ok, false);
      assert.strictEqual(andromedaExhausted.reason, 'andromeda_all_sources_exhausted');

      // 11e. End-to-End Waterfall Failover to Server 2 (Ursa / VidSrc)
      // The client explicitly requests Server 1 (Andromeda).
      // Since every Andromeda tier fails, the waterfall must fall back cleanly to Server 2 (Ursa).
      const waterfallFailoverRes = await resolveStreamForServer(
        {
          tmdbId: 'cascade-test-fail-all',
          title: 'cascade-test-fail-all',
          releaseYear: 2024,
          type: 'movie',
          season: 1,
          episode: 1
        },
        'andromeda',
        'en'
      );
      assert.strictEqual(waterfallFailoverRes.requestedServer, 'andromeda', 'Client requested server must be preserved');
      assert.strictEqual(waterfallFailoverRes.server, 'ursa', 'Waterfall must fall back to Server 2 (Ursa)');
      assert.ok(waterfallFailoverRes.streamUrl, 'Fallback to Server 2 must produce playable streamUrl');
      assert.ok(
        waterfallFailoverRes.serverAttempts.some(
          (a) => a.server === 'andromeda' && a.reason === 'andromeda_all_sources_exhausted'
        ),
        'serverAttempts must document Andromeda exhaustion'
      );
      const ursaServerObj = waterfallFailoverRes.servers.find((s) => s.id === 'ursa');
      assert.ok(ursaServerObj && ursaServerObj.active, 'Ursa must be marked active in servers list');

      // 11f. Cloudflare Worker: Multi-Tier Andromeda Resolution, Debug Telemetry & Waterfall Failover
      const workerEnv = {
        CASTLETV_BASE_URL: `${mockUpstream.url}/castletv`,
        NETMIRROR_BASE_URL: `${mockUpstream.url}/netmirror`,
        NETMIRROR_WEB_MIRRORS: `${mockUpstream.url}/netmirror`,
        VIDSTUCK_BASE_URL: '',
        TMDB_BASE_URL: `${mockUpstream.url}/tmdb`,
        VIDSRC_DATA_URL: `${mockUpstream.url}/vidsrc/api.php`
      };

      // Worker resolves Andromeda directly with CastleTV
      const cfAndromedaRes = await callWorker(
        'http://player.test/api/resolve/movie/693134?server=andromeda&audio=hi',
        workerEnv
      );
      assert.strictEqual(cfAndromedaRes.status, 200);
      const cfAndromedaJson = await cfAndromedaRes.json();
      assert.strictEqual(cfAndromedaJson.ok, true);
      assert.strictEqual(cfAndromedaJson.stream.server, 'andromeda');
      assert.strictEqual(cfAndromedaJson.stream.sourceName, 'CastleTV');
      assert.ok(cfAndromedaJson.stream.audioTracks.length >= 4);
      assert.strictEqual(cfAndromedaJson.stream.activeAudioTrack.lang, 'hi');

      // Worker parity: same-name collision must resolve the 1999 film, and the
      // TMDB-id keyed dub inventory must never report the 2023 film.
      const cfDubsRes = await callWorker('http://player.test/api/dubs/movie/550?audio=hi', workerEnv);
      assert.strictEqual(cfDubsRes.status, 200, 'worker /api/dubs must answer');
      const cfDubsJson = await cfDubsRes.json();
      assert.strictEqual(cfDubsJson.ok, true);
      assert.strictEqual(cfDubsJson.hindi, false, 'worker must not report a Hindi dub for the 1999 film');
      const cfCastleProvider = (cfDubsJson.providers || []).find((p) => p.id === 'castletv');
      assert.ok(cfCastleProvider && cfCastleProvider.ok, 'worker CastleTV entry must resolve');
      assert.strictEqual(cfCastleProvider.identity.matchedYear, 1999);
      assert.strictEqual(cfCastleProvider.identity.upstreamId, 'castle-fc-1999');
      assert.ok(!JSON.stringify(cfDubsJson).includes('fight-club-2023'), 'worker must not surface the 2023 film');

      const cfHindiRes = await callWorker(
        'http://player.test/api/resolve/movie/550?server=hindi&audio=hi',
        { ...workerEnv, HINDI_PROVIDERS: 'castletv,netmirror' }
      );
      assert.strictEqual(cfHindiRes.status, 200);
      const cfHindiJson = await cfHindiRes.json();
      assert.strictEqual(cfHindiJson.ok, true);
      assert.strictEqual(cfHindiJson.stream.server, 'hindi');
      assert.strictEqual(cfHindiJson.stream.hindiAvailable, false, 'worker must be honest about the missing Hindi dub');
      assert.strictEqual(cfHindiJson.stream.identity.upstreamId, 'castle-fc-1999');
      assert.ok(
        !String(cfHindiJson.stream.rawUrl).includes('2023'),
        'worker hindi server must never return the wrong-title stream'
      );

      // Worker /api/debug/andromeda/:type/:tmdbId inspects Andromeda upstreams
      const cfDebugRes = await callWorker(
        'http://player.test/api/debug/andromeda/movie/693134',
        workerEnv
      );
      assert.strictEqual(cfDebugRes.status, 200);
      const cfDebugJson = await cfDebugRes.json();
      assert.strictEqual(cfDebugJson.ok, true);
      assert.strictEqual(cfDebugJson.upstream.castletvBase, `${mockUpstream.url}/castletv`);
      assert.strictEqual(cfDebugJson.upstream.netmirrorBase, `${mockUpstream.url}/netmirror`);
      assert.strictEqual(cfDebugJson.result.sourceName, 'CastleTV');

      // Worker Waterfall: When Andromeda tiers fail, worker automatically falls back to Server 2 (Ursa)
      const cfWaterfallRes = await callWorker(
        'http://player.test/api/resolve/movie/cascade-test-fail-all?server=andromeda',
        workerEnv
      );
      assert.strictEqual(cfWaterfallRes.status, 200);
      const cfWaterfallJson = await cfWaterfallRes.json();
      assert.strictEqual(cfWaterfallJson.ok, true);
      assert.strictEqual(cfWaterfallJson.stream.requestedServer, 'andromeda');
      assert.strictEqual(cfWaterfallJson.stream.server, 'ursa', 'Worker waterfall must fall back to Server 2 (Ursa)');
      assert.ok(cfWaterfallJson.stream.rawUrl.includes('token=vidsrc-short-lived-jwt'));

    } finally {
      config.upstreams.castletvBase = origCastleBase;
      config.upstreams.netmirrorBase = origNetmirrorBase;
      config.upstreams.vidstuckBase = origVidstuckBase;
    }
    console.log('  ✔ Passed CastleTV, NetMirror & Server 2 Ursa failover waterfall tests.');

    // 12. Server 2 (Ursa / 4K UHD • Multi-Audio) 4-Tier Architecture & Waterfall Failover
    console.log('[12/12] Testing Server Ursa (4K UHD • Multi-Audio) 4-Tier Architecture & Waterfall Failover...');
    const origFourkhdhubBase = config.upstreams.fourkhdhubBase;
    const origMoviesdriveBase = config.upstreams.moviesdriveBase;
    const origHicineBase = config.upstreams.hicineApiBase;
    const origDahmerBase = config.upstreams.dahmerBase;
    const origVidsrcUrl = config.upstreams.vidsrcDataUrl;

    try {
      config.upstreams.fourkhdhubBase = `${mockUpstream.url}/4khdhub`;
      config.upstreams.moviesdriveBase = `${mockUpstream.url}/moviesdrive`;
      config.upstreams.hicineApiBase = `${mockUpstream.url}/hicine4k`;
      config.upstreams.dahmerBase = `${mockUpstream.url}/dahmer`;
      config.upstreams.vidsrcDataUrl = ''; // Disable VidSrc mock so pure 4-tier 4K cascade is exercised
      cache.store.clear();

      // 12a. Unit Test: 4KHDHub Redirector Decoder (b64 -> b64 -> rot13 -> b64 -> JSON.o -> b64)
      const targetUrl = 'https://hubcloud.ist/drive/dune4ktest';
      const innerPayload = JSON.stringify({ o: Buffer.from(targetUrl, 'utf8').toString('base64') });
      const rotEncoded = Buffer.from(
        Buffer.from(rot13Cipher(Buffer.from(innerPayload, 'utf8').toString('base64')), 'utf8').toString('base64'),
        'utf8'
      ).toString('base64');
      const decodedRedirect = decode4khdhubRedirectHtml(`<script>s('o','${rotEncoded}',1800);</script>`);
      assert.ok(decodedRedirect, 'decode4khdhubRedirectHtml must decode 4KHDHub redirector HTML');
      assert.strictEqual(decodedRedirect.url, targetUrl, 'Decoded 4KHDHub redirect URL must match original HubCloud target');

      // 12b. Tier 1: 4KHDHub Sub-resolver (2160p BluRay REMUX Dual-Audio + 1080p backup)
      const hub4kRes = await resolve4khdhub(
        { title: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
        'hi'
      );
      assert.ok(hub4kRes && hub4kRes.ok, '4KHDHub resolver must succeed');
      assert.strictEqual(hub4kRes.server, 'ursa');
      assert.strictEqual(hub4kRes.tier, '4khdhub');
      assert.ok(hub4kRes.rawUrl.endsWith('/cdn/4k/dune-2160p-webdl.mkv'), 'Browser-friendly 2160p WEB-DL must outrank the huge REMUX/TrueHD release');
      assert.ok(hub4kRes.backupUrls.some((url) => url.includes('dune-2160p-4k-dual.mkv')), 'The lower-ranked REMUX mirror must remain available as a backup');
      assert.strictEqual(hub4kRes.qualities[0].height, 2160, 'Top quality must be 2160p');
      assert.strictEqual(hub4kRes.qualities[0].label, '2160p (4K)');
      assert.ok(hub4kRes.qualities.some((q) => q.height === 1080), '1080p backup quality must be present in qualities ladder');
      assert.ok(
        hub4kRes.audioTracks[0].label.includes('Hindi') && hub4kRes.audioTracks[0].label.includes('English'),
        'Audio track label must reflect Hindi + English Multi-Audio'
      );
      await verifyPayloadLinksOneByOne('Node 4KHDHub', hub4kRes, async (link) => {
        const parsed = new URL(link, baseUrl);
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      // Nested HTML TV fixture: parse the series card and match episode 1 while
      // ignoring episode 2, then retain the episode's 1080p fallback.
      const hub4kTvRes = await resolve4khdhub(
        { title: 'Arcane', type: 'tv', season: 1, episode: 1 },
        'en'
      );
      assert.ok(hub4kTvRes && hub4kTvRes.ok, '4KHDHub TV resolver must parse nested episode markup');
      assert.ok(hub4kTvRes.rawUrl.endsWith('/cdn/4k/arcane-s1e1-2160p.mkv'));
      assert.ok(hub4kTvRes.qualities.some((quality) => quality.height === 1080));
      assert.ok(!hub4kTvRes.rawUrl.includes('wrong'), 'TV resolver must not select a different episode');
      await verifyPayloadLinksOneByOne('Node 4KHDHub TV', hub4kTvRes, async (link) => {
        const parsed = new URL(link, baseUrl);
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      // 12c. Tier 2: MoviesDrive 4K Sub-resolver (Typesense IMDb API + mdrive archive + HubCloud unroll)
      const md4kRes = await resolveMoviesdrive4k(
        {
          title: 'Dune: Part Two',
          releaseYear: 2024,
          type: 'movie',
          externalIds: { imdb_id: 'tt15239678' }
        },
        'en'
      );
      assert.ok(md4kRes && md4kRes.ok, 'MoviesDrive 4K resolver must succeed via Typesense IMDb lookup');
      assert.strictEqual(md4kRes.server, 'ursa');
      assert.strictEqual(md4kRes.tier, 'moviesdrive4k');
      assert.ok(md4kRes.rawUrl.endsWith('/cdn/4k/mdrive-dune-2160p-4k.mkv'), 'Primary stream must be unrolled 2160p MKV');
      assert.strictEqual(md4kRes.qualities[0].height, 2160);
      await verifyPayloadLinksOneByOne('Node MoviesDrive', md4kRes, async (link) => {
        const parsed = new URL(link, baseUrl);
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      // 12d. Tier 3: HiCine 4K UHD Sub-resolver (prioritizes [2160P] entry at bottom of links)
      const hc4kRes = await resolveHicine4k(
        { title: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
        'hi'
      );
      assert.ok(hc4kRes && hc4kRes.ok, 'HiCine 4K resolver must succeed');
      assert.strictEqual(hc4kRes.server, 'ursa');
      assert.strictEqual(hc4kRes.tier, 'hicine4k');
      assert.ok(hc4kRes.rawUrl.endsWith('/cdn/4k/hicine-dune-2160p-4k.mkv'), 'HiCine 4K must select 2160p stream as primary');
      assert.strictEqual(hc4kRes.qualities[0].height, 2160);
      await verifyPayloadLinksOneByOne('Node HiCine', hc4kRes, async (link) => {
        const parsed = new URL(link, baseUrl);
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      // 12e. Tier 4: DahmerMovies 4K Sub-resolver (open directory 2160p Multi-Audio MKV)
      const dahmerRes = await resolveDahmer4k(
        { title: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
        'en'
      );
      assert.ok(dahmerRes && dahmerRes.ok, 'DahmerMovies 4K resolver must succeed');
      assert.strictEqual(dahmerRes.server, 'ursa');
      assert.strictEqual(dahmerRes.tier, 'dahmer4k');
      assert.strictEqual(dahmerRes.qualities[0].height, 2160);
      assert.ok(dahmerRes.referer.includes('/dahmer/'), 'DahmerMovies must preserve Referer');
      await verifyPayloadLinksOneByOne('Node DahmerMovies', dahmerRes, async (link) => {
        const parsed = new URL(link, baseUrl);
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      // 12f. Ursa Multi-Tier Internal Cascading (Tier 1 -> Tier 2 -> Tier 3 -> Tier 4 -> Exhaustion)
      const ursaT1 = await resolveUrsaServer({
        title: 'Dune: Part Two',
        releaseYear: 2024,
        type: 'movie',
        externalIds: { imdb_id: 'tt15239678' }
      });
      assert.strictEqual(ursaT1.tier, '4khdhub', 'Tier 1 must be 4KHDHub');
      assert.strictEqual(ursaT1.diag.selectedTier, '4khdhub');

      const ursaT2 = await resolveUrsaServer({
        title: 'fail-4khdhub Dune: Part Two',
        releaseYear: 2024,
        type: 'movie',
        externalIds: { imdb_id: 'tt15239678' }
      });
      assert.strictEqual(ursaT2.tier, 'moviesdrive4k', 'Tier 2 must be MoviesDrive 4K when Tier 1 misses');

      const ursaT3 = await resolveUrsaServer({
        title: 'fail-4khdhub fail-moviesdrive Dune: Part Two',
        releaseYear: 2024,
        type: 'movie',
        externalIds: { imdb_id: 'fail-moviesdrive' }
      });
      assert.strictEqual(ursaT3.tier, 'hicine4k', 'Tier 3 must be HiCine 4K when Tiers 1 & 2 miss');

      const ursaT4 = await resolveUrsaServer({
        title: 'fail-4khdhub fail-moviesdrive fail-hicine4k Dune: Part Two',
        releaseYear: 2024,
        type: 'movie',
        externalIds: { imdb_id: 'fail-moviesdrive' }
      });
      assert.strictEqual(ursaT4.tier, 'dahmer4k', 'Tier 4 must be DahmerMovies 4K when Tiers 1–3 miss');

      const ursaExhausted = await resolveUrsaServer({
        title: '4k-cascade-fail-all',
        releaseYear: 2024,
        type: 'movie',
        externalIds: { imdb_id: '4k-cascade-fail-all' }
      });
      assert.strictEqual(ursaExhausted.ok, false);
      assert.strictEqual(ursaExhausted.reason, 'ursa_all_4k_sources_exhausted');

      // 12f-meta. Missing metadata must fail fast and honestly.
      // When TMDB resolution produced no title, every Ursa tier is a
      // search-by-title scrape with nothing to search. The cascade must NOT
      // pretend the four providers ran and found nothing ("all sources
      // exhausted"); it must report ursa_metadata_missing and probe nothing.
      const ursaNoMeta = await resolveUrsaServer({ title: null, type: 'movie', tmdbId: 999999 }, 'ursa', '');
      assert.strictEqual(ursaNoMeta.ok, false, 'Ursa must fail when metadata has no title');
      assert.strictEqual(
        ursaNoMeta.reason,
        'ursa_metadata_missing',
        'Missing title must surface as ursa_metadata_missing, not a fake exhaustion'
      );
      assert.ok(
        ursaNoMeta.diag && ursaNoMeta.diag.steps.some((s) => s.step === 'metadata_missing'),
        'diag must record the metadata_missing step'
      );
      assert.ok(
        !ursaNoMeta.diag.steps.some((s) => /_attempt$/.test(s.step)),
        'No 4K tier may be attempted when the title is missing'
      );

      // All four independent Ursa tiers should be in flight together rather
      // than adding their provider latencies serially.
      mockUpstream.metrics.peakUrsaTierRequests = 0;
      await resolveUrsaServer({ title: 'ursa-parallel-test', type: 'movie' });
      assert.ok(
        mockUpstream.metrics.peakUrsaTierRequests >= 3,
        `Ursa provider requests must overlap (observed peak ${mockUpstream.metrics.peakUrsaTierRequests})`
      );

      // 12g. Express HTTP API: ?server=4k alias & /api/debug/4k/:type/:tmdbId diagnostic route
      const http4kRes = await httpRequest(baseUrl, '/api/resolve/movie/693134?server=4k');
      assert.strictEqual(http4kRes.status, 200);
      assert.strictEqual(http4kRes.json.ok, true);
      assert.strictEqual(http4kRes.json.stream.server, 'ursa', '?server=4k must resolve Ursa 4K server');
      assert.strictEqual(http4kRes.json.stream.tier, '4khdhub');
      assert.strictEqual(http4kRes.json.stream.qualities[0].height, 2160);

      const dbg4kRes = await httpRequest(
        baseUrl,
        `/api/debug/4k/movie/693134?key=${encodeURIComponent(config.adminSecret)}`
      );
      assert.strictEqual(dbg4kRes.status, 200);
      assert.strictEqual(dbg4kRes.json.ok, true);
      assert.strictEqual(dbg4kRes.json.result.tier, '4khdhub');
      assert.strictEqual(dbg4kRes.json.upstream.fourkhdhubBase, `${mockUpstream.url}/4khdhub`);

      // 12h. Cloudflare Worker: ?server=4k & ?server=ursa 4-Tier Resolution + Debug Endpoint
      const worker4kEnv = {
        FOURKHDHUB_BASE_URL: `${mockUpstream.url}/4khdhub`,
        MOVIESDRIVE_BASE_URL: `${mockUpstream.url}/moviesdrive`,
        HICINE_API_BASE: `${mockUpstream.url}/hicine4k`,
        DAHMER_BASE_URL: `${mockUpstream.url}/dahmer`,
        VIDSRC_DATA_URL: '',
        TMDB_BASE_URL: `${mockUpstream.url}/tmdb`
      };

      const cf4kRes = await callWorker(
        'http://player.test/api/resolve/movie/693134?server=4k',
        worker4kEnv
      );
      assert.strictEqual(cf4kRes.status, 200);
      const cf4kJson = await cf4kRes.json();
      assert.strictEqual(cf4kJson.ok, true);
      assert.strictEqual(cf4kJson.stream.server, 'ursa');
      assert.strictEqual(cf4kJson.stream.tier, '4khdhub');
      assert.strictEqual(cf4kJson.stream.diag.selectedTier, '4khdhub');
      assert.strictEqual(cf4kJson.stream.qualities[0].height, 2160);
      assert.ok(cf4kJson.stream.rawUrl.endsWith('/cdn/4k/dune-2160p-webdl.mkv'), 'Worker 4K parsing must follow base64 pages.dev wrappers and score the WEB-DL above REMUX');
      await verifyPayloadLinksOneByOne('Worker Ursa', cf4kJson.stream, async (link) => {
        const parsed = new URL(link, 'http://player.test');
        if (parsed.origin === 'http://player.test') {
          return callWorker(parsed.href, worker4kEnv, { Range: 'bytes=0-64' });
        }
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      // Exercise each Worker-side backup provider independently, then request
      // every selected stream, quality, and mirror URL one at a time.
      const workerFallbackTiers = [
        { id: 555551, tier: 'moviesdrive4k', label: 'Worker MoviesDrive' },
        { id: 555552, tier: 'hicine4k', label: 'Worker HiCine' },
        { id: 555553, tier: 'dahmer4k', label: 'Worker DahmerMovies' }
      ];
      for (const fixture of workerFallbackTiers) {
        const fallbackResponse = await callWorker(
          `http://player.test/api/debug/4k/movie/${fixture.id}`,
          worker4kEnv
        );
        assert.strictEqual(fallbackResponse.status, 200, `${fixture.label} debug request must succeed`);
        const fallbackJson = await fallbackResponse.json();
        assert.strictEqual(fallbackJson.ok, true, `${fixture.label} must produce a stream`);
        assert.strictEqual(
          fallbackJson.result.tier,
          fixture.tier,
          `${fixture.label} must be selected at its tier: ${JSON.stringify(fallbackJson.result.diag?.steps || [])}`
        );
        await verifyPayloadLinksOneByOne(fixture.label, fallbackJson.result, async (link) => {
          const parsed = new URL(link, 'http://player.test');
          if (parsed.origin === 'http://player.test') {
            return callWorker(parsed.href, worker4kEnv, { Range: 'bytes=0-64' });
          }
          return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
        });
      }

      mockUpstream.metrics.peakUrsaTierRequests = 0;
      const cfParallelUrsa = await callWorker(
        'http://player.test/api/debug/4k/movie/555555',
        worker4kEnv
      );
      assert.strictEqual(cfParallelUrsa.status, 200);
      assert.ok(
        mockUpstream.metrics.peakUrsaTierRequests >= 3,
        `Worker Ursa provider requests must overlap (observed peak ${mockUpstream.metrics.peakUrsaTierRequests})`
      );

      const cf4kTvDebug = await callWorker(
        'http://player.test/api/debug/4k/tv/94605?season=1&episode=1',
        worker4kEnv
      );
      assert.strictEqual(cf4kTvDebug.status, 200);
      const cf4kTvJson = await cf4kTvDebug.json();
      assert.strictEqual(cf4kTvJson.ok, true, 'Worker must parse nested 4KHDHub TV episode markup');
      assert.strictEqual(cf4kTvJson.result.tier, '4khdhub');
      assert.ok(cf4kTvJson.result.rawUrl.endsWith('/cdn/4k/arcane-s1e1-2160p.mkv'));
      await verifyPayloadLinksOneByOne('Worker Ursa TV', cf4kTvJson.result, async (link) => {
        const parsed = new URL(link, 'http://player.test');
        if (parsed.origin === 'http://player.test') {
          return callWorker(parsed.href, worker4kEnv, { Range: 'bytes=0-64' });
        }
        return httpRequest(parsed.origin, `${parsed.pathname}${parsed.search}`, { headers: { Range: 'bytes=0-64' } });
      });

      const cf4kDebug = await callWorker(
        'http://player.test/api/debug/4k/movie/693134',
        worker4kEnv
      );
      assert.strictEqual(cf4kDebug.status, 200);
      const cf4kDebugJson = await cf4kDebug.json();
      assert.strictEqual(cf4kDebugJson.ok, true);
      assert.strictEqual(cf4kDebugJson.result.tier, '4khdhub');
      assert.strictEqual(cf4kDebugJson.upstream.fourkhdhubBase, `${mockUpstream.url}/4khdhub`);
    } finally {
      config.upstreams.fourkhdhubBase = origFourkhdhubBase;
      config.upstreams.moviesdriveBase = origMoviesdriveBase;
      config.upstreams.hicineApiBase = origHicineBase;
      config.upstreams.dahmerBase = origDahmerBase;
      config.upstreams.vidsrcDataUrl = origVidsrcUrl;
    }
    console.log('  ✔ Passed 4KHDHub, MoviesDrive 4K, HiCine 4K, DahmerMovies 4K & ?server=4k tests.');

    // 13. Server catalog: a rebrand / re-prioritisation must reach BOTH backends
    // and the player's server modal, with no stale names, slots, or order.
    console.log('[13/13] Testing shared server catalog, worker servers array & player defaults...');
    {
      const catalog = require('../src/services/serverCatalog');
      const expected = [
        ['andromeda', 'Fiber Optic Speedrun', 'Multi-Audio • Primary', 1],
        ['centaurus', 'Gigachad Node', 'Adaptive • Multi-Quality', 2],
        ['ursa', 'FBI Surveillance Van', '4K UHD • Multi-Audio', 3],
        ['hamster', 'Hamster Wheel', 'Multi-Language • OMSS Cascade', 4],
        ['atlas', 'Atlas', 'Adaptive • Backup', 5]
      ];

      // 13a. The Node backend serves the catalog order verbatim; the opt-in Hindi
      // cascade stays resolvable but is never rendered as a server row.
      assert.deepStrictEqual(
        config.servers.filter((s) => s.listed !== false).map((s) => [s.id, s.name, s.badge, s.priority]),
        expected,
        'Node config must expose the catalog names/badges/priorities in order'
      );
      const hindiEntry = config.servers.find((s) => s.id === 'hindi');
      assert.ok(hindiEntry, 'the opt-in Hindi cascade must stay resolvable on the Node backend');
      assert.strictEqual(hindiEntry.listed, false, 'Hindi must never be rendered as a player server row');
      assert.strictEqual(hindiEntry.fallback, false, 'Hindi must stay out of the implicit waterfall');
      assert.deepStrictEqual(
        catalog.WATERFALL_PRIORITY,
        expected.map((e) => e[0]),
        'waterfall order must always follow the catalog priorities'
      );

      // 13b. A runtime re-prioritisation must reorder the player's server array:
      // sortByPriority is applied to the live list, not to a frozen constant.
      const promoted = catalog.allServers().map((s) => ({ ...s }));
      promoted.find((s) => s.id === 'atlas').priority = 0;
      assert.deepStrictEqual(
        catalog.buildServerPayload(promoted, null).map((s) => s.id)[0],
        'atlas',
        'a promoted server must lead the player-facing array'
      );

      // 13c. The API payload the player renders: priority order, one active row,
      // opt-in/removed servers never listed.
      const payload = catalog.buildServerPayload(catalog.workerServerList(), 'ursa');
      assert.deepStrictEqual(
        payload.map((s) => s.id),
        expected.map((e) => e[0]),
        'player payload must list servers in priority order'
      );
      assert.deepStrictEqual(
        payload.find((s) => s.id === 'ursa').active,
        true,
        'the server that answered must be flagged active'
      );
      assert.strictEqual(
        payload.filter((s) => s.active).length,
        1,
        'exactly one server may ever be active'
      );
      assert.ok(!payload.some((s) => s.id === 'hindi'), 'opt-in Hindi must stay out of the player list');
      assert.ok(!payload.some((s) => s.id === 'strings'), 'the removed Strings slot must not be listed');

      // 13d. The player must default to priority 1 and order rows defensively.
      const embedJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'embed.js'), 'utf8');
      assert.match(embedJs, /server: 'andromeda'/, 'player default server must be the priority-1 server');
      assert.ok(!/server: 'atlas'/.test(embedJs), 'player must not default to the backup server');
      assert.ok(
        /\.sort\(\(a, b\) => \(Number\(a\.priority\) \|\| 999\)/.test(embedJs),
        'player must re-sort the API server array by priority before rendering'
      );
      const embedHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'embed.html'), 'utf8');
      assert.ok(!/Connecting to Atlas/.test(embedHtml), 'player page must not greet viewers with a removed server name');

      // 13e. Cloudflare Worker (the deployment that serves /embed) reports the
      // same list through /api/health, /api/info and the resolve payload.
      const catalogWorkerEnv = {
        CASTLETV_BASE_URL: `${mockUpstream.url}/castletv`,
        NETMIRROR_BASE_URL: `${mockUpstream.url}/netmirror`,
        NETMIRROR_WEB_MIRRORS: `${mockUpstream.url}/netmirror`,
        VIDSTUCK_BASE_URL: '',
        TMDB_BASE_URL: `${mockUpstream.url}/tmdb`,
        VIDSRC_DATA_URL: `${mockUpstream.url}/vidsrc/api.php`
      };

      const healthRes = await callWorker('http://player.test/api/health');
      assert.strictEqual(healthRes.status, 200);
      const healthJson = await healthRes.json();
      assert.deepStrictEqual(
        healthJson.servers.slice(0, expected.length),
        expected.map((e) => e[0]),
        'worker /api/health must list the catalog ids in priority order first'
      );
      assert.ok(
        healthJson.servers.includes('hindi'),
        'worker /api/health must still report the opt-in Hindi capability'
      );

      const infoRes = await callWorker('http://player.test/api/info/tv/94605', catalogWorkerEnv);
      assert.strictEqual(infoRes.status, 200);
      const infoJson = await infoRes.json();
      assert.deepStrictEqual(
        infoJson.servers.map((s) => [s.id, s.name, s.priority]),
        expected.map((e) => [e[0], e[1], e[3]]),
        'worker /api/info must expose the rebranded server objects'
      );

      const resolveRes = await callWorker(
        'http://player.test/api/resolve/movie/693134?server=andromeda',
        catalogWorkerEnv
      );
      assert.strictEqual(resolveRes.status, 200);
      const resolveJson = await resolveRes.json();
      assert.strictEqual(resolveJson.ok, true);
      assert.deepStrictEqual(
        resolveJson.servers.map((s) => s.id),
        expected.map((e) => e[0]),
        'the worker payload rendered by the player must be the catalog list'
      );
      assert.deepStrictEqual(
        resolveJson.servers.map((s) => s.name),
        expected.map((e) => e[1]),
        'the player must receive the rebranded names, not the legacy ones'
      );
      assert.strictEqual(
        resolveJson.servers.find((s) => s.active).id,
        resolveJson.stream.server,
        'the active flag must match the server that produced the stream'
      );
      assert.ok(
        !JSON.stringify(resolveJson.servers).includes('Strings'),
        'worker payload must not leak removed servers'
      );

      // 13f. Hamster Wheel must run on the worker too (same shared cascade).
      const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudflare-worker', 'worker.js'), 'utf8');
      assert.ok(
        /serverCatalog\.workerServerList\(\)/.test(workerSrc),
        'worker must build its server list from the shared catalog'
      );
      assert.ok(
        /hamsterCore\.configureHamsterCore\(/.test(workerSrc) && /resolveHamsterWheelUpstream/.test(workerSrc),
        'worker must wire the shared Hamster Wheel cascade'
      );
      assert.ok(!/srvId === 'strings'/.test(workerSrc), "the dead Strings waterfall branch must be gone");
    }
    console.log('  ✔ Passed shared server catalog, worker servers array & player default tests.');

    // 14. Hamster Wheel (Multi-Language • OMSS Cascade): the priority-4 server
    // runs the SAME module on the Node backend and the Worker, so it is verified
    // once with provider-accurate fixtures: Videasy (plain + enc-dec encrypted),
    // Peachify (AES-256-CBC envelope) and VidSrc (three-hop vsembed scrape).
    console.log('[14/14] Testing Hamster Wheel OMSS cascade (Videasy, Peachify, VidSrc)...');
    {
      const hamsterWheel = require('../src/services/hamsterWheel');
      const realFetch = globalThis.fetch;
      const calls = [];
      const jsonRes = (body) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const htmlRes = (body) =>
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });

      // Peachify ships an AES-256-CBC envelope: base64 blob with a 16-byte IV
      // prefix and the key carried (hex) beside it in the JSON response.
      const peachKey = crypto.randomBytes(32).toString('hex');
      const peachIv = crypto.randomBytes(16);
      const peachCipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(peachKey, 'hex').slice(0, 32), peachIv);
      const peachBody = Buffer.concat([
        peachIv,
        peachCipher.update(
          JSON.stringify({
            sources: [
              { url: 'https://cdn.peachify.test/english/master.m3u8', quality: '720p', dub: 'English' },
              { url: 'https://cdn.peachify.test/hindi/master.m3u8', quality: '1080p', dub: 'Hindi' }
            ]
          }),
          'utf8'
        ),
        peachCipher.final()
      ]);

      const metadata = { type: 'movie', tmdbId: '693134', title: 'Dune: Part Two', releaseYear: 2024, season: 1, episode: 1 };

      const routeFetch = async (input, init = {}) => {
        const u = String(typeof input === 'string' ? input : input.url);
        calls.push(u);
        if (u.startsWith('https://api.videasy.net/') || u.startsWith('https://api2.videasy.net/')) {
          if (/fail-all/.test(JSON.stringify(videasyMode))) return new Response('nope', { status: 500 });
          if (u.includes('/hdmovie/')) {
            return jsonRes({ sources: [{ url: 'https://cdn.videasy.test/hindi/master.m3u8', quality: '1080p' }] });
          }
          if (u.startsWith('https://api2.videasy.net/')) {
            // Encrypted provider answer: the core must round-trip it via enc-dec.app.
            return new Response('ENCRYPTED_BLOB_PAYLOAD', { status: 200 });
          }
          return jsonRes({ sources: [{ url: 'https://cdn.videasy.test/english/master.m3u8', quality: '1080p' }] });
        }
        if (u === 'https://enc-dec.app/api/decrypt') {
          return new Response(JSON.stringify({ sources: [{ url: 'https://cdn.videasy.test/spanish/master.m3u8', quality: '720p' }] }), { status: 200 });
        }
        if (u.includes('eat-peach.sbs')) {
          return jsonRes({ isEncrypted: true, data: peachBody.toString('base64'), key: peachKey });
        }
        if (u === 'https://vsembed.ru/embed/movie?tmdb=693134') {
          return htmlRes(`<script>fetch('https://cloudnestra.com/api/embed?id=1')</script>`);
        }
        if (u === 'https://cloudnestra.com/api/embed?id=1') {
          return htmlRes(`<script>fetch('https://cloudnestra.com/api/source/2')</script>`);
        }
        if (u === 'https://cloudnestra.com/api/source/2') {
          return htmlRes(`<script>player.setup({ file: "https://{v1}/hls/master.m3u8" })</script>`);
        }
        return realFetch(input, init);
      };
      let videasyMode = 'ok';

      globalThis.fetch = routeFetch;
      try {
        // 14a. Videasy primary: multi-language tracks, proxied playback URLs,
        // preferred audio first, and the encrypted provider round-tripped.
        calls.length = 0;
        const videasy = await hamsterWheel.resolveVideasy(metadata, 'hindi');
        assert.strictEqual(videasy.provider, 'videasy');
        assert.strictEqual(videasy.server, 'hamster');
        assert.strictEqual(videasy.language, 'hindi', 'the requested language must lead the track list');
        assert.ok(videasy.streamUrl.includes('/api/proxy?'), 'playback URLs must be routed through the proxy');
        assert.ok(
          videasy.audioTracks.length >= 3,
          `every Videasy server that answered must become an audio track (got ${videasy.audioTracks.length})`
        );
        assert.ok(
          videasy.backupUrls.every((u) => u.includes('/api/proxy?')),
          'backup URLs must be proxied too'
        );
        assert.ok(
          calls.some((u) => u === 'https://enc-dec.app/api/decrypt'),
          'encrypted Videasy answers must be decrypted through enc-dec.app'
        );

        // 14b. Peachify fallback: the AES envelope must decrypt to real sources.
        const peachify = await hamsterWheel.resolvePeachify(metadata, 'hi');
        assert.strictEqual(peachify.provider, 'peachify');
        assert.strictEqual(peachify.dub, 'Hindi', 'preferred dub must lead the Peachify track list');
        assert.ok(peachify.streamUrl.includes('/api/proxy?'));
        assert.ok(
          peachify.audioTracks.some((t) => t.label.includes('Hindi')),
          'decrypted dub labels must surface as selectable tracks'
        );

        // 14c. VidSrc last resort: three-hop scrape with {v1} domain substitution.
        const vidsrc = await hamsterWheel.resolveVidsrc(metadata, 'en');
        assert.strictEqual(vidsrc.provider, 'vidsrc');
        assert.strictEqual(vidsrc.rawUrl, 'https://neonhorizonworkshops.com/hls/master.m3u8');
        assert.ok(vidsrc.streamUrl.includes('/api/proxy?'));

        // 14d. Orchestrator order: Videasy wins without touching the fallbacks.
        calls.length = 0;
        const primary = await hamsterWheel.resolveHamsterWheelServer(metadata, 'hamster', 'en');
        assert.strictEqual(primary.provider, 'videasy');
        assert.ok(!calls.some((u) => u.includes('eat-peach.sbs')), 'fallbacks must not run once Videasy answers');

        // 14e. Provider failure cascades to the next provider, not to the player.
        videasyMode = 'fail-all';
        const fallback = await hamsterWheel.resolveHamsterWheelServer(metadata, 'hamster', 'hi');
        assert.strictEqual(fallback.provider, 'peachify', 'a dead Videasy must cascade to Peachify');
        videasyMode = 'ok';

        // 14f. A fully dead cascade reports every provider attempt instead of throwing.
        globalThis.fetch = async (input, init = {}) => {
          const u = String(typeof input === 'string' ? input : input.url);
          calls.push(u);
          if (/videasy|eat-peach|vsembed|cloudnestra/.test(u)) return new Response('down', { status: 503 });
          return realFetch(input, init);
        };
        const dead = await hamsterWheel.resolveHamsterWheelServer(metadata, 'hamster', 'en');
        assert.strictEqual(dead.streamUrl, undefined);
        assert.ok(
          dead.reason === 'hamster_all_sources_exhausted' || dead.reason === 'circuit_open',
          `a dead cascade must explain itself (got ${dead.reason})`
        );
        assert.ok(Array.isArray(dead.diag.steps) && dead.diag.steps.length >= 3, 'diagnostics must list every provider hop');
        assert.ok(!JSON.stringify(dead).includes('cdn.videasy.test'), 'failures must not leak stale stream URLs');

        // 14g. The Worker runs the same cascade: ?server=hamster resolves end-to-end
        // and the player payload flags the Hamster Wheel row as active.
        globalThis.fetch = routeFetch;
        calls.length = 0;
        const cfHamsterRes = await callWorker(
          'http://player.test/api/resolve/movie/693134?server=hamster&audio=hindi',
          {
            CASTLETV_BASE_URL: `${mockUpstream.url}/castletv`,
            NETMIRROR_BASE_URL: `${mockUpstream.url}/netmirror`,
            NETMIRROR_WEB_MIRRORS: `${mockUpstream.url}/netmirror`,
            VIDSTUCK_BASE_URL: '',
            TMDB_BASE_URL: `${mockUpstream.url}/tmdb`,
            VIDSRC_DATA_URL: `${mockUpstream.url}/vidsrc/api.php`
          }
        );
        assert.strictEqual(cfHamsterRes.status, 200, 'Worker ?server=hamster must answer');
        const cfHamsterJson = await cfHamsterRes.json();
        assert.strictEqual(cfHamsterJson.ok, true);
        assert.strictEqual(cfHamsterJson.stream.server, 'hamster');
        assert.strictEqual(cfHamsterJson.stream.provider, 'videasy');
        const cfHamsterRow = cfHamsterJson.servers.find((s) => s.id === 'hamster');
        assert.ok(cfHamsterRow && cfHamsterRow.active, 'the Hamster Wheel row must be flagged active for the player');
        assert.strictEqual(
          cfHamsterJson.servers.filter((s) => s.active).length,
          1,
          'exactly one server row may be active'
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    }
    console.log('  ✔ Passed Hamster Wheel OMSS cascade tests (Node + Worker).');

    console.log('\n==========================================================');
    console.log('  ALL 14 PRODUCTION VERIFICATION SUITES PASSED (0 TEST VIDEOS)');
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
