'use strict';

/**
 * Real (but fully local) ffmpeg integration test. Generates a tiny multi-audio
 * MKV, serves it through the same /api/proxy URL shape used by the player, and
 * verifies the resulting HLS variants, audio renditions, codecs and segments.
 * No public provider, network CDN, or test video download is involved.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { createMkvHlsHandler, buildMkvHlsLadder, patchMkvHlsMaster } = require('../src/services/mkvHls');
const { parseHlsAudioTracks } = require('../src/services/hls');

function runFile(binary, args, options = {}) {
  return execFileSync(binary, args, { timeout: 60000, ...options });
}

function videoPlaylistUris(manifest) {
  const lines = manifest.split(/\r?\n/);
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

function segmentUris(playlist) {
  return playlist.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

async function runMkvHlsTest() {
  assert.deepStrictEqual(buildMkvHlsLadder(1080).map((rung) => rung.height), [1080, 720, 480]);
  assert.deepStrictEqual(buildMkvHlsLadder(720).map((rung) => rung.height), [720, 480]);
  assert.deepStrictEqual(buildMkvHlsLadder(2160).map((rung) => rung.height), [1080, 720, 480]);
  assert.deepStrictEqual(buildMkvHlsLadder(900).map((rung) => rung.height), [900, 720, 480]);

  const patched = patchMkvHlsMaster(
    '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_0",DEFAULT=YES,URI="variant_2.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=105600,CODECS="mp4a.40.2",AUDIO="group_aud"\n' +
    'variant_2.m3u8\n',
    [{ lang: 'eng', label: 'English' }]
  );
  assert(patched.includes('NAME="English",LANGUAGE="eng",DEFAULT=YES'));
  assert(!patched.includes('#EXT-X-STREAM-INF:'), 'audio-only output must not become a quality row');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-mkv-hls-test-'));
  const inputPath = path.join(tempDir, 'input.mkv');
  let server = null;
  let handler = null;

  try {
    runFile(ffmpegInstaller.path, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '6',
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata:s:a:0', 'language=eng',
      '-metadata:s:a:1', 'language=hin',
      inputPath
    ]);

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
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
            if (start > end || start >= stat.size) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
              return;
            }
            res.writeHead(206, {
              'Content-Type': 'video/x-matroska',
              'Content-Length': end - start + 1,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(inputPath, { start, end }).pipe(res);
          } else {
            res.writeHead(200, {
              'Content-Type': 'video/x-matroska',
              'Content-Length': stat.size,
              'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(inputPath).pipe(res);
          }
          return;
        }
        if (handler && await handler.handle(req, res)) return;
        res.writeHead(404).end('Not found');
      } catch (error) {
        res.writeHead(400).end(error.message);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    handler = createMkvHlsHandler({
      enabled: true,
      port,
      rootDir: path.join(tempDir, 'hls-sessions')
    });

    const mediaUrl = `http://127.0.0.1:${port}/input.mkv`;
    const proxyUrl = `http://127.0.0.1:${port}/api/proxy?url=${encodeURIComponent(mediaUrl)}`;
    const conversionUrl = `http://127.0.0.1:${port}/api/mkv-hls?src=${encodeURIComponent(proxyUrl)}`;
    const redirect = await fetch(conversionUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60000)
    });
    assert.strictEqual(redirect.status, 302, 'conversion should redirect to a session master playlist');
    const masterPath = redirect.headers.get('location');
    assert.match(masterPath || '', /^\/api\/mkv-hls\/[a-f0-9]{32}\/master\.m3u8$/);

    const masterUrl = `http://127.0.0.1:${port}${masterPath}`;
    const masterResponse = await fetch(masterUrl);
    assert.strictEqual(masterResponse.status, 200);
    const master = await masterResponse.text();
    const audioTracks = parseHlsAudioTracks(master);
    assert.deepStrictEqual(audioTracks.map((track) => track.lang), ['eng', 'hin']);
    assert.strictEqual(audioTracks.filter((track) => track.default).length, 1, 'exactly one default audio rendition');

    const variants = videoPlaylistUris(master);
    assert.strictEqual(variants.length, 2, '720p MKV should produce exactly two video variants');
    assert(master.includes('RESOLUTION=1280x720'));
    assert(master.includes('RESOLUTION=854x480'));
    assert(!master.includes('RESOLUTION=1920x1080'), 'must never invent a 1080p rendition');
    assert(!/CODECS="mp4a[^\"]*",AUDIO=/.test(master), 'audio-only outputs must not be video variants');

    const playlistPaths = [...variants, ...audioTracks.map((track) => track.url)];
    const playlists = await Promise.all(playlistPaths.map(async (uri) => {
      const response = await fetch(new URL(uri, masterUrl));
      assert.strictEqual(response.status, 200, `${uri} should be readable`);
      const text = await response.text();
      assert(text.includes('#EXTINF'), `${uri} should reference real media`);
      return text;
    }));

    const session = [...handler._sessions.values()][0];
    assert(session, 'conversion session should remain available for seeking');
    const deadline = Date.now() + 30000;
    while (session.status !== 'done' && Date.now() < deadline) {
      assert.notStrictEqual(session.status, 'failed', `ffmpeg failed: ${session.log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(session.status, 'done', 'short fixture conversion should complete');

    const finishedPlaylist = await (await fetch(new URL(variants[0], masterUrl))).text();
    assert(finishedPlaylist.includes('#EXT-X-ENDLIST'), 'completed HLS must be seekable VOD, not an endless live tail');
    assert.match(finishedPlaylist, /#EXT-X-TARGETDURATION:2/, 'short segments should minimize startup wait');
    assert(segmentUris(finishedPlaylist).length >= 2, 'completed playlist should expose all temporal segments');

    const mediaBuffers = [];
    for (let index = 0; index < playlists.length; index += 1) {
      const firstSegment = segmentUris(playlists[index])[0];
      assert(firstSegment, 'playlist should contain a segment URI');
      const response = await fetch(new URL(firstSegment, new URL(playlistPaths[index], masterUrl)));
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /mp2t/);
      const buffer = Buffer.from(await response.arrayBuffer());
      assert(buffer.length > 500, 'segment should contain actual media bytes');
      mediaBuffers.push(buffer);
    }
    assert(!mediaBuffers[0].equals(mediaBuffers[1]), '720p and 480p must be genuinely different encodes');

    const videoSegmentPath = path.join(tempDir, 'video.ts');
    const audioSegmentPath = path.join(tempDir, 'audio.ts');
    fs.writeFileSync(videoSegmentPath, mediaBuffers[0]);
    fs.writeFileSync(audioSegmentPath, mediaBuffers[2]);
    // The legacy ffprobe binary used for MKV metadata segfaults on TS in this
    // environment. Decode with ffmpeg instead: this verifies both codec and
    // actual readability rather than trusting a CODECS playlist label.
    const decodeInfo = (file) => {
      const result = spawnSync(ffmpegInstaller.path, [
        '-hide_banner', '-i', file, '-f', 'null', '-'
      ], { encoding: 'utf8', timeout: 60000 });
      assert.strictEqual(result.status, 0, `generated segment must decode: ${result.stderr}`);
      return result.stderr;
    };
    const videoInfo = decodeInfo(videoSegmentPath);
    const audioInfo = decodeInfo(audioSegmentPath);
    assert.match(videoInfo, /Video: h264/);
    assert.match(videoInfo, /1280x720/);
    assert.match(audioInfo, /Audio: aac/);

    const rejectedRemote = await fetch(
      `http://127.0.0.1:${port}/api/mkv-hls?src=${encodeURIComponent('https://example.com/api/proxy?url=https%3A%2F%2Fexample.com%2Ffile.mkv')}`
    );
    assert.strictEqual(rejectedRemote.status, 400, 'must not become an arbitrary remote transcoding endpoint');

    const sessionDir = session.dir;
    await handler.close();
    handler = null;
    assert(!fs.existsSync(sessionDir), 'closing the host must remove generated media');

    console.log('  ✔ Real MKV→HLS route: 720p/480p H.264, dual AAC audio, VOD segments and host guard passed.');
  } finally {
    if (handler) await handler.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runMkvHlsTest().then(() => {
    console.log('MKV HLS integration test passed.');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = runMkvHlsTest;
