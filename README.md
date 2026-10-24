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
| `server`   | Preferred upstream server: `goldmine` (a stale/removed id falls back to the top-priority server) |
| `source`   | Optional pin to one source (provider) of a server: `server=goldmine&source=<provider-id>` (pinned requests do not fall through to other sources) |
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
- `GET /api/resolve/:type/:tmdbId` — resolves a source and returns stream, audio, subtitle, and segment metadata.
- `GET /api/proxy?url=...` — HLS/MP4 stream proxy. Forwards `Range`/`206`;
  retries a rejected request once without the `Referer`/`Origin` (hotlink
  filters) and once without the `Range` (whole-file-only hosts); answers
  **502** when the upstream returns an HTML/JSON page instead of media, so a
  gate page can never masquerade as a decode failure in the player.
- `/api/admin/*` — owner operations, all requiring `X-Admin-Key` (or `?key=`): `GET /api/admin/stats` (dashboard feed), `POST /api/admin/stats/reset`, `POST /api/admin/domains/block` (`{ domain, blocked }`), `GET`/`POST /api/admin/domains/ad-free` (`{ domain, adFree }`, player Worker), `GET /api/admin/overview`, `POST /api/admin/probe`, `GET /api/admin/goldmine/diagnose/:type/:tmdbId`, plus upstream configuration and source overrides. The `/reze` page is the UI for these.

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

Names, badges and priorities live in `src/services/serverCatalog.js`, which both
backends (the Node API and the Cloudflare Worker that serves `/embed`) import —
so the player's server modal can never drift from what the waterfall actually
tries:

| Priority | Server id  | Player name  | Badge                  | Cascade                                |
|----------|------------|--------------|------------------------|----------------------------------------|
| 1        | `goldmine` | Goldmine | HLS • DASH • Multi-Audio | Owner-hosted TMDB-Embed-API instance    |

The lineup is single-server and the browser accepts only HLS or DASH. Native
multi-audio HLS/DASH is ideal; multi-audio progressive sources become converter
input ahead of single-audio streams. On a Node host with ffmpeg they become HLS
with genuine quality/audio renditions. Where conversion is unavailable, those
candidates are skipped. A ready source settles quickly instead of waiting for
slow mirrors. The catalog machinery stays generic, so adding a second server
later is a one-entry change.

Every `/api/resolve` payload carries the `servers` array in this exact order with
the answering server flagged `active`, and it is rebuilt from the live catalog on
every response — including cache hits — so a rebrand or re-prioritisation shows
up in the player immediately. Owner priority changes made through
`POST /api/admin/upstreams` feed the same array and the waterfall.

### Server — Goldmine (TMDB-Embed-API aggregation)

