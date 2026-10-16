#!/usr/bin/env bash
# Send one text message to Telegram — the single entry point for every turn.
#
# Why this exists instead of a raw curl: the Bot API echoes the sent text back
# inside its JSON response, and that echo regularly carries bytes a naive parser
# chokes on (`jq: parse error: Invalid string: control characters from U+0000
# through U+001F must be escaped`, or a json.load traceback). A caller that
# reads "parse failed" as "send failed" re-runs the identical curl and the owner
# gets the same message twice — seen three times on 20.09.2026 alone.
#
# Two defences, both required:
#   1) success is decided by `grep -q '"ok":true'` on the RAW body, never by a
#      JSON parser — the control-character class that breaks jq cannot break
#      grep. Same pattern as restart-when-idle.sh used inline before this.
#   2) an idempotency key over chat+thread+reply+the exact text bytes (the key
#      hashes bytes; the LENGTH guard below counts characters — those are two
#      different questions). A send
#      that could not be read leaves a .inflight marker behind and the next
#      attempt with the same key REFUSES: an unreadable response is not a failed
#      send, and only getUpdates / list_messages can tell the two apart.
#
# Splitting (08.10.2026, the default): a text over TG_SPLIT_MIN_CHARS characters
# with at least two blank-line blocks goes out as several messages, one thought
# each — haiku picks the cut points by meaning (src/split-plan.ts), any failure
# of it falls back to packing by blocks. The plan is cached at $KEY.plan.json so
# a re-run sends the same parts; each part is this script again with --no-split
# and its own salt, so every part keeps its own key and .inflight refusal.
#
# usage:
#   tg-send.sh --chat <id> [--thread N] [--reply N] [--salt STR] [--no-split|--plan-only] --text-file PATH
#
#   --salt       mix an extra string into the key. For callers that legitimately
#                send the SAME text more than once over their lifetime (watchers,
#                restart notices) — without it the second identical post is
#                suppressed as a duplicate forever.
#   --no-split   one message exactly as written (a block to copy, a fixed format).
#   --plan-only  print the split plan as JSON and exit; sends nothing.
#
# output: `ok=true message_id=<id>`, or for a split reply
#         `ok=true message_id=<first> message_ids=<id1,id2,…> parts=<n>`
#
# exit codes: 0 sent (or already sent) · 1 send failed / response unreadable
#             2 bad usage · 3 refused, a previous attempt is unresolved
#
# env: TG_SEND_STATE        state dir (default ~/.config/tg-orchestrator/sent)
#      TG_SEND_API          API base override, for tests only
#      TG_SPLIT_MIN_CHARS   split only above this many characters (default 700)
#      TG_SPLIT_PAUSE       seconds between parts (default 1; Bot API: 20/min per group)
#      TG_SPLIT_CLAUDE_BIN  the model command (default claude), for tests
set -uo pipefail

CFG="$HOME/.config/tg-orchestrator"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHAT="" THREAD="" REPLY="" TEXT_FILE="" SALT="" NO_SPLIT="" PLAN_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --chat) CHAT="$2"; shift 2 ;;
    --thread) THREAD="$2"; shift 2 ;;
    --reply) REPLY="$2"; shift 2 ;;
    --text-file) TEXT_FILE="$2"; shift 2 ;;
    --salt) SALT="$2"; shift 2 ;;
    --no-split) NO_SPLIT=1; shift ;;
    --plan-only) PLAN_ONLY=1; shift ;;
    *) echo "tg-send.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$CHAT" ] || { echo "tg-send.sh: --chat <id> is required" >&2; exit 2; }
[ -n "$TEXT_FILE" ] || { echo "tg-send.sh: --text-file PATH is required" >&2; exit 2; }
[ -f "$TEXT_FILE" ] || { echo "tg-send.sh: no such text file: $TEXT_FILE" >&2; exit 2; }
[ "$THREAD" = "0" ] && THREAD=""

# 4096 is the Bot API's hard limit and it counts CHARACTERS, not UTF-8 bytes.
# Everything this bot sends is Russian and Cyrillic is two bytes per character,
# so `wc -c` would refuse a perfectly valid answer at roughly half the real
# limit. Over the limit Telegram does not error — it truncates silently, and the
# turn reports a message the owner never fully received.
BYTES="$(wc -c < "$TEXT_FILE" | tr -d ' ')"
CHARS="$(python3 -c "import sys; print(len(open(sys.argv[1], encoding='utf-8').read()))" "$TEXT_FILE" 2>/dev/null)"
[ -n "$CHARS" ] || { echo "tg-send.sh: could not read $TEXT_FILE as UTF-8 text" >&2; exit 2; }
[ "$CHARS" -gt 0 ] || { echo "tg-send.sh: text file is empty" >&2; exit 2; }

