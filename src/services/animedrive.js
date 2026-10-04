/**
 * AnimeDrive — Hindi-dub anime release blog (server 2 / Centaurus source #3).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Centaurus already has HiCine (broad) and Anime Dub Hindi (Netflix-style
 * multi-audio). AnimeDrive covers the shows Anime Dub Hindi misses and — unlike
 * the Streamtape-only anime catalogs — its releases sit on the two hosts this
 * repo can already unroll, with real x264 480p/720p/1080p encodes instead of
 * HEVC-only:
 *
 *   search   : https://animedrive.cc/?s=<title>                 → WordPress posts
 *   post     : https://animedrive.cc/<slug>/                    → "Download / Watch"
 *   episodes : https://link.animedrive.cc/<yyyy>/<mm>/<dd>/<slug>/
 *              → "EP NN / Episode N" accordion blocks
 *              → per quality: HubCloud and GDFlix rows
 *   row link : https://link.animedrive.cc/dl/<base64url>
 *              → the payload is `base64url(reverse(targetUrl))` and the target
 *                is `https://hubcloud.ist/drive/<id>` or `https://gdflix.dev/file/<id>`
 *   build    : both hosts have verified unrollers in this repo already
 *              (hubcloud: /drive/<id> → Instant/Direct/DL; gdflix: /file/<id> →
 *               Instant 302 → direct file).
 *
 * Everything above was verified against the live site on 2026-10-04 (see
 * docs/hamster-wheel-upstream-research.md §10): the decoded targets were
 * `hubcloud.ist/drive/…` and `gdflix.dev/file/…`, and the `/dl/` payload really
 * is base64-of-reversed-URL (`NUNJMGpJcjZVbmRnYXBLL2VsaWYvdmVkLnhpbGZkZy8vOnNwdHRo`
 * → `https://gdflix.dev/file/KpagdnU6rIj0IC5`).
 *
 * PARSING STRATEGY
 * ----------------
 * The blog restyles its pages often, so — like the Anime Dub Hindi module —
 * this one walks the document in order and inlines every anchor into a text
 * stream instead of matching CSS classes. The *decoded target host* (not a
 * "☁️ HubCloud" heading) decides which server a row belongs to, and the most
 * recent "EP NN" marker decides which episode it belongs to. Rows that decode
 * to send.cm / 1fichier / StreamTape / FuckingFast / StreamWish are counted for
 * diagnostics and skipped.
 *
 * No network calls and no Node-only APIs live here: pure parsing + scoring, so
 * it is unit-testable against fixtures and Worker-portable. Shared helpers come
 * from ./animedubhindi (same site family, same token format).
 */

const {
  A_OPEN,
  A_MID,
  A_CLOSE,
  buildStream,
  extractAnchors,
  classifyHost,
  sortRows,
  parseSearchResults,
  pickBestPost
} = require('./animedubhindi');

/** `link.animedrive.cc/dl/<payload>` (also matches the live `/dl/<payload>?t=…`). */
const DL_PATH_RE = /\/dl\/([A-Za-z0-9_-]{8,})\/?$/;

const SOCIAL_HOST_RE =
  /(?:^|\.)(?:t\.me|telegram\.(?:me|org|dog)|whatsapp\.com|facebook\.com|fb\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|youtu\.be|pinterest\.[a-z.]+|reddit\.com|discord\.[a-z.]+)$/i;

