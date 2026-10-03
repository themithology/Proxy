import { BaseProvider } from './base.js';
import { fetchJson } from '../util/http.js';
import { buildQuery, resolveUrl } from '../util/url.js';
import { parseHeight } from './types.js';
import type {
  CatalogItem,
  ProviderConfig,
  CatalogQuery,
  MediaType,
  ResolveQuery,
  SearchQuery,
  StreamCandidate,
  SubtitleTrack,
} from './types.js';

/**
 * Stremio addon provider.
 *
 * Implements the public Stremio addon protocol:
 *   GET {base}/manifest.json
 *   GET {base}/stream/{type}/{id}.json       id = tt1234567[:season:episode]
 *   GET {base}/catalog/{type}/{catId}[/search=query].json
 *
 * Any addon that speaks this protocol becomes a provider — which is how the
 * ecosystem (and apps like Hikari) stays source-agnostic.
 */

interface StremioManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  resources?: unknown;
  types?: string[];
  catalogs?: StremioCatalog[];
  idPrefixes?: string[];
  logo?: string;
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean };
}

interface StremioCatalog {
  type: string;
  id: string;
  name?: string;
  extraSupported?: string[];
  extraRequired?: string[];
  genres?: { id: string; name: string }[];
}

interface StremioSubtitle {
  id?: string;
  url: string;
  lang: string;
  SubEncoding?: string;
}

interface StremioStream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  sources?: string[];
  name?: string;
  title?: string;
  description?: string;
  subtitles?: StremioSubtitle[];
  behaviorHints?: {
    videoSize?: number;
    filename?: string;
    notWebReady?: boolean;
    bingeGroup?: string;
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
    headers?: Record<string, string>;
  };
}

interface StremioMetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string | number;
  imdbRating?: string | number;
  genres?: string[];
  links?: unknown[];
}

export class StremioProvider extends BaseProvider {
  private base = '';
  private manifest: StremioManifest | null = null;
  private catalogs: StremioCatalog[] = [];

  constructor(cfg: ProviderConfig) {
    super(cfg);
  }

  private get manifestUrl(): string {
    return this.opt<string>('manifestUrl', '') || this.opt<string>('baseUrl', '');
  }

  async init(): Promise<void> {
    const raw = this.manifestUrl;
    if (!raw) throw new Error('option "manifestUrl" is required');

    // Accept either the manifest URL or the addon base URL.
    const url = /manifest\.json$/i.test(raw) ? raw : `${raw.replace(/\/+$/, '')}/manifest.json`;

    const manifest = await fetchJson<StremioManifest>(url, {
      timeout: this.opt<number>('timeout', 10_000),
      headers: this.opt<Record<string, string>>('headers', {}),
    });

    if (!manifest?.id) throw new Error('addon manifest missing "id"');

    this.manifest = manifest;
    this.base = url.replace(/manifest\.json$/i, '').replace(/\/+$/, '');
    this.catalogs = manifest.catalogs ?? [];

    this.log.debug(
      { addon: manifest.name, types: manifest.types, catalogs: this.catalogs.length },
      'stremio manifest loaded',
    );
  }

  async ping(): Promise<void> {
    if (!this.manifest) {
      await fetchJson(`${this.base}/manifest.json`, { timeout: 8_000 });
      return;
    }
    // Cheap sanity call; a 200 means the addon is alive.
    await fetchJson(`${this.base}/manifest.json`, { timeout: 8_000 });
  }

  /** Build the Stremio id: tt1234567 or tt1234567:S:E */
  private stremioId(q: ResolveQuery): string | null {
    const id = q.imdbId;
    if (!id) return null;
    if (q.type === 'series' || q.type === 'anime') {
      if (q.season == null || q.episode == null) return null;
      return `${id}:${q.season}:${q.episode}`;
    }
    return id;
  }

  protected async doGetStreams(q: ResolveQuery): Promise<StreamCandidate[]> {
    const sid = this.stremioId(q);
    if (!sid) return []; // Stremio addons are keyed on IMDB ids.

    const url = `${this.base}/stream/${encodeURIComponent(q.type)}/${encodeURIComponent(
      sid,
    )}.json`;

    const data = await fetchJson<{ streams?: StremioStream[] }>(url, {
      timeout: this.opt<number>('timeout', 15_000),
      headers: this.opt<Record<string, string>>('headers', {}),
    });

    const out: StreamCandidate[] = [];
    for (const s of data.streams ?? []) out.push(...this.mapStream(s, q));
    return out;
  }

