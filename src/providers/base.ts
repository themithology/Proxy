import { logFor } from '../logger.js';
import { guessKind, normalizeLanguage, parseHeight } from './types.js';
import type {
  CatalogItem,
  CatalogQuery,
  MediaType,
  Provider,
  ProviderConfig,
  ProviderHealth,
  ResolveQuery,
  SearchQuery,
  StreamCandidate,
} from './types.js';

/**
 * Shared plumbing for concrete providers: config access, logging, health
 * bookkeeping and normalisation of whatever the upstream returned.
 */
export abstract class BaseProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly website?: string;
  readonly types: MediaType[];
  readonly languages: string[];
  readonly priority: number;
  readonly enabled: boolean;
  readonly supports: Provider['supports'];

  protected readonly log = logFor('provider');
  protected readonly options: Record<string, unknown>;

  // Health / circuit-breaker state
  protected lastError?: string;
  protected lastOkAt?: number;
  protected failures = 0;
  protected cooldownUntil = 0;
  protected latencyMs = -1;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.description = cfg.description;
    this.website = cfg.website;
    this.types = cfg.types ?? ['movie', 'series'];
    this.languages = cfg.languages ?? ['*'];
    this.priority = cfg.priority ?? 50;
    this.enabled = cfg.enabled !== false;
    this.options = cfg.options ?? {};
    this.supports = {
      streams: true,
      search: typeof (this as unknown as Provider).search === 'function',
      catalog: typeof (this as unknown as Provider).catalog === 'function',
    };
    this.log = logFor(`provider:${this.id}`);
  }

  /** Typed access to `options` with a fallback. */
  protected opt<T>(key: string, fallback: T): T {
    const v = this.options[key];
    return v === undefined || v === null ? fallback : (v as T);
  }

  /** Required option; throws a clear error at init time when missing. */
  protected reqOpt<T>(key: string): T {
    const v = this.options[key];
    if (v === undefined || v === null || v === '') {
      throw new Error(`Provider "${this.id}" is missing required option "${key}"`);
    }
    return v as T;
  }

  abstract init(): Promise<void>;
  abstract ping(): Promise<void>;
  protected abstract doGetStreams(q: ResolveQuery): Promise<StreamCandidate[]>;

  search?(q: SearchQuery): Promise<CatalogItem[]>;
  catalog?(q: CatalogQuery): Promise<CatalogItem[]>;

  async getStreams(q: ResolveQuery): Promise<StreamCandidate[]> {
    const started = Date.now();
    const results = await this.doGetStreams(q);
    this.latencyMs = Date.now() - started;
    this.lastOkAt = Date.now();
    this.failures = 0;
    this.lastError = undefined;

    // Normalise everything so downstream code can rely on the shape.
    return results
      .filter((s) => !!s && typeof s.url === 'string' && s.url.length > 0)
      .map((s) => this.normalize(s, q));
  }

  protected normalize(s: StreamCandidate, q: ResolveQuery): StreamCandidate {
    const height = s.height ?? parseHeight(s.quality, s.name, s.title);
    const kind = s.kind && s.kind !== 'unknown' ? s.kind : guessKind(s.url);
    const language = s.language
      ? normalizeLanguage(s.language)
      : normalizeLanguage(q.languages?.[0]);

    return {
      ...s,
      provider: this.id,
      providerName: this.name,
      kind,
      height,
      language,
      audioLanguages: s.audioLanguages?.length
        ? Array.from(new Set(s.audioLanguages.map((l) => normalizeLanguage(l) ?? l)))
        : language
          ? [language]
          : undefined,
      name:
        s.name ??
        [this.name, s.quality, language && language !== 'en' ? language.toUpperCase() : null]
          .filter(Boolean)
          .join(' · '),
      subtitles:
        s.subtitles?.map((sub) => ({
          ...sub,
          lang: normalizeLanguage(sub.lang) ?? sub.lang ?? 'en',
          label: sub.label ?? sub.lang ?? 'Unknown',
          format: sub.format ?? 'unknown',
        })) ?? [],
    };
  }

  // --- health --------------------------------------------------------------

  protected markFailure(err: unknown): void {
    this.failures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastError = this.scrub(this.lastError);
  }

  /** Keep signed URLs out of logs and health output. */
  protected scrub(msg: string): string {
    return msg.replace(/https?:\/\/\S+/g, (m) => {
      try {
        const u = new URL(m);
        return `${u.protocol}//${u.host}/…`;
      } catch {
        return m;
      }
    });
  }

  get isCooling(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  protected noteSuccess(): void {
    this.lastOkAt = Date.now();
    this.lastError = undefined;
    this.failures = 0;
    this.cooldownUntil = 0;
  }

  protected noteFailure(err: unknown): void {
    this.markFailure(err);
  }

  health(): ProviderHealth {
    return {
      id: this.id,
      ok: this.failures === 0 && !this.isCooling,
      latencyMs: this.latencyMs,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      cooling: this.isCooling,
      consecutiveFailures: this.failures,
    };
  }
}
