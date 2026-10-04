#!/usr/bin/env node
/**
 * Live end-to-end probe for the player-facing servers — defaults to Server 3
 * (`ursa`, 4K UHD) and Server 4 (`hamster`, OMSS cascade).
 *
 * Run this on a network with real egress (a GitHub runner, not the Arena
 * sandbox):
 *
 *   node tools/server-live-probe.js --out diagnostics/server-live-probe.json
 *   node tools/server-live-probe.js --servers=ursa,hamster --titles=Dune
 *
 * WHY THIS EXISTS
 * ---------------
 * The 4K probe (`tools/4k-live-probe.js`) tests the Node tier resolvers.
 * The player does not call those: it calls `GET /api/resolve/:type/:tmdbId?server=…`
 * on the Cloudflare Worker, which runs its own Ursa implementation and the
 * shared Hamster cascade. A server can pass the tier probe and still fail the
 * player path (worker-only bug, catalog wiring, proxy URL, unplayable CDN URL).
 *
 * So this probe walks the EXACT production path for every server in the matrix:
 * the in-process Worker request (same module `wrangler` deploys) plus the Node
 * equivalent, and it records the resolved URL, the player payload, per-tier /
 * per-provider failure reasons, and a Range probe proving the media actually
 * plays. The report is diagnostic, not pass/fail.
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const serverCatalog = require('../src/services/serverCatalog');
const { resolveTmdbMetadata } = require('../src/services/tmdb');
const {
  resolveUrsaServer,
  resolve4khdhub,
  resolveMoviesdrive4k,
  resolveHicine4k,
  resolveDahmer4k,
  resolveStreamForServer,
  parse4khdhubSearchCards,
  get4kDownloadBlocks,
  decode4khdhubRedirectHtml,
  extractWrappedMediaTargets,
  isHubcloudGeneratorUrl,
  normalizePlayableUrl,
  scorePlayableUrl,
  probePlayableMediaUrl
} = require('../src/services/resolver');
const {
  resolveHamsterWheelServer,
  resolveVideasy,
  resolvePeachify,
  resolveVidsrc
} = require('../src/services/hamsterWheel');

// ---------------------------------------------------------------- CLI & report

const argValue = (name, fallback = '') => {
  const idx = process.argv.findIndex((arg) => arg === `--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};
const OUT = argValue('out', 'diagnostics/server-live-probe.json');
const SERVERS = argValue('servers', 'ursa,hamster')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TITLE_FILTER = process.argv
  .filter((arg) => arg.startsWith('--title='))
  .map((arg) => arg.slice('--title='.length).trim().toLowerCase())
  .filter(Boolean);
const WORKER_ORIGIN = argValue('origin', 'https://server-live-probe.test');
const WORKER_E2E_TIMEOUT_MS = Number(argValue('timeout', '90000'));
const PLAYBACK_PROBE_TIMEOUT_MS = 20000;

const DEFAULT_TITLES = [
  { type: 'movie', tmdbId: 693134, title: 'Dune: Part Two', season: 1, episode: 1 },
  { type: 'movie', tmdbId: 550, title: 'Fight Club', season: 1, episode: 1 },
  { type: 'tv', tmdbId: 94605, title: 'Arcane', season: 1, episode: 1 }
];

const report = {
  startedAt: new Date().toISOString(),
  runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
  node: process.version,
  serversRequested: SERVERS,
  catalog: serverCatalog.allServers().map((s) => ({
    id: s.id,
    priority: s.priority,
    name: s.name,
    badge: s.badge,
    enabled: s.enabled,
    listed: s.listed,
    fallback: s.fallback
  })),
  upstreams: {
    fourkhdhubBase: config.upstreams.fourkhdhubBase,
    moviesdriveBase: config.upstreams.moviesdriveBase,
    hicineApiBase: config.upstreams.hicineApiBase,
    dahmerBase: config.upstreams.dahmerBase,
    videasy: 'https://api.videasy.net (+ api2.videasy.net)',
    peachify: 'peachify upstreams',
    vidsrc: 'vsembed.ru + CDN mirrors'
  },
  titles: {}
};

// ------------------------------------------------------------------- helpers

/** Keep report URLs small: host + path head, no signatures/queries. */
function shortUrl(value) {
  const raw = String(value || '');
  if (!raw) return null;
  try {
    const parsed = new URL(raw, WORKER_ORIGIN);
    const isRelative = !/^https?:/i.test(raw);
    return `${isRelative ? '' : `${parsed.protocol}//`}${parsed.host}${parsed.pathname}`;
  } catch {
    return raw.slice(0, 160);
  }
}

