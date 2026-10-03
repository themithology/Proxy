const http = require('http');
const zlib = require('zlib');
const assert = require('assert');
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
  parseHicineLinks
} = require('../src/services/resolver');
const {
  resolveArchiveServer,
  titleSimilarity,
  licenceInfo,
  pickPlayableFiles,
  pickBestItem,
  buildSearchQuery
} = require('../src/services/providers/archive');

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

      // 3b. TMDB v3 Movie Details — public-domain era title ("The General", 1926)
      if (u.pathname === '/tmdb/movie/961') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 961,
            title: 'The General',
            release_date: '1926-12-31',
            runtime: 78,
            genres: [{ id: 35, name: 'Comedy' }, { id: 10752, name: 'War' }],
            imdb_id: 'tt0017925',
            external_ids: { imdb_id: 'tt0017925' }
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
                { id: 'fr-dub', lang: 'fr', label: 'French dub', type: 'dub', url: `${mockOrigin}/cdn/hls/master-fr.m3u8` }
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

      // 7b. Internet Archive public-domain catalogue (search + item metadata + file CDN)
      if (u.pathname === '/archive/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            response: {
              numFound: 2,
              docs: [
                {
                  identifier: 'the-general-1926',
                  title: 'The General',
                  year: '1926',
                  collection: ['publicmovies'],
                  licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/'
                },
                {
                  // Decoy: right title, copyrighted and 100 years off — must never win.
                  identifier: 'modern-copyrighted-restoration',
                  title: 'The General (2026 Restoration)',
                  year: '2026',
                  collection: ['moviesandfilms'],
                  rights: 'All rights reserved'
                }
              ]
            }
          })
        );
      }

      if (u.pathname === '/archive/metadata/the-general-1926') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            metadata: {
              identifier: 'the-general-1926',
              title: 'The General',
              year: '1926',
              collection: ['publicmovies'],
              licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/'
            },
            files: [
              { name: 'the_general_512kb.mp4', format: '512Kb MPEG4', size: '180000000' },
              { name: 'the_general.mp4', format: 'h.264', size: '900000000' },
              { name: 'the_general_files.xml', format: 'Metadata' },
              { name: 'the_general.thumbs', format: 'Thumbnail' }
            ]
          })
        );
      }

      if (u.pathname.startsWith('/archive/download/')) {
        const body = Buffer.alloc(2048, 0);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(body.length),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(body);
      }

      // 8. Upstream HLS Playlist for Proxy Rewriter verification
      if (u.pathname.startsWith('/cdn/hls/')) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n1080p/index.m3u8\n`
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
  console.log('  VidStuck Production Stream Engine — Verification Suite');
  console.log('==========================================================\n');

  // 1. Cryptographic Unit Tests (AES-256-CBC + HMAC-SHA256 + Handshake Token)
  console.log('[1/8] Testing AES-256-CBC (ZXC OpenSSL EVP_BytesToKey) & HMAC Signing...');
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
  console.log('[2/8] Testing ZokoAnime XOR Decryptor & HiCine Multi-Quality Link Parser...');
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
  console.log('  ✔ Passed ZokoAnime XOR & HiCine link parser tests.');

  // 3. SRT -> WebVTT Converter Unit Test
  console.log('[3/8] Testing SubRip (.srt) to WebVTT (.vtt) Converter...');
  const sampleSrt = `1\r\n00:00:02,500 --> 00:00:05,800\r\nWelcome to Piltover.\r\n\r\n2\r\n00:00:06,100 --> 00:00:09,450\r\nThe City of Progress.\r\n`;
  const convertedVtt = srtToVtt(sampleSrt);
  assert.ok(convertedVtt.startsWith('WEBVTT'), 'Output must start with WEBVTT header');
  assert.ok(
    convertedVtt.includes('00:00:02.500 --> 00:00:05.800'),
    'Comma timestamps must convert to dots'
  );
  console.log('  ✔ Passed SRT -> VTT conversion.');

  // 4. M3U8 Manifest Rewriter Unit Test
  console.log('[4/8] Testing M3U8 Master & Media Playlist Rewriter...');
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

  // 4b. Internet Archive provider unit tests (licence gating, matching, file picker)
  console.log('[4b/9] Testing Internet Archive public-domain provider (licence gating & file picker)...');
  assert.strictEqual(titleSimilarity('The General', 'the general'), 1);
  assert.ok(titleSimilarity('The General', 'The General (1926 restoration)') >= 0.9);
  assert.ok(titleSimilarity('The General', 'General Hospital') < 0.6, 'Unrelated titles must not match');

  assert.strictEqual(
    licenceInfo({ licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/' }).publicDomain,
    true,
    'Public Domain Mark items must be accepted'
  );
  assert.strictEqual(
    licenceInfo({ collection: ['publicmovies'] }).publicDomain,
    true,
    'Curated public-domain collections must be accepted'
  );
  assert.strictEqual(
    licenceInfo({ collection: ['moviesandfilms'], rights: 'All rights reserved' }).publicDomain,
    false,
    'Copyrighted items must be rejected'
  );

  const gradedFiles = pickPlayableFiles([
    { name: 'the_general_512kb.mp4', format: '512Kb MPEG4', size: '180000000' },
    { name: 'the_general.mp4', format: 'h.264', size: '900000000' },
    { name: 'the_general_files.xml', format: 'Metadata' },
    { name: 'the_general.thumbs', format: 'Thumbnail' }
  ]);
  assert.strictEqual(gradedFiles.length, 2, 'Only real video derivatives may be offered as qualities');
  assert.strictEqual(gradedFiles[0].name, 'the_general.mp4', 'Highest-quality derivative must rank first');

  const matched = pickBestItem(
    [
      { identifier: 'modern-copyrighted-restoration', title: 'The General (2026 Restoration)', year: '2026' },
      { identifier: 'the-general-1926', title: 'The General', year: '1926' }
    ],
    { title: 'The General', year: 1926 }
  );
  assert.strictEqual(matched.doc.identifier, 'the-general-1926', 'Year proximity must break title ties');
  assert.ok(
    buildSearchQuery({ title: 'The General', year: 1926 }).includes('year:[1924 TO 1929]'),
    'Search query must constrain the release year window'
  );
  console.log('  ✔ Passed Internet Archive provider unit tests.');

  // Start Mock Upstream Server & Application HTTP Server for End-to-End Integration Tests
  const mockUpstream = await startUpstreamMockServer();
  config.tmdbBaseUrl = `${mockUpstream.url}/tmdb`;
  config.upstreams.introDbUrl = `${mockUpstream.url}/introdb`;
  config.upstreams.openSubtitlesRestUrl = `${mockUpstream.url}/opensubtitles`;
  config.upstreams.zxcBase = `${mockUpstream.url}/zxc`;
  config.upstreams.vidstuckBase = `${mockUpstream.url}/vidstuck`;
  config.upstreams.vidsrcDataUrl = `${mockUpstream.url}/vidsrc/api.php`;
  config.upstreams.archiveSearchUrl = `${mockUpstream.url}/archive/search`;
  config.upstreams.archiveMetadataUrl = `${mockUpstream.url}/archive/metadata`;
  config.upstreams.archiveDownloadBase = `${mockUpstream.url}/archive/download`;
  config.upstreams.archiveDetailsBase = `${mockUpstream.url}/archive/details`;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 5. Health & Handshake Endpoints
    console.log('[5/8] Testing /api/health & /api/handshake...');
    const health = await httpRequest(baseUrl, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);
    assert.ok(Array.isArray(health.json.servers) && health.json.servers.length === 6);

    const hs = await httpRequest(baseUrl, '/api/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', id: '94605', season: 1, episode: 1 })
    });
    assert.strictEqual(hs.status, 200);
    assert.strictEqual(hs.json.ok, true);
    console.log('  ✔ Passed /api/health & /api/handshake.');

    // 6. TMDB-ID Metadata & Real IntroDB Skip Segments Resolution
    console.log('[6/8] Testing TMDB ID -> External IDs (IMDb/TVDB) & IntroDB Skip Intro Segments...');
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
    console.log('[7/8] Testing /api/resolve/tv/94605, OpenSubtitles .srt.gz -> .vtt, & /api/proxy...');
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

    // 7c. Public-domain source end-to-end: /api/resolve/movie/961?server=archive
    console.log('[7c/9] Testing /api/resolve?server=archive (public-domain end-to-end)...');
    const archiveRes = await httpRequest(baseUrl, '/api/resolve/movie/961?server=archive');
    assert.strictEqual(archiveRes.status, 200);
    assert.strictEqual(archiveRes.json.ok, true);
    assert.strictEqual(archiveRes.json.stream.server, 'archive');
    assert.strictEqual(archiveRes.json.stream.format, 'mp4');
    assert.ok(
      archiveRes.json.stream.rawUrl.endsWith('/archive/download/the-general-1926/the_general.mp4'),
      'Best-quality public-domain derivative must be selected'
    );
    assert.strictEqual(archiveRes.json.stream.streamUrl, archiveRes.json.stream.rawUrl);
    assert.strictEqual(archiveRes.json.stream.provenance.publicDomain, true);
    assert.ok(
      archiveRes.json.stream.provenance.sourcePage.includes('the-general-1926'),
      'Provenance must expose the archive.org source page for attribution'
    );

    // Licence gating: a copyrighted title must NOT resolve through the archive source.
    const nonPd = await resolveArchiveServer({ type: 'movie', title: 'Dune: Part Two', releaseYear: 2024 });
    assert.strictEqual(nonPd, null, 'Copyrighted titles must never be served by the archive source');
    console.log('  ✔ Passed public-domain resolution & licence gating.');

    // 8. Embed Player Routes & Developer Portal HTML
    console.log('[8/8] Testing TMDB-ID Embed Routes (/embed/tv/94605/1/1, /embed/movie/693134)...');
    const embedTv = await httpRequest(baseUrl, '/embed/tv/94605/1/1');
    assert.strictEqual(embedTv.status, 200);
    assert.ok(embedTv.body.includes('PLAYER SETTINGS'), 'Embed HTML must include PLAYER SETTINGS modal');
    assert.ok(embedTv.body.includes('Skip Intro'), 'Embed HTML must include Skip Intro button');
    assert.ok(embedTv.body.includes('Upload subtitle'), 'Embed JS/HTML must support Upload subtitle');

    const portalRes = await httpRequest(baseUrl, '/');
    assert.strictEqual(portalRes.status, 200);
    assert.ok(portalRes.body.includes('Configure Embed'), 'Developer Portal must render');
    console.log('  ✔ Passed Embed Player & Developer Portal verification.');

    // 9. Owner Admin Panel (/admin, Domain Telemetry, Source Replacer, Domain Blocking, Custom Overrides)
    console.log('[9/9] Testing Owner Admin Panel (/admin, Domain Telemetry, Live Source Replacer & Firewall)...');
    const adminPage = await httpRequest(baseUrl, '/admin');
    assert.strictEqual(adminPage.status, 200);
    assert.ok(adminPage.body.includes('OWNER ADMIN CONSOLE'), '/admin HTML page must render');

    // Simulate external domain embedding the player
    await httpRequest(baseUrl, '/embed/tv/94605/1/1?parent=https://partner-cinema.to/watch/arcane', {
      headers: { Referer: 'https://partner-cinema.to/watch/arcane' }
    });
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
      overview.json.domains.some((d) => d.domain === 'partner-cinema.to' && d.embeds >= 1 && d.resolves >= 1),
      'Admin overview must track external embedding domain stats'
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
    console.log('  ✔ Passed Owner Admin Console, Domain Telemetry, Firewall & Live Source Replacement.');

    console.log('\n==========================================================');
    console.log('  ALL 9 PRODUCTION VERIFICATION SUITES PASSED (0 TEST VIDEOS)');
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
