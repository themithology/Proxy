/* Hermetic regressions for direct providers and multi-audio playback metadata. */
const assert = require('assert');
const crypto = require('crypto');
const goldmine = require('../src/services/goldmine');
const direct = require('../src/services/directProviders');
const { parseHlsAudioTracks } = require('../src/services/hls');
const { rewriteM3u8Manifest } = require('../src/services/proxy');
const languages = require('../src/services/languages');

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function testNormalization() {
  const pixel = goldmine.normalizeGoldmineStream({
    provider: '4khdhub', name: '4KHDHub - FSL Server 1080p',
    title: 'Movie.2024.1080p.Multi.Audio.Hindi.English.MKV',
    url: 'https://pixeldrain.dev/u/abc123', quality: '1080p'
  }, 0);
  assert.strictEqual(pixel.url, 'https://pixeldrain.dev/api/file/abc123');
  assert.strictEqual(pixel.container, 'mkv');
  assert.deepStrictEqual(pixel.languages.map((row) => row.code), ['hi', 'en']);

  const r2 = goldmine.normalizeGoldmineStream({
    provider: '4khdhub', name: 'Movie 1080p', title: 'Multi Audio',
    url: 'https://pub-example.r2.dev/download/9f8e7d6c', quality: '1080p'
  }, 1);
  assert.strictEqual(r2.container, 'mkv', 'extensionless R2 downloads must not stay unknown');
  assert.strictEqual(r2.multi, true);

  const splitMetadata = goldmine.normalizeGoldmineStream({
    provider: '4khdhub', name: 'Hindi + Tamil + Telugu + Japanese + Original',
    title: 'Movie 1080p Matroska', url: 'https://fsl.example/download/abc', quality: '1080p'
  }, 2);
  assert.strictEqual(splitMetadata.container, 'mkv');
  assert.deepStrictEqual(splitMetadata.languages.map((row) => row.code), ['hi', 'ta', 'te', 'ja', 'und']);
  assert.strictEqual(splitMetadata.original, true);

  assert.strictEqual(languages.parseAudioLanguageHints('Dual Audio 2 Audio Org').multi, true);
  assert.strictEqual(languages.parseAudioLanguageHints('Original Audio').original, true);
}

