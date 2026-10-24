/**
 * Small, runtime-neutral HLS metadata helpers.
 *
 * This is intentionally not a playlist loader.  It only reads master-playlist
 * declarations, so it can be used by both the Node resolver and a Cloudflare
 * Worker without a DOM, cheerio, or a Node stream/buffer implementation.
 */

function parseAttributes(value) {
  const attrs = {};
  const source = String(value || '');
  const pattern = /([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi;
  let match;
  while ((match = pattern.exec(source))) {
    attrs[match[1].toUpperCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

/** Parse #EXT-X-MEDIA:TYPE=AUDIO rows from an HLS master playlist. */
function parseHlsAudioTracks(manifest) {
  if (typeof manifest !== 'string' || !manifest.includes('#EXT-X-MEDIA')) return [];
  const rows = [];
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^#EXT-X-MEDIA:/i.test(trimmed)) continue;
    const attrs = parseAttributes(trimmed.slice(trimmed.indexOf(':') + 1));
    if (attrs.TYPE !== 'AUDIO') continue;
    const label = attrs.NAME || attrs.LANGUAGE || 'Audio';
    rows.push({
      index: rows.length,
      lang: attrs.LANGUAGE || '',
      label,
      url: attrs.URI || '',
      groupId: attrs['GROUP-ID'] || '',
      default: String(attrs.DEFAULT || '').toUpperCase() === 'YES',
      autoselect: String(attrs.AUTOSELECT || '').toUpperCase() === 'YES',
      channels: attrs.CHANNELS || ''
    });
  }
  return rows;
}

/** Parse subtitles as well; providers often put them beside alternate audio. */
function parseHlsSubtitleTracks(manifest, baseUrl = '') {
  if (typeof manifest !== 'string' || !manifest.includes('#EXT-X-MEDIA')) return [];
  const rows = [];
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^#EXT-X-MEDIA:/i.test(trimmed)) continue;
    const attrs = parseAttributes(trimmed.slice(trimmed.indexOf(':') + 1));
    if (attrs.TYPE !== 'SUBTITLES' || !attrs.URI) continue;
    let url = attrs.URI;
    try { url = new URL(url, baseUrl).toString(); } catch {}
    rows.push({
      index: rows.length,
      lang: attrs.LANGUAGE || '',
      label: attrs.NAME || attrs.LANGUAGE || 'Subtitles',
      url,
      format: 'vtt'
    });
  }
  return rows;
}

function looksLikeHlsManifest(text) {
  return typeof text === 'string' && /^\uFEFF?\s*#EXTM3U/i.test(text);
}

module.exports = {
  parseAttributes,
  parseHlsAudioTracks,
  parseHlsSubtitleTracks,
  looksLikeHlsManifest
};
