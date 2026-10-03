/* Proxy — front-end.
 * Vanilla JS, no build step. Talks to the same API you'd use from curl.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = document.getElementById('app');
  const LS_KEY = 'proxy.apikey';

  // ---------------------------------------------------------------- helpers

  function apiKey() {
    return localStorage.getItem(LS_KEY) || '';
  }

  async function api(path, opts) {
    const headers = Object.assign({ accept: 'application/json' }, (opts && opts.headers) || {});
    const key = apiKey();
    if (key) headers['x-api-key'] = key;

    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-json */ }

    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return body;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function poster(p) {
    return p ? 'url("' + esc(p) + '")' : 'none';
  }

  function fmtBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  }

  function qualityBadge(s) {
    const q = s.quality || (s.height ? s.height + 'p' : '');
    return q ? '<span class="badge q">' + esc(q) + '</span>' : '';
  }

  function langBadge(s) {
    if (!s.language) return '';
    return '<span class="badge lang">' + esc(String(s.language).toUpperCase()) + '</span>';
  }

  // ---------------------------------------------------------------- routing

  const routes = [
    { re: /^\/$/, fn: home },
    { re: /^\/search\/?$/, fn: home },
    { re: /^\/title\/([^/]+)\/([^/]+)\/?$/, fn: titlePage },
    { re: /^\/watch\/([^/]+)\/([^/]+)\/?$/, fn: watchPage },
  ];

  function currentRoute() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    for (const r of routes) {
      const m = r.re.exec(path);
      if (m) return { fn: r.fn, params: m.slice(1).map(decodeURIComponent) };
    }
    return { fn: home, params: [] };
  }

  function navigate(url, replace) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    render();
  }

  window.addEventListener('popstate', render);

  async function render() {
    const r = currentRoute();
    stopPlayer();
    app.innerHTML = '<div class="loading">Loading…</div>';
    try {
      await r.fn.apply(null, r.params);
    } catch (err) {
      app.innerHTML = '<div class="error"><strong>Something went wrong.</strong><br>' +
        esc(err && err.message ? err.message : String(err)) + '</div>';
    }
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------- home

  async function home() {
    const q = new URLSearchParams(location.search).get('q') || '';
    $('#search').value = q;

    app.innerHTML =
      '<h2 class="section">' + (q ? 'Results' : 'Trending') + '</h2>' +
      '<div class="grid" id="grid"><div class="loading">Loading…</div></div>';

    const grid = $('#grid');

    try {
      const data = q
        ? await api('/api/search?q=' + encodeURIComponent(q) + '&page=1')
        : await api('/api/catalog/movie?category=trending&page=1');

      const results = (data && data.results) || [];
      if (!results.length) {
        grid.innerHTML = '<div class="notice">Nothing found. ' +
          (data.source === 'providers'
            ? 'No enabled provider answered the search.'
            : 'Set <code>TMDB_API_KEY</code> in your <code>.env</code> to enable search &amp; discovery.') +
          '</div>';
        return;
      }
      grid.innerHTML = results.map(cardHtml).join('');
      grid.querySelectorAll('.card').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.dataset.imdb || el.dataset.tmdb;
          navigate('/title/' + (el.dataset.type || 'movie') + '/' + id);
        });
      });
    } catch (err) {
      grid.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  }

  function cardHtml(m) {
    const id = m.imdbId || (m.tmdbId != null ? 'tmdb:' + m.tmdbId : null);
    if (!id) return '';
    const type = m.type === 'series' || m.type === 'anime' ? 'series' : 'movie';
    return (
      '<article class="card" data-id="' + esc(id) + '" data-type="' + esc(type) + '"' +
        ' data-imdb="' + esc(m.imdbId || '') + '" data-tmdb="' + esc(m.tmdbId || '') + '">' +
        '<div class="poster" style="background-image:' + poster(m.poster) + '">' +
          (m.poster ? '' : esc(m.title)) +
          (m.rating ? '<span class="rating">★ ' + esc(m.rating) + '</span>' : '') +
        '</div>' +
        '<div class="meta">' +
          '<div class="title">' + esc(m.title) + '</div>' +
          '<div class="sub">' + esc([m.year, type === 'series' ? 'Series' : 'Movie'].filter(Boolean).join(' · ')) + '</div>' +
        '</div>' +
      '</article>'
    );
  }

  // ------------------------------------------------------------- title page

  async function titlePage(type, id) {
    const params = new URLSearchParams(location.search);
    const season = params.get('season') || '1';
    const episode = params.get('episode') || '1';

    app.innerHTML = '<div class="loading">Loading title…</div>';

    let meta = null;
    try { meta = await api('/api/meta/' + encodeURIComponent(type) + '/' + encodeURIComponent(id)); }
    catch (_) { /* metadata is optional */ }

    const isSeries = type !== 'movie';
    const title = (meta && meta.title) || id;

    let episodesHtml = '';
    if (isSeries && meta && meta.tmdbId) {
      try {
        const s = await api('/api/meta/series/' + meta.tmdbId + '/season/' + season);
        if (s.episodes && s.episodes.length) {
          episodesHtml =
            '<label>Episode ' +
            '<select id="episode">' +
              s.episodes.map((e) =>
                '<option value="' + e.episodeNumber + '"' +
                (String(e.episodeNumber) === String(episode) ? ' selected' : '') + '>' +
                e.episodeNumber + '. ' + esc(e.name || 'Episode ' + e.episodeNumber) +
                '</option>').join('') +
            '</select></label>';
        }
      } catch (_) { /* ignore */ }
    }

    const seasons = (meta && meta.seasons) || [];

    app.innerHTML =
      '<section class="hero">' +
        '<div class="bg" style="background-image:' + poster(meta && meta.backdrop) + '"></div>' +
        '<div class="inner">' +
          '<div class="poster-lg" style="background-image:' + poster(meta && meta.poster) + '"></div>' +
          '<div>' +
            '<h1>' + esc(title) + '</h1>' +
            '<div class="tags">' +
              (meta && meta.year ? '<span class="tag">' + esc(meta.year) + '</span>' : '') +
              (meta && meta.runtime ? '<span class="tag">' + esc(meta.runtime) + ' min</span>' : '') +
              (meta && meta.rating ? '<span class="tag">★ ' + esc(meta.rating) + '</span>' : '') +
              (meta && meta.genres ? meta.genres.slice(0, 4).map((g) => '<span class="tag">' + esc(g) + '</span>').join('') : '') +
              '<span class="tag">' + esc(isSeries ? 'Series' : 'Movie') + '</span>' +
            '</div>' +
            (meta && meta.overview ? '<p class="overview">' + esc(meta.overview) + '</p>' : '') +
            '<div class="controls">' +
              (isSeries ? '<label>Season <select id="season">' + seasons.map((s) =>
                  '<option value="' + s.seasonNumber + '"' +
                  (String(s.seasonNumber) === String(season) ? ' selected' : '') + '>' +
                  esc(s.name || 'Season ' + s.seasonNumber) + '</option>').join('') +
                '</select></label>' : '') +
              episodesHtml +
              '<button class="btn" id="play">▶ Play</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>' +
      '<h2 class="section">Sources</h2>' +
      '<div class="streams" id="streams"><div class="loading">Looking for streams…</div></div>';

    constseasonEpisodeBind(type, id, season, episode);
    loadStreams(type, id, isSeries ? season : null, isSeries ? episode : null);
  }

  function constseasonEpisodeBind(type, id, season, episode) {
    const sel = $('#season');
    if (sel) {
      sel.addEventListener('change', () => {
        const p = new URLSearchParams(location.search);
        p.set('season', sel.value);
        p.set('episode', '1');
        navigate(location.pathname + '?' + p.toString());
      });
    }
    const esel = $('#episode');
    if (esel) {
      esel.addEventListener('change', () => {
        const p = new URLSearchParams(location.search);
        p.set('episode', esel.value);
        navigate(location.pathname + '?' + p.toString());
      });
    }
    const play = $('#play');
    if (play) {
      play.addEventListener('click', () => {
        const p = new URLSearchParams(location.search);
        navigate('/watch/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + '?' + p.toString());
      });
    }
  }

  async function loadStreams(type, id, season, episode) {
    const box = $('#streams');
    if (!box) return;

    const params = new URLSearchParams();
    if (season) params.set('season', season);
    if (episode) params.set('episode', episode);
    params.set('diagnostics', 'true');

    const lang = $('#langfilter') ? $('#langfilter').value : '';
    if (lang) params.set('lang', lang);

    try {
      const data = await api('/api/streams/' + encodeURIComponent(type) + '/' +
        encodeURIComponent(id) + '?' + params.toString());

      if (!data.streams || !data.streams.length) {
        const diags = (data.diagnostics || []).filter((d) => !d.ok);
        box.innerHTML =
          '<div class="notice"><strong>No streams found.</strong><br>' +
          'No enabled provider returned a playable source for this title.' +
          (diags.length ? '<br><br><small>' + diags.slice(0, 4).map((d) =>
            esc(d.provider) + ': ' + esc(d.error || 'no results')).join('<br>') + '</small>' : '') +
          '</div>';
        return;
      }

      box.innerHTML = data.streams.map((s, i) => streamRow(s, i)).join('');
      box.querySelectorAll('.stream').forEach((el) => {
        el.addEventListener('click', () => {
          const idx = Number(el.dataset.idx);
          box.querySelectorAll('.stream').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
          playStream(data.streams[idx]);
        });
      });

      // Auto-select the first directly playable source.
      const first = data.streams.findIndex((s) => ['hls', 'dash', 'mp4'].indexOf(s.playback.type) >= 0);
      const start = first >= 0 ? first : 0;
      const el = box.querySelector('.stream[data-idx="' + start + '"]');
      if (el) { el.classList.add('active'); playStream(data.streams[start]); }
    } catch (err) {
      box.innerHTML = '<div class="error">' + esc(err.message) + '</div>';
    }
  }

  function streamRow(s, i) {
    const p = s.playback || {};
    const subs = (s.subtitles || []).length;
    const bits = [];
    if (s.provider && s.provider.name) bits.push(esc(s.provider.name));
    if (p.type) bits.push(esc(String(p.type).toUpperCase()));
    if (s.sizeBytes) bits.push(esc(fmtBytes(s.sizeBytes)));
    if (subs) bits.push(subs + ' subtitle' + (subs === 1 ? '' : 's'));
    if (p.via === 'extracted') bits.push('extracted');
    if (s.seeders) bits.push(esc(s.seeders) + ' seeds');

    return (
      '<div class="stream" data-idx="' + i + '">' +
        '<div class="idx">' + (i + 1) + '</div>' +
        '<div class="info">' +
          '<div class="name">' + esc(s.name || s.title || s.provider.name) + '</div>' +
          '<div class="detail">' + bits.join(' · ') + '</div>' +
        '</div>' +
        qualityBadge(s) + langBadge(s) +
        '<span class="badge ' + (['hls', 'dash', 'mp4'].indexOf(p.type) >= 0 ? 'ok' : 'warn') + '">' +
          esc(String(p.type || 'unknown').toUpperCase()) + '</span>' +
      '</div>'
    );
  }

  // ------------------------------------------------------------- watch page

  async function watchPage(type, id) {
    const params = new URLSearchParams(location.search);
    const season = params.get('season') || '1';
    const episode = params.get('episode') || '1';

    app.innerHTML =
      '<div class="playerwrap" id="playerwrap">' +
        '<div class="overlay">Fetching streams…</div>' +
      '</div>' +
      '<div class="controls"><a class="ghost" href="/title/' + esc(type) + '/' + esc(id) + '?season=' +
        esc(season) + '&episode=' + esc(episode) + '">← Back to sources</a></div>' +
      '<h2 class="section">Sources</h2>' +
      '<div class="streams" id="streams"><div class="loading">…</div></div>';

    const isSeries = type !== 'movie';
    loadStreams(type, id, isSeries ? season : null, isSeries ? episode : null);
  }

  // ----------------------------------------------------------------- player

  let hls = null;
  let dash = null;

  function stopPlayer() {
    try { if (hls) { hls.destroy(); hls = null; } } catch (_) {}
    try { if (dash) { dash.reset(); dash = null; } } catch (_) {}
    const v = document.getElementById('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} }
  }

  /** Inject the API key into player XHRs, since /proxy/* may require auth. */
  function xhrWithKey(xhr) {
    const key = apiKey();
    if (key) xhr.setRequestHeader('x-api-key', key);
    return xhr;
  }

  function playerContainer() {
    let wrap = document.getElementById('playerwrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'playerwrap';
      wrap.id = 'playerwrap';
      app.insertBefore(wrap, app.firstChild);
      window.scrollTo(0, 0);
    }
    return wrap;
  }

  function showOverlay(wrap, msg) {
    const old = wrap.querySelector('.overlay');
    if (old) old.remove();
    const o = document.createElement('div');
    o.className = 'overlay';
    o.textContent = msg;
    wrap.appendChild(o);
  }

  function clearOverlay(wrap) {
    const old = wrap.querySelector('.overlay');
    if (old) old.remove();
  }

  function buildVideo(wrap) {
    wrap.innerHTML = '';
    const v = document.createElement('video');
    v.id = 'video';
    v.controls = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.autoplay = true;
    wrap.appendChild(v);
    return v;
  }

  function addTracks(video, subtitles) {
    (subtitles || []).forEach((s, i) => {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.src = s.url;
      t.srclang = s.lang || 'und';
      t.label = s.label || s.lang || 'Track ' + (i + 1);
      if (i === 0) t.default = true;
      video.appendChild(t);
    });
  }

  function playStream(stream) {
    const wrap = playerContainer();
    const p = stream.playback || {};
    stopPlayer();

    if (p.type === 'embed') {
      wrap.innerHTML = '<iframe src="' + esc(p.url) + '" allowfullscreen ' +
        'allow="autoplay; encrypted-media; picture-in-picture" ' +
        'sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>';
      return;
    }

    if (p.type === 'torrent') {
      wrap.innerHTML = '';
      showOverlay(wrap, 'Torrent / debrid source — open it in a torrent client or a debrid service:\n' +
        (p.infoHash || '').slice(0, 40) + '…');
      return;
    }

    const video = buildVideo(wrap);
    addTracks(video, stream.subtitles);

    const url = p.url;
    const onError = () => showOverlay(wrap, 'Playback failed. Try another source.');

    if (p.type === 'hls') {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90,
          xhrSetup: xhrWithKey,
        });
        hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            showOverlay(wrap, 'Network error — retrying…');
            hls.startLoad();
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            onError();
          }
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          clearOverlay(wrap);
          video.play().catch(() => {});
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        return;
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.addEventListener('loadedmetadata', () => clearOverlay(wrap));
        video.play().catch(() => {});
        return;
      }
      showOverlay(wrap, 'HLS is not supported in this browser.');
      return;
    }

    if (p.type === 'dash') {
      if (window.dashjs) {
        dash = window.dashjs.MediaPlayer().create();
        dash.updateSettings({
          streaming: {
            buffer: { fastSwitchEnabled: true },
            delay: { liveDelay: 12 },
          },
        });
        dash.extend('RequestModifier', function () {
          return { modifyRequestHeader: xhrWithKey };
        }, true);
        dash.initialize(video, url, true);
        dash.on(window.dashjs.MediaPlayer.events.ERROR, onError);
        dash.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => clearOverlay(wrap));
        return;
      }
      showOverlay(wrap, 'DASH is not supported in this browser.');
      return;
    }

    // mp4 / unknown: let the browser try.
    video.src = url;
    video.addEventListener('loadedmetadata', () => clearOverlay(wrap));
    video.addEventListener('error', onError);
    video.play().catch(() => {});
  }

  // ---------------------------------------------------------------- startup

  $('#searchform').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search').value.trim();
    if (!q) return;
    navigate('/search?q=' + encodeURIComponent(q));
  });

  $('#settingsbtn').addEventListener('click', () => {
    const s = $('#settings');
    s.classList.toggle('hidden');
    $('#apikey').value = apiKey();
  });
  $('#closesettings').addEventListener('click', () => $('#settings').classList.add('hidden'));
  $('#savesettings').addEventListener('click', () => {
    localStorage.setItem(LS_KEY, $('#apikey').value.trim());
    $('#settings').classList.add('hidden');
    render();
  });

  const langSel = $('#langfilter');
  if (langSel) langSel.addEventListener('change', render);

  // Provider status strip
  (async () => {
    try {
      const d = await api('/api/health');
      const p = d.providers || {};
      const el = $('#providerstatus');
      if (el) {
        el.textContent = p.ready + '/' + p.total + ' providers ready · cache: ' +
          (d.features && d.features.cache) + ' · tmdb: ' + ((d.features && d.features.tmdb) ? 'on' : 'off');
      }
    } catch (_) {
      const el = $('#providerstatus');
      if (el) el.textContent = 'API unreachable';
    }
  })();

  render();
})();
