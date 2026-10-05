# LOL Embed — Player Worker & Backend

LOL Embed is the **player Worker**: it serves the embeddable player page at `/embed`, the JSON/stream backend API (TMDB metadata, source resolution, edge stream proxy), the public **documentation** at `/docs` (alias `/documentation`) and the owner **dashboard** at `/reze`. The main frontend website is a **separate project** and embeds this Worker with an iframe; it is intentionally not built in this repository. There is no landing page — `/` is a JSON service descriptor for API clients (and a rickroll for browsers).

## Brand

- **Name:** LOL Embed
- **Visual direction:** monochrome
- **Palette:** black `#000000`, charcoal `#171717`, graphite `#404040`, gray `#A3A3A3`, and white `#FFFFFF`
- **Social/meta image:** `GET /meta-image.gif` serves the supplied GIF. Use its absolute deployment URL for `og:image` and `twitter:image` on the main site. The root JSON response also advertises it as `metaImage`.

Example metadata for the future main site:

```html
<meta property="og:title" content="LOL Embed">
<meta property="og:image" content="https://YOUR_PLAYER_HOST/meta-image.gif">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://YOUR_PLAYER_HOST/meta-image.gif">
<meta name="theme-color" content="#000000">
```

## Embedding the player

The main website embeds the player with an iframe pointing at this Worker. The player accepts several equivalent URL forms — a canonical query form plus path-style and legacy path forms:

| Form                     | Example                                      |
| ------------------------ | -------------------------------------------- |
| Canonical query          | `/embed?type=tv&tmdb=94605&s=1&e=1`          |
| Path (TV)                | `/embed/tv/:tmdbId/:s/:e` → `/embed/tv/94605/2/1` |
| Path (movie)             | `/embed/movie/:tmdbId` → `/embed/movie/693134` |
| Legacy path (TV)         | `/tv/:tmdbId/:s/:e` → `/tv/94605/2/1`        |
| Legacy path (movie)      | `/movie/:tmdbId` → `/movie/693134`           |

The path forms also accept the query parameters listed below (e.g. `?api=`, `?lang=`, `?server=`) and a trailing slash. Every form serves the same player page.

For example, once the player Worker is deployed to `https://lol-embed.example.workers.dev`:

```html
<iframe
  src="https://lol-embed.example.workers.dev/embed?type=tv&tmdb=94605&s=1&e=1"
  allowfullscreen
  allow="autoplay; fullscreen; encrypted-media"
  referrerpolicy="no-referrer"
></iframe>
```

The page is served with `Content-Security-Policy: frame-ancestors *` so any site can embed it. Supported query parameters on every player URL form:

| Parameter  | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `type`     | `tv` (default) or `movie`                                               |
| `tmdb`     | TMDB ID (also accepted as `id`)                                          |
| `s` / `e`  | Season / episode for TV (also `season` / `episode`)                      |
| `server`   | Preferred upstream server: `andromeda` or `centaurus` (a stale/removed id falls back to the top-priority server) |
| `source`   | Optional pin to one source of a multi-source server: `centaurus&source=hicine` (pinned requests do not fall through to other servers) |
| `api`      | Absolute API base URL override (see below)                               |
| `lang`     | Preferred audio language (e.g. `hi`, `en`, `ta`)                         |
| `sub`      | Preferred subtitle language (e.g. `en`); matched against the resolved tracks' language codes |
| `t`        | Start position — seconds (`t=754`), `1h2m3s` / `12m34s` or `12:34` (also accepted as `start`). One-shot: it applies to the episode the link opens, not to the next one |
| `autoskip` | `1` turns **auto-skip** on for this viewer (intros / recaps / previews are skipped automatically; credits keep the manual *Next Episode* button); `0` turns it off. The choice persists in `localStorage` |
| `origin`   | Origin of the page hosting the iframe (e.g. `https://watch.example`). When set, the player only obeys `postMessage` commands from that origin and posts its events only to it (see *Host control API*) |
| `color`    | Optional accent override (e.g. `e50914`); default styling is monochrome  |
| `branding` | Player branding text (defaults to `LOL Embed`)                           |
| `back`     | `false`/`0` hides the back button                                        |

All of these routes serve the same player page. When the episode changes, the player rewrites the URL in place (`history.replaceState`) using whichever form it was opened with — the query string for `/embed?…`, the path segments for `/embed/tv/:id/:s/:e` — so a reload resumes the episode that is actually playing and no additional routes are needed on the player Worker.

### Player UI behaviour

