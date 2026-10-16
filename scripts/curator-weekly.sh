#!/usr/bin/env bash
# The curator's weekly run (docs/agent-learning.md §3), started by launchd
# (personal.tg-orchestrator.curator.plist, written by install-curator.sh).
#
# It only drops a wake record for the learning topic; the runner turns that
# into a turn, and the topic's `topics` file routes the turn to the curator.
# No learning topic = nothing to do: exit 1 with the reason in the launchd log.
#
# Overrides (tests): TG_ORC_HOME = the config dir; TG_LEARNING_TOPIC from the
# process env wins over the env file, as in config.ts.
#
# usage: scripts/curator-weekly.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${TG_ORC_HOME:-$HOME/.config/tg-orchestrator}"
# shellcheck source=lib/agent-home.sh
. "$HERE/lib/agent-home.sh"

# launchd's PATH is /usr/bin:/bin; wake.sh mirrors into the event log with node.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2> /dev/null | sort -V | tail -1)"
export PATH="${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TOPIC="${TG_LEARNING_TOPIC:-$(env_file_value "$CFG/env" TG_LEARNING_TOPIC)}"
if [ -z "$TOPIC" ]; then
  say "$(date '+%F %T') curator-weekly: TG_LEARNING_TOPIC is not set in $CFG/env — nothing to wake" >&2
  exit 1
fi

exec bash "$HERE/wake.sh" --convo "$TOPIC" --job curator-weekly --kind curator --ok \
  --text "Weekly curation pass: do it now. Walk every agent's memory as your brain describes (files older than 30 days and every type: project; verify against the transcripts first; at most 25% of one agent's files; line-level edits; archive, never delete), file one proposal per change through learning.mjs propose, post nothing to Telegram yourself, and end with one line summarising what you looked at and how many proposals you filed."
