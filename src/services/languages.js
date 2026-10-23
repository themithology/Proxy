/**
 * Shared audio-language helpers — single source of truth for language parsing.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Several resolvers need to answer the same questions about a stream:
 *
 *   - Which audio languages does this filename/title hint at? (TMDB-Embed-API
 *     stream `name`/`title` rows, release filename tags…)
 *   - What is the ISO 639-1 code for a language name ("Hindi" -> "hi")?
 *   - What is the human label for a code ("hi" -> "Hindi")?
 *
 * They are pure JS (no Node APIs, no Buffer) so the Cloudflare Worker can
 * import this module directly through `nodejs_compat`, the same way it
 * imports `serverCatalog.js` — the Goldmine resolver and the player-facing
 * API can never drift apart on what "Hindi+Tamil" means.
 */

/** Language name -> ISO 639-1 code (covers the dubs the upstreams carry). */
const LANGUAGE_NAME_TO_CODE = {
  hindi: 'hi', hin: 'hi',
  tamil: 'ta', tam: 'ta',
  telugu: 'te', tel: 'te',
  malayalam: 'ml', mal: 'ml',
  kannada: 'kn', kan: 'kn',
  bengali: 'bn', ben: 'bn', beng: 'bn', bangla: 'bn',
  marathi: 'mr', mar: 'mr',
  punjabi: 'pa', pan: 'pa',
  urdu: 'ur', urd: 'ur',
  gujarati: 'gu', guj: 'gu',
  odia: 'or', oriya: 'or', ori: 'or', odi: 'or', ory: 'or',
  assamese: 'as', asm: 'as',
  nepali: 'ne', nep: 'ne',
  sinhala: 'si', sinhalese: 'si', sin: 'si',
  bhojpuri: 'bho',
  english: 'en', eng: 'en',
  korean: 'ko', kor: 'ko',
  japanese: 'ja', jpn: 'ja',
  chinese: 'zh', zho: 'zh', chi: 'zh', cmn: 'zh', yue: 'zh', mandarin: 'zh', cantonese: 'zh',
  spanish: 'es', spa: 'es', espanol: 'es', castellano: 'es', latino: 'es',
  french: 'fr', fra: 'fr', fre: 'fr', francais: 'fr',
  german: 'de', deu: 'de', ger: 'de', deutsch: 'de',
  italian: 'it', ita: 'it', italiano: 'it',
  portuguese: 'pt', por: 'pt', portugues: 'pt', pb: 'pt', pob: 'pt', ptbr: 'pt',
  russian: 'ru', rus: 'ru',
  ukrainian: 'uk', ukr: 'uk',
  polish: 'pl', pol: 'pl',
  dutch: 'nl', nld: 'nl', dut: 'nl',
  swedish: 'sv', swe: 'sv',
  norwegian: 'no', nor: 'no', nob: 'no', nno: 'no',
  danish: 'da', dan: 'da',
  finnish: 'fi', fin: 'fi',
  czech: 'cs', ces: 'cs', cze: 'cs',
  slovak: 'sk', slk: 'sk', slo: 'sk',
  hungarian: 'hu', hun: 'hu',
  romanian: 'ro', ron: 'ro', rum: 'ro',
  bulgarian: 'bg', bul: 'bg',
  serbian: 'sr', srp: 'sr',
  croatian: 'hr', hrv: 'hr',
  slovenian: 'sl', slv: 'sl',
  greek: 'el', ell: 'el', gre: 'el',
  hebrew: 'he', heb: 'he',
  thai: 'th', tha: 'th',
  indonesian: 'id', ind: 'id',
  malay: 'ms', msa: 'ms', may: 'ms',
  filipino: 'tl', tagalog: 'tl', fil: 'tl', tgl: 'tl',
  turkish: 'tr', tur: 'tr',
  arabic: 'ar', ara: 'ar',
  vietnamese: 'vi', vie: 'vi',
  persian: 'fa', fas: 'fa', per: 'fa', farsi: 'fa',
  catalan: 'ca', cat: 'ca'
};

