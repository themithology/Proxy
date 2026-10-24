/**
 * Direct, Cloudflare-Worker-compatible provider fallbacks.
 *
 * TMDB-Embed-API is useful aggregation infrastructure, but it is also a single
 * egress IP and a single place for provider cookies to be missing.  This file
 * contains the small fetch-only parts of its multi-audio providers so the
 * Worker can resolve the same sources itself.  There are deliberately no Node
 * imports, Buffer, cheerio, axios, or DOM APIs here: the exact same module is
 * loaded by src/services/goldmine.js in Node and by cloudflare-worker/worker.js.
 *
 * Every extractor returns provider-shaped rows (name/title/url/quality/
 * provider/headers).  Normalization and playback stay in goldmine.js; providers
 * never get to bypass the proxy, language, or audio-track policies.
 */

const { parseHlsAudioTracks, parseHlsSubtitleTracks, looksLikeHlsManifest } = require('./hls');
const { parseAudioLanguageHints } = require('./languages');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DIRECT_PROVIDER_IDS = [
  '4khdhub',
  'castletv',
  'hdghartv',
  'netmirror',
  'dahmermovies',
  'showbox',
  'onetouchtv'
];

const PROVIDER_ALIASES = {
  '4khdhub': '4khdhub',
  '4khd': '4khdhub',
  castletv: 'castletv',
  castle: 'castletv',
  hdghartv: 'hdghartv',
  netmirror: 'netmirror',
  dahmermovies: 'dahmermovies',
  dahmer: 'dahmermovies',
  showbox: 'showbox',
  febbox: 'showbox',
  pstream: 'showbox',
  onetouchtv: 'onetouchtv',
  onetouch: 'onetouchtv'
};

function providerId(value) {
  const key = String(value || '').trim().toLowerCase();
  return PROVIDER_ALIASES[key] || key;
}

function metadataFor(metadata = {}) {
  const type = /^(tv|series)$/i.test(String(metadata.type || '')) ? 'tv' : 'movie';
  const date = metadata.releaseDate || metadata.release_date || metadata.firstAirDate || metadata.first_air_date || '';
  return {
    tmdbId: String(metadata.tmdbId || metadata.id || ''),
    imdbId: String(metadata.imdbId || metadata.imdb_id || ''),
    type,
    title: String(metadata.title || metadata.name || metadata.originalTitle || metadata.original_title || '').trim(),
    originalTitle: String(metadata.originalTitle || metadata.original_title || '').trim(),
    year: String(metadata.releaseYear || metadata.year || date.slice(0, 4) || '').trim(),
    season: Math.max(1, Number.parseInt(metadata.season || 1, 10) || 1),
    episode: Math.max(1, Number.parseInt(metadata.episode || 1, 10) || 1)
  };
}

function headersWith(extra = {}) {
  return { 'User-Agent': USER_AGENT, Accept: '*/*', ...extra };
}

/**
 * Fetch and read a response with both a timeout and an optional parent abort.
 * Reading the body inside the try block is important: a timeout must cover a
 * stalled body as well as the initial response headers.
 */
async function requestText(url, options = {}, context = {}) {
  const doFetch = typeof context.fetchImpl === 'function' ? context.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timeoutMs = Math.max(250, Number(context.timeoutMs) || 12000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const parent = context.signal;
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const fetchOptions = { ...options, signal: controller.signal };
    if (!fetchOptions.redirect) fetchOptions.redirect = 'follow';
    fetchOptions.headers = headersWith(fetchOptions.headers || {});
    const response = await doFetch(url, fetchOptions);
    let text = '';
    if (context.readBody === false) {
      try { if (response.body) await response.body.cancel(); } catch {}
    } else {
      text = await response.text();
    }
    return { response, text, url: response.url || url, timedOut: () => timedOut };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onAbort);
  }
}

async function requestJson(url, options = {}, context = {}) {
  const result = await requestText(url, options, context);
  if (!result.response.ok) throw new Error(`HTTP ${result.response.status} for ${url}`);
  try {
    return { ...result, json: JSON.parse(result.text) };
  } catch (error) {
    throw new Error(`Invalid JSON for ${url}: ${error.message}`);
  }
}

