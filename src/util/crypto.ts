import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto';
import { config } from '../config.js';

/**
 * Signed tokens let us hand a client a proxy URL that carries the real upstream
 * URL plus the per-request headers it needs (Referer / Origin / Cookie) without
 * exposing those details or letting a client use our server as an open proxy.
 *
 * The payload is base64url-encoded JSON; the signature is HMAC-SHA256 over it.
 */

export interface ProxyTokenPayload {
  /** Upstream URL to fetch. */
  u: string;
  /** Extra request headers to send upstream. */
  h?: Record<string, string>;
  /** Expiry, epoch ms. */
  e: number;
  /** Media kind, used to pick content-type when upstream is lying. */
  k?: 'manifest' | 'segment' | 'subtitle' | 'key' | 'other';
}

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

function sign(data: string): string {
  return createHmac('sha256', config.PROXY_SECRET).update(data).digest('base64url');
}

export function signToken(payload: ProxyTokenPayload): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body)}`;
}

/** Verify + decode. Returns null on any tamper/expiry failure. */
export function verifyToken(token: string): ProxyTokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(unb64u(body).toString('utf8')) as ProxyTokenPayload;
    if (typeof payload.u !== 'string' || typeof payload.e !== 'number') return null;
    if (Date.now() > payload.e) return null;
    if (payload.h && typeof payload.h !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

/** Stable hash used for cache keys and stream de-duplication. */
export function stableHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url').slice(0, 32);
}

export const newId = (): string => randomUUID();