/** ISO 639-2/3 -> ISO 639-1 for the languages the player menu normalizes. */
const ISO639_TO_ISO639_1 = {
  hin: 'hi', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr',
  pan: 'pa', urd: 'ur', guj: 'gu', ori: 'or', asm: 'as', nep: 'ne', sin: 'si',
  eng: 'en', kor: 'ko', jpn: 'ja', zho: 'zh', chi: 'zh', cmn: 'zh', yue: 'zh',
  spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt',
  rus: 'ru', tha: 'th', ind: 'id', tur: 'tr', ara: 'ar', vie: 'vi', fas: 'fa',
  per: 'fa', msa: 'ms', may: 'ms', fil: 'tl', tgl: 'tl', nld: 'nl', dut: 'nl',
  pol: 'pl', ukr: 'uk', heb: 'he', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el',
  hun: 'hu', ron: 'ro', rum: 'ro', bul: 'bg', srp: 'sr', hrv: 'hr', slk: 'sk',
  slo: 'sk', slv: 'sl', swe: 'sv', nor: 'no', nob: 'no', nno: 'no', dan: 'da',
  fin: 'fi', cat: 'ca', glg: 'gl', eus: 'eu', baq: 'eu', lit: 'lt', lav: 'lv',
  est: 'et', mkd: 'mk', mac: 'mk', sqi: 'sq', alb: 'sq', aze: 'az', kaz: 'kk',
  uzb: 'uz', kat: 'ka', geo: 'ka', hye: 'hy', arm: 'hy', amh: 'am', swa: 'sw',
  afr: 'af', isl: 'is', ice: 'is', lat: 'la'
};

/** ISO 639-1 -> ISO 639-2/B (Matroska files tag tracks with three letters). */
const CODE2_TO_CODE3 = {
  en: 'eng', hi: 'hin', ta: 'tam', te: 'tel', ml: 'mal', kn: 'kan', bn: 'ben',
  mr: 'mar', pa: 'pan', ur: 'urd', gu: 'guj', or: 'ori', as: 'asm', ne: 'nep',
  si: 'sin', ja: 'jpn', ko: 'kor', zh: 'zho', es: 'spa', fr: 'fra', de: 'deu',
  it: 'ita', pt: 'por', ru: 'rus', ar: 'ara', th: 'tha', id: 'ind', tr: 'tur',
  fa: 'fas', vi: 'vie', ms: 'msa', tl: 'tgl', nl: 'nld', pl: 'pol', uk: 'ukr',
  he: 'heb', cs: 'ces', el: 'ell', hu: 'hun', ro: 'ron', bg: 'bul', sr: 'srp',
  hr: 'hrv', sk: 'slk', sl: 'slv', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin',
  ca: 'cat', gl: 'glg', eu: 'eus', lt: 'lit', lv: 'lav', et: 'est', mk: 'mkd',
  sq: 'sqi', az: 'aze', kk: 'kaz', uz: 'uzb', ka: 'kat', hy: 'hye', am: 'amh',
  sw: 'swa', af: 'afr', is: 'isl', la: 'lat'
};

/**
 * Normalize any language-ish value ("Hindi", "hin", "hi-IN", "und", "") to a
 * short code. Dependency-free so the Worker can use it too.
 */
function normalizeLanguageCode(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw || /^(und|unknown|undefined|zxx|mis|none|mul)$/i.test(raw)) return 'und';
  const word = raw.split(/[\s,;.]/, 1)[0];
  const base = word.split('-', 1)[0];
  if (!base) return 'und';
  if (LANGUAGE_NAME_TO_CODE[base]) return LANGUAGE_NAME_TO_CODE[base];
  if (ISO639_TO_ISO639_1[base]) return ISO639_TO_ISO639_1[base];
  if (/^[a-z]{2}$/.test(base)) return base;
  if (/^[a-z]{3}$/.test(base)) return base; // unmapped 3-letter: keep as-is
  return 'und';
}