  private mapStream(s: StremioStream, q: ResolveQuery): StreamCandidate[] {
    const headers = {
      ...this.opt<Record<string, string>>('headers', {}),
      ...(s.behaviorHints?.proxyHeaders?.request ?? {}),
      ...(s.behaviorHints?.headers ?? {}),
    };

    const subs: SubtitleTrack[] = (s.subtitles ?? [])
      .filter((x) => !!x?.url)
      .map((x) => ({
        url: x.url,
        lang: x.lang ?? 'en',
        label: x.lang ?? 'Unknown',
        format: x.url.toLowerCase().includes('.srt') ? ('srt' as const) : ('vtt' as const),
        headers: Object.keys(headers).length ? headers : undefined,
      }));

    const label = s.description ?? s.title ?? s.name ?? '';
    const height = parseHeight(
      s.name,
      s.title,
      s.behaviorHints?.filename,
      s.description,
    );

    // Torrent / debrid-style stream
    if (s.infoHash) {
      const magnet =
        this.opt<boolean>('expandMagnet', true)
          ? `magnet:?xt=urn:btih:${s.infoHash}${buildQuery({
              dn: s.behaviorHints?.filename,
            }).replace('?', '&')}${this.trackers()
              .map((t) => `&tr=${encodeURIComponent(t)}`)
              .join('')}`
          : `magnet:?xt=urn:btih:${s.infoHash}`;

      return [
        {
          provider: this.id,
          providerName: this.name,
          name: [this.name, s.name, s.title].filter(Boolean).join(' · '),
          title: s.behaviorHints?.filename ?? label,
          url: magnet,
          kind: 'torrent',
          quality: height ? `${height}p` : undefined,
          height,
          sizeBytes: s.behaviorHints?.videoSize,
          subtitles: subs,
          headers: Object.keys(headers).length ? headers : undefined,
          meta: {
            infoHash: s.infoHash,
            fileIdx: s.fileIdx,
            sources: s.sources?.length ?? 0,
          },
          raw: s,
        },
      ];
    }

    // YouTube-sourced stream → official embed
    if (s.ytId) {
      return [
        {
          provider: this.id,
          providerName: this.name,
          name: [this.name, 'YouTube'].filter(Boolean).join(' · '),
          title: label,
          url: `https://www.youtube.com/embed/${s.ytId}`,
          kind: 'embed',
          height,
          quality: height ? `${height}p` : undefined,
          subtitles: subs,
          meta: { ytId: s.ytId },
          raw: s,
        },
      ];
    }

    if (s.externalUrl && !s.url) {
      return [
        {
          provider: this.id,
          providerName: this.name,
          name: [this.name, s.name].filter(Boolean).join(' · '),
          title: label,
          url: s.externalUrl,
          kind: 'embed',
          height,
          quality: height ? `${height}p` : undefined,
          subtitles: subs,
          headers: Object.keys(headers).length ? headers : undefined,
          raw: s,
        },
      ];
    }

    if (!s.url) return [];

    const url = resolveUrl(this.base, s.url);
    return [
      {
        provider: this.id,
        providerName: this.name,
        name: [this.name, s.name, s.title].filter(Boolean).join(' · '),
        title: label || s.behaviorHints?.filename,
        url,
        // Unknown here; the resolver sniffs the content type later.
        kind: 'unknown',
        height,
        quality: height ? `${height}p` : undefined,
        sizeBytes: s.behaviorHints?.videoSize,
        subtitles: subs,
        headers: Object.keys(headers).length ? headers : undefined,
        meta: {
          bingeGroup: s.behaviorHints?.bingeGroup,
          notWebReady: s.behaviorHints?.notWebReady,
          filename: s.behaviorHints?.filename,
        },
        raw: s,
      },
    ];
  }

  private trackers(): string[] {
    const custom = this.opt<string[]>('trackers', []);
    if (custom.length) return custom;
    return [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://exodus.desync.com:6969/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
    ];
  }

  // --- search / catalog ----------------------------------------------------

  override async search(q: SearchQuery): Promise<CatalogItem[]> {
    const cat = this.catalogs.find(
      (c) =>
        (!q.type || c.type === q.type || (q.type === 'anime' && c.type === 'series')) &&
        c.extraSupported?.includes('search'),
    );
    if (!cat) return [];

    const url = `${this.base}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(
      cat.id,
    )}/search=${encodeURIComponent(q.query)}.json`;

    const data = await fetchJson<{ metas?: StremioMetaPreview[] }>(url, {
      timeout: this.opt<number>('timeout', 15_000),
      headers: this.opt<Record<string, string>>('headers', {}),
    });

    return this.mapMetas(data.metas ?? []);
  }

  override async catalog(q: CatalogQuery): Promise<CatalogItem[]> {
    const cat = this.catalogs.find(
      (c) =>
        (c.type === q.type || (q.type === 'anime' && c.type === 'series')) &&
        (!q.category || c.id === q.category),
    );
    if (!cat) return [];

    const segments =
      q.page && q.page > 1 && cat.extraSupported?.includes('skip')
        ? `/skip=${(q.page - 1) * 50}`
        : '';

    const url = `${this.base}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(
      cat.id,
    )}${segments}.json`;

    const data = await fetchJson<{ metas?: StremioMetaPreview[] }>(url, {
      timeout: this.opt<number>('timeout', 15_000),
      headers: this.opt<Record<string, string>>('headers', {}),
    });

    return this.mapMetas(data.metas ?? []);
  }

  private mapMetas(metas: StremioMetaPreview[]): CatalogItem[] {
    return metas.map((m) => ({
      id: m.id,
      provider: this.id,
      type: (m.type as MediaType) ?? 'movie',
      title: m.name,
      year: typeof m.releaseInfo === 'number' ? m.releaseInfo : Number(m.releaseInfo) || undefined,
      poster: m.poster,
      backdrop: m.background,
      description: m.description,
      imdbId: m.id.startsWith('tt') ? m.id : undefined,
      genres: m.genres,
      rating: typeof m.imdbRating === 'number' ? m.imdbRating : Number(m.imdbRating) || undefined,
    }));
  }
}
