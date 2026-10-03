# Proxy

A production-grade, multi-provider streaming API with a built-in player.

You give it a title (IMDB id, TMDB id, or a title + year). It fans the request
out across every configured provider, ranks and de-duplicates what comes back,
and hands your player a URL on **your own origin** that just plays — HLS and
DASH manifests are rewritten, segments and AES keys are proxied with full
`Range` support, and subtitles are transcoded to WebVTT on the fly.

```
GET /api/streams/movie/tt0111161?lang=hi,en
  → [ { provider, quality, language, subtitles, playback: { type: "hls", url: "/proxy/manifest?token=…" } } ]
```

No client ever talks to an upstream host directly. No CORS, no Referer checks,
no mixed-content errors, and per-source headers stay on the server.

---

## Why this exists

Streaming sources are heterogeneous and hostile:

| Problem | What Proxy does |
|---|---|
| HLS/DASH manifests full of relative + absolute upstream URLs | Rewrites **every** URI to a signed URL on your origin |
| `EXT-X-KEY` AES keys, fMP4 `EXT-X-MAP` init segments | Proxied and cached like any other segment |
| Players only render WebVTT | SRT / SSA-ASS / TTML are transcoded to VTT automatically |
| Sources need `Referer` / `Origin` / cookies | Headers travel inside the **HMAC-signed token**, never exposed |
| Seeking breaks when a proxy drops `Range` | `Range` is forwarded; `206` + `Content-Range` come back intact |
| Providers need the same URL pattern repeated | Rule-driven `webextract` engine — configure, don't code |
| One dead source kills playback | Fan-out with per-provider circuit breakers; failures are isolated |
| Thundering herds on a popular title | Request coalescing + multi-tier caching (memory / SQLite / Redis) |

---

## Quick start

```bash
git clone <your-fork> && cd Proxy
npm install
cp .env.example .env

# Generate a signing secret (do this; the default is not safe)
sed -i "s|^PROXY_SECRET=.*|PROXY_SECRET=$(openssl rand -hex 32)|" .env

npm run dev          # http://localhost:3000
```

Open <http://localhost:3000> — you get a working search + player UI.
API docs are at <http://localhost:3000/api/docs>.

### With Docker

```bash
docker compose up -d
```

### First-run checklist

1. **`PROXY_SECRET`** — anything else lets strangers forge proxy URLs.
2. **`PUBLIC_URL`** — the origin clients connect to. Manifests are rewritten
   against it, so if it's wrong, playback breaks. Behind a reverse proxy this
   must be the public URL.
3. **`TMDB_API_KEY`** — optional, but you want it. It fills in titles, years,
   artwork, episode lists, and — most importantly — translates between IMDB and
   TMDB ids so one request can fan out across providers keyed on either.
   Free at <https://www.themoviedb.org/settings/api>.
4. **`API_KEY`** — set it before exposing this to the internet.

---

## API

Everything returns JSON. Errors are `{ ok: false, error, code }`.

Auth (when `API_KEY` is set) accepts any of: `x-api-key` header,
`Authorization: Bearer <key>`, or `?api_key=`.

### `GET /api/streams/:type/:id` — the one you'll actually use

| Param | Notes |
|---|---|
| `:type` | `movie` \| `series` \| `anime` |
| `:id` | `tt0111161`, `278`, `tmdb:278`, or any `prefix:value` |
| `season`, `episode` | required for `series` / `anime` |
| `lang=hi,en` | preferred audio languages, **in priority order** |
| `only=en` | hard filter (streams with unknown language are kept) |
| `limit=25` | cap results (default 25, max 200) |
| `minHeight`, `maxHeight` | drop renditions outside a range (bandwidth control) |
| `playable=true` | drop embeds and torrents |
| `expose=direct` | include raw upstream URLs in the response |
| `title`, `year` | pass a title manually when TMDB is off |
| `diagnostics=true` | include per-provider timings and errors |

```bash
curl "http://localhost:3000/api/streams/movie/tt0111161?lang=en&limit=5"
```

