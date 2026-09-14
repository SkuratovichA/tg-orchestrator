#!/usr/bin/env bash
# Export the public subset of this repository into a separate git repository
# with its own history, refuse if anything private slipped in, commit, push.
#
# The private checkout carries the owner's agent.md, per-topic brains, the
# machine map, changelogs and learning notes. None of that is published; the
# public tree is an allowlist copy, so a new private file can never leak by
# omission. Three guards run before the commit: a private denylist of patterns
# kept OUTSIDE the repo (~/.config/tg-orchestrator/publish-denylist, one
# regex per line), a generic scan for home paths and token shapes, and a check
# that no `link:` dependency survived the rewrite below.
#
# The export must install from a CLEAN CLONE, and the private checkout takes
# @tagents/core as `link:` from the package next door. So the copied
# package.json is rewritten to take the same package from git, and
# pnpm-lock.yaml is not exported at all: the lockfile pins that link: path
# (`specifier: link:../../tagents/packages/core`), which resolves to nothing
# beside a clone, and rewriting a lockfile by hand is how you ship one that
# disagrees with its manifest.
#
# usage: scripts/publish.sh "<commit message>" [public_dir]
#   public_dir defaults to $TG_ORCHESTRATOR_PUBLIC_DIR or ~/git/tg-orchestrator
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MSG="${1:?usage: publish.sh \"<commit message>\" [public_dir]}"
PUB="${2:-${TG_ORCHESTRATOR_PUBLIC_DIR:-$HOME/git/tg-orchestrator}}"
DENY="${TG_ORCHESTRATOR_DENYLIST:-$HOME/.config/tg-orchestrator/publish-denylist}"

ALLOW=(src test scripts ensure.sh README.md LICENSE package.json tsconfig.json .node-version .env.example agent.example.md .gitignore)
# Where a public consumer gets @tagents/core from.
CORE_GIT_SPEC='github:SkuratovichA/tagents#path:/packages/core'

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

# The one rewrite the export needs: a path dependency becomes a git one.
node --input-type=commonjs -e '
const fs = require("fs");
const [file, spec] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const cur = pkg.dependencies && pkg.dependencies["@tagents/core"];
if (!cur) { console.error("publish: @tagents/core is no longer a dependency — drop this step"); process.exit(1); }
if (!cur.startsWith("link:")) { console.error("publish: expected a link: spec for @tagents/core, found " + cur); process.exit(1); }
pkg.dependencies["@tagents/core"] = spec;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$PUB/package.json" "$CORE_GIT_SPEC"

# The other rewrite: a script default that names the owner's checkout layout
# ($HOME/git/<repo>) becomes the public layout ($HOME/git/<repo>).
# Production keeps the real default on purpose — a clean-env deploy once dropped
# TELEGRAM_MCP_DIR and the fallback pointed at a path that did not exist.
for f in "$PUB"/scripts/*.sh; do
  [ -f "$f" ] || continue
  # [p]ersonal: this script is exported too, and the denylist gate below would
  # otherwise find the private layout spelled out in its own source.
  sed -i '' 's#\$HOME/git/[p]ersonal/#$HOME/git/#g' "$f"
done
hits=$(grep -rn 'git/[p]ersonal' "$PUB"/scripts || true)
[ -z "$hits" ] || fail "the layout rewrite missed a private default" "$hits"
if [ -f "$DENY" ]; then
  hits=$(grep -rnEf "$DENY" "$PUB" --exclude-dir=.git || true)
  [ -z "$hits" ] || fail "private identifiers in the export (see $DENY)" "$hits"
fi
# --exclude=publish.sh: this very pattern list would otherwise match itself.
hits=$(grep -rnE '/Users/[A-Za-z]|/home/[a-z]|[0-9]{8,10}:[A-Za-z0-9_-]{35}|sk-ant-|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|BEGIN [A-Z ]*PRIVATE KEY' "$PUB" --exclude-dir=.git --exclude=publish.sh || true)
[ -z "$hits" ] || fail "home paths or token shapes in the export" "$hits"
# A link: is a path on THIS machine: it cannot resolve from a clean clone.
hits=$(grep -rn 'link:' "$PUB" --exclude-dir=.git --include=package.json --include='*.yaml' --include='*.yml' || true)
[ -z "$hits" ] || fail "a link: dependency survived into the export" "$hits"

# What a stranger gets. Install from the rewritten package.json (core comes
# from GitHub and builds itself) and run the same gates the private checkout
# runs. Only a real install shows some classes of trouble: a link: keeps two
# copies of every shared dependency, so a global type augmentation leaking out
# of one package never meets the other's code here.
check_log=$(mktemp -t publish-check)
for step in install typecheck test; do
  if ! (cd "$PUB" && corepack pnpm "$step") >"$check_log" 2>&1; then
    fail "the export fails '$step' from a clean install (log: $check_log)" "$(tail -20 "$check_log")"
  fi
done
echo "publish: clean install, typecheck and tests pass in $PUB"
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
