#!/usr/bin/env bash
# launchd entry for dm-guard.py; the environment a launchd run lacks is set up in
# guard-env.sh, shared with gh-guard.sh.
#
# usage: dm-guard.sh <guard_dir> [--dry-run] [--replay-from MSG_ID]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/guard-env.sh"
exec "$GUARD_PYTHON" "$HERE/dm-guard.py" "$@"
