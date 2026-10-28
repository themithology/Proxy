'use strict';

/**
 * Local generation/delivery benchmark. Creates a real dual-audio source,
 * converts it through the production handler, then consumes the source-quality
 * HLS segments against a 3x playback clock. No public provider or test video
 * download is involved. Run with: npm run benchmark:hls
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { createMkvHlsHandler } = require('../src/services/mkvHls');

const SOURCE_SECONDS = Math.max(10, Math.min(300, Number(process.env.BENCHMARK_SECONDS) || 60));
const PLAYBACK_RATE = Math.max(1, Math.min(6, Number(process.env.BENCHMARK_RATE) || 3));
const BUFFER_CAP_SECONDS = 45;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function videoVariantUris(master) {
  const lines = master.split(/\r?\n/);
  const uris = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:') || !lines[index].includes('RESOLUTION=')) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor] || lines[cursor].startsWith('#')) continue;
      uris.push(lines[cursor]);
      break;
    }
  }
  return uris;
}

function playlistSegments(playlist) {
  const lines = playlist.split(/\r?\n/);
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#EXTINF:([0-9.]+)/);
    if (!match) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor] || lines[cursor].startsWith('#')) continue;
      segments.push({ duration: Number(match[1]), uri: lines[cursor] });
      break;
    }
  }
  return segments;
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-hls-3x-benchmark-'));
  const inputPath = path.join(tempDir, 'input.mkv');
  let server = null;
  let handler = null;

  try {
    execFileSync(ffmpegInstaller.path, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', String(SOURCE_SECONDS),
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-c:a', 'aac',
      '-metadata:s:a:0', 'language=eng',
      '-metadata:s:a:1', 'language=hin',
      inputPath
    ], { timeout: 120000 });

    let port = 0;
    server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url, 'http://local.invalid');
        if (requestUrl.pathname === '/api/proxy') {
          const target = new URL(requestUrl.searchParams.get('url') || '');
          if (target.origin !== `http://127.0.0.1:${port}` || target.pathname !== '/input.mkv') {
            res.writeHead(403).end('Forbidden');
            return;
          }
          const stat = fs.statSync(inputPath);
          const range = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
          if (start > end || start >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
            return;
          }
          res.writeHead(range ? 206 : 200, {
            'Content-Type': 'video/x-matroska',
            'Content-Length': end - start + 1,
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
            'Accept-Ranges': 'bytes'
          });
          fs.createReadStream(inputPath, { start, end }).pipe(res);
          return;
        }
        if (handler && await handler.handle(req, res)) return;
        res.writeHead(404).end('Not found');
      } catch (error) {
        res.writeHead(500).end(error.message);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    handler = createMkvHlsHandler({ enabled: true, port, rootDir: path.join(tempDir, 'hls') });

    const mediaUrl = `http://127.0.0.1:${port}/input.mkv`;
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy?url=${encodeURIComponent(mediaUrl)}`;
    const conversionUrl = `http://127.0.0.1:${port}/api/mkv-hls?src=${encodeURIComponent(proxyUrl)}`;
    const conversionStarted = Date.now();
    const redirect = await fetch(conversionUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(120000)
    });
    const startupMs = Date.now() - conversionStarted;
    assert.strictEqual(redirect.status, 302);
    const masterUrl = `http://127.0.0.1:${port}${redirect.headers.get('location')}`;
    const masterResponse = await fetch(masterUrl);
    assert.strictEqual(masterResponse.status, 200);
    const master = await masterResponse.text();
    const variants = videoVariantUris(master);
    assert.strictEqual(variants.length, 2, 'benchmark expects two genuine video rungs');

    const topPlaylistUrl = new URL(variants[0], masterUrl);
    let topPlaylist = '';
    let fullTimelineMs = null;
    const fullTimelineDeadline = Date.now() + 120000;
    while (Date.now() < fullTimelineDeadline) {
      const topPlaylistResponse = await fetch(topPlaylistUrl);
      assert.strictEqual(topPlaylistResponse.status, 200);
      topPlaylist = await topPlaylistResponse.text();
      if (topPlaylist.includes('#EXT-X-ENDLIST')) {
        fullTimelineMs = Date.now() - conversionStarted;
        break;
      }
      await sleep(100);
    }
    assert(fullTimelineMs !== null, 'source remux should complete its full timeline in background');
    const segments = playlistSegments(topPlaylist);
    const sourceDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    assert(segments.length > 1 && sourceDuration >= SOURCE_SECONDS * 0.9);

    const playbackStarted = Date.now();
    let downloadedSeconds = 0;
    let lateSegments = 0;
    let maximumBuffer = 0;
    let minimumBufferBeforeFinalSecond = Infinity;
    let totalSegmentDownloadMs = 0;

    for (const segment of segments) {
      // Match the player's 45-second capacity without downloading the whole
      // VOD instantly. The clock keeps running at 3x during every HTTP fetch.
      while (downloadedSeconds - ((Date.now() - playbackStarted) / 1000) * PLAYBACK_RATE > BUFFER_CAP_SECONDS) {
        await sleep(20);
      }
      const downloadStarted = Date.now();
      const response = await fetch(new URL(segment.uri, topPlaylistUrl));
      assert.strictEqual(response.status, 200);
      await response.arrayBuffer();
      totalSegmentDownloadMs += Date.now() - downloadStarted;
      downloadedSeconds += segment.duration;
      const playedSeconds = ((Date.now() - playbackStarted) / 1000) * PLAYBACK_RATE;
      const buffer = downloadedSeconds - playedSeconds;
      maximumBuffer = Math.max(maximumBuffer, buffer);
      if (playedSeconds < sourceDuration - 1) minimumBufferBeforeFinalSecond = Math.min(minimumBufferBeforeFinalSecond, buffer);
      if (buffer < 0) lateSegments += 1;
    }

    // Let the 3x clock reach the end so an early fast download cannot hide a
    // later underrun. Reaching zero at the final frame is normal, not a stall.
    while (((Date.now() - playbackStarted) / 1000) * PLAYBACK_RATE < sourceDuration) {
      const playedSeconds = ((Date.now() - playbackStarted) / 1000) * PLAYBACK_RATE;
      const buffer = downloadedSeconds - playedSeconds;
      if (playedSeconds < sourceDuration - 1) minimumBufferBeforeFinalSecond = Math.min(minimumBufferBeforeFinalSecond, buffer);
      await sleep(25);
    }

    const result = {
      passed: lateSegments === 0,
      logicalCpus: os.cpus().length,
      sourceSeconds: Number(sourceDuration.toFixed(3)),
      playbackRate: PLAYBACK_RATE,
      startupMs,
      fullTimelineMs,
      videoRungs: variants.length,
      audioRenditions: (master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length,
      segments: segments.length,
      wallSeconds: Number(((Date.now() - playbackStarted) / 1000).toFixed(3)),
      lateSegments,
      minimumBufferBeforeFinalSecondSeconds: Number((Number.isFinite(minimumBufferBeforeFinalSecond)
        ? minimumBufferBeforeFinalSecond
        : 0).toFixed(3)),
      maximumBufferSeconds: Number(maximumBuffer.toFixed(3)),
      averageSegmentDownloadMs: Number((totalSegmentDownloadMs / segments.length).toFixed(2))
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (handler) await handler.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
