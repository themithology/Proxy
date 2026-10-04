#!/usr/bin/env node
/**
 * NetMirror live probe.
 *
 * NetMirror rotates domains and its API base is handed out by a discovery
 * endpoint (checknewtv.php -> base64 token_hash). This probe answers, from a
 * real network:
 *   1. which discovery domains still answer,
 *   2. which API base they hand out,
 *   3. which of the NewTV endpoints our resolver uses still exist,
 *   4. whether the production resolveNetmirror() resolves a title end to end.
 *
 *   node tools/netmirror-probe.js [--out diagnostics/netmirror-probe.json]
 */

const fs = require('fs');
const path = require('path');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx !== -1 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : 'diagnostics/netmirror-probe.json';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

// Web mirrors that serve /api/embed-tmdb (independent of the NewTV API base).
const WEB_MIRRORS = ['https://net27.cc', 'https://net52.cc', 'https://net77.cc', 'https://netmiror.com'];

const DISCOVERY_DOMAINS = [
  'https://net27.cc',
  'https://net52.cc',
  'https://net77.cc',
  'https://mobiledetect.app',
  'https://mobiledetects.com',
  'https://mobidetect.cc',
  'https://mobidetects.top',
  'https://getimgcdn.com',
  'https://mobidetect.art',
  'https://mobidetect.click'
];

const report = { startedAt: new Date().toISOString(), discovery: [], apiBase: null, endpoints: {}, resolver: null };