function unwrapData(value) {
  if (value && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return value.data;
  return value;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function textOf(value) {
  return decodeEntities(String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(tag || '').match(pattern);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function anchors(html, baseUrl = '') {
  const rows = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const rawHref = attribute(match[1], 'href');
    if (!rawHref || /^(?:javascript:|#|mailto:)/i.test(rawHref)) continue;
    let url = rawHref;
    try { url = new URL(rawHref, baseUrl).toString(); } catch {}
    rows.push({
      url,
      href: rawHref,
      text: textOf(match[2]),
      attrs: match[1],
      index: match.index
    });
  }
  return rows;
}

function absoluteUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).toString(); } catch { return String(value || ''); }
}

/** Return balanced DIV blocks with a class token (enough for provider cards,
 * season folders, and episode rows without shipping a DOM parser to Workers). */
function divBlocks(html, classToken) {
  const source = String(html || '');
  const blocks = [];
  const opening = /<div\b[^>]*>/gi;
  let match;
  while ((match = opening.exec(source))) {
    const tag = match[0];
    const classes = attribute(tag, 'class').split(/\s+/);
    if (!classes.includes(classToken)) continue;
    const nested = /<div\b[^>]*>|<\/div\s*>/gi;
    nested.lastIndex = opening.lastIndex;
    let depth = 1;
    let end = source.length;
    let token;
    while ((token = nested.exec(source))) {
      if (/^<div\b/i.test(token[0])) depth += 1;
      else depth -= 1;
      if (depth === 0) { end = nested.lastIndex; break; }
    }
    const body = source.slice(match.index, end);
    blocks.push({ html: body, text: textOf(body), index: match.index, end });
    opening.lastIndex = end;
  }
  return blocks;
}

function validStreamUrl(value) {
  if (!/^https?:\/\//i.test(String(value || ''))) return false;
  if (/\.zip(?:$|[?#])/i.test(value)) return false;
  if (/(?:cdn\.ampproject\.org|bloggingvector\.shop|hubcloud\.cx\/tg|\/tg\/go)/i.test(value)) return false;
  return true;
}

function qualityOf(...values) {
  const text = values.filter(Boolean).join(' ');
  const match = String(text).match(/(?:^|[^a-z0-9])(2160|1440|1080|720|576|540|480|360|240)\s*p?(?:[^a-z0-9]|$)/i);
  if (match) return `${match[1]}p`;
  if (/\b(?:4k|uhd)\b/i.test(text)) return '4K';
  if (/\bhd\b/i.test(text)) return '720p';
  return 'Auto';
}

function streamRow(provider, url, title, quality, options = {}) {
  if (!validStreamUrl(url)) return null;
  const q = quality || qualityOf(title, url);
  return {
    name: options.name || `${provider} | ${q}`,
    title: title || options.name || provider,
    url,
    quality: q,
    provider,
    directExtracted: true,
    headers: options.headers || {},
    ...(options.subtitles && options.subtitles.length ? { subtitles: options.subtitles } : {}),
    ...(options.audioTracks && options.audioTracks.length ? { audioTracks: options.audioTracks } : {})
  };
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(?:the|a|an)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleScore(candidate, metadata) {
  const wanted = normalizeTitle(metadata.title);
  const got = normalizeTitle(candidate);
  if (!wanted || !got) return 0;
  let score = wanted === got ? 100 : got.includes(wanted) || wanted.includes(got) ? 75 : 0;
  if (!score) {
    const words = wanted.split(' ').filter((word) => word.length > 2);
    const matched = words.filter((word) => got.includes(word)).length;
    score = words.length ? (matched / words.length) * 60 : 0;
  }
  const year = String(candidate || '').match(/\b(?:19|20)\d{2}\b/);
  if (metadata.year && year) score += year[0] === String(metadata.year) ? 20 : -80;
  return score;
}

function bestTitleMatch(rows, metadata, titleSelector = (row) => row.title || row.text || '') {
  return [...rows]
    .map((row) => ({ row, score: titleScore(titleSelector(row), metadata) }))
    .filter((entry) => entry.score >= 35)
    .sort((a, b) => b.score - a.score)[0]?.row || null;
}

function slugify(value) {
  return normalizeTitle(value).replace(/\s+/g, '-');
}

function base64Bytes(value) {
  let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (text.length % 4) text += '=';
  const binary = globalThis.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Text(value) {
  return new TextDecoder().decode(base64Bytes(value));
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) { out.set(array, offset); offset += array.length; }
  return out;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value));
}

async function aesCbcDecrypt(value, key, iv) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('WebCrypto AES-CBC is unavailable');
  const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, base64Bytes(value));
  return new TextDecoder().decode(plain);
}

function safeJson(text) {
  // CastleTV sometimes emits 64-bit IDs as bare JSON numbers.  Quote them
  // before parsing so an episode/language ID is not rounded by JavaScript.
  return JSON.parse(String(text).replace(/([:{[,]\s*)(\d{16,})/g, '$1"$2"'));
}

function parseSourcesAssignment(text) {
  const match = String(text || '').match(/(?:var|let|const)\s+sources\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function enrichHlsRow(row, context = {}) {
  if (!row || !/\.m3u8(?:$|[?#])|\/playlist\b|\/master\b/i.test(row.url)) return row;
  try {
    const result = await requestText(row.url, { headers: row.headers || {} }, { ...context, timeoutMs: Math.min(Number(context.timeoutMs) || 5000, 5000) });
    if (!result.response.ok || !looksLikeHlsManifest(result.text)) return row;
    const audioTracks = parseHlsAudioTracks(result.text).map((track) => ({
      ...track,
      url: track.url ? absoluteUrl(track.url, result.url) : ''
    }));
    const subtitles = parseHlsSubtitleTracks(result.text, result.url);
    return {
      ...row,
      ...(audioTracks.length ? { audioTracks } : {}),
      ...(subtitles.length ? { subtitles: [...(row.subtitles || []), ...subtitles] } : {})
    };
  } catch {
    return row;
  }
}

/* ------------------------------------------------------------------------- */
/* 4KHDHub: Redirector -> HubDrive/HubCloud -> Pixeldrain/FSL/R2             */
/* ------------------------------------------------------------------------- */

const FOUR_K_DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';

function rot13(value) {
  return String(value || '').replace(/[A-Za-z]/g, (char) => {
    const start = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
  });
}

async function resolve4kBase(context) {
  const configured = context.fourKhdhubBaseUrl || context['4khdhubBaseUrl'];
  if (configured) return String(configured).replace(/\/+$/, '');
  if (context.domains && context.domains['4khdhub']) return String(context.domains['4khdhub']).replace(/\/+$/, '');
  try {
    const result = await requestJson(FOUR_K_DOMAINS_URL, {}, { ...context, timeoutMs: 5000 });
    if (result.json && result.json['4khdhub']) return String(result.json['4khdhub']).replace(/\/+$/, '');
  } catch {}
  return 'https://4khdhub.com';
}

async function resolveRedirector(url, context, depth = 0) {
  if (depth > 2) return '';
  try {
    const result = await requestText(url, {}, { ...context, timeoutMs: 8000 });
    if (!result.response.ok) return '';
    const body = result.text;
    const pattern = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    let combined = '';
    let match;
    while ((match = pattern.exec(body))) combined += match[1] || match[2] || '';
    if (combined) {
      try {
        const decoded = base64Text(rot13(base64Text(base64Text(combined))));
        const object = JSON.parse(decoded);
        if (object.o) return base64Text(object.o).trim();
        const redirectData = object.data ? base64Text(object.data).trim() : '';
        if (object.blog_url && redirectData) {
          // The redirector expects its opaque token verbatim (the upstream
          // provider also appends it unescaped).  Retry URL-encoded only when
          // the verbatim form did not produce a URL.
          const next = await requestText(`${object.blog_url}?re=${redirectData}`, {}, { ...context, timeoutMs: 8000 });
          const text = textOf(next.text);
          if (/^https?:\/\//i.test(text)) return text;
          const encoded = await requestText(`${object.blog_url}?re=${encodeURIComponent(redirectData)}`, {}, { ...context, timeoutMs: 8000 });
          const encodedText = textOf(encoded.text);
          if (/^https?:\/\//i.test(encodedText)) return encodedText;
        }
      } catch {}
    }
    const candidates = body.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
    const found = candidates.find((candidate) => /(?:hubcloud|hubdrive|pixeldrain|r2\.dev|fsl)/i.test(candidate));
    if (found) return decodeEntities(found);
    const location = result.response.headers.get('location');
    if (location) return absoluteUrl(location, result.url);
  } catch {}
  return '';
}

function pageHeader(html) {
  const match = String(html || '').match(/<div\b[^>]*class=["'][^"']*card-header[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return textOf(match ? match[1] : '');
}

function pageSize(html) {
  const match = String(html || '').match(/<i\b[^>]*id=["']size["'][^>]*>([\s\S]*?)<\/i>/i);
  return textOf(match ? match[1] : '');
}

function pixeldrainUrl(url) {
  return String(url || '').replace(/(pixeldrain\.(?:dev|net|com))\/u\/([a-z0-9]+)/i, '$1/api/file/$2');
}

function finalLinkFromResponse(result, fallback) {
  const finalUrl = result && result.url ? result.url : fallback;
  try {
    const parsed = new URL(finalUrl);
    const link = parsed.searchParams.get('link');
    if (link) {
      try { return decodeURIComponent(link); } catch { return link; }
    }
  } catch {}
  const match = String(finalUrl || '').match(/[?&]link=([^&]+)/i);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }
  return finalUrl;
}

async function extractHubCloud(url, context, depth = 0) {
  if (depth > 3) return [];
  try {
    const first = await requestText(url, {}, { ...context, timeoutMs: 9000 });
    if (!first.response.ok) return [];
    let downloadUrl = url;
    if (!/hubcloud\.php/i.test(url)) {
      const links = anchors(first.text, first.url);
      const download = links.find((link) => /(?:hubcloud\.php|download)/i.test(link.url) && link.url !== url);
      if (!download) return [];
      downloadUrl = download.url;
    }
    const page = downloadUrl === url && /hubcloud\.php/i.test(url)
      ? first
      : await requestText(downloadUrl, {}, { ...context, timeoutMs: 9000 });
    if (!page.response.ok) return [];
    const header = pageHeader(page.text);
    const size = pageSize(page.text);
    const quality = qualityOf(header, page.text.slice(0, 3000));
    const pxl = page.text.match(/var\s+pxl\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    let links = anchors(page.text, page.url).filter((link) => /(?:btn|download)/i.test(`${link.attrs} ${link.text}`));
    if (!links.length) links = anchors(page.text, page.url);
    if (pxl) {
      const pixel = { url: absoluteUrl(pxl, page.url), href: pxl, text: 'PixelServer', attrs: 'class="btn"', index: -1 };
      const existing = links.find((link) => /pixeldrain/i.test(link.url));
      if (existing) existing.url = pixel.url;
      else links.unshift(pixel);
    }
    const output = [];
    const seen = new Set();
    for (const link of links.slice(0, 10)) {
      let target = link.url;
      if (!validStreamUrl(target) && !/hubcloud|buzzserver|dl\.php/i.test(target)) continue;
      if (/hubcloud\.cx\/tg|\/tg\/go/i.test(target)) continue;
      if (/buzzserver/i.test(target)) {
        try {
          const buzz = await requestText(`${target.replace(/\/$/, '')}/download`, { headers: { Referer: target } }, { ...context, timeoutMs: 8000, readBody: false });
          target = buzz.response.headers.get('hx-redirect') || buzz.response.headers.get('location') || finalLinkFromResponse(buzz, target);
          target = absoluteUrl(target, buzz.url);
        } catch { continue; }
      } else if (/10\s*gbps|pixel\.hubcloud|dl\.php/i.test(`${link.text} ${target}`)) {
        try {
          const resolved = await requestText(target, {}, { ...context, timeoutMs: 9000, readBody: false });
          target = finalLinkFromResponse(resolved, target);
        } catch { continue; }
      }
      target = pixeldrainUrl(target);
      if (!validStreamUrl(target) || seen.has(target)) continue;
      seen.add(target);
      const title = `${header || '4KHDHub release'}${size ? `\n${size}` : ''}`;
      const name = `4KHDHub - ${link.text || 'HubCloud'} - ${quality}`;
      const headers = {};
      try {
        const host = new URL(target).hostname;
        if (/\.r2\.dev$/i.test(host)) {
          headers.Referer = `${new URL(target).origin}/`;
          headers.Origin = new URL(target).origin;
        }
      } catch {}
      const row = streamRow('4khdhub', target, title, quality, { name, headers });
      if (row) output.push(row);
    }
    return output;
  } catch {
    return [];
  }
}

async function extractHubDrive(url, context, depth = 0) {
  if (depth > 3) return [];
  try {
    const page = await requestText(url, {}, { ...context, timeoutMs: 9000 });
    if (!page.response.ok || /file not found/i.test(pageHeader(page.text))) return [];
    const header = pageHeader(page.text);
    const size = pageSize(page.text);
    const quality = qualityOf(header, page.text.slice(0, 3000));
    const links = anchors(page.text, page.url);
    const download = links.find((link) => /btn-primary|btn-user|btn-success1|download/i.test(`${link.attrs} ${link.text}`)) || links[0];
    if (!download) return [];
    if (/hubcloud/i.test(download.url)) return extractHubCloud(download.url, context, depth + 1);
    const target = pixeldrainUrl(download.url);
    const row = streamRow('4khdhub', target, `${header || '4KHDHub release'}${size ? `\n${size}` : ''}`, quality, {
      name: `4KHDHub - HubDrive - ${quality}`
    });
    return row ? [row] : [];
  } catch {
    return [];
  }
}

async function resolve4kLink(url, context, depth = 0) {
  if (depth > 3 || !url) return [];
  let target = url;
  if (!/(?:hubcloud\.php|hubdrive|hubcloud)/i.test(target) && /[?&]id=|modrefer|modpro|redirector/i.test(target)) {
    const resolved = await resolveRedirector(target, context);
    if (resolved) target = resolved;
  }
  if (/hubdrive/i.test(target)) return extractHubDrive(target, context, depth + 1);
  if (/hubcloud/i.test(target)) return extractHubCloud(target, context, depth + 1);
  if (validStreamUrl(target) && (isProbablyFileUrl(target) || /pixeldrain|r2\.dev|fsl|111477\.xyz/i.test(target))) {
    const row = streamRow('4khdhub', pixeldrainUrl(target), fileTitleFromUrl(target), qualityOf(target), { name: '4KHDHub Direct Link' });
    return row ? [row] : [];
  }
  try {
    const page = await requestText(target, {}, { ...context, timeoutMs: 8000 });
    const links = anchors(page.text, page.url);
    for (const link of links) {
      if (/hubcloud|hubdrive|pixeldrain|r2\.dev|fsl/i.test(link.url)) return resolve4kLink(link.url, context, depth + 1);
    }
  } catch {}
  return [];
}

function isProbablyFileUrl(url) {
  return /\.(?:mkv|mp4|avi|webm|mov|m3u8)(?:$|[?#])/i.test(String(url || ''));
}

function fileTitleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || '4KHDHub release');
    return name.replace(/\.(?:mkv|mp4|avi|webm|mov)$/i, '').replace(/[._-]+/g, ' ');
  } catch { return '4KHDHub release'; }
}

async function extract4khdhub(metadata, context) {
  if (!metadata.title) return [];
  const base = await resolve4kBase(context);
  const search = await requestText(`${base}/?s=${encodeURIComponent(metadata.title)}`, {}, { ...context, timeoutMs: 9000 });
  if (!search.response.ok) return [];
  const candidates = anchors(search.text, search.url).filter((link) => link.text.length > 1 && !/(?:facebook|twitter|telegram|whatsapp|login|register)/i.test(`${link.text} ${link.url}`));
  const match = bestTitleMatch(candidates, metadata, (row) => `${row.text} ${row.url}`);
  if (!match) return [];
  const page = await requestText(match.url, {}, { ...context, timeoutMs: 9000 });
  if (!page.response.ok) return [];
  let links = anchors(page.text, page.url).filter((link) => /(?:hubdrive|hubcloud|drive|download|redirect|[?&]id=)/i.test(`${link.url} ${link.text} ${link.attrs}`));
  if (metadata.type === 'tv') {
    // Episode numbers usually live in a sibling badge, not in the anchor text.
    // Scope anchors to the requested season/episode DIV before using the
    // looser S01E01 fallback; otherwise every episode's MKV gets returned.
    const seasonBlocks = divBlocks(page.text, 'season-item');
    const scopedLinks = [];
    for (const seasonBlock of seasonBlocks) {
      const seasonMatch = seasonBlock.text.match(/\bseason\s*0*(\d+)/i) || seasonBlock.text.match(/\bS0*(\d+)\b/i);
      if (seasonMatch && Number(seasonMatch[1]) !== metadata.season) continue;
      const episodeBlocks = divBlocks(seasonBlock.html, 'episode-download-item');
      for (const episodeBlock of episodeBlocks) {
        const episodeMatch = episodeBlock.text.match(/Episode[-\s]*0*(\d+)/i) || episodeBlock.text.match(/\bE0*(\d+)\b/i);
        if (episodeMatch && Number(episodeMatch[1]) !== metadata.episode) continue;
        scopedLinks.push(...anchors(episodeBlock.html, page.url));
      }
    }
    if (scopedLinks.length) {
      links = scopedLinks.filter((link) => /(?:hubdrive|hubcloud|drive|download|redirect|[?&]id=)/i.test(`${link.url} ${link.text} ${link.attrs}`));
    } else {
      const seasonTag = new RegExp(`s0*${metadata.season}(?:\\D|$)`, 'i');
      const episodeTag = new RegExp(`(?:e|episode[-\\s]*)0*${metadata.episode}(?:\\D|$)`, 'i');
      const exact = links.filter((link) => seasonTag.test(`${link.text} ${link.url}`) && episodeTag.test(`${link.text} ${link.url}`));
      if (exact.length) links = exact;
      else {
        const episodeOnly = links.filter((link) => episodeTag.test(`${link.text} ${link.url}`));
        if (episodeOnly.length) links = episodeOnly;
      }
    }
  }
  const output = [];
  for (const link of links.slice(0, 8)) {
    const rows = await resolve4kLink(link.url, context);
    output.push(...rows);
  }
  return dedupeStreams(output);
}

/* ------------------------------------------------------------------------- */
/* DahmerMovies directory listings                                            */
/* ------------------------------------------------------------------------- */

async function extractDahmermovies(metadata, context) {
  if (!metadata.title) return [];
  const base = String(context.dahmerBaseUrl || 'https://a.111477.xyz').replace(/\/+$/, '');
  const worker = String(context.dahmerWorkerUrl || 'https://p.111477.xyz/bulk?u=');
  const cleanTitle = metadata.title.replace(/:/g, '');
  const paths = metadata.type === 'tv'
    ? [`/tvs/${encodeURIComponent(cleanTitle)}/Season%20${String(metadata.season).padStart(2, '0')}/`, `/tvs/${encodeURIComponent(cleanTitle)}/Season%20${metadata.season}/`]
    : [`/movies/${encodeURIComponent(`${cleanTitle} (${metadata.year})`)}/`];
  for (const path of paths) {
    try {
      const directoryUrl = `${base}${path}`;
      const result = await requestText(directoryUrl, { headers: { Referer: `${base}/` } }, { ...context, timeoutMs: 9000 });
      if (!result.response.ok) continue;
      const rows = [];
      for (const anchor of anchors(result.text, directoryUrl)) {
        if (!/\.(?:mkv|mp4|avi|webm|m3u8)$/i.test(anchor.text)) continue;
        if (metadata.type === 'tv') {
          const ep = new RegExp(`s0*${metadata.season}e0*${metadata.episode}|e0*${metadata.episode}`, 'i');
          if (!ep.test(anchor.text)) continue;
        }
        const direct = anchor.url;
        const url = `${worker}${encodeURI(direct)}`;
        const title = `${anchor.text} | ${qualityOf(anchor.text)} | ${anchor.text}`;
        const row = streamRow('dahmermovies', url, title, qualityOf(anchor.text), {
          name: 'DahmerMovies',
          headers: { Referer: `${base}/`, 'User-Agent': USER_AGENT }
        });
        if (row) rows.push(row);
      }
      if (rows.length) return dedupeStreams(rows).slice(0, 8);
    } catch {}
  }
  return [];
}

/* ------------------------------------------------------------------------- */
/* HDGharTV JSON API                                                          */
/* ------------------------------------------------------------------------- */

async function extractHdghartv(metadata, context) {
  if (!metadata.title) return [];
  const base = String(context.hdghartvBaseUrl || 'https://hdghartv.cc/api').replace(/\/+$/, '');
  const headers = { Referer: `${new URL(base).origin}/`, Accept: 'application/json, */*' };
  const search = await requestJson(`${base}/search?q=${encodeURIComponent(metadata.title)}`, { headers }, { ...context, timeoutMs: 9000 });
  const collection = metadata.type === 'movie' ? search.json.movies : search.json.series;
  const match = bestTitleMatch(Array.isArray(collection) ? collection : [], metadata, (row) => row.title || row.name || '');
  if (!match || !match._id) return [];
  const detailUrl = metadata.type === 'movie' ? `${base}/movies/public/${match._id}` : `${base}/series/public/${match._id}`;
  const detail = await requestJson(detailUrl, { headers }, { ...context, timeoutMs: 9000 });
  let links = [];
  if (metadata.type === 'movie') links = detail.json.streamingLinks || [];
  else {
    const season = (detail.json.seasons || []).find((entry) => Number(entry.seasonNumber) === metadata.season);
    const episode = season && (season.episodes || []).find((entry) => Number(entry.episodeNumber) === metadata.episode);
    links = episode ? episode.streamingLinks || [] : [];
  }
  return dedupeStreams(links.filter((link) => link && link.isActive !== false && link.url).map((link) => {
    const quality = link.quality || qualityOf(link.url, link.title);
    const languageText = [link.language, link.lang, link.audioLanguage, link.audio, link.dub].filter(Boolean).join(' ');
    const title = `${match.title || metadata.title} ${languageText} ${link.title || ''} ${quality}`.trim();
    const audioTracks = Array.isArray(link.audioTracks) ? link.audioTracks : undefined;
    return streamRow('hdghartv', link.url, title, quality, {
      name: `HDGharTV${languageText ? ` ${languageText}` : ''}`,
      headers,
      audioTracks,
      subtitles: link.subtitles || link.captions
    });
  }).filter(Boolean));
}

/* ------------------------------------------------------------------------- */
/* NetMirror                                                                  */
/* ------------------------------------------------------------------------- */

function netmirrorRows(data, metadata, base, context = {}) {
  const subtitles = (data.captions || []).filter((caption) => caption && caption.url).map((caption, index) => ({
    id: `netmirror-${index}`,
    url: absoluteUrl(caption.url, base),
    lang: caption.lang || 'und',
    label: caption.name || caption.lang || 'Subtitles'
  }));
  const rows = [];
  for (const source of data.streams || []) {
    if (!source || !source.url) continue;
    const quality = source.resolution ? `${source.resolution}p` : source.quality || 'Auto';
    const title = `${metadata.title} ${source.language || source.lang || ''} ${quality}`.trim();
    rows.push(streamRow('netmirror', source.url, title, quality, {
      name: `NetMirror | ${source.language || source.lang || 'Netflix'}`,
headers: { Referer: contextNetmirrorReferer(context), 'User-Agent': USER_AGENT },
      subtitles,
      audioTracks: source.audioTracks || data.audioTracks
    }));
  }
  if (!rows.length && data.mp4) rows.push(streamRow('netmirror', data.mp4, `${metadata.title} Auto`, 'Auto', {
    name: 'NetMirror | Netflix', headers: { Referer: contextNetmirrorReferer(context), 'User-Agent': USER_AGENT }, subtitles
  }));
  return rows.filter(Boolean);
}

function contextNetmirrorReferer(context = {}) {
  // Keep NetMirror's playback Referer distinct from its API origin.  The
  // upstream provider uses this video-gateway Referer for the direct CDN;
  // sending net27.cc here can resolve a URL which then fails during playback.
  return String(context.netmirrorStreamReferer || 'https://videodownloader.site/').replace(/\/+$/, '') + '/';
}

async function extractNetmirror(metadata, context) {
  const base = String(context.netmirrorApiBase || 'https://net27.cc').replace(/\/+$/, '');
  const url = metadata.type === 'tv'
    ? `${base}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}?type=tv&se=${metadata.season}&ep=${metadata.episode}`
    : `${base}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}`;
  try {
    const result = await requestJson(url, { headers: { Referer: `${base}/`, Accept: 'application/json, text/plain, */*' } }, { ...context, timeoutMs: 12000 });
    if (result.json && result.json.ok === true) {
      const rows = netmirrorRows(result.json, metadata, base, context);
      if (rows.length) {
        // A master playlist can carry languages which are not present in the
        // JSON title.  Read only the first few manifests, never media segments.
        const enriched = await Promise.all(rows.slice(0, 3).map((row) => enrichHlsRow(row, context)));
        return dedupeStreams([...enriched, ...rows.slice(3)]);
      }
    }
  } catch {}
  return extractNetmirrorNewTv(metadata, context);
}

const NEW_TV_DOMAINS = [
  'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==', 'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==', 'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr', 'aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=', 'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=', 'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl', 'aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==', 'aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg=='
];

function newTvHeaders(ott, extra = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'NetmirrorNewTV v1.0',
    Ott: ott,
    'Cache-Control': 'no-cache',
    ...extra
  };
}

async function extractNetmirrorNewTv(metadata, context) {
  if (!metadata.title || context.netmirrorNewTv === false) return [];
  const platforms = [['netflix', 'nf'], ['primevideo', 'pv'], ['hotstar', 'hs'], ['disney', 'hs']];
  let api = '';
  const custom = String(context.newTvDomains || '').split(',').map((value) => value.trim()).filter(Boolean);
  const domains = [...custom, ...NEW_TV_DOMAINS.map((value) => { try { return base64Text(value); } catch { return ''; } }).filter(Boolean)];
  for (const domain of domains) {
    try {
      const result = await requestJson(`${domain.replace(/\/+$/, '')}/checknewtv.php`, { headers: newTvHeaders('nf') }, { ...context, timeoutMs: 5000 });
      if (result.json.token_hash) { api = base64Text(result.json.token_hash).replace(/\/+$/, ''); break; }
    } catch {}
  }
  if (!api) return [];
  const rows = [];
  for (const [platform, ott] of platforms) {
    try {
      const search = await requestJson(`${api}/newtv/search.php?s=${encodeURIComponent(metadata.title)}`, { headers: newTvHeaders(ott) }, { ...context, timeoutMs: 8000 });
      const first = (search.json.searchResult || [])[0];
      if (!first || !first.id) continue;
      const post = await requestJson(`${api}/newtv/post.php?id=${encodeURIComponent(first.id)}`, { headers: newTvHeaders(ott, { Lastep: '', Usertoken: '' }) }, { ...context, timeoutMs: 8000 });
      let targetId = first.id;
      if (metadata.type === 'tv') {
        const selectedSeason = Array.isArray(post.json.season) ? post.json.season.findIndex((entry) => entry.selected) : -1;
        const episodes = (post.json.episodes || []).filter(Boolean).map((entry) => ({
          id: entry.id,
          season: selectedSeason >= 0 ? selectedSeason + 1 : Number(entry.sNum || entry.s),
          episode: Number(entry.ep || entry.epNum)
        }));
        const target = episodes.find((entry) => Number(entry.season) === metadata.season && Number(entry.episode) === metadata.episode);
        if (!target) continue;
        targetId = target.id;
      } else if (post.json.type === 't' || (post.json.episodes || []).filter(Boolean).length) continue;
      else targetId = post.json.main_id || first.id;
      const player = await requestJson(`${api}/newtv/player.php?id=${encodeURIComponent(targetId)}`, { headers: newTvHeaders(ott, { Usertoken: '' }) }, { ...context, timeoutMs: 8000 });
      if (!player.json.video_link) continue;
      const row = streamRow('netmirror', player.json.video_link, `${metadata.title} ${platform} Auto`, 'Auto', {
        name: `NetMirror | ${platform}`,
        headers: { Referer: player.json.referer || api, 'User-Agent': USER_AGENT }
      });
      if (row) rows.push(row);
    } catch {}
  }
  return dedupeStreams(rows);
}

/* ------------------------------------------------------------------------- */
/* CastleTV: AES-CBC API + one file per language track                       */
/* ------------------------------------------------------------------------- */

const CASTLE_BASE = 'https://api.hlowb.com';
const CASTLE_PACKAGE = 'com.external.castle';
const CASTLE_CHANNEL = 'IndiaA';

async function castleSecurityKey(context) {
  const base = context.castleBaseUrl || CASTLE_BASE;
  const result = await requestJson(`${base}/v0.1/system/getSecurityKey/1?channel=${CASTLE_CHANNEL}&clientType=1&lang=en-US`, { headers: { Referer: base, 'User-Agent': 'okhttp/4.9.3' } }, { ...context, timeoutMs: 9000 });
  if (!result.json.data) throw new Error('CastleTV security key missing');
  return result.json.data;
}

async function castleDecrypted(url, securityKey, options, context) {
  const result = await requestText(url, options, { ...context, timeoutMs: 10000 });
  if (!result.response.ok) throw new Error(`CastleTV HTTP ${result.response.status}`);
  let cipher = result.text.trim();
  try {
    const parsed = JSON.parse(cipher);
    if (parsed && typeof parsed.data === 'string') cipher = parsed.data.trim();
  } catch {}
  const keyBytes = base64Bytes(securityKey);
  const suffix = utf8Bytes('T!BgJB');
  let combined = concatBytes(keyBytes, suffix);
  if (combined.length < 16) combined = concatBytes(combined, new Uint8Array(16 - combined.length));
  const key = combined.slice(0, 16);
  return safeJson(await aesCbcDecrypt(cipher, key, key));
}

function castleStreams(raw, metadata, language, resolution) {
  const data = unwrapData(raw) || {};
  const qualityDefault = ({ 1: '480p', 2: '720p', 3: '1080p', 4: '4K' })[resolution] || 'Auto';
  const subtitles = (data.subtitles || []).filter((sub) => sub && sub.url).map((sub, index) => ({
    id: `castle-${index}`, url: sub.url.replace(/ /g, '%20'), lang: sub.abbreviate || sub.title || 'und', label: sub.title || sub.abbreviate || 'Subtitles'
  }));
  const videos = Array.isArray(data.videos) && data.videos.length ? data.videos : (data.videoUrl ? [{ url: data.videoUrl, resolutionDescription: data.resolutionDescription, size: data.size }] : []);
  return videos.map((video) => {
    const url = video.url || data.videoUrl;
    const quality = qualityOf(video.resolutionDescription, video.quality, url) !== 'Auto'
      ? qualityOf(video.resolutionDescription, video.quality, url)
      : (({ 1: '480p', 2: '720p', 3: '1080p', 4: '4K' })[Number(video.resolution)] || qualityDefault);
    const langLabel = language ? `[${language}]` : '';
    return streamRow('castletv', url, `${metadata.title} ${langLabel}\n${quality} | Castle`, quality, {
      name: `CastleTV ${langLabel} | ${quality}`,
      headers: { Referer: CASTLE_BASE, 'User-Agent': USER_AGENT },
      subtitles
    });
  }).filter(Boolean);
}

async function extractCastletv(metadata, context) {
  if (!metadata.title) return [];
  const base = context.castleBaseUrl || CASTLE_BASE;
  const securityKey = await castleSecurityKey(context);
  const searchParams = new URLSearchParams({ channel: CASTLE_CHANNEL, clientType: '1', keyword: metadata.title, lang: 'en-US', mode: '1', packageName: CASTLE_PACKAGE, page: '1', size: '30' });
  const search = await castleDecrypted(`${base}/film-api/v1.1.0/movie/searchByKeyword?${searchParams}`, securityKey, { headers: { Referer: base, 'User-Agent': 'okhttp/4.9.3' } }, context);
  const rows = (unwrapData(search).rows || []);
  const match = bestTitleMatch(rows, metadata, (row) => row.title || row.name || '') || rows[0];
  if (!match) return [];
  const id = String(match.id || match.redirectId || match.redirectIdStr || '');
  if (!id) return [];
  let details = await castleDecrypted(`${base}/film-api/v1.9.9/movie?channel=${CASTLE_CHANNEL}&clientType=1&lang=en-US&movieId=${encodeURIComponent(id)}&packageName=${CASTLE_PACKAGE}`, securityKey, { headers: { Referer: base, 'User-Agent': 'okhttp/4.9.3' } }, context);
  let activeId = id;
  if (metadata.type === 'tv') {
    const season = (unwrapData(details).seasons || []).find((entry) => Number(entry.number) === metadata.season);
    if (season && season.movieId && String(season.movieId) !== id) {
      activeId = String(season.movieId);
      details = await castleDecrypted(`${base}/film-api/v1.9.9/movie?channel=${CASTLE_CHANNEL}&clientType=1&lang=en-US&movieId=${encodeURIComponent(activeId)}&packageName=${CASTLE_PACKAGE}`, securityKey, { headers: { Referer: base, 'User-Agent': 'okhttp/4.9.3' } }, context);
    }
  }
  const episodes = unwrapData(details).episodes || [];
  const episode = metadata.type === 'tv'
    ? episodes.find((entry) => Number(entry.number) === metadata.episode)
    : episodes[0];
  const episodeId = episode && (episode.id || episode.episodeId);
  if (!episodeId) return [];
  const tracks = (episode.tracks || []).filter((track) => track.existIndividualVideo !== false);
  const output = [];
  const jobs = tracks.length ? tracks : [null];
  await Promise.all(jobs.map(async (track) => {
    await Promise.all([3, 2, 1].map(async (resolution) => {
      try {
        const body = {
          mode: '1', appMarket: 'GuanWang', clientType: '1', woolUser: 'false',
          apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475', androidVersion: '13',
          movieId: activeId, episodeId: String(episodeId),
          ...(track ? { languageId: String(track.languageId) } : {}),
          isNewUser: 'true', resolution: String(resolution), packageName: CASTLE_PACKAGE
        };
        const raw = await castleDecrypted(`${base}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=${CASTLE_PACKAGE}&channel=${CASTLE_CHANNEL}&lang=en-US`, securityKey, {
          method: 'POST', headers: { Referer: base, 'User-Agent': 'okhttp/4.9.3', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }, context);
        output.push(...castleStreams(raw, metadata, track && (track.languageName || track.abbreviate), resolution));
      } catch {}
    }));
  }));
  // Some titles advertise language tracks but only the shared endpoint has a
  // playable video.  Match upstream's fallback instead of returning zero.
  if (output.length === 0 && tracks.length > 0) {
    await Promise.all([3, 2, 1].map(async (resolution) => {
      try {
        const body = {
          mode: '1', appMarket: 'GuanWang', clientType: '1', woolUser: 'false',
          apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475', androidVersion: '13',
          movieId: activeId, episodeId: String(episodeId), isNewUser: 'true',
          resolution: String(resolution), packageName: CASTLE_PACKAGE
        };
        const raw = await castleDecrypted(`${base}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=${CASTLE_PACKAGE}&channel=${CASTLE_CHANNEL}&lang=en-US`, securityKey, {
          method: 'POST', headers: { Referer: base, 'User-Agent': 'okhttp/4.9.3', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }, context);
        output.push(...castleStreams(raw, metadata, '', resolution));
      } catch {}
    }));
  }
  return dedupeStreams(output);
}

/* ------------------------------------------------------------------------- */
/* Showbox / FebBox / PStream                                                 */
/* ------------------------------------------------------------------------- */

function cookieValue(context) {
  const value = context.febboxCookies || context.febboxCookie || '';
  const first = Array.isArray(value) ? value[0] : String(value).split(',')[0];
  return String(first || '').trim().replace(/^ui=/, '');
}

function febboxFileEntries(html) {
  return divBlocks(html, 'file').map((block) => {
    const openingTag = block.html.match(/^<div\b[^>]*>/i)?.[0] || '';
    const classes = attribute(openingTag, 'class');
    const nameMatch = block.html.match(/<p\b[^>]*class=["'][^"']*file_name[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const name = textOf(nameMatch ? nameMatch[1] : attribute(openingTag, 'data-path') || block.text);
    return {
      id: attribute(openingTag, 'data-id'),
      name,
      folder: /(?:^|\s)open_dir(?:\s|$)/i.test(classes),
      html: block.html
    };
  }).filter((entry) => /^\d+$/.test(entry.id));
}

function episodeNumberFromName(name) {
  const text = String(name || '');
  const match = text.match(/s\d{1,2}e(\d{1,3})/i) || text.match(/episode[-\s_]*0*(\d{1,3})/i) || text.match(/\be0*(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

async function febboxFolderEntries(shareKey, parentId, shareUrl, cookie, context) {
  const origin = new URL(shareUrl).origin;
  const result = await requestText(`${origin}/file/file_share_list?share_key=${encodeURIComponent(shareKey)}&parent_id=${encodeURIComponent(parentId)}&is_html=1&pwd=`, {
    headers: { Referer: shareUrl, 'X-Requested-With': 'XMLHttpRequest', ...(cookie ? { Cookie: `ui=${cookie}` } : {}) }
  }, { ...context, timeoutMs: 10000 });
  if (!result.response.ok) return [];
  let html = result.text;
  try {
    const parsed = JSON.parse(result.text);
    html = parsed.html || (parsed.data && parsed.data.html) || '';
  } catch {}
  return html ? febboxFileEntries(html) : [];
}

function pstreamRows(data, metadata) {
  const rows = [];
  const add = (url, quality, label) => {
    const row = streamRow('showbox', url, `${metadata.title} ${label || quality || 'Auto'}`, quality || qualityOf(label, url), {
      name: `Showbox ${label || quality || ''}`.trim(), headers: {}
    });
    if (row) rows.push(row);
  };
  if (data && data.streams && typeof data.streams === 'object' && !Array.isArray(data.streams)) {
    for (const [quality, url] of Object.entries(data.streams)) if (typeof url === 'string') add(url, qualityOf(quality), quality);
  }
  for (const source of (data && Array.isArray(data.sources) ? data.sources : [])) add(source.url || source.file, source.quality || qualityOf(source.label), source.label || source.quality);
  for (const source of (data && Array.isArray(data.data) ? data.data : [])) add(source.url || source.file, source.quality || qualityOf(source.label), source.label || source.quality);
  return rows;
}

async function extractShowbox(metadata, context) {
  const rows = [];
  const cookie = cookieValue(context);
  if (metadata.imdbId) {
    try {
      const base = String(context.pstreamBaseUrl || 'https://fed-api.pstream.mov').replace(/\/+$/, '');
      const url = metadata.type === 'movie'
        ? `${base}/movie/${encodeURIComponent(metadata.imdbId)}`
        : `${base}/tv/${encodeURIComponent(metadata.imdbId)}/${metadata.season}/${metadata.episode}`;
      const result = await requestJson(url, { headers: {
        accept: 'pstream.org', origin: 'https://pstream.mov',
        referer: `https://pstream.mov/media/tmdb-${metadata.type}-${metadata.imdbId}`,
        region: context.febboxRegion || 'East', ...(cookie ? { 'ui-token': cookie } : {})
      } }, { ...context, timeoutMs: 12000 });
      rows.push(...pstreamRows(result.json, metadata));
    } catch {}
  }
  const pstreamHints = rows.map((row) => parseAudioLanguageHints(`${row.name || ''} ${row.title || ''}`));
  const pstreamLanguages = new Set(pstreamHints.flatMap((hint) => hint.languages.map((language) => language.code)));
  // One English/Original file is not a multi-audio answer.  Only an explicit
  // dual/multi marker or distinct language rows may skip the FebBox fallback.
  const pstreamHasAudioEvidence = pstreamHints.some((hint) => hint.multi) || pstreamLanguages.size > 1;
  if (rows.length && context.showboxFebbox !== true && (context.showboxFebbox === false || pstreamHasAudioEvidence)) return dedupeStreams(rows);
  if (!metadata.title) return dedupeStreams(rows);

  // FebBox's public share flow works without a cookie for shares which permit
  // it; when a cookie is configured on the Worker it is used for gated shares.
  const showboxBase = String(context.showboxBaseUrl || 'https://www.showbox.media').replace(/\/+$/, '');
  const slug = slugify(metadata.title);
  if (!slug || !metadata.year) return dedupeStreams(rows);
  const pageUrl = `${showboxBase}/${metadata.type === 'movie' ? 'movie' : 'tv'}/${metadata.type === 'movie' ? 'm' : 't'}-${slug}-${metadata.year}`;
  try {
    const page = await requestText(pageUrl, {}, { ...context, timeoutMs: 10000 });
    if (!page.response.ok) return dedupeStreams(rows);
    const shareUrls = [...new Set((page.text.match(/https?:\/\/(?:www\.)?febbox\.com\/share\/[a-z0-9-]+/gi) || []).map((value) => value.replace(/["'<].*$/, '')))];
    let contentId = pageUrl.match(/\/detail\/(\d+)/)?.[1] || '';
    let contentType = metadata.type === 'movie' ? '1' : '2';
    if (!contentId) {
      const detailHref = page.text.match(/\/(?:movie|tv)\/detail\/(\d+)/i);
      if (detailHref) contentId = detailHref[1];
    }
    if (!shareUrls.length && contentId) {
      try {
        const share = await requestJson(`${showboxBase}/index/share_link?id=${encodeURIComponent(contentId)}&type=${contentType}`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } }, { ...context, timeoutMs: 9000 });
        if (share.json.code === 1 && share.json.data && share.json.data.link) shareUrls.push(share.json.data.link);
      } catch {}
    }
    for (const shareUrl of shareUrls.slice(0, 2)) {
      const share = await requestText(shareUrl, { headers: cookie ? { Cookie: `ui=${cookie}` } : {} }, { ...context, timeoutMs: 10000 });
      if (!share.response.ok) continue;
      const shareKey = shareUrl.match(/\/share\/([a-z0-9-]+)/i)?.[1] || share.text.match(/(?:share_key|shareid)\s*[:=]\s*["']?([a-z0-9-]+)/i)?.[1];
      if (!shareKey) continue;
      const directSources = parseSourcesAssignment(share.text);
      for (const source of directSources) {
        const row = streamRow('showbox', source.file || source.url, `${metadata.title} ${source.label || 'Original'}`, qualityOf(source.label), {
          name: `Showbox ${source.label || ''}`.trim(), headers: cookie ? { Cookie: `ui=${cookie}`, Referer: shareUrl } : { Referer: shareUrl }
        });
        if (row) rows.push(row);
      }
      let fileEntries = febboxFileEntries(share.text);
      if (metadata.type === 'tv') {
        const folders = fileEntries.filter((entry) => entry.folder);
        if (folders.length) {
          const seasonFolder = folders.find((entry) => {
            const match = entry.name.match(/\bseason\s*0*(\d+)/i) || entry.name.match(/\bs0*(\d+)\b/i);
            return match && Number(match[1]) === metadata.season;
          }) || folders[metadata.season - 1];
          if (!seasonFolder) continue;
          try {
            fileEntries = await febboxFolderEntries(shareKey, seasonFolder.id, shareUrl, cookie, context);
          } catch { fileEntries = []; }
        }
        const files = fileEntries.filter((entry) => !entry.folder);
        const numbered = files.filter((entry) => episodeNumberFromName(entry.name) !== null);
        const selected = numbered.length
          ? files.filter((entry) => episodeNumberFromName(entry.name) === metadata.episode)
          : (files.length > metadata.episode - 1 ? [files[metadata.episode - 1]] : []);
        fileEntries = selected;
      } else {
        fileEntries = fileEntries.filter((entry) => !entry.folder);
      }
      const fids = fileEntries.map((entry) => entry.id);
      const shareOrigin = new URL(shareUrl).origin;
      for (const fid of [...new Set(fids)].slice(0, 6)) {
        try {
          const player = await requestText(`${shareOrigin}/file/player`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
              Origin: shareOrigin, Referer: shareUrl, ...(cookie ? { Cookie: `ui=${cookie}` } : {})
            },
            body: new URLSearchParams({ fid, share_key: shareKey }).toString()
          }, { ...context, timeoutMs: 12000 });
          if (!player.response.ok) continue;
          for (const source of parseSourcesAssignment(player.text)) {
            const row = streamRow('showbox', source.file || source.url, `${metadata.title} ${source.label || 'Original'}`, qualityOf(source.label), {
              name: `Showbox ${source.label || ''}`.trim(), headers: { Referer: shareUrl, ...(cookie ? { Cookie: `ui=${cookie}` } : {}) }
            });
            if (row) rows.push(row);
          }
        } catch {}
      }
    }
  } catch {}
  return dedupeStreams(rows);
}

/* ------------------------------------------------------------------------- */
/* OneTouchTV: encrypted JSON API (optional Wave 2 fallback)                  */
/* ------------------------------------------------------------------------- */

async function oneTouchDecrypted(path, context) {
  const base = context.oneTouchBaseUrl || 'https://api3.devcorp.me';
  const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;
  const result = await requestText(url, { headers: { Referer: 'https://onetouchtv.xyz/' } }, { ...context, timeoutMs: 10000 });
  if (!result.response.ok) throw new Error(`OneTouchTV HTTP ${result.response.status}`);
  // The mirror wraps its base64 alphabet in a short transport-safe encoding.
  // Keep the replacement deliberately literal; this is also what the upstream
  // provider does before handing the value to AES-256-CBC.
  const encoded = result.text.replace(/-_\./g, '/').replace(/@/g, '+').replace(/\s+/g, '');
  const key = utf8Bytes('im72charPasswordofdInitVectorStm');
  const iv = utf8Bytes('im72charPassword');
  const plain = await aesCbcDecrypt(encoded, key, iv);
  return safeJson(plain).result;
}

async function extractOnetouchtv(metadata, context) {
  if (!metadata.title) return [];
  try {
    const base = context.oneTouchBaseUrl || 'https://api3.devcorp.me';
    const search = await oneTouchDecrypted(`/vod/search?keyword=${encodeURIComponent(metadata.title)}`, context);
    const rows = Array.isArray(search) ? search : [];
    const match = bestTitleMatch(rows, metadata, (row) => row.title || '');
    if (!match || !match.id) return [];
    const detail = await oneTouchDecrypted(`/vod/${encodeURIComponent(match.id)}/detail`, context);
    const episodes = detail && detail.episodes || [];
    const episode = metadata.type === 'movie' ? episodes[0] : episodes.find((entry) => Number(entry.episode) === metadata.episode);
    if (!episode || !episode.playId) return [];
    const data = await oneTouchDecrypted(`/vod/${encodeURIComponent(match.id)}/episode/${encodeURIComponent(episode.playId)}`, context);
    const subtitles = (data && data.track || []).filter((track) => track.file).map((track) => ({ url: track.file, lang: track.name || 'und', label: track.name || 'Subtitles' }));
    return dedupeStreams((data && data.sources || []).map((source) => streamRow('onetouchtv', source.url, `${match.title} ${source.language || source.lang || ''} ${source.quality || 'Auto'}`, source.quality || qualityOf(source.quality, source.url), {
      name: `OneTouchTV ${source.name || ''}`.trim(), headers: { Referer: `${base}/`, 'User-Agent': USER_AGENT }, subtitles,
      audioTracks: source.audioTracks
    })).filter(Boolean));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------- */
/* Public fan-out                                                            */
/* ------------------------------------------------------------------------- */

const EXTRACTORS = {
  '4khdhub': extract4khdhub,
  castletv: extractCastletv,
  hdghartv: extractHdghartv,
  netmirror: extractNetmirror,
  dahmermovies: extractDahmermovies,
  showbox: extractShowbox,
  onetouchtv: extractOnetouchtv
};

function dedupeStreams(streams) {
  const seen = new Set();
  return (streams || []).filter((stream) => {
    if (!stream || !validStreamUrl(stream.url)) return false;
    const key = `${String(stream.provider || '').toLowerCase()}|${stream.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runExtractor(id, metadata, context) {
  const extractor = EXTRACTORS[id];
  if (!extractor) return { provider: id, streams: [], ms: 0 };
  const started = Date.now();
  const controller = new AbortController();
  const parent = context.signal;
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutMs = Math.max(500, Number(context.timeoutMs) || 20000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timeoutId;
  try {
    const promise = Promise.resolve().then(() => extractor(metadata, { ...context, signal: controller.signal }));
    // A custom fetch implementation may not honor AbortSignal.  The race keeps
    // one broken provider from holding the whole resolve open; its rejection is
    // still observed so it cannot become an unhandled rejection.
    promise.catch(() => {});
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve([]), timeoutMs);
    });
    const streams = await Promise.race([promise, timeout]);
    clearTimeout(timeoutId);
    return { provider: id, streams: dedupeStreams(streams), ms: Date.now() - started };
  } catch (error) {
    return { provider: id, streams: [], ms: Date.now() - started, error: error && error.message ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (timeoutId) clearTimeout(timeoutId);
    if (parent) parent.removeEventListener('abort', onAbort);
  }
}

/**
 * Resolve selected direct providers in parallel.  `providers` may be a string
 * or an array; unknown providers are ignored.  The return value is deliberately
 * similar to a TMDB-Embed-API response so goldmine.js can merge it without a
 * second normalization path.
 */
async function resolveDirectStreams(metadataInput, options = {}) {
  const metadata = metadataFor(metadataInput);
  const requested = options.providers || DIRECT_PROVIDER_IDS;
  const ids = [...new Set((Array.isArray(requested) ? requested : [requested]).map(providerId))].filter((id) => EXTRACTORS[id]);
  if (!ids.length || !metadata.tmdbId) return { streams: [], providerTimings: {}, errors: [] };
  const context = { ...options, timeoutMs: options.timeoutMs || 20000 };
  const results = await Promise.all(ids.map((id) => runExtractor(id, metadata, context)));
  const streams = [];
  const providerTimings = {};
  const errors = [];
  for (const result of results) {
    providerTimings[result.provider] = result.ms;
    if (result.error) errors.push({ provider: result.provider, error: result.error });
    streams.push(...result.streams);
  }
  return { streams: dedupeStreams(streams), providerTimings, errors };
}

module.exports = {
  DIRECT_PROVIDER_IDS,
  resolveDirectStreams,
  extract4khdhub,
  extractCastletv,
  extractHdghartv,
  extractNetmirror,
  extractDahmermovies,
  extractShowbox,
  extractOnetouchtv,
  // Exported for focused unit tests and for providers which already have a
  // playlist body but no JSON language fields.
  parseHlsAudioTracks,
  parseHlsSubtitleTracks,
  enrichHlsRow,
  // Pure helpers are useful to the resolver's regression tests.
  parseSourcesAssignment,
  pixeldrainUrl,
  resolveRedirector,
  extractHubCloud,
  extractHubDrive
};
