import { fetch, Agent, ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config.js';
import { logFor } from '../logger.js';

const log = logFor('http');

/** Long-lived agents: connection reuse matters a lot when proxying segments. */
export const directAgent = new Agent({
  connections: 64,
  keepAliveTimeout: 15_000,
  keepAliveMaxTimeout: 30_000,
  connect: { timeout: 10_000 },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
});

let proxyAgent: ProxyAgent | null = null;
if (config.EGRESS_PROXY) {
  proxyAgent = new ProxyAgent({
    uri: config.EGRESS_PROXY,
    connect: { timeout: 10_000 },
  });
  log.info({ proxy: config.EGRESS_PROXY.split('@').pop() }, 'egress proxy enabled');
}

const dispatcher: Dispatcher = proxyAgent ?? directAgent;

/** The dispatcher that respects EGRESS_PROXY (used by the segment proxy too). */
export const getDispatcher = (): Dispatcher => dispatcher;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout in ms. */
  timeout?: number;
  /** Retry count for transient failures. */
  retries?: number;
  /** Follow redirects (default true). */
  follow?: number;
  /** Return raw response instead of consuming body. */
  raw?: boolean;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryableErr(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_SOCKET' ||
    (err as Error)?.name === 'AbortError' === false && code === 'EPIPE'
  );
}

/** Default headers applied to every upstream request unless overridden. */
export function defaultHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': config.UPSTREAM_USER_AGENT,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    ...extra,
  };
  if (config.UPSTREAM_REFERER && !h.referer && !h.Referer) {
    h.referer = config.UPSTREAM_REFERER;
  }
  return h;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  url: string;
  /** Body buffer — empty when `raw` was requested. */
  body: Buffer;
  text: () => string;
  json: <T = unknown>() => T;
}

/**
 * Fetch upstream with timeouts, bounded retries and connection reuse.
 * Throws on non-2xx (except when `raw`).
 */
export async function request(
  url: string,
  opts: RequestOptions = {},
): Promise<HttpResponse> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = config.PROVIDER_TIMEOUT,
    retries = 2,
    follow = 5,
    signal,
  } = opts;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const onOuterAbort = () => ac.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await fetch(url, {
        method,
        headers: defaultHeaders(headers),
        body,
        redirect: follow > 0 ? 'follow' : 'manual',
        dispatcher,
        signal: ac.signal,
      });

      if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());

      if (!res.ok) {
        throw Object.assign(
          new Error(`Upstream ${res.status} for ${safeUrl(url)}`),
          { status: res.status },
        );
      }

      return {
        status: res.status,
        headers: res.headers,
        url: res.url || url,
        body: buf,
        text: () => buf.toString('utf8'),
        json: <T = unknown>() => JSON.parse(buf.toString('utf8')) as T,
      };
    } catch (err) {
      lastErr = err;
      const aborted = (err as Error)?.name === 'AbortError';
      const transient = aborted || isRetryableErr(err);
      if (!transient || attempt === retries) break;
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  const aborted = (lastErr as Error)?.name === 'AbortError';
  if (aborted) {
    throw Object.assign(new Error(`Upstream timeout after ${timeout}ms: ${safeUrl(url)}`), {
      status: 504,
    });
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Convenience: fetch text. */
export async function fetchText(url: string, opts: RequestOptions = {}): Promise<string> {
  const r = await request(url, opts);
  return r.text();
}

/** Convenience: fetch JSON. */
export async function fetchJson<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const r = await request(url, opts);
  return r.json<T>();
}

/** Strip query string so we never log signed URLs. */
export function safeUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 2000);
