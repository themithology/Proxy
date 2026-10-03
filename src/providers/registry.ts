import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { config } from '../config.js';
import { logFor } from '../logger.js';
import { ck, cache } from '../cache/index.js';
import { AppError } from '../util/errors.js';
import { stableHash } from '../util/crypto.js';
import { StremioProvider } from './stremio.js';
import { ArchiveProvider } from './archive.js';
import { YouTubeProvider } from './youtube.js';
import { DirectProvider } from './direct.js';
import { WebExtractProvider } from './webextract.js';
import type {
  CatalogItem,
  CatalogQuery,
  MediaType,
  Provider,
  ProviderConfig,
  ProviderHealth,
  ProvidersFile,
  ResolveQuery,
  SearchQuery,
  StreamCandidate,
} from './types.js';
import { normalizeLanguage } from './types.js';

const log = logFor('registry');

type Factory = (cfg: ProviderConfig) => Provider;

/** Built-in provider kinds. Add a module here to add a provider type. */
export const PROVIDER_KINDS: Record<string, Factory> = {
  stremio: (c) => new StremioProvider(c),
  archive: (c) => new ArchiveProvider(c),
  youtube: (c) => new YouTubeProvider(c),
  direct: (c) => new DirectProvider(c),
  webextract: (c) => new WebExtractProvider(c),
};

// ---------------------------------------------------------------------------
// Ranking & de-duplication
// ---------------------------------------------------------------------------

export interface RankOptions {
  preferredLanguages?: string[];
  /** Restrict results to these languages (after normalisation). */
  onlyLanguages?: string[];
  minHeight?: number;
  maxHeight?: number;
  /** Drop non-playable kinds (embed/torrent/unknown). */
  playableOnly?: boolean;
  limit?: number;
}

/** Higher is better. Deterministic given the same inputs. */
export function scoreCandidate(c: StreamCandidate, opts: RankOptions): number {
  let score = 0;

  // Quality: the dominant signal, but capped so a 2160p stream from a
  // terrible source doesn't outrank a rock-solid 1080p one.
  const h = c.height ?? 0;
  score += Math.min(h, 2160) / 2160 * 34;

  // Language match is the loudest preference after quality.
  const preferred = (opts.preferredLanguages ?? []).map((l) => normalizeLanguage(l));
  if (preferred.length && c.language) {
    const idx = preferred.indexOf(c.language);
    if (idx === 0) score += 40;
    else if (idx > 0) score += 40 - idx * 8;
    else score -= 10;
  }

  // Deliverability: what a browser can actually play without extra work.
  switch (c.kind) {
    case 'hls':
      score += 14;
      break;
    case 'dash':
      score += 12;
      break;
    case 'mp4':
      score += 8;
      break;
    case 'embed':
      score -= 6;
      break;
    case 'torrent':
      score -= 30;
      break;
    default:
      score -= 20;
  }

  if (!c.height) score -= 5;
  if (c.subtitles?.length) score += 3;
  if (typeof c.seeders === 'number') score += Math.min(c.seeders / 25, 8);

  return score;
}

/** Identity used to collapse the same stream reported by several providers. */
function dedupeKey(c: StreamCandidate): string {
  const urlKey = canonicalUrl(c.url);
  if (urlKey) return `u:${urlKey}`;
  return `m:${c.provider}|${c.height ?? 0}|${c.language ?? ''}|${
    (c.title ?? c.name ?? '').toLowerCase().trim()
  }`;
}

/** Strip volatile query params so signed/CDN-tokenised duplicates collapse. */
function canonicalUrl(u: string): string {
  try {
    const p = new URL(u);
    const volatile = [
      'token',
      'sig',
      'signature',
      'exp',
      'expires',
      'e',
      'st',
      'ip',
      'rnd',
      '_',
      'ts',
      'hdnts',
      'hdnea',
      'auth',
      'key',
      'session',
    ];
    for (const v of volatile) p.searchParams.delete(v);
    return `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, '')}${
      p.search
    }`;
  } catch {
    return '';
  }
}

