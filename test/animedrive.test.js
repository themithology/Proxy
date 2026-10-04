/**
 * AnimeDrive (Centaurus source #3) unit tests — parsers, ranking and the full
 * mocked pipeline.
 *
 * Fixtures mirror the live site as fetched on 2026-10-04: a WordPress search
 * page, a post whose only release link is the `link.animedrive.cc` landing
 * page, and the landing page's `EP NN` accordions with HubCloud/GDFlix rows
 * wrapped as `link.animedrive.cc/dl/<base64url(reverse(target))>`. Every
 * wrapper payload below is built with the same helper the site uses, and the
 * two hosts are exercised through the shared unrollers.
 *
 * Run: node test/animedrive.test.js
 */

'use strict';

const assert = require('assert');
const drive = require('../src/services/animedrive');

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

/** `link.animedrive.cc/dl/<payload>` — the site's base64url(reverse(url)) wrapper. */
const dlToken = (target) => {
  const raw = Buffer.from(target, 'utf8').toString('binary');
  return Buffer.from(raw.split('').reverse().join(''), 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
const wrap = (target, label) =>
  `https://link.animedrive.cc/dl/${dlToken(target)}?t=Blue+Box+Season+2&q=${encodeURIComponent(label)}`;

const SEARCH_HTML = `
<html><body>
  <form class="search"><input name="s" value="blue box"></form>
  <main>
    <article>
      <h2 class="entry-title"><a href="https://animedrive.cc/blue-box-season-2-hindi-download/">Blue Box Season 2 [Hindi-Eng-Jap] Multi Audio 480p, 720p &amp; 1080p HD WEB-DL | 10bit HEVC | EP-01 Added</a></h2>
    </article>
    <article>
      <h2 class="entry-title"><a href="https://animedrive.cc/blue-box-season-1-hindi-download/">Blue Box Season 1 [Hindi-Eng-Jap] Multi Audio 480p, 720p &amp; 1080p HD WEB-DL | 10bit HEVC | Complete Season Pack</a></h2>
    </article>
    <article>
      <h2 class="entry-title"><a href="https://animedrive.cc/that-time-i-got-reincarnated-as-a-slime-season-4-hindi-download/">That Time I Got Reincarnated as a Slime Season 4 [Hindi-Eng-Jap] Multi Audio 480p, 720p &amp; 1080p HD WEB-DL | 10bit HEVC | EP-18 Added</a></h2>
    </article>
  </main>
  <aside>
    <a href="https://t.me/animeedrive">Join our Telegram for latest updates!</a>
    <a href="https://animedrive.cc/?s=blue+box">Search</a>
  </aside>
</body></html>`;

const POST_HTML = `
<html><body>
  <h1>Blue Box Season 2 Hindi Download</h1>
  <p>Audio: Multi Audio (Hindi-English-Japanese)</p>
  <p><a class="btn" href="https://link.animedrive.cc/2026/10/04/blue-box-2026-s02-hindi-download/">Download / Watch</a></p>
  <p class="related"><a href="https://animedrive.cc/blue-box-season-1-hindi-download/">Blue Box Season 1</a></p>
  <footer><a href="https://t.me/animeedrive">Join Telegram</a></footer>
</body></html>`;

// EP 01 has both hosts; Send.cm / StreamTape rows must be skipped by the parser.
const LANDING_HTML = `
<html><body>
  <h1>Blue Box Season 02 – AnimeDrive</h1>
  <div>📦 Full ZIP Download</div>
  <div>⏳ Zip Download Will Be Available Soon. Stay Tuned!</div>
  <h2>📵 Episodes</h2>

  <details>
    <summary>EP 01Episode 1</summary>
    <h4>☁️ HubCloud</h4>
    <a href="${wrap('https://hubcloud.ist/drive/ep1hcl480', '📥 480p x264 — 107mb')}">📥 480p x264 — 107mb</a>
    <a href="${wrap('https://hubcloud.ist/drive/ep1hcl720', '📥 720p x264 — 186mb')}">📥 720p x264 — 186mb</a>
    <h4>🟣 GDFlix</h4>
    <a href="${wrap('https://gdflix.dev/file/ep1gdf1080', '📥 1080p x264 — 1.42GB')}">📥 1080p x264 — 1.42GB</a>
    <a href="${wrap('https://send.cm/5ow6jh9n1o4o', '📥 720p x264 — 186mb')}">📥 720p x264 — 186mb</a>
    <a href="https://streamtape.com/e/wODyb43jQ3CJz3l">📥 1080p HEVC — 311.00 MB</a>
  </details>

  <details>
    <summary>EP 02Episode 2</summary>
    <h4>☁️ HubCloud</h4>
    <a href="${wrap('https://hubcloud.ist/drive/ep2hcl480', '📥 480p x264 — 108mb')}">📥 480p x264 — 108mb</a>
    <h4>🟣 GDFlix</h4>
    <a href="${wrap('https://gdflix.dev/file/ep2gdf720', '📥 720p x264 — 179mb')}">📥 720p x264 — 179mb</a>
  </details>
</body></html>`;

// Movie page: no `EP NN` markers at all.
const MOVIE_HTML = `
<html><body>
  <h1>Some Anime Movie – AnimeDrive</h1>
  <a href="${wrap('https://hubcloud.ist/drive/mv1080', '📥 1080p x264 — 2.10GB')}">📥 1080p x264 — 2.10GB</a>
  <a href="${wrap('https://gdflix.dev/file/mv1080', '📥 1080p x265 10bit — 1.80GB')}">📥 1080p x265 10bit — 1.80GB</a>
</body></html>`;

const NOT_FOUND_HTML = '<html><body><h1>Page Not Found</h1><p>Nothing found here.</p></body></html>';

/* ------------------------------------------------------------------------- */
/* Parsing                                                                   */
/* ------------------------------------------------------------------------- */

check('decodeDlUrl decodes the live token shape (base64url of the reversed URL)', () => {
  // Verified live 2026-10-04: this exact payload is anime drive EP01's GDFlix 480p row.
  const live = 'https://link.animedrive.cc/dl/NUNJMGpJcjZVbmRnYXBLL2VsaWYvdmVkLnhpbGZkZy8vOnNwdHRo?t=x&q=y';
  assert.strictEqual(drive.decodeDlUrl(live), 'https://gdflix.dev/file/KpagdnU6rIj0IC5');
});

check('decodeDlUrl also accepts plain base64 and rejects non-dl paths / junk', () => {
  const plain = `https://link.animedrive.cc/dl/${Buffer.from(
    'https://hubcloud.ist/drive/etoew62n2tnfuc2'.split('').reverse().join('')
  )
    .toString('base64')
    .replace(/=+$/, '')}`;
  assert.strictEqual(drive.decodeDlUrl(plain), 'https://hubcloud.ist/drive/etoew62n2tnfuc2');
  assert.strictEqual(drive.decodeDlUrl('https://link.animedrive.cc/go/abc'), '');
  assert.strictEqual(drive.decodeDlUrl('https://link.animedrive.cc/dl/%%%%'), '');
  assert.strictEqual(drive.decodeDlUrl('not a url'), '');
});

check('parseRowLabel reads height, codec, HQ and size', () => {
  const row = drive.parseRowLabel('📥 1080p x265 10bit — 395mb');
  assert.strictEqual(row.height, 1080);
  assert.strictEqual(row.isHevc, true);
  assert.strictEqual(row.isX264, false);
  assert.strictEqual(Math.round(row.sizeMb), 395);
  const hq = drive.parseRowLabel('📥 1080p x264 — 1.50GB');
  assert.strictEqual(hq.isX264, true);
  assert.strictEqual(Math.round(hq.sizeMb), 1536);
});

check('parsePostLink follows the Download / Watch button, never Telegram/related links', () => {
  const url = drive.parsePostLink(POST_HTML, 'https://animedrive.cc/blue-box-season-2-hindi-download/');
  assert.strictEqual(url, 'https://link.animedrive.cc/2026/10/04/blue-box-2026-s02-hindi-download/');
});

check('parseEpisodePage groups rows per episode and skips non-HubCloud/GDFlix hosts', () => {
  const parsed = drive.parseEpisodePage(LANDING_HTML, 'https://link.animedrive.cc/2026/10/04/blue-box-2026-s02-hindi-download/');
  assert.strictEqual(parsed.pageKind, 'ok');
  assert.deepStrictEqual(parsed.episodes.map((episode) => episode.episode), [1, 2]);
  assert.deepStrictEqual(
    parsed.episodes[0].rows.map((row) => `${row.host}:${row.height}`).sort(),
    ['gdflix:1080', 'hubcloud:480', 'hubcloud:720']
  );
  assert.strictEqual(parsed.episodes[1].rows.length, 2);
});

check('selectRowsForEpisode returns only the requested episode for TV', () => {
  const parsed = drive.parseEpisodePage(LANDING_HTML, 'https://link.animedrive.cc/x/');
  const ep1 = drive.selectRowsForEpisode(parsed, { type: 'tv', episode: 1 });
  assert.strictEqual(ep1.length, 3);
  const ep2 = drive.selectRowsForEpisode(parsed, { type: 'tv', episode: 2 });
  assert.strictEqual(ep2.length, 2);
  // A not-yet-uploaded episode must NOT fall back to another one (or the ZIP).
  assert.deepStrictEqual(drive.selectRowsForEpisode(parsed, { type: 'tv', episode: 9 }), []);
});

check('selectRowsForEpisode uses unmarked rows for movies', () => {
  const parsed = drive.parseEpisodePage(MOVIE_HTML, 'https://link.animedrive.cc/x/');
  const rows = drive.selectRowsForEpisode(parsed, { type: 'movie', episode: 1 });
  assert.strictEqual(rows.length, 2);
});

check('parseEpisodePage flags a soft-404 page', () => {
  const parsed = drive.parseEpisodePage(NOT_FOUND_HTML, 'https://link.animedrive.cc/x/');
  assert.strictEqual(parsed.pageKind, 'not_found');
});

check('sortRows prefers x264 over x265, then resolution', () => {
  const rows = [
    drive.parseRowLabel('1080p x265 10bit — 395mb'),
    drive.parseRowLabel('480p x264 — 107mb'),
    drive.parseRowLabel('1080p x264 — 1.42GB')
  ];
  const ordered = drive.sortRows(rows);
  assert.strictEqual(ordered[0].height, 1080);
  assert.strictEqual(ordered[0].isX264, true);
  assert.strictEqual(ordered[ordered.length - 1].isHevc, true);
});

check('languagesFromText puts Hindi first and falls back safely', () => {
  assert.deepStrictEqual(drive.languagesFromText('[Hindi-Eng-Jap] Multi Audio').map((l) => l.code), ['hi', 'en', 'ja']);
  assert.deepStrictEqual(drive.languagesFromText('Some Show WEB-DL').map((l) => l.code), ['hi', 'en', 'ja']);
});

/* ------------------------------------------------------------------------- */
/* Full pipeline (mocked network)                                            */
/* ------------------------------------------------------------------------- */

const MKV_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const maintenance = () => html('<html><body>maintenance</body></html>');
const gdflixPage = (instantUrl) =>
  html(
    `<html><body><h3>GDFlix</h3><a href="${instantUrl}">Download</a>` +
      `<span>https://instant.busycdn.xyz/${instantUrl.split('/').pop()}::hash?bytes=112401539</span></body></html>`
  );

function makeFetch(routes) {
  return async (url) => {
    const href = String(url);
    const route = routes.find((entry) => entry.match(href));
    if (!route) return new Response('not found', { status: 404 });
    return route.handler(href);
  };
}

async function runAsyncChecks() {
  const resolver = require('../src/services/resolver');
  const config = require('../src/config');

  // Kill switch: no network is touched when the source is disabled.
  const original = config.animedrive.enabled;
  config.animedrive.enabled = false;
  try {
    const disabled = await resolver.resolveAnimeDriveSource({ title: 'Blue Box', type: 'tv', season: 2, episode: 1 });
    assert.strictEqual(disabled.reason, 'source_disabled');
    passed += 1;
    console.log('  ✓ resolveAnimeDriveSource honours ANIMEDRIVE_ENABLED=false');
  } finally {
    config.animedrive.enabled = original;
  }

  // Non-animation titles short-circuit before any fetch.
  const notAnime = await resolver.resolveAnimeDriveSource({
    title: 'Jawan',
    type: 'movie',
    genres: ['Action', 'Thriller']
  });
  assert.strictEqual(notAnime.reason, 'not_anime');
  passed += 1;
  console.log('  ✓ non-animation metadata short-circuits with not_anime (no fetch)');

  // Scenario A: HubCloud unrolls, GDFlix is down → primary is the HubCloud file.
  const originalFetch = global.fetch;
  const directFor = (fileId) => `https://cdn.example/${fileId}.mkv`;
  global.fetch = makeFetch([
    { match: (u) => u.includes('animedrive.cc/?s='), handler: () => html(SEARCH_HTML) },
    { match: (u) => u.includes('blue-box-season-2-hindi-download/') && !u.includes('link.'), handler: () => html(POST_HTML) },
    { match: (u) => u.includes('blue-box-2026-s02-hindi-download'), handler: () => html(LANDING_HTML) },
    {
      match: (u) => u.includes('hubcloud.ist/drive/ep1hcl'),
      handler: (u) => {
        const id = u.split('/drive/')[1].split(/[?#]/)[0];
        return html(`<html><body><h1>Generating Download Link</h1><a id="download" href="${directFor(id)}">Download Here</a></body></html>`);
      }
    },
    { match: (u) => u.includes('hubcloud.ist/drive/'), handler: () => maintenance() },
    { match: (u) => u.includes('gdflix.dev/file/'), handler: () => maintenance() },
    {
      match: (u) => u.startsWith('https://cdn.example/'),
      handler: () => new Response(MKV_BYTES, { status: 200, headers: { 'content-type': 'video/x-matroska' } })
    }
  ]);
  try {
    const resolved = await resolver.resolveAnimeDriveSource({
      title: 'Blue Box',
      type: 'tv',
      season: 2,
      episode: 1,
      releaseYear: 2026,
      genres: ['Animation']
    });
    assert.ok(resolved && resolved.streamUrl, `expected a stream payload, got ${JSON.stringify(resolved)}`);
    assert.strictEqual(resolved.server, 'centaurus');
    assert.strictEqual(resolved.centaurusSource, 'animedrive');
    assert.strictEqual(resolved.rawUrl, directFor('ep1hcl720'));
    assert.strictEqual(resolved.audioTracks[0].lang, 'hi');
    assert.strictEqual(resolved.audioTracks[0].default, true);
    assert.ok(!resolved.qualities.some((quality) => /x265/i.test(quality.label)), 'x265 rows must not win');
    assert.ok(resolved.animedriveDiag.includes('post:Blue Box Season 2'), resolved.animedriveDiag);
    passed += 1;
    console.log('  ✓ HubCloud wins when GDFlix is down (rows ranked x264-first, probed live-file)');
  } finally {
    global.fetch = originalFetch;
  }

  // Scenario B: HubCloud is dead → each row falls through to its GDFlix twin.
  const gdflixInstant = (url) => {
    const id = url.split('/file/')[1].split(/[?#]/)[0];
    return `https://instant.busycdn.xyz/${id}::hash?bytes=112401539`;
  };
  global.fetch = makeFetch([
    { match: (u) => u.includes('animedrive.cc/?s='), handler: () => html(SEARCH_HTML) },
    { match: (u) => u.includes('blue-box-season-2-hindi-download/') && !u.includes('link.'), handler: () => html(POST_HTML) },
    { match: (u) => u.includes('blue-box-2026-s02-hindi-download'), handler: () => html(LANDING_HTML) },
    { match: (u) => u.includes('hubcloud.ist/drive/'), handler: () => maintenance() },
    {
      match: (u) => u.includes('gdflix.dev/file/'),
      handler: (u) => gdflixPage(gdflixInstant(u))
    },
    {
      match: (u) => u.includes('instant.busycdn.xyz'),
      handler: (u) => {
        const fileId = new URL(u).pathname.replace(/^\//, '').split('::')[0] || 'file';
        return new Response(null, {
          status: 302,
          headers: { location: `https://dl.busycdn.xyz/go?url=${encodeURIComponent(directFor(fileId))}` }
        });
      }
    },
    {
      match: (u) => u.startsWith('https://cdn.example/') || u.includes('light.indexserver.site'),
      handler: () => new Response(MKV_BYTES, { status: 200, headers: { 'content-type': 'video/x-matroska' } })
    }
  ]);
  try {
    const resolved = await resolver.resolveAnimeDriveSource({
      title: 'Blue Box',
      type: 'tv',
      season: 2,
      episode: 1,
      releaseYear: 2026,
      genres: ['Animation']
    });
    assert.ok(resolved && resolved.streamUrl, `expected a stream payload, got ${JSON.stringify(resolved)}`);
    assert.strictEqual(resolved.rawUrl, directFor('ep1gdf1080'));
    assert.deepStrictEqual(
      resolved.qualities.map((quality) => quality.height).sort((a, b) => b - a),
      [1080, 720, 480]
    );
    passed += 1;
    console.log('  ✓ GDFlix fallback resolves when HubCloud is down (302 unwrap → probe)');
  } finally {
    global.fetch = originalFetch;
  }

  // Pinned-source requests must not waterfall into the other sources.
  // Every host answers 404 so the assertion is deterministic and hermetic.
  global.fetch = async () => new Response('not found', { status: 404 });
  let only;
  try {
    only = await resolver.resolveCentaurusServer(
      { title: 'Blue Box', type: 'tv', season: 2, episode: 1, genres: ['Animation'] },
      { onlySource: 'animedrive' }
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.ok(only.reason, 'expected a failure reason (network mocked off)');
  assert.ok(
    Array.isArray(only.centaurusSources) && only.centaurusSources.length === 1 && only.centaurusSources[0].source === 'animedrive',
    `expected a single pinned attempt, got ${JSON.stringify(only.centaurusSources)}`
  );
  passed += 1;
  console.log('  ✓ onlySource=animedrive pins the third source (no HiCine waterfall)');

  console.log(`\n${passed} AnimeDrive checks passed.`);
}

runAsyncChecks().catch((error) => {
  console.error('  ✗ resolver guards');
  console.error(error);
  process.exit(1);
});