/** "Hindi Dub" / "hin" / "hi-IN" -> "hi". Unknown -> "und". */
function mapLanguageNameToCode(name) {
  if (!name) return 'und';
  const clean = String(name).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (LANGUAGE_NAME_TO_CODE[clean]) return LANGUAGE_NAME_TO_CODE[clean];
  return normalizeLanguageCode(clean);
}

/** "hi" -> "Hindi" (title-cased label for the language menu / chips). */
function languageLabelForCode(code) {
  const normalized = normalizeLanguageCode(code);
  for (const alias of LANGUAGE_ALIASES) {
    if (alias.code === normalized) return alias.label;
  }
  if (normalized && normalized !== 'und') {
    return normalized.length <= 3 ? normalized.toUpperCase() : normalized;
  }
  return 'Original';
}

/** "hi" -> "hin" (Matroska/FFmpeg three-letter tags). Unknown passes through. */
function threeLetterCode(code) {
  const normalized = normalizeLanguageCode(code);
  return CODE2_TO_CODE3[normalized] || normalized;
}

/**
 * Language aliases used to sniff dub languages out of free text (release
 * titles, filenames, provider labels). Longest aliases are matched first so
 * "Malayalam" wins over "Malay". Short ambiguous English words are intentionally
 * omitted here so movie titles never false-match.
 */
const LANGUAGE_ALIASES = [
  { code: 'en', label: 'English', aliases: ['English', 'Eng'] },
  { code: 'hi', label: 'Hindi', aliases: ['Hindi', 'Hin'] },
  { code: 'te', label: 'Telugu', aliases: ['Telugu', 'Tel'] },
  { code: 'bn', label: 'Bengali', aliases: ['Bengali', 'Bangla', 'Beng'] },
  { code: 'ta', label: 'Tamil', aliases: ['Tamil', 'Tam'] },
  { code: 'ml', label: 'Malayalam', aliases: ['Malayalam', 'Mal'] },
  { code: 'kn', label: 'Kannada', aliases: ['Kannada', 'Kan'] },
  { code: 'ja', label: 'Japanese', aliases: ['Japanese', 'Jpn'] },
  { code: 'ko', label: 'Korean', aliases: ['Korean', 'Kor'] },
  { code: 'zh', label: 'Chinese', aliases: ['Chinese', 'Mandarin', 'Cantonese'] },
  { code: 'es', label: 'Spanish', aliases: ['Spanish', 'Espanol', 'Castellano'] },
  { code: 'fr', label: 'French', aliases: ['French', 'Francais'] },
  { code: 'ar', label: 'Arabic', aliases: ['Arabic'] },
  { code: 'ur', label: 'Urdu', aliases: ['Urdu'] },
  { code: 'mr', label: 'Marathi', aliases: ['Marathi'] },
  { code: 'pa', label: 'Punjabi', aliases: ['Punjabi'] },
  { code: 'gu', label: 'Gujarati', aliases: ['Gujarati'] },
  { code: 'or', label: 'Odia', aliases: ['Odia', 'Oriya'] },
  { code: 'as', label: 'Assamese', aliases: ['Assamese'] },
  { code: 'ne', label: 'Nepali', aliases: ['Nepali'] },
  { code: 'si', label: 'Sinhala', aliases: ['Sinhala', 'Sinhalese'] },
  { code: 'bho', label: 'Bhojpuri', aliases: ['Bhojpuri'] },
  { code: 'pt', label: 'Portuguese', aliases: ['Portuguese', 'Portugues'] },
  { code: 'ru', label: 'Russian', aliases: ['Russian'] },
  { code: 'uk', label: 'Ukrainian', aliases: ['Ukrainian'] },
  { code: 'pl', label: 'Polish', aliases: ['Polish'] },
  { code: 'nl', label: 'Dutch', aliases: ['Dutch'] },
  { code: 'de', label: 'German', aliases: ['German', 'Deutsch'] },
  { code: 'it', label: 'Italian', aliases: ['Italian', 'Italiano'] },
  { code: 'id', label: 'Indonesian', aliases: ['Indonesian'] },
  { code: 'ms', label: 'Malay', aliases: ['Malay'] },
  { code: 'tl', label: 'Filipino', aliases: ['Filipino', 'Tagalog'] },
  { code: 'tr', label: 'Turkish', aliases: ['Turkish'] },
  { code: 'th', label: 'Thai', aliases: ['Thai'] },
  { code: 'fa', label: 'Persian', aliases: ['Persian', 'Farsi'] },
  { code: 'vi', label: 'Vietnamese', aliases: ['Vietnamese'] },
  { code: 'he', label: 'Hebrew', aliases: ['Hebrew'] },
  { code: 'el', label: 'Greek', aliases: ['Greek'] },
  { code: 'cs', label: 'Czech', aliases: ['Czech'] },
  { code: 'sk', label: 'Slovak', aliases: ['Slovak'] },
  { code: 'hu', label: 'Hungarian', aliases: ['Hungarian'] },
  { code: 'ro', label: 'Romanian', aliases: ['Romanian'] },
  { code: 'bg', label: 'Bulgarian', aliases: ['Bulgarian'] },
  { code: 'sr', label: 'Serbian', aliases: ['Serbian'] },
  { code: 'hr', label: 'Croatian', aliases: ['Croatian'] },
  { code: 'sv', label: 'Swedish', aliases: ['Swedish'] },
  { code: 'no', label: 'Norwegian', aliases: ['Norwegian'] },
  { code: 'da', label: 'Danish', aliases: ['Danish'] },
  { code: 'fi', label: 'Finnish', aliases: ['Finnish'] },
  { code: 'ca', label: 'Catalan', aliases: ['Catalan'] }
];

