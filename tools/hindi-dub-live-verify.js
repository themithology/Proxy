#!/usr/bin/env node
/**
 * Live end-to-end verification of the TMDB-id keyed Hindi dub layer.
 *
 * Runs on a machine with real internet (GitHub Actions runner; this repo's
 * edit sandbox is egress-filtered). It exercises the PRODUCTION code paths:
 *
 *   buildDubCatalog()   -> /api/dubs
 *   resolveHindiServer() -> ?server=hindi (what the player calls)
 *
 * and proves, per title, that:
 *   - the upstream identity matches the TMDB title (title + year + type),
 *   - same-name collisions are rejected (the 2023 "Fight Club" for TMDB 550),
 *   - the dub inventory lists every language the verified providers offer,
 *   - the resolved stream is the verified title, with Hindi preferred.
 *
 *   node tools/hindi-dub-live-verify.js [--out diagnostics/hindi-dub-live.json] [--deep]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx !== -1 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : null;
const DEEP = process.argv.includes('--deep');

const { resolveTmdbMetadata } = require('../src/services/tmdb');
const { buildDubCatalog, resolveHindiServer } = require('../src/services/dubCatalog');

const TITLES = [
  { type: 'movie', id: 550, season: 1, episode: 1, note: 'Fight Club 1999 (the reported collision)' },
  { type: 'movie', id: 693134, season: 1, episode: 1, note: 'Dune: Part Two 2024 (Hindi dub expected)' },
  { type: 'movie', id: 20453, season: 1, episode: 1, note: '3 Idiots (Hindi native)' },
  { type: 'movie', id: 872585, season: 1, episode: 1, note: 'Oppenheimer (Hindi dub expected)' },
  { type: 'tv', id: 1396, season: 1, episode: 1, note: 'Breaking Bad (Hindi dub expected)' },
  { type: 'tv', id: 94605, season: 1, episode: 1, note: 'Arcane (anime-style multi-audio)' },
  { type: 'tv', id: 85937, season: 1, episode: 1, note: 'Demon Slayer (anime Hindi dub)' },
  { type: 'tv', id: 60625, season: 1, episode: 1, note: 'Rick and Morty (western animation)' },
  { type: 'movie', id: 129, season: 1, episode: 1, note: 'Spirited Away (anime movie)' }
];

const report = { startedAt: new Date().toISOString(), deep: DEEP, titles: {} };

function summarizeCatalog(catalog) {
  return {
    mode: catalog.mode,
    hindi: catalog.hindi,
    hindiAnySource: catalog.hindiAnySource ?? null,
    best: catalog.best
      ? {
          providerId: catalog.best.providerId,
          hindi: catalog.best.hindi,
          verified: catalog.best.verified ?? null,
          identityMethod: catalog.best.identityMethod || null
        }
      : null,
    dubs: catalog.dubs,
    providers: (catalog.providers || []).map((p) => ({
      id: p.id,
      ok: p.ok,
      hindi: p.hindi,
      verified: p.identity?.verified ?? null,
      matchedTitle: p.identity?.matchedTitle ?? null,
      matchedYear: p.identity?.matchedYear ?? null,
      upstreamId: p.identity?.upstreamId ?? null,
      reasons: p.identity?.reasons ?? null,
      rejected: (p.identity?.rejectedCandidates || []).slice(0, 6),
      languages: (p.languages || []).map((l) => `${l.code || l.label}${l.playable ? '' : '(?)'}`)
    }))
  };
}

function summarizeResolve(resolved) {
  if (!resolved) return null;
  return {
    ok: Boolean(resolved.streamUrl),
    server: resolved.server || null,
    sourceName: resolved.sourceName || null,
    providerId: resolved.providerId || null,
    hindiAvailable: resolved.hindiAvailable ?? null,
    hindiVerified: resolved.hindiVerified ?? null,
    identityMethod: resolved.identityMethod || null,
    diagMessage: resolved.diagMessage || null,
    identity: resolved.identity
      ? {
          matchedTitle: resolved.identity.matchedTitle,
          matchedYear: resolved.identity.matchedYear,
          upstreamId: resolved.identity.upstreamId,
          reasons: resolved.identity.reasons
        }
      : null,
    activeTrack: (resolved.audioTracks || []).find((t) => t.default) || null,
    audioTracks: (resolved.audioTracks || []).map((t) => ({ lang: t.lang, label: t.label, default: t.default })),
    attempts: resolved.attempts || null,
    streamHost: resolved.rawUrl ? String(resolved.rawUrl).split('/')[2] : null
  };
}

/**
 * Direct CastleTV probe used when the resolver reports a miss, so the report
 * answers "did the provider not have it, or did the identity gate reject it?".
 * Mirrors the resolver's crypto (AES-128-CBC, key = b64(seed)+"T!BgJB").
 */
