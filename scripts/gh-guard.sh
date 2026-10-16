#!/usr/bin/env bash
# launchd entry for gh-guard.py; the environment a launchd run lacks (PATH to
# claude, gh and node, USER for the keychain login, a python >= 3.10) is set up in
# guard-env.sh, shared with dm-guard.sh.
#
# usage: gh-guard.sh <guard_dir> [--dry-run] [--replay-since ISO]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/guard-env.sh"
exec "$GUARD_PYTHON" "$HERE/gh-guard.py" "$@"
