#!/usr/bin/env bash
# One-off migration to agent homes (docs/agent-learning.md §1). Run once after
# the deploy, before the drain restart; running it again is a no-op.
#
#   agents/orchestrator/   created; the bot's auto-memory moves in from the
#                          $HOME project dir (~/.claude/projects/<munged $HOME>/memory)
#   agents/psy/            created; ~/.config/tg-orchestrator/psy/ (dossier, log,
#                          raw) moves in; the repo's agents/<chat_id>_<thread_id>.md
#                          is copied in as brain.md with its paths rewritten, and
#                          topics gets that <chat_id>:<thread_id>
#
# Moves never overwrite: an entry whose target already exists stays where it is
# and is reported as a CONFLICT (exit 1 at the end), for a human to resolve.
#
# Overrides (tests): TG_ORC_HOME = the config dir, CLAUDE_PROJECT_MEMORY = the
# source memory dir.
#
# usage: scripts/migrate-agent-homes.sh
set -uo pipefail

CFG="${TG_ORC_HOME:-$HOME/.config/tg-orchestrator}"
SRC_MEMORY="${CLAUDE_PROJECT_MEMORY:-$HOME/.claude/projects/$(printf '%s' "$HOME" | tr '/.' '--')/memory}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The psy brain is the one per-topic brain of the old convention,
# agents/<chat_id>_<thread_id>.md in the repo; its name is its topic.
REPO_PSY_BRAIN=""
for f in "$HERE"/../agents/*_*.md; do
  [ -f "$f" ] && REPO_PSY_BRAIN="$f" && break
done
PSY_TOPIC=""
if [ -n "$REPO_PSY_BRAIN" ]; then
  PSY_TOPIC="$(basename "$REPO_PSY_BRAIN" .md | tr '_' ':')"
fi
AGENTS="$CFG/agents"
CONFLICTS=0

# say, make_home: shared with install-curator.sh.
# shellcheck source=lib/agent-home.sh
. "$HERE/lib/agent-home.sh"

# move_contents <src dir> <dst dir>: mv every entry (dotfiles included), never overwriting.
move_contents() {
  local src="$1" dst="$2"
  if [ ! -d "$src" ]; then
    say "skip    $src (missing)"
    return
  fi
  local entries=()
  local e
  shopt -s nullglob dotglob
  entries=("$src"/*)
  shopt -u nullglob dotglob
  if [ "${#entries[@]}" -eq 0 ]; then
    say "skip    $src (empty)"
    return
  fi
  local moved=0
  for e in "${entries[@]}"; do
    local target="$dst/$(basename "$e")"
    if [ -e "$target" ]; then
      say "CONFLICT $target exists — left $e in place"
      CONFLICTS=$((CONFLICTS + 1))
    elif mv "$e" "$target"; then
      moved=$((moved + 1))
    else
      say "FAILED  mv $e $target"
      CONFLICTS=$((CONFLICTS + 1))
    fi
  done
  say "moved   $moved entries $src -> $dst"
}

mkdir -p "$AGENTS"

# --- orchestrator ---------------------------------------------------------------
make_home orchestrator
move_contents "$SRC_MEMORY" "$AGENTS/orchestrator/memory"

# --- psy ------------------------------------------------------------------------
make_home psy
PSY_OLD="$CFG/psy"
move_contents "$PSY_OLD" "$AGENTS/psy"
# The old dir goes once everything is out of it, so a second run reads "missing".
if [ -d "$PSY_OLD" ] && rmdir "$PSY_OLD" 2>/dev/null; then
  say "removed $PSY_OLD (empty)"
fi

if [ -e "$AGENTS/psy/brain.md" ]; then
  say "kept    $AGENTS/psy/brain.md"
elif [ -n "$REPO_PSY_BRAIN" ]; then
  # Both spellings of the old dossier path; `tg-orchestrator/psy` followed by the
  # end of the path, a slash or any non-word character.
  # POSIX ERE on purpose: macOS sed has no `\|`.
  sed -E \
    -e 's#(~|\$HOME|'"$HOME"')/\.config/tg-orchestrator/psy([^A-Za-z0-9_-]|$)#\1/.config/tg-orchestrator/agents/psy\2#g' \
    "$REPO_PSY_BRAIN" >"$AGENTS/psy/brain.md"
  say "wrote   $AGENTS/psy/brain.md (from $(basename "$REPO_PSY_BRAIN"), paths rewritten)"
else
  say "skip    psy brain.md (no agents/<chat_id>_<thread_id>.md in the repo)"
fi

if [ -e "$AGENTS/psy/topics" ]; then
  say "kept    $AGENTS/psy/topics"
elif [ -z "$PSY_TOPIC" ]; then
  say "skip    psy topics (no brain in the repo to name the topic)"
else
  printf '%s\n' "$PSY_TOPIC" >"$AGENTS/psy/topics"
  say "wrote   $AGENTS/psy/topics"
fi

if [ "$CONFLICTS" -gt 0 ]; then
  say "done with $CONFLICTS conflict(s) — resolve them by hand and run again"
  exit 1
fi
say "done"
