import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { resolveUrl } from '../util/url.js';

/**
 * DASH (MPEG-DASH MPD) parsing and rewriting.
 *
 * DASH manifests address segments in three different ways, and all three need
 * handling:
 *   • SegmentBase   — one contiguous range per Representation (+ init range)
 *   • SegmentList   — an explicit list of SegmentURL@media
 *   • SegmentTemplate — a URL template containing $Number$ / $Time$ / $Bandwidth$
 *
 * SegmentTemplate is the tricky one: the *player* substitutes the placeholders,
 * so our rewritten template must keep them visible in the query string. The
 * proxy route re-injects them before fetching upstream (see `templateParams`).
 */

export interface MpdRepresentation {
  id?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  frameRate?: string;
  baseUrl?: string;
  /** 'video' | 'audio' | 'text' | 'image' */
  contentType?: 'video' | 'audio' | 'text' | 'image' | string;
  lang?: string;
}

export interface ParsedMpd {
  durationSeconds?: number;
  isLive: boolean;
  representations: MpdRepresentation[];
  subtitleReps: MpdRepresentation[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  removeNSPrefix: false,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: false,
  processEntities: true,
  suppressEmptyNode: false,
});

const arr = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

function guessContentType(rep: Record<string, unknown>): string {
  const ct = String(rep['@_contentType'] ?? '').toLowerCase();
  if (ct) return ct;
  const mime = String(rep['@_mimeType'] ?? '').toLowerCase();
  if (mime.startsWith('video')) return 'video';
  if (mime.startsWith('audio')) return 'audio';
  if (mime.startsWith('text') || mime.includes('vtt') || mime.includes('ttml')) {
    return 'text';
  }
  if (mime.startsWith('image')) return 'image';
  // Fall back to the adaptation set the representation sits in.
  return '';
}

export function parseMpd(text: string, baseUrl: string): ParsedMpd {
  let doc: any;
  try {
    doc = parser.parse(text);
  } catch {
    return { isLive: false, representations: [], subtitleReps: [] };
  }

  const mpd = doc?.MPD;
  if (!mpd) return { isLive: false, representations: [], subtitleReps: [] };

  const isLive = String(mpd['@_type'] ?? 'static').toLowerCase() === 'dynamic';

  let durationSeconds: number | undefined;
  const dur = mpd['@_mediaPresentationDuration'] ?? mpd['@_duration'];
  if (dur) {
    const m = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(
      String(dur),
    );
    if (m) {
      durationSeconds =
        Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
    }
  }

  const representations: MpdRepresentation[] = [];
  const subtitleReps: MpdRepresentation[] = [];

  for (const period of arr<any>(mpd.Period)) {
    for (const as of arr<any>(period.AdaptationSet)) {
      const setContentType = guessContentType(as);
      const setMime = String(as['@_mimeType'] ?? '');
      const setLang = String(as['@_lang'] ?? '');
      const setCodecs = String(as['@_codecs'] ?? '');

      for (const rep of arr<any>(as.Representation)) {
        const ct = guessContentType(rep) || setContentType;
        const baseUrlRaw = rep.BaseURL ?? as.BaseURL;
        const baseUrlText =
          typeof baseUrlRaw === 'string'
            ? baseUrlRaw
            : typeof baseUrlRaw?.['#text'] === 'string'
              ? baseUrlRaw['#text']
              : undefined;

        const entry: MpdRepresentation = {
          id: rep['@_id'] ? String(rep['@_id']) : undefined,
          bandwidth: Number(rep['@_bandwidth']) || undefined,
          width: Number(rep['@_width']) || undefined,
          height: Number(rep['@_height']) || undefined,
          codecs: String(rep['@_codecs'] ?? setCodecs) || undefined,
          mimeType: String(rep['@_mimeType'] ?? setMime) || undefined,
          frameRate: rep['@_frameRate'] ? String(rep['@_frameRate']) : undefined,
          baseUrl: baseUrlText ? resolveUrl(baseUrl, baseUrlText) : undefined,
          contentType: ct,
          lang: String(rep['@_lang'] ?? setLang) || undefined,
        };

        representations.push(entry);
        if (ct === 'text') subtitleReps.push(entry);
      }
    }
  }

  return { durationSeconds, isLive, representations, subtitleReps };
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

export type MpdRewriteFn = (absoluteUri: string, context: 'base' | 'segment' | 'init' | 'template') => string;

/**
 * Walk the parsed MPD and rewrite every URL-ish node in place, then rebuild.
 */
/** Read the text of a BaseURL node (string | {#text} | array). */
function baseUrlText(node: Record<string, any>): string | undefined {
  const v = node?.BaseURL;
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && typeof first['#text'] === 'string') {
      return first['#text'];
    }
    return undefined;
  }
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'];
  return undefined;
}

