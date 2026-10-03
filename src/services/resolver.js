const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { decryptZxcLink } = require('../utils/crypto');
const { buildProxyStreamUrl } = require('./proxy');
const { telemetry } = require('./telemetry');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 1. VidStuck / ZXC Upstream Resolver (Andromeda / Atlas)
 * Performs session warm-up, /backend/meow token generation, /backend/servers/:server lookup,
 * and OpenSSL MD5 EVP_BytesToKey AES-256-CBC decryption.
 */
async function resolveVidstuckServer(metadata, serverId) {
  const providerKey = `vidstuck:${serverId}`;
  if (!circuitBreaker.isAvailable(providerKey)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);

  try {
    // Step 1: Warm up session cookies on ZXC
    const warmupRes = await fetch(`${config.upstreams.zxcBase}/movie`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal
    }).catch(() => null);

    const rawCookies = warmupRes?.headers?.getSetCookie ? warmupRes.headers.getSetCookie() : [];
    const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');

    // Step 2: Request /backend/meow token
    const meowPayload = {
      type: metadata.type,
      id: String(metadata.tmdbId),
      title: metadata.title || '',
      season: String(metadata.season || 1),
      episode: String(metadata.episode || 1),
      releaseYear: String(metadata.releaseYear || '')
    };

    const meowRes = await fetch(`${config.upstreams.vidstuckBase}/backend/meow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Referer: `${config.upstreams.zxcBase}/`,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      body: JSON.stringify(meowPayload),
      signal: controller.signal
    });

    if (!meowRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    const meowJson = await meowRes.json();
    const token = meowJson?.token;
    if (!token) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    // Step 3: Query /backend/servers/:serverId
    const qs = new URLSearchParams({
      id: String(metadata.tmdbId),
      type: metadata.type,
      title: metadata.title || '',
      token,
      season: String(metadata.season || 1),
      episode: String(metadata.episode || 1),
      year: String(metadata.releaseYear || '')
    });

    const srvRes = await fetch(
      `${config.upstreams.vidstuckBase}/backend/servers/${encodeURIComponent(serverId)}?${qs.toString()}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          Referer: `${config.upstreams.zxcBase}/`,
          ...(cookieHeader ? { Cookie: cookieHeader } : {})
        },
        signal: controller.signal
      }
    );

    if (!srvRes.ok) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    const srvJson = await srvRes.json();
    const encLink = srvJson?.data?.link || srvJson?.link;
    if (!encLink) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    // Step 4: Decrypt AES-256-CBC link if encrypted
    let streamUrl = encLink;
    if (!/^https?:\/\//i.test(encLink) && !encLink.startsWith('/')) {
      const decrypted = decryptZxcLink(encLink);
      if (decrypted) {
        streamUrl = decrypted.startsWith('http')
          ? decrypted
          : `${config.upstreams.vidstuckBase}${decrypted}`;
      }
    } else if (encLink.startsWith('/')) {
      streamUrl = `${config.upstreams.vidstuckBase}${encLink}`;
    }

    circuitBreaker.recordSuccess(providerKey);

    const referer = `${config.upstreams.zxcBase}/`;
    const proxiedUrl = buildProxyStreamUrl(streamUrl, referer);

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
      format: streamUrl.includes('.mp4') ? 'mp4' : 'hls',
      rawUrl: streamUrl,
      streamUrl: proxiedUrl,
      referer,
      headers: {
        Referer: referer,
        Origin: config.upstreams.zxcBase
      },
      audioTracks,
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
 * Helper: Decrypt VidSrc.sh ChaCha20 WebAssembly envelope (`vs.wasm` / `vs.wasm_url`)
 */
