/**
 * TMDB presentation artwork shared by the Node backend and the Cloudflare
 * Worker (pure helpers, no Node-only APIs — the Worker bundles this file
 * through nodejs_compat like serverCatalog.js and skipSegments.js).
 *
 * The player's connect screen and paused screen show the title *logo* (the
 * transparent PNG TMDB keeps under `images.logos`), the tagline and the
 * rating instead of plain text. Both details calls therefore append
 * `images` with `include_image_language=en,null` and run the payload through
 * `presentationFields()` so the two deployments can never drift.
 */

const DEFAULT_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Query-string fragment every details request must carry. */
const DETAILS_APPEND = 'append_to_response=external_ids,alternative_titles,images&include_image_language=en,null';

/**
 * Choose the logo viewers should see: English first, then language-less,
 * PNG over SVG (SVG renders unpredictably in <img> at fixed sizes), and the
 * community rating as the tie-breaker. Returns the TMDB file path or null.
 */
function pickLogoPath(images) {
  const logos = images && Array.isArray(images.logos) ? images.logos : [];
  let best = null;
  let bestScore = -Infinity;
  for (const logo of logos) {
    if (!logo || typeof logo.file_path !== 'string' || !logo.file_path) continue;
    const lang = logo.iso_639_1 || null;
    const langScore = lang === 'en' ? 3 : lang === null ? 2 : 1;
    const formatScore = /\.png$/i.test(logo.file_path) ? 1 : 0;
    const votes = Number(logo.vote_average) || 0;
    const score = langScore * 100 + formatScore * 10 + votes;
    if (score > bestScore) {
      bestScore = score;
      best = logo;
    }
  }
  return best ? best.file_path : null;
}

function logoUrl(filePath, imageBase = DEFAULT_IMAGE_BASE) {
  if (!filePath) return null;
  const base = (imageBase || DEFAULT_IMAGE_BASE).replace(/\/$/, '');
  // SVGs are vector: request the original. PNG logos are plenty sharp at w500.
  const size = /\.svg$/i.test(filePath) ? 'original' : 'w500';
  return `${base}/${size}${filePath}`;
}

/**
 * Fields added to the metadata payload: `{ logo, tagline, rating, voteCount }`.
 * `data` is the raw TMDB details response (movie or tv).
 */
function presentationFields(data, imageBase = DEFAULT_IMAGE_BASE) {
  const safe = data && typeof data === 'object' ? data : {};
  const rating = Number(safe.vote_average);
  const voteCount = Number(safe.vote_count);
  return {
    logo: logoUrl(pickLogoPath(safe.images), imageBase),
    tagline: typeof safe.tagline === 'string' ? safe.tagline.trim() : '',
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    voteCount: Number.isFinite(voteCount) && voteCount > 0 ? voteCount : null
  };
}

module.exports = {
  DEFAULT_IMAGE_BASE,
  DETAILS_APPEND,
  pickLogoPath,
  logoUrl,
  presentationFields
};