async function testHlsPayload() {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",LANGUAGE="hi",URI="hi.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Tamil",LANGUAGE="ta",URI="ta.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Telugu",LANGUAGE="te",URI="te.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",LANGUAGE="ja",URI="ja.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",LANGUAGE="und",URI="original.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="audio"',
    'video.m3u8'
  ].join('\n');
  const hints = parseHlsAudioTracks(manifest);
  assert.strictEqual(hints.length, 6);
  const normalized = goldmine.normalizeGoldminePayload({
    streams: [{ provider: 'netmirror', name: 'HLS', title: 'Movie 1080p', url: 'https://cdn.example/master.m3u8', quality: '1080p', audioTracks: hints }]
  });
  const payload = goldmine.buildGoldminePayload(normalized, { proxyStreams: false });
  assert.deepStrictEqual(payload.audioTracks.map((row) => row.lang), ['en', 'hi', 'ta', 'te', 'ja', 'und']);
  assert(payload.audioTracks.every((row) => row.inFile === false));
  assert.strictEqual(payload.audioTracks.find((row) => row.lang === 'ja').audioIndex, 4);

  const fetchImpl = async (url) => {
    if (String(url).includes('master.m3u8')) return new Response(manifest, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const discovered = await goldmine.discoverGoldmineHlsAudio([
    { provider: 'netmirror', title: 'Movie', url: 'https://cdn.example/master.m3u8' }
  ], { fetchImpl });
  assert.strictEqual(discovered[0].audioTracks.length, 6);
}

async function testDirectFallback() {
  let directRequested = false;
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/api/providers')) return json({ providers: [{ name: 'hdghartv', enabled: true }] });
    if (url.pathname.includes('/api/streams/hdghartv/')) {
      return json({ streams: [{ provider: 'hdghartv', name: 'single HLS', title: 'Test Movie 1080p', url: 'https://remote.example/master.m3u8', quality: '1080p' }] });
    }
    if (url.pathname === '/api/search') {
      directRequested = true;
      return json({ movies: [{ _id: 'm1', title: 'Test Movie (2024)' }] });
    }
    if (url.pathname === '/api/movies/public/m1') {
      return json({ streamingLinks: [
        { url: 'https://pixeldrain.dev/api/file/abc', quality: '1080p', language: 'Hindi', title: 'Test Movie Multi Audio MKV' },
        { url: 'https://cdn.example/english.mkv', quality: '1080p', language: 'English' }
      ] });
    }
    if (url.hostname === 'remote.example') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const fastPayload = await goldmine.resolveGoldmineServer(
    { type: 'movie', tmdbId: 'regression-fast', title: 'Test Movie', year: '2024' },
    {
      apiBase: 'https://audio-regression.invalid', fetchImpl, proxyStreams: false,
      timeoutMs: 2500, directTimeoutMs: 1000, hlsManifestTimeoutMs: 500,
      directProviderOptions: { providers: ['hdghartv'], hdghartvBaseUrl: 'https://hd.example/api' }
    }
  );
  assert.strictEqual(fastPayload.format, 'hls', 'native HLS must be the default fast path');
  assert(fastPayload.streamUrl.includes('remote.example'));
  assert.strictEqual(directRequested, false, 'native HLS must not trigger speculative direct MKV scraping');

  const rememberedEnglish = await goldmine.resolveGoldmineServer(
    { type: 'movie', tmdbId: 'regression-fast-en', title: 'Test Movie', year: '2024' },
    {
      apiBase: 'https://audio-regression.invalid', fetchImpl, proxyStreams: false, preferredAudio: 'en',
      timeoutMs: 2500, directTimeoutMs: 1000, hlsManifestTimeoutMs: 500,
      directProviderOptions: { providers: ['hdghartv'], hdghartvBaseUrl: 'https://hd.example/api' }
    }
  );
  assert.strictEqual(rememberedEnglish.format, 'hls');
  assert.strictEqual(directRequested, false, 'remembered English must stay on untagged native HLS');

  const payload = await goldmine.resolveGoldmineServer(
    { type: 'movie', tmdbId: 'regression-1', title: 'Test Movie', year: '2024' },
    {
      apiBase: 'https://audio-regression.invalid', fetchImpl, proxyStreams: false,
      timeoutMs: 2500, directTimeoutMs: 1000, hlsManifestTimeoutMs: 500, preferredAudio: 'hi',
      directProviderOptions: { providers: ['hdghartv'], hdghartvBaseUrl: 'https://hd.example/api' }
    }
  );
  const preferredPayload = goldmine.applyPreferredAudioToPayload(payload, 'hi');
  assert(preferredPayload.streamUrl.includes('pixeldrain'), 'an explicitly requested dub may still select its direct MKV');
  assert(preferredPayload.audioTracks.some((row) => row.lang === 'hi'));
  assert(preferredPayload.audioTracks.some((row) => row.lang === 'en'));
  assert.strictEqual(directRequested, true, 'a missing requested dub should still permit direct extraction');

  // Numeric Worker requests begin with this ID-only stub.  The metadata
  // promise must still enable title-based direct extraction and its merge.
  const lazyPayload = await goldmine.resolveGoldmineServer(
    { type: 'movie', tmdbId: 'regression-lazy' },
    {
      apiBase: 'https://audio-regression.invalid', fetchImpl, proxyStreams: false,
      timeoutMs: 2500, directTimeoutMs: 1000, hlsManifestTimeoutMs: 500, preferredAudio: 'hi',
      directFallback: 'parallel',
      metadataPromise: Promise.resolve({ type: 'movie', tmdbId: 'regression-lazy', title: 'Test Movie', year: '2024' }),
      directProviderOptions: { providers: ['hdghartv'], hdghartvBaseUrl: 'https://hd.example/api' }
    }
  );
  const lazyPreferred = goldmine.applyPreferredAudioToPayload(lazyPayload, 'hi');
  assert(lazyPreferred.streamUrl.includes('pixeldrain'), 'ID-only Worker stubs must still reach direct MKV fallback for a requested dub');
  assert(lazyPreferred.audioTracks.some((row) => row.lang === 'hi'));
}

async function testFastSettleOnNativeHls() {
  goldmine.clearGoldmineProviderCache();
  let wave2Called = false;
  let slowMkvAborted = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/api/providers')) {
      return json({ providers: [
        { name: 'dahmermovies', enabled: true }, { name: 'vidsrc', enabled: true }, { name: 'netmirror', enabled: true }
      ] });
    }
    if (url.pathname.includes('/api/streams/dahmermovies/')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ streams: [{ title: 'Native HLS', url: 'https://cdn.example/single.m3u8', quality: '1080p' }] });
    }
    if (url.pathname.includes('/api/streams/vidsrc/')) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({ streams: [] })), 1200);
        if (init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            slowMkvAborted = true;
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    }
    if (url.pathname.includes('/api/streams/netmirror/')) {
      wave2Called = true;
      return json({ streams: [{ title: 'Movie Hindi English Multi Audio MKV', url: 'https://cdn.example/multi.mkv', quality: '1080p' }] });
    }
    return new Response('not found', { status: 404 });
  };
  const started = Date.now();
  const result = await goldmine.fetchGoldmineStreamsFast({
    apiBase: 'https://wave2-regression.invalid', tmdbId: '1', type: 'movie', timeoutMs: 1500, fetchImpl
  });
  assert(result.ok && result.json.streams.some((stream) => stream.url.includes('single.m3u8')));
  assert(!result.json.streams.some((stream) => stream.url.includes('multi.mkv')));
  assert.strictEqual(wave2Called, false, 'ready native HLS must not launch another slow provider wave');
  assert.strictEqual(slowMkvAborted, true, 'ready native HLS must abort the slow MKV extractor');
  assert(Date.now() - started < 600, 'native HLS should settle without the old MKV wait');
}

