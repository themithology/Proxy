import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttributes,
  setAttribute,
  getAttribute,
  parseM3u8,
  rewriteM3u8,
  pickVariant,
} from '../../src/stream/m3u8.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,URI="subs/hi.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
1080/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x9c7db877
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg0.ts
#EXT-X-BYTERANGE:1024@0
seg1.ts
#EXT-X-ENDLIST
`;

test('parseAttributes handles commas inside quoted values', () => {
  const a = parseAttributes(
    '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  );
  assert.equal(a.BANDWIDTH, '5200000');
  assert.equal(a.RESOLUTION, '1920x1080');
  assert.equal(a.CODECS, 'avc1.640028,mp4a.40.2');
});

test('setAttribute replaces only the named attribute', () => {
  const line = '#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0xabc';
  const out = setAttribute(line, 'URI', 'https://proxy/key?token=t');
  assert.equal(getAttribute(out, 'URI'), 'https://proxy/key?token=t');
  assert.equal(getAttribute(out, 'METHOD'), 'AES-128');
  assert.equal(getAttribute(out, 'IV'), '0xabc');
});

test('setAttribute appends when the attribute is absent', () => {
  const out = setAttribute('#EXT-X-MAP:BYTERANGE="0@0"', 'URI', 'https://p/i.mp4');
  assert.equal(getAttribute(out, 'URI'), 'https://p/i.mp4');
  assert.equal(getAttribute(out, 'BYTERANGE'), '0@0');
});

test('master playlist: parses variants and renditions', () => {
  const p = parseM3u8(MASTER, 'https://cdn.test/hls/master.m3u8');
  assert.equal(p.isMaster, true);
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0]!.height, 480);
  assert.equal(p.variants[1]!.height, 1080);
  assert.equal(p.variants[1]!.bandwidth, 5200000);
  assert.equal(p.variants[1]!.uri, 'https://cdn.test/hls/1080/index.m3u8');
  assert.equal(p.renditions.length, 2);
  assert.equal(p.subtitlePlaylists.length, 1);
  assert.equal(p.subtitlePlaylists[0]!.language, 'hi');
});

test('media playlist: parses segments, key, map and endlist', () => {
  const p = parseM3u8(MEDIA, 'https://cdn.test/hls/1080/index.m3u8');
  assert.equal(p.isMaster, false);
  assert.equal(p.endlist, true);
  assert.equal(p.encrypted, true);
  assert.equal(p.usesFmp4, true);
  assert.equal(p.targetDuration, 6);
  assert.deepEqual(p.keyUris, ['https://cdn.test/hls/key.bin']);
  assert.deepEqual(p.segmentUris, [
    'https://cdn.test/hls/1080/seg0.ts',
    'https://cdn.test/hls/1080/seg1.ts',
  ]);
});

test('rewrite: every URI is replaced, non-URI lines untouched', () => {
  const seen: Array<[string, string]> = [];
  const out = rewriteM3u8(MEDIA, 'https://cdn.test/hls/1080/index.m3u8', (u, ctx) => {
    seen.push([u, ctx]);
    return `https://proxy.test/x?u=${encodeURIComponent(u)}`;
  });

  // Relative and parent-relative URIs resolved, then rewritten.
  assert.deepEqual(seen.map((s) => s[0]), [
    'https://cdn.test/hls/key.bin',
    'https://cdn.test/hls/1080/init.mp4',
    'https://cdn.test/hls/1080/seg0.ts',
    'https://cdn.test/hls/1080/seg1.ts',
  ]);
  assert.deepEqual(seen.map((s) => s[1]), ['key', 'map', 'segment', 'segment']);

  assert.ok(out.includes('#EXTINF:6.000,'));
  assert.ok(out.includes('#EXT-X-BYTERANGE:1024@0'));
  assert.ok(out.includes('#EXT-X-ENDLIST'));

  // No line may remain a bare upstream URI.
  const uriLines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(uriLines.length > 0, 'expected rewritten URI lines');
  for (const l of uriLines) {
    assert.ok(l.startsWith('https://proxy.test/'), `unrewritten URI line: ${l}`);
    assert.ok(!/^seg\d\.ts$/.test(l), `bare segment URI survived: ${l}`);
  }
});

test('rewrite: master playlist variants and media renditions', () => {
  const seen: string[] = [];
  const out = rewriteM3u8(MASTER, 'https://cdn.test/hls/master.m3u8', (u, ctx) => {
    seen.push(ctx);
    return `P:${u}`;
  });

  assert.deepEqual(seen, ['media', 'subtitle', 'variant', 'variant']);
  assert.ok(out.includes('P:https://cdn.test/hls/480/index.m3u8'));
  assert.ok(out.includes('P:https://cdn.test/hls/1080/index.m3u8'));
  assert.ok(out.includes('URI="P:https://cdn.test/hls/subs/hi.m3u8"'));
});

test('rewrite: unknown tags pass through byte-for-byte', () => {
  const weird = '#EXTM3U\n#EXT-X-CUSTOM:FOO="bar",BAZ=1\n#EXT-X-DISCONTINUITY\nseg.ts\n';
  const out = rewriteM3u8(weird, 'https://c/a/b.m3u8', (u) => `P:${u}`);
  assert.ok(out.includes('#EXT-X-CUSTOM:FOO="bar",BAZ=1'));
  assert.ok(out.includes('#EXT-X-DISCONTINUITY'));
  assert.ok(out.includes('P:https://c/a/seg.ts'));
});

test('pickVariant selects the closest height', () => {
  const p = parseM3u8(MASTER, 'https://cdn.test/master.m3u8');
  assert.equal(pickVariant(p.variants, 1080)!.height, 1080);
  assert.equal(pickVariant(p.variants, 400)!.height, 480);
  assert.equal(pickVariant(p.variants)!.height, 1080); // highest bandwidth
});
