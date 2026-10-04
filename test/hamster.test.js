/**
 * Hamster Wheel unit tests — parsers and ranking only.
 *
 * They deliberately never touch the network: provider hosts are either
 * geo/ISP-blocked or Cloudflare-walled in CI, so protocol parsing and ranking
 * are the parts worth locking down here. Live behaviour is verified with
 * `curl /api/resolve/...?server=hamster` against a real deployment.
 *
 * Run: node test/hamster.test.js
 */

'use strict';

const assert = require('assert');
const hamster = require('../src/services/hamster');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('Hamster Wheel — parsers');

check('parseQuality maps release text to heights', () => {
  assert.deepStrictEqual(hamster.parseQuality('Jawan 2023 1080p WEB-DL'), { label: '1080p', height: 1080 });
  assert.deepStrictEqual(hamster.parseQuality('Movie.2160p.HDR'), { label: '2160p', height: 2160 });
  assert.deepStrictEqual(hamster.parseQuality('Movie 720p'), { label: '720p', height: 720 });
  assert.deepStrictEqual(hamster.parseQuality('no quality here'), { label: 'Auto', height: 0 });
});

check('parseAudioHint distinguishes Hindi / multi / English', () => {
  assert.strictEqual(hamster.parseAudioHint('Jawan 2023 Hindi 1080p'), 'hi');
  assert.strictEqual(hamster.parseAudioHint('Movie Hindi + English Dual Audio'), 'multi');
  assert.strictEqual(hamster.parseAudioHint('Movie WEB-DL English'), 'en');
  assert.strictEqual(hamster.parseAudioHint('Movie 1080p'), 'und');
});

check('kindFromUrl recognises stream containers', () => {
  assert.strictEqual(hamster.kindFromUrl('https://cdn.example/master.m3u8?token=1'), 'hls');
  assert.strictEqual(hamster.kindFromUrl('https://cdn.example/file.mp4'), 'mp4');
  assert.strictEqual(hamster.kindFromUrl('https://cdn.example/release.mkv'), 'mkv');
  assert.strictEqual(hamster.kindFromUrl('https://cdn.example/manifest.mpd'), 'dash');
  assert.strictEqual(hamster.kindFromUrl('https://hubcloud.ist/drive/abc'), 'unknown');
});

check('pixeldrainDirect rewrites file pages to direct downloads', () => {
  assert.strictEqual(
    hamster.pixeldrainDirect('https://pixeldrain.com/u/AbCd1234'),
    'https://pixeldrain.com/api/file/AbCd1234?download'
  );
  assert.strictEqual(hamster.pixeldrainDirect('https://hubcloud.ist/drive/abc'), '');
});

check('gdshineFileId extracts release ids only from gdshine links', () => {
  assert.strictEqual(hamster.gdshineFileId('https://gdshine.org/file/AbC123xyz789'), 'AbC123xyz789');
  assert.strictEqual(hamster.gdshineFileId('https://gdshine.org/'), '');
  assert.strictEqual(hamster.gdshineFileId('https://hubcloud.ist/drive/abc'), '');
});

console.log('Hamster Wheel — HindMoviez parsing');

check('parseHindMoviezArticles reads post cards', () => {
  const html = `
    <main>
      <article class="post">
        <h2 class="entry-title"><a href="/movie/jawan-2023/">Jawan (2023) Hindi 1080p</a></h2>
        <div class="entry-meta">Released 2023</div>
      </article>
      <article class="post">
        <h2 class="entry-title"><a href="/movie/pathaan-2023/">Pathaan (2023) Hindi</a></h2>
      </article>
    </main>`;
  const articles = hamster.parseHindMoviezArticles(html, 'https://hindmovie.dev');
  assert.strictEqual(articles.length, 2);
  assert.strictEqual(articles[0].title, 'Jawan (2023) Hindi 1080p');
  assert.strictEqual(articles[0].url, 'https://hindmovie.dev/movie/jawan-2023/');
  assert.strictEqual(articles[0].year, 2023);
});

