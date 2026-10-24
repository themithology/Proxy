'use strict';

/**
 * Node-host progressive media -> HLS transcoding.
 *
 * This module is deliberately imported only by the Node development/host
 * harness. Cloudflare Workers cannot spawn ffmpeg. When the Worker page
 * advertises MKV_HLS_ENABLED=true, progressive sources are converter inputs;
 * the browser receives HLS and never opens the original file directly.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { parseAttributes } = require('./hls');

const ROUTE = '/api/mkv-hls';
const SESSION_ID = /^[a-f0-9]{32}$/;
const MEDIA_FILE = /^(?:master\.m3u8|variant_\d+\.m3u8|segment_\d+_\d+\.ts)$/;
const DEFAULT_ROOT = path.join(os.tmpdir(), 'lol-embed-mkv-hls');

function positiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeToken(value, fallback = 'und') {
  const token = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  return token || fallback;
}

function displayTrackLabel(stream, index) {
  const tags = (stream && stream.tags) || {};
  const title = String(tags.title || '').trim();
  if (title) return title.replace(/\s+/g, ' ').slice(0, 80);
  const lang = safeToken(tags.language, '');
  if (lang && lang !== 'und') return lang.toUpperCase();
  return `Audio ${index + 1}`;
}

function buildMkvHlsLadder(sourceHeight) {
  const height = Number(sourceHeight) || 0;
  if (height <= 0) return [{ height: 0, bitrate: 2500 }];

  // Never upscale or advertise a 4K transcode on the small development host.
  // Non-standard source heights keep their real top rung (900p, for example).
  const top = Math.min(1080, Math.max(2, Math.floor(height / 2) * 2));
  const heights = [top];
  [1080, 720, 480].forEach((candidate) => {
    if (candidate < top && !heights.includes(candidate)) heights.push(candidate);
  });
  return heights.map((rung) => ({
    height: rung,
    bitrate: rung >= 1080 ? 5000 : rung >= 900 ? 3500 : rung >= 720 ? 3000 : rung >= 480 ? 1400 : 900
  }));
}

function quoteAttribute(value) {
  return `"${String(value == null ? '' : value).replace(/["\r\n]/g, '')}"`;
}

/**
 * ffmpeg 4.1 writes one EXT-X-MEDIA row per audio output, but its
 * var_stream_map does not support NAME/LANGUAGE and it also exposes the audio
 * outputs as audio-only quality variants. Patch only the master served to the
 * browser: variant/segment files remain exactly as ffmpeg wrote them.
 */
function patchMkvHlsMaster(manifest, audioTracks) {
  const lines = String(manifest || '').split(/\r?\n/);
  const output = [];
  let audioIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#EXT-X-MEDIA:/i.test(line)) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (attrs.TYPE !== 'AUDIO') {
        output.push(line);
        continue;
      }
      const track = audioTracks[audioIndex] || {};
      audioIndex += 1;
      const fields = [
        `TYPE=AUDIO`,
        `GROUP-ID=${quoteAttribute(attrs['GROUP-ID'] || 'group_aud')}`,
        `NAME=${quoteAttribute(track.label || `Audio ${audioIndex}`)}`
      ];
      if (track.lang && track.lang !== 'und') fields.push(`LANGUAGE=${quoteAttribute(track.lang)}`);
      fields.push(`DEFAULT=${audioIndex === 1 ? 'YES' : 'NO'}`);
      fields.push('AUTOSELECT=YES');
      fields.push('CHANNELS="2"');
      fields.push(`URI=${quoteAttribute(attrs.URI || '')}`);
      output.push(`#EXT-X-MEDIA:${fields.join(',')}`);
      continue;
    }

    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      // Audio-only outputs are selectable through EXT-X-MEDIA, not fake video
      // quality rows. Skip this declaration and its URI line.
      if (!attrs.RESOLUTION) {
        if (lines[index + 1] && !lines[index + 1].startsWith('#')) index += 1;
        continue;
      }
    }
    output.push(line);
  }
  return output.join('\n');
}

function redactLog(value, secrets) {
  let text = String(value || '');
  secrets.filter(Boolean).forEach((secret) => {
    if (text.includes(secret)) text = text.split(secret).join('[source]');
  });
  return text
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-1200);
}

