/** Parsing of the loose id formats clients like to send us. */

export interface ParsedId {
  imdbId?: string;
  tmdbId?: string;
  /** Raw id when it's neither IMDB nor TMDB (kitsu:123, direct:abc…). */
  native?: { prefix: string; value: string };
  /** The numeric id, when the input was a bare number. */
  numeric?: number;
}

const IMDB_RE = /^(imdb:)?(tt\d{5,12})$/i;
const TMDB_RE = /^(tmdb:)?(\d{1,10})$/i;
const PREFIX_RE = /^([a-z][a-z0-9_-]*):(.+)$/i;

export function parseId(input: string): ParsedId {
  const raw = (input ?? '').trim();
  if (!raw) return {};

  const imdb = IMDB_RE.exec(raw);
  if (imdb) return { imdbId: imdb[2]!.toLowerCase() };

  const tmdb = TMDB_RE.exec(raw);
  if (tmdb) return { tmdbId: tmdb[2]!, numeric: Number(tmdb[2]) };

  const prefixed = PREFIX_RE.exec(raw);
  if (prefixed) {
    const prefix = prefixed[1]!.toLowerCase();
    const value = prefixed[2]!;
    if (prefix === 'imdb') return { imdbId: value.toLowerCase() };
    if (prefix === 'tmdb') return { tmdbId: value, numeric: Number(value) || undefined };
    return { native: { prefix, value } };
  }

  return {};
}

/** Normalise a media type string from the URL. */
export function parseType(input: string): 'movie' | 'series' | 'anime' {
  const t = (input ?? '').toLowerCase();
  if (t === 'tv' || t === 'show' || t === 'shows' || t === 'series') return 'series';
  if (t === 'anime') return 'anime';
  return 'movie';
}

/** Split a comma/space separated language list. */
export function parseLanguages(input?: string | string[]): string[] {
  const raw = Array.isArray(input) ? input.join(',') : (input ?? '');
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}
