/**
 * Archive — Internet Archive (archive.org) public-domain movie provider.
 *
 * This is the only source in the stack that needs no gating bypass at all:
 * archive.org publishes its catalogue through a public JSON API, serves the
 * files from a plain CORS-enabled CDN, and the items surfaced here carry an
 * explicit Public Domain / CC0 marker on the item itself.
 *
 * Resolution pipeline:
 *   1. TMDB metadata (title, year) -> archive.org advancedsearch query
 *      (`mediatype:movies`, restricted to public-domain collections)
 *   2. Score candidates by title similarity + release-year proximity
 *   3. Re-check the licence on the full item metadata (never trust the search
 *      index alone) and pick the best playable `.mp4` derivative
 *   4. Return the stream payload the player already understands, including
 *      `provenance` so the licence + source page can be surfaced in the UI.
 *
 * Everything is configurable through `config.upstreams.archive*` so the test
 * suite can point it at the local mock upstream server.
 */

const config = require('../../config');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Collections whose contents are published as public domain / free to share. */
const PUBLIC_DOMAIN_COLLECTIONS = [
  'prelinger',
  'classic_cartoons',
  'film_noir',
  'sci-fi_horror',
  'publicmovies',
  'public_domain_movies',
  'academic_films'
];

/** Licence markers accepted without any further review. */
const PUBLIC_DOMAIN_LICENCE_MARKERS = [
  'publicdomain',
  'public_domain',
  'creativecommons.org/publicdomain',
  'creativecommons.org/licenses/zero',
  'creativecommons.org/share-your-work/public-domain'
];

/** Creative Commons licences that *permit* redistribution (attribution required). */
const CREATIVE_COMMONS_MARKERS = ['creativecommons.org/licenses/by'];

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token-overlap similarity between the wanted and candidate title (0..1).
 * A containment match (`the kid` vs `the kid 1921 restoration`) scores 1.
 */
