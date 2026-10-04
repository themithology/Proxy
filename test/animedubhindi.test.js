/**
 * Anime Dub Hindi (Centaurus source #2) unit tests — parsers and ranking only.
 *
 * The fixtures mirror the two row formats the live site shipped in 2026
 * (`[480P x264]💾 106.72 MB` on Season 1 posts, `480P x264 [Size: 107mb]` on
 * Season 2), plus the adhlinks wrapper links, the soft-404 page and the GDFlix
 * button set. No network access: provider hosts are Cloudflare-walled/ISP-blocked
 * here, so parsing, attribution and ranking are what get locked down.
 *
 * Run: node test/animedubhindi.test.js
 */

'use strict';

const assert = require('assert');
const adh = require('../src/services/animedubhindi');

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

const SEARCH_HTML = `
<html><body>
  <form class="search"><input name="s" value="blue box"></form>
  <main>
    <article>
      <h2 class="entry-title"><a href="https://www.animedubhindi.link/blue-box-season-2-hindi-multi-audio/">Blue Box Season 2 Hindi, Tamil, Telugu, English, Japanese (Multi Audio) NF WEB-DL Episodes Download</a></h2>
    </article>
    <article>
      <h2 class="entry-title"><a href="https://www.animedubhindi.link/blue-box-season-1-hindi-multi-audio/">Blue Box Season 1 Hindi, Tamil, Telugu, English, Japanese (Multi Audio) BluRay Episodes Download</a></h2>
    </article>
  </main>
  <aside>
    <a href="https://www.animedubhindi.link/category/anime/">Anime</a>
    <a href="https://www.animedubhindi.link/?s=blue+box">Search</a>
    <a href="https://t.me/+fWBFeP8cqnE3MDQ6">Join Telegram</a>
  </aside>
</body></html>`;

const POST_HTML = `
<html><body>
  <h3>Blue Box Season 2 Download in Hindi</h3>
  <ul>
    <li><b>Quality:</b> 480p AVC | 720p AVC | 1080p HEVC 10bit | 1080p AVC HQ</li>
    <li><b>Audio Tracks :</b> Hindi | Tamil | Telugu | English | Japanese</li>
    <li><b>Total Episode:</b> 25</li>
  </ul>
  <p><a class="btn" href="https://new.adhlinks.com/episode/bluebox-s2/">Download / Watch</a></p>
  <p class="related"><a href="https://www.animedubhindi.link/trigun-stampede-season-1-hindi-multi-audio/">Trigun Stampede Season 1</a></p>
</body></html>`;

// Season 1 format: "[480P x264]💾 106.72 MB" + wrapper links + watch-online.
const EPISODE_PAGE_S1 = `
<html><body>
  <h4>Episode: 01</h4>
  <p>Upload Date: 06/03/2026</p>
  <p>[480P x264]💾 106.72 MB</p>
  <p>
    <a href="https://hubcloud.ist/drive/gsbas974kcbbv9c">HubCloud</a>
    <a href="https://new.adhlinks.com/re.php?data=MTZ0">Multi</a>
    <a href="https://new.adhlinks.com/redirect.php?data=RnI0">MEGA</a>
    <a href="https://gdflix.dev/file/LLNGwymM72D015H">GDFlix</a>
    <a href="https://filebee.xyz/file/6a42909586d6cba55437ce94">FileBee</a>
  </p>
  <p>[720P x264]💾 180.14 MB</p>
  <p>
    <a href="https://hubcloud.ist/drive/gfd1gz9dp4hk4sg">HubCloud</a>
    <a href="https://gdflix.dev/file/uczhEYHyyZ10Ahh">GDFlix</a>
  </p>
  <p>[1080P x265 10bit]💾 276.47 MB</p>
  <p>
    <a href="https://hubcloud.ist/drive/g1pkf2fpngeyqbu">HubCloud</a>
    <a href="https://gdflix.dev/file/8HvazZzdxGBuPw9">GDFlix</a>
  </p>
  <p>[1080P x265 10bit HQ]💾 971.46 MB</p>
  <p>
    <a href="https://hubcloud.ist/drive/378xcsrcrnr83hl">HubCloud</a>
    <a href="https://gdflix.dev/file/z2yYMfkJLsSQ9Cv">GDFlix</a>
  </p>
  <p>Watch online:- <a href="https://www.desidubanime.me/anime/ao-no-hako/">Click Here</a></p>

  <h4>Episode: 02</h4>
  <p>Upload Date: 06/03/2026</p>
  <p>[480P x264]💾 102.94 MB</p>
  <p>
    <a href="https://hubcloud.ist/drive/6fh9xf3vk3z1xzv">HubCloud</a>
    <a href="https://gdflix.dev/file/ZIRCOMQuQ669ZIi">GDFlix</a>
  </p>
  <p>[1080P x265 10bit]💾 257.91 MB</p>
  <p>
    <a href="https://hubcloud.ist/drive/zel16vdfliatgav">HubCloud</a>
    <a href="https://gdflix.dev/file/MUFSObCAwzwiFAZ">GDFlix</a>
  </p>
</body></html>`;

