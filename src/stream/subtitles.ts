/**
 * Subtitle fetching, transcoding and normalisation.
 *
 * Players only reliably render WebVTT, and upstream sources ship SRT, SSA/ASS
 * or TTML. We convert on the fly so a single player can use every source.
 */

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' | 'unknown';

const SRT_TIME =
  /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const ASS_TIME =
  /Dialogue:\s*\d+,(\d+):(\d{2}):(\d{2})[.:](\d{1,3}),(\d+):(\d{2}):(\d{2})[.:](\d{1,3}),/;

/** Detect the format of a subtitle payload (cheap heuristics, no deps). */
export function detectFormat(text: string, url = ''): SubtitleFormat {
  const head = text.slice(0, 4096);
  if (/^WEBVTT/i.test(head.trimStart())) return 'vtt';
  if (/<tt\b|tt\s+xmlns|<body[^>]*xmlns/i.test(head)) return 'ttml';
  if (/\[Script Info\]/i.test(head) || /^Dialogue:/m.test(head)) return 'ass';
  if (SRT_TIME.test(head)) return 'srt';
  if (/\.vtt(\?|$)/i.test(url)) return 'vtt';
  if (/\.(ass|ssa)(\?|$)/i.test(url)) return 'ass';
  if (/\.srt(\?|$)/i.test(url)) return 'srt';
  if (/\.(xml|ttml|dfxp)(\?|$)/i.test(url)) return 'ttml';
  return 'unknown';
}

