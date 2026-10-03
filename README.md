# @VIDSTUCK — TMDB Video Embed API, Multi-Server Scraper & Edge Stream Proxy

A complete, production-ready **VidStuck-style Video Embed Player + Multi-Server Upstream Resolver + Owner Admin Console + Edge M3U8/MP4 Reverse Proxy** built around **TMDB IDs only**.

Pass any **TMDB Movie or Series ID** in the `<iframe>` URL—the backend automatically resolves external IDs (`imdb_id`, `tvdb_id`, `mal_id`), episode thumbnails & runtimes, **Skip Intro / Recap / Next Episode** timestamps, **OpenSubtitles / Wyzie WebVTT tracks** (with local `.srt` upload, style & delay controls), and **multi-language audio dubs/subs**.

---

## ✨ Key Production Features

- **TMDB ID Only for Developers:**
  - Movies: `/embed/movie/{tmdb_id}` (e.g. `/embed/movie/693134`)
  - TV & Anime: `/embed/tv/{tmdb_id}/{season}/{episode}` (e.g. `/embed/tv/94605/1/1`)
  - Also supports VidBolt (`/movie/{id}`, `/tv/{id}/{s}/{e}`) and ScreenScape (`/embed?tmdb={id}&type=movie`) URL patterns out of the box.
- **6 Stream Sources (Zero Test/Demo Streams):**
  0. **Archive (`archive.org`, default)** — Internet Archive public-domain films. Public JSON API, CORS CDN, no gating bypass, and only items carrying an explicit Public Domain / CC0 marker are served. The resolved payload includes `provenance` (`identifier`, `licence`, `sourcePage`) for attribution.
  1. **Andromeda (`vidstuck.xyz` / `zxcstream.icu`)** — Session warm-up + `/backend/meow` handshake + OpenSSL MD5 `EVP_BytesToKey` **AES-256-CBC** stream decryption.
  2. **Ursa (`data.vidsrc.sh`)** — Compiles `.wasm` in Node/Workers to decrypt ChaCha20 `stream_urls` and stamps `.m3u8` URLs with `<origin>/generate.php` JWT tokens.
  3. **Centaurus (`api.hicine.sbs`)** — Resolves `vcloud` Cloudflare Worker signed tokens (`pixel` / `ten` / `r2`) and `pixeldrain` links into direct `1080p` / `720p` / `480p` `.mp4`/`.mkv` streams.
  4. **Atlas (`vidstuck.xyz` Backup)** — Secondary multi-audio HLS mirror.
  5. **Strings (`hianime.at` + `zokoanime.video`)** — Extracts both **Japanese Original Sub** and **English Dub** `.m3u8` streams by decoding `window.__P` (Base64 + XOR key `"otaku-embed-v1"`).
- **Owner Admin Console (`/admin`):**
  - **Embedding Domains Analytics & Firewall:** See every external website/domain embedding your player (`Referer`, `Origin`, and `window.location.ancestorOrigins`), total embed views, stream resolutions, proxy hits, top watched TMDB titles, and **Block / Unblock** any domain in one click.
  - **Stale / Dead Source Monitor & Live Replacer:** Run active health probes (`⚡ Run Live Health Probe`) against all 5 upstream providers, view real-time success rates & latency (`ms`), reorder failover priority (`#1`–`#5`), disable broken servers, or **hot-swap upstream base URLs & AES keys live at runtime without redeploying**.
  - **Custom TMDB Stream Overrides:** Pin a direct `.m3u8` or `.mp4` URL to any specific TMDB movie or TV episode right from `/admin`.
- **Peak QoL Player UI:**
  - **Skip Intro / Skip Recap / Next Episode** floating button powered by IntroDB (`api.introdb.app`) + AniSkip v2 (`api.aniskip.com`).
  - **Segmented Timeline** with visual chapter markers and hover timestamp tooltips.
  - **`[A文]` Multi-Language Audio Switcher** & **`[==]` Subtitles Popover** (`Upload subtitle`, `Style` font/color/background customizer, and `Delay` `-0.5s` / `+0.5s` sync).
  - **Episodes Drawer (`[▷]`)** with Season dropdown and 3-column TMDB episode cards.
  - **Player Settings Modal (`⚙️`)** with **Quality**, **Audio**, **Subtitles**, **Aspect Ratio (`Fit`, `Fill`, `Stretch`)**, **Brightness (`50%`–`150%`)**, **Mirror (Horizontal Flip)**, **Picture-in-Picture**, and **Playback Speed (`0.5x`–`2x`)**.

---

## 📡 Stream Sources — status & lawful alternatives

The server switcher exposes six sources. Only **Archive** is a licensed-clean, upstream-managed API that this project can keep working without reverse-engineering anything:

