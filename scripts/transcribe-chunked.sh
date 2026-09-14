#!/usr/bin/env bash
# Parallel local transcription of a long Telegram voice note.
#
# Downloads the audio (Telethon), decodes to 16 kHz mono, cuts it at silences
# nearest to even chunk boundaries (no overlap, no duplicated words), runs
# mlx-whisper on the chunks with N parallel workers on the GPU, and joins the
# texts in order. Prints the transcript to stdout and writes it to
# /tmp/tg-voice-<msg_id>/voice.txt. With <convo> it reports through wake.sh on
# every exit path, like transcribe-fallback.sh.
#
# usage: transcribe-chunked.sh <chat_id> <message_id> [<chat_id>:<thread_id>] [--workers N] [--chunk-sec S]
set -euo pipefail
CHAT_ID="${1:?usage: transcribe-chunked.sh <chat_id> <message_id> [convo] [--workers N] [--chunk-sec S]}"
MSG_ID="${2:?usage: transcribe-chunked.sh <chat_id> <message_id> [convo] [--workers N] [--chunk-sec S]}"
shift 2
CONVO=""; WORKERS=4; CHUNK_SEC=120
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) WORKERS="$2"; shift 2 ;;
    --chunk-sec) CHUNK_SEC="$2"; shift 2 ;;
    *) CONVO="$1"; shift ;;
  esac
done
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_REPO="${TELEGRAM_MCP_DIR:-$HOME/git/telegram-mcp}"
PY="$MCP_REPO/.venv/bin/python"
WORK="/tmp/tg-voice-$MSG_ID"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$WORK/chunks"
: > "$WORK/run.log"
STAGE="init"; DONE=false

report() {
  local rc=$?
  $DONE && return 0
  [ -n "$CONVO" ] || { echo "transcribe-chunked: FAILED at $STAGE (rc=$rc), no convo to report to" >&2; return 0; }
  "$HERE/wake.sh" --convo "$CONVO" --kind voice-transcript --fail \
    --job "chunked whisper for voice msg $MSG_ID (failed at: $STAGE, rc=$rc)" \
    --started "$STARTED" --text-file "$WORK/run.log" --file "$WORK/run.log" >&2 || true
}
trap report EXIT

STAGE="download (telethon)"
[ -s "$WORK/voice.ogg" ] || "$PY" "$HERE/tg-download-voice.py" "$CHAT_ID" "$MSG_ID" "$WORK/voice.ogg" "$MCP_REPO/.env" >> "$WORK/run.log" 2>&1

STAGE="ffmpeg decode"
ffmpeg -y -loglevel error -i "$WORK/voice.ogg" -ar 16000 -ac 1 -c:a pcm_s16le "$WORK/voice.wav" >> "$WORK/run.log" 2>&1

STAGE="split at silences"
# Cut points: for each k*CHUNK_SEC pick the middle of the nearest silence (>=0.35 s, < -30 dB) within ±CHUNK_SEC/2.
python3 - "$WORK/voice.wav" "$WORK/chunks" "$CHUNK_SEC" >> "$WORK/run.log" 2>&1 <<'PY'
import re, subprocess, sys, wave
wav, out_dir, chunk = sys.argv[1], sys.argv[2], float(sys.argv[3])
with wave.open(wav) as w:
    total = w.getnframes() / w.getframerate()
det = subprocess.run(["ffmpeg", "-i", wav, "-af", "silencedetect=noise=-30dB:d=0.35", "-f", "null", "-"],
                     capture_output=True, text=True).stderr
starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", det)]
ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", det)]
mids = [(s + e) / 2 for s, e in zip(starts, ends)]
cuts = []
k = 1
while k * chunk < total - chunk / 2:
    target = k * chunk
    near = [m for m in mids if abs(m - target) <= chunk / 2 and (not cuts or m > cuts[-1] + 10)]
    cuts.append(min(near, key=lambda m: abs(m - target)) if near else target)
    k += 1
bounds = [0.0] + cuts + [total]
for i in range(len(bounds) - 1):
    a, b = bounds[i], bounds[i + 1]
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ss", f"{a:.3f}", "-to", f"{b:.3f}",
                    "-c", "copy", f"{out_dir}/c{i:03d}.wav"], check=True)
print(f"total={total:.1f}s chunks={len(bounds)-1} cuts={[round(c,1) for c in cuts]}")
PY

STAGE="mlx-whisper x$WORKERS"
# WHISPER_LANGUAGE=auto lets whisper detect the language per chunk (mixed-language recordings).
export WL="${WHISPER_LANGUAGE:-ru}"
# Path goes in as $1 (-n 1), not via -I: BSD xargs caps an -I command line at 255 bytes after replacement.
ls "$WORK"/chunks/c*.wav | xargs -P "$WORKERS" -n 1 sh -c \
  'f="$1"; if [ "$WL" = auto ]; then set --; else set -- --language "$WL"; fi; uvx --from mlx-whisper mlx_whisper --model mlx-community/whisper-large-v3-turbo "$@" --output-format txt --output-dir "$(dirname "$f")" "$f" >> "$(dirname "$f")/../run.log" 2>&1' _

STAGE="join"
: > "$WORK/voice.txt"
for f in "$WORK"/chunks/c*.txt; do
  [ -s "$f" ] || { echo "empty chunk transcript: $f" >> "$WORK/run.log"; exit 1; }
  cat "$f" >> "$WORK/voice.txt"; printf '\n\n' >> "$WORK/voice.txt"
done
[ -s "$WORK/voice.txt" ] || { echo "voice.txt empty after join" >> "$WORK/run.log"; exit 1; }
DONE=true
trap - EXIT
if [ -n "$CONVO" ]; then
  "$HERE/wake.sh" --convo "$CONVO" --kind voice-transcript --ok \
    --job "chunked whisper for voice msg $MSG_ID" \
    --started "$STARTED" --text-file "$WORK/voice.txt" --file "$WORK/voice.txt" >&2
fi
cat "$WORK/voice.txt"
