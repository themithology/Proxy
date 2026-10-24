/**
 * LOL Embed Cloudflare Worker — embedded player page (/embed) + backend API
 * (TMDB Resolver + Stream Extractors + Edge M3U8 Proxy).
 *
 * This is the player Worker: it serves the embeddable player at exactly
 * /embed plus the player's assets. The main website is built separately and
 * embeds this Worker with an iframe. The landing/developer portal, demo page,
 * and admin dashboard UI are not served; `/` stays a JSON endpoint.
 *
 * The player's API base URL is configurable (API_BASE_URL var or `?api=`
 * query parameter) so the player and the API can run on different Workers.
 *
 * Deploy with:
 *   npx wrangler deploy
 * Or connect your GitHub repository directly in the Cloudflare Dashboard -> Workers & Pages.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
// Shared server catalog (single source of truth with the Node backend). The player renders the `servers` array returned by /api/resolve,
// so rebranding or re-prioritising a server must never require a second edit here.
import serverCatalog from '../src/services/serverCatalog.js';
// Shared Goldmine source resolver (owner-hosted TMDB-Embed-API) + language
// helpers — single source of truth with the Node backend.
import goldmine from '../src/services/goldmine.js';
import languages from '../src/services/languages.js';
import skipSegments from '../src/services/skipSegments.js';
import subtitleSources from '../src/services/subtitleSources.js';
import tmdbArtwork from '../src/services/tmdbArtwork.js';
import statsAggregate from '../src/services/statsAggregate.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Player-visible servers in waterfall priority order (shared catalog). */
const SERVERS = serverCatalog.workerServerList();


// Runtime-editable Upstream Config & Telemetry State in Cloudflare Worker
const runtimeState = {
  startedAt: new Date().toISOString(),
  upstreams: {
    goldmineBase: 'https://rdp-running-campion.onrender.com'
  },
  externalProxyPool: [],
  domains: new Map(),
  blockedDomains: new Set(),
  adFreeDomains: new Set(),
  customOverrides: new Map(),
  serverMetrics: new Map(
    SERVERS.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        badge: s.badge,
        enabled: true,
        priority: s.priority,
        status: 'online',
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastLatencyMs: 0,
        lastError: null
      }
    ])
  )
};

function extractCallerDomain(request, url) {
  const candidates = [
    url.searchParams.get('parent'),
    url.searchParams.get('domain'),
    request.headers.get('origin'),
    request.headers.get('referer')
  ].filter(Boolean);
  const selfHost = url.hostname.toLowerCase();
  for (const raw of candidates) {
    try {
      const h = raw.includes('://')
        ? new URL(raw).hostname.toLowerCase()
        : raw.split('/')[0].split(':')[0].toLowerCase();
      if (!h) continue;
      if (h === selfHost && candidates.length > 1) continue;
      return h;
    } catch {}
  }
  return selfHost || 'direct-access';
}

function recordWorkerDomainHit(request, url, type = 'embed', media = null) {
  const domain = extractCallerDomain(request, url);
  const now = new Date().toISOString();
  let d = runtimeState.domains.get(domain);
  if (!d) {
    d = { domain, embeds: 0, resolves: 0, proxyHits: 0, firstSeen: now, lastSeen: now, topTitles: new Map() };
    runtimeState.domains.set(domain, d);
  }
  d.lastSeen = now;
  if (type === 'embed') d.embeds += 1;
  else if (type === 'resolve') d.resolves += 1;
  else if (type === 'proxy') d.proxyHits += 1;
  if (media && (media.title || media.tmdbId)) {
    const label = media.title ? `${media.title} (#${media.tmdbId})` : `TMDB #${media.tmdbId}`;
    d.topTitles.set(label, (d.topTitles.get(label) || 0) + 1);
  }
}

function recordWorkerServerAttempt(srvId, ok, latencyMs = 0, errMsg = null) {
  // Per-server success/failure/latency also feeds the owner dashboard. No
  // env/ctx here: the event rides along with the resolve outcome's flush.
  queueStatsEvent({ kind: 'server_attempt', server: srvId, ok: !!ok, latencyMs, reason: ok ? null : errMsg });
  const m = runtimeState.serverMetrics.get(srvId);
  if (!m) return;
  m.lastLatencyMs = Math.round(latencyMs);
  if (ok) {
    m.successCount += 1;
    m.lastError = null;
    m.avgLatencyMs = m.avgLatencyMs ? Math.round(m.avgLatencyMs * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);
    m.status = 'online';
  } else {
    m.failureCount += 1;
    m.lastError = errMsg || 'Upstream returned no stream';
    const total = m.successCount + m.failureCount;
    m.status = m.failureCount >= 3 && m.failureCount / total >= 0.75 ? 'dead' : 'degraded';
  }
}

function getWorkerAdminSnapshot() {
  const domains = Array.from(runtimeState.domains.values()).map((d) => ({
    domain: d.domain,
    embeds: d.embeds,
    resolves: d.resolves,
    proxyHits: d.proxyHits,
    totalRequests: d.embeds + d.resolves + d.proxyHits,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    blocked: runtimeState.blockedDomains.has(d.domain.replace(/^www\./, '')),
    topTitles: Array.from(d.topTitles.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([title, count]) => ({ title, count }))
  }));
  const servers = SERVERS.map((s) => {
    const m = runtimeState.serverMetrics.get(s.id) || {};
    const total = (m.successCount || 0) + (m.failureCount || 0);
    return {
      ...s,
      status: s.enabled === false ? 'disabled' : m.status || 'online',
      successCount: m.successCount || 0,
      failureCount: m.failureCount || 0,
      successRate: total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 100,
      avgLatencyMs: m.avgLatencyMs || 0,
      lastLatencyMs: m.lastLatencyMs || 0,
      lastError: m.lastError || null
    };
  });
  return {
    startedAt: runtimeState.startedAt,
    summary: {
      uniqueDomains: domains.length,
      blockedDomainsCount: runtimeState.blockedDomains.size,
      totalEmbeds: domains.reduce((a, d) => a + d.embeds, 0),
      totalResolves: domains.reduce((a, d) => a + d.resolves, 0),
      totalProxyHits: domains.reduce((a, d) => a + d.proxyHits, 0),
      activeServersCount: servers.filter((s) => s.enabled && s.status !== 'dead').length,
      deadOrDegradedCount: servers.filter((s) => s.status === 'dead' || s.status === 'degraded').length
    },
    domains,
    blockedDomains: Array.from(runtimeState.blockedDomains),
    servers,
    upstreams: { ...runtimeState.upstreams },
    externalProxyPool: [...runtimeState.externalProxyPool],
    customOverrides: Array.from(runtimeState.customOverrides.values())
  };
}

// ---------------------------------------------------------------------------
// Usage statistics — owner dashboard at /reze, `GET /api/admin/stats`
// ---------------------------------------------------------------------------
// The counters (most requested / failing titles, sites using the API,
// viewer countries, per-server health, per-day activity, latest failures) and
// owner settings (blocked domains, per-site ad-free list) live in ONE
// SQLite-backed Durable Object (`STATS` binding, class `StatsStore` below) so
// they are global and survive isolate recycling.
// Requests enqueue events in isolate memory and ship them to the object in
// the background (`ctx.waitUntil`): embed / resolve outcomes flush at once,
// per-segment proxy hits are batched. Without the binding (`wrangler dev`
// without the DO, the test-suite) the same aggregate runs in-isolate and the
// dashboard says so (`persistent: false`).

const STATS_OBJECT_NAME = 'global';
const STATS_FLUSH_DELAY_MS = 10000;
const STATS_BATCH_SIZE = 50;
const STATS_BATCH_MAX_AGE_MS = 30000;
const STATS_BLOCKLIST_TTL_MS = 60000;

const localStats = statsAggregate.createStatsAggregate();
const statsQueue = { enabled: false, events: [], lastFlush: 0 };
const blockedDomainsCache = { domains: new Set(), fetchedAt: 0, pending: null };
const adFreeDomainsCache = { domains: new Set(), fetchedAt: 0, pending: null };

function statsStub(env) {
  const ns = env && env.STATS;
  if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') return null;
  try {
    return ns.get(ns.idFromName(STATS_OBJECT_NAME));
  } catch {
    return null;
  }
}

function requestCountry(request) {
  const cf = request && request.cf;
  return (cf && cf.country) || (request && request.headers.get('cf-ipcountry')) || '';
}

/** Queue an event for the Durable Object (no-op when none is bound). */
function queueStatsEvent(event) {
  const stamped = { at: new Date().toISOString(), ...event };
  localStats.record(stamped);
  if (statsQueue.enabled) statsQueue.events.push(stamped);
}

function flushStats(env, ctx) {
  const stub = statsStub(env);
  if (!stub || !statsQueue.events.length) return;
  const batch = statsQueue.events.splice(0);
  statsQueue.lastFlush = Date.now();
  const sent = stub
    .fetch('https://stats.internal/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    })
    .then(() => undefined)
    .catch(() => undefined); // stats must never break a request; drop the batch
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(sent);
}

function recordStatsEvent(env, ctx, event, { urgent = true } = {}) {
  queueStatsEvent(event);
  if (!statsQueue.enabled) return;
  const stale = Date.now() - statsQueue.lastFlush > STATS_BATCH_MAX_AGE_MS;
  if (urgent || statsQueue.events.length >= STATS_BATCH_SIZE || stale) flushStats(env, ctx);
}

function statsMediaFields(metadata) {
  if (!metadata) return {};
  return {
    type: metadata.type === 'movie' ? 'movie' : 'tv',
    tmdbId: metadata.tmdbId,
    title: metadata.title || '',
    year: metadata.releaseYear || null
  };
}

/** `{ type, tmdbId, season, episode }` of a player URL (query or path form). */
function parseEmbedMedia(url) {
  const tv = url.pathname.match(/\/(?:embed\/)?tv\/([^/]+)(?:\/(\d+))?(?:\/(\d+))?/i);
  const movie = url.pathname.match(/\/(?:embed\/)?movie\/([^/]+)/i);
  const q = url.searchParams;
  if (tv) {
    return { type: 'tv', tmdbId: tv[1], season: parseInt(tv[2] || q.get('s') || q.get('season') || '1', 10), episode: parseInt(tv[3] || q.get('e') || q.get('episode') || '1', 10) };
  }
  if (movie) return { type: 'movie', tmdbId: movie[1], season: null, episode: null };
  const type = (q.get('type') || 'tv').toLowerCase() === 'movie' ? 'movie' : 'tv';
  const tmdbId = q.get('tmdb') || q.get('id') || '';
  if (!tmdbId) return null;
  return {
    type,
    tmdbId,
    season: type === 'tv' ? parseInt(q.get('s') || q.get('season') || '1', 10) : null,
    episode: type === 'tv' ? parseInt(q.get('e') || q.get('episode') || '1', 10) : null
  };
}

async function fetchStatsSnapshot(env, limit = 25) {
  const stub = statsStub(env);
  if (stub) {
    try {
      const res = await stub.fetch(`https://stats.internal/snapshot?limit=${encodeURIComponent(limit)}`);
      if (res.ok) return { persistent: true, storage: 'durable-object', ...(await res.json()) };
    } catch {}
  }
  return { persistent: false, storage: 'isolate-memory', ...localStats.snapshot({ limit }) };
}

/** Normalize an owner-entered website host (a URL or hostname) for exact host matching. */
function normalizeSiteDomain(raw) {
  const value = String(raw || '').trim();
  if (!value || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value))) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (!host || host.length > 253 || host.split('.').some((label) =>
      !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )) return '';
    return host;
  } catch {
    return '';
  }
}

