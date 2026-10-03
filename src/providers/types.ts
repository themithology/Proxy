import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Core media model
// ---------------------------------------------------------------------------

export type MediaType = 'movie' | 'series' | 'anime';

/** How a candidate stream must be handled by the player/proxy. */
export type StreamKind =
  | 'hls' // .m3u8  — rewritten + proxied
  | 'dash' // .mpd   — rewritten + proxied
  | 'mp4' // progressive file — proxied with Range support
  | 'embed' // an HTML page that must be extracted first
  | 'torrent' // magnet/infostream (Stremio style)
  | 'unknown';

export interface SubtitleTrack {
  url: string;
  /** ISO-639-1 when known, otherwise the provider's own label. */
  lang: string;
  label?: string;
  format: 'vtt' | 'srt' | 'ass' | 'unknown';
  headers?: Record<string, string>;
}

export interface StreamCandidate {
  /** Stable provider id that produced this candidate. */
  provider: string;
  providerName: string;
  /** Human label shown in a UI, e.g. "MovieBox · 1080p · Hindi". */
  name?: string;
  title?: string;
  url: string;
  kind: StreamKind;
  /** "2160p" | "1080p" | "720p" | "480p" | "auto" */
  quality?: string;
  /** Numeric height for sorting; derived when absent. */
  height?: number;
  /** Primary audio language (ISO-639-1) when known. */
  language?: string;
  audioLanguages?: string[];
  subtitles?: SubtitleTrack[];
  /** Headers required to fetch `url` (Referer, Origin, Cookie, auth…). */
  headers?: Record<string, string>;
  sizeBytes?: number;
  seeders?: number;
  peers?: number;
  /** Free-form extras surfaced in the API for debugging/UI. */
  meta?: Record<string, string | number | boolean | undefined>;
  /** Provider-specific payload kept for advanced clients. */
  raw?: unknown;
}

export interface CatalogItem {
  id: string; // imdb id when known, else provider-native id
  provider: string;
  type: MediaType;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  description?: string;
  imdbId?: string;
  tmdbId?: string;
  genres?: string[];
  rating?: number;
}

/** Everything a provider needs to resolve streams for one playable item. */
export interface ResolveQuery {
  type: MediaType;
  /** IMDB id (tt…) — the canonical key across providers. */
  imdbId?: string;
  tmdbId?: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Absolute episode number (anime providers often need this). */
  absoluteEpisode?: number;
  /** Preferred audio languages, ISO-639-1. Empty = any. */
  languages?: string[];
  signal?: AbortSignal;
}

export interface SearchQuery {
  query: string;
  type?: MediaType;
  page?: number;
  signal?: AbortSignal;
}

export interface CatalogQuery {
  type: MediaType;
  /** Provider-defined, e.g. genre id or "popular"/"trending". */
  category?: string;
  page?: number;
  languages?: string[];
  signal?: AbortSignal;
}

export interface ProviderHealth {
  id: string;
  ok: boolean;
  /** ms; -1 when unknown. */
  latencyMs: number;
  lastError?: string;
  lastOkAt?: number;
  /** True while the circuit breaker is open. */
  cooling: boolean;
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface ProviderMeta {
  id: string;
  name: string;
  description?: string;
  /** Home page / upstream service, for docs. */
  website?: string;
  types: MediaType[];
  /** ISO-639-1 codes this provider is good at, or ['*'] for any. */
  languages: string[];
  /** Higher wins when merging/ranking results. 0-100. */
  priority: number;
  supports: {
    streams: boolean;
    search: boolean;
    catalog: boolean;
  };
}

export interface Provider extends ProviderMeta {
  enabled: boolean;
  /** Called once at boot; throw to disable the provider. */
  init(): Promise<void>;
  shutdown?(): Promise<void>;
  /** Cheap liveness probe used by /health and the circuit breaker. */
  ping(): Promise<void>;
  getStreams(q: ResolveQuery): Promise<StreamCandidate[]>;
  search?(q: SearchQuery): Promise<CatalogItem[]>;
  catalog?(q: CatalogQuery): Promise<CatalogItem[]>;
}

/** Constructor signature every provider module exports as `default`. */
export type ProviderFactory = (cfg: ProviderConfig) => Provider;

// ---------------------------------------------------------------------------
// Configuration schema (config/providers.json)
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  id: string;
  /** Module kind: stremio | archive | youtube | direct | webextract */
  kind: string;
  name: string;
  enabled: boolean;
  priority: number;
  languages: string[];
  types: MediaType[];
  description?: string;
  website?: string;
  /** Kind-specific settings. */
  options: Record<string, string | number | boolean | string[] | undefined>;
}

