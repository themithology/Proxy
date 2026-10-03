const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { decryptZxcLink } = require('../utils/crypto');
const { buildProxyStreamUrl } = require('./proxy');
const { telemetry } = require('./telemetry');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * vidstuck.xyz backend "keys": the player talks to its own API with randomly
 * obfuscated JSON field names / query parameters (anti-bot obfuscation baked into
 * their bundle). These are field names, not secrets — identical constants are
 * mirrored by vicine v1.5.2's zxc provider:
 *
 *   POST /backend/meow          { <UO>: tmdbId, <UP>: type, <UG>: server }
 *   GET  /backend/servers/:id?  <UO>=id&<UG>=server&<UP>=type&<UL>=ts&<UU>=token
 *                               &<UD>=title&<UC>=year&<UM>=releaseDate&<IM>=imdbId
 *   -> links[0].link is an OpenSSL AES-256-CBC (md5 EVP_BytesToKey) base64 blob.
 *
 * The backend rejects requests that do not carry Origin/Referer: https://vidstuck.xyz.
 */
const ZXC_KEYS = {
  id: 'a7f39c821d604e5b9c71f36e1547b',
  type: 'c285f91ab306d28147a35632e816b',
  server: '6b491e7253ad84d392e7561a9384c',
  ts: '61d9a5274c8e3b29afd6384c291e6',
  token: 'c492f7a183d6502b1e7436c538a716d',
  title: '5e28c9147a306d1e829f3674b392a1',
  year: 'b731e6c94f08269d725f8341c306e',
  date: 'e164932c50216a39e5814b3027',
  imdb: 'f35a8c19d674b3265e871c4933a725f'
};

const VIDSTUCK_ORIGIN = 'https://vidstuck.xyz';

/**
 * Ursa (VidSrc.sh) WASM envelope marker. When the runtime refuses runtime
 * WebAssembly compilation (Cloudflare Workers V8 isolates) or the wasm ABI is
 * unknown, the sealed envelope is shipped to the browser which finishes the
 * decryption with the exact same (vicine v1.5.2) ABI.
 */
const VSRC_WASM_ENVELOPE_URL = 'vidsrc://wasm-envelope';
const VSRC_REFERER = 'https://vidsrc.sh/';

/**
 * 1. VidStuck / ZXC Upstream Resolver (Andromeda / Atlas)
 * Performs session warm-up, /backend/meow token generation, /backend/servers/:server lookup,
 * and OpenSSL MD5 EVP_BytesToKey AES-256-CBC decryption.
 */
