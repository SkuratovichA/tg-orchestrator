#!/usr/bin/env bash
# Keep an eye on a Claude Code session that lives in a tmux pane.
#
# Default is read-only: it never sends keys to the pane. It posts to Telegram
# (as the bot) when the session stalls on a permission prompt, or when its
# screen has not changed for --idle-min minutes (finished, or waiting for the
# owner). With --auto-yes it answers permission prompts itself (presses "1" =
# Yes, Enter as a fallback) — only when the numbered "1. Yes" choice is on
# screen, never on a bare input line — and reports approvals to Telegram in
# batches, at most one notice per 30 minutes.
#
# Exit paths: pane gone, --hours budget spent → Telegram notice + wake.sh so
# the orchestrator learns it stopped. SIGTERM (deliberate replacement by the
# orchestrator) → log only, no wake.
#
# usage: watch-tmux-prompt.sh <pane> <chat_id> [<thread_id>] [--hours N] [--idle-min N] [--label STR] [--auto-yes]
#   pane      tmux target, e.g. agents:2.2
#   thread_id forum topic to post into; omit for the General topic
set -uo pipefail
PANE="${1:?usage: watch-tmux-prompt.sh <pane> <chat_id> [thread_id] [--hours N] [--idle-min N] [--label STR] [--auto-yes]}"
CHAT="${2:?usage: watch-tmux-prompt.sh <pane> <chat_id> [thread_id] [--hours N] [--idle-min N] [--label STR] [--auto-yes]}"
shift 2
THREAD=""; HOURS=8; IDLE_MIN=15; LABEL=""; AUTO_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --idle-min) IDLE_MIN="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --auto-yes) AUTO_YES=1; shift ;;
    *) THREAD="$1"; shift ;;
  esac
done
# Pin the process, not the address: panes get moved between windows, and then the
# watcher silently starts reporting on whatever session took the old address over.
PANE_PID="$(tmux display -p -t "$PANE" '#{pane_pid}' 2>/dev/null || true)"
[ -n "$PANE_PID" ] || { echo "watch-tmux-prompt: no such pane: $PANE" >&2; exit 2; }
[ -n "$LABEL" ] || LABEL="$(tmux display -p -t "$PANE" '#{pane_title}' 2>/dev/null)"
[ -n "$LABEL" ] || LABEL="$PANE"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
LOG="/tmp/watch-tmux-prompt-$(echo "$PANE" | tr ':.' '__').log"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END=$(( $(date +%s) + HOURS * 3600 ))
CONVO="$CHAT:${THREAD:-0}"
EXIT_REASON="unknown"
NOTICE_EVERY=1800   # seconds between batched auto-yes notices

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$LOG"; }

send() {
  local args=(-d "chat_id=$CHAT" --data-urlencode "text=$1")
  [ -n "$THREAD" ] && args+=(-d "message_thread_id=$THREAD")
  curl -s --max-time 20 "$API/sendMessage" "${args[@]}" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); print('send', r.get('ok'), r.get('description',''))" >> "$LOG" 2>&1
}

report() {
  [ "$EXIT_REASON" = "terminated" ] && { log "terminated, no wake"; return 0; }
  "$HERE/wake.sh" --convo "$CONVO" --kind tmux-watch --ok \
    --job "watch-tmux-prompt $PANE ($LABEL): stopped, $EXIT_REASON; auto-yes pressed $approved times" \
    --started "$STARTED" --text "watcher for $PANE stopped: $EXIT_REASON; auto-yes pressed $approved times" >> "$LOG" 2>&1 || true
}
trap report EXIT
trap 'EXIT_REASON="terminated"; exit 0' TERM INT HUP

pane_alive() { tmux list-panes -t "$PANE" -F '#{pane_id}' >/dev/null 2>&1; }
find_pane_by_pid() {
  tmux list-panes -a -F '#{pane_pid} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v p="$1" '$1 == p { print $2; exit }'
}
# Returns 1 when the watched process is gone for good.
follow_pane() {
  local cur; cur="$(tmux display -p -t "$PANE" '#{pane_pid}' 2>/dev/null || true)"
  [ "$cur" = "$PANE_PID" ] && return 0
  local moved; moved="$(find_pane_by_pid "$PANE_PID")"
  [ -n "$moved" ] || return 1
  log "pane moved: $PANE -> $moved (pid $PANE_PID)"
  PANE="$moved"
}
capture() { tmux capture-pane -p -t "$PANE" -S -60 2>/dev/null; }

# Lines of the prompt block: from the tool header down to the choice list.
prompt_block() {
  printf '%s\n' "$1" | awk '
    /^ *(Bash command|Edit file|Write file|Read file|Create file|Tool use|Fetch|Web ?[Ss]earch)/ { on=1 }
    on { print }
    /Esc to cancel|Esc to exit/ { on=0 }
  ' | sed -E 's/^ +//' | grep -vE '^Tip:' | head -30 | cut -c1-220
}

