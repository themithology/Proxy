const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const { signProxyParams, verifyProxySignature } = require('../utils/crypto');

/**
 * Hosts the Node tier may fetch for remuxing. These are exactly the CDN
 * families the resolver already hands to the browser (HubCloud/GDFlix release
 * chains included), so remuxing from them grants no new trust — while keeping
 * the SSRF guard intact for anything else. Add deployment-specific suffixes
 * with MULTITRACK_ALLOWED_HOSTS (do not add untrusted hosts).
 */
const DEFAULT_ALLOWED_HOSTS = [
  'r2.dev',
  'cloudflarestorage.com',
  'cloudfront.net',
  'googleusercontent.com',
  'workers.dev',
  'pixeldrain.com',
  'pixeldrain.dev',
  // HubCloud / GDFlix / Anime Dub Hindi release chains.
  'hubcloud.ist',
  'hubdrive.pics',
  'gdflix.dev',
  'gdflix.io',
  'busycdn.xyz',
  'indexserver.site'
];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COPYABLE_AUDIO_CODECS = new Set(['aac', 'ac3', 'eac3']);
const VOLATILE_AUTH_QUERY_PARAM =
  /^(?:token|sig|signature|expires?|expiry|auth|auth_key|access_token|policy|key-pair-id|x-(?:amz|goog)-.+|googleaccessid)$/i;
const LANGUAGE_NAMES = {
  ar: 'Arabic',
  bn: 'Bengali',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fa: 'Persian',
  fr: 'French',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  ml: 'Malayalam',
  mr: 'Marathi',
  pa: 'Punjabi',
  pt: 'Portuguese',
  ru: 'Russian',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  ur: 'Urdu',
  zh: 'Chinese'
};
const ISO639_TO_ISO639_1 = {
  ara: 'ar',
  ben: 'bn',
  deu: 'de',
  ger: 'de',
  eng: 'en',
  fas: 'fa',
  per: 'fa',
  fra: 'fr',
  fre: 'fr',
  hin: 'hi',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kan: 'kn',
  kor: 'ko',
  mal: 'ml',
  mar: 'mr',
  pan: 'pa',
  por: 'pt',
  rus: 'ru',
  tam: 'ta',
  tel: 'te',
  tha: 'th',
  tur: 'tr',
  urd: 'ur',
  zho: 'zh',
  chi: 'zh'
};

const probeCache = new Map();
const pendingProbes = new Map();
const pendingBuilds = new Map();
const runningJobs = new Map();
let activeBuildCount = 0;
let activeProbeCount = 0;

process.once('exit', () => {
  for (const job of runningJobs.values()) {
    try {
      job.child.kill('SIGTERM');
    } catch {}
  }
});

