import { config } from '../config.js';
import { logFor } from '../logger.js';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Caching layer.
 *
 * Three drivers plus a no-op, behind one interface:
 *   memory — fastest, per-process, lost on restart
 *   sqlite — default; survives restarts, no native dependencies
 *   redis  — for multi-instance deployments (needs `npm i ioredis`)
 *   none   — disabled
 *
 * `wrap()` also coalesces concurrent misses, so a burst of identical requests
 * triggers exactly one upstream call.
 */

const log = logFor('cache');

export interface CacheStats {
  driver: string;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  size: number | null;
}

export interface CacheDriver {
  readonly name: string;
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number | null>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

interface Entry {
  value: string;
  expires: number;
}

class MemoryDriver implements CacheDriver {
  readonly name = 'memory';
  private map = new Map<string, Entry>();
  private readonly max: number;

  constructor(max = 20_000) {
    this.max = max;
  }

  async get<T>(key: string): Promise<T | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.expires) {
      this.map.delete(key);
      return null;
    }
    // Refresh insertion order => cheap LRU eviction.
    this.map.delete(key);
    this.map.set(key, e);
    return JSON.parse(e.value) as T;
  }

  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    if (ttl <= 0) return;
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, {
      value: JSON.stringify(value),
      expires: Date.now() + ttl * 1000,
    });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async size(): Promise<number> {
    return this.map.size;
  }

  async close(): Promise<void> {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// SQLite (default; survives restarts, zero native deps)
// ---------------------------------------------------------------------------

class SqliteDriver implements CacheDriver {
  readonly name = 'sqlite';
  private db: any;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(file: string) {
    // node:sqlite is only reachable via require() from an ESM module.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous  = NORMAL;
      CREATE TABLE IF NOT EXISTS cache (
        key     TEXT PRIMARY KEY,
        value   TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires);
    `);
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    try {
      this.db.prepare('DELETE FROM cache WHERE expires < ?').run(Date.now());
    } catch (err) {
      log.warn({ err }, 'cache sweep failed');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const row = this.db
        .prepare('SELECT value, expires FROM cache WHERE key = ?')
        .get(key) as { value: string; expires: number } | undefined;
      if (!row) return null;
      if (Date.now() > row.expires) {
        this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
        return null;
      }
      return JSON.parse(row.value) as T;
    } catch (err) {
      log.warn({ err }, 'sqlite get failed');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    if (ttl <= 0) return;
    try {
      this.db
        .prepare(
          'INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires',
        )
        .run(key, JSON.stringify(value), Date.now() + ttl * 1000);
    } catch (err) {
      log.warn({ err }, 'sqlite set failed');
    }
  }

  async del(key: string): Promise<void> {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM cache');
  }

  async size(): Promise<number> {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM cache').get() as { n: number };
    return r?.n ?? 0;
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Redis (optional; requires `npm i ioredis`)
// ---------------------------------------------------------------------------

class RedisDriver implements CacheDriver {
  readonly name = 'redis';
  private client: any;
  private readonly prefix = 'proxy:';

  private constructor(client: any) {
    this.client = client;
  }

  static async create(url: string): Promise<RedisDriver> {
    let Redis: any;
    try {
      // Imported through a variable so the dependency stays optional.
      const mod = 'ioredis';
      Redis = (await import(mod)).default;
    } catch {
      throw new Error(
        'CACHE_DRIVER=redis requires ioredis. Install it with: npm i ioredis',
      );
    }
    const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    return new RedisDriver(client);
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.k(key));
    return raw == null ? null : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    if (ttl <= 0) return;
    await this.client.set(this.k(key), JSON.stringify(value), 'EX', ttl);
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }

  async clear(): Promise<void> {
    const keys = await this.client.keys(`${this.prefix}*`);
    if (keys.length) await this.client.del(...keys);
  }

  async size(): Promise<number> {
    return this.client.dbsize();
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// No-op
// ---------------------------------------------------------------------------

class NullDriver implements CacheDriver {
  readonly name = 'none';
  async get<T>(): Promise<T | null> {
    return null;
  }
  async set(): Promise<void> {}
  async del(): Promise<void> {}
  async clear(): Promise<void> {}
  async size(): Promise<null> {
    return null;
  }
  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

class Cache {
  private driver: CacheDriver = new NullDriver();
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;

  async init(): Promise<void> {
    switch (config.CACHE_DRIVER) {
      case 'memory':
        this.driver = new MemoryDriver();
        break;
      case 'sqlite':
        this.driver = new SqliteDriver(config.cacheFile);
        break;
      case 'redis':
        this.driver = await RedisDriver.create(config.REDIS_URL);
        break;
      default:
        this.driver = new NullDriver();
    }
    log.info({ driver: this.driver.name }, 'cache initialised');
  }

  get driverName(): string {
    return this.driver.name;
  }

  private async rawGet<T>(key: string): Promise<T | null> {
    const v = await this.driver.get<T>(key);
    if (v === null || v === undefined) this.misses++;
    else this.hits++;
    return v ?? null;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.rawGet<T>(key);
  }

  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    if (value === undefined || value === null) return;
    this.sets++;
    await this.driver.set(key, value, ttl);
  }

  async del(key: string): Promise<void> {
    this.deletes++;
    await this.driver.del(key);
  }

  async clear(): Promise<void> {
    await this.driver.clear();
  }

  /** Concurrent callers for the same key share one computation. */
  private inflight = new Map<string, Promise<unknown>>();

  async wrap<T>(
    key: string,
    ttl: number,
    producer: () => Promise<T | null>,
    opts: { allowNull?: boolean } = {},
  ): Promise<T | null> {
    const cached = await this.rawGet<T>(key);
    if (cached !== null && cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T | null>;

    const p = (async () => {
      try {
        const value = await producer();
        if (value === null || value === undefined) {
          if (opts.allowNull) {
            // Negative-cache briefly so failing providers aren't hammered.
            await this.set(key, value, Math.min(ttl, 60));
          }
          return value ?? null;
        }
        await this.set(key, value, ttl);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p as Promise<T | null>;
  }

  stats(): CacheStats {
    return {
      driver: this.driver.name,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      size: null,
    };
  }

  async size(): Promise<number | null> {
    return this.driver.size();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

export const cache = new Cache();

/** Namespaced key builders, to keep cache keys tidy and collision-free. */
export const ck = {
  meta: (type: string, id: string, lang: string) => `meta:v1:${type}:${id}:${lang}`,
  search: (q: string, type: string, lang: string) =>
    `search:v1:${type}:${lang}:${q.toLowerCase().trim()}`,
  streams: (type: string, id: string, se: string, ep: string, lang: string) =>
    `streams:v1:${type}:${id}:${se ?? '-'}:${ep ?? '-'}:${lang}`,
  proxy: (token: string) => `proxy:v1:${token}`,
  resolve: (providerId: string, type: string, id: string, se: string, ep: string) =>
    `resolve:v1:${providerId}:${type}:${id}:${se ?? '-'}:${ep ?? '-'}`,
};
