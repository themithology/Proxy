/**
 * Standalone upstream fixture server.
 *
 *   npm run fixture
 *
 * Serves genuine HLS (master + media + AES key + fMP4 init), DASH
 * (SegmentTemplate + SegmentList + BaseURL), subtitles in three formats and an
 * embed page that hides its media URL — everything the proxy has to cope with.
 *
 * Point a `direct` provider at it to exercise the full pipeline by hand:
 *
 *   curl "http://localhost:3000/api/streams/movie/tt9999999"
 */
import { startFixture } from '../test/fixtures/upstream.js';

const fixture = await startFixture(Number(process.env.FIXTURE_PORT ?? 0) || 0);

console.log(`\n  Upstream fixture running at ${fixture.baseUrl}\n`);
console.log('  Try:');
console.log(`    ${fixture.baseUrl}/master.m3u8           HLS master (2 variants + subs)`);
console.log(`    ${fixture.baseUrl}/dash/manifest.mpd     DASH (SegmentTemplate + SegmentList)`);
console.log(`    ${fixture.baseUrl}/embed.html            embed hiding its media URL`);
console.log(`    ${fixture.baseUrl}/b64.html              media URL hidden in base64`);
console.log(`    ${fixture.baseUrl}/subs/hi.srt           SRT subtitle`);
console.log('\n  Ctrl-C to stop.\n');

const stop = async () => {
  await fixture.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
