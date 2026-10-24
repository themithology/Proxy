# Shell helpers shared by the VPS installer and its tests. Callers must cd to
# the repository root before sourcing this file; .env is never printed.

get_env() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
}

set_env() {
  local key="$1"
  local value="$2"
  value="${value//\\/\\\\}"
  value="${value//|/\\|}"
  value="${value//&/\\&}"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*$|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    local first second
    first="$(cat /proc/sys/kernel/random/uuid)"
    second="$(cat /proc/sys/kernel/random/uuid)"
    printf '%s%s\n' "${first//-/}" "${second//-/}"
  fi
}

ensure_secret() {
  local key="$1"
  local current
  current="$(get_env "$key")"
  case "$current" in
    ""|change-this-*|admin123|lol-embed-edge-hmac-secret-key-2026-*)
      set_env "$key" "$(random_secret)"
      ;;
  esac
}
