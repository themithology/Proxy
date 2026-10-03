import { BaseProvider } from './base.js';
import { request } from '../util/http.js';
import { resolveUrl } from '../util/url.js';
import { parseHeight } from './types.js';
import type {
  CatalogItem,
  ProviderConfig,
  CatalogQuery,
  MediaType,
  ResolveQuery,
  SearchQuery,
  StreamCandidate,
  StreamKind,
} from './types.js';

/**
 * WebExtract — a generic, configuration-driven extractor.
 *
 * Instead of hard-coding a scraper per site, you describe the steps in
 * `config/providers.json`. Steps run in order over a shared variable scope:
 *
 *   { "op": "fetch",   "url": "https://example.com/watch/{imdbId}", "as": "body" }
 *   { "op": "regex",   "source": "body", "pattern": "sources:\\[(?<json>.*?)\\]" }
 *   { "op": "json",    "source": "json", "path": "sources.0.file", "as": "fileUrl" }
 *   { "op": "findUrls","source": "body", "as": "found" }
 *   { "op": "emit",    "url": "{fileUrl}", "quality": "1080p" }
 *
 * Point it only at sources you operate or are authorised to access.
 */

type Vars = Record<string, unknown>;

interface Step {
  op: 'fetch' | 'regex' | 'json' | 'findUrls' | 'emit' | 'emitFound' | 'set';
  /** Variable to read from (default: "body"). */
  source?: string;
  /** Variable to write to. */
  as?: string;
  url?: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  pattern?: string;
  flags?: string;
  path?: string;
  /** emit-only */
  quality?: string;
  language?: string;
  kind?: StreamKind;
  name?: string;
  /** set-only */
  value?: string;
  /** filter for findUrls/emitFound */
  include?: string;
  exclude?: string;
  /** Only run this step if the named variable is set. */
  when?: string;
}

const DEFAULT_MEDIA_RE =
  /(https?:[^\s"'\\<>]+\.(?:m3u8|mpd|mp4|m4s|ts|webm|mkv)(?:\?[^\s"'\\<>]*)?)|(magnet:\?[^\s"'<>]+)/gi;

export class WebExtractProvider extends BaseProvider {
  private steps: Step[] = [];
  private searchSteps: Step[] = [];
  private baseUrl = '';

  constructor(cfg: ProviderConfig) {
    super(cfg);
  }

  async init(): Promise<void> {
    this.baseUrl = (this.opt<string>('baseUrl', '') || '').replace(/\/+$/, '');
    const steps = this.opt<unknown>('steps', null);
    const legacy = this.opt<string>('streamPath', '');

    if (Array.isArray(steps)) {
      this.steps = steps as Step[];
    } else if (legacy) {
      // Shorthand: one fetch + auto-discovery of media URLs in the page.
      this.steps = [
        { op: 'fetch', url: legacy, as: 'body' },
        { op: 'findUrls', source: 'body', as: 'found' },
        { op: 'emitFound', source: 'found' },
      ];
    }

    const ss = this.opt<unknown>('searchSteps', null);
    if (Array.isArray(ss)) this.searchSteps = ss as Step[];

    if (!this.steps.length) {
      throw new Error('needs "steps" (array) or "streamPath" (string)');
    }
  }

  async ping(): Promise<void> {
    if (!this.baseUrl) return;
    await request(this.baseUrl, { method: 'GET', timeout: 8_000, retries: 1 });
  }

  // --- templating ----------------------------------------------------------