- **Connect screen:** every load and every server/source change shows a connect screen over the blurred TMDB backdrop: the title's logo artwork (TMDB `images.logos`, English PNG preferred; plain title text when the title has none), its genres, a `CONNECTING TO <SERVER>_` status with a progress bar that advances as the stream is resolved, picked and becomes playable, the **Server / Source NN** that answered, rotating usage tips, the `?branding=` name and its own Back / Servers buttons. On first open the TMDB metadata is fetched (`/api/info`) in parallel with the much slower stream resolve, so the artwork is on screen almost immediately. A failure turns the same screen into the error state.
- **Paused screen:** two seconds after pausing with no interaction, the controls give way to a title card over the blurred artwork — `PAUSED`, the logo image, the episode (`S1 E2 · title`), tagline, `year • runtime • ★ rating`, genre pills and the episode's (or show's) overview. Any pointer, touch or key activity brings the controls back (the card returns after another two idle seconds while still paused); resuming removes it. It never shows over an open menu, while loading/erroring, after the credits, or before playback has started.
- **Compact layout:** below 720 px wide or 440 px tall the player rearranges itself: the title moves into the top bar beside Back, a `−15 / play-pause / +15` transport sits in the centre of the picture, the timeline spans the full width with the times underneath, and the remaining icons (volume, audio, subtitles, settings, fullscreen) are centred in the bottom row. The layout follows the embed's size live (`ResizeObserver`).
- **Playback state:** a centre play button appears while paused (and persistently on touch devices); a small spinner shows during buffering/seeks; the HUD and cursor hide after ~3 s of inactivity during playback and come back on pause. Clicking or tapping the picture never pauses: it only shows the controls (a tap on visible controls hides them again); play/pause lives on the buttons, `Space`/`K`, and double-click/double-tap centre toggles fullscreen.
- **Servers & sources:** the cloud button opens a list of servers; under each one the player lists the stream sources it resolved as **Source 1…N** (upstream provider names and URLs are never shown). Picking a source of the playing server switches mirrors in place; picking another server (or one of its sources) re-resolves. Servers the player knows nothing about yet are checked one at a time while the list is open (✓ ready · — not checked · ✕ unavailable), and what one resolve reveals about other servers (the backend waterfall's attempts) is reused instead of re-asked.
- **Errors:** when a server fails the player tries the next one automatically. When every server fails, the connect screen turns into the error state — *"Ouu shii… can't find it here. Maybe change the server from below :)"* — with the reason underneath and the **server list rendered right there**: each server shows its status (✓ ready · — not checked · ✕ unavailable), unchecked servers keep being probed while the screen is up, tapping a server switches to it, and tapping the one that just failed retries it (**Retry** does the same). No endless spinner, no dead end.
- **Skip button & timeline:** only shown for real intro/recap/credits segments returned by the API (see *Skip segments* below); the timeline is split at those segments and the ranges are highlighted in yellow (no invented chapters). While the playhead is inside a segment the progress fill and thumb turn yellow and the button's background fills left-to-right as the segment elapses; the button stays visible even after the rest of the HUD auto-hides. `S` (or the button) jumps to the end of the segment, or to the next episode during credits. Hovering the timeline shows the time and the segment name. **Auto-skip** (Settings → *Auto-skip intro & recap*, `?autoskip=1`, or the `setAutoSkip` host command) skips intros, recaps and previews on its own — once per segment, so seeking back into one shows the button again instead of looping — and never auto-skips credits.
- **Episodes drawer:** the season dropdown browses another season (`/api/info?season=`) without interrupting playback; cards show a "Now playing" badge and the viewer's watched progress.
- **Up next:** at the end of a TV episode an 8-second countdown card offers *Play now* / *Cancel*; the last available episode ends without a redirect.
- **Resume:** progress is saved per episode in `localStorage` (every ~3 s while playing, and immediately on pause, tab hide and unload); anything past 95 % is treated as finished and restarts from the beginning. An explicit `?t=` wins over the saved position for the link that was opened.
- **Share at a timestamp:** Settings → *Copy link at current time* copies the current embed URL with `?t=<seconds>` and fires a `share` host event carrying `{ url, time }`, so a host page can offer its own link instead.
- **Subtitles & audio:** rendered by the player (multi-line cues, HTML entities decoded, RTL languages right-aligned); styling and delay/offset live in the subtitle menu. The language the viewer picks — or *Off* — is remembered **per title** (`lol_embed_prefs_<type>_<tmdbId>`) and re-applied on the next episode and the next visit, ahead of `?sub=` / `?lang=`; audio language is remembered the same way. Global subtitle style and volume/mute persist too.
- **Quality:** the quality the viewer picks is remembered (`lol_embed_quality`, by height) and re-applied on HLS streams whose ladder has it; progressive single-file sources are left on *Auto* rather than re-downloading.
- **Hold to fast-forward:** pressing and holding the picture (touch, pen or mouse) plays at 2× with a small `2× ▶▶` badge until release; the speed setting is left untouched and the release does not toggle the controls.
- **Keyboard:** `Space`/`K` play-pause · `←`/`→`/`J`/`L` ±15 s · `↑`/`↓` volume · `M` mute · `C` captions · `F` fullscreen · `S` skip intro/recap/credits · `0–9` seek to 0–90 % · `Shift+N` next episode · `Esc` close menus. Touch: double-tap left/right to seek ±15 s, double-tap centre for fullscreen, press-and-hold for 2×. Fullscreen on phones also requests landscape orientation lock where the browser allows it; Picture-in-Picture lives in Settings.

### Host control API (postMessage)

A page embedding the player (a watch-party room, a site with its own "up next" rail, …) talks to it with **one** stable `postMessage` dialect — no polling, no guessing which player is inside the frame. The player identifies itself with `source: "lol-embed-player"` on everything it sends; protocol version `1`.

**Sending commands** — `iframe.contentWindow.postMessage({ type: "LOL_EMBED_PLAYER_COMMAND", command, requestId?, ...args }, playerOrigin)`. Only the frame's parent / top / opener window is obeyed; with `?origin=` on the embed URL, only that origin. When a `requestId` is included (and always for the query commands) the player answers with `{ source, type: "LOL_EMBED_PLAYER_RESPONSE", command, requestId, ok, error, ...snapshot }`.

| Command | Arguments | Notes |
| --- | --- | --- |
| `play` / `pause` / `togglePlay` | — | `play` resolves after the browser accepted it; an autoplay refusal answers `ok: false, error: "NotAllowedError"` |
| `seek` | `time` (seconds) | Clamped to the media; `seekBy` takes `delta` |
| `setVolume` | `volume` 0–1, optional `muted` | `setMuted { muted }` on its own |
| `setPlaybackRate` | `rate` 0.25–4 | |
| `setSubtitle` | `lang` (e.g. `"ar"`) or `id`, or `"off"` | Remembered for the title like a menu choice |
| `setAudio` | `lang` or `id` | Same as choosing it in the audio menu |
| `setServer` | `server` id | Re-resolves on that server, keeping the position |
| `setEpisode` | `season`, `episode` | TV only |
| `nextEpisode` | — | `ok: false` when there is none |
| `skipSegment` | — | Skips the intro / recap / credits segment at the playhead, if any |
| `setAutoSkip` | `enabled` (boolean) | Same switch as Settings → Auto-skip |
| `getState` / `getTime` / `getDuration` / `ping` | — | Query only; always answered, `requestId` optional |

**Receiving events** — listen for `message` events whose `data.type === "LOL_EMBED_PLAYER_EVENT"`. Every event carries `event` plus the **full snapshot** below (so a host never has to issue a `getState` to interpret an event). Events: `init` (player script ready; sent before anything loads), `loadstart { server }`, `sourcechange` (a different stream URL was attached), `ready` (bundle resolved and attached), `loadedmetadata`, `durationchange` (only once the browser knows the real duration), `play`, `playing`, `pause`, `waiting`, `seeking`, `seeked`, `timeupdate` (~4×/s, native cadence), `ratechange`, `volumechange`, `ended`, `error { error, serverExplanation }`, `statechange { previousState }`, `serverchange`, `episodechange { season, episode }`, `audiotrackchange`, `subtitlechange`, `fullscreenchange`, `share { url, time }`, `back`.

| Snapshot field | Meaning |
| --- | --- |
| `protocol` | `1` |
| `tmdbId`, `mediaType`, `season`, `episode`, `title` | What is loaded (`season`/`episode` are `null` for movies) |
| `state` | One of `loading` · `error` · `ready` (attached, never played) · `playing` · `buffering` · `paused` · `ended`. **Buffering is its own state** — a stalled stream is `buffering` with `paused: false`, never `paused` |
| `paused`, `buffering`, `seeking`, `ended` | The raw flags behind `state` |
| `currentTime`, `playbackRate`, `volume`, `muted`, `fullscreen` | Playback position and output state |
| `mediaDuration` | The real duration of the attached file in seconds, or `null` until the browser reports one. **Use this for cut detection** — it differs between cuts/encodes of the same episode |
| `duration` | What the player's timeline shows: `mediaDuration` when known, otherwise the TMDB runtime estimate (so it is never 0 for UI purposes) |
| `server`, `sourceIndex`, `sourceId` | The server id, the 1-based source index within it (what the servers menu labels *Source N*) and the combined `"<server>/<index>"` fingerprint. The same `sourceId` on every participant means the same upstream source |
| `sourceHash` | 8-hex FNV-1a of the exact stream URL. Only comparable between clients when the URL is identical (it usually is for a server/source pair) — treat `sourceId` + `mediaDuration` as the authoritative cut fingerprint |
| `audio`, `subtitle` | `{ id, lang, label }` of the active tracks, or `null` |

The `statechange` event is de-duplicated (one per transition), so a party host can drive its whole sync machine from `statechange` + `seeked` + `timeupdate` alone.

```js
// Minimal host-side wrapper
class LolEmbedPlayer {
  constructor(iframe, playerOrigin) {
    this.iframe = iframe; this.origin = playerOrigin; this.seq = 0; this.pending = new Map(); this.listeners = new Set();
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.origin !== this.origin || !m || m.source !== 'lol-embed-player') return;
      if (m.type === 'LOL_EMBED_PLAYER_RESPONSE' && this.pending.has(m.requestId)) { this.pending.get(m.requestId)(m); this.pending.delete(m.requestId); }
      if (m.type === 'LOL_EMBED_PLAYER_EVENT') this.listeners.forEach((fn) => fn(m.event, m));
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  send(command, args = {}) {
    const requestId = `${Date.now()}-${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.iframe.contentWindow.postMessage({ type: 'LOL_EMBED_PLAYER_COMMAND', command, requestId, ...args }, this.origin);
    });
  }
  play() { return this.send('play'); }
  pause() { return this.send('pause'); }
  seek(time) { return this.send('seek', { time }); }
  async getTime() { return (await this.send('getTime')).currentTime; }
  async getDuration() { const s = await this.send('getDuration'); return s.mediaDuration ?? s.duration; }
}
```

Legacy shapes are still accepted so existing hosts keep working: a bare `{ command: "play" | "pause" | "seek" | "setVolume" | "nextEpisode", … }`, `{ type: "VIDBOLT_PLAY" | "VIDBOLT_PAUSE" }`, and `{ type: "SCREENSCAPE_GET_WATCH_HISTORY_WITH_PROGRESS" }` (answered with the stored progress entries). The player's own events are never interpreted as commands.

> Easter egg: a human opening the Worker **root URL** in a browser gets rickrolled. API clients keep receiving the JSON service descriptor at `/` unchanged (the redirect is only served when the request advertises `Accept: text/html`).

## Configuring the API Worker URL

The player and the API may run on different Workers (or the API on a Node deployment). The player's API base URL is resolved in this order:

1. **`?api=` query parameter** on the embed URL — per-request override:
   `/embed?type=tv&tmdb=94605&s=1&e=1&api=https://api.lol-embed.example`