/**
 * Parse free text (a release title, a filename, a provider label) for dub
 * language hints. Returns `{ languages: [{code,label}], multi, original }`:
 *
 *   - `languages` — distinct hinted languages in order of appearance
 *   - `multi`     — an explicit "Dual Audio"/"Multi-Audio" marker was found,
 *                   or more than one language is hinted
 *   - `original`  — an "Original Audio"/"Org" marker was found
 */
function parseAudioLanguageHints(text) {
  // URLs (hosts, CDN paths, query tokens) are never dub hints — strip them
  // before scanning so e.g. `english.workers.dev` does not register as English.
  const value = String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ');
  const aliases = LANGUAGE_ALIASES.flatMap((language) =>
    language.aliases.map((alias) => ({ ...language, alias }))
  ).sort((a, b) => b.alias.length - a.alias.length);
  const aliasPattern = aliases.map((item) => item.alias).join('|');
  const matcher = new RegExp(`(^|[^A-Za-z])(${aliasPattern})(?=$|[^A-Za-z])`, 'gi');
  const languages = [];
  const seen = new Set();
  let match;
  while ((match = matcher.exec(value))) {
    const alias = match[2].toLowerCase();
    const language = aliases.find((item) => item.alias.toLowerCase() === alias);
    if (language && !seen.has(language.code)) {
      seen.add(language.code);
      languages.push({ code: language.code, label: language.label });
    }
  }
  const explicitMulti = /\b(?:dual[\s._-]*audio|multi(?:ple)?[\s._-]*(?:audio|language|lang|track|dub))\b/i.test(value);
  const original = /\b(?:org\.?|original)[\s._-]*(?:audio|track)\b/i.test(value);
  return { languages, multi: explicitMulti || languages.length > 1, original };
}

module.exports = {
  LANGUAGE_NAME_TO_CODE,
  LANGUAGE_ALIASES,
  ISO639_TO_ISO639_1,
  CODE2_TO_CODE3,
  normalizeLanguageCode,
  mapLanguageNameToCode,
  languageLabelForCode,
  threeLetterCode,
  parseAudioLanguageHints
};
