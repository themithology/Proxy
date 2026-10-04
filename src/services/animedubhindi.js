/**
 * Anime Dub Hindi — Hindi-dub anime release blog (server 2 / Centaurus source #2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "Centaurus" used to have exactly one upstream (HiCine). Anime in Hindi is
 * almost absent from general aggregators, so `/aniem`-style requests kept
 * falling through to Hamster Wheel. Anime Dub Hindi publishes official Netflix
 * Hindi/Tamil/Telugu dubs and — unlike the Streamtape-only anime catalogs —
 * its releases sit on hosts this repo can already unroll:
 *
 *   search   : https://www.animedubhindi.link/?s=<title>   → WordPress posts
 *   post     : https://www.animedubhindi.link/<slug>/      → "Download / Watch"
 *   episodes : https://new.adhlinks.com/episode/<slug>/    → "Episode: NN" blocks
 *   row      : [480P x264]💾 106.72 MB
 *                → HubCloud https://hubcloud.ist/drive/<id>   (existing unroll)
 *                → GDFlix   https://gdflix.dev/file/<id>       (new unroll)
 *                → FileBee / Fprs / MEGA / Multi (skipped: wrappers or dead ends)
 *   gdflix   : /file/<id> → "Instant DL [10GBPS]" → 302 Location ?url=<direct file>
 *
 * All of the above was verified against the live site on 2026-10-04 (see
 * docs/hamster-wheel-upstream-research.md §9). Slugs are NOT derivable — Blue
 * Box Season 1 lives at `/episode/blubox-s1/` — which is why every page is
 * discovered by following links rather than being constructed.
 *
 * PARSING STRATEGY
 * ----------------
 * The site is a WordPress blog whose classes/templates change between posts
 * (Season 1 rows read `[1080P x265 10bit]💾 257.91 MB`, Season 2 rows read
 * `1080P x264 [Size: 107mb]`). So instead of CSS selectors this module walks
 * the document in order and inlines each anchor into the text stream as
 * `\x01<href>\x02<label>\x03`. Rows are then found by the *visible* text
 * ("1080P x265 10bit") and the links are attributed to the row that precedes
 * them. That keeps working when the markup is restyled, and it never executes
 * page JavaScript.
 *
 * No network calls and no Node-only APIs live here: the module is pure parsing
 * + scoring so it can be unit-tested against saved fixtures and reused from the
 * Worker bundle if this source is ever ported there.
 */

const cheerio = require('cheerio');
const { titleDistance } = require('./hamster');

/** Anchor delimiters used by the document-order text walker. */
const A_OPEN = '\u0001';
const A_MID = '\u0002';
const A_CLOSE = '\u0003';

/** Release hosts we know how to resolve (id is what the resolver switches on). */
const RELEASE_HOSTS = [
  { id: 'hubcloud', re: /(?:^|\.)hubcloud\.[a-z.]+$|(?:^|\.)hubdrive\.[a-z.]+$/i },
  { id: 'gdflix', re: /(?:^|\.)gdflix\.[a-z.]+$|(?:^|\.)gdlink\.[a-z.]+$/i },
  { id: 'filebee', re: /(?:^|\.)filebee\.[a-z.]+$/i },
  { id: 'fprs', re: /(?:^|\.)fpgo\.[a-z.]+$|(?:^|\.)fprs\.[a-z.]+$/i }
];

/** Links the player can actually be served from (everything else is skipped). */
const RESOLVABLE_HOSTS = new Set(['hubcloud', 'gdflix']);

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

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

/**
 * Classify a release link. Host first (mirrors rotate domains freely), then the
 * adhlinks base64 wrappers, then the `/episode/` page shape used by the blog.
 */
