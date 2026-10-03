import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { logFor } from '../logger.js';
import { verifyToken, type ProxyTokenPayload } from '../util/crypto.js';
import { cache } from '../store/cache.js';
import { stableHash } from '../util/crypto.js';
import { AppError } from '../util/errors.js';
import {
  fetchManifest,
  fetchSubtitle,
  fetchUpstream,
  proxyUrl,
  sniffKind,
} from '../stream/proxy.js';

const log = logFor('route:proxy');

/** Small resources worth buffering and caching (keys, init segments, subs). */
const CACHEABLE_MAX_BYTES = 512 * 1024;

function readToken(req: FastifyRequest): ProxyTokenPayload {
  const q = req.query as Record<string, string | undefined>;
  const token =
    q.token ??
    (req.params as { token?: string })?.token ??
    (req.headers['x-proxy-token'] as string | undefined);

  if (!token) throw AppError.unauthorized('Missing proxy token');

  const payload = verifyToken(token);
  if (!payload) throw AppError.unauthorized('Invalid or expired proxy token');
  return payload;
}

/**
 * DASH SegmentTemplate placeholders.
 *
 * The rewritten template keeps `$Number$` etc. visible in our query string so
 * the player can substitute them; we re-inject the values here before calling
 * upstream.
 */
function applyTemplateParams(url: string, query: Record<string, string | undefined>): string {
  if (!url.includes('$')) return url;

  let out = url;
  if (query._n !== undefined) out = out.replace(/\$Number\$/g, query._n);
  if (query._t !== undefined) out = out.replace(/\$Time\$/g, query._t);
  if (query._b !== undefined) out = out.replace(/\$Bandwidth\$/g, query._b);
  if (query._r !== undefined) out = out.replace(/\$RepresentationID\$/g, query._r);

  // Any unresolved placeholder means the player sent us something incomplete.
  if (/\$(Number|Time|Bandwidth|RepresentationID)\$/.test(out)) {
    throw AppError.badRequest('Unresolved DASH template placeholder');
  }
  return out;
}

function cors(reply: FastifyReply): void {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'range, content-type, x-api-key');
  reply.header('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  reply.header('access-control-expose-headers', 'content-length, content-range, etag');
  reply.header('cross-origin-resource-policy', 'cross-origin');
}