export interface ProvidersFile {
  /** Schema version. */
  version: number;
  providers: ProviderConfig[];
}

// ---------------------------------------------------------------------------
// Ranking helpers shared by the registry and the streams route
// ---------------------------------------------------------------------------

const QUALITY_HEIGHT: Record<string, number> = {
  '2160p': 2160,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720,
  '576p': 576,
  '480p': 480,
  '360p': 360,
  '240p': 240,
  '144p': 144,
};

/** Pull a height out of a free-form quality/label string. */
export function parseHeight(...parts: (string | undefined)[]): number | undefined {
  for (const p of parts) {
    if (!p) continue;
    const s = p.toLowerCase().replace(/\s+/g, '');
    const direct = QUALITY_HEIGHT[s];
    if (direct) return direct;
    // 4k / 2160 / 1080 / 720
    if (s === '4k' || s === 'uhd') return 2160;
    if (s === '8k') return 4320;
    if (s === 'hd') return 720;
    if (s === 'sd') return 480;
    const m = s.match(/(\d{3,4})\s*p/);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n >= 100 && n <= 4320) return n;
    }
    const m2 = s.match(/\b(2160|1440|1080|720|576|480|360|240)\b/);
    if (m2?.[1]) return Number(m2[1]);
  }
  return undefined;
}

/** Normalise a free-form language label to ISO-639-1 where we can. */
const LANG_ALIASES: Record<string, string> = {
  english: 'en',
  eng: 'en',
  hindi: 'hi',
  hin: 'hi',
  tamil: 'ta',
  tam: 'ta',
  telugu: 'te',
  tel: 'te',
  malayalam: 'ml',
  mal: 'ml',
  kannada: 'kn',
  kan: 'kn',
  marathi: 'mr',
  bengali: 'bn',
  ben: 'bn',
  punjabi: 'pa',
  gujarati: 'gu',
  urdu: 'ur',
  spanish: 'es',
  spa: 'es',
  latin: 'la',
  french: 'fr',
  fre: 'fr',
  german: 'de',
  ger: 'de',
  japanese: 'ja',
  jpn: 'ja',
  korean: 'ko',
  kor: 'ko',
  chinese: 'zh',
  chi: 'zh',
  thai: 'th',
  indonesian: 'id',
  portuguese: 'pt',
  russian: 'ru',
  arabic: 'ar',
  turkish: 'tr',
  italian: 'it',
  vietnamese: 'vi',
  nepali: 'ne',
  sinhala: 'si',
  odia: 'or',
  assamese: 'as',
  bhojpuri: 'bh',
};

export function normalizeLanguage(input?: string): string | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'multi' || s === 'multilingual') return 'multi';
  if (/^[a-z]{2,3}$/.test(s)) return s;
  return LANG_ALIASES[s] ?? s;
}

/** Guess the stream kind from a URL/content-type. */
export function guessKind(url: string, contentType?: string): StreamKind {
  const u = url.toLowerCase().split('?')[0] ?? '';
  const ct = (contentType ?? '').toLowerCase();

  if (ct.includes('mpegurl') || u.includes('.m3u8')) return 'hls';
  if (ct.includes('dash') || u.includes('.mpd')) return 'dash';
  if (ct.includes('mp4') || u.includes('.mp4')) return 'mp4';
  if (ct.includes('webm') || u.includes('.webm')) return 'mp4';
  if (ct.includes('mpeg') || u.includes('.mkv') || u.includes('.avi')) return 'mp4';
  if (u.startsWith('magnet:') || u.includes('.torrent')) return 'torrent';
  if (/\.(ts|m4s)(\?|$)/.test(u)) return 'hls';
  return 'unknown';
}

export type { z };