function commandExists(command) {
  if (!command) return false;
  try {
    const result = spawnSync(command, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
      windowsHide: true
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function initializeMultitrack() {
  const requested = config.multitrack && config.multitrack.requested !== false;
  const available =
    !!requested &&
    commandExists(config.multitrack.ffmpegPath) &&
    commandExists(config.multitrack.ffprobePath);
  config.multitrack.enabled = available;
  return available;
}

// Detect at process startup (the resolver imports this module during server boot).
initializeMultitrack();

function normalizeAudioLanguage(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw || /^(und|unknown|undefined|zxx|mis)$/i.test(raw)) return 'und';
  const word = raw.split(/[\s,;.]/, 1)[0];
  const base = word.split('-', 1)[0];
  if (LANGUAGE_NAMES[base]) return base;
  if (ISO639_TO_ISO639_1[base]) return ISO639_TO_ISO639_1[base];
  return /^[a-z]{2,3}$/.test(base) ? base : 'und';
}

function languageName(code) {
  return LANGUAGE_NAMES[normalizeAudioLanguage(code)] || '';
}

function normalizeFallbackLanguages(fallbackLanguages) {
  if (!Array.isArray(fallbackLanguages)) return [];
  return fallbackLanguages
    .map((hint) => normalizeAudioLanguage(typeof hint === 'string' ? hint : hint && hint.code))
    .filter((code) => code !== 'und')
    .slice(0, 16);
}

/**
 * Gate every URL that reaches the remux/ffprobe tier.
 *
 * The suffix allowlist keeps arbitrary third-party hosts out. Resolver call
 * sites that obtained the URL from a provider they already trust pass
 * `{ allowUnknownHost: true }`, which skips ONLY the suffix check: https, the
 * no-credentials/no-port rules and the hard IP/localhost rejection always stay
 * in force, so internal-network SSRF targets remain blocked.
 */
function isAllowedSourceUrl(sourceUrl, options = {}) {
  if (typeof sourceUrl !== 'string' || sourceUrl.length > 8192) return false;
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    /\.(?:m3u8?|mpd|pls|zip|rar|7z)$/i.test(parsed.pathname)
  ) {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return false;
  }
  // IP literal sources are never accepted, even if a permissive custom host is configured.
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return false;

  if (options && options.allowUnknownHost) return true;

  const configuredHosts = Array.from(
    new Set([...DEFAULT_ALLOWED_HOSTS, ...((config.multitrack && config.multitrack.allowedHosts) || [])])
  );
  return configuredHosts.some((suffix) => {
    const cleanSuffix = String(suffix || '').toLowerCase().replace(/^\.|\.$/g, '');
    return cleanSuffix && (host === cleanSuffix || host.endsWith(`.${cleanSuffix}`));
  });
}

/**
 * Cache identity drops rotating authentication query parameters while keeping
 * stable query keys (for example a file ID). HiCine/CDN URLs often rotate
 * `token`, `sig`, and X-Amz values; the full source URL still goes to ffprobe/ffmpeg.
 */
function sourceCacheKey(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const stableParams = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !VOLATILE_AUTH_QUERY_PARAM.test(key))
      .sort(
        ([keyA, valueA], [keyB, valueB]) =>
          keyA.localeCompare(keyB) || valueA.localeCompare(valueB)
      );
    const query = new URLSearchParams(stableParams).toString();
    const stableIdentity = `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
    return crypto.createHash('sha256').update(stableIdentity).digest('hex');
  } catch {
    return '';
  }
}

function parseProbeJson(input) {
  try {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    const streams = Array.isArray(data && data.streams) ? data.streams : [];
    return {
      streams,
      videoStreams: streams.filter(
        (stream) =>
          stream &&
          stream.codec_type === 'video' &&
          Number(stream.disposition && stream.disposition.attached_pic) !== 1
      ),
      audioStreams: streams.filter((stream) => stream && stream.codec_type === 'audio')
    };
  } catch {
    return { streams: [], videoStreams: [], audioStreams: [] };
  }
}

function mapAudioStreams(streams, fallbackLanguages = []) {
  const audioStreams = (Array.isArray(streams) ? streams : []).filter(
    (stream) => stream && stream.codec_type === 'audio'
  );
  const fallbackCodes = normalizeFallbackLanguages(fallbackLanguages);
  const firstDefault = audioStreams.findIndex(
    (stream) => Number(stream.disposition && stream.disposition.default) === 1
  );
  const seenLabels = new Map();

  return audioStreams.map((stream, index) => {
    let lang = normalizeAudioLanguage(stream.tags && stream.tags.language);
    if (lang === 'und' && fallbackCodes[index]) lang = fallbackCodes[index];

    const taggedTitle = String(
      (stream.tags && (stream.tags.title || stream.tags.handler_name)) || ''
    ).trim();
    const usefulTitle = taggedTitle && !/^(?:audio|track|stream)\s*\d*$/i.test(taggedTitle);
    const fallbackLabel = fallbackLanguages[index] && typeof fallbackLanguages[index] === 'object'
      ? String(fallbackLanguages[index].label || '').trim()
      : '';
    let label = usefulTitle
      ? taggedTitle
      : languageName(lang) || fallbackLabel || `Audio ${index + 1}`;

    if (usefulTitle && lang !== 'und') {
      const langLabel = languageName(lang);
      if (langLabel && !new RegExp(`\\b${langLabel}\\b`, 'i').test(label)) {
        label = `${langLabel} — ${label}`;
      }
    }

    const duplicateCount = seenLabels.get(label.toLowerCase()) || 0;
    seenLabels.set(label.toLowerCase(), duplicateCount + 1);
    if (duplicateCount > 0) label = `${label} — Track ${index + 1}`;

    return {
      streamIndex: Number.isInteger(Number(stream.index)) ? Number(stream.index) : index,
      audioIndex: index,
      lang,
      label,
      codec: String(stream.codec_name || '').toLowerCase(),
      channels: Number(stream.channels) || 0,
      channelLayout: String(stream.channel_layout || ''),
      default: firstDefault === -1 ? index === 0 : firstDefault === index
    };
  });
}

function normalizeProbe(probe) {
  if (typeof probe === 'string') return parseProbeJson(probe);
  if (probe && Array.isArray(probe.streams)) return parseProbeJson(probe);
  if (probe && Array.isArray(probe.audioStreams)) {
    return {
      streams: [
        ...(Array.isArray(probe.videoStreams) ? probe.videoStreams : []),
        ...probe.audioStreams
      ],
      videoStreams: Array.isArray(probe.videoStreams) ? probe.videoStreams : [],
      audioStreams: probe.audioStreams
    };
  }
  return parseProbeJson(probe);
}

function masterSignatureTarget(sourceUrl, langParam = '', trusted = false) {
  return `multitrack-master|${sourceUrl}|${langParam}|${trusted ? '1' : '0'}`;
}

function createSignedMasterUrl(sourceUrl, fallbackLanguages = [], options = {}) {
  const langParam = normalizeFallbackLanguages(fallbackLanguages).join(',');
  const trusted = !!(options && options.allowUnknownHost);
  const exp = Math.floor(Date.now() / 1000) + (config.tokenTtlSeconds || 14400);
  const sig = signProxyParams(masterSignatureTarget(sourceUrl, langParam, trusted), '', exp);
  const params = new URLSearchParams({ url: sourceUrl });
  if (langParam) params.set('lang', langParam);
  if (trusted) params.set('trusted', '1');
  params.set('exp', String(exp));
  params.set('sig', sig);
  return `${config.publicBaseUrl || ''}/api/multitrack/master.m3u8?${params.toString()}`;
}

function verifySignedMaster(sourceUrl, langParam, exp, sig, trusted = false) {
  return verifyProxySignature(masterSignatureTarget(sourceUrl, langParam || '', trusted), '', exp, sig);
}

function createSignedAssetUrl(jobId, filename, exp) {
  const resource = `multitrack-asset|${jobId}|${filename}`;
  const sig = signProxyParams(resource, '', exp);
  const base = config.publicBaseUrl || '';
  return `${base}/api/multitrack/file/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}?exp=${encodeURIComponent(String(exp))}&sig=${encodeURIComponent(sig)}`;
}

function verifySignedAsset(jobId, filename, exp, sig) {
  return verifyProxySignature(`multitrack-asset|${jobId}|${filename}`, '', exp, sig);
}

function createMultiTrackPayload(sourceUrl, rawProbe, fallbackLanguages = [], options = {}) {
  const probe = normalizeProbe(rawProbe);
  if (probe.videoStreams.length === 0 || probe.audioStreams.length <= 1) return null;

  const mapped = mapAudioStreams(probe.streams, fallbackLanguages);
  if (mapped.length <= 1) return null;
  const streamUrl = createSignedMasterUrl(sourceUrl, mapped.map((track) => track.lang), {
    allowUnknownHost: !!(options && options.allowUnknownHost)
  });
  return {
    format: 'hls',
    streamUrl,
    audioTracks: mapped.map((track, index) => ({
      id: `centaurus-audio-${index}`,
      lang: track.lang,
      label: track.label,
      type: 'dub',
      streamUrl,
      rawUrl: sourceUrl,
      // Rendition order in the generated master playlist. The player switches
      // with `hls.audioTrack = audioIndex`, which keeps working when ffprobe
      // could not tag a language (lang === 'und' used to make the switch a
      // silent no-op while the UI still said "Audio switched").
      audioIndex: index,
      default: track.default
    }))
  };
}

function runCommand(command, args, options = {}) {
  const {
    timeoutMs = config.multitrack.probeTimeoutMs,
    maxStdoutBytes = 2 * 1024 * 1024,
    maxStderrBytes = 16 * 1024
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env
      });
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      const error = new Error('External media tool timed out');
      error.code = 'MULTITRACK_TIMEOUT';
      finish(error);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > maxStdoutBytes) {
        try {
          child.kill('SIGKILL');
        } catch {}
        const error = new Error('External media tool output exceeded its size limit');
        error.code = 'MULTITRACK_OUTPUT_LIMIT';
        finish(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxStderrBytes) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, maxStderrBytes);
      }
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      } else {
        const error = new Error('External media tool failed');
        error.code = 'MULTITRACK_TOOL_FAILED';
        error.exitCode = code;
        error.signal = signal;
        error.stderr = stderr.toString('utf8');
        finish(error);
      }
    });
  });
}

async function probeSource(sourceUrl, options = {}) {
  if (!config.multitrack.enabled || !isAllowedSourceUrl(sourceUrl, options)) return null;
  const cacheKey = sourceCacheKey(sourceUrl);
  if (!cacheKey) return null;

  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.probe;
  if (pendingProbes.has(cacheKey)) return pendingProbes.get(cacheKey);
  if (activeProbeCount >= config.multitrack.maxJobs) return null;
  activeProbeCount += 1;

  const pending = (async () => {
    try {
      const args = [
        '-v',
        'error',
        '-rw_timeout',
        String(config.multitrack.probeTimeoutMs * 1000),
        '-user_agent',
        USER_AGENT,
        '-show_streams',
        '-show_format',
        '-print_format',
        'json',
        sourceUrl
      ];
      const { stdout } = await runCommand(config.multitrack.ffprobePath, args, {
        timeoutMs: config.multitrack.probeTimeoutMs,
        maxStdoutBytes: 2 * 1024 * 1024
      });
      const probe = parseProbeJson(stdout);
      if (probe.streams.length === 0) throw new Error('No media streams were found');
      probeCache.set(cacheKey, {
        probe,
        expiresAt: Date.now() + config.multitrack.probeCacheTtlMs
      });
      return probe;
    } finally {
      activeProbeCount = Math.max(0, activeProbeCount - 1);
    }
  })();

  pendingProbes.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    pendingProbes.delete(cacheKey);
  }
}

async function prepareMultiTrackStream(sourceUrl, fallbackLanguages = [], options = {}) {
  const enabled = options.enabled == null ? config.multitrack.enabled : !!options.enabled;
  const trusted = !!(options && options.trustSource);
  if (!enabled || !isAllowedSourceUrl(sourceUrl, { allowUnknownHost: trusted })) return null;
  try {
    const probe = options.probe
      ? await options.probe(sourceUrl)
      : await probeSource(sourceUrl, { allowUnknownHost: trusted });
    if (!probe) return null;
    return createMultiTrackPayload(sourceUrl, probe, fallbackLanguages, {
      allowUnknownHost: trusted
    });
  } catch {
    // Remux support is an optimization; a probe failure must preserve progressive playback.
    return null;
  }
}

function safeHlsAttribute(value) {
  return String(value || '')
    .replace(/[\r\n]/g, ' ')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMasterPlaylist(audioTracks) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  audioTracks.forEach((track, index) => {
    const name = safeHlsAttribute(track.label || `Audio ${index + 1}`);
    const language = /^[a-z]{2,3}$/.test(track.lang) ? `,LANGUAGE="${track.lang}"` : '';
    const channels = track.channels > 0 ? `,CHANNELS="${track.channels}"` : '';
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}"${language},DEFAULT=${track.default ? 'YES' : 'NO'},AUTOSELECT=YES${channels},URI="track_${index + 1}.m3u8"`
    );
  });
  lines.push('#EXT-X-STREAM-INF:BANDWIDTH=50000000,AUDIO="audio"', 'track_0.m3u8');
  return `${lines.join('\n')}\n`;
}

