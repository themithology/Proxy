/**
 * Usage statistics aggregate — the data model behind the owner dashboard
 * (`/reze`) and `GET /api/admin/stats`.
 *
 * One counter set, four dimensions:
 *
 *   titles     "most requested" / "most failing" titles (one row per TMDB title,
 *              episodes of a show roll up into the show)
 *   domains    who is using the API — the host page's domain (`?parent=`,
 *              Origin, or Referer of the embed / resolve request)
 *   countries  where the viewers are (`request.cf.country` / `CF-IPCountry`)
 *   servers    per-server success / failure / latency
 *
 * plus per-day buckets (small activity chart), a ring buffer of the latest
 * failures, totals, and the owner's blocked-domain list.
 *
 * The module is runtime-neutral on purpose: the Cloudflare Worker feeds it
 * inside a SQLite-backed Durable Object (persistent, global counters) *and*
 * uses it as an in-isolate fallback when no Durable Object is bound; the Node
 * backend uses it in-process. Persistence is delegated: `drainDirty()` hands
 * back only the rows that changed since the last call so a store can write a
 * handful of rows per flush instead of the whole table, and `load()` rebuilds
 * the aggregate from those rows.
 */

'use strict';

const LIMITS = Object.freeze({
  titles: 3000,
  domains: 2000,
  countries: 300,
  servers: 64,
  days: 45,
  errors: 60
});

const PRUNE_FRACTION = 0.1;

function nowIso() {
  return new Date().toISOString();
}

function dayOf(iso) {
  return String(iso || nowIso()).slice(0, 10);
}

function cleanDomain(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^www\./, '');
  return value.slice(0, 253);
}