async function testMultiAudioSettlePriority() {
  goldmine.clearGoldmineProviderCache();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/api/providers')) {
      return json({ providers: [
        { name: 'dahmermovies', enabled: true }, { name: '4khdhub', enabled: true }, { name: 'vidsrc', enabled: true }
      ] });
    }
    if (url.pathname.includes('/api/streams/dahmermovies/')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ streams: [{ title: 'Single HLS', url: 'https://cdn.example/single.m3u8', quality: '1080p' }] });
    }
    if (url.pathname.includes('/api/streams/4khdhub/')) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return json({ streams: [{ title: 'Movie Hindi English Multi Audio', url: 'https://cdn.example/multi.mkv', quality: '1080p' }] });
    }
    if (url.pathname.includes('/api/streams/vidsrc/')) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({ streams: [] })), 2000);
        if (init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    }
    return new Response('not found', { status: 404 });
  };
  const started = Date.now();
  const result = await goldmine.fetchGoldmineStreamsFast({
    apiBase: 'https://multi-priority.invalid', tmdbId: '1', type: 'movie', timeoutMs: 2500, fetchImpl
  });
  assert(result.ok && result.json.streams.some((stream) => stream.url.endsWith('multi.mkv')));
  const payload = goldmine.buildGoldminePayload(goldmine.normalizeGoldminePayload(result.json), { proxyStreams: false });
  assert.strictEqual(payload.rawUrl, 'https://cdn.example/multi.mkv');
  assert(Date.now() - started < 1200, 'multi-audio should settle promptly instead of waiting for the remaining mirrors');
}

async function testFastSettleForHlsConversion() {
  goldmine.clearGoldmineProviderCache();
  let slowExtractorAborted = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/api/providers')) {
      return json({ providers: [{ name: '4khdhub', enabled: true }, { name: 'dahmermovies', enabled: true }] });
    }
    if (url.pathname.includes('/api/streams/4khdhub/')) {
      return json({ streams: [{ title: 'Movie English 1080p', url: 'https://cdn.example/movie.mp4', quality: '1080p' }] });
    }
    if (url.pathname.includes('/api/streams/dahmermovies/')) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({ streams: [] })), 2200);
        if (init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            slowExtractorAborted = true;
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    }
    return new Response('not found', { status: 404 });
  };
  const started = Date.now();
  const result = await goldmine.fetchGoldmineStreamsFast({
    apiBase: 'https://conversion-settle.invalid', tmdbId: '1', type: 'movie', timeoutMs: 2500, fetchImpl
  });
  assert(result.ok && result.json.streams.some((stream) => stream.url.endsWith('.mp4')));
  assert(Date.now() - started < 1800, 'progressive fallback should reach the HLS converter without the old long settle');
  assert.strictEqual(slowExtractorAborted, true);
}