async function resolveVidstuckServer(metadata, serverId) {
  const providerKey = `vidstuck:${serverId}`;
  if (!circuitBreaker.isAvailable(providerKey)) {
    return {
      ok: false,
      reason: 'circuit_open',
      diag: {
        stage: 'circuit_breaker',
        message: `${serverId} is temporarily paused by the upstream circuit breaker (too many recent failures). Try again in ~30s or pick another server.`
      }
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);

  // Internal diagnostic — every failure branch stamps a reason the embed UI
  // can show to the user instead of the generic "All upstream servers failed".
  const diag = { stage: 'init', steps: [] };
  const stamp = (stage, message, extra) => {
    diag.stage = stage;
    diag.steps.push({ stage, message, ...(extra || {}) });
    diag.message = message;
  };

  try {
    // Step 1: Warm up session cookies on ZXC + the vidstuck embed page
    const isTv = metadata.type === 'tv';
    const vidstuckBase = config.upstreams.vidstuckBase || VIDSTUCK_ORIGIN;
    stamp('warmup', `Warming session cookies via ${vidstuckBase} / ${config.upstreams.zxcBase}`);
    const [zxcWarm, embedWarm] = await Promise.all([
      fetch(`${config.upstreams.zxcBase}/movie`, {
        headers: { 'User-Agent': USER_AGENT, Referer: `${config.upstreams.zxcBase}/` },
        signal: controller.signal
      }).catch(() => null),
      fetch(`${vidstuckBase}/embed/${isTv ? 'tv' : 'movie'}/${encodeURIComponent(metadata.tmdbId)}`, {
        headers: { 'User-Agent': USER_AGENT, Referer: `${VIDSTUCK_ORIGIN}/` },
        signal: controller.signal
      }).catch(() => null)
    ]);

    const cookieParts = [];
    for (const res of [zxcWarm, embedWarm]) {
      if (!res) continue;
      const list =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of list) cookieParts.push(String(c).split(';')[0]);
    }
    const cookieHeader = Array.from(new Set(cookieParts)).join('; ');

    const vidstuckHeaders = {
      'User-Agent': USER_AGENT,
      Origin: VIDSTUCK_ORIGIN,
      Referer: `${VIDSTUCK_ORIGIN}/`,
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    };

    // Step 1b: TMDB details feed the obfuscated servers query (title/year/date/imdb)
    let title = metadata.title || '';
    let releaseDate = '';
    let imdbId = '';
    const detailsRes = await fetch(
      `${vidstuckBase}/backend/tmdb/details/${isTv ? 'tv' : 'movie'}/${encodeURIComponent(metadata.tmdbId)}?language=en-US`,
      { headers: { ...vidstuckHeaders, Accept: 'application/json' }, signal: controller.signal }
    ).catch(() => null);
    if (detailsRes?.ok) {
      const det = await detailsRes.json().catch(() => null);
      if (det) {
        title = det.title || det.name || title;
        releaseDate = det.release_date || det.first_air_date || '';
        imdbId = det.imdb_id || det.external_ids?.imdb_id || '';
      }
    }
    const releaseYear = String(
      metadata.releaseYear || (releaseDate ? releaseDate.slice(0, 4) : '') || ''
    );
    if (!releaseDate) releaseDate = releaseYear;

    // Step 2: Request /backend/meow token (obfuscated JSON keys)
    const meowBody = {
      [ZXC_KEYS.id]: String(metadata.tmdbId),
      [ZXC_KEYS.type]: isTv ? 'tv' : 'movie',
      [ZXC_KEYS.server]: serverId
    };
    if (isTv) {
      meowBody.season = String(metadata.season || 1);
      meowBody.episode = String(metadata.episode || 1);
    }

    const meowRes = await fetch(`${vidstuckBase}/backend/meow`, {
      method: 'POST',
      headers: { ...vidstuckHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(meowBody),
      signal: controller.signal
    });

    if (!meowRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      stamp('meow', `VidStuck /backend/meow returned HTTP ${meowRes.status}. Upstream is blocking the request (often a stale Origin/Referer or dead session).`);
      return { ok: false, reason: `meow_${meowRes.status}`, diag };
    }

    const meowJson = await meowRes.json().catch(() => null);
    const token = meowJson?.token;
    if (!token) {
      circuitBreaker.recordFailure(providerKey);
      stamp('meow_token', 'VidStuck /backend/meow responded 200 but no session token was returned (upstream contract changed or key is stale).');
      return { ok: false, reason: 'meow_no_token', diag };
    }

    // Step 3: Query /backend/servers/:serverId (obfuscated query params)
    const qs = new URLSearchParams({
      [ZXC_KEYS.id]: String(metadata.tmdbId),
      [ZXC_KEYS.server]: serverId,
      [ZXC_KEYS.type]: isTv ? 'tv' : 'movie',
      ...(meowJson.ts ? { [ZXC_KEYS.ts]: String(meowJson.ts) } : {}),
      [ZXC_KEYS.token]: String(token),
      [ZXC_KEYS.title]: title,
      [ZXC_KEYS.year]: releaseYear,
      [ZXC_KEYS.date]: releaseDate
    });
    if (imdbId) qs.set(ZXC_KEYS.imdb, imdbId);
    if (isTv) {
      qs.set('season', String(metadata.season || 1));
      qs.set('episode', String(metadata.episode || 1));
    }

    const srvRes = await fetch(
      `${vidstuckBase}/backend/servers/${encodeURIComponent(serverId)}?${qs.toString()}`,
      {
        headers: { ...vidstuckHeaders, Accept: 'application/json' },
        signal: controller.signal
      }
    );

    if (!srvRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      stamp('servers_lookup', `VidStuck /backend/servers/${serverId} returned HTTP ${srvRes.status}. Token probably expired or this server is not provisioned for this title.`);
      return { ok: false, reason: `servers_${srvRes.status}`, diag };
    }

    const srvJson = await srvRes.json();
    const encLink = srvJson?.links?.[0]?.link || srvJson?.data?.link || srvJson?.link;
    if (!encLink) {
      circuitBreaker.recordFailure(providerKey);
      stamp('servers_empty', `VidStuck has no stream link for this title on server "${serverId}" (it may be missing in their catalog or restricted by region).`);
      return { ok: false, reason: 'servers_no_link', diag };
    }

    // Step 4: Decrypt AES-256-CBC link if encrypted
    let streamUrl = encLink;
    if (!/^https?:\/\//i.test(encLink) && !encLink.startsWith('/')) {
      const decrypted = decryptZxcLink(encLink);
      if (decrypted) {
        streamUrl = decrypted.startsWith('http')
          ? decrypted
          : `${config.upstreams.vidstuckBase}${decrypted}`;
      } else {
        circuitBreaker.recordFailure(providerKey);
        stamp('aes_decrypt', 'AES-256-CBC decryption of the stream link failed. The ZXC_AES_KEY has likely been rotated by the upstream.');
        return { ok: false, reason: 'aes_decrypt_failed', diag };
      }
    } else if (encLink.startsWith('/')) {
      streamUrl = `${config.upstreams.vidstuckBase}${encLink}`;
    }

    circuitBreaker.recordSuccess(providerKey);

    // The vidstuck backend is Origin/Referer gated (and needs the session
    // cookie), so the stream is fetched through this server's /api/proxy in
    // 'full' mode: nested playlists *and* segments are all rewritten.
    const referer = `${VIDSTUCK_ORIGIN}/`;
    const proxiedUrl = buildProxyStreamUrl(streamUrl, referer, '', {
      mode: 'full',
      cookie: cookieHeader
    });

    // Parse any multi-audio tracks or quality variants returned by the server
    const audioTracks = Array.isArray(srvJson?.data?.audioTracks)
      ? srvJson.data.audioTracks.map((t, idx) => ({
          id: t.id || `audio-${idx}`,
          lang: t.lang || 'en',
          label: t.label || t.name || `Audio ${idx + 1}`,
          type: t.type || 'sub',
          streamUrl: t.url ? buildProxyStreamUrl(t.url, referer) : proxiedUrl,
          rawUrl: t.url || streamUrl,
          default: idx === 0
        }))
      : [
          {
            id: 'orig-audio',
            lang: 'en',
            label: 'Original Audio',
            type: 'sub',
            streamUrl: proxiedUrl,
            rawUrl: streamUrl,
            default: true
          }
        ];

    const qualities = Array.isArray(srvJson?.data?.qualities)
      ? srvJson.data.qualities.map((q) => ({
          label: q.label || `${q.height || 1080}p`,
          height: Number(q.height || 1080),
          url: q.url ? buildProxyStreamUrl(q.url, referer) : proxiedUrl
        }))
      : [{ label: 'Auto', height: 0, url: proxiedUrl }];

    return {
      server: serverId,
      format: /\.mpd(\?|$)/i.test(streamUrl)
        ? 'dash'
        : /\.(mp4|mkv|m4v)(\?|$)/i.test(streamUrl)
          ? 'mp4'
          : 'hls',
      rawUrl: streamUrl,
      streamUrl: proxiedUrl,
      referer,
      headers: {
        Referer: referer,
        Origin: VIDSTUCK_ORIGIN
      },
      backupUrls: [
        buildProxyStreamUrl(streamUrl, referer, '', { mode: 'manifest', cookie: cookieHeader })
      ],
      audioTracks,
      qualities
    };
  } catch (err) {
    circuitBreaker.recordFailure(providerKey);
    const isAbort = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
    stamp(
      isAbort ? 'timeout' : 'exception',
      isAbort
        ? `Timed out talking to VidStuck upstream after 8.5s. The host may be unreachable from this region.`
        : `Unhandled error talking to VidStuck upstream: ${err && err.message ? err.message : 'unknown'}`
    );
    return { ok: false, reason: isAbort ? 'upstream_timeout' : 'upstream_exception', diag };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper: Decrypt the VidSrc.sh WebAssembly envelope (`vs.wasm` / `vs.wasm_url`).
 *
 * Current ABI (vicine v1.5.2 `pop_streams`):
 *
 *   const raw = Buffer.from(s, 'base64');
 *   const ptr = ex.alloc(raw.length);
 *   new Uint8Array(ex.memory.buffer, ptr, raw.length).set(raw);
 *   const len = ex.decrypt(ptr, raw.length);
 *   const decoded = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr + 12, len));
 *
 * The legacy ABI (`key()`/`nonce()`/`malloc()` + NUL-terminated JSON) is kept as a
 * fallback because older mirrors still serve it.
 */
async function decryptVidsrcWasmPayload(wasmBytes, encryptedBase64, nonceKeyStr) {
  const mod = await WebAssembly.compile(wasmBytes);
  const inst = await WebAssembly.instantiate(mod, {
    env: { emscripten_notify_memory_growth() {} }
  });
  const ex = inst.exports;
  const mem = ex.memory;
  if (!mem) return null;

  // --- Current ABI (vicine v1.5.2): alloc + decrypt -> utf8 payload at ptr + 12
  if (typeof ex.decrypt === 'function' && typeof ex.alloc === 'function') {
    try {
      const raw = Buffer.from(encryptedBase64, 'base64');
      const ptr = ex.alloc(raw.length);
      new Uint8Array(mem.buffer, ptr, raw.length).set(raw);
      const len = ex.decrypt(ptr, raw.length);
      if (typeof len === 'number' && len > 0) {
        const decoded = new TextDecoder().decode(new Uint8Array(mem.buffer, ptr + 12, len));
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.stream_urls)) return parsed.stream_urls;
      }
    } catch {
      // fall through to the legacy ABI
    }
  }

  // --- Legacy ABI: key() + nonce() + malloc() + NUL-terminated JSON
  if (typeof ex.key === 'function') {
    const kp = ex.key();
    const kb = new Uint8Array(mem.buffer, kp, 32);
    const kh = '91d803885852299907d44c2f92822699c62f8b0f0a5c8d208190e0f102131415';
    for (let i = 0; i < 32; i++) kb[i] = parseInt(kh.slice(i * 2, i * 2 + 2), 16);
  }
  if (typeof ex.nonce === 'function') {
    const nb = Buffer.from(String(nonceKeyStr), 'utf8');
    const np = (typeof ex.alloc === 'function' ? ex.alloc : ex.malloc)(nb.length + 1);
    new Uint8Array(mem.buffer).set(nb, np);
    new Uint8Array(mem.buffer)[np + nb.length] = 0;
    ex.nonce(np);
    if (typeof ex.free === 'function') ex.free(np);
  }

  const ct = Buffer.from(encryptedBase64, 'base64');
  const ptr = (typeof ex.alloc === 'function' ? ex.alloc : ex.malloc)(ct.length);
  new Uint8Array(mem.buffer).set(ct, ptr);
  const outPtr = ex.decrypt(ptr, ct.length);
  if (!outPtr) return null;

  const u8 = new Uint8Array(mem.buffer);
  let end = outPtr;
  while (end < u8.length && u8[end] !== 0) end++;
  const plainText = Buffer.from(mem.buffer, outPtr, end - outPtr).toString('utf8');
  const parsed = JSON.parse(plainText);
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.stream_urls) ? parsed.stream_urls : null;
}