// Season 2 format: "480P x264 [Size: 107mb]" (site template changed mid-season).
const EPISODE_PAGE_S2 = `
<html><body>
  <div class="entry">
    <h4>Episode: 01 <em>[New]</em></h4>
    <p>[Upload Date: 03/10/2026]</p>
    <p>480P x264 [Size: 107mb]
      <a href="https://hubcloud.ist/drive/qb8pqysvbs1bsim">Hcloud</a> |
      <a href="https://gdflix.dev/file/zObWX9waTYr4hN4">GDF</a> |
      <a href="https://new.adhlinks.com/redirect.php?data=RnI0cnpH">MEGA</a> |
      <a href="https://fpgo.xyz/file/6ac2116169b577b115224369">Fprs</a>
    </p>
    <p>1080P x265 10bit [Size: 376mb]
      <a href="https://hubcloud.ist/drive/hewghw1gxz4pguv">Hcloud</a> |
      <a href="https://gdflix.dev/file/sRNEmbwBqkomMqN">GDF</a>
    </p>
    <p>Watch online:- <a href="https://www.desidubanime.me/anime/ao-no-hako-season-2/">Click Here</a></p>
  </div>
</body></html>`;

const NOT_FOUND_HTML = `
<html><body>
  <h2>This server is currently unavailable. Please try a different server to download.</h2>
  <a href="https://www.animedubhindi.com/">GO to HOME page</a>
</body></html>`;

const GDFLIX_HTML = `
<html><body>
  <h3>File Information</h3>
  <p>Name : [AnimeDubHindi] Blue Box S02E01 480p x264 NF WEB-DL Multi Audio ESub.mkv</p>
  <a href="https://new4.gdflix.io/login?ref=/file/zObWX9waTYr4hN4">Login To DL [10GBPS]</a>
  <a href="https://instant.busycdn.xyz/a1aaa3e8284b68e1::d95941666cd1b85d?bytes=112401539">Instant DL [10GBPS]</a>
  <a href="https://new4.gdflix.io/cloud/1791129392/zObWX9waTYr4hN4">FAST CLOUD / ZIPDISK</a>
  <a href="https://tgredirect.pages.dev/gdflix05_bot?start=WHFsV0I2bmd5">Telegram Generate</a>
  <a href="https://goflix.sbs/en/mirror/e128fee16d08a682fc32ce4394646e89">GoFile [Multiup]</a>
  <a href="https://light.indexserver.site/GDFSRG1PMmU1ZVJFVjJ4/new4.gdflix.io/%5BAnimeDubHindi%5D_Blue_Box_S02E01_480p_x264.mkv">DIRECT SERVER [MGT]</a>
  <a href="https://new4.gdflix.io/about-us">About US</a>
  <a href="https://new4.gdflix.io/page/privacy-policy">Privacy &amp; Policy</a>
</body></html>`;

console.log('Anime Dub Hindi — search & post pages');

check('parseSearchResults keeps same-site posts and drops taxonomy/form links', () => {
  const results = adh.parseSearchResults(SEARCH_HTML, 'https://www.animedubhindi.link/?s=blue+box');
  assert.strictEqual(results.length, 2);
  assert.ok(results[0].url.endsWith('/blue-box-season-2-hindi-multi-audio/'));
  assert.ok(!results.some((r) => r.url.includes('/category/')));
  assert.ok(!results.some((r) => r.url.includes('t.me')));
});

check('pickBestPost matches the requested season', () => {
  const results = adh.parseSearchResults(SEARCH_HTML, 'https://www.animedubhindi.link/');
  const s2 = adh.pickBestPost(results, { title: 'Blue Box', type: 'tv', season: 2 });
  const s1 = adh.pickBestPost(results, { title: 'Blue Box', type: 'tv', season: 1 });
  assert.ok(s2.url.includes('season-2'), `expected S2, got ${s2.url}`);
  assert.ok(s1.url.includes('season-1'), `expected S1, got ${s1.url}`);
});

