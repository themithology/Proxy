#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="/tmp/tmdb-embed-api"

printf '\n[live-test] Installing the Proxy runtime dependencies…\n'
cd "$ROOT"
npm install --omit=dev

if [[ ! -f "$UPSTREAM_DIR/apiServer.js" ]]; then
  printf '\n[live-test] Cloning the real TMDB-Embed-API provider stack…\n'
  rm -rf "$UPSTREAM_DIR"
  git clone --depth 1 https://github.com/themithology/TMDB-Embed-API.git "$UPSTREAM_DIR"
fi

printf '\n[live-test] Installing the upstream provider dependencies…\n'
cd "$UPSTREAM_DIR"
npm install --omit=dev

printf '\n[live-test] Setup complete. No mock provider or fixture CDN is used.\n'
