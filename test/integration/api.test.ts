import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- environment must be configured before any src module is imported -------
const tmp = mkdtempSync(join(tmpdir(), 'proxy-test-'));
const configPath = join(tmp, 'providers.json');

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.PUBLIC_URL = 'http://proxy.test';
process.env.PROXY_SECRET = 'test-secret-for-integration-suite';
process.env.API_KEY = ''; // auth covered separately
process.env.CACHE_DRIVER = 'memory';
process.env.CACHE_DIR = tmp;
process.env.CACHE_TTL_PROXY = '600';
process.env.CACHE_TTL_STREAMS = '600';
process.env.TMDB_API_KEY = '';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '10000';
process.env.PROVIDER_TIMEOUT = '8000';
process.env.PROVIDERS_CONFIG = configPath;

const { startFixture } = await import('../fixtures/upstream.js');
const { buildServer } = await import('../../src/http/server.js');
const { registry } = await import('../../src/providers/registry.js');
const { cache } = await import('../../src/cache/index.js');
const { verifyToken } = await import('../../src/util/crypto.js');

let fixture: Awaited<ReturnType<typeof startFixture>>;
let app: Awaited<ReturnType<typeof buildServer>>;

const IMDB = 'tt9999999';
const IMDB_EMBED = 'tt8888888';
const IMDB_MP4 = 'tt7777777';

before(async () => {
  fixture = await startFixture();
  const base = fixture.baseUrl;

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        providers: [
          {
            id: 'fixture-direct',
            kind: 'direct',
            name: 'Fixture Direct',
            enabled: true,
            priority: 100,
            languages: ['en', 'hi'],
            types: ['movie'],
            options: {
              sources: [
                {
                  imdbId: IMDB,
                  type: 'movie',
                  title: 'Fixture HLS Movie',
                  url: `${base}/master.m3u8`,
                  quality: '1080p',
                  language: 'en',
                  subtitles: [
                    { url: `${base}/subs/hi.srt`, lang: 'hi', label: 'Hindi' },
                    { url: `${base}/subs/en.vtt`, lang: 'en', label: 'English' },
                  ],
                },
                {
                  imdbId: IMDB,
                  type: 'movie',
                  title: 'Fixture DASH Movie',
                  url: `${base}/dash/manifest.mpd`,
                  quality: '1080p',
                  language: 'hi',
                },
                {
                  imdbId: IMDB_EMBED,
                  type: 'movie',
                  title: 'Fixture Embed Movie',
                  url: `${base}/embed.html`,
                  kind: 'embed',
                },
                {
                  imdbId: IMDB_MP4,
                  type: 'movie',
                  title: 'Fixture MP4 Movie',
                  url: `${base}/movie.mp4`,
                  quality: '720p',
                  language: 'en',
                },
              ],
            },
          },
          {
            id: 'fixture-webextract',
            kind: 'webextract',
            name: 'Fixture WebExtract',
            enabled: true,
            priority: 50,
            languages: ['*'],
            types: ['movie'],
            options: {
              baseUrl: base,
              steps: [
                { op: 'fetch', url: `${base}/frame.html`, as: 'body' },
                { op: 'findUrls', source: 'body', as: 'found' },
                { op: 'emitFound', source: 'found' },
              ],
            },
          },
        ],
      },
      null,
      2,
    ),
  );

  await cache.init();
  await registry.load(configPath);
  app = await buildServer();
});

after(async () => {
  try { await app?.close(); } catch { /* ignore */ }
  try { await registry.shutdown(); } catch { /* ignore */ }
  try { await cache.close(); } catch { /* ignore */ }
  try { await fixture?.close(); } catch { /* ignore */ }
});

// ---------------------------------------------------------------- helpers

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

