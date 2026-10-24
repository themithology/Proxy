#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "Node.js 22 or newer is required. Install it, then rerun this script." >&2
  exit 1
fi
for command_name in npm curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required." >&2
    exit 1
  fi
done

RUNTIME_DIR="${TMPDIR:-/tmp}/lol-embed-quick-tunnel"
PLAYER_PID_FILE="$RUNTIME_DIR/player.pid"
TUNNEL_PID_FILE="$RUNTIME_DIR/tunnel.pid"
PLAYER_LOG="$RUNTIME_DIR/player.log"
TUNNEL_LOG="$RUNTIME_DIR/tunnel.log"
mkdir -p "$RUNTIME_DIR"

stop_previous() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then return; fi
  local pid
  pid="$(cat "$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..25}; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$pid_file"
}

stop_previous "$PLAYER_PID_FILE"
stop_previous "$TUNNEL_PID_FILE"
# Also replace processes started by the earlier manual instructions. In
# particular, src/server.js is API-only and must not keep port 3000.
if command -v pkill >/dev/null 2>&1; then
  pkill -f 'node scripts/player-server\.mjs' 2>/dev/null || true
  pkill -f 'node src/server\.js' 2>/dev/null || true
fi
if [[ -f /tmp/lol-player.pid ]]; then stop_previous /tmp/lol-player.pid; fi

if [[ ! -f .env ]]; then cp .env.example .env; fi
chmod 600 .env
# shellcheck source=deploy/env.sh
source "$ROOT_DIR/deploy/env.sh"
ensure_secret ADMIN_SECRET
ensure_secret PROXY_SECRET
set_env PLAYER_PORT 3000
set_env HOST 127.0.0.1
set_env NODE_ENV production
set_env API_BASE_URL ""
set_env GOLDMINE_API_BASE https://rdp-running-campion.onrender.com
set_env GOLDMINE_PROXY_STREAMS true
set_env GOLDMINE_TIMEOUT_MS 60000
set_env MKV_HLS_ENABLED true
set_env MKV_HLS_NODE_HOST true
set_env MKV_HLS_DIR "$RUNTIME_DIR/hls"
set_env MKV_HLS_MAX_SESSIONS 2
set_env MKV_HLS_READY_TIMEOUT_MS 120000

npm ci --omit=dev

case "$(uname -m)" in
  x86_64|amd64) CLOUDFLARED_ARCH=amd64 ;;
  aarch64|arm64) CLOUDFLARED_ARCH=arm64 ;;
  *) echo "cloudflared does not have a supported binary for $(uname -m)." >&2; exit 1 ;;
esac
if [[ -x /tmp/cloudflared ]]; then
  CLOUDFLARED=/tmp/cloudflared
else
  CLOUDFLARED="$RUNTIME_DIR/cloudflared-$CLOUDFLARED_ARCH"
fi
if [[ ! -x "$CLOUDFLARED" ]]; then
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CLOUDFLARED_ARCH" -o "$CLOUDFLARED"
  chmod 700 "$CLOUDFLARED"
fi

# Register the Quick Tunnel first. Its random public origin must be written to
# PUBLIC_BASE_URL before Node starts, because the player freezes that value at
# startup and uses it for browser-safe HLS and proxy URLs.
: > "$TUNNEL_LOG"
nohup "$CLOUDFLARED" tunnel --url http://127.0.0.1:3000 > "$TUNNEL_LOG" 2>&1 &
echo $! > "$TUNNEL_PID_FILE"

TUNNEL_URL=""
for _ in {1..45}; do
  TUNNEL_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)"
  if [[ -n "$TUNNEL_URL" ]]; then break; fi
  if ! kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then break; fi
  sleep 1
done
if [[ -z "$TUNNEL_URL" ]]; then
  echo "Cloudflare did not provide a Quick Tunnel URL. Tunnel log:" >&2
  tail -80 "$TUNNEL_LOG" >&2 || true
  exit 1
fi
set_env PUBLIC_BASE_URL "$TUNNEL_URL"

