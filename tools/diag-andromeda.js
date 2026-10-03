#!/usr/bin/env node
/**
 * Andromeda (Server #1) end-to-end diagnostic.
 *
 * Runs the REAL production resolver (`src/services/resolver.js` ->
 * `resolveVidstuckServer(metadata, 'andromeda')`) under a fetch interceptor that
 * logs every upstream request/response, then smoke-tests the resolved stream URL
 * (direct + through the deployed Worker proxy when DIAG_WORKER_ORIGIN is set).
 *
 * It needs no external dependencies, so it runs anywhere Node 18+ runs.
 *
 *   node tools/diag-andromeda.js [type] [tmdbId] [season] [episode]
 *   DIAG_WORKER_ORIGIN=https://proxy.example.workers.dev node tools/diag-andromeda.js movie 550
 */

const realFetch = globalThis.fetch;

const TYPE = (process.argv[2] || 'movie').toLowerCase();
const TMDB_ID = process.argv[3] || '550';
const SEASON = parseInt(process.argv[4] || '1', 10);
const EPISODE = parseInt(process.argv[5] || '1', 10);

const WORKER_ORIGIN = (process.env.DIAG_WORKER_ORIGIN || '').replace(/\/$/, '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const trace = [];
let stepNo = 0;

function label(url = '') {
  if (/\/backend\/meow/.test(url)) return 'POST /backend/meow  (session token)';
  if (/\/backend\/tmdb\/details/.test(url)) return 'GET  /backend/tmdb/details  (title/year/imdb)';
  if (/\/backend\/servers\//.test(url)) return 'GET  /backend/servers/:id  (encrypted link)';
  if (/zxcstream\.icu\/movie/.test(url)) return 'GET  zxcstream.icu/movie  (cookie warm-up)';
  if (/vidstuck\.xyz\/embed\//.test(url)) return 'GET  vidstuck.xyz/embed/...  (cookie warm-up)';
  if (/api\.themoviedb\.org/.test(url)) return 'GET  TMDB API';
  if (/introdb|aniskip/.test(url)) return 'GET  skip-intro segment API';
  if (/api\/proxy/.test(url)) return 'GET  worker /api/proxy';
  return 'HTTP';
}

function shortCookie(value = '') {
  return String(value)
    .split(/;\s*/)
    .map((c) => c.split('=')[0])
    .filter(Boolean)
    .join(', ');
}

function snippet(text = '', max = 500) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

globalThis.fetch = async function tracedFetch(input, init = {}) {
  const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const url = typeof input === 'string' ? input : req ? req.url : String(input);
  const method = (init.method || (req && req.method) || 'GET').toUpperCase();
  const headers = new Headers(req ? req.headers : undefined);
  new Headers(init.headers || undefined).forEach((v, k) => headers.set(k, v));
  const body = typeof init.body === 'string' ? init.body : null;

  const n = ++stepNo;
  const t0 = Date.now();
  const entry = {
    n,
    label: label(url),
    method,
    url: url.length > 260 ? `${url.slice(0, 260)}...` : url,
    requestHeaders: {
      origin: headers.get('origin') || '',
      referer: headers.get('referer') || '',
      cookieNames: shortCookie(headers.get('cookie') || ''),
      contentType: headers.get('content-type') || '',
      userAgent: (headers.get('user-agent') || '').slice(0, 40)
    },
    requestBody: body,
    status: 0,
    ms: 0,
    contentType: '',
    server: '',
    cfMitigated: '',
    setCookieNames: '',
    bodySnippet: '',
    error: ''
  };
  trace.push(entry);

  console.log(`\n--- [${n}] ${entry.label} ---`);
  console.log(`    ${method} ${entry.url}`);
  console.log(
    `    req: origin=${entry.requestHeaders.origin || '-'} referer=${entry.requestHeaders.referer || '-'} ` +
      `cookie=[${entry.requestHeaders.cookieNames || '-'}] ct=${entry.requestHeaders.contentType || '-'}`
  );
  if (body) console.log(`    body: ${body}`);

  try {
    const res = await realFetch(input, init);
    entry.status = res.status;
    entry.mediaUrl = res.url && res.url !== url ? res.url : '';
    entry.ms = Date.now() - t0;
    entry.contentType = res.headers.get('content-type') || '';
    entry.server = res.headers.get('server') || '';
    entry.cfMitigated = res.headers.get('cf-mitigated') || res.headers.get('x-frame-options') || '';
    const sc =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    entry.setCookieNames = sc.map((c) => String(c).split('=')[0]).join(', ');

    console.log(
      `    res: HTTP ${entry.status}  ${entry.ms}ms  ct=${entry.contentType || '-'}  ` +
        `server=${entry.server || '-'}  set-cookie=[${entry.setCookieNames || '-'}]` +
        (entry.cfMitigated ? `  cf-mitigated=${entry.cfMitigated}` : '') +
        (entry.mediaUrl ? `\n    -> redirected: ${entry.mediaUrl.slice(0, 220)}` : '')
    );

    const len = parseInt(res.headers.get('content-length') || '0', 10);
    const skipBody = /video\/|octet-stream|image\//i.test(entry.contentType) || len > 400000;
    if (!skipBody && res.body) {
      try {
        const text = await res.clone().text();
        entry.bodySnippet = snippet(text);
        console.log(`    body: ${entry.bodySnippet}`);
      } catch (e) {
        console.log(`    body: <unreadable: ${e.message}>`);
      }
    } else if (skipBody) {
      console.log(`    body: <skipped ${entry.contentType} ${len || '?'} bytes>`);
    }
    return res;
  } catch (err) {
    entry.ms = Date.now() - t0;
    entry.error = `${err.name}: ${err.message}` + (err.cause ? ` (cause: ${err.cause.message || err.cause})` : '');
    console.log(`    ERROR: ${entry.error}`);
    throw err;
  }
};

async function smokeTest(targetUrl, headers, tag) {
  const n = ++stepNo;
  const t0 = Date.now();
  console.log(`\n=== SMOKE TEST [${n}] ${tag} ===`);
  console.log(`    URL: ${targetUrl.slice(0, 260)}`);
  try {
    const res = await realFetch(targetUrl, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'follow'
    });
    const ms = Date.now() - t0;
    const ct = res.headers.get('content-type') || '';
    let head = '';
    try {
      const buf = Buffer.from(await res.arrayBuffer());
      head = snippet(buf.subarray(0, 600).toString('utf8'), 400);
      const looksM3u8 = head.startsWith('#EXTM3U');
      const looksMpd = head.includes('<MPD');
      console.log(
        `    HTTP ${res.status}  ${ms}ms  ct=${ct}  bytes=${buf.length}  ` +
          `hls=${looksM3u8} dash=${looksMpd}`
      );
      console.log(`    head: ${head}`);
      return { ok: res.status >= 200 && res.status < 400, status: res.status, ms, contentType: ct, bytes: buf.length, hls: looksM3u8, dash: looksMpd, head };
    } catch (e) {
      console.log(`    HTTP ${res.status}  ${ms}ms  ct=${ct}  <body unreadable: ${e.message}>`);
      return { ok: res.status >= 200 && res.status < 400, status: res.status, ms, contentType: ct, head: '' };
    }
  } catch (err) {
    console.log(`    ERROR: ${err.name}: ${err.message}`);
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(err.message) };
  }
}

async function main() {
  console.log('==========================================================');
  console.log('  ANDROMEDA (Server #1) DIAGNOSTIC');
  console.log(`  target: ${TYPE}/${TMDB_ID}${TYPE === 'tv' ? ` S${SEASON}E${EPISODE}` : ''}`);
  console.log(`  node:   ${process.version}`);
  process.stdout.write(`  runner IP: `);
  try {
    const ip = await realFetch('https://api.ipify.org').then((r) => r.text()).catch(() => 'unknown');
    console.log(ip);
  } catch {
    console.log('unknown');
  }
  console.log('==========================================================');

  const { resolveTmdbMetadata } = require('../src/services/tmdb');
  const { resolveVidstuckServer } = require('../src/services/resolver');

  // --- Step 0: TMDB metadata ---
  let metadata = null;
  try {
    metadata = await resolveTmdbMetadata(TYPE, TMDB_ID, SEASON, EPISODE);
    console.log(
      `\nmetadata: ${metadata && metadata.title} (${metadata && metadata.releaseYear}) ` +
        `imdb=${(metadata && metadata.imdbId) || '-'} runtime=${(metadata && metadata.runtime) || '-'}`
    );
  } catch (e) {
    console.log(`\nmetadata ERROR: ${e.message}`);
  }
  if (!metadata) {
    console.log('\nFATAL: metadata resolution failed — cannot continue (TMDB unreachable?).');
  }

  // --- Step 1: the real Andromeda resolver ---
  console.log('\n\n########## RUNNING resolveVidstuckServer(metadata, "andromeda") ##########');
  let result = null;
  if (metadata) {
    try {
      result = await resolveVidstuckServer(metadata, 'andromeda');
    } catch (e) {
      console.log(`resolver threw: ${e.name}: ${e.message}`);
    }
  }
  console.log('\n########## RESULT ##########');
  console.log(result ? JSON.stringify({ ...result, rawUrl: undefined }, null, 2).slice(0, 1500) : 'null');
  if (result) {
    console.log(`rawUrl: ${result.rawUrl}`);
    console.log(`format: ${result.format}`);
  }

  // --- Step 2: smoke tests ---
  const smoke = {};
  if (result && result.rawUrl && /^https?:\/\//i.test(result.rawUrl)) {
    smoke.direct = await smokeTest(
      result.rawUrl,
      {
        Referer: result.referer || 'https://vidstuck.xyz/',
        Origin: 'https://vidstuck.xyz'
      },
      'resolved stream URL (direct from runner IP, no worker proxy)'
    );
    if (WORKER_ORIGIN) {
      smoke.throughWorker = await smokeTest(
        `${WORKER_ORIGIN}${result.streamUrl}`,
        {},
        'resolved stream URL through the LIVE deployed worker /api/proxy'
      );
      smoke.workerResolve = await smokeTest(
        `${WORKER_ORIGIN}/api/resolve/${TYPE}/${TMDB_ID}?server=andromeda`,
        {},
        'LIVE deployed worker /api/resolve?server=andromeda'
      );
    }
  } else if (WORKER_ORIGIN) {
    smoke.workerResolve = await smokeTest(
      `${WORKER_ORIGIN}/api/resolve/${TYPE}/${TMDB_ID}?server=andromeda`,
      {},
      'LIVE deployed worker /api/resolve?server=andromeda (local resolver failed)'
    );
  }

  console.log('\n\n===DIAG_REPORT_START===');
  console.log(
    JSON.stringify(
      {
        target: `${TYPE}/${TMDB_ID}`,
        node: process.version,
        workerOrigin: WORKER_ORIGIN || null,
        metadataOk: Boolean(metadata),
        resolved: Boolean(result && result.streamUrl),
        rawUrl: result ? result.rawUrl : null,
        format: result ? result.format : null,
        steps: trace.map((t) => ({
          n: t.n,
          label: t.label,
          status: t.status,
          ms: t.ms,
          contentType: t.contentType,
          server: t.server,
          setCookie: t.setCookieNames,
          snippet: t.bodySnippet.slice(0, 180),
          error: t.error
        })),
        smoke
      },
      null,
      2
    )
  );
  console.log('===DIAG_REPORT_END===');
}

main()
  .catch((e) => console.log(`\nFATAL: ${e && e.stack ? e.stack : e}`))
  .finally(() => {
    console.log('\n[done]');
    process.exit(0);
  });