check('pickBestPost survives year/typo noise and rejects unknown titles', () => {
  const results = [
    { url: 'https://www.animedubhindi.link/ranma-%c2%bd-2024-season-3-hindi-multi-audio/', title: 'Ranma ½ (2024) Season 3 Hindi, English, Japanese (Multi Audio) NF WEB-DL Episodes Download' }
  ];
  const picked = adh.pickBestPost(results, { title: 'Ranma ½', releaseYear: 2024, type: 'tv', season: 3 });
  assert.ok(picked, 'Ranma ½ S3 should match');
  assert.strictEqual(adh.pickBestPost(results, { title: 'Suzume', type: 'movie' }), null);
});

check('seasonFromText handles "Season 3", "Seasons 4" and SxxExx', () => {
  assert.strictEqual(adh.seasonFromText('Mushoku Tensei Season 3 Hindi'), 3);
  assert.strictEqual(adh.seasonFromText('Dr. Stone Seasons 4 Hindi Download'), 4);
  assert.strictEqual(adh.seasonFromText('[AnimeDubHindi] Blue Box S02E01 480p'), 2);
  assert.strictEqual(adh.seasonFromText('Blue Box Hindi Download'), null);
});

check('normalizeTitleForMatch reduces release-blog titles to the base title', () => {
  assert.strictEqual(
    adh.normalizeTitleForMatch('Blue Box Season 2 Hindi, Tamil, Telugu, English, Japanese (Multi Audio) NF WEB-DL Episodes Download'),
    'blue box'
  );
});

check('parsePostEpisodeLinks finds the adhlinks episode page, not related posts', () => {
  const links = adh.parsePostEpisodeLinks(POST_HTML, 'https://www.animedubhindi.link/blue-box-season-2-hindi-multi-audio/');
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].url, 'https://new.adhlinks.com/episode/bluebox-s2/');
});

console.log('\nAnime Dub Hindi — episode page');

check('parseEpisodePage reads the Season 1 row format', () => {
  const parsed = adh.parseEpisodePage(EPISODE_PAGE_S1, 'https://new.adhlinks.com/episode/blubox-s1/');
  assert.strictEqual(parsed.pageKind, 'season');
  assert.strictEqual(parsed.episodes.length, 2);
  const rows = parsed.episodes[0].rows;
  assert.strictEqual(rows.length, 4);
  const [first] = rows;
  assert.strictEqual(first.height, 480);
  assert.strictEqual(first.label, '480P x264');
  assert.strictEqual(first.isX264, true);
  assert.strictEqual(first.isHevc, false);
  assert.strictEqual(first.sizeMb, 106.72);
  const hosts = first.links.map((link) => link.host);
  assert.ok(hosts.includes('hubcloud') && hosts.includes('gdflix') && hosts.includes('mega-wrapper'));
});

check('parseEpisodePage reads the Season 2 row format and flags 10-bit HEVC', () => {
  const parsed = adh.parseEpisodePage(EPISODE_PAGE_S2, 'https://new.adhlinks.com/episode/bluebox-s2/');
  const rows = parsed.episodes[0].rows;
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].label, '480P x264');
  assert.strictEqual(rows[0].sizeMb, 107);
  assert.strictEqual(rows[1].isHevc, true);
  assert.strictEqual(rows[1].sizeMb, 376);
  // The watch-online iframe mirror is classified but never resolvable.
  const allLinks = rows.flatMap((row) => row.links);
  assert.ok(allLinks.some((link) => link.host === 'watch-online'));
  assert.ok(!allLinks.some((link) => adh.isResolvableHost(link.host) && link.host === 'watch-online'));
});

check('selectRowsForEpisode returns the requested episode only', () => {
  const parsed = adh.parseEpisodePage(EPISODE_PAGE_S1, 'https://new.adhlinks.com/episode/blubox-s1/');
  const ep1 = adh.selectRowsForEpisode(parsed, { type: 'tv', episode: 1 });
  const ep2 = adh.selectRowsForEpisode(parsed, { type: 'tv', episode: 2 });
  const ep5 = adh.selectRowsForEpisode(parsed, { type: 'tv', episode: 5 });
  assert.strictEqual(ep1.length, 4);
  assert.strictEqual(ep2.length, 2);
  assert.deepStrictEqual(ep5, []);
});

