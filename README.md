# LOL Embed — Player Worker & Backend

LOL Embed is the **player Worker**: it serves the embeddable player page at exactly `/embed` and the JSON/stream backend API (TMDB metadata, source resolution, edge stream proxy). The main frontend website is a **separate project** and embeds this Worker with an iframe; it is intentionally not built in this repository. The old landing/developer portal, demo page, and admin dashboard UI remain removed — `/` is a JSON service descriptor, not a website.

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
| `api`      | Absolute API base URL override (see below)                               |
| `lang`     | Preferred audio language (e.g. `hi`, `en`, `ta`)                         |
| `sub`      | Preferred subtitle language (e.g. `en`)                                  |
| `color`    | Optional accent override (e.g. `e50914`); default styling is monochrome  |
| `branding` | Player branding text (defaults to `LOL Embed`)                           |
| `back`     | `false`/`0` hides the back button                                        |

All of these routes serve the same player page; once loaded, the player rewrites only the query string when the episode changes, so no additional routes are needed on the player Worker.

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

- `GET /` — JSON service information; no HTML landing page.
- `GET /embed` — the embeddable player page (Worker only; the Node API runtime stays JSON-only).
- `GET /meta-image.gif` — the LOL Embed social/meta image.
- `GET /api/health` — service, runtime, and upstream health summary.
- `GET /api/catalog` — small sample catalog for API clients and smoke tests.
- `POST /api/handshake` — short-lived request token.
- `GET /api/info/:type/:tmdbId` — TMDB metadata and skip segments.
- `GET /api/segments/:type/:tmdbId` — intro, recap, and outro timestamps.
- `GET /api/subtitles/:type/:tmdbId` — external subtitle tracks.
- `GET /api/resolve/:type/:tmdbId` — resolves a source and returns stream, audio, subtitle, and segment metadata.
- `GET /api/proxy?url=...` — HLS/MP4 stream proxy.
- `GET /api/multitrack/master.m3u8` and `/api/multitrack/file/:jobId/:filename` — signed Node-side audio-remux output.
- `/api/admin/*` — JSON-only owner operations for health probes, domain blocks, upstream configuration, and source overrides; requires `X-Admin-Key`. There is no admin web UI.

Supported media types are `movie`, `tv`, and `series` where applicable. TV requests accept `season` and `episode` query parameters.

## Source resolution and audio behavior

The resolver supports the following server configurations. Names, badges and
priorities live in `src/services/serverCatalog.js`, which both backends (the
Node API and the Cloudflare Worker that serves `/embed`) import — so the player's
server modal can never drift from what the waterfall actually tries:

| Priority | Server id   | Player name           | Badge                                  | Cascade |
|----------|-------------|-----------------------|----------------------------------------|---------|
| 1        | `andromeda` | Fiber Optic Speedrun  | Multi-Audio • Primary                  | CastleTV → NetMirror |
| 2        | `centaurus` | Gigachad Node         | Adaptive • Multi-Quality               | HiCine Direct MP4 |

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
   - **Not yet wired:** NetMirror's `captions[]` (13 languages on the probed episode, sourced from Moviebox's library) are still ignored by `/api/subtitles`, which currently uses OpenSubtitles/Wyzie only.

3. **Clean Waterfall Failover: Server 2 (Centaurus, HiCine)**
   - If both internal Andromeda tiers return no playable streams for a given title, Andromeda cleanly cascades to the next server in the shared priority waterfall.

### Audio Behavior & Remuxing

Audio behavior is intentionally truthful:

- Upstream HLS audio renditions are exposed when they are actually switchable.
- HiCine has filename-only language hints, not structured language URLs; progressive sources remain one honest default row rather than duplicate entries for the same file.
- Node deployments can use FFmpeg/FFprobe to remux embedded MKV/MP4 audio tracks into HLS. The video stream is copied; supported audio is copied and other audio is converted to AAC.
- Cloudflare Workers do not run FFmpeg. They retain upstream HLS rendition switching and use progressive fallback for embedded MKV tracks; the browser cannot select embedded tracks from progressive MKV.
- If remuxing is unavailable, unsafe for the source host, or fails, the resolver keeps the source's default audio and progressive fallback rather than claiming unsupported switching.

The generated Node multitrack package is cached locally (default two hours), starts serving once initial segments are ready, and is protected by HMAC-signed playlist and asset URLs. The built-in HTTPS source allowlist includes `r2.dev`, `cloudflarestorage.com`, `cloudfront.net`, `googleusercontent.com`, `workers.dev`, and Pixeldrain. Add trusted suffixes with `MULTITRACK_ALLOWED_HOSTS`; do not allow untrusted hosts. Tune job count and cache limits with the `MULTITRACK_*` settings in `.env.example`.

Codec/device combinations such as HEVC/AV1 profiles, HDR/Dolby Vision, AC-3/E-AC-3, and progressive MKV may not work in every browser. Use a compatible source/server when necessary; the backend does not transcode video to conceal these limitations.

## Run the Node backend (API-only)

```bash
npm ci
npm test
npm start
```

The server listens on `0.0.0.0:3000` by default and serves the JSON API only — the player page ships with the Cloudflare Worker. Copy `.env.example` to `.env` and configure deployment-specific values. The Docker image installs FFmpeg (including FFprobe); for non-Docker hosts, install both binaries on `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`. Multitrack remuxing can be disabled with `MULTITRACK_ENABLED=false`.

With Docker Compose:

```bash
docker compose up -d --build
```

## Deploy the Cloudflare Worker

`cloudflare-worker/worker.js` runs the player page, the backend API, and the edge proxy. The `public/` directory contains the `/embed` player page, its CSS/JS/vendor assets, and the social/meta GIF — no landing page, portal, or admin dashboard.

```bash
npx wrangler login
npx wrangler deploy
```

Configure production secrets and variables in Cloudflare Worker settings. Set a strong `ADMIN_SECRET` and `PROXY_SECRET` before deployment; do not use the sample values in `wrangler.toml` for a public service. If the API runs on a separate Worker or Node deployment, set `API_BASE_URL` to its absolute URL (see above).

Branch pushes run `wrangler preview` via Workers Builds, using the preview-safe values in the `[previews]` block of `wrangler.toml`; only merges to the production branch deploy the production configuration.

## Security status

The restored player page does **not** make source responses private or scraper-proof. The resolver API can still return source/proxy data, and permissive CORS is not authentication. Before the public main site launches, add an explicit client-auth/session design, short-lived signed access, rate limits, and a policy for avoiding raw upstream URLs in client responses. Do not treat CORS, iframe controls, or obscurity as source protection. These controls are intentionally not implemented in this change.
