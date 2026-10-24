(function () {
  'use strict';

  // Optional live diagnostics. Set before the movi module loads so its own
  // FFmpeg/WebCodecs logs reach the browser console during real-source tests.
  const PLAYER_DEBUG = new URLSearchParams(window.location.search).get('debug') === '1';
  if (PLAYER_DEBUG) window.__movilog = console;

  // --- Configurable API base URL ---
  // The player page (/embed) and the JSON/stream API may run on different
  // Workers. The API base is resolved in this order:
  //   1. `?api=https://api-worker.example` query parameter on the embed URL
  //   2. `window.__LOL_EMBED_CONFIG__.apiBaseUrl` injected by the Worker
  //      (configured via the API_BASE_URL var in wrangler.toml)
  //   3. empty string -> same origin (player + API on one Worker)
  function resolveApiBaseUrl() {
    const params = new URLSearchParams(window.location.search);
    const candidates = [
      params.get('api') || params.get('apiBase') || '',
      (window.__LOL_EMBED_CONFIG__ && window.__LOL_EMBED_CONFIG__.apiBaseUrl) || ''
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || '').trim();
      if (!raw) continue;
      try {
        const parsed = new URL(raw, window.location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        return parsed.href.replace(/\/+$/, '');
      } catch (_) {
        // Ignore malformed values and fall back to the next candidate.
      }
    }
    return '';
  }
  const API_BASE = resolveApiBaseUrl();

  // Prefix an API path (e.g. `/api/resolve/...`) with the configured base.
  function apiUrl(path) {
    return API_BASE + path;
  }

  // API responses may carry same-origin-relative URLs (`/api/proxy?...`).
  // When the API lives on another Worker those must be resolved against the
  // configured API base instead of the player's own origin.
  function absolutizeApiUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    if (value.startsWith('/') && !value.startsWith('//')) return API_BASE + value;
    return value;
  }

  function absolutizeStreamPayload(stream) {
    if (!stream || typeof stream !== 'object') return;
    stream.streamUrl = absolutizeApiUrl(stream.streamUrl);
    if (Array.isArray(stream.backupUrls)) {
      stream.backupUrls = stream.backupUrls.map(absolutizeApiUrl);
    }
    if (Array.isArray(stream.audioTracks)) {
      stream.audioTracks.forEach((track) => {
        if (!track) return;
        track.streamUrl = absolutizeApiUrl(track.streamUrl);
        track.rawUrl = absolutizeApiUrl(track.rawUrl);
      });
    }
    if (Array.isArray(stream.qualities)) {
      stream.qualities.forEach((quality) => {
        if (quality) quality.url = absolutizeApiUrl(quality.url);
      });
    }
    // Goldmine labels its sources per URL (`sourceLabels`): remap the keys so
    // they keep matching the absolutized streamUrl/backupUrls entries.
    if (stream.sourceLabels && typeof stream.sourceLabels === 'object') {
      const remapped = {};
      Object.keys(stream.sourceLabels).forEach((key) => {
        remapped[absolutizeApiUrl(key)] = stream.sourceLabels[key];
      });
      stream.sourceLabels = remapped;
    }
    if (stream.sourceMeta && typeof stream.sourceMeta === 'object') {
      const remappedMeta = {};
      Object.keys(stream.sourceMeta).forEach((key) => {
        const meta = stream.sourceMeta[key];
        if (!meta || typeof meta !== 'object') return;
        const copy = Object.assign({}, meta);
        if (Array.isArray(copy.subtitles)) {
          copy.subtitles = copy.subtitles.map((sub) =>
            sub && typeof sub === 'object' ? Object.assign({}, sub, { url: absolutizeApiUrl(sub.url) }) : sub
          );
        }
        remappedMeta[absolutizeApiUrl(key)] = copy;
      });
      stream.sourceMeta = remappedMeta;
    }
  }

  // --- Language code & label normalization (shared across URL params, MKV, HLS, subtitles) ---
  const MOVI_LANG_FIX = {
    english: 'en', eng: 'en',
    hindi: 'hi', hin: 'hi',
    tamil: 'ta', tam: 'ta',
    telugu: 'te', tel: 'te',
    malayalam: 'ml', mal: 'ml',
    kannada: 'kn', kan: 'kn',
    bengali: 'bn', bangla: 'bn', ben: 'bn', beng: 'bn',
    marathi: 'mr', mar: 'mr',
    gujarati: 'gu', guj: 'gu',
    punjabi: 'pa', pan: 'pa',
    urdu: 'ur', urd: 'ur',
    odia: 'or', oriya: 'or', ori: 'or', odi: 'or', ory: 'or',
    assamese: 'as', asm: 'as',
    nepali: 'ne', nep: 'ne',
    sinhala: 'si', sinhalese: 'si', sin: 'si',
    bhojpuri: 'bho',
    arabic: 'ar', ara: 'ar',
    spanish: 'es', espanol: 'es', castellano: 'es', latino: 'es', spa: 'es',
    french: 'fr', francais: 'fr', fra: 'fr', fre: 'fr',
    german: 'de', deutsch: 'de', deu: 'de', ger: 'de',
    italian: 'it', italiano: 'it', ita: 'it',
    portuguese: 'pt', portugues: 'pt', por: 'pt', pb: 'pt', pob: 'pt', ptbr: 'pt',
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
    persian: 'fa', farsi: 'fa', fas: 'fa', per: 'fa',
    japanese: 'ja', jpn: 'ja',
    korean: 'ko', kor: 'ko',
    chinese: 'zh', mandarin: 'zh', cantonese: 'zh', zho: 'zh', chi: 'zh', cmn: 'zh', yue: 'zh',
    thai: 'th', tha: 'th',
    indonesian: 'id', ind: 'id',
    malay: 'ms', msa: 'ms', may: 'ms',
    filipino: 'tl', tagalog: 'tl', fil: 'tl', tgl: 'tl',
    turkish: 'tr', tur: 'tr',
    vietnamese: 'vi', vie: 'vi',
    catalan: 'ca', cat: 'ca'
  };

  const LANG_CHIP_LABELS = {
    en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
    kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi',
    ur: 'Urdu', or: 'Odia', as: 'Assamese', ne: 'Nepali', si: 'Sinhala',
    bho: 'Bhojpuri', ar: 'Arabic', fa: 'Persian', he: 'Hebrew', es: 'Spanish',
    fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
    uk: 'Ukrainian', pl: 'Polish', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian',
    da: 'Danish', fi: 'Finnish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian',
    ro: 'Romanian', bg: 'Bulgarian', sr: 'Serbian', hr: 'Croatian', sl: 'Slovenian',
    el: 'Greek', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', th: 'Thai',
    id: 'Indonesian', ms: 'Malay', tl: 'Filipino', tr: 'Turkish', vi: 'Vietnamese',
    ca: 'Catalan'
  };

  function normalizeMoviLang(lang) {
    const raw = String(lang || '').trim().toLowerCase().replace(/_/g, '-');
    if (!raw || /^(und|unknown|undefined|zxx|mis|none|mul|default)$/i.test(raw)) return 'und';
    const token = raw.split(/[\s,;.]/, 1)[0];
    const base = token.split('-', 1)[0];
    if (!base) return 'und';
    if (MOVI_LANG_FIX[base]) return MOVI_LANG_FIX[base];
    if (/^[a-z]{2,3}$/.test(base)) return base;
    return 'und';
  }

  function inferLangFromTrackLabel(label) {
    const text = String(label || '');
    if (!text) return 'und';
    const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.length >= 3 && MOVI_LANG_FIX[w]) return MOVI_LANG_FIX[w];
    }
    return 'und';
  }

  function langChipLabel(lang, index) {
    const code = normalizeMoviLang(lang);
    if (!code || code === 'und') return `Audio ${index + 1}`;
    return LANG_CHIP_LABELS[code] || (code.length <= 3 ? code.toUpperCase() : code.charAt(0).toUpperCase() + code.slice(1));
  }

  // --- Small helpers ---
  // Everything rendered through innerHTML (TMDB titles/overviews, upstream
  // track labels, uploaded file names) goes through this first.
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      // Storage can be unavailable in sandboxed iframes / private mode.
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_) {}
  }

  const AUTOSKIP_KEY = 'lol_embed_autoskip';
  const QUALITY_KEY = 'lol_embed_quality';

  /**
   * `?t=` / `?start=` value in seconds. Accepts plain seconds (`90`, `90.5`),
   * YouTube-style `1h2m3s` / `2m` / `45s`, and clock form `1:02:03` / `2:03`.
   */
  function parseStartParam(raw) {
    if (raw == null) return 0;
    const text = String(raw).trim().toLowerCase();
    if (!text) return 0;
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, parseFloat(text));
    const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (clock) {
      const parts = clock.slice(1).filter((x) => x !== undefined).map((x) => parseInt(x, 10));
      return parts.reduce((acc, n) => acc * 60 + n, 0);
    }
    const hms = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
    if (hms && (hms[1] || hms[2] || hms[3])) {
      return (parseInt(hms[1] || '0', 10) * 3600) + (parseInt(hms[2] || '0', 10) * 60) + parseFloat(hms[3] || '0');
    }
    return 0;
  }

  /** Per-title memory of the viewer's subtitle / audio language choice. */
  function showPrefsKey() {
    return `lol_embed_prefs_${state.type}_${state.tmdbId}`;
  }
  function readShowPrefs() {
    try {
      const parsed = JSON.parse(storageGet(showPrefsKey()) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  function writeShowPrefs(patch) {
    if (!state.tmdbId) return;
    const next = Object.assign(readShowPrefs(), patch);
    storageSet(showPrefsKey(), JSON.stringify(next));
  }

  // Pick black or white text for a given accent so active pills / badges
  // stay readable with `?color=` overrides.
  function contrastColorFor(hex) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return '#000000';
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return luminance > 0.45 ? '#000000' : '#ffffff';
  }

  const RTL_LANGS = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ku']);
  function directionForLang(lang) {
    const code = String(lang || '').toLowerCase().split(/[-_]/)[0];
    return RTL_LANGS.has(code) ? 'rtl' : 'ltr';
  }

  // --- DOM Elements ---
  const playerRoot = document.getElementById('player-root');
  const nativeVideo = document.getElementById('video-element');
  // The element playback currently runs on: the native <video>, or the
  // movi-player element (WebCodecs/FFmpeg-WASM) while a Goldmine MKV /
  // multi-audio file is attached. EVERY media read/write in this file goes
  // through `video`, so swapping this reference moves the whole HUD with it.
  let video = nativeVideo;
  const moviMount = document.getElementById('movi-mount');
  const langChipsRow = document.getElementById('lang-chips-row');
  const langChips = document.getElementById('lang-chips');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatusText = document.getElementById('loading-status-text');
  const loadingStatusDetail = document.getElementById('loading-status-detail');
  const loadingActions = document.getElementById('loading-actions');
  const btnRetryLoad = document.getElementById('btn-retry-load');
  const loadingServers = document.getElementById('loading-servers');
  const bufferingIndicator = document.getElementById('buffering-indicator');
  const playerToast = document.getElementById('player-toast');
  const playerToastText = document.getElementById('player-toast-text');
  const btnCenterPlay = document.getElementById('btn-center-play');
  const iconCenterPlay = document.getElementById('icon-center-play');
  const iconCenterPause = document.getElementById('icon-center-pause');
  const btnCenterRewind = document.getElementById('btn-center-rewind');
  const btnCenterForward = document.getElementById('btn-center-forward');
  // Connect screen (loading overlay) parts
  const loadingBackdrop = document.getElementById('loading-backdrop');
  const loadingLogo = document.getElementById('loading-logo');
  const loadingTitleText = document.getElementById('loading-title-text');
  const loadingGenres = document.getElementById('loading-genres');
  const loadingProgressFill = document.getElementById('loading-progress-fill');
  const loadingSourceLine = document.getElementById('loading-source-line');
  const loadingSourceServer = document.getElementById('loading-source-server');
  const loadingSourceLabel = document.getElementById('loading-source-label');
  const loadingTip = document.getElementById('loading-tip');
  const loadingBranding = document.getElementById('loading-branding');
  const btnLoadingBack = document.getElementById('btn-loading-back');
  const btnLoadingServers = document.getElementById('btn-loading-servers');
  // Paused screen parts
  const pausedOverlay = document.getElementById('paused-overlay');
  const pausedBackdrop = document.getElementById('paused-backdrop');
  const pausedLogo = document.getElementById('paused-logo');
  const pausedTitleText = document.getElementById('paused-title-text');
  const pausedEpisode = document.getElementById('paused-episode');
  const pausedTagline = document.getElementById('paused-tagline');
  const pausedMeta = document.getElementById('paused-meta');
  const pausedGenres = document.getElementById('paused-genres');
  const pausedOverview = document.getElementById('paused-overview');
  const topMediaTitle = document.getElementById('top-media-title');

  // Up next
  const upNextCard = document.getElementById('up-next-card');
  const upNextTitle = document.getElementById('up-next-title');
  const upNextProgressFill = document.getElementById('up-next-progress-fill');
  const btnUpNextCancel = document.getElementById('btn-up-next-cancel');
  const btnUpNextPlay = document.getElementById('btn-up-next-play');

  // Top & Metadata
  const btnBack = document.getElementById('btn-back');
  const btnEpisodes = document.getElementById('btn-episodes');
  const btnServers = document.getElementById('btn-servers');
  const centerClickZone = document.getElementById('center-click-zone');
  const mediaTitleEl = document.getElementById('media-title');
  const mediaTagsEl = document.getElementById('media-tags');

  // Skip Intro & Timeline
  const btnSkipIntro = document.getElementById('btn-skip-intro');
  const skipIntroLabel = document.getElementById('skip-intro-label');
  const skipProgressFill = document.getElementById('skip-progress-fill');
  const timeCurrentEl = document.getElementById('time-current');
  const timeDurationEl = document.getElementById('time-duration');
  const timelineSlider = document.getElementById('timeline-slider');
  const timelineHoverTooltip = document.getElementById('timeline-hover-tooltip');
  const timelineSegmentsBg = document.getElementById('timeline-segments-bg');
  const timelineBuffered = document.getElementById('timeline-buffered');
  const timelineProgress = document.getElementById('timeline-progress');
  const timelineThumb = document.getElementById('timeline-thumb');

  // Bottom Controls
  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnRewind = document.getElementById('btn-rewind');
  const btnForward = document.getElementById('btn-forward');
  const btnNextEpisode = document.getElementById('btn-next-episode');
  const btnMute = document.getElementById('btn-mute');
  const iconVolHigh = document.getElementById('icon-vol-high');
  const iconVolLow = document.getElementById('icon-vol-low');
  const iconVolMuted = document.getElementById('icon-vol-muted');
  const volumeRange = document.getElementById('volume-range');

  const btnAudioMenu = document.getElementById('btn-audio-menu');
  const btnSubtitlesMenu = document.getElementById('btn-subtitles-menu');
  const subtitlesActiveDot = document.getElementById('subtitles-active-dot');
  const btnSettingsModal = document.getElementById('btn-settings-modal');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const iconFsEnter = document.getElementById('icon-fs-enter');
  const iconFsExit = document.getElementById('icon-fs-exit');

  // Popovers
  const popoverAudio = document.getElementById('popover-audio');
  const audioTrackListEl = document.getElementById('audio-track-list');

  const popoverSubtitles = document.getElementById('popover-subtitles');
  const subtitleMainView = document.getElementById('subtitle-main-view');
  const subtitleTrackListEl = document.getElementById('subtitle-track-list');
  const subtitleFileInput = document.getElementById('subtitle-file-input');
  const btnSubStyle = document.getElementById('btn-sub-style');
  const btnSubDelay = document.getElementById('btn-sub-delay');
  const subtitleStyleView = document.getElementById('subtitle-style-view');
  const subtitleDelayView = document.getElementById('subtitle-delay-view');
  const btnSubStyleBack = document.getElementById('btn-sub-style-back');
  const btnSubDelayBack = document.getElementById('btn-sub-delay-back');
  const delayCurrentValue = document.getElementById('delay-current-value');
  const subDelayBadge = document.getElementById('sub-delay-badge');
  const customSubtitleText = document.getElementById('custom-subtitle-text');

  // Modals
  const modalSettingsBackdrop = document.getElementById('modal-settings-backdrop');
  const settingsMainPanel = document.getElementById('settings-main-panel');
  const settingsDrillPanel = document.getElementById('settings-drill-panel');
  const settingsDrillTitle = document.getElementById('settings-drill-title');
  const settingsDrillList = document.getElementById('settings-drill-list');
  const btnSettingsDrillBack = document.getElementById('btn-settings-drill-back');
  const btnCloseSettings = document.getElementById('btn-close-settings');

  const valQuality = document.getElementById('val-quality');
  const valAudio = document.getElementById('val-audio');
  const valSubtitles = document.getElementById('val-subtitles');
  const valAspect = document.getElementById('val-aspect');
  const valBrightness = document.getElementById('val-brightness');
  const valMirror = document.getElementById('val-mirror');
  const valPip = document.getElementById('val-pip');
  const valSpeed = document.getElementById('val-speed');
  const switchMirror = document.getElementById('switch-mirror');
  const switchPip = document.getElementById('switch-pip');
  const switchAutoskip = document.getElementById('switch-autoskip');
  const valAutoskip = document.getElementById('val-autoskip');
  const valShare = document.getElementById('val-share');
  const speedBoostBadge = document.getElementById('speed-boost-badge');

  const modalEpisodesBackdrop = document.getElementById('modal-episodes-backdrop');
  const seasonSelect = document.getElementById('season-select');
  const episodesGrid = document.getElementById('episodes-grid');
  const episodesEmpty = document.getElementById('episodes-empty');
  const episodesHeaderSubtitle = document.getElementById('episodes-header-subtitle');
  const btnCloseEpisodes = document.getElementById('btn-close-episodes');

  const popoverServers = document.getElementById('popover-servers');
  const serversListContainer = document.getElementById('servers-list-container');

  const seekFeedbackLeft = document.getElementById('seek-feedback-left');
  const seekFeedbackRight = document.getElementById('seek-feedback-right');

  // --- Player State ---
  const state = {
    type: 'tv',
    tmdbId: '94605',
    season: 1,
    episode: 1,
    server: 'goldmine',
    // `?source=` pins one TMDB-Embed-API provider (manual source selection).
    pinnedSource: '',
    // movi-player engine state (Goldmine MKV / multi-audio playback).
    moviEl: null,
    moviScriptPromise: null,
    branding: 'LOL Embed',
    media: null,
    stream: null,
    segments: [],
    subtitles: [],
    audioTracks: [],
    qualities: [],
    servers: [],
    // What the player has learned about each server for the current episode:
    // { status: 'unknown'|'checking'|'ready'|'failed', sources: [url, ...] }.
    serverInfo: {},
    // A specific source the viewer picked before the server finished resolving.
    pendingSourceUrl: null,
    activeAudioId: '',
    preferredAudioLang: '',
    activeSubtitleId: 'off',
    preferredSubtitleLang: '',
    attachToken: 0,
    moviWatchdogTimer: null,
    // `?t=` / `?start=` offset; consumed by the first stream that attaches so
    // the next episode does not inherit it.
    startAt: 0,
    autoSkip: storageGet(AUTOSKIP_KEY) === '1',
    autoSkipped: new Set(),
    // Hold-to-fast-forward: { prevRate } while the picture is pressed.
    longPressBoost: null,
    lastSubtitleId: null,
    activeQualityId: 'auto',
    parsedCues: [],
    subtitleDelaySec: 0,
    aspectRatio: 'Fit',
    brightness: 100,
    mirror: false,
    playbackSpeed: 1,
    hlsInstance: null,
    // Logical source whose manifest is currently attached.  This differs from
    // activeHlsUrl when a proxy-to-direct fallback is used.
    activeHlsUrl: null,
    pendingAudioSelection: null,
    dashInstance: null,
    activeSkipSegment: null,
    isDraggingTimeline: false,
    scrubSeconds: 0,
    scrubSeekTimer: null,
    idleTimer: null,
    toastTimer: null,
    rafId: null,
    bufferingTimer: null,
    lastProgressSaveAt: 0,
    // Set while a *different* title/episode is being loaded so the outgoing
    // video's currentTime is never written under the incoming episode's key.
    progressLocked: false,
    hasPlaybackStarted: false,
    loadToken: 0,
    browseSeason: 1,
    seasonEpisodesCache: {},
    seasonFetchToken: 0,
    upNextTimer: null,
    upNextDeadline: 0,
    upNextTarget: null,
    pausedInfoTimer: null,
    loadingHideTimer: null,
    tipTimer: null,
    tipIndex: 0,
    // Host control API: only talk to this origin when the embed names it.
    hostOrigin: null,
    attachedStreamUrl: null,
    _triedStreamUrls: new Set(),
    _triedDirectUrls: new Set(),
    // One-shot: the next /api/resolve must bypass the backend cache (Retry,
    // manual server pick). Provider URLs expire, so replaying the cached
    // payload is what made "Retry" fail exactly like the first attempt.
    resolveFresh: false,
    // True only once the attached source actually reached the `playing` event,
    // so the servers popover never claims "Playing" while it is still connecting.
    activeSourceLive: false,
    // True once every candidate stream on every server has exhausted failover,
    // so the popover never marks the final dead source as Playing/Ready.
    allStreamsFailed: false
  };

  // --- Parse URL Path & Query Parameters (TMDB ID Only) ---
  function parseRouteParams() {
    const pathname = window.location.pathname;
    const params = new URLSearchParams(window.location.search);

    // Match /embed/tv/:tmdbId/:s/:e or /tv/:tmdbId/:s/:e
    const tvMatch = pathname.match(/\/(?:embed\/)?tv\/([^/]+)(?:\/(\d+))?(?:\/(\d+))?/i);
    // Match /embed/movie/:tmdbId or /movie/:tmdbId
    const movieMatch = pathname.match(/\/(?:embed\/)?movie\/([^/]+)/i);

    if (tvMatch) {
      state.type = 'tv';
      state.tmdbId = tvMatch[1];
      state.season = parseInt(tvMatch[2] || params.get('s') || params.get('season') || '1', 10);
      state.episode = parseInt(tvMatch[3] || params.get('e') || params.get('episode') || '1', 10);
    } else if (movieMatch) {
      state.type = 'movie';
      state.tmdbId = movieMatch[1];
      state.season = 1;
      state.episode = 1;
    } else {
      state.type = (params.get('type') || 'tv').toLowerCase() === 'movie' ? 'movie' : 'tv';
      state.tmdbId = params.get('tmdb') || params.get('id') || '94605';
      state.season = parseInt(params.get('s') || params.get('season') || '1', 10);
      state.episode = parseInt(params.get('e') || params.get('episode') || '1', 10);
    }
    if (!Number.isFinite(state.season) || state.season < 1) state.season = 1;
    if (!Number.isFinite(state.episode) || state.episode < 1) state.episode = 1;
    state.browseSeason = state.season;

    if (params.get('server')) {
      const rawServer = params.get('server').toLowerCase();
      state.server = rawServer;
    }
    // `?source=` pins one Goldmine provider (TMDB-Embed-API source id such as
    // `vidlink` or `dahmermovies`). The backend validates the slug; an invalid
    // value is ignored here already.
    if (params.get('source')) {
      const rawSource = params.get('source').toLowerCase();
      if (/^[a-z0-9]{3,24}$/.test(rawSource)) state.pinnedSource = rawSource;
    }
    if (params.get('branding')) state.branding = params.get('branding');
    const audioParam = params.get('audio') || params.get('lang') || '';
    if (audioParam) {
      const normalizedAudio = normalizeMoviLang(audioParam);
      if (normalizedAudio && normalizedAudio !== 'und') {
        state.preferredAudioLang = normalizedAudio;
        state.activeAudioId = normalizedAudio;
      } else {
        state.activeAudioId = String(audioParam).trim().toLowerCase();
      }
    }
    if (params.get('sub')) {
      // Subtitle ids are assigned by the API (`os-…`, `wyzie-…`), so a URL
      // preference is normalized to an ISO language code ('jpn' -> 'ja', 'spa' -> 'es').
      const normalizedSub = normalizeMoviLang(params.get('sub'));
      state.preferredSubtitleLang =
        normalizedSub && normalizedSub !== 'und'
          ? normalizedSub
          : params.get('sub').toLowerCase().slice(0, 2);
    }
    state.startAt = parseStartParam(params.has('t') ? params.get('t') : params.get('start'));
    if (params.has('autoskip')) {
      const autoskip = String(params.get('autoskip')).toLowerCase();
      state.autoSkip = !(autoskip === '0' || autoskip === 'false' || autoskip === 'off');
    }

    // Custom Accent Color (?color=e50914 or ?color=netflix)
    const colorParam = params.get('color');
    if (colorParam) {
      const colorMap = {
        netflix: '#e50914',
        red: '#e50914',
        yellow: '#eab308',
        blue: '#3b82f6',
        purple: '#a855f7',
        green: '#22c55e',
        pink: '#ec4899',
        orange: '#f97316'
      };
      const resolvedColor = colorMap[colorParam.toLowerCase()] ||
        (colorParam.startsWith('#') ? colorParam : `#${colorParam}`);
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(resolvedColor)) {
        document.documentElement.style.setProperty('--accent', resolvedColor);
        document.documentElement.style.setProperty('--accent-contrast', contrastColorFor(resolvedColor));
      }
    }

    if (params.get('back') === 'false' || params.get('back') === '0') {
      btnBack.classList.add('hidden');
    }

    // ?origin=https://host.example — the host page's origin. When present,
    // commands from any other origin are ignored and events are only
    // delivered there (recommended for watch-party / sync integrations).
    const originParam = params.get('origin');
    if (originParam) {
      try {
        const parsed = new URL(originParam);
        if (/^https?:$/.test(parsed.protocol)) state.hostOrigin = parsed.origin;
      } catch (_) {}
    }
  }

  // --- Format Seconds into M:SS or H:MM:SS ---
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- Show Toast Notification ---
  function showToast(message, durationMs = 3400) {
    playerToastText.textContent = message;
    playerToast.classList.add('is-visible');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      playerToast.classList.remove('is-visible');
    }, durationMs);
  }

  function hideToast() {
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = null;
    playerToast.classList.remove('is-visible');
  }

  // --- Emit postMessage to Parent Host ---
  // --- Host control API (postMessage), protocol 1 ---
  // Every event and every command response carries the same snapshot, so a
  // host never has to poll or merge: `state` is one of loading | ready |
  // playing | buffering | paused | ended | error, and buffering is *never*
  // reported as paused. See README "Host control API".
  const HOST_PROTOCOL_VERSION = 1;
  const HOST_SOURCE = 'lol-embed-player';
  const HOST_EVENT_TYPE = 'LOL_EMBED_PLAYER_EVENT';
  const HOST_COMMAND_TYPE = 'LOL_EMBED_PLAYER_COMMAND';
  const HOST_RESPONSE_TYPE = 'LOL_EMBED_PLAYER_RESPONSE';
  let hostBuffering = false;
  let lastHostState = null;

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function playbackState() {
    if (playerRoot.classList.contains('is-loading')) {
      return loadingOverlay.classList.contains('is-error') ? 'error' : 'loading';
    }
    if (video.ended) return 'ended';
    if (video.paused) return state.hasPlaybackStarted ? 'paused' : 'ready';
    if (hostBuffering || video.seeking || video.readyState < 3) return 'buffering';
    return 'playing';
  }

  function hostSnapshot() {
    const sources = state.stream ? sourcesFromStream(state.stream) : [];
    const attached = state.attachedStreamUrl;
    const idx = attached ? sources.indexOf(attached) : -1;
    const audio = state.audioTracks.find((a) => a.id === state.activeAudioId) || null;
    const subtitle = state.activeSubtitleId !== 'off' ? state.subtitles.find((t) => t.id === state.activeSubtitleId) || null : null;
    const playback = playbackState();
    return {
      protocol: HOST_PROTOCOL_VERSION,
      tmdbId: state.tmdbId,
      mediaType: state.type,
      season: state.type === 'tv' ? state.season : null,
      episode: state.type === 'tv' ? state.episode : null,
      title: state.media ? state.media.displayTitle : '',
      state: playback,
      paused: !!video.paused,
      buffering: playback === 'buffering',
      seeking: !!video.seeking,
      ended: !!video.ended,
      currentTime: video.currentTime || 0,
      // `duration` keeps its historical meaning (real duration, else the TMDB
      // runtime); `mediaDuration` is only ever the real one — use it for cut
      // detection.
      duration: getEffectiveDuration(),
      mediaDuration: hasRealDuration() ? video.duration : null,
      playbackRate: video.playbackRate || 1,
      volume: typeof video.volume === 'number' ? video.volume : 1,
      muted: !!video.muted,
      server: state.server,
      sourceIndex: idx >= 0 ? idx + 1 : null,
      // Same server + same source slot => same cut for everyone in a party.
      sourceId: state.stream && attached ? `${state.server}/${idx >= 0 ? idx + 1 : 0}` : null,
      // Changes whenever this client is attached to a different stream URL.
      sourceHash: attached ? fnv1a(attached) : null,
      audio: audio ? { id: audio.id, lang: audio.lang || null, label: audio.label || '' } : null,
      subtitle: subtitle ? { id: subtitle.id, lang: subtitle.lang || null, label: subtitle.label || '' } : null,
      fullscreen: isFullscreen()
    };
  }

  function postToHost(payload, targetWindow, targetOrigin) {
    try {
      const win = targetWindow || window.parent;
      if (!win) return;
      win.postMessage(payload, state.hostOrigin || targetOrigin || '*');
    } catch (_) {}
  }

  function emitHostEvent(eventName, data = {}) {
    postToHost({ source: HOST_SOURCE, type: HOST_EVENT_TYPE, event: eventName, ...hostSnapshot(), ...data });
  }

  // `statechange` fires once per transition of the derived state, so a host
  // can drive its whole UI from this single event.
  function emitStateChange() {
    const next = playbackState();
    if (next === lastHostState) return;
    const previousState = lastHostState;
    lastHostState = next;
    emitHostEvent('statechange', { previousState });
  }

  // Real media duration when known; TMDB runtime as a placeholder until then.
  function getEffectiveDuration() {
    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      return video.duration;
    }
    return (state.media && state.media.durationSec) || 0;
  }

  function hasRealDuration() {
    return !!(video.duration && isFinite(video.duration) && video.duration > 0);
  }

  // --- Watch progress persistence ---
  function progressKey(type, tmdbId, season, episode) {
    return `lol_embed_prog_${type}_${tmdbId}_${season}_${episode}`;
  }

  // Stored as JSON {t, d}; legacy entries were a bare number of seconds.
  function readProgress(type, tmdbId, season, episode) {
    const raw = storageGet(progressKey(type, tmdbId, season, episode));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'number') return { time: parsed, duration: 0 };
      if (parsed && typeof parsed === 'object') {
        return { time: Number(parsed.t) || 0, duration: Number(parsed.d) || 0 };
      }
    } catch (_) {
      const n = parseFloat(raw);
      if (isFinite(n)) return { time: n, duration: 0 };
    }
    return null;
  }

  function saveProgress(force = false) {
    if (state.progressLocked) return;
    const now = Date.now();
    if (!force && now - state.lastProgressSaveAt < 3000) return;
    const current = video.currentTime || 0;
    if (current <= 2) return;
    state.lastProgressSaveAt = now;
    const duration = hasRealDuration() ? video.duration : 0;
    storageSet(
      progressKey(state.type, state.tmdbId, state.season, state.episode),
      JSON.stringify({ t: Math.floor(current), d: Math.floor(duration) })
    );
  }

  // Treat anything past 95% as "finished": resume from the start next time.
  function isNearEnd(time, duration) {
    return duration > 0 && time >= duration * 0.95;
  }

  // --- Normalize Backend Metadata into UI State ---
  function normalizeMetadata(meta) {
    if (!meta) return null;
    const isTv = meta.type === 'tv' || meta.type === 'series';
    const baseTitle = meta.title || `TMDB #${state.tmdbId}`;
    const displayTitle = isTv
      ? `${baseTitle} S${meta.season || state.season}E${meta.episode || state.episode}`
      : baseTitle;

    const tags = [
      isTv ? 'Series' : 'Movie',
      ...(Array.isArray(meta.genres) ? meta.genres.slice(0, 2) : []),
      ...(meta.releaseYear ? [String(meta.releaseYear)] : [])
    ];

    const runtimeMin = Number(meta.runtime);
    const durationSec = runtimeMin > 0 ? runtimeMin * 60 : 0;
    const seasonNumbers = Array.isArray(meta.seasons)
      ? meta.seasons.map((s) => Number(s.season_number)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const totalSeasons = seasonNumbers.length > 0 ? Math.max(...seasonNumbers) : Math.max(1, state.season);

    const episodes = normalizeEpisodes(meta.episodes, meta, isTv ? (meta.season || state.season) : 1);

    // Artwork / facts for the connect and paused screens. Only http(s) image
    // URLs are ever written into `src` / `background-image`.
    const ratingNum = Number(meta.rating);
    return {
      ...meta,
      type: isTv ? 'tv' : 'movie',
      title: baseTitle,
      displayTitle,
      tags,
      genres: Array.isArray(meta.genres) ? meta.genres.filter((g) => typeof g === 'string' && g.trim()) : [],
      logo: isHttpUrl(meta.logo) ? meta.logo : null,
      backdrop: isHttpUrl(meta.backdrop) ? meta.backdrop : null,
      poster: isHttpUrl(meta.poster) ? meta.poster : null,
      tagline: typeof meta.tagline === 'string' ? meta.tagline.trim() : '',
      rating: Number.isFinite(ratingNum) && ratingNum > 0 ? Math.round(ratingNum * 10) / 10 : null,
      durationSec,
      totalSeasons,
      seasonNumbers,
      episodes
    };
  }

  function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);
  }

  function cssUrl(url) {
    return `url("${String(url).replace(/["\\\n\r]/g, (c) => `\\${c}`)}")`;
  }

  function normalizeEpisodes(list, meta, seasonNumber) {
    if (!Array.isArray(list)) return [];
    return list
      .map((ep) => ({
        episode: Number(ep.episode),
        season: Number(ep.season || seasonNumber),
        title: ep.title || `Episode ${ep.episode}`,
        airDate: ep.date || ep.airDate || '',
        runtime: ep.runtime ? `${ep.runtime}m` : '',
        still: ep.still || (meta && meta.backdrop) || '',
        overview: ep.overview || ''
      }))
      .filter((ep) => Number.isFinite(ep.episode))
      .sort((a, b) => a.episode - b.episode);
  }

  function serverDisplayName(serverId) {
    const match = state.servers.find((s) => s.id === serverId);
    if (match && match.name) return match.name;
    const id = String(serverId || 'server');
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  // --- Loading / error overlay ---
  // The connect screen: blurred backdrop, title logo, genres, a terminal-style
  // "CONNECTING TO <SERVER>_" status with a progress bar that advances per
  // phase (resolving -> stream picked -> playable), the server/source that
  // answered, and rotating usage tips. Shown on every load and server/source
  // change; `.is-error` turns the same screen into the failure state.
  const CONNECT_TIPS = [
    'Change playback speed in the player settings.',
    'Press S to skip an intro or recap the moment the button appears.',
    'Double-tap the left or right side of the picture to jump 15 seconds.',
    'Pick another server or source from the cloud menu at any time.',
    'Keyboard: Space plays, C toggles subtitles, M mutes, F goes full screen.',
    'Your position is saved — reopen this title to resume where you left off.'
  ];
  const PAUSED_INFO_DELAY_MS = 2000;

  function showConnectTip() {
    loadingTip.textContent = CONNECT_TIPS[state.tipIndex % CONNECT_TIPS.length];
    state.tipIndex += 1;
    // Restart the fade-in for the new tip.
    loadingTip.style.animation = 'none';
    void loadingTip.offsetWidth;
    loadingTip.style.animation = '';
  }

  function startConnectTips() {
    stopConnectTips();
    showConnectTip();
    state.tipTimer = setInterval(showConnectTip, 4500);
  }

  function stopConnectTips() {
    if (state.tipTimer) clearInterval(state.tipTimer);
    state.tipTimer = null;
  }

  function setConnectProgress(pct, creeping) {
    loadingProgressFill.classList.toggle('is-creeping', !!creeping);
    loadingProgressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  // "Goldmine / Source 02" once we know which source of which server is
  // being attached (`sourceIndex` is 0-based; negative hides the line).
  function setConnectSource(serverId, sourceIndex) {
    if (!(sourceIndex >= 0)) {
      loadingSourceLine.classList.add('hidden');
      return;
    }
    loadingSourceServer.textContent = serverDisplayName(serverId);
    loadingSourceLabel.textContent = `Source ${String(sourceIndex + 1).padStart(2, '0')}`;
    loadingSourceLine.classList.remove('hidden');
  }

  function cancelPendingLoadingHide() {
    if (state.loadingHideTimer) clearTimeout(state.loadingHideTimer);
    state.loadingHideTimer = null;
    loadingOverlay.classList.remove('is-leaving');
  }

  function showLoading(message) {
    cancelPendingLoadingHide();
    hidePausedInfo();
    loadingOverlay.classList.remove('hidden', 'is-error');
    loadingActions.classList.add('hidden');
    loadingStatusDetail.classList.add('hidden');
    loadingStatusDetail.textContent = '';
    // The blinking cursor replaces any trailing ellipsis.
    loadingStatusText.textContent = String(message || 'Connecting').replace(/[\s.…]+$/, '');
    loadingSourceLine.classList.add('hidden');
    loadingBranding.textContent = state.branding || '';
    renderScreenArtwork();
    playerRoot.classList.add('is-loading');
    hideBuffering();
    startConnectTips();
    // Progress: snap back to the start, then creep towards ~40% while the
    // stream resolves so the bar is never frozen at zero.
    loadingProgressFill.style.transition = 'none';
    setConnectProgress(6, false);
    void loadingProgressFill.offsetWidth;
    loadingProgressFill.style.transition = '';
    setConnectProgress(42, true);
    emitStateChange();
  }

  function hideLoading() {
    playerRoot.classList.remove('is-loading');
    stopConnectTips();
    emitStateChange();
    if (loadingOverlay.classList.contains('hidden') || state.loadingHideTimer) return;
    // Let the bar complete and the screen fade before it is removed.
    setConnectProgress(100, false);
    loadingOverlay.classList.add('is-leaving');
    state.loadingHideTimer = setTimeout(() => {
      state.loadingHideTimer = null;
      loadingOverlay.classList.add('hidden');
      loadingOverlay.classList.remove('is-error', 'is-leaving');
    }, 320);
  }

  function showLoadError(message, detail) {
    cancelPendingLoadingHide();
    hidePausedInfo();
    stopConnectTips();
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.classList.add('is-error');
    loadingStatusText.textContent = message;
    if (detail) {
      loadingStatusDetail.textContent = detail;
      loadingStatusDetail.classList.remove('hidden');
    } else {
      loadingStatusDetail.classList.add('hidden');
    }
    loadingActions.classList.remove('hidden');
    renderErrorServers();
    loadingBranding.textContent = state.branding || '';
    renderScreenArtwork();
    playerRoot.classList.add('is-loading');
    playerRoot.classList.remove('controls-idle');
    hideBuffering();
    // Find out which of the other servers actually work while the viewer
    // looks at the list.
    probeUnknownServers();
    emitStateChange();
  }

  // "Maybe change the server from below": every known server as a button
  // under the error message, with what we learned about it (✓ / — / ✕).
  // Provider names are never shown here either — only the server names.
  function renderErrorServers() {
    loadingServers.innerHTML = '';
    const servers = state.servers;
    loadingServers.classList.toggle('hidden', servers.length === 0);
    servers.forEach((srv) => {
      const info = serverInfoFor(srv.id);
      const status = STATE_ICONS[info.status] ? info.status : 'unknown';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `connect-server-btn is-${status}${srv.id === state.server ? ' is-current' : ''}`;
      btn.setAttribute('aria-label', `${srv.name}: ${STATE_LABELS[status]}${srv.id === state.server ? ' (current)' : ''}`);
      btn.innerHTML = `
        <span class="server-state is-${status}" aria-hidden="true">${STATE_ICONS[status]}</span>
        <span><span class="connect-server-name">${escapeHtml(srv.name)}</span><small>${escapeHtml(
          status === 'failed' ? 'Unavailable right now — tap to retry' : srv.description || ''
        )}</small></span>
      `;
      btn.addEventListener('click', () => {
        if (srv.id === state.server) {
          triedServers.clear();
          loadMediaBundle(true);
        } else {
          selectServer(srv.id);
        }
      });
      loadingServers.appendChild(btn);
    });
  }

  // Blurred backdrop + title logo (or the plain title) + genres shared by the
  // connect and paused screens. Re-run whenever metadata changes.
  function renderScreenArtwork() {
    const m = state.media;
    const art = m && (m.backdrop || m.poster);
    const background = art ? cssUrl(art) : 'none';
    loadingBackdrop.style.backgroundImage = background;
    pausedBackdrop.style.backgroundImage = background;
    setTitleLogo(loadingLogo, loadingTitleText, m);
    setTitleLogo(pausedLogo, pausedTitleText, m);
    loadingGenres.textContent = m && m.genres.length > 0 ? m.genres.slice(0, 3).join(' / ') : '';
  }

  function setTitleLogo(img, fallbackEl, m) {
    const title = m ? m.title : '';
    if (m && m.logo) {
      img.onerror = () => {
        img.classList.add('hidden');
        fallbackEl.textContent = title;
      };
      if (img.getAttribute('src') !== m.logo) img.setAttribute('src', m.logo);
      img.alt = title;
      img.classList.remove('hidden');
      fallbackEl.textContent = '';
      return;
    }
    img.onerror = null;
    img.removeAttribute('src');
    img.classList.add('hidden');
    fallbackEl.textContent = title;
  }

  // --- Paused screen ---
  // Two seconds after pausing with no interaction, the HUD gives way to the
  // title card (logo, tagline, facts, overview) over the blurred artwork. Any
  // pointer / key activity brings the controls back; resuming removes it.
  function canShowPausedInfo() {
    return (
      state.media !== null &&
      video.paused &&
      !video.ended &&
      state.hasPlaybackStarted &&
      !playerRoot.classList.contains('is-loading') &&
      !playerRoot.classList.contains('is-ended') &&
      !state.isDraggingTimeline &&
      !isAnyOverlayOpen()
    );
  }

  function schedulePausedInfo() {
    if (state.pausedInfoTimer) clearTimeout(state.pausedInfoTimer);
    state.pausedInfoTimer = null;
    if (!canShowPausedInfo()) return;
    state.pausedInfoTimer = setTimeout(() => {
      state.pausedInfoTimer = null;
      if (canShowPausedInfo()) showPausedInfo();
    }, PAUSED_INFO_DELAY_MS);
  }

  function showPausedInfo() {
    renderPausedInfo();
    pausedOverlay.classList.remove('hidden');
    pausedOverlay.setAttribute('aria-hidden', 'false');
    playerRoot.classList.add('is-paused-info');
  }

  function hidePausedInfo() {
    if (state.pausedInfoTimer) clearTimeout(state.pausedInfoTimer);
    state.pausedInfoTimer = null;
    if (!playerRoot.classList.contains('is-paused-info')) return;
    playerRoot.classList.remove('is-paused-info');
    pausedOverlay.classList.add('hidden');
    pausedOverlay.setAttribute('aria-hidden', 'true');
  }

  function renderPausedInfo() {
    const m = state.media;
    if (!m) return;
    const isTv = m.type === 'tv';
    const ep = isTv ? m.episodes.find((e) => e.episode === state.episode) : null;

    if (isTv) {
      pausedEpisode.textContent = `S${state.season} E${state.episode}${ep && ep.title ? ` · ${ep.title}` : ''}`;
      pausedEpisode.classList.remove('hidden');
    } else {
      pausedEpisode.textContent = '';
      pausedEpisode.classList.add('hidden');
    }

    pausedTagline.textContent = m.tagline || '';
    pausedTagline.classList.toggle('hidden', !m.tagline);

    const runtimeMin = ep && ep.runtime ? parseInt(ep.runtime, 10) : Number(m.runtime);
    const facts = [];
    if (m.releaseYear) facts.push({ text: String(m.releaseYear) });
    if (runtimeMin > 0) facts.push({ text: `${runtimeMin} min` });
    if (m.rating) facts.push({ text: m.rating.toFixed(1), rating: true });
    pausedMeta.innerHTML = facts
      .map((f, idx) => {
        const dot = idx > 0 ? '<span class="paused-meta-dot" aria-hidden="true">•</span>' : '';
        const body = f.rating
          ? `<span class="paused-meta-rating"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.1 8.6 22.2 9.3 16.9 14.1 18.4 21.1 12 17.5 5.6 21.1 7.1 14.1 1.8 9.3 8.9 8.6"></polygon></svg><span class="sr-only">Rating </span>${escapeHtml(f.text)}</span>`
          : `<span>${escapeHtml(f.text)}</span>`;
        return dot + body;
      })
      .join('');

    pausedGenres.innerHTML = m.genres
      .slice(0, 4)
      .map((g) => `<span class="media-tag-pill">${escapeHtml(g)}</span>`)
      .join('');

    pausedOverview.textContent = (ep && ep.overview) || m.overview || '';
  }

  // --- Compact layout ---
  // Small embeds get the title in the top bar, the transport in the centre of
  // the picture and a full-width timeline (see `.is-compact` in the CSS).
  const COMPACT_MAX_WIDTH = 720;
  const COMPACT_MAX_HEIGHT = 440;

  function applyCompactLayout() {
    const width = playerRoot.clientWidth;
    const height = playerRoot.clientHeight;
    if (!(width > 0 && height > 0)) return;
    playerRoot.classList.toggle('is-compact', width < COMPACT_MAX_WIDTH || height < COMPACT_MAX_HEIGHT);
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(applyCompactLayout).observe(playerRoot);
  } else {
    window.addEventListener('resize', applyCompactLayout);
  }

  function showBuffering() {
    if (!loadingOverlay.classList.contains('hidden')) return;
    if (state.bufferingTimer) return;
    state.bufferingTimer = setTimeout(() => {
      state.bufferingTimer = null;
      if (!video.paused && !video.ended && video.readyState < 3) {
        bufferingIndicator.classList.remove('hidden');
      }
    }, 350);
  }

  function hideBuffering() {
    if (state.bufferingTimer) {
      clearTimeout(state.bufferingTimer);
      state.bufferingTimer = null;
    }
    bufferingIndicator.classList.add('hidden');
  }

  // Same resolve URL for the main load and for server probes, so the backend
  // cache (and its domain telemetry) sees one request shape.
  function buildResolveUrl(serverId) {
    const parentDomain =
      (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) ||
      document.referrer ||
      window.location.origin;
    // Ask for the audio language/track the viewer last chose for this title, so
    // the backend answers with that cut instead of the default one.
    const prefs = readShowPrefs();
    const audioQuery =
      prefs.audio ||
      prefs.audioId ||
      state.preferredAudioLang ||
      state.activeAudioId ||
      '';
    return apiUrl(
      `/api/resolve/${state.type}/${encodeURIComponent(state.tmdbId)}?season=${state.season}&episode=${state.episode}&server=${encodeURIComponent(serverId)}&audio=${encodeURIComponent(audioQuery)}&parent=${encodeURIComponent(parentDomain)}${
        state.pinnedSource ? `&source=${encodeURIComponent(state.pinnedSource)}` : ''
      }${state.resolveFresh ? '&fresh=1' : ''}`
    );
  }

  function cloneAudioRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => (row && typeof row === 'object' ? Object.assign({}, row) : row)).filter(Boolean);
  }

  function applyPreferredSubtitleSelection() {
    const rememberedSub = String(readShowPrefs().sub || '').toLowerCase();
    const byLang = (lang) => {
      if (!lang) return null;
      const norm = normalizeMoviLang(lang);
      return state.subtitles.find((s) => s && normalizeMoviLang(s.lang) === norm) || null;
    };
    const preferredSub =
      (state.activeSubtitleId !== 'off' && state.subtitles.find((s) => s.id === state.activeSubtitleId)) ||
      (state.lastSubtitleId && state.subtitles.find((s) => s.id === state.lastSubtitleId)) ||
      (rememberedSub && rememberedSub !== 'off' && byLang(rememberedSub)) ||
      (rememberedSub !== 'off' && byLang(state.preferredSubtitleLang));
    if (preferredSub) {
      loadSubtitleTrack(preferredSub, { silent: true, remember: false });
    } else if (state.activeSubtitleId !== 'off' && state.activeSubtitleId !== 'custom-upload') {
      disableSubtitles({ remember: false });
    }
  }

  async function lazyRefreshSubtitlesIfEmpty(loadToken) {
    try {
      const res = await fetch(
        apiUrl(`/api/subtitles/${state.type}/${encodeURIComponent(state.tmdbId)}?season=${state.season}&episode=${state.episode}`)
      );
      if (!res.ok) return;
      const json = await res.json();
      if (loadToken !== state.loadToken || !json || !Array.isArray(json.tracks) || json.tracks.length === 0) return;
      const seenUrls = new Set(state.subtitles.map((s) => s && s.url).filter(Boolean));
      let added = false;
      json.tracks.forEach((sub) => {
        if (!sub || !sub.url) return;
        const absUrl = absolutizeApiUrl(sub.url);
        if (seenUrls.has(absUrl)) return;
        seenUrls.add(absUrl);
        state.subtitles.push(Object.assign({}, sub, { url: absUrl }));
        added = true;
      });
      if (added) {
        renderSubtitlesPopover();
        updateSettingsSummaryValues();
        if (state.activeSubtitleId === 'off') applyPreferredSubtitleSelection();
      }
    } catch (_) {}
  }

  // --- Load Media Bundle from Backend ---
  async function loadMediaBundle(preserveTime = false) {
    const savedTime = preserveTime ? video.currentTime : 0;
    const loadToken = ++state.loadToken;
    const requestedServer = state.server;
    if (!preserveTime) {
      state.progressLocked = true;
      // Sources differ per episode: forget what we learned about the servers.
      state.serverInfo = {};
      state.pendingSourceUrl = null;
    }
    if (!video.paused) video.pause();
    cancelUpNext();
    // A stale "Skip Intro" from the previous episode must not survive the switch.
    if (!preserveTime) clearActiveSkip();
    playerRoot.classList.remove('is-ended');
    showLoading(`Connecting to ${serverDisplayName(requestedServer)}`);
    // Nothing is attached while a new bundle loads (see hostSnapshot()).
    state.attachedStreamUrl = null;
    emitHostEvent('loadstart', { server: requestedServer });
    // First open: the upstream resolve can take seconds, while the TMDB
    // metadata is one cached call away. Fetch it in parallel so the connect
    // screen shows the artwork almost immediately.
    if (!state.media) prefetchArtwork(loadToken);

    let data = null;
    const wantFresh = state.resolveFresh;
    state.resolveFresh = false;
    try {
      const res = await fetch(buildResolveUrl(requestedServer), wantFresh ? { cache: 'no-store' } : undefined);
      try {
        data = await res.json();
      } catch (_) {
        data = null;
      }
      // A newer load (episode change, manual server switch) superseded this one.
      if (loadToken !== state.loadToken) return;

      // Make API-relative URLs playable when the API runs on another Worker.
      if (data) {
        absolutizeStreamPayload(data.stream);
        if (Array.isArray(data.subtitles)) {
          data.subtitles.forEach((sub) => {
            if (sub) sub.url = absolutizeApiUrl(sub.url);
          });
        }
      }

      if (data && data.metadata) {
        state.media = normalizeMetadata(data.metadata);
        if (state.media && state.media.type === 'tv') {
          state.seasonEpisodesCache[`${state.tmdbId}:${state.season}`] = state.media.episodes;
        }
        renderMetadataUI();
        state.browseSeason = state.season;
        renderEpisodesModal();
      }

      state.segments = normalizeSegments(data && data.segments);
      state.autoSkipped = new Set();
      state.subtitles = Array.isArray(data && data.subtitles) ? data.subtitles : [];
      // Goldmine payloads can carry subtitles from the providers themselves
      // (already wrapped in the backend proxy): merge them into the regular
      // subtitle list so the popover and the overlay renderer pick them up.
      if (data && data.stream && Array.isArray(data.stream.embeddedSubtitles)) {
        const seenSubUrls = new Set(state.subtitles.map((sub) => sub && sub.url).filter(Boolean));
        data.stream.embeddedSubtitles.forEach((sub) => {
          if (!sub || !sub.url || seenSubUrls.has(sub.url)) return;
          seenSubUrls.add(sub.url);
          state.subtitles.push({
            id: sub.id || `gm-sub-${state.subtitles.length}`,
            lang: sub.lang || 'und',
            label: sub.label || 'Embedded',
            url: absolutizeApiUrl(sub.url)
          });
        });
      }
      state.servers = ((data && data.servers) || [])
        .filter((s) => s && s.id && s.enabled !== false && (s.listed !== false || s.active))
        // The API already sorts by priority; sorting again keeps the UI correct
        // even if a cached/stale payload predates the current catalog order.
        .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
        .map((s) => ({
          ...s,
          description: s.badge || 'Production Stream Server'
        }));

      // A rebrand can remove or rename the server we are currently on. Never let
      // the player keep requesting an id that no longer exists in the catalog.
      if (state.servers.length > 0 && !state.servers.some((s) => s.id === state.server)) {
        state.server = state.servers[0].id;
      }

      learnServersFromPayload(data, requestedServer);
      renderSegmentedTimeline();
      renderSubtitlesPopover();
      renderServersPopover();
      updateNextEpisodeButton();

      if (!data || !res.ok || !data.ok || !data.stream || !data.stream.streamUrl) {
        const fallbackMsg = res.ok
          ? 'No upstream stream available on this server.'
          : `The stream service answered with HTTP ${res.status}.`;
        throw new Error((data && data.error) || fallbackMsg);
      }

      state.stream = data.stream;
      // Register BOTH the requested server and the server that actually answered
      // *before* switching state.server: otherwise `triedServers` only ever holds
      // the resolved id, the waterfall keeps handing the same two servers back to
      // each other and the player loops forever on "Switching to backup server".
      triedServers.add(requestedServer);
      if (data.stream.server) triedServers.add(data.stream.server);
      state.server = data.stream.server || state.server;
      state._triedStreamUrls = new Set();
      state._triedDirectUrls = new Set();
      state.activeSourceLive = false;
      state.allStreamsFailed = false;
      state.activeQualityId = 'auto';
      state.audioTracks = cloneAudioRows(data.stream.audioTracks);
      state.stream._initialAudioTracks = cloneAudioRows(state.audioTracks);
      state.qualities = (Array.isArray(data.stream.qualities) ? data.stream.qualities : [])
        .filter((q) => q && q.label)
        .map((q, idx) => ({
          id: String(q.label).toLowerCase() === 'auto' ? 'auto' : `q-${idx}`,
          label: q.label,
          height: q.height,
          bitrate: q.bitrate,
          levelIndex: Number.isInteger(q.levelIndex) ? q.levelIndex : undefined,
          url: q.url
        }));
      // HLS replaces this list with its real manifest levels while attached.
      // Keep the payload rows so a progressive fallback never inherits stale
      // HLS-only choices after a source switch.
      state.stream._initialQualities = state.qualities.map((quality) => ({ ...quality }));

      if (state.audioTracks.length > 0) {
        // Order: the language the viewer already picked for this title, then
        // `?audio=`/`?lang=`, then the track the backend says is playing.
        const prefs = readShowPrefs();
        const rememberedAudioLang = normalizeMoviLang(prefs.audio || '');
        const wantedLang =
          (rememberedAudioLang !== 'und' ? rememberedAudioLang : '') ||
          state.preferredAudioLang ||
          '';
        const rememberedTrack =
          (prefs.audioId && state.audioTracks.find((a) => a.id === prefs.audioId)) ||
          (wantedLang && state.audioTracks.find((a) => normalizeMoviLang(a.lang) === wantedLang)) ||
          null;
        const activeTrack =
          rememberedTrack ||
          (data.stream.activeAudioTrack && state.audioTracks.find((a) => a.id === data.stream.activeAudioTrack.id)) ||
          state.audioTracks.find((a) => a.default) ||
          state.audioTracks.find((a) => a.id === state.activeAudioId) ||
          state.audioTracks[0];
        if (activeTrack) {
          state.activeAudioId = activeTrack.id;
          const activeNorm = normalizeMoviLang(activeTrack.lang);
          if (activeNorm && activeNorm !== 'und' && wantedLang) {
            state.preferredAudioLang = activeNorm;
          }
        }
        // A remembered track that lives in its own file (sub vs dub streams)
        // must actually be the file that plays, as when it is picked from the menu.
        if (rememberedTrack && rememberedTrack.streamUrl && state.stream.streamUrl && !sameStreamReference(rememberedTrack.streamUrl, state.stream.streamUrl)) {
          applyAudioTrackSourceMetadata(rememberedTrack);
        }
      }

      renderAudioPopover();
      renderLangChips();
      renderServersPopover();
      updateSettingsSummaryValues();
      // The waterfall may have answered from another server than requested.
      loadingStatusText.textContent = `Connecting to ${serverDisplayName(state.server)}`;

      // Honour a source the viewer picked from the servers list, if this
      // server still offers it; otherwise start from the primary source.
      const sources = sourcesFromStream(state.stream);
      const targetStreamUrl =
        state.pendingSourceUrl && sources.includes(state.pendingSourceUrl) ? state.pendingSourceUrl : state.stream.streamUrl;
      state.pendingSourceUrl = null;
      setConnectSource(state.server, sources.indexOf(targetStreamUrl));
      setConnectProgress(72, false);
      await attachStreamToVideo(targetStreamUrl, savedTime, loadToken);

      applyPreferredSubtitleSelection();
      if (state.subtitles.length === 0) {
        lazyRefreshSubtitlesIfEmpty(loadToken);
      }

      emitHostEvent('ready', { title: state.media ? state.media.displayTitle : '' });
    } catch (err) {
      if (loadToken !== state.loadToken) return;
      // The backend tells us which server failed and why; surface that instead
      // of a generic failure with no next step. `data` is declared outside the
      // try block on purpose so this branch can read it.
      const apiData = data && (data.explanation || data.serverExplanation) ? data : null;
      const baseMsg = (err && err.message) || 'Stream unavailable — select another server.';
      // Nothing is playing from this server now: do not keep listing the
      // previous stream's sources as if they were.
      state.stream = null;
      state.attachedStreamUrl = null;
      state.audioTracks = [];
      renderLangChips();
      renderServersPopover();
      const detail = apiData
        ? [apiData.serverExplanation, apiData.explanation && apiData.requestedServer ? `${apiData.explanation} (${apiData.requestedServer})` : apiData.explanation]
            .filter(Boolean)
            .join(' ')
        : (state.servers.length > 1 ? 'Try another server from the list, or retry this one.' : '');
      showLoadError(baseMsg, detail);
      emitHostEvent('error', { error: baseMsg, serverExplanation: apiData ? apiData.serverExplanation : null });
    }
  }

  async function prefetchArtwork(loadToken) {
    try {
      const res = await fetch(
        apiUrl(`/api/info/${state.type}/${encodeURIComponent(state.tmdbId)}?season=${state.season}&episode=${state.episode}`)
      );
      const json = await res.json();
      const meta = json && json.metadata;
      // The resolve may have delivered the full metadata in the meantime.
      if (loadToken !== state.loadToken || state.media || !meta || !meta.title) return;
      state.media = normalizeMetadata({ ...meta, type: meta.type || state.type });
      renderMetadataUI();
    } catch (_) {
      /* best effort: the resolve response carries the same metadata */
    }
  }

  // --- Render Metadata (Title, Tags, Season/Episode Controls) ---
  function renderMetadataUI() {
    const m = state.media;
    if (!m) return;

    document.title = `${m.displayTitle} — ${state.branding}`;
    mediaTitleEl.textContent = m.displayTitle;
    mediaTitleEl.classList.remove('is-placeholder');
    topMediaTitle.textContent = m.displayTitle;
    renderScreenArtwork();

    mediaTagsEl.innerHTML = '';
    (m.tags || []).forEach((tag) => {
      const span = document.createElement('span');
      span.className = 'media-tag-pill';
      span.textContent = tag;
      mediaTagsEl.appendChild(span);
    });

    if (!hasRealDuration()) {
      timeDurationEl.textContent = formatTime(m.durationSec || 0);
    }

    const isTv = m.type === 'tv';
    btnEpisodes.classList.toggle('hidden', !isTv);
    btnNextEpisode.classList.toggle('hidden', !isTv);
  }

  // --- Skip segments (intro / recap / credits / preview) ---
  // The API sends `{ type, label, start, end }` in seconds; `end: null` means
  // "until the end of the media" (open-ended credits). Everything else is
  // dropped here so the render loop never has to re-validate.
  const SEGMENT_TYPES = ['intro', 'recap', 'outro', 'preview'];
  const SEGMENT_NOUNS = { intro: 'Intro', recap: 'Recap', outro: 'Credits', preview: 'Preview' };

  function normalizeSegments(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((seg) => {
        if (!seg || typeof seg !== 'object') return null;
        const start = Number(seg.start);
        const end = seg.end === null || seg.end === undefined ? null : Number(seg.end);
        if (!Number.isFinite(start) || start < 0) return null;
        if (end !== null && !(Number.isFinite(end) && end > start)) return null;
        const type = SEGMENT_TYPES.includes(seg.type) ? seg.type : 'intro';
        const label = typeof seg.label === 'string' && seg.label.trim() ? seg.label.trim() : '';
        return { type, label, start, end, source: seg.source || '' };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  /** Where a segment ends in seconds; open-ended segments run to the media end. */
  function segmentEndSeconds(seg) {
    if (seg && Number.isFinite(seg.end)) return seg.end;
    const total = getEffectiveDuration();
    return total > 0 ? total : Infinity;
  }

  // --- Render Segmented Timeline Track ---
  // Pieces come from the real skip segments. Without segment data the bar is
  // one continuous track — no invented chapters.
  function renderSegmentedTimeline() {
    timelineSegmentsBg.innerHTML = '';
    const total = getEffectiveDuration();
    const addPiece = (type, start, end) => {
      if (!(total > 0)) return;
      const widthPct = ((end - start) / total) * 100;
      if (widthPct <= 0.3) return;
      const piece = document.createElement('div');
      piece.className = `timeline-segment-piece${type ? ` is-${type}` : ''}`;
      piece.style.width = `${widthPct}%`;
      timelineSegmentsBg.appendChild(piece);
    };

    const segments = (state.segments || [])
      .map((s) => ({ ...s, end: segmentEndSeconds(s) }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
      .map((s) => ({ ...s, start: clamp(s.start, 0, total || s.end), end: total > 0 ? Math.min(s.end, total) : s.end }))
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);

    if (!(total > 0) || segments.length === 0) {
      const piece = document.createElement('div');
      piece.className = 'timeline-segment-piece';
      piece.style.width = '100%';
      timelineSegmentsBg.appendChild(piece);
      return;
    }

    let cursor = 0;
    segments.forEach((seg) => {
      if (seg.start > cursor) addPiece('', cursor, seg.start);
      addPiece(seg.type || '', Math.max(seg.start, cursor), seg.end);
      cursor = Math.max(cursor, seg.end);
    });
    if (cursor < total) addPiece('', cursor, total);
  }

  function unwrapProxiedTargetUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl) return '';
    try {
      const parsed = new URL(rawUrl, window.location.href);
      if (
        parsed.pathname.endsWith('/api/proxy') ||
        parsed.pathname.endsWith('/ts-proxy') ||
        (parsed.pathname === '/' && parsed.searchParams.has('url'))
      ) {
        return parsed.searchParams.get('url') || rawUrl;
      }
      return parsed.href;
    } catch (_) {
      return rawUrl;
    }
  }

  function canonicalStreamReference(value) {
    const raw = String(value || '');
    if (!raw) return '';
    const unwrapped = unwrapProxiedTargetUrl(raw);
    try { return new URL(unwrapped, window.location.href).href; } catch (_) { return unwrapped; }
  }

  function sameStreamReference(a, b) {
    const left = canonicalStreamReference(a);
    const right = canonicalStreamReference(b);
    return !!left && !!right && left === right;
  }

  function currentLogicalStreamUrl() {
    return (state.attachedStreamUrl || (state.stream && state.stream.streamUrl) || '');
  }

  function sourceMetaForUrl(url) {
    const metas = state.stream && state.stream.sourceMeta;
    if (!metas || typeof metas !== 'object') return null;
    if (metas[url]) return metas[url];
    const key = Object.keys(metas).find((candidate) => sameStreamReference(candidate, url));
    return key ? metas[key] : null;
  }

  function applyAudioTrackSourceMetadata(track) {
    if (!state.stream || !track || !track.streamUrl) return null;
    const meta = sourceMetaForUrl(track.streamUrl);
    state.stream.streamUrl = track.streamUrl;
    if (track.rawUrl) state.stream.rawUrl = track.rawUrl;
    if (!meta) return null;
    state.stream.format = meta.format || meta.container || state.stream.format;
    state.stream.engine = meta.engine === 'movi' ? 'movi' : undefined;
    state.stream.progressiveFormat = meta.engine === 'movi' ? meta.container : undefined;
    state.stream.moviHeaders = meta.moviHeaders;
    state.stream.embeddedSubtitles = meta.subtitles;
    return meta;
  }

  function classifyCandidateStream(streamUrl, isPrimary) {
    const stream = state.stream || {};
    const meta = sourceMetaForUrl(streamUrl);
    const innerUrl = unwrapProxiedTargetUrl(streamUrl);
    let innerPath = '';
    try {
      innerPath = new URL(innerUrl, window.location.href).pathname.toLowerCase();
    } catch (_) {
      innerPath = String(innerUrl || '').toLowerCase();
    }

    const isDash =
      !!(meta && meta.format === 'dash') ||
      /\.mpd(?:$|[?#&])/i.test(streamUrl) ||
      /\.mpd(?:$|[?#&])/i.test(innerUrl) ||
      (isPrimary && stream.format === 'dash');

    const isHls =
      !isDash &&
      (!!(meta && meta.format === 'hls') ||
        /\.m3u8(?:$|[?#&])/i.test(streamUrl) ||
        /\.m3u8(?:$|[?#&])/i.test(innerUrl) ||
        /\/playlist\b|\/master\b/i.test(innerPath) ||
        (isPrimary && stream.format === 'hls'));

    const moviHeaders = meta
      ? meta.moviHeaders || null
      : isPrimary && stream.moviHeaders
        ? stream.moviHeaders
        : null;
    // Sources that need custom request headers must stay on movi-player: only
    // it can attach them (`headers` attribute), the native <video> cannot.
    const needsCustomHeaders = !!(moviHeaders && Object.keys(moviHeaders).length > 0);

    // `stream.engine` describes the PRIMARY source only: a per-URL `meta`
    // (and the extension check) decides for every other source, so an MP4
    // backup of an MKV primary is no longer dragged through the WASM demuxer.
    const useMovi =
      !isDash &&
      !isHls &&
      (needsCustomHeaders ||
        !!(meta && meta.engine === 'movi') ||
        /\.(?:mkv|webm|avi|mov|ts)(?:$|[?#&])/i.test(innerUrl) ||
        (isPrimary && stream.engine === 'movi'));

    return {
      isDash,
      isHls,
      useMovi,
      meta,
      moviHeaders,
      sourceSubtitles: meta && Array.isArray(meta.subtitles) ? meta.subtitles : null
    };
  }

  /**
   * Unwrap a `/api/proxy?url=...` stream to its raw upstream URL when direct
   * browser playback is safe to attempt (HTTPS anywhere, or HTTP on local test
   * origins) and has not already been tried for this load.
   */
  function directFallbackUrlFor(streamUrl, candidateInfo) {
    const rawStr = String(streamUrl || '');
    if (!/\/api\/proxy\?/.test(rawStr)) return null;
    const rawTarget = String(
      (candidateInfo && candidateInfo.meta && candidateInfo.meta.rawUrl) ||
        unwrapProxiedTargetUrl(rawStr) ||
        ''
    ).trim();
    if (!rawTarget || rawTarget === rawStr) return null;
    const allowHttp = window.location && window.location.protocol === 'http:';
    if (!(allowHttp ? /^https?:\/\//i.test(rawTarget) : /^https:\/\//i.test(rawTarget))) {
      return null;
    }
    if (state._triedDirectUrls && state._triedDirectUrls.has(rawTarget)) return null;
    return rawTarget;
  }

  /**
   * Two-byte Range probe against `/api/proxy` to distinguish "proxy delivered
   * real media bytes that <video> could not decode (HEVC/EAC3 -> escalate to
   * movi-player WASM)" from "upstream 403/502/timeout -> skip 12 MB WASM load".
   */
  async function probeProxiedMediaBytes(streamUrl) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 3500) : null;
    try {
      const probeUrl = `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}probe=1`;
      const res = await fetch(probeUrl, {
        headers: { Range: 'bytes=0-1' },
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {})
      });
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      try {
        if (res.body) await res.body.cancel();
      } catch (_) {}
      if (res.status !== 200 && res.status !== 206) return false;
      if (/^(?:text\/html|text\/plain|application\/json)/i.test(ct)) return false;
      return true;
    } catch (_) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function clearMoviWatchdog() {
    if (state.moviWatchdogTimer) {
      clearTimeout(state.moviWatchdogTimer);
      state.moviWatchdogTimer = null;
    }
  }

  function resetNativeVideoElement() {
    nativeVideo.onerror = null;
    nativeVideo.onloadedmetadata = null;
    try {
      if (!nativeVideo.paused) nativeVideo.pause();
    } catch (_) {}
    if (nativeVideo.hasAttribute('src') || nativeVideo.currentSrc) {
      nativeVideo.removeAttribute('src');
      try {
        nativeVideo.load();
      } catch (_) {}
    }
  }

  function prepareAudioRowsForSourceSwitch(nextUrl) {
    if (!state.stream || !Array.isArray(state.stream._initialAudioTracks)) return;
    const baseRows = cloneAudioRows(state.stream._initialAudioTracks);
    if (baseRows.length === 0) return;

    const currentActive = state.audioTracks.find((t) => t && t.id === state.activeAudioId);
    const wantedLang =
      (currentActive && normalizeMoviLang(currentActive.lang) !== 'und'
        ? normalizeMoviLang(currentActive.lang)
        : '') ||
      normalizeMoviLang(readShowPrefs().audio || '') ||
      state.preferredAudioLang ||
      '';
    const belongsToNext = (row) => row && (!row.streamUrl || sameStreamReference(row.streamUrl, nextUrl));
    const nextRows = baseRows.filter(belongsToNext);
    const pending = state.pendingAudioSelection;

    // Remove stale muxed-only rows discovered from a previous MKV while keeping
    // the full cross-source dub catalog ready for the newly attached source.
    // Prefer a row belonging to the new URL; a same-language row from the old
    // provider must not make the new HLS instance select a rendition by accident.
    state.audioTracks = baseRows;
    const match =
      (pending && nextRows.find((row) => row.id === pending.id)) ||
      (pending && Number.isInteger(pending.audioIndex) && nextRows.find((row) => row.audioIndex === pending.audioIndex)) ||
      (wantedLang && wantedLang !== 'und' && nextRows.find((row) => normalizeMoviLang(row.lang) === wantedLang)) ||
      nextRows.find((row) => row.default) ||
      nextRows[0] ||
      state.audioTracks.find((row) => row.default) ||
      state.audioTracks[0];
    if (match) state.activeAudioId = match.id;
    renderAudioPopover();
    renderLangChips();
    updateSettingsSummaryValues();
  }

  // --- Attach Stream via Movi (MKV/multi-audio) / HLS.js / Dash.js / Native Video ---
  async function attachStreamToVideo(streamUrl, resumeTime = 0, loadToken = 0) {
    const attachToken = ++state.attachToken;
    state.activeSourceLive = false;
    state.allStreamsFailed = false;
    clearMoviWatchdog();

    // Tear down any active movi custom element before configuring the next source.
    if (video !== nativeVideo || state.moviEl) detachMoviPlayer();
    nativeVideo.onerror = null;
    nativeVideo.onloadedmetadata = null;

    const sourceChanged = state.attachedStreamUrl !== streamUrl;
    state.attachedStreamUrl = streamUrl;
    hostBuffering = false;
    if (sourceChanged) emitHostEvent('sourcechange');
    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }
    state.activeHlsUrl = null;
    if (state.dashInstance) {
      try { state.dashInstance.reset(); } catch (_) {}
      state.dashInstance = null;
    }
    hideBuffering();

    const startParam = state.startAt > 0 ? state.startAt : 0;
    const saved = readProgress(state.type, state.tmdbId, state.season, state.episode);
    let savedProgress = saved ? saved.time : 0;
    if (saved && isNearEnd(saved.time, saved.duration)) savedProgress = 0;
    const targetStartTime = resumeTime > 0 ? resumeTime : (startParam > 0 ? startParam : savedProgress);

    // Re-checked against the real duration once it is known: a stale "resume"
    // position past the end would otherwise start the file on its last frame.
    const applyStartTime = () => {
      let t = targetStartTime;
      if (hasRealDuration() && isNearEnd(t, video.duration)) t = 0;
      if (t > 2) {
        try {
          video.currentTime = t;
        } catch (_) {}
        if (resumeTime <= 0 && startParam <= 0) {
          showToast(`Resuming from ${formatTime(t)}`, 2200);
        }
      }
      // The `?t=` offset is a one-shot: later attaches resume from progress.
      if (startParam > 0) state.startAt = 0;
    };

    // Track which URLs the fallback ladder already burned through this session.
    if (!state.stream) state.stream = {};
    if (!Array.isArray(state.stream.backupUrls)) state.stream.backupUrls = [];
    if (!state._triedStreamUrls) state._triedStreamUrls = new Set();
    if (!state._triedDirectUrls) state._triedDirectUrls = new Set();
    if (!state.stream._primaryStreamUrl) state.stream._primaryStreamUrl = state.stream.streamUrl || streamUrl;
    state._triedStreamUrls.add(streamUrl);
    if (state.stream.streamUrl !== streamUrl) state.stream.streamUrl = streamUrl;
    if (!popoverServers.classList.contains('hidden')) renderServersPopover();

    // Walk the resolved backup ladder before declaring the server dead.
    const tryNextBackupStream = (fromTime = 0) => {
      if (attachToken !== state.attachToken) return true;
      const backups = Array.isArray(state.stream && state.stream.backupUrls)
        ? state.stream.backupUrls
        : [];
      const qualityUrls = Array.isArray(state.qualities)
        ? state.qualities.map((quality) => quality && quality.url).filter(Boolean)
        : [];
      const candidates = [...new Set([...backups, ...qualityUrls])];
      for (const candidate of candidates) {
        if (!candidate || state._triedStreamUrls.has(candidate)) continue;
        const quality = state.qualities.find((item) => item.url === candidate);
        if (quality) {
          state.activeQualityId = quality.id;
          updateSettingsSummaryValues();
        }
        const sourceList = sourcesFromStream(state.stream);
        const nextIdx = sourceList.indexOf(candidate);
        if (nextIdx >= 0 && !loadingOverlay.classList.contains('hidden')) {
          setConnectSource(state.server, nextIdx);
          setConnectProgress(74, false);
        }
        prepareAudioRowsForSourceSwitch(candidate);
        showToast(
          quality
            ? `Switching to ${quality.label} fallback...`
            : nextIdx >= 0
              ? `Switching to Source ${String(nextIdx + 1).padStart(2, '0')}...`
              : 'Switching to backup stream mirror...',
          2200
        );
        attachStreamToVideo(candidate, fromTime, loadToken || state.loadToken);
        return true;
      }
      return false;
    };

    const isDeclaredPrimaryUrl = streamUrl === state.stream._primaryStreamUrl;
    const candidateInfo = classifyCandidateStream(streamUrl, isDeclaredPrimaryUrl);
    if (candidateInfo.meta && candidateInfo.meta.rawUrl) state.stream.rawUrl = candidateInfo.meta.rawUrl;

    if (!candidateInfo.isHls && Array.isArray(state.stream._initialQualities)) {
      state.qualities = state.stream._initialQualities.map((quality) => ({ ...quality }));
      const currentQuality = state.qualities.find(
        (quality) => quality.url && sameStreamReference(quality.url, streamUrl)
      );
      state.activeQualityId = currentQuality ? currentQuality.id : 'auto';
      updateSettingsSummaryValues();
    }

    if (Array.isArray(candidateInfo.sourceSubtitles) && candidateInfo.sourceSubtitles.length > 0) {
      const seenSubUrls = new Set(state.subtitles.map((s) => s && s.url).filter(Boolean));
      let addedSubs = false;
      candidateInfo.sourceSubtitles.forEach((sub) => {
        if (!sub || !sub.url || seenSubUrls.has(sub.url)) return;
        seenSubUrls.add(sub.url);
        state.subtitles.push({
          id: sub.id || `gm-sub-${state.subtitles.length}`,
          lang: sub.lang || 'und',
          label: sub.label || 'Embedded',
          url: absolutizeApiUrl(sub.url)
        });
        addedSubs = true;
      });
      if (addedSubs) renderSubtitlesPopover();
    }

    // --- Movi engine (Goldmine MKV / multi-audio files) ----------------------
    // Progressive containers the browser cannot decode (MKV/HEVC/AV1/EAC3) and
    // files with several muxed dubs play through the bundled movi-player
    // element instead of the native <video>. Streaming sources (HLS/DASH —
    // even when wrapped in /api/proxy) stay on hls.js / dash.js below.
    if (candidateInfo.useMovi) {
      let moviReady = !!(window.customElements && customElements.get('movi-player'));
      if (!moviReady) {
        if (!loadingOverlay.classList.contains('hidden')) {
          loadingStatusText.textContent = `Loading ${serverDisplayName(state.server)} Engine`;
          setConnectProgress(78, false);
        }
        try {
          await ensureMoviPlayer();
          moviReady = !!(window.customElements && customElements.get('movi-player'));
        } catch (_) {
          moviReady = false; // script blocked/offline: try native <video> / backups
        }
      }
      // A newer load or source switch may have superseded the download.
      if ((loadToken && loadToken !== state.loadToken) || attachToken !== state.attachToken) return;
      if (!loadingOverlay.classList.contains('hidden')) {
        loadingStatusText.textContent = `Connecting to ${serverDisplayName(state.server)}`;
        setConnectProgress(84, false);
      }
      if (moviReady) {
        attachMoviStream(
          streamUrl,
          targetStartTime,
          applyStartTime,
          tryNextBackupStream,
          attachToken,
          candidateInfo
        );
        return;
      }
    }

    if (candidateInfo.isDash && window.dashjs) {
      const player = window.dashjs.MediaPlayer().create();
      state.dashInstance = player;
      player.initialize(video, streamUrl, true);
      player.on('canPlay', () => {
        if (attachToken !== state.attachToken) return;
        hideLoading();
        applyStartTime();
      });
      const dashErrorEvent = window.dashjs.MediaPlayer.events && window.dashjs.MediaPlayer.events.ERROR;
      if (dashErrorEvent) {
        player.on(dashErrorEvent, (event) => {
          if (attachToken !== state.attachToken) return;
          if (!event || (!event.fatal && !event.error && !event.event)) return;
          try { player.reset(); } catch (_) {}
          state.dashInstance = null;
          if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
          handleFatalStreamError();
        });
      }
      video.onerror = () => {
        if (attachToken !== state.attachToken) return;
        if (state.dashInstance) {
          try { state.dashInstance.reset(); } catch (_) {}
        }
        state.dashInstance = null;
        if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
        handleFatalStreamError();
      };
      return;
    }

    if (window.Hls && window.Hls.isSupported() && candidateInfo.isHls) {
      const attachHlsUrl = (activeHlsUrl) => {
        state.activeHlsUrl = activeHlsUrl;
        const hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: false
        });
        state.hlsInstance = hls;
        let networkRecoveries = 0;
        let mediaRecoveries = 0;

        hls.loadSource(activeHlsUrl);
        hls.attachMedia(video);

        hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
          if (attachToken !== state.attachToken) return;
          hideLoading();

          // Build the visible quality menu from the actual master playlist,
          // not the resolver's initial (often single) HLS row.
          syncHlsQualityLevels(hls, data && data.levels);

          // Merge any real HLS multi-audio tracks discovered in the manifest
          if (hls.audioTracks && hls.audioTracks.length > 0) {
            syncHlsAudioTracks();
          }

          applyStartTime();
          applyRememberedQuality();

          video.play().catch((error) => {
            if (attachToken !== state.attachToken) return;
            // Autoplay denial is recoverable, but an unsupported HLS decode can use the next quality/mirror.
            if (error && error.name === 'NotSupportedError') {
              if (!tryNextBackupStream(video.currentTime || targetStartTime || 0)) {
                handleFatalStreamError();
              }
            }
          });
        });

        if (window.Hls.Events.AUDIO_TRACKS_UPDATED) {
          hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => {
            if (attachToken !== state.attachToken) return;
            syncHlsAudioTracks();
          });
        }

        if (window.Hls.Events.LEVELS_UPDATED) {
          hls.on(window.Hls.Events.LEVELS_UPDATED, (_, data) => {
            if (attachToken !== state.attachToken) return;
            syncHlsQualityLevels(hls, data && data.levels);
          });
        }

        hls.on(window.Hls.Events.ERROR, (_, errData) => {
          if (attachToken !== state.attachToken || !errData) return;
          if (errData.fatal) {
            const types = window.Hls.ErrorTypes || {};
            const details = window.Hls.ErrorDetails || {};
            const isManifestFailure =
              errData.details === details.MANIFEST_LOAD_ERROR ||
              errData.details === details.MANIFEST_LOAD_TIMEOUT ||
              errData.details === details.MANIFEST_PARSING_ERROR;
            // Standard hls.js recovery before burning a mirror: one reload for a
            // mid-stream network drop, one decoder reset for a media error.
            if (errData.type === types.NETWORK_ERROR && !isManifestFailure && networkRecoveries < 1) {
              networkRecoveries += 1;
              showBuffering();
              hls.startLoad();
              return;
            }
            if (errData.type === types.MEDIA_ERROR && mediaRecoveries < 1) {
              mediaRecoveries += 1;
              hls.recoverMediaError();
              return;
            }
            hls.destroy();
            if (state.hlsInstance === hls) state.hlsInstance = null;
            if (isManifestFailure && !/[?&](?:referer|cookie)=/i.test(activeHlsUrl)) {
              const directHls = directFallbackUrlFor(activeHlsUrl, candidateInfo);
              if (directHls) {
                state._triedDirectUrls.add(directHls);
                attachHlsUrl(directHls);
                return;
              }
            }
            if (tryNextBackupStream(video.currentTime || 0)) return;
            handleFatalStreamError();
          }
        });
      };
      attachHlsUrl(streamUrl);
      return;
    }

    // Native HLS (Safari/iOS) or direct MP4 CDN playback
    const attachNativeUrl = (activeSrcUrl) => {
      video.src = activeSrcUrl;
      video.onloadedmetadata = () => {
        if (attachToken !== state.attachToken) return;
        hideLoading();
        syncNativeAudioTracks();
        applyStartTime();
        video.play().catch((error) => {
          if (attachToken !== state.attachToken) return;
          if (error && error.name === 'NotSupportedError') {
            if (retryWithMoviIfPossible(activeSrcUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo)) return;
            if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
            handleFatalStreamError();
          }
        });
      };
      video.onerror = () => {
        if (attachToken !== state.attachToken) return;
        const mediaErrCode = video.error && video.error.code;
        if (/\/api\/proxy\?/.test(activeSrcUrl)) {
          probeProxiedMediaBytes(activeSrcUrl).then((hasMediaBytes) => {
            if (attachToken !== state.attachToken) return;
            if (hasMediaBytes) {
              if (retryWithMoviIfPossible(activeSrcUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo)) return;
            } else {
              const directMp4 = directFallbackUrlFor(activeSrcUrl, candidateInfo);
              if (directMp4) {
                state._triedDirectUrls.add(directMp4);
                attachNativeUrl(directMp4);
                return;
              }
            }
            if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
            handleFatalStreamError();
          });
          return;
        }
        // On a direct URL, only escalate an explicit MP4 to the 12 MB WASM
        // demuxer when bytes arrived and failed to decode (MEDIA_ERR_DECODE = 3).
        const isKnownMp4 = candidateInfo && candidateInfo.meta && candidateInfo.meta.container === 'mp4';
        if (!isKnownMp4 || mediaErrCode === 3) {
          if (retryWithMoviIfPossible(activeSrcUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo)) return;
        }
        if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
        handleFatalStreamError();
      };
      video.load();
    };
    attachNativeUrl(streamUrl);
  }

  // --- Movi-player integration (Goldmine MKV / multi-audio engine) -----------
  // movi-player is an ES-module WebCodecs/FFmpeg-WASM custom element (`element.js`
  // uses `import.meta.url` + `export`), so it MUST load via `<script type="module">`
  // and wait for `customElements.whenDefined('movi-player')` before attaching.

  const MOVI_LOAD_TIMEOUT_MS = 25000;
  const MOVI_CONNECT_TIMEOUT_MS = 18000;

  function ensureMoviPlayer() {
    if (window.customElements && customElements.get('movi-player')) return Promise.resolve(true);
    if (!state.moviScriptPromise) {
      state.moviScriptPromise = new Promise((resolve, reject) => {
        if (!window.customElements) {
          state.moviScriptPromise = null;
          reject(new Error('CustomElements API unavailable'));
          return;
        }
        let settled = false;
        const script = document.createElement('script');
        script.type = 'module';
        script.crossOrigin = 'anonymous';
        script.src = '/vendor/movi/element.js';
        script.async = true;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          state.moviScriptPromise = null;
          try { if (script.parentNode) script.parentNode.removeChild(script); } catch (_) {}
          reject(new Error('movi-player module load timed out'));
        }, MOVI_LOAD_TIMEOUT_MS);

        const finishOk = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        };
        const finishErr = (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.moviScriptPromise = null;
          try { if (script.parentNode) script.parentNode.removeChild(script); } catch (_) {}
          reject(new Error(reason || 'movi-player failed to load'));
        };

        if (typeof customElements.whenDefined === 'function') {
          customElements.whenDefined('movi-player').then(finishOk).catch(() => {});
        }
        script.onload = () => {
          if (customElements.get('movi-player')) {
            finishOk();
            return;
          }
          if (typeof customElements.whenDefined === 'function') {
            customElements
              .whenDefined('movi-player')
              .then(finishOk)
              .catch(() => finishErr('movi-player failed to register'));
          } else {
            finishErr('movi-player custom element did not register');
          }
        };
        script.onerror = () => finishErr('movi-player script failed to fetch');
        document.head.appendChild(script);
      });
    }
    return state.moviScriptPromise;
  }

  function detachMoviPlayer() {
    clearMoviWatchdog();
    const el = state.moviEl;
    state.moviEl = null;
    if (el) {
      // Preserve volume/mute changes made while movi-player was active.
      try {
        if (typeof el.volume === 'number' && Number.isFinite(el.volume)) nativeVideo.volume = el.volume;
        if (typeof el.muted === 'boolean') nativeVideo.muted = el.muted;
      } catch (_) {}
      // Remove all listeners BEFORE pause/dispose so teardown never fires stale UI events.
      if (Array.isArray(el._lolHandlers)) {
        el._lolHandlers.forEach(([type, fn]) => el.removeEventListener(type, fn));
        el._lolHandlers = null;
      }
      if (Array.isArray(el._lolMediaHandlers)) {
        el._lolMediaHandlers.forEach(({ type, handler, opts }) => el.removeEventListener(type, handler, opts));
        el._lolMediaHandlers = null;
      }
      video = nativeVideo;
      try { el.pause(); } catch (_) {}
      try {
        if (typeof el.dispose === 'function') el.dispose();
      } catch (_) {}
      if (el.parentNode) el.parentNode.removeChild(el);
    } else {
      video = nativeVideo;
    }
    moviMount.classList.add('hidden');
    playerRoot.classList.remove('movi-mode');
  }

  /** A native attach that failed on a progressive file (MKV the browser cannot
   *  demux) gets one movi-player attempt before the backup ladder runs. */
  function retryWithMoviIfPossible(streamUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo) {
    if (video === state.moviEl) return false; // movi itself already failed
    if (candidateInfo && (candidateInfo.isHls || candidateInfo.isDash)) return false;
    if (/\.m3u8(?:$|[?#&])/i.test(streamUrl) || /\.mpd(?:$|[?#&])/i.test(streamUrl)) return false;
    if (window.customElements && customElements.get('movi-player')) {
      attachMoviStream(streamUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo);
      return true;
    }
    ensureMoviPlayer()
      .then(() => {
        if (attachToken !== state.attachToken) return;
        attachMoviStream(streamUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo);
      })
      .catch(() => {
        if (attachToken !== state.attachToken) return;
        if (!tryNextBackupStream(targetStartTime || 0)) handleFatalStreamError();
      });
    return true;
  }

  function attachMoviStream(streamUrl, targetStartTime, applyStartTime, tryNextBackupStream, attachToken, candidateInfo) {
    // Always start with a clean MoviElement so previous probe/error flags never leak;
    // the compiled FFmpeg WASM module is cached globally inside element.js.
    if (state.moviEl || moviMount.querySelector('movi-player')) {
      detachMoviPlayer();
    }
    resetNativeVideoElement();

    const el = document.createElement('movi-player');
    // Headless + automatic WebCodecs->WASM software fallback (`sw="auto"`) for
    // mobile/desktop GPUs that refuse HEVC 10-bit / AV1 hardware decode.
    el.setAttribute('nohotkeys', '');
    el.setAttribute('nolinkwarning', '');
    el.setAttribute('smoothwarning', 'false');
    el.setAttribute('sw', 'auto');
    el.setAttribute('playsinline', '');
    el.setAttribute('preload', 'auto');
    // Custom error slot suppresses Movi's internal Shadow DOM broken-screen UI.
    const errSlot = document.createElement('div');
    errSlot.setAttribute('slot', 'error');
    errSlot.hidden = true;
    el.appendChild(errSlot);

    moviMount.appendChild(el);
    el._lolMediaHandlers = mediaListenerRegistry.slice();
    el._lolMediaHandlers.forEach(({ type, handler, opts }) => el.addEventListener(type, handler, opts));

    // Swap the active media element BEFORE anything reads or writes `video`.
    state.moviEl = el;
    video = el;
    moviMount.classList.remove('hidden');
    playerRoot.classList.add('movi-mode');

    // Carry the viewer's settings over from the native element/state.
    try {
      el.volume = nativeVideo.volume;
      el.muted = nativeVideo.muted;
      el.playbackRate = state.playbackSpeed || 1;
    } catch (_) {}
    applyMediaTransforms();

    const moviHeaders = candidateInfo && candidateInfo.moviHeaders ? candidateInfo.moviHeaders : null;
    if (moviHeaders && typeof moviHeaders === 'object' && Object.keys(moviHeaders).length > 0) {
      el.setAttribute('headers', JSON.stringify(moviHeaders));
    } else {
      el.removeAttribute('headers');
    }

    let settled = false;
    const failOverOnce = () => {
      if (settled || attachToken !== state.attachToken) return;
      settled = true;
      clearMoviWatchdog();
      // If /api/proxy failed (e.g. Worker-to-Worker 1042/403 on p.111477.xyz,
      // Pixeldrain, R2, or workers.dev), try the open-CORS raw URL directly in
      // movi-player before abandoning this MKV source.
      const directMoviUrl = directFallbackUrlFor(streamUrl, candidateInfo);
      if (directMoviUrl) {
        state._triedDirectUrls.add(directMoviUrl);
        attachMoviStream(
          directMoviUrl,
          targetStartTime,
          applyStartTime,
          tryNextBackupStream,
          attachToken,
          candidateInfo
        );
        return;
      }
      const resumeAt = (video && video.currentTime) || targetStartTime || 0;
      if (tryNextBackupStream(resumeAt)) return;
      handleFatalStreamError();
    };

    const logMoviFailure = (event, kind) => {
      if (!PLAYER_DEBUG) return;
      console.error(`[LOL Embed] movi ${kind}`, {
        detail: event && event.detail,
        mediaError: el.error || null,
        readyState: el.readyState,
        networkState: el.networkState,
        container: candidateInfo && candidateInfo.meta && candidateInfo.meta.container
      });
    };
    const onError = (event) => {
      logMoviFailure(event, 'error');
      failOverOnce();
    };
    const onErrorDisplay = (event) => {
      logMoviFailure(event, 'error display');
      failOverOnce();
    };
    const onLoadedMetadata = () => {
      if (attachToken !== state.attachToken) return;
      settled = true;
      clearMoviWatchdog();
      hideLoading();
      applyStartTime();
      syncMoviAudioTracks();
      syncMoviSubtitleTracks();
      if (state.activeSubtitleId === 'off') {
        applyPreferredSubtitleSelection();
      }

      // Switch to the viewer's preferred/active muxed audio track in-place.
      const prefs = readShowPrefs();
      const wantedLang =
        normalizeMoviLang(
          (state.audioTracks.find((t) => t && t.id === state.activeAudioId) || {}).lang ||
            prefs.audio ||
            state.preferredAudioLang ||
            ''
        );
      const wanted =
        state.audioTracks.find((t) => t && t.inFile && t.id === state.activeAudioId) ||
        (wantedLang && wantedLang !== 'und'
          ? state.audioTracks.find((t) => t && t.inFile && normalizeMoviLang(t.lang) === wantedLang)
          : null);
      if (wanted) {
        state.activeAudioId = wanted.id;
        selectMoviAudioTrack(wanted);
        renderAudioPopover();
        renderLangChips();
        updateSettingsSummaryValues();
      }

      // Keep Movi's internal subtitle renderer off unless an embedded MKV subtitle is explicitly chosen.
      const activeSub = state.subtitles.find((s) => s && s.id === state.activeSubtitleId);
      if (activeSub && Number.isInteger(activeSub.moviSubTrackId)) {
        try { el.pickSubtitleTrack(activeSub.moviSubTrackId); } catch (_) {}
      } else if (typeof el.pickSubtitleTrack === 'function') {
        try { el.pickSubtitleTrack(null); } catch (_) {}
      }

      if (typeof el.play === 'function') {
        el.play().catch((error) => {
          if (attachToken !== state.attachToken) return;
          if (PLAYER_DEBUG) console.error('[LOL Embed] movi play() rejected', error);
          if (error && error.name === 'NotSupportedError') failOverOnce();
        });
      }
    };

    el.addEventListener('error', onError);
    el.addEventListener('errordisplay', onErrorDisplay);
    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el._lolHandlers = [
      ['error', onError],
      ['errordisplay', onErrorDisplay],
      ['loadedmetadata', onLoadedMetadata]
    ];

    // Startup watchdog: if an upstream CDN hangs or returns non-media bytes
    // without firing metadata/error, advance smoothly to the next backup source.
    clearMoviWatchdog();
    state.moviWatchdogTimer = setTimeout(() => {
      if (!settled && attachToken === state.attachToken && (!el.readyState || el.readyState < 1)) {
        failOverOnce();
      }
    }, MOVI_CONNECT_TIMEOUT_MS);

    el.setAttribute('src', streamUrl);
  }

  /**
   * Read muxed MKV/MP4 audio tracks from `el.player.getAudioTracks()` (falling
   * back to `el.getAudioLangs()` for split external audio) and merge them with
   * cross-file dub rows so every language in the container is one click away.
   */
  function syncMoviAudioTracks() {
    const el = state.moviEl;
    if (!el || !state.stream) return;

    let rawTracks = [];
    try {
      const muxed =
        el.player && typeof el.player.getAudioTracks === 'function'
          ? el.player.getAudioTracks()
          : null;
      if (Array.isArray(muxed) && muxed.length > 0) {
        const activeMuxed =
          el.player &&
          el.player.trackManager &&
          typeof el.player.trackManager.getActiveAudioTrack === 'function'
            ? el.player.trackManager.getActiveAudioTrack()
            : null;
        const activeId = activeMuxed && activeMuxed.id != null ? activeMuxed.id : muxed[0].id;
        rawTracks = muxed.map((mt, idx) => {
          const trackId = Number.isInteger(mt.id) ? mt.id : idx;
          const rawLang = mt.language || mt.lang || '';
          const normFromCode = normalizeMoviLang(rawLang);
          const inferred = normFromCode !== 'und' ? normFromCode : inferLangFromTrackLabel(mt.label || mt.title || '');
          return {
            trackId,
            rawLang: rawLang || inferred,
            lang: inferred,
            rawLabel: String(mt.label || mt.title || '').trim(),
            channels: mt.channels || 0,
            active: trackId === activeId
          };
        });
      } else if (typeof el.getAudioLangs === 'function') {
        const ext = el.getAudioLangs() || [];
        rawTracks = ext.map((et, idx) => {
          const rawLang = (et && et.lang) || '';
          const normFromCode = normalizeMoviLang(rawLang);
          const inferred = normFromCode !== 'und' ? normFromCode : inferLangFromTrackLabel(et && et.label);
          return {
            trackId: null,
            rawLang,
            lang: inferred,
            rawLabel: String((et && et.label) || '').trim(),
            channels: 0,
            active: !!(et && et.active) || idx === 0
          };
        });
      }
    } catch (_) {
      return;
    }

    if (!Array.isArray(rawTracks) || rawTracks.length === 0) return;

    const currentUrl = currentLogicalStreamUrl();
    const currentMeta = sourceMetaForUrl(currentUrl);
    const currentRawUrl = (currentMeta && currentMeta.rawUrl) || state.stream.rawUrl || currentUrl;

    // Single untagged audio stream inside a language-specific dub file (e.g. a
    // dedicated Hindi dub file whose audio stream lacks an ISO tag): keep the
    // payload's known language row instead of overwriting it with "Audio 1".
    if (rawTracks.length === 1 && rawTracks[0].lang === 'und') {
      const sameUrlRows = state.audioTracks.filter((row) => row && sameStreamReference(row.streamUrl, currentUrl));
      if (sameUrlRows.length === 1) {
        sameUrlRows[0].inFile = true;
        if (Number.isInteger(rawTracks[0].trackId)) {
          sameUrlRows[0].moviTrackId = rawTracks[0].trackId;
        }
        renderAudioPopover();
        renderLangChips();
        updateSettingsSummaryValues();
        return;
      }
    }

    const langOccurrences = {};
    rawTracks.forEach((t) => {
      langOccurrences[t.lang] = (langOccurrences[t.lang] || 0) + 1;
    });
    const usedIds = new Set();
    const matchedExistingIds = new Set();

    const inFileRows = rawTracks.map((track, index) => {
      const lang = track.lang || 'und';
      // FFmpeg/movi sometimes exposes an explicitly Original track as just
      // "Audio 3" with LANGUAGE=und.  A generic demuxer label must not erase
      // the resolver's Original row; a meaningful non-Original label still
      // remains eligible for normal language inference above.
      const genericRawLabel = !track.rawLabel || /^(?:audio|track)[\s#-]*\d+$/i.test(track.rawLabel);
      const existing = state.audioTracks.find(
        (row) =>
          row &&
          !matchedExistingIds.has(row.id) &&
          sameStreamReference(row.streamUrl, currentUrl) &&
          ((lang !== 'und' && normalizeMoviLang(row.lang) === lang) ||
            (lang === 'und' && /original/i.test(String(row.label || '')) &&
              (genericRawLabel || /original/i.test(track.rawLabel))))
      );

      const baseLabel = lang !== 'und' ? langChipLabel(lang, index) : '';
      let displayLabel = baseLabel || track.rawLabel || langChipLabel(lang, index);
      if (langOccurrences[lang] > 1 && lang !== 'und') {
        if (track.rawLabel && track.rawLabel.toLowerCase() !== baseLabel.toLowerCase()) {
          displayLabel = `${baseLabel} · ${track.rawLabel}`;
        } else if (track.channels >= 6) {
          displayLabel = `${baseLabel} (5.1)`;
        } else {
          displayLabel = `${baseLabel} #${index + 1}`;
        }
      }

      if (existing) {
        matchedExistingIds.add(existing.id);
        usedIds.add(existing.id);
        return Object.assign({}, existing, {
          label: langOccurrences[lang] > 1 ? displayLabel : existing.label || displayLabel,
          inFile: true,
          moviLang: track.rawLang || lang,
          moviTrackId: track.trackId,
          default: existing.default || !!track.active
        });
      }

      let id = `goldmine-${lang === 'und' ? `track-${index}` : lang}`;
      if (usedIds.has(id)) id = `${id}-${index + 1}`;
      usedIds.add(id);

      return {
        id,
        lang,
        label: displayLabel,
        type: 'dub',
        streamUrl: currentUrl,
        rawUrl: currentRawUrl,
        inFile: true,
        moviLang: track.rawLang || lang,
        moviTrackId: track.trackId,
        default: !!track.active
      };
    });

    // Per-language rows that live in OTHER files survive the merge — picking
    // one of those loads its file and keeps the playhead.
    const otherFileRows = state.audioTracks.filter(
      (row) =>
        row &&
        row.streamUrl &&
        !sameStreamReference(row.streamUrl, currentUrl) &&
        !inFileRows.some((merged) => merged.lang !== 'und' && merged.lang === normalizeMoviLang(row.lang))
    );
    state.audioTracks = [...inFileRows, ...otherFileRows];

    const prefs = readShowPrefs();
    const preferredLang =
      normalizeMoviLang(prefs.audio || '') !== 'und'
        ? normalizeMoviLang(prefs.audio)
        : state.preferredAudioLang;
    const active =
      state.audioTracks.find((row) => row.id === state.activeAudioId) ||
      (preferredLang && preferredLang !== 'und'
        ? state.audioTracks.find((row) => row.inFile && normalizeMoviLang(row.lang) === preferredLang) ||
          state.audioTracks.find((row) => normalizeMoviLang(row.lang) === preferredLang)
        : null) ||
      state.audioTracks.find((row) => row.inFile && row.default) ||
      state.audioTracks.find((row) => row.default) ||
      state.audioTracks[0];
    if (active) state.activeAudioId = active.id;
    state.pendingAudioSelection = null;
    renderAudioPopover();
    renderLangChips();
    updateSettingsSummaryValues();
  }

  /** Expose muxed MKV subtitle tracks in the CC menu alongside external VTTs. */
  function syncMoviSubtitleTracks() {
    const el = state.moviEl;
    if (!el || !el.player || typeof el.player.getSubtitleTracks !== 'function') return;
    let muxedSubs = [];
    try {
      muxedSubs = el.player.getSubtitleTracks() || [];
    } catch (_) {
      return;
    }
    // Remove any stale embedded subtitle entries from an earlier MKV file first.
    state.subtitles = state.subtitles.filter((s) => !s || !Number.isInteger(s.moviSubTrackId));
    if (!Array.isArray(muxedSubs) || muxedSubs.length === 0) {
      renderSubtitlesPopover();
      return;
    }
    muxedSubs.forEach((ms, idx) => {
      const trackId = Number.isInteger(ms.id) ? ms.id : idx;
      const rawLang = ms.language || ms.lang || '';
      const normLang = normalizeMoviLang(rawLang) !== 'und'
        ? normalizeMoviLang(rawLang)
        : inferLangFromTrackLabel(ms.label || ms.title || '');
      const baseName = normLang !== 'und' ? langChipLabel(normLang, idx) : `Track ${idx + 1}`;
      const extra = ms.label && ms.label.toLowerCase() !== baseName.toLowerCase() ? ` · ${ms.label}` : '';
      state.subtitles.push({
        id: `movi-sub-${trackId}`,
        lang: normLang,
        label: `${baseName}${extra} (Embedded)`,
        moviSubTrackId: trackId
      });
    });
    renderSubtitlesPopover();
    updateSettingsSummaryValues();
  }

  function selectMoviAudioLang(moviLang) {
    if (!moviLang) return false;
    return selectMoviAudioTrack({ lang: moviLang, moviLang });
  }

  function selectMoviAudioTrack(track) {
    const el = state.moviEl;
    if (!el || !track) return false;
    try {
      // 1. Direct muxed track selection by demuxer track id (`0`, `1`, `2`, ...).
      if (Number.isInteger(track.moviTrackId) && typeof el.pickAudioTrack === 'function') {
        if (
          el.player &&
          typeof el.player.isNativeAudioActive === 'function' &&
          el.player.isNativeAudioActive() &&
          typeof el.player.useMuxedAudio === 'function'
        ) {
          el.player.useMuxedAudio().then(() => {
            try { el.pickAudioTrack(track.moviTrackId); } catch (_) {}
          }).catch(() => {});
          return true;
        }
        return !!el.pickAudioTrack(track.moviTrackId);
      }
      // 2. Match muxed track by language if `moviTrackId` was not resolved yet.
      if (el.player && typeof el.player.getAudioTracks === 'function' && typeof el.pickAudioTrack === 'function') {
        const muxed = el.player.getAudioTracks() || [];
        const wanted = normalizeMoviLang(track.moviLang || track.lang);
        if (wanted && wanted !== 'und' && muxed.length > 0) {
          const hit = muxed.find((mt) => {
            const code = normalizeMoviLang(mt.language || mt.lang);
            const fromTitle = code !== 'und' ? code : inferLangFromTrackLabel(mt.label || mt.title || '');
            return fromTitle === wanted;
          });
          if (hit && Number.isInteger(hit.id)) {
            track.moviTrackId = hit.id;
            return !!el.pickAudioTrack(hit.id);
          }
        }
      }
      // 3. Fallback: external split-audio track switching (`getAudioLangs` / `selectAudioLang`).
      const moviLang = track.moviLang || track.lang;
      if (moviLang && typeof el.selectAudioLang === 'function') {
        return !!el.selectAudioLang(moviLang);
      }
    } catch (_) {
      return false;
    }
    return false;
  }

  /** Sync native HTMLMediaElement `audioTracks` (Safari/WebKit/Chromium) when present. */
  function syncNativeAudioTracks() {
    const list = nativeVideo && nativeVideo.audioTracks;
    if (!list || !(list.length > 1)) return;
    const currentUrl = currentLogicalStreamUrl();
    const nativeRows = [];
    for (let i = 0; i < list.length; i++) {
      const nt = list[i];
      const lang = normalizeMoviLang(nt.language) !== 'und'
        ? normalizeMoviLang(nt.language)
        : inferLangFromTrackLabel(nt.label);
      const label = nt.label || langChipLabel(lang, i);
      nativeRows.push({
        id: `native-audio-${i}`,
        lang,
        label,
        type: 'dub',
        streamUrl: currentUrl,
        nativeAudioIndex: i,
        default: !!nt.enabled
      });
    }
    if (nativeRows.length > 1) {
      const otherFileRows = state.audioTracks.filter(
        (row) => row && row.streamUrl && !sameStreamReference(row.streamUrl, currentUrl)
      );
      state.audioTracks = [...nativeRows, ...otherFileRows];
      const active =
        state.audioTracks.find((r) => r.id === state.activeAudioId) ||
        nativeRows.find((r) => r.default) ||
        nativeRows[0];
      if (active) state.activeAudioId = active.id;
      renderAudioPopover();
      renderLangChips();
      updateSettingsSummaryValues();
    }
  }

  // --- One-click dub language chips ------------------------------------------
  // The resolve payload knows every dub language up front (audioTracks /
  // languages): each becomes one chip, and one click plays that language —
  // either switching the muxed track inside the running file or loading the
  // file that carries it (selectAudioTrack handles both).
  function renderLangChips() {
    if (!langChips || !langChipsRow) return;
    const rows = (state.audioTracks || []).filter((t) => t && t.id);
    const show = rows.length > 1;
    langChipsRow.classList.toggle('hidden', !show);
    if (!show) {
      langChips.innerHTML = '';
      return;
    }
    langChips.innerHTML = '';
    rows.forEach((track) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isActive = track.id === state.activeAudioId;
      chip.className = 'lang-chip' + (isActive ? ' active' : '');
      chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      chip.title = track.inFile ? `Play the ${track.label} audio track` : `Load the ${track.label} source`;
      chip.innerHTML = `<span class="lang-chip-dot" aria-hidden="true"></span><span>${escapeHtml(track.label || track.lang || 'Audio')}</span>`;
      chip.addEventListener('click', () => selectAudioTrack(track));
      langChips.appendChild(chip);
    });
  }

  // --- Automatic Server Failover on Fatal Stream Error ---
  const triedServers = new Set();

  /**
   * Ask every source of the failed server how it is doing: a two-byte Range GET
   * through the proxy tells apart "the upstream rejected us" (expired link,
   * hotlink gate, region lock — 4xx) from "the bytes arrive but nothing plays"
   * (unsupported codec → the movi/native engine) from "we cannot reach it at
   * all" (network/ISP). The sentence is appended under the error message after
   * the screen is already visible, so it never delays the message itself.
   */
  async function explainStreamFailure(token) {
    const sources = sourcesFromStream(state.stream || {}).slice(0, 4);
    if (sources.length === 0) return '';
    // The `probe=1` marker keeps the probe out of any media cache entry for
    // that URL. Only our own proxy tolerates it; signed upstream URLs are
    // probed verbatim so the report reflects what the player actually saw.
    const probe = (raw) =>
      /\/api\/proxy\?/.test(raw) ? `${raw}${raw.includes('?') ? '&' : '?'}probe=1` : raw;
    const statuses = await Promise.all(
      sources.map(async (src) => {
        try {
          const res = await fetch(probe(src), {
            headers: { Range: 'bytes=0-1' },
            cache: 'no-store'
          });
          try {
            if (res.body) await res.body.cancel();
          } catch (_) {}
          return res.status;
        } catch (_) {
          return 0;
        }
      })
    );
    if (token !== state.loadToken) return '';

    const reachable = statuses.filter((st) => st === 200 || st === 206 || st === 304);
    const rejected = statuses.filter((st) => st >= 400);
    const unreachable = statuses.filter((st) => st === 0);
    const codes = (list) => [...new Set(list)].join(', ');

    if (reachable.length === statuses.length) {
      return 'All sources answer normally, so the links are alive but this device could not decode them — the file may use a codec the browser cannot play.';
    }
    if (rejected.length === statuses.length) {
      return `Every source was rejected upstream (HTTP ${codes(rejected)}) — the links have most likely expired, so Retry asks for fresh ones.`;
    }
    if (unreachable.length === statuses.length) {
      return 'The sources could not be reached from this device at all — a network/ISP block is likely.';
    }
    return `Some sources failed upstream (HTTP ${codes([...rejected, ...unreachable])}) — try another server or retry.`;
  }

  function appendErrorDetail(sentence) {
    if (!sentence) return;
    const existing = loadingStatusDetail.textContent || '';
    loadingStatusDetail.textContent = existing ? `${existing} ${sentence}` : sentence;
    loadingStatusDetail.classList.remove('hidden');
  }

  function handleFatalStreamError() {
    state.activeSourceLive = false;
    triedServers.add(state.server);
    setServerInfo(state.server, {
      status: 'failed',
      sources: state.stream ? sourcesFromStream(state.stream) : []
    });
    const nextSrv = state.servers.find((s) => !triedServers.has(s.id));
    if (nextSrv) {
      renderServersPopover();
      state.server = nextSrv.id;
      showToast(`Switching to backup server: ${nextSrv.name}...`, 2800);
      loadMediaBundle(true);
    } else {
      state.allStreamsFailed = true;
      if (state.stream && state.stream.streamUrl) {
        if (!state._triedStreamUrls) state._triedStreamUrls = new Set();
        state._triedStreamUrls.add(state.stream.streamUrl);
      }
      renderServersPopover();
      showLoadError(
        'All servers failed to play this title.',
        state.servers.length > 1
          ? 'Every available server was tried. Retry, or pick a server manually.'
          : 'Retry in a moment — the upstream source may be temporarily unavailable.'
      );
      const token = state.loadToken;
      explainStreamFailure(token)
        .then((sentence) => {
          if (token !== state.loadToken || loadingOverlay.classList.contains('hidden')) return;
          appendErrorDetail(sentence);
        })
        .catch(() => {});
      emitHostEvent('error', { error: 'All upstream servers failed' });
    }
  }

  btnRetryLoad.addEventListener('click', () => {
    triedServers.clear();
    state._triedStreamUrls = new Set();
    state._triedDirectUrls = new Set();
    state.allStreamsFailed = false;
    // Ask the backend for a live resolve: replaying a cached payload would
    // retry the very same (most likely expired) provider URLs.
    state.resolveFresh = true;
    loadMediaBundle(true);
  });

  // The connect screen covers the HUD, so it carries its own Back / Servers.
  btnLoadingBack.addEventListener('click', () => btnBack.click());
  btnLoadingServers.addEventListener('click', () => {
    const wasHidden = popoverServers.classList.contains('hidden');
    closeAllPopovers();
    if (wasHidden) openServersPopover();
  });

  // Resolve which native HLS audio rendition a payload audio row maps to.
  // The backend ships an explicit `audioIndex` for remuxed multi-track files,
  // so index wins; language/name matching is only a fallback for third-party
  // HLS playlists because ffprobe often cannot tag a language (lang === 'und')
  // and a 'und' lookup used to silently match nothing while the UI still said
  // "Audio switched".
  function resolveHlsAudioIndex(track, hlsTracks) {
    if (!track || !Array.isArray(hlsTracks) || hlsTracks.length === 0) return -1;
    if (Number.isInteger(track.audioIndex) && track.audioIndex >= 0 && track.audioIndex < hlsTracks.length) {
      return track.audioIndex;
    }
    const lang = normalizeMoviLang(track.lang || '');
    if (lang && lang !== 'und') {
      const langIdx = hlsTracks.findIndex((t) => {
        const hlsLang = normalizeMoviLang((t && (t.lang || t.language)) || '');
        return hlsLang === lang || (hlsLang !== 'und' && hlsLang.startsWith(lang));
      });
      if (langIdx !== -1) return langIdx;
    }
    const label = String(track.label || '').toLowerCase().trim();
    if (label) {
      const labelIdx = hlsTracks.findIndex((t) => {
        const name = String((t && (t.name || t.label)) || '').toLowerCase().trim();
        return name && (name === label || name.includes(label) || label.includes(name));
      });
      if (labelIdx !== -1) return labelIdx;
    }
    if (track.hlsGroupId) {
      const groupIdx = hlsTracks.findIndex((t) => t && t.groupId === track.hlsGroupId);
      if (groupIdx !== -1) return groupIdx;
    }
    return -1;
  }

  function syncHlsAudioTracks() {
    if (!state.hlsInstance || !Array.isArray(state.hlsInstance.audioTracks)) return;
    const hlsTracks = state.hlsInstance.audioTracks;
    if (hlsTracks.length === 0) return;

    const currentUrl = currentLogicalStreamUrl();
    const currentMeta = sourceMetaForUrl(currentUrl);
    const currentRawUrl = (currentMeta && currentMeta.rawUrl) || (state.stream && state.stream.rawUrl) || currentUrl;
    const previousRows = Array.isArray(state.audioTracks) ? state.audioTracks : [];
    const currentRows = previousRows.filter((row) => row && (!row.streamUrl || sameStreamReference(row.streamUrl, currentUrl)));
    const otherFileRows = previousRows.filter((row) => row && row.streamUrl && !sameStreamReference(row.streamUrl, currentUrl));
    const usedIds = new Set();
    const usedRows = new Set();
    const pending = state.pendingAudioSelection;

    // hls.js is authoritative for the attached manifest.  Merge by rendition
    // index first, then language/name, but ONLY against rows for this source.
    // Rows for another provider remain available as separate-file choices.
    const mergedRows = hlsTracks.map((hlsTrack, index) => {
      const rawLang = String((hlsTrack && (hlsTrack.lang || hlsTrack.language)) || '').toLowerCase();
      const normFromCode = normalizeMoviLang(rawLang);
      const hlsLang = normFromCode !== 'und'
        ? normFromCode
        : inferLangFromTrackLabel((hlsTrack && (hlsTrack.name || hlsTrack.label)) || '');
      const existing = currentRows.find((row) => {
        if (usedRows.has(row)) return false;
        if (Number.isInteger(row.audioIndex) && row.audioIndex === index) return true;
        if (hlsLang !== 'und' && normalizeMoviLang(row.lang) === hlsLang && !Number.isInteger(row.audioIndex)) return true;
        const rowLabel = String(row.label || '').toLowerCase().trim();
        const hlsLabel = String((hlsTrack && (hlsTrack.name || hlsTrack.label)) || '').toLowerCase().trim();
        return rowLabel && hlsLabel && (rowLabel === hlsLabel || rowLabel.includes(hlsLabel) || hlsLabel.includes(rowLabel));
      });
      if (existing) usedRows.add(existing);
      let id = existing && existing.id ? existing.id : `hls-${index}`;
      if (usedIds.has(id)) id = `${id}-${index + 1}`;
      usedIds.add(id);
      const label = (hlsLang !== 'und' ? langChipLabel(hlsLang, index) : '') ||
        (hlsTrack && (hlsTrack.name || hlsTrack.label)) || (existing && existing.label) || `Audio ${index + 1}`;
      return {
        ...(existing || {}),
        id,
        lang: hlsLang !== 'und' ? hlsLang : (existing && existing.lang) || 'und',
        label,
        type: 'dub',
        streamUrl: currentUrl,
        rawUrl: (existing && existing.rawUrl) || currentRawUrl,
        inFile: false,
        audioIndex: index,
        hlsGroupId: (hlsTrack && hlsTrack.groupId) || (existing && existing.hlsGroupId) || '',
        hlsUrl: (hlsTrack && (hlsTrack.url || hlsTrack.uri)) || (existing && existing.hlsUrl) || '',
        default: hlsTrack && typeof hlsTrack.default === 'boolean' ? !!hlsTrack.default : !!(existing && existing.default)
      };
    });

    state.audioTracks = [...mergedRows, ...otherFileRows];
    const activeBefore = previousRows.find((row) => row && row.id === state.activeAudioId);
    const pendingRow = pending && mergedRows.find((row) =>
      (pending.id && row.id === pending.id) ||
      (Number.isInteger(pending.audioIndex) && row.audioIndex === pending.audioIndex) ||
      (pending.lang && normalizeMoviLang(row.lang) === normalizeMoviLang(pending.lang))
    );
    const active = pendingRow ||
      (activeBefore && mergedRows.find((row) => row.id === activeBefore.id)) ||
      (activeBefore && mergedRows.find((row) => normalizeMoviLang(row.lang) === normalizeMoviLang(activeBefore.lang))) ||
      mergedRows.find((row) => row.default) || mergedRows[0];
    if (active) {
      state.activeAudioId = active.id;
      const matchIdx = resolveHlsAudioIndex(active, hlsTracks);
      if (matchIdx !== -1) state.hlsInstance.audioTrack = matchIdx;
    }
    if (pending) state.pendingAudioSelection = null;
    renderAudioPopover();
    renderLangChips();
    updateSettingsSummaryValues();
  }

  // --- Render Audio Popover ---
  function renderAudioPopover() {
    audioTrackListEl.innerHTML = '';
    if (state.audioTracks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'popover-empty';
      empty.textContent = 'This stream exposes a single audio track.';
      audioTrackListEl.appendChild(empty);
      return;
    }
    state.audioTracks.forEach((track) => {
      const btn = document.createElement('button');
      const isActive = track.id === state.activeAudioId;
      btn.className = 'popover-item-btn' + (isActive ? ' active' : '');
      btn.type = 'button';
      btn.innerHTML = `
        <span>${escapeHtml(track.label)}</span>
        <span class="popover-check">✓</span>
      `;
      btn.addEventListener('click', () => {
        selectAudioTrack(track);
        closeAllPopovers();
      });
      audioTrackListEl.appendChild(btn);
    });
  }

  function selectAudioTrack(track, options = {}) {
    if (!track) return;
    state.activeAudioId = track.id;
    const normLang = normalizeMoviLang(track.lang);
    if (normLang && normLang !== 'und') {
      state.preferredAudioLang = normLang;
    }
    renderAudioPopover();
    renderLangChips();
    updateSettingsSummaryValues();
    if (options.remember !== false && normLang && normLang !== 'und') {
      writeShowPrefs({ audio: normLang, audioId: track.id });
    } else if (options.remember !== false && track.id) {
      writeShowPrefs({ audioId: track.id });
    }

    let switched = false;
    let switchHint = '';
    const currentUrl = currentLogicalStreamUrl();
    const sameStreamUrl = !track.streamUrl || !state.stream || sameStreamReference(track.streamUrl, currentUrl);
    const hlsRenditionSwitch = !!(
      state.hlsInstance &&
      sameStreamUrl &&
      Array.isArray(state.hlsInstance.audioTracks) &&
      state.hlsInstance.audioTracks.length > 0 &&
      (Number.isInteger(track.audioIndex) || track.inFile === false)
    );

    // 0. In-file dub (movi engine): the track is muxed inside the running
    // file — switch it in place via pickAudioTrack(id), no reload and no playhead jump.
    if (state.moviEl && video === state.moviEl && sameStreamUrl && (track.inFile || Number.isInteger(track.moviTrackId))) {
      switched = selectMoviAudioTrack(track);
      if (!switched) switchHint = ' — this file could not switch tracks';
    }
    // 1. If the selected audio track has its own distinct streamUrl (e.g. separate Hindi/English dub file), switch stream preserving current time
    else if (!hlsRenditionSwitch && track.streamUrl && state.stream && !sameStreamUrl) {
      const resumeAt = (video && video.currentTime) || 0;
      state.pendingAudioSelection = {
        id: track.id,
        lang: track.lang,
        ...(Number.isInteger(track.audioIndex) ? { audioIndex: track.audioIndex } : {})
      };
      applyAudioTrackSourceMetadata(track);
      prepareAudioRowsForSourceSwitch(track.streamUrl);
      if (state.audioTracks.some((r) => r.id === track.id)) {
        state.activeAudioId = track.id;
        renderAudioPopover();
        renderLangChips();
      }
      attachStreamToVideo(track.streamUrl, resumeAt, state.loadToken);
      switched = true;
    }
    // 2. If HLS instance has multiple embedded audio renditions, switch natively
    else if (state.hlsInstance && sameStreamUrl && Array.isArray(state.hlsInstance.audioTracks) && state.hlsInstance.audioTracks.length > 0) {
      const idx = resolveHlsAudioIndex(track, state.hlsInstance.audioTracks);
      if (idx !== -1) {
        track.audioIndex = idx;
        state.hlsInstance.audioTrack = idx;
        switched = true;
      } else {
        switchHint = ' — no matching track in this stream';
      }
    }
    // 3. Native HTMLMediaElement.audioTracks (Safari / iOS / Chromium)
    else if (nativeVideo && video === nativeVideo && sameStreamUrl && nativeVideo.audioTracks && nativeVideo.audioTracks.length > 1) {
      let targetIdx = Number.isInteger(track.nativeAudioIndex) ? track.nativeAudioIndex : -1;
      if (targetIdx < 0 && normLang && normLang !== 'und') {
        for (let i = 0; i < nativeVideo.audioTracks.length; i++) {
          if (normalizeMoviLang(nativeVideo.audioTracks[i].language) === normLang) {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx >= 0 && targetIdx < nativeVideo.audioTracks.length) {
        for (let i = 0; i < nativeVideo.audioTracks.length; i++) {
          nativeVideo.audioTracks[i].enabled = i === targetIdx;
        }
        switched = true;
      } else {
        switchHint = ' — no matching track in this stream';
      }
    }
    // 4. Fallback attempt on movi-player if active even when `inFile` was not pre-tagged
    else if (state.moviEl && video === state.moviEl && sameStreamUrl) {
      switched = selectMoviAudioTrack(track);
      if (!switched) switchHint = ' — this file plays its default audio track only';
    } else {
      switchHint = ' — this file plays its default audio track only';
    }

    // 5. If track is a "sub" variant, auto-enable English subtitles if available and currently Off
    if (track.type === 'sub' && state.activeSubtitleId === 'off' && state.subtitles.length > 0) {
      const enSub = state.subtitles.find((s) => normalizeMoviLang(s.lang) === 'en') || state.subtitles[0];
      if (enSub) {
        loadSubtitleTrack(enSub, { remember: false });
      }
    }

    if (switched) {
      showToast(`Audio switched to ${track.label}`, 2200);
    } else {
      showToast(`Audio: ${track.label}${switchHint}`, 3200);
    }
    emitHostEvent('audiotrackchange', { audioTrack: track.label, lang: track.lang, switched });
  }

  // --- Render Subtitles Popover ---
  function renderSubtitlesPopover() {
    subtitleTrackListEl.innerHTML = '';

    // 1. "Upload subtitle" row
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'popover-item-btn is-upload';
    uploadBtn.type = 'button';
    uploadBtn.innerHTML = `<span>Upload subtitle (.srt / .vtt)</span><span class="popover-check"></span>`;
    uploadBtn.addEventListener('click', () => {
      subtitleFileInput.click();
    });
    subtitleTrackListEl.appendChild(uploadBtn);

    // 2. "Off" row
    const offBtn = document.createElement('button');
    const isOff = state.activeSubtitleId === 'off';
    offBtn.className = 'popover-item-btn' + (isOff ? ' active' : '');
    offBtn.type = 'button';
    offBtn.innerHTML = `<span>Off</span><span class="popover-check">✓</span>`;
    offBtn.addEventListener('click', () => {
      disableSubtitles();
      closeAllPopovers();
    });
    subtitleTrackListEl.appendChild(offBtn);

    // 3. Language tracks
    if (state.subtitles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'popover-empty';
      empty.textContent = 'No subtitles were found for this title. You can upload your own.';
      subtitleTrackListEl.appendChild(empty);
    }
    state.subtitles.forEach((sub) => {
      const btn = document.createElement('button');
      const isActive = sub.id === state.activeSubtitleId;
      btn.className = 'popover-item-btn' + (isActive ? ' active' : '');
      btn.type = 'button';
      btn.innerHTML = `
        <span>${escapeHtml(sub.label)}</span>
        <span class="popover-check">✓</span>
      `;
      btn.addEventListener('click', () => {
        loadSubtitleTrack(sub);
        closeAllPopovers();
      });
      subtitleTrackListEl.appendChild(btn);
    });

    subtitlesActiveDot.classList.toggle('hidden', state.activeSubtitleId === 'off');
  }

  function disableSubtitles(options = {}) {
    if (state.activeSubtitleId !== 'off') state.lastSubtitleId = state.activeSubtitleId;
    state.activeSubtitleId = 'off';
    state.parsedCues = [];
    customSubtitleText.textContent = '';
    if (state.moviEl && typeof state.moviEl.pickSubtitleTrack === 'function') {
      try { state.moviEl.pickSubtitleTrack(null); } catch (_) {}
    }
    renderSubtitlesPopover();
    updateSettingsSummaryValues();
    // Only a deliberate "Off" is remembered for the title, not a failed load.
    if (options.remember !== false) writeShowPrefs({ sub: 'off' });
    emitHostEvent('subtitlechange', { subtitle: null });
  }

  async function loadSubtitleTrack(sub, options = {}) {
    state.activeSubtitleId = sub.id;
    state.lastSubtitleId = sub.id;
    renderSubtitlesPopover();
    updateSettingsSummaryValues();
    if (options.remember !== false && sub.id !== 'custom-upload' && sub.lang) {
      const normSubLang = normalizeMoviLang(sub.lang);
      if (normSubLang && normSubLang !== 'und') {
        writeShowPrefs({ sub: normSubLang });
      }
    }

    // Embedded MKV subtitle track rendered by movi-player's SubtitleOverlay
    if (Number.isInteger(sub.moviSubTrackId)) {
      state.parsedCues = [];
      customSubtitleText.textContent = '';
      if (state.moviEl && typeof state.moviEl.pickSubtitleTrack === 'function') {
        try { state.moviEl.pickSubtitleTrack(sub.moviSubTrackId); } catch (_) {}
      }
      if (!options.silent) showToast(`Subtitles: ${sub.label}`, 2000);
      emitHostEvent('subtitlechange', { subtitle: sub.label, lang: sub.lang });
      return;
    }

    // External VTT or uploaded SRT/VTT: ensure movi-player's internal subtitle overlay is off
    if (state.moviEl && typeof state.moviEl.pickSubtitleTrack === 'function') {
      try { state.moviEl.pickSubtitleTrack(null); } catch (_) {}
    }

    if (sub.id === 'custom-upload' && Array.isArray(sub.cues)) {
      state.parsedCues = sub.cues;
      customSubtitleText.dir = sub.dir || 'ltr';
      updateActiveSubtitleCue();
      return;
    }

    try {
      const res = await fetch(sub.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const vttText = await res.text();
      // The viewer may have picked another track while this one was downloading.
      if (state.activeSubtitleId !== sub.id) return;
      state.parsedCues = parseWebVttCues(vttText);
      customSubtitleText.dir = sub.dir || directionForLang(sub.lang);
      updateActiveSubtitleCue();
      if (state.parsedCues.length === 0) {
        showToast(`Subtitle track "${sub.label}" is empty or unreadable`, 2600);
      } else if (!options.silent) {
        showToast(`Subtitles: ${sub.label}`, 2000);
      }
      emitHostEvent('subtitlechange', { subtitle: sub.label, lang: sub.lang });
    } catch (_) {
      if (state.activeSubtitleId !== sub.id) return;
      showToast('Failed to load subtitle track', 2000);
      disableSubtitles({ remember: false });
    }
  }

  const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, lower) ? HTML_ENTITIES[lower] : match;
    });
  }

  // Parse WebVTT or SRT text into [{ start, end, text }]
  function parseWebVttCues(rawText) {
    const normalized = String(rawText || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

    const blocks = normalized.split(/\n\n+/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeLineIdx === -1) continue;

      const [startStr, endStr] = lines[timeLineIdx].split('-->').map((s) => s.trim().split(/\s+/)[0]);
      const start = parseTimestampToSeconds(startStr);
      const end = parseTimestampToSeconds(endStr);
      const text = decodeEntities(
        lines
          .slice(timeLineIdx + 1)
          .join('\n')
          .replace(/\{\\[^}]*\}/g, '') // ASS/SSA override tags ({\an8}, {\i1})
          .replace(/<[^>]+>/g, '')
      ).trim();

      if (!isNaN(start) && !isNaN(end) && end >= start && text) {
        cues.push({ start, end, text });
      }
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  function parseTimestampToSeconds(ts) {
    if (!ts) return NaN;
    const parts = ts.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return NaN;
  }

  function updateActiveSubtitleCue() {
    if (state.activeSubtitleId === 'off' || state.parsedCues.length === 0) {
      if (customSubtitleText.textContent) customSubtitleText.textContent = '';
      return;
    }
    const effectiveTime = (video.currentTime || 0) - state.subtitleDelaySec;
    const cue = state.parsedCues.find((c) => effectiveTime >= c.start && effectiveTime <= c.end);
    const next = cue ? cue.text : '';
    if (customSubtitleText.textContent !== next) customSubtitleText.textContent = next;
  }

  // Handle local .srt / .vtt upload
  subtitleFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      const cues = parseWebVttCues(content);
      if (cues.length === 0) {
        showToast(`Could not read any cues from ${file.name}`, 2800);
        subtitleFileInput.value = '';
        return;
      }
      const customId = 'custom-upload';
      const shortName = file.name.length > 22 ? `${file.name.slice(0, 19)}…` : file.name;
      const customSub = {
        id: customId,
        code: 'custom',
        lang: 'custom',
        label: `Uploaded (${shortName})`,
        dir: 'ltr',
        cues
      };
      state.subtitles = [customSub, ...state.subtitles.filter((s) => s.id !== customId)];
      loadSubtitleTrack(customSub, { silent: true });
      closeAllPopovers();
      showToast(`Loaded subtitle: ${file.name}`, 2500);
      subtitleFileInput.value = '';
    };
    reader.readAsText(file);
  });

  // --- Episodes Modal ---
  function episodesForSeason(seasonNumber) {
    return state.seasonEpisodesCache[`${state.tmdbId}:${seasonNumber}`] || null;
  }

  function renderEpisodesModal() {
    if (!state.media || state.media.type !== 'tv') return;

    // Populate Season Dropdown
    const totalSeasons = state.media.totalSeasons || 1;
    const seasonNumbers = state.media.seasonNumbers && state.media.seasonNumbers.length > 0
      ? state.media.seasonNumbers
      : Array.from({ length: totalSeasons }, (_, i) => i + 1);
    if (!seasonNumbers.includes(state.season)) seasonNumbers.push(state.season);
    seasonNumbers.sort((a, b) => a - b);
    seasonSelect.innerHTML = '';
    seasonNumbers.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `Season ${s}`;
      if (s === state.browseSeason) opt.selected = true;
      seasonSelect.appendChild(opt);
    });

    renderEpisodeCards(state.browseSeason, episodesForSeason(state.browseSeason) || []);
  }

  function renderEpisodeCards(seasonNumber, episodes) {
    episodesGrid.innerHTML = '';
    episodesGrid.classList.remove('is-loading');
    episodesEmpty.classList.toggle('hidden', episodes.length > 0);
    episodesHeaderSubtitle.textContent = episodes.length > 0
      ? `${state.media.title} · Season ${seasonNumber} · ${episodes.length} episode${episodes.length === 1 ? '' : 's'}`
      : 'Select an episode to watch.';

    episodes.forEach((ep) => {
      const card = document.createElement('div');
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      const isCurrent = seasonNumber === state.season && ep.episode === state.episode;
      card.className = 'episode-card' + (isCurrent ? ' active' : '');
      card.setAttribute('aria-label', `Episode ${ep.episode}: ${ep.title}`);
      if (isCurrent) card.setAttribute('aria-current', 'true');

      const progress = readProgress(state.type, state.tmdbId, seasonNumber, ep.episode);
      let progressPct = 0;
      if (progress && progress.duration > 0) {
        progressPct = clamp((progress.time / progress.duration) * 100, 0, 100);
        if (isNearEnd(progress.time, progress.duration)) progressPct = 100;
      } else if (progress && progress.time > 60) {
        progressPct = 5; // Legacy entry without duration: show "started".
      }

      const metaParts = [ep.airDate, ep.runtime].filter(Boolean);
      card.innerHTML = `
        <div class="episode-thumb-wrap">
          ${ep.still ? `<img class="episode-thumb-img" src="${escapeHtml(ep.still)}" alt="" loading="lazy" />` : ''}
          <span class="episode-thumb-number">E${escapeHtml(ep.episode)}</span>
          ${isCurrent ? '<span class="episode-now-playing">Now playing</span>' : ''}
          <span class="episode-thumb-play" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><polygon points="7 4 21 12 7 20 7 4"></polygon></svg>
          </span>
          ${progressPct > 0 ? `<span class="episode-progress"><span class="episode-progress-fill" style="width:${progressPct.toFixed(1)}%"></span></span>` : ''}
        </div>
        <div class="episode-title">${escapeHtml(ep.episode)}. ${escapeHtml(ep.title)}</div>
        <div class="episode-meta">${escapeHtml(metaParts.join(' • '))}</div>
        <div class="episode-desc">${escapeHtml(ep.overview)}</div>
      `;
      const img = card.querySelector('.episode-thumb-img');
      if (img) {
        img.addEventListener('error', () => img.classList.add('is-missing'));
      }

      const openEpisode = () => {
        if (isCurrent) {
          modalEpisodesBackdrop.classList.add('hidden');
          return;
        }
        saveProgress(true);
        state.season = seasonNumber;
        state.episode = ep.episode;
        state.browseSeason = seasonNumber;
        modalEpisodesBackdrop.classList.add('hidden');
        syncUrlWithState();
        loadMediaBundle(false);
        emitHostEvent('episodechange', { season: state.season, episode: state.episode });
      };
      card.addEventListener('click', openEpisode);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openEpisode();
        }
      });

      episodesGrid.appendChild(card);
    });

    const activeCard = episodesGrid.querySelector('.episode-card.active');
    if (activeCard && typeof activeCard.scrollIntoView === 'function') {
      try { activeCard.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }
  }

  // Browsing another season only lists its episodes; playback changes when an
  // episode is actually clicked.
  seasonSelect.addEventListener('change', async () => {
    const seasonNumber = parseInt(seasonSelect.value, 10) || 1;
    state.browseSeason = seasonNumber;
    const cached = episodesForSeason(seasonNumber);
    if (cached) {
      renderEpisodeCards(seasonNumber, cached);
      return;
    }
    const token = ++state.seasonFetchToken;
    episodesGrid.classList.add('is-loading');
    episodesEmpty.classList.add('hidden');
    episodesHeaderSubtitle.textContent = `Loading Season ${seasonNumber}…`;
    try {
      const res = await fetch(apiUrl(`/api/info/tv/${encodeURIComponent(state.tmdbId)}?season=${seasonNumber}`));
      const json = await res.json();
      const episodes = normalizeEpisodes(json && json.metadata && json.metadata.episodes, json && json.metadata, seasonNumber);
      state.seasonEpisodesCache[`${state.tmdbId}:${seasonNumber}`] = episodes;
      if (token !== state.seasonFetchToken || state.browseSeason !== seasonNumber) return;
      renderEpisodeCards(seasonNumber, episodes);
    } catch (_) {
      if (token !== state.seasonFetchToken) return;
      renderEpisodeCards(seasonNumber, []);
      episodesHeaderSubtitle.textContent = `Could not load Season ${seasonNumber}.`;
    }
  });

  // --- Servers & sources ---------------------------------------------------
  // A "source" is one of the stream URLs a server resolved (its primary stream
  // plus its backup mirrors). They are shown as "Source 1..N" only: upstream
  // provider names and URLs never reach the viewer.
  function serverInfoFor(id) {
    return state.serverInfo[id] || { status: 'unknown', sources: [] };
  }

  function setServerInfo(id, patch) {
    if (!id) return;
    state.serverInfo[id] = { ...serverInfoFor(id), ...patch };
    if (loadingOverlay.classList.contains('is-error') && !loadingOverlay.classList.contains('hidden')) {
      renderErrorServers();
    }
  }

  function sourcesFromStream(stream) {
    if (!stream || typeof stream !== 'object') return [];
    const primary = stream._primaryStreamUrl || stream.streamUrl;
    const backups = Array.isArray(stream.backupUrls) ? stream.backupUrls : [];
    return [...new Set([primary, ...backups].filter((u) => typeof u === 'string' && u))];
  }

  /**
   * Every resolve answer teaches us about several servers at once: the one
   * that answered is ready (with its sources), and each entry of the backend
   * waterfall's `serverAttempts` failed before it.
   */
  function learnServersFromPayload(data, requestedServer) {
    const stream = data && data.stream && typeof data.stream === 'object' ? data.stream : null;
    const attempts = (stream && Array.isArray(stream.serverAttempts) && stream.serverAttempts) ||
      (data && Array.isArray(data.serverAttempts) && data.serverAttempts) || [];
    attempts.forEach((attempt) => {
      if (attempt && attempt.server && serverInfoFor(attempt.server).status !== 'ready') {
        setServerInfo(attempt.server, { status: 'failed', sources: [] });
      }
    });
    if (stream && stream.streamUrl && stream.server) {
      setServerInfo(stream.server, { status: 'ready', sources: sourcesFromStream(stream) });
      if (requestedServer && requestedServer !== stream.server && serverInfoFor(requestedServer).status !== 'ready') {
        setServerInfo(requestedServer, { status: 'failed', sources: [] });
      }
    } else if (requestedServer && serverInfoFor(requestedServer).status !== 'ready') {
      setServerInfo(requestedServer, { status: 'failed', sources: [] });
    }
  }

  // Servers we know nothing about yet are checked one at a time while the
  // list is open (or the error screen lists them), so every row can show a
  // real state instead of a guess.
  let serverProbeChain = Promise.resolve();
  function serverStatesWanted() {
    return (
      !popoverServers.classList.contains('hidden') ||
      (loadingOverlay.classList.contains('is-error') && !loadingOverlay.classList.contains('hidden'))
    );
  }

  function probeUnknownServers() {
    const token = state.loadToken;
    state.servers
      .filter((srv) => srv.id !== state.server && serverInfoFor(srv.id).status === 'unknown')
      .forEach((srv) => {
        serverProbeChain = serverProbeChain.then(async () => {
          if (token !== state.loadToken) return;
          if (!serverStatesWanted()) return;
          if (serverInfoFor(srv.id).status !== 'unknown') return;
          setServerInfo(srv.id, { status: 'checking' });
          renderServersPopover();
          let data = null;
          try {
            const res = await fetch(buildResolveUrl(srv.id));
            try { data = await res.json(); } catch (_) { data = null; }
          } catch (_) {
            data = null;
          }
          if (token !== state.loadToken) return;
          if (data) absolutizeStreamPayload(data.stream);
          learnServersFromPayload(data, srv.id);
          if (serverInfoFor(srv.id).status === 'checking') setServerInfo(srv.id, { status: 'failed', sources: [] });
          renderServersPopover();
        });
      });
  }

  function selectServer(serverId) {
    // Manual selection: forget every previously failed server so the user's
    // explicit choice is always retried with a clean slate — including a live
    // re-resolve, because the cached payload may predate an expired link.
    triedServers.clear();
    state._triedStreamUrls = new Set();
    state._triedDirectUrls = new Set();
    state.allStreamsFailed = false;
    state.resolveFresh = true;
    state.server = serverId;
    closeAllPopovers();
    loadMediaBundle(true);
    emitHostEvent('serverchange', { server: serverId });
  }

  function switchToSource(serverId, url, label) {
    if (serverId === state.server && state.stream && state.stream.streamUrl) {
      if (state.stream.streamUrl === url && !loadingOverlay.classList.contains('is-error')) {
        closeAllPopovers();
        return;
      }
      const resumeAt = (video && video.currentTime) || 0;
      const wasInErrorOrLoading =
        playerRoot.classList.contains('is-loading') || loadingOverlay.classList.contains('is-error');
      state._triedStreamUrls = new Set();
      state._triedDirectUrls = new Set();
      state.allStreamsFailed = false;
      closeAllPopovers();
      prepareAudioRowsForSourceSwitch(url);
      const sourceIndex = sourcesFromStream(state.stream).indexOf(url);
      if (wasInErrorOrLoading) {
        showLoading(`Connecting to ${serverDisplayName(serverId)}`);
        setConnectSource(serverId, sourceIndex);
        setConnectProgress(74, false);
      } else {
        hostBuffering = true;
        bufferingIndicator.classList.remove('hidden');
        showToast(`Switching to ${label || `Source ${sourceIndex + 1}`}…`, 2200);
      }
      attachStreamToVideo(url, resumeAt, state.loadToken);
      renderServersPopover();
      return;
    }
    state.pendingSourceUrl = url;
    selectServer(serverId);
  }

  const STATE_ICONS = {
    ready: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12.5 10 17.5 19 7"></polyline></svg>',
    failed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>',
    checking: '<span class="server-state-spinner"></span>',
    unknown: '—'
  };
  const STATE_LABELS = { ready: 'Ready', failed: 'Unavailable', checking: 'Checking', unknown: 'Not checked yet' };

  function renderServersPopover() {
    serversListContainer.innerHTML = '';
    if (state.servers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'popover-empty';
      empty.textContent = 'Server list unavailable — the stream service did not respond yet.';
      serversListContainer.appendChild(empty);
      return;
    }
    const playingUrl = state.stream && state.stream.streamUrl ? state.stream.streamUrl : null;
    const triedUrls = state._triedStreamUrls || new Set();

    state.servers.forEach((srv) => {
      const isSelectedServer = srv.id === state.server && !!playingUrl;
      const isActive = isSelectedServer && !state.allStreamsFailed;
      let info = serverInfoFor(srv.id);
      // The playing server is the live truth unless every source on it failed.
      if (isActive) {
        info = { ...info, status: 'ready', sources: sourcesFromStream(state.stream) };
      } else if (isSelectedServer && state.allStreamsFailed) {
        info = { ...info, status: 'failed', sources: sourcesFromStream(state.stream) };
      } else if (info.status === 'unknown' && triedServers.has(srv.id)) {
        info = { ...info, status: 'failed' };
      }
      const status = STATE_ICONS[info.status] ? info.status : 'unknown';

      const group = document.createElement('div');
      group.className = 'server-group' + (isActive ? ' is-active' : '');

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'server-row-card' + (isActive ? ' active' : '');
      head.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      head.innerHTML = `
        <div class="server-row-main">
          <div>
            <div class="server-name-line"><span>${escapeHtml(srv.name)}</span></div>
            <div class="server-desc-line">${escapeHtml(srv.description)}</div>
          </div>
        </div>
        <span class="server-state is-${status}" role="img" aria-label="${STATE_LABELS[status]}">${STATE_ICONS[status]}</span>
      `;
      head.addEventListener('click', () => {
        if (isActive) {
          closeAllPopovers();
          return;
        }
        selectServer(srv.id);
      });
      group.appendChild(head);

      if ((status === 'ready' || (isSelectedServer && state.allStreamsFailed)) && info.sources.length > 0) {
        const list = document.createElement('div');
        list.className = 'server-sources';
        info.sources.slice(0, 12).forEach((url, index) => {
          // Goldmine labels its sources with quality/language descriptors
          // ("1080p · Multi-Audio · MKV"); anything else falls back to the
          // plain slot number.
          const backendLabel = state.stream && state.stream.sourceLabels ? state.stream.sourceLabels[url] : '';
          const label = backendLabel || `Source ${index + 1}`;
          const isPlayingSource = isActive && url === playingUrl;
          const sourceFailed = isSelectedServer && !isPlayingSource && triedUrls.has(url);
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'server-source-row' + (isPlayingSource ? ' active' : '');
          row.setAttribute('aria-pressed', isPlayingSource ? 'true' : 'false');
          // "Playing" (green) only once the media element really reached `playing`;
          // connecting sources stay neutral (`is-ready`), and exhausted sources
          // including the final fallback rung show `Failed` (`is-failed`).
          const isConnecting = isPlayingSource && !state.activeSourceLive && !sourceFailed;
          const statusClass =
            isPlayingSource && state.activeSourceLive
              ? 'is-playing'
              : sourceFailed
                ? 'is-failed'
                : 'is-ready';
          const statusText = isConnecting
            ? 'Connecting'
            : isPlayingSource
              ? 'Playing'
              : sourceFailed
                ? 'Failed'
                : 'Ready';
          row.innerHTML = `<span class="source-name">${escapeHtml(label)}</span><span class="source-status ${statusClass}">${statusText}</span>`;
          row.addEventListener('click', () => switchToSource(srv.id, url, label));
          list.appendChild(row);
        });
        group.appendChild(list);
      } else if (status === 'checking') {
        const note = document.createElement('div');
        note.className = 'server-source-note';
        note.textContent = 'Checking sources…';
        group.appendChild(note);
      } else if (status === 'failed') {
        const note = document.createElement('div');
        note.className = 'server-source-note';
        note.textContent = 'No sources available right now';
        group.appendChild(note);
      }

      serversListContainer.appendChild(group);
    });
  }

  function openServersPopover() {
    closeAllPopovers();
    renderServersPopover();
    popoverServers.classList.remove('hidden');
    btnServers.classList.add('is-open');
    btnServers.setAttribute('aria-expanded', 'true');
    probeUnknownServers();
  }

  // --- Update Player Settings Summary Values ---
  function updateSettingsSummaryValues() {
    const qObj = state.qualities.find((q) => q.id === state.activeQualityId);
    valQuality.textContent = qObj ? qObj.label : 'Auto';

    const aObj = state.audioTracks.find((a) => a.id === state.activeAudioId);
    valAudio.textContent = aObj ? aObj.label : 'Original Audio';

    if (state.activeSubtitleId === 'off') {
      valSubtitles.textContent = 'Off';
    } else {
      const sObj = state.subtitles.find((s) => s.id === state.activeSubtitleId);
      valSubtitles.textContent = sObj ? sObj.label : 'On';
    }
    subtitlesActiveDot.classList.toggle('hidden', state.activeSubtitleId === 'off');

    valAspect.textContent = state.aspectRatio;
    valBrightness.textContent = `${state.brightness}%`;
    const pipOn = !!document.pictureInPictureElement;
    valMirror.textContent = state.mirror ? 'On' : 'Off';
    valPip.textContent = pipOn ? 'On' : 'Off';
    switchMirror.classList.toggle('on', state.mirror);
    switchPip.classList.toggle('on', pipOn);
    const mirrorRow = switchMirror.closest('.settings-row-btn');
    const pipRow = switchPip.closest('.settings-row-btn');
    if (mirrorRow) mirrorRow.setAttribute('aria-checked', String(state.mirror));
    if (pipRow) pipRow.setAttribute('aria-checked', String(pipOn));
    valSpeed.textContent = `${state.playbackSpeed}x`;
    valAutoskip.textContent = state.autoSkip ? 'On' : 'Off';
    switchAutoskip.classList.toggle('on', state.autoSkip);
    const autoskipRow = switchAutoskip.closest('.settings-row-btn');
    if (autoskipRow) autoskipRow.setAttribute('aria-checked', String(state.autoSkip));
    valShare.textContent = formatTime(video.currentTime || 0);
  }

  /** Embed URL that opens this title at the current position (`?t=`). */
  function buildShareUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('start');
    url.searchParams.delete('origin');
    url.searchParams.set('t', String(Math.max(0, Math.floor(video.currentTime || 0))));
    url.hash = '';
    return url.toString();
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  async function shareCurrentTime() {
    const time = Math.max(0, Math.floor(video.currentTime || 0));
    const url = buildShareUrl();
    const copied = await copyText(url);
    showToast(copied ? `Link copied · starts at ${formatTime(time)}` : 'Could not copy the link', 2600);
    // Hosts usually want their own page URL shared: the event carries the
    // position so they can build one.
    emitHostEvent('share', { url, time, copied });
  }

  function setAutoSkip(on) {
    state.autoSkip = !!on;
    storageSet(AUTOSKIP_KEY, state.autoSkip ? '1' : '0');
    updateSettingsSummaryValues();
  }

  // Apply CSS transforms & filters for Aspect Ratio, Brightness, and Mirror
  function applyMediaTransforms() {
    const filterVal = `brightness(${state.brightness / 100})`;
    const transformVal = state.mirror ? 'scaleX(-1)' : 'scaleX(1)';
    let fitVal = 'contain';
    if (state.aspectRatio === 'Fill') fitVal = 'cover';
    else if (state.aspectRatio === 'Stretch') fitVal = 'fill';

    nativeVideo.style.filter = filterVal;
    nativeVideo.style.transform = transformVal;
    nativeVideo.style.objectFit = fitVal;

    if (state.moviEl) {
      state.moviEl.style.filter = filterVal;
      state.moviEl.style.transform = transformVal;
      state.moviEl.style.objectFit = fitVal;
      try { state.moviEl.setAttribute('objectfit', fitVal); } catch (_) {}
    }
    updateSettingsSummaryValues();
  }

  // --- Settings Modal Drill-Down Panels ---
  document.querySelectorAll('.settings-row-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const panel = btn.dataset.panel;
      const action = btn.dataset.action;

      if (action === 'toggle-mirror') {
        state.mirror = !state.mirror;
        applyMediaTransforms();
        return;
      }

      if (action === 'toggle-autoskip') {
        setAutoSkip(!state.autoSkip);
        showToast(state.autoSkip ? 'Intros and recaps will be skipped automatically' : 'Auto-skip off', 2200);
        return;
      }

      if (action === 'share-time') {
        await shareCurrentTime();
        return;
      }

      if (action === 'toggle-pip') {
        if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) {
          showToast('Picture-in-Picture is not supported in this browser', 2400);
          return;
        }
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else {
            await video.requestPictureInPicture();
          }
        } catch (_) {
          showToast('Picture-in-Picture could not be started', 2400);
        }
        updateSettingsSummaryValues();
        return;
      }

      if (panel) {
        openSettingsDrillPanel(panel);
      }
    });
  });

  /** Switch to a payload or manifest-discovered quality; remembered across titles (`lol_embed_quality`). */
  function applyQuality(q, idx = state.qualities.indexOf(q), options = {}) {
    state.activeQualityId = q.id;
    if (options.remember !== false) {
      if (q.id === 'auto' || !q.height) storageRemove(QUALITY_KEY);
      else storageSet(QUALITY_KEY, String(q.height));
    }
    if (state.hlsInstance && state.hlsInstance.levels && state.hlsInstance.levels.length > 0) {
      // Prefer the exact manifest index captured from hls.js. Height matching
      // remains as a fallback for resolver-supplied rows and older payloads.
      const heights = state.hlsInstance.levels.map((l) => (l && l.height) || 0);
      let levelIdx =
        Number.isInteger(q.levelIndex) && q.levelIndex >= 0 && q.levelIndex < state.hlsInstance.levels.length
          ? q.levelIndex
          : -1;
      if (levelIdx === -1 && q.id !== 'auto' && q.height) {
        levelIdx = heights.findIndex((h) => h === q.height);
        if (levelIdx === -1) {
          const closest = heights.reduce(
            (best, h, i) => (h > 0 && Math.abs(h - q.height) < Math.abs((best.height || 1e9) - q.height) ? { height: h, index: i } : best),
            { height: 0, index: -1 }
          );
          levelIdx = closest.index;
        }
      }
      state.hlsInstance.currentLevel = q.id === 'auto'
        ? -1
        : (levelIdx !== -1 ? levelIdx : Math.min(Math.max(idx - 1, 0), state.hlsInstance.levels.length - 1));
    } else if (!options.hlsOnly && q.url && state.stream && q.url !== state.stream.streamUrl) {
      const resumeAt = (video && video.currentTime) || 0;
      state.stream.streamUrl = q.url;
      prepareAudioRowsForSourceSwitch(q.url);
      attachStreamToVideo(q.url, resumeAt, state.loadToken);
    }
    updateSettingsSummaryValues();
  }

  /**
   * hls.js, not the resolver's initial row, is authoritative for a master
   * playlist's quality ladder. Replace the visible menu with the levels that
   * actually exist and retain each exact level index for duplicate-height
   * ladders. A single media playlist consequently yields Auto + one honest
   * rung instead of pretending that 1080/720/480 variants exist.
   */
  function syncHlsQualityLevels(hls, eventLevels) {
    if (!hls || state.hlsInstance !== hls) return;
    const levels = Array.isArray(eventLevels) ? eventLevels : hls.levels;
    if (!Array.isArray(levels) || levels.length === 0) return;

    const rows = levels
      .map((level, levelIndex) => {
        const height = Number(level && level.height) || 0;
        const bitrate = Number(level && level.bitrate) || 0;
        const bitrateLabel = bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : '';
        const name = String((level && level.name) || '').trim();
        if (!height && !bitrateLabel && !name) return null;
        return {
          id: `hls-level-${levelIndex}`,
          label: height > 0 ? `${height}p` : name || bitrateLabel,
          height,
          bitrate: bitrateLabel || undefined,
          levelIndex,
          url: ''
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.height - a.height || (parseInt(b.bitrate, 10) || 0) - (parseInt(a.bitrate, 10) || 0));
    if (rows.length === 0) return;

    state.qualities = [{ id: 'auto', label: 'Auto', height: 0, url: '' }, ...rows];
    const currentLevel = Number.isInteger(hls.currentLevel) ? hls.currentLevel : -1;
    const currentRow = rows.find((row) => row.levelIndex === currentLevel);
    state.activeQualityId = currentRow ? currentRow.id : 'auto';
    updateSettingsSummaryValues();
  }

  /**
   * Re-apply the height the viewer last picked, once the HLS ladder is known.
   * Progressive files are left alone: switching them means re-downloading.
   */
  function applyRememberedQuality() {
    const wanted = parseInt(storageGet(QUALITY_KEY) || '', 10);
    if (!Number.isFinite(wanted) || wanted <= 0) return;
    if (!state.hlsInstance || !state.hlsInstance.levels || state.hlsInstance.levels.length < 2) return;
    const match = state.qualities.find((q) => q.id !== 'auto' && q.height === wanted);
    if (!match) return;
    applyQuality(match, state.qualities.indexOf(match), { remember: false, hlsOnly: true });
  }

  function openSettingsDrillPanel(panelType) {
    settingsMainPanel.classList.add('hidden');
    settingsDrillPanel.classList.remove('hidden');
    settingsDrillList.innerHTML = '';

    if (panelType === 'quality') {
      settingsDrillTitle.textContent = 'Select Quality';
      if (state.qualities.length === 0) {
        settingsDrillList.appendChild(createDrillOption('Auto (single quality)', true, closeSettingsDrillPanel));
      }
      state.qualities.forEach((q, idx) => {
        const item = createDrillOption(q.label + (q.bitrate ? ` (${q.bitrate})` : ''), q.id === state.activeQualityId, () => {
          applyQuality(q, idx);
          closeSettingsDrillPanel();
          showToast(`Quality: ${q.label}`, 2000);
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'audio') {
      settingsDrillTitle.textContent = 'Select Audio Track';
      if (state.audioTracks.length === 0) {
        settingsDrillList.appendChild(createDrillOption('Original Audio (single track)', true, closeSettingsDrillPanel));
      }
      state.audioTracks.forEach((track) => {
        const item = createDrillOption(track.label, track.id === state.activeAudioId, () => {
          selectAudioTrack(track);
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'subtitles') {
      settingsDrillTitle.textContent = 'Select Subtitles';
      settingsDrillList.appendChild(createDrillOption('Off', state.activeSubtitleId === 'off', () => {
        disableSubtitles();
        closeSettingsDrillPanel();
      }));
      state.subtitles.forEach((sub) => {
        const item = createDrillOption(sub.label, sub.id === state.activeSubtitleId, () => {
          loadSubtitleTrack(sub);
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
      if (state.subtitles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'popover-empty';
        empty.textContent = 'No subtitles were found for this title. Use the CC menu to upload a file.';
        settingsDrillList.appendChild(empty);
      }
    } else if (panelType === 'aspect') {
      settingsDrillTitle.textContent = 'Aspect Ratio';
      ['Fit', 'Fill', 'Stretch'].forEach((mode) => {
        const item = createDrillOption(mode, state.aspectRatio === mode, () => {
          state.aspectRatio = mode;
          applyMediaTransforms();
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'brightness') {
      settingsDrillTitle.textContent = 'Screen Brightness';
      [50, 75, 100, 125, 150].forEach((val) => {
        const item = createDrillOption(`${val}%`, state.brightness === val, () => {
          state.brightness = val;
          applyMediaTransforms();
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'speed') {
      settingsDrillTitle.textContent = 'Playback Speed';
      [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach((spd) => {
        const item = createDrillOption(spd === 1 ? '1x (Normal)' : `${spd}x`, state.playbackSpeed === spd, () => {
          state.playbackSpeed = spd;
          video.playbackRate = spd;
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    }
  }

  function createDrillOption(label, isActive, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popover-item-btn' + (isActive ? ' active' : '');
    const text = document.createElement('span');
    text.textContent = label;
    const check = document.createElement('span');
    check.className = 'popover-check';
    check.textContent = '✓';
    btn.appendChild(text);
    btn.appendChild(check);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function closeSettingsDrillPanel() {
    settingsDrillPanel.classList.add('hidden');
    settingsMainPanel.classList.remove('hidden');
    updateSettingsSummaryValues();
  }

  btnSettingsDrillBack.addEventListener('click', closeSettingsDrillPanel);

  // --- Timeline & Skip Intro Logic ---
  function findSegmentAt(seconds) {
    return state.segments.find((s) => s && seconds >= s.start && seconds < segmentEndSeconds(s)) || null;
  }

  /** Label for the button: outro only says "Next Episode" when there is one. */
  function skipLabelFor(seg) {
    const isOutro = seg.type === 'outro';
    if (seg.label && !(isOutro && (state.type !== 'tv' || !getNextEpisodeTarget()))) return seg.label;
    if (isOutro) return 'Skip Credits';
    if (seg.type === 'recap') return 'Skip Recap';
    if (seg.type === 'preview') return 'Skip Preview';
    return 'Skip Intro';
  }

  // Last width written to the progressive fill (browsers normalise the value
  // on read-back, so the change guard cannot compare against the DOM).
  let lastSkipFillWidth = '';
  function setSkipFillWidth(width) {
    if (width === lastSkipFillWidth) return;
    lastSkipFillWidth = width;
    skipProgressFill.style.width = width;
  }

  /** Hide the skip button and drop the yellow segment styling. */
  function clearActiveSkip() {
    state.activeSkipSegment = null;
    btnSkipIntro.classList.add('hidden');
    playerRoot.classList.remove('is-in-segment');
    setSkipFillWidth('0%');
  }

  function updateTimelineAndSkipState() {
    const current = video.currentTime || 0;
    const total = getEffectiveDuration();
    const pct = total > 0 ? clamp((current / total) * 100, 0, 100) : 0;

    const currentLabel = formatTime(current);
    const totalLabel = formatTime(total);
    if (timeCurrentEl.textContent !== currentLabel && !state.isDraggingTimeline) timeCurrentEl.textContent = currentLabel;
    if (timeDurationEl.textContent !== totalLabel) timeDurationEl.textContent = totalLabel;

    if (!state.isDraggingTimeline) {
      timelineProgress.style.width = `${pct}%`;
      timelineThumb.style.left = `${pct}%`;
      const ariaNow = String(Math.round(pct));
      if (timelineSlider.getAttribute('aria-valuenow') !== ariaNow) {
        timelineSlider.setAttribute('aria-valuenow', ariaNow);
        timelineSlider.setAttribute('aria-valuetext', `${currentLabel} of ${totalLabel}`);
      }
    }

    if (total > 0 && video.buffered && video.buffered.length > 0) {
      // Use the buffered range that contains the playhead, not just the last one.
      let bufEnd = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= current + 0.5 && video.buffered.end(i) >= bufEnd) {
          bufEnd = video.buffered.end(i);
        }
      }
      timelineBuffered.style.width = `${clamp((bufEnd / total) * 100, 0, 100)}%`;
    }

    // Only a real intro / recap / credits segment summons the skip button.
    const matchingSeg = state.upNextTarget ? null : findSegmentAt(current);
    if (matchingSeg) {
      if (state.activeSkipSegment !== matchingSeg) {
        state.activeSkipSegment = matchingSeg;
        const label = skipLabelFor(matchingSeg);
        skipIntroLabel.textContent = label;
        btnSkipIntro.setAttribute('aria-label', label);
        setSkipFillWidth('0%');
        btnSkipIntro.classList.remove('hidden');
        // Yellow progress fill + thumb while inside the segment.
        playerRoot.classList.add('is-in-segment');
      }
      // Auto-skip: intros / recaps / previews jump once per episode (so seeking
      // back into one shows the button instead of looping); credits keep the
      // manual button so the viewer decides about the next episode. Checked on
      // every tick, not only on entry: a recap at 0:00 is entered while the
      // player is still paused.
      if (state.autoSkip && matchingSeg.type !== 'outro' && !video.paused && !video.seeking && !state.isDraggingTimeline) {
        const autoKey = `${state.season}_${state.episode}_${matchingSeg.type}_${matchingSeg.start}`;
        if (!state.autoSkipped.has(autoKey)) {
          state.autoSkipped.add(autoKey);
          skipActiveSegment({ auto: true });
          return;
        }
      }
      // Progressive button: the fill tracks how much of the segment has elapsed.
      const segEnd = segmentEndSeconds(matchingSeg);
      const span = segEnd - matchingSeg.start;
      const ratio = Number.isFinite(span) && span > 0 ? clamp((current - matchingSeg.start) / span, 0, 1) : 0;
      setSkipFillWidth(`${(ratio * 100).toFixed(1)}%`);
    } else if (state.activeSkipSegment) {
      clearActiveSkip();
    }

    updateActiveSubtitleCue();
    saveProgress();
  }

  function skipActiveSegment(options = {}) {
    const seg = state.activeSkipSegment;
    if (!seg) return false;
    if (seg.type === 'outro' && state.type === 'tv' && getNextEpisodeTarget()) {
      goToNextEpisode();
      return true;
    }
    const total = getEffectiveDuration();
    const end = segmentEndSeconds(seg);
    // Never seek past the file; an open-ended credits segment lands just before the end.
    const targetSec = total > 0 ? Math.min(end, Math.max(0, total - 1)) : Number.isFinite(end) ? end : seg.start;
    video.currentTime = targetSec;
    clearActiveSkip();
    updateTimelineAndSkipState();
    showToast(options.auto ? `Auto-skipped ${seg.type} · ${formatTime(targetSec)}` : `Skipped to ${formatTime(targetSec)}`, 1800);
    return true;
  }

  btnSkipIntro.addEventListener('click', (e) => {
    e.stopPropagation();
    skipActiveSegment();
  });

  // --- Timeline Scrubbing & Hover Timestamp Tooltip (pointer events) ---
  function getTimelineHoverSeconds(clientX) {
    const rect = timelineSlider.getBoundingClientRect();
    const ratio = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    return { ratio, seconds: ratio * getEffectiveDuration(), rect };
  }

  function positionHoverTooltip(clientX) {
    const { ratio, seconds, rect } = getTimelineHoverSeconds(clientX);
    const seg = findSegmentAt(seconds);
    timelineHoverTooltip.innerHTML = seg
      ? `<span class="tooltip-chapter">${escapeHtml(SEGMENT_NOUNS[seg.type] || seg.label || seg.type || '')}</span>${formatTime(seconds)}`
      : formatTime(seconds);
    timelineHoverTooltip.classList.remove('hidden');
    // Keep the tooltip inside the slider at both ends.
    const half = timelineHoverTooltip.offsetWidth / 2;
    const px = clamp(ratio * rect.width, half, Math.max(half, rect.width - half));
    timelineHoverTooltip.style.left = `${px}px`;
    return { ratio, seconds };
  }

  function previewScrub(clientX) {
    const { ratio, seconds } = positionHoverTooltip(clientX);
    state.scrubSeconds = seconds;
    timelineProgress.style.width = `${ratio * 100}%`;
    timelineThumb.style.left = `${ratio * 100}%`;
    timeCurrentEl.textContent = formatTime(seconds);
    // Live-seek while dragging, throttled so the decoder is not thrashed.
    if (!state.scrubSeekTimer) {
      state.scrubSeekTimer = setTimeout(() => {
        state.scrubSeekTimer = null;
        if (state.isDraggingTimeline) video.currentTime = state.scrubSeconds;
      }, 160);
    }
  }

  function endScrub(e) {
    if (!state.isDraggingTimeline) return;
    state.isDraggingTimeline = false;
    timelineSlider.classList.remove('is-dragging');
    if (!e || e.pointerType !== 'mouse') timelineHoverTooltip.classList.add('hidden');
    if (state.scrubSeekTimer) {
      clearTimeout(state.scrubSeekTimer);
      state.scrubSeekTimer = null;
    }
    video.currentTime = state.scrubSeconds;
    updateTimelineAndSkipState();
  }

  timelineSlider.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!(getEffectiveDuration() > 0)) return;
    state.isDraggingTimeline = true;
    timelineSlider.classList.add('is-dragging');
    try { timelineSlider.setPointerCapture(e.pointerId); } catch (_) {}
    previewScrub(e.clientX);
    resetIdleTimer();
  });

  timelineSlider.addEventListener('pointermove', (e) => {
    if (state.isDraggingTimeline) {
      previewScrub(e.clientX);
    } else if (e.pointerType !== 'touch') {
      positionHoverTooltip(e.clientX);
    }
  });

  timelineSlider.addEventListener('pointerup', endScrub);
  timelineSlider.addEventListener('pointercancel', endScrub);
  timelineSlider.addEventListener('lostpointercapture', endScrub);

  timelineSlider.addEventListener('pointerleave', () => {
    if (!state.isDraggingTimeline) timelineHoverTooltip.classList.add('hidden');
  });

  // Keyboard scrubbing when the slider itself is focused
  timelineSlider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(5); }
    else if (e.key === 'Home') { e.preventDefault(); video.currentTime = 0; }
    else if (e.key === 'End' && hasRealDuration()) { e.preventDefault(); video.currentTime = Math.max(0, video.duration - 1); }
  });

  // --- Playback Controls ---
  function togglePlay() {
    closeAllPopovers();
    if (video.ended && state.type === 'tv' && upNextCard && !upNextCard.classList.contains('hidden')) {
      cancelUpNext();
    }
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function seekBy(deltaSec) {
    const total = getEffectiveDuration();
    const max = total > 0 ? total : Infinity;
    const target = clamp((video.currentTime || 0) + deltaSec, 0, max);
    video.currentTime = target;
    updateTimelineAndSkipState();

    const feedbackEl = deltaSec < 0 ? seekFeedbackLeft : seekFeedbackRight;
    feedbackEl.textContent = `${deltaSec < 0 ? '-' : '+'}${Math.abs(deltaSec)}s`;
    feedbackEl.classList.add('show');
    clearTimeout(feedbackEl._hideTimer);
    feedbackEl._hideTimer = setTimeout(() => feedbackEl.classList.remove('show'), 550);
  }

  // --- Episode navigation ---
  function getNextEpisodeTarget() {
    if (state.type !== 'tv') return null;
    const episodes = (state.media && state.media.episodes) || [];
    if (episodes.length > 0) {
      const next = episodes.find((ep) => ep.episode > state.episode);
      if (next) return { season: state.season, episode: next.episode, title: next.title };
      const totalSeasons = (state.media && state.media.totalSeasons) || state.season;
      if (state.season < totalSeasons) return { season: state.season + 1, episode: 1, title: '' };
      return null;
    }
    // Episode list unknown (metadata failed): optimistically try the next number.
    return { season: state.season, episode: state.episode + 1, title: '' };
  }

  function updateNextEpisodeButton() {
    const hasNext = !!getNextEpisodeTarget();
    btnNextEpisode.disabled = !hasNext;
    btnNextEpisode.title = hasNext ? 'Next Episode (Shift+N)' : 'This is the last available episode';
  }

  function goToNextEpisode() {
    const target = getNextEpisodeTarget();
    if (!target) {
      showToast('You have reached the last available episode', 2400);
      return;
    }
    cancelUpNext();
    saveProgress(true);
    state.season = target.season;
    state.episode = target.episode;
    state.browseSeason = target.season;
    syncUrlWithState();
    loadMediaBundle(false);
    emitHostEvent('episodechange', { season: state.season, episode: state.episode });
  }

  function startUpNextCountdown() {
    const target = getNextEpisodeTarget();
    if (!target) return false;
    state.upNextTarget = target;
    const label = target.title
      ? `S${target.season}E${target.episode} · ${target.title}`
      : `Season ${target.season}, Episode ${target.episode}`;
    upNextTitle.textContent = label;
    upNextProgressFill.style.width = '0%';
    upNextCard.classList.remove('hidden');
    clearActiveSkip();
    playerRoot.classList.remove('controls-idle');
    const durationMs = 8000;
    state.upNextDeadline = Date.now() + durationMs;
    if (state.upNextTimer) clearInterval(state.upNextTimer);
    state.upNextTimer = setInterval(() => {
      const remaining = state.upNextDeadline - Date.now();
      upNextProgressFill.style.width = `${clamp(100 - (remaining / durationMs) * 100, 0, 100)}%`;
      if (remaining <= 0) {
        clearInterval(state.upNextTimer);
        state.upNextTimer = null;
        goToNextEpisode();
      }
    }, 100);
    return true;
  }

  function cancelUpNext() {
    if (state.upNextTimer) clearInterval(state.upNextTimer);
    state.upNextTimer = null;
    state.upNextTarget = null;
    upNextCard.classList.add('hidden');
  }

  btnUpNextCancel.addEventListener('click', () => {
    cancelUpNext();
    showToast('Autoplay cancelled', 1600);
  });
  btnUpNextPlay.addEventListener('click', goToNextEpisode);

  function syncUrlWithState() {
    // The player page lives at `/embed` (query form) or one of the path forms
    // served by the same Worker. Rewrite whichever form is in use so a reload
    // of the rewritten URL opens the episode that is actually playing.
    try {
      const params = new URLSearchParams(window.location.search);
      const pathname = window.location.pathname;
      const pathMatch = pathname.match(/^(\/(?:embed\/)?)(?:tv|movie)\/[^/]+(?:\/\d+(?:\/\d+)?)?\/?$/i);
      let newPath = pathname;
      if (pathMatch) {
        const prefix = pathMatch[1];
        const id = encodeURIComponent(state.tmdbId);
        newPath = state.type === 'tv'
          ? `${prefix}tv/${id}/${state.season}/${state.episode}`
          : `${prefix}movie/${id}`;
        ['type', 'tmdb', 'id', 's', 'e', 'season', 'episode'].forEach((k) => params.delete(k));
      } else {
        params.set('type', state.type);
        params.set('tmdb', String(state.tmdbId));
        params.delete('id');
        params.delete('season');
        params.delete('episode');
        if (state.type === 'tv') {
          params.set('s', String(state.season));
          params.set('e', String(state.episode));
        } else {
          params.delete('s');
          params.delete('e');
        }
      }
      // A start offset belongs to the link that was opened, not to the next episode.
      params.delete('t');
      params.delete('start');
      const qs = params.toString();
      window.history.replaceState({}, '', `${newPath}${qs ? `?${qs}` : ''}`);
    } catch (_) {}
  }

  btnPlay.addEventListener('click', togglePlay);
  btnCenterPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });
  btnRewind.addEventListener('click', () => seekBy(-15));
  btnForward.addEventListener('click', () => seekBy(15));
  btnCenterRewind.addEventListener('click', (e) => {
    e.stopPropagation();
    seekBy(-15);
  });
  btnCenterForward.addEventListener('click', (e) => {
    e.stopPropagation();
    seekBy(15);
  });
  btnNextEpisode.addEventListener('click', goToNextEpisode);

  // Click / tap / double-tap on the picture. Clicking the picture never
  // pauses: play/pause lives on the buttons, Space and K.
  //  - mouse:  click = show the controls, double-click = fullscreen
  //  - touch:  tap = show the controls (or hide them while playing),
  //            double-tap left/right = ±15s, double-tap center = fullscreen
  let lastPointerType = 'mouse';
  let tapTimer = null;
  let lastTapAt = 0;
  let hudWasIdleOnPointerDown = false;
  playerRoot.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse';
    // Captured before touchstart wakes the HUD, so a tap on hidden controls
    // shows them instead of immediately hiding them again.
    hudWasIdleOnPointerDown = playerRoot.classList.contains('controls-idle');
  }, { passive: true, capture: true });

  // --- Hold to fast-forward (press and hold the picture for 2×) ---
  const LONG_PRESS_MS = 550;
  let longPressTimer = null;
  let longPressStart = null;
  let suppressNextCenterClick = false;

  function startLongPressBoost() {
    if (state.longPressBoost || video.paused || video.ended) return;
    state.longPressBoost = { prevRate: video.playbackRate || state.playbackSpeed || 1 };
    video.playbackRate = 2;
    speedBoostBadge.classList.remove('hidden');
    speedBoostBadge.setAttribute('aria-hidden', 'false');
    // The matching pointerup ends in a click: that click must not toggle the HUD.
    suppressNextCenterClick = true;
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
    lastTapAt = 0;
  }

  function endLongPressBoost() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
    if (!state.longPressBoost) return;
    const { prevRate } = state.longPressBoost;
    state.longPressBoost = null;
    video.playbackRate = prevRate;
    speedBoostBadge.classList.add('hidden');
    speedBoostBadge.setAttribute('aria-hidden', 'true');
  }

  centerClickZone.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressStart = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      startLongPressBoost();
    }, LONG_PRESS_MS);
  });
  centerClickZone.addEventListener('pointermove', (e) => {
    // A drag / scroll gesture is not a hold.
    if (!longPressTimer || !longPressStart) return;
    if (Math.abs(e.clientX - longPressStart.x) > 12 || Math.abs(e.clientY - longPressStart.y) > 12) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => {
    centerClickZone.addEventListener(type, endLongPressBoost);
  });
  window.addEventListener('blur', endLongPressBoost);
  // Android raises the context menu on a long touch; that would end the press.
  centerClickZone.addEventListener('contextmenu', (e) => {
    if (longPressTimer || state.longPressBoost) e.preventDefault();
  });

  centerClickZone.addEventListener('click', (e) => {
    if (suppressNextCenterClick) {
      suppressNextCenterClick = false;
      return;
    }
    const now = Date.now();
    const isTouch = lastPointerType === 'touch' || lastPointerType === 'pen';
    if (now - lastTapAt < 300) {
      lastTapAt = 0;
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
      }
      const width = playerRoot.clientWidth || 1;
      const ratio = (e.clientX - playerRoot.getBoundingClientRect().left) / width;
      if (isTouch && ratio < 0.33) seekBy(-15);
      else if (isTouch && ratio > 0.67) seekBy(15);
      else toggleFullscreen();
      return;
    }
    lastTapAt = now;
    const hudWasIdle = hudWasIdleOnPointerDown;
    tapTimer = setTimeout(() => {
      tapTimer = null;
      if (isTouch && !hudWasIdle && !video.paused && !playerRoot.classList.contains('controls-idle')) {
        // Controls were already showing: a tap tucks them away again.
        if (state.idleTimer) clearTimeout(state.idleTimer);
        playerRoot.classList.add('controls-idle');
        closeAllPopovers();
        return;
      }
      resetIdleTimer();
    }, 240);
  });

  function setPlayingUI(isPlaying) {
    iconPlay.classList.toggle('hidden', isPlaying);
    iconPause.classList.toggle('hidden', !isPlaying);
    iconCenterPlay.classList.toggle('hidden', isPlaying);
    iconCenterPause.classList.toggle('hidden', !isPlaying);
    btnCenterPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    playerRoot.classList.toggle('is-playing', isPlaying);
  }

  function startRenderLoop() {
    if (state.rafId) return;
    const tick = () => {
      updateTimelineAndSkipState();
      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
  }

  function stopRenderLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  // Media element event wiring. Every listener is registered through
  // onMediaEvent() so the exact same set can be replayed when a movi-player
  // element replaces the native <video> as the active media element (the
  // Goldmine MKV engine mirrors the HTMLMediaElement event set).
  const mediaListenerRegistry = [];
  function onMediaEvent(el, type, handler, opts) {
    const guarded = function (evt) {
      if (evt && evt.currentTarget && evt.currentTarget !== video) return;
      return handler.call(this, evt);
    };
    el.addEventListener(type, guarded, opts);
    mediaListenerRegistry.push({ type, handler: guarded, opts });
  }

  onMediaEvent(video, 'play', () => {
    setPlayingUI(true);
    playerRoot.classList.remove('is-ended');
    state.hasPlaybackStarted = true;
    hidePausedInfo();
    resetIdleTimer();
    emitHostEvent('play');
    emitStateChange();
  });

  onMediaEvent(video, 'playing', () => {
    state.progressLocked = false;
    hostBuffering = false;
    state.activeSourceLive = true;
    hideBuffering();
    hideLoading();
    startRenderLoop();
    // The servers popover shows "Connecting" until this point; reflect it.
    if (!popoverServers.classList.contains('hidden')) renderServersPopover();
    emitHostEvent('playing');
    emitStateChange();
  });

  onMediaEvent(video, 'pause', () => {
    endLongPressBoost();
    setPlayingUI(false);
    stopRenderLoop();
    updateTimelineAndSkipState();
    saveProgress(true);
    // Keep the HUD on screen while paused; the title card takes over after a
    // couple of idle seconds.
    if (state.idleTimer) clearTimeout(state.idleTimer);
    playerRoot.classList.remove('controls-idle');
    schedulePausedInfo();
    emitHostEvent('pause');
    emitStateChange();
  });

  // Buffering is its own state for the host: a stalled guest must never look
  // like a deliberate pause.
  onMediaEvent(video, 'waiting', () => {
    hostBuffering = true;
    showBuffering();
    emitHostEvent('waiting');
    emitStateChange();
  });
  onMediaEvent(video, 'stalled', () => {
    if (video.paused) return;
    hostBuffering = true;
    emitStateChange();
  });
  onMediaEvent(video, 'seeking', () => {
    if (state.hasPlaybackStarted) showBuffering();
    emitHostEvent('seeking');
    emitStateChange();
  });
  onMediaEvent(video, 'seeked', () => {
    hideBuffering();
    updateTimelineAndSkipState();
    emitHostEvent('seeked');
    emitStateChange();
  });
  onMediaEvent(video, 'canplay', () => {
    hostBuffering = false;
    hideBuffering();
    emitStateChange();
  });
  onMediaEvent(video, 'volumechange', () => {
    emitHostEvent('volumechange');
  });

  onMediaEvent(video, 'timeupdate', () => {
    if (!state.rafId) updateTimelineAndSkipState();
    emitHostEvent('timeupdate');
  });

  onMediaEvent(video, 'loadedmetadata', () => {
    state.progressLocked = false;
    renderSegmentedTimeline();
    updateTimelineAndSkipState();
    emitHostEvent('loadedmetadata');
  });

  onMediaEvent(video, 'durationchange', () => {
    renderSegmentedTimeline();
    updateTimelineAndSkipState();
    if (hasRealDuration()) emitHostEvent('durationchange');
  });

  onMediaEvent(video, 'ratechange', () => {
    // A hold-to-fast-forward 2× is temporary: it must not become the setting.
    if (!state.longPressBoost && video.playbackRate > 0 && video.playbackRate !== state.playbackSpeed) {
      state.playbackSpeed = video.playbackRate;
      updateSettingsSummaryValues();
    }
    emitHostEvent('ratechange', { boost: !!state.longPressBoost });
  });

  onMediaEvent(video, 'ended', () => {
    stopRenderLoop();
    setPlayingUI(false);
    hidePausedInfo();
    playerRoot.classList.add('is-ended');
    playerRoot.classList.remove('controls-idle');
    // Mark as finished so the episode card fills up and resume starts over.
    if (hasRealDuration()) {
      storageSet(
        progressKey(state.type, state.tmdbId, state.season, state.episode),
        JSON.stringify({ t: Math.floor(video.duration), d: Math.floor(video.duration) })
      );
    } else {
      storageRemove(progressKey(state.type, state.tmdbId, state.season, state.episode));
    }
    emitHostEvent('ended');
    emitStateChange();
    if (state.type === 'tv') {
      if (!startUpNextCountdown()) {
        showToast('You have reached the last available episode', 3000);
      }
    }
  });

  onMediaEvent(video, 'enterpictureinpicture', updateSettingsSummaryValues);
  onMediaEvent(video, 'leavepictureinpicture', updateSettingsSummaryValues);

  // Volume & Mute (persisted across loads)
  function persistVolume() {
    storageSet('lol_embed_volume', String(video.volume));
    storageSet('lol_embed_muted', video.muted ? '1' : '0');
  }

  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
    updateVolumeUI();
    persistVolume();
  });

  volumeRange.addEventListener('input', () => {
    video.volume = parseFloat(volumeRange.value);
    video.muted = video.volume === 0;
    updateVolumeUI();
    persistVolume();
  });

  onMediaEvent(video, 'volumechange', updateVolumeUI);

  function updateVolumeUI() {
    const muted = video.muted || video.volume === 0;
    iconVolMuted.classList.toggle('hidden', !muted);
    iconVolLow.classList.toggle('hidden', muted || video.volume >= 0.5);
    iconVolHigh.classList.toggle('hidden', muted || video.volume < 0.5);
    btnMute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    const sliderValue = muted ? 0 : video.volume;
    if (Math.abs(parseFloat(volumeRange.value) - sliderValue) > 0.001) {
      volumeRange.value = String(sliderValue);
    }
  }

  function adjustVolume(delta) {
    video.volume = clamp(Math.round((video.volume + delta) * 20) / 20, 0, 1);
    video.muted = video.volume === 0;
    updateVolumeUI();
    persistVolume();
    showToast(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`, 1200);
  }

  function restoreVolume() {
    const savedVolume = parseFloat(storageGet('lol_embed_volume') || '');
    if (isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) video.volume = savedVolume;
    if (storageGet('lol_embed_muted') === '1') video.muted = true;
    updateVolumeUI();
  }

  // Fullscreen
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateFullscreenUI() {
    const fs = isFullscreen();
    iconFsEnter.classList.toggle('hidden', fs);
    iconFsExit.classList.toggle('hidden', !fs);
    btnFullscreen.title = fs ? 'Exit Fullscreen (F)' : 'Fullscreen (F)';
    btnFullscreen.setAttribute('aria-label', fs ? 'Exit Fullscreen' : 'Fullscreen');
    playerRoot.classList.toggle('is-fullscreen', fs);
    if (!fs && window.screen && window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
      try { window.screen.orientation.unlock(); } catch (_) {}
    }
  }

  function toggleFullscreen() {
    if (!isFullscreen()) {
      let requested = null;
      if (playerRoot.requestFullscreen) {
        requested = playerRoot.requestFullscreen();
      } else if (playerRoot.webkitRequestFullscreen) {
        playerRoot.webkitRequestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        // iPhone Safari: only the <video> element can go fullscreen.
        try { video.webkitEnterFullscreen(); } catch (_) {}
        return;
      }
      if (requested && typeof requested.catch === 'function') {
        requested.catch(() => showToast('Fullscreen is not available here', 2000));
      }
      // Rotate phones to landscape when the browser allows it.
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.lock === 'function') {
        try {
          const lock = window.screen.orientation.lock('landscape');
          if (lock && typeof lock.catch === 'function') lock.catch(() => {});
        } catch (_) {}
      }
      if (lastPointerType === 'touch') {
        showToast(`${state.branding} – to exit full screen, drag from the top and touch the back button`, 3800);
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }

  btnFullscreen.addEventListener('click', toggleFullscreen);
  const onFullscreenChange = () => {
    updateFullscreenUI();
    emitHostEvent('fullscreenchange');
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // Back Button
  btnBack.addEventListener('click', () => {
    emitHostEvent('back');
    if (document.referrer && window.history.length > 1) {
      window.history.back();
    } else {
      showToast('Back event sent to host page', 1800);
    }
  });

  // --- Popovers & Modals Toggling ---
  function closeAllPopovers() {
    popoverAudio.classList.add('hidden');
    popoverSubtitles.classList.add('hidden');
    popoverServers.classList.add('hidden');
    btnServers.classList.remove('is-open');
    btnServers.setAttribute('aria-expanded', 'false');
    subtitleStyleView.classList.add('hidden');
    subtitleDelayView.classList.add('hidden');
    subtitleMainView.classList.remove('hidden');
    btnAudioMenu.classList.remove('is-open');
    btnSubtitlesMenu.classList.remove('is-open');
    btnAudioMenu.setAttribute('aria-expanded', 'false');
    btnSubtitlesMenu.setAttribute('aria-expanded', 'false');
  }

  function closeAllModals() {
    modalSettingsBackdrop.classList.add('hidden');
    modalEpisodesBackdrop.classList.add('hidden');
  }

  function isAnyOverlayOpen() {
    return (
      !modalSettingsBackdrop.classList.contains('hidden') ||
      !modalEpisodesBackdrop.classList.contains('hidden') ||
      !popoverServers.classList.contains('hidden') ||
      !popoverAudio.classList.contains('hidden') ||
      !popoverSubtitles.classList.contains('hidden') ||
      !upNextCard.classList.contains('hidden')
    );
  }

  btnAudioMenu.addEventListener('click', () => {
    const wasHidden = popoverAudio.classList.contains('hidden');
    closeAllPopovers();
    if (wasHidden) {
      renderAudioPopover();
      popoverAudio.classList.remove('hidden');
      btnAudioMenu.classList.add('is-open');
      btnAudioMenu.setAttribute('aria-expanded', 'true');
    }
  });

  btnSubtitlesMenu.addEventListener('click', () => {
    const wasHidden = popoverSubtitles.classList.contains('hidden');
    closeAllPopovers();
    if (wasHidden) {
      renderSubtitlesPopover();
      popoverSubtitles.classList.remove('hidden');
      btnSubtitlesMenu.classList.add('is-open');
      btnSubtitlesMenu.setAttribute('aria-expanded', 'true');
    }
  });

  // Click anywhere outside an open popover closes it.
  document.addEventListener('pointerdown', (e) => {
    if (
      popoverAudio.classList.contains('hidden') &&
      popoverSubtitles.classList.contains('hidden') &&
      popoverServers.classList.contains('hidden')
    ) {
      return;
    }
    const target = e.target;
    if (
      popoverAudio.contains(target) ||
      popoverSubtitles.contains(target) ||
      popoverServers.contains(target) ||
      btnAudioMenu.contains(target) ||
      btnSubtitlesMenu.contains(target) ||
      btnServers.contains(target)
    ) {
      return;
    }
    closeAllPopovers();
  });

  // Subtitle Style & Delay subviews
  btnSubStyle.addEventListener('click', () => {
    subtitleMainView.classList.add('hidden');
    subtitleStyleView.classList.remove('hidden');
  });

  btnSubStyleBack.addEventListener('click', () => {
    subtitleStyleView.classList.add('hidden');
    subtitleMainView.classList.remove('hidden');
  });

  btnSubDelay.addEventListener('click', () => {
    subtitleMainView.classList.add('hidden');
    subtitleDelayView.classList.remove('hidden');
  });

  btnSubDelayBack.addEventListener('click', () => {
    subtitleDelayView.classList.add('hidden');
    subtitleMainView.classList.remove('hidden');
  });

  const SUB_STYLE_KEY = 'lol_embed_sub_style';
  function readSubStyle() {
    try {
      return JSON.parse(storageGet(SUB_STYLE_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function applySubStyle(style) {
    if (style.size) document.documentElement.style.setProperty('--sub-font-size', style.size);
    if (style.color) document.documentElement.style.setProperty('--sub-color', style.color);
    if (style.bg) document.documentElement.style.setProperty('--sub-bg', style.bg);
    const mark = (groupId, attr, value) => {
      if (!value) return;
      document.querySelectorAll(`#${groupId} .pill-choice`).forEach((b) => {
        b.classList.toggle('active', b.dataset[attr] === value);
      });
    };
    mark('sub-size-group', 'size', style.size);
    mark('sub-color-group', 'color', style.color);
    mark('sub-bg-group', 'bg', style.bg);
  }

  function bindPillGroup(groupId, attr, cssVar, styleKey) {
    document.querySelectorAll(`#${groupId} .pill-choice`).forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${groupId} .pill-choice`).forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.documentElement.style.setProperty(cssVar, btn.dataset[attr]);
        const style = readSubStyle();
        style[styleKey] = btn.dataset[attr];
        storageSet(SUB_STYLE_KEY, JSON.stringify(style));
      });
    });
  }

  bindPillGroup('sub-size-group', 'size', '--sub-font-size', 'size');
  bindPillGroup('sub-color-group', 'color', '--sub-color', 'color');
  bindPillGroup('sub-bg-group', 'bg', '--sub-bg', 'bg');

  function renderSubtitleDelay() {
    const formatted = `${state.subtitleDelaySec >= 0 ? '+' : '−'}${Math.abs(state.subtitleDelaySec).toFixed(1)}s`;
    delayCurrentValue.textContent = formatted;
    subDelayBadge.textContent = state.subtitleDelaySec === 0 ? 'Delay' : `Delay (${formatted})`;
  }

  document.querySelectorAll('.delay-step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = parseFloat(btn.dataset.delta);
      if (delta === 0) {
        state.subtitleDelaySec = 0;
      } else {
        state.subtitleDelaySec = clamp(Math.round((state.subtitleDelaySec + delta) * 10) / 10, -30, 30);
      }
      renderSubtitleDelay();
      updateActiveSubtitleCue();
    });
  });

  // Modals Open/Close
  btnSettingsModal.addEventListener('click', () => {
    closeAllPopovers();
    closeSettingsDrillPanel();
    modalSettingsBackdrop.classList.remove('hidden');
  });

  btnCloseSettings.addEventListener('click', () => {
    modalSettingsBackdrop.classList.add('hidden');
  });

  modalSettingsBackdrop.addEventListener('click', (e) => {
    if (e.target === modalSettingsBackdrop) modalSettingsBackdrop.classList.add('hidden');
  });

  btnEpisodes.addEventListener('click', () => {
    closeAllPopovers();
    state.browseSeason = state.season;
    modalEpisodesBackdrop.classList.remove('hidden');
    renderEpisodesModal();
  });

  btnCloseEpisodes.addEventListener('click', () => {
    modalEpisodesBackdrop.classList.add('hidden');
  });

  modalEpisodesBackdrop.addEventListener('click', (e) => {
    if (e.target === modalEpisodesBackdrop) modalEpisodesBackdrop.classList.add('hidden');
  });

  btnServers.addEventListener('click', () => {
    const wasHidden = popoverServers.classList.contains('hidden');
    closeAllPopovers();
    if (wasHidden) openServersPopover();
  });

  // Auto-hide HUD on inactivity during playback
  function resetIdleTimer() {
    playerRoot.classList.remove('controls-idle');
    if (playerRoot.classList.contains('is-paused-info') || state.pausedInfoTimer) {
      hidePausedInfo();
      schedulePausedInfo();
    }
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (!video.paused && !video.ended && !isAnyOverlayOpen() && !state.isDraggingTimeline) {
        playerRoot.classList.add('controls-idle');
      }
    }, 3200);
  }

  playerRoot.addEventListener('mousemove', resetIdleTimer);
  playerRoot.addEventListener('touchstart', resetIdleTimer, { passive: true });
  playerRoot.addEventListener('keydown', resetIdleTimer);
  playerRoot.addEventListener('mouseleave', () => {
    if (!video.paused && !isAnyOverlayOpen() && !state.isDraggingTimeline) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => playerRoot.classList.add('controls-idle'), 800);
    }
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const active = document.activeElement;
    if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
    if (active === timelineSlider && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;

    const key = e.key;
    if (e.code === 'Space' || key === 'k' || key === 'K') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft' || key === 'j' || key === 'J') {
      e.preventDefault();
      seekBy(-15);
    } else if (e.code === 'ArrowRight' || key === 'l' || key === 'L') {
      e.preventDefault();
      seekBy(15);
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      adjustVolume(0.1);
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      adjustVolume(-0.1);
    } else if (key === 'f' || key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (key === 'm' || key === 'M') {
      e.preventDefault();
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 0.5;
      updateVolumeUI();
      persistVolume();
      showToast(video.muted ? 'Muted' : 'Unmuted', 1200);
    } else if (key === 'c' || key === 'C') {
      e.preventDefault();
      if (state.activeSubtitleId !== 'off') {
        disableSubtitles();
        showToast('Subtitles off', 1400);
      } else {
        const candidate =
          (state.lastSubtitleId && state.subtitles.find((s) => s.id === state.lastSubtitleId)) ||
          (state.preferredSubtitleLang && state.subtitles.find((s) => String(s.lang || '').toLowerCase() === state.preferredSubtitleLang)) ||
          state.subtitles.find((s) => s.lang === 'en') ||
          state.subtitles[0];
        if (candidate) loadSubtitleTrack(candidate);
        else showToast('No subtitles available for this title', 1800);
      }
    } else if (key === 's' || key === 'S') {
      if (skipActiveSegment()) e.preventDefault();
    } else if (key === 'N' && e.shiftKey) {
      e.preventDefault();
      goToNextEpisode();
    } else if (/^[0-9]$/.test(key) && hasRealDuration()) {
      e.preventDefault();
      video.currentTime = (parseInt(key, 10) / 10) * video.duration;
      updateTimelineAndSkipState();
    } else if (key === 'Escape') {
      closeAllPopovers();
      closeAllModals();
      if (!upNextCard.classList.contains('hidden')) cancelUpNext();
    }
    resetIdleTimer();
  });

  // Listen for remote control commands from parent page via postMessage
  // Commands: `{ type: 'LOL_EMBED_PLAYER_COMMAND', command, requestId?, ...args }`
  // (the bare legacy `{ command: 'play' }` and VIDBOLT_* forms still work).
  // A `requestId` always gets a `LOL_EMBED_PLAYER_RESPONSE` with the snapshot;
  // query commands answer even without one.
  const HOST_QUERY_COMMANDS = new Set(['getState', 'getTime', 'getDuration', 'ping']);
  const LEGACY_COMMANDS = { VIDBOLT_PLAY: 'play', VIDBOLT_PAUSE: 'pause' };

  function jumpToEpisode(season, episode) {
    saveProgress(true);
    cancelUpNext();
    state.season = season;
    state.episode = episode;
    state.browseSeason = season;
    closeAllModals();
    syncUrlWithState();
    loadMediaBundle(false);
    emitHostEvent('episodechange', { season: state.season, episode: state.episode });
  }

  async function runHostCommand(command, msg) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    switch (command) {
      case 'play': {
        if (video.ended) cancelUpNext();
        try {
          await video.play();
        } catch (err) {
          return { ok: false, error: (err && err.name) || 'PlayFailed' };
        }
        return { ok: true };
      }
      case 'pause':
        video.pause();
        return { ok: true };
      case 'togglePlay':
        togglePlay();
        return { ok: true };
      case 'seek': {
        const t = num(msg.time !== undefined ? msg.time : msg.seconds);
        if (t === null) return { ok: false, error: 'seek needs a numeric `time` (seconds)' };
        const total = getEffectiveDuration();
        video.currentTime = clamp(t, 0, total > 0 ? total : Infinity);
        updateTimelineAndSkipState();
        return { ok: true };
      }
      case 'seekBy': {
        const d = num(msg.delta !== undefined ? msg.delta : msg.seconds);
        if (d === null) return { ok: false, error: 'seekBy needs a numeric `delta` (seconds)' };
        seekBy(d);
        return { ok: true };
      }
      case 'setVolume': {
        const v = num(msg.volume);
        if (v === null) return { ok: false, error: 'setVolume needs a numeric `volume` (0..1)' };
        video.volume = clamp(v, 0, 1);
        if (typeof msg.muted === 'boolean') video.muted = msg.muted;
        else if (video.volume > 0 && video.muted) video.muted = false;
        volumeRange.value = String(video.volume);
        updateVolumeUI();
        persistVolume();
        return { ok: true };
      }
      case 'setMuted':
        video.muted = msg.muted !== false;
        updateVolumeUI();
        persistVolume();
        return { ok: true };
      case 'setPlaybackRate': {
        const r = num(msg.rate !== undefined ? msg.rate : msg.playbackRate);
        if (r === null || r < 0.25 || r > 4) return { ok: false, error: 'setPlaybackRate needs `rate` between 0.25 and 4' };
        state.playbackSpeed = r;
        video.playbackRate = r;
        updateSettingsSummaryValues();
        return { ok: true };
      }
      case 'setSubtitle': {
        const wanted = msg.id || msg.lang || msg.subtitle;
        if (!wanted || String(wanted).toLowerCase() === 'off') {
          disableSubtitles({ remember: true });
          return { ok: true };
        }
        const normLang = normalizeMoviLang(wanted);
        const rawLower = String(wanted).toLowerCase();
        const track =
          state.subtitles.find((t) => t.id === wanted) ||
          (normLang !== 'und' && state.subtitles.find((t) => normalizeMoviLang(t.lang) === normLang)) ||
          state.subtitles.find((t) => String(t.lang || '').toLowerCase() === rawLower);
        if (!track) return { ok: false, error: `No subtitle track matches "${wanted}"` };
        loadSubtitleTrack(track, { silent: true, remember: true });
        return { ok: true };
      }
      case 'setAudio': {
        const wanted = msg.id || msg.lang || msg.audio;
        if (!wanted) return { ok: false, error: 'setAudio needs `id` or `lang`' };
        const normLang = normalizeMoviLang(wanted);
        const rawLower = String(wanted).toLowerCase();
        const track =
          state.audioTracks.find((t) => t.id === wanted) ||
          (normLang !== 'und' && state.audioTracks.find((t) => t.inFile && normalizeMoviLang(t.lang) === normLang)) ||
          (normLang !== 'und' && state.audioTracks.find((t) => normalizeMoviLang(t.lang) === normLang)) ||
          state.audioTracks.find((t) => String(t.lang || '').toLowerCase() === rawLower);
        if (!track) return { ok: false, error: `No audio track matches "${wanted}"` };
        selectAudioTrack(track);
        return { ok: true };
      }
      case 'setSource': {
        if (!state.stream) return { ok: false, error: 'No active stream bundle' };
        const sources = sourcesFromStream(state.stream);
        let url = typeof msg.url === 'string' && sources.includes(msg.url) ? msg.url : null;
        if (!url) {
          const idx1 = num(msg.index !== undefined ? msg.index : msg.sourceIndex);
          if (idx1 !== null && idx1 >= 1 && idx1 <= sources.length) {
            url = sources[Math.floor(idx1) - 1];
          }
        }
        if (!url) return { ok: false, error: 'setSource needs a valid 1-based `index` or `url`' };
        const label = (state.stream.sourceLabels && state.stream.sourceLabels[url]) || `Source ${sources.indexOf(url) + 1}`;
        switchToSource(state.server, url, label);
        return { ok: true };
      }
      case 'setServer': {
        const id = String(msg.server || msg.id || '').toLowerCase();
        if (!state.servers.some((srv) => srv.id === id)) return { ok: false, error: `Unknown server "${id}"` };
        if (id !== state.server) selectServer(id);
        return { ok: true };
      }
      case 'setEpisode': {
        if (state.type !== 'tv') return { ok: false, error: 'setEpisode only applies to TV' };
        const season = num(msg.season);
        const episode = num(msg.episode);
        if (!(season >= 1) || !(episode >= 1)) return { ok: false, error: 'setEpisode needs `season` and `episode` >= 1' };
        if (season !== state.season || episode !== state.episode) jumpToEpisode(Math.floor(season), Math.floor(episode));
        return { ok: true };
      }
      case 'nextEpisode':
        if (!getNextEpisodeTarget()) return { ok: false, error: 'No next episode' };
        goToNextEpisode();
        return { ok: true };
      case 'setAutoSkip': {
        const on = msg.enabled !== undefined ? msg.enabled : msg.autoSkip;
        if (typeof on !== 'boolean') return { ok: false, error: 'setAutoSkip needs boolean `enabled`' };
        setAutoSkip(on);
        return { ok: true };
      }
      case 'skipSegment': {
        const skipped = skipActiveSegment();
        return { ok: skipped, error: skipped ? null : 'No intro / recap / credits segment at the current position' };
      }
      case 'getState':
      case 'getTime':
      case 'getDuration':
      case 'ping':
        return { ok: true };
      default:
        return { ok: false, error: `Unknown command "${command}"` };
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.source === HOST_SOURCE) return;
    // Only the embedding page (or the window that opened us) may drive the
    // player; a named ?origin= narrows that further.
    if (state.hostOrigin && event.origin !== state.hostOrigin) return;
    if (event.source && event.source !== window.parent && event.source !== window.top && event.source !== window.opener) return;
    const replyOrigin = event.origin && event.origin !== 'null' ? event.origin : '*';

    if (msg.type === 'SCREENSCAPE_GET_WATCH_HISTORY_WITH_PROGRESS') {
      postToHost({
        type: 'SCREENSCAPE_WATCH_HISTORY_WITH_PROGRESS_RESPONSE',
        requestId: msg.requestId,
        watchHistory: [{
          tmdbId: state.tmdbId,
          type: state.type,
          season: state.season,
          episode: state.episode,
          currentTime: video.currentTime || 0,
          duration: getEffectiveDuration()
        }]
      }, event.source || null, replyOrigin);
      return;
    }

    const command = typeof msg.command === 'string' ? msg.command : LEGACY_COMMANDS[msg.type];
    if (!command) return;
    runHostCommand(command, msg).then((result) => {
      if (msg.requestId === undefined && !HOST_QUERY_COMMANDS.has(command)) return;
      postToHost(
        {
          source: HOST_SOURCE,
          type: HOST_RESPONSE_TYPE,
          command,
          requestId: msg.requestId === undefined ? null : msg.requestId,
          ok: result.ok,
          error: result.error || null,
          ...hostSnapshot()
        },
        event.source || null,
        replyOrigin
      );
    });
  });

  // Persist progress when the tab is hidden / the iframe is torn down.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress(true);
  });
  window.addEventListener('pagehide', () => saveProgress(true));

  // Initialize Player
  parseRouteParams();
  emitHostEvent('init');
  restoreVolume();
  applySubStyle(readSubStyle());
  renderSubtitleDelay();
  updateFullscreenUI();
  setPlayingUI(false);
  renderSegmentedTimeline();
  applyCompactLayout();
  loadMediaBundle(false);
})();
