const crypto = require('crypto');
const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { decryptZxcLink } = require('../utils/crypto');
const { buildProxyStreamUrl } = require('./proxy');
const { prepareMultiTrackStream, normalizeAudioLanguage } = require('./multitrack');
const { telemetry } = require('./telemetry');
const identity = require('./identity');
const { resolveHamsterWheelServer } = require('./hamsterWheel');

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
 * Common Language Name -> ISO-639-1 code mapping for multi-audio tracks
 * (Indian regional languages, Asian dramas, Hollywood dubs).
 */
const LANGUAGE_NAME_TO_CODE = {
  hindi: 'hi', hin: 'hi',
  tamil: 'ta', tam: 'ta',
  telugu: 'te', tel: 'te',
  malayalam: 'ml', mal: 'ml',
  kannada: 'kn', kan: 'kn',
  bengali: 'bn', ben: 'bn', beng: 'bn',
  marathi: 'mr', mar: 'mr',
  punjabi: 'pa', pan: 'pa',
  urdu: 'ur', urd: 'ur',
  english: 'en', eng: 'en',
  korean: 'ko', kor: 'ko',
  japanese: 'ja', jpn: 'ja',
  chinese: 'zh', zho: 'zh', chi: 'zh', mandarin: 'zh', cantonese: 'zh',
  spanish: 'es', spa: 'es',
  french: 'fr', fra: 'fr', fre: 'fr',
  german: 'de', deu: 'de', ger: 'de',
  italian: 'it', ita: 'it',
  portuguese: 'pt', por: 'pt',
  russian: 'ru', rus: 'ru',
  thai: 'th', tha: 'th',
  indonesian: 'id', ind: 'id',
  turkish: 'tr', tur: 'tr',
  arabic: 'ar', ara: 'ar',
  vietnamese: 'vi', vie: 'vi'
};

function mapLanguageNameToCode(name) {
  if (!name) return 'und';
  const clean = String(name).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (LANGUAGE_NAME_TO_CODE[clean]) return LANGUAGE_NAME_TO_CODE[clean];
  return normalizeAudioLanguage(clean);
}

// In-memory cache for CastleTV AES security key
let cachedCastleKey = null;
let cachedCastleKeyExp = 0;

function buildCastleKey(securityKeyB64) {
  let km = Buffer.from(String(securityKeyB64 || ''), 'base64');
  km = Buffer.concat([km, Buffer.from('T!BgJB', 'utf8')]);
  if (km.length > 16) km = km.subarray(0, 16);
  else if (km.length < 16) km = Buffer.concat([km, Buffer.alloc(16 - km.length, 0)]);
  return km;
}

function decryptCastleAes(dataB64, key) {
  const raw = Buffer.from(String(dataB64 || '').trim(), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  decipher.setAutoPadding(true);
  try {
    return Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
  } catch {
    const d2 = crypto.createDecipheriv('aes-128-cbc', key, key);
    d2.setAutoPadding(false);
    return Buffer.concat([d2.update(raw), d2.final()]).toString('utf8');
  }
}

async function getCastleSecurityKey(castletvBase, signal) {
  if (cachedCastleKey && Date.now() < cachedCastleKeyExp) {
    return cachedCastleKey;
  }
  const url = `${castletvBase}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal
  });
  if (!res.ok) throw new Error(`Castle security key request failed HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 200 || !json.data) throw new Error('Castle security key empty');

  const km = buildCastleKey(json.data);
  cachedCastleKey = km;
  cachedCastleKeyExp = Date.now() + 15 * 60 * 1000;
  return km;
}

/**
 * Sub-provider 1 for Andromeda: CastleTV API (https://api.hlowb.com)
 * Premier source for South Indian movies (Tamil, Telugu, Malayalam, Kannada),
 * Bollywood / Pan-Indian Hindi dubs, K-Drama/C-Drama dubs, Anime, and Hollywood multi-audio.
 *
 * Identity: CastleTV search is plain-name only and its ranking is popularity
 * based, so a name search for "Fight Club" puts the 2023 Indian film (which has
 * a Hindi dub) ahead of the 1999 film the viewer asked for. Every candidate row
 * is therefore validated against the TMDB identity (title + original/alt
 * titles + release year + movie/series type) before it is used, and an
 * unverifiable search result is a provider miss instead of wrong content.
 */
const CASTLETV_RESOLVE_DEADLINE_MS = 9000;
const CASTLETV_TRACK_CONCURRENCY = 6;

function buildCastleSearchKeywords(metadata) {
  const seen = new Set();
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    keywords.push(text);
  };
  const keywords = [];
  const title = metadata.title || '';
  const year = metadata.releaseYear || metadata.year || '';
  push(year ? `${title} ${year}` : title);
  push(title);
  push(metadata.originalTitle);
  const alts = Array.isArray(metadata.alternativeTitles)
    ? metadata.alternativeTitles
    : Array.isArray(metadata.altTitles)
      ? metadata.altTitles
      : [];
  alts.slice(0, 2).forEach((alt) => push(typeof alt === 'string' ? alt : alt && (alt.title || alt.name)));
  return keywords.filter(Boolean).slice(0, 4);
}

function castleRowToCandidate(row) {
  return {
    id: String(row.id || row.redirectId || row.redirectIdStr || ''),
    title: row.title || row.name || '',
    year: row.publishTime || row.releaseDate || row.year || null,
    movieType: row.movieType,
    movieTypeName: row.movieTypeName,
    // Season/episode metadata lets the identity gate tell an anime film from
    // an anime series when the provider tags both as "anime".
    seasonDescription: row.seasonDescription || null,
    lastEpisodeCount: row.lastEpisodeCount != null ? row.lastEpisodeCount : null,
    isSeries: row.seasonDescription != null || Number(row.lastEpisodeCount) > 0 || null,
    languages: Array.isArray(row.languages) ? row.languages : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    rating: row.rating,
    popularity: row.score
  };
}

async function castletvSearchRows(castletvBase, keyword, signal) {
  const params = new URLSearchParams({
    channel: 'IndiaA',
    clientType: '1',
    keyword,
    lang: 'en',
    mode: '1',
    packageName: 'com.external.castle',
    page: '1',
    size: '30'
  });
  const res = await fetch(
    `${castletvBase}/film-api/v1.1.0/movie/searchByKeyword?${params.toString()}`,
    {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${castletvBase}/` },
      signal
    }
  );
  if (!res.ok) return [];
  const key = await getCastleSecurityKey(castletvBase, signal);
  const cipher = await res.text();
  try {
    const json = JSON.parse(decryptCastleAes(cipher, key));
    return (json?.data?.rows || []).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveCastletv(metadata, preferredAudio = '', parentSignal = null) {
  const castletvBase = (config.upstreams.castletvBase || 'https://api.hlowb.com').replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CASTLETV_RESOLVE_DEADLINE_MS);
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    if (!metadata || !metadata.title) return null;
    const key = await getCastleSecurityKey(castletvBase, controller.signal);

    // 1. Search with several identity keys (title+year, title, original and
    //    alternative titles) and union the rows before validating them.
    const rowsById = new Map();
    for (const keyword of buildCastleSearchKeywords(metadata)) {
      const rows = await castletvSearchRows(castletvBase, keyword, controller.signal);
      for (const row of rows) {
        const id = String(row.id || row.redirectId || row.redirectIdStr || '');
        if (id && !rowsById.has(id)) rowsById.set(id, row);
      }
      if (rowsById.size === 0) continue;
      // Stop early once an exact identity match is visible in the results.
      const early = identity.pickIdentityMatch(
        Array.from(rowsById.values()).map(castleRowToCandidate),
        metadata,
        { preferredAudio }
      );
      if (early.winner) break;
    }

    const candidates = Array.from(rowsById.values()).map(castleRowToCandidate);
    if (!candidates.length) return null;

    // 2. TMDB-anchored identity gate. No "first row" fallback: if nothing
    //    proves the identity we report a clean miss so the cascade continues.
    const picked = identity.pickIdentityMatch(candidates, metadata, { preferredAudio });
    if (!picked.winner) return null;

    const matched = picked.winner;
    const movieId = matched.id;
    if (!movieId) return null;

    // 3. Details for the verified title.
    const detRes = await fetch(
      `${castletvBase}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en&movieId=${movieId}&packageName=com.external.castle`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${castletvBase}/` },
        signal: controller.signal
      }
    );
    if (!detRes.ok) return null;
    let detJson = JSON.parse(decryptCastleAes(await detRes.text(), key));
    const isTv = metadata.type === 'tv';

    // TV catalogues keep one movieId per season; switch to the requested season
    // when CastleTV stores seasons as separate subjects.
    let activeId = movieId;
    if (isTv) {
      const seasonNumber = Number(metadata.season || 1);
      const seasonEntry = (detJson?.data?.seasons || []).find((s) => Number(s.number) === seasonNumber);
      if (seasonEntry && seasonEntry.movieId && String(seasonEntry.movieId) !== String(movieId)) {
        const seasonRes = await fetch(
          `${castletvBase}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en&movieId=${seasonEntry.movieId}&packageName=com.external.castle`,
          {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: `${castletvBase}/` },
            signal: controller.signal
          }
        );
        if (seasonRes.ok) {
          const seasonJson = JSON.parse(decryptCastleAes(await seasonRes.text(), key));
          if (seasonJson?.data?.episodes?.length) {
            detJson = seasonJson;
            activeId = String(seasonEntry.movieId);
          }
        }
      }
    }

    const episodes = detJson?.data?.episodes || [];
    const wantedEpisode = Number(metadata.episode || 1);
    const targetEpisode = isTv
      ? episodes.find((e) => Number(e.number) === wantedEpisode) || episodes[0]
      : episodes[0];
    if (!targetEpisode) return null;
    const episodeId = targetEpisode.id;

    const rawTracks =
      targetEpisode.tracks && targetEpisode.tracks.length > 0
        ? targetEpisode.tracks
        : [{ languageId: null, languageName: 'Original', videos: targetEpisode.videos || [] }];
    // Prefer per-language videos when CastleTV marks them, otherwise keep every
    // track so the complete dub list is exposed.
    const withIndividualVideo = rawTracks.filter((t) => t.existIndividualVideo === true);
    const tracks = withIndividualVideo.length > 0 ? withIndividualVideo : rawTracks;

    const referer = `${castletvBase}/`;
    const APK_SIGN_KEY = 'ED0955EB04E67A1D9F3305B95454FED485261475';

    const fetchTrackStream = async (track) => {
      for (const resolution of [3, 2, 1]) {
        try {
          const body = {
            mode: '1',
            appMarket: 'GuanWang',
            clientType: '1',
            woolUser: 'false',
            apkSignKey: APK_SIGN_KEY,
            androidVersion: '13',
            movieId: String(activeId),
            episodeId: String(episodeId),
            isNewUser: 'true',
            resolution: String(resolution),
            packageName: 'com.external.castle'
          };
          if (track.languageId != null) body.languageId = String(track.languageId);

          const vRes = await fetch(
            `${castletvBase}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en`,
            {
              method: 'POST',
              headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal
            }
          );
          if (!vRes.ok) continue;
          const vJson = JSON.parse(decryptCastleAes(await vRes.text(), key));
          const videoUrl = vJson?.data?.videoUrl || vJson?.data?.videos?.[0]?.url;
          if (!videoUrl) continue;
          const videos = (vJson?.data?.videos || [])
            .filter((v) => v && v.url)
            .map((v) => ({
              url: v.url,
              height: v.resolution === 4 ? 2160 : v.resolution === 3 ? 1080 : v.resolution === 2 ? 720 : 480
            }));
          return {
            languageId: track.languageId,
            languageName: track.languageName || track.abbreviate || 'Original',
            videoUrl,
            videos,
            subtitles: (vJson?.data?.subtitles || []).filter((s) => s && s.url)
          };
        } catch {
          // try the next resolution rung
        }
      }
      return null;
    };

    // Fetch every language track with bounded concurrency so all dubs survive.
    const streamByTrack = new Array(tracks.length).fill(null);
    for (let start = 0; start < tracks.length; start += CASTLETV_TRACK_CONCURRENCY) {
      const slice = tracks.slice(start, start + CASTLETV_TRACK_CONCURRENCY);
      const settled = await Promise.allSettled(slice.map((track) => fetchTrackStream(track)));
      settled.forEach((entry, index) => {
        if (entry.status === 'fulfilled' && entry.value) streamByTrack[start + index] = entry.value;
      });
      if (streamByTrack.some(Boolean) && controller.signal.aborted) break;
    }

    const resolvedTracks = streamByTrack.filter(Boolean);
    if (!resolvedTracks.length) {
      // Shared/legacy endpoint: one stream carrying the source default audio.
      const shared = await fetchTrackStream({ languageId: null, languageName: 'Original' });
      if (!shared) return null;
      resolvedTracks.push(shared);
    }

    const wantedCode = preferredAudio ? normalizeAudioLanguage(String(preferredAudio).trim().toLowerCase()) : '';

    const audioTracks = resolvedTracks.map((track, index) => {
      const langCode = mapLanguageNameToCode(track.languageName);
      const rawUrl = track.videoUrl;
      return {
        id: `castle-${track.languageId || langCode || index}`,
        lang: langCode,
        label: track.languageName || 'Original Audio',
        type: 'dub',
        streamUrl: buildProxyStreamUrl(rawUrl, referer, '', { mode: 'full' }),
        rawUrl,
        default: false
      };
    });

    const hindiTrack = audioTracks.find((track) => track.lang === 'hi');
    const preferredTrack = wantedCode
      ? audioTracks.find((track) => track.lang === wantedCode)
      : null;
    const defaultTrack = preferredTrack || hindiTrack || audioTracks[0];
    audioTracks.forEach((track) => {
      track.default = track === defaultTrack;
    });

    const activeTrack = defaultTrack;
    const qualitySource = resolvedTracks.find((t) => t.languageName === activeTrack.label) ||
      resolvedTracks.find((t) => buildProxyStreamUrl(t.videoUrl, referer, '', { mode: 'full' }) === activeTrack.streamUrl) ||
      resolvedTracks[0];
    const seenHeights = new Set();
    const qualities = [
      { label: 'Auto', height: 0, url: activeTrack.streamUrl },
      ...(qualitySource.videos || [])
        .slice()
        .sort((a, b) => (b.height || 0) - (a.height || 0))
        .filter((v) => {
          if (!v.height || seenHeights.has(v.height)) return false;
          seenHeights.add(v.height);
          return true;
        })
        .map((v) => ({
          label: `${v.height}p`,
          height: v.height,
          url: buildProxyStreamUrl(v.url, referer, '', { mode: 'full' })
        }))
    ];

    return {
      server: 'andromeda',
      sourceName: 'CastleTV',
      format: 'hls',
      rawUrl: activeTrack.rawUrl,
      streamUrl: activeTrack.streamUrl,
      referer,
      headers: { Referer: referer },
      backupUrls: [buildProxyStreamUrl(activeTrack.rawUrl, referer, '', { mode: 'manifest' })],
      audioTracks,
      qualities,
      downloadAudioTracks: audioTracks,
      identity: {
        provider: 'castletv',
        verified: true,
        matchedTitle: matched.title,
        matchedYear: matched.year ? identity.extractYearFromValue(matched.year) : null,
        upstreamId: String(movieId),
        activeUpstreamId: String(activeId),
        score: picked.winnerMatch ? picked.winnerMatch.score : null,
        reasons: picked.winnerMatch ? picked.winnerMatch.reasons : [],
        candidates: picked.ranked,
        rejectedCandidates: picked.rejected,
        altMatches: (picked.ranked || []).filter((entry) => !entry.accepted).slice(0, 5)
      }
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let cachedNetmirrorApiUrl = '';
let cachedNetmirrorExpiry = 0;
let cachedNetmirrorActiveReferer = '';

function getNetmirrorDiscoveryPool() {
  const configured = Array.isArray(config.upstreams.netmirrorDiscoveryUrls)
    ? config.upstreams.netmirrorDiscoveryUrls
    : [];
  const pool = [
    ...configured,
    'https://mobiledetect.app',
    'https://mobiledetects.com',
    'https://mobidetect.cc',
    'https://mobidetects.top',
    'https://getimgcdn.com',
    'https://mobidetect.art',
    'https://mobidetect.click',
    'https://mobidetect.ink',
    'https://mobidetect.live',
    'https://mobidetect.pro',
    'https://mobidetect.shop',
    'https://mobidetect.site',
    'https://mobidetect.space',
    'https://mobidetect.store',
    'https://mobidetect.vip',
    'https://mobidetect.wiki',
    'https://mobidetect.xyz',
    'https://mobidetects.art',
    'https://mobidetects.info',
    'https://mobidetects.pro',
    'https://mobidetects.store',
    'https://mobidetects.xyz'
  ]
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return [...new Set(pool)];
}

async function getNetmirrorApiBase(signal) {
  if (cachedNetmirrorApiUrl && Date.now() < cachedNetmirrorExpiry) {
    return cachedNetmirrorApiUrl;
  }
  const checkDomains = getNetmirrorDiscoveryPool();
  for (const base of checkDomains) {
    try {
      const res = await fetch(`${base}/checknewtv.php`, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*'
        },
        signal
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.token_hash) {
          const decoded = Buffer.from(data.token_hash, 'base64').toString('utf8').replace(/\/$/, '');
          if (decoded.startsWith('http')) {
            cachedNetmirrorApiUrl = decoded;
            cachedNetmirrorExpiry = Date.now() + 3600000;
            return decoded;
          }
        }
      }
    } catch {}
  }
  return cachedNetmirrorApiUrl || '';
}