2. **`API_BASE_URL` Worker var** — set in `wrangler.toml` under `[vars]` or in the Cloudflare dashboard (Settings → Variables and secrets). The Worker injects it into the player page at request time:
   ```toml
   [vars]
   API_BASE_URL = "https://api.lol-embed.example"
   ```
3. **Empty/unset** — the player calls its own origin (player and API on one Worker).

The value must be an absolute `http(s)` URL (a path prefix is allowed and trailing slashes are stripped). Never hardcode `localhost` in deployment configuration. The player prefixes all `/api/*` calls with the configured base and re-resolves API-relative URLs (`/api/proxy?...`, subtitle proxy URLs, etc.) returned by `/api/resolve` against it, so cross-origin playback works. The API endpoints send permissive CORS headers; the API deployment does not need to serve any HTML.

## Backend surface

- `GET /` — JSON service information; no HTML landing page (browsers get the rickroll).
- `GET /embed` — the embeddable player page (Worker only; the Node API runtime stays JSON-only).
- `GET /docs` (alias `/documentation`) — public documentation page (Worker only; see *Documentation page*).
- `GET /reze` — owner dashboard shell (Worker only; every number on it comes from `/api/admin/stats`, see *Owner dashboard*).
- `GET /meta-image.gif` — the LOL Embed social/meta image.
- `GET /api/health` — service, runtime, and upstream health summary.
- `GET /api/servers` — public, cacheable list of the player-visible servers (`id`, `name`, `badge`, `priority`); the ids are what `?server=` accepts. Never carries upstream/provider names.
- `GET /api/catalog` — small sample catalog for API clients and smoke tests.
- `POST /api/handshake` — short-lived request token.
- `GET /api/info/:type/:tmdbId` — TMDB metadata and skip segments.
- `GET /api/segments/:type/:tmdbId` — intro, recap, and credits timestamps (see *Skip segments*).
- `GET /api/subtitles/:type/:tmdbId` — external subtitle tracks (see *Subtitles*).
- `GET /api/subtitles/proxy?url=…&enc=…&lang=…` — fetches one subtitle file from an allowed subtitle host (gzip/zip unpacked, charset detected) and returns WebVTT.
- `GET /api/resolve/:type/:tmdbId` — resolves a source and returns stream, audio, subtitle, and segment metadata. Rate-limited, and the body is whitelist-filtered (see *Security model*). Add `?detail=1` **with** `X-Admin-Key` for the unfiltered owner view (`rawUrl`, `sourceName`, `diag`, upstream traces).
- `GET /api/proxy?url=…&exp=…&sig=…` — HLS/MP4 stream proxy. **Signed URLs only**: it serves URLs this service issued via `/api/resolve`, never an arbitrary `?url=`.
- `GET /api/multitrack/master.m3u8` and `/api/multitrack/file/:jobId/:filename` — signed Node-side audio-remux output.
- `/api/admin/*` — owner operations, all requiring `X-Admin-Key` (or `Authorization: Bearer`; the `?key=` query form was removed because query strings leak into access logs, `Referer` headers and browser history): `GET /api/admin/stats` (dashboard feed), `POST /api/admin/stats/reset`, `POST /api/admin/domains/block` (`{ domain, blocked }`), `GET`/`POST /api/admin/domains/ad-free` (`{ domain, adFree }`, player Worker), `GET /api/admin/overview`, `POST /api/admin/probe`, plus upstream configuration and source overrides. The `/reze` page is the UI for these.

