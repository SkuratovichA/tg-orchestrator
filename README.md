# tg-orchestrator

A personal [Claude Code](https://claude.com/claude-code) orchestrator that lives
in a Telegram forum group. One bot, one owner. Every forum topic is a
workstream with its own long-lived Claude session; the agent has the whole
machine — shell, files, your scripts, the transcripts of every other Claude
session — and answers back through the Bot API.

Why: development happens in many places at once and the state of it is
scattered across scripts, sessions and dashboards. Telegram is the one interface
that is always open and where nothing gets lost. The bot is the structured index
over all of it, and a pair of hands on the machine.

## What it does

- **A topic is a session.** Each `chat_id:thread_id` resumes its own
  `claude -p` session; it resets after 6 h of silence or `/reset`.
- **Bursts.** Messages typed in a row (three texts and two voice notes) arrive
  as one turn. A "flush word" (`читай`, `го`, `/answer`, …) closes the window
  at once and is not forwarded to the model.
- **Parallel turns across topics, serial within one.** A question in one topic
  never waits for an analysis running in another. Messages typed while a topic
  is mid-turn fold into its next turn instead of waiting unread in Telegram.
- **Wake spool.** A turn can start work that outlives it (a long transcription,
  a build, a scrape). The job reports back with `scripts/wake.sh` and the runner
  opens a new turn on the same topic with the result in hand — so "I'll report
  back" is a mechanism, not a promise.
- **Message-claim registry.** A SQLite arbiter (`src/claims.mjs`) that several
  agents on one machine consult before writing into a chat: message claims,
  chat leases with a live-pid check, optional hand-over through
  claude-coop mailboxes. No two agents answer the same
  message.
- **Turn safety.** Hard cap per turn (default 50 min) with a warning posted to
  the topic 5 minutes before the kill; a result printed by a process that then
  hangs is still accepted; a turn that already acted is never re-run.
- **Restart without killing a turn.** `scripts/restart-when-idle.sh` asks the
  runner to drain: it stops taking work, finishes what is in flight, exits by
  itself; only then the new code starts.
- **Monitoring.** `src/status.mjs`: daemon phase, in-flight turns, a peek into
  the live transcript, undelivered updates on Telegram's side, usage rollups.
  `/status` in Telegram answers instantly without a model.
- **`src/sessions.mjs`** — "what was I doing across all my Claude projects?"
  Reads the head and tail of every session transcript on the machine, for every
  Claude config dir (`~/.claude`, `~/.claude-<name>`).

## Requirements

- macOS or Linux, Node ≥ 22.5 (uses `node:sqlite`, no npm dependencies).
- The `claude` CLI, logged in.
- A Telegram bot from @BotFather, added to your forum group as an administrator
  with **Manage Topics**.
- Optional, for the local voice-transcription fallback: `ffmpeg`, `uvx`
  (mlx-whisper) and a checkout of a Telethon-based Telegram MCP that holds your
  user session.

## Install

1. Configuration lives outside the repo:
   ```sh
   mkdir -p ~/.config/tg-orchestrator
   cp .env.example ~/.config/tg-orchestrator/env
   chmod 600 ~/.config/tg-orchestrator/env
   ```
   Fill in `TELEGRAM_BOT_TOKEN` and `OWNER_ID` (your numeric user id — messages
   from anyone else are dropped before they reach a model).
2. The system prompt: `cp agent.example.md agent.md` and make it yours. It is
   the agent's contract — how to answer (Bot API only), what to do with voice
   notes, when a background job must call `wake.sh`, how to check the registry
   before writing into a chat.
3. Start: `bash ensure.sh` — idempotent, safe to call from a cron or a launchd
   job. A launchd job that keeps it alive:
   ```xml
   <!-- ~/Library/LaunchAgents/tg-orchestrator.plist -->
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>tg-orchestrator</string>
     <key>ProgramArguments</key>
     <array><string>/bin/bash</string><string>/path/to/tg-orchestrator/ensure.sh</string></array>
     <key>RunAtLoad</key><true/>
     <key>StartInterval</key><integer>300</integer>
   </dict></plist>
   ```
   `launchctl load ~/Library/LaunchAgents/tg-orchestrator.plist`.
4. Check: DM the bot, it answers. `/status` shows the daemon is alive.

## How a turn works

```
getUpdates (long-poll)
  → owner-only filter → claim every message in the registry
  → burst window (sliding, closed early by a flush word; commands bypass it)
  → group by topic → per-topic queue (scheduler.mjs)
  → claude -p --resume <topic session> --append-system-prompt-file agent.md
      stream-json: tool calls and the final result are seen as they happen
  → result accepted, session id saved, cost booked to ~/.config/tg-orchestrator/usage.jsonl
  → message settled in the registry (answered / failed)
```

The agent answers through the Bot API itself; the runner posts only
infrastructure messages (a timeout warning, "could not process", `/status`).

Per-topic brains: drop `agents/<chat_id>_<thread_id>.md` and that topic gets it
as its system prompt instead of `agent.md`. Such a file must be self-contained.

## Configuration

All in `~/.config/tg-orchestrator/env` (or the process environment).

| variable | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | bot token |
| `OWNER_ID` | — | the only Telegram user the bot listens to |
| `TG_CLAUDE_TIMEOUT_MS` | 50 min | hard cap per turn; warning to the topic 5 min before |
| `TG_MAX_PARALLEL_TURNS` | 3 | topics in a turn at once (one topic is always serial) |
| `TG_CLAUDE_MODEL`, `TG_CLAUDE_EFFORT` | runner defaults | passed to `claude -p` |
| `CLAIMS_DB` | `~/.config/claude-agents/claims.sqlite` | registry database, shared with other agents |
| `CLAIMS_COOP` | first existing `~/git/work/claude-coop`, `~/git/claude-coop`, `~/claude-coop` | claude-coop `coop.sh`, for hand-over |
| `CLAUDE_HOMES` | every `~/.claude*` | config dirs `sessions.mjs` scans |
| `TELEGRAM_MCP_DIR`, `WHISPER_LANGUAGE` | `~/git/telegram-mcp`, `ru` | voice fallback |

Runtime state: `~/.config/tg-orchestrator/` — `state.json` (offset, sessions),
`status.json` (heartbeat), `usage.jsonl` (ledger), `runner.log`, `wake/`
(spool), `runner.pid`, `drain` (restart flag). `state.json` and `status.json`
are written atomically (tmp + rename), so another process never reads a torn
file.

## Layout

```
ensure.sh                 idempotent start (the launchd/cron entrypoint)
src/runner.mjs            the daemon: poll, burst, dispatch, wake spool, commands, heartbeat
src/turn.mjs              one claude turn: stream-json, timeout + warning, grace kill after
                          result, retry decision, registry claims for incoming messages
src/scheduler.mjs         per-topic queues, parallel across topics, serial within one
src/claims.mjs            the registry (library + CLI: owner / claim / release / lease / ask / inbox)
src/status.mjs            monitoring snapshot (--watch, --json)
src/sessions.mjs          recent / search / show across every Claude session on the box
src/arc-cdp.mjs           dependency-free Chrome DevTools driver (for browser chores)
scripts/wake.sh           background-job → turn bridge (call on every exit path)
scripts/restart-when-idle.sh   drain-based restart
scripts/transcribe-fallback.sh local whisper for a voice note, reports through wake.sh
scripts/publish.sh        export the public subset of a private fork into its own repo
test/                     node:test suites, no dependencies
agent.example.md          system prompt template → agent.md
.env.example              → ~/.config/tg-orchestrator/env
```

## Operations

**Background jobs.** Anything that outlives the turn that started it must
report on every exit path:
```sh
scripts/wake.sh --convo "<chat_id>:<thread_id>" --job "whisper msg 380" \
  --ok --text-file /tmp/result.txt          # or --fail --text-file /tmp/err.log
```
The runner queues the record on that topic (after the turn that is already
running there, if any) and the agent continues where it left off. A record
older than 30 minutes is marked LATE so the agent says "this arrived late"
instead of presenting it as fresh.

**Registry CLI.**
```sh
node src/claims.mjs owner <chat_id> [--thread N]      # exit 0 free, 3 held by a live agent
node src/claims.mjs claim <chat_id> <msg_id> --owner me
node src/claims.mjs lease <chat_id> --owner me --ttl 2h ; ... ; unlease
node src/claims.mjs status
```

**Restart on new code.** `scripts/restart-when-idle.sh <chat_id>:<thread_id>`
— touches the drain flag, waits for the runner to finish and exit, starts the
new code, reports the outcome into that topic (a failed restart is reported too;
a silent dead bot is the one outcome this whole design avoids).

**Logs.** `~/.config/tg-orchestrator/runner.log`; per-message decisions are
logged as `claimed / already-claimed / already-handled / busy`, per-turn as
`claude ok / FAILED / retry-fresh / retry-suppressed`.

## Tests

```sh
npm test      # node --test test/*.test.mjs
npm run check # node --check + bash -n over everything
```

- `scheduler.test.mjs` — hand-written cases plus a seeded randomized run over
  interleavings: the same topic never runs twice at once, the cap holds, every
  item runs exactly once and in order.
- `turn.test.mjs` — the turn lifecycle against a fake `claude` binary: result
  accepted after a hang, retry only for a turn that did nothing, claims.
- `claims.test.mjs` — 24 processes racing for the same message; exactly one
  wins.

## Caveats

- The agent runs `claude --dangerously-skip-permissions` as your user on your
  machine. The owner-only filter is the security boundary: never hand the bot
  token to anyone, never add the bot to a chat you do not control.
- Bot-facing strings (`/help`, the timeout warning, `/reset`) are in Russian —
  the author's language. Internationalising them is a one-file change waiting
  for a second user.
- Built for one person; there is no multi-user mode and none planned.

## License

MIT.