/** Decode bytes with a declared charset, falling back gracefully. */
export function decodeText(buf: Buffer, declared?: string): string {
  const candidates = [declared, 'utf-8', 'windows-1252', 'iso-8859-1', 'utf-16le']
    .filter(Boolean) as string[];

  for (const enc of candidates) {
    try {
      const norm = enc.toLowerCase().replace(/[^a-z0-9]/g, '');
      let name = norm;
      if (norm === 'utf8') name = 'utf-8';
      if (norm === 'utf16le' || norm === 'utf16') name = 'utf-16le';
      if (norm === 'cp1252' || norm === 'windows1252') name = 'windows-1252';
      if (norm === 'latin1' || norm === 'iso88591') name = 'latin1';

      const out = new TextDecoder(name, { fatal: true }).decode(buf);
      // Reject decodes that produced a pile of replacement chars.
      if (!out.includes('�')) return out;
    } catch {
      /* try next */
    }
  }
  return buf.toString('utf8');
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function assTimeToVtt(h: string, m: string, s: string, ms: string): string {
  const pad = (n: string, len = 2) => n.padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function srtTimeToVtt(
  h: string,
  m: string,
  s: string,
  ms: string,
): string {
  const pad = (n: string, len = 2) => n.padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${(ms ?? '0').padEnd(3, '0')}`;
}

/** Remove SSA/ASS and SRT inline markup, keeping readable text. */
function cleanInline(input: string, format: SubtitleFormat): string {
  let s = input;

  if (format === 'ass' || format === 'ssa') {
    // {\i1}…{\i0} style override blocks, \N and \n line breaks, \h hard space.
    s = s.replace(/\{[^}]*\}/g, '');
    s = s.replace(/\\[Nn]/g, '\n');
    s = s.replace(/\\h/g, ' ');
  }

  // Common tag cleanup for srt/ass.
  s = s.replace(/<\/?[biu]>/gi, '');
  s = s.replace(/<font[^>]*>|<\/font>/gi, '');
  s = s.replace(/<\/?[^>]+>/g, '');
  return s;
}

function vttEscape(s: string): string {
  // Only `-->` inside cue text is dangerous; escape it.
  return s.replace(/-->/g, '-\u200b->');
}

/** Convert any supported subtitle payload to WebVTT. */
export function toVtt(raw: string, format: SubtitleFormat = 'unknown'): string {
  const text = stripBom(raw).replace(/\r\n?/g, '\n');
  const fmt = format === 'unknown' ? detectFormat(text) : format;

  if (fmt === 'vtt') {
    return text.startsWith('WEBVTT') ? text : `WEBVTT\n\n${text}`;
  }

  if (fmt === 'ass' || fmt === 'ssa') {
    return assToVtt(text);
  }

  if (fmt === 'ttml') {
    return ttmlToVtt(text);
  }

  return srtToVtt(text);
}

function srtToVtt(text: string): string {
  const out: string[] = ['WEBVTT', ''];

  // SRT cues are blank-line separated blocks: index / time / text…
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;

    const timeIdx = lines.findIndex((l) => SRT_TIME.test(l));
    if (timeIdx === -1) continue;

    const m = SRT_TIME.exec(lines[timeIdx]!)!;
    const start = srtTimeToVtt(m[1]!, m[2]!, m[3]!, m[4]!);
    const end = srtTimeToVtt(m[5]!, m[6]!, m[7]!, m[8]!);

    const body = lines
      .slice(timeIdx + 1)
      .map((l) => cleanInline(l, 'srt'))
      .map(vttEscape)
      .join('\n')
      .trim();

    if (!body) continue;

    out.push(`${start} --> ${end}`);
    out.push(body);
    out.push('');
  }

  return out.join('\n');
}

function assToVtt(text: string): string {
  const out: string[] = ['WEBVTT', ''];
  const lines = text.split('\n');

  // Parse the [Events] Format: line so we can find the text column.
  let textCol = 9; // default: 10th field in a standard SSA Dialogue line
  let inEvents = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (/^\[Events\]/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[/i.test(line)) {
      inEvents = false;
      continue;
    }

    if (inEvents && /^Format:/i.test(line)) {
      const fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      const idx = fields.indexOf('text');
      if (idx !== -1) textCol = idx;
      continue;
    }

    if (!/^Dialogue:/i.test(line)) continue;

    const m = ASS_TIME.exec(line);
    if (!m) continue;

    const start = assTimeToVtt(m[1]!, m[2]!, m[3]!, m[4]!);
    const end = assTimeToVtt(m[5]!, m[6]!, m[7]!, m[8]!);

    // Split on commas *outside* the text field: text is last, so take the tail.
    const parts = line.split(',');
    const body = (parts.length > textCol ? parts.slice(textCol).join(',') : '')
      .split('\n')
      .map((l) => cleanInline(l, 'ass'))
      .map(vttEscape)
      .join('\n')
      .trim();

    if (!body) continue;

    out.push(`${start} --> ${end}`);
    out.push(body);
    out.push('');
  }

  return out.join('\n');
}

function ttmlToVtt(text: string): string {
  const out: string[] = ['WEBVTT', ''];

  const timeRe =
    /begin="([^"]+)"[^>]*end="([^"]+)"|end="([^"]+)"[^>]*begin="([^"]+)"/i;

  // Crude but effective: iterate <p …>…</p> elements.
  for (const m of text.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const t = timeRe.exec(attrs);
    if (!t) continue;

    const begin = t[1] ?? t[4];
    const end = t[2] ?? t[3];
    if (!begin || !end) continue;

    const body = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (!body) continue;

    out.push(`${ttmlTime(begin)} --> ${ttmlTime(end)}`);
    out.push(body);
    out.push('');
  }

  return out.join('\n');
}

/** Convert TTML clock/time values ("00:01:02.500", "62.5s", "1.5h") to VTT. */
function ttmlTime(v: string): string {
  const s = v.trim();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');

  // hh:mm:ss[.mmm] or mm:ss[.mmm]
  let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s);
  if (m) {
    const h = Number(m[1] ?? 0);
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    const ms = Number((m[4] ?? '0').padEnd(3, '0'));
    return `${pad(h)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
  }

  // Metric: 62.5s / 1.5h / 900ms
  m = /^([\d.]+)(ms|s|m|h)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const seconds =
      unit === 'ms' ? n / 1000 : unit === 's' ? n : unit === 'm' ? n * 60 : n * 3600;
    const h = Math.floor(seconds / 3600);
    const mm = Math.floor((seconds % 3600) / 60);
    const ss = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${pad(h)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
  }

  return '00:00:00.000';
}

/** Map an ISO-639-1/2 code to a human label for the player's track menu. */
const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  kn: 'Kannada',
  mr: 'Marathi',
  bn: 'Bengali',
  pa: 'Punjabi',
  gu: 'Gujarati',
  ur: 'Urdu',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  th: 'Thai',
  id: 'Indonesian',
  ar: 'Arabic',
  tr: 'Turkish',
  vi: 'Vietnamese',
  ne: 'Nepali',
  si: 'Sinhala',
};

export function languageLabel(code?: string): string {
  if (!code) return 'Unknown';
  return LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}