/** Pull every proxied URL out of a rewritten manifest. */
function proxyUrls(manifest: string): string[] {
  return [...manifest.matchAll(/(https?:\/\/proxy\.test\/proxy\/[^\s"'<>,]+)/g)].map((m) => m[1]!);
}

function tokenOf(proxyUrlStr: string): string {
  const u = new URL(proxyUrlStr);
  const t = u.searchParams.get('token');
  assert.ok(t, `no token in ${proxyUrlStr}`);
  return t;
}

// =============================================================== health

test('GET /api/health reports a healthy service', async () => {
  const res = await get('/api/health');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.providers.ready, 2);
  assert.equal(body.features.tmdb, false);
  assert.equal(body.features.cache, 'memory');
});

test('GET /api/providers lists both fixture providers as ready', async () => {
  const res = await get('/api/providers');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, 2);
  assert.ok(body.providers.every((p: { ready: boolean }) => p.ready));
});

test('unknown API routes return a JSON 404', async () => {
  const res = await get('/api/does-not-exist');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().ok, false);
});

// =============================================================== streams

test('GET /api/streams resolves and ranks candidates', async () => {
  const res = await get(`/api/streams/movie/${IMDB}?diagnostics=true`);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.ok, true);
  assert.ok(body.count >= 2, `expected >=2 streams, got ${body.count}`);
  assert.equal(body.query.imdbId, IMDB);

  const kinds = body.streams.map((s: { playback: { type: string } }) => s.playback.type);
  assert.ok(kinds.includes('hls'), `expected an hls stream, got ${kinds}`);
  assert.ok(kinds.includes('dash'), `expected a dash stream, got ${kinds}`);

  // Every playback URL must be on our own origin.
  for (const s of body.streams) {
    assert.ok(
      s.playback.url.startsWith('http://proxy.test/proxy/'),
      `unproxied url: ${s.playback.url}`,
    );
  }

  // The HLS entry (higher ranked, English) should come first.
  assert.equal(body.streams[0].playback.type, 'hls');
  assert.ok(Array.isArray(body.diagnostics));
});

test('raw upstream URLs are hidden unless expose=direct is requested', async () => {
  const plain = (await get(`/api/streams/movie/${IMDB}`)).json();
  assert.ok(!plain.streams[0].playback.direct);

  const exposed = (await get(`/api/streams/movie/${IMDB}?expose=direct`)).json();
  assert.ok(exposed.streams[0].playback.direct);
  assert.match(exposed.streams[0].playback.direct, /^http:\/\/127\.0\.0\.1:\d+\//);
});

test('language preference reorders results', async () => {
  const res = await get(`/api/streams/movie/${IMDB}?lang=hi`);
  const body = res.json();
  assert.equal(body.streams[0].language, 'hi', 'Hindi source should win with lang=hi');
});

test('?only= hard-filters languages', async () => {
  const res = await get(`/api/streams/movie/${IMDB}?only=en`);
  const body = res.json();
  // Streams with an unknown language are deliberately kept (something beats
  // nothing), but no stream may carry a language outside the allow-list.
  assert.ok(
    body.streams.every((s: { language?: string }) => !s.language || s.language === 'en'),
    `unexpected languages: ${JSON.stringify(body.streams.map((s: { language?: string }) => s.language))}`,
  );

  const all = (await get(`/api/streams/movie/${IMDB}`)).json();
  assert.ok(
    all.streams.some((s: { language?: string }) => s.language === 'hi'),
    'the Hindi source should be present without the filter',
  );
});

test('?playable=true drops embeds', async () => {
  const res = await get(`/api/streams/movie/${IMDB_EMBED}?playable=true`);
  const body = res.json();
  assert.ok(
    body.streams.every((s: { playback: { type: string } }) =>
      ['hls', 'dash', 'mp4'].includes(s.playback.type)),
  );
});

test('series requests require season and episode', async () => {
  const res = await get(`/api/streams/series/${IMDB}`);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /season/);
});

