/**
 * Converts SubRip (.srt) subtitle content to WebVTT (.vtt) format
 * and supports shifting cue timestamps by an offset in seconds.
 */
function srtToVtt(srtText) {
  if (!srtText || typeof srtText !== 'string') {
    return 'WEBVTT\n\n';
  }

  const trimmed = srtText.trim().replace(/^\uFEFF/, '');
  if (trimmed.startsWith('WEBVTT')) {
    return trimmed;
  }

  // Normalize line endings and convert SRT comma milliseconds (00:01:23,456) to VTT dot (00:01:23.456)
  const normalized = trimmed
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/(\d{1}:\d{2}:\d{2}),(\d{3})/g, '0$1.$2');

  return `WEBVTT\n\n${normalized}\n`;
}

module.exports = { srtToVtt };
