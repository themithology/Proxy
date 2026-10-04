const config = require('../config');

class TelemetryAndAdminEngine {
  constructor() {
    this.startedAt = new Date().toISOString();
    // Map<domain, { domain, embeds, resolves, proxyHits, firstSeen, lastSeen, topTitles: Map, userAgents: Set }>
    this.domains = new Map();
    this.blockedDomains = new Set(
      (process.env.BLOCKED_DOMAINS || '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    );

    // Per-server health & staleness stats
    this.serverMetrics = new Map();
    for (const srv of config.servers) {
      this.serverMetrics.set(srv.id, {
        id: srv.id,
        name: srv.name,
        badge: srv.badge,
        enabled: srv.enabled !== false,
        priority: srv.priority,
        status: 'online',
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastLatencyMs: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null
      });
    }

    // Custom stream overrides: Map<"type:tmdbId:s:e", { type, tmdbId, season, episode, streamUrl, format, label, updatedAt }>
    this.customOverrides = new Map();
  }

  /**
   * Extract normalized hostname from a URL or Referer/Origin/parent parameter
   */
  extractDomain(req) {
    const candidates = [
      req.query?.parent,
      req.query?.domain,
      req.query?.embed_domain,
      req.headers?.['x-embed-domain'],
      req.headers?.origin,
      req.headers?.referer
    ].filter(Boolean);

    const selfHost = (req.headers?.host || '').split(':')[0].toLowerCase();

    for (const raw of candidates) {
      try {
        const cleaned = String(raw).trim();
        const hostname = cleaned.includes('://')
          ? new URL(cleaned).hostname.toLowerCase()
          : cleaned.split('/')[0].split(':')[0].toLowerCase();

        if (!hostname) continue;
        // If the referer is our own embed page, check if there's a parent param first; otherwise classify as direct/self
        if (hostname === selfHost && candidates.length > 1) continue;
        return hostname;
      } catch {
        // ignore malformed referer
      }
    }
    return selfHost || 'direct-access';
  }

  isDomainBlocked(domain) {
    if (!domain) return false;
    const clean = String(domain).toLowerCase().replace(/^www\./, '');
    return this.blockedDomains.has(clean) || this.blockedDomains.has(String(domain).toLowerCase());
  }

  setDomainBlocked(domain, blocked = true) {
    const clean = String(domain).trim().toLowerCase().replace(/^www\./, '');
    if (!clean) return;
    if (blocked) {
      this.blockedDomains.add(clean);
    } else {
      this.blockedDomains.delete(clean);
    }
  }

  /**
   * Record an embed load, stream resolve, or proxy hit for a domain
   */
  recordDomainActivity(req, eventType = 'embed', mediaInfo = null) {
    const domain = this.extractDomain(req);
    const now = new Date().toISOString();

    let entry = this.domains.get(domain);
    if (!entry) {
      entry = {
        domain,
        embeds: 0,
        resolves: 0,
        proxyHits: 0,
        firstSeen: now,
        lastSeen: now,
        topTitles: new Map()
      };
      this.domains.set(domain, entry);
    }

    entry.lastSeen = now;
    if (eventType === 'embed') entry.embeds += 1;
    else if (eventType === 'resolve') entry.resolves += 1;
    else if (eventType === 'proxy') entry.proxyHits += 1;

    if (mediaInfo && (mediaInfo.title || mediaInfo.tmdbId)) {
      const label = mediaInfo.title
        ? `${mediaInfo.title} (#${mediaInfo.tmdbId})`
        : `TMDB #${mediaInfo.tmdbId}`;
      entry.topTitles.set(label, (entry.topTitles.get(label) || 0) + 1);
    }
  }

  /**
   * Record upstream server resolution attempt (success or failure + latency)
   */
  recordServerAttempt(serverId, success, latencyMs = 0, errorMsg = null) {
    const metric = this.serverMetrics.get(serverId);
    if (!metric) return;

    const now = new Date().toISOString();
    metric.lastLatencyMs = Math.round(latencyMs);

    if (success) {
      metric.successCount += 1;
      metric.lastSuccessAt = now;
      metric.lastError = null;
      metric.avgLatencyMs =
        metric.avgLatencyMs === 0
          ? Math.round(latencyMs)
          : Math.round(metric.avgLatencyMs * 0.7 + latencyMs * 0.3);
      metric.status = 'online';
    } else {
      metric.failureCount += 1;
      metric.lastFailureAt = now;
      metric.lastError = errorMsg || 'Upstream returned no stream';
      const total = metric.successCount + metric.failureCount;
      const failRatio = metric.failureCount / total;
      if (metric.failureCount >= 3 && failRatio >= 0.75) {
        metric.status = 'dead';
      } else if (metric.failureCount >= 1) {
        metric.status = 'degraded';
      }
    }
  }

  /**
   * Manage custom TMDB stream overrides
   */
  setCustomOverride({ type = 'movie', tmdbId, season = 1, episode = 1, streamUrl, format = 'hls', label = 'Admin Custom Source' }) {
    const normType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
    const key = normType === 'tv' ? `tv:${tmdbId}:${season}:${episode}` : `movie:${tmdbId}:1:1`;
    const entry = {
      key,
      type: normType,
      tmdbId: String(tmdbId),
      season: Number(season || 1),
      episode: Number(episode || 1),
      streamUrl: String(streamUrl).trim(),
      format: streamUrl.includes('.mp4') ? 'mp4' : format,
      label,
      updatedAt: new Date().toISOString()
    };
    this.customOverrides.set(key, entry);
    return entry;
  }

  removeCustomOverride(key) {
    return this.customOverrides.delete(key);
  }

  getCustomOverride(type, tmdbId, season = 1, episode = 1) {
    const normType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
    const key = normType === 'tv' ? `tv:${tmdbId}:${season}:${episode}` : `movie:${tmdbId}:1:1`;
    return this.customOverrides.get(key) || null;
  }

  /**
   * Hot-swap upstream URLs, AES key, proxy pool, and server enabled/priority settings at runtime
   */
  updateUpstreamsAndServers(payload = {}) {
    if (payload.upstreams && typeof payload.upstreams === 'object') {
      for (const [k, v] of Object.entries(payload.upstreams)) {
        if (typeof v === 'string' && v.trim() && k in config.upstreams) {
          config.upstreams[k] = v.trim().replace(/\/$/, '');
        }
      }
    }

    if (typeof payload.tmdbApiKey === 'string' && payload.tmdbApiKey.trim()) {
      config.tmdbApiKey = payload.tmdbApiKey.trim();
    }

    if (typeof payload.wyzieApiKey === 'string') {
      config.wyzieApiKey = payload.wyzieApiKey.trim();
    }

    if (Array.isArray(payload.externalProxyPool)) {
      config.externalProxyPool = payload.externalProxyPool
        .map((u) => String(u).trim().replace(/\/$/, ''))
        .filter(Boolean);
    } else if (typeof payload.externalProxyPool === 'string') {
      config.externalProxyPool = payload.externalProxyPool
        .split(',')
        .map((u) => u.trim().replace(/\/$/, ''))
        .filter(Boolean);
    }

    if (Array.isArray(payload.servers)) {
      for (const srvUpdate of payload.servers) {
        const target = config.servers.find((s) => s.id === srvUpdate.id);
        const metric = this.serverMetrics.get(srvUpdate.id);
        if (target) {
          if (typeof srvUpdate.enabled === 'boolean') target.enabled = srvUpdate.enabled;
          if (typeof srvUpdate.priority === 'number') target.priority = srvUpdate.priority;
          if (typeof srvUpdate.name === 'string' && srvUpdate.name.trim()) {
            target.name = srvUpdate.name.trim();
          }
        }
        if (metric) {
          if (typeof srvUpdate.enabled === 'boolean') metric.enabled = srvUpdate.enabled;
          if (typeof srvUpdate.priority === 'number') metric.priority = srvUpdate.priority;
        }
      }
      config.servers.sort((a, b) => (a.priority || 99) - (b.priority || 99));
    }
  }

  /**
   * Run active diagnostic probes against all upstream endpoints
   */
  async runLiveHealthProbes() {
    const targets = [
      {
        serverId: 'andromeda',
        name: 'CastleTV Multi-Audio API',
        url: `${config.upstreams.castletvBase}/v0.1/system/getSecurityKey/1`
      },
      {
        serverId: 'centaurus',
        name: 'HiCine Direct API',
        url: `${config.upstreams.hicineApiBase}/api/search/arcane`
      }
    ];

    const results = [];
    for (const t of targets) {
      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6500);
      try {
        const res = await fetch(t.url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            ...(t.headers || {})
          },
          signal: controller.signal
        });
        const latencyMs = Date.now() - t0;
        const ok = res.status >= 200 && res.status < 400;
        this.recordServerAttempt(
          t.serverId,
          ok,
          latencyMs,
          ok ? null : `HTTP ${res.status} from ${t.url}`
        );
        results.push({
          serverId: t.serverId,
          name: t.name,
          url: t.url,
          ok,
          httpStatus: res.status,
          latencyMs
        });
      } catch (err) {
        const latencyMs = Date.now() - t0;
        this.recordServerAttempt(t.serverId, false, latencyMs, err.message);
        results.push({
          serverId: t.serverId,
          name: t.name,
          url: t.url,
          ok: false,
          httpStatus: 0,
          latencyMs,
          error: err.message
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  /**
   * Build the JSON snapshot returned by /api/admin/overview
   */
  getDashboardSnapshot() {
    const domainList = Array.from(this.domains.values())
      .map((d) => {
        const topTitles = Array.from(d.topTitles.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([title, count]) => ({ title, count }));
        return {
          domain: d.domain,
          embeds: d.embeds,
          resolves: d.resolves,
          proxyHits: d.proxyHits,
          totalRequests: d.embeds + d.resolves + d.proxyHits,
          firstSeen: d.firstSeen,
          lastSeen: d.lastSeen,
          blocked: this.isDomainBlocked(d.domain),
          topTitles
        };
      })
      .sort((a, b) => b.totalRequests - a.totalRequests);

    const servers = config.servers.map((srv) => {
      const m = this.serverMetrics.get(srv.id) || {};
      const total = (m.successCount || 0) + (m.failureCount || 0);
      const successRate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 100;
      return {
        ...srv,
        enabled: srv.enabled !== false,
        status: srv.enabled === false ? 'disabled' : m.status || 'online',
        successCount: m.successCount || 0,
        failureCount: m.failureCount || 0,
        successRate,
        avgLatencyMs: m.avgLatencyMs || 0,
        lastLatencyMs: m.lastLatencyMs || 0,
        lastSuccessAt: m.lastSuccessAt || null,
        lastFailureAt: m.lastFailureAt || null,
        lastError: m.lastError || null
      };
    });

    const totalEmbeds = domainList.reduce((acc, d) => acc + d.embeds, 0);
    const totalResolves = domainList.reduce((acc, d) => acc + d.resolves, 0);
    const totalProxyHits = domainList.reduce((acc, d) => acc + d.proxyHits, 0);

    return {
      startedAt: this.startedAt,
      summary: {
        uniqueDomains: domainList.length,
        blockedDomainsCount: this.blockedDomains.size,
        totalEmbeds,
        totalResolves,
        totalProxyHits,
        activeServersCount: servers.filter((s) => s.enabled && s.status !== 'dead').length,
        deadOrDegradedCount: servers.filter((s) => s.status === 'dead' || s.status === 'degraded').length
      },
      domains: domainList,
      blockedDomains: Array.from(this.blockedDomains),
      servers,
      upstreams: { ...config.upstreams },
      externalProxyPool: [...config.externalProxyPool],
      customOverrides: Array.from(this.customOverrides.values())
    };
  }
}

const telemetry = new TelemetryAndAdminEngine();

module.exports = {
  telemetry
};