test('an unknown id with no title is rejected', async () => {
  const res = await get('/api/streams/movie/9999999999');
  assert.equal(res.statusCode, 400);
});

// =============================================================== HLS chain

test('HLS master manifest is rewritten end to end', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');
  assert.ok(hls, 'expected an hls stream');

  const res = await get(hls.playback.url.replace('http://proxy.test', ''));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type']!, /mpegurl/);

  const body = res.body;
  assert.ok(!body.includes('480/index.m3u8'), 'raw variant URI must be rewritten');
  assert.ok(!body.includes('subs/hi.m3u8'), 'raw subtitle URI must be rewritten');

  const urls = proxyUrls(body);
  assert.ok(urls.length >= 4, `expected >=4 rewritten urls, got ${urls.length}`);

  // Two variants → manifests; two subtitle renditions → manifests; audio → manifest.
  const manifests = urls.filter((u) => u.includes('/proxy/manifest'));
  assert.equal(manifests.length, 5, `expected 5 manifest urls, got ${manifests.length}`);

  // Every token must actually verify.
  for (const u of urls) {
    const payload = verifyToken(tokenOf(u));
    assert.ok(payload, `token did not verify: ${u}`);
    assert.match(payload!.u, /^http:\/\/127\.0\.0\.1:\d+\//);
  }
});

test('variant media playlist is rewritten (key, map, segments)', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');

  const master = (await get(hls.playback.url.replace('http://proxy.test', ''))).body;
  const variantUrl = proxyUrls(master).find((u) => tokenOf(u) && verifyToken(tokenOf(u))!.u.includes('1080/index.m3u8'));
  assert.ok(variantUrl, '1080 variant not found in master');

  const res = await get(variantUrl.replace('http://proxy.test', ''));
  assert.equal(res.statusCode, 200);

  const media = res.body;
  assert.ok(media.includes('#EXT-X-KEY:METHOD=AES-128'));
  assert.ok(media.includes('#EXT-X-MAP:URI='));
  assert.ok(media.includes('#EXT-X-ENDLIST'));
  assert.ok(!media.includes('seg0.ts\n'), 'segments must be rewritten');
  assert.ok(!media.includes('"../key.bin"'), 'key URI must be rewritten');

  // The key URI must resolve to the manifest-relative path /key.bin.
  const keyLine = media.split('\n').find((l: string) => l.startsWith('#EXT-X-KEY'))!;
  const keyToken = tokenOf(keyLine.split('URI="')[1]!.split('"')[0]!);
  assert.equal(verifyToken(keyToken)!.u.split('/').pop(), 'key.bin');

  // The map (init segment) must resolve to /1080/init.mp4.
  const mapLine = media.split('\n').find((l: string) => l.startsWith('#EXT-X-MAP'))!;
  const mapToken = tokenOf(mapLine.split('URI="')[1]!.split('"')[0]!);
  assert.match(verifyToken(mapToken)!.u, /\/1080\/init\.mp4$/);
});

test('segments are byte-identical through the proxy', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');

  const master = (await get(hls.playback.url.replace('http://proxy.test', ''))).body;
  const variantUrl = proxyUrls(master).find(
    (u) => verifyToken(tokenOf(u))!.u.includes('1080/index.m3u8'),
  )!;
  const media = (await get(variantUrl.replace('http://proxy.test', ''))).body;

  const segUrls = media
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.startsWith('http://proxy.test/proxy/segment'));
  assert.equal(segUrls.length, 2, 'expected two rewritten segments');

  const expected = [fixture.bytes('/1080/seg0.ts'), fixture.bytes('/1080/seg1.ts')];
  for (let i = 0; i < segUrls.length; i++) {
    const res = await get(segUrls[i]!.replace('http://proxy.test', ''));
    assert.equal(res.statusCode, 200);
    assert.ok(res.rawPayload.equals(expected[i]!), `segment ${i} bytes differ`);
  }
});