function summarizeStream(stream) {
  if (!stream) return null;
  return {
    server: stream.server || null,
    provider: stream.provider || null,
    tier: stream.tier || null,
    format: stream.format || null,
    streamUrl: shortUrl(stream.streamUrl),
    streamUrlIsRelative: !/^https?:/i.test(String(stream.streamUrl || '')),
    rawUrl: shortUrl(stream.rawUrl),
    rawUrlKind: /\.m3u8(\?|$)/i.test(String(stream.rawUrl || ''))
      ? 'hls'
      : /\.mpd(\?|$)/i.test(String(stream.rawUrl || ''))
        ? 'dash'
        : /\.(mkv|mp4|webm)(\?|$)/i.test(String(stream.rawUrl || ''))
          ? 'progressive'
          : 'other',
    qualityDegraded: stream.qualityDegraded === true,
    qualities: (stream.qualities || []).map((q) => ({ label: q.label, height: q.height, url: shortUrl(q.url) })),
    audioTracks: (stream.audioTracks || []).map((t) => ({ id: t.id, lang: t.lang, label: t.label, default: !!t.default })),
    backupUrlCount: (stream.backupUrls || []).length
  };
}

function summarizeAttempts(attempts) {
  return (attempts || []).map((a) => ({
    server: a.server,
    latencyMs: a.latencyMs,
    reason: a.reason,
    diagMessage: a.diag && a.diag.message ? String(a.diag.message).slice(0, 300) : null
  }));
}

function summarizePayload(body) {
  return {
    ok: !!body.ok,
    error: body.error || null,
    explanation: body.explanation || null,
    requestedServer: body.requestedServer || null,
    failedReason: body.failedReason || null,
    resolvedByServer: body.stream ? body.stream.server || null : null,
    stream: summarizeStream(body.stream),
    serverAttempts: summarizeAttempts(body.serverAttempts),
    playerServerList: (body.servers || []).map((s) => ({
      id: s.id,
      order: s.priority,
      name: s.name,
      badge: s.badge,
      active: !!s.active
    }))
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true, label }), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function safe(label, fn) {
  const started = Date.now();
  try {
    const value = await withTimeout(fn(), WORKER_E2E_TIMEOUT_MS, label);
    if (value && value.__timeout) return { ok: false, reason: 'probe_timeout', latencyMs: Date.now() - started };
    return { latencyMs: Date.now() - started, ...(value || {}) };
  } catch (error) {
    return { ok: false, reason: 'probe_exception', error: String(error && error.message), latencyMs: Date.now() - started };
  }
}