/** Owner block-list: persisted in the stats object, cached per isolate for a minute. */
async function getBlockedDomains(env) {
  const stub = statsStub(env);
  if (!stub) return runtimeState.blockedDomains;
  if (Date.now() - blockedDomainsCache.fetchedAt < STATS_BLOCKLIST_TTL_MS) return blockedDomainsCache.domains;
  if (!blockedDomainsCache.pending) {
    blockedDomainsCache.pending = stub
      .fetch('https://stats.internal/blocked')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.blockedDomains)) blockedDomainsCache.domains = new Set(data.blockedDomains);
      })
      .catch(() => undefined)
      .finally(() => {
        blockedDomainsCache.fetchedAt = Date.now();
        blockedDomainsCache.pending = null;
      });
  }
  await blockedDomainsCache.pending;
  return blockedDomainsCache.domains;
}

/** Per-site ad exceptions are persisted with the dashboard's StatsStore and cached per isolate. */
async function getAdFreeDomains(env) {
  const stub = statsStub(env);
  if (!stub) return runtimeState.adFreeDomains;
  if (Date.now() - adFreeDomainsCache.fetchedAt < STATS_BLOCKLIST_TTL_MS) return adFreeDomainsCache.domains;
  if (!adFreeDomainsCache.pending) {
    adFreeDomainsCache.pending = stub
      .fetch('https://stats.internal/ad-free')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.adFreeDomains)) {
          adFreeDomainsCache.domains = new Set(data.adFreeDomains.map(normalizeSiteDomain).filter(Boolean));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        adFreeDomainsCache.fetchedAt = Date.now();
        adFreeDomainsCache.pending = null;
      });
  }
  await adFreeDomainsCache.pending;
  return adFreeDomainsCache.domains;
}

async function isCallerAdFree(request, url, env) {
  const callerDomain = normalizeSiteDomain(extractCallerDomain(request, url));
  if (!callerDomain) return false;
  const adFreeDomains = await getAdFreeDomains(env);
  return adFreeDomains.has(callerDomain);
}

async function isCallerBlocked(request, url, env) {
  const callerDomain = extractCallerDomain(request, url);
  const blocked = await getBlockedDomains(env);
  return blocked.has(callerDomain.replace(/^www\./, '')) ? callerDomain : '';
}

async function setDomainBlocked(env, domain, blocked) {
  const clean = statsAggregate.cleanDomain(domain);
  if (!clean) return null;
  if (blocked) runtimeState.blockedDomains.add(clean);
  else runtimeState.blockedDomains.delete(clean);
  localStats.setBlocked(clean, blocked);
  const stub = statsStub(env);
  if (stub) {
    try {
      const res = await stub.fetch('https://stats.internal/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: clean, blocked })
      });
      const data = res.ok ? await res.json() : null;
      if (data && Array.isArray(data.blockedDomains)) {
        blockedDomainsCache.domains = new Set(data.blockedDomains);
        blockedDomainsCache.fetchedAt = Date.now();
        return data.blockedDomains;
      }
    } catch {}
  }
  return Array.from(runtimeState.blockedDomains).sort();
}

async function setDomainAdFree(env, domain, adFree) {
  const clean = normalizeSiteDomain(domain);
  if (!clean || typeof adFree !== 'boolean') return null;
  if (adFree) runtimeState.adFreeDomains.add(clean);
  else runtimeState.adFreeDomains.delete(clean);

  const stub = statsStub(env);
  if (stub) {
    try {
      const res = await stub.fetch('https://stats.internal/ad-free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: clean, adFree })
      });
      const data = res.ok ? await res.json() : null;
      if (data && Array.isArray(data.adFreeDomains)) {
        adFreeDomainsCache.domains = new Set(data.adFreeDomains.map(normalizeSiteDomain).filter(Boolean));
        adFreeDomainsCache.fetchedAt = Date.now();
        return Array.from(adFreeDomainsCache.domains).sort();
      }
    } catch {}
  }

  return Array.from(runtimeState.adFreeDomains).sort();
}

async function resetStats(env) {
  localStats.reset();
  statsQueue.events.length = 0;
  const stub = statsStub(env);
  if (!stub) return;
  try {
    await stub.fetch('https://stats.internal/reset', { method: 'POST' });
  } catch {}
}

/**
 * Durable Object that owns the counters. Declared in wrangler.toml as
 *   [[durable_objects.bindings]]  name = "STATS", class_name = "StatsStore"
 *   [[migrations]]                tag = "v1", new_sqlite_classes = ["StatsStore"]
 * Events are applied to the in-memory aggregate immediately; only the rows
 * that changed are written to SQLite ten seconds later (one alarm per burst),
 * which keeps row writes far below the free plan's daily allowance. Ad-free
 * site settings are small and written immediately. Written in the plain-class
 * form (no `cloudflare:workers` import) so the module still loads under Node.
 */