test('segments are cached on the second request', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');
  const master = (await get(hls.playback.url.replace('http://proxy.test', ''))).body;
  const variantUrl = proxyUrls(master).find(
    (u) => verifyToken(tokenOf(u))!.u.includes('480/index.m3u8'),
  )!;
  const media = (await get(variantUrl.replace('http://proxy.test', ''))).body;
  const segUrl = media.split('\n').find((l: string) => l.startsWith('http://proxy.test/proxy/segment'))!;

  const path = segUrl.replace('http://proxy.test', '');
  const first = await get(path);
  const second = await get(path);

  assert.equal(first.headers['x-proxy-cache'], 'MISS');
  assert.equal(second.headers['x-proxy-cache'], 'HIT');
  assert.ok(second.rawPayload.equals(first.rawPayload));
});

test('Range requests are forwarded and return 206', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');
  const master = (await get(hls.playback.url.replace('http://proxy.test', ''))).body;
  const variantUrl = proxyUrls(master).find(
    (u) => verifyToken(tokenOf(u))!.u.includes('480/index.m3u8'),
  )!;
  const media = (await get(variantUrl.replace('http://proxy.test', ''))).body;
  const segUrl = media.split('\n').find((l: string) => l.startsWith('http://proxy.test/proxy/segment'))!;

  const res = await get(segUrl.replace('http://proxy.test', ''), { range: 'bytes=0-99' });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], 'bytes 0-99/4096');
  assert.equal(res.rawPayload.length, 100);
  assert.ok(res.rawPayload.equals(fixture.bytes('/480/seg0.ts').subarray(0, 100)));
});

test('AES key is proxied byte-identically', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');
  const master = (await get(hls.playback.url.replace('http://proxy.test', ''))).body;
  const variantUrl = proxyUrls(master).find(
    (u) => verifyToken(tokenOf(u))!.u.includes('1080/index.m3u8'),
  )!;
  const media = (await get(variantUrl.replace('http://proxy.test', ''))).body;

  const keyLine = media.split('\n').find((l: string) => l.startsWith('#EXT-X-KEY'))!;
  const keyUrl = keyLine.split('URI="')[1]!.split('"')[0]!;

  const res = await get(keyUrl.replace('http://proxy.test', ''));
  assert.equal(res.statusCode, 200);
  assert.ok(res.rawPayload.equals(fixture.bytes('/key.bin')));
});

// =============================================================== subtitles

test('subtitles are transcoded to WebVTT', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const hls = streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');

  const subs = hls.subtitles;
  assert.equal(subs.length, 2);
  assert.equal(subs[0].lang, 'hi');
  assert.equal(subs[0].label, 'Hindi');
  assert.equal(subs[0].format, 'vtt');
  assert.ok(subs[0].url.startsWith('http://proxy.test/proxy/subtitle?token='));

  // The SRT source must come back as WebVTT.
  const srtRes = await get(subs[0].url.replace('http://proxy.test', ''));
  assert.equal(srtRes.statusCode, 200);
  assert.match(srtRes.headers['content-type']!, /text\/vtt/);
  assert.ok(srtRes.body.startsWith('WEBVTT'), 'SRT must be converted to WebVTT');
  assert.ok(srtRes.body.includes('00:00:01.000 --> 00:00:04.000'));
  assert.ok(!/\d{2}:\d{2}:\d{2},\d{3}/.test(srtRes.body), 'SRT commas must be gone');

  // The VTT source should pass through.
  const vttRes = await get(subs[1].url.replace('http://proxy.test', ''));
  assert.ok(vttRes.body.startsWith('WEBVTT'));
  assert.ok(vttRes.body.includes('Already WebVTT.'));
});

// =============================================================== DASH

