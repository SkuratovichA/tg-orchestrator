#!/usr/bin/env bash
# Install the curator agent and its weekly launchd job (docs/agent-learning.md
# §3). Idempotent: whatever already exists is kept, a second run changes nothing.
#
#   agents/curator/          the home skeleton (lib/agent-home.sh make_home)
#   agents/curator/brain.md  templates/curator/brain.md, {{REPO}} and
#                            {{AGENTS_ROOT}} substituted; kept if present
#   agents/curator/topics    the learning topic (TG_LEARNING_TOPIC in <cfg>/env)
#   ~/Library/LaunchAgents/personal.tg-orchestrator.curator.plist
#                            Sunday 20:00 local time → scripts/curator-weekly.sh,
#                            bootstrapped into the GUI domain
#
# Overrides (tests): TG_ORC_HOME = the config dir, TG_ORC_REPO = the repo (default:
# this script's own), TG_ORC_LAUNCH_AGENTS = the LaunchAgents dir,
# TG_ORC_NO_LAUNCHD=1 = write the plist but do not touch launchctl.
#
# usage: scripts/install-curator.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${TG_ORC_HOME:-$HOME/.config/tg-orchestrator}"
REPO="${TG_ORC_REPO:-$(cd "$HERE/.." && pwd)}"
LAUNCH_AGENTS="${TG_ORC_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
AGENTS="$CFG/agents"
LABEL="personal.tg-orchestrator.curator"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
TEMPLATE="$HERE/../templates/curator/brain.md"

# shellcheck source=lib/agent-home.sh
. "$HERE/lib/agent-home.sh"

TOPIC="$(env_file_value "$CFG/env" TG_LEARNING_TOPIC)"
if ! printf '%s' "$TOPIC" | grep -Eq '^-?[0-9]+:[0-9]+$'; then
  say "TG_LEARNING_TOPIC=<chat_id>:<thread_id> must be set in $CFG/env (got '${TOPIC}') — nothing installed" >&2
  exit 1
fi
[ -f "$TEMPLATE" ] || { say "missing template $TEMPLATE" >&2; exit 1; }

HOME_DIR="$AGENTS/curator"
make_home curator

if [ -e "$HOME_DIR/brain.md" ]; then
  say "kept    $HOME_DIR/brain.md"
else
  # `#` as the sed delimiter: both values are paths. An `&` or `#` in a path
  # would need escaping; neither appears in a home directory path here.
  sed -e "s#{{REPO}}#$REPO#g" -e "s#{{AGENTS_ROOT}}#$AGENTS#g" "$TEMPLATE" >"$HOME_DIR/brain.md"
  say "wrote   $HOME_DIR/brain.md"
fi

if [ -e "$HOME_DIR/topics" ] && grep -qxF -e "$TOPIC" "$HOME_DIR/topics"; then
  say "kept    $HOME_DIR/topics"
else
  printf '%s\n' "$TOPIC" >"$HOME_DIR/topics"
  say "wrote   $HOME_DIR/topics"
fi

# read -d '' rather than $(cat <<EOF): bash 3.2 mis-parses quotes inside a
# heredoc nested in a command substitution.
IFS= read -r -d '' PLIST_BODY <<EOF || true
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/curator-weekly.sh</string>
  </array>
  <!-- Sunday 20:00 in the local time zone of the Mac (Prague). -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>20</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$CFG/launchd-curator.log</string>
  <key>StandardErrorPath</key>
  <string>$CFG/launchd-curator.log</string>
</dict>
</plist>
EOF
PLIST_BODY="${PLIST_BODY%$'\n'}"

if [ -f "$PLIST" ] && [ "$(cat "$PLIST")" = "$PLIST_BODY" ]; then
  say "kept    $PLIST"
  CHANGED=0
else
  mkdir -p "$LAUNCH_AGENTS"
  printf '%s\n' "$PLIST_BODY" >"$PLIST"
  say "wrote   $PLIST"
  CHANGED=1
fi

if [ "${TG_ORC_NO_LAUNCHD:-0}" = "1" ]; then
  say "skip    launchctl (TG_ORC_NO_LAUNCHD=1)"
else
  DOMAIN="gui/$(id -u)"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    if [ "$CHANGED" = "1" ]; then
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
      launchctl bootstrap "$DOMAIN" "$PLIST" && say "reloaded $LABEL"
    else
      say "kept    $LABEL (loaded)"
    fi
  elif launchctl bootstrap "$DOMAIN" "$PLIST"; then
    say "loaded  $LABEL"
  else
    say "FAILED  launchctl bootstrap $DOMAIN $PLIST" >&2
    exit 1
  fi
fi
say "done"
