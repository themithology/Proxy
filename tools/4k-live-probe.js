#!/usr/bin/env node
/**
 * Live Ursa/4K probe. Run this on a real-network runner, not in the Arena
 * sandbox:
 *
 *   node tools/4k-live-probe.js --out diagnostics/4k-live-probe.json
 *
 * The report is intentionally diagnostic rather than pass/fail. It keeps the
 * exact 4KHDHub buttons and redirector landing HTML, the MoviesDrive search
 * hit quality/IMDb flags, HiCine vcloud unrolls, and Dahmer 2160p directory
 * files beside each tier's structured resolver result.
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { resolveTmdbMetadata } = require('../src/services/tmdb');
const {
  resolveUrsaServer,
  resolve4khdhub,
  resolveMoviesdrive4k,
  resolveHicine4k,
  resolveDahmer4k,
  unroll4kCandidateUrl,
  parse4khdhubSearchCards,
  get4kDownloadBlocks,
  parseHicineLinks
} = require('../src/services/resolver');

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex >= 0 && process.argv[outIndex + 1]
  ? process.argv[outIndex + 1]
  : 'diagnostics/4k-live-probe.json';
const titleArgs = process.argv
  .filter((arg) => arg.startsWith('--title='))
  .map((arg) => arg.slice('--title='.length).trim())
  .filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_HTML = 96 * 1024;
const DEFAULT_TITLES = [
  { type: 'movie', tmdbId: 693134, title: 'Dune: Part Two', releaseYear: 2024, imdbId: 'tt15239678', season: 1, episode: 1 },
  { type: 'movie', tmdbId: 550, title: 'Fight Club', releaseYear: 1999, imdbId: 'tt0137523', season: 1, episode: 1 },
  { type: 'tv', tmdbId: 94605, title: 'Arcane', releaseYear: 2021, imdbId: 'tt11126994', season: 1, episode: 1 }
];

const report = {
  startedAt: new Date().toISOString(),
  runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
  node: process.version,
  upstreams: {
    fourkhdhubBase: config.upstreams.fourkhdhubBase,
    moviesdriveBase: config.upstreams.moviesdriveBase,
    hicineApiBase: config.upstreams.hicineApiBase,
    dahmerBase: config.upstreams.dahmerBase,
    domainDiscoveryUrl: config.upstreams.domainDiscoveryUrl
  },
  titles: {}
};

function browserHeaders(referer = '', accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8') {
  return {
    'User-Agent': UA,
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {})
  };
}

async function fetchTimed(url, options = {}, timeoutMs = 10000, cap = MAX_HTML) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    let body = '';
    if (!/video|audio|octet-stream|zip/i.test(contentType)) {
      body = await response.text();
      if (body.length > cap) body = body.slice(0, cap);
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      contentType,
      body,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      body: '',
      error: String(error?.message || error),
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueHosts(base, extra = []) {
  return Array.from(new Set([base, ...extra].filter(Boolean).map((value) => String(value).replace(/\/$/, ''))));
}

async function discoverHosts() {
  const hosts = {
    fourkhdhub: uniqueHosts(config.upstreams.fourkhdhubBase, config.upstreams.fourkhdhubHosts),
    moviesdrive: uniqueHosts(config.upstreams.moviesdriveBase, config.upstreams.moviesdriveHosts)
  };
  try {
    const discovery = await fetchTimed(config.upstreams.domainDiscoveryUrl, {
      headers: { ...browserHeaders(), Accept: 'application/json' }
    }, 5000, 256 * 1024);
    if (discovery.ok) {
      const data = JSON.parse(discovery.body);
      if (data['4khdhub']) hosts.fourkhdhub.unshift(String(data['4khdhub']).replace(/\/$/, ''));
      if (data.moviesdrive) hosts.moviesdrive.unshift(String(data.moviesdrive).replace(/\/$/, ''));
    }
  } catch (error) {
    report.discoveryError = String(error?.message || error);
  }
  return {
    fourkhdhub: Array.from(new Set(hosts.fourkhdhub)),
    moviesdrive: Array.from(new Set(hosts.moviesdrive))
  };
}

function summarizeResult(result) {
  if (!result) return { ok: false, reason: 'no_result' };
  return {
    ok: Boolean(result.ok && result.streamUrl),
    reason: result.reason || null,
    tier: result.tier || null,
    server: result.server || null,
    rawUrl: result.rawUrl || null,
    qualityDegraded: result.qualityDegraded === true,
    requestedQuality: result.requestedQuality || '2160p',
    qualities: Array.isArray(result.qualities)
      ? result.qualities.map((quality) => ({ label: quality.label, height: quality.height, url: quality.url }))
      : [],
    diag: result.diag || null
  };
}

function isRedirectButton(url) {
  return /[?&]id=[^&#\s"']+/i.test(url) || /(^|\.)greenmotors\.(?:club|cc)\//i.test(url);
}

async function probe4khdhub(meta, hosts) {
  const tier = { failureReasons: [], search: [], buttons: [], resolver: null };
  for (const host of hosts.slice(0, 3)) {
    const searchUrl = `${host}/?s=${encodeURIComponent(meta.title)}`;
    const search = await fetchTimed(searchUrl, { headers: browserHeaders(`${host}/`) }, 10000);
    const searchEntry = { host, url: searchUrl, status: search.status, latencyMs: search.latencyMs };
    if (!search.ok) {
      searchEntry.error = search.error || `HTTP ${search.status}`;
      tier.search.push(searchEntry);
      continue;
    }
    const cards = parse4khdhubSearchCards(search.body, host);
    searchEntry.cards = cards.map((card) => ({ title: card.title, year: card.year, href: card.href, isSeries: card.isSeries }));
    tier.search.push(searchEntry);
    const wanted = cards
      .filter((card) => meta.type === 'tv' ? card.isSeries : !card.isSeries)
      .sort((a, b) => {
        const aTitle = String(a.title).toLowerCase();
        const bTitle = String(b.title).toLowerCase();
        return Number(bTitle.includes(meta.title.toLowerCase())) - Number(aTitle.includes(meta.title.toLowerCase()));
      })[0] || cards[0];
    if (!wanted) {
      tier.failureReasons.push('no_matching_search_card');
      continue;
    }
    const detailUrl = new URL(wanted.href, host).href;
    const detail = await fetchTimed(detailUrl, { headers: browserHeaders(searchUrl) }, 10000);
    if (!detail.ok) {
      tier.failureReasons.push(`detail_http_${detail.status}`);
      continue;
    }
    const blocks = get4kDownloadBlocks(detail.body, meta.type === 'tv', meta.season, meta.episode);
    for (const block of blocks) {
      const text = cleanText(block.html).slice(0, 500);
      const linkRe = /<a\b[^>]*>/gi;
      let match;
      while ((match = linkRe.exec(block.html))) {
        const hrefMatch = match[0].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        if (!hrefMatch) continue;
        const href = new URL((hrefMatch[1] || hrefMatch[2] || hrefMatch[3]).replace(/&amp;/g, '&'), detail.url || detailUrl).href;
        const close = block.html.indexOf('</a>', linkRe.lastIndex);
        const label = cleanText(close >= 0 ? block.html.slice(linkRe.lastIndex, close) : '');
        const button = { href, label, block: text, redirector: isRedirectButton(href) };
        if (button.redirector) {
          const landing = await fetchTimed(href, { headers: browserHeaders(detail.url || detailUrl) }, 8000);
          button.landing = {
            requestedUrl: href,
            finalUrl: landing.url,
            status: landing.status,
            contentType: landing.contentType,
            html: landing.body,
            error: landing.error || null
          };
        }
        try {
          button.unroll = {
            url: await unroll4kCandidateUrl(href, null, Date.now() + 10000, detail.url || detailUrl),
            attemptedAt: new Date().toISOString()
          };
        } catch (error) {
          button.unroll = { url: null, error: String(error?.message || error) };
        }
        tier.buttons.push(button);
      }
    }
    if (tier.buttons.length === 0) tier.failureReasons.push('no_download_buttons');
    break;
  }
  if (tier.search.length === 0) tier.failureReasons.push('no_search_response');
  try {
    tier.resolver = summarizeResult(await resolve4khdhub(meta));
  } catch (error) {
    tier.resolver = { ok: false, reason: String(error?.message || error) };
  }
  if (!tier.resolver.ok && tier.resolver.reason) tier.failureReasons.push(tier.resolver.reason);
  return tier;
}

async function probeMoviesdrive(meta, hosts) {
  const tier = { failureReasons: [], hits: [], post: null, resolver: null };
  for (const host of hosts.slice(0, 3)) {
    for (const query of [meta.imdbId, meta.title].filter(Boolean)) {
      const url = `${host}/search.php?q=${encodeURIComponent(query)}&page=1`;
      const response = await fetchTimed(url, { headers: browserHeaders(`${host}/`) }, 10000);
      if (!response.ok) {
        tier.failureReasons.push(`search_http_${response.status}`);
        continue;
      }
      try {
        const data = JSON.parse(response.body);
        for (const hit of (data.hits || [])) {
          const doc = hit.document || {};
          const text = [doc.post_title, doc.title, doc.quality, doc.resolution].filter(Boolean).join(' ');
          tier.hits.push({
            query,
            permalink: doc.permalink || null,
            post_title: doc.post_title || doc.title || null,
            imdb_id: doc.imdb_id || '',
            hasImdbId: Boolean(String(doc.imdb_id || '').trim()),
            is4K: /2160p|\b4k\b|\buhd\b/i.test(text),
            quality: (text.match(/2160p|1440p|1080p|720p|4k|uhd/ig) || [])
          });
        }
      } catch (error) {
        tier.failureReasons.push(`search_json:${error.message}`);
      }
    }
    break;
  }
  try {
    tier.resolver = summarizeResult(await resolveMoviesdrive4k(meta));
  } catch (error) {
    tier.resolver = { ok: false, reason: String(error?.message || error) };
  }
  if (tier.hits.length === 0) tier.failureReasons.push('no_search_hits');
  if (!tier.resolver.ok && tier.resolver.reason) tier.failureReasons.push(tier.resolver.reason);
  return tier;
}

async function probeHicine(meta) {
  const tier = { failureReasons: [], search: null, vcloud: [], resolver: null };
  const base = String(config.upstreams.hicineApiBase || '').replace(/\/$/, '');
  const response = await fetchTimed(`${base}/api/search/${encodeURIComponent(meta.title)}`, {
    headers: { ...browserHeaders(`${base}/`), Accept: 'application/json' }
  }, 10000, 1024 * 1024);
  tier.search = { status: response.status, latencyMs: response.latencyMs, error: response.error || null };
  try {
    const items = JSON.parse(response.body);
    const chosen = items.find((item) => String(item.title || item.name || '').toLowerCase().includes(meta.title.toLowerCase())) || items[0];
    const raw = meta.type === 'tv'
      ? chosen?.[`season_${meta.season}`] || chosen?.season_1 || ''
      : chosen?.links || '';
    const links = parseHicineLinks(raw, meta.type === 'tv', meta.episode)
      .filter((entry) => entry.type === 'vcloud_worker');
    tier.search.match = chosen?.title || chosen?.name || null;
    await Promise.all(links.slice(0, 8).map(async (entry) => {
      const item = { quality: entry.quality, height: entry.height, url: entry.url, description: entry.description };
      try {
        item.unroll = await unroll4kCandidateUrl(entry.url, null, Date.now() + 9000, `${base}/`);
      } catch (error) {
        item.error = String(error?.message || error);
      }
      tier.vcloud.push(item);
    }));
  } catch (error) {
    tier.failureReasons.push(response.ok ? `search_parse:${error.message}` : `search_http_${response.status}`);
  }
  try {
    tier.resolver = summarizeResult(await resolveHicine4k(meta));
  } catch (error) {
    tier.resolver = { ok: false, reason: String(error?.message || error) };
  }
  if (tier.vcloud.length === 0) tier.failureReasons.push('no_vcloud_4k_links');
  if (!tier.resolver.ok && tier.resolver.reason) tier.failureReasons.push(tier.resolver.reason);
  return tier;
}

async function probeDahmer(meta) {
  const tier = { failureReasons: [], directories: [], files2160p: [], resolver: null };
  const base = String(config.upstreams.dahmerBase || '').replace(/\/$/, '');
  const cleanTitle = String(meta.title).replace(/:/g, '').replace(/\s+/g, ' ').trim();
  const paths = meta.type === 'tv'
    ? [`/tvs/${encodeURIComponent(cleanTitle)}/Season%20${String(meta.season).padStart(2, '0')}/`, `/tvs/${encodeURIComponent(cleanTitle)}/Season%20${meta.season}/`]
    : [`/movies/${encodeURIComponent(`${cleanTitle} (${meta.releaseYear})`)}/`, `/movies/${encodeURIComponent(cleanTitle)}/`];
  for (const pathname of paths) {
    const url = `${base}${pathname}`;
    const response = await fetchTimed(url, { headers: browserHeaders(`${base}/`) }, 10000);
    const directory = { url, status: response.status, latencyMs: response.latencyMs, error: response.error || null };
    if (response.ok) {
      const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRe.exec(response.body))) {
        const filename = cleanText(match[2]);
        const href = new URL(match[1], response.url || url).href;
        if (/\.(mkv|mp4|webm|m4v)([?#]|$)/i.test(`${href} ${filename}`) && /2160p/i.test(`${href} ${filename}`)) {
          tier.files2160p.push({ filename, url: href, is2160p: true });
        }
      }
      tier.directories.push(directory);
      break;
    }
    tier.directories.push(directory);
  }
  try {
    tier.resolver = summarizeResult(await resolveDahmer4k(meta));
  } catch (error) {
    tier.resolver = { ok: false, reason: String(error?.message || error) };
  }
  if (tier.files2160p.length === 0) tier.failureReasons.push('no_2160p_files');
  if (!tier.resolver.ok && tier.resolver.reason) tier.failureReasons.push(tier.resolver.reason);
  return tier;
}

async function probeTitle(input, hosts) {
  let metadata = { ...input, externalIds: { imdb_id: input.imdbId } };
  try {
    const tmdb = await resolveTmdbMetadata(input.type, input.tmdbId, input.season, input.episode);
    if (tmdb && !tmdb.unresolvedTmdb) metadata = { ...tmdb, ...metadata, externalIds: { ...(tmdb.externalIds || {}), imdb_id: input.imdbId || tmdb.externalIds?.imdb_id } };
  } catch (error) {
    metadata.metadataError = String(error?.message || error);
  }
  const [fourkhdhub, moviesdrive, hicine, dahmer] = await Promise.all([
    probe4khdhub(metadata, hosts.fourkhdhub),
    probeMoviesdrive(metadata, hosts.moviesdrive),
    probeHicine(metadata),
    probeDahmer(metadata)
  ]);
  let cascade;
  try {
    cascade = summarizeResult(await resolveUrsaServer(metadata, 'ursa', ''));
  } catch (error) {
    cascade = { ok: false, reason: String(error?.message || error) };
  }
  return {
    metadata: {
      type: metadata.type,
      tmdbId: metadata.tmdbId,
      title: metadata.title,
      releaseYear: metadata.releaseYear,
      season: metadata.season,
      episode: metadata.episode,
      externalIds: metadata.externalIds
    },
    tiers: { fourkhdhub, moviesdrive, hicine, dahmer },
    cascade
  };
}

async function main() {
  const hosts = await discoverHosts();
  report.discoveredHosts = hosts;
  const titles = titleArgs.length
    ? DEFAULT_TITLES.filter((item) => titleArgs.some((title) => item.title.toLowerCase().includes(title.toLowerCase())))
    : DEFAULT_TITLES;
  for (const title of titles.length ? titles : DEFAULT_TITLES.slice(0, 1)) {
    const key = `${title.type}:${title.tmdbId}`;
    try {
      report.titles[key] = await probeTitle(title, hosts);
    } catch (error) {
      report.titles[key] = { error: String(error?.stack || error) };
    }
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  const output = path.resolve(OUT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`4K live probe wrote ${output}`);
}

main().catch((error) => {
  report.finishedAt = new Date().toISOString();
  report.fatalError = String(error?.stack || error);
  const output = path.resolve(OUT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 0;
});
