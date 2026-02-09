#!/usr/bin/env bash
set -euo pipefail

# GitHub Copilot Tmux Wrapper
# Creates a tmux session with copilot and a game view that auto-switches

SESSION_NAME="copilot-play"
STATE_FILE="${COPILOT_HOOKS_STATE:-$HOME/.copilot/hooks-state.json}"
GAME_COMMAND="${GAME_COMMAND:-cmatrix}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill existing session if it exists
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

# Ensure state file directory exists
mkdir -p "$(dirname "$STATE_FILE")"

# Create new tmux session
tmux new-session -d -s "$SESSION_NAME" -n copilot

# Configure tmux
tmux set-option -t "$SESSION_NAME" -g mouse on
tmux set-option -t "$SESSION_NAME" -g status-position bottom
tmux set-option -t "$SESSION_NAME" -g status-interval 1

# Add custom keybind Ctrl+G to toggle between windows
tmux bind-key -n C-g run-shell "
  CURRENT=\$(tmux display-message -p '#I')
  if [ \"\$CURRENT\" = '0' ]; then
    tmux select-window -t 1
  else
    tmux select-window -t 0
  fi
"

# Set up window 0: Copilot
tmux send-keys -t "$SESSION_NAME:0" "copilot $*" C-m

# Create window 1: Game
tmux new-window -t "$SESSION_NAME" -n game "$GAME_COMMAND"

# Create a small debug/controller pane at the bottom of window 0
tmux split-window -t "$SESSION_NAME:0" -v -l 3 "exec $SCRIPT_DIR/tmux-controller.sh"

# Select the copilot pane (top of window 0)
tmux select-pane -t "$SESSION_NAME:0.0"

# Attach to the session
tmux attach-session -t "$SESSION_NAME"
