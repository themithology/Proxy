import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { AppError } from '../util/errors.js';

/** Paths that stay open even when an API key is configured. */
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/docs',
  '/openapi.json',
  '/',
  '/watch/',
  '/embed/',
  '/assets/',
  // Static player engines (hls.js / dash.js) — assets, not data.
  '/vendor/',
];

function isPublic(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true;
  return PUBLIC_PREFIXES.some(
    (p) => p !== '/' && (pathname === p.slice(0, -1) || pathname.startsWith(p)),
  );
}

function extractKey(req: FastifyRequest): string | null {
  const h = req.headers;

  const direct = h['x-api-key'];
  if (typeof direct === 'string' && direct) return direct;

  const auth = h.authorization;
  if (typeof auth === 'string' && auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
    if (!auth.toLowerCase().startsWith('bearer')) return auth.trim();
  }

  // Browser convenience: ?api_key=… (documented, opt-in).
  const q = req.query as Record<string, unknown>;
  const qk = q?.api_key ?? q?.apiKey;
  if (typeof qk === 'string' && qk) return qk;

  return null;
}

/**
 * Optional API-key gate.
 *
 * Everything under /api and /proxy requires the key when API_KEY is set.
 * The static player pages stay public so the UI can load, and the UI sends
 * the key on its XHR calls.
 */
export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.hasApiKey) return;

    const path = req.url.split('?')[0] ?? '';
    if (req.method === 'OPTIONS') return;
    if (isPublic(path)) return;

    const key = extractKey(req);
    if (!key || key !== config.API_KEY) {
      throw AppError.unauthorized(
        'Missing or invalid API key. Send it as `x-api-key`, `Authorization: Bearer <key>` or `?api_key=`.',
      );
    }
  });
}
