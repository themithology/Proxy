#!/usr/bin/env node
/**
 * Round 2 of the Hindi-dub accuracy research.
 *
 * Round 1 findings (diagnostics/hindi-dub-research.json):
 *  - CastleTV search for "Fight Club" returns the 2023 Indian film FIRST
 *    (id 7292504997497856, tracks: Hindi/Tamil/Telugu/Malayalam/Kannada) and the
 *    1999 film SECOND (id 7269776931136512, English only) -> first-row match is
 *    the reported bug.
 *  - CastleTV has no TMDB/IMDb lookup endpoint and no id fields on rows; it does
 *    expose publishTime / movieType / countries / tags / languages on rows.
 *  - Every Moviebox host failed the signed search probe from CI.
 *
 * Round 2 therefore:
 *  A. Dumps Raw CastleTV rows for same-name collisions across movie/TV/anime.
 *  B. Verifies CastleTV per-language track playability (does Hindi really play?).
 *  C. Diagnoses Moviebox host-by-host: status codes, alternate signing keys,
 *     v4 identity headers, GET/POST search endpoints, web player domains.
 *  D. Checks the TMDB-native tiers we already have (NetMirror embed-tmdb,
 *     MoviesDrive IMDb search) so the Hindi plan can lean on id-native paths.
 *
 *   node tools/hindi-dub-research2.js [--out <file>] [--section castle,moviebox,netmirror,idnative]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx !== -1 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : null;
const secIdx = process.argv.indexOf('--section');
const SECTIONS = (secIdx !== -1 && process.argv[secIdx + 1] ? process.argv[secIdx + 1] : 'castle,moviebox,netmirror,idnative')
  .split(',')
  .map((s) => s.trim());

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_KEY = process.env.TMDB_API_KEY || '47a1a7df542d3d483227f758a7317dff';

const CASTLE_BASE = process.env.CASTLETV_BASE_URL || 'https://api.hlowb.com';
const CASTLE_PKG = 'com.external.castle';
const CASTLE_CHANNEL = 'IndiaA';
const CASTLE_APK_SIGN = 'ED0955EB04E67A1D9F3305B95454FED485261475';

const MBOX_HOSTS = (
  process.env.MOVIEBOX_HOSTS ||
  'https://api.inmoviebox.com,https://api6.aoneroom.com,https://api5.aoneroom.com,https://api3.aoneroom.com,https://h5-api.aoneroom.com,https://api.aoneroom.com'
)
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const MBOX_KEYS = [
  process.env.MOVIEBOX_KEY_B64_OVERRIDE || 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==',
  'WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ=='
];

const report = { startedAt: new Date().toISOString(), sections: SECTIONS, castle: {}, moviebox: {}, netmirror: {}, idnative: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (s, n = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

/* -------------------------------------------------------------- fetch util */

async function req(url, options = {}, timeoutMs = 20000) {
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
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message), text: '', json: null };
  } finally {
    clearTimeout(t);
  }
}

/* -------------------------------------------------------------- CastleTV */

function castleKeyFrom(securityKeyB64) {
  let km = Buffer.from(String(securityKeyB64 || ''), 'base64');
  km = Buffer.concat([km, Buffer.from('T!BgJB', 'utf8')]);
  if (km.length > 16) km = km.subarray(0, 16);
  else if (km.length < 16) km = Buffer.concat([km, Buffer.alloc(16 - km.length, 0)]);
  return km;
}