check('parseHindMoviezPageLinks keeps release hosts and drops nav', () => {
  const html = `
    <div class="entry-content">
      <a class="maxbutton" href="https://hindmovie.dev/download/jawan-1080p/">Download 1080p</a>
      <a href="https://gdshine.org/file/AbC123xyz789">Gdshine 1080p</a>
      <a href="https://hubcloud.ist/drive/xyz">HubCloud</a>
      <a href="https://hindmovie.dev/contact">Contact</a>
    </div>`;
  const links = hamster.parseHindMoviezPageLinks(html, 'https://hindmovie.dev/movie/jawan-2023/');
  assert.strictEqual(links.length, 4);
  const gd = links.find((link) => /gdshine/.test(link.url));
  assert.strictEqual(gd.quality.height, 1080);
  assert.strictEqual(hamster.gdshineFileId(gd.url), 'AbC123xyz789');
});

console.log('Hamster Wheel — 4KHDHub parsing');

check('parseKHDHubCards reads search cards with format + year', () => {
  const html = `
    <div class="grid">
      <a class="movie-card" href="/movie/jawan-2023/">
        <h3 class="movie-card-title">Jawan</h3>
        <span class="movie-card-format">Movies</span>
        <div class="movie-card-meta">2023 • Action</div>
      </a>
      <a class="movie-card" href="/series/jawan-series/">
        <h3 class="movie-card-title">Jawan Series</h3>
        <span class="movie-card-format">Series</span>
        <div class="movie-card-meta">2021 • Drama</div>
      </a>
    </div>`;
  const cards = hamster.parseKHDHubCards(html, 'https://4khdhub.one');
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(cards[0].title, 'Jawan');
  assert.strictEqual(cards[0].url, 'https://4khdhub.one/movie/jawan-2023/');
  assert.strictEqual(cards[0].year, 2023);
  assert.strictEqual(cards[1].format, 'Series');
});

check('pickKHDHubCard prefers the movie card with the matching year', () => {
  const cards = hamster.parseKHDHubCards(
    `
    <a class="movie-card" href="/movie/jawan-2016/">
      <h3 class="movie-card-title">Jawan</h3><span class="movie-card-format">Movies</span>
      <div class="movie-card-meta">2016 • Action</div>
    </a>
    <a class="movie-card" href="/movie/jawan-2023/">
      <h3 class="movie-card-title">Jawan</h3><span class="movie-card-format">Movies</span>
      <div class="movie-card-meta">2023 • Action</div>
    </a>`,
    'https://4khdhub.one'
  );
  const picked = hamster.pickKHDHubCard(cards, { title: 'Jawan', releaseYear: 2023, type: 'movie' }, false);
  assert.strictEqual(picked.url, 'https://4khdhub.one/movie/jawan-2023/');
});

check('parseKHDHubItems reads release blocks and their deep links', () => {
  const html = `
    <div class="download-item">
      <p class="file-title">Jawan 2023 1080p WEB-DL Hindi DDP5.1 x264 [2.4GB]</p>
      <a href="https://hblinks.example/abc">Download Links</a>
      <a href="https://hubcloud.ist/drive/xyz">HubCloud</a>
    </div>
    <div class="download-item">
      <p class="file-title">Jawan 2023 2160p 4K HDR Hindi [9GB]</p>
      <a href="https://hblinks.example/def">Download Links</a>
    </div>`;
  const items = hamster.parseKHDHubItems(html, { isSeries: false });
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].height, 1080);
  assert.strictEqual(items[0].size, '2.4GB');
  assert.strictEqual(items[0].links.length, 2);
  assert.strictEqual(items[1].height, 2160);
});

