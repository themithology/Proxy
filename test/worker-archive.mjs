/**
 * Edge-worker parity test for the Archive (Internet Archive) public-domain source.
 *
 * `cloudflare-worker/worker.js` is a separate bundle from `src/`, so its copy of
 * the archive resolver can silently drift. This test imports the real worker
 * module (copied to a temporary .mjs so Node parses its ESM syntax), stubs the
 * upstream HTTP calls (TMDB + archive.org), then drives the actual
 * `/api/resolve/movie/961?server=archive` route and asserts the payload.
 *
 *   node test/worker-archive.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSource = path.join(here, '..', 'cloudflare-worker', 'worker.js');

// --- 1. Load the worker module up as ESM -----------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-archive-'));
const tmpWorker = path.join(tmpDir, 'worker.mjs');
fs.copyFileSync(workerSource, tmpWorker);
const worker = (await import(pathToFileURL(tmpWorker).href)).default;

// --- 2. Stub the upstream network ------------------------------------------
const calls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push(url);

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });

  if (url.includes('api.themoviedb.org/3/movie/961')) {
    return json({
      id: 961,
      title: 'The General',
      release_date: '1926-12-31',
      runtime: 78,
      genres: [{ id: 35, name: 'Comedy' }],
      imdb_id: 'tt0017925',
      external_ids: { imdb_id: 'tt0017925' }
    });
  }

  if (url.includes('archive.org/advancedsearch.php')) {
    return json({
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
            identifier: 'modern-copyrighted-restoration',
            title: 'The General (2026 Restoration)',
            year: '2026',
            collection: ['moviesandfilms'],
            rights: 'All rights reserved'
          }
        ]
      }
    });
  }

  if (url.includes('archive.org/metadata/the-general-1926')) {
    return json({
      metadata: {
        identifier: 'the-general-1926',
        title: 'The General',
        year: '1926',
        collection: ['publicmovies']
      },
      files: [
        { name: 'the_general_512kb.mp4', format: '512Kb MPEG4', size: '180000000' },
        { name: 'the_general.mp4', format: 'h.264', size: '900000000' },
        { name: 'the_general_files.xml', format: 'Metadata' }
      ]
    });
  }

  // Skip-intro / subtitle lookups are irrelevant here.
  if (url.includes('introdb.app') || url.includes('aniskip.com') || url.includes('opensubtitles')) {
    return json({}, 200);
  }
  if (url.includes('wyzie') || url.includes('strem.io')) return json([], 200);

  throw new Error(`unexpected upstream call: ${url}`);
};

// --- 3. Drive the real worker route ---------------------------------------
try {
  const res = await worker.fetch(
    new Request('https://edge.example.workers.dev/api/resolve/movie/961?server=archive'),
    {}
  );
  const payload = await res.json();

  assert.equal(res.status, 200, 'worker /api/resolve must answer 200');
  assert.equal(payload.ok, true, `worker resolve failed: ${JSON.stringify(payload).slice(0, 400)}`);
  assert.equal(payload.stream.server, 'archive', 'archive source must answer, not a legacy server');
  assert.equal(payload.stream.format, 'mp4');
  assert.ok(
    payload.stream.rawUrl.endsWith('/the-general-1926/the_general.mp4'),
    `best-quality derivative must be selected (got ${payload.stream.rawUrl})`
  );
  assert.equal(payload.stream.provenance.publicDomain, true, 'licence provenance must be reported');
  assert.equal(
    /public\s*domain|publicdomain/i.test(payload.stream.provenance.licence),
    true,
    `licence marker must be reported (got ${payload.stream.provenance.licence})`
  );
  assert.ok(
    payload.stream.provenance.sourcePage.includes('archive.org/details/the-general-1926'),
    'source page must be exposed for attribution'
  );
  assert.ok(
    calls.some((u) => u.includes('archive.org/advancedsearch.php')),
    'worker must query the public archive.org search API'
  );
  assert.ok(
    !calls.some((u) => u.includes('vidstuck') || u.includes('hianime') || u.includes('hicine')),
    'no legacy upstream may be contacted when the public-domain source answers'
  );

  console.log('==========================================================');
  console.log('  Edge worker — Archive (public domain) parity: PASSED');
  console.log(`  resolved: ${payload.stream.rawUrl}`);
  console.log(`  licence:  ${payload.stream.provenance.licence}`);
  console.log('==========================================================');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