function safeOutputName(value) {
  const name = path.posix.basename(String(value || '').split(/[?#]/, 1)[0]);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return '';
  return name;
}

function localPlaylistResource(uri) {
  let value = String(uri || '').trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return '';
  }
  if (/^(?:https?:|file:|\/\/)/i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return '';
    }
  }
  return safeOutputName(value);
}

async function hasInitialMediaSegments(directory, audioTrackCount) {
  for (let index = 0; index <= audioTrackCount; index += 1) {
    const playlistPath = path.join(directory, `track_${index}.m3u8`);
    const playlist = await fsp.readFile(playlistPath, 'utf8').catch(() => '');
    if (!playlist.startsWith('#EXTM3U')) return false;
    const segmentLine = playlist.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#'));
    const mapUri = (playlist.match(/#EXT-X-MAP:[^\r\n]*\bURI="([^"]+)"/i) || [])[1];
    const segmentName = localPlaylistResource(segmentLine);
    const initName = localPlaylistResource(mapUri);
    if (!segmentName || !initName) return false;
    const [segment, init] = await Promise.all([
      fsp.stat(path.join(directory, segmentName)).catch(() => null),
      fsp.stat(path.join(directory, initName)).catch(() => null)
    ]);
    if (!segment || !segment.isFile() || segment.size === 0 || !init || !init.isFile() || init.size === 0) {
      return false;
    }
  }
  return true;
}

function assetUrlFromPlaylistUri(uri, jobId, exp) {
  let decoded = String(uri || '').trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw value and reject it below if it is not a safe local filename.
  }
  if (/^(?:https?:|file:|\/\/)/i.test(decoded)) return '';
  const filename = safeOutputName(decoded);
  return filename ? createSignedAssetUrl(jobId, filename, exp) : '';
}

function rewriteGeneratedPlaylist(content, jobId, exp) {
  return String(content || '').split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#') && /\bURI="[^"]+"/i.test(line)) {
      let invalid = false;
      const rewritten = line.replace(/URI="([^"]+)"/gi, (whole, uri) => {
        const signed = assetUrlFromPlaylistUri(uri, jobId, exp);
        if (!signed) {
          invalid = true;
          return whole;
        }
        return `URI="${signed}"`;
      });
      if (invalid) throw new Error('Generated playlist contains an unsafe resource URI');
      return rewritten;
    }

    if (!trimmed.startsWith('#')) {
      const signed = assetUrlFromPlaylistUri(trimmed, jobId, exp);
      if (!signed) throw new Error('Generated playlist contains an unsafe segment URI');
      return signed;
    }
    return line;
  }).join('\n');
}