async function timedFetch(url, options = {}, timeoutMs = 12000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 0, ok: false, error: String(error.message || error), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function probeDiscovery() {
  for (const domain of DISCOVERY_DOMAINS) {
    const entry = { domain };
    const res = await timedFetch(`${domain}/checknewtv.php`, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' } });
    entry.status = res.status;
    entry.latencyMs = res.latencyMs;
    entry.error = res.error || null;
    if (res.text) {
      entry.bodySample = res.text.slice(0, 200);
      try {
        const json = JSON.parse(res.text);
        entry.token_hash = json.token_hash || null;
        if (json.token_hash) {
          const decoded = Buffer.from(json.token_hash, 'base64').toString('utf8').replace(/\/$/, '');
          entry.decoded = decoded;
          if (!report.apiBase && decoded.startsWith('http')) report.apiBase = decoded;
        }
      } catch {
        entry.parse = 'not-json';
      }
    }
    report.discovery.push(entry);
  }
}

async function probeApi(base) {
  // The three NewTV endpoints our resolver uses, plus the direct embed-tmdb API.
  const newTvHeaders = {
    'User-Agent': `${UA} /OS.GatuNewTV v1.0`,
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'NetmirrorNewTV v1.0',
    Ott: 'nf'
  };

  const search = await timedFetch(`${base}/newtv/search.php?s=${encodeURIComponent('Dune Part Two')}`, { headers: newTvHeaders });
  report.endpoints.newtvSearch = { status: search.status, latencyMs: search.latencyMs, sample: (search.text || search.error || '').slice(0, 300) };

  report.endpoints.embedMovie = await (async () => {
    const res = await timedFetch(`${base}/api/embed-tmdb/693134`, {
      headers: { Accept: 'application/json, text/plain, */*', Referer: `${base}/`, 'User-Agent': UA }
    });
    return { status: res.status, latencyMs: res.latencyMs, sample: (res.text || res.error || '').slice(0, 300) };
  })();

  report.endpoints.embedTv = await (async () => {
    const res = await timedFetch(`${base}/api/embed-tmdb/1396?type=tv&se=1&ep=1`, {
      headers: { Accept: 'application/json, text/plain, */*', Referer: `${base}/`, 'User-Agent': UA }
    });
    return { status: res.status, latencyMs: res.latencyMs, sample: (res.text || res.error || '').slice(0, 300) };
  })();

  // If search works, follow it all the way through post/player for a movie.
  try {
    const parsed = JSON.parse(report.endpoints.newtvSearch.sample);
    const first = (parsed.searchResult || [])[0];
    if (first && first.id) {
      report.endpoints.newtvSearch.exampleId = first.id;
      const post = await timedFetch(`${base}/newtv/post.php?id=${first.id}`, { headers: newTvHeaders });
      report.endpoints.newtvPost = { status: post.status, latencyMs: post.latencyMs, sample: (post.text || post.error || '').slice(0, 300) };
      const player = await timedFetch(`${base}/newtv/player.php?id=${first.id}`, { headers: newTvHeaders });
      report.endpoints.newtvPlayer = {
        status: player.status,
        latencyMs: player.latencyMs,
        sample: (player.text || player.error || '').slice(0, 400)
      };
    }
  } catch {
    // search output was not JSON (blocked/redirected) - the samples above say why.
  }
}

async function probeWebMirrors() {
  report.webMirrors = {};
  for (const base of WEB_MIRRORS) {
    const entry = {};
    for (const [name, url] of [
      ['movie', `${base}/api/embed-tmdb/693134`],
      ['tv', `${base}/api/embed-tmdb/1396?type=tv&se=1&ep=1`]
    ]) {
      const res = await timedFetch(url, {
        headers: { Accept: 'application/json, text/plain, */*', Referer: `${base}/`, 'User-Agent': UA }
      });
      let summary = { status: res.status, latencyMs: res.latencyMs };
      if (res.text) {
        try {
          const json = JSON.parse(res.text);
          summary.ok = json.ok;
          summary.error = json.error || null;
          summary.streams = (json.streams || []).length;
          summary.mp4 = json.mp4 ? 'yes' : null;
          summary.firstStream = json.streams && json.streams[0] ? String(json.streams[0].url).slice(0, 110) : null;
          summary.captions = (json.captions || []).length;
        } catch {
          summary.bodySample = res.text.slice(0, 140);
        }
      }
      entry[name] = summary;
    }
    report.webMirrors[base] = entry;
  }
}

async function probeResolver() {
  const config = require('../src/config');
  const { resolveNetmirror } = require('../src/services/resolver');
  const prevBase = config.upstreams.netmirrorBase;
  const results = [];
  const titles = [
    { tmdbId: 693134, title: 'Dune: Part Two', originalTitle: 'Dune: Part Two', releaseYear: 2024, type: 'movie' },
    { tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club', releaseYear: 1999, type: 'movie' },
    { tmdbId: 1396, title: 'Breaking Bad', originalTitle: 'Breaking Bad', releaseYear: 2008, type: 'tv', season: 1, episode: 1 }
  ];
  for (const metadata of titles) {
    const started = Date.now();
    let resolved = null;
    try {
      resolved = await resolveNetmirror(metadata, 'hi');
    } catch (error) {
      resolved = { __error: String(error.message || error) };
    }
    results.push({
      title: metadata.title,
      latencyMs: Date.now() - started,
      ok: Boolean(resolved && resolved.streamUrl),
      sourceName: resolved && resolved.sourceName,
      server: resolved && resolved.server,
      rawUrl: resolved && resolved.rawUrl,
      audioTracks: resolved && resolved.audioTracks,
      reason: resolved && resolved.reason,
      error: resolved && resolved.__error
    });
  }
  config.upstreams.netmirrorBase = prevBase;
  report.resolver = results;
}

async function main() {
  await probeDiscovery();
  if (!report.apiBase) {
    const fallback = ['https://net27.cc', 'https://net52.cc', 'https://net77.cc'].find((d) =>
      report.discovery.some((entry) => entry.domain === d && entry.status > 0)
    );
    report.apiBase = fallback || null;
    report.apiBaseSource = fallback ? 'fallback (no token_hash)' : 'none';
  } else {
    report.apiBaseSource = 'checknewtv token_hash';
  }
  if (report.apiBase) await probeApi(report.apiBase);
  await probeWebMirrors();
  await probeResolver();

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`api base: ${report.apiBase} (${report.apiBaseSource})`);
  for (const entry of report.discovery) {
    console.log(`  ${entry.domain.padEnd(28)} status=${entry.status} ${entry.error || ''} ${entry.decoded ? '-> ' + entry.decoded : ''}`);
  }
  for (const [base, entry] of Object.entries(report.webMirrors || {})) {
    console.log(`  ${base.padEnd(24)} movie=${JSON.stringify(entry.movie).slice(0, 150)}`);
    console.log(`  ${''.padEnd(24)} tv=${JSON.stringify(entry.tv).slice(0, 150)}`);
  }
  for (const [name, value] of Object.entries(report.endpoints)) {
    console.log(`  ${name.padEnd(16)} ${JSON.stringify(value).slice(0, 200)}`);
  }
  for (const entry of report.resolver || []) {
    console.log(`  RESOLVE ${entry.title.padEnd(16)} ok=${entry.ok} ${entry.sourceName || entry.reason || entry.error || ''}`);
  }
  console.log(`report: ${OUT}`);
}

main().catch((error) => {
  console.error('netmirror probe failed:', error);
  process.exitCode = 1;
});