/** Replace a BaseURL node's text in place. */
function setBaseUrlText(node: Record<string, any>, value: string): void {
  const v = node.BaseURL;
  if (typeof v === 'string') {
    node.BaseURL = value;
  } else if (Array.isArray(v)) {
    node.BaseURL = v.map((item) => {
      if (typeof item === 'string') return value;
      if (item && typeof item === 'object') item['#text'] = value;
      return item;
    });
  } else if (v && typeof v === 'object') {
    v['#text'] = value;
  }
}

/**
 * Does this node address its segments through a child element rather than
 * straight through BaseURL? If so, BaseURL is only a *prefix* for those
 * children — we bake it into every child URL and then drop the element,
 * because a proxied BaseURL (with a query string) cannot be used as a
 * relative-URL base by the player.
 */
function hasSegmentAddressing(node: Record<string, any>): boolean {
  return !!(
    node?.SegmentTemplate ||
    node?.SegmentList ||
    node?.SegmentBase
  );
}

export function rewriteMpd(
  text: string,
  manifestBase: string,
  rewrite: MpdRewriteFn,
): string {
  let doc: any;
  try {
    doc = parser.parse(text);
  } catch {
    return text; // Not parseable — hand it back untouched rather than break playback.
  }

  const mpd = doc?.MPD;
  if (!mpd) return text;

  const docBase = mpd['@_xml:base'] ? resolveUrl(manifestBase, String(mpd['@_xml:base'])) : manifestBase;

  for (const period of arr<any>(mpd.Period)) {
    const periodBase = resolveUrl(docBase, baseUrlText(period) ?? '');

    for (const as of arr<any>(period.AdaptationSet)) {
      const asBase = resolveUrl(periodBase, baseUrlText(as) ?? '');

      for (const rep of arr<any>(as.Representation)) {
        const repBase = resolveUrl(asBase, baseUrlText(rep) ?? '');

        // --- SegmentTemplate (representation or adaptation-set level) -------
        for (const st of [
          ...arr<any>(rep.SegmentTemplate).map((n) => ({ node: n, base: repBase, parent: rep })),
          ...arr<any>(as.SegmentTemplate).map((n) => ({ node: n, base: asBase, parent: as })),
        ]) {
          if (st.node['@_media']) {
            st.node['@_media'] = rewrite(
              resolveUrl(st.base, String(st.node['@_media'])),
              'template',
            );
          }
          if (st.node['@_initialization']) {
            st.node['@_initialization'] = rewrite(
              resolveUrl(st.base, String(st.node['@_initialization'])),
              'init',
            );
          }
        }

        // --- SegmentList ----------------------------------------------------
        for (const sl of [
          ...arr<any>(rep.SegmentList).map((n) => ({ node: n, base: repBase })),
          ...arr<any>(as.SegmentList).map((n) => ({ node: n, base: asBase })),
        ]) {
          const listBase = resolveUrl(sl.base, baseUrlText(sl.node) ?? '');
          for (const su of arr<any>(sl.node.SegmentURL)) {
            if (su?.['@_media']) {
              su['@_media'] = rewrite(resolveUrl(listBase, String(su['@_media'])), 'segment');
            }
          }
          if (sl.node.BaseURL) delete sl.node.BaseURL;
        }

        // --- SegmentBase (single-range + init) ------------------------------
        for (const sb of arr<any>(rep.SegmentBase)) {
          const sbBase = resolveUrl(repBase, baseUrlText(sb) ?? '');
          if (sb?.Initialization?.['@_sourceURL']) {
            sb.Initialization['@_sourceURL'] = rewrite(
              resolveUrl(sbBase, String(sb.Initialization['@_sourceURL'])),
              'init',
            );
          }
          for (const ri of arr<any>(sb.RepresentationIndex)) {
            if (ri?.['@_sourceURL']) {
              ri['@_sourceURL'] = rewrite(
                resolveUrl(sbBase, String(ri['@_sourceURL'])),
                'init',
              );
            }
          }
          if (sb.BaseURL) delete sb.BaseURL;
        }

        // BaseURL is now redundant for segment-addressed representations.
        if (hasSegmentAddressing(rep)) {
          if (rep.BaseURL) delete rep.BaseURL;
        } else if (rep.BaseURL) {
          setBaseUrlText(rep, rewrite(repBase, 'base'));
        }
      }

      if (hasSegmentAddressing(as)) {
        if (as.BaseURL) delete as.BaseURL;
      } else if (as.BaseURL) {
        setBaseUrlText(as, rewrite(asBase, 'base'));
      }
    }
  }

  try {
    // The builder re-emits the declaration; strip it so we don't emit two.
    const built = builder.build(doc).replace(/^\s*<\?xml[^>]*\?>\s*/i, '');
    return `<?xml version="1.0" encoding="UTF-8"?>\n${built}`;
  } catch {
    return text;
  }
}
