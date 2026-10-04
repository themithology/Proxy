/**
 * Canonical Server Catalog — single source of truth for the player's server array.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The player (`public/js/embed.js`) renders the server list straight from the
 * `servers` array in the `/api/resolve/...` response. Two backends can serve
 * that response:
 *
 *   1. The Cloudflare Worker (`cloudflare-worker/worker.js`) — serves `/embed`
 *      plus `/api/*` and is the deployment the player normally talks to.
 *   2. The Node backend (`src/server.js`) — API-only, used when the player is
 *      pointed at it via `API_BASE_URL` / `?api=`.
 *
 * Both used to keep their own hardcoded copy of the server list, so rebranding
 * or re-prioritising servers in one place left the player showing the other
 * copy (stale names, stale order, servers that no longer exist). Both backends
 * now derive their list from this module, so a rebrand is a one-file change.
 *
 * No Node-only APIs are used here on purpose: the Worker bundles this file
 * through `nodejs_compat` alongside the rest of `src/`.
 */

/**
 * Player-visible production servers, in waterfall priority order.
 * `badge` is the description rendered under the name in the servers modal.
 */
const PRODUCTION_SERVERS = [
  {
    id: 'andromeda',
    name: 'Fiber Optic Speedrun',
    badge: 'Multi-Audio • Primary',
    priority: 1,
    enabled: true,
    supportsMultiAudio: true
  },
  {
    id: 'centaurus',
    name: 'Gigachad Node',
    badge: 'Adaptive • Multi-Quality',
    priority: 2,
    enabled: true,
    supportsMultiAudio: true
  },
  {
    id: 'hamster',
    name: 'Hamster Wheel',
    badge: 'Hindi First • Multi-Audio • Max Coverage',
    priority: 3,
    enabled: true,
    supportsMultiAudio: true
  }
];

/** Waterfall order. Kept in sync with the priorities above by construction. */
const WATERFALL_PRIORITY = PRODUCTION_SERVERS.map((s) => s.id);

/** Stable ordering helper: unknown priorities sink to the bottom, id breaks ties. */
function sortByPriority(list) {
  return [...list].sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : 999;
    const pb = Number.isFinite(b.priority) ? b.priority : 999;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Servers the player is allowed to see: enabled and not hidden.
 * Always returned in priority order so the UI order cannot drift from config.
 */
function listableServers(list) {
  return sortByPriority(list.filter((s) => s.enabled !== false && s.listed !== false));
}

/** Servers that may be attempted implicitly by the waterfall. */
function waterfallEnabledServers(list) {
  return sortByPriority(list.filter((s) => s.enabled !== false && s.fallback !== false));
}

/**
 * Map a (possibly stale or unknown) requested server id onto a real one.
 * Removed or unknown ids (including legacy `4k`/`uhd`/`2160p` aliases) fall back
 * to the top-priority server so a stale bookmark can never strand the player.
 */
function resolveServerId(list, requestedServerId) {
  const requested = String(requestedServerId || '').trim().toLowerCase();
  const normalized = requested;
  if (normalized) {
    const known = list.find((s) => s.id === normalized && s.enabled !== false);
    if (known) return known.id;
  }
  // Unknown, removed or disabled id: fall back to the best live server so a
  // stale bookmark/embed URL can never strand the player on a dead server.
  const [fallback] = waterfallEnabledServers(list);
  return fallback ? fallback.id : PRODUCTION_SERVERS[0].id;
}

/**
 * Build the API `servers` array: listed servers in priority order with the
 * active server flagged. `activeServerId` accepts the resolved stream's server
 * id, which may be an opt-in server that is not itself listed.
 */
function buildServerPayload(allServers, activeServerId = null) {
  const listed = listableServers(allServers);
  const activeId = activeServerId || null;
  // A stream resolved by a server that is not listed (e.g. an owner "custom"
  // override) would otherwise leave the modal with nothing highlighted.
  const includesActive = listed.some((s) => s.id === activeId);
  const payload = listed.map((s) => ({ ...s, active: s.id === activeId }));
  if (activeId && !includesActive) {
    const hidden = allServers.find((s) => s.id === activeId);
    if (hidden) payload.push({ ...hidden, active: true });
  }
  return payload;
}

/**
 * Every server a backend knows how to resolve, in waterfall priority order.
 * This is what `config.servers` / the Worker's SERVERS hold — use
 * `listableServers()`/`buildServerPayload()` for anything the player renders,
 * and this list for resolution, /api/health and admin views.
 */
function allServers() {
  return PRODUCTION_SERVERS.map((s) => ({ ...s }));
}

/** @deprecated alias kept for readability at the call sites. */
const nodeServerList = allServers;
/** @deprecated alias kept for readability at the call sites. */
const workerServerList = allServers;

module.exports = {
  PRODUCTION_SERVERS,
  WATERFALL_PRIORITY,
  sortByPriority,
  listableServers,
  waterfallEnabledServers,
  resolveServerId,
  buildServerPayload,
  allServers,
  nodeServerList,
  workerServerList
};