```json
{
  "ok": true,
  "query": { "type": "movie", "imdbId": "tt0111161", "title": "The Shawshank Redemption", "year": 1994 },
  "count": 2,
  "streams": [
    {
      "id": "kQgUPdrV74WVeyBmi1-fl4tHHfCfYsPB",
      "provider": { "id": "archive", "name": "Internet Archive" },
      "name": "Internet Archive · 1080p",
      "quality": "1080p",
      "height": 1080,
      "language": "en",
      "subtitles": [
        { "url": "http://localhost:3000/proxy/subtitle?token=…", "lang": "hi", "label": "Hindi", "format": "vtt" }
      ],
      "playback": {
        "type": "hls",
        "url": "http://localhost:3000/proxy/manifest?token=…",
        "via": "direct"
      }
    }
  ]
}
```

`playback.url` is always playable. Feed it straight to hls.js, dash.js, a
`<video>` tag, VLC, or mpv.

### The rest

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness, provider counts, cache stats |
| `GET /api/providers` | list providers + health + circuit-breaker state |
| `POST /api/providers/reload` | re-read `config/providers.json` without restarting |
| `PATCH /api/providers/:id` | `{ "enabled": true }` — toggle a provider live |
| `GET /api/providers/:id/health` | ping a single provider |
| `GET /api/search?q=…&type=…&page=…` | search (TMDB, or provider search as fallback) |
| `GET /api/catalog/:type?category=trending` | browse |
| `GET /api/meta/:type/:id` | full metadata |
| `GET /api/meta/:type/:id/season/:n` | episode list |
| `POST /api/resolve` | resolve one URL → `{ url, headers?, kind? }` |
| `GET /api/extract?url=…` | pull media URLs out of any page |
| `POST /api/cache/clear` | flush the cache |
| `GET /proxy/manifest?token=…` | rewritten HLS / DASH manifest |
| `GET /proxy/segment?token=…` | segment / AES key / init segment (`Range` OK) |
| `GET /proxy/subtitle?token=…` | subtitle transcoded to WebVTT |
| `POST /proxy/sign` | mint a signed proxy URL for a URL you already have |
| `GET /openapi.json`, `GET /api/docs` | OpenAPI 3.1 spec + Swagger UI |

---

## Providers

Providers are plugins described in `config/providers.json`. Five kinds ship
with the project, and adding a sixth is a single module plus one registry line.

```jsonc
{
  "id": "my-provider",          // unique
  "kind": "stremio",            // stremio | archive | youtube | direct | webextract
  "name": "My Provider",
  "enabled": true,
  "priority": 70,               // 0–100, tie-breaker when ranking
  "languages": ["hi", "en"],    // ISO-639-1, or ["*"] for any
  "types": ["movie", "series"],
  "options": { /* kind-specific */ }
}
```

### `stremio` — any Stremio addon

The Stremio addon protocol is an open standard, and it's the fastest way to add
a source without writing code. Point it at a manifest URL:

```json
{ "kind": "stremio", "id": "my-addon", "name": "My Addon", "enabled": true,
  "languages": ["*"], "types": ["movie", "series"], "priority": 70,
  "options": { "manifestUrl": "https://your-addon.example.com/manifest.json" } }
```

Handles `stream`, `catalog` and `search` resources; maps `ytId` → YouTube
embed, `infoHash` → magnet (with trackers), `externalUrl` → embed, and honours
`behaviorHints.proxyHeaders.request` so upstream headers are applied
automatically.

### `archive` — Internet Archive

Public-domain and openly licensed film. No key required, works out of the box.

```json
{ "kind": "archive", "options": { "collection": "feature_films", "maxFiles": 3 } }
```

Change `collection` to your own uploads to serve your own library.

### `youtube` — official embeds

```json
{ "kind": "youtube", "options": { "apiKey": "", "invidiousUrl": "" } }
```

Three modes: `apiKey` → YouTube Data API search; `invidiousUrl` → a
user-hosted Invidious instance (also yields direct MP4 URLs); neither → embed
only. Always plays through the official player.

### `direct` — your own files

```json
{ "kind": "direct", "options": {
  "urlTemplate": "https://cdn.example.com/{type}/{imdbId}/{season}/{episode}.m3u8",
  "sources": [ { "imdbId": "tt0111161", "url": "https://cdn.example.com/a.m3u8", "quality": "1080p", "language": "en" } ],
  "file": "./config/my-library.json"   // or load the array from disk
} }
```

Placeholders: `{imdbId} {tmdbId} {title} {type} {year} {season} {episode}
{seasonPad} {episodePad}`.