async function testProviderFallbackDetails() {
  const netmirror = await direct.resolveDirectStreams(
    { tmdbId: '1', type: 'movie', title: 'Test Movie' },
    {
      providers: ['netmirror'], netmirrorApiBase: 'https://netmirror.example', timeoutMs: 500,
      fetchImpl: async () => json({ ok: true, streams: [{ url: 'https://cdn.example/movie.mp4', resolution: 1080 }] })
    }
  );
  assert.strictEqual(netmirror.streams[0].headers.Referer, 'https://videodownloader.site/');

  let showboxPageRequested = false;
  const showbox = await direct.resolveDirectStreams(
    { tmdbId: '1', imdbId: 'tt1', type: 'movie', title: 'Test Movie', year: '2024' },
    {
      providers: ['showbox'], showboxBaseUrl: 'https://showbox.example', timeoutMs: 500,
      fetchImpl: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === 'fed-api.pstream.mov') {
          return json({ sources: [{ url: 'https://cdn.example/original.mp4', label: 'Original' }] });
        }
        if (url.hostname === 'showbox.example') {
          showboxPageRequested = true;
          return new Response('<html><body>No public share</body></html>', { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
    }
  );
  assert.strictEqual(showbox.streams.length, 1);
  assert.strictEqual(showboxPageRequested, true, 'single Original PStream output must not suppress FebBox fallback');
}

async function testCastleTv() {
  const secret = crypto.randomBytes(16);
  const encrypt = (value) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', secret, secret);
    return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64');
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.includes('getSecurityKey')) return json({ code: 200, data: secret.toString('base64') });
    if (url.pathname.includes('searchByKeyword')) return new Response(encrypt({ data: { rows: [{ id: '123', title: 'Test Movie' }] } }));
    if (url.pathname === '/film-api/v1.9.9/movie') {
      return new Response(encrypt({ data: { episodes: [{ id: '456', tracks: [
        { languageId: 11, languageName: 'Hindi', existIndividualVideo: true },
        { languageId: 22, languageName: 'English', existIndividualVideo: true }
      ] }] } }));
    }
    if (url.pathname.includes('getVideo2')) {
      const body = JSON.parse(init.body);
      const language = body.languageId === '11' ? 'hindi' : 'english';
      return new Response(encrypt({ data: { videoUrl: `https://cdn.example/${language}-${body.resolution}.mp4`, resolutionDescription: body.resolution === '3' ? '1080p' : '720p' } }));
    }
    return new Response('not found', { status: 404 });
  };
  const result = await direct.resolveDirectStreams(
    { tmdbId: '1', type: 'movie', title: 'Test Movie' },
    { providers: ['castletv'], fetchImpl, castleBaseUrl: 'https://castle.example', timeoutMs: 1000 }
  );
  assert(result.streams.some((stream) => stream.title.includes('Hindi')));
  assert(result.streams.some((stream) => stream.title.includes('English')));
}

async function testPreferredSourceMetadata() {
  const normalized = goldmine.normalizeGoldminePayload({ streams: [
    { provider: '4khdhub', title: 'Movie Multi Audio Hindi English MKV', url: 'https://cdn.example/multi.mkv', quality: '1080p' },
    { provider: 'netmirror', title: 'Movie Japanese HLS', url: 'https://cdn.example/master.m3u8', quality: '720p' }
  ] });
  const payload = goldmine.buildGoldminePayload(normalized, { proxyStreams: false });
  assert.strictEqual(payload.format, 'mkv', 'multi-audio must outrank single-audio HLS for conversion');
  const preferred = goldmine.applyPreferredAudioToPayload(payload, 'ja');
  assert.strictEqual(preferred.format, 'hls');
  assert.strictEqual(preferred.engine, undefined);
  assert.strictEqual(preferred.streamUrl, 'https://cdn.example/master.m3u8');
  assert.strictEqual(preferred.qualities[0].url, preferred.streamUrl);
}