const CASTLE_BASE = (process.env.CASTLETV_BASE_URL || 'https://api.hlowb.com').replace(/\/$/, '');

function castleKeyFromSeed(seedB64) {
  let km = Buffer.from(String(seedB64 || ''), 'base64');
  km = Buffer.concat([km, Buffer.from('T!BgJB', 'utf8')]);
  if (km.length > 16) km = km.subarray(0, 16);
  else if (km.length < 16) km = Buffer.concat([km, Buffer.alloc(16 - km.length, 0)]);
  return km;
}

function castleDecrypt(dataB64, key) {
  const raw = Buffer.from(String(dataB64 || '').trim(), 'base64');
  const d = crypto.createDecipheriv('aes-128-cbc', key, key);
  try {
    return Buffer.concat([d.update(raw), d.final()]).toString('utf8');
  } catch {
    const d2 = crypto.createDecipheriv('aes-128-cbc', key, key);
    d2.setAutoPadding(false);
    return Buffer.concat([d2.update(raw), d2.final()]).toString('utf8');
  }
}

async function castleKey() {
  const res = await fetch(`${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`castle key HTTP ${res.status}`);
  const json = await res.json();
  return castleKeyFromSeed(json.data);
}

async function castleSearch(keyword, key) {
  const params = new URLSearchParams({
    channel: 'IndiaA',
    clientType: '1',
    keyword,
    lang: 'en',
    mode: '1',
    packageName: 'com.external.castle',
    page: '1',
    size: '30'
  });
  const res = await fetch(`${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: `${CASTLE_BASE}/` }
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  try {
    const json = JSON.parse(castleDecrypt(await res.text(), key));
    return { rows: json?.data?.rows || [] };
  } catch (error) {
    return { error: `decrypt/parse: ${error.message}` };
  }
}

async function castleDiag(metadata, identity) {
  const out = { base: CASTLE_BASE, keywords: [], verdicts: [] };
  let key;
  try {
    key = await castleKey();
  } catch (error) {
    out.error = `security key: ${error.message}`;
    return out;
  }
  const keywords = [];
  const push = (v) => {
    const t = String(v || '').trim();
    if (t && !keywords.includes(t)) keywords.push(t);
  };
  push(metadata.releaseYear ? `${metadata.title} ${metadata.releaseYear}` : metadata.title);
  push(metadata.title);
  push(metadata.originalTitle);
  (metadata.alternativeTitles || []).slice(0, 2).forEach((t) => push(t));

  const seen = new Set();
  for (const keyword of keywords.slice(0, 4)) {
    const { rows, error } = await castleSearch(keyword, key);
    out.keywords.push({ keyword, rows: rows ? rows.length : 0, error: error || null });
    (rows || []).forEach((row) => {
      const id = String(row.id || row.redirectId || '');
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.verdicts.push({
        id,
        title: row.title || row.name,
        year: row.publishTime || row.releaseDate || null,
        movieType: row.movieType,
        movieTypeName: row.movieTypeName,
        seasonDescription: row.seasonDescription || null,
        lastEpisodeCount: row.lastEpisodeCount != null ? row.lastEpisodeCount : null,
        languages: row.languages || [],
        tags: row.tags || [],
        rating: row.rating
      });
    });
  }

  // Score every collected row with the production identity gate so the report
  // shows exactly why each candidate was accepted or rejected.
  const { pickIdentityMatch } = identity;
  const picked = pickIdentityMatch(out.verdicts, metadata, { preferredAudio: 'hi' });
  out.picked = picked.winner ? picked.winner.id : null;
  out.ranked = (picked.ranked || []).slice(0, 8);
  out.rejected = (picked.rejected || []).slice(0, 8);
  return out;
}

async function main() {
  for (const entry of TITLES) {
    const key = `${entry.type}/${entry.id}`;
    const record = { note: entry.note, tmdb: null, catalog: null, hindiServer: null, error: null };
    report.titles[key] = record;

    let metadata;
    try {
      metadata = await resolveTmdbMetadata(entry.type, entry.id, entry.season, entry.episode);
      record.tmdb = {
        title: metadata.title,
        originalTitle: metadata.originalTitle,
        year: metadata.releaseYear,
        imdbId: metadata.externalIds?.imdb_id || null,
        altTitles: (metadata.alternativeTitles || []).slice(0, 4),
        unresolved: Boolean(metadata.unresolvedTmdb)
      };
    } catch (err) {
      record.error = `tmdb: ${err.message}`;
      continue;
    }
    if (metadata.unresolvedTmdb) {
      record.error = 'tmdb metadata unresolved (no API access?)';
      continue;
    }

    try {
      const catalog = await buildDubCatalog(metadata, { deep: DEEP, preferredAudio: 'hi' });
      record.catalog = summarizeCatalog(catalog);
    } catch (err) {
      record.catalog = { error: err.message };
    }

    try {
      const resolved = await resolveHindiServer(metadata, 'hi');
      record.hindiServer = summarizeResolve(resolved);
    } catch (err) {
      record.hindiServer = { error: err.message };
    }

    const castletvFailed = !record.catalog || !(record.catalog.providers || []).some((p) => p.id === 'castletv' && p.ok);
    if (castletvFailed) {
      try {
        record.castletvDiagnostics = await castleDiag(metadata, require('../src/services/identity'));
      } catch (err) {
        record.castletvDiagnostics = { error: err.message };
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  const outFile = OUT || path.join(process.cwd(), 'diagnostics', 'hindi-dub-live.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\nreport written: ${outFile}`);
  for (const [key, record] of Object.entries(report.titles)) {
    console.log(`\n=== ${key} :: ${record.note}`);
    console.log(`  TMDB   : ${record.tmdb ? `"${record.tmdb.title}" (${record.tmdb.year})` : record.error}`);
    if (record.catalog && !record.catalog.error) {
      console.log(`  CATALOG: hindi=${record.catalog.hindi} dubs=[${(record.catalog.dubs || []).map((d) => d.label).join(', ')}]`);
      for (const p of record.catalog.providers) {
        console.log(
          `    - ${p.id}: ok=${p.ok} hindi=${p.hindi} matched=${JSON.stringify(p.matchedTitle)}@${p.matchedYear} verified=${p.verified} langs=[${p.languages.join(',')}]`
        );
        if (p.ok && p.rejected.length) {
          console.log(`      rejected: ${p.rejected.map((r) => `${JSON.stringify(r.title)}@${r.year}(${r.reason})`).join(' | ')}`);
        }
      }
    } else if (record.catalog) {
      console.log(`  CATALOG: error ${record.catalog.error}`);
    }
    const hs = record.hindiServer;
    if (hs && !hs.error) {
      console.log(
        `  HINDI  : ok=${hs.ok} source=${hs.sourceName} provider=${hs.providerId} hindiAvailable=${hs.hindiAvailable} default=${hs.activeTrack ? `${hs.activeTrack.label}(${hs.activeTrack.lang})` : '-'} host=${hs.streamHost}`
      );
      if (hs.identity) console.log(`           identity: ${JSON.stringify(hs.identity)}`);
    } else if (hs) {
      console.log(`  HINDI  : error ${hs.error}`);
    }
  }
}

main().catch((err) => {
  console.error('live verify failed:', err);
  process.exitCode = 1;
});