### `webextract` — any HTTP source, configured not coded

A small rules engine. Steps run in order over a shared variable scope:

```json
{ "kind": "webextract", "options": {
  "baseUrl": "https://example.com",
  "headers": { "referer": "https://example.com/" },
  "steps": [
    { "op": "fetch",    "url": "/watch/{imdbId}", "as": "body" },
    { "op": "regex",    "source": "body", "pattern": "sources:\\[(?<json>.*?)\\]" },
    { "op": "json",     "source": "json", "path": "sources.0.file", "as": "fileUrl" },
    { "op": "findUrls", "source": "body", "as": "found", "exclude": "preview|trailer" },
    { "op": "emit",     "url": "{fileUrl}", "quality": "1080p", "language": "hi" },
    { "op": "emitFound","source": "found" }
  ]
} }
```

| Op | Behaviour |
|---|---|
| `fetch` | GET/POST a templated URL; stores text in `as` (and parses JSON into `json`) |
| `regex` | named capture groups become variables |
| `json` | dotted/bracketed path get (`a.b[0].c`) |
| `findUrls` | finds `.m3u8 .mpd .mp4 .webm .mkv .ts` and magnets, including inside base64 blobs |
| `emit` | emit one candidate from a template |
| `emitFound` | emit everything `findUrls` collected |
| `set` | assign a literal |

Templates accept `{imdbId} {tmdbId} {title} {year} {season} {episode} {type}
{query}` plus any variable you've captured. `include` / `exclude` take regexes.

### Adding a new provider kind

1. Create `src/providers/mine.ts` extending `BaseProvider` — implement
   `init()`, `ping()` and `doGetStreams()`; add `search()` / `catalog()` if the
   source supports them.
2. Register the factory in `PROVIDER_KINDS` in `src/providers/registry.ts`.
3. Add an entry to `config/providers.json`.

`BaseProvider` gives you typed option access (`this.opt` / `this.reqOpt`),
health tracking, circuit-breaker bookkeeping and candidate normalisation
(quality parsing, language normalisation, kind sniffing) for free.

---

## How playback works

```
client ──GET /api/streams/movie/tt…──▶ Proxy
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
              provider A          provider B          provider C
                    └───────────────────┼───────────────────┘
                                        ▼
                          rank → dedupe → normalise
                                        ▼
                    { playback: { type: "hls", url: "/proxy/manifest?token=…" } }

client ──GET /proxy/manifest?token=…──▶ fetch upstream manifest
                                        rewrite EVERY uri ──▶ /proxy/segment?token=…
client ──GET /proxy/segment?token=…───▶ verify HMAC → fetch upstream (Range fwd)
```

**Tokens** are `base64url(payload).HMAC-SHA256(payload)` carrying the upstream
URL, the headers it needs, and an expiry. Tampering or expiry → `401`. The
upstream URL is never visible to the client unless you ask for `expose=direct`.

**DASH `SegmentTemplate`** is the subtle one: the *player* substitutes
`$Number$` / `$Bandwidth$`, so those placeholders are kept visible in our query
string (`&_n=$Number$`) and re-injected server-side before the upstream fetch.
`BaseURL` is baked into child URLs and then dropped, because a proxied BaseURL
containing a query string can't be used as a relative-URL base.

**Caching:** VOD manifests, subtitles, AES keys and init segments are cached
(live manifests are not). Range requests stream straight through. Concurrent
requests for the same key share one upstream fetch.

---

## Configuration

Every setting lives in `.env` (see `.env.example`). The important ones:

| Var | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | **must** match how clients reach you |
| `PROXY_SECRET` | insecure default | HMAC key for proxy tokens — change it |
| `API_KEY` | *(empty = auth off)* | gates `/api/*` and `/proxy/*` |
| `ALLOWED_ORIGINS` | *(empty = any)* | comma-separated upstream host allow-list |
| `TMDB_API_KEY` | *(empty)* | metadata, search, IMDB↔TMDB translation |
| `CACHE_DRIVER` | `sqlite` | `memory` \| `sqlite` \| `redis` \| `none` |
| `EGRESS_PROXY` | *(empty)* | route upstream traffic through a proxy |
| `UPSTREAM_REFERER` / `UPSTREAM_USER_AGENT` | — | sent to every upstream |
| `PROVIDER_FANOUT_CONCURRENCY` | `8` | parallel provider queries |
| `PROVIDER_TIMEOUT` | `15000` | ms per provider |
| `PROVIDER_FAILURE_THRESHOLD` / `PROVIDER_COOLDOWN` | `4` / `120000` | circuit breaker |
| `MAX_SEGMENT_BYTES` | `0` (unlimited) | guard against runaway responses |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `300` / `60000` | per-IP |