function cleanCountry(raw) {
  const value = String(raw || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1' ? value : 'ZZ';
}

function titleKey(event) {
  const type = event.type === 'movie' ? 'movie' : 'tv';
  const id = String(event.tmdbId || '').trim();
  return id ? `${type}:${id}` : '';
}

function titleLabel(entry) {
  if (!entry.title) return `TMDB #${entry.tmdbId}`;
  return entry.year ? `${entry.title} (${entry.year})` : entry.title;
}

function createStatsAggregate(options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };

  const state = {
    startedAt: nowIso(),
    totals: { embeds: 0, resolves: 0, resolveErrors: 0, proxyHits: 0, lastEventAt: null },
    titles: new Map(),
    domains: new Map(),
    countries: new Map(),
    servers: new Map(),
    days: new Map(),
    errors: [],
    blocked: new Set()
  };

  const dirty = {
    rows: new Map(), // dim -> Set(key)
    removed: [], // [{ dim, key }]
    meta: false,
    errors: false,
    blocked: false
  };

  function markDirty(dim, key) {
    if (!dirty.rows.has(dim)) dirty.rows.set(dim, new Set());
    dirty.rows.get(dim).add(key);
  }

  function prune(dim, map, countOf) {
    const limit = limits[dim];
    if (!limit || map.size <= limit) return;
    const drop = Math.max(1, Math.floor(limit * PRUNE_FRACTION));
    const victims = Array.from(map.entries())
      .sort((a, b) => countOf(a[1]) - countOf(b[1]))
      .slice(0, drop);
    for (const [key] of victims) {
      map.delete(key);
      if (dirty.rows.has(dim)) dirty.rows.get(dim).delete(key);
      dirty.removed.push({ dim, key });
    }
  }

  function dayBucket(at) {
    const day = dayOf(at);
    let bucket = state.days.get(day);
    if (!bucket) {
      bucket = { day, embeds: 0, resolves: 0, fails: 0, proxyHits: 0 };
      state.days.set(day, bucket);
      if (state.days.size > limits.days) {
        const oldest = Array.from(state.days.keys()).sort().slice(0, state.days.size - limits.days);
        for (const key of oldest) {
          state.days.delete(key);
          dirty.removed.push({ dim: 'days', key });
        }
      }
    }
    markDirty('days', day);
    return bucket;
  }

  function touchDomain(event, at) {
    const domain = cleanDomain(event.domain);
    if (!domain) return null;
    let entry = state.domains.get(domain);
    if (!entry) {
      entry = { domain, embeds: 0, resolves: 0, proxyHits: 0, fails: 0, firstSeen: at, lastSeen: at };
      state.domains.set(domain, entry);
      prune('domains', state.domains, (d) => d.embeds + d.resolves + d.proxyHits);
    }
    entry.lastSeen = at;
    markDirty('domains', domain);
    return entry;
  }

  function touchCountry(event, at) {
    const code = cleanCountry(event.country);
    let entry = state.countries.get(code);
    if (!entry) {
      entry = { code, count: 0, lastSeen: at };
      state.countries.set(code, entry);
      prune('countries', state.countries, (c) => c.count);
    }
    entry.count += 1;
    entry.lastSeen = at;
    markDirty('countries', code);
    return entry;
  }

  function touchTitle(event, at) {
    const key = titleKey(event);
    if (!key) return null;
    let entry = state.titles.get(key);
    if (!entry) {
      entry = {
        key,
        type: event.type === 'movie' ? 'movie' : 'tv',
        tmdbId: String(event.tmdbId),
        title: '',
        year: null,
        requests: 0,
        fails: 0,
        lastSeen: at
      };
      state.titles.set(key, entry);
      prune('titles', state.titles, (t) => t.requests + t.fails);
    }
    if (event.title) entry.title = String(event.title).slice(0, 160);
    if (event.year && Number.isFinite(Number(event.year))) entry.year = Number(event.year);
    entry.lastSeen = at;
    markDirty('titles', key);
    return entry;
  }

  function touchServer(id, at) {
    const serverId = String(id || '').trim().slice(0, 64);
    if (!serverId) return null;
    let entry = state.servers.get(serverId);
    if (!entry) {
      entry = {
        id: serverId,
        ok: 0,
        fails: 0,
        avgLatencyMs: 0,
        lastLatencyMs: 0,
        lastOkAt: null,
        lastError: null,
        lastErrorAt: null
      };
      state.servers.set(serverId, entry);
      prune('servers', state.servers, (s) => s.ok + s.fails);
    }
    markDirty('servers', serverId);
    return entry;
  }

  function pushError(event, at, title) {
    state.errors.unshift({
      at,
      key: title ? title.key : null,
      title: title ? titleLabel(title) : null,
      season: event.season != null ? Number(event.season) : null,
      episode: event.episode != null ? Number(event.episode) : null,
      server: event.server ? String(event.server).slice(0, 64) : null,
      reason: event.reason ? String(event.reason).slice(0, 200) : 'unknown',
      domain: cleanDomain(event.domain) || null,
      country: event.country ? cleanCountry(event.country) : null
    });
    if (state.errors.length > limits.errors) state.errors.length = limits.errors;
    dirty.errors = true;
  }

  /**
   * Record one event. Shapes:
   *   { kind: 'embed',          domain, country, type, tmdbId, title, year }
   *   { kind: 'resolve',        domain, country, type, tmdbId, title, year, season, episode, server }   (a successful resolve)
   *   { kind: 'resolve_error',  domain, country, type, tmdbId, title, year, season, episode, server, reason }  (a failed one)
   *   { kind: 'proxy',          domain }
   *   { kind: 'server_attempt', server, ok, latencyMs, reason }
   * Every shape accepts an optional ISO `at`.
   */
  function record(event) {
    if (!event || typeof event !== 'object') return;
    const at = typeof event.at === 'string' && event.at ? event.at : nowIso();
    const kind = String(event.kind || '');
    state.totals.lastEventAt = at;
    dirty.meta = true;

    if (kind === 'embed') {
      state.totals.embeds += 1;
      const domain = touchDomain(event, at);
      if (domain) domain.embeds += 1;
      touchCountry(event, at);
      const title = touchTitle(event, at);
      if (title) title.requests += 1;
      dayBucket(at).embeds += 1;
      return;
    }

    if (kind === 'resolve') {
      state.totals.resolves += 1;
      const domain = touchDomain(event, at);
      if (domain) domain.resolves += 1;
      touchCountry(event, at);
      const title = touchTitle(event, at);
      if (title) title.requests += 1;
      dayBucket(at).resolves += 1;
      return;
    }

    if (kind === 'resolve_error') {
      // A failed resolve is still a request from that site / country for that
      // title — it just also counts as a failure.
      state.totals.resolveErrors += 1;
      const domain = touchDomain(event, at);
      if (domain) domain.fails += 1;
      touchCountry(event, at);
      const title = touchTitle(event, at);
      if (title) {
        title.requests += 1;
        title.fails += 1;
      }
      dayBucket(at).fails += 1;
      pushError(event, at, title);
      return;
    }

    if (kind === 'proxy') {
      state.totals.proxyHits += 1;
      const domain = touchDomain(event, at);
      if (domain) domain.proxyHits += 1;
      dayBucket(at).proxyHits += 1;
      return;
    }

    if (kind === 'server_attempt') {
      const server = touchServer(event.server, at);
      if (!server) return;
      const latency = Math.max(0, Math.round(Number(event.latencyMs) || 0));
      server.lastLatencyMs = latency;
      if (event.ok) {
        server.ok += 1;
        server.lastOkAt = at;
        server.avgLatencyMs = server.avgLatencyMs ? Math.round(server.avgLatencyMs * 0.7 + latency * 0.3) : latency;
      } else {
        server.fails += 1;
        server.lastError = event.reason ? String(event.reason).slice(0, 200) : 'Upstream returned no stream';
        server.lastErrorAt = at;
      }
    }
  }

  function recordMany(events) {
    if (!Array.isArray(events)) return;
    for (const event of events) record(event);
  }

  function setBlocked(domain, blocked = true) {
    const clean = cleanDomain(domain);
    if (!clean) return false;
    if (blocked) state.blocked.add(clean);
    else state.blocked.delete(clean);
    dirty.blocked = true;
    return true;
  }

  function isBlocked(domain) {
    const clean = cleanDomain(domain);
    return !!clean && state.blocked.has(clean);
  }

  function blockedDomains() {
    return Array.from(state.blocked).sort();
  }

  /** JSON snapshot for the dashboard. `limit` caps every ranked list. */
  function snapshot({ limit = 25 } = {}) {
    const titles = Array.from(state.titles.values());
    const domains = Array.from(state.domains.values());
    const domainRequests = (d) => d.embeds + d.resolves + d.fails;
    const topTitles = titles
      .filter((t) => t.requests > 0)
      .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map((t) => ({ ...t, label: titleLabel(t) }));
    const failingTitles = titles
      .filter((t) => t.fails > 0)
      .sort((a, b) => b.fails - a.fails || b.requests - a.requests || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map((t) => ({ ...t, label: titleLabel(t) }));
    const sites = domains
      .sort((a, b) => domainRequests(b) - domainRequests(a) || b.proxyHits - a.proxyHits || a.domain.localeCompare(b.domain))
      .slice(0, limit)
      .map((d) => ({ ...d, requests: domainRequests(d), blocked: state.blocked.has(d.domain) }));
    const countries = Array.from(state.countries.values())
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
      .slice(0, limit);
    const servers = Array.from(state.servers.values())
      .map((s) => {
        const total = s.ok + s.fails;
        return { ...s, total, successRate: total ? Math.round((s.ok / total) * 100) : null };
      })
      .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
    const days = Array.from(state.days.values())
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-30);
    const requests = state.totals.embeds + state.totals.resolves + state.totals.resolveErrors;
    const attempts = state.totals.resolves + state.totals.resolveErrors;
    return {
      startedAt: state.startedAt,
      generatedAt: nowIso(),
      totals: {
        ...state.totals,
        requests,
        failureRate: attempts ? Math.round((state.totals.resolveErrors / attempts) * 1000) / 10 : 0,
        uniqueDomains: state.domains.size,
        uniqueCountries: state.countries.size,
        uniqueTitles: state.titles.size
      },
      topTitles,
      failingTitles,
      domains: sites,
      countries,
      servers,
      days,
      errors: state.errors.slice(0, limit),
      blockedDomains: blockedDomains()
    };
  }

  /** Rows changed since the previous call (and rows to delete). Clears the dirty set. */
  function drainDirty() {
    const rows = [];
    for (const [dim, keys] of dirty.rows) {
      const map = state[dim];
      if (!map) continue;
      for (const key of keys) {
        const value = map.get(key);
        if (value) rows.push({ dim, key, data: JSON.stringify(value) });
      }
    }
    const batch = {
      rows,
      removed: dirty.removed.splice(0),
      meta: dirty.meta ? JSON.stringify({ startedAt: state.startedAt, totals: state.totals }) : null,
      errors: dirty.errors ? JSON.stringify(state.errors) : null,
      blocked: dirty.blocked ? JSON.stringify(blockedDomains()) : null
    };
    dirty.rows.clear();
    dirty.meta = false;
    dirty.errors = false;
    dirty.blocked = false;
    return batch;
  }

  function hasDirty() {
    return dirty.rows.size > 0 || dirty.removed.length > 0 || dirty.meta || dirty.errors || dirty.blocked;
  }

  /** Rebuild from persisted rows: `{ rows: [{dim,key,data}], meta: [{key,data}] }`. */
  function load({ rows = [], meta = [] } = {}) {
    for (const row of rows) {
      const map = state[row.dim];
      if (!map || typeof map.set !== 'function') continue;
      try {
        map.set(row.key, JSON.parse(row.data));
      } catch {}
    }
    for (const entry of meta) {
      try {
        const data = JSON.parse(entry.data);
        if (entry.key === 'totals' && data && typeof data === 'object') {
          if (data.startedAt) state.startedAt = data.startedAt;
          if (data.totals) state.totals = { ...state.totals, ...data.totals };
        } else if (entry.key === 'errors' && Array.isArray(data)) {
          state.errors = data.slice(0, limits.errors);
        } else if (entry.key === 'blocked' && Array.isArray(data)) {
          state.blocked = new Set(data.map(cleanDomain).filter(Boolean));
        }
      } catch {}
    }
    dirty.rows.clear();
    dirty.removed.length = 0;
    dirty.meta = false;
    dirty.errors = false;
    dirty.blocked = false;
  }

  function reset() {
    state.startedAt = nowIso();
    state.totals = { embeds: 0, resolves: 0, resolveErrors: 0, proxyHits: 0, lastEventAt: null };
    for (const dim of ['titles', 'domains', 'countries', 'servers', 'days']) state[dim].clear();
    state.errors = [];
    dirty.rows.clear();
    dirty.removed.length = 0;
    dirty.meta = true;
    dirty.errors = true;
    // The block-list survives a reset; re-mark it so a store that truncated
    // its tables writes it back on the next flush.
    dirty.blocked = true;
  }

  return {
    record,
    recordMany,
    snapshot,
    drainDirty,
    hasDirty,
    load,
    reset,
    setBlocked,
    isBlocked,
    blockedDomains,
    get startedAt() {
      return state.startedAt;
    }
  };
}

module.exports = {
  LIMITS,
  createStatsAggregate,
  cleanDomain,
  cleanCountry,
  titleKey
};
