#!/usr/bin/env bash
#
# scripts/fly-secrets.sh
#
# Push secrets from .env to all three Fly.io apps in one shot.
#
# Reads <repo>/.env and applies the relevant values via `flyctl secrets set`
# for botguild-sentinel-bot, botguild-flow-bot, and botguild-verifier-bot.
# WEBHOOK_BASE_URL is computed per-app (https://<app>.fly.dev) regardless of
# what's in .env — the .env value is for local dev (ngrok / docker-compose).
# PORT is intentionally skipped because each app's fly.toml owns that.
#
# Usage:
#   scripts/fly-secrets.sh [--dry-run] [--app <app-name>]
#
# Examples:
#   scripts/fly-secrets.sh
#   scripts/fly-secrets.sh --dry-run
#   scripts/fly-secrets.sh --app botguild-flow-bot

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_FILE="${REPO_ROOT}/.env"
readonly DEFAULT_APPS=(botguild-sentinel-bot botguild-flow-bot botguild-verifier-bot)

# --- arg parsing ----------------------------------------------------------

DRY_RUN=0
TARGET_APPS=("${DEFAULT_APPS[@]}")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --app)
      [[ $# -ge 2 ]] || { echo "error: --app requires a value" >&2; exit 2; }
      TARGET_APPS=("$2")
      shift 2
      ;;
    -h|--help)
      sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "usage: $0 [--dry-run] [--app <app-name>]" >&2
      exit 2
      ;;
  esac
done

# --- prereqs --------------------------------------------------------------

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not found on PATH. Install: https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example to .env and fill in values first." >&2
  exit 1
fi

# Read a single key=value pair from .env without sourcing the file
# (sourcing risks shell-interpreting values that contain $, backticks, etc.).
get_env() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -n1 || true)
  [[ -z "$line" ]] && return 0
  printf '%s' "${line#${key}=}"
}

# --- collect values -------------------------------------------------------

BOTGUILD_API_URL="$(get_env BOTGUILD_API_URL)"
BOTGUILD_API_KEY="$(get_env BOTGUILD_API_KEY)"
BOTGUILD_BOT_ID="$(get_env BOTGUILD_BOT_ID)"
BOTGUILD_WEBHOOK_SECRET="$(get_env BOTGUILD_WEBHOOK_SECRET)"
ANTHROPIC_API_KEY="$(get_env ANTHROPIC_API_KEY)"
TELEGRAM_BOT_TOKEN="$(get_env TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(get_env TELEGRAM_CHAT_ID)"

required=(
  BOTGUILD_API_URL
  BOTGUILD_API_KEY
  BOTGUILD_WEBHOOK_SECRET
  ANTHROPIC_API_KEY
)

missing=()
for var in "${required[@]}"; do
  if [[ -z "${!var}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: the following required values are missing or blank in $ENV_FILE:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

# --- apply ----------------------------------------------------------------

push_secrets_for_app() {
  local app="$1"
  local webhook_url="https://${app}.fly.dev"

  # Build the args array. `flyctl secrets set` is idempotent on identical
  # values, so it's safe to re-run.
  local args=(
    "BOTGUILD_API_URL=${BOTGUILD_API_URL}"
    "BOTGUILD_API_KEY=${BOTGUILD_API_KEY}"
    "BOTGUILD_WEBHOOK_SECRET=${BOTGUILD_WEBHOOK_SECRET}"
    "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
    "WEBHOOK_BASE_URL=${webhook_url}"
  )

  # Optional values — only push when set (avoid clobbering with empty string).
  [[ -n "$BOTGUILD_BOT_ID" ]]     && args+=("BOTGUILD_BOT_ID=${BOTGUILD_BOT_ID}")
  [[ -n "$TELEGRAM_BOT_TOKEN" ]]  && args+=("TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}")
  [[ -n "$TELEGRAM_CHAT_ID" ]]    && args+=("TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}")

  echo
  echo "── ${app} ──"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  (dry-run) would set ${#args[@]} secrets:"
    for arg in "${args[@]}"; do
      # Print key only — never the value, even in dry-run.
      printf '    %s=***\n' "${arg%%=*}"
    done
    return 0
  fi

  flyctl secrets set --app "$app" "${args[@]}"
}

if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY RUN — no changes will be made. Re-run without --dry-run to apply."
fi

for app in "${TARGET_APPS[@]}"; do
  push_secrets_for_app "$app"
done

echo
echo "Done. Verify with:  flyctl secrets list --app <app-name>"
