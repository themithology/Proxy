import { fetchText } from '../util/http.js';
import { resolveUrl, hostOf } from '../util/url.js';
import { logFor } from '../logger.js';
import { decodeText } from './subtitles.js';
import type { StreamKind } from '../providers/types.js';

/**
 * Generic page extraction.
 *
 * Given any HTML page (an embed, a watch page, a JSON API response), pull out
 * every plausible media URL. This is what turns a provider that only hands us
 * an "embed" link into a real, playable stream.
 *
 * Everything here is transport-level and site-agnostic: no site-specific
 * rules, no DRM handling, no circumvention — just finding URLs a page already
 * exposes and following the iframes it points at.
 */

const log = logFor('extract');

export interface ExtractedUrl {
  url: string;
  kind: StreamKind;
  /** Where it was found — useful in diagnostics. */
  via: 'regex' | 'iframe' | 'base64' | 'json' | 'attribute';
  score: number;
}

const MEDIA_PATTERNS: Array<{ re: RegExp; kind: StreamKind; weight: number }> = [
  { re: /https?:\/\/[^\s"'\\<>]+\.m3u8[^\s"'\\<>]*/gi, kind: 'hls', weight: 100 },
  { re: /https?:\/\/[^\s"'\\<>]+\.mpd[^\s"'\\<>]*/gi, kind: 'dash', weight: 95 },
  { re: /https?:\/\/[^\s"'\\<>]+\.mp4[^\s"'\\<>]*/gi, kind: 'mp4', weight: 70 },
  { re: /https?:\/\/[^\s"'\\<>]+\.(?:webm|mkv|m4v|mov|avi)[^\s"'\\<>]*/gi, kind: 'mp4', weight: 50 },
  { re: /magnet:\?[^\s"'<>]+/gi, kind: 'torrent', weight: 30 },
];

const IFRAME_RE = /<iframe[^>]+src=["']([^"']+)["']/gi;
const SRC_ATTR_RE = /(?:src|file|videoUrl|source|url)\s*[:=]\s*["']([^"']{8,})["']/gi;

/** Un-escape the many ways URLs get embedded in JS/JSON. */
function unescapeUrl(u: string): string {
  return u
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/gi, '&')
    .trim();
}

function looksLikeMedia(u: string): boolean {
  return /\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|avi|m4s|ts)(\?|#|$)/i.test(u) || u.startsWith('magnet:');
}

function kindFor(u: string): StreamKind {
  if (/\.m3u8(\?|$)/i.test(u)) return 'hls';
  if (/\.mpd(\?|$)/i.test(u)) return 'dash';
  if (u.startsWith('magnet:')) return 'torrent';
  if (/\.(mp4|webm|mkv|m4v|mov|avi|m4s|ts)(\?|$)/i.test(u)) return 'mp4';
  return 'unknown';
}

/** Try base64 blobs; many pages wrap the real URL in one. */
function fromBase64(text: string, baseUrl: string, out: ExtractedUrl[]): void {
  const blobs = text.match(/[A-Za-z0-9+/]{32,}={0,2}/g) ?? [];
  for (const b of blobs.slice(0, 40)) {
    let decoded = '';
    try {
      decoded = Buffer.from(b, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (!decoded.includes('http')) continue;
    for (const m of decoded.matchAll(/https?:\/\/[^\s"'\\<>]+/gi)) {
      const u = unescapeUrl(m[0]);
      if (!looksLikeMedia(u)) continue;
      out.push({
        url: resolveUrl(baseUrl, u),
        kind: kindFor(u),
        via: 'base64',
        score: 60,
      });
    }
  }
}

function collect(text: string, baseUrl: string): ExtractedUrl[] {
  const out: ExtractedUrl[] = [];
  const seen = new Set<string>();

  const push = (raw: string, kind: StreamKind, via: ExtractedUrl['via'], weight: number) => {
    let u = unescapeUrl(raw);
    if (!u) return;
    if (!/^(https?:|magnet:)/i.test(u)) u = resolveUrl(baseUrl, u);
    if (!/^(https?:|magnet:)/i.test(u)) return;

    const key = u.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    let score = weight;

    // Prefer manifests and larger-looking renditions.
    if (/\b(1080|720|2160|480|360)\b/.test(u)) score += 15;
    const hm = /[/\-_](\d{3,4})[pP]?[/\-_.]/.exec(u);
    if (hm) score += Math.min(Number(hm[1]) / 100, 20);
    if (/master|index|playlist/i.test(u)) score += 10;
    if (/\.ts(\?|$)/i.test(u)) score -= 25; // raw segments are a last resort
    if (/preview|trailer|teaser|sample|thumb/i.test(u)) score -= 60;
    if (/pixel|analytics|ads?\.|\/ad[sx]?\//i.test(u)) score -= 80;

    out.push({ url: u, kind: kind === 'unknown' ? kindFor(u) : kind, via, score });
  };

  for (const p of MEDIA_PATTERNS) {
    for (const m of text.matchAll(p.re)) push(m[0], p.kind, 'regex', p.weight);
  }

  // Attribute-style: src="/x/y.m3u8" or file: "..."
  for (const m of text.matchAll(SRC_ATTR_RE)) {
    const u = m[1];
    if (!u || !looksLikeMedia(u)) continue;
    push(u, 'unknown', 'attribute', 65);
  }

  // JSON-embedded URLs (escaped slashes)
  const jsonish = text.match(/"(https?:\\?\/\\?\/[^"]{6,})"/gi) ?? [];
  for (const raw of jsonish) {
    const u = unescapeUrl(raw.replace(/^"|"$/g, ''));
    if (!looksLikeMedia(u)) continue;
    push(u, 'unknown', 'json', 70);
  }

  fromBase64(text, baseUrl, out);

  return out.sort((a, b) => b.score - a.score);
}

export interface ExtractOptions {
  /** Follow <iframe src> one level deep (default true). */
  followIframes?: boolean;
  /** Max nested pages to fetch. */
  maxDepth?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Extract playable media URLs from a page, following one level of iframes.
 */
export async function extractFromPage(
  pageUrl: string,
  opts: ExtractOptions = {},
): Promise<ExtractedUrl[]> {
  const {
    followIframes = true,
    maxDepth = 1,
    headers = {},
    signal,
  } = opts;

  let html = '';
  try {
    html = await fetchText(pageUrl, {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...headers },
      timeout: 15_000,
      signal,
    });
  } catch (err) {
    log.debug({ err: String(err) }, 'page fetch failed');
    return [];
  }

  const results = collect(html, pageUrl);

  if (followIframes && maxDepth > 0) {
    const iframes: string[] = [];
    for (const m of html.matchAll(IFRAME_RE)) {
      const src = m[1];
      if (!src) continue;
      if (/^(about:|javascript:|data:)/i.test(src)) continue;
      iframes.push(resolveUrl(pageUrl, unescapeUrl(src)));
    }

    // Cap the fan-out so a page full of ad iframes can't stall us.
    for (const frame of [...new Set(iframes)].slice(0, 4)) {
      if (hostOf(frame) === hostOf(pageUrl) && frame === pageUrl) continue;
      try {
        const inner = await extractFromPage(frame, {
          ...opts,
          followIframes: false,
          maxDepth: maxDepth - 1,
          headers: { referer: pageUrl, ...headers },
        });
        for (const r of inner) results.push({ ...r, via: r.via === 'iframe' ? 'iframe' : 'iframe' });
      } catch {
        /* ignore */
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/** Best-effort: resolve a page/embed URL to a single playable stream. */
export async function resolvePageToStream(
  pageUrl: string,
  headers: Record<string, string> = {},
): Promise<{ url: string; kind: StreamKind; via: string } | null> {
  const found = await extractFromPage(pageUrl, { headers });
  const top = found.find((f) => f.kind !== 'torrent' && f.score > 0);
  return top ? { url: top.url, kind: top.kind, via: top.via } : null;
}