PLANNER="$HERE/../src/split-plan.mjs"
MIN_CHARS="${TG_SPLIT_MIN_CHARS:-700}"
if [ -n "$PLAN_ONLY" ]; then
  node "$PLANNER" plan --text-file "$TEXT_FILE" --min-chars "$MIN_CHARS"
  exit $?
fi

# The key is over the exact bytes, so a retry of the same post collides with it
# and a genuinely different post does not.
STATE="${TG_SEND_STATE:-$CFG/sent}"
mkdir -p "$STATE"
KEY="$(printf '%s|%s|%s|%s|' "$CHAT" "$THREAD" "$REPLY" "$SALT" | cat - "$TEXT_FILE" | shasum -a 256 | cut -c1-16)"
REC="$STATE/$KEY"
MARK="$STATE/$KEY.inflight"

if [ -f "$REC" ]; then
  PREV="$(sed -n 's/^message_id=//p' "$REC" | head -1)"
  echo "already-sent message_id=$PREV — NOT resending"
  exit 0
fi

# Split path. One part (short, a single block, or a fallback that fits) falls
# through to the single-message path below with the ORIGINAL bytes and key.
if [ -z "$NO_SPLIT" ] && [ "$CHARS" -gt "$MIN_CHARS" ]; then
  PLAN="$STATE/$KEY.plan.json"
  N="$(node "$PLANNER" plan --text-file "$TEXT_FILE" --min-chars "$MIN_CHARS" --out "$PLAN")" \
    || { echo "tg-send.sh: split planner failed, sending as one message" >&2; N=1; }
  if [ "${N:-1}" -ge 2 ] 2>/dev/null; then
    IDS=()
    for i in $(seq 1 "$N"); do
      PART="$STATE/$KEY.part$i.txt"
      node "$PLANNER" part --plan "$PLAN" --index "$i" > "$PART" \
        || { echo "tg-send.sh: could not read part $i of $PLAN" >&2; exit 1; }
      SUB=(--chat "$CHAT" --no-split --salt "$KEY:part$i" --text-file "$PART")
      [ -n "$THREAD" ] && SUB+=(--thread "$THREAD")
      # The reply goes on the first part only; the rest follow it in the thread.
      [ "$i" -eq 1 ] && [ -n "$REPLY" ] && SUB+=(--reply "$REPLY")
      OUT="$(bash "${BASH_SOURCE[0]}" "${SUB[@]}")"
      RC=$?
      if [ "$RC" -ne 0 ]; then
        echo "tg-send.sh: part $i of $N NOT sent (rc=$RC); parts before it are in the chat. Re-run the same command: it skips the parts already sent." >&2
        exit "$RC"
      fi
      IDS+=("$(printf '%s\n' "$OUT" | sed -n 's/.*message_id=\([0-9a-z]*\).*/\1/p' | head -1)")
      # Bot API: 20 messages a minute per group. A skipped part costs no pause.
      case "$OUT" in ok=true*) [ "$i" -lt "$N" ] && sleep "${TG_SPLIT_PAUSE:-1}" ;; esac
    done
    CSV="$(IFS=,; echo "${IDS[*]}")"
    {
      echo "message_id=${IDS[0]}"
      echo "message_ids=$CSV"
      echo "parts=$N"
      echo "chat=$CHAT"
      echo "thread=${THREAD:-}"
      echo "reply=${REPLY:-}"
      echo "chars=$CHARS"
      echo "bytes=$BYTES"
      echo "sent_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$REC"
    rm -f "$STATE/$KEY".part*.txt
    echo "ok=true message_id=${IDS[0]} message_ids=$CSV parts=$N"
    exit 0
  fi
fi

if [ "$CHARS" -gt 4096 ]; then
  echo "tg-send.sh: text is $CHARS characters ($BYTES bytes), Telegram's limit is 4096 characters — split it or send it as a file (sendDocument)." >&2
  exit 2
fi

if [ -f "$MARK" ]; then
  echo "tg-send.sh: REFUSING to send. A previous attempt with this key ($KEY) left an unreadable response:" >&2
  sed 's/^/  /' "$MARK" >&2
  echo "An unreadable response is NOT a failed send — the message may already be in the chat." >&2
  echo "VERIFY first: getUpdates, or the Telegram MCP list_messages on chat $CHAT${THREAD:+ thread $THREAD}." >&2
  echo "If it is not there, delete $MARK and run this again." >&2
  exit 3
fi

# Token: same convention as restart-when-idle.sh — the daemon's env file holds
# it; a turn that already has it in its environment keeps it. Resolved BEFORE
# the marker is written, so a missing token cannot leave a key blocked.
if [ -n "${TG_SEND_API:-}" ]; then
  API="$TG_SEND_API"
else
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && [ -f "$CFG/env" ]; then
    set -a; . "$CFG/env"; set +a
  fi
  API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
fi

{
  echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "chat=$CHAT"
  echo "thread=${THREAD:-}"
  echo "reply=${REPLY:-}"
  echo "text_file=$TEXT_FILE"
  echo "chars=$CHARS"
  echo "bytes=$BYTES"
} > "$MARK"

RESP="$(mktemp -t tgsend)"
trap 'rm -f "$RESP"' EXIT

args=(-d chat_id="$CHAT")
[ -n "$THREAD" ] && args+=(-d message_thread_id="$THREAD")
[ -n "$REPLY" ] && args+=(-d reply_to_message_id="$REPLY")
# text@FILE sends the file's bytes url-encoded: no shell quoting, no arg-length
# limit, and the bytes that were hashed are the bytes that go out.
args+=(--data-urlencode "text@$TEXT_FILE")

curl -sS --max-time 25 -o "$RESP" "$API/sendMessage" "${args[@]}" 2>>"$RESP"
CURL_RC=$?

# The whole point: grep on the raw body. No jq, no json.load — the echoed text
# in the response is exactly what breaks those.
if [ "$CURL_RC" -eq 0 ] && grep -q '"ok":true' "$RESP"; then
  # Real parsing FIRST, with strict=False: that flag accepts the raw U+0000–
  # U+001F bytes the Bot API echoes back inside the sent text, which is the exact
  # class that made jq and a default json.load fail. The parse never had to fail
  # at all — all three duplicate sends of 20.09.2026 came from treating it as a
  # failed send.
  MSG_ID="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.buffer.read().decode("utf-8","replace"), strict=False)["result"]["message_id"])' < "$RESP" 2>/dev/null)"
  PARSED=true
  if [ -z "$MSG_ID" ]; then
    # Degraded fallback. `grep -o` emits matches in document order, so head -1 is
    # result.message_id and NOT the nested reply_to_message.message_id; a greedy
    # `sed -n 's/.*"message_id":\([0-9]*\).*/\1/p'` returns the reply TARGET
    # instead. The quote in the pattern also keeps message_thread_id out.
    # This is a positional heuristic, so it is marked as such below: ids in a
    # forum group are chat-wide, an id taken this way can name a message in a
    # different topic, and any future deleteMessage path MUST refuse to act on an
    # id recorded with parsed=false.
    PARSED=false
    MSG_ID="$(grep -o '"message_id":[0-9]*' "$RESP" | head -1 | grep -o '[0-9]*')"
  fi
  {
    echo "message_id=${MSG_ID:-unknown}"
    echo "parsed=$PARSED"
    echo "chat=$CHAT"
    echo "thread=${THREAD:-}"
    echo "reply=${REPLY:-}"
    echo "chars=$CHARS"
    echo "bytes=$BYTES"
    echo "sent_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$REC"
  rm -f "$MARK"

  # Mirror into the durable event log (src/events.mjs), same invocation shape as
  # wake.sh. Best effort on every step: a rejected event must never turn a
  # delivered message into a reported failure. `text` (the first 500 characters)
  # is what the guest classifier shows haiku as the bot's own recent words
  # (src/guest-classify.ts); an unreadable file leaves it null, never the send.
  EV_JSON="$(python3 -c '
import json, sys
def head(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read(500)
    except Exception:
        return None
print(json.dumps({"message_id": sys.argv[1], "key": sys.argv[2], "chars": int(sys.argv[3]), "bytes": int(sys.argv[4]), "reply_to": sys.argv[5] or None, "parsed": sys.argv[6] == "true", "text": head(sys.argv[7])}))' \
    "${MSG_ID:-unknown}" "$KEY" "$CHARS" "$BYTES" "${REPLY:-}" "$PARSED" "$TEXT_FILE" 2>/dev/null || true)"
  if [ -n "$EV_JSON" ]; then
    node "$HERE/../src/events.mjs" append outbound \
      --convo "$CHAT:${THREAD:-0}" --actor tg-send.sh --json "$EV_JSON" >/dev/null 2>&1 || true
  fi

  echo "ok=true message_id=${MSG_ID:-unknown}"
  exit 0
fi

# Marker stays. Whatever happened here, we do NOT know that the message did not
# arrive — and the next attempt must stop and check rather than post again.
echo "tg-send.sh: send NOT confirmed (curl rc=$CURL_RC). Response head:" >&2
head -c 400 "$RESP" >&2; echo >&2
echo "Marker kept at $MARK — the next call with this key will refuse until you verify." >&2
exit 1
