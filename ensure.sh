#!/usr/bin/env bash
# Start the tg-orchestrator daemon if it is not already running. Idempotent —
# safe from launchd, a shell, or a SessionStart hook. Silent no-op without config.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Node: whatever .node-version names, if that release is installed under nvm —
# the suites and the type stripping this repo relies on are developed against
# exactly that one. A box without it falls back to the newest nvm node rather
# than refusing to start.
NODE_BIN=""
WANT="$(tr -d '[:space:]' < "$HERE/.node-version" 2> /dev/null)"
if [ -n "$WANT" ] && [ -x "$HOME/.nvm/versions/node/v$WANT/bin/node" ]; then
  NODE_BIN="$HOME/.nvm/versions/node/v$WANT/bin"
else
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2> /dev/null | sort -V | tail -1)"
fi
# ~/.local/bin holds the claude binary — without it the runner dies with
# "spawn claude ENOENT" (found the hard way on first E2E).
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CFG="$HOME/.config/tg-orchestrator"

[ -f "$CFG/env" ] || exit 0
PID=$(cat "$CFG/runner.pid" 2> /dev/null || echo "")
if [ -n "$PID" ] && kill -0 "$PID" 2> /dev/null; then exit 0; fi

nohup node "$HERE/src/runner.mjs" >> "$CFG/runner.log" 2>&1 &
disown
echo "tg-orchestrator started (pid $!)"