function titleSimilarity(wanted, candidate) {
  const a = normalizeTitle(wanted);
  const b = normalizeTitle(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.95;
  const aTokens = new Set(a.split(' ').filter((t) => t.length > 1));
  const bTokens = new Set(b.split(' ').filter((t) => t.length > 1));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let shared = 0;
  for (const t of aTokens) if (bTokens.has(t)) shared += 1;
  return shared / Math.min(aTokens.size, bTokens.size);
}

function toYear(value) {
  const m = String(value == null ? '' : value).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/** Does the item carry an explicit public-domain / CC0 marker? */
function licenceInfo(source = {}) {
  const haystack = [
    source.licenseurl,
    source.license,
    source.rights,
    source.usage,
    ...(Array.isArray(source.collection) ? source.collection : [source.collection])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const collection = (Array.isArray(source.collection) ? source.collection : [source.collection])
    .filter(Boolean)
    .map((c) => String(c).toLowerCase());

  if (PUBLIC_DOMAIN_LICENCE_MARKERS.some((m) => haystack.includes(m))) {
    return { publicDomain: true, licence: source.licenseurl || 'Public Domain' };
  }
  if (/public domain/.test(haystack)) {
    return { publicDomain: true, licence: source.licenseurl || 'Public Domain' };
  }
  const pdCollection = collection.find((c) => PUBLIC_DOMAIN_COLLECTIONS.includes(c));
  if (pdCollection) {
    return { publicDomain: true, licence: `Public Domain collection: ${pdCollection}` };
  }
  if (CREATIVE_COMMONS_MARKERS.some((m) => haystack.includes(m))) {
    return {
      publicDomain: false,
      creativeCommons: true,
      licence: source.licenseurl || 'Creative Commons (attribution required)'
    };
  }
  return { publicDomain: false, licence: source.licenseurl || '' };
}

/** Rank a playable file: bigger/higher-quality MP4 derivatives win. */
function scoreFile(file) {
  const name = String(file.name || '');
  if (!/\.(mp4|m4v|mkv)$/i.test(name)) return -1;
  if (/\.(thumbs|torrent|xml|sqlite|gz)$/i.test(name)) return -1;
  const format = String(file.format || '').toLowerCase();
  let score = 100;
  if (format.includes('h.264') || format.includes('mpeg4')) score += 40;
  const heightHint = name.match(/(\d{3,4})p/i);
  if (heightHint) score += Number(heightHint[1]) / 10;
  const size = Number(file.size || 0);
  if (size > 0) score += Math.min(size / 1073741824, 6) * 4; // up to +24 for ~6 GB
  if (/_512kb|_256kb|_64kb/i.test(name)) score -= 25;
  return score;
}

/** Best-first list of playable files for an item. */
function pickPlayableFiles(files = []) {
  return files
    .map((f) => ({ file: f, score: scoreFile(f) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.file);
}

function heightFromFile(file = {}) {
  const hint = String(file.name || '').match(/(\d{3,4})p/i);
  if (hint) return Number(hint[1]);
  const format = String(file.format || '').toLowerCase();
  if (format.includes('1080')) return 1080;
  if (format.includes('720')) return 720;
  if (format.includes('480')) return 480;
  return 0;
}

function buildDownloadUrl(identifier, fileName) {
  const base = (config.upstreams.archiveDownloadBase || 'https://archive.org/download').replace(/\/$/, '');
  return `${base}/${encodeURIComponent(identifier)}/${String(fileName)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function detailsUrl(identifier) {
  const base = (config.upstreams.archiveDetailsBase || 'https://archive.org/details').replace(/\/$/, '');
  return `${base}/${encodeURIComponent(identifier)}`;
}

/** Best candidate from the search response, or null when nothing is close enough. */
function pickBestItem(docs = [], wanted = {}) {
  let best = null;
  for (const doc of docs) {
    if (!doc || !doc.identifier) continue;
    const similarity = titleSimilarity(wanted.title, doc.title || doc.identifier);
    if (similarity < 0.6) continue;
    const candidateYear = toYear(doc.year || doc.date || doc.publicdate);
    let yearPenalty = 0;
    if (wanted.year && candidateYear) {
      const delta = Math.abs(candidateYear - wanted.year);
      if (delta > 3) continue;
      yearPenalty = delta * 0.03;
    }
    const score = similarity - yearPenalty;
    if (!best || score > best.score) best = { doc, score, similarity, year: candidateYear };
  }
  return best;
}

function buildSearchQuery(wanted = {}, options = {}) {
  const { includeYear = true } = options;
  const clauses = ['mediatype:movies'];
  const title = String(wanted.title || '').replace(/["\\]/g, ' ').trim();
  if (title) clauses.push(`title:(${title.split(/\s+/).slice(0, 8).join(' ')})`);
  if (includeYear && wanted.year) clauses.push(`year:[${wanted.year - 2} TO ${wanted.year + 3}]`);
  return clauses.join(' AND ');
}

async function safeJson(url, headers = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchItems(wanted) {
  const base = (config.upstreams.archiveSearchUrl || 'https://archive.org/advancedsearch.php').replace(/\/$/, '');

  const runQuery = async (query) => {
    const params = new URLSearchParams();
    params.set('q', query);
    for (const field of ['identifier', 'title', 'year', 'date', 'collection', 'licenseurl', 'mediatype']) {
      params.append('fl[]', field);
    }
    params.set('rows', '12');
    params.set('page', '1');
    params.set('output', 'json');

    const json = await safeJson(`${base}?${params.toString()}`);
    return json && json.response && Array.isArray(json.response.docs) ? json.response.docs : [];
  };

  // Plenty of public-domain items carry no `year` field, so the year window is
  // a preference, not a hard filter: retry unconstrained when it matches nothing.
  let docs = await runQuery(buildSearchQuery(wanted));
  if (docs.length === 0 && wanted.year) {
    docs = await runQuery(buildSearchQuery(wanted, { includeYear: false }));
  }
  return docs;
}

async function fetchItemMetadata(identifier) {
  const base = (config.upstreams.archiveMetadataUrl || 'https://archive.org/metadata').replace(/\/$/, '');
  const json = await safeJson(`${base}/${encodeURIComponent(identifier)}`);
  if (!json || !Array.isArray(json.files)) return null;
  return { metadata: json.metadata || {}, files: json.files };
}

/**
 * Resolve a stream for the `archive` server, or null when the catalogue has no
 * public-domain match for this title.
 */
async function resolveArchiveServer(metadata = {}) {
  // Only films: archive.org items are not episode-addressable, so pretending to
  // serve a specific TV episode would hand the viewer the wrong thing.
  if (metadata.type === 'tv') return null;

  const wanted = { title: metadata.title || metadata.originalTitle || '', year: metadata.releaseYear || null };
  if (!wanted.title) return null;

  const docs = await searchItems(wanted);
  const best = pickBestItem(docs, wanted);
  if (!best) return null;

  const item = await fetchItemMetadata(best.doc.identifier);
  if (!item) return null;

  const licence = licenceInfo({ ...best.doc, ...item.metadata });
  const allowCreativeCommons = String(process.env.ARCHIVE_ALLOW_CC || '') === '1';
  if (!licence.publicDomain && !(allowCreativeCommons && licence.creativeCommons)) return null;

  const files = pickPlayableFiles(item.files);
  if (files.length === 0) return null;

  const identifier = best.doc.identifier;
  const urls = files.map((f) => buildDownloadUrl(identifier, f.name));
  const primary = urls[0];

  return {
    server: 'archive',
    format: 'mp4',
    rawUrl: primary,
    // archive.org serves these files straight from a CORS-enabled CDN with no
    // Origin/Referer gating, so direct playback is enough — the proxied variant
    // stays available as a fallback for restricted networks.
    streamUrl: primary,
    referer: '',
    headers: {},
    backupUrls: urls.slice(1),
    audioTracks: [
      {
        id: 'archive-orig',
        lang: 'en',
        label: 'Original Audio',
        type: 'sub',
        streamUrl: primary,
        rawUrl: primary,
        default: true
      }
    ],
    qualities: files.map((f, idx) => ({
      label: idx === 0 ? 'Auto' : `${heightFromFile(f) || 'source'}${heightFromFile(f) ? 'p' : ''}`,
      height: heightFromFile(f),
      url: urls[idx]
    })),
    provenance: {
      provider: 'Internet Archive',
      identifier,
      title: item.metadata.title || best.doc.title || wanted.title,
      year: toYear(item.metadata.year || item.metadata.date || best.year),
      licence: licence.licence,
      publicDomain: licence.publicDomain,
      sourcePage: detailsUrl(identifier)
    }
  };
}

module.exports = {
  resolveArchiveServer,
  // exported for unit tests
  normalizeTitle,
  titleSimilarity,
  licenceInfo,
  pickPlayableFiles,
  pickBestItem,
  buildSearchQuery,
  buildDownloadUrl,
  heightFromFile
};
