import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVtt, detectFormat, decodeText, languageLabel } from '../../src/stream/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world.

2
00:00:05,500 --> 00:00:08,250
Second line
with a break.
`;

const ASS = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello {\\i1}ASS{\\i0} world
Dialogue: 0,0:00:10.50,0:00:12.00,Default,,0,0,0,,Bye\\Nnext line
`;

const TTML = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div>
    <p begin="00:00:01.000" end="00:00:04.000">Hello TTML</p>
    <p begin="10.5s" end="12.5s">Metric timing</p>
  </div></body>
</tt>`;

test('detectFormat identifies each format', () => {
  assert.equal(detectFormat('WEBVTT\n\n00:00 --> 00:01\nx'), 'vtt');
  assert.equal(detectFormat(SRT), 'srt');
  assert.equal(detectFormat(ASS), 'ass');
  assert.equal(detectFormat(TTML), 'ttml');
  assert.equal(detectFormat('whatever', 'https://x/a.vtt'), 'vtt');
  assert.equal(detectFormat('whatever', 'https://x/a.srt'), 'srt');
});

test('SRT converts to valid WebVTT', () => {
  const vtt = toVtt(SRT, 'srt');
  assert.ok(vtt.startsWith('WEBVTT'), 'must start with the WEBVTT header');
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.000'));
  assert.ok(vtt.includes('00:00:05.500 --> 00:00:08.250'));
  assert.ok(vtt.includes('Hello world.'));
  // Comma-separated SRT timestamps must become dot-separated VTT timestamps.
  assert.ok(!/-->/.test(vtt.split('\n').filter((l) => l.includes('-->'))
    .map((l) => l.replace(/ --> /g, '')).join('')), 'no stray arrows');
  assert.ok(!/\d{2}:\d{2}:\d{2},\d{3}/.test(vtt), 'no SRT-style commas remain');
});

test('ASS converts to WebVTT and strips override blocks', () => {
  const vtt = toVtt(ASS, 'ass');
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.000'));
  assert.ok(vtt.includes('Hello ASS world'), `got: ${vtt}`);
  assert.ok(!vtt.includes('{\\i1}'), 'override blocks removed');
  assert.ok(vtt.includes('Bye\nnext line'), '\\N becomes a real newline');
});

test('TTML converts to WebVTT, including metric timing', () => {
  const vtt = toVtt(TTML, 'ttml');
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.000'));
  assert.ok(vtt.includes('Hello TTML'));
  assert.ok(vtt.includes('00:00:10.500 --> 00:00:12.500'), '10.5s → clock time');
});

test('WebVTT passes through unchanged and gets a header', () => {
  const input = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi';
  assert.equal(toVtt(input, 'vtt'), input);

  const bare = '00:00:01.000 --> 00:00:02.000\nHi';
  assert.ok(toVtt(bare, 'vtt').startsWith('WEBVTT'));
});

test('decodeText falls back to latin1 when utf-8 is invalid', () => {
  // 0xE9 is é in latin-1 but an invalid lone continuation-ish byte in utf-8.
  const buf = Buffer.from([0x43, 0x61, 0x66, 0xe9]);
  const out = decodeText(buf);
  assert.equal(out.length, 4);
  assert.ok(out.startsWith('Caf'));
});

test('languageLabel maps codes to names', () => {
  assert.equal(languageLabel('hi'), 'Hindi');
  assert.equal(languageLabel('ta'), 'Tamil');
  assert.equal(languageLabel('zz'), 'ZZ');
  assert.equal(languageLabel(undefined), 'Unknown');
});