Supported media types are `movie`, `tv`, and `series` where applicable. TV requests accept `season` and `episode` query parameters. Ids are TMDB ids; IMDb ids (`tt…`) are accepted everywhere a TMDB id is and translated once through TMDB's `/find` endpoint (cached for a day) — the responses and the host API always report the TMDB id.

### Documentation page

`/docs` (and `/documentation`) is a self-contained page (`public/docs.html`, inline CSS/JS, no extra asset routes) written for people who embed the player — the same kind of reference the big embed services publish: endpoints for movies and TV with required/optional parameters and examples, implementation snippets (plain iframe, responsive wrapper, React), the customization parameters, the host events, the postMessage commands, an **embed builder** that generates a URL + iframe code and previews it on demand, a live status strip (`/api/health` + `/api/servers`) and an FAQ. Everything host-specific is filled in at runtime from `location.origin` and the injected config (`apiBaseUrl`, the server catalog), so the page is correct on any domain without editing. It deliberately documents only the player surface: `/api/resolve` and the upstream providers are never mentioned.

### Owner dashboard (`/reze`) and usage statistics

`/reze` is the operator's page (`public/reze.html`): a dark dashboard with **Most requested titles**, **Most failing titles**, **Who is using the API (sites)**, **Countries**, per-server health (success rate, latency, last error, a *Probe now* button), **Requests per day**, the latest failures (title, server, reason, site, country), **blocked sites**, and an **Ad-free sites** list. The ad controls can turn the popunder off for a tracked site or any manually entered domain; sites can be removed from the exception list to restore ads. The shell is public but anonymous — it holds no numbers and no key; it asks for the admin key (`ADMIN_SECRET`), keeps it in `sessionStorage` and calls the key-protected admin API. `/reze?key=…` signs in and strips the key from the URL. The page is served with `X-Robots-Tag: noindex` and `X-Frame-Options: DENY`.

What is counted, and where:

- **Events.** `embed` (player page load), `resolve` (successful stream resolve), `resolve_error` (failed one, with the upstream reason), `proxy` (segment/manifest hit, totals only) and `server_attempt` (per-server success/failure/latency). A site is the host page's domain (`?parent=`, `Origin` or `Referer` of the request; the Worker host itself and direct opens are never listed as a site). Countries come from `request.cf.country` (`CF-IPCountry`). TV episodes roll up into their show.
- **Storage.** On the Worker, counters and owner settings live in **one SQLite-backed Durable Object** (`STATS` binding, class `StatsStore`, declared in `wrangler.toml` with a `new_sqlite_classes` migration), so they are global across Cloudflare's edge and survive isolate recycling. Requests enqueue events in isolate memory and ship them to the object in the background (`ctx.waitUntil`); embed/resolve outcomes flush immediately, proxy hits in batches of 50 / 30 s. The object applies events in memory and writes only the rows that changed, ten seconds after a burst (one alarm), which keeps row writes far below the free plan's allowance. Works on the Workers Free plan; nothing to create by hand — `wrangler deploy` applies the migration. Without the binding (or if the object is unreachable) counters and settings fall back to isolate memory and the dashboard badge says *In-memory (per isolate)* instead of *Durable storage*. The Node backend keeps its counters in process memory (*Process memory*).
- **Blocking and ads.** Blocked domains are persisted in the same object (cached per isolate for a minute). A blocked site gets a 403 page instead of the player and a 403 from `/api/resolve`; the dashboard offers *Unblock*. Per-site ad-free domains are stored there too: `/embed` removes the marked ad block when the host page's domain matches, with `www.` normalized away; a global `ADS_ENABLED=false` still disables ads for everyone. A reset of statistics preserves both the block-list and ad-free settings.
- **Shape.** `GET /api/admin/stats?limit=25` → `{ ok, stats: { persistent, storage, startedAt, totals, topTitles[], failingTitles[], domains[], countries[], servers[], days[], errors[], blockedDomains[] }, catalog[], servers[], runtime }`. The same `stats` block is included in `GET /api/admin/overview`. On the player Worker, `GET /api/admin/domains/ad-free` returns `{ ok, adFreeDomains[], adsEnabled }`; `POST` accepts `{ domain, adFree }`. Per-site settings can also be managed from the **Ad-free sites** card in `/reze`. The statistics aggregation model is shared (`src/services/statsAggregate.js`) between the Worker, the Durable Object and the Node backend.
- **Dev.** `node scripts/dev-player-mock.mjs` serves `/docs` and `/reze?key=admin123` with seeded demo statistics.

### Skip segments

`/api/info`, `/api/segments`, and `/api/resolve` return a `segments` array of `{ type, label, start, end, source }` with `type` one of `intro`, `recap`, `outro` (credits), or `preview`, times in seconds, and `end: null` meaning "until the end of the file". Both the Node backend and the Worker resolve them through the shared `src/services/skipSegments.js` parsers from three community databases, queried in parallel and merged (earlier sources win overlapping entries, `post_credits` scenes are never offered as a skip):

