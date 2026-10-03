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
const { rewriteM3u8Manifest } = require('../src/services/proxy');
const {
  decodeZokoAnimeXorPayload,
  parseHicineLinks,
  parseHicineAudioHints,
  isHubcloudGeneratorUrl,
  unrollHubcloudUrl,
  resolveHicineServer,
  resolveStreamForServer,
  resolveAndromedaServer,
  resolveCastletv,
  resolveMoviebox,
  resolveNetmirror,
  buildCastleKey,
  decryptCastleAes,
  mapLanguageNameToCode,
  buildMovieboxHeaders
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
        res.writeHead(302, {
          Location: `${mockOrigin}/hubcloud/dl.php?link=${encodeURIComponent(`${mockOrigin}/cdn/hls/fight%20club.mkv`)}`
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

      // 8d. Upstream MP4 Stream for Moviebox verification
      if (u.pathname.startsWith('/cdn/mbox/')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end('fake-mp4-data-stream');
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

      // 10. Moviebox Mock Upstream (/moviebox/...)
      if (u.pathname === '/moviebox/wefeed-mobile-bff/subject-api/search/v2') {
        let rawBody = '';
        req.on('data', (c) => { rawBody += c; });
        req.on('end', () => {
          let bodyObj = {};
          try { bodyObj = JSON.parse(rawBody); } catch {}
          const kw = (bodyObj.keyword || '').toLowerCase();
          if (kw.includes('fail-moviebox') || kw.includes('cascade-test-fail-all')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ code: 0, data: { results: [] } }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 0,
              data: {
                results: [
                  {
                    subjects: [
                      {
                        subjectId: 'mbox-101',
                        title: 'Dune: Part Two',
                        subjectType: 1
                      }
                    ]
                  }
                ]
              }
            })
          );
        });
        return;
      }

      if (u.pathname === '/moviebox/wefeed-mobile-bff/subject-api/get') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            code: 0,
            data: {
              dubs: [
                { subjectId: 'mbox-101', lanName: 'English' },
                { subjectId: 'mbox-102', lanName: 'Hindi' },
                { subjectId: 'mbox-103', lanName: 'Tamil' }
              ]
            }
          })
        );
      }

      if (u.pathname === '/moviebox/wefeed-mobile-bff/subject-api/play-info') {
        const subId = u.searchParams.get('subjectId');
        const lang = subId === 'mbox-102' ? 'hi' : subId === 'mbox-103' ? 'ta' : 'en';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            code: 0,
            data: {
              streams: [
                {
                  url: `${mockOrigin}/cdn/mbox/mbox-${lang}.mp4`,
                  resolutions: '1080p'
                }
              ]
            }
          })
        );
      }

      // 11. NetMirror Mock Upstream (/netmirror/...)
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
                url: `${mockOrigin}/cdn/hls/netmirror-master.m3u8`
              }
            ]
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
        url: `http://127.0.0.1:${addr.port}`
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
    parsedEp1.some((l) => l.type === 'pixeldrain' && l.url === 'https://pixeldrain.dev/api/file/AbCdEf123'),
    'HiCine parser must convert pixeldrain /u/ links to direct /api/file/ streams'
  );
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
  const viaJs = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/countdown-js`);
  assert.strictEqual(
    viaJs,
    'https://pub-1a2b.r2.dev/movies/Fight-Club-1999.mkv',
    'URL hidden in JS string escapes (\\/) must be extracted'
  );

  // (c) two-hop flow: drive page → <a id="download"> → dl.php?link= → direct
  const viaDrive = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/drive-page`);
  assert.strictEqual(
    viaDrive,
    `${mockUpstream.url}/cdn/hls/arcane-s1e1.mp4`,
    'nested <a id="download"> wrapper must be followed one hop'
  );

  // (d) pixeldrain /u/ share page → direct /api/file/ endpoint
  const viaPixel = await unrollHubcloudUrl(`${mockUpstream.url}/hubcloud/pixeldrain-page`);
  assert.strictEqual(
    viaPixel,
    'https://pixeldrain.com/api/file/AbCdEf123',
    'pixeldrain /u/ links must be rewritten to /api/file/'
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
    assert.ok(Array.isArray(health.json.servers) && health.json.servers.length === 5);
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
    // Priority 2: Moviebox (Broad catalog, multi-language MP4/HLS)
    // Priority 3: NetMirror (Official OTT platform mirrors)
    // Waterfall Failover: When all 3 tiers miss, cleanly hand off to Server 2 (Ursa / VidSrc)
    console.log('[11/11] Testing Server Andromeda Multi-Tier Architecture & Waterfall Failover...');

    // 11a. CastleTV Unit & Sub-resolver: Security key handshake, AES-128-CBC encryption, multi-audio tracks
    const castleKey = buildCastleKey('MTIzNDU2Nzg5MA==');
    assert.strictEqual(castleKey.length, 16, 'Castle key must be 16 bytes (AES-128)');
    const testPlain = JSON.stringify({ test: 'castle-crypto-verify' });
    const testEnc = encryptCastleAes(testPlain, castleKey);
    const testDec = decryptCastleAes(testEnc, castleKey);
    assert.strictEqual(testDec, testPlain, 'Castle AES encryption and decryption must roundtrip');

    const origCastleBase = config.upstreams.castletvBase;
    const origMovieboxBase = config.upstreams.movieboxBase;
    const origNetmirrorBase = config.upstreams.netmirrorBase;
    const origVidstuckBase = config.upstreams.vidstuckBase;

    try {
      config.upstreams.castletvBase = `${mockUpstream.url}/castletv`;
      config.upstreams.movieboxBase = `${mockUpstream.url}/moviebox`;
      config.upstreams.netmirrorBase = `${mockUpstream.url}/netmirror`;
      // Clear VidStuck base to verify the pure 3-tier cascade and Ursa failover without old fallback
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

      // 11b. Moviebox Unit & Sub-resolver: HMAC-MD5 signing, search, detail & play-info
      const mboxSecret = Buffer.from('test-mbox-secret-key-12345');
      const mboxHeaders = buildMovieboxHeaders('POST', `${mockUpstream.url}/test`, JSON.stringify({ a: 1 }), mboxSecret);
      assert.ok(mboxHeaders['x-client-token'], 'Moviebox headers must include x-client-token');
      assert.ok(mboxHeaders['x-tr-signature'], 'Moviebox headers must include x-tr-signature');
      assert.match(mboxHeaders['x-tr-signature'], /^\d+\|2\|[A-Za-z0-9+/=]+$/, 'Signature must follow ts|2|b64 format');

      // Test Dynamic Moviebox Failover (dead host in pool -> failover to working mirror)
      config.upstreams.movieboxBase = 'http://127.0.0.1:1'; // unreachable dead port
      config.upstreams.movieboxHosts = [`${mockUpstream.url}/moviebox`];

      const mboxRes = await resolveMoviebox(
        { title: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
        'ta'
      );
      assert.ok(mboxRes, 'Moviebox resolver must succeed by failing over to working host in pool');
      assert.strictEqual(mboxRes.server, 'andromeda');
      assert.strictEqual(mboxRes.sourceName, 'Moviebox');
      assert.strictEqual(mboxRes.format, 'mp4');
      assert.strictEqual(mboxRes.audioTracks.length, 3, 'Moviebox must yield 3 audio tracks');
      const taMboxTrack = mboxRes.audioTracks.find((t) => t.lang === 'ta');
      assert.ok(taMboxTrack, 'Tamil track must be present');
      assert.strictEqual(taMboxTrack.default, true, 'Preferred audio "ta" must be default');

      // Reset movieboxBase for downstream tests
      config.upstreams.movieboxBase = `${mockUpstream.url}/moviebox`;

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

      // Restore static netmirrorBase as fallback
      config.upstreams.netmirrorBase = `${mockUpstream.url}/netmirror`;

      // 11d. Andromeda Multi-Tier Internal Cascading (Priority 1: Castle -> Priority 2: Moviebox -> Priority 3: NetMirror)
      // Tier 1: When CastleTV succeeds, Andromeda returns CastleTV
      const andromedaTier1 = await resolveAndromedaServer({
        title: 'Dune: Part Two',
        releaseYear: 2024,
        tmdbId: '693134',
        type: 'movie'
      });
      assert.ok(andromedaTier1 && andromedaTier1.streamUrl, 'Andromeda must resolve Tier 1');
      assert.strictEqual(andromedaTier1.sourceName, 'CastleTV', 'Priority 1 must be CastleTV');

      // Tier 2: When CastleTV fails, Andromeda cascades to Moviebox
      const andromedaTier2 = await resolveAndromedaServer({
        title: 'fail-castle Dune',
        releaseYear: 2024,
        tmdbId: '693134',
        type: 'movie'
      });
      assert.ok(andromedaTier2 && andromedaTier2.streamUrl, 'Andromeda must resolve Tier 2 when Tier 1 misses');
      assert.strictEqual(andromedaTier2.sourceName, 'Moviebox', 'Priority 2 must be Moviebox');

      // Tier 3: When CastleTV and Moviebox both fail, Andromeda cascades to NetMirror
      const andromedaTier3 = await resolveAndromedaServer({
        title: 'fail-castle fail-moviebox Dune',
        releaseYear: 2024,
        tmdbId: '693134',
        type: 'movie'
      });
      assert.ok(andromedaTier3 && andromedaTier3.streamUrl, 'Andromeda must resolve Tier 3 when Tiers 1 & 2 miss');
      assert.ok(andromedaTier3.sourceName.startsWith('NetMirror'), 'Priority 3 must be NetMirror');

      // Exhaustion: When all 3 tiers fail, Andromeda returns clean failure
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
      // Since all 3 Andromeda tiers fail, the waterfall must fall back cleanly to Server 2 (Ursa).
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
        MOVIEBOX_BASE_URL: `${mockUpstream.url}/moviebox`,
        NETMIRROR_BASE_URL: `${mockUpstream.url}/netmirror`,
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

      // Worker /api/debug/andromeda/:type/:tmdbId inspects Andromeda upstreams
      const cfDebugRes = await callWorker(
        'http://player.test/api/debug/andromeda/movie/693134',
        workerEnv
      );
      assert.strictEqual(cfDebugRes.status, 200);
      const cfDebugJson = await cfDebugRes.json();
      assert.strictEqual(cfDebugJson.ok, true);
      assert.strictEqual(cfDebugJson.upstream.castletvBase, `${mockUpstream.url}/castletv`);
      assert.strictEqual(cfDebugJson.upstream.movieboxBase, `${mockUpstream.url}/moviebox`);
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
      config.upstreams.movieboxBase = origMovieboxBase;
      config.upstreams.netmirrorBase = origNetmirrorBase;
      config.upstreams.vidstuckBase = origVidstuckBase;
    }
    console.log('  ✔ Passed CastleTV, Moviebox, NetMirror & Server 2 Ursa failover waterfall tests.');

    console.log('\n==========================================================');
    console.log('  ALL 11 PRODUCTION VERIFICATION SUITES PASSED (0 TEST VIDEOS)');
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
