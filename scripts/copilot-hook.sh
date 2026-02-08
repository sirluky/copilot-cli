#!/usr/bin/env bash
set -euo pipefail

STATE="${1:-}"
if [ -z "$STATE" ]; then
  echo "Usage: copilot-hook.sh <busy|idle>" >&2
  exit 1
fi

STATE_FILE="${COPILOT_HOOKS_STATE:-$HOME/.copilot/hooks-state.json}"
mkdir -p "$(dirname "$STATE_FILE")"

cat >/dev/null
printf '{"state":"%s","timestamp":%s}\n' "$STATE" "$(date +%s)" > "$STATE_FILE"