function buildFfmpegArgs(sourceUrl, probe, audioTracks, directory) {
  const video = probe.videoStreams[0];
  const mapArgs = ['-map', `0:${video.index}`];
  for (const track of audioTracks) mapArgs.push('-map', `0:${track.streamIndex}`);

  const streamMap = ['v:0,agroup:audio'];
  for (let index = 0; index < audioTracks.length; index += 1) {
    const track = audioTracks[index];
    const language = /^[a-z]{2,3}$/.test(track.lang) ? track.lang : 'und';
    const name = String(track.label || `Audio_${index + 1}`)
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 48) || `Audio_${index + 1}`;
    const parts = [`a:${index}`, 'agroup:audio', `language:${language}`, `name:${name}`];
    if (track.default) parts.push('default:yes');
    streamMap.push(parts.join(','));
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-rw_timeout',
    String(config.multitrack.jobTimeoutMs * 1000),
    '-user_agent',
    USER_AGENT,
    '-i',
    sourceUrl,
    ...mapArgs,
    '-c:v',
    'copy',
    '-sn'
  ];

  for (let index = 0; index < audioTracks.length; index += 1) {
    const codec = COPYABLE_AUDIO_CODECS.has(audioTracks[index].codec) ? 'copy' : 'aac';
    args.push(`-c:a:${index}`, codec);
    if (codec === 'aac') args.push(`-b:a:${index}`, '192k');
  }

  args.push(
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments+temp_file',
    '-master_pl_name',
    'ffmpeg-master.m3u8',
    '-var_stream_map',
    streamMap.join(' '),
    '-hls_segment_filename',
    path.join(directory, 'variant_%v_%05d.m4s'),
    '-hls_fmp4_init_filename',
    path.join(directory, 'init_%v.mp4'),
    path.join(directory, 'track_%v.m3u8')
  );
  return args;
}

