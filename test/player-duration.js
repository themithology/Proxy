'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const playerSource = fs.readFileSync(path.join(root, 'public/js/embed.js'), 'utf8');
const playerHtml = fs.readFileSync(path.join(root, 'public/embed.html'), 'utf8');

assert.match(playerHtml, /id="time-duration"/, 'the bottom-bar duration element must exist');

function sourceBetween(start, end) {
  const startIndex = playerSource.indexOf(start);
  const endIndex = playerSource.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0 && endIndex > startIndex, `could not extract player source: ${start}`);
  return playerSource.slice(startIndex, endIndex);
}

function makeElement() {
  return {
    textContent: '',
    style: {},
    classList: { add() {}, remove() {} },
    getAttribute() { return null; },
    setAttribute() {}
  };
}

const timeDurationEl = makeElement();
const context = {
  isFinite,
  Math,
  Number,
  String,
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  video: { currentTime: 61, duration: 443, buffered: { length: 0 } },
  state: {
    activeHlsUrl: 'https://player.test/api/mkv-hls/0123456789abcdef0123456789abcdef/master.m3u8',
    attachedStreamUrl: 'https://player.test/api/mkv-hls/0123456789abcdef0123456789abcdef/master.m3u8',
    generatedSourceDuration: 0,
    hlsInstance: { latestLevelDetails: { live: true } },
    media: { durationSec: 8340 },
    isDraggingTimeline: false,
    upNextTarget: null,
    activeSkipSegment: null
  },
  timeCurrentEl: makeElement(),
  timeDurationEl,
  timelineProgress: makeElement(),
  timelineThumb: makeElement(),
  timelineBuffered: makeElement(),
  timelineSlider: makeElement(),
  findSegmentAt() { return null; },
  clearActiveSkip() {},
  updateActiveSubtitleCue() {},
  saveProgress() {}
};

vm.createContext(context);
vm.runInContext([
  sourceBetween('  function formatTime(', '  // --- Show Toast Notification ---'),
  sourceBetween('  function isGeneratedHlsPlayback()', '  // --- Watch progress persistence ---'),
  sourceBetween('  function updateTimelineAndSkipState()', '  function skipActiveSegment(')
].join('\n'), context, { filename: 'embed-duration-functions.js' });

// Exact regression: the generated playlist exposes only 7:23. The control bar
// must not replace the known full 2:19:00 title runtime with that partial value.
context.updateTimelineAndSkipState();
assert.strictEqual(timeDurationEl.textContent, '2:19:00');

// A growing playlist keeps the same full label on subsequent render ticks.
context.video.duration = 500;
context.updateTimelineAndSkipState();
assert.strictEqual(timeDurationEl.textContent, '2:19:00');

// ffprobe's more precise source duration wins over the rounded title runtime.
context.state.generatedSourceDuration = 8352;
context.updateTimelineAndSkipState();
assert.strictEqual(timeDurationEl.textContent, '2:19:12');

// Without ffprobe metadata, ENDLIST allows the completed media's real duration
// to replace the fallback runtime.
context.state.generatedSourceDuration = 0;
context.state.hlsInstance.latestLevelDetails = { live: false };
context.video.duration = 8352;
context.updateTimelineAndSkipState();
assert.strictEqual(timeDurationEl.textContent, '2:19:12');

// Native HLS is not a growing converter session and keeps its existing behavior.
context.state.activeHlsUrl = 'https://cdn.test/native/master.m3u8';
context.state.attachedStreamUrl = context.state.activeHlsUrl;
context.video.duration = 443;
context.updateTimelineAndSkipState();
assert.strictEqual(timeDurationEl.textContent, '7:23');

console.log('Player bottom-bar duration regression test passed.');
