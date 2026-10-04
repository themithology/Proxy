#!/usr/bin/env node
/**
 * Hindi-dub accuracy research probe.
 *
 * Why: the Andromeda Hindi tiers (CastleTV + Moviebox) currently match upstream
 * titles by plain NAME. For "Fight Club" that resolves a 2023 Indian movie that
 * happens to share the title, not the 1999 film the viewer asked for
 * (TMDB id 550). This script gathers the LIVE evidence needed to design a
 * TMDB-id-anchored identity check:
 *
 *   1. Does either upstream expose TMDB/IMDb ids on search rows?
 *   2. Does either upstream accept an id as the search keyword?
 *   3. Are there id-native endpoints we never use?
 *   4. What fields exist for verification (year, type, duration, poster)?
 *   5. How many dubs/tracks does a matched title actually expose?
 *
 * Runs anywhere Node 18+ runs WITH real internet (GitHub Actions runner; the
 * sandbox this repo is edited from is egress-filtered, the CI runner is not).
 *
 *   node tools/hindi-dub-research.js [--out <file>] [--quick]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
const QUICK = process.argv.includes('--quick');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_KEY = process.env.TMDB_API_KEY || '47a1a7df542d3d483227f758a7317dff';

const CASTLE_BASE = process.env.CASTLETV_BASE_URL || 'https://api.hlowb.com';
const CASTLE_PKG = 'com.external.castle';
const CASTLE_CHANNEL = 'IndiaA';
const MBOX_HOSTS = (
  process.env.MOVIEBOX_HOSTS ||
  'https://api.inmoviebox.com,https://api6.aoneroom.com,https://api5.aoneroom.com,https://api3.aoneroom.com,https://h5-api.aoneroom.com'
)
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const report = {
  startedAt: new Date().toISOString(),
  env: { castleBase: CASTLE_BASE, movieboxHosts: MBOX_HOSTS },
  tmdb: {},
  castletv: {},
  moviebox: {},
  summary: {}
};

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { ok: res.ok, status: res.status, text, json, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message), text: '', json: null };
  } finally {
    clearTimeout(t);
  }
}

function normTitle(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(dub|dubbed|hd|4k|hindi|tamil|telugu|dual audio|multi audio)\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function yearOf(value) {
  const m = String(value == null ? '' : value).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/* ------------------------------------------------------------------- TMDB */

async function tmdbDetails(type, id) {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids,alternative_titles&language=en-US`;
  const res = await fetchJson(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.json) return null;
  const d = res.json;
  const titles = new Set(
    [
      d.title,
      d.name,
      d.original_title,
      d.original_name,
      ...(d.alternative_titles?.titles || []).map((t) => t.title)
    ].filter(Boolean)
  );
  return {
    tmdbId: Number(id),
    type,
    title: d.title || d.name,
    originalTitle: d.original_title || d.original_name,
    altTitles: [...titles],
    year: yearOf(d.release_date || d.first_air_date),
    releaseDate: d.release_date || d.first_air_date || null,
    runtime: d.runtime || (Array.isArray(d.episode_run_time) ? d.episode_run_time[0] : null) || null,
    genres: (d.genres || []).map((g) => g.name),
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    tvdbId: d.external_ids?.tvdb_id || null,
    originCountry: d.origin_country || [],
    status: d.status || null
  };
}

/* --------------------------------------------------------------- CastleTV */

function buildCastleKey(securityKeyB64) {
  let km = Buffer.from(String(securityKeyB64 || ''), 'base64');
  km = Buffer.concat([km, Buffer.from('T!BgJB', 'utf8')]);
  if (km.length > 16) km = km.subarray(0, 16);
  else if (km.length < 16) km = Buffer.concat([km, Buffer.alloc(16 - km.length, 0)]);
  return km;
}

function castleDecrypt(dataB64, key) {
  const raw = Buffer.from(String(dataB64 || '').trim(), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  decipher.setAutoPadding(true);
  const out = Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
  return out.replace(/([:{[,]\s*)(\d{16,})/g, '$1"$2"');
}

let castleKey = null;

async function castleSecurityKey() {
  if (castleKey) return castleKey;
  const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CHANNEL}&clientType=1&lang=en`;
  const res = await fetchJson(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.json?.data) throw new Error(`castle key failed: HTTP ${res.status}`);
  castleKey = buildCastleKey(res.json.data);
  return castleKey;
}

