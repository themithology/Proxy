import { resolveUrl } from '../util/url.js';

/**
 * HLS (M3U8) parsing and URI rewriting.
 *
 * Rewriting is what makes an upstream stream playable in a browser: every URI
 * inside the manifest is replaced with a URL on our own origin so the player
 * never talks to the upstream host directly (no CORS, no Referer checks, no
 * mixed content, and per-upstream headers are applied server-side).
 *
 * The rewriter is deliberately line-oriented: anything it does not explicitly
 * understand is passed through byte-for-byte, so new HLS tags keep working.
 */

export type UriContext =
  | 'variant' // playlist of a variant (master playlist)
  | 'iframe' // EXT-X-I-FRAME-STREAM-INF
  | 'media' // EXT-X-MEDIA rendition (audio / video)
  | 'subtitle' // EXT-X-MEDIA rendition of TYPE=SUBTITLES
  | 'segment' // a media segment URI line
  | 'key' // EXT-X-KEY / EXT-X-SESSION-KEY
  | 'map' // EXT-X-MAP (fMP4 init segment)
  | 'part' // EXT-X-PART (low-latency partial segment)
  | 'preload' // EXT-X-PRELOAD-HINT
  | 'rendition-report'
  | 'unknown';

export type RewriteFn = (absoluteUri: string, context: UriContext) => string;

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;

/** Parse `A=1,B="x,y"` style tag attributes. Quoted values may contain commas. */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = input.includes(':') ? input.slice(input.indexOf(':') + 1) : input;
  for (const m of body.matchAll(ATTR_RE)) {
    const key = m[1];
    let val = m[2] ?? '';
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    out[key!.toUpperCase()] = val;
  }
  return out;
}

function quote(value: string): string {
  // Quoted strings are always valid for URI-typed attributes.
  return `"${value.replace(/"/g, '')}"`;
}

/** Replace (or append) a single attribute, leaving the rest untouched. */
export function setAttribute(line: string, name: string, value: string): string {
  const re = new RegExp(`(?<![A-Z0-9-])${name}=("[^"]*"|[^,]*)`, 'i');
  if (re.test(line)) {
    return line.replace(re, `${name}=${quote(value)}`);
  }
  const comma = line.endsWith(',') ? '' : ',';
  return `${line}${comma}${name}=${quote(value)}`;
}

export function getAttribute(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(`(?<![A-Z0-9-])${name}=("([^"]*)"|[^,]*)`, 'i'));
  if (!m) return undefined;
  const v = m[2] ?? m[1] ?? '';
  return v.startsWith('"') ? v.slice(1, -1) : v;
}

/** The part of a tag line before the attribute list, e.g. "#EXT-X-KEY". */
function tagName(line: string): string {
  const i = line.indexOf(':');
  return (i === -1 ? line : line.slice(0, i)).trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Parsed model
// ---------------------------------------------------------------------------

export interface Variant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audio?: string;
  video?: string;
  subtitles?: string;
  hdcpLevel?: string;
  uriRewritten?: string;
}

export interface Rendition {
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS' | string;
  groupId?: string;
  name?: string;
  language?: string;
  assocLanguage?: string;
  isDefault: boolean;
  autoselect: boolean;
  forced: boolean;
  uri?: string;
  channels?: number;
  characteristics?: string;
  uriRewritten?: string;
}

export interface ParsedPlaylist {
  isMaster: boolean;
  version?: number;
  targetDuration?: number;
  mediaSequence?: number;
  discontinuitySequence?: number;
  endlist: boolean;
  encrypted: boolean;
  keyUris: string[];
  /** True when segments are fMP4 (has EXT-X-MAP) rather than MPEG-TS. */
  usesFmp4: boolean;
  variants: Variant[];
  renditions: Rendition[];
  segmentUris: string[];
  /** Media playlist URIs of subtitle renditions, resolved. */
  subtitlePlaylists: Rendition[];
}

