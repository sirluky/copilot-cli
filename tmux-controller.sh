#!/usr/bin/env bash
set -euo pipefail

# Tmux Window Controller
# Monitors copilot hooks state and switches windows automatically
# Runs in a small pane at the bottom for debugging visibility

STATE_FILE="${COPILOT_HOOKS_STATE:-$HOME/.copilot/hooks-state.json}"
SESSION_NAME="copilot-play"
POLL_INTERVAL=0.2

last_state="unknown"
last_mtime=0

log() {
  echo "[$(date '+%H:%M:%S')] $1"
}

switch_to_copilot() {
  local current_window
  current_window=$(tmux display-message -t "$SESSION_NAME" -p '#I' 2>/dev/null || echo "")
  if [ "$current_window" != "0" ]; then
    tmux select-window -t "$SESSION_NAME:0" 2>/dev/null || true
    log "Switched to copilot window"
  fi
}

switch_to_game() {
  local current_window
  current_window=$(tmux display-message -t "$SESSION_NAME" -p '#I' 2>/dev/null || echo "")
  if [ "$current_window" != "1" ]; then
    tmux select-window -t "$SESSION_NAME:1" 2>/dev/null || true
    log "Switched to game window"
  fi
}

read_state() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "unknown"
    return
  fi
  
  local mtime
  mtime=$(stat -c %Y "$STATE_FILE" 2>/dev/null || stat -f %m "$STATE_FILE" 2>/dev/null || echo "0")
  
  if [ "$mtime" = "$last_mtime" ]; then
    echo "$last_state"
    return
  fi
  
  last_mtime=$mtime
  local state
  state=$(cat "$STATE_FILE" 2>/dev/null | grep -o '"state":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  echo "$state"
}

log "Controller started"
log "State file: $STATE_FILE"
log "Manual switch: Ctrl+G or tmux prefix + 0/1"
log "----------------------------------------"

while true; do
  current_state=$(read_state)
  
  if [ "$current_state" != "$last_state" ]; then
    log "State: $current_state"
    last_state=$current_state
    
    case "$current_state" in
      idle)
        switch_to_copilot
        ;;
      busy)
        switch_to_game
        ;;
      *)
        log "Unknown state, no switch"
        ;;
    esac
  fi
  
  sleep "$POLL_INTERVAL"
done
