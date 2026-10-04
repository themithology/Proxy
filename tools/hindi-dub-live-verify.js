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
      rejected: (p.identity?.rejectedCandidates || []).slice(0, 4),
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
