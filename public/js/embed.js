(function () {
  'use strict';

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
  }

  // --- DOM Elements ---
  const playerRoot = document.getElementById('player-root');
  const video = document.getElementById('video-element');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatusText = document.getElementById('loading-status-text');
  const playerToast = document.getElementById('player-toast');
  const playerToastText = document.getElementById('player-toast-text');

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
  const iconVolMuted = document.getElementById('icon-vol-muted');
  const volumeRange = document.getElementById('volume-range');

  const btnAudioMenu = document.getElementById('btn-audio-menu');
  const btnSubtitlesMenu = document.getElementById('btn-subtitles-menu');
  const btnSettingsModal = document.getElementById('btn-settings-modal');
  const btnFullscreen = document.getElementById('btn-fullscreen');

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

  const modalEpisodesBackdrop = document.getElementById('modal-episodes-backdrop');
  const seasonSelect = document.getElementById('season-select');
  const episodesGrid = document.getElementById('episodes-grid');
  const btnCloseEpisodes = document.getElementById('btn-close-episodes');

  const modalServersBackdrop = document.getElementById('modal-servers-backdrop');
  const serversListContainer = document.getElementById('servers-list-container');
  const btnCloseServers = document.getElementById('btn-close-servers');

  const seekFeedbackLeft = document.getElementById('seek-feedback-left');
  const seekFeedbackRight = document.getElementById('seek-feedback-right');

  // --- Player State ---
  const state = {
    type: 'tv',
    tmdbId: '94605',
    season: 1,
    episode: 1,
    server: 'andromeda',
    branding: 'LOL Embed',
    media: null,
    stream: null,
    segments: [],
    chapters: [],
    subtitles: [],
    audioTracks: [],
    qualities: [],
    servers: [],
    activeAudioId: 'en-dub',
    activeSubtitleId: 'off',
    activeQualityId: 'auto',
    parsedCues: [],
    subtitleDelaySec: 0,
    aspectRatio: 'Fit',
    brightness: 100,
    mirror: false,
    playbackSpeed: 1,
    hlsInstance: null,
    dashInstance: null,
    activeSkipSegment: null,
    isDraggingTimeline: false,
    idleTimer: null,
    toastTimer: null
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

    if (params.get('server')) {
      const rawServer = params.get('server').toLowerCase();
      state.server = rawServer;
    }
    if (params.get('branding')) state.branding = params.get('branding');
    if (params.get('lang')) {
      const l = params.get('lang').toLowerCase();
      state.activeAudioId = l.includes('-') ? l : `${l}-dub`;
    }
    if (params.get('sub')) {
      state.activeSubtitleId = `vtt-${params.get('sub').toLowerCase()}`;
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
      document.documentElement.style.setProperty('--accent', resolvedColor);
    }

    if (params.get('back') === 'false' || params.get('back') === '0') {
      btnBack.classList.add('hidden');
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
    playerToast.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      playerToast.classList.add('hidden');
    }, durationMs);
  }

  // --- Emit postMessage to Parent Host ---
  function emitHostEvent(eventName, data = {}) {
    try {
      window.parent.postMessage({
        source: 'lol-embed-player',
        type: 'LOL_EMBED_PLAYER_EVENT',
        event: eventName,
        tmdbId: state.tmdbId,
        mediaType: state.type,
        season: state.season,
        episode: state.episode,
        currentTime: video.currentTime || 0,
        duration: getEffectiveDuration(),
        ...data
      }, '*');
    } catch (_) {}
  }

  function getEffectiveDuration() {
    if (video.duration && isFinite(video.duration) && video.duration > 10) {
      return video.duration;
    }
    return (state.media && state.media.durationSec) || 2603;
  }

  // --- Normalize Backend Metadata into UI State ---
  function normalizeMetadata(meta) {
    if (!meta) return null;
    const isTv = meta.type === 'tv';
    const displayTitle = isTv
      ? `${meta.title || `TMDB #${state.tmdbId}`} S${meta.season || state.season}E${meta.episode || state.episode}`
      : meta.title || `TMDB #${state.tmdbId}`;

    const tags = [
      isTv ? 'Series' : 'Movie',
      ...(Array.isArray(meta.genres) ? meta.genres.slice(0, 2) : []),
      ...(meta.releaseYear ? [String(meta.releaseYear)] : [])
    ];

    const durationSec = meta.runtime ? Number(meta.runtime) * 60 : isTv ? 2520 : 7200;
    const totalSeasons =
      Array.isArray(meta.seasons) && meta.seasons.length > 0
        ? Math.max(...meta.seasons.map((s) => Number(s.season_number || 1)))
        : 1;

    const episodes = Array.isArray(meta.episodes)
      ? meta.episodes.map((ep) => ({
          episode: Number(ep.episode),
          season: Number(ep.season || state.season),
          title: ep.title || `Episode ${ep.episode}`,
          airDate: ep.date || '',
          runtime: ep.runtime ? `${ep.runtime}m` : '',
          still: ep.still || meta.backdrop || '',
          overview: ep.overview || ''
        }))
      : [];

    return {
      ...meta,
      displayTitle,
      tags,
      durationSec,
      totalSeasons,
      episodes
    };
  }

  // --- Load Media Bundle from Backend ---
  async function loadMediaBundle(preserveTime = false) {
    const savedTime = preserveTime ? video.currentTime : 0;
    loadingOverlay.classList.remove('hidden');
    const requestedServer = state.server;
    const serverCap = requestedServer.charAt(0).toUpperCase() + requestedServer.slice(1);
    loadingStatusText.textContent = `Connecting to ${serverCap}...`;

    try {
      const parentDomain =
        (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) ||
        document.referrer ||
        window.location.origin;
      const url = apiUrl(`/api/resolve/${state.type}/${encodeURIComponent(state.tmdbId)}?season=${state.season}&episode=${state.episode}&server=${requestedServer}&audio=${state.activeAudioId}&parent=${encodeURIComponent(parentDomain)}`);
      const res = await fetch(url);
      const data = await res.json();

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
        renderMetadataUI();
        renderEpisodesModal();
      }

      state.segments = (data && data.segments) || [];
      state.subtitles = (data && data.subtitles) || [];
      state.servers = ((data && data.servers) || [])
        .filter((s) => s && s.id && s.enabled !== false && (s.listed !== false || s.active))
        // The API already sorts by priority; sorting again keeps the UI correct
        // even if a cached/stale payload predates the current catalog order.
        .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
        .map((s) => ({
          ...s,
          flag: '☁',
          description: s.badge || 'Production Stream Server'
        }));

      // A rebrand can remove or rename the server we are currently on. Never let
      // the player keep requesting an id that no longer exists in the catalog.
      if (state.servers.length > 0 && !state.servers.some((s) => s.id === state.server)) {
        state.server = state.servers[0].id;
      }

      renderSegmentedTimeline();
      renderSubtitlesPopover();
      renderServersModal();

      if (!data || !data.ok || !data.stream || !data.stream.streamUrl) {
        throw new Error((data && data.error) || 'No upstream stream available on this server.');
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
      state.audioTracks = (data.stream && data.stream.audioTracks) || [];
      state.qualities = ((data.stream && data.stream.qualities) || []).map((q, idx) => ({
        id: q.label.toLowerCase() === 'auto' ? 'auto' : `q-${idx}`,
        label: q.label,
        height: q.height,
        url: q.url
      }));

      if (state.audioTracks.length > 0) {
        const activeTrack =
          (data.stream.activeAudioTrack && state.audioTracks.find((a) => a.id === data.stream.activeAudioTrack.id)) ||
          state.audioTracks.find((a) => a.default) ||
          state.audioTracks.find((a) => a.id === state.activeAudioId) ||
          state.audioTracks[0];
        if (activeTrack) {
          state.activeAudioId = activeTrack.id;
        }
      }

      renderAudioPopover();
      renderServersModal();
      updateSettingsSummaryValues();

      const targetStreamUrl = state.stream.streamUrl;
      await attachStreamToVideo(targetStreamUrl, savedTime);

      // Load default subtitle track if specified
      if (state.activeSubtitleId && state.activeSubtitleId !== 'off') {
        const subObj = state.subtitles.find((s) => s.id === state.activeSubtitleId);
        if (subObj) loadSubtitleTrack(subObj);
      }

      emitHostEvent('ready', { title: state.media ? state.media.displayTitle : '' });
    } catch (err) {
      // The backend now tells us exactly which server failed and why.
      // Surface that as a secondary line so the user is not staring at a
      // generic "All upstream servers failed" message with no next step.
      const apiData = (data && data.explanation) ? data : null;
      const baseMsg = err.message || 'Stream unavailable — select another server from the Cloud menu.';
      loadingStatusText.textContent = apiData && apiData.serverExplanation
        ? `${baseMsg} — ${apiData.serverExplanation}`
        : baseMsg;
      if (apiData && apiData.explanation) {
        showToast(`${apiData.explanation} (${apiData.requestedServer})`, 5000);
      } else {
        showToast(baseMsg, 4000);
      }
      emitHostEvent('error', { error: err.message, serverExplanation: apiData ? apiData.serverExplanation : null });
    }
  }

  // --- Render Metadata (Title, Tags, Season/Episode Controls) ---
  function renderMetadataUI() {
    const m = state.media;
    if (!m) return;

    document.title = `${m.displayTitle} — Watch Online`;
    mediaTitleEl.textContent = m.displayTitle;

    mediaTagsEl.innerHTML = '';
    (m.tags || []).forEach(tag => {
      const span = document.createElement('span');
      span.className = 'media-tag-pill';
      span.textContent = tag;
      mediaTagsEl.appendChild(span);
    });

    timeDurationEl.textContent = formatTime(m.durationSec || 2603);

    if (m.type === 'tv') {
      btnEpisodes.classList.remove('hidden');
      btnNextEpisode.classList.remove('hidden');
    } else {
      btnEpisodes.classList.add('hidden');
      btnNextEpisode.classList.add('hidden');
    }
  }

  // --- Render Segmented Timeline Track (Screenshot 1 & 5) ---
  function renderSegmentedTimeline() {
    timelineSegmentsBg.innerHTML = '';
    const total = getEffectiveDuration();
    const chapters = state.chapters && state.chapters.length > 0
      ? state.chapters
      : [
          { type: 'intro', start: 0, end: Math.min(180, total * 0.08) },
          { type: 'content', start: Math.min(180, total * 0.08), end: total * 0.92 },
          { type: 'outro', start: total * 0.92, end: total }
        ];

    chapters.forEach(ch => {
      const piece = document.createElement('div');
      piece.className = 'timeline-segment-piece' + (ch.type === 'intro' ? ' is-intro' : '');
      const widthPct = Math.max(2, ((ch.end - ch.start) / total) * 100);
      piece.style.width = `${widthPct}%`;
      timelineSegmentsBg.appendChild(piece);
    });
  }

  // --- Attach Stream via HLS.js / Dash.js / Native Video ---
  async function attachStreamToVideo(streamUrl, resumeTime = 0) {
    video.onerror = null;
    video.onloadedmetadata = null;
    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }
    if (state.dashInstance) {
      state.dashInstance.reset();
      state.dashInstance = null;
    }

    const params = new URLSearchParams(window.location.search);
    const startParam = parseFloat(params.get('start') || '0');
    const savedProgressKey = `lol_embed_prog_${state.type}_${state.tmdbId}_${state.season}_${state.episode}`;
    const savedProgress = parseFloat(localStorage.getItem(savedProgressKey) || '0');
    const targetStartTime = resumeTime > 0 ? resumeTime : (startParam > 0 ? startParam : savedProgress);

    // Track which URLs the fallback ladder already burned through this session.
    if (!state.stream) state.stream = {};
    if (!Array.isArray(state.stream.backupUrls)) state.stream.backupUrls = [];
    if (!state._triedStreamUrls) state._triedStreamUrls = new Set();
    if (!state.stream._primaryStreamUrl) state.stream._primaryStreamUrl = state.stream.streamUrl || streamUrl;
    state._triedStreamUrls.add(streamUrl);
    if (state.stream.streamUrl !== streamUrl) state.stream.streamUrl = streamUrl;

    // Walk the resolved backup ladder (googleusercontent -> fsl2 -> 480p ->
    // /api/proxy) before declaring the stream dead.
    const tryNextBackupStream = (fromTime = 0) => {
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
        showToast(quality ? `Switching to ${quality.label} fallback...` : 'Switching to backup stream mirror...', 2200);
        attachStreamToVideo(candidate, fromTime);
        return true;
      }
      return false;
    };

    const isDeclaredPrimaryUrl = streamUrl === state.stream._primaryStreamUrl;
    if ((/\.mpd(?:[?#]|$)/i.test(streamUrl) || (state.stream.format === 'dash' && isDeclaredPrimaryUrl)) && window.dashjs) {
      const player = window.dashjs.MediaPlayer().create();
      state.dashInstance = player;
      player.initialize(video, streamUrl, true);
      player.on('canPlay', () => {
        loadingOverlay.classList.add('hidden');
        if (targetStartTime > 2) video.currentTime = targetStartTime;
      });
      const dashErrorEvent = window.dashjs.MediaPlayer.events && window.dashjs.MediaPlayer.events.ERROR;
      if (dashErrorEvent) {
        player.on(dashErrorEvent, (event) => {
          if (!event || (!event.fatal && !event.error && !event.event)) return;
          player.reset();
          state.dashInstance = null;
          if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
          handleFatalStreamError();
        });
      }
      video.onerror = () => {
        if (state.dashInstance) state.dashInstance.reset();
        state.dashInstance = null;
        if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
        handleFatalStreamError();
      };
      return;
    }

    const isHlsUrl = /\.m3u8(?:[?#]|$)/i.test(streamUrl) || (state.stream.format === 'hls' && isDeclaredPrimaryUrl);
    if (window.Hls && window.Hls.isSupported() && isHlsUrl) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false
      });
      state.hlsInstance = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
        loadingOverlay.classList.add('hidden');

        // Merge any real HLS multi-audio tracks discovered in the manifest
        if (hls.audioTracks && hls.audioTracks.length > 1) {
          syncHlsAudioTracks();
        }

        if (targetStartTime > 2 && targetStartTime < (video.duration || 99999)) {
          video.currentTime = targetStartTime;
        }

        video.play().catch((error) => {
          // Autoplay denial is recoverable, but an unsupported HLS decode can use the next quality/mirror.
          if (error && error.name === 'NotSupportedError') {
            if (!tryNextBackupStream(video.currentTime || targetStartTime || 0)) {
              handleFatalStreamError();
            }
          }
        });
      });

      hls.on(window.Hls.Events.ERROR, (_, errData) => {
        if (errData.fatal) {
          hls.destroy();
          state.hlsInstance = null;
          if (tryNextBackupStream(video.currentTime || 0)) return;
          handleFatalStreamError();
        }
      });
      return;
    }

    // Native HLS (Safari/iOS) or direct MP4/MKV CDN playback
    video.src = streamUrl;
    video.onloadedmetadata = () => {
      loadingOverlay.classList.add('hidden');
      if (targetStartTime > 2) video.currentTime = targetStartTime;
      video.play().catch((error) => {
        if (error && error.name === 'NotSupportedError') {
          if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
          handleFatalStreamError();
        }
      });
    };
    video.onerror = () => {
      // Direct CDN <video src> failed (hotlink/ISP block) — iterate the resolved
      // backup URLs before giving up on the whole server.
      if (tryNextBackupStream(video.currentTime || targetStartTime || 0)) return;
      handleFatalStreamError();
    };
    video.load();
  }

  // --- Automatic Server Failover on Fatal Stream Error ---
  const triedServers = new Set();
  function handleFatalStreamError() {
    triedServers.add(state.server);
    const nextSrv = state.servers.find((s) => !triedServers.has(s.id));
    if (nextSrv) {
      state.server = nextSrv.id;
      showToast(`Switching to backup server: ${nextSrv.name}...`, 2800);
      loadMediaBundle(true);
    } else {
      loadingOverlay.classList.remove('hidden');
      loadingStatusText.textContent =
        'All upstream servers failed to play this stream. Click the Cloud icon to retry.';
    }
  }

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
    const lang = String(track.lang || '').toLowerCase();
    const usableLang = lang && lang !== 'und' && lang !== 'default';
    if (usableLang) {
      const langIdx = hlsTracks.findIndex(t => {
        const hlsLang = String((t && t.lang) || '').toLowerCase();
        return hlsLang === lang || hlsLang.startsWith(lang);
      });
      if (langIdx !== -1) return langIdx;
    }
    const label = String(track.label || '').toLowerCase().trim();
    if (label) {
      const labelIdx = hlsTracks.findIndex(t => {
        const name = String((t && t.name) || '').toLowerCase();
        return name && (name === label || name.includes(label) || label.includes(name));
      });
      if (labelIdx !== -1) return labelIdx;
    }
    return -1;
  }

  function syncHlsAudioTracks() {
    if (!state.hlsInstance || !state.hlsInstance.audioTracks) return;
    const hlsTracks = state.hlsInstance.audioTracks;

    // The payload may expose a single row for a manifest that actually carries
    // several audio renditions (e.g. NetMirror's "Original Audio (Multi-Track
    // HLS)"). hls.js is the source of truth once the manifest is parsed: add a
    // row per rendition so the menu can switch them.
    const distinctStreams = new Set(state.audioTracks.map((t) => t && t.streamUrl).filter(Boolean));
    if (hlsTracks.length > state.audioTracks.length && distinctStreams.size <= 1) {
      hlsTracks.forEach((hlsTrack, index) => {
        const hlsLang = String((hlsTrack && hlsTrack.lang) || '').toLowerCase();
        const already = state.audioTracks.find(
          (t) => t.audioIndex === index || (hlsLang && t.lang && t.lang.toLowerCase() === hlsLang && t.audioIndex == null)
        );
        if (already) {
          already.audioIndex = index;
          if (hlsTrack && hlsTrack.default) already.default = true;
          return;
        }
        const label = (hlsTrack && hlsTrack.name) || (hlsLang ? hlsLang.toUpperCase() : `Audio ${index + 1}`);
        state.audioTracks.push({
          id: `hls-${index}`,
          lang: hlsLang,
          label,
          type: 'dub',
          streamUrl: state.stream ? state.stream.streamUrl : '',
          audioIndex: index,
          default: !!(hlsTrack && hlsTrack.default)
        });
      });
      if (typeof renderAudioPopover === 'function' && typeof updateSettingsSummaryValues === 'function') {
        renderAudioPopover();
        updateSettingsSummaryValues();
      }
    }

    // Learn the rendition order for EVERY row once, so later switches do not
    // depend on fuzzy name matching.
    state.audioTracks.forEach(t => {
      if (!Number.isInteger(t.audioIndex)) {
        const idx = resolveHlsAudioIndex(t, hlsTracks);
        if (idx !== -1) t.audioIndex = idx;
      }
    });

    const selectedObj = state.audioTracks.find(a => a.id === state.activeAudioId);
    if (!selectedObj) return;
    const matchIdx = resolveHlsAudioIndex(selectedObj, hlsTracks);
    if (matchIdx !== -1) {
      state.hlsInstance.audioTrack = matchIdx;
    }
  }

  // --- Render Audio Popover (Matches Screenshot 2) ---
  function renderAudioPopover() {
    audioTrackListEl.innerHTML = '';
    state.audioTracks.forEach(track => {
      const btn = document.createElement('button');
      const isActive = track.id === state.activeAudioId;
      btn.className = 'popover-item-btn' + (isActive ? ' active' : '');
      btn.innerHTML = `
        <span>${track.label}</span>
        <span class="popover-check">✓</span>
      `;
      btn.addEventListener('click', () => {
        selectAudioTrack(track);
        popoverAudio.classList.add('hidden');
      });
      audioTrackListEl.appendChild(btn);
    });
  }

  function selectAudioTrack(track) {
    state.activeAudioId = track.id;
    renderAudioPopover();
    updateSettingsSummaryValues();

    let switched = false;
    let switchHint = '';

    // 1. If the selected audio track has its own distinct streamUrl (e.g. separate Sub vs Dub HLS/MP4 stream), switch stream preserving current time
    if (track.streamUrl && state.stream && track.streamUrl !== state.stream.streamUrl) {
      state.stream.streamUrl = track.streamUrl;
      attachStreamToVideo(track.streamUrl, video.currentTime || 0);
      switched = true;
    }
    // 2. If HLS instance has multiple embedded audio renditions, switch natively
    else if (state.hlsInstance && state.hlsInstance.audioTracks && state.hlsInstance.audioTracks.length > 1) {
      const idx = resolveHlsAudioIndex(track, state.hlsInstance.audioTracks);
      if (idx !== -1) {
        track.audioIndex = idx;
        state.hlsInstance.audioTrack = idx;
        switched = true;
      } else {
        switchHint = ' — no matching track in this stream';
      }
    } else {
      // The stream is a single progressive file (no HLS audio renditions) and
      // every row shares one URL: the browser cannot switch the file's
      // embedded tracks. Say so instead of faking a successful switch.
      switchHint = ' — this file plays its default audio track only';
    }

    // 3. If track is a "sub" variant, auto-enable English subtitles if available and currently Off
    if (track.type === 'sub' && state.activeSubtitleId === 'off' && state.subtitles.length > 0) {
      const enSub = state.subtitles.find((s) => s.lang === 'en') || state.subtitles[0];
      if (enSub) {
        loadSubtitleTrack(enSub);
      }
    }

    if (switched) {
      showToast(`Audio switched to ${track.label}`, 2200);
    } else {
      showToast(`Audio: ${track.label}${switchHint}`, 3200);
    }
    emitHostEvent('audiotrackchange', { audioTrack: track.label, lang: track.lang, switched });
  }

  // --- Render Subtitles Popover (Matches Screenshot 3) ---
  function renderSubtitlesPopover() {
    subtitleTrackListEl.innerHTML = '';

    // 1. "Upload subtitle" row (Screenshot 3 top item)
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'popover-item-btn';
    uploadBtn.innerHTML = `<span>Upload subtitle</span><span class="popover-check"></span>`;
    uploadBtn.addEventListener('click', () => {
      subtitleFileInput.click();
    });
    subtitleTrackListEl.appendChild(uploadBtn);

    // 2. "Off" row (Screenshot 3 second item)
    const offBtn = document.createElement('button');
    const isOff = state.activeSubtitleId === 'off';
    offBtn.className = 'popover-item-btn' + (isOff ? ' active' : '');
    offBtn.innerHTML = `<span>Off</span><span class="popover-check">✓</span>`;
    offBtn.addEventListener('click', () => {
      disableSubtitles();
      popoverSubtitles.classList.add('hidden');
    });
    subtitleTrackListEl.appendChild(offBtn);

    // 3. Language tracks (العربية, বাংলা, English, Filipino, Français, हिन्दी, etc.)
    state.subtitles.forEach(sub => {
      const btn = document.createElement('button');
      const isActive = sub.id === state.activeSubtitleId;
      btn.className = 'popover-item-btn' + (isActive ? ' active' : '');
      btn.innerHTML = `
        <span>${sub.label}</span>
        <span class="popover-check">✓</span>
      `;
      btn.addEventListener('click', () => {
        loadSubtitleTrack(sub);
        popoverSubtitles.classList.add('hidden');
      });
      subtitleTrackListEl.appendChild(btn);
    });
  }

  function disableSubtitles() {
    state.activeSubtitleId = 'off';
    state.parsedCues = [];
    customSubtitleText.textContent = '';
    renderSubtitlesPopover();
    updateSettingsSummaryValues();
  }

  async function loadSubtitleTrack(sub) {
    state.activeSubtitleId = sub.id;
    renderSubtitlesPopover();
    updateSettingsSummaryValues();

    try {
      const res = await fetch(sub.url);
      const vttText = await res.text();
      state.parsedCues = parseWebVttCues(vttText);
      customSubtitleText.dir = sub.dir || 'ltr';
      updateActiveSubtitleCue();
      showToast(`Subtitles: ${sub.label}`, 2000);
    } catch (_) {
      showToast('Failed to load subtitle track', 2000);
    }
  }

  // Parse WebVTT or SRT text into [{ start, end, text }]
  function parseWebVttCues(rawText) {
    const normalized = rawText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

    const blocks = normalized.split(/\n\n+/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const timeLineIdx = lines.findIndex(l => l.includes('-->'));
      if (timeLineIdx === -1) continue;

      const [startStr, endStr] = lines[timeLineIdx].split('-->').map(s => s.trim().split(' ')[0]);
      const start = parseTimestampToSeconds(startStr);
      const end = parseTimestampToSeconds(endStr);
      const text = lines.slice(timeLineIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim();

      if (!isNaN(start) && !isNaN(end) && text) {
        cues.push({ start, end, text });
      }
    }
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
      customSubtitleText.textContent = '';
      return;
    }
    const effectiveTime = (video.currentTime || 0) - state.subtitleDelaySec;
    const cue = state.parsedCues.find(c => effectiveTime >= c.start && effectiveTime <= c.end);
    customSubtitleText.textContent = cue ? cue.text : '';
  }

  // Handle local .srt / .vtt upload
  subtitleFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      const customId = 'custom-upload';
      const customSub = {
        id: customId,
        code: 'custom',
        label: `Uploaded (${file.name.slice(0, 18)})`,
        dir: 'ltr'
      };
      state.subtitles = [customSub, ...state.subtitles.filter(s => s.id !== customId)];
      state.activeSubtitleId = customId;
      state.parsedCues = parseWebVttCues(content);
      renderSubtitlesPopover();
      updateSettingsSummaryValues();
      popoverSubtitles.classList.add('hidden');
      showToast(`Loaded subtitle: ${file.name}`, 2500);
    };
    reader.readAsText(file);
  });

  // --- Render Episodes Modal (Matches Screenshot 4) ---
  function renderEpisodesModal() {
    if (!state.media || state.media.type !== 'tv') return;

    // Populate Season Dropdown
    const totalSeasons = state.media.totalSeasons || 1;
    seasonSelect.innerHTML = '';
    for (let s = 1; s <= totalSeasons; s++) {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `Season ${s}`;
      if (s === state.season) opt.selected = true;
      seasonSelect.appendChild(opt);
    }

    // Populate 3-Column Episode Cards Grid
    episodesGrid.innerHTML = '';
    const episodes = state.media.episodes || [];
    episodes.forEach(ep => {
      const card = document.createElement('div');
      const isCurrent = ep.episode === state.episode;
      card.className = 'episode-card' + (isCurrent ? ' active' : '');

      const thumbSrc = ep.still || state.media.backdrop || 'https://image.tmdb.org/t/p/w500/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg';
      card.innerHTML = `
        <div class="episode-thumb-wrap">
          <img class="episode-thumb-img" src="${thumbSrc}" alt="Episode ${ep.episode}" loading="lazy" onerror="this.src='https://image.tmdb.org/t/p/w500/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg'" />
        </div>
        <div class="episode-title">${ep.episode}. ${ep.title}</div>
        <div class="episode-meta">${ep.airDate} • ${ep.runtime}</div>
        <div class="episode-desc">${ep.overview}</div>
      `;

      card.addEventListener('click', () => {
        state.episode = ep.episode;
        modalEpisodesBackdrop.classList.add('hidden');
        syncUrlWithState();
        loadMediaBundle(false);
        emitHostEvent('episodechange', { season: state.season, episode: state.episode });
      });

      episodesGrid.appendChild(card);
    });
  }

  seasonSelect.addEventListener('change', async () => {
    state.season = parseInt(seasonSelect.value, 10) || 1;
    state.episode = 1;
    await loadMediaBundle(false);
    modalEpisodesBackdrop.classList.remove('hidden');
  });

  // --- Render Servers Cloud Modal ---
  function renderServersModal() {
    serversListContainer.innerHTML = '';
    state.servers.forEach(srv => {
      const btn = document.createElement('button');
      btn.className = 'server-row-card' + (srv.active || srv.id === state.server ? ' active' : '');
      btn.innerHTML = `
        <div>
          <div class="server-name-line">
            <span>${srv.name}</span>
            <span>${srv.flag}</span>
          </div>
          <div class="server-desc-line">${srv.description}</div>
        </div>
        <span class="server-badge-pill">${srv.latencyMs || 140}ms</span>
      `;
      btn.addEventListener('click', () => {
        // Manual selection: forget every previously failed server so the user's
        // explicit choice is always retried with a clean slate.
        triedServers.clear();
        state._triedStreamUrls = new Set();
        state.server = srv.id;
        modalServersBackdrop.classList.add('hidden');
        loadMediaBundle(true);
        emitHostEvent('serverchange', { server: srv.id });
      });
      serversListContainer.appendChild(btn);
    });
  }

  // --- Update Player Settings Summary Values (Screenshot 1) ---
  function updateSettingsSummaryValues() {
    const qObj = state.qualities.find(q => q.id === state.activeQualityId);
    valQuality.textContent = qObj ? qObj.label : 'Auto';

    const aObj = state.audioTracks.find(a => a.id === state.activeAudioId);
    valAudio.textContent = aObj ? aObj.label : 'Original Audio';

    if (state.activeSubtitleId === 'off') {
      valSubtitles.textContent = 'Off';
    } else {
      const sObj = state.subtitles.find(s => s.id === state.activeSubtitleId);
      valSubtitles.textContent = sObj ? sObj.label : 'On';
    }

    valAspect.textContent = state.aspectRatio;
    valBrightness.textContent = `${state.brightness}%`;
    valMirror.textContent = state.mirror ? 'On' : 'Off';
    valPip.textContent = document.pictureInPictureElement ? 'On' : 'Off';
    valSpeed.textContent = `${state.playbackSpeed}x`;
  }

  //Apply CSS transforms & filters for Aspect Ratio, Brightness, and Mirror
  function applyMediaTransforms() {
    video.style.filter = `brightness(${state.brightness / 100})`;
    video.style.transform = state.mirror ? 'scaleX(-1)' : 'scaleX(1)';

    if (state.aspectRatio === 'Fit') {
      video.style.objectFit = 'contain';
    } else if (state.aspectRatio === 'Fill') {
      video.style.objectFit = 'cover';
    } else if (state.aspectRatio === 'Stretch') {
      video.style.objectFit = 'fill';
    }
    updateSettingsSummaryValues();
  }

  // --- Settings Modal Drill-Down Panels ---
  document.querySelectorAll('.settings-row-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const panel = btn.dataset.panel;
      const action = btn.dataset.action;

      if (action === 'toggle-mirror') {
        state.mirror = !state.mirror;
        applyMediaTransforms();
        return;
      }

      if (action === 'toggle-pip') {
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else if (video.requestPictureInPicture) {
            await video.requestPictureInPicture();
          }
        } catch (_) {}
        updateSettingsSummaryValues();
        return;
      }

      if (panel) {
        openSettingsDrillPanel(panel);
      }
    });
  });

  function openSettingsDrillPanel(panelType) {
    settingsMainPanel.classList.add('hidden');
    settingsDrillPanel.classList.remove('hidden');
    settingsDrillList.innerHTML = '';

    if (panelType === 'quality') {
      settingsDrillTitle.textContent = 'Select Quality';
      state.qualities.forEach((q, idx) => {
        const item = createDrillOption(q.label + (q.bitrate ? ` (${q.bitrate})` : ''), q.id === state.activeQualityId, () => {
          state.activeQualityId = q.id;
          if (state.hlsInstance && state.hlsInstance.levels && state.hlsInstance.levels.length > 0) {
            // Match the payload quality to the real HLS level by height first.
            // The old positional `idx - 1` assumption broke whenever the
            // payload ladder and the manifest ladder disagreed (they usually
            // do: payload is [Auto, 1080, 720, 480], hls.js levels ascend).
            const heights = state.hlsInstance.levels.map(l => (l && l.height) || 0);
            let levelIdx = -1;
            if (q.id !== 'auto' && q.height) {
              levelIdx = heights.findIndex(h => h === q.height);
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
          } else if (q.url && state.stream && q.url !== state.stream.streamUrl) {
            state.stream.streamUrl = q.url;
            attachStreamToVideo(q.url, video.currentTime || 0);
          }
          closeSettingsDrillPanel();
          showToast(`Quality: ${q.label}`, 2000);
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'audio') {
      settingsDrillTitle.textContent = 'Select Audio Track';
      state.audioTracks.forEach(track => {
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
      state.subtitles.forEach(sub => {
        const item = createDrillOption(sub.label, sub.id === state.activeSubtitleId, () => {
          loadSubtitleTrack(sub);
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'aspect') {
      settingsDrillTitle.textContent = 'Aspect Ratio';
      ['Fit', 'Fill', 'Stretch'].forEach(mode => {
        const item = createDrillOption(mode, state.aspectRatio === mode, () => {
          state.aspectRatio = mode;
          applyMediaTransforms();
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'brightness') {
      settingsDrillTitle.textContent = 'Screen Brightness';
      [50, 75, 100, 125, 150].forEach(val => {
        const item = createDrillOption(`${val}%`, state.brightness === val, () => {
          state.brightness = val;
          applyMediaTransforms();
          closeSettingsDrillPanel();
        });
        settingsDrillList.appendChild(item);
      });
    } else if (panelType === 'speed') {
      settingsDrillTitle.textContent = 'Playback Speed';
      [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(spd => {
        const item = createDrillOption(`${spd}x`, state.playbackSpeed === spd, () => {
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
    btn.className = 'popover-item-btn' + (isActive ? ' active' : '');
    btn.innerHTML = `<span>${label}</span><span class="popover-check">✓</span>`;
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
  function updateTimelineAndSkipState() {
    const current = video.currentTime || 0;
    const total = getEffectiveDuration();
    const pct = Math.min(100, Math.max(0, (current / total) * 100));

    timeCurrentEl.textContent = formatTime(current);
    timeDurationEl.textContent = formatTime(total);

    timelineProgress.style.width = `${pct}%`;
    timelineThumb.style.left = `${pct}%`;

    if (video.buffered && video.buffered.length > 0) {
      const bufEnd = video.buffered.end(video.buffered.length - 1);
      const bufPct = Math.min(100, (bufEnd / total) * 100);
      timelineBuffered.style.width = `${bufPct}%`;
    }

    // Check if current timestamp falls inside an Intro / Recap / Outro segment
    const matchingSeg = state.segments.find(s => current >= s.start && current < s.end);
    if (matchingSeg) {
      state.activeSkipSegment = matchingSeg;
      skipIntroLabel.textContent = matchingSeg.label || 'Skip Intro';
      btnSkipIntro.classList.remove('hidden');
    } else {
      // Keep Skip Intro button accessible during the first 4 minutes so user can always test/click it
      const firstIntro = state.segments.find(s => s.type === 'intro') || { start: 0, end: Math.min(225, total * 0.2), label: 'Skip Intro' };
      if (current < 245) {
        state.activeSkipSegment = firstIntro;
        skipIntroLabel.textContent = firstIntro.label || 'Skip Intro';
        btnSkipIntro.classList.remove('hidden');
      } else {
        state.activeSkipSegment = null;
        btnSkipIntro.classList.add('hidden');
      }
    }

    updateActiveSubtitleCue();

    // Save watch progress to localStorage every 3 seconds
    if (Math.floor(current) % 3 === 0 && current > 2) {
      const key = `lol_embed_prog_${state.type}_${state.tmdbId}_${state.season}_${state.episode}`;
      localStorage.setItem(key, String(Math.floor(current)));
    }
  }

  btnSkipIntro.addEventListener('click', (e) => {
    e.stopPropagation();
    const seg = state.activeSkipSegment || state.segments.find(s => s.type === 'intro');
    if (seg && seg.type === 'outro' && state.type === 'tv') {
      goToNextEpisode();
      return;
    }
    const targetSec = seg ? seg.end : Math.min(getEffectiveDuration() - 5, (video.currentTime || 0) + 85);
    video.currentTime = targetSec;
    updateTimelineAndSkipState();
    showToast(`Skipped to ${formatTime(targetSec)}`, 1800);
  });

  // --- Timeline Scrubbing & Hover Timestamp Tooltip (Screenshot 5) ---
  function getTimelineHoverSeconds(clientX) {
    const rect = timelineSlider.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { ratio, seconds: ratio * getEffectiveDuration() };
  }

  timelineSlider.addEventListener('mousemove', (e) => {
    const { ratio, seconds } = getTimelineHoverSeconds(e.clientX);
    timelineHoverTooltip.textContent = formatTime(seconds);
    timelineHoverTooltip.style.left = `${ratio * 100}%`;
    timelineHoverTooltip.classList.remove('hidden');

    if (state.isDraggingTimeline) {
      video.currentTime = seconds;
      updateTimelineAndSkipState();
    }
  });

  timelineSlider.addEventListener('mouseleave', () => {
    timelineHoverTooltip.classList.add('hidden');
  });

  timelineSlider.addEventListener('mousedown', (e) => {
    state.isDraggingTimeline = true;
    const { seconds } = getTimelineHoverSeconds(e.clientX);
    video.currentTime = seconds;
    updateTimelineAndSkipState();
  });

  window.addEventListener('mouseup', () => {
    state.isDraggingTimeline = false;
  });

  // Touch support on timeline
  timelineSlider.addEventListener('touchstart', (e) => {
    if (!e.touches[0]) return;
    const { seconds } = getTimelineHoverSeconds(e.touches[0].clientX);
    video.currentTime = seconds;
    updateTimelineAndSkipState();
  }, { passive: true });

  timelineSlider.addEventListener('touchmove', (e) => {
    if (!e.touches[0]) return;
    const { seconds } = getTimelineHoverSeconds(e.touches[0].clientX);
    video.currentTime = seconds;
    updateTimelineAndSkipState();
  }, { passive: true });

  // --- Playback Controls ---
  function togglePlay() {
    closeAllPopovers();
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function seekBy(deltaSec) {
    const target = Math.max(0, Math.min(getEffectiveDuration(), (video.currentTime || 0) + deltaSec));
    video.currentTime = target;
    updateTimelineAndSkipState();

    const feedbackEl = deltaSec < 0 ? seekFeedbackLeft : seekFeedbackRight;
    feedbackEl.classList.add('show');
    setTimeout(() => feedbackEl.classList.remove('show'), 550);
  }

  function goToNextEpisode() {
    if (state.type !== 'tv') return;
    const episodes = (state.media && state.media.episodes) || [];
    if (state.episode < episodes.length) {
      state.episode += 1;
    } else {
      state.season += 1;
      state.episode = 1;
    }
    syncUrlWithState();
    loadMediaBundle(false);
    emitHostEvent('episodechange', { season: state.season, episode: state.episode });
  }

  function syncUrlWithState() {
    // The player page lives at exactly `/embed`; keep media selection in the
    // query string so reloads of the rewritten URL stay on the same route.
    try {
      const params = new URLSearchParams(window.location.search);
      params.set('type', state.type);
      params.set('tmdb', String(state.tmdbId));
      if (state.type === 'tv') {
        params.set('s', String(state.season));
        params.set('e', String(state.episode));
      } else {
        params.delete('s');
        params.delete('e');
      }
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    } catch (_) {}
  }

  btnPlay.addEventListener('click', togglePlay);
  centerClickZone.addEventListener('click', togglePlay);
  btnRewind.addEventListener('click', () => seekBy(-15));
  btnForward.addEventListener('click', () => seekBy(15));
  btnNextEpisode.addEventListener('click', goToNextEpisode);

  // Double-click center zone for fullscreen
  centerClickZone.addEventListener('dblclick', toggleFullscreen);

  video.addEventListener('play', () => {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    emitHostEvent('play');
  });

  video.addEventListener('pause', () => {
    iconPause.classList.add('hidden');
    iconPlay.classList.remove('hidden');
    emitHostEvent('pause');
  });

  video.addEventListener('timeupdate', () => {
    updateTimelineAndSkipState();
    emitHostEvent('timeupdate');
  });

  video.addEventListener('ended', () => {
    emitHostEvent('ended');
    if (state.type === 'tv') {
      goToNextEpisode();
    }
  });

  // Volume & Mute
  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    updateVolumeUI();
  });

  volumeRange.addEventListener('input', () => {
    video.volume = parseFloat(volumeRange.value);
    video.muted = video.volume === 0;
    updateVolumeUI();
  });

  function updateVolumeUI() {
    if (video.muted || video.volume === 0) {
      iconVolHigh.classList.add('hidden');
      iconVolMuted.classList.remove('hidden');
    } else {
      iconVolMuted.classList.add('hidden');
      iconVolHigh.classList.remove('hidden');
    }
  }

  // Fullscreen & Toast (Matches Screenshot 5)
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (playerRoot.requestFullscreen) {
        playerRoot.requestFullscreen().catch(() => {});
      }
      showToast(`${state.branding} – to exit full screen, drag from the top and touch the back button`, 3800);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }

  btnFullscreen.addEventListener('click', toggleFullscreen);

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
    subtitleStyleView.classList.add('hidden');
    subtitleDelayView.classList.add('hidden');
    subtitleMainView.classList.remove('hidden');
  }

  btnAudioMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasHidden = popoverAudio.classList.contains('hidden');
    closeAllPopovers();
    if (wasHidden) popoverAudio.classList.remove('hidden');
  });

  btnSubtitlesMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasHidden = popoverSubtitles.classList.contains('hidden');
    closeAllPopovers();
    if (wasHidden) popoverSubtitles.classList.remove('hidden');
  });

  // Subtitle Style & Delay subviews (Screenshot 3 footer buttons)
  btnSubStyle.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleMainView.classList.add('hidden');
    subtitleStyleView.classList.remove('hidden');
  });

  btnSubStyleBack.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleStyleView.classList.add('hidden');
    subtitleMainView.classList.remove('hidden');
  });

  btnSubDelay.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleMainView.classList.add('hidden');
    subtitleDelayView.classList.remove('hidden');
  });

  btnSubDelayBack.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleDelayView.classList.add('hidden');
    subtitleMainView.classList.remove('hidden');
  });

  document.querySelectorAll('#sub-size-group .pill-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sub-size-group .pill-choice').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.documentElement.style.setProperty('--sub-font-size', btn.dataset.size);
    });
  });

  document.querySelectorAll('#sub-color-group .pill-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sub-color-group .pill-choice').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.documentElement.style.setProperty('--sub-color', btn.dataset.color);
    });
  });

  document.querySelectorAll('#sub-bg-group .pill-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sub-bg-group .pill-choice').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.documentElement.style.setProperty('--sub-bg', btn.dataset.bg);
    });
  });

  document.querySelectorAll('.delay-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const delta = parseFloat(btn.dataset.delta);
      if (delta === 0) {
        state.subtitleDelaySec = 0;
      } else {
        state.subtitleDelaySec = Math.round((state.subtitleDelaySec + delta) * 10) / 10;
      }
      const formatted = `${state.subtitleDelaySec >= 0 ? '+' : ''}${state.subtitleDelaySec.toFixed(1)}s`;
      delayCurrentValue.textContent = formatted;
      subDelayBadge.textContent = state.subtitleDelaySec === 0 ? 'Delay' : `Delay (${formatted})`;
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
    renderEpisodesModal();
    modalEpisodesBackdrop.classList.remove('hidden');
  });

  btnCloseEpisodes.addEventListener('click', () => {
    modalEpisodesBackdrop.classList.add('hidden');
  });

  modalEpisodesBackdrop.addEventListener('click', (e) => {
    if (e.target === modalEpisodesBackdrop) modalEpisodesBackdrop.classList.add('hidden');
  });

  btnServers.addEventListener('click', () => {
    closeAllPopovers();
    renderServersModal();
    modalServersBackdrop.classList.remove('hidden');
  });

  btnCloseServers.addEventListener('click', () => {
    modalServersBackdrop.classList.add('hidden');
  });

  modalServersBackdrop.addEventListener('click', (e) => {
    if (e.target === modalServersBackdrop) modalServersBackdrop.classList.add('hidden');
  });

  // Auto-hide HUD on mouse inactivity during playback
  function resetIdleTimer() {
    playerRoot.classList.remove('controls-idle');
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      const anyModalOpen =
        !modalSettingsBackdrop.classList.contains('hidden') ||
        !modalEpisodesBackdrop.classList.contains('hidden') ||
        !modalServersBackdrop.classList.contains('hidden') ||
        !popoverAudio.classList.contains('hidden') ||
        !popoverSubtitles.classList.contains('hidden');
      if (!video.paused && !anyModalOpen) {
        playerRoot.classList.add('controls-idle');
      }
    }, 3800);
  }

  playerRoot.addEventListener('mousemove', resetIdleTimer);
  playerRoot.addEventListener('touchstart', resetIdleTimer, { passive: true });
  playerRoot.addEventListener('keydown', resetIdleTimer);

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
    if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      seekBy(-15);
    } else if (e.code === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      seekBy(15);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      video.muted = !video.muted;
      updateVolumeUI();
    } else if (e.key === 'Escape') {
      closeAllPopovers();
      modalSettingsBackdrop.classList.add('hidden');
      modalEpisodesBackdrop.classList.add('hidden');
      modalServersBackdrop.classList.add('hidden');
    }
  });

  // Listen for remote control commands from parent page via postMessage
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.command === 'play' || msg.type === 'VIDBOLT_PLAY') video.play().catch(() => {});
    if (msg.command === 'pause' || msg.type === 'VIDBOLT_PAUSE') video.pause();
    if (msg.command === 'seek' && typeof msg.time === 'number') video.currentTime = msg.time;
    if (msg.command === 'setVolume' && typeof msg.volume === 'number') {
      video.volume = Math.max(0, Math.min(1, msg.volume));
      volumeRange.value = String(video.volume);
      updateVolumeUI();
    }
    if (msg.type === 'SCREENSCAPE_GET_WATCH_HISTORY_WITH_PROGRESS') {
      window.parent.postMessage({
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
      }, '*');
    }
  });

  // Initialize Player
  parseRouteParams();
  loadMediaBundle(false);
})();