async function testNestedHlsProxyHeaders() {
  const cookie = 'session=audio-regression';
  const userAgent = 'AudioRegressionUA/1.0';
  const manifest = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",LANGUAGE="hi",URI="audio/hi.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="audio"',
    'video.m3u8'
  ].join('\n');

  // Node rewriter: every nested URI must retain the master request context.
  const nodeManifest = rewriteM3u8Manifest(manifest, 'https://nested-audio.test/master.m3u8', {
    reqBaseUrl: 'https://node-proxy.test', mode: 'full', cookie, userAgent
  });
  const nodeUri = nodeManifest.match(/TYPE=AUDIO[^\n]*URI="([^"]+)"/)?.[1];
  assert(nodeUri, 'Node rewriter must proxy the audio rendition');
  const nodeParams = new URL(nodeUri, 'https://node-proxy.test').searchParams;
  assert.strictEqual(nodeParams.get('cookie'), cookie);
  assert.strictEqual(nodeParams.get('ua'), userAgent);
  assert.strictEqual(nodeParams.get('url'), 'https://nested-audio.test/audio/hi.m3u8');

  // Worker rewriter: exercise the actual proxy route, including the disguised
  // playlist sniffing path, then follow the generated audio URL upstream.
  const worker = (await import('../cloudflare-worker/worker.js')).default;
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!requestUrl.startsWith('https://nested-audio.test/')) return originalFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    upstreamRequests.push({ url: requestUrl, cookie: headers.get('cookie'), ua: headers.get('user-agent') });
    const path = new URL(requestUrl).pathname;
    if (path === '/master.m3u8' || path === '/disguised') {
      return new Response(manifest, {
        status: 200,
        headers: { 'Content-Type': path === '/disguised' ? 'application/octet-stream' : 'application/vnd.apple.mpegurl' }
      });
    }
    if (path === '/audio/hi.m3u8') {
      return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n', {
        status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
      });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    for (const target of ['https://nested-audio.test/master.m3u8', 'https://nested-audio.test/disguised']) {
      const proxyUrl = 'https://worker.test/api/proxy?' + new URLSearchParams({ url: target, mode: 'full', cookie, ua: userAgent });
      const response = await worker.fetch(new Request(proxyUrl), {}, {});
      assert.strictEqual(response.status, 200);
      const body = await response.text();
      const uri = body.match(/TYPE=AUDIO[^\n]*URI="([^"]+)"/)?.[1];
      assert(uri, `Worker must rewrite the audio URI for ${target}`);
      const nested = new URL(uri, 'https://worker.test');
      assert.strictEqual(nested.searchParams.get('cookie'), cookie);
      assert.strictEqual(nested.searchParams.get('ua'), userAgent);
      assert.strictEqual(nested.searchParams.get('url'), 'https://nested-audio.test/audio/hi.m3u8');
      const audioResponse = await worker.fetch(new Request(nested.href), {}, {});
      assert.strictEqual(audioResponse.status, 200);
      await audioResponse.body?.cancel?.();
    }
    const audioRequests = upstreamRequests.filter((row) => new URL(row.url).pathname === '/audio/hi.m3u8');
    assert.strictEqual(audioRequests.length, 2);
    assert(audioRequests.every((row) => row.cookie === cookie && row.ua === userAgent));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

module.exports = async function runAudioRegressions() {
  await testNormalization();
  await testHlsPayload();
  await testDirectFallback();
  await testFastSettleOnNativeHls();
  await testMultiAudioSettlePriority();
  await testFastSettleForHlsConversion();
  await testProviderFallbackDetails();
  await testCastleTv();
  await testPreferredSourceMetadata();
  await testNestedHlsProxyHeaders();
};