function probeStreams(inputUrl, session) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-rw_timeout', '30000000',
      '-show_streams',
      '-of', 'json',
      inputUrl
    ];
    const child = execFile(ffprobeInstaller.path, args, {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (session.probeChild === child) session.probeChild = null;
      if (error) {
        const detail = redactLog(stderr || error.message, [inputUrl, session.publicSource]);
        reject(new Error(detail || 'ffprobe could not read the source'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (_) {
        reject(new Error('ffprobe returned invalid stream metadata'));
      }
    });
    session.probeChild = child;
  });
}

function appendSessionLog(session, chunk) {
  session.log = `${session.log}${String(chunk || '')}`.slice(-32768);
}

async function waitForPlaylists(session, expectedCount, timeoutMs, requireSourceComplete = false) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.status === 'failed' || session.status === 'closed') {
      throw new Error(redactLog(session.log, [session.inputUrl, session.publicSource]) || 'ffmpeg stopped');
    }
    let ready = session.status === 'done';
    if (!ready) {
      ready = true;
      for (let index = 0; index < expectedCount; index += 1) {
        try {
          const playlist = await fs.promises.readFile(path.join(session.dir, `variant_${index}.m3u8`), 'utf8');
          if (!playlist.includes('#EXTM3U') || !playlist.includes('#EXTINF')) {
            ready = false;
            break;
          }
          if (requireSourceComplete && index === 0 && !playlist.includes('#EXT-X-ENDLIST')) {
            ready = false;
            break;
          }
        } catch (_) {
          ready = false;
          break;
        }
      }
    }
    if (ready) {
      await fs.promises.access(path.join(session.dir, session.masterInput || 'master.m3u8'), fs.constants.R_OK);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Timed out waiting for the first HLS segments');
}

const VOLATILE_SOURCE_PARAMS = new Set([
  'sig', 'signature', 'expires', 'exp', 'token', 'key', 'auth', 'hdntl', 'hdnea',
  'policy', 'key-pair-id', 'session', 'hash'
]);

