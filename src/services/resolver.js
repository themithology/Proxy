const crypto = require('crypto');
const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { decryptZxcLink } = require('../utils/crypto');
const { buildProxyStreamUrl } = require('./proxy');
const { prepareMultiTrackStream, normalizeAudioLanguage } = require('./multitrack');
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
 * Bollywood / Pan-Indian Hindi dubs, K-Drama/C-Drama dubs, and Hollywood multi-audio.
 */
async function resolveCastletv(metadata, preferredAudio = '', parentSignal = null) {
  const castletvBase = (config.upstreams.castletvBase || 'https://api.hlowb.com').replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const key = await getCastleSecurityKey(castletvBase, controller.signal);

    const searchTerm = `${metadata.title || ''} ${metadata.releaseYear || ''}`.trim();
    if (!searchTerm) return null;

    const searchParams = new URLSearchParams({
      channel: 'IndiaA',
      clientType: '1',
      keyword: searchTerm,
      lang: 'en',
      mode: '1',
      packageName: 'com.external.castle',
      page: '1',
      size: '30'
    });

    const searchRes = await fetch(
      `${castletvBase}/film-api/v1.1.0/movie/searchByKeyword?${searchParams.toString()}`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal
      }
    );
    if (!searchRes.ok) return null;
    const searchCipher = await searchRes.text();
    const searchJson = JSON.parse(decryptCastleAes(searchCipher, key));
    const rows = (searchJson?.data?.rows) || [];
    if (!rows.length) return null;

    const targetTitleNorm = (metadata.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let matchedRow = rows.find((r) => {
      const rowNorm = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return rowNorm === targetTitleNorm || rowNorm.includes(targetTitleNorm) || targetTitleNorm.includes(rowNorm);
    }) || rows[0];

    const movieId = matchedRow.id || matchedRow.redirectId || matchedRow.redirectIdStr;
    if (!movieId) return null;

    const detRes = await fetch(
      `${castletvBase}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en&movieId=${movieId}&packageName=com.external.castle`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal
      }
    );
    if (!detRes.ok) return null;
    const detCipher = await detRes.text();
    const detJson = JSON.parse(decryptCastleAes(detCipher, key));
    const episodes = (detJson?.data?.episodes) || [];

    const isTv = metadata.type === 'tv';
    let targetEpisode = null;
    if (isTv) {
      targetEpisode = episodes.find((e) => Number(e.number) === Number(metadata.episode || 1)) || episodes[0];
    } else {
      targetEpisode = episodes[0];
    }
    if (!targetEpisode) return null;

    const episodeId = targetEpisode.id;
    const rawTracks =
      targetEpisode.tracks && targetEpisode.tracks.length > 0
        ? targetEpisode.tracks
        : [{ languageId: null, languageName: 'Original', videos: targetEpisode.videos || [] }];

    const referer = `${castletvBase}/`;
    const APK_SIGN_KEY = 'ED0955EB04E67A1D9F3305B95454FED485261475';

    // Fetch stream URLs across tracks in parallel
    const trackJobs = rawTracks.map(async (t) => {
      const resOptions = [4, 2, 1];
      for (const res of resOptions) {
        try {
          const body = {
            mode: '1',
            appMarket: 'GuanWang',
            clientType: '1',
            woolUser: 'false',
            apkSignKey: APK_SIGN_KEY,
            androidVersion: '13',
            movieId: String(movieId),
            episodeId: String(episodeId),
            isNewUser: 'true',
            resolution: String(res),
            packageName: 'com.external.castle'
          };
          if (t.languageId != null) body.languageId = String(t.languageId);

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
          const vCipher = await vRes.text();
          const vJson = JSON.parse(decryptCastleAes(vCipher, key));
          const vUrl = vJson?.data?.videoUrl || vJson?.data?.videos?.[0]?.url;
          if (vUrl) {
            return {
              languageId: t.languageId,
              languageName: t.languageName,
              videoUrl: vUrl,
              resolution: res === 4 ? 1080 : res === 2 ? 720 : 480
            };
          }
        } catch {}
      }
      return null;
    });

    const settled = await Promise.allSettled(trackJobs);
    const validTracks = settled
      .filter((s) => s.status === 'fulfilled' && s.value && s.value.videoUrl)
      .map((s) => s.value);

    if (!validTracks.length) return null;

    const wanted = (preferredAudio || '').trim().toLowerCase();
    const wantedCode = wanted ? normalizeAudioLanguage(wanted) : '';

    const audioTracks = validTracks.map((t, idx) => {
      const langCode = mapLanguageNameToCode(t.languageName);
      const isDefault = wantedCode ? langCode === wantedCode : idx === 0;
      const proxiedUrl = buildProxyStreamUrl(t.videoUrl, referer, '', { mode: 'full' });
      return {
        id: `castle-${t.languageId || langCode || idx}`,
        lang: langCode,
        label: t.languageName || 'Original Audio',
        type: 'dub',
        streamUrl: proxiedUrl,
        rawUrl: t.videoUrl,
        default: isDefault
      };
    });

    if (!audioTracks.some((a) => a.default)) {
      audioTracks[0].default = true;
    }

    const activeTrack = audioTracks.find((a) => a.default) || audioTracks[0];
    const qualities = [
      { label: 'Auto', height: 0, url: activeTrack.streamUrl },
      { label: '1080p', height: 1080, url: activeTrack.streamUrl },
      { label: '720p', height: 720, url: activeTrack.streamUrl }
    ];

    return {
      server: 'andromeda',
      sourceName: 'CastleTV',
      format: 'hls',
      rawUrl: activeTrack.rawUrl,
      streamUrl: activeTrack.streamUrl,
      referer,
      headers: { Referer: referer },
      backupUrls: [
        buildProxyStreamUrl(activeTrack.rawUrl, referer, '', { mode: 'manifest' })
      ],
      audioTracks,
      qualities
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sub-provider 2 for Andromeda: Moviebox API (https://api3.aoneroom.com)
 * Comprehensive international & Hollywood catalog with discrete dubbed streams.
 */
const MBOX_KEY_B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';

function getMovieboxSecret() {
  try {
    return Buffer.from(Buffer.from(MBOX_KEY_B64, 'base64').toString('utf8'), 'base64');
  } catch {
    return Buffer.from(MBOX_KEY_B64, 'base64');
  }
}

function buildMovieboxHeaders(method, urlStr, bodyStr, secret) {
  const ts = Date.now().toString();
  const reversed = ts.split('').reverse().join('');
  const token = `${ts},${crypto.createHash('md5').update(reversed).digest('hex')}`;

  let path = '';
  let query = '';
  try {
    const u = new URL(urlStr);
    path = u.pathname;
    const sortedKeys = Array.from(u.searchParams.keys()).sort();
    if (sortedKeys.length) {
      query = sortedKeys.map((k) => `${k}=${u.searchParams.getAll(k).join('&')}`).join('&');
    }
  } catch {
    path = urlStr;
  }
  const canonicalUrl = query ? `${path}?${query}` : path;
  const bodyHash = bodyStr ? crypto.createHash('md5').update(bodyStr).digest('hex') : '';
  const bodyLen = bodyStr ? Buffer.byteLength(bodyStr, 'utf8').toString() : '';
  const canonical = `${method.toUpperCase()}\napplication/json\napplication/json\n${bodyLen}\n${ts}\n${bodyHash}\n${canonicalUrl}`;
  const sig = `${ts}|2|${crypto.createHmac('md5', secret).update(canonical).digest('base64')}`;

  const clientInfo = JSON.stringify({
    package_name: 'com.community.mbox.in',
    version_name: '3.0.03.0529.03',
    version_code: 50020042,
    os: 'android',
    os_version: '16',
    device_id: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
    install_store: 'ps',
    gaid: 'd7578036d13336cc',
    brand: 'samsung',
    model: 'SM-S918B',
    system_language: 'en',
    net: 'NETWORK_WIFI',
    region: 'IN',
    timezone: 'Asia/Calcutta',
    sp_code: ''
  });

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-client-token': token,
    'x-tr-signature': sig,
    'User-Agent':
      'com.community.mbox.in/50020042 (Linux; U; Android 16; en_IN; SM-S918B; Build/BP22.250325.006; Cronet/133.0.6876.3)',
    'x-client-info': clientInfo,
    'x-client-status': '0'
  };
}

async function resolveMoviebox(metadata, preferredAudio = '', parentSignal = null) {
  const movieboxBase = (config.upstreams.movieboxBase || 'https://api3.aoneroom.com').replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const secret = getMovieboxSecret();

  try {
    const searchBody = JSON.stringify({ page: 1, perPage: 20, keyword: metadata.title || '' });
    const searchUrl = `${movieboxBase}/wefeed-mobile-bff/subject-api/search/v2`;
    const searchRes = await fetch(searchUrl, {
      method: 'POST',
      headers: buildMovieboxHeaders('POST', searchUrl, searchBody, secret),
      body: searchBody,
      signal: controller.signal
    });
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const subjects = [];
    if (searchJson?.data?.results) {
      searchJson.data.results.forEach((group) => {
        if (group.subjects) subjects.push(...group.subjects);
      });
    }
    if (!subjects.length) return null;

    const targetType = metadata.type === 'tv' ? 2 : 1;
    const normTmdb = (metadata.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const best =
      subjects.find((s) => {
        const norm = (s.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return s.subjectType === targetType && (norm === normTmdb || norm.includes(normTmdb) || normTmdb.includes(norm));
      }) ||
      subjects.find((s) => s.subjectType === targetType) ||
      subjects[0];

    if (!best || !best.subjectId) return null;
    const subjectId = best.subjectId;

    const getUrl = `${movieboxBase}/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`;
    const getRes = await fetch(getUrl, {
      headers: buildMovieboxHeaders('GET', getUrl, null, secret),
      signal: controller.signal
    });
    if (!getRes.ok) return null;
    const getJson = await getRes.json();
    const dubs = getJson?.data?.dubs || [];
    const dubTargets = [{ id: subjectId, lang: 'Original' }];
    if (Array.isArray(dubs)) {
      dubs.forEach((d) => {
        if (d.subjectId && d.subjectId !== subjectId) {
          dubTargets.push({ id: d.subjectId, lang: d.lanName || 'Dubbed' });
        }
      });
    }

    const season = metadata.type === 'tv' ? metadata.season || 1 : 0;
    const episode = metadata.type === 'tv' ? metadata.episode || 1 : 0;
    const referer = `${movieboxBase}/`;

    const streamJobs = dubTargets.map(async (t) => {
      const playUrl = `${movieboxBase}/wefeed-mobile-bff/subject-api/play-info?subjectId=${t.id}&se=${season}&ep=${episode}`;
      try {
        const pRes = await fetch(playUrl, {
          headers: buildMovieboxHeaders('GET', playUrl, null, secret),
          signal: controller.signal
        });
        if (!pRes.ok) return null;
        const pJson = await pRes.json();
        const streams = pJson?.data?.streams || [];
        const chosen = streams.find((s) => s.url) || null;
        if (chosen?.url) {
          return {
            id: t.id,
            lang: t.lang,
            url: chosen.url,
            quality: chosen.resolutions || chosen.quality || 'Auto'
          };
        }
      } catch {}
      return null;
    });

    const settled = await Promise.allSettled(streamJobs);
    const valid = settled
      .filter((s) => s.status === 'fulfilled' && s.value && s.value.url)
      .map((s) => s.value);
    if (!valid.length) return null;

    const wanted = (preferredAudio || '').trim().toLowerCase();
    const wantedCode = wanted ? normalizeAudioLanguage(wanted) : '';

    const audioTracks = valid.map((v, idx) => {
      const langCode = mapLanguageNameToCode(v.lang);
      const isDefault = wantedCode ? langCode === wantedCode : idx === 0;
      const proxiedUrl = buildProxyStreamUrl(v.url, referer, '', { mode: 'full' });
      return {
        id: `mbox-${v.id || langCode || idx}`,
        lang: langCode,
        label: v.lang || 'Original Audio',
        type: 'dub',
        streamUrl: proxiedUrl,
        rawUrl: v.url,
        default: isDefault
      };
    });

    if (!audioTracks.some((a) => a.default)) {
      audioTracks[0].default = true;
    }
    const active = audioTracks.find((a) => a.default) || audioTracks[0];

    return {
      server: 'andromeda',
      sourceName: 'Moviebox',
      format: /\.mpd(\?|$)/i.test(active.rawUrl) ? 'dash' : /\.mp4(\?|$)/i.test(active.rawUrl) ? 'mp4' : 'hls',
      rawUrl: active.rawUrl,
      streamUrl: active.streamUrl,
      referer,
      headers: { Referer: referer },
      backupUrls: [
        buildProxyStreamUrl(active.rawUrl, referer, '', { mode: 'manifest' })
      ],
      audioTracks,
      qualities: [{ label: 'Auto', height: 0, url: active.streamUrl }]
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

let cachedNetmirrorApiUrl = '';
let cachedNetmirrorExpiry = 0;

async function getNetmirrorApiBase(signal) {
  if (cachedNetmirrorApiUrl && Date.now() < cachedNetmirrorExpiry) {
    return cachedNetmirrorApiUrl;
  }
  const checkDomains = [
    'https://mobiledetect.app',
    'https://mobiledetects.com',
    'https://getimgcdn.com'
  ];
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
 * Sub-provider 3 for Andromeda: NetMirror (https://net27.cc / NewTV OTT Mirror)
 * Official OTT mirror for Netflix, Prime Video, and Disney+/Hotstar releases.
 */
async function resolveNetmirror(metadata, preferredAudio = '', parentSignal = null) {
  const netmirrorBase = (config.upstreams.netmirrorBase || 'https://net27.cc').replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
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
              const referer = pJson.referer || 'https://net52.cc';
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

    // 2. Direct embed-tmdb endpoint fallback
    const netflixUrl = isTv
      ? `${netmirrorBase}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}?type=tv&se=${metadata.season || 1}&ep=${metadata.episode || 1}`
      : `${netmirrorBase}/api/embed-tmdb/${encodeURIComponent(metadata.tmdbId)}`;

    const res = await fetch(netflixUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: `${netmirrorBase}/`,
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    });

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        const streamUrl = data.streams?.[0]?.url || data.mp4;
        if (streamUrl) {
          const referer = 'https://videodownloader.site/';
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
              buildProxyStreamUrl(streamUrl, referer, '', { mode: 'manifest' })
            ],
            audioTracks,
            qualities
          };
        }
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
 * Cascades across 3 premier multi-audio sources in priority order:
 *   1. CastleTV (Priority 1: South Indian dubs, K-Drama/C-Drama, Anime, Hollywood)
 *   2. Moviebox (Priority 2: Broad catalog with discrete language streams)
 *   3. NetMirror (Priority 3: Netflix/Prime/Hotstar official platform streams)
 * If all 3 fail, fails cleanly so the waterfall immediately hands playback to Server 2 (Ursa).
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

  // 2. Priority 2: Moviebox
  stamp('moviebox_attempt', 'Querying Moviebox multi-audio upstream...');
  try {
    const mboxRes = await resolveMoviebox(metadata, preferredAudio);
    if (mboxRes && mboxRes.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      stamp('moviebox_success', `Moviebox resolved ${mboxRes.audioTracks.length} audio track(s).`);
      return { ok: true, ...mboxRes, diag };
    }
    stamp('moviebox_miss', 'Moviebox returned no playable streams for this title.');
  } catch (err) {
    stamp('moviebox_error', `Moviebox failed: ${err.message}`);
  }

  // 3. Priority 3: NetMirror
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

  // 4. Test/Mock Fallback: if VidStuck is explicitly pointed to a local mock (e.g. test suite)
  if (config.upstreams.vidstuckBase && /127\.0\.0\.1|localhost/i.test(config.upstreams.vidstuckBase)) {
    stamp('vidstuck_mock_attempt', 'Attempting local VidStuck mock fallback...');
    const vsRes = await resolveVidstuckServer(metadata, 'andromeda');
    if (vsRes && vsRes.streamUrl) {
      circuitBreaker.recordSuccess(providerKey);
      return { ok: true, ...vsRes, diag };
    }
  }

  // All 3 sub-providers failed: record failure and hand off to Server 2 (Ursa)
  circuitBreaker.recordFailure(providerKey);
  stamp('andromeda_exhausted', 'All 3 Andromeda sub-providers (CastleTV, Moviebox, NetMirror) failed to resolve a stream.');
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
const HUBCLOUD_UNROLL_BUDGET_MS = 4500; // hard cap per resolve-step
const HUBCLOUD_UNROLL_BODY_CAP = 600 * 1024;
const HUBCLOUD_UNROLL_ALT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const hubcloudUnrollCache = new Map(); // generatorUrl -> { direct, exp }

function isHubcloudGeneratorUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return (
      /(^|\.)hubcloud\./.test(host) ||
      /(^|\.)hubcdn\./.test(host) ||
      /(^|\.)gamerxyt\.com$/.test(host) ||
      /^gpdl\d*\./.test(host) ||
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
function extractHttpLinkParam(u) {
  const m = String(u || '').match(/[?&]link=([^&#\s]+)/i);
  if (!m) return '';
  const raw = m[1];
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    /* malformed encoding — keep raw */
  }
  return '';
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
  if (/(^|\.)video-downloads\.googleusercontent\.com$/.test(host)) return 100;
  if (/(^|\.)r2\.dev$/.test(host)) return 95;
  if (/\.(cloudflarestorage\.com|cloudfront\.net)$/.test(host)) return 90;
  if (/(^|\.)workers\.dev$/.test(host)) return 85;
  if (/\.(mp4|mkv|webm|m4v|m3u8|mpd)([?#]|$)/i.test(href)) return 80;
  if (/(^|\.)pixeldrain\.(com|dev)$/.test(host) && /^\/(u|api\/file)\/[A-Za-z0-9]+/.test(pathname)) {
    return 70;
  }
  return -1;
}

/** Pixeldrain share pages `/u/ID` → direct API endpoint `/api/file/ID`. */
function normalizePlayableUrl(u) {
  try {
    const url = new URL(u);
    if (/(^|\.)pixeldrain\.(com|dev)$/.test(url.hostname.toLowerCase())) {
      const m = url.pathname.match(/^\/u\/([A-Za-z0-9]+)/);
      if (m) return `${url.origin}/api/file/${m[1]}`;
    }
    return url.href;
  } catch {
    return u;
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
  for (const m of normalized.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    tryAdd(m[0].replace(/[.,;:]+$/, ''));
  }
  for (const m of normalized.matchAll(/\batob\(\s*["']([A-Za-z0-9+/=]{16,})["']\s*\)/g)) {
    try {
      const decoded = atob(m[1]);
      for (const d of decoded.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
        tryAdd(d[0].replace(/[.,;:]+$/, ''));
      }
    } catch {
      /* not base64 */
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
  let direct = null;
  let directScore = -1;
  let generator = null;
  for (const cand of collectGeneratorCandidates(html, pageUrl)) {
    if (cand === pageUrl) continue;
    if (isHubcloudGeneratorUrl(cand) || extractHttpLinkParam(cand)) {
      if (!generator) generator = cand;
      continue;
    }
    const score = scorePlayableUrl(cand);
    if (score > directScore) {
      direct = cand;
      directScore = score;
    }
  }
  if (directScore >= 0) return { direct: normalizePlayableUrl(direct), generator: null };
  return { direct: null, generator };
}

/**
 * Fetch with a hard deadline: `deadline` (epoch ms) bounds the whole unroll,
 * `outerSignal` (when present) aborts together with the caller's controller.
 */
async function fetchWithDeadline(url, userAgent, outerSignal, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 400 || outerSignal?.aborted) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(3500, remaining));
  const onAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener?.('abort', onAbort);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
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

/** Follow one `?link=` hop: recurse into wrappers, accept terminal URLs. */
async function resolveLinkInner(inner, opts) {
  if (!inner) return null;
  if (isHubcloudGeneratorUrl(inner)) {
    return unrollHubcloudUrl(inner, { ...opts, depth: opts.depth + 1 });
  }
  if (scorePlayableUrl(inner) >= 0) return normalizePlayableUrl(inner);
  return null;
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

  const cached = hubcloudUnrollCache.get(startUrl);
  if (cached) {
    if (Date.now() < cached.exp) return cached.direct;
    hubcloudUnrollCache.delete(startUrl);
  }

  const deadline = options.deadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS;
  const direct = await unrollHubcloudUncached(startUrl, {
    signal: options.signal,
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
  const { signal, depth, deadline } = opts;
  try {
    // 1) `dl.php?link=…` wrappers carry the final URL in the query string —
    //    no fetch needed at all when the Location itself is one.
    const entryInner = extractHttpLinkParam(startUrl);
    if (entryInner) {
      const resolved = await resolveLinkInner(entryInner, opts);
      if (resolved) return resolved;
    }

    // 2) fetch the generator page, following HTTP redirects (some generator
    //    hosts 302 straight to `dl.php?link=<direct>` — no JS involved).
    const res = await fetchWithDeadline(startUrl, USER_AGENT, signal, deadline);
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
      // binary body after redirect → the final URL itself is the file
      return scorePlayableUrl(finalUrl) >= 0 ? normalizePlayableUrl(finalUrl) : null;
    }

    // 3) scan the raw landing HTML for the final CDN link — it is present in
    //    the source even while the countdown hides it (meta-refresh target,
    //    inline script, hidden/JS-filled anchor, atob payload).
    let html = '';
    if (res.ok) {
      html = await readCappedText(res);
      if (isCfChallengePage(html)) html = ''; // challenge interstitial — no links
    }
    const pick = pickFromGeneratorHtml(html, finalUrl);
    if (pick.direct) return pick.direct;
    if (pick.generator && pick.generator !== startUrl) {
      const next = await unrollHubcloudUrl(pick.generator, { ...opts, depth: depth + 1 });
      if (next) return next;
    }

    // 4) last resort: some generator hosts serve the countdown page to browser
    //    UAs but 302 directly for crawlers — retry once with a non-browser UA.
    if (depth === 0 && Date.now() < deadline - 1200 && !signal?.aborted) {
      const retry = await fetchWithDeadline(startUrl, HUBCLOUD_UNROLL_ALT_UA, signal, deadline);
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
        if (rPick.direct) return rPick.direct;
        if (rPick.generator && rPick.generator !== startUrl) {
          const next = await unrollHubcloudUrl(rPick.generator, { ...opts, depth: depth + 1 });
          if (next) return next;
        }
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
        /https?:\/\/pixeldrain\.(?:dev|com)\/u\/([A-Za-z0-9]+)/gi
      )) {
        const label = labelFor(match.index);
        results.push({
          type: 'pixeldrain',
          quality: label,
          height: toHeight(label),
          url: `https://pixeldrain.dev/api/file/${match[1]}`,
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
          if (isHubcloudGeneratorUrl(location) || extractHttpLinkParam(location)) {
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
            const pdId = location.split('/u/')[1].split(/[?#]/)[0];
            if (pdId) location = `https://pixeldrain.dev/api/file/${pdId}`;
          }

          let isHotlinkBlocked = unrollFailed;
          if (/pixeldrain\.(?:dev|com)\/api\/file\//i.test(location)) {
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
  const validServer =
    enabledServers.find((s) => s.id === requestedServerId)?.id ||
    enabledServers[0]?.id ||
    'andromeda';

  const cacheKey = `resolve:v2:${metadata.type}:${metadata.tmdbId}:s${metadata.season || 1}:e${metadata.episode || 1}:${validServer}`;
  const cached = await cache.get(cacheKey);
  if (cached) return applyPreferredAudio(cached, preferredAudio);

  // Build ordered waterfall starting with the user's selected server, then the
  // premier multi-audio cascade: Andromeda (Server 1) -> Ursa (Server 2) -> Centaurus -> Atlas -> Strings.
  const WATERFALL_PRIORITY = ['andromeda', 'ursa', 'centaurus', 'atlas', 'strings'];
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
    if (srvId === 'andromeda') {
      resolved = await resolveAndromedaServer(metadata, srvId, preferredAudio);
    } else if (srvId === 'atlas') {
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
      const payload = {
        ...resolved,
        requestedServer: validServer,
        serverAttempts,
        activeAudioTrack:
          resolved.audioTracks.find((t) => t.default) || resolved.audioTracks[0] || null,
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
  resolveMoviebox,
  resolveNetmirror,
  resolveVidstuckServer,
  resolveVidsrcServer,
  resolveHicineServer,
  resolveHianimeServer,
  buildCastleKey,
  decryptCastleAes,
  mapLanguageNameToCode,
  buildMovieboxHeaders,
  decryptVidsrcWasmPayload,
  decodeZokoAnimeXorPayload,
  parseHicineLinks,
  parseHicineAudioHints,
  // HubCloud generator unroller (Centaurus fix) — exported for tests
  isHubcloudGeneratorUrl,
  unrollHubcloudUrl
};
