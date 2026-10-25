#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/vps.sh YOUR_DOMAIN" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi
chmod 600 .env

# shellcheck source=deploy/env.sh
source "$ROOT_DIR/deploy/env.sh"

DOMAIN="${1:-${DOMAIN:-$(get_env DOMAIN)}}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"
if [[ -z "$DOMAIN" && -t 0 ]]; then
  read -r -p "Public domain for this embed (DNS must already point here): " DOMAIN
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Usage: sudo bash deploy/vps.sh embed.example.com" >&2
  echo "Point the domain's A/AAAA record to this VPS and open TCP ports 80 and 443 first." >&2
  exit 1
fi

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then return; fi
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl
  else
    echo "curl is required; install it with your distribution's package manager." >&2
    exit 1
  fi
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker || true
  elif command -v service >/dev/null 2>&1; then
    service docker start || true
  fi
}

install_docker() {
  echo "Installing Docker and Compose v2 from Docker's official installer..."
  ensure_curl
  local installer
  installer="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
  rm -f "$installer"
  start_docker
}

ensure_curl
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install_docker
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 did not install correctly." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  start_docker
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but its daemon is not running." >&2
  exit 1
fi

ensure_secret ADMIN_SECRET
ensure_secret PROXY_SECRET
set_env DOMAIN "$DOMAIN"
set_env PUBLIC_BASE_URL "https://${DOMAIN}"
set_env NODE_ENV production
set_env HOST 0.0.0.0
set_env PLAYER_PORT 3000
set_env MKV_HLS_ENABLED true
set_env MKV_HLS_NODE_HOST true
set_env MKV_HLS_DIR /data/hls
if [[ -z "$(get_env MKV_HLS_MAX_SESSIONS)" ]]; then
  set_env MKV_HLS_MAX_SESSIONS 2
fi

# Earlier releases used fixed container names. Remove only those legacy
# containers so they cannot conflict or hold ports 80/443; named volumes and
# their HLS/certificate data are deliberately preserved.
docker rm -f lol-embed-player lol-embed-https >/dev/null 2>&1 || true

# The compose file uses the same .env for container variables and substitution.
docker compose up -d --build --remove-orphans

healthy=0
for _ in {1..60}; do
  if docker compose exec -T lol-embed wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" -ne 1 ]]; then
  echo "The player container did not become healthy. Recent logs:" >&2
  docker compose logs --tail=80 lol-embed >&2 || true
  exit 1
fi

https_ready=0
for _ in {1..60}; do
  if curl -fsSL --max-time 10 "https://${DOMAIN}/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    https_ready=1
    break
  fi
  sleep 2
done
if [[ "$https_ready" -ne 1 ]]; then
  echo "The app is healthy, but public HTTPS is not responding yet." >&2
  echo "Check DNS, cloud firewall/security-group ports 80 and 443, and Caddy logs:" >&2
  docker compose logs --tail=80 caddy >&2 || true
  exit 1
fi

printf '\nDeployment is healthy.\n'
printf 'Player:  https://%s/embed\n' "$DOMAIN"
printf 'Health:  https://%s/api/health\n' "$DOMAIN"
printf 'Admin:   https://%s/reze (use ADMIN_SECRET from .env)\n' "$DOMAIN"
printf 'Logs:    cd %s && docker compose logs -f\n' "$ROOT_DIR"
printf 'Stop:    cd %s && docker compose down\n' "$ROOT_DIR"
printf 'HLS data and Caddy certificates use persistent Docker volumes.\n'
