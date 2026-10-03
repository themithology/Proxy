import { logFor } from '../logger.js';
import { proxyUrl } from './proxy.js';
import { sniffKind } from './proxy.js';
import { extractFromPage } from './extract.js';
import { languageLabel } from './subtitles.js';
import { stableHash } from '../util/crypto.js';
import type { StreamCandidate, SubtitleTrack } from '../providers/types.js';

const log = logFor('playback');

export interface PlaybackPayload {
  type: 'hls' | 'dash' | 'mp4' | 'embed' | 'torrent' | 'unknown';
  /** Proxied URL on our origin — always present and always playable. */
  url: string;
  /** Raw upstream URL. Only included when `exposeDirect` is requested. */
  direct?: string;
  /** For embeds that could not be resolved to a media URL. */
  embed?: string;
  /** How the final URL was obtained. */
  via?: 'direct' | 'extracted' | 'sniffed';
  infoHash?: string;
  headers?: Record<string, string>;
}

export interface ResolvedStream {
  id: string;
  provider: { id: string; name: string };
  name: string;
  title?: string;
  kind: string;
  quality?: string;
  height?: number;
  language?: string;
  audioLanguages?: string[];
  sizeBytes?: number;
  seeders?: number;
  subtitles: Array<{
    url: string;
    lang: string;
    label: string;
    format: string;
    direct?: string;
  }>;
  playback: PlaybackPayload;
  meta?: Record<string, string | number | boolean | undefined>;
}

export interface BuildOptions {
  /** Include the raw upstream URL in the response (opt-in). */
  exposeDirect?: boolean;
  /** Attempt to resolve embed/unknown URLs by scanning the page. */
  resolveEmbeds?: boolean;
}

/**
 * Turn a provider's candidate into something a player can consume:
 * a proxied URL on our origin plus a normalised track list.
 */
export async function buildResolved(
  candidate: StreamCandidate,
  opts: BuildOptions = {},
): Promise<ResolvedStream> {
  const headers = candidate.headers ?? {};
  const { exposeDirect = false, resolveEmbeds = true } = opts;

  let url = candidate.url;
  let kind = candidate.kind;
  let via: PlaybackPayload['via'] = 'direct';

  // Unknown kinds: sniff the content type before giving up.
  if (kind === 'unknown') {
    const sniffed = await sniffKind(url, headers, kind);
    kind = sniffed.kind;
    if (kind !== 'unknown') via = 'sniffed';
  }

  // Embeds: try to pull a real media URL out of the page.
  let embedFallback: string | undefined;
  if (kind === 'embed' && resolveEmbeds) {
    const found = await extractFromPage(url, { headers });
    const best = found.find((f) => f.kind !== 'torrent' && f.kind !== 'unknown');
    if (best) {
      url = best.url;
      kind = best.kind;
      via = 'extracted';
      log.debug({ from: candidate.url.slice(0, 80), to: kind }, 'embed resolved');
    } else {
      embedFallback = url;
    }
  }

  const playback = buildPlayback(url, kind, headers, {
    exposeDirect,
    embed: embedFallback,
    via,
  });

  return {
    id: stableHash(`${candidate.provider}|${url}|${candidate.quality ?? ''}`),
    provider: { id: candidate.provider, name: candidate.providerName },
    name: candidate.name ?? candidate.providerName,
    title: candidate.title,
    kind,
    quality: candidate.quality,
    height: candidate.height,
    language: candidate.language,
    audioLanguages: candidate.audioLanguages,
    sizeBytes: candidate.sizeBytes,
    seeders: candidate.seeders,
    subtitles: (candidate.subtitles ?? []).map((s) => mapSubtitle(s, exposeDirect)),
    playback,
    meta: candidate.meta,
  };
}

function buildPlayback(
  url: string,
  kind: string,
  headers: Record<string, string>,
  extra: {
    exposeDirect?: boolean;
    embed?: string;
    via?: PlaybackPayload['via'];
  },
): PlaybackPayload {
  const direct = extra.exposeDirect ? url : undefined;

  switch (kind) {
    case 'hls':
      return {
        type: 'hls',
        url: proxyUrl(url, headers, 'manifest'),
        direct,
        via: extra.via,
        headers: Object.keys(headers).length ? headers : undefined,
      };
    case 'dash':
      return {
        type: 'dash',
        url: proxyUrl(url, headers, 'manifest'),
        direct,
        via: extra.via,
        headers: Object.keys(headers).length ? headers : undefined,
      };
    case 'mp4':
      return {
        type: 'mp4',
        url: proxyUrl(url, headers, 'segment'),
        direct,
        via: extra.via,
        headers: Object.keys(headers).length ? headers : undefined,
      };
    case 'torrent':
      return {
        type: 'torrent',
        url,
        direct,
        via: extra.via,
        infoHash: /btih:([a-zA-Z0-9]+)/i.exec(url)?.[1],
      };
    case 'embed':
      return { type: 'embed', url, direct, via: extra.via, embed: extra.embed ?? url };
    default:
      // Last resort: hand it to the generic media proxy and let the client try.
      return { type: 'unknown', url: proxyUrl(url, headers, 'other'), direct, via: extra.via };
  }
}

function mapSubtitle(s: SubtitleTrack, exposeDirect?: boolean) {
  return {
    url: proxyUrl(s.url, s.headers ?? {}, 'subtitle'),
    lang: s.lang ?? 'en',
    label: s.label ?? languageLabel(s.lang),
    format: 'vtt',
    direct: exposeDirect ? s.url : undefined,
  };
}