check('parseKHDHubItems selects the requested episode for series', () => {
  const html = `
    <div class="episode-item">
      <h3 class="episode-title">Season S01</h3>
      <div class="episode-download-item">
        <span class="episode-file-title">Episode-01 1080p</span>
        <a href="https://hblinks.example/ep1">Links</a>
      </div>
      <div class="episode-download-item">
        <span class="episode-file-title">Episode-02 1080p</span>
        <a href="https://hblinks.example/ep2">Links</a>
      </div>
    </div>`;
  const items = hamster.parseKHDHubItems(html, { isSeries: true, season: 1, episode: 2 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].links[0].url, 'https://hblinks.example/ep2');
  assert.strictEqual(items[0].height, 1080);
});

check('parseHblinksPage collects outbound release links', () => {
  const html = `
    <div class="entry-content">
      <h3><a href="https://hubcloud.ist/drive/xyz">HubCloud 1080p</a></h3>
      <p><a href="/go/gamerxyt-xyz">G-Direct</a></p>
      <a href="https://hblinks.example/nested">More links</a>
    </div>`;
  const links = hamster.parseHblinksPage(html, 'https://hblinks.example/abc');
  assert.strictEqual(links.length, 3);
  assert.strictEqual(links[0].url, 'https://hubcloud.ist/drive/xyz');
  assert.strictEqual(links[1].url, 'https://hblinks.example/go/gamerxyt-xyz');
});

check('parseHubCloudFinalLinks finds the raw mirrors on the final page', () => {
  const html = `
    <div id="size">2.4 GB</div>
    <a href="https://bcdn.example/r2/abc.mkv">Download File</a>
    <a href="https://pixeldrain.com/u/AbCd1234">PixelServer</a>
    <a href="https://zip.example.workers.dev/dl/def.mkv">ZipDisk Server</a>
    <a href="https://fsl.example/download/ghi">FSL Server</a>
    <a href="https://hubcloud.ist/help">Help</a>`;
  const links = hamster.parseHubCloudFinalLinks(html);
  const urls = links.map((entry) => entry.url);
  assert.ok(urls.includes('https://bcdn.example/r2/abc.mkv'), 'R2 direct link must be kept');
  assert.ok(urls.includes('https://zip.example.workers.dev/dl/def.mkv'), 'ZipDisk link must be kept');
  assert.ok(urls.includes('https://fsl.example/download/ghi'), 'FSL link must be kept');
  assert.ok(urls.includes('https://pixeldrain.com/api/file/AbCd1234?download'), 'PixelDrain must be rewritten to the API');
  assert.ok(!urls.some((url) => /hubcloud\.ist\/help/.test(url)), 'non-release anchors must be ignored');
});

check('decodeReleaseRedirect undoes the base64/rot13 wrapper', () => {
  const target = 'https://hubcloud.ist/drive/raw-target';
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64');
  const json = JSON.stringify({ o: encode(target) });
  const step4 = encode(json);
  const step3 = hamster.rot13(step4);
  const step2 = encode(step3);
  const payload = encode(step2);
  const page = `<script>s('o','${payload}');</script>`;
  assert.strictEqual(hamster.decodeReleaseRedirect(page), target);
  assert.strictEqual(hamster.decodeReleaseRedirect('<html>not a wrapper</html>'), '');
});

check('titleDistance tolerates release-name noise', () => {
  assert.strictEqual(hamster.titleDistance('jawan', 'jawan'), 0);
  assert.ok(hamster.titleDistance('jawaan', 'jawan') <= 2, 'near-miss spelling stays within tolerance');
  assert.ok(hamster.titleDistance('pathaan', 'jawan') > 2, 'a different title must stay far away');
});

check('pickKHDHubCard ignores a different title entirely', () => {
  const cards = hamster.parseKHDHubCards(
    `
    <a class="movie-card" href="/movie/jawan-2023/">
      <h3 class="movie-card-title">Jawan 2023 Hindi 1080p WEB-DL</h3>
      <span class="movie-card-format">Movies</span>
      <div class="movie-card-meta">2023</div>
    </a>`,
    'https://4khdhub.one'
  );
  assert.strictEqual(
    hamster.pickKHDHubCard(cards, { title: 'Pathaan', releaseYear: 2023, type: 'movie' }, false),
    null
  );
  assert.ok(hamster.pickKHDHubCard(cards, { title: 'Jawan', releaseYear: 2023, type: 'movie' }, false));
});

