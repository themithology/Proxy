/**
 * URL helpers. Proxy URLs are security-sensitive: everything that ends up in a
 * rewritten manifest must be escaped exactly once and never double-encoded.
 */

/** Resolve a possibly-relative URI against a base, tolerating junk input. */
export function resolveUrl(base: string, ref: string): string {
  if (!ref) return base;
  const r = ref.trim();
  // Protocol-relative
  if (r.startsWith('//')) {
    try {
      return new URL(r, base).toString();
    } catch {
      return r;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r)) return r; // already absolute
  try {
    return new URL(r, base).toString();
  } catch {
    return r;
  }
}

export function isAbsoluteUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** Percent-encode a string for safe use inside a single query-string value. */
export function encodeQs(v: string): string {
  return encodeURIComponent(v);
}

/** Build a query string, skipping null/undefined/empty values. */
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Extract a file extension (lower-cased, no dot) from a URL path. */
export function extOf(u: string): string {
  try {
    const p = new URL(u).pathname;
    const i = p.lastIndexOf('.');
    return i === -1 ? '' : p.slice(i + 1).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Hostname of a URL, or '' when unparseable. Used for allow-listing and
 * for logging that avoids leaking full URLs.
 */
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}

/** Naive but effective: does `host` match the allow-list entry (supports *.x.com). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === '*' || p === h) return true;
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return false;
}
