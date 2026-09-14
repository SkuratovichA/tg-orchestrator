#!/usr/bin/env bash
# Report a finished background job back into the orchestrator.
#
# The daemon is message-driven: only a Telegram message from the owner starts a
# turn. So work that outlives the turn that started it (whisper, a long build, a
# scrape) has NO way back — a turn that says "I'll report when it's done" is a
# promise nothing can keep. This is that way back: drop a record in the spool and
# the runner opens a turn on the same topic with the result in hand.
#
# CONTRACT: call this on EVERY exit path of the job, success and failure alike.
# A job that fails silently is worse than one that fails loudly.
#
# usage:
#   wake.sh --convo <chat_id>:<thread_id> --job "whisper msg 380" \
#           [--kind voice-transcript] [--fail] [--text-file PATH | --text STR] \
#           [--file PATH] [--started ISO8601]
set -euo pipefail

CONVO="" JOB="" KIND="job" OK=true TEXT="" TEXT_FILE="" FILE="" STARTED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --convo) CONVO="$2"; shift 2 ;;
    --job) JOB="$2"; shift 2 ;;
    --kind) KIND="$2"; shift 2 ;;
    --fail) OK=false; shift ;;
    --ok) OK=true; shift ;;
    --text) TEXT="$2"; shift 2 ;;
    --text-file) TEXT_FILE="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --started) STARTED="$2"; shift 2 ;;
    *) echo "wake.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$CONVO" ] || { echo "wake.sh: --convo <chat_id>:<thread_id> is required" >&2; exit 2; }
[ -n "$JOB" ] || { echo "wake.sh: --job \"<what this was>\" is required" >&2; exit 2; }

SPOOL="$HOME/.config/tg-orchestrator/wake"
mkdir -p "$SPOOL/done"
NAME="$(date -u +%Y%m%dT%H%M%S)-$$-$KIND.json"

# Written to a temp name first and moved into place: the runner reads whole
# files, and a half-written record would be dropped as unparseable.
python3 - "$SPOOL/.$NAME.tmp" "$CONVO" "$JOB" "$KIND" "$OK" "$TEXT" "$TEXT_FILE" "$FILE" "$STARTED" <<'PY'
import json, sys, datetime
tmp, convo, job, kind, ok, text, text_file, out_file, started = sys.argv[1:10]
if text_file:
    try:
        text = open(text_file, encoding="utf-8", errors="replace").read()
    except OSError as e:
        text = (text + "\n" if text else "") + f"[wake.sh: could not read {text_file}: {e}]"
rec = {
    "convo": convo,
    "job": job,
    "kind": kind,
    "ok": ok == "true",
    "text": text,
    "file": out_file or text_file or None,
    "startedAt": started or None,
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(rec, f, ensure_ascii=False)
PY
mv "$SPOOL/.$NAME.tmp" "$SPOOL/$NAME"

# Mirror the post into the durable event log (src/events.mjs). The spool answers
# "is there a pending job"; the event log answers "what happened to this job"
# long after the record was consumed and moved to done/. Best effort on every
# step — reporting a finished job must never fail because node is not on PATH
# or the log is unwritable.
EV_JSON="$(python3 -c 'import json,sys; print(json.dumps({"job": sys.argv[1], "kind": sys.argv[2], "ok": sys.argv[3] == "true", "file": sys.argv[4] or None}))' \
  "$JOB" "$KIND" "$OK" "${FILE:-$TEXT_FILE}" 2>/dev/null || true)"
if [ -n "$EV_JSON" ]; then
  node "$(dirname "$0")/../src/events.mjs" append wake_posted \
    --convo "$CONVO" --actor wake.sh --json "$EV_JSON" >/dev/null 2>&1 || true
fi

echo "wake queued: $SPOOL/$NAME"