export class StatsStore {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.agg = statsAggregate.createStatsAggregate();
    this.adFreeDomains = new Set();
    this.ready = state.blockConcurrencyWhile(() => this.load());
  }

  async load() {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS stats_rows (dim TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (dim, key))'
    );
    this.sql.exec('CREATE TABLE IF NOT EXISTS stats_meta (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const rows = this.sql.exec('SELECT dim, key, data FROM stats_rows').toArray();
    const meta = this.sql.exec('SELECT key, data FROM stats_meta').toArray();
    const adFreeMeta = meta.find((entry) => entry.key === 'ad_free_domains');
    if (adFreeMeta) {
      try {
        const domains = JSON.parse(adFreeMeta.data);
        if (Array.isArray(domains)) this.adFreeDomains = new Set(domains.map(normalizeSiteDomain).filter(Boolean));
      } catch {}
    }
    this.agg.load({ rows, meta });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const { method } = request;
    if (method === 'POST' && url.pathname === '/record') {
      const events = await request.json().catch(() => null);
      this.agg.recordMany(Array.isArray(events) ? events : []);
      await this.scheduleFlush();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/snapshot') {
      const limit = Math.min(100, Math.max(5, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
      return Response.json(this.agg.snapshot({ limit }));
    }
    if (url.pathname === '/blocked') {
      return Response.json({ blockedDomains: this.agg.blockedDomains() });
    }
    if (url.pathname === '/ad-free' && method === 'GET') {
      return Response.json({ adFreeDomains: Array.from(this.adFreeDomains).sort() });
    }
    if (url.pathname === '/ad-free' && method === 'POST') {
      const body = (await request.json().catch(() => null)) || {};
      const domain = normalizeSiteDomain(body.domain);
      if (!domain || typeof body.adFree !== 'boolean') {
        return Response.json({ ok: false, error: 'domain and boolean adFree are required' }, { status: 400 });
      }
      if (body.adFree) this.adFreeDomains.add(domain);
      else this.adFreeDomains.delete(domain);
      const domains = Array.from(this.adFreeDomains).sort();
      this.sql.exec(
        'INSERT INTO stats_meta (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data',
        'ad_free_domains',
        JSON.stringify(domains)
      );
      return Response.json({ ok: true, adFreeDomains: domains });
    }
    if (method === 'POST' && url.pathname === '/block') {
      const body = (await request.json().catch(() => null)) || {};
      this.agg.setBlocked(body.domain, body.blocked !== false);
      this.flush();
      return Response.json({ ok: true, blockedDomains: this.agg.blockedDomains() });
    }
    if (method === 'POST' && url.pathname === '/reset') {
      this.agg.reset();
      this.sql.exec('DELETE FROM stats_rows');
      // Configuration is independent from usage counters; keep ad-free sites on reset.
      this.sql.exec("DELETE FROM stats_meta WHERE key != 'ad_free_domains'");
      this.flush();
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
  }

  async scheduleFlush() {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing === undefined) {
      await this.state.storage.setAlarm(Date.now() + STATS_FLUSH_DELAY_MS);
    }
  }

  async alarm() {
    await this.ready;
    this.flush();
  }

  flush() {
    if (!this.agg.hasDirty()) return;
    const batch = this.agg.drainDirty();
    const write = () => {
      for (const row of batch.rows) {
        this.sql.exec(
          'INSERT INTO stats_rows (dim, key, data) VALUES (?, ?, ?) ON CONFLICT(dim, key) DO UPDATE SET data = excluded.data',
          row.dim,
          row.key,
          row.data
        );
      }
      for (const row of batch.removed) {
        this.sql.exec('DELETE FROM stats_rows WHERE dim = ? AND key = ?', row.dim, row.key);
      }
      for (const [key, data] of [['totals', batch.meta], ['errors', batch.errors], ['blocked', batch.blocked]]) {
        if (!data) continue;
        this.sql.exec('INSERT INTO stats_meta (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data', key, data);
      }
    };
    if (typeof this.state.storage.transactionSync === 'function') this.state.storage.transactionSync(write);
    else write();
  }
}

const NATIVE_LANG_LABELS = {
  ar: 'العربية', ara: 'العربية',
  bn: 'বাংলা', ben: 'বাংলা',
  en: 'English', eng: 'English',
  fil: 'Filipino', tl: 'Filipino', tgl: 'Filipino',
  fr: 'Français', fre: 'Français', fra: 'Français',
  de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch',
  hi: 'हिन्दी', hin: 'हिन्दी',
  id: 'Indonesian', ind: 'Indonesian',
  it: 'Italiano', ita: 'Italiano',
  ja: '日本語', jpn: '日本語',
  ko: '한국어', kor: '한국어',
  pt: 'Português', por: 'Português',
  ru: 'Русский', rus: 'Русский',
  es: 'Español', spa: 'Español',
  tr: 'Türkçe', tur: 'Türkçe',
  vi: 'Tiếng Việt', vie: 'Tiếng Việt',
  zh: '中文', chi: '中文', zho: '中文'
};

// In-isolate fast memory cache + Cloudflare Edge Cache API wrapper
const memoryCache = new Map();

async function edgeCacheGet(key) {
  const mem = memoryCache.get(key);
  if (mem && Date.now() < mem.exp) return mem.val;
  if (typeof caches !== 'undefined' && caches.default) {
    try {
      const cacheUrl = `https://edge-cache.internal/${encodeURIComponent(key)}`;
      const match = await caches.default.match(cacheUrl);
      if (match) {
        const val = await match.json();
        memoryCache.set(key, { val, exp: Date.now() + 300000 });
        return val;
      }
    } catch {}
  }
  return null;
}

async function edgeCacheSet(key, val, ttlSec = 1800) {
  if (memoryCache.size > 1000) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  if (typeof caches !== 'undefined' && caches.default) {
    try {
      const cacheUrl = `https://edge-cache.internal/${encodeURIComponent(key)}`;
      const resp = new Response(JSON.stringify(val), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttlSec}`
        }
      });
      await caches.default.put(cacheUrl, resp);
    } catch {}
  }
}

// The /embed page carries the ad tag between <!--LOL_EMBED_ADS--> markers.
const AD_BLOCK_RE = /[ \t]*<!--LOL_EMBED_ADS-->[\s\S]*?<!--\/LOL_EMBED_ADS-->\n?/g;

function adsEnabled(env) {
  const raw = env && env.ADS_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  return !['false', '0', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function stripAdBlock(html) {
  return String(html).replace(AD_BLOCK_RE, '');
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, X-Requested-With, X-Admin-Key',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges, Content-Disposition',
    'Content-Security-Policy': 'frame-ancestors *;',
    ...extra
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    })
  });
}

/**
 * Static assets the /embed player page is allowed to load. Everything else in
 * `public/` (notably no portal/admin UI) stays unserved.
 */
const PLAYER_ASSET_PATHS = new Set([
  '/css/embed.css',
  '/js/embed.js',
  '/vendor/hls.min.js',
  '/vendor/dash.all.min.js',
  '/vendor/movi/element.js'
]);

/**
 * The two non-player pages this Worker serves, both self-contained HTML files
 * in `public/` (no extra CSS/JS routes): the public documentation and the
 * owner dashboard. `/` itself stays the JSON descriptor / browser rickroll.
 */
const OWNER_PAGES = {
  '/docs': { file: 'docs.html', private: false },
  '/documentation': { file: 'docs.html', private: false },
  '/reze': { file: 'reze.html', private: true }
};

/**
 * Replace the `<!--LOL_EMBED_CONFIG-->` placeholder of a served page with the
 * runtime config (API Worker URL, …). Pages without the placeholder get it
 * injected before `</head>`.
 */
function injectPageConfig(html, config) {
  const script = `<script>window.__LOL_EMBED_CONFIG__=${JSON.stringify(config).replace(/</g, '\\u003c')};</script>`;
  return html.includes('<!--LOL_EMBED_CONFIG-->')
    ? html.replace('<!--LOL_EMBED_CONFIG-->', script)
    : html.replace('</head>', `${script}\n</head>`);
}

function blockedEmbedHtml(domain) {
  const safe = String(domain).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LOL Embed</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}main{padding:24px}h1{font-size:1.1rem;letter-spacing:.14em;text-transform:uppercase;color:#a3a3a3;margin:0 0 12px;font-weight:600}p{color:#f5f5f5;margin:6px 0}code{color:#a3a3a3}</style></head><body><main><h1>LOL Embed</h1><p>This player is not available on <code>${safe}</code>.</p><p>The embed owner has blocked this site.</p></main></body></html>`;
}

/**
 * Normalize the configured API Worker base URL. Accepts an absolute http(s)
 * origin (optionally with a path prefix); returns '' to mean "same origin".
 */
function normalizeApiBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Easter egg for humans who open the Worker root URL in a browser: a
 * monochrome LOL Embed interstitial that rickrolls them. API clients (no
 * `text/html` Accept header) never see this and keep receiving the JSON
 * service descriptor.
 */
const RICKROLL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOL Embed</title>
<meta http-equiv="refresh" content="2;url=https://www.youtube.com/watch?v=dQw4w9WgXcQ">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  main{text-align:center;padding:24px}
  h1{font-size:1.35rem;letter-spacing:.14em;text-transform:uppercase;color:#a3a3a3;margin:0 0 14px;font-weight:600}
  p{color:#f5f5f5;font-size:1.05rem;margin:8px 0}
  a{color:#fff;text-decoration:underline;text-underline-offset:3px}
</style>
<script>window.setTimeout(function () { location.replace('https://www.youtube.com/watch?v=dQw4w9WgXcQ'); }, 1500);</script>
</head>
<body>
<main>
  <h1>LOL Embed</h1>
  <p>Loading something very important&hellip;</p>
  <p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Never gonna give you up</a></p>
</main>
</body>
</html>
`;

/**
 * Convert SubRip (.srt) text to WebVTT (.vtt)
 */
function srtToVtt(rawText) {
  if (!rawText || typeof rawText !== 'string') return 'WEBVTT\n\n';
  const clean = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (clean.startsWith('WEBVTT')) return clean + '\n';
  const vttBody = clean
    .replace(/^\d+\s*\n(?=\d{2}:\d{2}:\d{2})/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/(\d{1,2}:\d{2}),(\d{3})/g, '00:$1.$2');
  return `WEBVTT\n\n${vttBody}\n`;
}

/**
 * Build proxy URL pointing to this Worker's /api/proxy endpoint.
 *
 * `mode`:
 *   'manifest' (default) — only nested playlists/keys are rewritten through the
 *                          proxy, .ts/.m4s segments stream straight from the CDN.
 *   'full'               — every playlist AND segment URI is rewritten through
 *                          the proxy (needed for Origin/Referer-gated hosts).
 *   'direct'             — pass through untouched.
 *
 * `cookie` (optional) is forwarded upstream — for Origin/Referer-gated
 * origins that also pin a session cookie.
 */
function buildWorkerProxyUrl(targetUrl, referer = '', mode = 'manifest', cookie = '', extra = {}) {
  const params = new URLSearchParams({ url: targetUrl, mode });
  if (referer) params.set('referer', referer);
  if (extra && extra.origin) params.set('origin', extra.origin);
  if (cookie) params.set('cookie', cookie);
  if (extra && extra.userAgent) params.set('ua', extra.userAgent);
  return `/api/proxy?${params.toString()}`;
}

function inferMediaContentType(pathname = '', fallbackUrl = '') {
  const probe = `${pathname} ${fallbackUrl}`.toLowerCase();
  if (/\.mkv(?:$|[?#&\s])/.test(probe)) return 'video/x-matroska';
  if (/\.webm(?:$|[?#&\s])/.test(probe)) return 'video/webm';
  if (/\.mpd(?:$|[?#&\s])/.test(probe)) return 'application/dash+xml';
  if (/\.ts(?:$|[?#&\s])/.test(probe)) return 'video/mp2t';
  if (/\.avi(?:$|[?#&\s])/.test(probe)) return 'video/x-msvideo';
  if (/\.mov(?:$|[?#&\s])/.test(probe)) return 'video/quicktime';
  return 'video/mp4';
}

/**
 * 1. Resolve TMDB ID -> Unified Metadata + External IDs (IMDb, TVDB, MAL) + Episodes
 */
/**
 * IMDb ids (`tt1234567`) are accepted wherever a TMDB id is: they are
 * translated once through TMDB's /find endpoint and cached for a day.
 */
async function translateImdbId(normalizedType, rawId, tmdbBase, tmdbKey) {
  if (!/^tt\d{5,10}$/i.test(rawId)) return rawId;
  const imdbId = rawId.toLowerCase();
  const cacheKey = `cf:tmdb:find:${normalizedType}:${imdbId}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetch(
      `${tmdbBase}/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
    );
    if (res.ok) {
      const data = await res.json();
      const preferred = normalizedType === 'tv' ? data.tv_results : data.movie_results;
      const other = normalizedType === 'tv' ? data.movie_results : data.tv_results;
      const hit = (Array.isArray(preferred) && preferred[0]) || (Array.isArray(other) && other[0]) || null;
      if (hit && hit.id) {
        const resolved = String(hit.id);
        await edgeCacheSet(cacheKey, resolved, 86400);
        return resolved;
      }
    }
  } catch {}
  return rawId;
}

async function resolveTmdbMetadata(type, tmdbId, season = 1, episode = 1, env = {}) {
  const normalizedType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
  const sNum = Math.max(1, parseInt(season || 1, 10));
  const eNum = Math.max(1, parseInt(episode || 1, 10));

  const tmdbKey = env.TMDB_API_KEY || '47a1a7df542d3d483227f758a7317dff';
  const tmdbBase = (
    (env && env.TMDB_BASE_URL) ||
    runtimeState.tmdbBaseUrl ||
    'https://api.themoviedb.org/3'
  ).replace(/\/$/, '');
  const cleanId = await translateImdbId(normalizedType, String(tmdbId).trim(), tmdbBase, tmdbKey);

  const cacheKey = `cf:tmdb:v2:${normalizedType}:${cleanId}:s${sNum}:e${eNum}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  let result = null;

  // A single failed TMDB call used to hand back a title-less metadata stub —
  // the player header, stats and artwork all need the title. Retry once
  // quickly: Cloudflare's shared egress IPs hit TMDB rate limits more often
  // than a dedicated host would.
  let detailsData = null;
  // `images` (logos) + tagline + rating feed the player's connect / paused
  // screens; the selection logic is shared with Node (src/services/tmdbArtwork.js).
  const detailsUrl = `${tmdbBase}/${normalizedType}/${cleanId}?api_key=${encodeURIComponent(tmdbKey)}&${tmdbArtwork.DETAILS_APPEND}&language=en-US`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const detailsRes = await fetch(detailsUrl, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
      });
      if (detailsRes.ok) detailsData = await detailsRes.json();
    } catch {}
    if (detailsData && (detailsData.id || detailsData.title || detailsData.name)) break;
    if (attempt === 0) await new Promise((wait) => setTimeout(wait, 300));
  }

  try {
    if (detailsData && (detailsData.id || detailsData.title || detailsData.name)) {
      const data = detailsData;
      const releaseDate = data.release_date || data.first_air_date || '';
      const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;
      const genres = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
      const isAnimation =
        genres.some((g) => /animation|anime/i.test(g)) ||
        (Array.isArray(data.origin_country) && data.origin_country.includes('JP'));

      let seasons = [];
      let episodes = [];

      if (normalizedType === 'tv') {
        seasons = (data.seasons || [])
          .filter((s) => s.season_number > 0)
          .map((s) => ({
            season_number: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episode_count: s.episode_count || 0
          }));

        const sRes = await fetch(
          `${tmdbBase}/tv/${cleanId}/season/${sNum}?api_key=${encodeURIComponent(tmdbKey)}&language=en-US`,
          { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
        );
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData.episodes)) {
            episodes = sData.episodes.map((ep) => ({
              episode: ep.episode_number,
              season: sNum,
              title: ep.name || `Episode ${ep.episode_number}`,
              runtime: ep.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
              date: ep.air_date || '',
              still: ep.still_path
                ? `https://image.tmdb.org/t/p/w500${ep.still_path}`
                : data.backdrop_path
                  ? `https://image.tmdb.org/t/p/w780${data.backdrop_path}`
                  : null,
              overview: ep.overview || ''
            }));
          }
        }
      }

      const title = data.title || data.name;
      const alternativeTitles = (data.alternative_titles?.titles || [])
        .map((entry) => entry && entry.title)
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .slice(0, 25);
      let malId = null;
      if (isAnimation && title) {
        try {
          const jRes = await fetch(
            `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=3`,
            { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
          );
          if (jRes.ok) {
            const jData = await jRes.json();
            malId = jData?.data?.[0]?.mal_id || null;
          }
        } catch {}
      }

      result = {
        tmdbId: Number(cleanId) || cleanId,
        type: normalizedType,
        title,
        originalTitle: data.original_title || data.original_name || title,
        alternativeTitles,
        releaseYear,
        runtime: data.runtime || (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
        genres,
        overview: data.overview || '',
        backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
        ...tmdbArtwork.presentationFields(data),
        externalIds: {
          imdb_id: data.imdb_id || data.external_ids?.imdb_id || null,
          tvdb_id: data.external_ids?.tvdb_id || null,
          mal_id: malId,
          anilist_id: null
        },
        seasons,
        episodes,
        season: sNum,
        episode: eNum,
        activeEpisode:
          normalizedType === 'tv'
            ? episodes.find((e) => Number(e.episode) === eNum) || episodes[0] || null
            : null
      };
    }
  } catch {}

  if (!result) {
    return {
      tmdbId: Number(cleanId) || cleanId,
      type: normalizedType,
      title: null,
      releaseYear: null,
      genres: [],
      externalIds: { imdb_id: null, tvdb_id: null, mal_id: null },
      seasons: [],
      episodes: [],
      season: sNum,
      episode: eNum,
      unresolvedTmdb: true
    };
  }

  await edgeCacheSet(cacheKey, result, 3600);
  return result;
}

/**
 * 2. Resolve Skip Intro / Recap / Credits segments.
 *
 * Providers are queried in parallel and merged by the shared
 * src/services/skipSegments.js parsers (the same code the Node backend runs):
 *   - TheIntroDB v3 keyed by TMDB id (movies + TV)
 *   - IntroDB keyed by the IMDb id bridged from TMDB (movies + TV)
 *   - AniSkip v2 keyed by MAL id (anime TV)
 * Returns the normalised segment array the player consumes.
 */
const SEGMENT_FETCH_TIMEOUT_MS = 4500;
const SEGMENT_POSITIVE_TTL_SECONDS = 6 * 3600;
// Confirmed misses are cached as well: TheIntroDB allows 500 unauthenticated
// requests a day per IP and every player load would otherwise re-ask for
// titles that have no data.
const SEGMENT_NEGATIVE_TTL_SECONDS = 15 * 60;
// When a provider was unreachable (timeout, 5xx, 429) the empty answer is only
// held briefly so a transient outage cannot hide segments for long.
const SEGMENT_FAILED_TTL_SECONDS = 60;

/**
 * Fetch one provider. Resolves `{ answered, data }`: 200 -> data, 404 ->
 * answered with null ("no data for this title"), anything else -> not answered.
 */
async function fetchSegmentJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEGMENT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal
    });
    if (res.status === 404) return { answered: true, data: null };
    if (!res.ok) return { answered: false, data: null };
    return { answered: true, data: await res.json() };
  } catch {
    return { answered: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSkipSegments(metadata, env) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata || {};
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  const cacheKey = `cf:seg:v3:${mediaType}:${tmdbId}:s${season}:e${episode}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const theIntroDbBase = (env && env.THEINTRODB_URL) || skipSegments.DEFAULT_URLS.theIntroDbUrl;
  const theIntroDbKey = (env && env.THEINTRODB_API_KEY) || '';
  const introDbBase = (env && env.INTRODB_URL) || skipSegments.DEFAULT_URLS.introDbUrl;
  const aniSkipBase = (env && env.ANISKIP_URL) || skipSegments.DEFAULT_URLS.aniSkipUrl;

  const lookups = [];
  let allAnswered = true;
  const parsed = (promise, parse) =>
    promise.then(({ answered, data }) => {
      if (!answered) allAnswered = false;
      return parse(data, mediaType);
    });

  const theIntroDbUrl = skipSegments.buildTheIntroDbUrl(theIntroDbBase, {
    tmdbId,
    type: mediaType,
    season,
    episode
  });
  if (theIntroDbUrl) {
    const headers = theIntroDbKey ? { Authorization: `Bearer ${theIntroDbKey}` } : {};
    lookups.push(parsed(fetchSegmentJson(theIntroDbUrl, headers), skipSegments.parseTheIntroDb));
  }

  const introDbUrl = skipSegments.buildIntroDbUrl(introDbBase, {
    imdbId: externalIds.imdb_id,
    type: mediaType,
    season,
    episode
  });
  if (introDbUrl) {
    lookups.push(parsed(fetchSegmentJson(introDbUrl), skipSegments.parseIntroDb));
  }

  if (mediaType === 'tv') {
    const aniSkipUrl = skipSegments.buildAniSkipUrl(aniSkipBase, { malId: externalIds.mal_id, episode });
    if (aniSkipUrl) {
      lookups.push(parsed(fetchSegmentJson(aniSkipUrl), skipSegments.parseAniSkip));
    }
  }

  const segments = skipSegments.mergeSegments(await Promise.all(lookups));
  const ttl = segments.length > 0
    ? SEGMENT_POSITIVE_TTL_SECONDS
    : allAnswered
      ? SEGMENT_NEGATIVE_TTL_SECONDS
      : SEGMENT_FAILED_TTL_SECONDS;
  await edgeCacheSet(cacheKey, segments, ttl);
  return segments;
}

/**
 * 3. Subtitles — OpenSubtitles (via Stremio's keyless v3 addon) + optional
 *    keyed sources (Wyzie, SubDL). The retired rest.opensubtitles.org API is
 *    gone: it answered every download with a "buy VIP" notice.
 */
const SUBTITLE_FETCH_TIMEOUT_MS = 6500;
const SUBTITLE_PROXY_TIMEOUT_MS = 10000;
const SUBTITLE_MAX_BYTES = 4 * 1024 * 1024;

function subtitleSourceConfig(env) {
  const e = env || {};
  const D = subtitleSources.DEFAULT_URLS;
  return {
    stremioBase: e.OPENSUBTITLES_STREMIO_URL || D.openSubtitlesStremioUrl,
    wyzieBase: e.WYZIE_SUBS_URL || D.wyzieSubsUrl,
    wyzieKey: e.WYZIE_API_KEY || '',
    subdlBase: e.SUBDL_API_URL || D.subdlApiUrl,
    subdlDownloadBase: e.SUBDL_DOWNLOAD_URL || D.subdlDownloadUrl,
    subdlKey: e.SUBDL_API_KEY || '',
    extraProxyHosts: e.SUBTITLE_PROXY_HOSTS || ''
  };
}

async function fetchSubtitleJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBTITLE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSubtitles(metadata, env) {
  const { tmdbId, type, season = 1, episode = 1, externalIds = {} } = metadata;
  const cacheKey = `cf:subs:v2:${type}:${tmdbId}:s${season}:e${episode}`;
  const cached = await edgeCacheGet(cacheKey);
  if (cached) return cached;

  const cfg = subtitleSourceConfig(env);
  const ids = { tmdbId, imdbId: externalIds.imdb_id, type, season, episode };
  const lookups = [];

  const stremioUrl = subtitleSources.buildStremioUrl(cfg.stremioBase, ids);
  if (stremioUrl) lookups.push(fetchSubtitleJson(stremioUrl).then(subtitleSources.parseStremio));

  const wyzieUrl = subtitleSources.buildWyzieUrl(cfg.wyzieBase, { ...ids, key: cfg.wyzieKey });
  if (wyzieUrl) lookups.push(fetchSubtitleJson(wyzieUrl).then(subtitleSources.parseWyzie));

  const subdlUrl = subtitleSources.buildSubdlUrl(cfg.subdlBase, { ...ids, key: cfg.subdlKey });
  if (subdlUrl) lookups.push(fetchSubtitleJson(subdlUrl).then((data) => subtitleSources.parseSubdl(data, cfg.subdlDownloadBase)));

  const lists = await Promise.all(lookups);
  const tracks = subtitleSources.toApiTracks(subtitleSources.mergeSubtitleTracks(lists));
  // Positive answers are stable for an hour; an empty answer is retried soon
  // (a source outage should not pin "no subtitles" on a title).
  await edgeCacheSet(cacheKey, tracks, tracks.length > 0 ? 3600 : 120);
  return tracks;
}

/** Fetch a subtitle file (srt / vtt / .gz / .zip, any charset) and return WebVTT text. */
async function fetchSubtitleAsVtt(subUrl, { encoding = '', lang = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBTITLE_PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(subUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Upstream subtitle HTTP ${res.status}`);
    const arrBuf = await res.arrayBuffer();
    if (arrBuf.byteLength > SUBTITLE_MAX_BYTES) throw new Error('Subtitle file too large');
    const bytes = subtitleSources.unwrapSubtitlePayload(new Uint8Array(arrBuf), {
      gunzip: (b) => new Uint8Array(zlib.gunzipSync(Buffer.from(b))),
      inflateRaw: (b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b)))
    });
    const text = subtitleSources.decodeSubtitleBytes(bytes, { encoding, lang });
    if (subtitleSources.looksLikePlaceholderSubtitle(text)) {
      throw new Error('Upstream returned a placeholder instead of a subtitle');
    }
    return srtToVtt(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 4. Upstream Stream Extractor — Goldmine (TMDB-Embed-API)
 *
 * One server, one upstream: the owner-hosted TMDB-Embed-API instance
 * (https://github.com/themithology/TMDB-Embed-API) aggregates every provider
 * (Showbox/FebBox, 4KHDHub, VidLink, DahmerMovies, …) behind a single JSON
 * endpoint. The shared goldmine.js service does the fetch + normalization;
 * this Worker layer adds the runtime pieces: the env-configured API base, an
 * isolate-local circuit breaker and signed proxy URL building. The legacy
 * HLS-only extractors (CastleTV, NetMirror, VidStuck, HiCine and the HubCloud
 * unroller) were removed with the move to full-MKV playback through the
 * bundled movi-player engine.
 */

/** Apply the viewer's `?audio=`/remembered language to a resolved payload. */
function applyPreferredAudio(resolved, preferredAudio) {
  return goldmine.applyPreferredAudioToPayload(resolved, preferredAudio);
}

// ---------------------------------------------------------------------------
// Goldmine circuit breaker (isolate-local): repeated infrastructure failures
// pause the upstream for a minute so the waterfall answers fast instead of
// re-timing-out on every request while the Render service cold-starts or is
// down. Title misses do NOT trip it — those are the providers' answer, not an
// outage.
// ---------------------------------------------------------------------------
const goldmineCircuit = { failures: 0, openedAt: 0 };
const GOLDMINE_CB_THRESHOLD = 4;
const GOLDMINE_CB_COOLDOWN_MS = 60000;

function goldmineCircuitOpen() {
  if (goldmineCircuit.failures < GOLDMINE_CB_THRESHOLD) return false;
  if (Date.now() - goldmineCircuit.openedAt > GOLDMINE_CB_COOLDOWN_MS) {
    goldmineCircuit.failures = 0; // half-open: let one probe through
    return false;
  }
  return true;
}

function goldmineCircuitRecord(ok) {
  if (ok) {
    goldmineCircuit.failures = 0;
    return;
  }
  goldmineCircuit.failures += 1;
  if (goldmineCircuit.failures === GOLDMINE_CB_THRESHOLD) goldmineCircuit.openedAt = Date.now();
}

/** Live TMDB-Embed-API base: env var first, then admin hot-swap, then default. */
function goldmineApiBaseWorker(env) {
  return normalizeApiBaseUrl(
    (env && env.GOLDMINE_API_BASE) ||
      runtimeState.upstreams.goldmineBase ||
      goldmine.GOLDMINE_DEFAULT_API_BASE
  );
}

/** Top of the live waterfall = the default server id for `?server=`-less calls. */
function defaultServerIdWorker() {
  const waterfall = serverCatalog.waterfallEnabledServers(SERVERS);
  return (waterfall[0] && waterfall[0].id) || 'goldmine';
}

async function resolveGoldmineUpstream(metadata, env = null, options = {}) {
  const { onlySource = '', preferredAudio = '', metadataPromise = null } = options;
  const circuitOpen = goldmineCircuitOpen();
  const timeoutMs =
    parseInt(String((env && env.GOLDMINE_TIMEOUT_MS) || ''), 10) || GOLDMINE_TIMEOUT_MS;
  try {
    const resolved = await goldmine.resolveGoldmineServer(metadata, {
      apiBase: goldmineApiBaseWorker(env),
      timeoutMs,
      onlySource,
      preferredAudio,
      metadataPromise,
      directOnly: circuitOpen,
      directFallback: circuitOpen ? 'always' : undefined,
      directProviderOptions: {
        febboxCookies: (env && (env.FEBBOX_COOKIES || env.FEBBOX_COOKIE)) || '',
        febboxRegion: (env && env.FEBBOX_REGION) || '',
        fourKhdhubBaseUrl: (env && (env.FOUR_KHDHUB_BASE_URL || env['4KHDHUB_BASE_URL'])) || '',
        dahmerBaseUrl: (env && env.DAHMER_BASE_URL) || '',
        hdghartvBaseUrl: (env && env.HDGHARTV_BASE_URL) || '',
        netmirrorApiBase: (env && env.NETMIRROR_API_BASE) || '',
        netmirrorStreamReferer: (env && env.NETMIRROR_STREAM_REFERER) || '',
        castleBaseUrl: (env && env.CASTLETV_BASE_URL) || '',
        showboxBaseUrl: (env && env.SHOWBOX_BASE_URL) || '',
        pstreamBaseUrl: (env && env.PSTREAM_BASE_URL) || ''
      },
      // Streams whose host requires Referer/Origin/Cookie/UA get every nested URL
      // rewritten through the proxy ('full'); open hosts only get their
      // manifests/keys rewritten so segments stream straight from the CDN.
      proxyUrl: (targetUrl, referer, meta = {}) => {
        const needsFull = !!(referer || (meta && (meta.origin || meta.cookie || meta.userAgent)));
        return buildWorkerProxyUrl(
          targetUrl,
          referer || '',
          needsFull ? 'full' : 'manifest',
          (meta && meta.cookie) || '',
          meta || {}
        );
      }
    });
    if (resolved && resolved.streamUrl) {
      goldmineCircuitRecord(true);
      return resolved;
    }
    const reason = (resolved && resolved.reason) || 'goldmine_no_streams';
    if (['goldmine_timeout', 'goldmine_unreachable', 'goldmine_http_error', 'goldmine_bad_response'].includes(reason)) {
      goldmineCircuitRecord(false);
    }
    return { reason, diag: (resolved && resolved.diag) || 'no streams' };
  } catch (error) {
    goldmineCircuitRecord(false);
    return { reason: 'goldmine_exception', diag: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
/** Per-upstream budget keeps the waterfall deterministic. Generous: the
 *  TMDB-Embed-API fans out to every enabled provider and free-tier hosts
 *  (Render) cold-start slowly. */
const WATERFALL_UPSTREAM_TIMEOUT_MS = 28000;
const GOLDMINE_TIMEOUT_MS = 25000;

async function withTimeout(promise, ms, fallback = null) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveStreamWaterfall(metadata, requestedServer, preferredAudio, env, source = '', options = {}) {
  const validServer = serverCatalog.resolveServerId(SERVERS, requestedServer);
  const onlySource = String(source || '').toLowerCase();
  // `fresh=1` (the player sends it on Retry and on a manual server pick) skips
  // the edge cache read. Provider URLs are short-lived signed links: replaying
  // a 15-minute-old payload turns "Retry" into "fail again instantly", which is
  // exactly what a dead source looks like from the outside.
  const fresh = !!(options && options.fresh);
  const cacheKey = `cf:resolve:v10:${metadata.type}:${metadata.tmdbId}:s${metadata.season}:e${metadata.episode}:${validServer}${
    onlySource ? `:${onlySource}` : ''
  }`;
  const cached = fresh ? null : await edgeCacheGet(cacheKey);
  if (cached) {
    // Rebuild the displayed server list from the live catalog: the stream payload
    // is cached for 15 minutes, but a rebrand/re-prioritisation must show up in
    // the player immediately instead of being replayed from cache.
    const payload = applyPreferredAudio(cached, preferredAudio);
    return { ...payload, servers: serverCatalog.buildServerPayload(SERVERS, payload.server) };
  }

  // Waterfall order comes from the shared catalog's live priority order, and an
  // explicitly requested server is always attempted first. A pinned source
  // (`?source=<provider>`) locks the request to that server — no fallthrough,
  // so a manual source pick never silently swaps providers.
  const prioritized = serverCatalog.waterfallEnabledServers(SERVERS).map((s) => s.id);
  const order = onlySource ? [validServer] : [validServer, ...prioritized.filter((id) => id !== validServer)];

  // Per-server diagnostic aggregation for API responses and the owner debug endpoint.
  const serverAttempts = [];

  for (const srvId of order) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'goldmine') {
      resolved = await withTimeout(
        resolveGoldmineUpstream(metadata, env, {
          onlySource,
          preferredAudio,
          metadataPromise: options && options.metadataPromise
        }),
        WATERFALL_UPSTREAM_TIMEOUT_MS
      );
    } else {
      resolved = { reason: 'unknown_server', diag: `no resolver for "${srvId}"` };
    }
    const latencyMs = Date.now() - t0;

    if (resolved && resolved.streamUrl) {
      recordWorkerServerAttempt(srvId, true, latencyMs);
      const payload = {
        ...resolved,
        requestedServer: validServer,
        serverAttempts,
        activeAudioTrack:
          resolved.audioTracks?.find((t) => t.default) || resolved.audioTracks?.[0] || null,
        servers: serverCatalog.buildServerPayload(SERVERS, resolved.server)
      };
      const finalPayload = applyPreferredAudio(payload, preferredAudio);
      await edgeCacheSet(cacheKey, finalPayload, finalPayload.ephemeralOnly ? 60 : 900);
      return finalPayload;
    } else {
      const reason =
        resolved && resolved.reason ? resolved.reason : 'no_stream';
      const diag = resolved && resolved.diag ? resolved.diag : null;
      recordWorkerServerAttempt(srvId, false, latencyMs, reason);
      serverAttempts.push({ server: srvId, latencyMs, reason, diag });
    }
  }

  return {
    server: null,
    streamUrl: null,
    // The normalized id, so an error body never echoes a removed/legacy server.
    requestedServer: validServer,
    reason: 'all_servers_failed',
    serverAttempts,
    servers: serverCatalog.buildServerPayload(SERVERS, null)
  };
}

/**
 * 5. M3U8 Manifest Rewriter & Edge Stream Proxy
 */
/**
 * Per-host JWT cache for token-gated stream hosts (`<host>/generate.php`).
 * Tokens are IP bound with a ~4h TTL, so a 10 minute edge cache is safe and
 * keeps the waterfall within the sub-400ms budget.
 */
const jwTokenCache = new Map();

async function fetchHostGateToken(hostOrigin, referer = '') {
  if (!hostOrigin) return '';
  const cached = jwTokenCache.get(hostOrigin);
  if (cached && Date.now() < cached.exp) return cached.token;
  let token = '';
  try {
    const res = await fetch(`${hostOrigin}/generate.php`, {
      headers: {
        'User-Agent': USER_AGENT,
        ...(referer ? { Referer: referer } : {})
      },
      redirect: 'follow'
    });
    if (res.ok) {
      const raw = (await res.text()).trim();
      if (raw) {
        if (raw.startsWith('{')) {
          token = JSON.parse(raw)?.token || '';
        } else if (raw.startsWith('<')) {
          token = '';
        } else {
          token = raw.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {
    token = '';
  }
  if (token) jwTokenCache.set(hostOrigin, { token, exp: Date.now() + 600000 });
  return token;
}

/**
 * Stamp a URL with an __TOKEN__ placeholder or a `?token=` query parameter.
 */
function stampTokenOnUrl(target, token, forUriAttribute = false) {
  if (!target) return target;
  const enc = encodeURIComponent(token);
  let out = target;
  if (out.includes('__TOKEN__')) {
    out = out.replace(/__TOKEN__/g, enc);
  } else if (!/[?&]token=/i.test(out)) {
    if (forUriAttribute || /\.m3u8|\.key|\.ts|\.m4s|\.mp4/i.test(out)) {
      out = `${out}${out.includes('?') ? '&' : '?'}token=${enc}`;
    }
  }
  return out;
}

/**
 * Rewrite an HLS manifest so every nested playlist / key / segment is routed
 * through this Worker (never leaking a bare segment URL that would 403 on
 * Origin/Referer + JWT gated hosts).
 */
function rewriteManifest(m3u8, baseUrl, workerProxyBase, referer, origin, mode, token = '', cookie = '', userAgent = '') {
  const resolveAbs = (u) => {
    try {
      return new URL(u.trim(), baseUrl).toString();
    } catch {
      return u.trim();
    }
  };

  const proxyUri = (target, isPlaylistOrKey) => {
    let abs = resolveAbs(target);
    if (token && !abs.includes('__TOKEN__') && !/[?&]token=/i.test(abs)) {
      abs = stampTokenOnUrl(abs, token, true);
    }
    // In 'manifest' mode (default on Cloudflare), only proxy nested .m3u8 playlists & keys;
    // let heavy .ts/.m4s video segments stream directly from upstream CDN to save Worker request quota!
    if (mode === 'manifest' && !isPlaylistOrKey) return abs;
    const p = new URLSearchParams({ url: abs, mode });
    if (referer) p.set('referer', referer);
    if (origin) p.set('origin', origin);
    if (token) p.set('token', token);
    if (cookie) p.set('cookie', cookie);
    if (userAgent) p.set('ua', userAgent);
    return `${workerProxyBase}?${p.toString()}`;
  };

  return m3u8
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#EXT-X-') && trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUri(u, true)}"`);
      }
      if (trimmed.startsWith('#')) return line;
      const isPlaylist =
        trimmed.includes('.m3u8') || trimmed.includes('playlist') || trimmed.includes('index');
      return proxyUri(trimmed, isPlaylist);
    })
    .join('\n');
}

/**
 * Upstream statuses that mean "this exact request shape is not welcome here"
 * rather than "this file does not exist": hotlink filters reject a Referer they
 * do not expect, picky CDNs reject HEAD, and some hosts answer 416 to the first
 * probe of a file they will happily stream afterwards.
 */
const PROXY_RETRY_STATUSES = new Set([
  400, 401, 403, 404, 405, 406, 410, 412, 415, 416, 429, 451, 500, 502, 503, 504
]);

/** 200 OK bodies that are hotlink/WAF gates rather than media or text/plain HLS. */
const GATE_BODY_CONTENT_TYPE = /^(?:text\/html|text\/xml|application\/(?:json|xml|xhtml\+xml))/i;

/**
 * Peek the first bytes of a non-Range 200 stream when Content-Type is
 * `text/plain` or `application/octet-stream` so disguised `#EXTM3U` HLS
 * playlists (StreamFlix, VaPlayer, Videasy, CastleTV, OneTouchTV, VixSrc) can
 * be rewritten instead of rejected or streamed raw, without buffering binary media.
 */
async function sniffDisguisedM3u8(body, maxManifestBytes = 2 * 1024 * 1024) {
  if (!body || typeof body.getReader !== 'function') {
    return { isPlaylist: false, body };
  }
  const reader = body.getReader();
  const headChunks = [];
  let headLen = 0;
  while (headLen < 32) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      headChunks.push(value);
      headLen += value.byteLength;
    }
  }
  if (headLen === 0) {
    try { reader.releaseLock(); } catch {}
    return { isPlaylist: false, body: new ReadableStream({ start(c) { c.close(); } }) };
  }
  const headBuf = new Uint8Array(Math.min(headLen, 64));
  let offset = 0;
  for (const ch of headChunks) {
    const slice = ch.subarray(0, Math.min(ch.byteLength, headBuf.byteLength - offset));
    headBuf.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= headBuf.byteLength) break;
  }
  const headText = new TextDecoder('utf-8', { fatal: false })
    .decode(headBuf)
    .replace(/^\uFEFF/, '')
    .trimStart();

  if (!headText.startsWith('#EXTM3U')) {
    let idx = 0;
    const rebuilt = new ReadableStream({
      pull(controller) {
        if (idx < headChunks.length) {
          controller.enqueue(headChunks[idx++]);
          return;
        }
        return reader.read().then(({ value, done }) => {
          if (done) controller.close();
          else controller.enqueue(value);
        });
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
    return { isPlaylist: false, body: rebuilt };
  }

  let totalBytes = headLen;
  while (totalBytes <= maxManifestBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      headChunks.push(value);
      totalBytes += value.byteLength;
    }
  }
  if (totalBytes > maxManifestBytes) {
    try { await reader.cancel(); } catch {}
    return { isPlaylist: false, body: null, tooLarge: true };
  }
  const full = new Uint8Array(totalBytes);
  let pos = 0;
  for (const ch of headChunks) {
    full.set(ch, pos);
    pos += ch.byteLength;
  }
  return {
    isPlaylist: true,
    text: new TextDecoder('utf-8', { fatal: false }).decode(full),
    body: null
  };
}

/**
 * Fetch the upstream stream, relaxing request details one at a time when a CDN
 * rejects the first attempt. Order matters: the exact request the player asked
 * for always goes first, then hotlink headers are dropped (a wrong Referer is
 * the single most common cause of an instant 403), then the Range (a few hosts
 * only serve whole files), then both, and finally HEAD is retried as GET.
 *
 * Returns `{ resp, relaxed, method }` — `resp` is the last attempt, `relaxed`
 * names the shape that finally worked (`''` when the first attempt did).
 */
async function fetchUpstreamWithFallbacks(targetUrl, baseHeaders, method, { hasReferer = false, hasRange = false } = {}) {
  // A CDN that rejects the provider's Referer often accepts its own: try that
  // before giving up on the source entirely.
  let selfOrigin = '';
  try {
    selfOrigin = new URL(targetUrl).origin;
  } catch {}
  const canSelfRefer = /^https?:\/\//i.test(selfOrigin);

  const variants = [{ relax: [], method }];
  if (hasReferer) variants.push({ relax: ['hotlink'], method });
  if (hasReferer && canSelfRefer) variants.push({ relax: ['same-origin-referer'], method });
  if (hasRange) variants.push({ relax: ['range'], method });
  if (hasReferer && hasRange) variants.push({ relax: ['hotlink', 'range'], method });
  if (method === 'HEAD') variants.push({ relax: [], method: 'GET' });

  let last = null;
  let gateResp = null;
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    const headers = new Headers(baseHeaders);
    if (variant.relax.includes('hotlink')) {
      headers.delete('Referer');
      headers.delete('Origin');
    }
    if (variant.relax.includes('same-origin-referer')) {
      headers.set('Referer', `${selfOrigin}/`);
      headers.set('Origin', selfOrigin);
    }
    if (variant.relax.includes('range')) headers.delete('Range');

    let resp = null;
    try {
      resp = await fetch(targetUrl, {
        method: variant.method,
        headers,
        redirect: 'follow'
      });
    } catch (err) {
      // Network-level failure: try the next shape, remembering nothing.
      continue;
    }

    if (resp.ok || resp.status === 206) {
      const respCt = (resp.headers.get('content-type') || '').toLowerCase();
      if (resp.status === 200 && GATE_BODY_CONTENT_TYPE.test(respCt) && i < variants.length - 1) {
        try {
          if (resp.body) await resp.body.cancel();
        } catch {}
        if (!gateResp) gateResp = resp;
        continue;
      }
      return { resp, relaxed: variant.relax.join('+'), method: variant.method };
    }
    // Nobody wants this body; release it before the next attempt.
    try {
      if (resp.body) await resp.body.cancel();
    } catch {}
    last = resp;
    if (!PROXY_RETRY_STATUSES.has(resp.status)) break;
  }
  return { resp: gateResp || last, relaxed: null, method };
}

/** Bodies that are never a playable stream (hotlink gates, error pages, JSON). */
const NON_MEDIA_CONTENT_TYPE = /^(?:text\/html|text\/plain|text\/xml|application\/(?:json|xml|xhtml\+xml))/i;

async function handleProxyRequest(request, url) {
  const targetUrl = url.searchParams.get('url');
  const referer = url.searchParams.get('referer') || '';
  const origin = url.searchParams.get('origin') || '';
  const mode = url.searchParams.get('mode') || 'manifest';
  const cookie = url.searchParams.get('cookie') || '';
  const ua = url.searchParams.get('ua') || '';
  const passthroughToken = url.searchParams.get('token') || '';
  const vidsrcStamp = url.searchParams.get('vidsrcStamp') === '1';

  if (!targetUrl) {
    return jsonResponse({
      ok: true,
      brand: 'LOL Embed',
      worker: 'LOL Embed Cloudflare Worker',
      usage: '/api/proxy?url=https://example.com/master.m3u8&referer=https://upstream.site/'
    });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid ?url= parameter' }, 400);
  }

  // Only ever send Referer/Origin when the caller explicitly asked for them —
  // a synthesized Referer is what triggered Pixeldrain's hotlink filter and the
  // Origin/Referer-gated hosts answer 403 without their headers.
  const upstreamHeaders = new Headers({
    'User-Agent': ua || request.headers.get('User-Agent') || USER_AGENT,
    Accept: '*/*'
  });
  if (referer) upstreamHeaders.set('Referer', referer);
  if (origin) {
    upstreamHeaders.set('Origin', origin);
  } else if (referer) {
    try {
      upstreamHeaders.set('Origin', new URL(referer).origin);
    } catch {}
  }
  if (cookie) upstreamHeaders.set('Cookie', cookie);

  // JWT stamping for X-frame/Origin gated hosts: `vidsrcStamp=1` (legacy flag)
  // or an __TOKEN__ placeholder in the URL triggers a <host>/generate.php lookup.
  let token = passthroughToken;
  if (vidsrcStamp || targetUrl.includes('__TOKEN__')) {
    token = token || (await fetchHostGateToken(parsed.origin, referer));
  }

  let upstreamTarget = targetUrl;
  if (token) upstreamTarget = stampTokenOnUrl(targetUrl, token, true);
  const upstreamUrl = new URL(upstreamTarget);

  const range = request.headers.get('Range');
  if (range) upstreamHeaders.set('Range', range);

  // Forward custom safe headers (e.g. Authorization, X-Client-Token, X-Requested-With)
  // sent by movi-player's `headers` attribute without leaking infra/admin headers.
  const proxySkipX = /^x-(?:admin-key|forwarded-|real-ip|amzn-|vercel-|railway-)/i;
  request.headers.forEach((val, key) => {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || (lower.startsWith('x-') && !proxySkipX.test(lower))) {
      if (val && !upstreamHeaders.has(key)) upstreamHeaders.set(key, val);
    }
  });

  const requestedMethod = request.method === 'HEAD' ? 'HEAD' : 'GET';
  const { resp: upstreamResp, relaxed } = await fetchUpstreamWithFallbacks(
    upstreamUrl.toString(),
    upstreamHeaders,
    requestedMethod,
    {
      hasReferer: !!(referer || origin),
      hasRange: !!(range && requestedMethod === 'GET')
    }
  );

  if (!upstreamResp) {
    return jsonResponse(
      { ok: false, error: 'Upstream stream host could not be reached', target: parsed.hostname },
      502
    );
  }

  if (!upstreamResp.ok && upstreamResp.status !== 206) {
    return jsonResponse(
      {
        ok: false,
        error: `Upstream returned HTTP ${upstreamResp.status}`,
        target: parsed.hostname
      },
      upstreamResp.status,
      { 'X-Upstream-Status': String(upstreamResp.status) }
    );
  }

  const contentType = (upstreamResp.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstreamResp.url || upstreamUrl.toString();
  const isM3u8 =
    contentType.includes('mpegurl') ||
    contentType.includes('m3u8') ||
    parsed.pathname.endsWith('.m3u8');

  if (isM3u8 && request.method !== 'HEAD') {
    const text = await upstreamResp.text();
    if (text.trim().startsWith('#EXTM3U')) {
      const workerProxyBase = `${url.origin}/api/proxy`;
      // `mode=full` (or a JWT-stamped response) rewrites every variant AND
      // segment URI through the Worker with the token attached.
      const effectiveMode = mode === 'full' ? 'full' : mode;
      const rewritten = rewriteManifest(
        text,
        finalUrl,
        workerProxyBase,
        referer,
        origin,
        effectiveMode,
        token,
        cookie,
        ua
      );
      return new Response(rewritten, {
        status: 200,
        headers: corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'public, max-age=15',
          'X-Upstream-Status': String(upstreamResp.status),
          ...(relaxed ? { 'X-Proxy-Relaxed': relaxed } : {})
        })
      });
    }
  }

  if (mode === 'full' && isM3u8 && request.method !== 'HEAD') {
    // Upstream answered with something other than an #EXTM3U playlist
    return jsonResponse(
      { ok: false, error: 'Upstream did not return an HLS manifest', target: parsed.hostname },
      502
    );
  }

  let responseBody = upstreamResp.body;
  const declaredLen = parseInt(upstreamResp.headers.get('content-length') || '0', 10);
  const canSniffM3u8 =
    !isM3u8 &&
    requestedMethod !== 'HEAD' &&
    upstreamResp.status === 200 &&
    !range &&
    (!declaredLen || declaredLen <= 2 * 1024 * 1024) &&
    (contentType.startsWith('text/plain') ||
      !contentType ||
      contentType.includes('octet-stream') ||
      contentType.includes('binary/'));

  if (canSniffM3u8 && responseBody) {
    const sniffed = await sniffDisguisedM3u8(responseBody);
    if (sniffed.isPlaylist && sniffed.text) {
      const workerProxyBase = `${url.origin}/api/proxy`;
      const effectiveMode = mode === 'full' ? 'full' : mode;
      const rewritten = rewriteManifest(
        sniffed.text,
        finalUrl,
        workerProxyBase,
        referer,
        origin,
        effectiveMode,
        token,
        cookie,
        ua
      );
      return new Response(rewritten, {
        status: 200,
        headers: corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'public, max-age=15',
          'X-Upstream-Status': String(upstreamResp.status),
          ...(relaxed ? { 'X-Proxy-Relaxed': relaxed } : {})
        })
      });
    }
    responseBody = sniffed.body;
  }

  // A 200 that answers with an HTML/JSON body is a hotlink gate or an error
  // page — passing it through turns into a silent "source failed to decode" in
  // the player. Say what actually happened instead.
  if (upstreamResp.ok && NON_MEDIA_CONTENT_TYPE.test(contentType)) {
    try {
      if (responseBody) await responseBody.cancel();
    } catch {}
    return jsonResponse(
      {
        ok: false,
        error: 'Upstream answered with a non-media body instead of the stream',
        upstreamStatus: upstreamResp.status,
        upstreamType: contentType,
        target: parsed.hostname
      },
      502
    );
  }

  const respHeaders = new Headers(corsHeaders());
  respHeaders.set('Accept-Ranges', 'bytes');
  respHeaders.set('X-Upstream-Status', String(upstreamResp.status));
  if (relaxed) respHeaders.set('X-Proxy-Relaxed', relaxed);
  const resolvedMime =
    !contentType || contentType.includes('octet-stream')
      ? inferMediaContentType(parsed.pathname, finalUrl)
      : contentType;
  respHeaders.set('Content-Type', resolvedMime);

  const cl = upstreamResp.headers.get('content-length');
  if (cl) respHeaders.set('Content-Length', cl);
  const cr = upstreamResp.headers.get('content-range');
  if (cr) respHeaders.set('Content-Range', cr);
  const cd = upstreamResp.headers.get('content-disposition');
  if (cd) respHeaders.set('Content-Disposition', cd);

  // A HEAD answer must stay body-less even when it was retried as a GET.
  const body = requestedMethod === 'HEAD' ? null : responseBody;
  return new Response(body, {
    status: upstreamResp.status,
    headers: respHeaders
  });
}