function conversionIdentity(publicSource) {
  let identity = String(publicSource || '');
  try {
    const proxyUrl = new URL(identity, 'http://local.invalid');
    identity = proxyUrl.searchParams.get('url') || identity;
    const parsed = new URL(identity);
    const stableParams = [...parsed.searchParams.entries()]
      .filter(([key]) => !VOLATILE_SOURCE_PARAMS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    stableParams.forEach(([key, value]) => parsed.searchParams.append(key, value));
    return parsed.href;
  } catch (_) {
    return identity;
  }
}

function createMkvHlsHandler(options = {}) {
  const enabled = options.enabled === true;
  const port = positiveInt(options.port, 3000, 1, 65535);
  const rootDir = options.rootDir || process.env.MKV_HLS_DIR || DEFAULT_ROOT;
  const readyTimeout = positiveInt(process.env.MKV_HLS_READY_TIMEOUT_MS, 120000, 10000, 300000);
  const maxSessions = positiveInt(process.env.MKV_HLS_MAX_SESSIONS, 2, 1, 4);
  const ttlMs = positiveInt(process.env.MKV_HLS_SESSION_TTL_MS, 2 * 60 * 60 * 1000, 60000, 12 * 60 * 60 * 1000);
  const sessions = new Map();

  function stopSession(session) {
    if (!session) return Promise.resolve();
    if (session.cleanup) return session.cleanup;
    session.status = 'closed';
    sessions.delete(session.id);
    const children = [...new Set([session.probeChild, session.child, ...(session.children || [])].filter(Boolean))];
    children.forEach((child) => {
      if (child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    });
    const closed = children.map((child) => {
      if (child.exitCode !== null || child.signalCode) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('close', resolve);
        setTimeout(resolve, 2000).unref();
      });
    });
    session.cleanup = Promise.all(closed)
      .then(() => fs.promises.rm(session.dir, { recursive: true, force: true }))
      .catch(() => {});
    return session.cleanup;
  }

  async function makeRoom() {
    while (sessions.size >= maxSessions) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (!oldest) break;
      await stopSession(oldest);
    }
  }

  async function startSession(session) {
    await fs.promises.mkdir(session.dir, { recursive: true });
    if (session.status === 'closed') throw new Error('Conversion session closed');
    const probe = await probeStreams(session.inputUrl, session);
    if (session.status === 'closed') throw new Error('Conversion session closed');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStream = streams.find((stream) =>
      stream && stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic)
    ) || streams.find((stream) => stream && stream.codec_type === 'video');
    if (!videoStream) throw new Error('The source has no video stream');

    const sourceAudio = streams.filter((stream) => stream && stream.codec_type === 'audio').slice(0, 8);
    session.sourceWidth = Number(videoStream.width) || 0;
    session.sourceHeight = Number(videoStream.height) || 0;
    session.sourceBandwidth = Number(videoStream.bit_rate) || 0;
    session.audioTracks = sourceAudio.map((stream, index) => ({
      lang: safeToken(stream.tags && stream.tags.language),
      label: displayTrackLabel(stream, index)
    }));
    // Two genuine rungs are useful without making a small host encode three
    // complete copies. Compatible top video is never re-encoded at all.
    const ladder = buildMkvHlsLadder(videoStream.height).slice(0, 2);
    session.ladder = ladder;
    session.children = [];

    const makeInputArgs = () => {
      const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y'];
      if (/^https?:\/\//i.test(session.inputUrl)) {
        args.push(
          '-rw_timeout', '30000000',
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5'
        );
      }
      args.push('-i', session.inputUrl);
      return args;
    };
    const addAudioArgs = (args) => {
      sourceAudio.forEach((stream, index) => {
        if (stream.codec_name === 'aac') {
          args.push(`-c:a:${index}`, 'copy');
        } else {
          args.push(
            `-c:a:${index}`, 'aac',
            `-b:a:${index}`, '128k',
            `-ac:a:${index}`, '2',
            `-ar:a:${index}`, '48000'
          );
        }
      });
    };
    const addHlsArgs = (args, masterName) => {
      args.push(
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+temp_file'
      );
      if (masterName) args.push('-master_pl_name', masterName);
    };
    const addEncodeArgs = (args, rung, index = null) => {
      const videoOption = (name) => index === null ? name : `${name}:v:${index}`;
      args.push(
        videoOption('-c'), 'libx264',
        videoOption('-pix_fmt'), 'yuv420p',
        videoOption('-preset'), 'ultrafast',
        videoOption('-threads'), '1',
        videoOption('-b'), `${rung.bitrate}k`,
        videoOption('-maxrate'), `${rung.bitrate}k`,
        videoOption('-bufsize'), `${rung.bitrate * 2}k`,
        videoOption('-g'), '120',
        videoOption('-keyint_min'), '120',
        videoOption('-sc_threshold'), '0',
        videoOption('-force_key_frames'), 'expr:gte(t,n_forced*2)'
      );
      if (rung.height > 0) {
        args.push(videoOption('-filter'), `scale=-2:${rung.height},setsar=1`);
      }
    };

    const runningChildren = new Set();
    const launch = (args, label) => {
      const child = spawn(ffmpegInstaller.path, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
      if (!session.child) session.child = child;
      session.children.push(child);
      runningChildren.add(child);
      child.stderr.on('data', (chunk) => appendSessionLog(session, chunk));
      child.once('error', (error) => {
        appendSessionLog(session, `${label}: ${error.message}`);
        if (session.status !== 'closed') session.status = 'failed';
      });
      child.once('exit', (code, signal) => {
        runningChildren.delete(child);
        if (session.status === 'closed') return;
        if (code !== 0) {
          session.status = 'failed';
          appendSessionLog(session, `${label} exited code=${code} signal=${signal || ''}`);
          if (!session.ready) {
            session.children.forEach((other) => {
              if (other !== child && other.exitCode === null && !other.signalCode) {
                try { other.kill('SIGKILL'); } catch (_) {}
              }
            });
          }
        } else if (runningChildren.size === 0 && session.status !== 'failed') {
          session.status = 'done';
        }
      });
      return child;
    };

    const canRemuxTop =
      videoStream.codec_name === 'h264' &&
      videoStream.pix_fmt === 'yuv420p' &&
      Number(ladder[0] && ladder[0].height) === (Number(videoStream.height) || 0);
    session.status = 'running';

    if (canRemuxTop) {
      // Remux and lower-rung encode are independent processes. The source-
      // quality playlist can therefore reach ENDLIST/full duration without
      // waiting for the lower encode, and neither process re-encodes audio
      // needlessly for the other quality.
      session.masterInput = 'remux_master.m3u8';
      const lowerIndex = 1 + sourceAudio.length;
      const lowerRung = ladder[1] || null;
      const lowerHeight = lowerRung ? lowerRung.height : 0;
      const lowerWidth = lowerRung && Number(videoStream.width) > 0 && Number(videoStream.height) > 0
        ? Math.max(2, Math.round((Number(videoStream.width) * lowerHeight / Number(videoStream.height)) / 2) * 2)
        : 0;
      session.remux = lowerRung ? {
        lowerIndex,
        lowerWidth,
        lowerHeight,
        lowerBitrate: lowerRung.bitrate
      } : null;

      const topArgs = makeInputArgs();
      topArgs.push('-map', `0:${videoStream.index}`, '-c:v', 'copy');
      sourceAudio.forEach((stream) => topArgs.push('-map', `0:${stream.index}`));
      addAudioArgs(topArgs);
      addHlsArgs(topArgs, 'remux_master.m3u8');
      topArgs.push('-hls_segment_filename', path.join(session.dir, 'segment_%v_%05d.ts'));
      const topMap = [sourceAudio.length > 0 ? 'v:0,agroup:aud' : 'v:0'];
      sourceAudio.forEach((_, index) => topMap.push(`a:${index},agroup:aud`));
      topArgs.push('-var_stream_map', topMap.join(' '), path.join(session.dir, 'variant_%v.m3u8'));
      launch(topArgs, 'source-remux');

      if (lowerRung) {
        const lowerArgs = makeInputArgs();
        lowerArgs.push('-map', `0:${videoStream.index}`, '-an');
        addEncodeArgs(lowerArgs, lowerRung);
        addHlsArgs(lowerArgs);
        lowerArgs.push(
          '-hls_segment_filename', path.join(session.dir, `segment_${lowerIndex}_%05d.ts`),
          path.join(session.dir, `variant_${lowerIndex}.m3u8`)
        );
        launch(lowerArgs, 'lower-rung-encode');
      }
    } else {
      session.masterInput = 'master.m3u8';
      session.remux = null;
      const args = makeInputArgs();
      ladder.forEach(() => args.push('-map', `0:${videoStream.index}`));
      sourceAudio.forEach((stream) => args.push('-map', `0:${stream.index}`));
      ladder.forEach((rung, index) => addEncodeArgs(args, rung, index));
      addAudioArgs(args);
      addHlsArgs(args, 'master.m3u8');
      args.push('-hls_segment_filename', path.join(session.dir, 'segment_%v_%05d.ts'));
      const variantMap = [];
      ladder.forEach((_, index) => {
        variantMap.push(sourceAudio.length > 0 ? `v:${index},agroup:aud` : `v:${index}`);
      });
      sourceAudio.forEach((_, index) => variantMap.push(`a:${index},agroup:aud`));
      if (variantMap.length > 0) args.push('-var_stream_map', variantMap.join(' '));
      args.push(path.join(session.dir, 'variant_%v.m3u8'));
      launch(args, 'hls-encode');
    }

    console.log(
      `[mkv-hls] ${session.id}: ${canRemuxTop ? 'remux-first ' : ''}` +
      `${ladder.map((rung) => rung.height ? `${rung.height}p` : 'source').join('/')}` +
      ` with ${sourceAudio.length} audio track(s)`
    );
    const expectedCount = canRemuxTop
      ? 1 + sourceAudio.length + (ladder[1] ? 1 : 0)
      : ladder.length + sourceAudio.length;
    // Compatible remuxing is fast and produces the real, fully seekable
    // source timeline. Wait for that actual VOD completion only — never for a
    // fixed buffer amount and never for the independent lower-rung encode.
    await waitForPlaylists(session, expectedCount, readyTimeout, canRemuxTop);
    session.ready = true;
  }

  async function buildSessionMaster(session) {
    const manifest = await fs.promises.readFile(path.join(session.dir, session.masterInput || 'master.m3u8'), 'utf8');
    const patched = patchMkvHlsMaster(manifest, session.audioTracks);
    const sourceLines = patched.split(/\r?\n/);
    const lines = [];
    let audioGroup = '';
    for (let index = 0; index < sourceLines.length; index += 1) {
      const line = sourceLines[index];
      if (/^#EXT-X-MEDIA:/i.test(line)) {
        const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
        if (attrs.TYPE === 'AUDIO' && attrs['GROUP-ID']) audioGroup = attrs['GROUP-ID'];
      }
      // This bundled ffmpeg can omit copied video from its master. Rebuild all
      // video declarations from ffprobe instead of trusting incomplete output.
      if (/^#EXT-X-STREAM-INF:/i.test(line)) {
        if (sourceLines[index + 1] && !sourceLines[index + 1].startsWith('#')) index += 1;
        continue;
      }
      if (line) lines.push(line);
    }

    const lower = session.remux;
    const lowerBandwidth = lower ? lower.lowerBitrate * 1000 + session.audioTracks.length * 128000 : 0;
    const sourceBandwidth = Number(session.sourceBandwidth) || 0;
    const topBandwidth = Math.max(2500000, sourceBandwidth + session.audioTracks.length * 128000, lowerBandwidth + 1);
    const topFields = [`BANDWIDTH=${topBandwidth}`];
    if (session.sourceWidth > 0 && session.sourceHeight > 0) {
      topFields.push(`RESOLUTION=${session.sourceWidth}x${session.sourceHeight}`);
    }
    if (audioGroup) topFields.push(`AUDIO=${quoteAttribute(audioGroup)}`);
    lines.push(`#EXT-X-STREAM-INF:${topFields.join(',')}`, 'variant_0.m3u8');

    if (lower) {
      const lowerFields = [`BANDWIDTH=${Math.max(1, lowerBandwidth)}`];
      if (lower.lowerWidth > 0 && lower.lowerHeight > 0) {
        lowerFields.push(`RESOLUTION=${lower.lowerWidth}x${lower.lowerHeight}`);
      }
      if (audioGroup) lowerFields.push(`AUDIO=${quoteAttribute(audioGroup)}`);
      lines.push(`#EXT-X-STREAM-INF:${lowerFields.join(',')}`, `variant_${lower.lowerIndex}.m3u8`);
    }
    return `${lines.join('\n')}\n`;
  }

  async function ensureSession(publicSource, inputUrl) {
    const id = crypto.createHash('sha256').update(conversionIdentity(publicSource)).digest('hex').slice(0, 32);
    const existing = sessions.get(id);
    if (existing && existing.status !== 'failed' && existing.status !== 'closed') {
      existing.lastAccess = Date.now();
      return existing;
    }
    if (existing) await stopSession(existing);
    await makeRoom();
    const session = {
      id,
      dir: path.join(rootDir, id),
      publicSource,
      inputUrl,
      status: 'starting',
      ready: false,
      log: '',
      audioTracks: [],
      ladder: [],
      child: null,
      children: [],
      probeChild: null,
      masterInput: 'master.m3u8',
      remux: null,
      cleanup: null,
      lastAccess: Date.now(),
      readyPromise: null
    };
    sessions.set(id, session);
    session.readyPromise = startSession(session).catch((error) => {
      if (session.status !== 'closed') session.status = 'failed';
      const detail = redactLog(error && error.message, [inputUrl, publicSource]);
      console.error(`[mkv-hls] ${id}: ${detail || 'conversion failed'}`);
      throw new Error(detail || 'Conversion failed');
    });
    return session;
  }

  function localInputForSource(req, rawSource) {
    const source = String(rawSource || '').trim();
    if (!source || source.length > 32768) throw new Error('A proxy source URL is required');
    const relative = source.startsWith('/');
    const parsed = new URL(source, 'http://local.invalid');
    if (parsed.pathname !== '/api/proxy' || !parsed.searchParams.get('url')) {
      throw new Error('Only the player same-origin /api/proxy source can be converted');
    }
    if (!relative) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported source protocol');
      const hosts = [req.headers.host, String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()]
        .filter(Boolean)
        .map((host) => String(host).toLowerCase());
      if (!hosts.includes(parsed.host.toLowerCase())) {
        throw new Error('The proxy source must belong to this player host');
      }
    }
    return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
  }

  function send(res, status, body, headers = {}) {
    res.statusCode = status;
    Object.entries({
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }).forEach(([key, value]) => res.setHeader(key, value));
    if (body == null) {
      res.end();
      return;
    }
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.setHeader('Content-Length', payload.length);
    res.end(payload);
  }

  function sendJson(res, status, value, headers = {}) {
    send(res, status, JSON.stringify(value), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    });
  }

  async function awaitReady(session) {
    if (session.ready || session.status === 'done') return;
    await session.readyPromise;
  }

  async function serveMedia(req, res, session, filename) {
    session.lastAccess = Date.now();
    if (filename === 'master.m3u8') {
      try {
        await awaitReady(session);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: 'HLS conversion failed', detail: error.message });
        return;
      }
    }
    if (filename === 'master.m3u8' && session.masterInput === 'remux_master.m3u8') {
      try {
        const text = await buildSessionMaster(session);
        send(res, 200, text, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store'
        });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: 'HLS master is not ready', detail: error.message });
      }
      return;
    }
    const filePath = path.join(session.dir, filename);
    if (filename.endsWith('.m3u8')) {
      let text;
      try {
        text = await fs.promises.readFile(filePath, 'utf8');
      } catch (_) {
        if (session.status === 'failed' || session.status === 'closed') {
          sendJson(res, 502, { ok: false, error: 'HLS conversion stopped', detail: redactLog(session.log, [session.inputUrl, session.publicSource]) });
        } else {
          sendJson(res, 503, { ok: false, error: 'HLS playlist is not ready yet' }, { 'Retry-After': '1' });
        }
        return;
      }
      if (filename === 'master.m3u8') text = patchMkvHlsMaster(text, session.audioTracks);
      send(res, 200, text, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return;
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (_) {
      sendJson(res, 404, { ok: false, error: 'HLS segment not found' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://local.invalid');
    } catch (_) {
      return false;
    }
    if (url.pathname !== ROUTE && !url.pathname.startsWith(`${ROUTE}/`)) return false;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    if (req.method === 'OPTIONS') {
      send(res, 204, null, { 'Cache-Control': 'no-store' });
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    if (!enabled) {
      sendJson(res, 404, { ok: false, error: 'HLS conversion is not enabled on this host' });
      return true;
    }

    if (url.pathname === ROUTE) {
      let publicSource;
      let inputUrl;
      try {
        publicSource = url.searchParams.get('src') || '';
        inputUrl = localInputForSource(req, publicSource);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
        return true;
      }
      try {
        const session = await ensureSession(publicSource, inputUrl);
        await awaitReady(session);
        session.lastAccess = Date.now();
        send(res, 302, null, {
          Location: `${ROUTE}/${session.id}/master.m3u8`,
          'Cache-Control': 'no-store'
        });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: 'HLS conversion failed', detail: error.message });
      }
      return true;
    }

    const match = url.pathname.match(/^\/api\/mkv-hls\/([a-f0-9]{32})\/([^/]+)$/);
    if (!match || !SESSION_ID.test(match[1]) || !MEDIA_FILE.test(match[2])) {
      sendJson(res, 404, { ok: false, error: 'Unknown HLS resource' });
      return true;
    }
    const session = sessions.get(match[1]);
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'HLS conversion session expired; retry the source' });
      return true;
    }
    await serveMedia(req, res, session, match[2]);
    return true;
  }

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    [...sessions.values()].forEach((session) => {
      if (session.lastAccess < cutoff) stopSession(session);
    });
  }, 10 * 60 * 1000);
  sweeper.unref();

  return {
    handle,
    close() {
      clearInterval(sweeper);
      return Promise.all([...sessions.values()].map(stopSession));
    },
    _sessions: sessions
  };
}

module.exports = {
  ROUTE,
  buildMkvHlsLadder,
  patchMkvHlsMaster,
  createMkvHlsHandler
};