async function cacheDirectory() {
  const dir = config.multitrack.cacheDir || path.join(os.tmpdir(), 'proxy-multitrack');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function isReadyDirectory(directory) {
  try {
    const failed = await fsp.stat(path.join(directory, '.failed')).catch(() => null);
    if (failed) return false;
    const [ready, master] = await Promise.all([
      fsp.stat(path.join(directory, '.ready')),
      fsp.stat(path.join(directory, 'master.m3u8'))
    ]);
    if (!ready.isFile() || !master.isFile() || master.size === 0) return false;

    const complete = await fsp.stat(path.join(directory, '.complete')).catch(() => null);
    if (complete && complete.isFile()) return true;
    const building = JSON.parse(await fsp.readFile(path.join(directory, '.building'), 'utf8'));
    const startedAt = Number(building.startedAt) || 0;
    if (startedAt && Date.now() - startedAt > config.multitrack.jobTimeoutMs + 60 * 1000) return false;
    const pid = Number(building.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(error && error.code === 'ESRCH');
    }
  } catch {
    return false;
  }
}

async function lockIsStale(lockDirectory, now = Date.now()) {
  try {
    const owner = JSON.parse(await fsp.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
    const startedAt = Number(owner.startedAt) || 0;
    if (startedAt && now - startedAt > config.multitrack.jobTimeoutMs + 60 * 1000) return true;
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error && error.code === 'ESRCH';
    }
  } catch {
    const stat = await fsp.stat(lockDirectory).catch(() => null);
    return !!stat && now - stat.mtimeMs > 60 * 1000;
  }
}

async function anotherBuilderIsPackaging(root, jobId) {
  for (let slot = 0; slot < config.multitrack.maxJobs; slot += 1) {
    const lockDirectory = path.join(root, `.multitrack-lock-${slot}`);
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
      if (owner.jobId === jobId && !(await lockIsStale(lockDirectory))) return true;
    } catch {
      // Empty, stale, or concurrently released lock slot.
    }
  }
  return false;
}