export function rankAndDedupe(
  list: StreamCandidate[],
  providerPriority: Map<string, number>,
  opts: RankOptions,
): StreamCandidate[] {
  const filtered = list.filter((c) => {
    if (opts.playableOnly && !['hls', 'dash', 'mp4', 'embed'].includes(c.kind)) {
      return false;
    }
    if (opts.minHeight && (c.height ?? 0) < opts.minHeight) return false;
    if (opts.maxHeight && (c.height ?? 0) > opts.maxHeight) return false;
    if (opts.onlyLanguages?.length) {
      const lang = c.language;
      // Streams with unknown language are kept — better than an empty list.
      if (lang && !opts.onlyLanguages.includes(lang)) return false;
    }
    return true;
  });

  const best = new Map<string, { c: StreamCandidate; s: number }>();

  for (const c of filtered) {
    const s = scoreCandidate(c, opts) + (providerPriority.get(c.provider) ?? 50) / 10;
    const key = dedupeKey(c);
    const prev = best.get(key);
    if (!prev || s > prev.s) best.set(key, { c, s });
  }

  const out = [...best.values()].sort((a, b) => b.s - a.s).map((x) => x.c);
  return opts.limit && opts.limit > 0 ? out.slice(0, opts.limit) : out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface Slot {
  cfg: ProviderConfig;
  instance: Provider | null;
  initError?: string;
}

class ProviderRegistry {
  private slots = new Map<string, Slot>();

  get all(): Provider[] {
    return [...this.slots.values()]
      .map((s) => s.instance)
      .filter((p): p is Provider => !!p && p.enabled);
  }

  get(id: string): Provider | undefined {
    return this.slots.get(id)?.instance ?? undefined;
  }

  /** Load config from disk and (re)initialise every provider. */
  async load(file = config.providersConfigPath): Promise<void> {
    let file_: ProvidersFile;
    if (!existsSync(file)) {
      log.warn({ file }, 'providers config missing — starting with no providers');
      file_ = { version: 1, providers: [] };
    } else {
      try {
        file_ = JSON.parse(readFileSync(file, 'utf8')) as ProvidersFile;
      } catch (err) {
        throw new AppError(500, `Invalid providers config at ${file}: ${String(err)}`);
      }
    }

    // Tear down anything running.
    await this.shutdown();
    this.slots.clear();

    for (const cfg of file_.providers ?? []) {
      const slot: Slot = { cfg, instance: null };

      if (cfg.enabled === false) {
        this.slots.set(cfg.id, slot);
        log.info({ id: cfg.id }, 'provider disabled by config');
        continue;
      }

      const factory = PROVIDER_KINDS[cfg.kind];
      if (!factory) {
        slot.initError = `unknown provider kind "${cfg.kind}"`;
        log.error({ id: cfg.id, kind: cfg.kind }, 'unknown provider kind');
        this.slots.set(cfg.id, slot);
        continue;
      }

      try {
        const p = factory(cfg);
        await p.init();
        slot.instance = p;
        log.info(
          { id: cfg.id, kind: cfg.kind, types: p.types, langs: p.languages },
          'provider ready',
        );
      } catch (err) {
        slot.initError = err instanceof Error ? err.message : String(err);
        log.error({ id: cfg.id, err: slot.initError }, 'provider failed to initialise');
      }

      this.slots.set(cfg.id, slot);
    }

    log.info(
      { total: this.slots.size, ready: this.all.length },
      'provider registry loaded',
    );
  }

  async shutdown(): Promise<void> {
    for (const slot of this.slots.values()) {
      try {
        await slot.instance?.shutdown?.();
      } catch {
        /* best effort */
      }
    }
  }

  /** Providers that claim to serve this media type. */
  forType(type: MediaType): Provider[] {
    return this.all.filter((p) => p.types.includes(type) || p.types.includes('*' as MediaType));
  }

  /** Providers that advertise one of the requested languages (or any). */
  forLanguages(langs?: string[]): (p: Provider) => boolean {
    if (!langs?.length) return () => true;
    const want = langs.map((l) => normalizeLanguage(l)).filter(Boolean) as string[];
    return (p) =>
      p.languages.includes('*') || p.languages.some((l) => want.includes(l));
  }

  // --- fan-out -------------------------------------------------------------

  /**
   * Query every eligible provider concurrently, tolerate individual failures,
   * then rank and de-duplicate the merged result.
   */
  async collectStreams(q: ResolveQuery, opts: RankOptions = {}): Promise<{
    streams: StreamCandidate[];
    diagnostics: ProviderDiagnostic[];
  }> {
    const wanted = q.languages?.length ? q.languages : opts.preferredLanguages;
    const eligible = this.forType(q.type)
      .filter(this.forLanguages(wanted))
      .filter((p) => !this.isCooling(p));

    if (!eligible.length) {
      return {
        streams: [],
        diagnostics: [
          {
            provider: '(none)',
            ok: false,
            count: 0,
            ms: 0,
            error: 'No enabled provider matches this media type / language',
            cached: false,
          },
        ],
      };
    }

    const priority = new Map(eligible.map((p) => [p.id, p.priority]));
    const diagnostics: ProviderDiagnostic[] = [];
    const collected: StreamCandidate[] = [];

    const results = await mapLimit(
      eligible,
      Math.max(1, config.PROVIDER_FANOUT_CONCURRENCY),
      async (p) => this.fromProvider(p, q),
    );

    for (const r of results) {
      diagnostics.push(r.diagnostic);
      collected.push(...r.streams);
    }

    diagnostics.sort((a, b) => a.provider.localeCompare(b.provider));
    return { streams: rankAndDedupe(collected, priority, opts), diagnostics };
  }

  /** Single provider, with caching + breaker bookkeeping. */
  private async fromProvider(
    p: Provider,
    q: ResolveQuery,
  ): Promise<{ streams: StreamCandidate[]; diagnostic: ProviderDiagnostic }> {
    const key = ck.resolve(
      p.id,
      q.type,
      q.imdbId ?? q.tmdbId ?? q.title,
      String(q.season ?? ''),
      String(q.episode ?? ''),
    );
    const started = Date.now();
    let cached = true;

    try {
      const streams = (await cache.wrap<StreamCandidate[] | null>(
        key,
        config.CACHE_TTL_STREAMS,
        async () => {
          cached = false;
          return (await p.getStreams(q)) ?? null;
        },
        { allowNull: true },
      )) ?? [];

      this.clearFailure(p);
      return {
        streams,
        diagnostic: {
          provider: p.id,
          ok: true,
          count: streams.length,
          ms: Date.now() - started,
          cached,
        },
      };
    } catch (err) {
      this.recordFailure(p, err);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        streams: [],
        diagnostic: {
          provider: p.id,
          ok: false,
          count: 0,
          ms: Date.now() - started,
          error: redactUrls(msg).slice(0, 300),
          cached: false,
        },
      };
    }
  }

  // --- circuit breaker -----------------------------------------------------

  private failures = new Map<string, { n: number; until: number }>();

  private isCooling(p: Provider): boolean {
    const f = this.failures.get(p.id);
    return !!f && Date.now() < f.until;
  }

  private clearFailure(p: Provider): void {
    this.failures.delete(p.id);
  }

  private recordFailure(p: Provider, err: unknown): void {
    const cur = this.failures.get(p.id) ?? { n: 0, until: 0 };
    cur.n += 1;
    if (cur.n >= config.PROVIDER_FAILURE_THRESHOLD) {
      cur.until = Date.now() + config.PROVIDER_COOLDOWN;
      cur.n = 0;
      log.warn(
        { provider: p.id, cooldownMs: config.PROVIDER_COOLDOWN },
        'provider cooled down after repeated failures',
      );
    }
    this.failures.set(p.id, cur);
  }

  // --- search / catalog ----------------------------------------------------

  async search(q: SearchQuery): Promise<CatalogItem[]> {
    const providers = this.all.filter((p) => p.search);
    const results = await mapLimit(providers, 6, async (p) => {
      try {
        return await p.search!(q);
      } catch (err) {
        log.warn({ provider: p.id, err: redactUrls(String(err)) }, 'search failed');
        return [] as CatalogItem[];
      }
    });
    return dedupeItems(results.flat());
  }

  async catalog(q: CatalogQuery): Promise<CatalogItem[]> {
    const providers = this.all.filter((p) => p.catalog);
    const results = await mapLimit(providers, 6, async (p) => {
      try {
        return await p.catalog!(q);
      } catch (err) {
        log.warn({ provider: p.id, err: redactUrls(String(err)) }, 'catalog failed');
        return [] as CatalogItem[];
      }
    });
    return dedupeItems(results.flat());
  }

  // --- introspection -------------------------------------------------------

  list(): Array<{
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
    ready: boolean;
    priority: number;
    types: MediaType[];
    languages: string[];
    supports: Provider['supports'];
    description?: string;
    website?: string;
    error?: string;
    health?: ProviderHealth;
  }> {
    return [...this.slots.values()].map((s) => ({
      id: s.cfg.id,
      name: s.cfg.name,
      kind: s.cfg.kind,
      enabled: s.cfg.enabled !== false,
      ready: !!s.instance,
      priority: s.cfg.priority ?? 50,
      types: s.cfg.types ?? [],
      languages: s.cfg.languages ?? [],
      supports: s.instance?.supports ?? {
        streams: false,
        search: false,
        catalog: false,
      },
      description: s.cfg.description,
      website: s.cfg.website,
      error: s.initError,
      health: (s.instance as unknown as { health?: () => ProviderHealth })?.health?.(),
    }));
  }

  health(): ProviderHealth[] {
    return this.all.map((p) =>
      (p as unknown as { health?: () => ProviderHealth }).health?.() ?? {
        id: p.id,
        ok: false,
        latencyMs: -1,
        cooling: false,
        consecutiveFailures: 0,
      },
    );
  }

  /** Persist an updated provider list back to the config file. */
  save(file = config.providersConfigPath): void {
    const providers: ProviderConfig[] = [...this.slots.values()].map((s) => s.cfg);
    writeFileSync(file, JSON.stringify({ version: 1, providers }, null, 2), 'utf8');
  }

  /** Enable/disable a provider at runtime. */
  setEnabled(id: string, enabled: boolean): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    slot.cfg.enabled = enabled;
    return true;
  }
}

export interface ProviderDiagnostic {
  provider: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
  cached: boolean;
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** Bounded-concurrency async map that never rejects. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function dedupeItems(items: CatalogItem[]): CatalogItem[] {
  const seen = new Map<string, CatalogItem>();
  for (const it of items) {
    if (!it?.id) continue;
    const key = it.imdbId || `${it.provider}:${it.id}`;
    const prev = seen.get(key);
    if (!prev || (it.rating ?? 0) > (prev.rating ?? 0)) seen.set(key, it);
  }
  return [...seen.values()];
}

export function redactUrls(msg: string): string {
  return msg.replace(/https?:\/\/\S+/g, (m) => {
    try {
      const u = new URL(m);
      return `${u.protocol}//${u.host}/…`;
    } catch {
      return m;
    }
  });
}

/** Stable fingerprint of a resolve query, used for cache + logging. */
export const queryFingerprint = (q: ResolveQuery): string =>
  stableHash(
    [q.type, q.imdbId, q.tmdbId, q.title, q.year, q.season, q.episode].join('|'),
  );

export const registry = new ProviderRegistry();
