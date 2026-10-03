(function () {
  'use strict';

  const demoIframe = document.getElementById('demo-iframe');
  const previewUrlDisplay = document.getElementById('preview-url-display');
  const openStandaloneLink = document.getElementById('open-standalone-link');
  const iframeCodeOutput = document.getElementById('iframe-code-output');
  const eventLog = document.getElementById('event-log');

  const typeTvBtn = document.getElementById('type-tv-btn');
  const typeMovieBtn = document.getElementById('type-movie-btn');
  const inputTmdb = document.getElementById('input-tmdb');
  const inputSeason = document.getElementById('input-season');
  const inputEpisode = document.getElementById('input-episode');
  const seasonGroup = document.getElementById('season-group');
  const episodeGroup = document.getElementById('episode-group');
  const selectServer = document.getElementById('select-server');
  const selectColor = document.getElementById('select-color');
  const btnLoadPlayer = document.getElementById('btn-load-player');

  const btnCopyUrl = document.getElementById('btn-copy-url');
  const btnCopyIframe = document.getElementById('btn-copy-iframe');
  const btnRemotePlay = document.getElementById('btn-remote-play');
  const btnRemotePause = document.getElementById('btn-remote-pause');
  const btnRemoteSeek = document.getElementById('btn-remote-seek');

  let currentType = 'tv';

  function buildEmbedRelativePath() {
    const tmdb = (inputTmdb.value || '94605').trim();
    const s = parseInt(inputSeason.value || '1', 10);
    const e = parseInt(inputEpisode.value || '1', 10);
    const basePath = currentType === 'tv'
      ? `/embed/tv/${encodeURIComponent(tmdb)}/${s}/${e}`
      : `/embed/movie/${encodeURIComponent(tmdb)}`;

    const params = new URLSearchParams();
    if (selectServer.value && selectServer.value !== 'atlas') {
      params.set('server', selectServer.value);
    }
    if (selectColor.value) {
      params.set('color', selectColor.value);
    }

    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  function updateEmbedPreview() {
    const relUrl = buildEmbedRelativePath();
    const fullUrl = `${window.location.origin}${relUrl}`;
    demoIframe.src = relUrl;
    previewUrlDisplay.textContent = relUrl;
    openStandaloneLink.href = relUrl;

    iframeCodeOutput.textContent =
`<iframe
  src="${fullUrl}"
  width="100%"
  height="100%"
  frameborder="0"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
></iframe>`;
  }

  function setMediaType(type) {
    currentType = type;
    if (type === 'tv') {
      typeTvBtn.classList.add('active');
      typeMovieBtn.classList.remove('active');
      seasonGroup.style.display = '';
      episodeGroup.style.display = '';
    } else {
      typeMovieBtn.classList.add('active');
      typeTvBtn.classList.remove('active');
      seasonGroup.style.display = 'none';
      episodeGroup.style.display = 'none';
    }
  }

  typeTvBtn.addEventListener('click', () => {
    setMediaType('tv');
    if (inputTmdb.value === '550') inputTmdb.value = '94605';
    updateEmbedPreview();
  });

  typeMovieBtn.addEventListener('click', () => {
    setMediaType('movie');
    if (inputTmdb.value === '94605') inputTmdb.value = '550';
    updateEmbedPreview();
  });

  btnLoadPlayer.addEventListener('click', updateEmbedPreview);
  selectServer.addEventListener('change', updateEmbedPreview);
  selectColor.addEventListener('change', updateEmbedPreview);

  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      const type = chip.dataset.type;
      setMediaType(type);
      inputTmdb.value = chip.dataset.id;
      if (type === 'tv') {
        inputSeason.value = chip.dataset.s || '1';
        inputEpisode.value = chip.dataset.e || '1';
      }
      updateEmbedPreview();
    });
  });

  btnCopyUrl.addEventListener('click', () => {
    const fullUrl = `${window.location.origin}${buildEmbedRelativePath()}`;
    navigator.clipboard.writeText(fullUrl).catch(() => {});
    btnCopyUrl.textContent = 'Copied!';
    setTimeout(() => { btnCopyUrl.textContent = 'Copy URL'; }, 1500);
  });

  btnCopyIframe.addEventListener('click', () => {
    navigator.clipboard.writeText(iframeCodeOutput.textContent).catch(() => {});
    btnCopyIframe.textContent = 'Copied!';
    setTimeout(() => { btnCopyIframe.textContent = 'Copy Code'; }, 1500);
  });

  // Remote postMessage commands to iframe
  btnRemotePlay.addEventListener('click', () => {
    demoIframe.contentWindow.postMessage({ command: 'play' }, '*');
  });

  btnRemotePause.addEventListener('click', () => {
    demoIframe.contentWindow.postMessage({ command: 'pause' }, '*');
  });

  btnRemoteSeek.addEventListener('click', () => {
    demoIframe.contentWindow.postMessage({ command: 'seek', time: 195 }, '*');
  });

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || d.source !== 'vidstuck-player') return;
    const stamp = new Date().toLocaleTimeString();
    eventLog.textContent = `[${stamp}] ${d.event.toUpperCase()} — TMDB:${d.tmdbId} (${Math.floor(d.currentTime || 0)}s / ${Math.floor(d.duration || 0)}s)`;
  });

  updateEmbedPreview();
})();