function castleDecrypt(dataB64, key) {
  const raw = Buffer.from(String(dataB64 || '').trim(), 'base64');
  const d = crypto.createDecipheriv('aes-128-cbc', key, key);
  d.setAutoPadding(true);
  const out = Buffer.concat([d.update(raw), d.final()]).toString('utf8');
  return out.replace(/([:{[,]\s*)(\d{16,})/g, '$1"$2"');
}

let castleKey = null;
async function castleSecurityKey() {
  if (castleKey) return castleKey;
  const res = await req(`${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CHANNEL}&clientType=1&lang=en`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  });
  if (!res.json?.data) throw new Error(`castle key HTTP ${res.status}`);
  castleKey = castleKeyFrom(res.json.data);
  return castleKey;
}

async function castleSearch(keyword, size = 30) {
  const key = await castleSecurityKey();
  const params = new URLSearchParams({
    channel: CASTLE_CHANNEL,
    clientType: '1',
    keyword,
    lang: 'en',
    mode: '1',
    packageName: CASTLE_PKG,
    page: '1',
    size: String(size)
  });
  const res = await req(`${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${CASTLE_BASE}/` }
  });
  if (!res.ok || !res.text) return { keyword, status: res.status, error: res.error || 'empty' };
  try {
    const json = JSON.parse(castleDecrypt(res.text, key));
    return { keyword, status: res.status, total: (json?.data?.rows || []).length, rows: json?.data?.rows || [] };
  } catch (err) {
    return { keyword, status: res.status, decryptError: err.message };
  }
}

async function castleDetails(movieId) {
  const key = await castleSecurityKey();
  const res = await req(
    `${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CASTLE_CHANNEL}&clientType=1&lang=en&movieId=${movieId}&packageName=${CASTLE_PKG}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${CASTLE_BASE}/` } }
  );
  if (!res.ok || !res.text) return { status: res.status, error: res.error || 'empty' };
  try {
    return { status: res.status, data: JSON.parse(castleDecrypt(res.text, key))?.data || {} };
  } catch (err) {
    return { status: res.status, decryptError: err.message };
  }
}

async function castleGetVideo(movieId, episodeId, languageId, resolution) {
  const key = await castleSecurityKey();
  const body = {
    mode: '1',
    appMarket: 'GuanWang',
    clientType: '1',
    woolUser: 'false',
    apkSignKey: CASTLE_APK_SIGN,
    androidVersion: '13',
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: 'true',
    resolution: String(resolution),
    packageName: CASTLE_PKG
  };
  if (languageId != null) body.languageId = String(languageId);
  const res = await req(
    `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=${CASTLE_PKG}&channel=${CASTLE_CHANNEL}&lang=en`,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', Referer: `${CASTLE_BASE}/` },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok || !res.text) return { status: res.status, error: res.error || 'empty' };
  try {
    const json = JSON.parse(castleDecrypt(res.text, key));
    const d = json?.data || {};
    return {
      status: res.status,
      code: json?.code,
      videoUrl: clamp(d.videoUrl, 160),
      videos: (d.videos || []).map((v) => ({ url: clamp(v.url, 120), resolution: v.resolution, desc: v.resolutionDescription, size: v.size })),
      subtitles: (d.subtitles || []).map((s) => ({ lang: s.abbreviate || s.title, url: clamp(s.url, 80) }))
    };
  } catch (err) {
    return { status: res.status, decryptError: err.message };
  }
}

/* -------------------------------------------------------------- Moviebox */

function mboxSecretFrom(keyB64) {
  try {
    return Buffer.from(Buffer.from(keyB64, 'base64').toString('utf8'), 'base64');
  } catch {
    return Buffer.from(keyB64, 'base64');
  }
}

function mboxHeaders(method, urlStr, bodyStr, keyB64, identity) {
  const secret = mboxSecretFrom(keyB64);
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

  const clients = {
    legacy: {
      pkg: 'com.community.mbox.in',
      versionName: '3.0.03.0529.03',
      versionCode: 50020042,
      ua: 'com.community.mbox.in/50020042 (Linux; U; Android 16; en_IN; SM-S918B; Build/BP22.250325.006; Cronet/133.0.6876.3)'
    },
    v4: {
      pkg: 'com.community.oneroom',
      versionName: '4.0.02',
      versionCode: 50020126,
      ua: 'com.community.oneroom/50020126 (Linux; U; Android 15; en_IN; SM-S918B; Build/BP22.250325.006; Cronet/133.0.6876.3)'
    }
  }[identity || 'legacy'];

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-client-token': token,
    'x-tr-signature': sig,
    'User-Agent': clients.ua,
    'x-client-info': JSON.stringify({
      package_name: clients.pkg,
      version_name: clients.versionName,
      version_code: clients.versionCode,
      os: 'android',
      os_version: '16',
      device_id: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
      system_language: 'en',
      region: 'IN'
    }),
    'x-client-status': '0'
  };
  if (identity === 'v4') {
    headers['X-M-Version'] = '4.0.02';
    headers['x-app-package'] = clients.pkg;
  }
  return headers;
}

