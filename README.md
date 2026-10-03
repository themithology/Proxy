# LOL Embed — Backend & Workers

LOL Embed is a **backend-only** TMDB metadata, source-resolution, and stream-proxy service. This repository contains the Node.js API and Cloudflare Worker; it no longer ships a player, developer portal, admin dashboard, CSS, or browser JavaScript. A separate frontend can be added later and consume the JSON API.

## Brand

- **Name:** LOL Embed
- **Visual direction for a future client:** monochrome
- **Palette:** black `#000000`, charcoal `#171717`, graphite `#404040`, gray `#A3A3A3`, and white `#FFFFFF`
- **Social/meta image:** `GET /meta-image.gif` serves the supplied GIF. Use its absolute deployment URL for `og:image` and `twitter:image` when a frontend is introduced. The root JSON response also advertises it as `metaImage`.

Example metadata for a future frontend:

```html
<meta property="og:title" content="LOL Embed">
<meta property="og:image" content="https://YOUR_API_HOST/meta-image.gif">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://YOUR_API_HOST/meta-image.gif">
<meta name="theme-color" content="#000000">
```

## Backend surface

- `GET /` — JSON service information; no HTML landing page.
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
- `/api/admin/*` — JSON-only owner operations for health probes, domain blocks, upstream configuration, and source overrides; requires `X-Admin-Key`.

Supported media types are `movie`, `tv`, and `series` where applicable. TV requests accept `season` and `episode` query parameters.

## Source resolution and audio behavior

The resolver has five upstream families: Andromeda/Atlas (VidStuck/ZXC), Ursa (VidSrc), Centaurus (HiCine), and Strings (HiAnime/ZokoAnime). It normalizes their stream and subtitle results for API clients and proxies supported HLS/MP4 sources.

Audio behavior is intentionally truthful:

- Upstream HLS audio renditions are exposed when they are actually switchable.
- HiCine has filename-only language hints, not structured language URLs; progressive sources remain one honest default row rather than duplicate entries for the same file.
- Node deployments can use FFmpeg/FFprobe to remux embedded MKV/MP4 audio tracks into HLS. The video stream is copied; supported audio is copied and other audio is converted to AAC.
- Cloudflare Workers do not run FFmpeg. They retain upstream HLS rendition switching and use progressive fallback for embedded MKV tracks; the browser cannot select embedded tracks from progressive MKV.
- If remuxing is unavailable, unsafe for the source host, or fails, the resolver keeps the source's default audio and progressive fallback rather than claiming unsupported switching.

The generated Node multitrack package is cached locally (default two hours), starts serving once initial segments are ready, and is protected by HMAC-signed playlist and asset URLs. The built-in HTTPS source allowlist includes `r2.dev`, `cloudflarestorage.com`, `cloudfront.net`, `googleusercontent.com`, `workers.dev`, and Pixeldrain. Add trusted suffixes with `MULTITRACK_ALLOWED_HOSTS`; do not allow untrusted hosts. Tune job count and cache limits with the `MULTITRACK_*` settings in `.env.example`.

Codec/device combinations such as HEVC/AV1 profiles, HDR/Dolby Vision, AC-3/E-AC-3, and progressive MKV may not work in every browser. Use a compatible source/server when necessary; the backend does not transcode video to conceal these limitations.

## Run the Node backend

```bash
npm ci
npm test
npm start
```

The server listens on `0.0.0.0:3000` by default. Copy `.env.example` to `.env` and configure deployment-specific values. The Docker image installs FFmpeg (including FFprobe); for non-Docker hosts, install both binaries on `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`. Multitrack remuxing can be disabled with `MULTITRACK_ENABLED=false`.

With Docker Compose:

```bash
docker compose up -d --build
```

## Deploy the Cloudflare Worker

`cloudflare-worker/worker.js` runs the backend API and edge proxy. The `public/` directory contains only the social/meta GIF; no HTML, CSS, or frontend JavaScript is published.

```bash
npx wrangler login
npx wrangler deploy
```

Configure production secrets and variables in Cloudflare Worker settings. Set a strong `ADMIN_SECRET` and `PROXY_SECRET` before deployment; do not use the sample values in `wrangler.toml` for a public service.

## Security status

Removing the bundled frontend does **not** make source responses private or scraper-proof. The resolver API can still return source/proxy data, and permissive CORS is not authentication. This repository is now the backend foundation; before attaching a public frontend, add an explicit client-auth/session design, short-lived signed access, rate limits, and a policy for avoiding raw upstream URLs in client responses. Do not treat CORS, iframe controls, or obscurity as source protection.