const LAST_EPISODE_RE = /E(?:P|pisode)\s*[-._:№#]*\s*0*(\d{1,3})(?!\d)/i;
const ZIP_CONTEXT_RE = /full\s*zip|season\s*pack|complete\s*season|zip\s*download/i;
const NOT_FOUND_RE = /page\s+not\s+found|nothing\s+found|404\s+not\s+found|no\s+posts\s+found/i;

function base64Decode(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (!normalized) return '';
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    if (typeof atob === 'function') return atob(padded);
    if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('binary');
  } catch {
    return '';
  }
  return '';
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function absoluteUrl(href, base) {
  const value = String(href || '').trim();
  if (!value || /^(?:javascript:|data:|mailto:|#)/i.test(value)) return '';
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
}

/**
 * `/dl/<payload>` → the real release URL. The payload is base64url of the
 * *reversed* target; plain base64 also accepted defensively. Returns '' for
 * anything that is not a decodable http(s) URL.
 */
function decodeDlUrl(href, base = 'https://link.animedrive.cc/') {
  const url = absoluteUrl(href, base);
  if (!url) return '';
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const match = DL_PATH_RE.exec(pathname);
  if (!match) return '';
  const decoded = base64Decode(match[1]);
  if (!decoded) return '';
  const reversed = decoded.split('').reverse().join('');
  for (const candidate of [decoded, reversed]) {
    const value = String(candidate || '').trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(value)) return value;
  }
  return '';
}

/** Quality label → the fields the shared row scorer understands. */
function parseRowLabel(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const heightMatch = /(\d{3,4})\s*p\b/i.exec(text);
  const sizeMatch = /(\d+(?:\.\d+)?)\s*(mb|gb)\b/i.exec(text);
  return {
    label: text,
    height: Number(heightMatch && heightMatch[1]) || 0,
    isX264: /\bx264\b|avc/i.test(text),
    isHevc: /\bx265\b|h\.?265|hevc/i.test(text),
    isHq: /\bhq\b/i.test(text),
    sizeMb: sizeMatch
      ? Number(sizeMatch[1]) * (sizeMatch[2].toLowerCase() === 'gb' ? 1024 : 1)
      : 0
  };
}

/**
 * Post page → the `link.animedrive.cc/...` landing page. The slug is never
 * constructed; the button is followed. Related-post links (same host) and the
 * Telegram footer are excluded.
 */
function parsePostLink(html, postUrl) {
  const baseHost = hostOf(postUrl);
  if (!baseHost) return '';
  const anchors = extractAnchors(buildStream(html, postUrl));
  const scored = [];
  for (const anchor of anchors) {
    const url = absoluteUrl(anchor.href, postUrl);
    if (!url) continue;
    const host = hostOf(url);
    if (!host || SOCIAL_HOST_RE.test(host)) continue;
    const label = String(anchor.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isLinksHost = host !== baseHost && (host.endsWith(`.${baseHost}`) || host.startsWith('link.'));
    const isDownloadLabel = /download\s*\/?\s*watch|download\s*now|watch\s*download|download/i.test(label);
    const isDlPath = /\/dl\//i.test(url);
    if (!isLinksHost && !isDownloadLabel && !isDlPath) continue;
    if (host === baseHost && !isDlPath) continue;
    let score = 0;
    if (isLinksHost) score += 40;
    if (isDownloadLabel) score += 20;
    if (isDlPath) score += 10;
    scored.push({ url, score });
  }
  if (scored.length === 0) return '';
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

/**
 * Landing page → episode blocks with release rows.
 *
 * `{ pageKind: 'ok' | 'not_found' | 'empty', episodes: [{ episode, label, rows }] }`
 *
 * Rows carry `{ label, height, isX264, isHevc, isHq, sizeMb, host, url }` plus a
 * single-entry `links` array so callers can treat them exactly like the Anime
 * Dub Hindi rows.
 */
function parseEpisodePage(html, pageUrl) {
  const stream = buildStream(html, pageUrl);
  const episodes = [];
  const byEpisode = new Map();
  let currentEpisode = null;
  let currentLabel = '';
  let lastIndex = 0;
  let anchorsSeen = 0;

  const blockFor = (episode, label) => {
    const key = episode == null ? 'none' : String(episode);
    if (!byEpisode.has(key)) {
      const block = { episode: episode == null ? null : Number(episode), label: label || '', rows: [] };
      byEpisode.set(key, block);
      episodes.push(block);
    } else if (label && !byEpisode.get(key).label) {
      byEpisode.get(key).label = label;
    }
    return byEpisode.get(key);
  };

  const anchorRe = new RegExp(`${A_OPEN}([^${A_MID}${A_CLOSE}]*)${A_MID}([^${A_CLOSE}]*)${A_CLOSE}`, 'g');
  for (const match of stream.matchAll(anchorRe)) {
    const between = stream.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    anchorsSeen += 1;

    // Context: the ZIP block resets the episode, "EP NN / Episode N" sets it.
    if (ZIP_CONTEXT_RE.test(between)) {
      currentEpisode = null;
      currentLabel = '';
    }
    const episodeMatch = LAST_EPISODE_RE.exec(between);
    if (episodeMatch) {
      currentEpisode = Number(episodeMatch[1]);
      currentLabel = between.replace(/\s+/g, ' ').trim().slice(-40);
    }

    const url = decodeDlUrl(match[1], pageUrl);
    if (!url) continue;
    const host = classifyHost(url);
    if (host !== 'hubcloud' && host !== 'gdflix') continue;
    const row = { ...parseRowLabel(match[2]), host, url, links: [{ host, url }] };
    blockFor(currentEpisode, currentLabel).rows.push(row);
  }

  const totalRows = episodes.reduce((sum, block) => sum + block.rows.length, 0);
  let pageKind = 'ok';
  if (totalRows === 0) {
    pageKind = NOT_FOUND_RE.test(stream) || anchorsSeen === 0 ? 'not_found' : 'empty';
  }
  return { pageKind, episodes: episodes.filter((block) => block.rows.length > 0) };
}

/**
 * The requested episode's rows. TV never falls back to another episode (or to a
 * season ZIP); movies use unmarked rows when the page has no episode markers.
 */
function selectRowsForEpisode(parsed, options = {}) {
  const blocks = (parsed && parsed.episodes) || [];
  if (options.type === 'tv') {
    const wanted = Number(options.episode) || 1;
    const block = blocks.find((entry) => Number(entry.episode) === wanted);
    return block ? block.rows : [];
  }
  const unmarked = blocks.filter((entry) => entry.episode == null);
  if (unmarked.length > 0) return unmarked.flatMap((entry) => entry.rows);
  if (blocks.length === 1) return blocks[0].rows;
  return [];
}

/** Language hints from the page/post title, Hindi first, else Hindi/English/Japanese. */
function languagesFromText(text) {
  const value = String(text || '').toLowerCase();
  const catalogue = [
    { code: 'hi', label: 'Hindi', re: /\bhindi\b|\bhin\b/ },
    { code: 'ta', label: 'Tamil', re: /\btamil\b/ },
    { code: 'te', label: 'Telugu', re: /\btelugu\b/ },
    { code: 'ml', label: 'Malayalam', re: /\bmalayalam\b/ },
    { code: 'kn', label: 'Kannada', re: /\bkannada\b/ },
    { code: 'bn', label: 'Bengali', re: /\bbengali\b/ },
    { code: 'en', label: 'English', re: /\benglish\b|\beng\b/ },
    { code: 'ja', label: 'Japanese', re: /\bjapanese\b|\bjap\b|\bjpn\b/ }
  ];
  const found = [];
  for (const entry of catalogue) {
    if (entry.re.test(value)) found.push({ code: entry.code, label: entry.label });
  }
  if (found.length === 0) return [{ code: 'hi', label: 'Hindi' }, { code: 'en', label: 'English' }, { code: 'ja', label: 'Japanese' }];
  found.sort((a, b) => (a.code === 'hi' ? -1 : b.code === 'hi' ? 1 : 0));
  return found;
}

module.exports = {
  DL_PATH_RE,
  decodeDlUrl,
  parseRowLabel,
  parsePostLink,
  parseEpisodePage,
  selectRowsForEpisode,
  languagesFromText,
  sortRows,
  classifyHost,
  buildStream,
  extractAnchors,
  parseSearchResults,
  pickBestPost,
  hostOf,
  absoluteUrl,
  base64Decode
};