  private tpl(tpl: string, vars: Vars, q: ResolveQuery | SearchQuery): string {
    const out = tpl
      .replace(/\{imdbId\}/g, (q as ResolveQuery).imdbId ?? '')
      .replace(/\{tmdbId\}/g, (q as ResolveQuery).tmdbId ?? '')
      .replace(/\{title\}/g, encodeURIComponent((q as ResolveQuery).title ?? ''))
      .replace(/\{titleRaw\}/g, (q as ResolveQuery).title ?? '')
      .replace(/\{type\}/g, (q as ResolveQuery).type ?? (q as SearchQuery).type ?? 'movie')
      .replace(/\{year\}/g, String((q as ResolveQuery).year ?? ''))
      .replace(/\{season\}/g, String((q as ResolveQuery).season ?? 1))
      .replace(/\{episode\}/g, String((q as ResolveQuery).episode ?? 1))
      .replace(/\{query\}/g, encodeURIComponent((q as SearchQuery).query ?? ''));

    // Substitute any captured variables: {name}
    return out.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key: string) => {
      if (key in vars && vars[key] !== undefined && vars[key] !== null) {
        return String(vars[key]);
      }
      return m;
    });
  }

  private baseVars(q: ResolveQuery | SearchQuery): Vars {
    return {};
  }

  // --- execution -----------------------------------------------------------

  /** Fetch helper that resolves relative URLs against baseUrl. */
  private abs(u: string): string {
    if (!u) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return `https:${u}`;
    if (this.baseUrl) return resolveUrl(this.baseUrl + '/', u.replace(/^\//, ''));
    return u;
  }

  protected async doGetStreams(q: ResolveQuery): Promise<StreamCandidate[]> {
    const vars = this.baseVars(q);
    const emits: StreamCandidate[] = [];
    await this.runSteps(this.steps, vars, q, emits);
    return emits;
  }

  override async search(q: SearchQuery): Promise<CatalogItem[]> {
    if (!this.searchSteps.length) return [];
    const vars = this.baseVars(q);
    const items: CatalogItem[] = [];
    await this.runSteps(this.searchSteps, vars, q, [], items);
    return items;
  }

  override async catalog(q: CatalogQuery): Promise<CatalogItem[]> {
    return this.search({ query: q.category ?? '', type: q.type });
  }

  private async runSteps(
    steps: Step[],
    vars: Vars,
    q: ResolveQuery | SearchQuery,
    emits: StreamCandidate[],
    items: CatalogItem[] = [],
  ): Promise<void> {
    for (const step of steps) {
      if (step.when && (vars[step.when] === undefined || vars[step.when] === null)) {
        continue;
      }
      try {
        await this.runStep(step, vars, q, emits, items);
      } catch (err) {
        this.log.debug(
          { op: step.op, err: err instanceof Error ? err.message : String(err) },
          'step failed — continuing',
        );
      }
    }
  }

  private async runStep(
    step: Step,
    vars: Vars,
    q: ResolveQuery | SearchQuery,
    emits: StreamCandidate[],
    items: CatalogItem[],
  ): Promise<void> {
    const sourceName = step.source ?? 'body';
    const target = step.as ?? sourceName;

    switch (step.op) {
      case 'fetch': {
        const url = this.tpl(this.abs(step.url ?? ''), vars, q);
        if (!/^https?:\/\//i.test(url)) throw new Error(`refusing non-http url: ${url}`);

        const res = await request(url, {
          method: step.method ?? 'GET',
          headers: {
            ...this.opt<Record<string, string>>('headers', {}),
            ...(step.headers ?? {}),
          },
          body: step.body ? this.tpl(step.body, vars, q) : undefined,
          timeout: this.opt<number>('timeout', 15_000),
        });

        const text = res.text();
        vars[target] = text;
        vars['__lastUrl'] = url;
        try {
          vars['json'] = JSON.parse(text);
        } catch {
          /* not JSON — fine */
        }
        return;
      }

      case 'regex': {
        const src = String(vars[sourceName] ?? '');
        if (!step.pattern) throw new Error('regex step needs "pattern"');
        const re = new RegExp(step.pattern, step.flags ?? 'g');
        const m = re.exec(src);
        if (!m) {
          vars[target] = null;
          return;
        }
        if (m.groups) {
          for (const [k, v] of Object.entries(m.groups)) vars[k] = v;
          vars[target] = m.groups;
        } else {
          vars[target] = m[1] ?? m[0];
        }
        return;
      }

      case 'json': {
        const root = vars[sourceName === 'body' ? 'json' : sourceName];
        if (!step.path) throw new Error('json step needs "path"');
        vars[target] = getPath(root, step.path);
        return;
      }

      case 'findUrls': {
        const src = String(vars[sourceName] ?? '');
        const custom = step.pattern ? new RegExp(step.pattern, step.flags ?? 'gi') : DEFAULT_MEDIA_RE;
        const found = new Set<string>();
        for (const m of src.matchAll(custom)) {
          const u = m[0];
          if (!u) continue;
          if (step.include && !new RegExp(step.include, 'i').test(u)) continue;
          if (step.exclude && new RegExp(step.exclude, 'i').test(u)) continue;
          found.add(this.abs(u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/')));
        }
        vars[target] = [...found];
        return;
      }

      case 'emit': {
        const raw = this.tpl(step.url ?? '', vars, q);
        if (!raw || raw.includes('{')) return;
        const url = this.abs(raw);
        if (!/^(https?:|magnet:)/i.test(url)) return;

        const height = parseHeight(step.quality, step.name);
        emits.push({
          provider: this.id,
          providerName: this.name,
          name: step.name ?? [this.name, step.quality].filter(Boolean).join(' · '),
          title: (q as ResolveQuery).title,
          url,
          kind: step.kind ?? 'unknown',
          height,
          quality: step.quality ?? (height ? `${height}p` : undefined),
          language: step.language ?? (this.opt<string>('language', '') || undefined),
          headers: {
            ...this.opt<Record<string, string>>('headers', {}),
            ...(step.headers ?? {}),
          },
        });
        return;
      }

      case 'emitFound': {
        const list = (vars[sourceName] ?? []) as string[];
        for (const url of list) {
          if (step.include && !new RegExp(step.include, 'i').test(url)) continue;
          if (step.exclude && new RegExp(step.exclude, 'i').test(url)) continue;
          const height = parseHeight(url, step.quality);
          emits.push({
            provider: this.id,
            providerName: this.name,
            name: [this.name, step.quality].filter(Boolean).join(' · '),
            title: (q as ResolveQuery).title,
            url,
            kind: (step.kind ?? 'unknown') as StreamKind,
            height,
            quality: step.quality ?? (height ? `${height}p` : undefined),
            language: step.language ?? (this.opt<string>('language', '') || undefined),
            headers: this.opt<Record<string, string>>('headers', {}),
          });
        }
        return;
      }

      case 'set': {
        vars[target] = step.value === undefined ? null : this.tpl(step.value, vars, q);
        return;
      }

      default:
        throw new Error(`unknown step op "${(step as Step).op}"`);
    }
  }
}

/** Minimal dotted/bracketed path getter: "a.b[0].c" */
export function getPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(p);
      cur = Number.isNaN(i) ? undefined : cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

export type { MediaType };
