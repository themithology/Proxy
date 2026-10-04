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
| `server`   | Preferred upstream server: `andromeda`, `ursa` (or `4k`), `centaurus`, `atlas`, `strings` |
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
- `GET /api/dubs/:type/:tmdbId` — TMDB-id keyed dub inventory (`?deep=1` also probes the 4K/download tiers, `?audio=hi` sets the preferred track).
- `GET /api/resolve/:type/:tmdbId` — resolves a source and returns stream, audio, subtitle, and segment metadata.
- `GET /api/proxy?url=...` — HLS/MP4 stream proxy.
- `GET /api/multitrack/master.m3u8` and `/api/multitrack/file/:jobId/:filename` — signed Node-side audio-remux output.
- `/api/admin/*` — JSON-only owner operations for health probes, domain blocks, upstream configuration, and source overrides; requires `X-Admin-Key`. There is no admin web UI.

Supported media types are `movie`, `tv`, and `series` where applicable. TV requests accept `season` and `episode` query parameters.

## Source resolution and audio behavior

The resolver supports five server configurations:
- **Server 1 (Andromeda)**: Multi-Tier Multi-Audio Cascade (CastleTV → Moviebox → NetMirror) with automatic failover to Server 2 (Ursa).
- **Server 2 (Ursa / `4k`)**: 4-Tier 2160p 4K UHD & Multi-Audio Cascade (4KHDHub → MoviesDrive 4K → HiCine 4K UHD → DahmerMovies 4K).
- **Server 3 (Centaurus)**: HiCine Direct MP4.
- **Server 4 (Atlas)**: ZXC Backup Adaptive HLS.
- **Server 5 (Strings)**: Anime Sub/Dub (HiAnime / ZokoAnime).
- **Server 6 (Hindi, opt-in)**: TMDB-id keyed Hindi dubs across every tier — requested explicitly with `?server=hindi`.

### Hindi dubs and TMDB-id identity (Server 6 / `?server=hindi`)

The multi-audio tiers (CastleTV, Moviebox) can only be searched by **name**, and those catalogs contain same-name collisions. A name search for `Fight Club` returns the 2023 Indian film — which happens to ship a Hindi dub — ahead of the 1999 film (TMDB `550`), so a naive first-row pick plays the wrong movie. The Hindi layer removes name ambiguity entirely:

- Metadata is always resolved from the **TMDB id** first (`/api/info`, `/api/resolve`, `/api/dubs`), including original and alternative titles.
- Every upstream search row/subject is scored against that identity (title + original/alt titles + release year + movie/series type), and only an exact-identity candidate can be used. Unverifiable results are a clean miss, so the waterfall moves on instead of playing a different film.
- The matched identity is returned in the payload (`stream.identity`: `matchedTitle`, `matchedYear`, `upstreamId`, `score`, `reasons`, plus the rejected candidates) so clients can show and verify what was actually selected.
- All dub languages the verified provider exposes are surfaced as `audioTracks` (CastleTV per-language tracks, Moviebox `dubs[]`/`resourceDetectors[]`); Hindi is the default when present, otherwise the preferred `?audio=` track.
- If no identity-verified Hindi source exists for a title, the Hindi server returns the verified original-audio stream with `hindiAvailable: false` (never a wrong-title Hindi stream) and the dub inventory reports `hindi: false`.
- Responses carry their provenance: `hindiVerified: true` means the Hindi track came from a TMDB/IMDb-anchored match, while `hindiVerified: false` + `identityMethod: "title-hint"` flags a provider that only matches by title hints (the resolution still reports `hindiAvailable`, so clients can decide whether to trust it).

`GET /api/dubs/:type/:tmdbId` returns the full inventory for a title:

```jsonc
{
  "ok": true,
  "hindi": true,           // identity-verified Hindi source exists
  "hindiAnySource": true,  // also true when only a title-hint provider reports Hindi
  "dubs": [{ "code": "hi", "label": "Hindi", "playable": true, "providers": ["castletv", "moviebox"] }],
  "providers": [
    {
      "id": "castletv",
      "ok": true,
      "identity": { "verified": true, "matchedTitle": "Dune: Part Two", "matchedYear": 2024, "upstreamId": "7475882100889600" },
      "languages": [{ "code": "hi", "label": "Hindi", "playable": true }],
      "hindi": true
    }
  ]
}
```

Provider identity methods:

| Provider      | Identity anchor                                                        |
| ------------- | ---------------------------------------------------------------------- |
| CastleTV      | TMDB title/original/alt titles + `publishTime` year + `movieType`       |
| Moviebox      | TMDB title/original/alt titles + subject year + `subjectType`           |
| NetMirror     | TMDB id (`/api/embed-tmdb/<id>`)                                        |
| MoviesDrive   | IMDb id from TMDB + title/year scoring                                  |
| 4KHDHub       | Title + release year parsed from the search page                        |
| HiCine        | title/year hints                                                        |
| HiAnime       | MAL id from TMDB (anime only)                                           |
| DahmerMovies | title (+year) directory path                                           |

Operational notes:

- Moviebox geo-blocks some regions (HTTP 403 `Service not available in current region`); the cascade treats that as a miss and continues.
- `MOVIEBOX_STRICT_HOSTS=true` pins the host pool to `MOVIEBOX_BASE_URL`/`MOVIEBOX_HOSTS`/`MOVIEBOX_EXTRA_HOSTS` only (no built-in mirrors).
- `HINDI_PROVIDERS=castletv,moviebox` limits which providers the Hindi server and `/api/dubs` may use.

