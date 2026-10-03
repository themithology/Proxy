import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { cache } from '../store/cache.js';
import { registry } from '../providers/registry.js';
import { tmdb } from '../metadata/tmdb.js';

const startedAt = Date.now();
const VERSION = '1.0.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    const providers = registry.list();
    const ready = providers.filter((p) => p.ready).length;

    return reply.send({
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      environment: config.isProd ? 'production' : 'development',
      features: {
        auth: config.hasApiKey,
        tmdb: tmdb.enabled,
        egressProxy: !!config.EGRESS_PROXY,
        cache: cache.driverName,
      },
      providers: {
        total: providers.length,
        enabled: providers.filter((p) => p.enabled).length,
        ready,
      },
      cache: cache.stats(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/providers', async (_req, reply) => {
    return reply.send({
      ok: true,
      count: registry.list().length,
      providers: registry.list(),
      health: registry.health(),
    });
  });

  app.get('/api/providers/:id/health', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = registry.get(id);
    if (!p) {
      return reply.code(404).send({ ok: false, error: `Unknown provider "${id}"` });
    }

    const started = Date.now();
    try {
      await p.ping();
      return reply.send({
        ok: true,
        id,
        healthy: true,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        id,
        healthy: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/api/providers/reload', async (_req, reply) => {
    await registry.load();
    return reply.send({
      ok: true,
      reloaded: true,
      providers: registry.list().length,
    });
  });

  app.patch('/api/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };

    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'Body must be { enabled: boolean }' });
    }
    if (!registry.setEnabled(id, body.enabled)) {
      return reply.code(404).send({ ok: false, error: `Unknown provider "${id}"` });
    }

    await registry.load();
    return reply.send({ ok: true, id, enabled: body.enabled });
  });

  app.post('/api/cache/clear', async (_req, reply) => {
    await cache.clear();
    return reply.send({ ok: true, cleared: true });
  });
}