Goldmine resolves through the owner-hosted
[TMDB-Embed-API](https://github.com/themithology/TMDB-Embed-API) instance
(`GOLDMINE_API_BASE`, defaulting to its Render deployment). One JSON call fans
out to every provider enabled on that instance:

```
GET {GOLDMINE_API_BASE}/api/streams/{movie|series}/{tmdbId}[?season=&episode=]
→ { success, tmdbId, imdbId, count, providerTimings,
    streams: [ { name, title, url, quality, provider, headers?, subtitles? } ] }
```

The shared resolver (`src/services/goldmine.js`, imported by **both** runtimes)
then:

- **Normalises** each row — quality labels to heights, containers from the URL,
  provider display labels from the upstream's `/api/providers` catalog.
- **Parses dub languages** from `name`, `title` and filename tags
  (`… Hindi+Tamil Multi Audio …`, `…WEB-DL.HIN.DUB.x264…`) via the shared
  language helpers (`src/services/languages.js`). URLs are stripped before
  scanning, so CDN host names can never masquerade as language hints.
- **Deduplicates mirrors** — same-height alternates of the best pick become
  `backupUrls` instead of fake quality variants, while every row of the payload
  becomes the player's Source 1…N list. Native HLS quality/audio menus are then
  populated from the actual manifest by hls.js; no server-side probe is added
  to the normal startup path.
- **Wraps header-gated files** — providers that demand a `Referer` /
  `User-Agent` (headers browsers refuse to send) route through the signed
  `/api/proxy?url=…` with server-side headers, CORS and Range support.
  `GOLDMINE_PROXY_STREAMS=false` disables the wrapping; URLs the upstream
  instance already proxied itself always pass through untouched.
- **Uses streaming playback only** — HLS goes through hls.js (or native HLS on
  supported Apple browsers), and DASH goes through dash.js. Progressive files
  are never attached to a browser media element: a Node host converts them to
  HLS, while a host without conversion skips them and tries another streaming
  source.
- **Pins one source manually** — `?source=<provider-id>` filters the aggregate
  to a single provider (a pinned request never falls through to the others).

Failure reasons map 1:1 onto the API error contract (`goldmine_timeout`,
`goldmine_unreachable`, `goldmine_http_error`, `goldmine_bad_response`,
`goldmine_no_streams`, `goldmine_source_empty`, `goldmine_source_disabled`,
`goldmine_source_unknown`) and surface verbatim on the player's error screen.
The Worker wraps resolution in a small circuit breaker so a cold-starting
free-tier instance cannot stall every request for the full timeout, and
resolution results are cached per title (a re-resolve, not a retry, is the
answer to a dead CDN link) — which is why the player's **Retry** button and any
manual server pick send `?fresh=1` (`?nocache=1` is accepted too) to skip the
cache read: provider links are signed and short-lived, so replaying a
15-minute-old payload only reproduces the same failure.

Owner surface:

```bash
# Per-title, per-provider diagnostic (what every provider answered, languages, qualities)
curl "$API/api/admin/goldmine/diagnose/tv/94605?season=1&episode=1&key=$ADMIN_SECRET"

# Hot-swap the upstream instance / re-prioritise / disable — live, no redeploy
curl -X POST "$API/api/admin/upstreams" -H "X-Admin-Key: $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"upstreams":{"goldmineBase":"https://my-instance.example"},"servers":[{"id":"goldmine","priority":1,"enabled":true}]}'
```

> **Owner note:** the upstream instance's biggest multi-dub provider only works
> when its `FEBBOX_COOKIES` env var is set on the Render service; without it,
> those rows simply never appear in `/api/streams` answers. The instance's own
> `/api/config` endpoint is public — keep the TMDB key it exposes rotated or
> lock the endpoint down.

### Audio behavior & MKV playback

Goldmine's direct MKV/MP4 files play through the bundled
[movi-player](https://github.com/MrUjjwalG/movi-player) engine
(`public/vendor/movi/element.js` — FFmpeg WASM demux + software/WebCodecs
decode, self-contained, no COOP/COEP needed). That is what makes **multi-audio
MKV in the browser** possible:

- **One-click dubs:** `/api/resolve` reports the dub languages parsed from the
  picked files up front (`languages` with counts, plus `audioTracks` for the
  selected file), and the player renders them as language rows. Picking one
  calls the engine's `selectAudioLang()` — the track switches inside the same
  file, without re-resolving and without losing the position.
- **Truthful tracks:** once the file is loaded the engine's `getAudioLangs()`
  is the source of truth; parsed-but-absent hints are never offered as
  switchable, and a single-audio file gets one honest row instead of fake
  duplicates.
- **HLS stays native:** aggregated HLS sources still play through hls.js with
  rendition switching and manifest-discovered audio rows.
- **Quality:** HLS menus are rebuilt from the actual levels hls.js discovers,
  with exact level indexes and an Auto/ABR row. Progressive files retain the
  real resolver-supplied alternatives rather than stale HLS choices.
- **Subtitles:** external `/api/subtitles` tracks remain selectable. Generated
  HLS carries the source's real video/audio renditions; embedded progressive
  subtitle tracks are not advertised as converted renditions.

Codec/device combinations (HEVC/AV1 profiles, HDR/Dolby Vision, AC-3/E-AC-3)
may still not play in every browser. The default Worker path does not conceal
those limits with a server transcode; a suitable Node host can opt in below.

### Node HLS conversion for progressive fallbacks

Native multi-audio HLS/DASH never needs this converter. The Codespace enables
conversion for progressive fallbacks. Compatible H.264/AAC video/audio is
remuxed, and the source-quality remux runs independently from the lower-rung
encode so it can expose a complete VOD without waiting for that encode.
Incompatible codecs and the additional quality rung still require real encoding.

Cloudflare Workers cannot spawn ffmpeg. `scripts/dev-worker.mjs` therefore
exposes `/api/mkv-hls` **only when `MKV_HLS_ENABLED=true` is set on that Node
process**. Do not set this in `wrangler.toml` and expect Cloudflare to convert
media: an ordinary Worker page advertises `mkvHlsEnabled=false` and skips
progressive candidates rather than playing them raw.

On an enabled Node host, an eligible progressive source goes **directly** to
the converter. ffmpeg reads the original same-origin `/api/proxy` source and
the browser receives only HLS. ffprobe discovers the actual streams before
ffmpeg writes H.264/AAC HLS with:

- up to two genuine video variants no higher than the source (1080p/720p for
  a 1080p source, 720p/480p for a 720p source, and no cosmetic upscaling);
- the source's real audio streams as selectable HLS renditions (up to eight),
  shared by the video rungs instead of encoded again for each rung;
- independent remux/encode playlists, with 2-second segments on encoded rungs
  and the source's real keyframe boundaries on remuxed video.

Playback never waits for a complete remux or a fixed buffer target. The first
usable segments start playback while the source-quality remux continues toward
a complete VOD in background. A browser-safe info handshake supplies ffprobe's
real full duration for the timeline and intro/outro markers while media grows.
The lower encode does not block startup. Scrubbing outside the current
seekable range requests an on-demand HLS window at that source timestamp. Its
first usable segments start playback while conversion continues from there;
the player maps the window's relative media time back to absolute source time
for the timeline, subtitles, skip markers and saved progress. Temporary output
is deleted when a session expires or the host stops.
`MKV_HLS_MAX_SESSIONS`
(default `2`) bounds concurrent sessions, and renewed signed URLs for the same
canonical source share one conversion. `MKV_HLS_DIR` overrides the temporary
output directory. `npm test` includes a fully local, real ffmpeg integration
test covering variant ladders, dual audio, codecs, segments and source-host
validation.

### 3× generation/delivery benchmark

`npm run benchmark:hls` creates a local 60-second dual-audio source, converts it
through the real handler, downloads the actual HLS segments against a 3×
playback clock, and reports startup time, full-timeline status, late segments
and buffer measurements. It uses no public provider or downloaded test video.
Set `BENCHMARK_SECONDS` or `BENCHMARK_RATE` to change the workload.

## Live provider test in GitHub Codespaces

For a real upstream/MKV/HLS test without Render, Cloudflare media egress, or mocked fixtures, open this branch in **GitHub Codespaces**. The included devcontainer installs TMDB-Embed-API, starts it on private loopback, and serves the real Worker player + API on forwarded port `3000`. The port remains private to your GitHub session.

Use **Code → Codespaces → Create codespace on this branch**, wait for setup, then open the forwarded URL at `/embed?type=movie&tmdb=693134`. Provider extraction and media requests originate from the Codespace. This is a temporary development test, not a production host or evidence that live playback has passed.

See [`.devcontainer/README.md`](.devcontainer/README.md) for TV examples, provider settings, logs, and the browser verification checklist.

## Player UI harness (optional local/dev tooling)

`scripts/dev-player-mock.mjs` serves `public/` exactly like the Worker does and mounts the **real backend** (`src/server.js`) behind it — `/api/resolve`, the waterfall, the Goldmine resolver, `/api/proxy` and the telemetry all run as in production — but points the upstream configuration at built-in mocks (a tiny TMDB stand-in, a TMDB-Embed-API stand-in answering provider-shaped JSON, skip-segment fixtures) plus a fixture CDN on port 8791 serving small real multi-audio MKV/MP4 files and a VTT (generated on first start, gitignored), so no internet or keys are needed:

```bash
npm run dev:player
# http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1            Goldmine HLS/DASH playback, dub-language chips, skip segments
# http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1&lang=ta    Tamil preselected
# http://localhost:8790/embed?type=tv&tmdb=94605&s=1&e=1&t=1m30s&autoskip=1 start offset + auto-skip
# http://localhost:8790/embed?type=movie&tmdb=0                     every source empty -> error screen with the server list inline
# http://localhost:8790/host                                        host page: iframe + the postMessage control API (buttons, live state, event log)
# http://localhost:8790/reze?key=admin123                           owner dashboard against the real backend
# ADS=1 npm run dev:player                                          serve the popunder ad tag too (stripped by default)
```

`scripts/dev-worker.mjs` runs the real Worker code (`cloudflare-worker/worker.js`) against the live upstreams instead.

## Run the Node backend (optional local/dev tooling)

The Node server in this repository is **optional local/dev tooling only**. The
deployed product is the Cloudflare Worker, and every deployed server
(Goldmine) resolves inside the Worker through the same shared services —
nothing in production requires, or is delegated to, a Node deployment.

```bash
npm ci
npm test
npm start
```

The server listens on `0.0.0.0:3000` by default and serves the JSON API only — the player page ships with the Cloudflare Worker. Copy `.env.example` to `.env` and configure deployment-specific values (`GOLDMINE_API_BASE`, secrets, optional subtitle keys).

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

Configure production secrets and variables in Cloudflare Worker settings. Set a strong `ADMIN_SECRET` (it is also the `/reze` dashboard key) and `PROXY_SECRET` before deployment; do not use the sample values in `wrangler.toml` for a public service. `GOLDMINE_API_BASE` points the resolver at your TMDB-Embed-API instance (the `wrangler.toml` default is the owner's Render deployment); `GOLDMINE_TIMEOUT_MS` should stay generous while that instance is on a free tier (cold starts). If the API runs on a separate Worker or Node deployment, set `API_BASE_URL` to its absolute URL (see above). The statistics Durable Object is created by the `[[migrations]]` block on the first deploy; to run without it, delete the `[[durable_objects.bindings]]` and `[[migrations]]` blocks (counters then live in isolate memory only).

Branch pushes run `wrangler preview` via Workers Builds, using the preview-safe values in the `[previews]` block of `wrangler.toml`; only merges to the production branch deploy the production configuration. Durable Object migrations are atomic and cannot be shipped by a preview/version upload, so the `v1` migration that creates the statistics object must land through a production `wrangler deploy` first (branch previews built before that fail with a migration error; afterwards they share the already-migrated class). If you ever rename `StatsStore`, add a new migration tag instead of editing `v1`.

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

## Security status

The restored player page does **not** make source responses private or scraper-proof. The resolver API can still return source/proxy data, and permissive CORS is not authentication. Before the public main site launches, add an explicit client-auth/session design, short-lived signed access, rate limits, and a policy for avoiding raw upstream URLs in client responses. Do not treat CORS, iframe controls, or obscurity as source protection. These controls are intentionally not implemented in this change.