console.log('Hamster Wheel — ranking');

check('candidateScore prefers Hindi and higher quality', () => {
  const hindi1080 = { provider: 'moviebox', audio: 'hi', height: 1080, kind: 'mp4' };
  const english720 = { provider: 'hindmoviez', audio: 'en', height: 720, kind: 'mkv' };
  const multi2160 = { provider: '4khdhub', audio: 'multi', height: 2160, kind: 'mkv' };
  assert.ok(hamster.candidateScore(hindi1080) > hamster.candidateScore(english720));
  assert.ok(hamster.candidateScore(multi2160) > hamster.candidateScore(english720));
});

check('sortCandidates puts a Hindi 1080p MP4 first', () => {
  const list = [
    { provider: '4khdhub', audio: 'en', height: 720, kind: 'mkv', url: 'https://x/b' },
    { provider: 'moviebox', audio: 'hi', height: 1080, kind: 'mp4', url: 'https://x/a' },
    { provider: 'hindmoviez', audio: 'hi', height: 480, kind: 'hls', url: 'https://x/c' }
  ];
  const sorted = hamster.sortCandidates(list);
  assert.strictEqual(sorted[0].url, 'https://x/a');
  assert.strictEqual(sorted[2].url, 'https://x/b');
});

console.log('Hamster Wheel — MovieBox signing');

check('movieboxSignature produces the documented header contract', () => {
  const headers = hamster.movieboxSignature(
    'POST',
    'https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/search/v2',
    '{"keyword":"Jawan","page":1,"perPage":15}'
  );
  assert.match(headers['x-tr-signature'], /^\d{13}\|2\|[A-Za-z0-9+/=]+$/);
  const [ts, tokenHash] = headers['x-client-token'].split(',');
  assert.strictEqual(ts, headers['x-tr-signature'].split('|')[0]);
  assert.match(tokenHash, /^[0-9a-f]{32}$/);
  const clientInfo = JSON.parse(headers['x-client-info']);
  assert.strictEqual(clientInfo.package_name, 'com.community.oneroom');
  assert.match(headers['User-Agent'], /^com\.community\.oneroom\/\d+/);
});

check('pickMovieBoxSubject prefers exact title + year', () => {
  const items = [
    { subjectId: '1', title: 'Jawan', year: 2023, type: 'MOVIE' },
    { subjectId: '2', title: 'Jawan', year: 2016, type: 'MOVIE' },
    { subjectId: '3', title: 'Jawan 2', year: 2025, type: 'MOVIE' }
  ];
  const picked = hamster.pickMovieBoxSubject(items, { title: 'Jawan', releaseYear: 2023, type: 'movie' });
  assert.strictEqual(picked.subjectId, '1');
  assert.strictEqual(hamster.pickMovieBoxSubject(items, { title: 'Something Else', type: 'movie' }), null);
});

console.log('Hamster Wheel — kill switch');

async function runAsyncChecks() {
  const config = require('../src/config');
  const original = config.hamster.enabled;
  config.hamster.enabled = false;
  try {
    const result = await hamster.resolveHamsterCandidates({ title: 'Jawan', type: 'movie' });
    // The fan-out short-circuits before any provider is contacted.
    assert.deepStrictEqual(result.candidates, []);
    assert.strictEqual(result.providers[0].diag, 'disabled');
    passed += 1;
    console.log('  ✓ resolveHamsterCandidates honours HAMSTER_ENABLED=false');
  } finally {
    config.hamster.enabled = original;
  }
  console.log(`\n${passed} Hamster Wheel checks passed.`);
}

runAsyncChecks().catch((error) => {
  console.error('  ✗ resolveHamsterCandidates honours HAMSTER_ENABLED=false');
  console.error(error);
  process.exit(1);
});
