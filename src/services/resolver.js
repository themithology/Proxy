const crypto = require('crypto');
const config = require('../config');
const { cache, circuitBreaker } = require('../utils/cache');
const { buildProxyStreamUrl } = require('./proxy');
const { prepareMultiTrackStream, normalizeAudioLanguage } = require('./multitrack');
const { telemetry } = require('./telemetry');
const identity = require('./identity');
const serverCatalog = require('./serverCatalog');
const hamster = require('./hamster');
const animedubhindi = require('./animedubhindi');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

    // CastleTV answers one quality per `resolution` rung. The old code stopped
    // at the first rung that produced a URL, so any title whose response carried
    // no `data.videos` array collapsed to a single "Auto" entry in the player.
    // Collect every rung into a real ladder instead (this stays inside the same
    // abort budget: the loop breaks as soon as two heights are known).
    const CASTLE_HEIGHTS_BY_RESOLUTION = { 1: 480, 2: 720, 3: 1080, 4: 2160 };
    const castleVideoHeight = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) return 0;
      return num <= 4 ? CASTLE_HEIGHTS_BY_RESOLUTION[num] || 0 : num;
    };

    const fetchTrackStream = async (track) => {
      const ladder = new Map();
      let base = null;
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
          const rows = (vJson?.data?.videos || [])
            .filter((v) => v && v.url)
            .map((v) => ({
              url: v.url,
              // `resolution` may be a rung number (1-4) or an explicit pixel
              // height depending on the upstream build; accept both.
              height: castleVideoHeight(v.resolution != null ? v.resolution : v.height)
            }))
            .filter((v) => v.height > 0);
          const videoUrl =
            vJson?.data?.videoUrl || rows[0]?.url || '';
          if (!videoUrl && rows.length === 0) continue;

          if (!base) {
            base = {
              languageId: track.languageId,
              languageName: track.languageName || track.abbreviate || 'Original',
              videoUrl: videoUrl || rows[0].url,
              subtitles: (vJson?.data?.subtitles || []).filter((s) => s && s.url)
            };
          }
          rows.forEach((row) => {
            if (!ladder.has(row.height)) ladder.set(row.height, row.url);
          });
          const requestedHeight = CASTLE_HEIGHTS_BY_RESOLUTION[resolution] || 0;
          if (videoUrl && requestedHeight && !ladder.has(requestedHeight)) {
            ladder.set(requestedHeight, videoUrl);
          }
          // A full ladder is usually inside the first response; only keep
          // probing lower rungs while the menu would still show one row.
          if (ladder.size >= 2) break;
        } catch {
          // try the next resolution rung
        }
      }
      if (!base) return null;
      base.videos = Array.from(ladder, ([height, url]) => ({ height, url }))
        .sort((a, b) => b.height - a.height);
      return base;
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

    // CastleTV is HLS-first, but some entries are direct progressive files.
    // Those used to be reported as `format: 'hls'` and handed to hls.js, which
    // cannot play them — and a browser cannot switch the audio tracks embedded
    // in a progressive file, so the track menu did nothing. Progressive tracks
    // now report their real container and go through the same Node remux as the
    // other servers (HLS tracks already carry switchable renditions).
    const activeKind = hamster.kindFromUrl(activeTrack.rawUrl);
    const activeFormat = activeKind === 'unknown' ? 'hls' : activeKind;
    const remuxStream =
      activeFormat === 'mp4' || activeFormat === 'mkv'
        ? await prepareMultiTrackStream(
            activeTrack.rawUrl,
            audioTracks.map((track) => ({ code: track.lang, label: track.label })),
            { trustSource: true }
          )
        : null;
    const finalAudioTracks = remuxStream ? remuxStream.audioTracks : audioTracks;
    finalAudioTracks.forEach((track, index) => {
      track.default = remuxStream ? !!track.default : track === defaultTrack;
      if (!track.id) track.id = `castle-${index}`;
    });

    return {
      server: 'andromeda',
      sourceName: 'CastleTV',
      // A remux is HLS by construction; otherwise the container is honest.
      format: remuxStream ? remuxStream.format : activeFormat,
      rawUrl: activeTrack.rawUrl,
      streamUrl: remuxStream ? remuxStream.streamUrl : activeTrack.streamUrl,
      // The variant ladder belongs to the original container, so a remuxed file
      // carries only its own (single) rendition — labeled with the source's
      // height instead of a bare "Auto" so the menu reflects reality.
      qualities: remuxStream ? [remuxQualityRow(qualities, remuxStream.streamUrl)] : qualities,
      progressiveFormat: remuxStream ? activeFormat : undefined,
      referer,
      headers: { Referer: referer },
      // Manifest proxy first (cheapest retry), then the original ladder so a
      // remux that the browser cannot decode still has real failover mirrors.
      backupUrls: Array.from(new Set([
        buildProxyStreamUrl(activeTrack.rawUrl, referer, '', { mode: 'manifest' }),
        ...(remuxStream ? qualities.slice(1).map((quality) => quality.url) : []),
        buildProxyStreamUrl(activeTrack.rawUrl, referer, '', { mode: 'full' })
      ])),
      audioTracks: finalAudioTracks,
      downloadAudioTracks: finalAudioTracks,
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
 * If both fail, fails cleanly so the waterfall immediately hands playback to Server 2 (Centaurus).
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

  // All sub-providers failed: record failure and hand off to the next server
  circuitBreaker.recordFailure(providerKey);
  stamp('andromeda_exhausted', 'All Andromeda sub-providers (CastleTV, NetMirror) failed to resolve a stream.');
  return {
    ok: false,
    reason: 'andromeda_all_sources_exhausted',
    diag
  };
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

/**
 * A remux publishes exactly one video rendition, so the quality menu must show
 * that rendition honestly. When the pre-remux ladder knew the file's height we
 * reuse it (e.g. "1080p"), otherwise the row stays "Auto".
 */
function remuxQualityRow(originalQualities, streamUrl) {
  const heights = (Array.isArray(originalQualities) ? originalQualities : [])
    .map((quality) => Number(quality && quality.height) || 0)
    .filter((height) => height > 0);
  const height = heights.length ? Math.max(...heights) : 0;
  return { label: height ? `${height}p` : 'Auto', height, url: streamUrl };
}

/**
 * Honest container label for a resolved media URL. Extension-less CDN files
 * are progressive downloads, so they map to 'mp4' — the player sends anything
 * that is not 'hls'/'dash' to the progressive <video> path, and MKV/MP4 files
 * become remux candidates when the Node tier can probe them.
 */
function containerFormatForUrl(url) {
  const kind = hamster.kindFromUrl(url);
  return kind === 'unknown' ? 'mp4' : kind;
}

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
      // Legacy download hosts now link through HubCloud's browser-only recovery path;
      // keep recognizing it even when the page resolves a relative href on a
      // download host before the endpoint redirects to hubcloud.ist.
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

  // CDN hosts only earn their bonus when the URL points at a real object: a
  // media extension or at least one non-root path segment. A bare host plus a
  // query string — `https://d33f51dyacx7bd.cloudfront.net/?aydfd=1015073`,
  // which is what the legacy 4K redirector chains return — is a landing/gate page,
  // not media. It used to score 90 and outrank every real file candidate, so
  // Server 3 reported a JavaScript page as its "verified 4K" stream.
  const hasObjectPath = pathname.replace(/\/+$/, '') !== '';
  const cdnScore = (base) => (hasObjectPath ? base : 25);
  if (/(^|\.)workers\.dev$/i.test(host) && /[?&]vcloud=/i.test(href)) return -1;
  if (/(^|\.)googleusercontent\.com$/i.test(host)) return cdnScore(100);
  if (/(^|\.)r2\.dev$/i.test(host)) return cdnScore(95);
  if (/(^|\.)r2\.cloudflarestorage\.com$/i.test(host) || /(^|\.)cloudflarestorage\.com$/i.test(host)) return cdnScore(92);
  if (/(^|\.)cloudfront\.net$/i.test(host)) return cdnScore(90);
  if (/(^|\.)storage\.googleapis\.com$/i.test(host)) return cdnScore(88);
  if (/(^|\.)pixeldrain\.(?:com|dev)$/i.test(host) && /^\/(?:u|api\/file)\/[A-Za-z0-9_-]+/i.test(pathname)) return 75;
  if (/(^|\.)workers\.dev$/i.test(host)) return cdnScore(60);
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

/**
 * Media sniffing for the Range preflight.
 *
 * A 200/206 response is NOT proof of media. Legacy redirector chains answer
 * with a JavaScript landing page (no Content-Type, body starting with
 * `(function(){`), which the old "not HTML and not JSON" test accepted — so
 * The old 4K tier returned that page as its "verified 4K" stream and every
 * playback attempt failed. Accept a candidate only when the response carries a
 * real media Content-Type, or when the first bytes match a known container.
 */
const MEDIA_CONTENT_TYPE_RE =
  /^(?:video|audio)\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|matroska|x-matroska|ogg|mp2t|x-flv)/i;