check('selectRowsForEpisode refuses to guess for TV but accepts movie pages', () => {
  const single = adh.parseEpisodePage('<html><body><p>[1080P x264]💾 1.42 GB</p><a href="https://hubcloud.ist/drive/abc">HubCloud</a></body></html>', 'https://new.adhlinks.com/movie/suzume/');
  assert.strictEqual(single.pageKind, 'single');
  assert.deepStrictEqual(adh.selectRowsForEpisode(single, { type: 'tv', episode: 3, pageUrl: 'https://new.adhlinks.com/movie/suzume/' }), []);
  assert.strictEqual(adh.selectRowsForEpisode(single, { type: 'movie', pageUrl: 'https://new.adhlinks.com/movie/suzume/' }).length, 1);
  // A single-episode page whose slug names the episode is trusted for TV.
  assert.strictEqual(adh.selectRowsForEpisode(single, { type: 'tv', episode: 3, pageUrl: 'https://new.adhlinks.com/episode/bluebox-s2-episode-03/' }).length, 1);
});

check('isPageNotFound catches adhlinks soft-404 pages', () => {
  assert.strictEqual(adh.isPageNotFound(NOT_FOUND_HTML, 'https://new.adhlinks.com/page-not-found/'), true);
  assert.strictEqual(adh.isPageNotFound(NOT_FOUND_HTML, 'https://new.adhlinks.com/episode/blubox-s1/'), true);
  assert.strictEqual(adh.isPageNotFound(EPISODE_PAGE_S1, 'https://new.adhlinks.com/episode/blubox-s1/'), false);
});

check('sortRows keeps every decodable x264 line ahead of the x265 10-bit ones', () => {
  const parsed = adh.parseEpisodePage(EPISODE_PAGE_S1, 'https://new.adhlinks.com/episode/blubox-s1/');
  const sorted = adh.sortRows(parsed.episodes[0].rows);
  // Among decodable rows resolution decides (720P before 480P) …
  assert.strictEqual(sorted[0].label, '720P x264');
  assert.strictEqual(sorted[1].label, '480P x264');
  // … and both outrank 1080P x265 10bit: a file the browser cannot decode is
  // not a higher-quality option.
  assert.strictEqual(sorted[2].isHevc, true);
  assert.strictEqual(sorted[3].isHevc, true);
  // The HQ line wins the tie between the two 1080P HEVC rows.
  assert.strictEqual(sorted[2].label, '1080P x265 10bit HQ');
});

console.log('\nAnime Dub Hindi — GDFlix');

check('parseGdflixPage orders instant → direct and skips chrome links', () => {
  const candidates = adh.parseGdflixPage(GDFLIX_HTML, 'https://gdflix.dev/file/zObWX9waTYr4hN4');
  assert.ok(candidates.length >= 2);
  assert.strictEqual(candidates[0].kind, 'instant');
  assert.ok(candidates[0].url.startsWith('https://instant.busycdn.xyz/'));
  assert.ok(candidates.some((candidate) => candidate.kind === 'cloud'));
  assert.ok(candidates.some((candidate) => candidate.kind === 'direct'));
  assert.ok(!candidates.some((candidate) => /about-us|privacy|login|tgredirect/.test(candidate.url)));
});

check('extractInstantTarget unwraps the ?url= redirect', () => {
  assert.strictEqual(
    adh.extractInstantTarget('https://dl.busycdn.xyz/go?url=https%3A%2F%2Fcdn.example%2FBlue.Box.S02E01.mkv', 'https://instant.busycdn.xyz/x'),
    'https://cdn.example/Blue.Box.S02E01.mkv'
  );
  assert.strictEqual(
    adh.extractInstantTarget('https://cdn.example/direct.mkv', 'https://instant.busycdn.xyz/x'),
    'https://cdn.example/direct.mkv'
  );
  assert.strictEqual(adh.extractInstantTarget('', 'https://instant.busycdn.xyz/x'), '');
});

check('isGdflixUrl only accepts gdflix/gdlink hosts', () => {
  assert.strictEqual(adh.isGdflixUrl('https://gdflix.dev/file/abc'), true);
  assert.strictEqual(adh.isGdflixUrl('https://new4.gdflix.io/file/abc'), true);
  assert.strictEqual(adh.isGdflixUrl('https://hubcloud.ist/drive/abc'), false);
});

console.log('\nAnime Dub Hindi — resolver guards');

