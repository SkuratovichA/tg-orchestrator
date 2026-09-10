#!/usr/bin/env bash
# Local fallback for Telegram voice transcription.
#
# Use when mcp__telegram__transcribe_voice returns GEN-ERR-NNN and
# $TELEGRAM_MCP_DIR/mcp_errors.log shows
# "Request was unsuccessful 6 time(s)" / InterdcCallError — that is Telegram's
# backend failing, retrying is pointless.
#
# A 6-minute note takes several minutes to transcribe, i.e. longer than the turn
# that starts it. Pass <convo> and the script reports itself back through the
# wake spool when it finishes — success or failure. WITHOUT <convo> nothing
# reports back and the result only reaches whoever is watching stdout; that is
# how a transcript sat unread in /tmp for a day on 05.09. Always pass it.
#
# Usage: transcribe-fallback.sh <chat_id> <message_id> [<chat_id>:<thread_id>]
set -euo pipefail

CHAT_ID="${1:?usage: transcribe-fallback.sh <chat_id> <message_id> [convo]}"
MSG_ID="${2:?usage: transcribe-fallback.sh <chat_id> <message_id> [convo]}"
CONVO="${3:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Checkout of the Telegram MCP (Telethon session + .env live there).
MCP_REPO="${TELEGRAM_MCP_DIR:-$HOME/git/telegram-mcp}"
PY="$MCP_REPO/.venv/bin/python"
WORK="/tmp/tg-voice-$MSG_ID"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$WORK"
: > "$WORK/run.log"

STAGE="init"
DONE=false
# Every exit path reports. Without this trap a `set -e` abort — a missing venv, a
# dead uvx, ffmpeg on a corrupt download — kills the script mid-way and the
# caller is left waiting on a job that will never speak again.
report() {
  local rc=$?
  $DONE && return 0
  [ -n "$CONVO" ] || { echo "transcribe-fallback: FAILED at $STAGE (rc=$rc), no --convo to report to" >&2; return 0; }
  "$HERE/wake.sh" --convo "$CONVO" --kind voice-transcript --fail \
    --job "local whisper for voice msg $MSG_ID (failed at: $STAGE, rc=$rc)" \
    --started "$STARTED" --text-file "$WORK/run.log" --file "$WORK/run.log" >&2 || true
}
trap report EXIT

STAGE="download (telethon)"
"$PY" - "$CHAT_ID" "$MSG_ID" "$WORK/voice.ogg" "$MCP_REPO/.env" >> "$WORK/run.log" 2>&1 <<'PY'
import asyncio, os, sys
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.sessions import StringSession

chat_id, msg_id, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
load_dotenv(sys.argv[4])


async def main():
    cl = TelegramClient(
        StringSession(os.environ["TELEGRAM_SESSION_STRING_PERSONAL"]),
        int(os.environ["TELEGRAM_API_ID"]),
        os.environ["TELEGRAM_API_HASH"],
    )
    await cl.start()
    # get_input_entity, not get_entity — otherwise Telethon raises a bogus
    # PeerIdInvalidError because the peer never gets resolved.
    peer = await cl.get_input_entity(chat_id)
    msg = (await cl.get_messages(peer, ids=[msg_id]))[0]
    if msg is None:
        raise SystemExit(f"message {msg_id} not found in {chat_id}")
    if not msg.voice and not msg.video_note and not msg.audio:
        raise SystemExit(f"message {msg_id} carries no voice/audio")
    await cl.download_media(msg, file=out)
    await cl.disconnect()


asyncio.run(main())
PY

STAGE="ffmpeg decode"
ffmpeg -y -loglevel error -i "$WORK/voice.ogg" -ar 16000 -ac 1 -c:a pcm_s16le "$WORK/voice.wav" \
  >> "$WORK/run.log" 2>&1

STAGE="mlx-whisper"
uvx --from mlx-whisper mlx_whisper \
  --model mlx-community/whisper-large-v3-turbo \
  --language "${WHISPER_LANGUAGE:-ru}" --output-format txt --output-dir "$WORK" \
  "$WORK/voice.wav" >> "$WORK/run.log" 2>&1

STAGE="verify output"
# whisper can exit 0 having written nothing (empty audio, model download half
# done). An empty transcript reported as success is the same silence one layer up.
[ -s "$WORK/voice.txt" ] || { echo "voice.txt missing or empty after whisper" >> "$WORK/run.log"; exit 1; }

DONE=true
trap - EXIT
if [ -n "$CONVO" ]; then
  "$HERE/wake.sh" --convo "$CONVO" --kind voice-transcript --ok \
    --job "local whisper for voice msg $MSG_ID" \
    --started "$STARTED" --text-file "$WORK/voice.txt" --file "$WORK/voice.txt" >&2
fi
cat "$WORK/voice.txt"