const JS_BODY_RE =
  /^\s*(?:<script|<!--|\(function|!function|function\s*\(|var\s|let\s|const\s|window\.|document\.|eval\()/i;
const MEDIA_MAGIC_HEADERS = [
  [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55], // #EXTM3U (HLS playlist)
  [0x1a, 0x45, 0xdf, 0xa3], // EBML header (Matroska / WebM)
  [0x4f, 0x67, 0x67, 0x53], // OggS
  [0x66, 0x4c, 0x61, 0x43], // fLaC
  [0x49, 0x44, 0x33], // ID3-tagged MP3
  [0x52, 0x49, 0x46, 0x46], // RIFF (WAV / AVI)
  [0x00, 0x00, 0x01, 0xba], // MPEG program stream
  [0x00, 0x00, 0x01, 0xb3] // MPEG video elementary stream
];

function bytesStartWith(bytes, magic, offset = 0) {
  if (!bytes || bytes.length < offset + magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic[index]) return false;
  }
  return true;
}

function looksLikeMediaSample(bytes, text) {
  if (!bytes || bytes.length < 8) return false;
  if (bytesStartWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return true; // `….ftyp` (MP4 / MOV)
  for (const magic of MEDIA_MAGIC_HEADERS) {
    if (bytesStartWith(bytes, magic)) return true;
  }
  // MPEG-TS: the 0x47 sync byte repeats every 188 bytes.
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return true;
  if (!text) return false;
  if (/#extm3u/.test(text)) return true;
  if (/<(?:mpd|manifest)[\s>]/.test(text)) return true;
  return false;
}

/**
 * First chunk of the body as raw bytes (container magic) and lowercased text.
 * Binary container headers never survive a UTF-8 round-trip, so the byte view
 * is what makes MP4/MKV/TS detection reliable.
 */
async function readProbeSample(response, maxBytes = 4096) {
  const reader = response?.body?.getReader?.();
  if (!reader) return { bytes: null, text: '' };
  try {
    const { value } = await reader.read();
    if (!value) return { bytes: null, text: '' };
    const bytes = value.subarray(0, maxBytes);
    return { bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes).toLowerCase() };
  } catch {
    return { bytes: null, text: '' };
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
      /text\/html|application\/(?:xhtml\+xml|json)|javascript/i.test(contentType)
    ) {
      try { await response.body?.cancel?.(); } catch {}
      return false;
    }
    const sample = await readProbeSample(response);
    const prefix = sample.text;
    if (
      /<\s*!doctype\s+html|<\s*html\b|<\s*body\b|download\s*quota\s*exceeded|downloadquotaexceeded|access\s+denied|token\s+expired|file\s+not\s+found/i.test(prefix)
    ) return false;
    if (JS_BODY_RE.test(prefix)) return false;
    // Positive evidence only: a media Content-Type, or a real container magic.
    // Anything else (bare JavaScript landing pages, bot walls without a
    // Content-Type) must never be handed to <video>.
    return MEDIA_CONTENT_TYPE_RE.test(contentType) || looksLikeMediaSample(sample.bytes, prefix);
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

/** Browser navigation headers used by the HubCloud/legacy-host anti-bot pages. */
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

/* ------------------------------------------------------------------------- *
 * GDFlix unroll — Anime Dub Hindi's second release host
 * ------------------------------------------------------------------------- */

const GDFLIX_UNROLL_TTL_MS = 600000; // 10 minutes
const GDFLIX_UNROLL_BODY_CAP = 900 * 1024;
const gdflixUnrollCache = new Map(); // fileUrl -> { direct, exp }

/**
 * `Instant DL [10GBPS]` → direct file. Verified live 2026-10-04 against
 * `new4.gdflix.io`: the instant host answers 302 with
 * `Location: …/?url=<encoded file>`; when it answers 200/206 the body *is* the
 * file, so the instant URL itself is the raw link.
 */
async function resolveGdflixInstant(instantUrl, options = {}) {
  const { signal, deadline, headers = {} } = options;
  const res = await fetchWithDeadline(instantUrl, USER_AGENT, signal, deadline, {
    headers: { Accept: '*/*', Range: 'bytes=0-1023', ...headers },
    redirect: 'manual'
  });
  if (!res) return '';
  let location = '';
  let contentType = '';
  try {
    location = res.headers.get('location') || '';
    contentType = String(res.headers.get('content-type') || '').toLowerCase();
  } catch {
    /* headers unavailable */
  }
  try {
    await res.body?.cancel?.();
  } catch {
    /* body already consumed */
  }
  const target = animedubhindi.extractInstantTarget(location, instantUrl);
  if (target) return target;
  if ((res.status === 200 || res.status === 206) && !/text\/html|application\/json/i.test(contentType)) {
    return instantUrl;
  }
  return '';
}

/**
 * GDFlix file page → raw media URL.
 *
 * The page lists "Instant DL [10GBPS]" (302 → file), "DIRECT SERVER [MGT]"
 * (plain CDN) and "FAST CLOUD / ZIPDISK" (`/cloud/…`, one more page of the same
 * shape). Mirrors rotate (`gdflix.dev` → `new4.gdflix.io`), so the unroll works
 * from whatever host the release page linked and follows HTTP redirects rather
 * than assuming a domain.
 *
 * Google Drive (`#gdlink`) targets are deliberately skipped: they need a
 * confirm-token dance that cannot be cached per session, and a wrong guess would
 * only burn a probe slot before falling through to HubCloud.
 */
async function unrollGdflixUrl(startUrl, options = {}) {
  if (!startUrl || typeof startUrl !== 'string') return null;
  if (!animedubhindi.isGdflixUrl(startUrl)) return null;
  const depth = Number(options.depth) || 0;
  if (depth > 1) return null;

  const signal = options.signal;
  const deadline = options.deadline || Date.now() + HUBCLOUD_UNROLL_BUDGET_MS;
  const headers = options.headers || {};

  const cached = gdflixUnrollCache.get(startUrl);
  if (cached) {
    if (Date.now() < cached.exp && (await probePlayableMediaUrl(cached.direct, { signal, deadline, headers }))) {
      return cached.direct;
    }
    gdflixUnrollCache.delete(startUrl);
  }

  let origin = '';
  try {
    origin = new URL(startUrl).origin;
  } catch {
    origin = '';
  }
  const res = await fetchWithDeadline(startUrl, USER_AGENT, signal, deadline, {
    headers: { Referer: origin ? `${origin}/` : '', ...headers }
  });
  if (!res) return null;

  const finalUrl = res.url || startUrl;
  let html = '';
  try {
    if (res.ok) html = await readCappedText(res, GDFLIX_UNROLL_BODY_CAP);
  } catch {
    html = '';
  }
  if (!html || isCfChallengePage(html)) return null;

  let pageOrigin = origin;
  try {
    pageOrigin = new URL(finalUrl).origin;
  } catch {
    /* keep the requested origin */
  }
  const refererHeaders = { Referer: pageOrigin ? `${pageOrigin}/` : 'https://gdflix.dev/', ...headers };
  const candidates = animedubhindi.parseGdflixPage(html, finalUrl);

  const remember = (direct) => {
    gdflixUnrollCache.set(startUrl, { direct, exp: Date.now() + GDFLIX_UNROLL_TTL_MS });
    if (gdflixUnrollCache.size > 128) {
      const oldest = gdflixUnrollCache.keys().next().value;
      if (oldest) gdflixUnrollCache.delete(oldest);
    }
    return direct;
  };

  for (const candidate of candidates) {
    if (candidate.kind === 'cloud') {
      const nested = await unrollGdflixUrl(candidate.url, { signal, deadline, headers, depth: depth + 1 });
      if (nested) return remember(nested);
      continue;
    }
    if (candidate.kind !== 'instant' && candidate.kind !== 'direct') continue;

    let target = candidate.url;
    if (candidate.kind === 'instant') {
      target = await resolveGdflixInstant(candidate.url, { signal, deadline, headers: refererHeaders });
      if (!target) continue;
    }
    const playable = await probePlayableMediaUrl(target, {
      signal,
      deadline: Math.max(deadline, Date.now() + 1500),
      timeoutMs: 3000,
      headers: refererHeaders
    });
    if (!playable) continue;
    return remember(target);
  }
  return null;
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
            // Extension-less CDN URLs are progressive files, but `.mkv` must
            // not be reported as mp4: the resolver's remux gate and the player
            // both key off the container.
            format: containerFormatForUrl(location)
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
    // Multi-audio releases are progressive MKV/MP4 files whose embedded tracks a
    // browser cannot switch on its own (it always plays the default track). The
    // Node tier remuxes them into an HLS master with one EXT-X-MEDIA rendition
    // per track, which is the only way the player gets a working audio menu.
    // Only HLS/DASH sources are skipped — they already carry their own
    // renditions, and the player switches those natively.
    const isProgressivePrimary =
      primary.streamFormat !== 'hls' && primary.streamFormat !== 'dash';
    const multiTrackStream = isProgressivePrimary
      ? await prepareMultiTrackStream(primary.rawUrl, hintedLanguages, { trustSource: true })
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
      qualities: multiTrackStream
        ? [remuxQualityRow(ordered.map((q) => ({ height: q.height })), multiTrackStream.streamUrl)]
        : ordered.map((q) => ({
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

/* ------------------------------------------------------------------------- *
 * Centaurus (server 2) source #2 — Anime Dub Hindi
 * ------------------------------------------------------------------------- */

/**
 * True when the request looks like anime. Used only to *skip* the anime source
 * for titles that are provably not animation: the source is a fallback, so it
 * must not add latency to every non-anime miss in front of Hamster Wheel.
 * When the metadata carries no genre information at all (the VidStuck fallback
 * path), the source is attempted and the title match decides.
 */
function isAnimeCandidate(metadata = {}) {
  const genres = Array.isArray(metadata.genres)
    ? metadata.genres.map((genre) => String(genre || '').toLowerCase())
    : [];
  if (genres.includes('animation') || genres.includes('anime')) return true;
  if (metadata.externalIds && metadata.externalIds.mal_id) return true;
  return genres.length === 0;
}

/**
 * HiCine's sibling source: Hindi-dub anime from Anime Dub Hindi.
 *
 * Pipeline (all pages discovered by following links — slugs like `blubox-s1`
 * are not derivable):
 *   WordPress search → post → adhlinks `/episode/<slug>/` → row for the
 *   requested episode → HubCloud (existing unroll) / GDFlix (new unroll) →
 *   probe → payload.
 *
 * Every candidate is probed before it is served, exactly like Hamster Wheel:
 * a release-host page that merely *looks* like a download must never reach the
 * player as a "raw link".
 */
async function resolveAnimeDubHindiSource(metadata = {}) {
  const settings = config.animedubhindi || {};
  if (settings.enabled === false) return { reason: 'source_disabled' };
  if (!metadata.title) return { reason: 'no_title' };
  if (!isAnimeCandidate(metadata)) return { reason: 'not_anime' };

  const providerKey = 'centaurus:animedubhindi';
  if (!circuitBreaker.isAvailable(providerKey)) return { reason: 'circuit_open' };

  const base = String(settings.baseUrl || 'https://www.animedubhindi.link').replace(/\/+$/, '');
  const budgetMs = Number(settings.timeoutMs) || 12000;
  const pageCap = Number(settings.pageBodyCap) || 1400 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs + 2500);
  const deadline = Date.now() + budgetMs;
  const diag = [];

  try {
    const fetchPage = async (url, extraHeaders = {}) => {
      const res = await fetchWithDeadline(url, USER_AGENT, controller.signal, deadline, {
        headers: { Referer: `${base}/`, ...extraHeaders }
      });
      if (!res || !res.ok) return null;
      const html = await readCappedText(res, pageCap);
      return html || null;
    };

    // 1) WordPress search → the post for this title (and season).
    let post = null;
    const queries = [String(metadata.title).trim()];
    if (metadata.releaseYear) queries.push(`${String(metadata.title).trim()} ${metadata.releaseYear}`);
    for (const query of queries) {
      if (Date.now() > deadline - 2500) break;
      const html = await fetchPage(`${base}/?s=${encodeURIComponent(query)}`);
      if (!html) {
        diag.push(`search_failed:${query}`);
        continue;
      }
      const results = animedubhindi.parseSearchResults(html, base);
      if (results.length === 0) {
        diag.push(`search_empty:${query}`);
        continue;
      }
      const picked = animedubhindi.pickBestPost(results, metadata);
      if (picked) {
        post = picked;
        diag.push(`post:${picked.title}`);
        break;
      }
      diag.push(`search_miss:${query}(${results.length})`);
    }
    if (!post) {
      circuitBreaker.recordSuccess(providerKey);
      return { reason: 'animedubhindi_no_post', diag: diag.join(', ') };
    }

    // 2) Post → adhlinks episode page. The slug is never constructed.
    const postHtml = await fetchPage(post.url);
    if (!postHtml) return { reason: 'animedubhindi_post_failed', diag: diag.join(', ') };
    const episodeLinks = animedubhindi.parsePostEpisodeLinks(postHtml, post.url);
    if (episodeLinks.length === 0) {
      return { reason: 'animedubhindi_no_episode_page', diag: `${diag.join(', ')}, post has no episode link` };
    }
    diag.push(`episodes:${episodeLinks[0].url}`);

    // 3) Episode page → the requested episode's quality rows.
    const pageUrl = episodeLinks[0].url;
    const pageHtml = await fetchPage(pageUrl, { Referer: post.url });
    if (!pageHtml) return { reason: 'animedubhindi_episode_page_failed', diag: diag.join(', ') };
    const parsed = animedubhindi.parseEpisodePage(pageHtml, pageUrl);
    if (parsed.pageKind === 'not_found') {
      return { reason: 'animedubhindi_page_not_found', diag: `${diag.join(', ')}, episode page removed` };
    }
    const rows = animedubhindi.selectRowsForEpisode(parsed, {
      type: metadata.type,
      episode: metadata.episode || 1,
      pageUrl
    });
    if (rows.length === 0) {
      return {
        reason: 'animedubhindi_episode_not_found',
        diag: `${diag.join(', ')}, page has ${parsed.episodes.length} episode block(s), wanted e${metadata.episode || 1}`
      };
    }

    // 4) Rank rows (x264 before x265, then resolution) and try, per row,
    //    HubCloud first — its unroll is the battle-tested one — then GDFlix.
    const ordered = animedubhindi.sortRows(rows);
    const candidates = [];
    for (const row of ordered) {
      for (const hostId of ['hubcloud', 'gdflix']) {
        const link = (row.links || []).find((entry) => entry.host === hostId && entry.url);
        if (link) candidates.push({ url: link.url, hostId, row });
      }
    }
    if (candidates.length === 0) {
      return { reason: 'animedubhindi_no_release_links', diag: `${diag.join(', ')}, rows have no HubCloud/GDFlix link` };
    }
    diag.push(`rows:${rows.length}`);

    // 5) Unroll + probe until the budget runs out.
    const unrollDeadline = Date.now() + (Number(settings.unrollBudgetMs) || 7000);
    const probeLimit = Number(settings.maxProbeCandidates) || 5;
    const probeTimeoutMs = Number(settings.probeTimeoutMs) || 3500;
    const playable = [];
    const seen = new Set();

    for (const candidate of candidates) {
      if (playable.length >= probeLimit || Date.now() > unrollDeadline + 2500) break;
      const referer = candidate.hostId === 'gdflix' ? 'https://gdflix.dev/' : 'https://hubcloud.ist/';
      const headers = { Referer: referer };
      let url = '';
      try {
        url = candidate.hostId === 'gdflix'
          ? await unrollGdflixUrl(candidate.url, { signal: controller.signal, deadline: unrollDeadline, headers })
          : await unrollHubcloudUrl(candidate.url, { signal: controller.signal, deadline: unrollDeadline, headers });
      } catch {
        url = '';
      }
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const isPlayable = await probePlayableMediaUrl(url, {
        signal: controller.signal,
        deadline: Math.max(unrollDeadline, Date.now() + 1500) + 3000,
        timeoutMs: probeTimeoutMs,
        headers
      });
      if (!isPlayable) continue;
      playable.push({
        url,
        referer,
        headers,
        row: candidate.row,
        hostId: candidate.hostId,
        kind: hamster.kindFromUrl(url)
      });
    }

    if (playable.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      diag.push(`unplayable:${candidates.length}`);
      return { reason: 'animedubhindi_no_playable_stream', diag: diag.join(', ') };
    }
    circuitBreaker.recordSuccess(providerKey);

    // ---- payload assembly ------------------------------------------------
    const primary = playable[0];
    const proxyFor = (item) => buildProxyStreamUrl(item.url, item.referer || '', '', { mode: 'full' });
    const primaryTrack = {
      id: 'animedubhindi-hi',
      lang: 'hi',
      // These encodes are Netflix multi-audio MKVs; browsers play the default
      // (Hindi) track, and the Node tier remuxes the rest when it can.
      label: 'Hindi (Multi-Audio release — plays default track)',
      type: 'dub',
      streamUrl: proxyFor(primary),
      rawUrl: primary.url,
      default: true
    };

    const seenHeights = new Set();
    const qualities = [];
    for (const item of playable) {
      const height = Number(item.row?.height) || 0;
      if (height && seenHeights.has(height)) continue;
      if (height) seenHeights.add(height);
      qualities.push({
        label: item.row?.label || (height ? `${height}p` : 'Auto'),
        height,
        url: proxyFor(item)
      });
    }

    // Anime Dub Hindi ships Hindi + Tamil + Telugu + English + Japanese in one
    // file; the hint list only labels the remuxed renditions (Hindi default).
    const hintedLanguages = [
      { code: 'hi', label: 'Hindi' },
      { code: 'ta', label: 'Tamil' },
      { code: 'te', label: 'Telugu' },
      { code: 'en', label: 'English' },
      { code: 'ja', label: 'Japanese' }
    ];
    // MKV (and extension-less CDN files, which are usually MKV too) carry the
    // Hindi/Tamil/Telugu/English/Japanese tracks inside one file; remux them so
    // the audio menu actually switches tracks instead of always playing the
    // default one. HLS/DASH sources keep their own renditions.
    const isProgressive = primary.kind !== 'hls' && primary.kind !== 'dash';
    const multiTrackStream = isProgressive
      ? await prepareMultiTrackStream(primary.url, hintedLanguages, { trustSource: true })
      : null;
    const fallbackKind = primary.kind === 'unknown' ? 'mp4' : primary.kind;

    return {
      server: 'centaurus',
      sourceName: 'Anime Dub Hindi',
      centaurusSource: 'animedubhindi',
      format: multiTrackStream ? multiTrackStream.format : fallbackKind,
      rawUrl: primary.url,
      streamUrl: multiTrackStream ? multiTrackStream.streamUrl : primaryTrack.streamUrl,
      progressiveFormat: multiTrackStream ? fallbackKind : undefined,
      progressiveFallbackUrls: multiTrackStream ? playable.slice(1).map((item) => item.url) : undefined,
      progressiveAudioTrack: multiTrackStream
        ? multiTrackStream.audioTracks.find((track) => track.default) || multiTrackStream.audioTracks[0] || primaryTrack
        : primaryTrack,
      referer: primary.referer,
      headers: primary.headers,
      // Proxied (not raw) so referer-protected CDNs still serve the mirror.
      backupUrls: playable.slice(1).map((item) => proxyFor(item)),
      audioTracks: multiTrackStream ? multiTrackStream.audioTracks : [primaryTrack],
      // A remux publishes exactly one video rendition — keep the progressive
      // ladder only while playback really is progressive, so the quality menu
      // never promises a file the active stream cannot deliver.
      qualities: multiTrackStream
        ? [remuxQualityRow(qualities, multiTrackStream.streamUrl)]
        : qualities.length > 0
          ? qualities
          : [{ label: 'Auto', height: 0, url: primaryTrack.streamUrl }],
      animedubhindiDiag: diag.join(', ')
    };
  } catch (error) {
    circuitBreaker.recordFailure(providerKey);
    return {
      reason: 'animedubhindi_failed',
      diag: error instanceof Error ? error.message : 'unknown'
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server 2 (Centaurus) is a two-source server: HiCine first (broad catalog),
 * Anime Dub Hindi second (Hindi-dub anime, which general aggregators miss).
 * The second source only runs when the first produced nothing, so behaviour is
 * unchanged for every title HiCine already serves.
 */
async function resolveCentaurusServer(metadata, options = {}) {
  const onlySource = String(options.onlySource || '').toLowerCase() || '';
  const sources = [
    { id: 'hicine', run: () => resolveHicineServer(metadata) },
    { id: 'animedubhindi', run: () => resolveAnimeDubHindiSource(metadata) }
  ].filter((source) => !onlySource || source.id === onlySource);
  const attempts = [];

  for (const source of sources) {
    const startedAt = Date.now();
    let resolved = null;
    try {
      resolved = await source.run();
    } catch (error) {
      resolved = { reason: 'source_threw', diag: error instanceof Error ? error.message : 'unknown' };
    }
    const ok = !!(resolved && resolved.streamUrl);
    attempts.push({
      source: source.id,
      ok,
      ms: Date.now() - startedAt,
      reason: ok ? null : resolved?.reason || 'no_stream',
      diag: ok ? null : resolved?.diag || null
    });
    if (ok) {
      return {
        ...resolved,
        server: 'centaurus',
        centaurusSource: resolved.centaurusSource || source.id,
        centaurusSources: attempts
      };
    }
  }

  return {
    // A pinned-source request reports that source's own reason so the caller
    // (the Worker's delegation, or an operator) sees `animedubhindi_no_post`
    // instead of a generic "nothing worked".
    reason: onlySource && attempts.length === 1 ? attempts[0].reason : 'centaurus_no_source',
    diag: attempts.map((attempt) => `${attempt.source}:${attempt.reason}`).join(', '),
    centaurusSources: attempts
  };
}

/**
 * Centaurus diagnostics — runs both sources and reports what each produced.
 * Exposed via `GET /api/admin/centaurus/diagnose/:type/:tmdbId` so "is the anime
 * source working?" is answered with per-source data instead of logs.
 */
async function diagnoseCentaurus(metadata) {
  const startedAt = Date.now();
  const report = {
    ok: false,
    metadata: {
      type: metadata.type,
      tmdbId: metadata.tmdbId,
      title: metadata.title,
      releaseYear: metadata.releaseYear || null,
      season: metadata.season || null,
      episode: metadata.episode || null,
      genres: metadata.genres || [],
      isAnimeCandidate: isAnimeCandidate(metadata)
    },
    sources: []
  };

  const hicineStart = Date.now();
  let hicine = null;
  try {
    hicine = await resolveHicineServer(metadata);
  } catch (error) {
    hicine = { reason: 'threw', diag: error instanceof Error ? error.message : 'unknown' };
  }
  report.sources.push({
    id: 'hicine',
    ok: !!(hicine && hicine.streamUrl),
    ms: Date.now() - hicineStart,
    reason: hicine?.streamUrl ? 'stream' : hicine?.reason || 'no_stream',
    rawUrl: hicine?.rawUrl || null,
    qualities: Array.isArray(hicine?.qualities) ? hicine.qualities.map((quality) => quality.label).slice(0, 8) : []
  });

  const animeStart = Date.now();
  let anime = null;
  try {
    anime = await resolveAnimeDubHindiSource(metadata);
  } catch (error) {
    anime = { reason: 'threw', diag: error instanceof Error ? error.message : 'unknown' };
  }
  report.sources.push({
    id: 'animedubhindi',
    ok: !!(anime && anime.streamUrl),
    ms: Date.now() - animeStart,
    reason: anime?.streamUrl ? 'stream' : anime?.reason || 'no_stream',
    diag: anime?.diag || anime?.animedubhindiDiag || null,
    rawUrl: anime?.rawUrl || null,
    referer: anime?.referer || null,
    qualities: Array.isArray(anime?.qualities) ? anime.qualities.map((quality) => quality.label).slice(0, 8) : [],
    audioTracks: Array.isArray(anime?.audioTracks) ? anime.audioTracks.map((track) => track.label).slice(0, 8) : []
  });

  report.ok = !!(anime && anime.streamUrl) || !!(hicine && hicine.streamUrl);
  report.totalMs = Date.now() - startedAt;
  return report;
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
/**
 * 4. Hamster Wheel Upstream Resolver (server #3)
 *
 * Hindi-first fan-out across MovieBox (HMAC mobile API), HindMoviez and
 * 4KHDHub. Providers only return candidates; this function is responsible for
 * the expensive part — unrolling release-host pages (hubcloud/hubdrive/
 * greenmotors), probing every candidate for a playable media response, and
 * only then assembling a payload. A dead provider therefore costs latency, not
 * a failed playback.
 *
 * The returned payload mirrors the Centaurus/Andromeda shape so the player,
 * proxy and multitrack code need no special cases.
 */
async function resolveHamsterServer(metadata) {
  const settings = config.hamster || {};
  const providerKey = 'hamster';
  if (!circuitBreaker.isAvailable(providerKey)) {
    return { reason: 'circuit_open' };
  }

  const controller = new AbortController();
  const totalTimeout = Number(settings.timeoutMs) || 12000;
  const timer = setTimeout(() => controller.abort(), totalTimeout + 3000);

  try {
    const { candidates, providers } = await hamster.resolveHamsterCandidates(metadata, {
      signal: controller.signal
    });
    const failedDiag = providers
      .filter((provider) => !provider.ok)
      .map((provider) => `${provider.id}:${provider.diag || 'no_candidates'}`)
      .join(', ');

    if (candidates.length === 0) {
      return { reason: 'hamster_no_candidates', diag: failedDiag || null, providers };
    }

    // Candidates are ranked (Hindi first, then quality, then direct formats);
    // unroll/probe only as many as the budget allows so the waterfall timer is
    // never blown by a slow release host.
    const unrollDeadline = Date.now() + (Number(settings.unrollBudgetMs) || 7000);
    const probeLimit = Number(settings.maxProbeCandidates) || 5;
    const probeTimeoutMs = Number(settings.probeTimeoutMs) || 3500;
    const playable = [];
    const seen = new Set();

    for (const candidate of candidates) {
      if (playable.length >= probeLimit || Date.now() > unrollDeadline + 2500) break;

      let url = candidate.url;
      let kind = candidate.kind;
      if (candidate.needsUnroll) {
        try {
          const direct = await unrollHubcloudUrl(candidate.url, {
            signal: controller.signal,
            deadline: unrollDeadline,
            headers: candidate.headers || {}
          });
          if (!direct) continue;
          url = direct;
          const resolvedKind = hamster.kindFromUrl(direct);
          kind = resolvedKind === 'unknown' ? 'mkv' : resolvedKind;
        } catch {
          continue;
        }
      }
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const isPlayable = await probePlayableMediaUrl(url, {
        signal: controller.signal,
        deadline: unrollDeadline + 3000,
        timeoutMs: probeTimeoutMs,
        headers: candidate.headers || {}
      });
      if (!isPlayable) continue;
      playable.push({ ...candidate, url, kind });
    }

    if (playable.length === 0) {
      circuitBreaker.recordFailure(providerKey);
      return { reason: 'hamster_no_playable_stream', diag: failedDiag || null, providers };
    }
    circuitBreaker.recordSuccess(providerKey);

    // ---- payload assembly -------------------------------------------------
    // Group the playable candidates by audio so a Hindi dub, a multi-audio
    // release and an English-only fallback become real player tracks.
    const AUDIO_PRIORITY = { hi: 0, multi: 1, en: 2, und: 3 };
    const tracksByAudio = new Map();
    for (const item of playable) {
      const key = item.audio || 'und';
      if (!tracksByAudio.has(key)) tracksByAudio.set(key, item);
    }
    const orderedAudio = [...tracksByAudio.keys()].sort(
      (a, b) => (AUDIO_PRIORITY[a] ?? 9) - (AUDIO_PRIORITY[b] ?? 9)
    );
    const audioLabel = (code) =>
      code === 'hi'
        ? 'Hindi'
        : code === 'multi'
          ? 'Multi-Audio (Hindi default)'
          : code === 'en'
            ? 'English'
            : 'Default Audio';

    const proxyFor = (item) =>
      buildProxyStreamUrl(item.url, item.referer || '', '', {
        mode: 'full',
        ...(item.headers && item.headers.Cookie ? { cookie: item.headers.Cookie } : {})
      });

    const audioTracks = orderedAudio.map((code, index) => {
      const item = tracksByAudio.get(code);
      return {
        id: `hamster-${code}-${index}`,
        lang: code === 'multi' ? 'hi' : code,
        label: audioLabel(code),
        type: 'dub',
        streamUrl: proxyFor(item),
        rawUrl: item.url,
        default: index === 0
      };
    });

    const primary = tracksByAudio.get(orderedAudio[0]);
    const primaryTrack = audioTracks[0];

    const seenHeights = new Set();
    const qualities = playable
      .filter((item) => item.height)
      .sort((a, b) => b.height - a.height)
      .filter((item) => {
        if (seenHeights.has(item.height)) return false;
        seenHeights.add(item.height);
        return true;
      })
      .map((item) => ({
        label: item.quality || `${item.height}p`,
        height: item.height,
        url: proxyFor(item)
      }));

    // MKV releases carry embedded audio tracks; the Node tier can remux them
    // into HLS (the Worker cannot, so it simply keeps the progressive URL).
    const hintedLanguages = orderedAudio.map((code) => ({
      code: code === 'multi' ? 'hi' : code,
      label: audioLabel(code)
    }));
    // Same progressive-file rule as the other servers: MKV and extension-less
    // CDN files are remuxed so their embedded audio tracks become switchable.
    const isProgressivePrimary = primary.kind !== 'hls' && primary.kind !== 'dash';
    const multiTrackStream = isProgressivePrimary
      ? await prepareMultiTrackStream(primary.url, hintedLanguages, { trustSource: true })
      : null;

    return {
      server: 'hamster',
      sourceName: 'Hamster Wheel',
      format: multiTrackStream
        ? multiTrackStream.format
        : primary.kind === 'unknown'
          ? 'mp4'
          : primary.kind,
      rawUrl: primary.url,
      streamUrl: multiTrackStream ? multiTrackStream.streamUrl : primaryTrack.streamUrl,
      progressiveFormat: multiTrackStream
        ? primary.kind === 'unknown'
          ? 'mp4'
          : primary.kind
        : undefined,
      progressiveFallbackUrls: multiTrackStream
        ? playable.slice(1).map((item) => item.url)
        : undefined,
      progressiveAudioTrack: multiTrackStream
        ? multiTrackStream.audioTracks.find((track) => track.default) || primaryTrack
        : primaryTrack,
      referer: primary.referer || '',
      headers: primary.headers || {},
      // Proxied mirrors (referer/cookie aware) so failover works on the CDNs
      // that hotlink-block raw URLs.
      backupUrls: playable.slice(1).map((item) => proxyFor(item)),
      audioTracks: multiTrackStream ? multiTrackStream.audioTracks : audioTracks,
      // A remux publishes one video rendition: list the file honestly instead
      // of offering ladder entries the active HLS stream cannot deliver.
      qualities: multiTrackStream
        ? [remuxQualityRow(qualities, multiTrackStream.streamUrl)]
        : qualities.length > 0
          ? qualities
          : [{ label: 'Auto', height: 0, url: primaryTrack.streamUrl }],
      hamsterProviders: providers
    };
  } catch (error) {
    circuitBreaker.recordFailure(providerKey);
    return {
      reason: 'hamster_failed',
      diag: error instanceof Error ? error.message : 'unknown'
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hamster Wheel diagnostics — the same fan-out the resolver runs, but it
 * reports every step instead of returning the first good stream. Exposed via
 * `GET /api/admin/hamster/diagnose/:type/:tmdbId` so "it didn't give a raw
 * link" can be answered with data: which provider produced candidates, which
 * link was unrolled, and whether the media probe accepted it.
 */
async function diagnoseHamster(metadata) {
  const settings = config.hamster || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (Number(settings.timeoutMs) || 12000) + 5000);
  try {
    const started = Date.now();
    const { candidates, providers } = await hamster.resolveHamsterCandidates(metadata, { signal: controller.signal });
    const unrollDeadline = Date.now() + (Number(settings.unrollBudgetMs) || 7000);
    const report = [];
    for (const candidate of candidates.slice(0, Number(settings.maxProbeCandidates) || 5)) {
      const entry = {
        provider: candidate.provider,
        url: candidate.url,
        origin: candidate.origin,
        kind: candidate.kind,
        quality: candidate.quality,
        height: candidate.height,
        audio: candidate.audio,
        needsUnroll: !!candidate.needsUnroll,
        unrolled: null,
        playable: false,
        ms: 0
      };
      const t0 = Date.now();
      let url = candidate.url;
      if (candidate.needsUnroll) {
        try {
          url = (await unrollHubcloudUrl(candidate.url, {
            signal: controller.signal,
            deadline: unrollDeadline,
            headers: candidate.headers || {}
          })) || '';
          entry.unrolled = url || null;
        } catch (error) {
          entry.unrolled = null;
          entry.unrollError = error instanceof Error ? error.message : 'failed';
        }
      }
      if (url) {
        entry.playable = await probePlayableMediaUrl(url, {
          signal: controller.signal,
          deadline: unrollDeadline + 3000,
          timeoutMs: Number(settings.probeTimeoutMs) || 3500,
          headers: candidate.headers || {}
        });
        if (!entry.playable) {
          try {
            const response = await fetch(url, {
              method: 'GET',
              headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Range: 'bytes=0-1023', ...(candidate.headers || {}) },
              redirect: 'follow',
              signal: controller.signal
            });
            entry.probeStatus = response.status;
            entry.probeContentType = response.headers.get('content-type') || '';
            try { await response.body?.cancel?.(); } catch {}
          } catch (error) {
            entry.probeError = error instanceof Error ? error.message : 'failed';
          }
        }
      }
      entry.ms = Date.now() - t0;
      report.push(entry);
    }
    return {
      ok: true,
      metadata: {
        title: metadata.title,
        releaseYear: metadata.releaseYear || null,
        type: metadata.type,
        season: metadata.season || 1,
        episode: metadata.episode || 1
      },
      providers,
      candidateCount: candidates.length,
      candidates: report,
      totalMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'diagnose_failed'
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} metadata
 * @param {string} requestedServerId
 * @param {string} preferredAudio
 * @param {{ onlySource?: string }} [options] `onlySource` restricts a multi-source
 *   server (currently centaurus) to one source. The Cloudflare Worker uses it to
 *   delegate just the Anime Dub Hindi source after its own HiCine attempt failed,
 *   instead of paying for a second HiCine run on the backend.
 */
async function resolveStreamForServer(metadata, requestedServerId = 'andromeda', preferredAudio = '', options = {}) {
  // 1. Check whether the owner configured a custom stream override for this TMDB ID via /api/admin
  const customOverride = telemetry.getCustomOverride(
    metadata.type,
    metadata.tmdbId,
    metadata.season || 1,
    metadata.episode || 1
  );
  if (!options.onlySource && customOverride && customOverride.streamUrl) {
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
      servers: serverCatalog.buildServerPayload(config.servers, null)
    };
  }

  // Catalog order is authoritative: the player renders the array in this order,
  // so a re-prioritised server must never linger in its old slot.
  const enabledServers = serverCatalog.sortByPriority(
    config.servers.filter((s) => s.enabled !== false)
  );
  const validServer = serverCatalog.resolveServerId(config.servers, requestedServerId);

  const onlySource = String(options.onlySource || '').toLowerCase() || '';
  const cacheKey = `resolve:v4:${metadata.type}:${metadata.tmdbId}:s${metadata.season || 1}:e${metadata.episode || 1}:${validServer}${
    onlySource ? `:${onlySource}` : ''
  }`;
  const cached = await cache.get(cacheKey);
  // Stream payloads are cached for 15 minutes, but the displayed server list is
  // not: rebuilding it here means a rebrand is visible immediately instead of
  // being replayed from cache.
  if (cached) {
    const payload = await applyPreferredAudio(cached, preferredAudio);
    return {
      ...payload,
      servers: serverCatalog.buildServerPayload(config.servers, payload.server)
    };
  }

  // Build the ordered waterfall starting with the user's selected server, then
  // the live priority order. Reading it from config.servers (instead of a frozen
  // constant) is what makes an owner re-prioritisation via /api/admin/upstreams
  // show up in the player immediately.
  const prioritized = enabledServers
    .filter((s) => s.fallback !== false)
    .map((s) => s.id);
  const serverOrder = onlySource
    ? [validServer]
    : [validServer, ...prioritized.filter((id) => id !== validServer)];
  const serverAttempts = [];

  for (const srvId of serverOrder) {
    const t0 = Date.now();
    let resolved = null;
    if (srvId === 'andromeda') {
      resolved = await resolveAndromedaServer(metadata, srvId, preferredAudio);
    } else if (srvId === 'centaurus') {
      // Server 2 fans out over two sources: HiCine, then Anime Dub Hindi.
      // `onlySource` (set by the Worker's delegation) pins it to one of them.
      resolved = await resolveCentaurusServer(metadata, { onlySource });
    } else if (srvId === 'hamster') {
      resolved = await resolveHamsterServer(metadata);
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
        servers: serverCatalog.buildServerPayload(config.servers, resolved.server)
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
    // The normalized id, so an error body never echoes a removed/legacy server.
    requestedServer: validServer,
    reason: 'all_servers_failed',
    serverAttempts,
    servers: serverCatalog.buildServerPayload(config.servers, null)
  };
}

module.exports = {
  resolveStreamForServer,
  resolveAndromedaServer,
  resolveCastletv,
  resolveNetmirror,
  extractHubcloudXhrEndpoints,
  isDdosGuardPage,
  resolveHicineServer,
  resolveAnimeDubHindiSource,
  resolveCentaurusServer,
  diagnoseCentaurus,
  resolveHamsterServer,
  diagnoseHamster,
  buildCastleKey,
  decryptCastleAes,
  mapLanguageNameToCode,
  parseHicineLinks,
  parseHicineAudioHints,
  // Resolver internals exposed for focused regression tests.
  isHubcloudGeneratorUrl,
  unrollHubcloudUrl,
  unrollGdflixUrl,
  extractWrappedMediaTargets,
  normalizePlayableUrl,
  scorePlayableUrl,
  probePlayableMediaUrl,
  containerFormatForUrl
};
