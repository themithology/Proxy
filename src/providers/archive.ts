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
 * Internet Archive provider — public-domain and openly licensed film.
 *
 * Uses the public advancedsearch + metadata APIs:
 *   https://archive.org/advancedsearch.php?q=…&output=json
 *   https://archive.org/metadata/{identifier}
 *
 * Default collection is `feature_films` (public domain in the US), which makes
 * this the safe default catalogue. Point `collection` at your own uploads to
 * serve your own library instead.
 */

interface IaDoc {
  identifier: string;
  title?: string;
  year?: string | number;
  description?: string;
  subject?: string | string[];
  mediatype?: string;
  downloads?: number;
}

interface IaSearchResponse {
  response?: { numFound?: number; docs?: IaDoc[] };
}

interface IaFile {
  name: string;
  source?: string;
  format?: string;
  size?: string;
  length?: string;
  height?: string;
  width?: string;
  md5?: string;
}

interface IaMetadata {
  metadata?: { identifier?: string; title?: string; year?: string };
  files?: IaFile[];
  server?: string;
  dir?: string;
}

const VIDEO_EXT = /\.(mp4|ogv|webm|mpeg|mpg|m4v|mov)$/i;
const SKIP = /(\.gif|\.png|\.jpg|\.jpeg|\.xml|\.sqlite|\.torrent|\.json|\.txt|\.srt)$/i;

export class ArchiveProvider extends BaseProvider {
  private base = 'https://archive.org';

  constructor(cfg: ProviderConfig) {
    super(cfg);
  }

  async init(): Promise<void> {
    this.base = (this.opt<string>('baseUrl', 'https://archive.org') || '').replace(
      /\/+$/,
      '',
    );
  }

  async ping(): Promise<void> {
    await fetchJson(
      `${this.base}/advancedsearch.php${`?q=mediatype:movies&rows=1&output=json`}`,
      { timeout: 8_000 },
    );
  }

  private collection(): string {
    return this.opt<string>('collection', 'feature_films');
  }

  private buildSearch(q: string, page: number): string {
    const rows = this.opt<number>('rows', 25);
    const params = new URLSearchParams();
    params.set('q', `(${q}) AND mediatype:movies AND collection:(${this.collection()})`);
    for (const fl of ['identifier', 'title', 'year', 'description', 'subject', 'downloads']) {
      params.append('fl[]', fl);
    }
    params.set('rows', String(rows));
    params.set('page', String(page));
    params.set('output', 'json');
    params.set('sort[]', 'downloads desc');
    return `${this.base}/advancedsearch.php?${params.toString()}`;
  }

  override async search(q: SearchQuery): Promise<CatalogItem[]> {
    const res = await fetchJson<IaSearchResponse>(this.buildSearch(q.query, q.page ?? 1), {
      timeout: this.opt<number>('timeout', 15_000),
    });
    return (res.response?.docs ?? []).map((d) => this.docToItem(d));
  }

  override async catalog(q: CatalogQuery): Promise<CatalogItem[]> {
    return this.search({ query: q.category || '', page: q.page ?? 1, type: q.type });
  }

  private docToItem(d: IaDoc): CatalogItem {
    return {
      id: d.identifier,
      provider: this.id,
      type: 'movie',
      title: d.title ?? d.identifier,
      year: typeof d.year === 'number' ? d.year : Number(d.year) || undefined,
      poster: `${this.base}/services/img/${d.identifier}`,
      description: typeof d.description === 'string' ? d.description.slice(0, 500) : undefined,
      genres: Array.isArray(d.subject)
        ? d.subject.slice(0, 5)
        : d.subject
          ? [d.subject]
          : undefined,
    };
  }

  protected async doGetStreams(q: ResolveQuery): Promise<StreamCandidate[]> {
    // Resolve query → identifier. IMDB ids are unknown to the Archive, so we
    // search by title (+ year) unless the caller passed an identifier directly.
    const identifier =
      q.tmdbId && q.tmdbId.startsWith('ia:')
        ? q.tmdbId.slice(3)
        : await this.findIdentifier(q);

    if (!identifier) return [];

    const meta = await fetchJson<IaMetadata>(`${this.base}/metadata/${identifier}`, {
      timeout: this.opt<number>('timeout', 15_000),
    });

    const files = (meta.files ?? []).filter(
      (f) => VIDEO_EXT.test(f.name) && !SKIP.test(f.name),
    );
    if (!files.length) return [];

    // Prefer the modern H.264 derivative, then derivative/original ordering.
    const scored = files
      .map((f) => ({
        f,
        name: f.name,
        size: Number(f.size ?? 0),
        height: Number(f.height ?? 0) || parseHeight(f.format ?? '', f.name) || 0,
        score: 0,
      }))
      .map((x) => {
        let s = x.size / 1e6 + x.height / 10;
        if (/h\.?264/i.test(x.f.format ?? '') || /h\.?264/i.test(x.name)) s += 50;
        if (/\.ia\.mp4$/i.test(x.name)) s += 20; // Archive's streaming derivative
        if (/512kb|h\.264/i.test(x.name)) s += 15;
        if (/_512kb|_h\.?264/i.test(x.name)) s += 10;
        if (/mpeg2|\.mpg$/i.test(x.name)) s -= 30;
        if (/\.ogv$/i.test(x.name)) s -= 20;
        return { ...x, score: s };
      })
      .sort((a, b) => b.score - a.score);

    const maxFiles = this.opt<number>('maxFiles', 4);
    const chosen = scored.slice(0, Math.max(1, maxFiles));

    return chosen.map(({ f, height }) => {
      const url = `${this.base}/download/${identifier}/${encodeURI(f.name)}`;
      return {
        provider: this.id,
        providerName: this.name,
        name: [this.name, height ? `${height}p` : f.format].filter(Boolean).join(' · '),
        title: meta.metadata?.title ?? q.title,
        url,
        kind: 'mp4' as const,
        height: height || undefined,
        quality: height ? `${height}p` : undefined,
        sizeBytes: Number(f.size ?? 0) || undefined,
        language: this.opt<string>('language', 'en') || undefined,
        meta: { identifier, filename: f.name },
      };
    });
  }

  private async findIdentifier(q: ResolveQuery): Promise<string | null> {
    const terms = [q.title, q.year].filter(Boolean).join(' ');
    if (!terms.trim()) return null;

    const res = await fetchJson<IaSearchResponse>(this.buildSearch(terms, 1), {
      timeout: this.opt<number>('timeout', 15_000),
    });

    const docs = res.response?.docs ?? [];
    if (!docs.length) return null;

    // Prefer an exact-ish title match, then a year match, then the top hit.
    const wanted = q.title.toLowerCase().trim();
    const exact = docs.find((d) => (d.title ?? '').toLowerCase().trim() === wanted);
    if (exact) return exact.identifier;

    const yearHit = q.year
      ? docs.find((d) => String(d.year ?? '') === String(q.year))
      : undefined;
    if (yearHit) return yearHit.identifier;

    return docs[0]?.identifier ?? null;
  }
}
