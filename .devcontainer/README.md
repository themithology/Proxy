# Real provider test in GitHub Codespaces

This environment tests the **actual provider pipeline from a GitHub-hosted machine**. It does not use `dev-player-mock.mjs`, mocked providers, generated test fixtures, Render, or the production Cloudflare media proxy.

GitHub personal accounts include free Codespaces usage without requiring payment details. Use the smallest machine and stop/delete the codespace when finished; this is a development test, not production hosting. See [GitHub's Codespaces billing documentation](https://docs.github.com/billing/managing-billing-for-github-codespaces/about-billing-for-github-codespaces).

## Open it

1. On GitHub, select this branch, then choose **Code → Codespaces → Create codespace on this branch**.
2. Wait for `postCreateCommand` and `postStartCommand` to finish. They install and start both Node processes automatically.
3. In **PORTS**, keep port **3000** set to **Private**. Open that forwarded port in the same browser where you are signed in to GitHub.
4. Go to the player path rather than the root URL:

   ```text
   /embed?type=movie&tmdb=693134
   ```

   Replace the TMDB id with the title you want to test. For TV, use for example:

   ```text
   /embed?type=tv&tmdb=94605&s=1&e=1
   ```

If setup is still running or the port is missing, run:

```bash
bash .devcontainer/setup.sh
bash .devcontainer/start.sh
```

## What is running

- **TMDB-Embed-API** on `127.0.0.1:8787`, with its own media proxy disabled. Its default test providers are `4khdhub`, `castletv`, `hdghartv`, and `dahmermovies`.
- **The real Worker player/API** through `scripts/dev-worker.mjs` on port `3000`. Only the static-asset binding is emulated; source resolution and media fetching are real.
- The Worker fetches the provider API over loopback. Provider extraction **and** `/api/proxy` media requests therefore originate from the Codespace, not Render or Cloudflare.
- **Original provider HLS is the preferred fast path.** The resolver settles on reliable native HLS/DASH without waiting for slower MKV extractors or speculative direct scraping. Native MP4 is next, MKV/movi remains a fallback, and the experimental ffmpeg MKV→HLS converter is disabled by default on this small Codespace.

To restart only the player after pulling a newer version of this branch (the existing Codespace and upstream can stay):

```bash
kill "$(cat /tmp/lol-embed-live/player.pid)" 2>/dev/null || true
bash .devcontainer/start.sh
```

The start script installs the ffmpeg/ffprobe packages if they are missing, but leaves conversion off unless you explicitly set `MKV_HLS_ENABLED=true`. That opt-in is experimental, not the normal playback path. `MKV_HLS_MAX_SESSIONS` defaults to `1` so simultaneous viewers cannot start unlimited encodes on the free machine.

## Experimental conversion (disabled by default)

- ffprobe reads the actual source height and audio streams. A 1080p source can produce 1080p/720p/480p variants; a 720p source produces only 720p/480p. It never upscales or adds cosmetic quality labels. The top transcode rung is capped at 1080p on this small host.
- Every source audio stream (up to eight) becomes an HLS audio rendition. The existing audio menu reads these real renditions; the quality menu reads the generated video levels.
- Output is a segmented VOD playlist under the host temporary directory, using 2-second segments to reduce the first-play wait. The first segment still requires conversion, and playback can buffer if the free CPU cannot encode faster than real time. A new conversion starts at the beginning instead of applying an old MKV resume timestamp. Seeking beyond the part converted so far must wait for ffmpeg; after conversion finishes, the whole playlist is seekable.
- The converter reads through the same-origin `/api/proxy` URL, preserving provider request headers. It does not accept an arbitrary third-party proxy URL.

To change the upstream provider list, stop the existing upstream process before restarting it:

```bash
kill "$(cat /tmp/lol-embed-live/upstream.pid)"
export LIVE_TEST_PROVIDERS='4khdhub,castletv'
bash .devcontainer/start.sh
```

`TMDB_API_KEY` and `FEBBOX_COOKIES` are optional Codespaces secrets for this test. Existing production secrets are not migrated by these scripts.

## Verify the actual result

A successful test means checking all of these in the browser, not merely seeing a process or mocked test pass:

1. A real provider source starts playback and can seek. With native HLS, confirm the original provider duration is visible immediately; do not mistake a short, still-growing generated playlist for a successful fast path.
2. The audio menu is populated from the loaded file/manifest and switching audio changes the audible track without reloading the whole source.
3. Quality rows correspond to real alternate files or HLS variants; selecting each generated rung changes the actual HLS level.
4. For HLS, the player rebuilds its quality menu from the levels hls.js actually discovers. `#EXT-X-STREAM-INF` indicates quality variants and `#EXT-X-MEDIA:TYPE=AUDIO` indicates audio renditions. If the menu contains only Auto plus one rung, inspect the original playlist: a media playlist containing only `#EXTINF` segments cannot provide a quality/audio ladder that the source does not have.
5. When native HLS is available, a fresh default resolve should report `"format":"hls"`, playback should not show **Converting MKV to HLS**, and `/tmp/lol-embed-live/player.log` should contain no new `[mkv-hls]` conversion. MKV/movi or explicit conversion is expected only when no usable native HLS is available or a selected audio track genuinely requires that file.

For diagnostics, add `?debug=1` to the player URL (or `&debug=1` when it already has a query string), then open **F12 → Console**. HLS failures appear as `[LOL Embed] HLS fatal error`; ffmpeg details are in `player.log` under `[mkv-hls]`. Non-converted sources can still emit `[movi:...]` and `[LOL Embed] movi ...` messages. Debug mode does not alter resolution or playback behavior.

Useful checks from the Codespace terminal:

```bash
# Upstream health and raw provider resolution
curl http://127.0.0.1:8787/api/health
curl 'http://127.0.0.1:8787/api/streams/movie/693134'

# The exact response consumed by the real player
curl 'http://127.0.0.1:3000/api/resolve/movie/693134?fresh=1'

# Logs
less /tmp/lol-embed-live/upstream.log
less /tmp/lol-embed-live/player.log
```

Opening this environment only prepares the live test; it is not evidence that a particular provider, MKV, HLS ladder, or audio track works. Record the actual browser result before deciding whether a VPS is necessary.