`CACHE_DRIVER=redis` additionally needs `npm i ioredis`.

---

## The web UI

Bundled at `/`, no build step, no CDN dependency — hls.js and dash.js are
served locally from `/vendor/`.

- Search and browse (TMDB when configured)
- Title pages with metadata, season/episode pickers, and a ranked source list
- Plays HLS (hls.js), DASH (dash.js), MP4 (native) and iframe embeds
- Subtitle track selection from the `<track>` elements we generate
- Language preference, per-source quality/size/language badges
- A ⚙ menu for the API key (stored in `localStorage`, sent as `x-api-key`)

Embeddable: `<iframe src="https://your-host/title/movie/tt0111161">`.

---

## Security notes

- **Signed tokens.** Proxy URLs are HMAC-signed with an expiry. A client cannot
  rewrite a token to point somewhere else.
- **No open proxy.** `assertUpstreamAllowed()` enforces `ALLOWED_ORIGINS` when
  set, and refuses loopback / link-local / RFC1918 targets in production.
  (They're permitted in development so local fixture servers can be tested.)
- **Upstream URLs are hidden** unless you explicitly pass `expose=direct`.
- **Headers stay server-side.** Referer/Origin/cookies ride inside the token.
- **Rate limiting** is on by default and keyed on `X-Forwarded-For` when
  `TRUST_PROXY=true`.
- Set `API_KEY` before exposing this publicly.

---

## Sources and responsibility

Proxy is transport and aggregation infrastructure: it resolves a title to a
playable URL and makes that URL work in a browser. It contains no content, and
it decides nothing about what is legal to stream in your jurisdiction.

The providers that ship enabled by default — Internet Archive (public domain
and openly licensed film) and YouTube (official embeds) — are there so the
project is useful the moment you clone it. The other kinds are mechanisms:
`stremio` speaks an open protocol, `direct` plays files you control, and
`webextract` is a generic rules engine for HTTP sources.

**Point those mechanisms at sources you own, host, or are licensed to
distribute.** Sites whose business is redistributing copyrighted work without
authorisation aren't shipped as built-in providers, and this document won't
help you target them — that determination is yours to make, and it's the one
piece of this project that isn't configurable.

---

## Development

```bash
npm run dev          # tsx watch
npm run typecheck    # tsc --noEmit
npm test             # 74 tests
npm run build        # → dist/
npm start            # run the build
```

### Running against a synthetic upstream

With no external network (or no provider credentials) the UI has nothing to
show. Two commands fix that:

```bash
npm run fixture                                    # local upstream on :4599
PROVIDERS_CONFIG=./config/providers.dev.json npm run dev
```

`config/providers.dev.json` points a `direct` provider and a `webextract`
provider at that fixture, so you get a populated catalogue, a ranked source
list, quality/language badges and subtitle tracks — the whole pipeline, no
internet required. The payloads are synthetic, so the player won't decode
video, but every request is real: manifests are rewritten, segments are
proxied and subtitles are transcoded exactly as they are in production.

Switch back to `config/providers.json` (the default) for real sources.

### Tests

The test suite exercises the real pipeline against a fixture upstream
(`test/fixtures/upstream.ts`) that serves genuine HLS (master + media + AES key
+ fMP4 init), DASH (SegmentTemplate + SegmentList + BaseURL), subtitles in
three formats, and an embed page that hides its media URL. Covered end to end:
manifest rewriting, byte-identical segment proxying, `Range`/`206`, AES keys,
DASH placeholder substitution, SRT/ASS/TTML → VTT, embed extraction, token
tampering, caching, and auth.

```
test/
  unit/         m3u8, mpd, subtitles, crypto, ids
  integration/  api (33 tests), auth (9 tests)
  fixtures/     a stand-in upstream CDN
```

---

## Licence

MIT.