async function acquireBuildLock(root, jobId) {
  for (let slot = 0; slot < config.multitrack.maxJobs; slot += 1) {
    const lockDirectory = path.join(root, `.multitrack-lock-${slot}`);
    try {
      await fsp.mkdir(lockDirectory);
      try {
        await fsp.writeFile(
          path.join(lockDirectory, 'owner.json'),
          JSON.stringify({ pid: process.pid, jobId, startedAt: Date.now() })
        );
      } catch (error) {
        await fsp.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return lockDirectory;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (await lockIsStale(lockDirectory)) {
        await fsp.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        try {
          await fsp.mkdir(lockDirectory);
          await fsp.writeFile(
            path.join(lockDirectory, 'owner.json'),
            JSON.stringify({ pid: process.pid, jobId, startedAt: Date.now() })
          );
          return lockDirectory;
        } catch (retryError) {
          if (!retryError || retryError.code !== 'EEXIST') throw retryError;
        }
      }
    }
  }
  return '';
}

function buildJobId(sourceUrl) {
  return sourceCacheKey(sourceUrl);
}

function startFfmpegJob(sourceUrl, probe, audioTracks, outputDirectory, lockDirectory, jobId) {
  const args = buildFfmpegArgs(sourceUrl, probe, audioTracks, outputDirectory);
  const child = spawn(config.multitrack.ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: process.env
  });
  const job = {
    child,
    exitCode: null,
    error: null,
    stderr: Buffer.alloc(0),
    finished: null,
    lockDirectory
  };
  activeBuildCount += 1;
  let finalized = false;
  job.finished = new Promise((resolve) => {
    const finalize = async (code, signal, error) => {
      if (finalized) return;
      finalized = true;
      job.exitCode = Number.isInteger(code) ? code : 1;
      job.signal = signal || '';
      job.error = error || job.error;
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

      try {
        if (job.exitCode === 0 && !job.error) {
          await fsp.writeFile(path.join(outputDirectory, '.complete'), new Date().toISOString());
          await fsp.rm(path.join(outputDirectory, '.failed'), { force: true }).catch(() => {});
        } else {
          await fsp.writeFile(
            path.join(outputDirectory, '.failed'),
            JSON.stringify({ code: job.exitCode, finishedAt: Date.now() })
          ).catch(() => {});
        }
        await fsp.rm(path.join(outputDirectory, '.building'), { force: true }).catch(() => {});
      } finally {
        runningJobs.delete(jobId);
        activeBuildCount = Math.max(0, activeBuildCount - 1);
        await fsp.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        resolve(job);
      }
    };

    child.stderr.on('data', (chunk) => {
      if (job.stderr.length < 32 * 1024) {
        job.stderr = Buffer.concat([job.stderr, chunk]).subarray(0, 32 * 1024);
      }
    });
    child.once('error', (error) => {
      job.error = error;
      setImmediate(() => finalize(1, '', error));
    });
    child.once('close', (code, signal) => {
      finalize(code, signal, job.error).catch(() => {});
    });
  });
  job.timeoutTimer = setTimeout(() => {
    job.timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {}
  }, config.multitrack.jobTimeoutMs);
  if (typeof job.timeoutTimer.unref === 'function') job.timeoutTimer.unref();
  runningJobs.set(jobId, job);
  return job;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInitialPackage(job, directory, audioTracks) {
  const deadline = Date.now() + config.multitrack.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (job.exitCode !== null && job.exitCode !== 0) {
      const error = new Error('ffmpeg exited before producing initial HLS segments');
      error.code = 'MULTITRACK_TOOL_FAILED';
      throw error;
    }
    if (await hasInitialMediaSegments(directory, audioTracks.length)) {
      await fsp.writeFile(path.join(directory, 'master.m3u8'), buildMasterPlaylist(audioTracks), 'utf8');
      await fsp.writeFile(path.join(directory, '.ready'), new Date().toISOString());
      return;
    }
    if (job.exitCode !== null) {
      const error = new Error('ffmpeg completed without usable HLS audio renditions');
      error.code = 'MULTITRACK_OUTPUT_INVALID';
      throw error;
    }
    await delay(250);
  }

  const error = new Error('ffmpeg did not produce initial HLS segments in time');
  error.code = 'MULTITRACK_STARTUP_TIMEOUT';
  try {
    job.child.kill('SIGKILL');
  } catch {}
  await job.finished;
  throw error;
}

