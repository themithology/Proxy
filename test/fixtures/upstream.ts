import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the real upstream CDNs.
 *
 * It serves structurally genuine HLS (master + media + AES key + fMP4 init),
 * DASH, subtitles and an embed page that hides its media URL — everything the
 * proxy has to cope with in production. Used by the integration tests.
 */

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
  /** Bytes we served, keyed by path — tests compare proxied output to these. */
  bytes(path: string): Buffer;
  requests: Array<{ url: string; headers: Record<string, string> }>;
}

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl; charset=utf-8',
  '.mpd': 'application/dash+xml; charset=utf-8',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.bin': 'application/octet-stream',
  '.key': 'application/octet-stream',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Deterministic, non-trivial payload so byte-fidelity can be asserted. */
function payload(seed: string, size: number): Buffer {
  const b = Buffer.alloc(size);
  let h = 2166136261;
  for (let i = 0; i < size; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619);
    b[i] = (h >>> 24) & 0xff;
  }
  return b;
}

const SEG_A = payload('segment-a', 4096);
const SEG_B = payload('segment-b', 4096);
const INIT = payload('init-mp4', 512);
const KEY = payload('aes-key-16', 16);

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,URI="subs/hi.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac",SUBTITLES="subs",FRAME-RATE=23.976
1080/index.m3u8
`;

const MEDIA_1080 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x9c7db8778570d05c317273c3f7e0e5b2
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg0.ts
#EXTINF:6.000,
seg1.ts
#EXT-X-ENDLIST
`;

const MEDIA_480 = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.000,
seg0.ts
#EXTINF:6.000,
seg1.ts
#EXT-X-ENDLIST
`;

const AUDIO_MEDIA = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
../audio-seg0.ts
#EXT-X-ENDLIST
`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello from the fixture.

2
00:00:05,500 --> 00:00:08,250
Second line,
with a break.
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Already WebVTT.
`;

const ASS = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello from ASS{\\i1}italic{\\i0}
`;

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2M0.000S">
  <Period id="0" duration="PT2M0.000S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="v0" bandwidth="1200000" width="854" height="480" codecs="avc1.4d401f">
        <BaseURL>480/</BaseURL>
        <SegmentTemplate timescale="90000" media="seg-$Number$.m4s" initialization="init-$Bandwidth$.mp4" startNumber="1" duration="540000"/>
      </Representation>
      <Representation id="v1" bandwidth="5200000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>1080/</BaseURL>
        <SegmentTemplate timescale="90000" media="seg-$Number$.m4s" initialization="init-$Bandwidth$.mp4" startNumber="1" duration="540000"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
      <Representation id="t0" bandwidth="1000">
        <BaseURL>subs/en.vtt</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;

/** An "embed" page: hides the media URL inside a nested iframe. */
const EMBED_PAGE = `<!doctype html>
<html><body>
<h1>Fake embed host</h1>
<iframe src="/frame.html" width="100%" height="100%"></iframe>
<script>var analytics = { pixel: "/pixel.png" };</script>
</body></html>
`;

const FRAME_PAGE = `<!doctype html>
<html><body>
<script>
  var player = { file: "${'\\/'}1080${'\\/'}index.m3u8", sources: [{src: "https://cdn.invalid/preview.mp4"}] };
</script>
</body></html>
`;

const B64_PAGE = `<!doctype html>
<html><body>
<script>var u = atob("${Buffer.from('https://cdn.example.com/hls/master.m3u8').toString('base64')}");</script>
</body></html>
`;

export async function startFixture(): Promise<FixtureServer> {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];

  const routes: Record<string, { body: Buffer | string; type: string }> = {
    '/master.m3u8': { body: MASTER, type: TYPES['.m3u8']! },
    '/1080/index.m3u8': { body: MEDIA_1080, type: TYPES['.m3u8']! },
    '/480/index.m3u8': { body: MEDIA_480, type: TYPES['.m3u8']! },
    '/audio/en/index.m3u8': { body: AUDIO_MEDIA, type: TYPES['.m3u8']! },
    '/1080/seg0.ts': { body: SEG_A, type: TYPES['.ts']! },
    '/1080/seg1.ts': { body: SEG_B, type: TYPES['.ts']! },
    '/480/seg0.ts': { body: SEG_A, type: TYPES['.ts']! },
    '/480/seg1.ts': { body: SEG_B, type: TYPES['.ts']! },
    '/audio-seg0.ts': { body: SEG_A, type: TYPES['.ts']! },
    '/1080/init.mp4': { body: INIT, type: TYPES['.mp4']! },
    '/key.bin': { body: KEY, type: TYPES['.bin']! },
    '/subs/en.m3u8': {
      body: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n../subs/en.vtt\n#EXT-X-ENDLIST\n`,
      type: TYPES['.m3u8']!,
    },
    '/subs/hi.m3u8': {
      body: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\n../subs/hi.srt\n#EXT-X-ENDLIST\n`,
      type: TYPES['.m3u8']!,
    },
    '/subs/en.vtt': { body: VTT, type: TYPES['.vtt']! },
    '/subs/hi.srt': { body: SRT, type: TYPES['.srt']! },
    '/subs/hi.ass': { body: ASS, type: TYPES['.srt']! },
    '/dash/manifest.mpd': { body: MPD, type: TYPES['.mpd']! },
    // DASH segments live under /dash/ because the MPD sits at /dash/manifest.mpd
    // and each Representation declares a relative BaseURL of "1080/".
    '/dash/1080/seg-1.m4s': { body: SEG_A, type: TYPES['.m4s']! },
    '/dash/1080/seg-2.m4s': { body: SEG_B, type: TYPES['.m4s']! },
    '/dash/480/seg-1.m4s': { body: SEG_A, type: TYPES['.m4s']! },
    '/dash/1080/init-5200000.mp4': { body: INIT, type: TYPES['.mp4']! },
    '/dash/480/init-1200000.mp4': { body: INIT, type: TYPES['.mp4']! },
    '/embed.html': { body: EMBED_PAGE, type: TYPES['.html']! },
    '/frame.html': { body: FRAME_PAGE, type: TYPES['.html']! },
    '/b64.html': { body: B64_PAGE, type: TYPES['.html']! },
    '/movie.mp4': { body: SEG_A, type: TYPES['.mp4']! },
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';
    requests.push({ url, headers: req.headers as Record<string, string> });

    // Range support, so seeking can be tested end to end.
    const route = routes[url.split('?')[0]!];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body, 'utf8');
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': route.type,
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'accept-ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
    }

    res.writeHead(200, {
      'content-type': route.type,
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
    });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    bytes: (p: string) => {
      const r = routes[p];
      if (!r) throw new Error(`unknown fixture path ${p}`);
      return Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body, 'utf8');
    },
    requests,
  };
}