async function decryptVidsrcWasmPayload(wasmBytes, encryptedBase64, nonceKeyStr) {
  const mod = await WebAssembly.compile(wasmBytes);
  let mem;
  const inst = await WebAssembly.instantiate(mod, {
    env: {
      emscripten_notify_memory_growth() {}
    }
  });
  const ex = inst.exports;
  mem = ex.memory;

  // Set ChaCha20 key via exported `key()` function
  if (typeof ex.key === 'function') {
    const kp = ex.key();
    const kb = new Uint8Array(mem.buffer, kp, 32);
    const kh = '91d803885852299907d44c2f92822699c62f8b0f0a5c8d208190e0f102131415';
    for (let i = 0; i < 32; i++) {
      kb[i] = parseInt(kh.slice(i * 2, i * 2 + 2), 16);
    }
  }

  // Write nonce string (`stream_urls:TMDB` or `TMDB_S_E`)
  const nb = Buffer.from(String(nonceKeyStr), 'utf8');
  const np = ex.malloc(nb.length + 1);
  new Uint8Array(mem.buffer).set(nb, np);
  new Uint8Array(mem.buffer)[np + nb.length] = 0;
  ex.nonce(np);
  ex.free(np);

  // Write ciphertext & invoke `decrypt(ptr, len)`
  const ct = Buffer.from(encryptedBase64, 'base64');
  const ptr = ex.malloc(ct.length);
  new Uint8Array(mem.buffer).set(ct, ptr);
  const outPtr = ex.decrypt(ptr, ct.length);
  if (!outPtr) return null;

  const u8 = new Uint8Array(mem.buffer);
  let end = outPtr;
  while (end < u8.length && u8[end] !== 0) end++;
  const plainText = Buffer.from(mem.buffer, outPtr, end - outPtr).toString('utf8');
  return JSON.parse(plainText);
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
        const decrypted = await decryptVidsrcWasmPayload(
          wasmBytes,
          json.data.stream_urls,
          nonceKey
        );
        if (Array.isArray(decrypted)) {
          urls = decrypted;
        }
      }
    }

    urls = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (urls.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      return null;
    }

    // Stamp stream URLs with a fresh JWT from <streamOrigin>/generate.php
    let rawMasterUrl = urls[0];
    try {
      const parsed = new URL(rawMasterUrl);
      const genRes = await fetch(`${parsed.origin}/generate.php`, {
        headers: { 'User-Agent': USER_AGENT, Referer: referer },
        signal: controller.signal
      });
      if (genRes.ok) {
        const genJson = await genRes.json();
        if (genJson?.token) {
          urls = urls.map(
            (u) => `${u.split('?')[0]}?token=${encodeURIComponent(genJson.token)}`
          );
          rawMasterUrl = urls[0];
        }
      }
    } catch {
      // Some VidSrc CDN mirrors do not require generate.php token
    }

    circuitBreaker.recordSuccess(providerKey);

    const proxiedUrl = buildProxyStreamUrl(rawMasterUrl, referer);
    const qualities = [
      { label: 'Auto', height: 0, url: proxiedUrl },
      ...urls.map((u, idx) => ({
        label: idx === 0 ? '1080p' : idx === 1 ? '720p' : `Mirror ${idx + 1}`,
        height: idx === 0 ? 1080 : 720,
        url: buildProxyStreamUrl(u, referer)
      }))
    ];

    return {
      server: 'ursa',
      format: rawMasterUrl.includes('.mp4') || rawMasterUrl.includes('.mkv') ? 'mp4' : 'hls',
      rawUrl: rawMasterUrl,
      streamUrl: proxiedUrl,
      referer,
      headers: {
        Referer: referer,
        Origin: 'https://vidsrc.sh'
      },
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
 * Helper: Parse HiCine raw text block (`480p : https://...`) into quality -> link descriptors
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
    const qMatch = line.match(/(2160p|4k|1080p|720p|480p)/i);
    const qualityLabel = qMatch ? qMatch[1].toLowerCase() : '720p';
    const height =
      qualityLabel === '2160p' || qualityLabel === '4k'
        ? 2160
        : parseInt(qualityLabel, 10) || 720;

    // Match vcloud worker URLs (`https://...workers.dev/?vcloud=https://vcloud.fit/...`)
    const workerMatch = line.match(/(https?:\/\/[^\s,"']+\/\?vcloud=[^\s,"']+)/i);
    if (workerMatch) {
      results.push({
        type: 'vcloud_worker',
        quality: qualityLabel,
        height,
        url: workerMatch[1]
      });
    }

    // Match direct pixeldrain URLs (`https://pixeldrain.dev/u/ID` or `https://pixeldrain.com/u/ID`)
    const pdMatch = line.match(/https?:\/\/pixeldrain\.(?:dev|com)\/u\/([A-Za-z0-9]+)/i);
    if (pdMatch) {
      results.push({
        type: 'pixeldrain',
        quality: qualityLabel,
        height,
        url: `https://pixeldrain.dev/api/file/${pdMatch[1]}`
      });
    }
  }

  return results;
}

/**
 * Resolve a vcloud worker URL (`https://<worker>.workers.dev/?vcloud=https://vcloud.fit/...`)
 * into a direct downloadable/streamable CDN URL.
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

    // Try token types in order of reliability (`pixel`, `ten`, `r2`, `DDL`)
    for (const tokenType of ['pixel', 'ten', 'r2', 'DDL']) {
      const tok = tokens[tokenType];
      if (!tok || !tok.ts || !tok.sig) continue;

      const goUrl = `${workerBase}/go?type=${encodeURIComponent(tokenType)}&vcloud=${encodeURIComponent(vcloudParam)}&ts=${encodeURIComponent(tok.ts)}&sig=${encodeURIComponent(tok.sig)}`;
      const goRes = await fetch(goUrl, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal
      });

      const location = goRes.headers.get('location');
      if (location && /^https?:\/\//i.test(location)) {
        if (location.includes('pixeldrain.') && location.includes('/u/')) {
          const pdId = location.split('/u/')[1]?.split(/[?#]/)[0];
          if (pdId) return { url: `https://pixeldrain.dev/api/file/${pdId}`, title: data.title || '' };
        }
        return { url: location, title: data.title || '' };
      }
    }
    return null;
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
    // Filter by contentType and best title/year match
    const candidates = items.filter((item) => {
      if (isTv) return item.contentType === 'series' || item.season_1;
      return item.contentType === 'movies' || item.links;
    });

    const chosen =
      candidates.find((c) => {
        const titleMatch =
          String(c.title || '').toLowerCase() === String(metadata.title).toLowerCase();
        const yearMatch =
          !metadata.releaseYear ||
          !c.releaseYear ||
          Math.abs(Number(c.releaseYear) - Number(metadata.releaseYear)) <= 1;
        return titleMatch && yearMatch;
      }) ||
      candidates[0] ||
      items[0];

    if (!chosen) return null;

    const rawText = isTv
      ? chosen[`season_${metadata.season || 1}`] || chosen.season_1 || ''
      : chosen.links || '';

    const extracted = parseHicineLinks(rawText, isTv, metadata.episode || 1);
    if (extracted.length === 0) return null;

    // Resolve direct links (preferring 1080p/720p first)
    const sorted = [...extracted].sort((a, b) => b.height - a.height);
    const resolvedQualities = [];
    let releaseTitle = '';

    for (const entry of sorted) {
      if (entry.type === 'pixeldrain') {
        resolvedQualities.push({
          label: entry.quality,
          height: entry.height,
          rawUrl: entry.url,
          url: buildProxyStreamUrl(entry.url, 'https://pixeldrain.dev/')
        });
      } else if (entry.type === 'vcloud_worker' && resolvedQualities.length < 3) {
        const resolved = await resolveVcloudWorkerLink(entry.url, controller.signal);
        if (resolved?.url) {
          if (resolved.title) releaseTitle = resolved.title;
          resolvedQualities.push({
            label: entry.quality,
            height: entry.height,
            rawUrl: resolved.url,
            url: buildProxyStreamUrl(resolved.url, '')
          });
        }
      }
    }

    if (resolvedQualities.length === 0) return null;

    circuitBreaker.recordSuccess(providerKey);

    const primary = resolvedQualities[0];
    const hasMultiAudio = /multi|dual|hin|eng/i.test(releaseTitle);
    const audioTracks = [
      {
        id: 'hicine-en',
        lang: 'en',
        label: hasMultiAudio ? 'English (Dual Audio)' : 'Original Audio',
        type: 'dub',
        streamUrl: primary.url,
        rawUrl: primary.rawUrl,
        default: true
      }
    ];

    return {
      server: 'centaurus',
      format: 'mp4',
      rawUrl: primary.rawUrl,
      streamUrl: primary.url,
      referer: '',
      headers: {},
      audioTracks,
      qualities: resolvedQualities.map((q) => ({
        label: q.label,
        height: q.height,
        url: q.url
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

  // Build ordered waterfall starting with the user's selected server
  const serverOrder = [
    validServer,
    ...enabledServers.map((s) => s.id).filter((id) => id !== validServer)
  ];

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
      telemetry.recordServerAttempt(srvId, false, latencyMs, `No stream returned by ${srvId}`);
    }
  }

  return null;
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