### Server Andromeda Multi-Tier Architecture

To replace the deprecated VidStuck upstream, Server Andromeda uses a resilient 3-tier cascade backed by automatic dynamic discovery:

1. **Priority 1: CastleTV (`api.hlowb.com`)**
   - **Coverage:** Extensive South Indian dubs (Tamil, Telugu, Malayalam, Kannada, Hindi), K-dramas, C-dramas, anime, and Hollywood multi-audio.
   - **Protocol:** AES-128-CBC encryption (`IV == key`), dynamically derived on-the-fly from `/v0.1/system/getSecurityKey/1`. Yields language-tagged master HLS playlists per dub track via `/film-api/v2.0.1/movie/getVideo2`.

2. **Priority 2: MovieBox Dynamic Cluster Pool (`api.inmoviebox.com`, `api6.aoneroom.com`, etc.)**
   - **Coverage:** Broad global catalog with discrete multi-audio MP4 and HLS streams.
   - **Dynamic Cluster Failover:** Automatically bypasses deprecated/unreachable endpoints (`api3.aoneroom.com`, `uwu.eat-peach.sbs`) by cascading through active cluster mirrors (`api.inmoviebox.com`, `api6.aoneroom.com`, `h5-api.aoneroom.com`, `apii.inmoviebox.com`, `api.aoneroom.com`, `i-api.aoneroom.com`, `api5.aoneroom.com`). If any cluster returns HTTP 440, 502, or connection reset, the resolver transparently retries the next candidate and caches the healthy cluster.
   - **Protocol:** Canonical HMAC-MD5 request signing (`x-client-token`, `x-tr-signature`) with Android client emulation.

3. **Priority 3: NetMirror Dynamic Discovery & Rotating Domain Tracking**
   - **Coverage:** Official OTT platform mirrors (Netflix, Prime Video, Disney+/Hotstar) with embedded multi-audio renditions.
   - **Dynamic Discovery Network:** Rather than hardcoding static web numbers (`net27.cc`), the resolver queries the `checknewtv.php` discovery network (`mobiledetect.app`, `mobiledetects.com`, `mobidetect.cc`, etc.) to dynamically resolve the active API backend (`https://tv.imgcdn.kim`).
   - **Live Rotating Domain Tracker:** Automatically extracts the active web mirror domain (e.g. `net52.cc`, `net77.cc`) from API response headers (`img_referer`, `referer`), dynamically updating video chunk and subtitle proxy headers without code changes.

4. **Clean Waterfall Failover: Server 2 (Ursa / 4K UHD)**
   - If all three internal Andromeda tiers return no playable streams for a given title, Andromeda cleanly cascades to Server 2 (Ursa) in the waterfall failover chain.

### Server Ursa (`?server=ursa` / `?server=4k`) 4-Tier 4K UHD Multi-Audio Architecture

Server 2 (`ursa`, also accessible via `?server=4k`) delivers true **2160p (4K UHD)** streams with **Multi-Audio / Dual-Audio** prioritized (and Original Audio supported) across a 4-tier cascade:

1. **Priority 1: 4KHDHub (`4khdhub.one` + Dynamic Domain Discovery)**
   - **Coverage:** Dedicated 2160p UHD BluRay REMUX, DV/HDR10, and 4K WEB-DL releases with Dual/Multi-Audio (`[Hindi DDP 5.1 + English TrueHD Atmos 7.1]`, Tamil/Telugu/Multi-Audio) plus 1080p backup qualities.
   - **Protocol:** Dynamic domain discovery (`urls.json` + mirror pool), `.download-item` / `.episode-download-item` extraction, 3-chain Base64 + ROT13 redirector decoding (`b64 -> b64 -> rot13 -> b64 -> JSON.o -> b64`), HubDrive hop, and HubCloud unrolling to direct R2 / FSL / workers.dev CDN URLs.

2. **Priority 2: MoviesDrive 4K (`new5.moviesdrive.christmas` + Typesense IMDb API)**
   - **Coverage:** Fast Typesense JSON search (`/search.php?q=<imdbId>&page=1`) indexing 2160p 4K SDR/HDR Dual-Audio (`[Hindi + English]`) and Multi-Audio releases.
   - **Protocol:** Exact `imdb_id` / title matching, `<h5>` quality block parsing, `mdrive.lol/archive/...` unpacking, and HubCloud generator unrolling to direct 2160p CDN streams.

3. **Priority 3: HiCine 4K UHD (`api.hicine.sbs`)**
   - **Coverage:** Extracts `[2160P]` / `4K` SDR & DV HDR Dual-Audio streams from HiCine's catalog (which Server 3 Centaurus skips in favor of mobile-first 720p x264) while retaining 1080p/720p backup rungs in `qualities`.
   - **Protocol:** Parallel `vcloud` worker token resolution (`ten`, `fsl2`, `fsl`, `r2`) and HubCloud unrolling.

4. **Priority 4: DahmerMovies 4K (`a.111477.xyz`)**
   - **Coverage:** Direct open-directory 2160p HDR/SDR `.mkv`/`.mp4` streams (`/movies/<Title> (<Year>)/` and `/tvs/<Title>/Season <NN>/`) with Original and Multi-Audio tracks.

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