| Source | Status | Notes |
| :--- | :--- | :--- |
| **Archive** (default) | ✅ Working | Internet Archive public-domain films. Item must carry an explicit Public Domain / CC0 marker (or belong to a curated public-domain collection); everything else is rejected by `src/services/providers/archive.js`. Returns licence + source page as `provenance`. Movies only — archive.org items are not episode-addressable, so TV requests are intentionally refused. Set `ARCHIVE_ALLOW_CC=1` to also accept Creative Commons (attribution) items. |
| Andromeda / Atlas (`vidstuck.xyz`) | ⚠️ Not working | Upstream replaced its API: the `/backend/meow` session-token endpoint the extractor depends on now answers `404`. The site is unlicensed, so this project does not attempt to reverse-engineer the replacement. |
| Ursa (`data.vidsrc.sh`) | ⚠️ Unlicensed | VidSrc is subject to active studio litigation (Netflix/Disney/Universal/Crunchyroll) and rotates domains to evade enforcement. Not something to build production on. |
| Centaurus (`api.hicine.sbs`) | ⚠️ Unlicensed | Third-party unlicensed aggregator; no API contract or stability guarantees. |
| Strings (`hianime.at`) | ⚠️ Unlicensed | HiAnime is on court-ordered piracy block lists in multiple jurisdictions. |

**Bring your own source instead.** Any stream you *do* have the rights to serve works through the existing plumbing:

- **Owner overrides (no code change):** `POST /api/admin/overrides` with `{ "type": "movie", "tmdbId": "550", "streamUrl": "https://your-cdn/master.m3u8" }` — or pin an override in `/admin`. HLS and progressive MP4/MKV both work, and the manifest rewriter will proxy nested playlists/segments if the CDN needs it.
- **Your own storage / CDN:** S3-compatible buckets, Cloudflare R2, Bunny, or any origin you control (public-domain and CC archives, your own library, licensed partner feeds).
- **A new provider:** add a module under `src/services/providers/`, register it in `src/config.js` `servers[]`, and add a branch in `resolveStreamForServer` (`src/services/resolver.js`) plus the mirrored copy in `cloudflare-worker/worker.js`.

Tests cover the source layer offline — `npm test` runs the backend suite (licence gating, title matching, file picker, end-to-end `/api/resolve?server=archive`) and then a worker parity test that imports the real `cloudflare-worker/worker.js`, stubs the upstream HTTP calls, and asserts the edge payload.

---

## 🛡️ Owner Admin Console (`/admin`)

Open **`/admin`** in your browser (default key: `admin123`, configurable via `ADMIN_SECRET` in `.env` or `wrangler.toml`):

| Admin Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/admin` | `GET` | Interactive Owner Admin Dashboard UI |
| `/api/admin/overview` | `GET` | Full JSON snapshot of domain stats, upstream health, blocked domains, and overrides (`X-Admin-Key` required) |
| `/api/admin/probe` | `POST` | Actively probes all 5 upstream providers and updates live latency & status (`ONLINE` / `DEGRADED` / `DEAD`) |
| `/api/admin/upstreams` | `POST` | Hot-swaps upstream domain URLs (`vidstuckBase`, `vidsrcDataUrl`, `hicineApiBase`, `hianimeBase`), AES keys, proxy pools, and server priority/enabled state |
| `/api/admin/domains/block` | `POST` | Blocks or unblocks an external website domain (`{ "domain": "example.com", "blocked": true }`) |
| `/api/admin/overrides` | `POST` | Pins a custom `.m3u8`/`.mp4` stream URL to a specific TMDB ID (`{ "type": "tv", "tmdbId": "94605", "season": 1, "episode": 1, "streamUrl": "https://..." }`) |

---

## ☁️ Deploying on Cloudflare Free Tier (No Credit Card Required)

`cloudflare-worker/worker.js` + `wrangler.toml` run the **entire platform** (Static UI Assets + TMDB Resolver + 5 Stream Extractors + OpenSubtitles Gzip/VTT Converter + Owner Admin Console + Edge M3U8 Proxy) on Cloudflare Workers Free Tier.

### Option 1: Deploy via Cloudflare Dashboard (GitHub Integration)
1. Log into **[dash.cloudflare.com](https://dash.cloudflare.com)** (no credit card needed for Workers Free).
2. Go to **Compute (Workers)** $\rightarrow$ **Workers & Pages** $\rightarrow$ **Create** $\rightarrow$ **Import a repository**.
3. Select this repository (`themithology/Proxy`).
4. Cloudflare automatically detects `wrangler.toml`, binds `./public` as free static `ASSETS`, and deploys `cloudflare-worker/worker.js`.
5. *(Optional)* In Worker **Settings $\rightarrow$ Variables and Secrets**, set your custom `ADMIN_SECRET` password for `/admin`.

### Option 2: Deploy via Wrangler CLI
```bash
npx wrangler login
npx wrangler deploy
```

---

## 🖥️ Running on Node.js / Docker / VPS

```bash
npm install
npm test
npm start
```

Or with Docker Compose:
```bash
docker compose up -d --build
```
