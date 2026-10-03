const config = require('../config');

class CacheEngine {
  constructor() {
    this.store = new Map();
    this.maxEntries = 2000;
  }

  async get(key) {
    const local = this.store.get(key);
    if (local) {
      if (Date.now() < local.expiresAt) {
        return local.value;
      }
      this.store.delete(key);
    }

    if (config.upstashRedisUrl && config.upstashRedisToken) {
      try {
        const res = await fetch(`${config.upstashRedisUrl}/get/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
          signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.result) {
            const parsed = JSON.parse(data.result);
            this.store.set(key, { value: parsed, expiresAt: Date.now() + 300000 });
            return parsed;
          }
        }
      } catch {
        // Fallback silently to local memory cache
      }
    }

    return null;
  }

  async set(key, value, ttlSeconds = 1800) {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000
    });

    if (config.upstashRedisUrl && config.upstashRedisToken) {
      try {
        await fetch(
          `${config.upstashRedisUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttlSeconds}`,
          {
            headers: { Authorization: `Bearer ${config.upstashRedisToken}` },
            signal: AbortSignal.timeout(1500)
          }
        );
      } catch {
        // Non-fatal
      }
    }
  }
}

class CircuitBreaker {
  constructor() {
    this.providers = new Map();
    this.failureThreshold = 4;
    this.cooldownMs = 60 * 1000;
  }

  isAvailable(providerKey) {
    const state = this.providers.get(providerKey);
    if (!state) return true;
    if (state.failures < this.failureThreshold) return true;
    if (Date.now() - state.lastFailureAt > this.cooldownMs) {
      state.failures = 0;
      return true;
    }
    return false;
  }

  recordSuccess(providerKey) {
    this.providers.set(providerKey, {
      failures: 0,
      lastSuccessAt: Date.now(),
      status: 'online'
    });
  }

  recordFailure(providerKey) {
    const prev = this.providers.get(providerKey) || { failures: 0 };
    const failures = prev.failures + 1;
    this.providers.set(providerKey, {
      ...prev,
      failures,
      lastFailureAt: Date.now(),
      status: failures >= this.failureThreshold ? 'cooldown' : 'degraded'
    });
  }

  status() {
    const out = {};
    for (const [k, v] of this.providers.entries()) {
      out[k] = v;
    }
    return out;
  }
}

const cache = new CacheEngine();
const circuitBreaker = new CircuitBreaker();

module.exports = {
  cache,
  circuitBreaker
};
