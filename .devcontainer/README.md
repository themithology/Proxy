# Real provider test in GitHub Codespaces

This environment tests the **actual provider pipeline from a GitHub-hosted machine**. It does not use `dev-player-mock.mjs`, mocked providers, generated media, Render, or the production Cloudflare media proxy.

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

To change the upstream provider list, stop the existing upstream process before restarting it:

```bash
kill "$(cat /tmp/lol-embed-live/upstream.pid)"
export LIVE_TEST_PROVIDERS='4khdhub,castletv'
bash .devcontainer/start.sh
```

`TMDB_API_KEY` and `FEBBOX_COOKIES` are optional Codespaces secrets for this test. Existing production secrets are not migrated by these scripts.

## Verify the actual result

A successful test means checking all of these in the browser, not merely seeing a process or mocked test pass:

1. A real MKV starts playback and can seek.
2. The audio menu is populated from the loaded file and switching audio changes the audible track without reloading the file.
3. Quality rows correspond to real alternate files or HLS variants.
4. For HLS, the player now rebuilds its quality menu from the levels hls.js actually discovers. `#EXT-X-STREAM-INF` indicates quality variants and `#EXT-X-MEDIA:TYPE=AUDIO` indicates audio renditions. If the menu contains only Auto plus one rung, inspect the original playlist: a media playlist containing only `#EXTINF` segments cannot provide a quality/audio ladder that the source does not have.

For real movi/FFmpeg decoder diagnostics, add `?debug=1` to the player URL (or `&debug=1` when it already has a query string), then open the browser console with **F12 → Console**. Reproduce the failure and look for `[movi:...]` and `[LOL Embed] movi ...` messages. Debug mode does not alter resolution or playback behavior.

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