async function castleSearch(keyword) {
  const key = await castleSecurityKey();
  const params = new URLSearchParams({
    channel: CASTLE_CHANNEL,
    clientType: '1',
    keyword,
    lang: 'en',
    mode: '1',
    packageName: CASTLE_PKG,
    page: '1',
    size: '30'
  });
  const res = await fetchJson(`${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${CASTLE_BASE}/` }
  });
  if (!res.ok || !res.text) return { keyword, status: res.status, error: res.error || 'empty' };
  try {
    const json = JSON.parse(castleDecrypt(res.text, key));
    const rows = json?.data?.rows || [];
    return {
      keyword,
      status: res.status,
      code: json?.code,
      total: rows.length,
      rows: rows.slice(0, 12).map((r) => ({ ...r, __keys: Object.keys(r) })),
      rawRow0: rows[0] || null
    };
  } catch (err) {
    return { keyword, status: res.status, decryptError: String(err.message) };
  }
}

async function castleDetails(movieId) {
  const key = await castleSecurityKey();
  const url = `${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CASTLE_CHANNEL}&clientType=1&lang=en&movieId=${movieId}&packageName=${CASTLE_PKG}`;
  const res = await fetchJson(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${CASTLE_BASE}/` }
  });
  if (!res.ok || !res.text) return { status: res.status, error: res.error || 'empty' };
  try {
    const json = JSON.parse(castleDecrypt(res.text, key));
    const data = json?.data || {};
    return {
      status: res.status,
      code: json?.code,
      topKeys: Object.keys(data),
      summary: {
        title: data.title || data.name || null,
        year: data.year || data.releaseYear || yearOf(data.releaseDate || data.publishTime),
        duration: data.duration || data.durationTime || data.runtime || null,
        movieId: data.movieId || data.id || null,
        type: data.type || data.movieType || null,
        imdbId: data.imdbId || null,
        tmdbId: data.tmdbId || null,
        tagList: data.tagList || data.tags || null,
        description: String(data.description || data.introduction || '').slice(0, 200) || null,
        seasonCount: (data.seasons || []).length,
        episodeCount: (data.episodes || []).length
      },
      seasons: (data.seasons || []).slice(0, 5),
      episodeSample: (data.episodes || []).slice(0, 3).map((e) => ({
        id: e.id,
        number: e.number,
        tracks: (e.tracks || []).map((t) => ({
          languageId: t.languageId,
          languageName: t.languageName,
          abbreviate: t.abbreviate,
          existIndividualVideo: t.existIndividualVideo,
          videoCount: (t.videos || []).length
        }))
      }))
    };
  } catch (err) {
    return { status: res.status, decryptError: String(err.message) };
  }
}

async function castleProbeEndpoints(tmdbId, imdbId) {
  const key = await castleSecurityKey();
  const paths = [
    `/film-api/v1.1.0/movie/searchByKeyword?channel=${CASTLE_CHANNEL}&clientType=1&keyword=${encodeURIComponent('tmdb:' + tmdbId)}&lang=en&mode=1&packageName=${CASTLE_PKG}&page=1&size=5`,
    `/film-api/v1.1.0/movie/searchByKeyword?channel=${CASTLE_CHANNEL}&clientType=1&keyword=${imdbId}&lang=en&mode=1&packageName=${CASTLE_PKG}&page=1&size=5`,
    `/film-api/v1.1.0/movie/searchByTmdbId?channel=${CASTLE_CHANNEL}&clientType=1&tmdbId=${tmdbId}&lang=en&packageName=${CASTLE_PKG}`,
    `/film-api/v1.1.0/movie/search?channel=${CASTLE_CHANNEL}&clientType=1&tmdbId=${tmdbId}&lang=en&packageName=${CASTLE_PKG}`,
    `/film-api/v1.0.0/movie/searchByKeyword?channel=${CASTLE_CHANNEL}&clientType=1&keyword=${imdbId}&lang=en&mode=1&packageName=${CASTLE_PKG}&page=1&size=5`
  ];
  const results = [];
  for (const p of paths) {
    const res = await fetchJson(`${CASTLE_BASE}${p}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${CASTLE_BASE}/` }
    });
    let decoded = null;
    if (res.ok && res.text) {
      try {
        const json = JSON.parse(castleDecrypt(res.text, key));
        const rows = json?.data?.rows || [];
        decoded = { code: json?.code, rowCount: rows.length, firstTitle: rows[0]?.title || rows[0]?.name || null };
      } catch {
        decoded = { nonJsonCipher: true, sample: res.text.slice(0, 80) };
      }
    }
    results.push({ path: p, status: res.status, decoded });
    await sleep(150);
  }
  return results;
}

/* ---------------------------------------------------------------- Moviebox */

const MBOX_KEY_B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';

function mboxSecret() {
  try {
    return Buffer.from(Buffer.from(MBOX_KEY_B64, 'base64').toString('utf8'), 'base64');
  } catch {
    return Buffer.from(MBOX_KEY_B64, 'base64');
  }
}

function mboxHeaders(method, urlStr, bodyStr) {
  const secret = mboxSecret();
  const ts = Date.now().toString();
  const reversed = ts.split('').reverse().join('');
  const token = `${ts},${crypto.createHash('md5').update(reversed).digest('hex')}`;
  let pathOnly = urlStr;
  let query = '';
  try {
    const u = new URL(urlStr);
    pathOnly = u.pathname;
    const sortedKeys = Array.from(u.searchParams.keys()).sort();
    if (sortedKeys.length) query = sortedKeys.map((k) => `${k}=${u.searchParams.getAll(k).join('&')}`).join('&');
  } catch {
    /* noop */
  }
  const canonicalUrl = query ? `${pathOnly}?${query}` : pathOnly;
  const bodyHash = bodyStr ? crypto.createHash('md5').update(bodyStr).digest('hex') : '';
  const bodyLen = bodyStr ? Buffer.byteLength(bodyStr, 'utf8').toString() : '';
  const canonical = `${method.toUpperCase()}\napplication/json\napplication/json\n${bodyLen}\n${ts}\n${bodyHash}\n${canonicalUrl}`;
  const sig = `${ts}|2|${crypto.createHmac('md5', secret).update(canonical).digest('base64')}`;
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-client-token': token,
    'x-tr-signature': sig,
    'User-Agent':
      'com.community.mbox.in/50020042 (Linux; U; Android 16; en_IN; SM-S918B; Build/BP22.250325.006; Cronet/133.0.6876.3)',
    'x-client-info': JSON.stringify({
      package_name: 'com.community.mbox.in',
      version_name: '3.0.03.0529.03',
      version_code: 50020042
    }),
    'x-client-status': '0'
  };
}

async function mboxFetch(host, pathAndQuery, { method = 'GET', body = null, extraHeaders = {} } = {}) {
  const url = `${host}${pathAndQuery}`;
  const headers = { ...mboxHeaders(method, url, body), ...extraHeaders };
  return fetchJson(url, { method, headers, body: body || undefined });
}

async function mboxFindHost() {
  for (const host of MBOX_HOSTS) {
    const body = JSON.stringify({ page: 1, perPage: 20, keyword: 'test', restrictKid: 1 });
    const res = await mboxFetch(host, '/wefeed-mobile-bff/subject-api/search/v2', { method: 'POST', body });
    if (res.ok && res.json && (res.json.code === 0 || res.json.data)) return host;
  }
  return null;
}

function mboxSubjects(json) {
  const out = [];
  (json?.data?.results || []).forEach((group) => {
    (group.subjects || []).forEach((s) => out.push(s));
  });
  return out;
}

async function mboxSearch(host, keyword) {
  const body = JSON.stringify({ page: 1, perPage: 20, keyword, restrictKid: 1 });
  const res = await mboxFetch(host, '/wefeed-mobile-bff/subject-api/search/v2', { method: 'POST', body });
  const subjects = mboxSubjects(res.json);
  return {
    keyword,
    status: res.status,
    code: res.json?.code,
    total: subjects.length,
    subjects: subjects.slice(0, 12).map((s) => ({
      subjectId: s.subjectId,
      title: s.title,
      subjectType: s.subjectType,
      year: s.year || yearOf(s.releaseDate),
      releaseDate: s.releaseDate || null,
      duration: s.duration || null,
      imdbId: s.imdbId || s.imdb_id || null,
      tmdbId: s.tmdbId || null,
      country: s.country || s.countryName || null,
      keys: Object.keys(s).slice(0, 40)
    }))
  };
}

async function mboxDetails(host, subjectId) {
  const res = await mboxFetch(host, `/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`);
  const d = res.json?.data || {};
  return {
    status: res.status,
    code: res.json?.code,
    topKeys: Object.keys(d).slice(0, 60),
    summary: {
      title: d.title || null,
      year: d.year || yearOf(d.releaseDate),
      releaseDate: d.releaseDate || null,
      duration: d.duration || null,
      imdbId: d.imdbId || null,
      tmdbId: d.tmdbId || null,
      subjectType: d.subjectType,
      seasonCount: (d.seasons || d.resourceDetectors || []).length
    },
    dubs: (d.dubs || []).map((x) => ({ subjectId: x.subjectId, lanName: x.lanName, lan: x.lan })),
    resourceDetectors: (d.resourceDetectors || []).map((x) => ({
      resourceId: x.resourceId,
      name: x.name,
      languages: x.languages
    })),
    rawKeys: Object.keys(d)
  };
}

async function mboxPlayInfo(host, subjectId, se = 0, ep = 0) {
  const qs = `subjectId=${subjectId}&se=${se}&ep=${ep}&streamSignType=1`;
  const res = await mboxFetch(host, `/wefeed-mobile-bff/subject-api/play-info?${qs}`);
  const d = res.json?.data || {};
  const streams = d.streams || [];
  return {
    status: res.status,
    code: res.json?.code,
    streamCount: streams.length,
    streams: streams.slice(0, 3).map((s) => ({
      url: String(s.url || '').slice(0, 100),
      resolutions: s.resolutions,
      languageName: s.languageName || s.lanName || null,
      format: s.format || null
    })),
    hasNetHls: Boolean(d.netHls),
    hasNetDash: Boolean(d.netDash)
  };
}

async function mboxProbeEndpoints(host, tmdbId, imdbId) {
  const probes = [
    ['GET', `/wefeed-mobile-bff/subject-api/get-by-tmdb?tmdbId=${tmdbId}`],
    ['GET', `/wefeed-mobile-bff/subject-api/search/tmdb?tmdbId=${tmdbId}`],
    ['GET', `/wefeed-mobile-bff/subject-api/detail?tmdbId=${tmdbId}`],
    ['GET', `/wefeed-mobile-bff/subject-api/resource?tmdbId=${tmdbId}`],
    ['GET', `/wefeed-mobile-bff/subject-api/get-by-imdb?imdbId=${imdbId}`]
  ];
  const out = [];
  for (const [method, p] of probes) {
    const res = await mboxFetch(host, p, { method });
    out.push({
      path: p,
      status: res.status,
      code: res.json?.code,
      hasData: Boolean(res.json?.data),
      sample: res.json ? JSON.stringify(res.json).slice(0, 160) : res.text.slice(0, 120)
    });
    await sleep(150);
  }
  return out;
}

/* -------------------------------------------------------------------- main */

const CASTLE_KEYWORDS = (md) => [
  md.title,
  md.year ? `${md.title} ${md.year}` : null,
  md.originalTitle !== md.title ? md.originalTitle : null,
  md.imdbId,
  `tmdb:${md.tmdbId}`
].filter(Boolean);

const MBOX_KEYWORDS = (md) => [
  md.title,
  md.year ? `${md.title} ${md.year}` : null,
  md.originalTitle !== md.title ? md.originalTitle : null,
  md.imdbId,
  String(md.tmdbId)
].filter(Boolean);

const TEST_TITLES = QUICK
  ? [
      { type: 'movie', id: 550 }, // Fight Club (1999) - the reported bug
      { type: 'movie', id: 693134 } // Dune: Part Two (2024)
    ]
  : [
      { type: 'movie', id: 550 }, // Fight Club (1999) - the reported bug
      { type: 'movie', id: 27205 }, // Inception (2010)
      { type: 'movie', id: 693134 }, // Dune: Part Two (2024)
      { type: 'movie', id: 129 }, // Spirited Away (2001, anime)
      { type: 'movie', id: 20453 }, // 3 Idiots (2009, Hindi)
      { type: 'tv', id: 1396 }, // Breaking Bad
      { type: 'tv', id: 94605 }, // Arcane
      { type: 'tv', id: 85937 }, // Demon Slayer (anime)
      { type: 'tv', id: 82856 } // The Mandalorian
    ];

async function main() {
  // 1. TMDB truth for every probe title.
  for (const t of TEST_TITLES) {
    try {
      report.tmdb[`${t.type}/${t.id}`] = await tmdbDetails(t.type, t.id);
    } catch (err) {
      report.tmdb[`${t.type}/${t.id}`] = { error: String(err.message) };
    }
    await sleep(120);
  }

  const fight = report.tmdb['movie/550'];

  // 2. CastleTV keyword probes for the reported bug + one TV case.
  report.castletv.keyProbes = {};
  try {
    await castleSecurityKey();
    for (const md of [fight, report.tmdb['movie/693134'], report.tmdb['tv/1396']].filter(Boolean)) {
      const label = `${md.type}/${md.tmdbId}`;
      report.castletv.keyProbes[label] = [];
      for (const kw of CASTLE_KEYWORDS(md)) {
        report.castletv.keyProbes[label].push(await castleSearch(kw));
        await sleep(200);
      }
    }
    // 3. Id-native endpoint probes on CastleTV.
    report.castletv.idEndpointProbes = await castleProbeEndpoints(550, 'tt0137523');

    // 4. Details for the top rows of the exact-title search, to see verifiable fields.
    const fightRows = report.castletv.keyProbes['movie/550']?.[0]?.rows || [];
    report.castletv.fightClubRowDetails = [];
    for (const row of fightRows.slice(0, 4)) {
      const id = row.id || row.redirectId || row.redirectIdStr;
      if (!id) continue;
      report.castletv.fightClubRowDetails.push({ row: { id, title: row.title || row.name, keys: row.__keys }, details: await castleDetails(id) });
      await sleep(250);
    }
  } catch (err) {
    report.castletv.error = String(err.message);
  }

  // 5. Moviebox probes.
  try {
    const host = await mboxFindHost();
    report.moviebox.host = host;
    if (host) {
      report.moviebox.keyProbes = {};
      for (const md of [fight, report.tmdb['movie/693134'], report.tmdb['tv/1396']].filter(Boolean)) {
        const label = `${md.type}/${md.tmdbId}`;
        report.moviebox.keyProbes[label] = [];
        for (const kw of MBOX_KEYWORDS(md)) {
          report.moviebox.keyProbes[label].push(await mboxSearch(host, kw));
          await sleep(250);
        }
      }
      report.moviebox.idEndpointProbes = await mboxProbeEndpoints(host, 550, 'tt0137523');

      // 6. Details + dubs + play-info for every Fight Club candidate (top 5),
      //    so we can see which candidate is the 1999 film and how many dubs
      //    each candidate exposes.
      const candidates = [];
      for (const probe of report.moviebox.keyProbes['movie/550'] || []) {
        for (const s of probe.subjects || []) {
          if (!candidates.some((c) => c.subjectId === s.subjectId)) candidates.push(s);
        }
      }
      report.moviebox.fightClubCandidates = [];
      for (const c of candidates.slice(0, 5)) {
        const details = await mboxDetails(host, c.subjectId);
        const dubs = details.dubs.length ? details.dubs : [{ subjectId: c.subjectId, lanName: 'Original' }];
        const play = [];
        for (const d of dubs.slice(0, 6)) {
          play.push({ dub: d, ...(await mboxPlayInfo(host, d.subjectId || c.subjectId, 0, 0)) });
          await sleep(250);
        }
        report.moviebox.fightClubCandidates.push({ subject: c, details, play });
      }
    }
  } catch (err) {
    report.moviebox.error = String(err.message);
  }

  report.finishedAt = new Date().toISOString();

  const outFile = OUT || path.join(process.cwd(), 'diagnostics', 'hindi-dub-research.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`report written: ${outFile}`);

  // Compact stdout summary so CI logs stay readable.
  console.log('\n=== CastleTV Fight Club search rows ===');
  for (const probe of report.castletv.keyProbes?.['movie/550'] || []) {
    console.log(`\nkeyword=${JSON.stringify(probe.keyword)} total=${probe.total}`);
    for (const r of (probe.rows || []).slice(0, 5)) {
      console.log(`  id=${r.id || r.redirectId || r.redirectIdStr} title=${JSON.stringify(r.title || r.name)} fields=${JSON.stringify(r.__keys)}`);
    }
  }
  console.log('\n=== Moviebox Fight Club search rows ===');
  for (const probe of report.moviebox.keyProbes?.['movie/550'] || []) {
    console.log(`\nkeyword=${JSON.stringify(probe.keyword)} total=${probe.total}`);
    for (const s of (probe.subjects || []).slice(0, 5)) {
      console.log(`  id=${s.subjectId} title=${JSON.stringify(s.title)} type=${s.subjectType} year=${s.year} dur=${s.duration} keys=${JSON.stringify(s.keys)}`);
    }
  }
  console.log('\n=== Moviebox Fight Club candidate dubs ===');
  for (const c of report.moviebox.fightClubCandidates || []) {
    console.log(
      `  ${JSON.stringify(c.subject.title)} id=${c.subject.subjectId} year=${c.subject.year} dubs=${JSON.stringify(c.details.dubs)} streams=${c.play.map((p) => p.streamCount).join('/')}`
    );
  }
}

main().catch((err) => {
  console.error('research failed:', err);
  process.exitCode = 1;
});