| Source | Keyed by | Covers | Config |
| --- | --- | --- | --- |
| [TheIntroDB](https://theintrodb.org) v3 | TMDB id (+ season/episode) | intro, recap, credits, preview — movies and TV | `THEINTRODB_URL`, optional `THEINTRODB_API_KEY` (raises the 500/day per-IP quota to 1000) |
| [IntroDB](https://introdb.app) | IMDb id bridged from TMDB | intro, recap, outro — movies (`is_movie=true`) and TV | `INTRODB_URL` |
| [AniSkip](https://api.aniskip.com) v2 | MyAnimeList id bridged via Jikan | op/ed/mixed/recap for anime | `ANISKIP_URL` |

Results are cached for six hours; confirmed "no data" answers for fifteen minutes; provider outages for one minute only. No keys are required.

### Subtitles

`/api/subtitles` and `/api/resolve` return `subtitles: [{ id, lang, label, format: 'vtt', url, default, source }]` — real upstream files only, one plain track (plus at most one `[CC]` track) per language, English first and flagged `default`. Both runtimes share `src/services/subtitleSources.js` and query the sources in parallel:

| Source | Keyed by | Key | Config |
| --- | --- | --- | --- |
| OpenSubtitles through Stremio's official **v3 addon** (`opensubtitles-v3.strem.io`) | IMDb id bridged from TMDB (+ season/episode) | none | `OPENSUBTITLES_STREMIO_URL` |
| [Wyzie Subs](https://docs.wyzie.io/subs) (aggregates OpenSubtitles.com, SubDL, Podnapisi, …) | TMDB id | free key from `store.wyzie.io/redeem` | `WYZIE_API_KEY`, `WYZIE_SUBS_URL` |
| [SubDL](https://subdl.com/api-doc) | TMDB id | free key from a SubDL account | `SUBDL_API_KEY`, `SUBDL_API_URL`, `SUBDL_DOWNLOAD_URL` |

> The legacy `rest.opensubtitles.org` API this project used to rely on was retired at the end of 2023; its download links now return a "become a VIP" notice instead of a subtitle, which is why subtitles silently stopped working. It is gone from both runtimes, and the proxy rejects such placeholder files (HTTP 502) instead of showing them as captions.

Every track URL points at `/api/subtitles/proxy`, which downloads the file server-side (CORS-free for the player), unwraps `.gz` and `.zip` archives (SubDL/Podnapisi style, the `.srt` inside is picked), decodes the charset (BOM → UTF-8 → the source's `enc` hint → a per-language legacy code page such as windows-1251/1256 → windows-1252) and converts SRT to WebVTT. The proxy only fetches from subtitle hosts (`strem.io`, `opensubtitles.*`, `wyzie.*`, `subdl.com`, `subsource.net`, `podnapisi.net`, `gestdown.info`) plus the hosts of the configured source URLs; add more with `SUBTITLE_PROXY_HOSTS=host1,host2` (`*` disables the check). Track lists are cached for an hour, empty answers for two minutes, files for two hours.

## Source resolution and audio behavior

The resolver supports the following server configurations. Names, badges and
priorities live in `src/services/serverCatalog.js`, which both backends (the
Node API and the Cloudflare Worker that serves `/embed`) import — so the player's
server modal can never drift from what the waterfall actually tries:

| Priority | Server id   | Player name           | Badge                                  | Cascade |
|----------|-------------|-----------------------|----------------------------------------|---------|
| 1        | `andromeda` | Fiber Optic Speedrun  | Multi-Audio • Primary                  | CastleTV → NetMirror |
| 2        | `centaurus` | Gigachad Node         | Adaptive • Multi-Quality               | HiCine |

Every `/api/resolve` payload carries the `servers` array in this exact order with
the answering server flagged `active`, and it is rebuilt from the live catalog on
every response — including cache hits — so a rebrand or re-prioritisation shows
up in the player immediately. Owner priority changes made through
`POST /api/admin/upstreams` feed the same array and the waterfall.

### Server 1 — Andromeda (Fiber Optic Speedrun) Multi-Tier Architecture

Server Andromeda uses a resilient two-tier cascade backed by automatic dynamic discovery:

1. **Priority 1: CastleTV (`api.hlowb.com`)**
   - **Coverage:** Extensive South Indian dubs (Tamil, Telugu, Malayalam, Kannada, Hindi), K-dramas, C-dramas, anime, and Hollywood multi-audio.
   - **Protocol:** AES-128-CBC encryption (`IV == key`), dynamically derived on-the-fly from `/v0.1/system/getSecurityKey/1`. Yields language-tagged master HLS playlists per dub track via `/film-api/v2.0.1/movie/getVideo2`.

2. **Priority 2: NetMirror Web-Mirror Pool (TMDB-id keyed)**
   - **Coverage:** Official OTT platform mirrors (Netflix, Prime Video, Disney+/Hotstar) with embedded multi-audio renditions. `GET /api/embed-tmdb/<tmdbId>` is keyed on the TMDB id (TV: `?type=tv&se=&ep=`), so identity is exact by construction.
   - **Mirror rotation:** `NETMIRROR_WEB_MIRRORS` (default `net27.cc`, `net52.cc`, `net77.cc`, `netmiror.com`) is walked in order until a mirror answers; the answering origin is remembered and used as the stream `Referer`.
   - **NewTV discovery is a fallback only:** the `checknewtv.php` network (`mobiledetect.app`, `mobidetect.cc`, ...) still resolves to an API base (e.g. `https://tv.imgcdn.kim`), but that base currently answers `403 Page Not Found` for `newtv/*` and `embed-tmdb`. The resolver tries it first and rotates mirrors when it fails.
   - **Alternate URLs kept as backups:** the embed payload's `fallbackHls` and `direct` links are returned in `backupUrls`, because NetMirror's primary CDN (`*.hakunaymatata.com`) rate-limits aggressively (`HTTP 429`) and its `?sign=` links are short-lived — a miss means re-resolve, not retry.
   - **Last live probe (2026-10-04, `diagnostics/netmirror-probe.json`):** `net27.cc` live (a TV title returned 4 streams + 13 subtitle languages; a movie not in their catalog returns `ok:true` + "couldn't find this title", treated as a miss), `net52.cc`/`net77.cc`/`netmiror.com` 404, and every CDN fetch from the CI runner was `429` regardless of Referer/Range/sign, so playback could not be confirmed from cloud IPs.
   - **Not yet wired:** NetMirror's `captions[]` (13 languages on the probed episode, sourced from Moviebox's library) are still ignored by `/api/subtitles`, which currently uses the sources listed under *Subtitles* (OpenSubtitles via Stremio v3, optional Wyzie/SubDL).

3. **Clean Waterfall Failover: Server 2 (Centaurus, HiCine)**
   - If both internal Andromeda tiers return no playable streams for a given title, Andromeda cleanly cascades to the next server in the shared priority waterfall.

### Server 2 — Centaurus (HiCine)

Centaurus resolves through HiCine (`api.hicine.sbs`), and it runs entirely
inside the Worker — no Node backend, no delegation:

| Source | Upstream | Flow | Output |
|--------|----------|------|--------|
| `hicine` | `api.hicine.sbs` | Search API → quality tokens → vCloud/Pixeldrain | Direct MP4/HLS |

HiCine publishes a small quality ladder per title and labels audio with
filename-only hints (Hindi by default; Tamil/Telugu/English/Japanese when
present). The ladder becomes the player's quality menu and the hints become the
honest default audio row — see Audio Behavior & Remuxing for how embedded MKV
tracks are handled (the Worker cannot remux them, so progressive fallback is
used).

Debug a title with the admin diagnostics endpoint:

```bash
curl -H "X-Admin-Key: $ADMIN_SECRET" "$API/api/admin/centaurus/diagnose/tv/94605?season=1&episode=1"
# → per-source {ok, ms, reason, diag, rawUrl, qualities}
```

The two Hindi-dub anime blogs (Anime Dub Hindi, AnimeDrive) that used to be
this server's sources 2 and 3 only worked on a Node backend — HTML extraction,
release-host unrolling and the ffmpeg remux did not fit the free-tier Worker —
and their release hosts are additionally unreachable from Cloudflare egress
(one is IP-banned, the other serves a Turnstile wall). They were removed on
2026-10-04; the research record (reachability, codec and season traps) is kept
in `docs/hamster-wheel-upstream-research.md`.

### Audio Behavior & Remuxing

Audio behavior is intentionally truthful:

- Upstream HLS audio renditions are exposed when they are actually switchable, and the player also adopts renditions it discovers in the parsed manifest — a single payload row hiding a multi-track HLS master still becomes a switchable menu.
- Switching is index-first (`audioIndex` from the remux payload) and only claims success when a rendition actually changed; if the stream is a single progressive file the player says so instead of showing a fake "Audio switched" toast.
- Quality rows are matched to HLS levels by resolution height (not array position), and CastleTV ladders are merged across every resolution rung, so the quality menu lists real 1080p/720p/480p entries instead of a lone "Auto". A remuxed file lists exactly one row at the file's native resolution.
- HiCine has filename-only language hints, not structured language URLs; progressive sources remain one honest default row rather than duplicate entries for the same file.
- Node deployments can use FFmpeg/FFprobe to remux embedded MKV/MP4 audio tracks into HLS. The video stream is copied; supported audio is copied and other audio is converted to AAC.
- Cloudflare Workers do not run FFmpeg. They retain upstream HLS rendition switching and use progressive fallback for embedded MKV tracks; the browser cannot select embedded tracks from progressive MKV.
- If remuxing is unavailable, unsafe for the source host, or fails, the resolver keeps the source's default audio and progressive fallback rather than claiming unsupported switching.

The generated Node multitrack package is cached locally (default two hours), starts serving once initial segments are ready, and is protected by HMAC-signed playlist and asset URLs (the signed master also carries the resolver's trust decision, so a provider-resolved file on a release CDN can be remuxed without opening the endpoint to arbitrary hosts). The built-in HTTPS source allowlist includes `r2.dev`, `cloudflarestorage.com`, `cloudfront.net`, `googleusercontent.com`, `workers.dev`, Pixeldrain, and the HubCloud/GDFlix release chains (`hubcloud.ist`, `hubdrive.pics`, `gdflix.dev`, `gdflix.io`, `busycdn.xyz`, `indexserver.site`). Add trusted suffixes with `MULTITRACK_ALLOWED_HOSTS`; do not allow untrusted hosts. Tune job count and cache limits with the `MULTITRACK_*` settings in `.env.example`.

Codec/device combinations such as HEVC/AV1 profiles, HDR/Dolby Vision, AC-3/E-AC-3, and progressive MKV may not work in every browser. Use a compatible source/server when necessary; the backend does not transcode video to conceal these limitations.

## Player UI harness (optional local/dev tooling)

`scripts/dev-player-mock.mjs` serves `public/` exactly like the Worker does but answers `/api/*` from an in-memory mock (a public HLS demo stream, fake episodes, segments and subtitles), so the player UI can be iterated on without TMDB keys or reachable upstreams:

```bash
node scripts/dev-player-mock.mjs
# http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1                   happy path
# http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1&server=centaurus  server 2 fails -> automatic failover
# http://localhost:8790/embed?type=movie&tmdb=0                            every server fails -> error screen with the server list inline
# http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1&t=1m30s&autoskip=1 start offset + auto-skip
# http://localhost:8790/host                                                host page: iframe + the postMessage control API (buttons, live state, event log)
```

`scripts/dev-worker.mjs` runs the real Worker code (`cloudflare-worker/worker.js`) against the live upstreams instead.

## Run the Node backend (optional local/dev tooling)

The Node server in this repository is **optional local/dev tooling only**. The
deployed product is the Cloudflare Worker, and every deployed source
(Andromeda, Centaurus/HiCine) resolves inside the Worker — nothing in
production requires, or is delegated to, a Node deployment.

```bash
npm ci
npm test
npm start
```

The server listens on `0.0.0.0:3000` by default and serves the JSON API only — the player page ships with the Cloudflare Worker. Copy `.env.example` to `.env` and configure deployment-specific values.

`ADMIN_SECRET` and `PROXY_SECRET` are **required**: with `NODE_ENV=production` the process refuses to start without them and prints the exact command to generate one. In any other environment it generates ephemeral secrets and logs that it did, so `npm run dev` and `npm test` work with no configuration — signed URLs simply will not survive a restart. `PROXY_SECRET` must match the Worker's, or URLs signed by one runtime are rejected by the other. The Docker image installs FFmpeg (including FFprobe); for non-Docker hosts, install both binaries on `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`. Multitrack remuxing can be disabled with `MULTITRACK_ENABLED=false`.

With Docker Compose:

```bash
docker compose up -d --build
```

## Deploy the Cloudflare Worker

`cloudflare-worker/worker.js` runs the player page, the backend API, the edge proxy, the documentation page and the owner dashboard. The `public/` directory contains the `/embed` player page with its CSS/JS/vendor assets, `docs.html`, `reze.html` and the social/meta GIF; nothing in it is served unless the Worker routes to it (`run_worker_first`), so `/docs.html`, `/reze.html` or `/index.html` stay 404.

```bash
npx wrangler login
npx wrangler deploy
```

`ADMIN_SECRET` and `PROXY_SECRET` are **mandatory** and are no longer present in `wrangler.toml` — set them as Cloudflare secrets before deploying:

```bash
npx wrangler secret put PROXY_SECRET   # signs every /api/proxy URL + multi-track master
npx wrangler secret put ADMIN_SECRET   # guards /api/admin/* and /api/debug/*; also the /reze key
# generate one with:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Both used to be committed in plaintext (`admin123` and a fixed HMAC key) *and* used as in-code fallbacks, so a deploy that forgot to override them was fully controllable by anyone who had read the repo. There are no fallbacks now: without usable secrets the Worker **fails closed** — `/api/proxy` and `/api/admin/*` return `503` with a `hint` field, rather than running unauthenticated. `PROXY_SECRET` must be **identical** on every runtime that signs or verifies proxy URLs (this Worker, any `EXTERNAL_PROXY_POOL` node, and the Node backend), otherwise URLs signed by one are rejected by the other. Local `wrangler dev` / `scripts/dev-worker.mjs` read `.dev.vars` (gitignored; see `.dev.vars.example`). If the API runs on a separate Worker or Node deployment, set `API_BASE_URL` to its absolute URL (see above). The statistics Durable Object is created by the `[[migrations]]` block on the first deploy; to run without it, delete the `[[durable_objects.bindings]]` and `[[migrations]]` blocks (counters then live in isolate memory only).

Branch pushes run `wrangler preview` via Workers Builds, using the preview-safe values in the `[previews.vars]` block of `wrangler.toml`; only merges to the production branch deploy the production configuration. `ADMIN_SECRET`/`PROXY_SECRET` are deliberately **absent** from `[previews.vars]`: a preview URL is publicly reachable, so committing a known preview secret would recreate the forgeable-signature hole on that deployment. Previews therefore fail closed for the proxy and admin routes while the player page, `/docs` and the `/reze` shell still render. Durable Object migrations are atomic and cannot be shipped by a preview/version upload, so the `v1` migration that creates the statistics object must land through a production `wrangler deploy` first (branch previews built before that fail with a migration error; afterwards they share the already-migrated class). If you ever rename `StatsStore`, add a new migration tag instead of editing `v1`.

### Ads

The `/embed` page carries one monetisation tag — a popunder script — at the end of `public/embed.html`, between `<!--LOL_EMBED_ADS-->` … `<!--/LOL_EMBED_ADS-->` markers:

```html
<script data-cfasync="false" src="https://4xfreedom.com/1/7bdb1e6b0498fdfa2a41c002db4e3a55"></script>
```

- It loads **after** `embed.js`, so a slow or blocked ad host never delays the player.
- `ADS_ENABLED = "false"` (Worker var; `"0"`/`"off"` work too) serves the page with the whole block stripped everywhere — use it for an ad-free deployment. The default is on; `[previews.vars]` turns it off for branch previews. The local harness mirrors this with `ADS=0 node scripts/dev-player-mock.mjs`.
- To exempt only some host websites while keeping ads on elsewhere, open `/reze` → **Ad-free sites**. Add a domain (or use *Turn ads off* beside a tracked site); remove it with *Enable ads*. The rule matches the exact host with `www.` ignored and is stored in the Worker's `STATS` Durable Object; a statistics reset does not remove it. Site detection uses the iframe request's `parent`, `Origin`, or `Referer`, so keep the browser's default referrer policy. In split player/API deployments, the dashboard sends these ad settings to the player Worker itself.
- To change networks, replace the tag and keep the markers.
- Popunders open a new window on the viewer's next click. A host page that puts the player in a `sandbox`ed iframe must include `allow-popups allow-popups-to-escape-sandbox`, otherwise the browser blocks them silently. `data-cfasync="false"` keeps Cloudflare Rocket Loader from deferring the tag.

## Security model

The controls below are enforced in **both** runtimes from shared CommonJS modules (`src/utils/proxySign.js`, `src/utils/rateLimit.js`, `src/services/publicPayload.js`), so a URL signed by one verifies on the other and a field filtered by one cannot leak from the other. Suite 14 of `npm test` asserts each of them.

### Secrets fail closed

`ADMIN_SECRET` and `PROXY_SECRET` have no fallback values. The previous defaults (`admin123` and a fixed HMAC key) were committed to this repository, so any deployment that inherited them was fully controllable by anyone who had read the source. Now:

- **Node** refuses to boot in production (`NODE_ENV=production`) when a secret is missing, shorter than 32 characters, or equal to a published sample. Outside production it generates an ephemeral secret and logs that it did.
- **Worker** answers `503` on `/api/proxy` and `/api/admin/*` when a secret is unusable, with a `hint` explaining the fix.
- Admin comparison is constant-time (`crypto.timingSafeEqual` over a SHA-256 digest, so length does not leak), and **failed** attempts are throttled per client. Successful attempts are not counted, so the `/reze` dashboard — which fires several admin calls per load — cannot lock the owner out.

### The stream proxy is not a relay

`/api/proxy` used to verify its signature *only when the caller supplied `exp` and `sig`*, which meant omitting them skipped verification entirely and exposed an unauthenticated open proxy with attacker-chosen `Referer`, `Origin` and `Cookie`. The Worker had **no** signature check at all, and also answered the same relay on a bare `/?url=…`.

- A signature is now **mandatory**; a missing or expired one is a rejection, never a bypass.
- The signature (v2) covers `url`, `referer`, `origin`, `cookie`, `mode`, `token` and `vidsrcStamp`. Those parameters were previously appended to the query string *after* signing, so anyone holding one legitimate signed URL — and every signed URL is visible in a viewer's network tab — could add `&cookie=…` and use the server as an authenticated request relay.
- Repeating any signed parameter is rejected with `400`. Express parses duplicate keys into an array while the Workers runtime reads the first value; that divergence is the classic HTTP-parameter-pollution setup for validating one value and acting on another.
- The root `/?url=…` alias is gone. `/` keeps its documented JSON behavior.
- **SSRF guard** (`inspectMediaTarget`): `http`/`https` only, no embedded credentials (which bypass `http://trusted@evil/` allowlists), and no loopback, link-local, private, CGNAT, multicast or reserved destination — so the proxy cannot be aimed at `169.254.169.254`, `127.0.0.1:6379`, `*.internal` or the Docker socket on a single-machine box.
- Redirects are followed **by hand** and every hop is re-validated. `redirect: 'follow'` alone would let an allowlisted public host bounce the request to an internal address.
- `PROXY_ALLOW_PRIVATE_TARGETS` relaxes the guard for local dev and the hermetic test suite. It is **ignored** when `NODE_ENV=production`, and logs an error when enabled on the Worker.

### Public payloads are whitelist-filtered

`/api/resolve` used to return the resolver's whole working set to every anonymous caller: `rawUrl` (the direct provider CDN link), `sourceName`/`provider`, `upstreamId`, `centaurusSources`, and a `diag` object of per-step upstream traces. The player renders none of it — `public/js/embed.js` only ever *normalised* `rawUrl` and never played it — so it was disclosure without function. The UI comment claiming provider names "never reach the viewer" described rendering, not the response body.

Filtering is a **whitelist** (`src/services/publicPayload.js`), not a blacklist: new internal fields are dropped until someone deliberately publishes them. Failure reasons are also downgraded to provider-neutral categories, because the raw codes name upstream machinery (`meow_403` is VidStuck's handshake endpoint, `centaurus_no_source` names a source). Owners get everything back with `?detail=1` plus `X-Admin-Key`; internal errors are logged server-side instead of echoing `err.message`.

`GET /api/debug/andromeda/:type/:tmdbId` was **unauthenticated on the Worker** while the Node equivalent required the admin key. It returned the live upstream base URLs and the resolver's complete raw output — the entire provider map for a guessed path. It is owner-only on both runtimes now.

**Still public by design:** for the Centaurus (HiCine) server the playable `streamUrl` is the provider's direct CDN URL rather than a proxied one ("Root Cause D: direct CDN playback … for regions where the Worker itself is the bottleneck"). That is a bandwidth/architecture decision in the resolver, not a filtering oversight, so the sanitizer preserves `streamUrl` exactly as resolved. Routing Centaurus through the proxy would reverse that decision — see *Open items*.

### Rate limits

TMDB ids are sequential integers, so `/api/resolve` is enumerable by a bare `for` loop. It stays public — this is an embed API — but it is throttled: `resolve` 30/min, `proxy` 600/min, `metadata` 120/min, `handshake` 30/min, failed admin auth 10/min. Responses carry `RateLimit-Limit`/`-Remaining`/`-Reset` and `Retry-After`, which are CORS-exposed so a player can back off intelligibly. Knobs are in `.env.example`.

Client identity comes from **unforgeable sources only**: `cf-connecting-ip`, and otherwise the socket peer address. `X-Forwarded-For`, `X-Real-IP` and Express's `req.ip` are ignored, because all three derive from client-supplied headers — with `trust proxy` pinned to a hop count and no real proxy in front, Express still takes `req.ip` from the caller's own XFF, so rotating that header bought a fresh bucket on every request. That bypass was found and fixed while building this. `cf-connecting-ip` itself is only trusted when the TCP peer verifies against Cloudflare's published edge ranges (`isCloudflarePeer`); a directly exposed Node process ignores a forged copy and falls back to the socket address. Stale ranges degrade safely to the coarser socket identity, never to a bypass.

Limits are per process (Node) or per isolate (Worker) — free, no latency, no storage, and enough to stop naive enumeration cold. They are **not** a global quota. For one, back `src/utils/rateLimit.js` with the existing `STATS` Durable Object. `RATE_LIMIT_TRUST_FORWARDED_HEADERS=true` is the opt-in for a non-Cloudflare proxy that rewrites XFF; enabling it without such a proxy re-opens the bypass above.

### Headers and proxy trust

`helmet` was a declared dependency that was never `require`d, so no security headers were applied. It is now wired up with two deliberate overrides: `crossOriginResourcePolicy: cross-origin` (proxied segments must be readable by a player on another origin, or every embed breaks) and `contentSecurityPolicy: false` (this runtime serves JSON and media, no HTML). `X-Powered-By` is disabled.

`app.set('trust proxy', true)` trusted the **leftmost** X-Forwarded-For entry — the client-supplied one. It is pinned to `TRUST_PROXY_HOPS` (default `1`; use `2` for CF → nginx → node).

### What is still not authentication

`Access-Control-Allow-Origin: *` is a product decision (any site may embed), not a control. The site **block list** is cosmetic: `telemetry.extractDomain` reads `?parent=`, `?domain=`, `?embed_domain=`, `x-embed-domain`, then `Origin`/`Referer` — all client-controlled, so a blocked site simply omits the parameter and a scraper sends nothing. Treat it as attribution for the dashboard, not as access control.

### Open items

- **Centaurus direct playback.** Closing the last raw-URL exposure means routing Centaurus media through the proxy, which reverses the Root Cause D bandwidth decision. Worth a per-deployment switch rather than a silent change.
- **Client auth / sessions.** There is still no notion of an authorized client. A signed handshake exists (`POST /api/handshake`) but nothing requires it, so `/api/resolve` remains anonymous-by-design and rate-limited rather than authenticated.
- **Global rate limits.** Per-isolate counters understate a distributed crawler.
- **DNS rebinding.** The SSRF guard validates hostnames and IP literals synchronously and does no DNS lookup, so a public hostname resolving to a private address is not caught at the guard. Redirect hops *are* re-validated; closing this fully needs DNS pinning on the resolved address.
- **TMDB key.** The shared v3 key in `src/config.js` / `wrangler.toml` is free-tier and semi-public by nature, but a scraper walking the catalog burns *your* TMDB quota, and TMDB throttling then degrades resolution for everyone. Set your own `TMDB_API_KEY`.
