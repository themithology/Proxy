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
  URL,
  console,
  PLAYER_DEBUG: false,
  window: { location: { href: 'https://player.test/embed/movie/693134' } },
  clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
  video: { currentTime: 61, duration: 443, buffered: { length: 0 }, paused: false },
  state: {
    activeHlsUrl: 'https://player.test/api/mkv-hls/0123456789abcdef0123456789abcdef/master.m3u8',
    attachedStreamUrl: 'https://player.test/api/mkv-hls/0123456789abcdef0123456789abcdef/master.m3u8',
    generatedSourceDuration: 0,
    generatedSourceOffset: 0,
    generatedConversionUrl: 'https://player.test/api/mkv-hls?src=fixture',
    generatedSeekToken: 0,
    pendingSeekTime: null,
    attachToken: 1,
    loadToken: 1,
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
  saveProgress() {},
  showBuffering() {},
  hideBuffering() {},
  showToast() {},
  fetch() { throw new Error('fetch stub was not configured'); },
  attachStreamToVideo() { throw new Error('attach stub was not configured'); }
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

async function runSeekTests() {
  // A target already inside the seekable HLS range stays local and does not
  // start another conversion.
  context.state.activeHlsUrl = 'https://player.test/api/mkv-hls/0123456789abcdef0123456789abcdef/master.m3u8';
  context.state.attachedStreamUrl = context.state.activeHlsUrl;
  context.state.generatedSourceDuration = 8352;
  context.state.generatedSourceOffset = 0;
  context.state.hlsInstance.latestLevelDetails = { live: true };
  context.video.seekable = { length: 1, start() { return 0; }, end() { return 443; } };
  context.fetch = () => { throw new Error('local seek must not fetch a new window'); };
  assert.strictEqual(await context.seekTo(100), true);
  assert.strictEqual(context.video.currentTime, 100);

  // This is the actual scrub-beyond-loaded-playlist regression. The player
  // must request the 1:00:00 window and attach it with source-relative time 0.
  const fetchUrls = [];
  const attachCalls = [];
  context.fetch = async (url) => {
    fetchUrls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          masterUrl: '/api/mkv-hls/feedfacefeedfacefeedfacefeedface/master.m3u8',
          sourceDuration: 8352,
          sourceOffset: 3600
        };
      }
    };
  };
  context.attachStreamToVideo = async (url, resumeTime, loadToken, options) => {
    attachCalls.push({ url, resumeTime, loadToken, options });
    context.state.attachedStreamUrl = url;
    context.state.activeHlsUrl = url;
    context.state.attachToken += 1;
    context.state.pendingSeekTime = null;
    context.video.currentTime = options.generatedStartTime;
  };
  assert.strictEqual(await context.seekTo(3600), true);
  assert.strictEqual(fetchUrls.length, 1);
  const seekUrl = new URL(fetchUrls[0]);
  assert.strictEqual(seekUrl.searchParams.get('info'), '1');
  assert.strictEqual(seekUrl.searchParams.get('seek'), '3600');
  assert.strictEqual(attachCalls.length, 1);
  assert.strictEqual(attachCalls[0].options.generatedStartTime, 0);
  assert.strictEqual(attachCalls[0].options.preservePendingSeek, true);
  assert.strictEqual(attachCalls[0].options.autoplay, true);
  assert.strictEqual(context.state.generatedSourceOffset, 3600);
  assert.strictEqual(context.getPlaybackTime(), 3600);
  context.updateTimelineAndSkipState();
  assert.strictEqual(context.timeCurrentEl.textContent, '1:00:00');
  assert.strictEqual(timeDurationEl.textContent, '2:19:12');
}

runSeekTests().then(() => {
  console.log('Player bottom-bar duration and on-demand seek regression tests passed.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
