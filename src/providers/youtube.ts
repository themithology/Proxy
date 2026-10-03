import { BaseProvider } from './base.js';
import { fetchJson } from '../util/http.js';
import { parseHeight } from './types.js';
import type {
  CatalogItem,
  ProviderConfig,
  CatalogQuery,
  ResolveQuery,
  SearchQuery,
  StreamCandidate,
} from './types.js';

/**
 * YouTube provider.
 *
 * Three modes, all of which play through the official YouTube player:
 *   api       — YouTube Data API v3 search (needs `apiKey`)
 *   invidious — a user-configured Invidious instance (needs `invidiousUrl`)
 *   embed     — no search; resolves only when a ytId is already known
 *
 * This deliberately returns *embeds* rather than extracted media URLs: the
 * official player respects the uploader's rights and embeds are the supported
 * way to play YouTube content off-site.
 */

interface YtSearchResponse {
  items?: {
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
    };
  }[];
}

interface InvidiousVideo {
  title?: string;
  videoId?: string;
  author?: string;
  lengthSeconds?: number;
  videoThumbnails?: { url?: string; quality?: string }[];
  adaptiveFormats?: {
    url?: string;
    type?: string;
    container?: string;
    qualityLabel?: string;
    bitrate?: string;
    audioChannels?: number;
  }[];
  formatStreams?: { url?: string; type?: string; qualityLabel?: string; container?: string }[];
}

export class YouTubeProvider extends BaseProvider {
  private mode: 'api' | 'invidious' | 'embed' = 'embed';

  constructor(cfg: ProviderConfig) {
    super(cfg);
  }

  async init(): Promise<void> {
    const key = this.opt<string>('apiKey', '');
    const inv = this.opt<string>('invidiousUrl', '');
    this.mode = key ? 'api' : inv ? 'invidious' : 'embed';
    this.log.debug({ mode: this.mode }, 'youtube provider mode');
  }

  async ping(): Promise<void> {
    if (this.mode === 'api') {
      await fetchJson(
        `https://www.googleapis.com/youtube/v3/search?part=id&maxResults=1&q=test&key=${encodeURIComponent(
          this.opt<string>('apiKey', ''),
        )}`,
        { timeout: 8_000 },
      );
    } else if (this.mode === 'invidious') {
      await fetchJson(`${this.invidious()}/api/v1/stats`, { timeout: 8_000 });
    }
    // 'embed' mode needs no remote call to be considered healthy.
  }

  private invidious(): string {
    return (this.opt<string>('invidiousUrl', '') || '').replace(/\/+$/, '');
  }

  private queryFor(q: ResolveQuery | SearchQuery): string {
    const suffix = this.opt<string>('querySuffix', 'trailer');
    if ('query' in q) return suffix ? `${q.query} ${suffix}` : q.query;
    const parts = [q.title, q.year, suffix];
    if (q.season != null) parts.push(`s${q.season}e${q.episode ?? 1}`);
    return parts.filter(Boolean).join(' ');
  }

  override async search(q: SearchQuery): Promise<CatalogItem[]> {
    if (this.mode === 'embed') return [];

    const term = this.queryFor(q);

    if (this.mode === 'api') {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${this.opt<
        number
      >('maxResults', 10)}&q=${encodeURIComponent(term)}&key=${encodeURIComponent(
        this.opt<string>('apiKey', ''),
      )}`;
      const data = await fetchJson<YtSearchResponse>(url, { timeout: 15_000 });
      return (data.items ?? [])
        .filter((i) => i.id?.videoId)
        .map((i) => ({
          id: i.id!.videoId!,
          provider: this.id,
          type: 'movie' as const,
          title: i.snippet?.title ?? i.id!.videoId!,
          year: i.snippet?.publishedAt
            ? Number(i.snippet.publishedAt.slice(0, 4))
            : undefined,
          poster: i.snippet?.thumbnails?.high?.url ?? i.snippet?.thumbnails?.medium?.url,
          description: i.snippet?.description?.slice(0, 500),
        }));
    }

    const data = await fetchJson<InvidiousVideo[]>(
      `${this.invidious()}/api/v1/search?q=${encodeURIComponent(term)}&type=video`,
      { timeout: 15_000 },
    );
    return (data ?? [])
      .filter((v) => v.videoId)
      .map((v) => ({
        id: v.videoId!,
        provider: this.id,
        type: 'movie' as const,
        title: v.title ?? v.videoId!,
        poster: v.videoThumbnails?.find((t) => t.quality === 'medium')?.url,
        description: v.author ? `by ${v.author}` : undefined,
      }));
  }

  override async catalog(q: CatalogQuery): Promise<CatalogItem[]> {
    if (!q.category) return [];
    return this.search({ query: q.category, type: q.type });
  }

  protected async doGetStreams(q: ResolveQuery): Promise<StreamCandidate[]> {
    // A ytId can be handed to us directly (options.ytId) or via a Stremio-style
    // hint; otherwise we search for it.
    const known = this.opt<string>('ytId', '') || q.tmdbId?.startsWith('yt:')
      ? this.opt<string>('ytId', '') || q.tmdbId?.slice(3)
      : null;

    const videoId = known ?? (await this.findVideoId(q));
    if (!videoId) return [];

    const out: StreamCandidate[] = [
      {
        provider: this.id,
        providerName: this.name,
        name: `${this.name} · embed`,
        title: q.title,
        url: `https://www.youtube.com/embed/${videoId}${this.embedParams()}`,
        kind: 'embed',
        language: this.opt<string>('language', 'en') || undefined,
        meta: { ytId: videoId },
      },
    ];

    // Invidious exposes progressive/adaptive URLs for self-hosted playback.
    if (this.mode === 'invidious') {
      try {
        const v = await fetchJson<InvidiousVideo>(
          `${this.invidious()}/api/v1/videos/${videoId}`,
          { timeout: 15_000 },
        );

        for (const f of v.formatStreams ?? []) {
          if (!f.url) continue;
          const h = parseHeight(f.qualityLabel);
          out.push({
            provider: this.id,
            providerName: this.name,
            name: [this.name, f.qualityLabel].filter(Boolean).join(' · '),
            title: v.title ?? q.title,
            url: f.url,
            kind: f.container === 'mp4' || (f.type ?? '').includes('mp4') ? 'mp4' : 'unknown',
            height: h,
            quality: f.qualityLabel ?? (h ? `${h}p` : undefined),
            language: this.opt<string>('language', 'en') || undefined,
            meta: { ytId: videoId, container: f.container },
          });
        }
      } catch (err) {
        this.log.debug({ err: String(err) }, 'invidious video lookup failed');
      }
    }

    return out;
  }

  private embedParams(): string {
    const autoplay = this.opt<boolean>('autoplay', false);
    const rel = this.opt<boolean>('relatedVideos', false);
    const p = new URLSearchParams();
    if (autoplay) p.set('autoplay', '1');
    if (!rel) p.set('rel', '0');
    p.set('playsinline', '1');
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  private async findVideoId(q: ResolveQuery): Promise<string | null> {
    if (this.mode === 'embed') return null;
    const items = await this.search({ query: this.queryFor(q) });
    return items[0]?.id ?? null;
  }
}