async function runAsyncChecks() {
  const resolver = require('../src/services/resolver');
  const config = require('../src/config');

  // Kill switch: no network is touched when the source is disabled.
  const original = config.animedubhindi.enabled;
  config.animedubhindi.enabled = false;
  try {
    const disabled = await resolver.resolveAnimeDubHindiSource({ title: 'Blue Box', type: 'tv', season: 1, episode: 1 });
    assert.strictEqual(disabled.reason, 'source_disabled');
    passed += 1;
    console.log('  ✓ resolveAnimeDubHindiSource honours ANIMEDUBHINDI_ENABLED=false');
  } finally {
    config.animedubhindi.enabled = original;
  }

  // Non-animation titles short-circuit before any fetch (the source exists to
  // cover anime; general titles stay on HiCine → Hamster Wheel).
  const notAnime = await resolver.resolveAnimeDubHindiSource({
    title: 'Jawan',
    type: 'movie',
    genres: ['Action', 'Thriller']
  });
  assert.strictEqual(notAnime.reason, 'not_anime');
  passed += 1;
  console.log('  ✓ non-animation metadata short-circuits with not_anime (no fetch)');

  // A gdflix URL on a non-gdflix host is rejected before any fetch.
  const badHost = await resolver.unrollGdflixUrl('https://hubcloud.ist/drive/abc', {});
  assert.strictEqual(badHost, null);
  passed += 1;
  console.log('  ✓ unrollGdflixUrl rejects non-gdflix URLs without a fetch');

  // Full pipeline against a mocked network: search → post → episode page →
  // HubCloud miss → GDFlix instant 302 → probe → Centaurus payload.
  const originalFetch = global.fetch;
  const MKV_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
  const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  const directFor = (fileId) => `https://cdn.example/${fileId}.mkv`;
  const routes = [
    { match: (url) => url.includes('animedubhindi.link/?s='), handler: () => html(SEARCH_HTML) },
    { match: (url) => url.includes('blue-box-season-2-hindi-multi-audio'), handler: () => html(POST_HTML) },
    { match: (url) => url.includes('/episode/bluebox-s2/'), handler: () => html(EPISODE_PAGE_S2) },
    // HubCloud is broken in this scenario — each row must fall through to GDFlix.
    { match: (url) => url.includes('hubcloud.ist/drive/'), handler: () => html('<html><body>maintenance</body></html>') },
    // Each GDFlix file page offers its own instant token (as the real site does).
    {
      match: (url) => url.includes('gdflix.dev/file/'),
      handler: (url) => {
        const fileId = url.split('/file/')[1].split(/[?#]/)[0];
        return html(
          GDFLIX_HTML.replace(
            /https:\/\/instant\.busycdn\.xyz\/[^"]+/,
            `https://instant.busycdn.xyz/${fileId}::hash?bytes=112401539`
          )
        );
      }
    },
    {
      match: (url) => url.includes('instant.busycdn.xyz'),
      handler: (url) => {
        const fileId = new URL(url).pathname.replace(/^\//, '').split('::')[0] || 'file';
        return new Response(null, {
          status: 302,
          headers: { location: `https://dl.busycdn.xyz/go?url=${encodeURIComponent(directFor(fileId))}` }
        });
      }
    },
    {
      match: (url) => url.startsWith('https://cdn.example/') || url.includes('light.indexserver.site'),
      handler: () => new Response(MKV_BYTES, { status: 200, headers: { 'content-type': 'video/x-matroska' } })
    }
  ];
  global.fetch = async (url) => {
    const href = String(url);
    const route = routes.find((entry) => entry.match(href));
    if (!route) return new Response('not found', { status: 404 });
    return route.handler(href);
  };
  try {
    const resolved = await resolver.resolveAnimeDubHindiSource({
      title: 'Blue Box',
      type: 'tv',
      season: 2,
      episode: 1,
      releaseYear: 2026,
      genres: ['Animation']
    });
    assert.ok(resolved && resolved.streamUrl, `expected a stream payload, got ${JSON.stringify(resolved)}`);
    assert.strictEqual(resolved.server, 'centaurus');
    assert.strictEqual(resolved.centaurusSource, 'animedubhindi');
    assert.strictEqual(resolved.rawUrl, directFor('zObWX9waTYr4hN4'));
    assert.strictEqual(resolved.audioTracks[0].lang, 'hi');
    assert.strictEqual(resolved.audioTracks[0].default, true);
    assert.deepStrictEqual(
      resolved.qualities.map((quality) => quality.label).sort(),
      ['1080P x265 10bit', '480P x264']
    );
    assert.ok(resolved.animedubhindiDiag.includes('post:Blue Box Season 2'), resolved.animedubhindiDiag);
    passed += 1;
    console.log('  ✓ full pipeline resolves a probed raw URL (HubCloud miss → GDFlix instant → 302 unwrap)');
  } finally {
    global.fetch = originalFetch;
  }

  console.log(`\n${passed} Anime Dub Hindi checks passed.`);
}

runAsyncChecks().catch((error) => {
  console.error('  ✗ resolver guards');
  console.error(error);
  process.exit(1);
});
