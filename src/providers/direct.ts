import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseProvider } from './base.js';
import { parseHeight } from './types.js';
import type {
  CatalogItem,
  ProviderConfig,
  CatalogQuery,
  ResolveQuery,
  SearchQuery,
  StreamCandidate,
  StreamKind,
  SubtitleTrack,
} from './types.js';

/**
 * Direct provider — plays media you already have URLs for.
 *
 * Two ways to configure:
 *   1. `sources`: an inline array of entries (or a `file` containing one).
 *   2. `urlTemplate`: build URLs from ids, e.g.
 *        https://cdn.example.com/{type}/{imdbId}/{season}/{episode}.m3u8
 *
 * This is the right provider for your own CDN, an S3/R2 bucket, a Plex/Jellyfin
 * direct-play path, or anything else you control.
 */

interface DirectEntry {
  /** Any of these may be present; matching is most-specific-first. */
  imdbId?: string;
  tmdbId?: string;
  title?: string;
  year?: number;
  type?: 'movie' | 'series' | 'anime';
  season?: number;
  episode?: number;
  url: string;
  kind?: StreamKind;
  quality?: string;
  language?: string;
  headers?: Record<string, string>;
  subtitles?: SubtitleTrack[];
  name?: string;
}

export class DirectProvider extends BaseProvider {
  private entries: DirectEntry[] = [];
  private template = '';

  constructor(cfg: ProviderConfig) {
    super(cfg);
  }

  async init(): Promise<void> {
    this.template = this.opt<string>('urlTemplate', '');

    const inline = this.opt<unknown>('sources', null);
    if (Array.isArray(inline)) {
      this.entries = inline as DirectEntry[];
    }

    const file = this.opt<string>('file', '');
    if (file) {
      const p = resolve(process.cwd(), file);
      if (!existsSync(p)) throw new Error(`sources file not found: ${file}`);
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      const list = Array.isArray(raw)
        ? raw
        : ((raw as { sources?: unknown[] }).sources ?? []);
      this.entries.push(...(list as DirectEntry[]));
    }

    if (!this.entries.length && !this.template) {
      throw new Error('needs either "sources" (array or file) or "urlTemplate"');
    }

    this.log.debug(
      { entries: this.entries.length, template: !!this.template },
      'direct provider ready',
    );
  }

  async ping(): Promise<void> {
    // Nothing remote to check for a static provider.
  }

  private norm(s?: string): string {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private matches(e: DirectEntry, q: ResolveQuery): boolean {
    if (e.type && q.type && e.type !== q.type) return false;
    if (e.imdbId && q.imdbId && e.imdbId.toLowerCase() === q.imdbId.toLowerCase()) {
      if (q.type === 'series' || q.type === 'anime') {
        if (e.season != null && q.season != null && e.season !== q.season) return false;
        if (e.episode != null && q.episode != null && e.episode !== q.episode) return false;
      }
      return true;
    }
    if (e.imdbId) return false;

    if (e.tmdbId && q.tmdbId && e.tmdbId === q.tmdbId) return true;
    if (e.tmdbId) return false;

    if (e.title) {
      const a = this.norm(e.title);
      const b = this.norm(q.title);
      if (!a || !b) return false;
      if (a !== b) return false;
      if (e.year && q.year && e.year !== q.year) return false;
      if (e.season != null && q.season != null && e.season !== q.season) return false;
      if (e.episode != null && q.episode != null && e.episode !== q.episode) return false;
      return true;
    }
    return false;
  }

  private fillTemplate(tpl: string, q: ResolveQuery): string {
    const pad = (n?: number) => String(n ?? 0).padStart(2, '0');
    return tpl
      .replace(/\{imdbId\}/g, q.imdbId ?? '')
      .replace(/\{tmdbId\}/g, q.tmdbId ?? '')
      .replace(/\{title\}/g, encodeURIComponent(q.title ?? ''))
      .replace(/\{type\}/g, q.type)
      .replace(/\{season\}/g, String(q.season ?? 1))
      .replace(/\{seasonPad\}/g, pad(q.season))
      .replace(/\{episode\}/g, String(q.episode ?? 1))
      .replace(/\{episodePad\}/g, pad(q.episode))
      .replace(/\{year\}/g, String(q.year ?? ''));
  }

  protected async doGetStreams(q: ResolveQuery): Promise<StreamCandidate[]> {
    const out: StreamCandidate[] = [];

    for (const e of this.entries) {
      if (!this.matches(e, q)) continue;
      const h = parseHeight(e.quality, e.name);
      out.push({
        provider: this.id,
        providerName: this.name,
        name: e.name ?? [this.name, e.quality].filter(Boolean).join(' · '),
        title: e.title ?? q.title,
        url: e.url,
        kind: e.kind ?? 'unknown',
        height: h,
        quality: e.quality ?? (h ? `${h}p` : undefined),
        language: e.language,
        headers: e.headers,
        subtitles: e.subtitles ?? [],
      });
    }

    if (this.template) {
      const url = this.fillTemplate(this.template, q);
      if (url && !url.includes('{')) {
        out.push({
          provider: this.id,
          providerName: this.name,
          name: `${this.name} · auto`,
          title: q.title,
          url,
          kind: 'unknown',
          language: this.opt<string>('language', '') || undefined,
          headers: this.opt<Record<string, string>>('headers', {}),
        });
      }
    }

    return out;
  }

  override async search(q: SearchQuery): Promise<CatalogItem[]> {
    const want = this.norm(q.query);
    if (!want) return [];
    return this.entries
      .filter((e) => e.title && this.norm(e.title).includes(want))
      .slice(0, this.opt<number>('maxResults', 25))
      .map((e, i) => ({
        id: e.imdbId ?? e.tmdbId ?? `direct-${i}`,
        provider: this.id,
        type: e.type ?? 'movie',
        title: e.title!,
        year: e.year,
        imdbId: e.imdbId,
        tmdbId: e.tmdbId,
      }));
  }

  override async catalog(q: CatalogQuery): Promise<CatalogItem[]> {
    return this.entries
      .filter((e) => !q.type || e.type === q.type)
      .slice(0, this.opt<number>('maxResults', 50))
      .map((e, i) => ({
        id: e.imdbId ?? e.tmdbId ?? `direct-${i}`,
        provider: this.id,
        type: e.type ?? 'movie',
        title: e.title ?? e.imdbId ?? `Item ${i + 1}`,
        year: e.year,
        imdbId: e.imdbId,
        tmdbId: e.tmdbId,
      }));
  }
}