function mboxSubjects(json) {
  const out = [];
  (json?.data?.results || []).forEach((g) => (g.subjects || []).forEach((s) => out.push(s)));
  if (!out.length && Array.isArray(json?.data?.subjects)) out.push(...json.data.subjects);
  return out;
}

async function mboxDiag(keyB64, identity, label) {
  const results = [];
  for (const host of MBOX_HOSTS) {
    const body = JSON.stringify({ page: 1, perPage: 20, keyword: 'Fight Club', restrictKid: 1 });
    const url = `${host}/wefeed-mobile-bff/subject-api/search/v2`;
    const res = await req(url, { method: 'POST', headers: mboxHeaders('POST', url, body, keyB64, identity), body }, 15000);
    results.push({
      host,
      status: res.status,
      err: res.error || null,
      code: res.json?.code ?? null,
      subjects: mboxSubjects(res.json).length,
      sample: res.json ? clamp(JSON.stringify(res.json), 200) : clamp(res.text, 200)
    });
    await sleep(200);
  }
  return { label, results };
}

/* -------------------------------------------------------------- NetMirror */

async function probeNetmirror(tmdbId, type, season, episode) {
  const out = {};
  // 1. Legacy TMDB-embed endpoint on the configured web mirror.
  const bases = ['https://net52.cc', 'https://net77.cc'];
  for (const base of bases) {
    const url =
      type === 'tv'
        ? `${base}/api/embed-tmdb/${tmdbId}?type=tv&se=${season}&ep=${episode}`
        : `${base}/api/embed-tmdb/${tmdbId}`;
    const res = await req(url, { headers: { Accept: 'application/json, text/plain, */*', Referer: `${base}/`, 'User-Agent': UA } }, 15000);
    out[base] = {
      status: res.status,
      ok: res.ok,
      sample: res.json ? clamp(JSON.stringify(res.json), 400) : clamp(res.text, 400)
    };
  }
  return out;
}

/* ------------------------------------------------------- id-native tiers */