export function parseM3u8(text: string, baseUrl: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/);
  const parsed: ParsedPlaylist = {
    isMaster: false,
    endlist: false,
    encrypted: false,
    keyUris: [],
    usesFmp4: false,
    variants: [],
    renditions: [],
    segmentUris: [],
    subtitlePlaylists: [],
  };

  let pendingVariant: Variant | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const tag = tagName(line);

      switch (tag) {
        case '#EXT-X-VERSION':
          parsed.version = Number(line.split(':')[1]) || undefined;
          break;
        case '#EXT-X-TARGETDURATION':
          parsed.targetDuration = Number(line.split(':')[1]) || undefined;
          break;
        case '#EXT-X-MEDIA-SEQUENCE':
          parsed.mediaSequence = Number(line.split(':')[1]) || undefined;
          break;
        case '#EXT-X-DISCONTINUITY-SEQUENCE':
          parsed.discontinuitySequence = Number(line.split(':')[1]) || undefined;
          break;
        case '#EXT-X-ENDLIST':
          parsed.endlist = true;
          break;
        case '#EXT-X-KEY':
        case '#EXT-X-SESSION-KEY': {
          const a = parseAttributes(line);
          if (a.METHOD && a.METHOD !== 'NONE') {
            parsed.encrypted = true;
            if (a.URI) parsed.keyUris.push(resolveUrl(baseUrl, a.URI));
          }
          break;
        }
        case '#EXT-X-MAP': {
          parsed.usesFmp4 = true;
          break;
        }
        case '#EXT-X-STREAM-INF': {
          parsed.isMaster = true;
          const a = parseAttributes(line);
          const res = a.RESOLUTION?.match(/^(\d+)x(\d+)$/);
          pendingVariant = {
            uri: '',
            bandwidth: Number(a.BANDWIDTH) || undefined,
            averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || undefined,
            width: res ? Number(res[1]) : undefined,
            height: res ? Number(res[2]) : undefined,
            codecs: a.CODECS,
            frameRate: Number(a['FRAME-RATE']) || undefined,
            audio: a.AUDIO,
            video: a.VIDEO,
            subtitles: a.SUBTITLES,
            hdcpLevel: a['HDCP-LEVEL'],
          };
          break;
        }
        case '#EXT-X-I-FRAME-STREAM-INF': {
          parsed.isMaster = true;
          break;
        }
        case '#EXT-X-MEDIA': {
          parsed.isMaster = true;
          const a = parseAttributes(line);
          parsed.renditions.push({
            type: a.TYPE ?? 'UNKNOWN',
            groupId: a['GROUP-ID'],
            name: a.NAME,
            language: a.LANGUAGE,
            assocLanguage: a['ASSOC-LANGUAGE'],
            isDefault: (a.DEFAULT ?? '').toUpperCase() === 'YES',
            autoselect: (a.AUTOSELECT ?? '').toUpperCase() === 'YES',
            forced: (a.FORCED ?? '').toUpperCase() === 'YES',
            uri: a.URI ? resolveUrl(baseUrl, a.URI) : undefined,
            channels: a.CHANNELS ? Number(a.CHANNELS) : undefined,
            characteristics: a.CHARACTERISTICS,
          });
          break;
        }
        default:
          break;
      }
      continue;
    }

    // URI line
    if (pendingVariant) {
      pendingVariant.uri = resolveUrl(baseUrl, line);
      parsed.variants.push(pendingVariant);
      pendingVariant = null;
    } else {
      parsed.segmentUris.push(resolveUrl(baseUrl, line));
    }
  }

  parsed.subtitlePlaylists = parsed.renditions.filter(
    (r) => r.type === 'SUBTITLES' && r.uri,
  );

  // Some masters carry an EXT-X-MEDIA but no STREAM-INF (audio-only, rare).
  if (!parsed.isMaster && parsed.renditions.length) parsed.isMaster = true;

  return parsed;
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite every URI in a playlist so it points at our proxy.
 *
 * @param text   raw playlist body
 * @param baseUrl the URL the playlist was fetched from (for relative URIs)
 * @param rewrite maps an absolute upstream URI to our proxied URL
 */
