#!/usr/bin/env bash
# Export the public subset of this repository into a separate git repository
# with its own history, refuse if anything private slipped in, commit, push.
#
# The private checkout carries the owner's agent.md, per-topic brains, the
# machine map, changelogs and learning notes. None of that is published; the
# public tree is an allowlist copy, so a new private file can never leak by
# omission. Two guards run before the commit: a private denylist of patterns
# kept OUTSIDE the repo (~/.config/tg-orchestrator/publish-denylist, one
# regex per line) and a generic scan for home paths and token shapes.
#
# usage: scripts/publish.sh "<commit message>" [public_dir]
#   public_dir defaults to $TG_ORCHESTRATOR_PUBLIC_DIR or ~/git/tg-orchestrator
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MSG="${1:?usage: publish.sh \"<commit message>\" [public_dir]}"
PUB="${2:-${TG_ORCHESTRATOR_PUBLIC_DIR:-$HOME/git/tg-orchestrator}}"
DENY="${TG_ORCHESTRATOR_DENYLIST:-$HOME/.config/tg-orchestrator/publish-denylist}"

ALLOW=(src test scripts ensure.sh README.md LICENSE package.json .env.example agent.example.md .gitignore)

mkdir -p "$PUB"
[ -d "$PUB/.git" ] || git -C "$PUB" init -q -b main

# Mirror the allowlist exactly: anything that is not on it disappears from the
# export, including files deleted privately.
find "$PUB" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
for p in "${ALLOW[@]}"; do
  [ -e "$ROOT/$p" ] || { echo "publish: missing $p" >&2; exit 1; }
  cp -R "$ROOT/$p" "$PUB/$p"
done

fail() { echo "publish: REFUSING — $1:" >&2; echo "$2" | head -20 >&2; exit 1; }
if [ -f "$DENY" ]; then
  hits=$(grep -rnEf "$DENY" "$PUB" --exclude-dir=.git || true)
  [ -z "$hits" ] || fail "private identifiers in the export (see $DENY)" "$hits"
fi
# --exclude=publish.sh: this very pattern list would otherwise match itself.
hits=$(grep -rnE '/Users/[A-Za-z]|/home/[a-z]|[0-9]{8,10}:[A-Za-z0-9_-]{35}|sk-ant-|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|BEGIN [A-Z ]*PRIVATE KEY' "$PUB" --exclude-dir=.git --exclude=publish.sh || true)
[ -z "$hits" ] || fail "home paths or token shapes in the export" "$hits"

git -C "$PUB" add -A
if git -C "$PUB" diff --cached --quiet; then
  echo "publish: nothing changed in $PUB"
else
  git -C "$PUB" commit -q -m "$MSG"
  echo "publish: committed $(git -C "$PUB" rev-parse --short HEAD) in $PUB"
fi
if git -C "$PUB" remote get-url origin > /dev/null 2>&1; then
  git -C "$PUB" push -q origin HEAD && echo "publish: pushed"
else
  echo "publish: no origin in $PUB — create it once:"
  echo "  gh repo create <owner>/tg-orchestrator --public --source \"$PUB\" --remote origin --push"
fi