/** Range/HEAD probe: does the URL actually behave like playable media? */
async function probePlayable(label, targetUrl, { headers = {}, relativeToWorker = false } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYBACK_PROBE_TIMEOUT_MS);
  try {
    const absolute = relativeToWorker ? `${WORKER_ORIGIN}${targetUrl}` : targetUrl;
    const res = relativeToWorker
      ? await globalThis.__workerFetch(
          new Request(absolute, { headers: { Range: 'bytes=0-2047', ...headers } }),
          globalThis.__workerEnv,
          { waitUntil() {} }
        )
      : await fetch(absolute, { headers: { Range: 'bytes=0-2047', 'User-Agent': 'Mozilla/5.0', ...headers }, signal: controller.signal });
    const buf = await res.arrayBuffer();
    const head = Buffer.from(buf.slice(0, 16));
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      contentType: res.headers.get('content-type') || null,
      contentLengthHeader: res.headers.get('content-length') || null,
      firstBytes: buf.byteLength,
      magic: head.toString('hex'),
      headText: head.toString('utf8').replace(/[^\x20-\x7e]/g, '.').slice(0, 40),
      looksLikeHtml: /^\s*<!doctype|^\s*<html/i.test(head.toString('utf8')),
      looksLikeScript: /^\s*(?:\(function|!function|function\s*\(|var\s|let\s|const\s|window\.|document\.|<script)/i.test(head.toString('utf8')),
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return { ok: false, status: 0, error: String(error && error.message), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- probing

let workerFetch = null;
let workerEnv = null;

function workerRequest(pathname) {
  return workerFetch(new Request(`${WORKER_ORIGIN}${pathname}`), workerEnv, { waitUntil() {} });
}

/** The player's exact request, served by the same module wrangler deploys. */
async function probeWorkerEndToEnd(title, server) {
  const started = Date.now();
  const qs = new URLSearchParams({
    season: String(title.season),
    episode: String(title.episode),
    server,
    audio: '',
    parent: 'https://probe.test'
  });
  const res = await workerRequest(`/api/resolve/${title.type}/${title.tmdbId}?${qs.toString()}`);
  const body = await res.json();
  const out = {
    status: res.status,
    latencyMs: Date.now() - started,
    ...summarizePayload(body)
  };
  if (out.stream) {
    out.playback = {
      resolvedTarget: String(body.stream.rawUrl || '').slice(0, 300),
      proxyTarget: String(body.stream.streamUrl || '').slice(0, 300),
      proxy: await probePlayable('worker-proxy', body.stream.streamUrl, { relativeToWorker: true }),
      direct: body.stream.rawUrl ? await probePlayable('direct', body.stream.rawUrl) : null
    };
  }
  return out;
}

/** Node equivalent of the player request (Node backend deployments). */
async function probeNodeWaterfall(metadata, server) {
  const result = await resolveStreamForServer(metadata, server, '');
  return {
    ok: !!(result && result.streamUrl),
    reason: result && result.reason ? result.reason : null,
    requestedServer: result ? result.requestedServer : null,
    resolvedByServer: result ? result.server : null,
    stream: summarizeStream(result),
    serverAttempts: summarizeAttempts(result && result.serverAttempts)
  };
}

/**
 * Per-tier Ursa detail: which 4K tier answered, why the others did not, and
 * whether the URL the tier returned is actually playable media. The last part
 * is what caught Server 3 returning a JavaScript landing page as "verified 4K".
 */
async function probeUrsaTiers(metadata) {
  const tiers = [
    ['4khdhub', () => resolve4khdhub(metadata, '')],
    ['moviesdrive4k', () => resolveMoviesdrive4k(metadata, '')],
    ['hicine4k', () => resolveHicine4k(metadata, '')],
    ['dahmer4k', () => resolveDahmer4k(metadata, '')]
  ];
  const entries = await Promise.all(
    tiers.map(async ([id, run]) => {
      try {
        const res = await run();
        const rawUrl = (res && res.rawUrl) || null;
        return [
          id,
          {
            ok: !!(res && res.ok && res.streamUrl),
            reason: res && res.reason ? res.reason : null,
            rawUrl: shortUrl(rawUrl),
            rawUrlFull: rawUrl ? String(rawUrl).slice(0, 300) : null,
            score: rawUrl ? scorePlayableUrl(rawUrl) : null,
            qualifiesViaScoreOnly: !!(
              rawUrl && scorePlayableUrl(rawUrl) >= 0
            ),
            playback: rawUrl ? await probePlayable(id, rawUrl) : null,
            qualities: ((res && res.qualities) || []).map((q) => q.label)
          }
        ];
      } catch (error) {
        return [id, { ok: false, reason: 'throw', error: String(error && error.message) }];
      }
    })
  );
  return Object.fromEntries(entries);
}

/**
 * Capture the 4KHDHub -> greenmotors redirector -> HubCloud generator chain so a
 * wrong terminal URL can be diagnosed offline: every candidate the generator
 * page exposes, its score, and whether it verifies as media.
 */
async function probeFourKChain(metadata) {
  const host = config.upstreams.fourkhdhubBase;
  const out = { host, searchUrl: null, cards: [], buttons: [] };
  const searchRes = await fetch(`${host}/?s=${encodeURIComponent(metadata.title)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' }
  });
  out.searchStatus = searchRes.status;
  const searchHtml = await searchRes.text();
  const cards = parse4khdhubSearchCards(searchHtml, host);
  out.cards = cards.slice(0, 4).map((c) => ({ title: c.title, year: c.year, href: c.href, isSeries: c.isSeries }));
  const wanted = cards.find((c) => (metadata.type === 'tv' ? c.isSeries : !c.isSeries)) || cards[0];
  if (!wanted) return out;

  const detailUrl = new URL(wanted.href, host).href;
  out.detailUrl = detailUrl;
  const detailRes = await fetch(detailUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0', Referer: host }
  });
  const detailHtml = await detailRes.text();
  out.detailStatus = detailRes.status;

  const blocks = get4kDownloadBlocks(detailHtml, metadata.type === 'tv', metadata.season, metadata.episode);
  for (const block of blocks.slice(0, 3)) {
    for (const match of block.html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const href = new URL((match[1] || match[2]).replace(/&amp;/g, '&'), detailUrl).href;
      if (!/[?&]id=[^&#\s"']+/i.test(href)) continue;
      const entry = { href: href.slice(0, 300), decoded: null, generator: null, candidates: [] };
      try {
        const landing = await fetch(href, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: detailUrl } });
        const html = await landing.text();
        entry.landingFinalUrl = String(landing.url || '').slice(0, 200);
        entry.decoded = decode4khdhubRedirectHtml(html, landing.url || href);
      } catch (error) {
        entry.error = String(error && error.message);
      }

      const generator = entry.decoded && entry.decoded.url ? entry.decoded.url : null;
      entry.generator = generator ? String(generator).slice(0, 200) : null;
      if (!generator) {
        out.buttons.push(entry);
        continue;
      }

      try {
        const genRes = await fetch(generator, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0', Referer: entry.landingFinalUrl || href }
        });
        const genHtml = await genRes.text();
        entry.generatorStatus = genRes.status;
        entry.generatorFinalUrl = String(genRes.url || '').slice(0, 200);
        entry.generatorHtmlHead = genHtml.slice(0, 700);
        const seen = new Set();
        for (const urlMatch of genHtml.replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>)\\]+/gi)) {
          const candidate = urlMatch[0].replace(/[.,;:]+$/, '');
          if (seen.has(candidate) || seen.size >= 14) continue;
          seen.add(candidate);
          const normalized = normalizePlayableUrl(candidate);
          const score = scorePlayableUrl(normalized);
          const wrapped = extractWrappedMediaTargets(normalized);
          entry.candidates.push({
            url: candidate.slice(0, 240),
            score,
            isGenerator: isHubcloudGeneratorUrl(normalized),
            wrapped: wrapped.length ? wrapped.map((w) => w.slice(0, 160)) : undefined,
            playback: score >= 0 ? await probePlayable('candidate', normalized) : undefined
          });
        }
      } catch (error) {
        entry.generatorError = String(error && error.message);
      }
      out.buttons.push(entry);
    }
  }
  return out;
}

/** Per-provider Hamster detail. */
async function probeHamsterProviders(metadata) {
  const providers = [
    ['videasy', () => resolveVideasy(metadata, '')],
    ['peachify', () => resolvePeachify(metadata, '')],
    ['vidsrc', () => resolveVidsrc(metadata, '')]
  ];
  const entries = await Promise.all(
    providers.map(async ([id, run]) => {
      try {
        const res = await run();
        return [
          id,
          {
            ok: !!(res && res.streamUrl),
            reason: res && res.reason ? res.reason : null,
            provider: res && res.provider ? res.provider : null,
            rawUrl: shortUrl(res && res.rawUrl),
            audioTracks: ((res && res.audioTracks) || []).map((t) => t.label || t.lang)
          }
        ];
      } catch (error) {
        return [id, { ok: false, reason: 'throw', error: String(error && error.message) }];
      }
    })
  );
  return Object.fromEntries(entries);
}

async function probeTitle(title) {
  let metadata = { ...title, externalIds: {} };
  try {
    const tmdb = await resolveTmdbMetadata(title.type, title.tmdbId, title.season, title.episode);
    if (tmdb && !tmdb.unresolvedTmdb) metadata = tmdb;
  } catch (error) {
    metadata.metadataError = String(error && error.message);
  }

  const entry = {
    metadata: {
      type: metadata.type,
      tmdbId: metadata.tmdbId,
      title: metadata.title,
      releaseYear: metadata.releaseYear,
      season: metadata.season,
      episode: metadata.episode,
      externalIds: metadata.externalIds || {},
      metadataError: metadata.metadataError || null
    },
    servers: {}
  };

  for (const server of SERVERS) {
    const serverReport = {
      workerEndToEnd: await safe(`${server}:worker`, () => probeWorkerEndToEnd(metadata, server)),
      nodeDirect: await safe(`${server}:node-direct`, async () => {
        let result = null;
        if (server === 'ursa') result = await resolveUrsaServer(metadata, 'ursa', '');
        else if (server === 'hamster') result = await resolveHamsterWheelServer(metadata, 'hamster', '');
        else return { skipped: true };
        return {
          ok: !!(result && result.streamUrl),
          reason: result && result.reason ? result.reason : null,
          selectedTier: result && result.diag ? result.diag.selectedTier || null : null,
          diagMessage: result && result.diag && result.diag.message ? String(result.diag.message).slice(0, 300) : null,
          diagSteps: result && result.diag && Array.isArray(result.diag.steps)
            ? result.diag.steps.map((step) => `${step.step || step.stage}: ${String(step.detail || step.message || '').slice(0, 200)}`)
            : null,
          stream: summarizeStream(result)
        };
      }),
      nodeWaterfall: await safe(`${server}:node-waterfall`, () => probeNodeWaterfall(metadata, server))
    };
    if (server === 'ursa') serverReport.tiers = await safe('ursa:tiers', () => probeUrsaTiers(metadata));
    if (server === 'hamster') serverReport.providers = await safe('hamster:providers', () => probeHamsterProviders(metadata));
    entry.servers[server] = serverReport;
  }
  if (SERVERS.includes('ursa')) {
    // One title is enough to fingerprint the 4KHDHub chain; more titles only
    // re-fetch the same redirector pages.
    entry.fourKChain = await safe('ursa:chain', () => probeFourKChain(metadata));
  }
  return entry;
}

async function main() {
  const workerModule = await import(`../cloudflare-worker/worker.js`);
  workerFetch = workerModule.default.fetch;
  globalThis.__workerFetch = workerFetch;
  workerEnv = {
    ...process.env,
    TMDB_API_KEY: process.env.TMDB_API_KEY || config.tmdbApiKey,
    CASTLETV_BASE_URL: process.env.CASTLETV_BASE_URL || config.upstreams.castletvBase,
    NETMIRROR_BASE_URL: process.env.NETMIRROR_BASE_URL || config.upstreams.netmirrorBase,
    FOURKHDHUB_BASE_URL: process.env.FOURKHDHUB_BASE_URL || config.upstreams.fourkhdhubBase,
    MOVIESDRIVE_BASE_URL: process.env.MOVIESDRIVE_BASE_URL || config.upstreams.moviesdriveBase,
    HICINE_API_BASE: process.env.HICINE_API_BASE || config.upstreams.hicineApiBase,
    DAHMER_BASE_URL: process.env.DAHMER_BASE_URL || config.upstreams.dahmerBase,
    VIDEO_SRC_DATA_URL: process.env.VIDSRC_DATA_URL || config.upstreams.vidsrcDataUrl,
    ADMIN_SECRET: process.env.ADMIN_SECRET || config.adminSecret,
    PROXY_SECRET: process.env.PROXY_SECRET || config.proxySecret
  };
  globalThis.__workerEnv = workerEnv;

  const titles = TITLE_FILTER.length
    ? DEFAULT_TITLES.filter((t) => TITLE_FILTER.some((f) => t.title.toLowerCase().includes(f)))
    : DEFAULT_TITLES;

  for (const title of titles) {
    const key = `${title.type}:${title.tmdbId}`;
    try {
      report.titles[key] = await probeTitle(title);
    } catch (error) {
      report.titles[key] = { error: String((error && error.stack) || error) };
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  const output = path.resolve(OUT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Server live probe wrote ${output}`);
  for (const [key, entry] of Object.entries(report.titles)) {
    for (const [server, data] of Object.entries(entry.servers || {})) {
      const w = data.workerEndToEnd || {};
      console.log(
        `${key} server=${server} worker=${w.status || '?'} ok=${!!w.ok}` +
          `${w.resolvedByServer ? ` by=${w.resolvedByServer}` : ''}` +
          `${w.failedReason ? ` reason=${w.failedReason}` : ''}` +
          `${w.error ? ` error=${w.error}` : ''}`
      );
    }
  }
}

main().catch((error) => {
  report.finishedAt = new Date().toISOString();
  report.fatalError = String((error && error.stack) || error);
  const output = path.resolve(OUT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 0;
});