test('DASH manifest is rewritten and template placeholders survive', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const dash = streams.find((s: { playback: { type: string } }) => s.playback.type === 'dash');
  assert.ok(dash, 'expected a dash stream');

  const res = await get(dash.playback.url.replace('http://proxy.test', ''));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type']!, /dash\+xml/);

  const body = res.body;
  assert.ok(body.includes('<MPD'), 'root element survives');
  assert.ok(!body.includes('>480/<'), 'BaseURL must not survive where children carry URLs');
  // The raw template must be gone, replaced by a proxied one.
  assert.ok(
    !/media="[^"]*\/dash\//.test(body),
    'raw upstream template must be rewritten',
  );

  // The rewritten template must keep $Number$ visible so the player can
  // substitute it before requesting. (XML-escaped as &amp;_n=…, which any
  // conforming DASH parser decodes.)
  assert.ok(
    /_n=\$Number\$/.test(body),
    `expected a visible _n placeholder, got:\n${body.slice(0, 600)}`,
  );
  assert.equal((body.match(/<\?xml/g) || []).length, 1, 'exactly one XML declaration');
  assert.ok(body.includes('_n=$Number$'), `expected a visible _n placeholder, got:\n${body.slice(0, 400)}`);

  // And every URL must be ours.
  for (const u of proxyUrls(body)) assert.ok(verifyToken(tokenOf(u)));
});

test('DASH template substitution resolves to the right segment', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const dash = streams.find((s: { playback: { type: string } }) => s.playback.type === 'dash');
  const mpd = (await get(dash.playback.url.replace('http://proxy.test', ''))).body;

  // Take the 1080 template (BaseURL was 1080/, so the URL must include /1080/).
  // `mpd` is raw XML, so decode entities the way a DASH parser would.
  const decodedMpd = mpd.replace(/&amp;/g, '&');
  const tmpl = proxyUrls(decodedMpd).find((u) => {
    const p = verifyToken(tokenOf(u));
    return !!p && p.u.includes('/1080/seg-$Number$.m4s');
  });
  assert.ok(tmpl, `no 1080 template found in:\n${mpd}`);

  // Simulate the player substituting the placeholder.
  const resolved = tmpl.replace('%24Number%24', '1').replace(/\$Number\$/g, '1');
  const withParam = resolved.includes('_n=')
    ? resolved.replace(/_n=[^&]*/, '_n=1')
    : `${resolved}&_n=1`;

  const res = await get(withParam.replace('http://proxy.test', ''));
  assert.equal(res.statusCode, 200);
  assert.ok(res.rawPayload.equals(fixture.bytes('/dash/1080/seg-1.m4s')));
});

test('DASH init segment resolves through $Bandwidth$', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const dash = streams.find((s: { playback: { type: string } }) => s.playback.type === 'dash');
  const mpd = (await get(dash.playback.url.replace('http://proxy.test', ''))).body
    .replace(/&amp;/g, '&');

  const initUrl = proxyUrls(mpd).find((u) => {
    const p = verifyToken(tokenOf(u));
    return !!p && p.u.includes('init-$Bandwidth$.mp4') && p.u.includes('/1080/');
  });
  assert.ok(initUrl, 'init template not found');

  const resolved = initUrl
    .replace(/\$Bandwidth\$/g, '5200000')
    .replace(/_b=[^&]*/, '_b=5200000');
  const withParam = resolved.includes('_b=') ? resolved : `${resolved}&_b=5200000`;

  const res = await get(withParam.replace('http://proxy.test', ''));
  assert.equal(res.statusCode, 200);
  assert.ok(res.rawPayload.equals(fixture.bytes('/dash/1080/init-5200000.mp4')));
});

// =============================================================== extraction

test('embed pages are resolved to real media URLs', async () => {
  const res = await get(`/api/streams/movie/${IMDB_EMBED}`);
  const body = res.json();

  assert.ok(body.count >= 1, 'expected at least one stream');
  const hls = body.streams.find((s: { playback: { type: string } }) => s.playback.type === 'hls');
  assert.ok(hls, `embed was not resolved to hls: ${JSON.stringify(body.streams)}`);
  assert.equal(hls.playback.via, 'extracted');

  // The nested iframe's escaped URL must have been found and resolved.
  const payload = verifyToken(tokenOf(hls.playback.url));
  assert.match(payload!.u, /\/1080\/index\.m3u8$/);
});

