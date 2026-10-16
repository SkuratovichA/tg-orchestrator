#!/usr/bin/env bash
# Restart the tg-orchestrator daemon without killing a turn.
#
# A runner change is dead code until the daemon is restarted, but the daemon
# cannot restart itself from inside a turn: killing it kills the very turn that
# would report the result. And a watcher that samples status.json and kills
# "when idle" has a race of its own: a turn can start between its last sample
# and its kill. So this does not kill a live runner at all — it asks it to
# drain: touch $CFG/drain, the runner stops taking new work, finishes what is
# queued and in flight, and exits. Only then is the new code started.
#
# Fallback for a runner that predates the drain flag (does not acknowledge it
# within ACK_WAIT seconds): the old kill-on-two-idle-readings path.
#
# It reports through the Bot API directly, NOT through wake.sh: a restart that
# fails leaves no runner to read the wake spool, and a silent dead bot is the
# one outcome that must never happen.
#
# usage: scripts/restart-when-idle.sh <chat_id>:<thread_id> [max_wait_seconds]
set -uo pipefail

CFG="$HOME/.config/tg-orchestrator"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONVO="${1:?usage: restart-when-idle.sh <chat_id>:<thread_id> [max_wait_s]}"
MAX="${2:-3900}" # > the 50-min turn timeout: a drain can legitimately take one full turn
ACK_WAIT=75      # the runner notices the flag at the top of its loop, i.e. within one 50 s long-poll
CHAT="${CONVO%%:*}"; THREAD="${CONVO##*:}"
DRAIN="$CFG/drain"

set -a; . "$CFG/env"; set +a

# The send itself lives in scripts/tg-send.sh — one implementation for the whole
# repo, grep-on-raw-body success detection and an idempotency key, so a response
# that cannot be read never turns into a second copy of the same message.
say() {
  local f; f="$(mktemp -t tgrestart)"
  printf '%s' "$1" > "$f"
  local args=(--chat "$CHAT" --text-file "$f")
  [ -n "$THREAD" ] && [ "$THREAD" != "0" ] && args+=(--thread "$THREAD")
  # --salt: a restart notice can legitimately repeat word for word across runs;
  # without it the key would treat the second one as a duplicate forever.
  "$HERE/tg-send.sh" "${args[@]}" --salt "restart-$$-$(date +%s)" > /dev/null \
    || echo "sendMessage failed" >&2
  rm -f "$f"
}

phase() { sed -n 's/.*"phase":"\([a-z]*\)".*/\1/p' "$CFG/status.json" 2>/dev/null; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

OLD=$(cat "$CFG/runner.pid" 2>/dev/null || echo "")
HOW=""
if ! alive "$OLD"; then
  HOW="раннер не был запущен"
else
  touch "$DRAIN"
  # 1) acknowledgment: the runner switches to draining (or exits at once when idle)
  waited=0; acked=0
  while [ "$waited" -lt "$ACK_WAIT" ]; do
    p=$(phase)
    if ! alive "$OLD" || [ "$p" = "draining" ] || [ "$p" = "down" ] || [ ! -e "$DRAIN" ]; then acked=1; break; fi
    sleep 3; waited=$((waited + 3))
  done
  if [ "$acked" -eq 1 ]; then
    # 2) let it finish: no kill, the runner exits by itself when nothing is left
    waited=0
    while alive "$OLD" && [ "$waited" -lt "$MAX" ]; do sleep 5; waited=$((waited + 5)); done
    if alive "$OLD"; then
      rm -f "$DRAIN"
      say "⚠️ Рестарт раннера не сделан: за $((MAX / 60)) мин он не закончил дренаж (phase=$(phase)). Старый код всё ещё в памяти, pid $OLD; flag снят, ходы не трогал."
      exit 1
    fi
    HOW="дренаж: раннер сам доделал ходы и вышел"
  else
    # 3) legacy runner: it ignores the flag, so fall back to killing on idle
    rm -f "$DRAIN"
    waited=0; idle=0
    while [ "$waited" -lt "$MAX" ]; do
      if [ "$(phase)" = "idle" ]; then idle=$((idle + 1)); else idle=0; fi
      [ "$idle" -ge 2 ] && break
      sleep 5; waited=$((waited + 5))
    done
    if [ "$idle" -lt 2 ]; then
      say "⚠️ Рестарт раннера не сделан: за $((MAX / 60)) мин он ни разу не был idle (сейчас phase=$(phase)). Старый код всё ещё в памяти, pid $OLD."
      exit 1
    fi
    kill "$OLD" 2>/dev/null
    for _ in $(seq 1 20); do alive "$OLD" || break; sleep 1; done
    alive "$OLD" && kill -9 "$OLD" 2>/dev/null && sleep 2
    HOW="старый раннер без drain — убит на idle"
  fi
fi

bash "$HERE/../ensure.sh" > /dev/null 2>&1
sleep 3
NEW=$(cat "$CFG/runner.pid" 2>/dev/null || echo "")
if ! alive "$NEW"; then
  bash "$HERE/../ensure.sh" > /dev/null 2>&1; sleep 3
  NEW=$(cat "$CFG/runner.pid" 2>/dev/null || echo "")
fi

UP=$(grep 'tg-orchestrator up' "$CFG/runner.log" | tail -1)
if alive "$NEW"; then
  say "♻️ Раннер перезапущен на новом коде: pid ${OLD:-—} → $NEW ($HOW).
$UP"
else
  say "🔴 РАННЕР НЕ ПОДНЯЛСЯ после рестарта (был pid ${OLD:-—}). Бот сейчас глухой, нужен ручной запуск:
cd $HERE/.. && bash ensure.sh
Хвост лога:
$(tail -5 "$CFG/runner.log")"
  exit 1
fi