function cacheControl(reply: FastifyReply, seconds: number): void {
  reply.header('cache-control', `public, max-age=${seconds}, s-maxage=${seconds}`);
}

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  // Preflight
  app.options('/proxy/*', async (_req, reply) => {
    cors(reply);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // /proxy/manifest — HLS or DASH, rewritten
  // -------------------------------------------------------------------------
  app.get('/proxy/manifest', async (req, reply) => {
    const payload = readToken(req);
    const url = applyTemplateParams(payload.u, req.query as Record<string, string>);

    const result = await fetchManifest(url, payload.h ?? {});

    cors(reply);
    reply.header('content-type', `${result.contentType}; charset=utf-8`);
    // Manifests must be revalidated often; the server caches upstream anyway.
    cacheControl(reply, 30);
    if (result.info) reply.header('x-proxy-info', JSON.stringify(result.info));

    return reply.send(result.body);
  });

  // -------------------------------------------------------------------------
  // /proxy/segment — media segments, AES keys, init segments (Range aware)
  // -------------------------------------------------------------------------
  app.get('/proxy/segment', async (req, reply) => {
    const payload = readToken(req);
    const query = req.query as Record<string, string | undefined>;
    const url = applyTemplateParams(payload.u, query);
    const headers = payload.h ?? {};
    const range = req.headers.range as string | undefined;

    cors(reply);
    reply.header('accept-ranges', 'bytes');

    // Range requests (seeking) are always streamed — never cached.
    if (range) {
      const up = await fetchUpstream(url, headers, range);
      reply.code(up.status);
      for (const [k, v] of Object.entries(up.headers)) reply.header(k, v);
      cacheControl(reply, 300);
      return reply.send(up.stream);
    }

    // Otherwise: serve from cache when possible.
    const key = `seg:v1:${stableHash(url)}`;
    const cached = await cache.get<{ body: string; headers: Record<string, string> }>(key);

    if (cached) {
      for (const [k, v] of Object.entries(cached.headers)) reply.header(k, v);
      cacheControl(reply, config.CACHE_TTL_PROXY);
      reply.header('x-proxy-cache', 'HIT');
      return reply.send(Buffer.from(cached.body, 'base64'));
    }

    const up = await fetchUpstream(url, headers);

    const declaredLength = Number(up.headers['content-length'] ?? 0);
    const cacheable =
      config.CACHE_TTL_PROXY > 0 &&
      (declaredLength > 0 ? declaredLength <= CACHEABLE_MAX_BYTES : true);

    if (!cacheable) {
      reply.code(up.status);
      for (const [k, v] of Object.entries(up.headers)) reply.header(k, v);
      cacheControl(reply, 300);
      return reply.send(up.stream);
    }

    // Buffer small resources so we can cache them (keys + init segments are
    // requested on every playback and are tiny).
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of up.stream) {
      const b = chunk as Buffer;
      total += b.length;
      if (config.MAX_SEGMENT_BYTES > 0 && total > config.MAX_SEGMENT_BYTES) {
        up.stream.destroy();
        throw AppError.badRequest('Upstream resource exceeds MAX_SEGMENT_BYTES');
      }
      chunks.push(b);
    }

    const body = Buffer.concat(chunks);

    reply.code(up.status);
    for (const [k, v] of Object.entries(up.headers)) reply.header(k, v);
    reply.header('content-length', String(body.length));
    cacheControl(reply, config.CACHE_TTL_PROXY);
    reply.header('x-proxy-cache', 'MISS');

    if (body.length <= CACHEABLE_MAX_BYTES && up.status < 400) {
      await cache.set(
        key,
        { body: body.toString('base64'), headers: up.headers },
        config.CACHE_TTL_PROXY,
      );
    }

    return reply.send(body);
  });

  // -------------------------------------------------------------------------
  // /proxy/subtitle — converted to WebVTT
  // -------------------------------------------------------------------------
  app.get('/proxy/subtitle', async (req, reply) => {
    const payload = readToken(req);
    const url = payload.u;

    const key = `sub:v1:${stableHash(url)}`;
    const cached = await cache.get<string>(key);

    let body = cached;
    if (body === null || body === undefined) {
      const res = await fetchSubtitle(url, payload.h ?? {});
      body = res.body;
      await cache.set(key, body, config.CACHE_TTL_PROXY);
    }

    cors(reply);
    reply.header('content-type', 'text/vtt; charset=utf-8');
    cacheControl(reply, config.CACHE_TTL_PROXY);
    return reply.send(body);
  });

  // -------------------------------------------------------------------------
  // /proxy/media — anything else: sniff, then dispatch
  // -------------------------------------------------------------------------
  app.get('/proxy/media', async (req, reply) => {
    const payload = readToken(req);
    const url = applyTemplateParams(payload.u, req.query as Record<string, string>);
    const headers = payload.h ?? {};

    cors(reply);

    const sniffed = await sniffKind(url, headers);
    if (sniffed.kind === 'hls' || sniffed.kind === 'dash') {
      const result = await fetchManifest(url, headers);
      reply.header('content-type', `${result.contentType}; charset=utf-8`);
      cacheControl(reply, 30);
      return reply.send(result.body);
    }

    const range = req.headers.range as string | undefined;
    const up = await fetchUpstream(url, headers, range);

    reply.code(up.status);
    for (const [k, v] of Object.entries(up.headers)) reply.header(k, v);
    reply.header('accept-ranges', 'bytes');
    cacheControl(reply, 300);
    return reply.send(up.stream);
  });

  // -------------------------------------------------------------------------
  // /proxy/sign — mint a proxy URL without doing a lookup (for advanced clients)
  // -------------------------------------------------------------------------
  app.post('/proxy/sign', async (req, reply) => {
    const body = (req.body ?? {}) as {
      url?: string;
      headers?: Record<string, string>;
      kind?: ProxyTokenPayload['k'];
      ttlSeconds?: number;
    };

    if (!body.url || !/^(https?:|magnet:)/i.test(body.url)) {
      throw AppError.badRequest('Body must include { url } (http/https/magnet)');
    }

    const ttlMs = Math.min(
      Math.max(Number(body.ttlSeconds ?? 21_600), 60),
      7 * 24 * 3600,
    ) * 1000;

    return reply.send({
      ok: true,
      url: proxyUrl(body.url, body.headers ?? {}, body.kind ?? 'other', ttlMs),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
  });

  app.get('/proxy/ping', async (_req, reply) => {
    return reply.send({ ok: true, service: 'proxy', ts: Date.now() });
  });
}