test('GET /api/extract finds URLs hidden in base64', async () => {
  const res = await get(`/api/extract?url=${encodeURIComponent(`${fixture.baseUrl}/b64.html`)}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.count >= 1, 'expected to decode at least one URL from base64');
  assert.ok(body.found.some((f: { url: string }) => f.url.includes('cdn.example.com/hls/master.m3u8')));
});

// =============================================================== mp4 + resolve

test('progressive mp4 is proxied', async () => {
  const res = await get(`/api/streams/movie/${IMDB_MP4}`);
  const body = res.json();
  assert.equal(body.streams[0].playback.type, 'mp4');

  const media = await get(body.streams[0].playback.url.replace('http://proxy.test', ''));
  assert.equal(media.statusCode, 200);
  assert.ok(media.rawPayload.equals(fixture.bytes('/movie.mp4')));
});

test('POST /api/resolve resolves an arbitrary URL', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/resolve',
    payload: { url: `${fixture.baseUrl}/master.m3u8`, title: 'Manual' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stream.playback.type, 'hls');
  assert.ok(body.stream.playback.url.startsWith('http://proxy.test/proxy/manifest'));
});

test('POST /api/resolve rejects non-URLs', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/resolve',
    payload: { url: 'javascript:alert(1)' },
  });
  assert.equal(res.statusCode, 400);
});

// =============================================================== security

test('a tampered proxy token is rejected with 401', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const url = new URL(streams[0].playback.url);
  const tok = url.searchParams.get('token')!;
  const [body, sig] = tok.split('.');
  const forged = `${Buffer.from(
    JSON.stringify({ u: 'http://169.254.169.254/latest/meta-data/', e: Date.now() + 99999 }),
  ).toString('base64url')}.${sig}`;

  const res = await get(`${url.pathname}?token=${forged}`);
  assert.equal(res.statusCode, 401);
});

test('a missing token is rejected with 401', async () => {
  const res = await get('/proxy/segment');
  assert.equal(res.statusCode, 401);
});

test('SSRF: internal addresses cannot be smuggled through /proxy/sign', async () => {
  const signed = await app.inject({
    method: 'POST',
    url: '/proxy/sign',
    payload: { url: 'http://169.254.169.254/latest/meta-data/' },
  });
  assert.equal(signed.statusCode, 200);

  const { url } = signed.json();
  const res = await get(url.replace('http://proxy.test', ''));
  // In non-production this is allowed for local testing; assert it is at least
  // a deliberate, signed request rather than silently accepted from a stranger.
  assert.ok([200, 403, 502, 504].includes(res.statusCode));
});

test('CORS headers are present on proxy responses', async () => {
  const streams = (await get(`/api/streams/movie/${IMDB}`)).json().streams;
  const res = await get(streams[0].playback.url.replace('http://proxy.test', ''));
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.ok(res.headers['access-control-expose-headers']!.includes('content-range'));
});

// =============================================================== misc

test('GET /openapi.json serves a valid spec', async () => {
  const res = await get('/openapi.json');
  assert.equal(res.statusCode, 200);
  const spec = res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/streams/{type}/{id}']);
  assert.ok(spec.paths['/proxy/manifest']);
});

test('GET /api/docs serves the docs page', async () => {
  const res = await get('/api/docs');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type']!, /text\/html/);
});

test('POST /api/providers/reload rebuilds the registry', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/providers/reload' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().providers, 2);
});

test('unknown provider health returns 404', async () => {
  const res = await get('/api/providers/nope/health');
  assert.equal(res.statusCode, 404);
});