/**
 * Sub-provider 3 for Andromeda: NetMirror (Dynamic NewTV Discovery & Rotating OTT Mirrors)
 * Dynamically discovers the active API endpoint and tracks live rotating web mirror domains (net27 -> net52 -> net77, etc.).
 */
async function resolveNetmirror(metadata, preferredAudio = '', parentSignal = null) {
  const configuredBase = (config.upstreams.netmirrorBase || '').replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const isTv = metadata.type === 'tv';

    // 1. Try NewTV dynamic OTT mirror API flow (Netflix, Prime, Hotstar)
    try {
      const apiBase = await getNetmirrorApiBase(controller.signal);
      if (apiBase) {
        const ottList = ['nf', 'pv', 'hs'];
        for (const ott of ottList) {
          try {
            const searchUrl = `${apiBase}/newtv/search.php?s=${encodeURIComponent(metadata.title || '')}`;
            const sRes = await fetch(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
                Accept: 'application/json, text/plain, */*',
                'X-Requested-With': 'NetmirrorNewTV v1.0',
                Ott: ott
              },
              signal: controller.signal
            });
            if (!sRes.ok) continue;
            const sJson = await sRes.json().catch(() => null);
            if (sJson?.img_referer) {
              cachedNetmirrorActiveReferer = sJson.img_referer.replace(/\/$/, '');
            }
            const results = sJson?.searchResult || [];
            if (!results.length) continue;

            const match = results[0];
            let targetId = match.id;

            if (isTv) {
              const postUrl = `${apiBase}/newtv/post.php?id=${match.id}`;
              const postRes = await fetch(postUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
                  Accept: 'application/json, text/plain, */*',
                  'X-Requested-With': 'NetmirrorNewTV v1.0',
                  Ott: ott
                },
                signal: controller.signal
              });
              if (postRes.ok) {
                const postJson = await postRes.json().catch(() => null);
                if (postJson?.img_referer) {
                  cachedNetmirrorActiveReferer = postJson.img_referer.replace(/\/$/, '');
                }
                const eps = (postJson?.episodes || []).filter(Boolean);
                const wantedS = metadata.season || 1;
                const wantedE = metadata.episode || 1;
                const found = eps.find((e) => {
                  const epNum = e.ep ? parseInt(e.ep) : e.epNum ? parseInt(e.epNum.replace(/[^0-9]/g, '')) : null;
                  const sNum = e.sNum ? parseInt(e.sNum.replace(/[^0-9]/g, '')) : null;
                  return (sNum ? sNum === wantedS : true) && epNum === wantedE;
                });
                if (found?.id) targetId = found.id;
              }
            }

            const playerUrl = `${apiBase}/newtv/player.php?id=${targetId}`;
            const pRes = await fetch(playerUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
                Accept: 'application/json, text/plain, */*',
                'X-Requested-With': 'NetmirrorNewTV v1.0',
                Ott: ott
              },
              signal: controller.signal
            });
            if (!pRes.ok) continue;
            const pJson = await pRes.json().catch(() => null);
            if (pJson && pJson.video_link) {
              const streamUrl = pJson.video_link;
              const dynamicReferer = pJson.referer ? pJson.referer.replace(/\/$/, '') : cachedNetmirrorActiveReferer;
              cachedNetmirrorActiveReferer = dynamicReferer;
              const referer = `${dynamicReferer}/`;
              const proxiedUrl = buildProxyStreamUrl(streamUrl, referer, '', { mode: 'full' });
              return {
                server: 'andromeda',
                sourceName: `NetMirror (${ott.toUpperCase()})`,
                format: 'hls',
                rawUrl: streamUrl,
                streamUrl: proxiedUrl,
                referer,
                headers: { Referer: referer },
                backupUrls: [buildProxyStreamUrl(streamUrl, referer, '', { mode: 'manifest' })],
                audioTracks: [
                  {
                    id: 'nm-default',
                    lang: 'en',
                    label: 'Original Audio (Multi-Track HLS)',
                    type: 'dub',
                    streamUrl: proxiedUrl,
                    rawUrl: streamUrl,
                    default: true
                  }
                ],
                qualities: [{ label: 'Auto', height: 0, url: proxiedUrl }]
              };
            }
          } catch {}
        }
      }
    } catch {}

    // 2. Direct embed-tmdb endpoint (TMDB-id keyed). The NewTV API base is
    // regressed upstream, so rotate through the web mirror pool until one
    // answers. `?type=tv&se=&ep=` (not s/e) is what the API honours.
    const webBases = [];
    const pushBase = (value) => {
      const clean = String(value || '').replace(/\/$/, '');
      if (clean.startsWith('http') && !webBases.includes(clean)) webBases.push(clean);
    };
    pushBase(configuredBase);
    pushBase(cachedNetmirrorActiveReferer);
    (config.upstreams.netmirrorWebMirrors || []).forEach(pushBase);

    for (const effectiveWebBase of webBases.slice(0, 5)) {
      try {
      const netflixUrl = isTv
        ? `${effectiveWebBase}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}?type=tv&se=${metadata.season || 1}&ep=${metadata.episode || 1}`
        : `${effectiveWebBase}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}`;

      const res = await fetch(netflixUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `${effectiveWebBase}/`,
          'User-Agent': USER_AGENT
        },
        redirect: 'follow',
        signal: controller.signal
      });

      if (!res.ok) continue;
      if (res.url) {
        try {
          const finalOrigin = new URL(res.url).origin;
          if (finalOrigin && finalOrigin.startsWith('http')) {
            cachedNetmirrorActiveReferer = finalOrigin;
          }
        } catch {}
      }
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        const streamUrl = data.streams?.[0]?.url || data.mp4;
        // NetMirror's primary CDN can rate-limit (HTTP 429); it also hands out
        // an HLS fallback and direct links, which are kept as backups.
        const alternateUrls = [
          typeof data.fallbackHls === 'string' ? data.fallbackHls : data.fallbackHls?.url,
          typeof data.direct === 'string' ? data.direct : data.direct?.url,
          data.cdn
        ].filter((value) => typeof value === 'string' && /^https?:/i.test(value));
        if (streamUrl) {
          const referer = `${cachedNetmirrorActiveReferer}/`;
          const proxiedUrl = buildProxyStreamUrl(streamUrl, referer, '', { mode: 'full' });
          const qualities = (data.streams || [])
            .filter((s) => s.url)
            .map((s) => ({
              label: s.resolution ? `${s.resolution}p` : 'Auto',
              height: Number(s.resolution || 1080),
              url: buildProxyStreamUrl(s.url, referer, '', { mode: 'full' })
            }));
          if (!qualities.length) {
            qualities.push({ label: 'Auto', height: 0, url: proxiedUrl });
          }

          const audioTracks = [
            {
              id: 'nm-default',
              lang: 'en',
              label: 'Original Audio (Multi-Track HLS)',
              type: 'dub',
              streamUrl: proxiedUrl,
              rawUrl: streamUrl,
              default: true
            }
          ];

          return {
            server: 'andromeda',
            sourceName: 'NetMirror',
            format: 'hls',
            rawUrl: streamUrl,
            streamUrl: proxiedUrl,
            referer,
            headers: { Referer: referer },
            backupUrls: [
              buildProxyStreamUrl(streamUrl, referer, '', { mode: 'manifest' }),
              ...alternateUrls.map((alt) => buildProxyStreamUrl(alt, referer, '', { mode: 'full' }))
            ],
            audioTracks,
            qualities
          };
        }
      }
      } catch {
        // dead mirror: try the next one
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Server 1 — Andromeda Multi-Audio Orchestrator
 * Cascades across the multi-audio sources in priority order:
 *   1. CastleTV (Priority 1: South Indian dubs, K-Drama/C-Drama, Anime, Hollywood)
 *   2. NetMirror (Priority 2: Netflix/Prime/Hotstar official platform streams)
 * If both fail, fails cleanly so the waterfall immediately hands playback to Server 2 (Ursa).
 * (The Moviebox tier was removed: the upstreams are region-blocked/unreliable.)
 */
async function resolveAndromedaServer(metadata, requestedServerId = 'andromeda', preferredAudio = '') {
  const providerKey = 'andromeda';
  if (!circuitBreaker.isAvailable(providerKey)) {
    return {
      ok: false,
      reason: 'circuit_open',
      diag: {
        stage: 'circuit_breaker',
        message: 'Andromeda is temporarily paused by the upstream circuit breaker. Failing over to next server.'
      }
    };
  }

  const diag = { stage: 'init', steps: [] };
  const stamp = (stage, message, extra) => {
    diag.stage = stage;
    diag.steps.push({ stage, message, ...(extra || {}) });
    diag.message = message;
  };

  // 1. Priority 1: CastleTV
  stamp('castletv_attempt', 'Querying CastleTV multi-audio upstream...');
  try {
    const castleRes = await resolveCastletv(metadata, preferredAudio);
    if (castleRes && castleRes.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      stamp('castletv_success', `CastleTV resolved ${castleRes.audioTracks.length} audio track(s).`);
      return { ok: true, ...castleRes, diag };
    }
    stamp('castletv_miss', 'CastleTV returned no playable streams for this title.');
  } catch (err) {
    stamp('castletv_error', `CastleTV failed: ${err.message}`);
  }

  // 2. Priority 2: NetMirror
  stamp('netmirror_attempt', 'Querying NetMirror OTT upstream...');
  try {
    const nmRes = await resolveNetmirror(metadata, preferredAudio);
    if (nmRes && nmRes.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      stamp('netmirror_success', 'NetMirror resolved official OTT stream.');
      return { ok: true, ...nmRes, diag };
    }
    stamp('netmirror_miss', 'NetMirror returned no playable streams for this title.');
  } catch (err) {
    stamp('netmirror_error', `NetMirror failed: ${err.message}`);
  }

  // 3. Test/Mock Fallback: if VidStuck is explicitly pointed to a local mock (e.g. test suite)
  if (config.upstreams.vidstuckBase && /127\.0\.0\.1|localhost/i.test(config.upstreams.vidstuckBase)) {
    stamp('vidstuck_mock_attempt', 'Attempting local VidStuck mock fallback...');
    const vsRes = await resolveVidstuckServer(metadata, 'andromeda');
    if (vsRes && vsRes.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      return { ok: true, ...vsRes, diag };
    }
  }

  // All sub-providers failed: record failure and hand off to Server 2 (Ursa)
  circuitBreaker.recordFailure(providerKey);
  stamp('andromeda_exhausted', 'All Andromeda sub-providers (CastleTV, NetMirror) failed to resolve a stream.');
  return {
    ok: false,
    reason: 'andromeda_all_sources_exhausted',
    diag
  };
}

/**
 * 1. VidStuck / ZXC Upstream Resolver (Atlas / Legacy Backup)
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

  // Internal diagnostic — stamp structured failure details for API consumers.
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
    const upstreamAudioTracks = Array.isArray(srvJson?.data?.audioTracks)
      ? srvJson.data.audioTracks
      : [];
    const defaultAudioIndex = upstreamAudioTracks.findIndex(
      (track) => track.default === true || track.default === 1 || track.default === '1'
    );
    const audioTracks = upstreamAudioTracks.length
      ? upstreamAudioTracks.map((t, idx) => {
          let trackRawUrl = streamUrl;
          if (t.url) {
            try {
              trackRawUrl = new URL(t.url, vidstuckBase).toString();
            } catch {
              trackRawUrl = streamUrl;
            }
          }
          return {
            id: t.id || `audio-${idx}`,
            lang: t.lang || 'en',
            label: t.label || t.name || `Audio ${idx + 1}`,
            type: t.type || 'sub',
            streamUrl: t.url
              ? buildProxyStreamUrl(trackRawUrl, referer, '', {
                  mode: 'full',
                  cookie: cookieHeader
                })
              : proxiedUrl,
            rawUrl: trackRawUrl,
            default: defaultAudioIndex === -1 ? idx === 0 : idx === defaultAudioIndex
          };
        })
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
    // cannot compile wasm. Return the sealed envelope for a trusted API client
    // to process in its browser and relay through /api/proxy with vidsrcStamp=1
    // and mode=full.
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
 * HubCloud generator unroller (Centaurus / HiCine).
 *
 * Root Cause E: HiCine's `ten` tokens terminate on a HubCloud *link generator*
 * landing page instead of a media file:
 *
 *   /go → https://gpdl2.hubcloud.ist/?id=…::token   (3-4s countdown HTML page)
 *       → https://gamerxyt.com/dl.php?link=<video-downloads.googleusercontent.com/…>
 *       → direct MKV/MP4 on a real CDN
 *
 * The landing page only reveals its "Download Here" target via client-side JS,
 * which `<video src>` / `fetch()` cannot execute, so every quality and backup
 * URL answered `text/html`, the player walked the whole ladder, and the embed
 * toasted "All upstream servers failed to play this stream."
 *
 * The unroll is pure HTTP — ground truth: MNTGXO/hubcloud-bypasser performs no
 * countdown wait at all, because the generator either 302-redirects to
 * `dl.php?link=<direct>` (final URL rides in the query string) or embeds the
 * final CDN link in the landing HTML (R2 / cloudflarestorage / cloudfront /
 * workers.dev / pixeldrain / video-downloads.googleusercontent.com / direct
 * media files). Nested generators (`hubcloud.<tld>/drive/<id>` → `<a id="download">`
 * → another generator) are followed up to HUBCLOUD_UNROLL_MAX_DEPTH hops, and
 * results are cached for 10 minutes because HubCloud tokens are short-lived.
 *
 * Mirrors cloudflare-worker/worker.js one-to-one — keep both in sync.
 */
const HUBCLOUD_UNROLL_TTL_MS = 600000; // 10 minutes
const HUBCLOUD_UNROLL_MAX_DEPTH = 4;
const HUBCLOUD_UNROLL_BUDGET_MS = 6000; // hard cap per resolve-step
const HUBCLOUD_UNROLL_BODY_CAP = 600 * 1024;
const HUBCLOUD_UNROLL_ALT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const hubcloudUnrollCache = new Map(); // generatorUrl -> { direct, exp }

function isHubcloudGeneratorUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (
      /\.(mp4|mkv|webm|m4v|m3u8|mpd)$/i.test(url.pathname) &&
      !url.searchParams.has('link') &&
      !url.searchParams.has('id')
    ) {
      return false;
    }
    return (
      /(^|\.)hubcloud\./.test(host) ||
      /(^|\.)hubcdn\./.test(host) ||
      /(^|\.)gamerxyt\.com$/.test(host) ||
      /^gpdl\d*\./.test(host) ||
      // MoviesDrive now links through HubCloud's browser-only recovery path;
      // keep recognizing it even when the page resolves a relative href on a
      // MoviesDrive host before the endpoint redirects to hubcloud.ist.
      /\/drive\/search-recover\.php$/i.test(url.pathname) ||
      (/\/drive\/[A-Za-z0-9_-]+$/i.test(url.pathname) && /(?:hubcloud|moviesdrive)/i.test(host)) ||
      // third-party hosts reuse the HubCloud wrapper scripts verbatim
      /\/(?:hubcloud|hubcdn)\.php(?:\?|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Extract the target of a `dl.php?link=…`-style wrapper without corrupting
 * already-encoded targets: a value that literally starts with `http(s)://`
 * is returned untouched (its `%xx` sequences belong to the target), only a
 * percent-encoded value is decoded.
 */
function extractQueryHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* malformed encoding — keep looking */
  }
  return '';
}

function extractHttpLinkParam(u) {
  const value = String(u || '').replace(/&amp;/gi, '&');
  for (const name of ['link', 'url']) {
    const match = value.match(new RegExp(`[?&]${name}=([^&#\s]+)`, 'i'));
    if (match) {
      const target = extractQueryHttpUrl(match[1]);
      if (target) return target;
    }
    try {
      const parsed = new URL(value);
      const target = extractQueryHttpUrl(parsed.searchParams.get(name));
      if (target) return target;
    } catch {
      /* malformed URL */
    }
  }
  return '';
}

function decodeBase64UrlParam(value) {
  try {
    let clean = String(value || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!clean) return '';
    clean += '='.repeat((4 - (clean.length % 4)) % 4);
    const decoded = Buffer.from(clean, 'base64').toString('utf8').trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
    try {
      const uriDecoded = decodeURIComponent(decoded);
      if (/^https?:\/\//i.test(uriDecoded)) return uriDecoded;
    } catch {}
  } catch {
    /* invalid base64 */
  }
  return '';
}

/** Extract raw targets embedded in common HubCloud and pages.dev wrappers. */
function extractWrappedMediaTargets(u) {
  const targets = [];
  const add = (value) => {
    const target = extractQueryHttpUrl(value);
    if (target && !targets.includes(target)) targets.push(target);
  };
  const rawUrl = String(u || '').replace(/&amp;/gi, '&');
  for (const name of ['link', 'url']) {
    const match = rawUrl.match(new RegExp(`[?&]${name}=([^&#\s]+)`, 'i'));
    if (match) add(match[1]);
    try {
      const parsed = new URL(rawUrl);
      add(parsed.searchParams.get(name));
    } catch {}
  }
  try {
    const parsed = new URL(rawUrl);
    if (/(^|\.)pages\.dev$/i.test(parsed.hostname)) {
      const encoded = parsed.searchParams.get('u') || '';
      const decoded = decodeBase64UrlParam(encoded.replace(/\s/g, '+'));
      if (decoded && !targets.includes(decoded)) targets.push(decoded);
    }
  } catch {}
  return targets;
}

/** File hosts that answer with an HTML page no `<video>` element can play. */
const HUBCLOUD_UNPLAYABLE_HOST_RE =
  /(^|\.)(mega\.nz|mediafire\.com|dropbox\.com|gofile\.io|drive\.google\.com|docs\.google\.com)$/i;

/**
 * Score a candidate as a *terminal* playable URL. -1 = not playable directly
 * (generator page, HTML file host, or garbage). Higher = preferred source:
 * Google's video CDN first, then Cloudflare R2/CDN, then workers.dev, then
 * any direct media file, then pixeldrain (hotlink-gated, last resort).
 */
function scorePlayableUrl(u) {
  if (!u || typeof u !== 'string') return -1;
  let href;
  let host;
  let pathname;
  try {
    const parsed = new URL(u);
    href = parsed.href;
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    return -1;
  }
  if (isHubcloudGeneratorUrl(href)) return -1;
  if (HUBCLOUD_UNPLAYABLE_HOST_RE.test(host)) return -1;

  if (/(^|\.)workers\.dev$/i.test(host) && /[?&]vcloud=/i.test(href)) return -1;
  if (/(^|\.)googleusercontent\.com$/i.test(host)) return 100;
  if (/(^|\.)r2\.dev$/i.test(host)) return 95;
  if (/(^|\.)r2\.cloudflarestorage\.com$/i.test(host) || /(^|\.)cloudflarestorage\.com$/i.test(host)) return 92;
  if (/(^|\.)cloudfront\.net$/i.test(host)) return 90;
  if (/(^|\.)storage\.googleapis\.com$/i.test(host)) return 88;
  if (/(^|\.)pixeldrain\.(?:com|dev)$/i.test(host) && /^\/(?:u|api\/file)\/[A-Za-z0-9_-]+/i.test(pathname)) return 75;
  if (/(^|\.)workers\.dev$/i.test(host)) return 60;
  if (!/(^|\.)workers\.dev$/i.test(host) && /\.(?:mp4|mkv|webm|m4v|m3u8|mpd)$/i.test(pathname)) return 80;
  return -1;
}

/** Pixeldrain share pages `/u/ID` → direct download API endpoint. */
function normalizePlayableUrl(u) {
  try {
    const url = new URL(u);
    if (/(^|\.)pixeldrain\.(?:com|dev)$/i.test(url.hostname.toLowerCase())) {
      const share = url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)/i);
      const api = url.pathname.match(/^\/api\/file\/([A-Za-z0-9_-]+)/i);
      if (share) return `${url.origin}/api/file/${share[1]}?download`;
      if (api && !url.searchParams.has('download')) {
        return `${url.origin}${url.pathname}${url.search ? `${url.search}&download` : '?download'}`;
      }
    }
    return url.href;
  } catch {
    return u;
  }
}

function isLocalTestMediaUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.test') ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
}

async function readProbePrefix(response, maxBytes = 4096) {
  const reader = response?.body?.getReader?.();
  if (!reader) return '';
  try {
    const { value } = await reader.read();
    if (!value) return '';
    return new TextDecoder('utf-8', { fatal: false }).decode(value.subarray(0, maxBytes)).toLowerCase();
  } catch {
    return '';
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

/**
 * Verify that a resolved candidate behaves like media before exposing it to
 * `<video>`. Local mock URLs are deliberately trusted so offline tests stay
 * deterministic; public candidates get a short byte-range GET.
 */
async function probePlayableMediaUrl(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let url;
  try {
    url = new URL(rawUrl).href;
  } catch {
    return false;
  }
  if (isLocalTestMediaUrl(url)) return true;
  const {
    signal,
    deadline,
    timeoutMs = 2500,
    headers = {},
    fetchImpl = fetch
  } = options;
  const remaining = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
  if (remaining < 100 || signal?.aborted) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Range: 'bytes=0-1023',
        ...headers
      },
      redirect: 'follow',
      signal: controller.signal
    });
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (
      response.status >= 400 ||
      ![200, 206].includes(response.status) ||
      /text\/html|application\/(?:xhtml\+xml|json)/i.test(contentType)
    ) {
      try { await response.body?.cancel?.(); } catch {}
      return false;
    }
    const prefix = await readProbePrefix(response);
    if (
      /<\s*!doctype\s+html|<\s*html\b|<\s*body\b|download\s*quota\s*exceeded|downloadquotaexceeded|access\s+denied|token\s+expired|file\s+not\s+found/i.test(prefix)
    ) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
    try { await response?.body?.cancel?.(); } catch {}
  }
}

/**
 * Collect every URL a generator page might be hiding: `href`/`src`/`action`
 * attributes, bare URLs in text/JS, and base64 `atob("…")` payloads. JS
 * string escapes (`\/`, `\u002F`, `\x2F`) are normalized first so URLs built
 * by obfuscated inline scripts become visible to the scanner.
 */