function classifyHost(url) {
  const raw = String(url || '');
  if (!raw) return 'other';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'other';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  for (const entry of RELEASE_HOSTS) {
    if (entry.re.test(host)) return entry.id;
  }
  if (/(?:^|\.)adhlinks\.com$/i.test(host) || /(?:^|\.)animedubhindi\./i.test(host)) {
    if (/redirect\.php$/i.test(path)) return 'mega-wrapper';
    if (/re\.php$/i.test(path)) return 'multi-wrapper';
    if (/\/episode\//i.test(path)) return 'episode-page';
    return 'link-host';
  }
  if (/\/episode\//i.test(path)) return 'episode-page';
  if (/desidubanime|watchanimeworld|animeplay/i.test(host)) return 'watch-online';
  return 'other';
}

/** Hosts whose pages can be unrolled into a raw media URL. */
function isResolvableHost(hostId) {
  return RESOLVABLE_HOSTS.has(String(hostId || '').toLowerCase());
}

/* ------------------------------------------------------------------------- *
 * Document-order walker
 * ------------------------------------------------------------------------- */

function textOfNode(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data || '';
  let acc = '';
  for (const child of node.children || []) {
    if (child.type === 'tag' && /^(?:script|style|noscript|template|svg)$/i.test(child.name || '')) continue;
    acc += textOfNode(child);
  }
  return acc;
}

/**
 * Flatten an HTML document into a text stream with anchors inlined
 * (`\x01href\x02label\x03`). Order is preserved, so a quality row's links are
 * always the anchors that follow its label and precede the next label.
 */
function buildStream(html, pageUrl) {
  let $;
  try {
    $ = cheerio.load(String(html || ''));
  } catch {
    return '';
  }
  $('script, style, noscript, template, svg').remove();
  const out = [];
  const blockTags = /^(?:br|p|div|li|tr|h[1-6]|section|article|header|footer|table|tbody|ul|ol|dd|dt|blockquote|center|figure)$/;
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'text') {
      out.push(node.data || '');
      return;
    }
    if (node.type !== 'tag' && node.type !== 'root') return;
    const name = String(node.name || '').toLowerCase();
    if (/^(?:script|style|noscript|template|svg)$/.test(name)) return;
    if (name === 'a') {
      const href = absoluteUrl(node.attribs?.href, pageUrl);
      const label = textOfNode(node).replace(/\s+/g, ' ').trim();
      if (href) out.push(`${A_OPEN}${href}${A_MID}${label}${A_CLOSE}`);
      else out.push(label);
      return;
    }
    const isBlock = blockTags.test(name);
    if (isBlock) out.push('\n');
    for (const child of node.children || []) walk(child);
    if (isBlock) out.push('\n');
  };
  walk($.root()[0]);
  return out
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Character ranges occupied by inline anchors, so labels can ignore them. */
function anchorSpans(stream) {
  const spans = [];
  let index = 0;
  while (index < stream.length) {
    const start = stream.indexOf(A_OPEN, index);
    if (start < 0) break;
    const end = stream.indexOf(A_CLOSE, start);
    if (end < 0) break;
    spans.push([start, end]);
    index = end + 1;
  }
  return spans;
}

function indexInsideSpans(position, spans) {
  for (const [start, end] of spans) {
    if (position >= start && position <= end) return true;
    if (start > position) break;
  }
  return false;
}

function extractAnchors(text) {
  const out = [];
  const re = new RegExp(`${A_OPEN}([^${A_MID}${A_CLOSE}]*)${A_MID}([^${A_CLOSE}]*)${A_CLOSE}`, 'g');
  for (const match of String(text || '').matchAll(re)) {
    out.push({ href: match[1], text: String(match[2] || '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Titles, seasons, episodes
 * ------------------------------------------------------------------------- */

/**
 * Strip release-blog decoration so a post title can be compared to a TMDB
 * title: "Blue Box Season 2 Hindi, Tamil, ... (Multi Audio) NF WEB-DL Episodes
 * Download" → "blue box".
 */
function normalizeTitleForMatch(title) {
  return String(title || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:seasons?|parts?|cours?)\s*[-._]?\s*\d+\b/g, ' ')
    .replace(/\b(?:season|part|cour)\b/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(
      /\b(?:hindi|tamil|telugu|malayalam|kannada|bengali|marathi|english|japanese|korean|chinese|spanish|dual\s*audio|multi\s*audio|multi|dub|dubbed|sub|subbed|esub|esubs)\b/g,
      ' '
    )
    .replace(/\b(?:download|episodes?|movies?|series|webseries|web[- ]?dl|blu[- ]?ray|bluray|hdrip|nf|netflix|amzn|prime|hotstar|sonyliv|crunchyroll|cr|complete|all|quality|hevc|avc)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Season 03", "Seasons 4", "S02E01" → 3 / 4 / 2 (null when unstated). */
function seasonFromText(text) {
  const value = String(text || '');
  const sxxe = /\bS(\d{1,2})\s*E\d{1,3}\b/i.exec(value);
  if (sxxe) return Number(sxxe[1]);
  const season = /\bseasons?\s*[-._:]?\s*0*(\d{1,2})(?!\d)/i.exec(value);
  if (season) return Number(season[1]);
  const short = /\bS(\d{1,2})\b(?!\d)/.exec(value);
  if (short) return Number(short[1]);
  return null;
}

/** "…/episode/bluebox-s2-episode-05" → { season: 2, episode: 5 } (partial ok). */
function episodeFromSlug(url) {
  const value = String(url || '');
  const sxxe = /\bs(\d{1,2})[\s._-]*e(\d{1,3})\b/i.exec(value);
  if (sxxe) return { season: Number(sxxe[1]), episode: Number(sxxe[2]) };
  const episode = /\b(?:episode|ep|part)[\s._-]*0*(\d{1,3})(?!\d)/i.exec(value);
  const result = {};
  if (episode) result.episode = Number(episode[1]);
  const season = /\b(?:season|s)[\s._-]*0*(\d{1,2})(?!\d)/i.exec(value);
  if (season) result.season = Number(season[1]);
  return result;
}

/* ------------------------------------------------------------------------- *
 * WordPress search + post pages
 * ------------------------------------------------------------------------- */

/**
 * Search results (`/?s=<title>`): one `h2 a` per post. Only same-site links that
 * are neither taxonomy pages nor the search form itself are kept.
 */
function parseSearchResults(html, baseUrl) {
  let $;
  try {
    $ = cheerio.load(String(html || ''));
  } catch {
    return [];
  }
  const baseHost = hostOf(baseUrl);
  const seen = new Set();
  const out = [];
  const push = (href, text) => {
    const url = absoluteUrl(href, baseUrl);
    if (!url || seen.has(url)) return;
    if (hostOf(url) !== baseHost) return;
    if (/[?&]s=|feed=|\/category\/|\/tag\/|\/author\/|\/page\/\d|\/wp-|\/schedule|#/i.test(url)) return;
    if (/\.(?:jpe?g|png|webp|gif|svg|css|js)$/i.test(url)) return;
    const title = String(text || '').replace(/\s+/g, ' ').trim();
    if (title.length < 6) return;
    seen.add(url);
    out.push({ url, title });
  };
  const selectors = ['h2 a[href]', 'h2.entry-title a[href]', '.entry-title a[href]', 'article a[href]', 'main a[href]'];
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const $element = $(element);
      push($element.attr('href'), $element.text());
    });
    if (out.length > 0) break;
  }
  return out;
}

/**
 * Pick the post that matches the requested title + season. Searches return
 * every season of a show, so the season decides between "Blue Box Season 1"
 * and "Blue Box Season 2".
 */
function pickBestPost(results, metadata = {}) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const wanted = [metadata.title, metadata.originalTitle, ...(metadata.alternativeTitles || [])]
    .filter((value) => typeof value === 'string' && value.trim())
    .map(normalizeTitleForMatch)
    .filter((value) => value.length >= 2)
    .slice(0, 8);
  if (wanted.length === 0) return null;

  const isTv = metadata.type === 'tv';
  const wantedSeason = Math.max(1, Number(metadata.season) || 1);
  const wantedYear = Number(metadata.releaseYear) || 0;
  let best = null;

  for (const result of results) {
    const raw = String(result.title || '');
    const base = normalizeTitleForMatch(raw);
    if (!base) continue;

    let titleScore = 0;
    for (const target of wanted) {
      if (base === target) {
        titleScore = Math.max(titleScore, 120);
      } else if (base.startsWith(target) || base.includes(target) || target.includes(base)) {
        titleScore = Math.max(titleScore, 80);
      } else {
        const distance = titleDistance(base, target);
        const limit = Math.max(2, Math.min(6, Math.round(target.length / 8)));
        if (distance <= limit) titleScore = Math.max(titleScore, 60 - distance * 5);
      }
    }
    if (titleScore <= 0) continue;

    let score = titleScore;
    const postSeason = seasonFromText(raw);
    const effectiveSeason = postSeason || 1;
    if (isTv) {
      if (effectiveSeason === wantedSeason) score += 60;
      else score -= 120;
    }
    const postYear = Number(/\b(?:19|20)\d{2}\b/.exec(raw)?.[0]) || 0;
    if (wantedYear && postYear) {
      const delta = Math.abs(postYear - wantedYear);
      score += delta === 0 ? 40 : delta <= 1 ? 20 : -25;
    }
    if (!best || score > best.score) best = { ...result, score, season: effectiveSeason, year: postYear };
  }
  return best && best.score > 0 ? best : null;
}

/** Post page → the adhlinks episode page ("Download / Watch" button). */
function parsePostEpisodeLinks(html, postUrl) {
  let $;
  try {
    $ = cheerio.load(String(html || ''));
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, element) => {
    const url = absoluteUrl($(element).attr('href'), postUrl);
    if (!url || seen.has(url)) return;
    if (classifyHost(url) !== 'episode-page') return;
    seen.add(url);
    out.push({ url, label: $(element).text().replace(/\s+/g, ' ').trim() });
  });
  return out;
}

/** Adhlinks' soft-404 is an HTTP 200 page that must never be parsed as content. */
function isPageNotFound(html, pageUrl) {
  const url = String(pageUrl || '');
  if (/page-not-found|\/404/i.test(url)) return true;
  const text = String(html || '');
  return /page-not-found|currently unavailable\.?\s*please try a different server|this server is currently unavailable/i.test(text);
}

/* ------------------------------------------------------------------------- *
 * Episode page: "Episode: NN" blocks → quality rows → release links
 * ------------------------------------------------------------------------- */

const EPISODE_MARK_RE = /\b(?:episode|ep)\b[\s:.#\-–—]*0*(\d{1,3})(?:\s*(?:-|–|—|to)\s*0*(\d{1,3}))?/gi;
const QUALITY_MARK_RE = /\b(\d{3,4})\s*[pP](?![\w])/g;

function composeRowLabel(height, codecText) {
  const extra = String(codecText || '')
    .replace(/^[\s\]]+/, '')
    .replace(/[\s\]]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return `${height}P${extra ? ` ${extra}` : ''}`;
}

/**
 * Split one episode block into quality rows. Row text has shipped in two
 * shapes so far (`[480P x264]💾 106.72 MB` and `480P x264 [Size: 107mb]`), so
 * only the resolution marker is required; codec/size/links are best-effort.
 */
function parseQualityRows(blockText, episodeNumber) {
  const stream = String(blockText || '');
  const spans = anchorSpans(stream);
  const marks = [...stream.matchAll(QUALITY_MARK_RE)].filter((match) => !indexInsideSpans(match.index, spans));
  const rows = [];

  marks.forEach((mark, index) => {
    const start = mark.index;
    const end = index + 1 < marks.length ? marks[index + 1].index : stream.length;
    const chunk = stream.slice(start, end);
    // The codec/HQ tokens sit between the resolution and the size or links.
    const head = chunk.slice(mark[0].length);
    const tail = head.split(/[[\u{1F4BE}\n]/u)[0] || '';
    const codecText = tail.replace(/\bsize\b\s*[:=]?\s*/gi, ' ');
    const sizeMatch = /([\d.]+)\s*(MB|GB)/i.exec(chunk);
    const sizeValue = sizeMatch ? Number.parseFloat(sizeMatch[1]) : null;
    const sizeMb = Number.isFinite(sizeValue)
      ? sizeMatch[2].toUpperCase() === 'GB'
        ? Math.round(sizeValue * 1024)
        : Math.round(sizeValue * 100) / 100
      : null;
    const height = Number(mark[1]);
    const label = composeRowLabel(height, codecText);
    const codecHaystack = `${label} ${codecText}`;

    rows.push({
      episode: episodeNumber,
      height,
      label,
      sizeMb,
      isHevc: /\b(?:x265|h\.?265|hevc)\b/i.test(codecHaystack),
      isX264: /\b(?:x264|h\.?264|avc)\b/i.test(codecHaystack),
      isHq: /\bhq\b/i.test(codecHaystack),
      links: extractAnchors(chunk).map((anchor) => ({
        host: classifyHost(anchor.href),
        url: anchor.href,
        label: anchor.text
      }))
    });
  });

  return rows;
}

/**
 * Parse an adhlinks page. A season page carries `Episode: NN` blocks; a movie /
 * single-item page has none and is reported as `single`.
 */
function parseEpisodePage(html, pageUrl) {
  const stream = buildStream(html, pageUrl);
  if (!stream) return { pageKind: 'empty', episodes: [], stream: '' };
  if (isPageNotFound(html, pageUrl)) return { pageKind: 'not_found', episodes: [], stream };

  const spans = anchorSpans(stream);
  const marks = [...stream.matchAll(EPISODE_MARK_RE)].filter((match) => !indexInsideSpans(match.index, spans));
  const episodes = [];

  // Movie (and single-episode) pages carry no `Episode: NN` heading at all —
  // the whole page is one item, so its rows belong to that item.
  if (marks.length === 0) {
    const singleRows = parseQualityRows(stream, null);
    return { pageKind: singleRows.length > 0 ? 'single' : 'empty', episodes: [], singleRows, stream };
  }

  marks.forEach((mark, index) => {
    const start = mark.index;
    const end = index + 1 < marks.length ? marks[index + 1].index : stream.length;
    const number = Number(mark[1]);
    const numberEnd = mark[2] ? Number(mark[2]) : number;
    const rows = parseQualityRows(stream.slice(start, end), number);
    episodes.push({ number, numberEnd, rows });
  });

  // Pages sometimes open with a nav list ("Episode 01 | 02 | …") whose blocks
  // carry no rows; drop those, and keep the richest block per episode number.
  const withRows = episodes.filter((episode) => episode.rows.length > 0);
  const byNumber = new Map();
  for (const episode of withRows) {
    const key = `${episode.number}-${episode.numberEnd}`;
    const existing = byNumber.get(key);
    if (!existing || episode.rows.length > existing.rows.length) byNumber.set(key, episode);
  }
  const deduped = [...byNumber.values()].sort((a, b) => a.number - b.number);

  return {
    pageKind: deduped.length > 0 ? 'season' : 'empty',
    episodes: deduped,
    singleRows: [],
    stream
  };
}

/**
 * Rows for the requested episode. TV requests require an explicit episode
 * block — an unlabelled page is only trusted for movies, because serving a
 * guessed episode is worse than serving nothing (the waterfall falls through
 * to Hamster Wheel instead).
 */
function selectRowsForEpisode(parsed, options = {}) {
  if (!parsed || !Array.isArray(parsed.episodes)) return [];
  const { type, episode = 1, pageUrl = '' } = options;

  if (parsed.episodes.length === 0) {
    const singleRows = Array.isArray(parsed.singleRows) ? parsed.singleRows : [];
    if (type === 'movie') return singleRows;
    const hinted = episodeFromSlug(pageUrl);
    if (hinted.episode && Number(hinted.episode) === Number(episode)) return singleRows;
    return [];
  }

  const wanted = Number(episode) || 1;
  const match = parsed.episodes.find((entry) => wanted >= entry.number && wanted <= entry.numberEnd);
  if (match) return match.rows;
  // Some pages label the newest episode only ("Episode: 01 [New]") while an
  // older request was already published elsewhere — never guess; return empty.
  return [];
}

/** Rank rows: decodable first (x264/AVC), then highest resolution. */
function scoreAnimeRow(row) {
  let score = 0;
  if (!row.isHevc) score += 100;
  if (row.isX264) score += 60;
  const height = Number(row.height) || 0;
  if (height === 1080) score += 30;
  else if (height === 720) score += 25;
  else if (height === 480) score += 20;
  else score += 10;
  if (row.isHevc) score -= 40;
  if (row.isHq) score += 5;
  if (Number(row.sizeMb) > 0) score += Math.min(10, Math.log10(Number(row.sizeMb)) * 2);
  return score;
}

function sortRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const delta = scoreAnimeRow(b) - scoreAnimeRow(a);
    if (delta !== 0) return delta;
    return (Number(b.height) || 0) - (Number(a.height) || 0);
  });
}

/* ------------------------------------------------------------------------- *
 * GDFlix (gdflix.dev / new4.gdflix.io / gdlink.*)
 * ------------------------------------------------------------------------- */

const GDFLIX_URL_RE = /gdflix\.[a-z.]+|gdlink\.[a-z.]+/i;

function isGdflixUrl(url) {
  return GDFLIX_URL_RE.test(String(url || ''));
}

/**
 * GDFlix file page → ordered download candidates.
 * Button labels are stable even when the domain rotates: "Instant DL [10GBPS]"
 * (302 → direct file), "DIRECT SERVER [MGT]", "FAST CLOUD / ZIPDISK".
 */
function parseGdflixPage(html, pageUrl) {
  let $;
  try {
    $ = cheerio.load(String(html || ''));
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, element) => {
    const $element = $(element);
    const url = absoluteUrl($element.attr('href'), pageUrl);
    if (!url || seen.has(url)) return;
    const label = $element.text().replace(/\s+/g, ' ').trim();
    if (/about|privacy|polic|terms|copyright|dmca|contact|login|telegram|t\.me\//i.test(`${label} ${url}`)) return;
    if (/^#/.test(String($element.attr('href') || '').trim())) return;

    let kind = 'other';
    if (/instant/i.test(url)) kind = 'instant';
    // `new*.gdflix.<tld>/cloud/<id>/<file>` is another page of the same shape,
    // not a file — it must be followed, not probed.
    else if (/\/cloud\//i.test(url)) kind = 'cloud';
    else if (/indexserver|\.(?:mkv|mp4|webm|m4v|avi)(?:\?|$)/i.test(url)) kind = 'direct';
    else if (/drive\.google\.com/i.test(url)) kind = 'gdrive';
    else if (/multiup|gofile|goflix|mirror/i.test(`${url} ${label}`)) kind = 'mirror';
    if (kind === 'other') return;

    seen.add(url);
    out.push({ url, kind, label: label.slice(0, 60) });
  });
  // Instant first (one 302 → the file), then plain CDN, then the /cloud page.
  const order = { instant: 0, direct: 1, cloud: 2, gdrive: 3, mirror: 4, other: 5 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * `Instant DL` answers 302 with `Location: …?url=<direct file>`. Pull the real
 * target out of the redirect (the intermediate host is a rate-limited rotating
 * proxy, so the raw file URL is what the player must be given).
 */
function extractInstantTarget(location, requestUrl) {
  const value = String(location || '').trim();
  if (!value) return '';
  const decoded = decodeURIComponentSafe(value);
  const wrapped = /[?&]url=([^&\s]+)/i.exec(decoded);
  if (wrapped) return decodeURIComponentSafe(wrapped[1]);
  if (/^https?:\/\//i.test(decoded)) return decoded;
  return absoluteUrl(decoded, requestUrl);
}

module.exports = {
  A_OPEN,
  A_MID,
  A_CLOSE,
  classifyHost,
  isResolvableHost,
  isGdflixUrl,
  buildStream,
  extractAnchors,
  parseSearchResults,
  pickBestPost,
  parsePostEpisodeLinks,
  isPageNotFound,
  parseEpisodePage,
  parseQualityRows,
  selectRowsForEpisode,
  scoreAnimeRow,
  sortRows,
  normalizeTitleForMatch,
  seasonFromText,
  episodeFromSlug,
  parseGdflixPage,
  extractInstantTarget,
  decodeURIComponentSafe
};
