# Hamster Wheel — upstream research

**Date:** 2026-10-04 · **Scope:** find the best upstream engine for a third server (`hamster`)
**Requirements:** no multi-audio/multi-language needed · priority #1 = availability (title coverage), #2 = accuracy (correct title/episode match)

> **Status (2026-10-04):** the Hamster Wheel server and the two anime blog
> sources (Anime Dub Hindi, AnimeDrive) were **removed** from the product that
> same day — every one of them only resolved when a Node backend deployment
> existed, and the deployed product is a free-plan Cloudflare Worker with no
> Node tier. Their release hosts are additionally unreachable from Cloudflare
> egress (`4khdhub.one` IP/ASN-banned, `hubcloud.ist` behind a Turnstile wall,
> `4khdhub.click` error 1016). This document is kept as the research record
> (why these sites, what was reachable, codec/season traps) in case a real
> host ever becomes available — the removal is a revert away in git history.

---

## TL;DR

1. **CinePro Core is dead.** Last code commit **2026-05-27**; issue [#62](https://github.com/cinepro-org/core/issues/62) (open) says *"CinePro/Core is undergoing a rewrite. None of the functionalities are promised to work. ETA ~4 Weeks"* (posted 2026-06-18, never landed). In the same thread a maintainer writes *"I can only suggest switching to Mediamash until CinePro is back up again"* and *"[@omss/framework] is deprecated. I am working on @omss/core"*. License is **PolyForm Noncommercial** — a blocker for anything commercial anyway.
2. **Videasy is dead too.** NiakVIO's automated provider census marks `videasy` **⚫ DISABLED — `provider_network_http_error` on both movie and TV lanes**, note: *"keep disabled until a new authoritative provider address/backend is qualified"*. The Aug-2026 reports that Videasy/VidKing were shutting down are confirmed by a second, independent source.
3. **The live successor to CinePro Core is [`Mediamash-org/backend`](https://github.com/Mediamash-org/backend)** — MIT, TypeScript, **OMSS-compliant HTTP API** (same shape the CinePro integration plan assumed), 15 providers, Docker, admin enable/disable/health. I cloned it and **verified locally that it installs, type-checks clean, boots (v1.1.0), registers 15 providers and serves the OMSS routes**.
4. **The only source of truth for "which site actually plays today" is the [`niakw/NiakVIO`](https://github.com/niakw/NiakVIO) provider census** — a GPLv3 provider layer for Nuvio clients that runs automated playback verification + repair across 46 providers and republishes a status table. As of the latest run: **21 FULL OK · 3 PARTIAL · 2 CANDIDATE · 10 ROUTE PROVEN · 2 CHAIN REACHED · 1 NO PROOF · 2 REGRESSION · 5 DISABLED**.
5. **Max availability = Mediamash as the host + curated providers from the census**, not any single repo's bundled provider list. Mediamash's own default set (`netmirror, 2embed, bingr, filmo, pikashow, vaultplayer, vidcore, videasy, dulo, hdmovie2`) does **not** include the census-proven 2026 sites (`playimdb, purstream, streamzo, movieshunt, hindmoviez, coflix, kehflix, papadustream, wookafr`).

---

## 1. The graveyard (do not build Hamster Wheel on these)

| Project | State (2026-10-04) | Why it fails the brief |
| --- | --- | --- |
| [`cinepro-org/core`](https://github.com/cinepro-org/core) | last commit **2026-05-27**, rewrite promised, open "Providers not working" issue, framework deprecated | stale engine, **PolyForm Noncommercial** license, maintainer-endorsed successor exists |
| Videasy (`player.videasy.to`, `api.speedracelight.com`) | **DISABLED** in NiakVIO census (`provider_network_http_error`, movie+tv) | single-embed dependency, now dead; successor domain not qualified |
| VidKing / Cineby family | cineby shut down; VidKing unverifiable (NXDOMAIN from here) | dead / unknown |
| `simoabid/cineflix-core` | CinePro **fork**, 44 providers, last commit **2026-07-28**, 3★ | it is the dead CinePro architecture + PolyForm-ish license, just with more providers |
| `rathod-ramraj/cinebridge` | CinePro fork, 17 providers, last commit **2026-08-08**, 0★ | same |
| Raw public embed scrapers (vidsrc.xyz/.cx/.me, vidbinge, vidcore-old, etc.) | see curated lists — many dead/bot-walled | no accuracy guarantees, no TMDB keying, high rot |

**Lesson:** every repo in this lineage freezes the moment its author stops. Anything that is "a repo with 17–44 hardcoded scrapers" has a half-life measured in weeks. Only the *ecosystems with automated verification/repair* still work.

---

## 2. What is actually alive

### 2.1 `Mediamash-org/backend` — the CinePro Core successor (recommended host)

- **License: MIT** (`LICENSE`, "Copyright (c) 2026 MediaMash contributors") — unlike CinePro's PolyForm Noncommercial. Note `package.json` says `"license": "None"`; the LICENSE file and GitHub agree on MIT.
- Node 20+/TypeScript, built on `@omss/framework`, follows the official OMSS spec (`https://omss.mintlify.site/`).
- Last push **2026-08-24**, releases **v1.0.1 → v1.0.4**, Dockerfile + `docker-compose.yml`/`docker-compose.prod.yml`, tests (vitest), admin UI (`/ui`), `/admin/providers{,/health}` + enable/disable/reload, optional Stremio addon + MCP.
- **Verified locally (2026-10-04, this workspace):** `npm ci` OK → `tsc --noEmit` OK → server boots as **v1.1.0** with **15 registered / 11 enabled providers** and answers:
  - `GET /v1/movies/{tmdbId}`
  - `GET /v1/tv/{tmdbId}/seasons/{s}/episodes/{e}`
  - `GET /v1/proxy?data=…`, `GET /v1/refresh/{responseId}`, `GET /admin/providers`
- **Providers shipped (15):** `netmirror, 2embed, bingr, filmo, pikashow, vaultplayer, vidcore, videasy, dulo, hdmovie2, peachify, vidsrc, streamingunity, example, sample`
  - ON by default: netmirror, 2embed, bingr, filmo, pikashow, vaultplayer, vidcore, videasy, dulo, hdmovie2
  - OFF by default (enable as needed): peachify, vidsrc, streamingunity
- Notables for this project: **HDMovie2** (Hindi/Bollywood focus, `preferHindi`) and **Dulo** (TMDB-keyed HLS) map well to the audience; **NetMirror** overlaps the existing Andromeda tier (dedupe needed).
- Weaknesses: tiny project (2★), AI-assisted development (Cursor co-authors), `videasy` provider is dead weight, provider upstreams may rot without anyone noticing.

### 2.2 Nuvio provider ecosystem — the breadth tier

- [`NuvioPlugin/All-in-One-Nuvio`](https://github.com/NuvioPlugin/All-in-One-Nuvio): **66 provider modules**, 161★, pushed **2026-10-02**. Contract (per the mirror README):
  `getStreams(tmdbId, type, season, episode)` → `[{ url, quality, headers | behaviorHints.proxyHeaders.request, … }]`.
  Modules are self-contained JS (fetch + their own decryption; e.g. `videasy.js` contains its own AES/RC4-style `decryptWingsDatabase` and a hardcoded TMDB key used to resolve `title/year/imdbId`).
- [`ktsevents/nuvio`](https://github.com/ktsevents/nuvio): auto-mirror of that `providers/` dir, **syncs every 6 h**, repo pushed **today**. Ships `nuvio_active.json` (17 enabled: `animezey, castle, cineby, einthusan, goated, hindmoviez, kisskh, movieblast, movix, netmirror, playimdb, purstream, uhdmovies, videasy, vidfast, vidlove, zinkmovies`).
  - ⚠️ "active" = enabled in the manifest, **not** verified-playing.
- License: **GPLv3**, upstream text says "educational purposes only"; code is minified/obfuscated (executes fine, painful to debug), and many modules assume browser-like transports/residential egress for Cloudflare/DDoS-Guard sites.
- Verdict: best ceiling for coverage (66 modules, hot-fixed by a big community, zero API keys), but it is a *client-app* provider bundle, not a server. Usable server-side via a thin Node runner + WAF-tolerant fetch, at the cost of license/opacity/transport work.

### 2.3 `niakw/NiakVIO` — the liveness oracle (GPLv3, pushed today)

Not a server: a Nuvio **provider layer** (46 "Hub Provider Objects") with a CI "BRAIN" that probes playback, classifies failures (`provider_waf_challenge`, `provider_network_http_error`, `provider_network_zero_result`, …), repairs, and republishes:
[`PROVIDER_CENSUS_STATUS.md`](https://github.com/niakw/NiakVIO/blob/main/PROVIDER_CENSUS_STATUS.md), `HUB-LAB-MATRIX-46.md`, provider repair/brain memory files.

**Use it as the shopping list:** it tells you which sites are worth porting *today* — which is exactly the work CinePro's dead provider list can't do.

### 2.4 Others checked (and why they are not the engine)

| Project | What it is | Verdict |
| --- | --- | --- |
| [`smy778/EncDecEndpoints`](https://github.com/smy778/EncDecEndpoints) (102★, last commit **2026-10-03**) | samples + hosted crypto API `enc-dec.app` (`enc/dec-vidfast`, `dec-videasy`, `enc-vidlink`, `dec-videasy` … , 40 req/s) for the current embed generation | accelerator, not an engine: closed-source crypto, third-party dependency, and its crypto is now partly embedded in the Nuvio modules themselves |
| [`omss-spec/core`](https://github.com/omss-spec/core) (MIT, beta, 2026-09-10) | official TypeScript runtime/plugin orchestrator replacing the deprecated `@omss/framework` | the future substrate for an OMSS host; too beta to pick today over Mediamash |
| [`simoabid/cineflix-addons-core`](https://github.com/simoabid/cineflix-addons-core) (2026-09-09) | OMSS-compliant backend that turns **any Stremio addon** into an OMSS provider; debrid (Real-Debrid/AllDebrid/Premiumize) resolution; optional residential egress proxy | interesting breadth path, but relies on debrid accounts for torrent-style addons and is 2★ |
| [`NivinCNC/CNCVerse-Bridge`](https://github.com/NivinCNC/CNCVerse-Bridge) (143★, Kotlin, alpha, all rights reserved) | runs **CloudStream extensions** as a Stremio/Nuvio addon from a local server (Android APK / Windows MSI), WebView for CF bypass | proves the CloudStream ecosystem is the deepest source pool, but it is an end-user app, not a datacenter service |
| `@omss/framework` | deprecated by its own author | migrate target is `@omss/core` |

---

## 3. Provider census — what actually plays (NiakVIO, latest run ≈ late Sept 2026)

Real playback verified ("retained proof" = a specific title that played):

| Status | Movie/TV providers | Notes |
| --- | --- | --- |
| 🟢 **FULL OK** | `castle`, `coflix`, `hindmoviez`, `kehflix`, `movieshunt`, `papadustream`, `playimdb`, `purstream`, `streamzo`, `wookafr` (+11 anime: anikototv, anime-sama, french-manga, kurage, mugiwarastream, neko-sama, sekai, voiranime×3, vostfree) | verified with Interstellar / Breaking Bad / Sinners |
| 🟡 **PARTIAL OK** | `vidlove` (tv only), `vidrock` (movie only), `persianstremio` (movie only) | |
| 🟪 **ROUTE PROVEN** | `4khdhub`, `flemmix`, `moviebox`, `moviesmod`, `vidfast`, `yflix` | routes reachable, terminal media not verified |
| 🟣 **CHAIN REACHED** | `allanime`, `mallumv` | |
| 🔵 NO PROOF | `allwish` | |
| 🔴 REGRESSION | `uhdmovies`, `animekai` | |
| ⚫ DISABLED | `videasy`, `showbox`, `desiflix`, `animetsu`, `fullanime` | |

Also note: `castle` being FULL OK is consistent with the existing Andromeda tier (CastleTV), so it is not new coverage for us.
Common failure modes are **WAF challenges** and **network errors**, not code bugs — i.e. most of these sites require browser-like TLS/JS or residential IPs. Datacenter-hosted instances will fail some of them even if the code is perfect.

---

## 4. Recommendation

**Hamster Wheel = self-hosted OMSS service (Mediamash) + a curated, census-driven provider set.**

Why this satisfies "most availability + accuracy, no multi-audio":

- **Accuracy by construction:** request is TMDB-id keyed (`/v1/movies/{tmdbId}`, `/v1/tv/{id}/seasons/{s}/episodes/{e}`), same accuracy class as the existing NetMirror tier; no title-string matching.
- **Availability by fan-out:** one HTTP call fans out to every enabled provider and returns `sources[] + subtitles[] + diagnostics[]`, so a dead provider degrades into a diagnostic instead of a failure.
- **Coverage grows the easy way:** adding a site = adding a `BaseProvider` plugin (`getMovieSources`/`getTVSources` → `{ sources, subtitles, diagnostics }`), so the census's FULL OK list becomes a backlog.
- **No multi-audio work:** HLS/progressive sources are accepted as-is; skip `multitrack` for this server.
- **License-safe:** host is MIT; only *if* LOL Embed ever becomes commercial does the provider-plugin question matter.

### Tier plan

| Tier | What | Why |
| --- | --- | --- |
| **A (day 1)** | Mediamash OMSS container; enable `netmirror`(dedupe), `2embed`, `bingr`, `filmo`, `pikashow`, `vaultplayer`, `dulo`, `hdmovie2`; disable `videasy` | verified boot, API-shaped, covers Hindi + Hollywood |
| **B (coverage)** | Port the census FULL OK sites that are not already covered (`playimdb`, `purstream`, `streamzo`, `movieshunt`, `hindmoviez`, `kehflix`, `papadustream`, `coflix`, `wookafr`) as Mediamash plugins | this is where "most availability" actually comes from in Oct 2026; use Nuvio modules as reference implementations |
| **C (optional breadth)** | Node runner over the 6-hourly Nuvio mirror (66 modules) as a last-resort tier | max ceiling, but GPLv3 + obfuscated + WAF/residential transport work; add only if A+B under-deliver |

### Integration sketch (this repo)

1. `src/services/serverCatalog.js` — add:
   ```js
   { id: 'hamster', name: 'Hamster Wheel', badge: 'Max Coverage • TMDB-Keyed', priority: 3, enabled: true,
     supportsMultiAudio: false, fallback: true }
   ```
2. `src/services/resolver.js` — new `resolveHamsterWheel(metadata)`:
   `GET ${HAMSTER_OMSS_URL}/v1/movies/{tmdbId}` or `/v1/tv/{tmdbId}/seasons/{s}/episodes/{e}` →
   pick the best `sources[]` entry (resolve/quality rank, prefer HLS) → wrap with the existing
   `buildProxyStreamUrl` so the player keeps talking to our `/api/proxy` only.
3. `resolveStreamForServer()` (~line 2364) — add `else if (srvId === 'hamster')`, and mirror the branch in
   `cloudflare-worker/worker.js` (~line 2880) **or** have the Worker call the Node backend for this tier
   (Workers can't run FFmpeg and are IP-blocked by some upstreams).
4. Env: `HAMSTER_OMSS_URL`, `HAMSTER_OMSS_TIMEOUT_MS`, `HAMSTER_OMSS_SECRET` (if a gateway is added).
5. Health: add the OMSS `/` health probe to `/api/health`; reuse the existing circuit breaker so a dead
   Hamster Wheel never slows the waterfall.

### Non-negotiables learned from this research

- Do **not** resurrect the CinePro plan as-is (dead code + PolyForm license).
- Do **not** build anything on Videasy or on single public embeds — verify a candidate in the census/community chatter first.
- Re-check the ecosystem every ~4–6 weeks; nothing in this space survives a quarter untouched.

---

## 5. What could NOT be verified from this workspace

- **No live playback test of any provider.** Sandbox egress blocks every provider host (`net27.cc`, `api.bingr.one`, `dulo.cx`, `filmo.to`, `hdm2.ink`, `peachify.top`, `vidcore.org`, `streamingunity.vip`, `vaultplayer.co.uk`, `manoda.co`, `2embed.online`, `api.speedracelight.com` → all `000`) and embed hosts (DDoS-Guard / IPv6-only / NXDOMAIN). Do not retry probing from here.
- **Verified:** Mediamash installs, type-checks, boots, registers providers, serves the OMSS + admin routes (`npm ci` → `tsc` → boot log → curl, captured 2026-10-04).
- **Not verified:** GHCR image availability (ghcr.io unreachable here), real success rate of each provider from a normal host, and the current quality of Tier-B sites.

**Decisive next experiment (5 minutes, on your own host):**
`docker compose up` the Mediamash backend, then
`curl -s localhost:3000/v1/movies/693134 | jq '.diagnostics, [.sources[].url]'`
— the diagnostics tell you exactly which providers work from *your* network before you wire anything.

---

## 6. Hindi sources — reliability ranking (added 2026-10-04, after user testing)

Context: the first domain set handed to the user for testing was **stale** (sites rotate domains every few weeks). Two live domain lists now drive this work:

- [`MrXtron/CloudStream-Extension`](https://github.com/MrXtron/CloudStream-Extension) — Hindi-focused CloudStream repo, commits **daily** ("hdmovie2 updated", "MovieBox Fixed", "All domains are up to date"). Machine-readable list at [`Files/domains.json`](https://github.com/MrXtron/CloudStream-Extension/blob/main/Files/domains.json).
- `niakw/NiakVIO` census (playback verification).

### Current (2026-10-04) domains

| Site | Current domain | Old / dead |
|---|---|---|
| HDMovie2 | `https://hdmovie2a.click` | newhdmovie2.beer |
| HindMoviez | `https://hindmovie.dev` | mvlink.blog |
| ZinkMovies | `https://new2.zinkmovies.mobi` | gemma416okl.com |
| Movies4u | `https://new1.movies4u.garden` | m4uplay.store |
| HDHub4u | `https://new1.hdhub4u.free` | — |
| Bollyflix | `https://new.bollyflix.vote` | — |
| VegaMovies | `https://vegamovies.gallery` | — |
| 4KHDHub | `https://4khdhub.one` | — |
| MovieBox | `https://moviebox.ph` | — |
| Pikashow | `https://manoda.co` (fallback `samui390dod.com` — reported down) | — |
| Others | `multimovies.casa`, `rogmovies.best`, `dudefilms.date`, `m4ulinks.site`, `tellyhd.im` | — |

**Design consequence:** do not hardcode these. Fetch `Files/domains.json` (updated daily) at boot/cron and resolve Indian providers against whatever the current domain is.

### Top 3 most reliable (ranked)

1. **MovieBox — `api{3,4,4sg,5,6}.aoneroom.com` + `h5-api.aoneroom.com`**
   - API-first (HMAC-signed mobile BFF), no HTML scraping → immune to site redesigns, only key/endpoint rotations.
   - **Already in this stack**: the NetMirror plugin fetches dub metadata from `h5-api.aoneroom.com`.
   - Ecosystem: [`mesamirh/MovieBox-TUI`](https://github.com/mesamirh/MovieBox-TUI) (2.4k★, pushed 2026-10-03, Apache-2.0); 3+ wrapper repos updated within 48h.
   - Hindi dubs + captions; MP4/HLS/DASH (mobile BFF path gives real CDN DASH via `signCookie`).
   - Risks: free-tier web play can be ~480p; search is title-based → needs year/IMDb scoring.

2. **HindMoviez — `hindmovie.dev`**
   - The **only Hindi-focused site with independently verified playback**: 🟢 FULL OK (movie+tv) in the NiakVIO census, retained proof Interstellar / Breaking Bad.
   - Provider matches on **IMDb id + title** → good accuracy.
   - Risks: Cloudflare/WAF; release-host pipeline (hubcloud-style) needs unrolling.

3. **4KHDHub — `4khdhub.one`**
   - Deepest Indian catalog (new Bollywood + South Hindi-dubbed, 480p→4K), used by `Shawon727/StreamHub-Api` `/fk/*` and the Hindi CloudStream repo.
   - Census: 🟪 ROUTE PROVEN (routes live; terminal media unverified in the last run).
   - Risk: hubcloud/hubdrive resolve chain adds latency and failure points.
   - **Conditional swap:** if Pikashow's `manoda.co` test passes, it outranks this — JSON catalog API with HMAC play URLs beats scraping.

### Reference implementations worth borrowing

- `Shawon727/StreamHub-Api` (MIT, updated 2026-10-03): `/mb/*` MovieBox, `/anime/*` HindiAnime **with HLS proxy**, `/fk/*` 4KHDHub→HubCloud resolve, `/pb/stream` (vidstuck/vidfast/roxy/bingr/nxsha).
- `faisaljs/Moviebox-API`: pure REST wrapper over `h5-api.aoneroom.com` (catalog, streams, captions).

---

## 7. Implementation (2026-10-04) — what shipped in this repo

Server #3 is wired end to end:

| File | Change |
|---|---|
| `src/services/hamster.js` | **New.** Three providers behind one candidate list: `moviebox` (HMAC-signed mobile BFF), `hindmoviez` (hindmovie.dev → gdshine `via-worker`), `4khdhub` (4khdhub.one → HubCloud/HubDrive/GreenMotors/PixelDrain). Rotating domains via `HAMSTER_DOMAINS_URL` (30 min cache). Per-provider circuit breakers (`hamster:<id>`). |
| `src/services/resolver.js` | `resolveHamsterServer()` — unrolls release links with the existing HubCloud machinery, probe-checks each candidate with a ranged GET, ranks Hindi-first, groups audio into player tracks, remuxes MKV via the existing multitrack path on Node. New `srvId === 'hamster'` waterfall branch. |
| `src/services/serverCatalog.js` | `hamster` entry: *Hamster Wheel* — `Hindi First • Multi-Audio • Max Coverage`, priority 3, `supportsMultiAudio: true`. |
| `cloudflare-worker/worker.js` | `resolveHamsterUpstream()` — delegates to the Node backend when `HAMSTER_BACKEND_URL` is set; otherwise the server is skipped with `hamster_backend_not_configured`. |
| `src/routes/api.js` | Hamster-specific failure explanations in the resolve error payload. |
| `src/config.js`, `.env.example`, `wrangler.toml` | `HAMSTER_*`, `MOVIEBOX_*`, `HINDMOVIEZ_*`, `FOURKHDHUB_*`, `HAMSTER_BACKEND_URL` settings. |
| `test/hamster.test.js` | 14 offline checks: parsers (both scrapers), quality/audio/kinds, PixelDrain + gdshine id handling, ranking, MovieBox signature contract and subject picker, kill switch. |
| `test/verify.js` | Catalog/waterfall expectations updated for the third server; the suite disables the fan-out so it stays hermetic. |

Verification done here: `npm test` passes (verify suite + 14 hamster checks);
the Node backend boots and `/api/health` lists `["andromeda","centaurus","hamster"]`;
a network-blocked `/api/resolve/movie/693134?server=hamster` returns the
documented graceful failure with per-provider diagnostics
(`4khdhub:fetch failed, hindmoviez:fetch failed, moviebox: MovieBox upstream failed`)
and then falls through the waterfall to the other servers.

**What still needs a real network (your box):** provider liveness. Sandbox egress
cannot reach any of these hosts. Run the backend and:

```bash
curl -s "localhost:3000/api/resolve/movie/693134?server=hamster" | jq '.stream.server, .stream.sourceName, .stream.audioTracks, .stream.quality'
curl -s "localhost:3000/api/resolve/tv/1396?season=1&episode=1&server=hamster" | jq '.ok, .failedReason, .serverAttempts'
```

If a provider is dead, its diagnostic string names it
(`moviebox:MovieBox upstream failed (api6...->403)`, `hindmoviez:HTTP 403`,
`4khdhub:fetch failed`), and the domain override env vars let you point it at a
working mirror without a code change.

---

## 8. 4KHDHub extractor — v2 (2026-10-04, after the first live test)

The v1 extractor read `.download-item` links straight off the title page and
handed HubCloud URLs to the Centaurus unroller. That produced **no raw link**,
because the site's current flow is three hops deeper:

```
search ?s=title+year
  → .movie-card (format/year/title filters)
  → title page .download-item / .episode-item .episode-download-item
  → hblinks.* (or hubstream.dad) link-list page
        ↳ links may be a redirect wrapper: base64 → base64 → rot13 → base64 → JSON.o
  → hubcloud.<tld>/drive/<id> … or hubdrive → (HubCloud link) → same
  → page with `var url = '…'`  → mirror page
  → raw mirrors: 10Gbps / PixelServer, R2 (*.r2.dev), ZipDisk (*.workers.dev), FSL, PixelDrain
```

v2 ports that whole chain (`src/services/hamster.js`):

- `decodeReleaseRedirect()` — undoes the base64×2 → rot13 → base64 wrapper.
- `parseHblinksPage()` / `extractHblinksLinks()` — walks link-list pages, recursing
  up to depth 2, routing each link to HubCloud/HubDrive/direct by host.
- `extractHubCloudLinks()` — follows the `var url = '…'` indirection, then reads
  the mirror page; HubDrive pages hop to their HubCloud link first.
- `parseHubCloudFinalLinks()` — keeps 10Gbps/PixelServer/zips/FSL/R2/workers.dev
  anchors, rewrites PixelDrain to `/api/file/<id>?download`, and also scrapes bare
  media URLs printed as text.
- Search walks **every known base** (`domains.json` value, then
  `FOURKHDHUB_BASE_URL`, then `4khdhub.one`/`4khdhub.click`) and reports a
  per-base failure string when none answers, instead of a silent empty result.
- Series support: `S01` / `Episode-01` matching inside `.episode-item`.
- Title matching is deliberately tight (exact/contained, else ≤2 edits for short
  titles) so *Jawan* can never resolve to *Pathaan*.

New debugging surface — this is how to answer "is it giving raw links?" without
reading logs:

```bash
curl -s "localhost:3000/api/admin/hamster/diagnose/movie/693134?key=$ADMIN_SECRET" | jq
# → { providers: [{id, ok, ms, count, diag}], candidates: [{provider, url,
#     kind, quality, audio, playable, probeStatus, probeContentType, ms}] }
```

`playable: true` with a `probeContentType` of `video/*`, `application/octet-stream`
(or a container magic hit) means the raw link is real. A candidate with
`playable: false` and `probeStatus: 403` is a host-side block, `probeStatus: 200`
with `probeContentType: text/html` means the extractor picked a page instead of a
file — both are visible per candidate, per provider.

---

## 9. Hindi-dub anime — research (2026-10-04)

Verdict: **one source is raw-extractable, the two biggest ones are iframe-only.**
The differentiator is the same as everywhere else in this project: *where does the
file actually live.*

| Source | Catalog | Where the video lives | Raw link? | Effort to add |
|---|---|---|---|---|
| **Anime Dub Hindi** (`animedubhindi.link`, was `.cc`/`.me`) | anime series + movies, Hindi/Tamil/Telugu/English/Japanese multi-audio | WordPress post → `new.adhlinks.com/episode/<slug>/` → per-episode mirrors: **Hcloud (`hubcloud.ist/drive/…`)**, **GDF (`gdflix.dev/file/…`)**, MEGA/Multi (base64 redirect), Fprs (`fpgo.xyz`) | ✅ **Yes** via HubCloud (already in this repo) + a small gdflix resolver | ~150 lines + gdflix (~40) |
| **HindiAnime** (`hindianime.site`, StreamHub `/anime/*`) | **93 movies + 411 series** (live `api/catalog.json`) | Catalog entries carry `streamUrl: https://streamtape.com/e/…` — **Streamtape iframe**; some series expose `videoHash` → their own `/api/proxy/master.m3u8` (zephyrix/p2p, often 404) | ❌ **No** — Streamtape `get_video` is IP-locked/rotating, no reliable server-side raw extraction | not worth it |
| **ToonHub4u** (`toonhub4u.live`, MrXtron `ToonHub`) | Hindi/Tamil/Telugu toons + anime | Site states it only *indexes* third-party links | ❌ iframe | skip |
| **AnimeDekho** (`animedekho.app`) | Hindi + multi-audio anime | AbyssPlayer / FileMoon / StreamWish, resolved through **`enc-dec.app/api/dec-*`** (third-party crypto API) | ⚠️ possible (m3u8) but depends on someone else's service | medium |
| **WatchAnimeWorld / AniPlayz** (`watchanimeworld.one`) | same operator as the HindiAnime catalog | same Streamtape pattern | ❌ | skip |

### Verified from this workspace (no guessing)
- `https://www.hindianime.site/api/catalog.json` → **live**, `totalMovies: 93`, `totalSeries: 411`, and every movie sample carries a `streamtape.com/e/…` URL.
- `https://www.animedubhindi.link/` → **live** (the `.me` domain now shows "We Have Moved → animedubhindi.link").
- `https://new.adhlinks.com/episode/bluebox-s2/` → episode rows with plaintext **`hubcloud.ist/drive/…`** and **`gdflix.dev/file/…`** links per quality (480p x264 / 720p x264 / 1080p x265 10bit / 1080p x264 HQ), plus `redirect.php?data=` / `re.php?data=` wrappers whose payload is **not** plain nested base64 (needs the page's `s('o',…)`/`ck('_wp_http_…',…)` + rot13 chain) — so prefer the Hcloud/GDF columns.
- `toonhub4u.live` → states "does not host any content… indexes links".
- DNS resolves for `animedubhindi.link`, `new.adhlinks.com`, `hubcloud.ist`, `gdflix.dev`, `fpgo.xyz`, `desidubanime.me`.

### Codec trap (important for anime)
The Anime Dub Hindi mirrors are largely **x265 10-bit MKV**. Browsers generally
cannot decode HEVC 10-bit inside MKV (Chrome needs hardware HEVC, and MKV still
needs remuxing on Node). Ranking must prefer **x264/AVC** releases and only fall
back to x265 when nothing else plays — otherwise the resolver reports success
while the player shows a black frame.

### Shipped as Centaurus source #2 (2026-10-04)

It went to server 2 rather than Hamster Wheel, as a second source behind HiCine:

| Piece | Where |
|---|---|
| Parsers + scoring | `src/services/animedubhindi.js` (pure, no network, unit-tested) |
| Source resolver | `resolveAnimeDubHindiSource()` in `src/services/resolver.js` |
| Two-source fan-out | `resolveCentaurusServer()` — HiCine, then Anime Dub Hindi |
| GDFlix unroll | `unrollGdflixUrl()` / `resolveGdflixInstant()` in `resolver.js` |
| Config | `config.animedubhindi.*` ← `ANIMEDUBHINDI_*` (.env.example) |
| Tests | `test/animedubhindi.test.js` (19 checks incl. a mocked full pipeline) |
| Diagnostics | `GET /api/admin/centaurus/diagnose/:type/:tmdbId?season=&episode=&key=` |
| Worker | delegates via `ANIMEDUBHINDI_BACKEND_URL` (falls back to `HAMSTER_BACKEND_URL`), `?source=animedubhindi` pins the source |

Flow actually implemented: WordPress search (`/?s=`) → post match on **title +
season** → post page → adhlinks `/episode/<slug>/` (slug followed, never built) →
`Episode: NN` block for the requested episode → per row **HubCloud first, then
GDFlix** → unroll + probe → payload (Hindi default track; MKV → Node HLS remux).

Parsing notes discovered while building:
- Two live row formats exist: `[480P x264]💾 106.72 MB` (S1 posts) and
  `480P x264 [Size: 107mb]` (S2 posts), and host labels rotate
  (`Hcloud`/`HubCloud`, `GDF`/`GDFlix`, plus `FileBee` on newer posts and `Fprs`
  on older ones). Only the resolution marker is required; the rest is optional.
- `new.adhlinks.com/page-not-found/` answers **HTTP 200**, so a soft-404 check is
  mandatory before parsing rows.
- Slugs are not derivable: Blue Box Season 1 is `/episode/blubox-s1/` (typo).
- Rows must be ranked **x264 before x265 10bit** regardless of resolution — the
  1080p mirror is usually HEVC 10-bit MKV, which browsers frequently refuse.
- MEGA (`/redirect.php?data=`) and Multi (`/re.php?data=`) wrappers are not plain
  nested base64; they are skipped in favour of HubCloud/GDFlix.

**GDFlix verified live** (`gdflix.dev/file/<id>` → `new4.gdflix.io`):
`Instant DL [10GBPS]` → `instant.busycdn.xyz/<hash>::<hash>?bytes=<n>` → 302
`Location: …?url=<direct file>.mkv`; the page also offers `DIRECT SERVER [MGT]`
(`light.indexserver.site/…`), `FAST CLOUD / ZIPDISK` (`/cloud/…`, one more page)
and a Google Drive `#gdlink` target (skipped: needs a confirm-token dance).
Reference implementations: `yogesh-hacker/MediaVanced::sites/gdflix.py` (instant
anchor → `allow_redirects=False` → `Location.split('?url=')[-1]`) and
`mnsrulz/nurlresolver::src/libs/gdflix.ts` (older POST `{action:'direct',key}`
flow with `x-token` — not needed while the GET path works).

---

## 10. Second Hindi-dub anime source — AnimeDrive (2026-10-04)

User asked for one more Hindi-dub anime source inside server 2 (the last one).
Candidate scan (all fetched live 2026-10-04):

| Site | Verdict | Why |
|------|---------|-----|
| **animedrive.cc** | **shipped** | WordPress search works; posts link to `link.animedrive.cc/<date>/<slug>/`; every release row is a `dl/<base64url(reverse(url))>` wrapper decoding to HubCloud or GDFlix — both already unrolled by this repo. Carries x264 480p/720p/1080p (not HEVC-only). |
| hindianimeszone.com (hindianimezone.me redirects there) | rejected | Episode rows point at `002.hindianimeszone.com/download1.php?code=…&q=…`; the download hop is a Cloudflare Turnstile interstitial ("Authorization valid for 1 hour"). Not automatable. |
| gokuhd.com | rejected | Search is client-rendered ("Searching database…" with an empty DOM). Only usable with hand-collected post URLs; not worth it next to AnimeDrive. |
| morimoflix.xyz | rejected | Search works but the Blue Box entry is `S01 1080P … English/Japanese` — no Hindi row; the site is a members-library front-end, not a release blog. |
| puretoons.in | rejected | Search returns cartoons only; no Hindi-dub anime rows. |

**Verified facts about AnimeDrive**

- Search: `https://animedrive.cc/?s=<title>` → one WP post per season
  (`/blue-box-season-2-hindi-download/`, `/that-time-i-got-reincarnated-as-a-slime-season-4-hindi-download/`, …).
  Posts carry the season in the title (`Season 2`, `Season 4`), so the same
  title+season matcher as Anime Dub Hindi works.
- Post → exactly one CTA, `Download / Watch`, to
  `https://link.animedrive.cc/<yyyy>/<mm>/<dd>/<slug>/` (e.g.
  `link.animedrive.cc/2026/06/18/that-time-i-got-reincarnated-as-a-slime-season-4-hindi-english-japanese-multi-audio-web-dl-episodes-download/`).
- Landing page: `EP 01` … `EP NN` accordions; each has a ☁️ HubCloud group and a
  🟣 GDFlix group with four rows —
  `480p x264`, `720p x264`, `1080p x265 10bit`, `1080p x264` (sizes vary per
  episode; e.g. 104mb / 174mb / 395mb / 1.50GB). A full-season ZIP block is
  promised "once airing completes".
- Every row is
  `https://link.animedrive.cc/dl/<payload>?t=<title>&q=<quality label>` where
  `payload = base64url(reverse(target URL))`. Decoded live examples:
  EP01 HubCloud 480p `MmN1Zm50Mm4yNndlb3RlL2V2aXJkL3RzaS5kdW9sY2J1aC8vOnNwdHRo`
  → `https://hubcloud.ist/drive/etoew62n2tnfuc2`; EP01 GDFlix 480p
  `NUNJMGpJcjZVbmRnYXBLL2VsaWYvdmVkLnhpbGZkZy8vOnNwdHRo`
  → `https://gdflix.dev/file/KpagdnU6rIj0IC5`.
- Rows this repo will not serve are counted in diagnostics and skipped:
  Send.cm, FuckingFast, 1Fichier, StreamTape, StreamWish.
- The two hosts are the *same* hosts Anime Dub Hindi publishes to, so no new
  unroller was needed — only a parser for the page + wrapper (this module
  deliberately classifies the host **after** decoding, so a rotated mirror
  domain still resolves).

**Shipped implementation**

| Piece | Where |
|-------|-------|
| Parser + wrapper decoder + episode/row grouping | `src/services/animedrive.js` (`decodeDlUrl`, `parseRowLabel`, `parsePostLink`, `parseEpisodePage`, `selectRowsForEpisode`, `languagesFromText`; reuses the Anime Dub Hindi text walker/ranking helpers) |
| Resolver source #3 (`search → post → landing → rows → unroll+probe → payload`) | `src/services/resolver.js` (`resolveAnimeDriveSource`, wired into `resolveCentaurusServer` + `diagnoseCentaurus`; `?source=animedrive` pins it) |
| Worker delegation + admin probe | `cloudflare-worker/worker.js` (`resolveAnimeDriveUpstream`, falls back `ANIMEDRIVE_BACKEND_URL → ANIMEDUBHINDI_BACKEND_URL → HAMSTER_BACKEND_URL`) |
| Config / env | `src/config.js` `animedrive` block; `.env.example` `ANIMEDRIVE_*`; `wrangler.toml` |
| Tests | `test/animedrive.test.js` (15 checks: live wrapper token, row labels, host filtering, episode strictness, mock pipeline for both hosts, pinned-source) |

Reasoning rules are identical to Anime Dub Hindi: x264 outranks x265 10-bit, a
missing episode returns nothing (never a neighbour/ZIP), and Hindi stays the
default audio hint.

---

## Sources

- https://github.com/cinepro-org/core · issues [#62](https://github.com/cinepro-org/core/issues/62), [LICENSE](https://github.com/cinepro-org/core/blob/main/LICENSE) · https://docs.cinepro.cc/
- https://github.com/Mediamash-org/backend (README, `config/providers.json`, `plugins/*`, releases v1.0.1–v1.0.4)
- https://github.com/NuvioPlugin/All-in-One-Nuvio · https://github.com/ktsevents/nuvio (`nuvio_active.json`)
- https://github.com/niakw/NiakVIO (`PROVIDER_CENSUS_STATUS.md`, `HUB-LAB-MATRIX-46.md`, `PROVIDER_REPAIR-V6.md`)
- https://github.com/smy778/EncDecEndpoints · https://enc-dec.app/status
- https://github.com/omss-spec/core · https://github.com/omss-spec/omss-spec
- https://github.com/NivinCNC/CNCVerse-Bridge · https://github.com/simoabid/cineflix-addons-core
- https://github.com/simoabid/cineflix-core · https://github.com/rathod-ramraj/cinebridge
- GDFlix reference flows: https://github.com/yogesh-hacker/MediaVanced (`sites/gdflix.py`) · https://github.com/mnsrulz/nurlresolver (`src/libs/gdflix.ts`)
- Anime Dub Hindi: https://www.animedubhindi.link/ · https://new.adhlinks.com/episode/blubox-s1/ (25-episode season) · https://new.adhlinks.com/episode/bluebox-s2/ (airing, S2 row format) · https://new4.gdflix.io/file/zObWX9waTYr4hN4 (GDFlix page)
- AnimeDrive: https://animedrive.cc/?s=blue+box · https://animedrive.cc/that-time-i-got-reincarnated-as-a-slime-season-4-hindi-download/ · https://link.animedrive.cc/2026/06/18/that-time-i-got-reincarnated-as-a-slime-season-4-hindi-english-japanese-multi-audio-web-dl-episodes-download/ (per-episode HubCloud/GDFlix rows)
