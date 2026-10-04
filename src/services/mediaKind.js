/**
 * Coarse media-kind detection from a URL's extension.
 *
 * Server-agnostic helper shared by the resolver: it derives a stream's
 * container (`hls` / `mp4` / `mkv` / `dash` / `unknown`) so the player can
 * pick the right playback path (HLS.js vs. progressive <video>). It used to
 * live in the now-removed server-3 provider module (which only ran on a Node
 * backend); the helper itself is server-agnostic and is used by the surviving
 * servers, so it lives here.
 */
function kindFromUrl(url) {
  const path = String(url || '').split('#')[0].split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mp4')) return 'mp4';
  if (path.endsWith('.mkv')) return 'mkv';
  if (path.endsWith('.mpd')) return 'dash';
  return 'unknown';
}

module.exports = {
  kindFromUrl
};