export function rewriteM3u8(text: string, baseUrl: string, rewrite: RewriteFn): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  // Tracks whether the *next* URI line belongs to a variant (master playlist).
  let nextIsVariant = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      out.push(rawLine);
      continue;
    }

    if (line.startsWith('#')) {
      const tag = tagName(line);

      // Tags whose URI lives in an attribute.
      switch (tag) {
        case '#EXT-X-MEDIA': {
          const a = parseAttributes(line);
          let newLine = line;
          if (a.URI) {
            const ctx: UriContext = (a.TYPE ?? '').toUpperCase() === 'SUBTITLES'
              ? 'subtitle'
              : 'media';
            newLine = setAttribute(newLine, 'URI', rewrite(resolveUrl(baseUrl, a.URI), ctx));
          }
          out.push(newLine);
          continue;
        }
        case '#EXT-X-KEY':
        case '#EXT-X-SESSION-KEY': {
          const a = parseAttributes(line);
          let newLine = line;
          if (a.URI && a.METHOD !== 'NONE') {
            newLine = setAttribute(
              newLine,
              'URI',
              rewrite(resolveUrl(baseUrl, a.URI), 'key'),
            );
          }
          out.push(newLine);
          continue;
        }
        case '#EXT-X-MAP': {
          const a = parseAttributes(line);
          let newLine = line;
          if (a.URI) {
            newLine = setAttribute(
              newLine,
              'URI',
              rewrite(resolveUrl(baseUrl, a.URI), 'map'),
            );
          }
          out.push(newLine);
          continue;
        }
        case '#EXT-X-PART': {
          const a = parseAttributes(line);
          let newLine = line;
          if (a.URI) {
            newLine = setAttribute(
              newLine,
              'URI',
              rewrite(resolveUrl(baseUrl, a.URI), 'part'),
            );
          }
          out.push(newLine);
          continue;
        }
        case '#EXT-X-PRELOAD-HINT':
        case '#EXT-X-RENDITION-REPORT': {
          const a = parseAttributes(line);
          let newLine = line;
          if (a.URI) {
            newLine = setAttribute(
              newLine,
              'URI',
              rewrite(resolveUrl(baseUrl, a.URI), tag === '#EXT-X-PRELOAD-HINT' ? 'preload' : 'rendition-report'),
            );
          }
          out.push(newLine);
          continue;
        }
        case '#EXT-X-I-FRAME-STREAM-INF': {
          const a = parseAttributes(line);
          let newLine = line;
          if (a.URI) {
            newLine = setAttribute(
              newLine,
              'URI',
              rewrite(resolveUrl(baseUrl, a.URI), 'iframe'),
            );
          }
          out.push(newLine);
          continue;
        }
        case '#EXT-X-STREAM-INF': {
          nextIsVariant = true;
          out.push(line);
          continue;
        }
        default:
          out.push(rawLine);
          continue;
      }
    }

    // Plain URI line: either a variant playlist or a media segment.
    const ctx: UriContext = nextIsVariant ? 'variant' : 'segment';
    nextIsVariant = false;
    out.push(rewrite(resolveUrl(baseUrl, line), ctx));
  }

  return out.join('\n');
}

/** Pick the variant closest to a requested height ( masters only ). */
export function pickVariant(variants: Variant[], targetHeight?: number): Variant | undefined {
  if (!variants.length) return undefined;
  if (!targetHeight) {
    return [...variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  }
  return [...variants].sort((a, b) => {
    const ah = a.height ?? 0;
    const bh = b.height ?? 0;
    const ad = Math.abs(ah - targetHeight);
    const bd = Math.abs(bh - targetHeight);
    if (ad !== bd) return ad - bd;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  })[0];
}

/** Turn `1920x1080` style resolution or a height into a quality label. */
export function variantQuality(v: Variant): string | undefined {
  return v.height ? `${v.height}p` : undefined;
}