PROMPT_RE='Do you want to proceed\?|Do you want to (make this edit|create|allow|run)|^ *❯ 1\. Yes|requires your approval|blocked this action'
YES_RE='^ *(❯ )?1\. Yes'   # the numbered choice list is on screen → "1" is safe to press
last_sig=""; same_n=0; idle_n=0; idle_sent=0; last_screen_hash=""
approved=0; batch_n=0; batch_head=""; last_notice=0

log "started: pane=$PANE chat=$CHAT thread='$THREAD' hours=$HOURS idle_min=$IDLE_MIN auto_yes=$AUTO_YES"
while [ "$(date +%s)" -lt "$END" ]; do
  if ! follow_pane; then
    EXIT_REASON="the watched session (pid $PANE_PID) is gone"
    send "Сторож: сессия «$LABEL» (pid $PANE_PID) закрылась. Выключаюсь. Yes нажимал $approved раз."
    exit 0
  fi
  if ! pane_alive; then
    EXIT_REASON="pane $PANE is gone"
    send "Сторож: панель $PANE ($LABEL) пропала — сессия закрыта или tmux перезапущен. Выключаюсь. Yes нажимал $approved раз."
    exit 0
  fi
  screen="$(capture)"
  hash="$(printf '%s' "$screen" | shasum | cut -c1-12)"

  if printf '%s\n' "$screen" | grep -qE "$PROMPT_RE"; then
    block="$(prompt_block "$screen")"
    [ -n "$block" ] || block="$(printf '%s\n' "$screen" | grep -vE '^\s*$' | tail -12)"
    sig="$(printf '%s' "$block" | shasum | cut -c1-12)"
    if [ "$AUTO_YES" -eq 1 ] && printf '%s\n' "$screen" | grep -qE "$YES_RE"; then
      tmux send-keys -t "$PANE" 1
      sleep 2
      if capture | grep -qE "$YES_RE"; then tmux send-keys -t "$PANE" Enter; sleep 2; fi
      if capture | grep -qE "$YES_RE"; then
        log "auto-yes FAILED, prompt still on screen (sig=$sig)"
        if [ "$sig" != "$last_sig" ]; then
          last_sig="$sig"
          send "$(printf 'Сессия «%s»: не смог нажать Yes сам, промпт остался. Глянь:\n\n%s' "$LABEL" "$block")"
        fi
      else
        approved=$((approved + 1)); batch_n=$((batch_n + 1))
        head1="$(printf '%s\n' "$block" | grep -E '^│' | head -1 | cut -c1-160)"
        [ -n "$head1" ] || head1="$(printf '%s\n' "$block" | head -2 | tail -1 | cut -c1-160)"
        [ -n "$batch_head" ] || batch_head="$head1"
        log "auto-yes #$approved: $head1"
        now="$(date +%s)"
        if [ $((now - last_notice)) -ge "$NOTICE_EVERY" ]; then
          if [ "$batch_n" -eq 1 ]; then
            send "Сессия «$LABEL»: нажал Yes на: $head1"
          else
            send "Сессия «$LABEL»: нажал Yes $batch_n раз с прошлой заметки, первый был: $batch_head"
          fi
          last_notice="$now"; batch_n=0; batch_head=""
        fi
        last_sig=""
      fi
    elif [ "$sig" != "$last_sig" ]; then
      last_sig="$sig"; same_n=0
      send "$(printf 'Сессия «%s» встала на промпте и ждёт тебя:\n\n%s\n\nНапиши «да» — нажму Yes.' "$LABEL" "$block")"
      log "prompt reported sig=$sig"
    else
      same_n=$((same_n + 1))
      if [ "$same_n" -eq 10 ] || [ "$same_n" -eq 30 ]; then
        send "Сессия «$LABEL» всё ещё стоит на том же промпте ($same_n мин)."
      fi
    fi
    idle_n=0; idle_sent=0
  else
    last_sig=""; same_n=0
    if [ "$hash" = "$last_screen_hash" ]; then
      idle_n=$((idle_n + 1))
      if [ "$idle_n" -ge "$IDLE_MIN" ] && [ "$idle_sent" -eq 0 ]; then
        tail_lines="$(printf '%s\n' "$screen" | grep -vE '^\s*$' | tail -8 | cut -c1-200)"
        send "$(printf 'Сессия «%s»: экран не менялся %s мин — закончила или ждёт тебя. Yes нажимал %s раз. Хвост экрана:\n\n%s' "$LABEL" "$idle_n" "$approved" "$tail_lines")"
        idle_sent=1
        log "idle reported after $idle_n min"
      fi
    else
      idle_n=0; idle_sent=0
    fi
  fi
  last_screen_hash="$hash"
  sleep 60
done
EXIT_REASON="time budget of ${HOURS}h ran out"
send "Сторож сессии «$LABEL» отработал свои ${HOURS} ч и выключился (Yes нажимал $approved раз). Если надо дальше — скажи."
exit 0