async function probe4khdhub(imdbId, title) {
  const hosts = [
    'https://4khdhub.one',
    'https://4khdhub.link',
    'https://4khdhub.fans',
    'https://4khdhub.ink',
    'https://4khdhub.click'
  ];
  const out = [];
  for (const host of hosts) {
    const res = await req(`${host}/?s=${encodeURIComponent(title)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' }
    }, 15000);
    out.push({ host, status: res.status, len: res.text.length, hasImdb: res.text.includes('imdb'), sample: clamp(res.text, 120) });
    await sleep(150);
  }
  return out;
}

async function probeMoviesdrive(imdbId) {
  const hosts = [
    'https://new5.moviesdrive.christmas',
    'https://new4.moviesdrive.christmas',
    'https://moviesdrive.world'
  ];
  const out = [];
  for (const host of hosts) {
    const res = await req(`${host}/search.php?q=${encodeURIComponent(imdbId)}&page=1`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }
    }, 15000);
    let hits = null;
    try {
      const j = res.json || JSON.parse(res.text);
      hits = j?.hits?.length ?? j?.found ?? null;
    } catch {
      /* ignore */
    }
    out.push({ host, status: res.status, hits, sample: clamp(res.text, 240) });
    await sleep(150);
  }
  return out;
}

/* -------------------------------------------------------------------- main */

const TITLES = [
  { type: 'movie', id: 550, note: 'Fight Club 1999 vs 2023 Indian film' },
  { type: 'movie', id: 693134, note: 'Dune: Part Two vs Dune 1984/2021' },
  { type: 'movie', id: 420818, note: 'The Lion King 2019 vs 1994' },
  { type: 'tv', id: 1396, note: 'Breaking Bad' },
  { type: 'tv', id: 94605, note: 'Arcane' },
  { type: 'movie', id: 20453, note: '3 Idiots (Hindi native)' },
  { type: 'tv', id: 85937, note: 'Demon Slayer (anime dub)' }
];

async function tmdbDetails(type, id, extra = '') {
  const res = await req(
    `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&append_to_response=external_ids${extra}&language=en-US`,
    { headers: { Accept: 'application/json', 'User-Agent': UA } }
  );
  const d = res.json || {};
  return {
    tmdbId: id,
    type,
    title: d.title || d.name,
    originalTitle: d.original_title || d.original_name,
    year: Number(String(d.release_date || d.first_air_date || '').slice(0, 4)) || null,
    runtime: d.runtime || (d.episode_run_time || [])[0] || null,
    genres: (d.genres || []).map((g) => g.name),
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    countries: d.production_countries?.map((c) => c.iso_3166_1) || [],
    originCountry: d.origin_country || []
  };
}

async function main() {
  const meta = {};
  for (const t of TITLES) {
    try {
      meta[`${t.type}/${t.id}`] = { ...(await tmdbDetails(t.type, t.id)), note: t.note };
    } catch (err) {
      meta[`${t.type}/${t.id}`] = { error: err.message };
    }
    await sleep(100);
  }
  report.tmdb = meta;

  if (SECTIONS.includes('castle')) {
    report.castle.collisions = {};
    try {
      await castleSecurityKey();
      for (const t of TITLES) {
        const md = meta[`${t.type}/${t.id}`];
        if (!md?.title) continue;
        const s = await castleSearch(md.title);
        const rows = (s.rows || []).map((r) => ({
          id: r.id || r.redirectId || r.redirectIdStr,
          title: r.title || r.name,
          year: r.publishTime ? new Date(Number(r.publishTime)).getUTCFullYear() : null,
          publishTime: r.publishTime,
          movieType: r.movieType,
          movieTypeName: r.movieTypeName,
          area: r.area,
          countries: r.countries,
          tags: r.tags,
          rating: r.rating,
          score: r.score,
          languages: r.languages,
          seasonDescription: r.seasonDescription,
          lastEpisodeCount: r.lastEpisodeCount,
          brief: clamp(r.briefIntroduction, 160)
        }));
        report.castle.collisions[`${t.type}/${t.id}`] = { tmdb: md, searchTotal: s.total || 0, rows };
        await sleep(250);
      }

      // Per-language playback verification for the Fight Club collision.
      const fc = report.castle.collisions['movie/550'];
      const candidates = (fc?.rows || []).filter((r) => /^fight club$/i.test(String(r.title || '').trim())).slice(0, 2);
      report.castle.fightClubPlayback = [];
      for (const c of candidates) {
        const det = await castleDetails(c.id);
        const ep = (det.data?.episodes || [])[0];
        if (!ep) {
          report.castle.fightClubPlayback.push({ id: c.id, title: c.title, error: 'no episode' });
          continue;
        }
        const tracks = (ep.tracks || []).map((t) => ({
          languageId: t.languageId,
          languageName: t.languageName,
          abbreviate: t.abbreviate,
          existIndividualVideo: t.existIndividualVideo
        }));
        const tries = [];
        for (const t of tracks.slice(0, 6)) {
          const video = await castleGetVideo(c.id, ep.id, t.languageId, 3);
          tries.push({ languageName: t.languageName, languageId: t.languageId, ...video });
          await sleep(200);
        }
        report.castle.fightClubPlayback.push({ id: c.id, title: c.title, episodeId: ep.id, tracks, tries });
        await sleep(200);
      }
    } catch (err) {
      report.castle.error = err.message;
    }
  }

  if (SECTIONS.includes('moviebox')) {
    report.moviebox.diagnostics = [];
    try {
      for (const keyB64 of MBOX_KEYS) {
        for (const identity of ['legacy', 'v4']) {
          report.moviebox.diagnostics.push(await mboxDiag(keyB64, identity, `${identity}/${keyB64.slice(0, 8)}`));
        }
      }
      // Best host from any variant -> try search endpoints and detail flow.
      const best = report.moviebox.diagnostics
        .flatMap((d) => d.results.map((r) => ({ ...r, label: d.label })))
        .find((r) => r.subjects > 0);
      report.moviebox.bestHost = best || null;
      if (best) {
        const host = best.host;
        const keyB64 = MBOX_KEYS[report.moviebox.diagnostics.findIndex((d) => d.label.split('/')[1] === best.label.split('/')[1])] || MBOX_KEYS[0];
        const identity = best.label.split('/')[0];
        const variants = [];
        for (const [label, path, method, body] of [
          ['POST search/v2 (type 0)', '/wefeed-mobile-bff/subject-api/search/v2', 'POST', JSON.stringify({ page: 1, perPage: 20, keyword: 'Fight Club', restrictKid: 1, type: 0 })],
          ['POST search', '/wefeed-mobile-bff/subject-api/search', 'POST', JSON.stringify({ keyword: 'Fight Club', type: 0, page: 1, pageSize: 20 })],
          ['POST search/v2 (page1)', '/wefeed-mobile-bff/subject-api/search/v2', 'POST', JSON.stringify({ page: 1, perPage: 20, keyword: 'Fight Club' })],
          ['POST search/v2 imdb', '/wefeed-mobile-bff/subject-api/search/v2', 'POST', JSON.stringify({ page: 1, perPage: 20, keyword: 'tt0137523' })],
          ['POST search/v2 tmdbid', '/wefeed-mobile-bff/subject-api/search/v2', 'POST', JSON.stringify({ page: 1, perPage: 20, keyword: '550' })]
        ]) {
          const url = `${host}${path}`;
          const res = await req(url, { method, headers: mboxHeaders(method, url, body, keyB64, identity), body }, 15000);
          variants.push({
            label,
            status: res.status,
            subjects: mboxSubjects(res.json).length,
            sample: res.json ? clamp(JSON.stringify(res.json.data || res.json), 400) : clamp(res.text, 300)
          });
          await sleep(250);
        }
        report.moviebox.searchVariants = variants;

        // Details + dubs for the first few Fight Club candidates.
        const subj = [];
        // (searchVariants results only give counts; re-run the classic query to capture subjects)
        const url = `${host}/wefeed-mobile-bff/subject-api/search/v2`;
        const body = JSON.stringify({ page: 1, perPage: 20, keyword: 'Fight Club', restrictKid: 1 });
        const res = await req(url, { method: 'POST', headers: mboxHeaders('POST', url, body, keyB64, identity), body }, 15000);
        for (const s of mboxSubjects(res.json).slice(0, 6)) {
          subj.push({
            subjectId: s.subjectId,
            title: s.title,
            subjectType: s.subjectType,
            year: s.year || Number(String(s.releaseDate || '').slice(0, 4)) || null,
            releaseDate: s.releaseDate,
            duration: s.duration,
            country: s.country || s.countryName,
            keys: Object.keys(s)
          });
        }
        report.moviebox.subjects = subj;
        report.moviebox.details = [];
        for (const s of subj.slice(0, 3)) {
          const dres = await req(`${host}/wefeed-mobile-bff/subject-api/get?subjectId=${s.subjectId}`, {
            method: 'GET',
            headers: mboxHeaders('GET', `${host}/wefeed-mobile-bff/subject-api/get?subjectId=${s.subjectId}`, null, keyB64, identity)
          }, 15000);
          const d = dres.json?.data || {};
          report.moviebox.details.push({
            subjectId: s.subjectId,
            status: dres.status,
            title: d.title,
            year: d.year || Number(String(d.releaseDate || '').slice(0, 4)) || null,
            duration: d.duration,
            dubs: (d.dubs || []).map((x) => ({ id: x.subjectId, lan: x.lanName || x.lan })),
            resourceDetectors: (d.resourceDetectors || []).map((x) => ({ id: x.resourceId, name: x.name })),
            keys: Object.keys(d).slice(0, 50)
          });
          await sleep(250);
        }
      }
    } catch (err) {
      report.moviebox.error = err.message;
    }
  }

  if (SECTIONS.includes('netmirror')) {
    try {
      report.netmirror = {
        movie550: await probeNetmirror(550, 'movie'),
        tv1396: await probeNetmirror(1396, 'tv', 1, 1)
      };
    } catch (err) {
      report.netmirror.error = err.message;
    }
  }

  if (SECTIONS.includes('idnative')) {
    try {
      report.idnative = {
        moviesdrive_imdb: await probeMoviesdrive('tt0137523'),
        fourkhdhub: await probe4khdhub('tt0137523', 'Fight Club 1999')
      };
    } catch (err) {
      report.idnative.error = err.message;
    }
  }

  report.finishedAt = new Date().toISOString();

  const outFile = OUT || path.join(process.cwd(), 'diagnostics', 'hindi-dub-research2.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`report written: ${outFile}\n`);

  console.log('=== CastleTV same-name collisions ===');
  for (const [k, v] of Object.entries(report.castle.collisions || {})) {
    console.log(`\n${k} tmdb="${v.tmdb?.title}" (${v.tmdb?.year}) total=${v.searchTotal}`);
    for (const r of (v.rows || []).slice(0, 8)) {
      console.log(`  id=${r.id} "${r.title}" year=${r.year} type=${r.movieType}/${r.movieTypeName} area=${r.area} langs=${JSON.stringify(r.languages)} tags=${JSON.stringify(r.tags)}`);
    }
  }
  console.log('\n=== CastleTV Fight Club playback proof ===');
  for (const c of report.castle.fightClubPlayback || []) {
    console.log(`  id=${c.id} "${c.title}" tracks=${(c.tracks || []).map((t) => t.languageName).join('/')}`);
    for (const t of c.tries || []) console.log(`    ${t.languageName}: status=${t.status} url=${t.videoUrl || t.error || t.decryptError || '-'}`);
  }
  console.log('\n=== Moviebox host diagnostics ===');
  for (const d of report.moviebox.diagnostics || []) {
    for (const r of d.results) console.log(`  [${d.label}] ${r.host} status=${r.status} code=${r.code} subjects=${r.subjects} err=${r.err || ''} ${r.status !== 200 ? clamp(r.sample, 120) : ''}`);
  }
  console.log('\n=== Moviebox search variants ===');
  for (const v of report.moviebox.searchVariants || []) console.log(`  ${v.label}: status=${v.status} subjects=${v.subjects} ${clamp(v.sample, 150)}`);
  console.log('\n=== Moviebox subjects ===');
  for (const s of report.moviebox.subjects || []) console.log(`  id=${s.subjectId} "${s.title}" type=${s.subjectType} year=${s.year} dur=${s.duration} country=${s.country}`);
  console.log('\n=== NetMirror ===');
  console.log(JSON.stringify(report.netmirror).slice(0, 1200));
  console.log('\n=== id-native tiers ===');
  console.log(JSON.stringify(report.idnative).slice(0, 1200));
}

main().catch((err) => {
  console.error('research2 failed:', err);
  process.exitCode = 1;
});
