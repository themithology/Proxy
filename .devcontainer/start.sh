#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="/tmp/tmdb-embed-api"
RUN_DIR="/tmp/lol-embed-live"
mkdir -p "$RUN_DIR"

if [[ ! -d "$ROOT/node_modules" || ! -d "$UPSTREAM_DIR/node_modules" || \
      ! -f "$ROOT/node_modules/@ffmpeg-installer/ffmpeg/package.json" || \
      ! -f "$ROOT/node_modules/@ffprobe-installer/ffprobe/package.json" ]]; then
  bash "$ROOT/.devcontainer/setup.sh"
fi

# Respect an explicitly supplied Codespaces secret. Otherwise reuse the public
# sample TMDB key already shipped with this repository; no Render secrets are
# required for the live provider test.
TMDB_KEY="${TMDB_API_KEY:-}"
if [[ -z "$TMDB_KEY" ]]; then
  TMDB_KEY="$(cd "$ROOT" && node -p "require('./src/config.js').tmdbApiKey")"
fi

if ! curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  printf '[live-test] Starting the real provider API on private loopback :8787…\n'
  (
    cd "$UPSTREAM_DIR"
    nohup env \
      API_PORT=8787 \
      BIND_HOST=127.0.0.1 \
      ENABLE_PROXY=false \
      DEFAULT_PROVIDERS="${LIVE_TEST_PROVIDERS:-4khdhub,castletv,hdghartv,dahmermovies}" \
      TMDB_API_KEY="$TMDB_KEY" \
      FEBBOX_COOKIES="${FEBBOX_COOKIES:-}" \
      node apiServer.js >"$RUN_DIR/upstream.log" 2>&1 &
    echo "$!" >"$RUN_DIR/upstream.pid"
  )
fi

FORWARDING_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
PUBLIC_ORIGIN="${PUBLIC_BASE_URL:-}"
if [[ -z "$PUBLIC_ORIGIN" && -n "${CODESPACE_NAME:-}" ]]; then
  PUBLIC_ORIGIN="https://${CODESPACE_NAME}-3000.${FORWARDING_DOMAIN}"
fi

if ! curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  printf '[live-test] Starting the real Worker player + API on :3000…\n'
  (
    cd "$ROOT"
    nohup env \
      PLAYER_PORT=3000 \
      HOST=0.0.0.0 \
      NODE_ENV=development \
      PUBLIC_BASE_URL="$PUBLIC_ORIGIN" \
      GOLDMINE_API_BASE=http://127.0.0.1:8787 \
      GOLDMINE_PROXY_STREAMS=true \
      GOLDMINE_TIMEOUT_MS=60000 \
      MKV_HLS_ENABLED="${MKV_HLS_ENABLED:-false}" \
      MKV_HLS_MAX_SESSIONS="${MKV_HLS_MAX_SESSIONS:-1}" \
      TMDB_API_KEY="$TMDB_KEY" \
      FEBBOX_COOKIES="${FEBBOX_COOKIES:-}" \
      ADMIN_SECRET="${ADMIN_SECRET:-live-test-admin}" \
      PROXY_SECRET="${PROXY_SECRET:-live-test-proxy}" \
      ADS_ENABLED=false \
      node scripts/dev-worker.mjs >"$RUN_DIR/player.log" 2>&1 &
    echo "$!" >"$RUN_DIR/player.pid"
  )
fi

wait_for_http() {
  local url="$1"
  for _ in {1..45}; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

READY=1
if ! wait_for_http http://127.0.0.1:8787/api/health; then
  printf '[live-test] Upstream did not become healthy. See %s/upstream.log\n' "$RUN_DIR" >&2
  READY=0
fi
if ! wait_for_http http://127.0.0.1:3000/api/health; then
  printf '[live-test] Player/API did not become healthy. See %s/player.log\n' "$RUN_DIR" >&2
  READY=0
fi
if [[ "$READY" -ne 1 ]]; then
  printf '[live-test] The live environment is NOT ready; no playback result is being claimed.\n' >&2
  exit 1
fi

printf '\n[live-test] Environment ready. Real provider/browser verification is still required.\n'
if [[ -n "$PUBLIC_ORIGIN" ]]; then
  printf '[live-test] Private player: %s/embed?type=movie&tmdb=693134\n' "$PUBLIC_ORIGIN"
  printf '[live-test] Keep port 3000 PRIVATE and open it while signed in to GitHub.\n'
else
  printf '[live-test] Open the forwarded port 3000, then visit /embed?type=movie&tmdb=693134\n'
fi
printf '[live-test] Logs: %s/upstream.log and %s/player.log\n\n' "$RUN_DIR" "$RUN_DIR"