/**
 * 2. VidSrc.sh Upstream Resolver (Ursa)
 * Queries https://data.vidsrc.sh/api.php, decrypts ChaCha20 WASM stream_urls if encrypted,
 * and stamps the stream URL with a fresh JWT from <streamHost>/generate.php.
 */
async function resolveVidsrcServer(metadata) {
  const providerKey = 'vidsrc:ursa';
  if (!circuitBreaker.isAvailable(providerKey)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const isTv = metadata.type === 'tv';
    const qs = isTv
      ? `type=tv&tmdb=${encodeURIComponent(metadata.tmdbId)}&season=${metadata.season || 1}&episode=${metadata.episode || 1}&stream_urls`
      : `type=movie&tmdb=${encodeURIComponent(metadata.tmdbId)}&stream_urls`;

    const apiUrl = `${config.upstreams.vidsrcDataUrl}?${qs}`;
    const referer = 'https://vidsrc.sh/';

    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: referer
      },
      signal: controller.signal
    });

    if (!res.ok) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    const json = await res.json();
    let urls = [];
    let vsEnvelope = null;

    if (Array.isArray(json?.data?.stream_urls)) {
      urls = json.data.stream_urls;
    } else if (typeof json?.data?.stream_urls === 'string' && json?.vs) {
      let wasmBytes = null;
      if (json.vs.wasm) {
        wasmBytes = Buffer.from(json.vs.wasm, 'base64');
      } else if (json.vs.wasm_url) {
        const wasmRes = await fetch(json.vs.wasm_url, {
          headers: { 'User-Agent': USER_AGENT, Referer: referer },
          signal: controller.signal
        });
        if (wasmRes.ok) {
          wasmBytes = Buffer.from(await wasmRes.arrayBuffer());
        }
      }

      if (wasmBytes) {
        const nonceKey = isTv
          ? `${metadata.tmdbId}_${metadata.season || 1}_${metadata.episode || 1}`
          : `stream_urls:${metadata.tmdbId}`;
        try {
          const decrypted = await decryptVidsrcWasmPayload(
            wasmBytes,
            json.data.stream_urls,
            nonceKey
          );
          if (Array.isArray(decrypted)) {
            urls = decrypted;
          }
        } catch {
          // "Wasm code generation disallowed by embedder" (Workers V8 isolates)
          // or an unknown ABI — the browser finishes the job below.
        }
      }

      if (urls.length === 0) {
        vsEnvelope = {
          streamUrls: json.data.stream_urls,
          wasmUrl: json.vs.wasm_url
            ? buildProxyStreamUrl(json.vs.wasm_url, referer, '', { mode: 'manifest' })
            : null,
          wasmBase64: json.vs.wasm || null
        };
      }
    }

    urls = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));

    // Browser-side WASM assist: never dead-end a title just because this runtime
    // cannot compile wasm. Hand the sealed envelope to public/js/embed.js, which
    // runs WebAssembly.compile in the viewer's browser and streams the result
    // back through /api/proxy with vidsrcStamp=1 + mode=full.
    if (urls.length === 0 && vsEnvelope) {
      circuitBreaker.recordSuccess(providerKey);
      return {
        server: 'ursa',
        format: 'hls',
        rawUrl: VSRC_WASM_ENVELOPE_URL,
        streamUrl: VSRC_WASM_ENVELOPE_URL,
        referer,
        headers: {},
        transport: 'browser-wasm',
        vsEnvelope,
        backupUrls: [],
        audioTracks: [
          {
            id: 'vidsrc-orig',
            lang: 'en',
            label: 'Original Audio',
            type: 'sub',
            streamUrl: VSRC_WASM_ENVELOPE_URL,
            rawUrl: VSRC_WASM_ENVELOPE_URL,
            default: true
          }
        ],
        qualities: [{ label: 'Auto', height: 0, url: VSRC_WASM_ENVELOPE_URL }]
      };
    }

    if (urls.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    // Stamp stream URLs with a fresh JWT from <streamOrigin>/generate.php.
    // The endpoint answers either a bare JWT (text/plain) or `{"token": "..."}`;
    // some mirrors also ship `__TOKEN__` placeholders inside the URL itself.
    let rawMasterUrl = urls[0];
    let vsToken = '';
    try {
      const parsed = new URL(rawMasterUrl);
      const genRes = await fetch(`${parsed.origin}/generate.php`, {
        headers: { 'User-Agent': USER_AGENT, Referer: referer },
        signal: controller.signal
      });
      if (genRes.ok) {
        const genText = (await genRes.text()).trim();
        if (genText.startsWith('{')) {
          vsToken = JSON.parse(genText)?.token || '';
        } else if (!genText.startsWith('<')) {
          vsToken = genText.replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      // Some VidSrc CDN mirrors do not require generate.php token
    }

    if (vsToken) {
      const stamp = (u) =>
        u.includes('__TOKEN__')
          ? u.replace(/__TOKEN__/g, encodeURIComponent(vsToken))
          : `${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(vsToken)}`;
      urls = urls.map(stamp);
      rawMasterUrl = urls[0];
    }

    circuitBreaker.recordSuccess(providerKey);

    // Origin/Referer + JWT gated host -> proxy every playlist AND segment URI
    // with the token attached ('full' mode).
    const proxiedUrl = buildProxyStreamUrl(rawMasterUrl, referer, '', {
      mode: 'full',
      token: vsToken
    });
    const qualities = [
      { label: 'Auto', height: 0, url: proxiedUrl },
      ...urls.map((u, idx) => ({
        label: idx === 0 ? '1080p' : idx === 1 ? '720p' : `Mirror ${idx + 1}`,
        height: idx === 0 ? 1080 : 720,
        url: buildProxyStreamUrl(u, referer, '', { mode: 'full', token: vsToken })
      }))
    ];

    return {
      server: 'ursa',
      format: rawMasterUrl.includes('.mp4') || rawMasterUrl.includes('.mkv') ? 'mp4' : 'hls',
      rawUrl: rawMasterUrl,
      streamUrl: proxiedUrl,
      referer,
      headers: {},
      vsToken,
      backupUrls: [
        buildProxyStreamUrl(rawMasterUrl, referer, '', { mode: 'manifest', token: vsToken }),
        rawMasterUrl,
        ...urls.slice(1).map((u) => buildProxyStreamUrl(u, referer, '', { mode: 'manifest', token: vsToken }))
      ],
      audioTracks: [
        {
          id: 'vidsrc-orig',
          lang: 'en',
          label: 'Original Audio',
          type: 'sub',
          streamUrl: proxiedUrl,
          rawUrl: rawMasterUrl,
          default: true
        }
      ],
      qualities
    };
  } catch {
    circuitBreaker.recordFailure(providerKey);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HiCine (Centaurus) shared helpers
 */

/**
 * Unwrap a `/go` redirect wrapper: `ten` links bounce through
 * `https://gamerxyt.com/dl.php?link=https://video-downloads.googleusercontent.com/...`
 * and the inner Google CDN URL is the real, never hotlink-blocked stream.
 */
function unwrapRedirectVideoUrl(loc) {
  if (!loc || typeof loc !== 'string') return '';
  const inner = loc.match(/[?&]link=(https?:\/\/[^\s&"']+)/i);
  if (inner && inner[1] && !/gamerxyt\.com/i.test(inner[1])) {
    try {
      return decodeURIComponent(inner[1]);
    } catch {
      return inner[1];
    }
  }
  return loc;
}

/**
 * Root Cause A: token priority. `pixel` (pixeldrain) hotlink-403s
 * ({"success":false,"value":"hotlink_detected"}) and is rate-limit-captcha gated,
 * so the CDN tokens are tried first and pixeldrain is kept only as a last resort.
 */
const HICINE_TOKEN_PRIORITY = ['ten', 'fsl2', 'fsl', 'r2', 'DDL', 'server1'];

function orderHicineTokens(tokens = {}) {
  return [
    ...HICINE_TOKEN_PRIORITY.filter((t) => tokens[t]),
    ...Object.keys(tokens).filter((t) => !HICINE_TOKEN_PRIORITY.includes(t) && t !== 'pixel'),
    ...(tokens.pixel ? ['pixel'] : [])
  ];
}

/**
 * Probe a pixeldrain endpoint before handing it to the player: Pixeldrain answers
 * HTTP 200 {"success":false,"value":"hotlink_detected"} for foreign referers, and
 * `availability: file_rate_limited_captcha_required` for captcha-gated files.
 */
async function probePixeldrain(url, headers = {}) {
  try {
    const probe = await fetch(url, {
      headers: { Accept: '*/*', 'User-Agent': USER_AGENT, Range: 'bytes=0-64', ...headers }
    });
    const text = (await probe.text()).slice(0, 400).toLowerCase();
    if (
      !probe.ok ||
      text.includes('hotlink_detected') ||
      text.includes('"success":false') ||
      text.includes('captcha')
    ) {
      return { blocked: true };
    }
    return { blocked: false };
  } catch {
    return { blocked: true };
  }
}

/**
 * Mobile browsers (Android Chrome/Brave) cannot decode 10-bit HEVC, so score
 * x264 + stereo AAC above a higher-resolution HEVC line, then prefer the
 * fastest-starting resolution (720p x264) while keeping 1080p/480p in qualities.
 */
function describeHicineMedia(label, context = '', url = '') {
  const haystack = `${label || ''} ${context || ''} ${url || ''}`;
  return {
    isHevc: /hevc|x265|10\s*bit/i.test(haystack),
    isX264: /x264|h\.?264/i.test(haystack),
    isMultiChannel: /dd\s*5\.1|ac3|eac3|5\.1|7\.1/i.test(haystack),
    isStereoAac: /aac|stereo|2\.0/i.test(haystack)
  };
}

function scoreHicineQuality(q) {
  let score = 0;
  const label = String(q.label || q.quality || '');
  const media = describeHicineMedia(label, q.description || '', q.url || '');
  const isHevc = q.isHevc ?? media.isHevc;
  const isX264 = q.isX264 ?? media.isX264;
  const isMultiChannel = q.isMultiChannel ?? media.isMultiChannel;
  const isStereoAac = q.isStereoAac ?? media.isStereoAac;
  const height = Number(q.height) || 0;

  if (!isHevc) score += 100;
  if (isX264) score += 60;
  if (isStereoAac) score += 40;
  if (height === 720) score += 30;
  else if (height === 480) score += 25;
  else if (height === 1080) score += 20;
  else score += 10;
  if (isHevc) score -= 50;
  if (isMultiChannel) score -= 30;
  return score;
}

/**
 * Split a HiCine quality block into (quality, url) candidates.
 * Handles `480p : <url>` lines, ` : ` packed multi-quality single lines
 * (`Episode 1 : <url>,480p : <url>,720p`) and pixeldrain share URLs.
 */
function parseHicineLinks(rawText, isTv = false, episodeNum = 1) {
  if (!rawText || typeof rawText !== 'string') return [];
  let targetBlock = rawText;

  if (isTv) {
    // Split into Episode sections: `Episode 1 : ...` or `Episode 01 ...`
    const lines = rawText.split(/\r?\n/);
    const epRegex = new RegExp(`^\\s*Episode\\s+0*${Number(episodeNum)}(?:\\b|\\s|:)`, 'i');
    const anyEpRegex = /^\s*Episode\s+\d+/i;
    const matchedLines = [];
    let inEpisode = false;

    for (const line of lines) {
      if (epRegex.test(line)) {
        inEpisode = true;
        matchedLines.push(line);
      } else if (inEpisode && anyEpRegex.test(line)) {
        break;
      } else if (inEpisode) {
        matchedLines.push(line);
      }
    }
    if (matchedLines.length > 0) {
      targetBlock = matchedLines.join('\n');
    }
  }

  const results = [];
  const lines = targetBlock.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const lineQuality = (line.match(/(2160p|4k|1080p|720p|480p)/i) || [])[1];

    // Root Cause C (TV): one episode packs multiple qualities on a single line,
    // ` : ` separated — explode them so `720p` and `1080p` variants on the same
    // line are both parsed.
    const segments = line.split(/\s+:\s+/);
    let inheritedQuality = lineQuality ? lineQuality.toLowerCase() : '720p';
    let firstSegment = true;

    for (const segment of segments) {
      const segQualityTokens = [...segment.matchAll(/(2160p|4k|1080p|720p|480p)/gi)];
      if (segQualityTokens.length > 0 && !firstSegment) {
        inheritedQuality = segQualityTokens[0][1].toLowerCase();
      }
      firstSegment = false;

      const labelFor = (urlIndex) => {
        const before = segQualityTokens
          .filter((m) => m.index < urlIndex)
          .pop();
        if (before) return before[1].toLowerCase();
        if (segQualityTokens.length > 0) return segQualityTokens[0][1].toLowerCase();
        return inheritedQuality;
      };
      const toHeight = (label) =>
        label === '2160p' || label === '4k' ? 2160 : parseInt(label, 10) || 720;

      // vcloud worker URLs (`https://...workers.dev/?vcloud=https://vcloud.fit/...`)
      for (const match of segment.matchAll(/(https?:\/\/[^\s,"']+\/?vcloud=[^\s,"']+)/gi)) {
        const label = labelFor(match.index);
        results.push({
          type: 'vcloud_worker',
          quality: label,
          height: toHeight(label),
          url: match[1],
          description: `${line} ${segment}`
        });
      }

      // direct pixeldrain share URLs (`https://pixeldrain.dev/u/ID`)
      for (const match of segment.matchAll(
        /https?:\/\/pixeldrain\.(?:dev|com)\/u\/([A-Za-z0-9]+)/gi
      )) {
        const label = labelFor(match.index);
        results.push({
          type: 'pixeldrain',
          quality: label,
          height: toHeight(label),
          url: `https://pixeldrain.dev/api/file/${match[1]}`,
          description: `${line} ${segment}`
        });
      }
    }
  }

  return results;
}

/**
 * Resolve a vcloud worker URL (`https://<worker>.workers.dev/?vcloud=https://vcloud.fit/...`)
 * into a direct downloadable/streamable CDN URL.
 *
 * Tokens are resolved in priority order with all present tokens probed in
 * parallel; `/go` redirect wrappers (`?link=`) are unwrapped and pixeldrain
 * responses are pre-flighted for the hotlink block.
 */
async function resolveVcloudWorkerLink(workerUrl, signal) {
  try {
    const parsed = new URL(workerUrl);
    const workerBase = parsed.origin;
    const vcloudParam = parsed.searchParams.get('vcloud');
    if (!vcloudParam) return null;

    const linksApi = `${workerBase}/api/links?vcloud=${encodeURIComponent(vcloudParam)}`;
    const res = await fetch(linksApi, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal
    });
    if (!res.ok) return null;

    const data = await res.json();
    const tokens = data?.tokens || {};
    const tokenTypes = orderHicineTokens(tokens);
    if (tokenTypes.length === 0) return null;

    const attempts = await Promise.all(
      tokenTypes.map(async (tokenType) => {
        const tok = tokens[tokenType];
        if (!tok || !tok.ts || !tok.sig) return null;
        try {
          const goUrl = `${workerBase}/go?type=${encodeURIComponent(tokenType)}&vcloud=${encodeURIComponent(vcloudParam)}&ts=${encodeURIComponent(tok.ts)}&sig=${encodeURIComponent(tok.sig)}`;
          const goRes = await fetch(goUrl, {
            headers: { 'User-Agent': USER_AGENT },
            redirect: 'manual',
            signal
          });

          let location = goRes.headers.get('location');
          if (!location || !/^https?:\/\//i.test(location)) return null;

          // Root Cause B: unwrap `?link=` redirect wrappers to the real CDN URL
          location = unwrapRedirectVideoUrl(location);
          if (!/^https?:\/\//i.test(location)) return null;

          // pixeldrain share pages -> direct API stream endpoint
          if (/pixeldrain\.(dev|com)/i.test(location) && location.includes('/u/')) {
            const pdId = location.split('/u/')[1].split(/[?#]/)[0];
            if (pdId) location = `https://pixeldrain.dev/api/file/${pdId}`;
          }

          let isHotlinkBlocked = false;
          if (/pixeldrain\.dev\/api\/file\//i.test(location)) {
            const probe = await probePixeldrain(location);
            isHotlinkBlocked = probe.blocked;
          }

          return {
            url: location,
            title: data.title || '',
            tokenType,
            isHotlinkBlocked,
            format: /\.mpd(\?|$)/i.test(location)
              ? 'dash'
              : /\.m3u8(\?|$)/i.test(location)
                ? 'hls'
                : 'mp4'
          };
        } catch {
          return null;
        }
      })
    );

    return (
      attempts.find((a) => a && !a.isHotlinkBlocked) ||
      attempts.find((a) => a) ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * 3. HiCine Upstream Resolver (Centaurus)
 * Queries https://api.hicine.sbs/api/search/{title} and resolves 1080p/720p/480p direct streams.
 */
async function resolveHicineServer(metadata) {
  const providerKey = 'hicine:centaurus';
  if (!circuitBreaker.isAvailable(providerKey) || !metadata.title) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9500);

  try {
    const searchUrl = `${config.upstreams.hicineApiBase}/api/search/${encodeURIComponent(metadata.title)}`;
    const res = await fetch(searchUrl, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal
    });

    if (!res.ok) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const isTv = metadata.type === 'tv';
    const wantedYear = Number(metadata.releaseYear) || 0;
    const wantedTitle = String(metadata.title || '').toLowerCase().trim();

    // Score candidates so `Fight Club (1999)` is selected instead of
    // `Fight Club (2023)`.
    const scoreItem = (item) => {
      let score = 0;
      const itemTitle = String(item.title || item.name || '').toLowerCase().trim();
      if (itemTitle === wantedTitle) score += 100;
      else if (itemTitle.startsWith(wantedTitle) || itemTitle.includes(wantedTitle)) score += 40;
      const itemYear = Number(item.releaseYear || item.year) || 0;
      if (wantedYear && itemYear) {
        const delta = Math.abs(itemYear - wantedYear);
        if (delta === 0) score += 100;
        else if (delta <= 1) score += 70;
        else if (delta <= 3) score += 30;
        else score -= 25;
      }
      if (isTv) {
        if (item.contentType === 'series' || item.season_1) score += 30;
        if (item.season_1 && /episode\s+1\b/i.test(String(item.season_1))) score += 10;
      } else if (item.contentType === 'movies' || item.links) {
        score += 30;
      }
      return score;
    };

    const candidates = items.filter((item) => {
      if (isTv) return item.contentType === 'series' || item.season_1;
      return item.contentType === 'movies' || item.links;
    });
    const pool = candidates.length > 0 ? candidates : items;
    const chosen = [...pool].sort((a, b) => scoreItem(b) - scoreItem(a))[0];
    if (!chosen) return null;

    const rawText = isTv
      ? chosen[`season_${metadata.season || 1}`] || chosen.season_1 || ''
      : chosen.links || '';

    const extracted = parseHicineLinks(rawText, isTv, metadata.episode || 1);
    if (extracted.length === 0) return null;

    const resolvedQualities = [];
    const seenDirect = new Set();
    let releaseTitle = '';

    for (const entry of extracted) {
      if (resolvedQualities.length >= 4) break;

      if (entry.type === 'pixeldrain') {
        // pixeldrain is the last-resort token type: keep it, but marked so the
        // scorer pushes it behind every working CDN token (hotlink_detected).
        const probe = await probePixeldrain(entry.url);
        if (!seenDirect.has(entry.url)) {
          seenDirect.add(entry.url);
          resolvedQualities.push({
            label: entry.quality,
            height: entry.height,
            rawUrl: entry.url,
            tokenType: 'pixel',
            isHotlinkBlocked: probe.blocked,
            streamFormat: 'mp4',
            description: entry.description || '',
            ...describeHicineMedia(entry.quality, entry.description || '', entry.url)
          });
        }
        continue;
      }

      if (entry.type === 'vcloud_worker') {
        const resolved = await resolveVcloudWorkerLink(entry.url, controller.signal);
        if (!resolved?.url || seenDirect.has(resolved.url)) continue;
        seenDirect.add(resolved.url);
        if (resolved.title) releaseTitle = resolved.title;
        resolvedQualities.push({
          label: entry.quality,
          height: entry.height,
          rawUrl: resolved.url,
          tokenType: resolved.tokenType,
          isHotlinkBlocked: !!resolved.isHotlinkBlocked,
          streamFormat: resolved.format,
          description: entry.description || '',
          ...describeHicineMedia(entry.quality, entry.description || '', entry.url)
        });
      }
    }

    if (resolvedQualities.length === 0) return null;

    circuitBreaker.recordSuccess(providerKey);

    // Root Cause C+D: prefer non-HEVC x264 stereo-AAC lines (720p x264 first for a
    // fast mobile start), keep 1080p/480p in `qualities`, and play resolved direct
    // CDN URLs natively in <video> instead of wrapping them in /api/proxy.
    const isDeadQuality = (q) => q.isHotlinkBlocked;
    const sorted = [...resolvedQualities].sort((a, b) => {
      const deadDelta = Number(isDeadQuality(a)) - Number(isDeadQuality(b));
      if (deadDelta !== 0) return deadDelta;
      return scoreHicineQuality(b) - scoreHicineQuality(a);
    });
    // Drop a 10-bit HEVC entry when an x264 line of the same resolution exists:
    // the duplicate label is useless on mobile and keeping it in `qualities`
    // invites a manual pick that cannot decode.
    const x264Heights = new Set(
      sorted.filter((q) => !q.isHevc && !q.isHotlinkBlocked).map((q) => q.height)
    );
    const playable = sorted.filter(
      (q) => !x264Heights.has(q.height) || (!q.isHevc && !q.isHotlinkBlocked)
    );
    if (playable.length === 0) playable.push(...sorted);
    const primary = playable[0];
    const ordered = [primary, ...playable.slice(1).sort((a, b) => b.height - a.height)];

    const backupUrls = [];
    for (const q of ordered.slice(1)) {
      backupUrls.push(buildProxyStreamUrl(q.rawUrl, '', '', { mode: 'manifest' }));
    }
    backupUrls.push(buildProxyStreamUrl(primary.rawUrl, '', '', { mode: 'manifest' }));
    backupUrls.push(buildProxyStreamUrl(primary.rawUrl, '', '', { mode: 'full' }));
    const uniqueBackups = Array.from(new Set(backupUrls.filter(Boolean)));

    const hasMultiAudio = /multi|dual|hin|eng/i.test(releaseTitle);
    const audioTracks = [
      {
        id: 'hicine-en',
        lang: 'en',
        label: hasMultiAudio ? 'English (Dual Audio)' : 'Original Audio',
        type: 'dub',
        streamUrl: primary.rawUrl,
        rawUrl: primary.rawUrl,
        default: true
      }
    ];

    return {
      server: 'centaurus',
      format: primary.streamFormat || 'mp4',
      rawUrl: primary.rawUrl,
      // Root Cause D: direct CDN playback, NOT wrapped in /api/proxy
      streamUrl: primary.rawUrl,
      referer: '',
      headers: {},
      tokenType: primary.tokenType,
      backupUrls: uniqueBackups,
      audioTracks,
      qualities: ordered.map((q) => ({
        label: q.label,
        height: q.height,
        url: q.rawUrl,
        tokenType: q.tokenType
      }))
    };
  } catch {
    circuitBreaker.recordFailure(providerKey);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper: Decode ZokoAnime `window.__P` base64 payload using XOR key `"otaku-embed-v1"`
 */
function decodeZokoAnimeXorPayload(b64Payload, xorKey = 'otaku-embed-v1') {
  const raw = Buffer.from(b64Payload, 'base64');
  const keyBuf = Buffer.from(xorKey, 'utf8');
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ keyBuf[i % keyBuf.length];
  }
  const decodedStr = out.toString('utf8');
  const parsed = JSON.parse(decodedStr);
  return {
    streamUrl: parsed?.data?.sources?.file || null,
    tracks: Array.isArray(parsed?.data?.tracks) ? parsed.data.tracks : []
  };
}

/**
 * 4. HiAnime.at + ZokoAnime Upstream Resolver (Strings)
 * Extracts both SUB and DUB .m3u8 streams for anime titles.
 */
async function resolveHianimeServer(metadata) {
  const providerKey = 'hianime:strings';
  if (!circuitBreaker.isAvailable(providerKey) || !metadata.title) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9500);

  try {
    const base = config.upstreams.hianimeBase;
    const searchRes = await fetch(
      `${base}/search?keyword=${encodeURIComponent(metadata.title)}`,
      {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal
      }
    );
    if (!searchRes.ok) return null;

    const searchHtml = await searchRes.text();
    const idMatch = searchHtml.match(/data-id="(\d+)"/);
    if (!idMatch) return null;
    const animeId = idMatch[1];

    const epListRes = await fetch(`${base}/api/theme/episode/list/${animeId}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${base}/`
      },
      signal: controller.signal
    });
    if (!epListRes.ok) return null;

    const epListJson = await epListRes.json();
    const epHtml = epListJson?.html || '';
    const epNum = metadata.episode || 1;
    const epRegex = new RegExp(
      `data-number="${epNum}"[\\s\\S]*?data-id="(\\d+)"|data-id="(\\d+)"[\\s\\S]*?data-number="${epNum}"`,
      'i'
    );
    const epMatch = epHtml.match(epRegex);
    const episodeId = epMatch ? epMatch[1] || epMatch[2] : null;
    if (!episodeId) return null;

    const srvRes = await fetch(
      `${base}/api/theme/episode/servers?episodeId=${episodeId}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${base}/`
        },
        signal: controller.signal
      }
    );
    if (!srvRes.ok) return null;

    const srvJson = await srvRes.json();
    const srvHtml = srvJson?.html || '';

    // Extract first sub and first dub server source IDs
    const subMatch = srvHtml.match(/data-type="sub"[\s\S]*?data-id="(\d+)"/i);
    const dubMatch = srvHtml.match(/data-type="dub"[\s\S]*?data-id="(\d+)"/i);

    const audioTracks = [];
    const zokoReferer = 'https://zokoanime.video/';

    for (const [mode, sourceId, label] of [
      ['sub', subMatch?.[1], 'Japanese (Original Sub)'],
      ['dub', dubMatch?.[1], 'English Dub']
    ]) {
      if (!sourceId) continue;
      const srcRes = await fetch(`${base}/api/theme/episode/sources?id=${sourceId}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${base}/`
        },
        signal: controller.signal
      });
      if (!srcRes.ok) continue;
      const srcJson = await srcRes.json();
      const embedLink = srcJson?.link;
      if (!embedLink) continue;

      const embedRes = await fetch(embedLink, {
        headers: { 'User-Agent': USER_AGENT, Referer: `${base}/` },
        signal: controller.signal
      });
      if (!embedRes.ok) continue;
      const embedHtml = await embedRes.text();
      const pMatch = embedHtml.match(/window\.__P\s*=\s*"([^"]+)"/);
      if (!pMatch) continue;

      const decoded = decodeZokoAnimeXorPayload(pMatch[1]);
      if (decoded?.streamUrl) {
        audioTracks.push({
          id: `zoko-${mode}`,
          lang: mode === 'dub' ? 'en' : 'ja',
          label,
          type: mode,
          rawUrl: decoded.streamUrl,
          streamUrl: buildProxyStreamUrl(decoded.streamUrl, zokoReferer),
          default: audioTracks.length === 0
        });
      }
    }

    if (audioTracks.length === 0) return null;

    circuitBreaker.recordSuccess(providerKey);
    const primary = audioTracks[0];

    return {
      server: 'strings',
      format: 'hls',
      rawUrl: primary.rawUrl,
      streamUrl: primary.streamUrl,
      referer: zokoReferer,
      headers: {
        Referer: zokoReferer,
        Origin: 'https://zokoanime.video'
      },
      audioTracks,
      qualities: [{ label: 'Auto', height: 0, url: primary.streamUrl }]
    };
  } catch {
    circuitBreaker.recordFailure(providerKey);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve stream for a specific server ID, or waterfall across all production servers
 * until a working stream is found. Zero test/demo videos.
 */
async function resolveStreamForServer(metadata, requestedServerId = 'andromeda', preferredAudio = '') {
  // 1. Check if the owner configured a custom stream override for this TMDB ID in /admin
  const customOverride = telemetry.getCustomOverride(
    metadata.type,
    metadata.tmdbId,
    metadata.season || 1,
    metadata.episode || 1
  );
  if (customOverride && customOverride.streamUrl) {
    const proxied = buildProxyStreamUrl(customOverride.streamUrl, '');
    return {
      server: 'custom',
      requestedServer: requestedServerId,
      format: customOverride.format || 'hls',
      rawUrl: customOverride.streamUrl,
      streamUrl: proxied,
      referer: '',
      headers: {},
      audioTracks: [
        {
          id: 'custom-orig',
          lang: 'en',
          label: customOverride.label || 'Custom Admin Source',
          type: 'sub',
          streamUrl: proxied,
          rawUrl: customOverride.streamUrl,
          default: true
        }
      ],
      qualities: [{ label: 'Auto', height: 0, url: proxied }],
      servers: config.servers.map((s) => ({ ...s, active: false }))
    };
  }

  const enabledServers = config.servers.filter((s) => s.enabled !== false);
  const validServer =
    enabledServers.find((s) => s.id === requestedServerId)?.id ||
    enabledServers[0]?.id ||
    'andromeda';

  const cacheKey = `resolve:v2:${metadata.type}:${metadata.tmdbId}:s${metadata.season || 1}:e${metadata.episode || 1}:${validServer}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  // Build ordered waterfall starting with the user's selected server, then the
  // fast edge-first priority used by the Cloudflare Worker:
  // centaurus -> ursa -> andromeda -> atlas -> strings.
  const WATERFALL_PRIORITY = ['centaurus', 'ursa', 'andromeda', 'atlas', 'strings'];
  const enabledIds = enabledServers.map((s) => s.id);
  const prioritized = [
    ...WATERFALL_PRIORITY.filter((id) => enabledIds.includes(id)),
    ...enabledIds.filter((id) => !WATERFALL_PRIORITY.includes(id))
  ];
  const serverOrder = [validServer, ...prioritized.filter((id) => id !== validServer)];
  const serverAttempts = [];

  for (const srvId of serverOrder) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'andromeda' || srvId === 'atlas') {
      resolved = await resolveVidstuckServer(metadata, srvId);
    } else if (srvId === 'ursa') {
      resolved = await resolveVidsrcServer(metadata);
    } else if (srvId === 'centaurus') {
      resolved = await resolveHicineServer(metadata);
    } else if (srvId === 'strings') {
      resolved = await resolveHianimeServer(metadata);
    }
    const latencyMs = Date.now() - t0;

    if (resolved && resolved.streamUrl) {
      telemetry.recordServerAttempt(srvId, true, latencyMs);
      // Honor preferredAudio if matching track exists
      if (preferredAudio && Array.isArray(resolved.audioTracks)) {
        const matchTrack = resolved.audioTracks.find(
          (t) => t.id === preferredAudio || t.lang === preferredAudio
        );
        if (matchTrack) {
          resolved.audioTracks = resolved.audioTracks.map((t) => ({
            ...t,
            default: t.id === matchTrack.id
          }));
          resolved.streamUrl = matchTrack.streamUrl;
          resolved.rawUrl = matchTrack.rawUrl;
        }
      }

      const payload = {
        ...resolved,
        requestedServer: validServer,
        activeAudioTrack:
          resolved.audioTracks.find((t) => t.default) || resolved.audioTracks[0] || null,
        servers: enabledServers.map((s) => ({
          ...s,
          active: s.id === resolved.server
        }))
      };

      await cache.set(cacheKey, payload, 900);
      return payload;
    } else {
      const reason =
        resolved && resolved.reason ? resolved.reason : 'no_stream';
      const diag = resolved && resolved.diag ? resolved.diag : null;
      telemetry.recordServerAttempt(srvId, false, latencyMs, reason);
      // Capture so the embed UI can tell the user *why* this server failed
      // instead of "All upstream servers failed" with zero context.
      serverAttempts.push({ server: srvId, latencyMs, reason, diag });
    }
  }

  return {
    server: null,
    streamUrl: null,
    reason: 'all_servers_failed',
    serverAttempts,
    servers: enabledServers.map((s) => ({ ...s, active: false }))
  };
}

module.exports = {
  resolveStreamForServer,
  resolveVidstuckServer,
  resolveVidsrcServer,
  resolveHicineServer,
  resolveHianimeServer,
  decryptVidsrcWasmPayload,
  decodeZokoAnimeXorPayload,
  parseHicineLinks
};