async function ensurePackage(sourceUrl, fallbackLanguages = [], options = {}) {
  if (!config.multitrack.enabled) throw new Error('Multi-track remuxing is disabled');
  // Mirrors serveMasterPlaylist's gate: a signed trusted master may package a
  // provider-resolved source even when its CDN host is not on the allowlist.
  if (!isAllowedSourceUrl(sourceUrl, options)) throw new Error('Source host is not allowlisted');
  const jobId = buildJobId(sourceUrl);
  if (!jobId) throw new Error('Invalid source URL');

  const root = await cacheDirectory();
  const outputDirectory = path.join(root, jobId);
  if (await isReadyDirectory(outputDirectory)) {
    await fsp.utimes(outputDirectory, new Date(), new Date()).catch(() => {});
    return { jobId, directory: outputDirectory };
  }
  if (pendingBuilds.has(jobId)) return pendingBuilds.get(jobId);
  if (activeBuildCount >= config.multitrack.maxJobs) {
    const error = new Error('The multi-track remux queue is full');
    error.code = 'MULTITRACK_BUSY';
    throw error;
  }

  const pending = (async () => {
    let lockDirectory = '';
    try {
      const probe = await probeSource(sourceUrl);
      if (!probe) {
        const error = new Error('The multi-track probe capacity is busy');
        error.code = 'MULTITRACK_BUSY';
        throw error;
      }
      const audioTracks = mapAudioStreams(probe.streams, fallbackLanguages);
      if (probe.videoStreams.length === 0 || audioTracks.length <= 1) {
        throw new Error('Source does not contain multiple audio tracks');
      }
      if (await isReadyDirectory(outputDirectory)) {
        await fsp.utimes(outputDirectory, new Date(), new Date()).catch(() => {});
        return { jobId, directory: outputDirectory };
      }
      if (activeBuildCount >= config.multitrack.maxJobs) {
        const error = new Error('The multi-track remux queue is full');
        error.code = 'MULTITRACK_BUSY';
        throw error;
      }

      lockDirectory = await acquireBuildLock(root, jobId);
      if (!lockDirectory) {
        const joinDeadline = Date.now() + Math.min(config.multitrack.startupTimeoutMs + 5000, 60000);
        while (Date.now() < joinDeadline && (await anotherBuilderIsPackaging(root, jobId))) {
          if (await isReadyDirectory(outputDirectory)) {
            await fsp.utimes(outputDirectory, new Date(), new Date()).catch(() => {});
            return { jobId, directory: outputDirectory };
          }
          await delay(250);
        }
        if (await isReadyDirectory(outputDirectory)) {
          await fsp.utimes(outputDirectory, new Date(), new Date()).catch(() => {});
          return { jobId, directory: outputDirectory };
        }
        const error = new Error('The multi-track remux queue is full');
        error.code = 'MULTITRACK_BUSY';
        throw error;
      }
      if (await isReadyDirectory(outputDirectory)) {
        await fsp.utimes(outputDirectory, new Date(), new Date()).catch(() => {});
        return { jobId, directory: outputDirectory };
      }

      await fsp.rm(outputDirectory, { recursive: true, force: true });
      await fsp.mkdir(outputDirectory, { recursive: true });
      await fsp.writeFile(
        path.join(outputDirectory, '.building'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now(), jobId })
      );
      const jobLock = lockDirectory;
      const job = startFfmpegJob(sourceUrl, probe, audioTracks, outputDirectory, jobLock, jobId);
      lockDirectory = '';

      try {
        await waitForInitialPackage(job, outputDirectory, audioTracks);
      } catch (error) {
        if (job.exitCode === null) {
          try {
            job.child.kill('SIGKILL');
          } catch {}
        }
        await job.finished;
        await fsp.rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      await fsp.utimes(outputDirectory, new Date(), new Date()).catch(() => {});
      return { jobId, directory: outputDirectory };
    } finally {
      if (lockDirectory) {
        await fsp.rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  })();

  pendingBuilds.set(jobId, pending);
  try {
    return await pending;
  } finally {
    pendingBuilds.delete(jobId);
  }
}
function assetPath(directory, filename) {
  const safeName = safeOutputName(filename);
  if (!safeName) return '';
  const candidate = path.resolve(directory, safeName);
  const parent = `${path.resolve(directory)}${path.sep}`;
  return candidate.startsWith(parent) ? candidate : '';
}

async function sweepCache(now = Date.now()) {
  try {
    const root = await cacheDirectory();
    const entries = await fsp.readdir(root, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const fullPath = path.join(root, entry.name);
      try {
        if (entry.name.startsWith('.multitrack-lock-') && !(await lockIsStale(fullPath, now))) return;
        if (/^[a-f0-9]{64}$/.test(entry.name) && runningJobs.has(entry.name)) return;
        if (/^[a-f0-9]{64}$/.test(entry.name) && (await isReadyDirectory(fullPath))) {
          const complete = await fsp.stat(path.join(fullPath, '.complete')).catch(() => null);
          if (!complete) return;
        }
        const stat = await fsp.stat(fullPath);
        const ttl = entry.name.startsWith('.tmp-')
          ? config.multitrack.jobTimeoutMs + 60 * 60 * 1000
          : config.multitrack.cacheTtlMs;
        if (now - stat.mtimeMs > ttl) {
          await fsp.rm(fullPath, { recursive: true, force: true });
        }
      } catch {
        // A file may be concurrently removed or atomically replaced.
      }
    }));
    for (const [key, value] of probeCache) {
      if (value.expiresAt <= now) probeCache.delete(key);
    }
  } catch {
    // Cache cleanup is best-effort; playback must not depend on a successful sweep.
  }
}

