import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger, logFor } from '../logger.js';
import { AppError, toAppError } from '../util/errors.js';
import { registerAuth } from './auth.js';
import { enterOrigin, originFromRequest } from '../util/origin.js';
import { healthRoutes } from '../routes/health.js';
import { metaRoutes } from '../routes/meta.js';
import { streamRoutes } from '../routes/streams.js';
import { proxyRoutes } from '../routes/proxy.js';
import { openapiRoutes } from './openapi.js';

const log = logFor('server');
const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..', '..');
const publicDir = join(rootDir, 'public');

export async function buildServer(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: config.TRUST_PROXY,
    // Manifests and segments are large; keep the ceiling generous.
    bodyLimit: 2 * 1024 * 1024,
    keepAliveTimeout: 30_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });

  // --- error shape ---------------------------------------------------------
  app.setErrorHandler(async (err, req, reply) => {
    const appErr = err instanceof AppError ? err : toAppError(err);

    // Fastify schema/validation errors surface as 400 with useful details.
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({
        ok: false,
        error: 'Validation failed',
        code: 'bad_request',
        details: (err as { validation: unknown }).validation,
      });
    }

    if (appErr.statusCode >= 500) {
      log.error(
        { err: appErr.message, path: req.url, method: req.method },
        'request failed',
      );
    }

    return reply.code(appErr.statusCode).send({
      ok: false,
      error: appErr.message,
      code: appErr.code,
      ...(appErr.details ? { details: appErr.details } : {}),
    });
  });

  app.setNotFoundHandler(async (req, reply) => {
    // Let the SPA handle client-side routes, but keep /api 404s as JSON.
    if (req.url.startsWith('/api') || req.url.startsWith('/proxy')) {
      return reply.code(404).send({
        ok: false,
        error: `No route for ${req.method} ${req.url.split('?')[0]}`,
        code: 'not_found',
      });
    }
    // Client-side routes (/title/…, /watch/…) are served the app shell with a
    // 200 — a 404 here makes browsers and some proxies refuse to render it.
    return reply.code(200).sendFile('index.html');
  });

  // --- plugins -------------------------------------------------------------
  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['content-type', 'x-api-key', 'authorization', 'range'],
    exposedHeaders: ['content-length', 'content-range'],
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Proxy endpoints carry the real traffic; keep their own generous budget.
    keyGenerator: (req) => {
      const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0];
      return fwd?.trim() || req.ip || 'unknown';
    },
    errorResponseBuilder: () => ({
      ok: false,
      error: 'Rate limit exceeded',
      code: 'rate_limited',
    }),
  });

  // Player engines are served locally (no CDN dependency, works offline).
  const vendor: Record<string, string> = {
    '/vendor/hls.min.js': join(rootDir, 'node_modules/hls.js/dist/hls.min.js'),
    '/vendor/dash.min.js': join(
      rootDir,
      'node_modules/dashjs/dist/modern/umd/dash.mediaplayer.min.js',
    ),
  };

  for (const [route, file] of Object.entries(vendor)) {
    if (!existsSync(file)) {
      log.warn({ route, file }, 'vendor bundle missing');
      continue;
    }
    app.get(route, async (_req, reply) => {
      reply.header('content-type', 'application/javascript; charset=utf-8');
      reply.header('cache-control', 'public, max-age=86400');
      return reply.send(await readFile(file));
    });
  }

  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      serve: true,
      wildcard: false,
      setHeaders: (res: { setHeader: (k: string, v: string) => void }, path: string) => {
        if (path.endsWith('.html')) {
          res.setHeader('cache-control', 'no-cache');
        }
      },
    });
  } else {
    log.warn({ publicDir }, 'public directory missing — serving API only');
  }

  // Derive the public origin per request when PUBLIC_URL is not configured.
  app.addHook('onRequest', async (req: { headers: Record<string, string | string[] | undefined> }) => {
    if (!config.PUBLIC_URL) {
      const origin = originFromRequest(req.headers);
      if (origin) enterOrigin(origin);
    }
  });

  // --- auth ----------------------------------------------------------------
  registerAuth(app);

  // --- routes --------------------------------------------------------------
  await app.register(openapiRoutes);
  await app.register(healthRoutes);
  await app.register(metaRoutes);
  await app.register(streamRoutes);
  await app.register(proxyRoutes);

  if (config.hasApiKey) {
    log.info('API key authentication is ENABLED');
  } else {
    log.warn('API key authentication is DISABLED (set API_KEY to enable)');
  }

  return app as unknown as FastifyInstance;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      await app.close();
      const { registry } = await import('../providers/registry.js');
      await registry.shutdown();
      const { cache } = await import('../store/cache.js');
      await cache.close();
      process.exit(0);
    } catch (err) {
      log.error({ err: String(err) }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => void shutdown(sig));
  }

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    log.info(
      {
        url: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`,
        publicOrigin: config.publicOrigin,
      },
      'Proxy API listening',
    );
    return app as unknown as FastifyInstance;
  } catch (err) {
    log.error({ err: String(err) }, 'failed to start server');
    throw err;
  }
}
