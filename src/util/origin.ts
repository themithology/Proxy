import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

/**
 * The public origin this request should build absolute URLs against.
 *
 * `PUBLIC_URL` is the explicit answer and always wins when set. When it is
 * left empty we derive the origin from the request itself
 * (`X-Forwarded-Proto` / `X-Forwarded-Host` when `TRUST_PROXY`, else `Host`).
 *
 * That means a deployment behind an arbitrary reverse proxy — or a preview
 * environment with a generated hostname — produces correct manifest URLs
 * without any configuration.
 */

const storage = new AsyncLocalStorage<string>();

/** Bind the derived origin to the rest of this request's async context. */
export function enterOrigin(origin: string): void {
  storage.enterWith(origin);
}

/** The origin to use right now; falls back to the configured `PUBLIC_URL`. */
export function currentOrigin(): string {
  return storage.getStore() ?? config.publicOrigin;
}

/**
 * Best-effort origin for a request.
 * Uses forwarded headers only when TRUST_PROXY is enabled.
 */
export function originFromRequest(headers: Record<string, string | string[] | undefined>): string | null {
  const first = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const host = config.TRUST_PROXY
    ? (first(headers['x-forwarded-host']) ?? first(headers.host))
    : first(headers.host);

  if (!host) return null;

  const proto = config.TRUST_PROXY
    ? (first(headers['x-forwarded-proto'])?.split(',')[0]?.trim() ?? 'http')
    : 'http';

  return `${proto}://${host}`.replace(/\/+$/, '');
}