function collectGeneratorCandidates(html, pageUrl) {
  const normalized = String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002[Ff]/g, '/')
    .replace(/\\x2[Ff]/g, '/')
    .replace(/&amp;/g, '&');
  const out = new Set();
  const tryAdd = (cand) => {
    if (!cand) return;
    try {
      out.add(new URL(String(cand).trim(), pageUrl).href);
    } catch {
      /* not a URL */
    }
  };
  for (const m of normalized.matchAll(/(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)) {
    tryAdd(m[1]);
  }
  // Redirectors use all of these forms, including computed property access:
  // `var url = ...`, `location.href = ...`, `location['href'] = ...`, and
  // `window.location.replace(...)`. Keep this a parser, never execute page JS.
  for (const m of normalized.matchAll(/(?:\b(?:var|let|const)\s+)?url\s*=\s*["']([^"']+)["']/gi)) {
    tryAdd(m[1]);
  }
  for (const m of normalized.matchAll(/location\s*(?:\.\s*href|\[\s*["']href["']\s*\])\s*=\s*["']([^"']+)["']/gi)) {
    tryAdd(m[1]);
  }
  for (const m of normalized.matchAll(/(?:location|window\.location)\s*\.?(?:replace|assign)\s*\(\s*["']([^"']+)["']\s*\)/gi)) {
    tryAdd(m[1]);
  }
  for (const m of normalized.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    tryAdd(m[0].replace(/[.,;:]+$/, ''));
  }

  // A few greenmotors generations put a base64 URL in atob(), sometimes
  // wrapping it in one more base64/URI layer. Decode only bounded strings and
  // feed every decoded layer back through the same URL scanner.
  const inlineB64 = [...normalized.matchAll(/\batob\(\s*["']([A-Za-z0-9+/_=-]{12,})["']\s*\)/gi)];
  for (const m of inlineB64) {
    let payload = m[1];
    for (let depth = 0; depth < 4 && payload; depth += 1) {
      const decoded = b64DecodeUtf8(payload);
      if (!decoded) break;
      for (const d of decoded.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
        tryAdd(d[0].replace(/[.,;:]+$/, ''));
      }
      for (const d of decoded.matchAll(/(?:[?&](?:url|link)=)([^\s"'<>]+)/gi)) {
        tryAdd(d[1].replace(/[),;]+$/, ''));
      }
      const next = decoded.trim();
      if (/^https?:\/\//i.test(next)) break;
      if (!/^[A-Za-z0-9+/_=-]{12,}$/.test(next)) break;
      payload = next;
    }
  }
  return out;
}

/**
 * Pick the terminal CDN URL out of a generator page, or — when the page only
 * links to another wrapper — the next hop to recurse into. Countdown pages
 * link to themselves; self-references are skipped so the walk always moves.
 */
function pickFromGeneratorHtml(html, pageUrl) {
  const directByUrl = new Map();
  const generatorSet = new Set();
  const considerDirect = (candidate) => {
    const score = scorePlayableUrl(candidate);
    if (score < 0) return;
    const normalized = normalizePlayableUrl(candidate);
    const previous = directByUrl.get(normalized);
    if (!previous || score > previous.score) directByUrl.set(normalized, { url: normalized, score });
  };

  for (const cand of collectGeneratorCandidates(html, pageUrl)) {
    if (cand === pageUrl) continue;
    const wrappedTargets = extractWrappedMediaTargets(cand);
    if (wrappedTargets.length > 0) {
      for (const target of wrappedTargets) {
        if (scorePlayableUrl(target) >= 0) considerDirect(target);
        else if (isHubcloudGeneratorUrl(target) || extractWrappedMediaTargets(target).length) generatorSet.add(target);
      }
      if (isHubcloudGeneratorUrl(cand)) generatorSet.add(cand);
      continue;
    }
    if (isHubcloudGeneratorUrl(cand)) {
      generatorSet.add(cand);
      continue;
    }
    considerDirect(cand);
  }

  const directCandidates = [...directByUrl.values()]
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url);
  const generatorCandidates = [...generatorSet];
  return {
    direct: directCandidates[0] || null,
    directCandidates,
    generator: generatorCandidates[0] || null,
    generatorCandidates
  };
}

/**
 * HubCloud's newer `/drive/search-recover.php` is not a normal generator page:
 * it renders "query locked" and asks browser JavaScript to call a second XHR.
 * Discover that endpoint from the page instead of looking for the old
 * `var url = ...` marker. This deliberately accepts only URL-looking strings
 * used by fetch/XHR helpers, so arbitrary page text is never requested.
 */
function extractHubcloudXhrEndpoints(html, pageUrl) {
  const normalized = String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002[Ff]/g, '/')
    .replace(/\\x2[Ff]/g, '/');
  const endpoints = new Set();
  const add = (candidate) => {
    if (!candidate || /\$\{|\b(?:javascript|data):/i.test(candidate)) return;
    try {
      const resolved = new URL(candidate, pageUrl);
      if (!/^https?:$/i.test(resolved.protocol)) return;
      if (/\/drive\/search-recover\.php$/i.test(resolved.pathname)) return;
      endpoints.add(resolved.href);
    } catch {
      /* not an endpoint */
    }
  };
  const patterns = [
    /(?:fetch|axios\.(?:get|post|request)|\$\.(?:get|getJSON|post|ajax))\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\.open\s*\(\s*["'`][^"'`]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi,
    /(?:url|uri|endpoint|apiUrl|requestUrl)\s*:\s*["'`]([^"'`]+)["'`]/gi,
    /["'`](\/[^"'`]*(?:search|recover|ajax|api)[^"'`]*)["'`]/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) add(match[1]);
  }
  return [...endpoints];
}

function addHubcloudSearchContext(endpoint, startUrl) {
  try {
    const target = new URL(endpoint);
    const source = new URL(startUrl);
    for (const name of ['from_ac', 'q', 'query', 'key']) {
      if (!target.searchParams.has(name) && source.searchParams.has(name)) {
        target.searchParams.set(name, source.searchParams.get(name));
      }
    }
    return target.href;
  } catch {
    return endpoint;
  }
}

function extractHubcloudResponseTargets(body, pageUrl) {
  const targets = new Set();
  const add = (value) => {
    if (!value || /\$\{|\b(?:javascript|data):/i.test(value)) return;
    try {
      const resolved = new URL(value, pageUrl).href;
      if (/^https?:\/\//i.test(resolved)) targets.add(resolved);
    } catch {}
  };
  for (const match of String(body || '').matchAll(/(?:["'](?:url|link|href|location)["']\s*:\s*|\b(?:url|link|href|location)\s*=\s*["'])([^"']+)(?:["'])/gi)) {
    add(match[1]);
  }
  for (const match of String(body || '').matchAll(/(?:https?:\/\/|\/)(?:[^\s"'<>]+\/)?(?:drive|api|download)\/[^\s"'<>]+/gi)) {
    add(match[0]);
  }
  return [...targets];
}

async function resolveHubcloudSearchRecoverPage(html, pageUrl, options = {}) {
  const endpoints = extractHubcloudXhrEndpoints(html, pageUrl)
    .map((endpoint) => addHubcloudSearchContext(endpoint, pageUrl));
  for (const endpoint of Array.from(new Set(endpoints)).slice(0, 6)) {
    const response = await fetchWithDeadline(
      endpoint,
      USER_AGENT,
      options.signal,
      options.deadline,
      { headers: { ...options.headers, Referer: pageUrl, Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' } }
    );
    if (!response) continue;
    const finalUrl = response.url || endpoint;
    let body = '';
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (response.ok && (/json|html|text|javascript|xml/i.test(contentType) || !contentType)) {
      body = await readCappedText(response);
    }
    if (!body && extractHttpLinkParam(finalUrl)) body = finalUrl;
    if (!body) continue;

    // XHR responses are often JSON with a relative `{url:"/drive/<id>"}`.
    // The generic HTML scanner intentionally ignores arbitrary relative text,
    // so inspect these response fields explicitly before scanning HTML/JSON.
    for (const target of extractHubcloudResponseTargets(body, finalUrl).slice(0, 8)) {
      const normalized = normalizePlayableUrl(target);
      if (scorePlayableUrl(normalized) >= 0) {
        const playable = await pickPlayableGeneratorCandidate({ directCandidates: [normalized] }, options);
        if (playable) return playable;
      }
      if (isHubcloudGeneratorUrl(target) || /\/drive\//i.test(target)) {
        const unrolled = await unrollHubcloudUrl(target, {
          ...options,
          depth: (options.depth || 0) + 1
        });
        if (unrolled) return unrolled;
      }
    }

    const pick = pickFromGeneratorHtml(body, finalUrl);
    const direct = await validateGeneratorPick(pick, options);
    if (direct) return direct;
    const next = pick?.generatorCandidates || [];
    for (const candidate of next.slice(0, 4)) {
      const unrolled = await unrollHubcloudUrl(candidate, {
        ...options,
        depth: (options.depth || 0) + 1
      });
      if (unrolled) return unrolled;
    }
  }
  return null;
}

async function pickPlayableGeneratorCandidate(pick, options = {}) {
  if (!pick) return null;
  const candidates = Array.from(new Set(pick.directCandidates || (pick.direct ? [pick.direct] : [])));
  if (candidates.length === 0) return null;
  const checked = await Promise.all(
    candidates.slice(0, 8).map(async (url) => ({
      url,
      playable: await probePlayableMediaUrl(url, options)
    }))
  );
  const winner = checked.find((candidate) => candidate.playable);
  return winner ? normalizePlayableUrl(winner.url) : null;
}

/**
 * Fetch with a hard deadline: `deadline` (epoch ms) bounds the whole unroll,
 * `outerSignal` (when present) aborts together with the caller's controller.
 */
async function fetchWithDeadline(url, userAgent, outerSignal, deadline, fetchOptions = {}) {
  const remaining = deadline - Date.now();
  if (remaining < 400 || outerSignal?.aborted) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(4000, remaining));
  const onAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener?.('abort', onAbort);
  try {
    return await fetch(url, {
      ...fetchOptions,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(fetchOptions.headers || {})
      },
      redirect: fetchOptions.redirect || 'follow',
      signal: ctrl.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener?.('abort', onAbort);
  }
}

/** Read at most `cap` bytes of a response body (landing pages only). */
async function readCappedText(res, cap = HUBCLOUD_UNROLL_BODY_CAP) {
  try {
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > 2 * 1024 * 1024) return ''; // a binary file, not a landing page
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      const text = await res.text();
      return text.length > cap ? text.slice(0, cap) : text;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let out = '';
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    try {
      await reader.cancel();
    } catch {
      /* already consumed */
    }
    return out.length > cap ? out.slice(0, cap) : out;
  } catch {
    return '';
  }
}

/**
 * Cloudflare managed-challenge interstitial ("Just a moment…"). Datacenter
 * fetchers (Workers, VPS) get this instead of the landing page on some
 * generator zones — it never contains a download link, so scanning it is
 * wasted work and the fetch must be treated as failed (→ UA retry below).
 */
function isCfChallengePage(html) {
  const h = String(html || '').toLowerCase();
  if (!h) return false;
  return (
    h.includes('cf-chl') ||
    h.includes('_cf_chl') ||
    h.includes('challenge-platform') ||
    h.includes('cf-turnstile') ||
    h.includes('verify_turnstile') ||
    h.includes('just a moment') ||
    h.includes('performing security verification') ||
    h.includes('enable javascript and cookies to continue') ||
    h.includes('attention required') ||
    h.includes('checking your browser') ||
    h.includes('cf_mitigation')
  );
}

/** DDoS-Guard's interstitial is HTML with no usable provider links. */
function isDdosGuardPage(html) {
  const h = String(html || '').toLowerCase();
  if (!h) return false;
  return (
    h.includes('ddos-guard') ||
    h.includes('ddos_guard') ||
    h.includes('ddosguard') ||
    h.includes('checking your browser before accessing') ||
    h.includes('please wait while your request is being verified') ||
    h.includes('jschl-answer') ||
    h.includes('ddos protection')
  );
}

function isAntiBotPage(html) {
  return isCfChallengePage(html) || isDdosGuardPage(html);
}

/** Browser navigation headers used by 4KHDHub/MoviesDrive anti-bot pages. */
function fourKBrowserHeaders(referer = '', accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8') {
  return {
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {})
  };
}

/** Follow one `?link=` hop: recurse into wrappers, accept terminal URLs. */
async function resolveLinkInner(inner, opts = {}) {
  if (!inner || (opts.depth || 0) > HUBCLOUD_UNROLL_MAX_DEPTH) return null;
  const wrappedTargets = extractWrappedMediaTargets(inner).filter((target) => target !== inner);
  for (const target of wrappedTargets) {
    const resolved = await resolveLinkInner(target, { ...opts, depth: (opts.depth || 0) + 1 });
    if (resolved) return resolved;
  }
  if (isHubcloudGeneratorUrl(inner)) {
    return unrollHubcloudUrl(inner, { ...opts, depth: (opts.depth || 0) + 1 });
  }
  const playableUrl = normalizePlayableUrl(inner);
  if (scorePlayableUrl(playableUrl) >= 0 && await probePlayableMediaUrl(playableUrl, opts)) {
    return playableUrl;
  }
  return null;
}

async function validateGeneratorPick(pick, options = {}) {
  const direct = await pickPlayableGeneratorCandidate(pick, options);
  if (direct) return direct;
  if ((options.depth || 0) >= HUBCLOUD_UNROLL_MAX_DEPTH) return null;
  const generators = Array.from(new Set(pick?.generatorCandidates || (pick?.generator ? [pick.generator] : [])));
  const attempts = await Promise.all(
    generators.slice(0, 6).map((generator) =>
      unrollHubcloudUrl(generator, { ...options, depth: (options.depth || 0) + 1 })
    )
  );
  return attempts.find(Boolean) || null;
}

/**
 * Resolve a HubCloud generator URL to the direct, playable CDN URL.
 * Returns the direct URL, or `null` when the generator could not be unrolled
 * (caller keeps the previous URL — no behaviour change on failure).
 *
 * `options`: { signal?, depth?, deadline? } — deadline is an absolute epoch
 * ms budget shared across every hop of one resolve step.
 */
async function unrollHubcloudUrl(startUrl, options = {}) {
  if (!startUrl || typeof startUrl !== 'string') return null;
  const depth = options.depth || 0;
  if (depth > HUBCLOUD_UNROLL_MAX_DEPTH) return null;

  const deadline = options.deadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS;
  const cached = hubcloudUnrollCache.get(startUrl);
  if (cached) {
    if (Date.now() < cached.exp && await probePlayableMediaUrl(cached.direct, { ...options, deadline })) {
      return cached.direct;
    }
    hubcloudUnrollCache.delete(startUrl);
  }
    const direct = await unrollHubcloudUncached(startUrl, {
      ...options,
      signal: options.signal,
      headers: options.headers || {},
      depth,
      deadline
    });
  if (direct) {
    hubcloudUnrollCache.set(startUrl, { direct, exp: Date.now() + HUBCLOUD_UNROLL_TTL_MS });
    if (hubcloudUnrollCache.size > 256) {
      const oldest = hubcloudUnrollCache.keys().next().value;
      if (oldest) hubcloudUnrollCache.delete(oldest);
    }
  }
  return direct;
}

async function unrollHubcloudUncached(startUrl, opts) {
  const { signal, headers = {}, depth, deadline } = opts;
  try {
    // 1) `dl.php?link=…` wrappers carry the final URL in the query string —
    //    no fetch needed at all when the Location itself is one.
    const entryInner = extractHttpLinkParam(startUrl);
    if (entryInner) {
      const resolved = await resolveLinkInner(entryInner, opts);
      if (resolved) return resolved;
    }
    for (const target of extractWrappedMediaTargets(startUrl)) {
      if (target === entryInner) continue;
      const resolved = await resolveLinkInner(target, opts);
      if (resolved) return resolved;
    }

    // 2) fetch the generator page, following HTTP redirects (some generator
    //    hosts 302 straight to `dl.php?link=<direct>` — no JS involved).
    const res = await fetchWithDeadline(startUrl, USER_AGENT, signal, deadline, { headers });
    if (!res) return null;
    const finalUrl = res.url || startUrl;

    if (finalUrl !== startUrl) {
      const inner = extractHttpLinkParam(finalUrl);
      if (inner) {
        const resolved = await resolveLinkInner(inner, opts);
        if (resolved) return resolved;
      }
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isPage =
      !contentType ||
      /^(?:text\/|application\/(?:json|xhtml|xml|javascript))/i.test(contentType) ||
      /html|xml/i.test(contentType);
    if (!isPage) {
      // Binary body after redirect → verify the final URL before returning it.
      if (scorePlayableUrl(finalUrl) >= 0 && await probePlayableMediaUrl(finalUrl, { signal, deadline, headers })) {
        return normalizePlayableUrl(finalUrl);
      }
      return null;
    }

    // 3) scan the raw landing HTML for the final CDN link — it is present in
    //    the source even while the countdown hides it (meta-refresh target,
    //    inline script, hidden/JS-filled anchor, atob payload).
    let html = '';
    if (res.ok) {
      html = await readCappedText(res);
      if (isCfChallengePage(html)) html = ''; // challenge interstitial — no links
    }

    // New HubCloud recovery pages intentionally contain no `var url=`. Their
    // browser-only XHR returns the actual /drive/<id> or CDN target.
    if (html && /\/drive\/search-recover\.php(?:\?|$)/i.test(finalUrl)) {
      const recovered = await resolveHubcloudSearchRecoverPage(html, finalUrl, {
        signal,
        deadline,
        headers,
        depth
      });
      if (recovered) return recovered;
    }

    const pick = pickFromGeneratorHtml(html, finalUrl);
    const pickedDirect = await validateGeneratorPick(pick, { signal, deadline, headers, depth, fetchImpl: opts.fetchImpl });
    if (pickedDirect) return pickedDirect;

    // 4) last resort: some generator hosts serve the countdown page to browser
    //    UAs but 302 directly for crawlers — retry once with a non-browser UA.
    if (depth === 0 && Date.now() < deadline - 1200 && !signal?.aborted) {
      const retry = await fetchWithDeadline(startUrl, HUBCLOUD_UNROLL_ALT_UA, signal, deadline, { headers });
      if (retry) {
        const retryUrl = retry.url || startUrl;
        const inner = extractHttpLinkParam(retryUrl);
        if (inner) {
          const resolved = await resolveLinkInner(inner, { ...opts, depth });
          if (resolved) return resolved;
        }
        let rHtml = '';
        if (retry.ok) {
          rHtml = await readCappedText(retry);
          if (isCfChallengePage(rHtml)) rHtml = '';
        }
        const rPick = pickFromGeneratorHtml(rHtml, retryUrl);
        const retryDirect = await validateGeneratorPick(rPick, { signal, deadline, headers, depth, fetchImpl: opts.fetchImpl });
        if (retryDirect) return retryDirect;
      }
    }
    return null;
  } catch {
    return null;
  }
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
  const playable = await probePlayableMediaUrl(url, { headers, timeoutMs: 2500 });
  return { blocked: !playable };
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

const HICINE_LANGUAGE_ALIASES = [
  { code: 'en', label: 'English', aliases: ['English', 'Eng'] },
  { code: 'hi', label: 'Hindi', aliases: ['Hindi'] },
  { code: 'te', label: 'Telugu', aliases: ['Telugu'] },
  { code: 'bn', label: 'Bengali', aliases: ['Bengali', 'Bangla', 'Beng'] },
  { code: 'ta', label: 'Tamil', aliases: ['Tamil'] },
  { code: 'ml', label: 'Malayalam', aliases: ['Malayalam'] },
  { code: 'kn', label: 'Kannada', aliases: ['Kannada'] },
  { code: 'ja', label: 'Japanese', aliases: ['Japanese'] },
  { code: 'ko', label: 'Korean', aliases: ['Korean'] },
  { code: 'zh', label: 'Chinese', aliases: ['Chinese', 'Mandarin'] },
  { code: 'es', label: 'Spanish', aliases: ['Spanish'] },
  { code: 'fr', label: 'French', aliases: ['French'] },
  { code: 'ar', label: 'Arabic', aliases: ['Arabic'] },
  { code: 'ur', label: 'Urdu', aliases: ['Urdu'] },
  { code: 'mr', label: 'Marathi', aliases: ['Marathi'] },
  { code: 'pa', label: 'Punjabi', aliases: ['Punjabi'] },
  { code: 'pt', label: 'Portuguese', aliases: ['Portuguese'] },
  { code: 'ru', label: 'Russian', aliases: ['Russian'] },
  { code: 'de', label: 'German', aliases: ['German'] },
  { code: 'it', label: 'Italian', aliases: ['Italian'] },
  { code: 'id', label: 'Indonesian', aliases: ['Indonesian'] },
  { code: 'tr', label: 'Turkish', aliases: ['Turkish'] },
  { code: 'th', label: 'Thai', aliases: ['Thai'] },
  { code: 'fa', label: 'Persian', aliases: ['Persian', 'Farsi'] }
];

function parseHicineAudioHints(text) {
  const value = String(text || '');
  const aliases = HICINE_LANGUAGE_ALIASES.flatMap((language) =>
    language.aliases.map((alias) => ({ ...language, alias }))
  ).sort((a, b) => b.alias.length - a.alias.length);
  const aliasPattern = aliases.map((item) => item.alias).join('|');
  const matcher = new RegExp(`(^|[^A-Za-z])(${aliasPattern})(?=$|[^A-Za-z])`, 'gi');
  const languages = [];
  const seen = new Set();
  let match;
  while ((match = matcher.exec(value))) {
    const alias = match[2].toLowerCase();
    const language = aliases.find((item) => item.alias.toLowerCase() === alias);
    if (language && !seen.has(language.code)) {
      seen.add(language.code);
      languages.push({ code: language.code, label: language.label });
    }
  }
  const explicitMulti = /\b(?:dual[\s._-]*audio|multi(?:ple)?[\s._-]*(?:audio|language|lang|track|dub))\b/i.test(value);
  const original = /\b(?:org\.?|original)[\s._-]*(?:audio|track)\b/i.test(value);
  return { languages, multi: explicitMulti || languages.length > 1, original };
}

function hicineAudioHintText(text) {
  const filenames = [];
  const textWithoutUrls = String(text || '').replace(/https?:\/\/[^\s,"']+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl.replace(/[),;]+$/, ''));
      const filename = decodeURIComponent(parsed.pathname.split('/').pop() || '');
      if (/\.(?:mkv|mp4|m4v|webm|mov|avi)$/i.test(filename)) {
        filenames.push(filename.replace(/\.[^.]+$/, ''));
      }
    } catch {}
    return ' ';
  });
  return `${textWithoutUrls} ${filenames.join(' ')}`;
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

      const description = `${line} ${segment}`;
      const audioHints = parseHicineAudioHints(hicineAudioHintText(description));

      // vcloud worker URLs (`https://...workers.dev/?vcloud=https://vcloud.fit/...`)
      for (const match of segment.matchAll(/(https?:\/\/[^\s,"']+\/?vcloud=[^\s,"']+)/gi)) {
        const label = labelFor(match.index);
        results.push({
          type: 'vcloud_worker',
          quality: label,
          height: toHeight(label),
          url: match[1],
          description,
          audioHints
        });
      }

      // direct pixeldrain share URLs (`https://pixeldrain.dev/u/ID`)
      for (const match of segment.matchAll(
        /https?:\/\/pixeldrain\.(?:dev|com)\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/gi
      )) {
        const label = labelFor(match.index);
        results.push({
          type: 'pixeldrain',
          quality: label,
          height: toHeight(label),
          url: normalizePlayableUrl(`https://pixeldrain.dev/api/file/${match[1]}`),
          description,
          audioHints
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
async function resolveVcloudWorkerLink(workerUrl, signal, unrollDeadline) {
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

          // Root Cause E: HubCloud link generators (`gpdl2.hubcloud.ist/?id=…`,
          // `gamerxyt.com/dl.php?link=…`, nested `hubcloud.<tld>/drive/<id>` pages) are
          // countdown HTML, not media — unroll them server-side to the real CDN
          // file before anything reaches `<video src>`.
          let unrollFailed = false;
          if (isHubcloudGeneratorUrl(location) || extractHttpLinkParam(location) || extractWrappedMediaTargets(location).length > 0) {
            const direct = await unrollHubcloudUrl(location, {
              signal,
              deadline: unrollDeadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS
            });
            if (direct) location = direct;
            // A landing page that could not be unrolled is just as unplayable as
            // a hotlink-blocked URL: mark it dead so the attempts loop falls
            // through to the next HiCine token (fsl/r2/DDL/…). If no other token
            // exists it stays the last resort, as before.
            else unrollFailed = true;
          }

          // Root Cause B: unwrap `?link=` redirect wrappers to the real CDN URL
          location = unwrapRedirectVideoUrl(location);
          if (!/^https?:\/\//i.test(location)) return null;

          // pixeldrain share pages -> direct API stream endpoint
          if (/pixeldrain\.(dev|com)/i.test(location) && location.includes('/u/')) {
            location = normalizePlayableUrl(location);
          }

          let isHotlinkBlocked = unrollFailed;
          if (!isHotlinkBlocked) {
            isHotlinkBlocked = !(await probePlayableMediaUrl(location, {
              signal,
              deadline: unrollDeadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS
            }));
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
    // Shared HubCloud-unroll budget: qualities resolve sequentially, so one
    // deadline (not per-hop timeouts) keeps the whole step inside the 9.5s
    // abort window even when a generator page stalls.
    const unrollDeadline = Date.now() + 6000;
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
            audioHints: entry.audioHints || parseHicineAudioHints(entry.description || ''),
            ...describeHicineMedia(entry.quality, entry.description || '', entry.url)
          });
        }
        continue;
      }

      if (entry.type === 'vcloud_worker') {
        const resolved = await resolveVcloudWorkerLink(entry.url, controller.signal, unrollDeadline);
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
          audioHints: entry.audioHints || parseHicineAudioHints(entry.description || ''),
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
    // This is also the graceful fallback if the Node HLS remux is unavailable
    // to the browser (or the generated fMP4/HEVC combination cannot be decoded).
    backupUrls.push(primary.rawUrl);
    const uniqueBackups = Array.from(new Set(backupUrls.filter(Boolean)));

    const audioHints =
      primary.audioHints ||
      parseHicineAudioHints(`${primary.description || ''} ${releaseTitle}`);
    const hintedLanguages = audioHints.languages || [];
    const fallbackTrackLabel = hintedLanguages.length > 1
      ? `${hintedLanguages.map((language) => language.label).join(' + ')} — plays default track`
      : hintedLanguages.length === 1
        ? `${hintedLanguages[0].label}${audioHints.multi ? ' — plays default track' : ' — filename hint; plays default track'}`
        : audioHints.multi
          ? 'Dual Audio — plays default track'
          : audioHints.original
            ? 'Original Audio (default track)'
            : 'Default Audio (track selection unavailable)';

    // HiCine exposes audio languages only in the filename. Never manufacture
    // multiple rows for one progressive MKV: browsers can only play its default.
    const defaultTrackLanguage =
      hintedLanguages.length === 1 && !audioHints.multi ? hintedLanguages[0].code : 'und';
    const defaultAudioTracks = [
      {
        id: 'hicine-default',
        lang: defaultTrackLanguage,
        label: fallbackTrackLabel,
        type: 'dub',
        streamUrl: primary.rawUrl,
        rawUrl: primary.rawUrl,
        default: true
      }
    ];
    const multiTrackStream =
      primary.streamFormat === 'mp4'
        ? await prepareMultiTrackStream(primary.rawUrl, hintedLanguages)
        : null;
    const streamUrl = multiTrackStream?.streamUrl || primary.rawUrl;

    return {
      server: 'centaurus',
      format: multiTrackStream?.format || primary.streamFormat || 'mp4',
      rawUrl: primary.rawUrl,
      // Progressive by default; Node switches to the signed HLS remux only when
      // ffprobe confirms multiple tracks and both ffmpeg tools are available.
      streamUrl,
      progressiveFormat: multiTrackStream ? (primary.streamFormat || 'mp4') : undefined,
      progressiveFallbackUrls: multiTrackStream
        ? Array.from(new Set([...uniqueBackups, ...ordered.map((quality) => quality.rawUrl)]))
        : undefined,
      progressiveAudioTrack: multiTrackStream
        ? multiTrackStream.audioTracks.find((track) => track.default) || defaultAudioTracks[0]
        : defaultAudioTracks[0],
      referer: '',
      headers: {},
      tokenType: primary.tokenType,
      backupUrls: uniqueBackups,
      audioTracks: multiTrackStream?.audioTracks || defaultAudioTracks,
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

// ============================================================================
// SERVER 2 (URSA / 4K): MULTI-TIER 2160p 4K UHD & MULTI-AUDIO CASCADE
// Priority 1: 4KHDHub      (2160p BluRay REMUX / WEB-DL Dual/Multi-Audio + HubCloud)
// Priority 2: MoviesDrive  (Typesense IMDb API + 2160p Dual-Audio MDrive/HubCloud)
// Priority 3: HiCine 4K    (2160p SDR/HDR Dual-Audio vcloud worker streams)
// Priority 4: Dahmer 4K    (2160p Original/Multi-Audio direct open-directory MKV)
// ============================================================================

let dynamic4kDomainCache = {
  fourkhdhub: null,
  moviesdrive: null,
  exp: 0
};

function rot13Cipher(str) {
  return String(str || '').replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function b64DecodeUtf8(str) {
  try {
    const clean = String(str || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    if (!clean) return '';
    const pad = clean.length % 4;
    const padded = pad ? clean + '='.repeat(4 - pad) : clean;
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Decode 4KHDHub redirector page (`s('o','<encoded>')` / `ck('_wp_http_...','<encoded>')`)
 * using the 3-chain Base64 + ROT13 pipeline:
 *   Chain 1: b64 -> b64 -> rot13 -> b64 -> JSON.o -> b64
 *   Chain 2: b64 -> b64 -> JSON.o -> b64
 *   Chain 3: b64 -> b64 -> b64 -> JSON.o -> b64
 */
function decode4kRedirectExpression(expression, pageUrl = '') {
  let value = String(expression || '').trim().replace(/[;,]+$/, '').trim();
  for (let depth = 0; depth < 4 && value; depth += 1) {
    // Strip harmless grouping parentheses around a literal/atob expression.
    if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();

    const atobMatch = value.match(/^atob\s*\(\s*(['"])([A-Za-z0-9+/_=-]{8,})\1\s*\)$/i);
    if (atobMatch) {
      value = b64DecodeUtf8(atobMatch[2]).trim();
      continue;
    }
    const uriMatch = value.match(/^decodeURIComponent\s*\(\s*(['"])(.*?)\1\s*\)$/i);
    if (uriMatch) {
      try { value = decodeURIComponent(uriMatch[2]); } catch { value = uriMatch[2]; }
      continue;
    }

    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) {
      value = quoted[2]
        .replace(/\\(['"])/g, '$1')
        .replace(/\\\//g, '/')
        .replace(/\\u002f/gi, '/')
        .replace(/\\x2f/gi, '/');
    }
    break;
  }
  const candidate = value.trim();
  if (/^https?:\/\//i.test(candidate)) return candidate;
  try {
    if (candidate.startsWith('/') && pageUrl) return new URL(candidate, pageUrl).href;
  } catch {}
  return '';
}

function decode4kRedirectCandidate(value, pageUrl = '') {
  const direct = decode4kRedirectExpression(value, pageUrl);
  if (!direct) return null;
  const wrapped = extractHttpLinkParam(direct);
  return { type: 'direct', url: wrapped || direct };
}

/**
 * Decode a 4KHDHub redirector page. The old `s('o', ...)` payload is retained,
 * but greenmotors.* now runs its own landing-page JavaScript after the 302.
 * Mirror the observable redirect expressions (var url, location.href/
 * location['href'], ?url/?link, atob payloads), then use the same bounded
 * generator scanner used by HubCloud. No encrypted id is guessed or decoded.
 */
function decode4khdhubRedirectHtml(html, pageUrl = '') {
  const raw = String(html || '');
  if (!raw) return null;

  const patterns = [
    /s\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=_-]{16,})['"]/i,
    /ck\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([A-Za-z0-9+/=_-]{16,})['"]/i,
    /localStorage\.setItem\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=_-]{16,})['"]/i,
    /['"]o['"]\s*[:=,]\s*['"]([A-Za-z0-9+/=_-]{24,})['"]/i
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (!m || !m[1]) continue;
    const encoded = m[1].trim();
    const s1 = b64DecodeUtf8(encoded);
    const s2 = b64DecodeUtf8(s1);
    const chains = [
      b64DecodeUtf8(rot13Cipher(s2)),
      s2,
      b64DecodeUtf8(s2),
      s1
    ];

    for (const candidate of chains) {
      if (!candidate || !candidate.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(candidate.trim());
        if (parsed && typeof parsed.o === 'string' && parsed.o) {
          const decodedUrl = b64DecodeUtf8(parsed.o).trim();
          if (/^https?:\/\//i.test(decodedUrl)) {
            return { type: 'direct', url: decodedUrl };
          }
        }
        if (parsed && parsed.blog_url && parsed.data) {
          return {
            type: 'blog_re',
            url: `${String(parsed.blog_url).trim()}?re=${encodeURIComponent(String(parsed.data).trim())}`
          };
        }
      } catch {
        // try next chain
      }
    }
  }

  // `url = '...'`, `location.href = '...'`, computed href access, and the
  // common `location.replace('...')` form. The expression is decoded without
  // evaluating arbitrary JavaScript.
  const assignmentRe = /(?:\b(?:var|let|const)\s+(?:re)?url\b|\b(?:re)?url\b|(?:window\.)?location\b|(?:window\.)?location\s*(?:\.\s*href|\[\s*['"]href['"]\s*\]))\s*=\s*([^;\n}]+)/gi;
  for (const match of raw.matchAll(assignmentRe)) {
    const result = decode4kRedirectCandidate(match[1], pageUrl);
    if (result) return result;
  }
  const callRe = /(?:window\.)?location\s*\.?(?:replace|assign)\s*\(\s*([^)]*)\)/gi;
  for (const match of raw.matchAll(callRe)) {
    const result = decode4kRedirectCandidate(match[1], pageUrl);
    if (result) return result;
  }

  // `?url=`/`?link=` may be embedded in an absolute URL or in an atob result.
  const inspectText = (text) => {
    for (const match of String(text || '').matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const candidate = match[0].replace(/[),;]+$/, '');
      const target = extractHttpLinkParam(candidate);
      if (target) return { type: 'direct', url: target };
      if (/^https?:\/\//i.test(candidate) && scorePlayableUrl(candidate) >= 0) {
        return { type: 'direct', url: candidate };
      }
    }
    return null;
  };
  const directFromText = inspectText(raw);
  if (directFromText) return directFromText;
  for (const match of raw.matchAll(/[?&](?:url|link)=([^\s"'<>]+)/gi)) {
    const target = extractQueryHttpUrl(match[1].replace(/[),;]+$/, ''));
    if (target) return { type: 'direct', url: target };
  }

  const encodedVariables = new Map();
  for (const variable of raw.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Za-z0-9+/_=-]{8,})['"]/gi)) {
    encodedVariables.set(variable[1], variable[2]);
  }
  for (const match of raw.matchAll(/\batob\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/gi)) {
    const encoded = encodedVariables.get(match[1]);
    if (!encoded) continue;
    let decoded = encoded;
    for (let depth = 0; depth < 4; depth += 1) {
      decoded = b64DecodeUtf8(decoded);
      if (!decoded) break;
      const fromDecoded = inspectText(decoded);
      if (fromDecoded) return fromDecoded;
      const wrapped = decoded.match(/[?&](?:url|link)=([^\s"'<>]+)/i);
      if (wrapped) {
        const target = extractQueryHttpUrl(wrapped[1]);
        if (target) return { type: 'direct', url: target };
      }
      if (/^https?:\/\//i.test(decoded.trim())) return { type: 'direct', url: decoded.trim() };
      if (!/^[A-Za-z0-9+/_=-]{8,}$/.test(decoded.trim())) break;
    }
  }

  // Last resort: generic href/src/action/URL/generator scanning. Returning a
  // generator as `direct` simply hands it to the iterative caller below.
  const pick = pickFromGeneratorHtml(raw, pageUrl);
  if (pick?.direct) return { type: 'direct', url: pick.direct };
  if (pick?.generator) return { type: 'direct', url: pick.generator };

  return null;
}

function parseResolutionHeight(text) {
  const s = String(text || '');
  if (/2160p|\b4k\b|\buhd\b/i.test(s)) return 2160;
  if (/1440p|\b2k\b/i.test(s)) return 1440;
  if (/1080p|\bfhd\b/i.test(s)) return 1080;
  if (/720p|\bhd\b/i.test(s)) return 720;
  if (/480p/i.test(s)) return 480;
  return 1080;
}

function format4kQualityLabel(height, description = '', seenLabels = new Set()) {
  const d = String(description || '');
  let base =
    height >= 2160
      ? '2160p (4K)'
      : height === 1440
        ? '1440p (2K)'
        : height === 1080
          ? '1080p'
          : height === 720
            ? '720p'
            : `${height || 1080}p`;

  if (seenLabels.has(base)) {
    const tag = /remux/i.test(d)
      ? 'REMUX'
      : /\bdv\b|dolby\s*vision/i.test(d)
        ? 'DV HDR'
        : /\bhdr/i.test(d)
          ? 'HDR'
          : /\bsdr\b/i.test(d)
            ? 'SDR'
            : /10\s*bit|hevc|x265|h\.?265/i.test(d)
              ? 'HEVC'
              : 'Alt';
    base = height >= 2160 ? `2160p (4K ${tag})` : `${height}p (${tag})`;
  }
  seenLabels.add(base);
  return base;
}

function score4kCandidate(item, preferredAudio = '') {
  let score = 0;
  const height = Number(item.height) || parseResolutionHeight(item.description || item.label || '');
  const desc = String(item.description || item.label || '');
  const hints = item.audioHints || parseHicineAudioHints(hicineAudioHintText(desc));
  const langs = (hints.languages || []).map((language) => language.code);
  const sizeMatch = desc.match(/\b(\d+(?:[.,]\d+)?)\s*(?:gb|gib)\b/i);
  const sizeGb = Number(item.sizeBytes) > 0
    ? Number(item.sizeBytes) / (1024 ** 3)
    : sizeMatch
      ? Number(sizeMatch[1].replace(',', '.'))
      : 0;

  // Resolution remains the dominant signal; build4kStreamPayload separately
  // keeps a 1080p codec fallback below any available 2160p primary.
  if (height >= 2160) score += 500;
  else if (height === 1440) score += 250;
  else if (height === 1080) score += 150;
  else if (height === 720) score += 80;
  else score += 30;

  if (hints.multi || langs.length > 1) score += 130;
  if (langs.length >= 3) score += 40;
  if (langs.includes('en') && langs.includes('hi')) score += 45;
  if (hints.original || langs.includes('en')) score += 35;
  if (preferredAudio) {
    const wanted = normalizeAudioLanguage(String(preferredAudio).trim().toLowerCase());
    if (wanted !== 'und' && langs.includes(wanted)) score += 180;
  }

  if (/\bweb[ ._-]?dl\b|\bwebrip\b/i.test(desc)) score += 45;
  if (/\bsdr\b/i.test(desc)) score += 35;
  if (/\baac\b|\beac3\b/i.test(desc)) score += 25;
  if (/\b(?:h\.?264|x264|avc)\b/i.test(desc)) score += 40;
  if (sizeGb >= 2 && sizeGb <= 18) score += 30;
  if (/\bremux\b/i.test(desc)) score -= 120;
  if (/\btruehd\b/i.test(desc)) score -= 120;
  if (/\bdts(?:[- .]?hd)?\b/i.test(desc)) score -= 120;
  if (sizeGb > 25) score -= 80;

  if (item.linkType === 'hubcloud') score += 25;
  if (item.isHotlinkBlocked) score -= 400;
  return score;
}

async function discoverDynamic4kDomains(signal) {
  if (Date.now() < dynamic4kDomainCache.exp) {
    return dynamic4kDomainCache;
  }
  const url = config.upstreams.domainDiscoveryUrl;
  if (!url || /127\.0\.0\.1|localhost/i.test(config.upstreams.fourkhdhubBase || '')) {
    return dynamic4kDomainCache;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2200);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener?.('abort', onAbort);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: ctrl.signal
    });
    if (res.ok) {
      const data = await res.json();
      dynamic4kDomainCache = {
        fourkhdhub: typeof data?.['4khdhub'] === 'string' ? data['4khdhub'].replace(/\/$/, '') : null,
        moviesdrive: typeof data?.moviesdrive === 'string' ? data.moviesdrive.replace(/\/$/, '') : null,
        exp: Date.now() + 3600 * 1000
      };
    }
  } catch {
    // ignore discovery error; fallback host pool is used
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
  return dynamic4kDomainCache;
}

async function get4khdhubCandidateHosts(signal) {
  const base = (config.upstreams.fourkhdhubBase || '').trim().replace(/\/$/, '');
  if (base && /127\.0\.0\.1|localhost/i.test(base)) return [base];
  const discovered = await discoverDynamic4kDomains(signal);
  const pool = [
    base,
    discovered.fourkhdhub,
    ...(Array.isArray(config.upstreams.fourkhdhubHosts) ? config.upstreams.fourkhdhubHosts : [])
  ]
    .filter(Boolean)
    .map((h) => String(h).trim().replace(/\/$/, ''));
  return Array.from(new Set(pool));
}

async function getMoviesdriveCandidateHosts(signal) {
  const base = (config.upstreams.moviesdriveBase || '').trim().replace(/\/$/, '');
  if (base && /127\.0\.0\.1|localhost/i.test(base)) return [base];
  const discovered = await discoverDynamic4kDomains(signal);
  const pool = [
    base,
    discovered.moviesdrive,
    ...(Array.isArray(config.upstreams.moviesdriveHosts) ? config.upstreams.moviesdriveHosts : [])
  ]
    .filter(Boolean)
    .map((h) => String(h).trim().replace(/\/$/, ''));
  return Array.from(new Set(pool));
}

/**
 * Unroll any 4K candidate link (4KHDHub redirector, HubDrive, MDrive archive,
 * HubCloud generator, VCloud worker/page, or direct CDN file) into a direct
 * playable media URL.
 */
async function unroll4kCandidateUrl(rawLink, signal, deadline, referer = '') {
  if (!rawLink || typeof rawLink !== 'string') return null;
  let currentUrl = rawLink.trim();
  const headers = fourKBrowserHeaders(referer);
  const probeOptions = { signal, deadline, headers, timeoutMs: 1800 };
  const checkedDirect = async (url) => {
    if (!url) return null;
    const normalizedUrl = normalizePlayableUrl(url);
    if (scorePlayableUrl(normalizedUrl) < 0) return null;
    return await probePlayableMediaUrl(normalizedUrl, probeOptions) ? normalizedUrl : null;
  };

  // Follow at most four redirector landings. In particular, greenmotors.club
  // commonly 302s to greenmotors.cc; the final response URL is another hop,
  // not a terminal URL to score and discard.
  const seen = new Set();
  for (let hop = 0; hop < 4 && currentUrl; hop += 1) {
    if (seen.has(currentUrl)) return null;
    seen.add(currentUrl);

    const wrappedTargets = extractWrappedMediaTargets(currentUrl);
    if (wrappedTargets.length > 0) {
      for (const target of wrappedTargets) {
        const direct = await resolveLinkInner(target, { ...probeOptions, depth: hop });
        if (direct) return direct;
      }
      if (!isHubcloudGeneratorUrl(currentUrl)) return null;
    }

    if (/vcloud=/i.test(currentUrl)) {
      const vc = await resolveVcloudWorkerLink(currentUrl, signal, deadline);
      if (vc?.url && !vc.isHotlinkBlocked) return checkedDirect(vc.url);
      return null;
    }

    if (isHubcloudGeneratorUrl(currentUrl)) {
      return await unrollHubcloudUrl(currentUrl, {
        signal,
        deadline,
        headers,
        depth: hop
      });
    }

    const direct = await checkedDirect(currentUrl);
    if (direct) return direct;

    let currentHost = '';
    try { currentHost = new URL(currentUrl).hostname; } catch { return null; }
    const isRedirector =
      /[?&]id=[^&#\s"']+/i.test(currentUrl) ||
      /(^|\.)greenmotors\.(?:club|cc)$/i.test(currentHost);
    if (!isRedirector) {
      // MDrive archive and HubDrive pages can expose several mirrors. Score and
      // probe all of their links instead of trusting the first button in HTML.
      if (/mdrive\.|\/archive\/\d+/i.test(currentUrl) || /hubdrive\./i.test(currentUrl)) {
        const res = await fetchWithDeadline(
          currentUrl,
          USER_AGENT,
          signal,
          deadline,
          { headers: fourKBrowserHeaders(referer || `${new URL(currentUrl).origin}/`) }
        );
        if (!res || !res.ok) return null;
        const html = await readCappedText(res);
        if (isAntiBotPage(html)) return null;
        const pick = pickFromGeneratorHtml(html, res.url || currentUrl);
        const picked = await validateGeneratorPick(pick, {
          ...probeOptions,
          depth: hop
        });
        if (picked) return picked;
        return null;
      }

      if (/(^|\.)vcloud\./i.test(currentUrl)) {
        const vc = await resolveVcloudWorkerLink(currentUrl, signal, deadline);
        if (vc?.url && !vc.isHotlinkBlocked) return checkedDirect(vc.url);
      }
      return null;
    }

    const originReferer = referer || (() => {
      try { return `${new URL(currentUrl).origin}/`; } catch { return ''; }
    })();
    const res = await fetchWithDeadline(
      currentUrl,
      USER_AGENT,
      signal,
      deadline,
      { headers: fourKBrowserHeaders(originReferer) }
    );
    if (!res) return null;

    const finalUrl = res.url || currentUrl;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isPage =
      !contentType ||
      /^(?:text\/|application\/(?:json|xhtml|xml|javascript))/i.test(contentType) ||
      /html|xml/i.test(contentType);
    if (!isPage) {
      const finalDirect = await checkedDirect(finalUrl);
      if (finalDirect) return finalDirect;
      return null;
    }

    const html = res.ok ? await readCappedText(res) : '';
    if (isAntiBotPage(html)) return null;
    const decoded = decode4khdhubRedirectHtml(html, finalUrl);

    if (decoded?.type === 'blog_re' && decoded.url) {
      const blogRes = await fetchWithDeadline(
        decoded.url,
        USER_AGENT,
        signal,
        deadline,
        { headers: fourKBrowserHeaders(finalUrl) }
      );
      if (blogRes?.ok) {
        const blogText = await readCappedText(blogRes);
        const blogPick = decode4khdhubRedirectHtml(blogText, blogRes.url || decoded.url) ||
          pickFromGeneratorHtml(blogText, blogRes.url || decoded.url);
        if (blogPick?.url) currentUrl = blogPick.url;
        else if (blogPick?.direct) currentUrl = blogPick.direct;
        else if (blogRes.url && blogRes.url !== decoded.url) currentUrl = blogRes.url;
        else continue;
        continue;
      }
    }

    let nextUrl = decoded?.url || '';
    // fetch(..., redirect: follow) already crossed club -> cc. Re-process the
    // final landing URL rather than adopting it and falling through to scoring.
    if (!nextUrl && finalUrl !== currentUrl) nextUrl = finalUrl;
    if (nextUrl) {
      try { nextUrl = new URL(nextUrl, finalUrl).href; } catch { nextUrl = ''; }
    }
    if (nextUrl && nextUrl !== currentUrl) {
      currentUrl = nextUrl;
      continue;
    }
    return null;
  }

  return null;
}

/**
 * Shared 4K Stream Payload Builder
 * - Selects the highest-scoring 2160p (4K) multi-audio/original stream as primary.
 * - Builds a full quality selector ladder (`2160p (4K)` -> `1080p` -> `720p`).
 * - Exposes switchable audioTracks when multiple distinct language streams or
 *   Node FFmpeg multi-track HLS remuxing are available, or honest multi-audio/original metadata.
 */
async function build4kStreamPayload({
  serverId = 'ursa',
  tier,
  resolvedItems,
  referer = '',
  headers = {},
  preferredAudio = ''
}) {
  if (!Array.isArray(resolvedItems) || resolvedItems.length === 0) return null;

  const scoreSort = (a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio);
  const fourKItems = resolvedItems.filter((item) => Number(item.height) >= 2160).sort(scoreSort);
  const otherItems = resolvedItems.filter((item) => Number(item.height) < 2160).sort(scoreSort);
  // Keep 2160p as the primary choice whenever one exists; codec-friendly 1080p
  // encodes remain in the quality ladder and backup URL list for browser failover.
  const qualityDegraded = fourKItems.length === 0;
  const sorted = fourKItems.length > 0 ? [...fourKItems, ...otherItems] : [...resolvedItems].sort(scoreSort);
  const primary = sorted[0];
  const seenLabels = new Set();

  const orderedQualities = [
    primary,
    ...sorted.slice(1).sort((a, b) => (b.height || 0) - (a.height || 0))
  ];

  const qualities = [];
  const seenQualityUrls = new Set();
  for (const item of orderedQualities) {
    const qUrl = item.streamUrl || item.rawUrl;
    if (!qUrl || seenQualityUrls.has(qUrl)) continue;
    seenQualityUrls.add(qUrl);
    qualities.push({
      label: format4kQualityLabel(item.height, item.description, seenLabels),
      height: item.height || 2160,
      url: qUrl,
      ...(item.tokenType ? { tokenType: item.tokenType } : {})
    });
  }

  const backupUrls = [];
  for (const item of orderedQualities.slice(1)) {
    backupUrls.push(buildProxyStreamUrl(item.rawUrl, referer, '', { mode: 'manifest' }));
  }
  backupUrls.push(buildProxyStreamUrl(primary.rawUrl, referer, '', { mode: 'manifest' }));
  backupUrls.push(buildProxyStreamUrl(primary.rawUrl, referer, '', { mode: 'full' }));
  backupUrls.push(primary.rawUrl);
  const uniqueBackups = Array.from(new Set(backupUrls.filter(Boolean)));

  const primaryHints =
    primary.audioHints || parseHicineAudioHints(hicineAudioHintText(primary.description || ''));
  const hintedLanguages = primaryHints.languages || [];

  // Check if we resolved distinct-URL language variants across items
  const distinctLangTracks = [];
  const seenLangKeys = new Set();
  for (const item of sorted) {
    const h = item.audioHints || parseHicineAudioHints(hicineAudioHintText(item.description || ''));
    const langs = h.languages || [];
    const langSignature = langs.length > 0 ? langs.map((l) => l.code).join('+') : h.original ? 'orig' : 'en';
    if (seenLangKeys.has(langSignature)) continue;
    seenLangKeys.add(langSignature);
    const primaryCode = langs.length > 0 ? langs[0].code : 'en';
    const label =
      langs.length > 1
        ? `${langs.map((l) => l.label).join(' + ')} (${item.height >= 2160 ? '4K ' : ''}Multi-Audio)`
        : langs.length === 1
          ? `${langs[0].label}${h.multi ? ' (Dual Audio)' : ' (Original / Dub)'}`
          : h.multi
            ? `Dual Audio (${item.height >= 2160 ? '4K UHD' : `${item.height || 1080}p`})`
            : `Original Audio (${item.height >= 2160 ? '4K UHD' : `${item.height || 1080}p`})`;
    distinctLangTracks.push({
      id: `${tier}-${langSignature}`,
      lang: primaryCode,
      languages: langs.map((l) => l.code),
      label,
      type: langs.length > 1 || h.multi ? 'dub' : 'sub',
      streamUrl: item.streamUrl || item.rawUrl,
      rawUrl: item.rawUrl,
      default: distinctLangTracks.length === 0
    });
  }

  // On Node.js, attempt FFmpeg/FFprobe multi-track HLS remux if primary is an allowlisted MP4/MKV
  const primaryFormat =
    primary.format ||
    (/\.mpd(\?|$)/i.test(primary.rawUrl)
      ? 'dash'
      : /\.m3u8(\?|$)/i.test(primary.rawUrl)
        ? 'hls'
        : 'mp4');

  const multiTrackStream =
    primaryFormat === 'mp4' && !primary.needsProxy
      ? await prepareMultiTrackStream(primary.rawUrl, hintedLanguages)
      : null;

  const finalStreamUrl =
    multiTrackStream?.streamUrl || primary.streamUrl || primary.rawUrl;
  const finalAudioTracks =
    multiTrackStream?.audioTracks ||
    (distinctLangTracks.length > 0
      ? distinctLangTracks
      : [
          {
            id: `${tier}-orig`,
            lang: hintedLanguages[0]?.code || 'en',
            label: `Original Audio (${primary.height >= 2160 ? '4K UHD' : `${primary.height || 1080}p`})`,
            type: 'sub',
            streamUrl: primary.streamUrl || primary.rawUrl,
            rawUrl: primary.rawUrl,
            default: true
          }
        ]);

  return {
    server: serverId,
    tier,
    qualityDegraded,
    requestedQuality: '2160p',
    format: multiTrackStream?.format || primaryFormat,
    rawUrl: primary.rawUrl,
    streamUrl: finalStreamUrl,
    progressiveFormat: multiTrackStream ? primaryFormat : undefined,
    progressiveFallbackUrls: multiTrackStream
      ? Array.from(new Set([...uniqueBackups, ...orderedQualities.map((q) => q.rawUrl)]))
      : undefined,
    progressiveAudioTrack: multiTrackStream
      ? multiTrackStream.audioTracks.find((t) => t.default) || finalAudioTracks[0]
      : finalAudioTracks[0],
    referer,
    headers,
    backupUrls: uniqueBackups,
    audioTracks: finalAudioTracks,
    qualities
  };
}

/**
 * Tier 1: 4KHDHub 2160p UHD Multi-Audio Resolver
 * Searches active 4KHDHub mirror, parses .download-item (movies) or .episode-item (TV),
 * decodes redirector chains (b64->b64->rot13->b64), and unrolls HubCloud/HubDrive to direct 4K CDN URLs.
 */
function normalize4kHtmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function read4kHtmlAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/** Marker-slice search cards and validate the source slug before scoring. */
function parse4khdhubSearchCards(html, baseUrl) {
  const anchors = [];
  const tagRe = /<a\b[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(String(html || '')))) {
    const tag = match[0];
    if (!/\bmovie-card\b/i.test(read4kHtmlAttribute(tag, 'class'))) continue;
    const href = read4kHtmlAttribute(tag, 'href');
    if (!/(?:movie|series)-\d+/i.test(href)) continue;
    anchors.push({ index: match.index, tagEnd: tagRe.lastIndex, href });
  }

  return anchors.map((marker, idx) => {
    const nextMarker = anchors[idx + 1]?.index ?? String(html || '').length;
    const close = String(html || '').indexOf('</a>', marker.tagEnd);
    const end = close >= 0 && close < nextMarker ? close : nextMarker;
    const inner = String(html || '').slice(marker.tagEnd, end);
    const titleMatch = inner.match(/class=["'][^"']*movie-card-title[^"']*["'][^>]*>([\s\S]*?)<\/h\d>/i);
    const metaMatch = inner.match(/class=["'][^"']*movie-card-meta[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const title = normalize4kHtmlText(titleMatch ? titleMatch[1] : inner);
    const meta = normalize4kHtmlText(metaMatch ? metaMatch[1] : '');
    const yearMatch = `${title} ${meta}`.match(/\b(19\d{2}|20\d{2})\b/);
    let href = marker.href;
    try { href = new URL(href, baseUrl).href; } catch {}
    return {
      href,
      title,
      year: yearMatch ? Number(yearMatch[1]) : 0,
      isSeries: /series-\d+/i.test(marker.href)
    };
  });
}

/** Slice sibling `.download-item` / `.episode-download-item` chunks by marker. */
function extract4kDivMarkerBlocks(html, markerClass) {
  const source = String(html || '');
  const markers = [];
  const divRe = /<div\b[^>]*>/gi;
  let match;
  while ((match = divRe.exec(source))) {
    const classes = read4kHtmlAttribute(match[0], 'class').split(/\s+/);
    if (classes.includes(markerClass)) markers.push({ index: match.index });
  }
  return markers.map((marker, idx) => {
    const end = markers[idx + 1]?.index ?? source.length;
    return { html: source.slice(marker.index, end), index: marker.index };
  });
}

function get4kEpisodeBadgeBefore(html, index) {
  const before = String(html || '').slice(Math.max(0, index - 3000), index);
  const badgeRe = /<([a-z][\w:-]*)\b[^>]*class=["'][^"']*\bepisode-number\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const badges = [...before.matchAll(badgeRe)];
  return badges.length ? normalize4kHtmlText(badges[badges.length - 1][2]) : '';
}

function get4kDownloadBlocks(html, isTv, seasonNum = 1, episodeNum = 1) {
  if (!isTv) return extract4kDivMarkerBlocks(html, 'download-item');
  const source = String(html || '');
  const episodesMatch = source.match(/<(?:div|section|main)\b[^>]*\bid=["']episodes["'][^>]*>/i);
  const scopeStart = episodesMatch ? episodesMatch.index : 0;
  const scope = source.slice(scopeStart);
  const blocks = extract4kDivMarkerBlocks(scope, 'episode-download-item');
  if (blocks.length === 0) return [];

  const seasonRe = new RegExp(`(?:\\bS0*${seasonNum}\\b|\\bseason\\s*0*${seasonNum}\\b)`, 'i');
  const episodeRe = new RegExp(
    `(?:\\bS0*${seasonNum}[\\s._-]*E0*${episodeNum}\\b|\\b(?:episode|ep)[\\s._-]*0*${episodeNum}\\b|\\bE0*${episodeNum}\\b)`,
    'i'
  );
  const matching = blocks.filter((block) => {
    const badge = get4kEpisodeBadgeBefore(scope, block.index);
    const text = `${badge} ${normalize4kHtmlText(block.html)}`;
    const explicitSeason = seasonRe.test(badge) || seasonRe.test(text);
    return episodeRe.test(text) && (!explicitSeason || seasonRe.test(text));
  });
  if (matching.length > 0) return matching;
  // Keep compatibility only when an older page omits the episode badge and
  // exposes exactly one item for the requested season; never guess among episodes.
  const seasonOnly = blocks.filter((block) => seasonRe.test(get4kEpisodeBadgeBefore(scope, block.index)));
  return seasonOnly.length === 1 ? seasonOnly : [];
}

async function resolve4khdhub(metadata, preferredAudio = '') {
  if (!metadata || !metadata.title) return { ok: false, reason: '4khdhub_missing_title' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const deadline = Date.now() + 10500;

  try {
    const hosts = await get4khdhubCandidateHosts(controller.signal);
    const isTv = metadata.type === 'tv';
    const wantedYear = Number(metadata.releaseYear) || 0;
    const wantedTitle = String(metadata.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    let pageHtml = '';
    let activeHost = '';
    let activePageUrl = '';

    for (const host of hosts.slice(0, 3)) {
      const searchUrl = `${host}/?s=${encodeURIComponent(metadata.title)}`;
      const searchRes = await fetchWithDeadline(
        searchUrl,
        USER_AGENT,
        controller.signal,
        deadline,
        { headers: fourKBrowserHeaders(`${host}/`) }
      );
      if (!searchRes || !searchRes.ok) continue;
      const searchHtml = await readCappedText(searchRes);
      if (!searchHtml || isAntiBotPage(searchHtml)) continue;

      const cards = parse4khdhubSearchCards(searchHtml, host);

      if (cards.length === 0) continue;

      const scoreCard = (c) => {
        let s = 0;
        const norm = c.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (norm === wantedTitle) s += 120;
        else if (norm.startsWith(wantedTitle) || norm.includes(wantedTitle)) s += 60;
        if (wantedYear && c.year) {
          const d = Math.abs(c.year - wantedYear);
          if (d === 0) s += 100;
          else if (d <= 1) s += 60;
          else s -= 40;
        }
        if (isTv === c.isSeries) s += 80;
        else s -= 80;
        return s;
      };

      const bestCard = cards.sort((a, b) => scoreCard(b) - scoreCard(a))[0];
      if (!bestCard || scoreCard(bestCard) < 40) continue;

      const detailUrl = new URL(bestCard.href, host).href;
      const detailRes = await fetchWithDeadline(
        detailUrl,
        USER_AGENT,
        controller.signal,
        deadline,
        { headers: fourKBrowserHeaders(searchUrl) }
      );
      if (detailRes && detailRes.ok) {
        pageHtml = await readCappedText(detailRes);
        if (isAntiBotPage(pageHtml)) continue;
        activeHost = host;
        activePageUrl = detailRes.url || detailUrl;
        if (pageHtml) break;
      }
    }

    if (!pageHtml) {
      return { ok: false, reason: '4khdhub_no_matching_page' };
    }

    const candidates = [];
    const seasonNum = Number(metadata.season || 1);
    const episodeNum = Number(metadata.episode || 1);
    const blocks = get4kDownloadBlocks(pageHtml, isTv, seasonNum, episodeNum);

    for (const blockRecord of blocks) {
      const block = blockRecord.html;
      const fileTitle = normalize4kHtmlText(block).slice(0, 320);
      if (/\.zip\b|\bpack\b/i.test(fileTitle) && !isTv) continue;

      const height = parseResolutionHeight(fileTitle);
      const audioHints = parseHicineAudioHints(hicineAudioHintText(fileTitle));
      const linkRe = /<a\b[^>]*>/gi;
      let lm;
      while ((lm = linkRe.exec(block))) {
        const rawHref = read4kHtmlAttribute(lm[0], 'href').trim().replace(/&amp;/g, '&');
        if (!rawHref) continue;
        const close = block.indexOf('</a>', linkRe.lastIndex);
        const linkText = normalize4kHtmlText(close >= 0 ? block.slice(linkRe.lastIndex, close) : '');
        let href = rawHref;
        try { href = new URL(rawHref, activePageUrl || activeHost || '').href; } catch { continue; }
        const isHubCloud = /hubcloud|hubcdn/i.test(`${href} ${linkText}`);
        const isHubDrive = /hubdrive/i.test(`${href} ${linkText}`);
        const isRedirect = /[?&]id=[^&#\s"']+/i.test(href);
        const isDirect = scorePlayableUrl(href) >= 0;
        if (!isHubCloud && !isHubDrive && !isRedirect && !isDirect) continue;

        candidates.push({
          url: href,
          linkType: isHubCloud ? 'hubcloud' : isHubDrive ? 'hubdrive' : isRedirect ? 'redirect' : 'direct',
          height,
          description: fileTitle,
          audioHints
        });
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: '4khdhub_no_candidate_links' };
    }

    // Prioritize 2160p (4K) multi-audio candidates first, plus a 1080p backup if available
    const sortedCandidates = [...candidates].sort(
      (a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio)
    );
    const fourKCandidates = sortedCandidates.filter((candidate) => candidate.height >= 2160);
    const lowerQualityCandidates = sortedCandidates.filter((candidate) => candidate.height < 2160);
    const preferred1080 = lowerQualityCandidates.filter((candidate) => candidate.height >= 1080).slice(0, 2);
    const selectedCandidates = Array.from(new Map(
      [...fourKCandidates.slice(0, 3), ...preferred1080, ...lowerQualityCandidates.slice(0, 2)]
        .map((candidate) => [candidate.url, candidate])
    ).values()).slice(0, 7);

    // Resolve separate mirrors/qualities concurrently. A dead 4K token should
    // not block a viable R2/Google mirror or the 1080p browser fallback.
    const settledItems = await Promise.all(selectedCandidates.map(async (cand) => {
      const directUrl = await unroll4kCandidateUrl(
        cand.url,
        controller.signal,
        deadline,
        activeHost ? `${activeHost}/` : ''
      );
      if (!directUrl) return null;
      return {
        rawUrl: directUrl,
        streamUrl: directUrl,
        height: cand.height,
        description: cand.description,
        audioHints: cand.audioHints,
        format: /\.m3u8(\?|$)/i.test(directUrl) ? 'hls' : 'mp4'
      };
    }));
    const seenUrls = new Set();
    const resolvedItems = settledItems.filter((item) => {
      if (!item || seenUrls.has(item.rawUrl)) return false;
      seenUrls.add(item.rawUrl);
      return true;
    });

    if (resolvedItems.length === 0) return { ok: false, reason: '4khdhub_unroll_failed' };

    const payload = await build4kStreamPayload({
      serverId: 'ursa',
      tier: '4khdhub',
      resolvedItems,
      referer: activeHost ? `${activeHost}/` : '',
      preferredAudio
    });
    return payload ? { ok: true, ...payload } : { ok: false, reason: '4khdhub_payload_empty' };
  } catch (err) {
    return { ok: false, reason: `4khdhub_error:${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 2: MoviesDrive 4K Multi-Audio Resolver
 * Queries Typesense JSON `/search.php?q=<imdbId|title>&page=1`, parses 2160p/1080p
 * `mdrive.lol/archive/...` and `hubcloud` links, and unrolls to direct 4K CDN streams.
 */
async function resolveMoviesdrive4k(metadata, preferredAudio = '') {
  if (!metadata || !metadata.title) return { ok: false, reason: 'moviesdrive4k_missing_title' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const deadline = Date.now() + 10500;

  try {
    const hosts = await getMoviesdriveCandidateHosts(controller.signal);
    const imdbId = metadata.externalIds?.imdb_id || '';
    const isTv = metadata.type === 'tv';
    const wantedYear = Number(metadata.releaseYear) || 0;
    const wantedTitle = String(metadata.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    let postHtml = '';
    let postBaseUrl = '';
    let activeHost = '';

    for (const host of hosts.slice(0, 3)) {
      const queries = Array.from(new Set([imdbId, metadata.title].filter(Boolean)));
      const documents = [];
      let lastSearchUrl = `${host}/`;

      // Query both the IMDb id and title before choosing a post. The live 2160p
      // document currently has imdb_id:"", while its 1080p sibling carries
      // the id; choosing per-query would therefore lock onto the wrong release.
      for (const q of queries) {
        const searchUrl = `${host}/search.php?q=${encodeURIComponent(q)}&page=1`;
        lastSearchUrl = searchUrl;
        const res = await fetchWithDeadline(
          searchUrl,
          USER_AGENT,
          controller.signal,
          deadline,
          { headers: fourKBrowserHeaders(`${host}/`) }
        );
        if (!res || !res.ok) continue;
        const text = await readCappedText(res);
        if (!text || isAntiBotPage(text) || !text.trim().startsWith('{')) continue;

        try {
          const data = JSON.parse(text);
          const hits = Array.isArray(data?.hits) ? data.hits : [];
          for (const hit of hits) {
            if (hit?.document) documents.push(hit.document);
          }
        } catch {
          // continue with the other query/host
        }
      }

      const uniqueDocuments = Array.from(
        new Map(documents.filter((doc) => doc?.permalink).map((doc) => [doc.permalink, doc])).values()
      );
      if (uniqueDocuments.length === 0) continue;

      const scoreDoc = (doc) => {
        let s = 0;
        const text = [
          doc.post_title,
          doc.title,
          doc.quality,
          doc.resolution,
          doc.release
        ].filter(Boolean).join(' ');
        const normalizedText = text.toLowerCase();
        const titleNorm = normalizedText.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const qualityHeight = /2160p|\b4k\b|\buhd\b/i.test(text)
          ? 2160
          : /1440p|\b2k\b/i.test(text)
            ? 1440
            : /1080p|\bfhd\b/i.test(text)
              ? 1080
              : /720p|\bhd\b/i.test(text)
                ? 720
                : 0;

        // Quality is intentionally a first-class score. A 2160p result with an
        // empty IMDb field must beat a matching IMDb id attached to 1080p.
        if (qualityHeight >= 2160) s += 1200;
        else if (qualityHeight === 1440) s += 650;
        else if (qualityHeight === 1080) s += 180;
        else if (qualityHeight === 720) s += 70;
        if (imdbId && String(doc.imdb_id || '').trim() === imdbId) s += 350;
        if (titleNorm.includes(wantedTitle)) s += 140;
        if (wantedYear && normalizedText.includes(String(wantedYear))) s += 80;
        if (isTv) {
          const sNum = Number(metadata.season || 1);
          if (new RegExp(`season\s*0*${sNum}\b|\bs0*${sNum}\b`, 'i').test(text)) s += 90;
        } else if (!/season\s*\d+/i.test(text)) {
          s += 40;
        }
        return s;
      };

      const best = uniqueDocuments.sort((a, b) => scoreDoc(b) - scoreDoc(a))[0];
      if (!best || !best.permalink || scoreDoc(best) < 80) continue;

      const postUrl = new URL(best.permalink, host).href;
      const postRes = await fetchWithDeadline(
        postUrl,
        USER_AGENT,
        controller.signal,
        deadline,
        { headers: fourKBrowserHeaders(lastSearchUrl || `${host}/`) }
      );
      if (postRes && postRes.ok) {
        postHtml = await readCappedText(postRes);
        if (isAntiBotPage(postHtml)) {
          postHtml = '';
          continue;
        }
        activeHost = host;
        postBaseUrl = postRes.url || postUrl;
        if (postHtml) break;
      }
    }

    if (!postHtml) {
      return { ok: false, reason: 'moviesdrive4k_no_matching_post' };
    }

    // Extract quality headings + archive/hubcloud links
    const candidates = [];
    const seasonNum = Number(metadata.season || 1);
    const episodeNum = Number(metadata.episode || 1);

    // Split on any heading level so each link inherits its quality/audio
    // description; current MoviesDrive themes have used both h4 and h5.
    const sections = postHtml.split(/<h[1-6]\b[^>]*>/i);
    for (const sec of sections.slice(1)) {
      const headingClose = sec.match(/<\/h[1-6]>/i);
      const headingEnd = headingClose ? headingClose.index : -1;
      const headingText = (headingEnd !== -1 ? sec.slice(0, headingEnd) : sec.slice(0, 240))
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const bodyStart = headingEnd !== -1 ? headingEnd + headingClose[0].length : 0;
      const bodyPart = sec.slice(bodyStart, bodyStart + 1800);
      // Some themes put the download anchor inside the heading itself:
      // `<h5><a href="...">1080p</a></h5>`.
      const linkPart = sec.slice(0, bodyStart + 1800);

      if (/\.zip\b|\bpack\b/i.test(headingText) && isTv && !/single\s*episode/i.test(headingText)) {
        continue;
      }

      const height = parseResolutionHeight(headingText);
      const audioHints = parseHicineAudioHints(hicineAudioHintText(headingText));

      const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let lm;
      while ((lm = linkRe.exec(linkPart))) {
        const rawHref = lm[1].trim().replace(/&amp;/g, '&');
        let href;
        try { href = new URL(rawHref, postBaseUrl || `${activeHost}/`).href; } catch { continue; }
        const linkLabel = lm[2].replace(/<[^>]+>/g, ' ').trim();
        if (!/mdrive|hubcloud|hubcdn|vcloud|gdflix|search-recover|\/drive\//i.test(`${href} ${linkLabel}`)) continue;

        candidates.push({
          url: href,
          linkType: /hubcloud|hubcdn/i.test(href) ? 'hubcloud' : 'archive',
          height,
          description: `${headingText} ${linkLabel}`.trim(),
          audioHints
        });
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: 'moviesdrive4k_no_candidate_links' };
    }

    // Prioritize 2160p (4K) multi-audio candidates first
    const sortedCandidates = [...candidates].sort(
      (a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio)
    );
    const fourKCandidates = sortedCandidates.filter((candidate) => candidate.height >= 2160);
    const lowerQualityCandidates = sortedCandidates.filter((candidate) => candidate.height < 2160);
    const preferred1080 = lowerQualityCandidates.filter((candidate) => candidate.height >= 1080).slice(0, 2);
    const selectedCandidates = Array.from(new Map(
      [...fourKCandidates.slice(0, 3), ...preferred1080, ...lowerQualityCandidates.slice(0, 2)]
        .map((candidate) => [candidate.url, candidate])
    ).values()).slice(0, 7);

    const settledItems = await Promise.all(selectedCandidates.map(async (cand) => {
      let targetUrl = cand.url;
      if (isTv && /mdrive\.|\/archive\/\d+/i.test(targetUrl)) {
        const archRes = await fetchWithDeadline(
          targetUrl,
          USER_AGENT,
          controller.signal,
          deadline,
          { headers: fourKBrowserHeaders(activeHost ? `${activeHost}/` : '') }
        );
        if (archRes && archRes.ok) {
          const archHtml = await readCappedText(archRes);
          if (isAntiBotPage(archHtml)) return null;
          const epRegex = new RegExp(
            `(?:Ep(?:isode)?\s*0*${episodeNum}\b|S0*${seasonNum}E0*${episodeNum}\b)[\s\S]{0,600}?href=["'](https?:\/\/[^"']*(?:hubcloud|hubcdn|vcloud)[^"']*)["']`,
            'i'
          );
          const epMatch = archHtml.match(epRegex);
          if (epMatch && epMatch[1]) targetUrl = epMatch[1];
        }
      }
      const directUrl = await unroll4kCandidateUrl(
        targetUrl,
        controller.signal,
        deadline,
        activeHost ? `${activeHost}/` : ''
      );
      if (!directUrl) return null;
      return {
        rawUrl: directUrl,
        streamUrl: directUrl,
        height: cand.height,
        description: cand.description,
        audioHints: cand.audioHints,
        format: /\.m3u8(\?|$)/i.test(directUrl) ? 'hls' : 'mp4'
      };
    }));
    const seenUrls = new Set();
    const resolvedItems = settledItems.filter((item) => {
      if (!item || seenUrls.has(item.rawUrl)) return false;
      seenUrls.add(item.rawUrl);
      return true;
    });

    if (resolvedItems.length === 0) return { ok: false, reason: 'moviesdrive4k_unroll_failed' };

    const payload = await build4kStreamPayload({
      serverId: 'ursa',
      tier: 'moviesdrive4k',
      resolvedItems,
      referer: activeHost ? `${activeHost}/` : '',
      preferredAudio
    });
    return payload ? { ok: true, ...payload } : { ok: false, reason: 'moviesdrive4k_payload_empty' };
  } catch (err) {
    return { ok: false, reason: `moviesdrive4k_error:${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 3: HiCine 4K UHD Resolver
 * Queries api.hicine.sbs/api/search/{title}, specifically targeting `[2160P]` / `4K`
 * entries at the bottom of HiCine's links block (which Centaurus skips due to its 4-item cap),
 * and resolves vcloud worker tokens (`ten`, `fsl2`, `fsl`, `r2`) to direct 2160p Dual-Audio streams.
 */
async function resolveHicine4k(metadata, preferredAudio = '') {
  if (!metadata || !metadata.title || !config.upstreams.hicineApiBase) {
    return { ok: false, reason: 'hicine4k_missing_config' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 11000);
  const unrollDeadline = Date.now() + 9500;

  try {
    const searchUrl = `${config.upstreams.hicineApiBase}/api/search/${encodeURIComponent(metadata.title)}`;
    const res = await fetch(searchUrl, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, reason: `hicine4k_http_${res.status}` };

    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, reason: 'hicine4k_no_search_results' };
    }

    const isTv = metadata.type === 'tv';
    const wantedYear = Number(metadata.releaseYear) || 0;
    const wantedTitle = String(metadata.title || '').toLowerCase().trim();

    const scoreItem = (item) => {
      let s = 0;
      const itemTitle = String(item.title || item.name || '').toLowerCase().trim();
      if (itemTitle === wantedTitle) s += 100;
      else if (itemTitle.startsWith(wantedTitle) || itemTitle.includes(wantedTitle)) s += 40;
      const itemYear = Number(item.releaseYear || item.year) || 0;
      if (wantedYear && itemYear) {
        const delta = Math.abs(itemYear - wantedYear);
        if (delta === 0) s += 100;
        else if (delta <= 1) s += 70;
        else s -= 25;
      }
      if (isTv && (item.contentType === 'series' || item.season_1)) s += 30;
      else if (!isTv && (item.contentType === 'movies' || item.links)) s += 30;
      return s;
    };

    const chosen = [...items].sort((a, b) => scoreItem(b) - scoreItem(a))[0];
    if (!chosen) return { ok: false, reason: 'hicine4k_no_match' };

    const rawText = isTv
      ? chosen[`season_${metadata.season || 1}`] || chosen.season_1 || ''
      : chosen.links || '';

    const extracted = parseHicineLinks(rawText, isTv, metadata.episode || 1);
    const entries4k = extracted.filter(
      (e) => e.height >= 2160 || /2160p|\b4k\b|\buhd\b/i.test(`${e.quality} ${e.description}`)
    );

    if (extracted.length === 0) {
      return { ok: false, reason: 'hicine4k_no_quality_entries' };
    }

    // Prefer 2160p when present, but retain a real lower-quality path. A title
    // without a UHD row should still resolve through Ursa and advertise the
    // degradation instead of being treated as an exhausted provider.
    const sorted4k = entries4k.sort(
      (a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio)
    );
    const lowerQuality = extracted
      .filter((entry) => entry.height < 2160)
      .sort((a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio));
    const orderedEntries = entries4k.length
      ? [...sorted4k.slice(0, 4), ...lowerQuality.slice(0, 2)]
      : lowerQuality.slice(0, 6);

    const settledItems = await Promise.all(orderedEntries.map(async (entry) => {
      if (entry.type === 'pixeldrain') {
        const url = normalizePlayableUrl(entry.url);
        if (!(await probePlayableMediaUrl(url, {
          signal: controller.signal,
          deadline: unrollDeadline,
          timeoutMs: 1800
        }))) return null;
        return {
          rawUrl: url,
          streamUrl: url,
          height: entry.height >= 2160 ? 2160 : entry.height,
          description: entry.description || '',
          audioHints: entry.audioHints || parseHicineAudioHints(entry.description || ''),
          format: 'mp4'
        };
      }
      if (entry.type !== 'vcloud_worker') return null;
      const resolved = await resolveVcloudWorkerLink(entry.url, controller.signal, unrollDeadline);
      if (!resolved?.url || resolved.isHotlinkBlocked) return null;
      return {
        rawUrl: resolved.url,
        streamUrl: resolved.url,
        height: entry.height >= 2160 ? 2160 : entry.height,
        description: `${entry.description || ''} ${resolved.title || ''}`.trim(),
        audioHints: entry.audioHints || parseHicineAudioHints(`${entry.description || ''} ${resolved.title || ''}`),
        tokenType: resolved.tokenType,
        format: resolved.format || 'mp4'
      };
    }));
    const seenDirect = new Set();
    const resolvedItems = settledItems.filter((item) => {
      if (!item || seenDirect.has(item.rawUrl)) return false;
      seenDirect.add(item.rawUrl);
      return true;
    });

    if (resolvedItems.length === 0) {
      return { ok: false, reason: 'hicine4k_unroll_failed' };
    }

    const payload = await build4kStreamPayload({
      serverId: 'ursa',
      tier: 'hicine4k',
      resolvedItems,
      preferredAudio
    });
    return payload ? { ok: true, ...payload } : { ok: false, reason: 'hicine4k_payload_empty' };
  } catch (err) {
    return { ok: false, reason: `hicine4k_error:${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 4: DahmerMovies 4K Open-Directory Resolver
 * Queries `https://a.111477.xyz/movies/<Title> (<Year>)/` or `/tvs/<Title>/Season <NN>/`,
 * extracts direct 2160p / 4K `.mkv`/`.mp4` streams (Original / Multi-Audio).
 */
async function resolveDahmer4k(metadata, preferredAudio = '') {
  const dahmerBase = (config.upstreams.dahmerBase || '').trim().replace(/\/$/, '');
  if (!dahmerBase || !metadata || !metadata.title) {
    return { ok: false, reason: 'dahmer4k_missing_config' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10500);
  const deadline = Date.now() + 9000;

  try {
    const cleanTitle = String(metadata.title || '').replace(/:/g, '').replace(/\s+/g, ' ').trim();
    const isTv = metadata.type === 'tv';
    const seasonNum = Number(metadata.season || 1);
    const episodeNum = Number(metadata.episode || 1);
    const paths = isTv
      ? [
          `/tvs/${encodeURIComponent(cleanTitle)}/Season%20${String(seasonNum).padStart(2, '0')}/`,
          `/tvs/${encodeURIComponent(cleanTitle)}/Season%20${seasonNum}/`
        ]
      : [
          ...(metadata.releaseYear
            ? [`/movies/${encodeURIComponent(`${cleanTitle} (${metadata.releaseYear})`)}/`]
            : []),
          `/movies/${encodeURIComponent(cleanTitle)}/`
        ];

    let dirHtml = '';
    let dirUrl = '';
    for (const p of paths) {
      const target = `${dahmerBase}${p}`;
      const res = await fetchWithDeadline(
        target,
        USER_AGENT,
        controller.signal,
        deadline,
        { headers: fourKBrowserHeaders(`${dahmerBase}/`) }
      );
      if (res && res.ok) {
        const text = await readCappedText(res);
        if (isAntiBotPage(text)) continue;
        if (text && /<a\s+href=/i.test(text)) {
          dirHtml = text;
          dirUrl = target;
          break;
        }
      }
    }

    if (!dirHtml) {
      return { ok: false, reason: 'dahmer4k_directory_not_found' };
    }

    const epPattern = new RegExp(`S0*${seasonNum}E0*${episodeNum}\\b|\\bE0*${episodeNum}\\b`, 'i');
    const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const files = [];
    let m;
    while ((m = linkRe.exec(dirHtml))) {
      const rawHref = m[1].trim();
      const filename = m[2].replace(/<[^>]+>/g, '').trim();
      if (!/\.(mkv|mp4|webm|m4v)([?#]|$)/i.test(`${rawHref} ${filename}`)) continue;
      if (isTv && !epPattern.test(`${rawHref} ${filename}`)) continue;

      let resolvedHref = '';
      try {
        resolvedHref = new URL(rawHref, dirUrl).href;
        if (resolvedHref.includes('/bulk?u=')) {
          const encodedPart = resolvedHref.split('/bulk?u=')[1].split('&')[0];
          resolvedHref = decodeURIComponent(encodedPart);
        }
      } catch {
        continue;
      }

      const height = parseResolutionHeight(`${filename} ${rawHref}`);
      const audioHints = parseHicineAudioHints(hicineAudioHintText(filename));
      files.push({
        rawUrl: resolvedHref,
        streamUrl: resolvedHref,
        height,
        description: filename,
        audioHints,
        format: 'mp4'
      });
    }

    const sorted4k = files.filter((file) => file.height >= 2160)
      .sort((a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio));
    const lowerQuality = files.filter((file) => file.height < 2160)
      .sort((a, b) => score4kCandidate(b, preferredAudio) - score4kCandidate(a, preferredAudio));
    const filesToProbe = [
      ...sorted4k.slice(0, 4),
      ...lowerQuality.filter((file) => file.height >= 720).slice(0, 3)
    ];
    const checkedFiles = await Promise.all(filesToProbe.map(async (file) =>
      await probePlayableMediaUrl(file.rawUrl, {
        signal: controller.signal,
        deadline,
        timeoutMs: 1800,
        headers: { Referer: `${dahmerBase}/` }
      }) ? file : null
    ));
    const playableFiles = checkedFiles.filter(Boolean);
    if (playableFiles.length === 0) {
      return { ok: false, reason: 'dahmer4k_no_playable_files' };
    }

    const payload = await build4kStreamPayload({
      serverId: 'ursa',
      tier: 'dahmer4k',
      resolvedItems: playableFiles,
      referer: `${dahmerBase}/`,
      headers: { Referer: `${dahmerBase}/` },
      preferredAudio
    });
    return payload ? { ok: true, ...payload } : { ok: false, reason: 'dahmer4k_payload_empty' };
  } catch (err) {
    return { ok: false, reason: `dahmer4k_error:${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 2b. Ursa / 4K UHD Server Multi-Tier Orchestrator
 * Cascades through:
 *   Tier 1: 4KHDHub      (2160p UHD BluRay REMUX / WEB-DL Dual/Multi-Audio)
 *   Tier 2: MoviesDrive  (Typesense IMDb API + 2160p Dual-Audio HubCloud)
 *   Tier 3: HiCine 4K    (2160p SDR/HDR Dual-Audio vcloud worker)
 *   Tier 4: Dahmer 4K    (2160p Original/Multi-Audio direct open-directory MKV)
 * Plus local mock VidSrc fallback when vidsrcDataUrl points to 127.0.0.1/localhost.
 */
// Four tiers run concurrently, but each can spend several seconds on a
// redirector hop plus range probes. Keep enough wall-clock budget for the
// slowest live tier without serialising the cascade.
const URSA_RESOLVE_TIMEOUT_MS = 22000;

function isVerifiedUrsa2160Result(result) {
  const rawUrl = String(result?.rawUrl || '');
  return !!(
    result?.streamUrl &&
    /^https?:\/\//i.test(rawUrl) &&
    scorePlayableUrl(rawUrl) >= 0 &&
    !isHubcloudGeneratorUrl(rawUrl) &&
    !extractHttpLinkParam(rawUrl) &&
    !extractWrappedMediaTargets(rawUrl).length &&
    Array.isArray(result.qualities) &&
    (
      result.qualities.some((quality) => Number(quality.height) >= 2160) ||
      result.qualityDegraded === true
    )
  );
}

/** Ursa resolves all four independent 4K tiers concurrently, then keeps priority order. */
async function resolveUrsaServer(metadata, requestedServerId = 'ursa', preferredAudio = '') {
  const providerKey = 'ursa:4k';
  const diag = {
    server: 'ursa',
    alias: requestedServerId,
    steps: [],
    startedAt: new Date().toISOString()
  };
  const stamp = (step, detail = '') => {
    diag.steps.push({ step, detail, t: Date.now() });
    diag.message = detail || step;
  };

  if (!circuitBreaker.isAvailable(providerKey)) {
    stamp('circuit_open', 'Ursa (4K UHD) circuit breaker is open');
    return { ok: false, reason: 'circuit_open', diag };
  }

  const tiers = [
    {
      id: '4khdhub',
      attempt: 'Attempting Tier 1: 4KHDHub (2160p UHD Multi-Audio)...',
      run: () => resolve4khdhub(metadata, preferredAudio)
    },
    {
      id: 'moviesdrive4k',
      attempt: 'Attempting Tier 2: MoviesDrive 4K (Typesense IMDb + 2160p HubCloud)...',
      run: () => resolveMoviesdrive4k(metadata, preferredAudio)
    },
    {
      id: 'hicine4k',
      attempt: 'Attempting Tier 3: HiCine 4K UHD (2160p vcloud worker)...',
      run: () => resolveHicine4k(metadata, preferredAudio)
    },
    {
      id: 'dahmer4k',
      attempt: 'Attempting Tier 4: DahmerMovies 4K (2160p direct directory)...',
      run: () => resolveDahmer4k(metadata, preferredAudio)
    }
  ];
  for (const tier of tiers) stamp(`${tier.id}_attempt`, tier.attempt);

  let timeoutId;
  const results = await Promise.race([
    Promise.all(tiers.map(async (tier) => {
      try {
        const result = await tier.run();
        return result && result.ok && isVerifiedUrsa2160Result(result)
          ? result
          : result && result.ok
            ? { ...result, ok: false, reason: `${tier.id}_no_verified_2160p` }
            : result;
      } catch (error) {
        return { ok: false, reason: `${tier.id}_error:${error.message}` };
      }
    })),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), URSA_RESOLVE_TIMEOUT_MS);
    })
  ]).finally(() => clearTimeout(timeoutId));

  if (!results) {
    stamp('ursa_timeout', `Ursa 4K resolution exceeded the ${URSA_RESOLVE_TIMEOUT_MS}ms request budget`);
    return { ok: false, reason: 'ursa_upstream_timeout', diag };
  }

  let selected = null;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    const result = results[index];
    if (!selected && result?.ok && result.streamUrl) {
      selected = result;
      const qualityNote = result.qualityDegraded
        ? `quality degraded to ${result.qualities?.[0]?.label || 'the best available quality'}`
        : `verified 4K (${result.qualities?.[0]?.label || '2160p'})`;
      stamp(`${tier.id}_success`, `Resolved ${qualityNote} via ${tier.id}`);
    } else {
      stamp(`${tier.id}_failed`, result?.reason || `${tier.id} returned no verified 2160p stream`);
    }
  }

  if (selected) {
    diag.selectedTier = selected.tier;
    diag.qualityDegraded = selected.qualityDegraded === true;
    diag.message = selected.qualityDegraded
      ? `Resolved best available quality via ${selected.tier} (${selected.qualities?.[0]?.label || 'fallback'})`
      : `Resolved verified 4K stream via ${selected.tier} (${selected.qualities?.[0]?.label || '2160p'})`;
    circuitBreaker.recordSuccess(providerKey);
    return { ...selected, diag };
  }

  // Test/Mock Fallback: if vidsrcDataUrl explicitly points to localhost.
  if (config.upstreams.vidsrcDataUrl && /127\.0\.0\.1|localhost/i.test(config.upstreams.vidsrcDataUrl)) {
    stamp('vidsrc_mock_attempt', 'Attempting local VidSrc mock fallback...');
    const vsRes = await resolveVidsrcServer(metadata);
    if (vsRes && vsRes.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      return { ok: true, ...vsRes, diag };
    }
  }

  stamp(
    'ursa_4k_exhausted',
    'All four Ursa 4K UHD sub-providers failed to resolve a verified 2160p stream.'
  );
  return {
    ok: false,
    reason: 'ursa_all_4k_sources_exhausted',
    diag
  };
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

function applyPreferredAudio(resolved, preferredAudio) {
  if (!resolved || !preferredAudio || !Array.isArray(resolved.audioTracks)) return resolved;
  const wanted = String(preferredAudio).trim().toLowerCase();
  const wantedLanguage = normalizeAudioLanguage(wanted);
  const matchTrack = resolved.audioTracks.find((track) =>
    String(track.id || '').toLowerCase() === wanted ||
    (wantedLanguage !== 'und' && normalizeAudioLanguage(track.lang) === wantedLanguage)
  );
  if (!matchTrack) return resolved;

  const audioTracks = resolved.audioTracks.map((track) => ({
    ...track,
    default: track.id === matchTrack.id
  }));
  return {
    ...resolved,
    audioTracks,
    streamUrl: matchTrack.streamUrl || resolved.streamUrl,
    rawUrl: matchTrack.rawUrl || resolved.rawUrl,
    activeAudioTrack: audioTracks.find((track) => track.id === matchTrack.id) || null
  };
}

/**
 * Resolve stream for a specific server ID, or waterfall across all production servers
 * until a working stream is found. Zero test/demo videos.
 */
async function resolveStreamForServer(metadata, requestedServerId = 'andromeda', preferredAudio = '') {
  // 1. Check whether the owner configured a custom stream override for this TMDB ID via /api/admin
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
  const normalizedServerId = ['4k', 'uhd', '2160p'].includes(String(requestedServerId || '').toLowerCase())
    ? 'ursa'
    : String(requestedServerId || 'andromeda').toLowerCase();
  const validServer =
    enabledServers.find((s) => s.id === normalizedServerId)?.id ||
    enabledServers[0]?.id ||
    'andromeda';

  const cacheKey = `resolve:v3:${metadata.type}:${metadata.tmdbId}:s${metadata.season || 1}:e${metadata.episode || 1}:${validServer}`;
  const cached = await cache.get(cacheKey);
  if (cached) return applyPreferredAudio(cached, preferredAudio);

  // Build ordered waterfall starting with the user's selected server, then the
  // premier multi-audio cascade: Andromeda (Server 1) -> Ursa (Server 2: 4K UHD) -> Centaurus -> Atlas -> Strings.
  const WATERFALL_PRIORITY = ['andromeda', 'centaurus', 'ursa', 'hamster', 'atlas'];
  const enabledIds = enabledServers.map((s) => s.id);
  const isImplicitFallback = (id) => {
    const server = config.servers.find((s) => s.id === id);
    return !server || server.fallback !== false;
  };
  const prioritized = [
    ...WATERFALL_PRIORITY.filter((id) => enabledIds.includes(id)),
    // Opt-in servers (e.g. the TMDB-id keyed "hindi" server) are only used
    // when explicitly requested, keeping the default waterfall unchanged.
    ...enabledIds.filter((id) => !WATERFALL_PRIORITY.includes(id) && isImplicitFallback(id))
  ];
  const serverOrder = [validServer, ...prioritized.filter((id) => id !== validServer)];
  const serverAttempts = [];

  for (const srvId of serverOrder) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'andromeda') {
      resolved = await resolveAndromedaServer(metadata, srvId, preferredAudio);
    } else if (srvId === 'atlas') {
      resolved = await resolveVidstuckServer(metadata, srvId);
    } else if (srvId === 'hamster') {
      resolved = await resolveHamsterWheelServer(metadata, srvId, preferredAudio);
    } else if (srvId === 'ursa') {
      resolved = await resolveUrsaServer(metadata, requestedServerId, preferredAudio);
    } else if (srvId === 'centaurus') {
      resolved = await resolveHicineServer(metadata);
    } else if (srvId === 'hindi') {
      // Lazy require: dubCatalog consumes the provider resolvers above.
      const { resolveHindiServer } = require('./dubCatalog');
      resolved = await resolveHindiServer(metadata, preferredAudio || 'hi');
    }
    const latencyMs = Date.now() - t0;

    if (resolved && resolved.streamUrl) {
      telemetry.recordServerAttempt(srvId, true, latencyMs);
      const payload = {
        ...resolved,
        requestedServer: validServer,
        serverAttempts,
        activeAudioTrack:
          (resolved.audioTracks || []).find((t) => t.default) || (resolved.audioTracks || [])[0] || null,
        servers: enabledServers.map((s) => ({
          ...s,
          active: s.id === resolved.server
        }))
      };

      // Cache the canonical source selection; apply each caller's audio preference
      // on a clone so one viewer cannot change the next viewer's cached default.
      await cache.set(cacheKey, payload, 900);
      return applyPreferredAudio(payload, preferredAudio);
    } else {
      const reason =
        resolved && resolved.reason ? resolved.reason : 'no_stream';
      const diag = resolved && resolved.diag ? resolved.diag : null;
      telemetry.recordServerAttempt(srvId, false, latencyMs, reason);
      // Preserve the reason so API consumers can report why this server failed
      // instead of returning "All upstream servers failed" with no context.
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
  resolveAndromedaServer,
  resolveCastletv,
  resolveNetmirror,
  resolveUrsaServer,
  resolve4khdhub,
  resolveMoviesdrive4k,
  resolveHicine4k,
  resolveDahmer4k,
  decode4khdhubRedirectHtml,
  unroll4kCandidateUrl,
  parse4khdhubSearchCards,
  get4kDownloadBlocks,
  extractHubcloudXhrEndpoints,
  isDdosGuardPage,
  rot13Cipher,
  resolveVidstuckServer,
  resolveVidsrcServer,
  resolveHicineServer,
  resolveHianimeServer,
  buildCastleKey,
  decryptCastleAes,
  mapLanguageNameToCode,
  decryptVidsrcWasmPayload,
  decodeZokoAnimeXorPayload,
  parseHicineLinks,
  parseHicineAudioHints,
  // Resolver internals exposed for focused regression tests.
  isHubcloudGeneratorUrl,
  unrollHubcloudUrl,
  extractWrappedMediaTargets,
  normalizePlayableUrl,
  scorePlayableUrl,
  probePlayableMediaUrl
};
