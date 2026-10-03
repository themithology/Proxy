import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMpd, rewriteMpd } from '../../src/stream/mpd.js';

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1H30M0.000S">
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="v0" bandwidth="1200000" width="854" height="480" codecs="avc1.4d401f">
        <BaseURL>480/</BaseURL>
        <SegmentTemplate timescale="90000" media="seg-$Number$.m4s" initialization="init-$Bandwidth$.mp4" startNumber="1" duration="540000"/>
      </Representation>
      <Representation id="v1" bandwidth="5200000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>1080/</BaseURL>
        <SegmentList duration="6">
          <SegmentURL media="seg-1.m4s"/>
          <SegmentURL media="seg-2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="hi">
      <Representation id="t0" bandwidth="1000">
        <BaseURL>subs/hi.vtt</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('parseMpd extracts representations and duration', () => {
  const p = parseMpd(MPD, 'https://cdn.test/dash/manifest.mpd');
  assert.equal(p.representations.length, 3);
  assert.equal(p.durationSeconds, 5400);
  assert.equal(p.isLive, false);
  assert.equal(p.subtitleReps.length, 1);
  assert.equal(p.subtitleReps[0]!.lang, 'hi');

  const hd = p.representations.find((r) => r.height === 1080);
  assert.ok(hd);
  assert.equal(hd!.bandwidth, 5200000);
  assert.equal(hd!.baseUrl, 'https://cdn.test/dash/1080/');
});

test('rewriteMpd rewrites BaseURL, SegmentTemplate and SegmentURL', () => {
  const seen: string[] = [];
  const out = rewriteMpd(MPD, 'https://cdn.test/dash/manifest.mpd', (u, ctx) => {
    seen.push(`${ctx}:${u}`);
    return `https://proxy.test/x?u=${encodeURIComponent(u)}`;
  });

  assert.ok(out.includes('https://cdn.test/dash/480/') === false, 'BaseURL replaced');
  assert.ok(out.includes('https://proxy.test/x?u='), 'proxy URLs injected');
  assert.ok(out.includes('480/') === false, 'raw BaseURL must not survive');

  // SegmentTemplate placeholders must be preserved through rewriting.
  assert.ok(
    seen.some((s) => s.startsWith('template:') && s.includes('$Number$')),
    `expected a template rewrite, got ${JSON.stringify(seen)}`,
  );
  assert.ok(seen.some((s) => s.startsWith('init:') && s.includes('$Bandwidth$')));
  assert.ok(seen.some((s) => s.includes('seg-1.m4s')));
  assert.ok(seen.some((s) => s.includes('subs/hi.vtt')));
});

test('rewriteMpd returns the input unchanged when it is not XML', () => {
  const junk = '#EXTM3U\nnot xml at all';
  assert.equal(rewriteMpd(junk, 'https://cdn.test/a', () => 'X'), junk);
});

test('rewritten MPD is still well-formed XML', () => {
  const out = rewriteMpd(MPD, 'https://cdn.test/dash/manifest.mpd', (u) =>
    `https://proxy.test/x?u=${encodeURIComponent(u)}`,
  );
  assert.ok(out.includes('<MPD'), 'root element survives');
  assert.ok(out.includes('urn:mpeg:dash:schema:mpd:2011'), 'namespace survives');
  assert.ok(out.includes('</MPD>'), 'document closes');
  assert.ok(!out.includes('&lt;'), 'no double-escaping');
});
