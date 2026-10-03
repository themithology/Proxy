(function () {
  'use strict';

  const adminKeyInput = document.getElementById('admin-key-input');
  const btnAuthRefresh = document.getElementById('btn-auth-refresh');
  const alertBanner = document.getElementById('admin-alert-banner');

  const kpiDomains = document.getElementById('kpi-domains');
  const kpiBlockedSub = document.getElementById('kpi-blocked-sub');
  const kpiEmbeds = document.getElementById('kpi-embeds');
  const kpiResolvesSub = document.getElementById('kpi-resolves-sub');
  const kpiServersHealth = document.getElementById('kpi-servers-health');
  const kpiStaleSub = document.getElementById('kpi-stale-sub');
  const kpiProxyHits = document.getElementById('kpi-proxy-hits');
  const kpiOverridesSub = document.getElementById('kpi-overrides-sub');

  const serversHealthGrid = document.getElementById('servers-health-grid');
  const btnRunProbe = document.getElementById('btn-run-probe');
  const btnSaveUpstreams = document.getElementById('btn-save-upstreams');
  const btnExportEnv = document.getElementById('btn-export-env');

  const upVidstuck = document.getElementById('up-vidstuck');
  const upZxc = document.getElementById('up-zxc');
  const upVidsrc = document.getElementById('up-vidsrc');
  const upHicine = document.getElementById('up-hicine');
  const upHianime = document.getElementById('up-hianime');
  const upAesKey = document.getElementById('up-aes-key');
  const upProxyPool = document.getElementById('up-proxy-pool');

  const domainsTableBody = document.getElementById('domains-table-body');
  const inputBlockDomain = document.getElementById('input-block-domain');
  const btnBlockDomain = document.getElementById('btn-block-domain');

  const ovType = document.getElementById('ov-type');
  const ovTmdb = document.getElementById('ov-tmdb');
  const ovSeason = document.getElementById('ov-season');
  const ovEpisode = document.getElementById('ov-episode');
  const ovUrl = document.getElementById('ov-url');
  const ovLabel = document.getElementById('ov-label');
  const btnAddOverride = document.getElementById('btn-add-override');
  const overridesTableBody = document.getElementById('overrides-table-body');

  let latestSnapshot = null;

  // Load saved admin key from sessionStorage if present
  const savedKey = sessionStorage.getItem('vidstuck_admin_key');
  if (savedKey) adminKeyInput.value = savedKey;

  function getAdminKey() {
    const val = (adminKeyInput.value || 'admin123').trim();
    sessionStorage.setItem('vidstuck_admin_key', val);
    return val;
  }

  function showAlert(msg, isError = false) {
    alertBanner.textContent = msg;
    alertBanner.className = 'admin-alert' + (isError ? ' error' : '');
    alertBanner.classList.remove('hidden');
    setTimeout(() => {
      alertBanner.classList.add('hidden');
    }, 5000);
  }

  async function adminFetch(path, options = {}) {
    const headers = {
      'X-Admin-Key': getAdminKey(),
      ...(options.headers || {})
    };
    const res = await fetch(path, { ...options, headers });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function renderDashboard(snap) {
    latestSnapshot = snap;
    const sum = snap.summary || {};

    kpiDomains.textContent = String(sum.uniqueDomains || 0);
    kpiBlockedSub.textContent = `${sum.blockedDomainsCount || 0} blocked domains`;
    kpiEmbeds.textContent = String(sum.totalEmbeds || 0);
    kpiResolvesSub.textContent = `${sum.totalResolves || 0} stream resolutions`;
    kpiProxyHits.textContent = String(sum.totalProxyHits || 0);
    kpiOverridesSub.textContent = `${(snap.customOverrides || []).length} custom TMDB overrides`;

    const totalSrv = (snap.servers || []).length || 5;
    const activeSrv = sum.activeServersCount ?? totalSrv;
    const deadCount = sum.deadOrDegradedCount || 0;
    kpiServersHealth.textContent = `${activeSrv} / ${totalSrv} Online`;
    kpiServersHealth.className = 'kpi-value ' + (deadCount > 0 ? 'kpi-warn' : 'kpi-good');
    kpiStaleSub.textContent =
      deadCount > 0
        ? `⚠ ${deadCount} source(s) degraded or unreachable`
        : 'All upstream scrapers healthy';

    // Populate Upstream URLs form
    const u = snap.upstreams || {};
    upVidstuck.value = u.vidstuckBase || '';
    upZxc.value = u.zxcBase || '';
    upVidsrc.value = u.vidsrcDataUrl || '';
    upHicine.value = u.hicineApiBase || '';
    upHianime.value = u.hianimeBase || '';
    upAesKey.value = snap.zxcAesKey || '';
    upProxyPool.value = (snap.externalProxyPool || []).join(', ');

    renderServersGrid(snap.servers || []);
    renderDomainsTable(snap.domains || [], snap.blockedDomains || []);
    renderOverridesTable(snap.customOverrides || []);
  }

  function renderServersGrid(servers) {
    serversHealthGrid.innerHTML = '';
    servers.forEach((srv) => {
      const card = document.createElement('div');
      card.className = `server-health-card status-${srv.status || 'online'}`;

      const errorHtml = srv.lastError
        ? `<div class="srv-error">Last error: ${srv.lastError}</div>`
        : '';

      card.innerHTML = `
        <div class="srv-top">
          <span class="srv-name">#${srv.priority} ${srv.name}</span>
          <span class="status-pill ${srv.status || 'online'}">${srv.status || 'online'}</span>
        </div>
        <div class="srv-badge">${srv.badge || ''}</div>
        <div class="srv-stats-row">
          <span>Success: <strong>${srv.successRate}%</strong> (${srv.successCount}/${srv.successCount + srv.failureCount})</span>
          <span>Latency: <strong>${srv.avgLatencyMs || srv.lastLatencyMs || 0}ms</strong></span>
        </div>
        ${errorHtml}
        <div class="srv-controls">
          <button class="btn-secondary-sm btn-toggle-srv" data-id="${srv.id}" data-enabled="${srv.enabled}">
            ${srv.enabled ? 'Disable Server' : 'Enable Server'}
          </button>
          <button class="btn-secondary-sm btn-promote-srv" data-id="${srv.id}">
            ↑ Promote #1
          </button>
        </div>
      `;
      serversHealthGrid.appendChild(card);
    });

    document.querySelectorAll('.btn-toggle-srv').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const currentlyEnabled = btn.dataset.enabled === 'true';
        try {
          const res = await adminFetch('/api/admin/upstreams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              servers: [{ id, enabled: !currentlyEnabled }]
            })
          });
          renderDashboard(res.snapshot);
          showAlert(`Server "${id}" ${!currentlyEnabled ? 'enabled' : 'disabled'}.`);
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });

    document.querySelectorAll('.btn-promote-srv').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const currentServers = (latestSnapshot && latestSnapshot.servers) || [];
        const updated = currentServers.map((s) => ({
          id: s.id,
          priority: s.id === id ? 1 : (s.priority || 2) + 1
        }));
        try {
          const res = await adminFetch('/api/admin/upstreams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ servers: updated })
          });
          renderDashboard(res.snapshot);
          showAlert(`Promoted "${id}" to #1 Primary Failover Server.`);
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });
  }

  function renderDomainsTable(domains, blockedList) {
    domainsTableBody.innerHTML = '';

    // Merge any manually blocked domains that haven't made requests yet
    const seen = new Set(domains.map((d) => d.domain));
    const allRows = [...domains];
    blockedList.forEach((b) => {
      if (!seen.has(b)) {
        allRows.push({
          domain: b,
          embeds: 0,
          resolves: 0,
          proxyHits: 0,
          topTitles: [],
          lastSeen: '—',
          blocked: true
        });
      }
    });

    if (allRows.length === 0) {
      domainsTableBody.innerHTML =
        '<tr><td colspan="8" class="empty-cell">No external domain activity recorded yet. Open an embed player to generate telemetry.</td></tr>';
      return;
    }

    allRows.forEach((d) => {
      const tr = document.createElement('tr');
      const titlesStr =
        Array.isArray(d.topTitles) && d.topTitles.length > 0
          ? d.topTitles.map((t) => `${t.title} (${t.count})`).join(', ')
          : '—';
      const lastSeenStr =
        d.lastSeen && d.lastSeen !== '—' ? new Date(d.lastSeen).toLocaleTimeString() : '—';

      tr.innerHTML = `
        <td><strong>${d.domain}</strong></td>
        <td><span class="status-pill ${d.blocked ? 'dead' : 'online'}">${d.blocked ? 'BLOCKED' : 'ALLOWED'}</span></td>
        <td>${d.embeds}</td>
        <td>${d.resolves}</td>
        <td>${d.proxyHits}</td>
        <td>${titlesStr}</td>
        <td>${lastSeenStr}</td>
        <td>
          <button class="${d.blocked ? 'btn-secondary-sm' : 'btn-danger-sm'} btn-domain-toggle" data-domain="${d.domain}" data-blocked="${d.blocked}">
            ${d.blocked ? 'Unblock' : 'Block Domain'}
          </button>
        </td>
      `;
      domainsTableBody.appendChild(tr);
    });

    document.querySelectorAll('.btn-domain-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const domain = btn.dataset.domain;
        const isBlocked = btn.dataset.blocked === 'true';
        try {
          const res = await adminFetch('/api/admin/domains/block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, blocked: !isBlocked })
          });
          renderDashboard(res.snapshot);
          showAlert(`Domain "${domain}" ${!isBlocked ? 'blocked' : 'unblocked'}.`);
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });
  }

  function renderOverridesTable(overrides) {
    overridesTableBody.innerHTML = '';
    if (!overrides || overrides.length === 0) {
      overridesTableBody.innerHTML =
        '<tr><td colspan="8" class="empty-cell">No custom stream overrides configured.</td></tr>';
      return;
    }

    overrides.forEach((ov) => {
      const tr = document.createElement('tr');
      const seStr = ov.type === 'tv' ? `S${ov.season}E${ov.episode}` : 'Movie';
      tr.innerHTML = `
        <td><code>${ov.key}</code></td>
        <td>${ov.type.toUpperCase()}</td>
        <td><strong>${ov.tmdbId}</strong></td>
        <td>${seStr}</td>
        <td>${ov.label || 'Custom'}</td>
        <td><code>${ov.streamUrl.slice(0, 55)}${ov.streamUrl.length > 55 ? '...' : ''}</code></td>
        <td>${ov.updatedAt ? new Date(ov.updatedAt).toLocaleTimeString() : '—'}</td>
        <td>
          <button class="btn-danger-sm btn-del-override" data-key="${ov.key}">Delete</button>
        </td>
      `;
      overridesTableBody.appendChild(tr);
    });

    document.querySelectorAll('.btn-del-override').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await adminFetch(`/api/admin/overrides/${encodeURIComponent(btn.dataset.key)}`, {
            method: 'DELETE'
          });
          renderDashboard(res.snapshot);
          showAlert(`Removed custom override ${btn.dataset.key}`);
        } catch (err) {
          showAlert(err.message, true);
        }
      });
    });
  }

  async function loadOverview() {
    try {
      const data = await adminFetch('/api/admin/overview');
      renderDashboard(data);
    } catch (err) {
      showAlert(`Admin Auth Error: ${err.message}`, true);
    }
  }

  btnAuthRefresh.addEventListener('click', loadOverview);

  btnRunProbe.addEventListener('click', async () => {
    btnRunProbe.disabled = true;
    btnRunProbe.textContent = '⏳ Probing Upstreams...';
    try {
      const data = await adminFetch('/api/admin/probe', { method: 'POST' });
      renderDashboard(data.snapshot);
      const okCount = (data.probeResults || []).filter((r) => r.ok).length;
      showAlert(`Health probe finished: ${okCount}/${(data.probeResults || []).length} upstreams responded online.`);
    } catch (err) {
      showAlert(err.message, true);
    } finally {
      btnRunProbe.disabled = false;
      btnRunProbe.textContent = '⚡ Run Live Health Probe';
    }
  });

  btnSaveUpstreams.addEventListener('click', async () => {
    try {
      const payload = {
        upstreams: {
          vidstuckBase: upVidstuck.value.trim(),
          zxcBase: upZxc.value.trim(),
          vidsrcDataUrl: upVidsrc.value.trim(),
          hicineApiBase: upHicine.value.trim(),
          hianimeBase: upHianime.value.trim()
        },
        zxcAesKey: upAesKey.value.trim(),
        externalProxyPool: upProxyPool.value.trim()
      };
      const res = await adminFetch('/api/admin/upstreams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      renderDashboard(res.snapshot);
      showAlert('Upstream domains, AES key, and proxy pool updated live!');
    } catch (err) {
      showAlert(err.message, true);
    }
  });

  btnExportEnv.addEventListener('click', () => {
    const envText = [
      `VIDSTUCK_BASE_URL=${upVidstuck.value.trim()}`,
      `ZXC_BASE_URL=${upZxc.value.trim()}`,
      `VIDSRC_DATA_URL=${upVidsrc.value.trim()}`,
      `HICINE_API_BASE=${upHicine.value.trim()}`,
      `HIANIME_BASE_URL=${upHianime.value.trim()}`,
      `ZXC_AES_KEY=${upAesKey.value.trim()}`,
      `EXTERNAL_PROXY_POOL=${upProxyPool.value.trim()}`
    ].join('\n');
    navigator.clipboard.writeText(envText).catch(() => {});
    showAlert('Copied updated .env / Wrangler variables to clipboard!');
  });

  btnBlockDomain.addEventListener('click', async () => {
    const domain = inputBlockDomain.value.trim();
    if (!domain) return;
    try {
      const res = await adminFetch('/api/admin/domains/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, blocked: true })
      });
      inputBlockDomain.value = '';
      renderDashboard(res.snapshot);
      showAlert(`Blocked domain "${domain}" from embedding.`);
    } catch (err) {
      showAlert(err.message, true);
    }
  });

  btnAddOverride.addEventListener('click', async () => {
    const tmdbId = ovTmdb.value.trim();
    const streamUrl = ovUrl.value.trim();
    if (!tmdbId || !streamUrl) {
      showAlert('Please enter both a TMDB ID and a direct .m3u8/.mp4 Stream URL.', true);
      return;
    }
    try {
      const res = await adminFetch('/api/admin/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: ovType.value,
          tmdbId,
          season: Number(ovSeason.value || 1),
          episode: Number(ovEpisode.value || 1),
          streamUrl,
          label: ovLabel.value.trim() || 'Admin Custom Source'
        })
      });
      ovUrl.value = '';
      renderDashboard(res.snapshot);
      showAlert(`Added custom stream override for TMDB #${tmdbId}.`);
    } catch (err) {
      showAlert(err.message, true);
    }
  });

  loadOverview();
})();