const sweepTimer = setInterval(() => {
  sweepCache().catch(() => {});
}, 10 * 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

async function serveMasterPlaylist(req, res) {
  const sourceUrl = String(req.query.url || '');
  const langParam = String(req.query.lang || '');
  const exp = String(req.query.exp || '');
  const sig = String(req.query.sig || '');
  // Only a server-signed master may relax the host suffix check: the flag is
  // part of the signed payload, so clients cannot add it themselves.
  const trusted = String(req.query.trusted || '') === '1';
  const validLanguageParam = !langParam || langParam.split(',').every((code) => /^[a-z]{2,3}$/.test(code));

  if (!sourceUrl || !verifySignedMaster(sourceUrl, langParam, exp, sig, trusted)) {
    return res.status(403).json({ error: 'Invalid or expired multi-track signature' });
  }
  if (!validLanguageParam) return res.status(400).json({ error: 'Invalid audio language metadata' });
  if (!isAllowedSourceUrl(sourceUrl, { allowUnknownHost: trusted })) {
    return res.status(403).json({ error: 'Source host is not allowed for multi-track remuxing' });
  }
  if (!config.multitrack.enabled) {
    return res.status(503).json({ error: 'Multi-track remuxing is unavailable on this Node host' });
  }

  try {
    const fallbackLanguages = langParam ? langParam.split(',') : [];
    const job = await ensurePackage(sourceUrl, fallbackLanguages, { allowUnknownHost: trusted });
    const masterPath = path.join(job.directory, 'master.m3u8');
    const master = await fsp.readFile(masterPath, 'utf8');
    await fsp.utimes(job.directory, new Date(), new Date()).catch(() => {});
    const rewritten = rewriteGeneratedPlaylist(master, job.jobId, exp);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.status(200).send(rewritten);
  } catch (error) {
    if (error && error.code === 'MULTITRACK_BUSY') {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({ error: 'Multi-track remux capacity is busy' });
    }
    // Do not return command stderr or the signed source URL to a client.
    console.warn(`[multitrack] HLS package failed (${error && error.code ? error.code : 'error'})`);
    return res.status(502).json({ error: 'Unable to create multi-track HLS; use the progressive fallback' });
  }
}

async function serveGeneratedFile(req, res) {
  const { jobId, filename } = req.params;
  const exp = String(req.query.exp || '');
  const sig = String(req.query.sig || '');
  if (!/^[a-f0-9]{64}$/.test(String(jobId || '')) || !safeOutputName(filename)) {
    return res.status(400).send('Invalid multi-track asset path');
  }
  if (!verifySignedAsset(jobId, filename, exp, sig)) {
    return res.status(403).send('Invalid or expired multi-track asset signature');
  }
  if (!config.multitrack.enabled) return res.status(503).send('Multi-track remuxing is unavailable');

  try {
    const root = await cacheDirectory();
    const directory = path.join(root, jobId);
    if (!(await isReadyDirectory(directory))) return res.status(404).send('Multi-track asset expired');
    const fullPath = assetPath(directory, filename);
    if (!fullPath) return res.status(400).send('Invalid multi-track asset path');
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).send('Multi-track asset not found');
    await fsp.utimes(directory, new Date(), new Date()).catch(() => {});

    if (/\.m3u8$/i.test(filename)) {
      const playlist = await fsp.readFile(fullPath, 'utf8');
      const rewritten = rewriteGeneratedPlaylist(playlist, jobId, exp);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).send(rewritten);
    }

    const contentType = /\.mp4$/i.test(filename)
      ? 'video/mp4'
      : /\.m4s$/i.test(filename)
        ? 'video/iso.segment'
        : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(fullPath);
  } catch {
    return res.status(404).send('Multi-track asset not found');
  }
}

module.exports = {
  DEFAULT_ALLOWED_HOSTS,
  initializeMultitrack,
  isAllowedSourceUrl,
  sourceCacheKey,
  normalizeAudioLanguage,
  parseProbeJson,
  mapAudioStreams,
  buildMasterPlaylist,
  hasInitialMediaSegments,
  createSignedMasterUrl,
  verifySignedMaster,
  createSignedAssetUrl,
  verifySignedAsset,
  createMultiTrackPayload,
  prepareMultiTrackStream,
  buildFfmpegArgs,
  rewriteGeneratedPlaylist,
  ensurePackage,
  sweepCache,
  serveMasterPlaylist,
  serveGeneratedFile
};