export default {
  async fetch(request, env = {}, ctx = null) {
    const url = new URL(request.url);
    const { pathname } = url;
    statsQueue.enabled = !!statsStub(env);

    if (request.method === 'OPTIONS') {
      const reqHeaders = request.headers.get('Access-Control-Request-Headers');
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders(
            reqHeaders ? { 'Access-Control-Allow-Headers': reqHeaders } : {}
          )
        }
      );
    }

    // Support standalone proxy mode at root `/?url=https://...` or `/api/proxy?url=https://...`
    if (pathname === '/api/proxy' || (pathname === '/' && url.searchParams.has('url'))) {
      recordWorkerDomainHit(request, url, 'proxy');
      // Segment hits come from the player page itself (Referer = this Worker),
      // so they only count towards the totals, not towards a site.
      const proxyCaller = extractCallerDomain(request, url);
      recordStatsEvent(
        env,
        ctx,
        { kind: 'proxy', domain: proxyCaller === url.hostname.toLowerCase() ? '' : proxyCaller },
        { urgent: false }
      );
      return handleProxyRequest(request, url);
    }

    // --- Owner Admin API Routes (/api/admin/*) ---
    if (pathname.startsWith('/api/admin/')) {
      const expectedKey = env.ADMIN_SECRET || 'admin123';
      const providedKey =
        request.headers.get('x-admin-key') ||
        url.searchParams.get('key') ||
        (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

      if (!providedKey || providedKey !== expectedKey) {
        return jsonResponse({ ok: false, error: 'Unauthorized: Invalid Admin Key' }, 401);
      }

      if (pathname === '/api/admin/overview' && request.method === 'GET') {
        return jsonResponse({
          ok: true,
          ...getWorkerAdminSnapshot(),
          adFreeDomains: Array.from(await getAdFreeDomains(env)).sort(),
          stats: await fetchStatsSnapshot(env)
        });
      }

      // Dashboard feed for /reze: global counters + the live server catalog
      // (names/badges are resolved here so the stats object only stores ids).
      if (pathname === '/api/admin/stats' && request.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '25', 10);
        const stats = await fetchStatsSnapshot(env, Number.isFinite(limit) ? limit : 25);
        return jsonResponse({
          ok: true,
          stats,
          catalog: SERVERS.map((s) => ({ id: s.id, name: s.name, badge: s.badge, priority: s.priority, enabled: s.enabled !== false })),
          servers: getWorkerAdminSnapshot().servers,
          adFreeDomains: Array.from(await getAdFreeDomains(env)).sort(),
          runtime: { startedAt: runtimeState.startedAt, version: '2.3.0', adsEnabled: adsEnabled(env) }
        });
      }

      if (pathname === '/api/admin/domains/ad-free' && request.method === 'GET') {
        return jsonResponse({
          ok: true,
          adFreeDomains: Array.from(await getAdFreeDomains(env)).sort(),
          adsEnabled: adsEnabled(env)
        });
      }

      if (pathname === '/api/admin/domains/ad-free' && request.method === 'POST') {
        const body = (await request.json().catch(() => null)) || {};
        if (typeof body.adFree !== 'boolean') {
          return jsonResponse({ ok: false, error: 'adFree must be a boolean' }, 400);
        }
        const adFreeDomains = await setDomainAdFree(env, body.domain, body.adFree);
        if (!adFreeDomains) return jsonResponse({ ok: false, error: 'Enter a valid website domain' }, 400);
        return jsonResponse({ ok: true, domain: normalizeSiteDomain(body.domain), adFree: body.adFree, adFreeDomains });
      }

      if (pathname === '/api/admin/stats/reset' && request.method === 'POST') {
        await resetStats(env);
        return jsonResponse({ ok: true, stats: await fetchStatsSnapshot(env) });
      }

      if (pathname === '/api/admin/domains/block' && request.method === 'POST') {
        const body = (await request.json().catch(() => null)) || {};
        const blockedDomains = await setDomainBlocked(env, body.domain, body.blocked !== false);
        if (!blockedDomains) return jsonResponse({ ok: false, error: 'domain is required' }, 400);
        return jsonResponse({ ok: true, blockedDomains });
      }

      if (pathname === '/api/admin/probe' && request.method === 'POST') {
        const goldmineBase = goldmineApiBaseWorker(env);
        const targets = [
          { serverId: 'goldmine', url: `${goldmineBase}/api/health` },
          { serverId: 'goldmine', url: `${goldmineBase}/api/providers` }
        ];
        const probeResults = [];
        for (const t of targets) {
          const t0 = Date.now();
          try {
            const r = await fetch(t.url, { headers: { 'User-Agent': USER_AGENT, ...(t.headers || {}) } });
            const ms = Date.now() - t0;
            const ok = r.status >= 200 && r.status < 400;
            recordWorkerServerAttempt(t.serverId, ok, ms, ok ? null : `HTTP ${r.status}`);
            probeResults.push({ serverId: t.serverId, url: t.url, ok, httpStatus: r.status, latencyMs: ms });
          } catch (e) {
            const ms = Date.now() - t0;
            recordWorkerServerAttempt(t.serverId, false, ms, e.message);
            probeResults.push({ serverId: t.serverId, url: t.url, ok: false, httpStatus: 0, latencyMs: ms, error: e.message });
          }
        }
        return jsonResponse({ ok: true, probeResults, snapshot: getWorkerAdminSnapshot() });
      }

      // Owner diagnostic for the Goldmine source: runs the TMDB-Embed-API for
      // one title and reports per-provider stream counts, timings, qualities
      // and dub languages — "is the API working?" answered with data.
      const goldmineDiagMatch = pathname.match(/^\/api\/admin\/goldmine\/diagnose\/(movie|tv)\/([^/]+)$/);
      if (goldmineDiagMatch && request.method === 'GET') {
        const [, diagType, diagTmdb] = goldmineDiagMatch;
        const diagSeason = parseInt(url.searchParams.get('season') || '1', 10);
        const diagEpisode = parseInt(url.searchParams.get('episode') || '1', 10);
        try {
          const meta = await resolveTmdbMetadata(diagType, diagTmdb, diagSeason, diagEpisode, env);
          const report = await goldmine.diagnoseGoldmine(meta, {
            apiBase: goldmineApiBaseWorker(env),
            timeoutMs: 30000
          });
          return jsonResponse(report);
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      }

      if (pathname.startsWith('/api/admin/overrides/') && request.method === 'DELETE') {
        const key = decodeURIComponent(pathname.replace('/api/admin/overrides/', ''));
        runtimeState.customOverrides.delete(key);
        return jsonResponse({ ok: true, snapshot: getWorkerAdminSnapshot() });
      }
    }

    // --- API Routes ---
    if (pathname === '/api/health') {
      return jsonResponse({
        ok: true,
        brand: 'LOL Embed',
        runtime: 'cloudflare-workers-edge',
        service: 'lol-embed-backend',
        mode: 'player-and-api',
        version: '2.2.0',
        embed: '/embed',
        metaImage: '/meta-image.gif',
        servers: SERVERS.map((s) => s.id)
      });
    }

    // Public, cacheable list of player-visible servers (ids are what `?server=`
    // accepts). Provider/upstream names are never part of this payload.
    if (pathname === '/api/servers' && ['GET', 'HEAD'].includes(request.method)) {
      const servers = serverCatalog
        .listableServers(SERVERS)
        .map((s) => ({ id: s.id, name: s.name, badge: s.badge, priority: s.priority }));
      return new Response(JSON.stringify({ ok: true, servers }), {
        status: 200,
        headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' })
      });
    }

    if (pathname === '/api/catalog') {
      return jsonResponse({
        ok: true,
        items: [
          { tmdbId: 94605, type: 'tv', title: 'Arcane', releaseYear: 2021, imdbId: 'tt11126994' },
          { tmdbId: 1396, type: 'tv', title: 'Breaking Bad', releaseYear: 2008, imdbId: 'tt0903747' },
          { tmdbId: 693134, type: 'movie', title: 'Dune: Part Two', releaseYear: 2024, imdbId: 'tt15239678' }
        ]
      });
    }

    // GET /api/subtitles/proxy?url=...&enc=<charset>&lang=<code>
    // Only subtitle hosts (and the configured source mirrors) may be fetched:
    // this endpoint must not be a general-purpose relay.
    if (pathname === '/api/subtitles/proxy') {
      const subUrl = url.searchParams.get('url');
      if (!subUrl) return new Response('Missing url', { status: 400, headers: corsHeaders() });
      const cfg = subtitleSourceConfig(env);
      const allowed = subtitleSources.isAllowedSubtitleUrl(subUrl, {
        bases: [cfg.stremioBase, cfg.wyzieBase, cfg.subdlBase, cfg.subdlDownloadBase],
        extraHosts: cfg.extraProxyHosts
      });
      if (!allowed) return new Response('Subtitle host not allowed', { status: 403, headers: corsHeaders() });
      try {
        const vtt = await fetchSubtitleAsVtt(subUrl, {
          encoding: url.searchParams.get('enc') || '',
          lang: url.searchParams.get('lang') || ''
        });
        return new Response(vtt, {
          status: 200,
          headers: corsHeaders({
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'public, max-age=7200'
          })
        });
      } catch (err) {
        return new Response(`Subtitle error: ${err.message}`, { status: 502, headers: corsHeaders() });
      }
    }

    // POST /api/subtitles/convert
    if (pathname === '/api/subtitles/convert' && request.method === 'POST') {
      const raw = await request.text();
      return new Response(srtToVtt(raw), {
        status: 200,
        headers: corsHeaders({ 'Content-Type': 'text/vtt; charset=utf-8' })
      });
    }


    // Match /api/(info|segments|subtitles|resolve)/:type/:tmdbId
    const apiMatch = pathname.match(/^\/api\/(info|segments|subtitles|resolve)\/(movie|tv|series)\/([^/]+)$/i);
    if (apiMatch) {
      const [, action, rawType, tmdbId] = apiMatch;
      const season = parseInt(url.searchParams.get('season') || url.searchParams.get('s') || '1', 10);
      const episode = parseInt(url.searchParams.get('episode') || url.searchParams.get('e') || '1', 10);
      const server = (url.searchParams.get('server') || defaultServerIdWorker()).toLowerCase();
      const audio = url.searchParams.get('audio') || '';
      // `?source=` pins one TMDB-Embed-API provider (manual source switching).
      // Provider ids are alnum slugs: `vidlink`, `4khdhub`, `dahmermovies`, …
      const rawSource = (url.searchParams.get('source') || '').toLowerCase();
      const source = /^[a-z0-9]{3,24}$/.test(rawSource) ? rawSource : '';

      if (action !== 'resolve') {
        const metadata = await resolveTmdbMetadata(rawType, tmdbId, season, episode, env);

        if (action === 'info') {
          const segments = await resolveSkipSegments(metadata, env);
          return jsonResponse({ ok: true, metadata, segments, servers: serverCatalog.listableServers(SERVERS) });
        }

        if (action === 'segments') {
          const segments = await resolveSkipSegments(metadata, env);
          return jsonResponse({ ok: true, tmdbId: metadata.tmdbId, segments });
        }

        if (action === 'subtitles') {
          const tracks = await resolveSubtitles(metadata, env);
          return jsonResponse({ ok: true, tmdbId: metadata.tmdbId, tracks });
        }
      }

      if (action === 'resolve') {
        const callerDomain = extractCallerDomain(request, url);
        if (await isCallerBlocked(request, url, env)) {
          return jsonResponse({ ok: false, error: `Domain "${callerDomain}" is blocked by the embed owner.` }, 403);
        }

        const normalizedType = rawType.toLowerCase() === 'movie' ? 'movie' : 'tv';
        const trimmedId = String(tmdbId || '').trim();
        const isNumericTmdb = /^\d+$/.test(trimmedId);
        // `?fresh=1` (or `?nocache=1`) forces a live re-resolve so a retry never
        // replays expired provider URLs from the 15-minute edge cache.
        const freshParam = String(url.searchParams.get('fresh') || url.searchParams.get('nocache') || '').toLowerCase();
        const fresh = freshParam === '1' || freshParam === 'true' || freshParam === 'yes';

        const buildCustomStream = (customOv) => ({
          server: 'custom',
          format: customOv.format || 'hls',
          rawUrl: customOv.streamUrl,
          streamUrl: buildWorkerProxyUrl(customOv.streamUrl, ''),
          audioTracks: [
            {
              id: 'custom-orig',
              lang: 'en',
              label: customOv.label || 'Custom Admin Source',
              type: 'sub',
              streamUrl: buildWorkerProxyUrl(customOv.streamUrl, ''),
              rawUrl: customOv.streamUrl,
              default: true
            }
          ],
          qualities: [{ label: 'Auto', height: 0, url: buildWorkerProxyUrl(customOv.streamUrl, '') }],
          servers: serverCatalog.buildServerPayload(SERVERS, null)
        });

        let metadata;
        let streamData;
        let subtitles;
        let segments;

        if (isNumericTmdb) {
          // Fast path: Goldmine only needs { type, tmdbId, season, episode }, so run
          // stream extraction in parallel with TMDB metadata instead of sequentially.
          const stubMeta = { type: normalizedType, tmdbId: trimmedId, season, episode };
          const ovKey = normalizedType === 'tv' ? `tv:${trimmedId}:${season}:${episode}` : `movie:${trimmedId}:1:1`;
          const customOv = runtimeState.customOverrides.get(ovKey);

          const metadataPromise = resolveTmdbMetadata(rawType, trimmedId, season, episode, env);
          const streamPromise = customOv
            ? Promise.resolve(buildCustomStream(customOv))
            : resolveStreamWaterfall(stubMeta, server, audio, env, source, { fresh, metadataPromise });
          const subtitlesPromise = metadataPromise.then((m) => resolveSubtitles(m, env)).catch(() => []);
          const segmentsPromise = metadataPromise.then((m) => resolveSkipSegments(m, env)).catch(() => []);

          [metadata, streamData] = await Promise.all([metadataPromise, streamPromise]);
          [subtitles, segments] = await Promise.all([
            withTimeout(subtitlesPromise, 2500, []),
            withTimeout(segmentsPromise, 2500, [])
          ]);
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(Promise.allSettled([subtitlesPromise, segmentsPromise]));
          }
        } else {
          // IMDb (`tt...`) ids translate to TMDB id first inside resolveTmdbMetadata.
          metadata = await resolveTmdbMetadata(rawType, trimmedId, season, episode, env);
          const ovKey = metadata.type === 'tv' ? `tv:${metadata.tmdbId}:${season}:${episode}` : `movie:${metadata.tmdbId}:1:1`;
          const customOv = runtimeState.customOverrides.get(ovKey);
          const subtitlesPromise = resolveSubtitles(metadata, env).catch(() => []);
          const segmentsPromise = resolveSkipSegments(metadata, env).catch(() => []);
          streamData = customOv
            ? buildCustomStream(customOv)
            : await resolveStreamWaterfall(metadata, server, audio, env, source, { fresh });
          [subtitles, segments] = await Promise.all([
            withTimeout(subtitlesPromise, 2500, []),
            withTimeout(segmentsPromise, 2500, [])
          ]);
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(Promise.allSettled([subtitlesPromise, segmentsPromise]));
          }
        }

        recordWorkerDomainHit(request, url, 'resolve', metadata);
        const statsBase = {
          domain: callerDomain === url.hostname.toLowerCase() ? '' : callerDomain,
          country: requestCountry(request),
          ...statsMediaFields(metadata),
          season: metadata.type === 'tv' ? season : null,
          episode: metadata.type === 'tv' ? episode : null,
          server
        };

        if (!streamData || !streamData.streamUrl) {
          // Include a useful per-server explanation in this API error response.
          const attempts = (streamData && streamData.serverAttempts) || [];
          const firstFailed = attempts.find((a) => a.server === server) || attempts[0];
          const reasonMap = {
            circuit_open: 'Server paused (too many recent failures).',
            goldmine_unreachable: 'The TMDB-Embed-API instance could not be reached (is the Render service awake?).',
            goldmine_timeout: 'The TMDB-Embed-API took too long to answer (cold start or slow providers).',
            goldmine_http_error: 'The TMDB-Embed-API answered with an HTTP error.',
            goldmine_bad_response: 'The TMDB-Embed-API answered with an unexpected payload.',
            goldmine_no_streams: 'No provider on the TMDB-Embed-API has this title right now.',
            goldmine_source_empty: 'The pinned source (provider) returned no playable streams for this title.',
            goldmine_source_unknown: 'Unknown provider id — check /api/providers on the TMDB-Embed-API.',
            goldmine_source_disabled: 'That provider is disabled on the TMDB-Embed-API instance.',
            goldmine_exception: 'Unhandled error contacting the TMDB-Embed-API.',
            goldmine_no_title: 'Title metadata could not be resolved (TMDB unreachable?), so upstreams were not queried.',
            unknown_server: 'That server id is not in the catalog.',
          };
          const humanReason = firstFailed
            ? reasonMap[firstFailed.reason] || firstFailed.reason
            : 'No working server in the waterfall.';
          const humanDiag = firstFailed && firstFailed.diag ? firstFailed.diag.message : null;
          recordStatsEvent(env, ctx, {
            kind: 'resolve_error',
            ...statsBase,
            server: firstFailed ? firstFailed.server : server,
            reason: firstFailed ? firstFailed.reason : (streamData && streamData.reason) || 'no_stream'
          });
          return jsonResponse(
            {
              ok: false,
              error: 'Unable to resolve stream from upstream providers for this title.',
              explanation: humanReason,
              serverExplanation: humanDiag,
              requestedServer: (streamData && streamData.requestedServer) || server,
              failedReason: firstFailed ? firstFailed.reason : null,
              serverAttempts: attempts,
              metadata,
              subtitles,
              segments,
              servers: (streamData && streamData.servers) || serverCatalog.buildServerPayload(SERVERS, null)
            },
            502
          );
        }

        recordStatsEvent(env, ctx, { kind: 'resolve', ...statsBase, server: streamData.server || server });
        return jsonResponse({
          ok: true,
          metadata,
          stream: streamData,
          subtitles,
          segments,
          servers: streamData.servers
        });
      }
    }

    // --- Embedded Player Page (/embed) ---
    // The player Worker serves exactly one HTML page. The main website is a
    // separate project and embeds this URL with an iframe. Both the canonical
    // query form and the path/legacy forms route here:
    //   /embed?type=tv&tmdb=94605&s=1&e=1   /embed/movie/693134
    //   /embed/tv/94605/2/1                 /movie/693134
    //   /tv/94605/2/1
    const isEmbedRoute = pathname === '/embed' || /^\/(?:embed\/)?(?:movie|tv)\/[^/]+(?:\/\d+(?:\/\d+)?)?\/?$/i.test(pathname);
    if (isEmbedRoute && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Player assets are not configured' }, 503);
      }
      const blockedCaller = await isCallerBlocked(request, url, env);
      if (blockedCaller) {
        return new Response(blockedEmbedHtml(blockedCaller), {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
      recordWorkerDomainHit(request, url, 'embed');
      const embedCaller = extractCallerDomain(request, url);
      const embedMedia = parseEmbedMedia(url);
      recordStatsEvent(env, ctx, {
        kind: 'embed',
        domain: embedCaller === url.hostname.toLowerCase() ? '' : embedCaller,
        country: requestCountry(request),
        ...(embedMedia || {}),
        // IMDb-keyed embeds are attributed to the title once the resolve
        // has translated the id; a `tt…` row would never get a name.
        tmdbId: embedMedia && /^\d+$/.test(String(embedMedia.tmdbId)) ? embedMedia.tmdbId : null
      });
      const embedReq = new Request(new URL('/embed.html', url.origin), { method: 'GET' });
      const assetRes = await env.ASSETS.fetch(embedReq);
      if (!assetRes.ok) {
        return jsonResponse({ ok: false, error: 'Player page is unavailable' }, assetRes.status);
      }
      let html = injectPageConfig(await assetRes.text(), {
        apiBaseUrl: normalizeApiBaseUrl(env.API_BASE_URL),
        // ffmpeg exists only on an explicitly configured Node host. A real
        // Cloudflare Worker leaves this false and keeps the normal fallback.
        mkvHlsEnabled: env.MKV_HLS_ENABLED === 'true' && env.MKV_HLS_NODE_HOST === 'true'
      });
      // ADS_ENABLED is the global switch; ad-free domains are scoped exceptions.
      if (!adsEnabled(env) || await isCallerAdFree(request, url, env)) html = stripAdBlock(html);
      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        // Must be iframe-embeddable by the (separately built) main website.
        'Content-Security-Policy': 'frame-ancestors *;',
        'Access-Control-Allow-Origin': '*'
      });
      headers.delete('X-Frame-Options');
      return new Response(html, { status: 200, headers });
    }

    // --- Documentation (/docs, alias /documentation) and owner dashboard (/reze) ---
    // Self-contained pages (inline CSS/JS, no extra asset routes). `/` keeps
    // its JSON descriptor + browser rickroll; the dashboard shell is public
    // but every number on it comes from the key-protected /api/admin/stats.
    const ownerPage = OWNER_PAGES[pathname.replace(/\/+$/, '') || '/'];
    if (ownerPage && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Page assets are not configured' }, 503);
      }
      const pageRes = await env.ASSETS.fetch(new Request(new URL(`/${ownerPage.file}`, url.origin), { method: 'GET' }));
      if (!pageRes.ok) {
        return jsonResponse({ ok: false, error: 'Page is unavailable' }, pageRes.status);
      }
      const html = injectPageConfig(await pageRes.text(), {
        apiBaseUrl: normalizeApiBaseUrl(env.API_BASE_URL),
        adsEnabled: adsEnabled(env),
        servers: serverCatalog.listableServers(SERVERS).map((s) => ({ id: s.id, name: s.name, badge: s.badge }))
      });
      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      if (ownerPage.private) {
        headers.set('X-Robots-Tag', 'noindex, nofollow');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Content-Security-Policy', "frame-ancestors 'none';");
      }
      return new Response(html, { status: 200, headers });
    }

    // --- Player Static Assets (only what the /embed page needs) ---
    if (PLAYER_ASSET_PATHS.has(pathname) && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Player assets are not configured' }, 503);
      }
      const assetRes = await env.ASSETS.fetch(new Request(new URL(pathname, url.origin), { method: 'GET' }));
      if (!assetRes.ok) {
        return jsonResponse({ ok: false, error: 'Player asset is unavailable' }, assetRes.status);
      }
      // The player bundle (embed.js / embed.css) must revalidate so a server
      // rebrand or player fix reaches viewers on their next load instead of
      // being pinned for a day behind max-age. Vendor libraries keep the long TTL.
      const isPlayerBundle = pathname === '/js/embed.js' || pathname === '/css/embed.css';
      const headers = new Headers();
      headers.set('Cache-Control', isPlayerBundle ? 'no-cache' : 'public, max-age=86400, stale-while-revalidate=604800');
      headers.set('Access-Control-Allow-Origin', '*');
      for (const headerName of ['Content-Type', 'ETag', 'Last-Modified']) {
        const value = assetRes.headers.get(headerName);
        if (value) headers.set(headerName, value);
      }
      const existingCt = (headers.get('Content-Type') || '').toLowerCase();
      if (pathname.endsWith('.css') && !existingCt.includes('text/css')) {
        headers.set('Content-Type', 'text/css; charset=utf-8');
      } else if (pathname.endsWith('.js') && !existingCt.includes('javascript')) {
        headers.set('Content-Type', 'text/javascript; charset=utf-8');
      }
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    // The social/meta image stays browser-addressable.
    if (pathname === '/meta-image.gif' && ['GET', 'HEAD'].includes(request.method)) {
      if (!env.ASSETS) {
        return jsonResponse({ ok: false, error: 'Meta-image asset is not configured' }, 503);
      }
      const assetReq = new Request(new URL('/lol-embed-meta.gif', url.origin), request);
      const assetRes = await env.ASSETS.fetch(assetReq);
      if (!assetRes.ok) {
        return jsonResponse({ ok: false, error: 'Meta-image asset is unavailable' }, assetRes.status);
      }
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Type', 'image/gif');
      headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    // `/` stays a JSON service descriptor for API clients — the main website
    // is a separate project and is not served from this Worker.
    if (pathname === '/' && request.method === 'GET') {
      // Easter egg: a human opening the Worker URL in a browser (Accept:
      // text/html) gets rickrolled; every non-browser client keeps the JSON.
      const acceptHeader = request.headers.get('accept') || '';
      if (acceptHeader.includes('text/html')) {
        return new Response(RICKROLL_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return jsonResponse({
        ok: true,
        brand: 'LOL Embed',
        service: 'lol-embed-backend',
        runtime: 'cloudflare-workers-edge',
        mode: 'player-and-api',
        version: '2.2.0',
        embed: '/embed',
        api: '/api',
        health: '/api/health',
        metaImage: '/meta-image.gif'
      });
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  }
};