: > "$PLAYER_LOG"
nohup env \
  HOST=127.0.0.1 \
  PLAYER_PORT=3000 \
  PUBLIC_BASE_URL="$TUNNEL_URL" \
  NODE_ENV=production \
  API_BASE_URL= \
  GOLDMINE_API_BASE=https://rdp-running-campion.onrender.com \
  GOLDMINE_PROXY_STREAMS=true \
  GOLDMINE_TIMEOUT_MS=60000 \
  MKV_HLS_ENABLED=true \
  MKV_HLS_NODE_HOST=true \
  MKV_HLS_DIR="$RUNTIME_DIR/hls" \
  MKV_HLS_MAX_SESSIONS=2 \
  MKV_HLS_READY_TIMEOUT_MS=120000 \
  node scripts/player-server.mjs > "$PLAYER_LOG" 2>&1 &
echo $! > "$PLAYER_PID_FILE"

local_ready=0
for _ in {1..45}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    local_ready=1
    break
  fi
  if ! kill -0 "$(cat "$PLAYER_PID_FILE")" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$local_ready" -ne 1 ]]; then
  echo "The player did not start. Player log:" >&2
  tail -80 "$PLAYER_LOG" >&2 || true
  exit 1
fi

public_ready=0
for _ in {1..45}; do
  if curl -fsS --max-time 5 "$TUNNEL_URL/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    public_ready=1
    break
  fi
  sleep 1
done
if [[ "$public_ready" -ne 1 ]]; then
  echo "The player is running locally, but the tunnel health check failed." >&2
  tail -60 "$TUNNEL_LOG" >&2 || true
  exit 1
fi

EMBED_HTML="$RUNTIME_DIR/embed.html"
if ! curl -fsS --max-time 15 "$TUNNEL_URL/embed/movie/693134" -o "$EMBED_HTML" || ! grep -q 'mkvHlsEnabled":true' "$EMBED_HTML"; then
  echo "The full player is not advertising its MKV-to-HLS converter." >&2
  tail -60 "$PLAYER_LOG" >&2 || true
  exit 1
fi

# An invalid source must produce 400 from the converter itself. A 404 here
# means the API-only server was started or the converter was not enabled.
converter_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$TUNNEL_URL/api/mkv-hls?src=invalid" || true)"
if [[ "$converter_status" != "400" ]]; then
  echo "MKV-to-HLS is not mounted (expected HTTP 400, got $converter_status)." >&2
  tail -60 "$PLAYER_LOG" >&2 || true
  exit 1
fi

RESOLVE_JSON="$RUNTIME_DIR/resolve.json"
# Warm and verify Goldmine locally so a slow Render cold start does not hit
# Cloudflare's public request timeout. The successful result is then cached for
# the first browser request through the tunnel.
if ! curl -fsS --max-time 120 http://127.0.0.1:3000/api/resolve/movie/693134 -o "$RESOLVE_JSON"; then
  echo "Goldmine did not resolve the test movie. Check the player log and Render upstream." >&2
  tail -80 "$PLAYER_LOG" >&2 || true
  exit 1
fi
if ! node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!data.stream || !data.stream.streamUrl) { console.error(data.error || "Goldmine returned no playable stream"); process.exit(1); }' "$RESOLVE_JSON"; then
  echo "The main Goldmine MP4/HLS source is not configured or returned no stream." >&2
  exit 1
fi

printf '\nQuick Tunnel, full player, Goldmine and MKV-to-HLS are configured.\n'
printf 'Player: %s/embed/movie/693134?debug=1\n' "$TUNNEL_URL"
printf 'Health: %s/api/health\n' "$TUNNEL_URL"
printf 'Player log: tail -f %s\n' "$PLAYER_LOG"
printf 'Tunnel log: tail -f %s\n' "$TUNNEL_LOG"
printf 'Stop: kill "$(cat %s)" "$(cat %s)"\n' "$PLAYER_PID_FILE" "$TUNNEL_PID_FILE"
printf 'This random URL lasts only while cloudflared and the player keep running.\n'
