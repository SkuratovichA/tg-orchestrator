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
  as one turn. Done sooner? React to any message still waiting — any emoji — and
  the window closes at once; the reaction itself never reaches the model. Flush
  words do the same, but only if `TG_FLUSH_WORDS` is set (there are none by
  default any more).
- **Auto-topics.** A message dropped into the forum's General gets a topic of
  its own immediately: the runner creates it with a provisional `⏳ …` name taken
  from the message, copies the message in, leaves a pointer in General, and asks
  the model (in the message header) to rename the topic once the subject is
  clear. One burst = one topic. `TG_AUTO_TOPIC=0` switches it off.
- **Parallel turns across topics, serial within one.** A question in one topic
  never waits for an analysis running in another. Messages typed while a topic
  is mid-turn fold into its next turn instead of waiting unread in Telegram.
- **Wake spool.** A turn can start work that outlives it (a long transcription,
  a build, a scrape). The job reports back with `scripts/wake.sh` and the runner
  opens a new turn on the same topic with the result in hand — so "I'll report
  back" is a mechanism, not a promise. The record's shape, the rename that
  claims it exactly once, the dead-letter paths and the prompt it becomes live
  in `src/wake/spool.ts`; the daemon only wires them up.
- **Message-claim registry.** A SQLite arbiter (`src/claims.mjs`) that several
  agents on one machine consult before writing into a chat: message claims,
  chat leases with a live-pid check, optional hand-over through
  claude-coop mailboxes. No two agents answer the same
  message.
- **Turn safety.** Hard cap per turn (default 50 min) with a warning posted to
  the topic 5 minutes before the kill; a result printed by a process that then
  hangs is still accepted; a turn that already acted is never re-run.
- **Model fallback.** When the model a turn runs on answers "you're out of usage
  credits", the turn does not die: the SAME session is continued on
  `TG_CLAUDE_FALLBACK_MODEL` with a RUNNER NOTICE telling the agent what it is
  looking at, so nothing already done is repeated. The daemon then remembers it
  and starts the next turns on the fallback for `TG_CLAUDE_FALLBACK_TTL_MS`
  (60 min), after which one turn probes the original model again. The topic is
  told on both transitions and `/status` names the model while it is on.
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

- macOS or Linux, Node ≥ 22.18 (uses `node:sqlite` and runs TypeScript natively;
  `.node-version` names the release `ensure.sh` prefers). Runtime dependencies:
  `@tagents/core`, `zod`, `ts-pattern`, `i18next` — installed with `pnpm`.
- The `claude` CLI, logged in.
- A checkout of `tagents` beside this one: `@tagents/core` (**≥ 0.3**) owns the
  headless turn lifecycle, the transcript reader and the plugin host that runs
  this daemon, and is taken as a local `link:` (`../../tagents/packages/core`).
  Build it once before running anything here —
  `pnpm -C ../../tagents/packages/core build` — and again after changing it;
  `pnpm test` refuses with that same line when its `dist/` is missing, and
  `src/runner.mjs` exits non-zero with the reason when it cannot load it.
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
     <!-- required: without it launchd kills the daemon's process group the
          moment ensure.sh returns, silently, before its first log line -->
     <key>AbandonProcessGroup</key><true/>
   </dict></plist>
   ```
   `launchctl load ~/Library/LaunchAgents/tg-orchestrator.plist`.
4. Check: DM the bot, it answers. `/status` shows the daemon is alive.

## How a turn works

```
getUpdates (long-poll)
  → owner-only filter → `inbound` event on disk → offset advances → claim in the registry
  → General → a topic of its own (auto-topic.ts), before the `inbound` event
  → burst window (sliding, closed early by a reaction or a flush word; commands bypass it)
  → group by topic → per-topic queue (scheduler.mjs)
  → claude -p --resume <topic session> --append-system-prompt-file agent.md
      stream-json: tool calls and the final result are seen as they happen
  → result accepted, session id saved, cost booked to ~/.config/tg-orchestrator/usage.jsonl
  → `turn_result` / `turn_fail` event per message, then settled in the registry
```

The agent answers through the Bot API itself; the runner posts only
infrastructure messages (a timeout warning, "could not process", `/status`).

**Agent homes.** An agent is a directory under
`~/.config/tg-orchestrator/agents/<name>/`, and every turn runs with that
directory as its cwd, so Claude Code loads the home's `CLAUDE.md`, its
`.claude/settings.json` (an absolute `autoMemoryDirectory` pointing at the
home's `memory/`), rules and skills by itself. A home's `topics` file lists the
`chat_id:thread_id` keys it answers; the first agent (names sorted) that lists a
key owns it, and every other key goes to `orchestrator`. The system prompt is
the home's `brain.md` when it has one, else `agent.md`. The `turn_start` event
carries the agent's name. `scripts/migrate-agent-homes.sh` creates the homes
once (idempotent). Design: `docs/agent-learning.md`.

**The approval gate.** An agent does not edit its own rules, skills or memory
index in a turn: it files a proposal (`node src/learning.mjs propose --file
<json>`) into `~/.config/tg-orchestrator/proposals/pending/`. With
`TG_LEARNING_TOPIC` set, the daemon posts every proposal into that topic; a 👍
applies it, a 👎 or a "no" reply rejects it, silence for `TG_PROPOSAL_TTL_MS`
applies it, and the resolved message is deleted. A weekly curator agent
(`scripts/install-curator.sh`) walks every agent's memory and files its
clean-up as proposals. Without `TG_LEARNING_TOPIC` none of this runs.

**The event log.** Every accepted message is written to `events.sqlite`
(`src/events.mjs`, WAL + `synchronous=FULL`) BEFORE the Telegram offset moves
past it — Telegram never redelivers an acknowledged update, so an offset ahead
of the log means a `kill -9` erases the message. Everything that can account for
a message (`turn_result`, `turn_fail`, `command`, `flush_word`, `skipped`) is
written there too, so "what is still owed an answer" is a query rather than a
guess. On startup the daemon re-queues every unclosed inbound message, prefixed
with a recovery notice telling the model a previous attempt may already have
posted something; anything older than 48 h is not replayed silently — the topic
gets a "this stayed unanswered, write again if it still matters" note instead.
`state.json` is now a cache: `node src/events.mjs rebuild` derives it from
the log.

## As a tagents plugin

This repo is a [tagents](../../tagents) plugin: `package.json` carries the
manifest (`"tagents": { "apiVersion": 1, "entry": "./src/plugin.ts" }`) and
`src/plugin.ts` default-exports one `definePlugin({ … })` object — the i18next
catalogue, one **service** (`runner`, the daemon) and one **CLI verb**
(`status`, the same sentence `/status` answers in Telegram, read out of the
daemon's own files).

Nothing about starting it changed: launchd still runs `ensure.sh`, `ensure.sh`
still runs `node src/runner.mjs`, and that file still owns the pid contract.
What it does now is three lines — load `@tagents/core`, load the plugin, run the
`runner` service under a context core builds (`createContext` → driver, `t`,
log, config dir):

```js
const ctx = core.createContext({ plugin, log });
const service = await core.runService(plugin, 'runner', ctx, { signals: true });
await service.done;
```

The daemon itself is `startRunner(deps)` in `src/runner.ts`, which hands back
the three handles a supervisor holds: `drain()` (the restart handshake —
finish what is in flight, take no new work, exit), `stop(reason)` (now, the way
SIGTERM always did) and `done`.

Either import failing is **exit 1** with one sentence on stderr and in
`runner.log`. A dead bot that exited 0 is the one outcome this design refuses:
nobody would see it and `ensure.sh` would "start" it again five minutes later.
The only silent exit 0 stays the missing or unusable env file — an unconfigured
install is not a broken one.

## Configuration

All in `~/.config/tg-orchestrator/env` (or the process environment).

| variable | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | bot token |
| `OWNER_ID` | — | the only Telegram user the bot listens to |
| `TG_CLAUDE_TIMEOUT_MS` | 50 min | hard cap per turn; warning to the topic 5 min before |
| `TG_MAX_PARALLEL_TURNS` | 3 | topics in a turn at once (one topic is always serial) |
| `TG_CLAUDE_MODEL`, `TG_CLAUDE_EFFORT` | `fable`, `xhigh` | passed to `claude -p`; set them in the env file (a launchd start has no other environment), the process environment wins for an ad-hoc run |
| `TG_CLAUDE_FALLBACK_MODEL` | `opus` | where a turn continues when `TG_CLAUDE_MODEL` is out of usage credits; empty (or the same model) switches the fallback off |
| `TG_CLAUDE_FALLBACK_TTL_MS` | 60 min | how long the next turns stay on the fallback before one of them probes the original model again |
| `TG_CLAUDE_CONFIG_DIR` | *(unset)* | absolute path of the Claude Code config dir the child sessions log in as, e.g. `~/.claude-work` — an account, not a setting; unset/empty = the personal account the daemon itself runs under |
| `TG_CLAUDE_CONFIG_DIR_UNTIL` | *(unset)* | ISO-8601 timestamp (`2026-09-21T16:00:00Z`) after which `TG_CLAUDE_CONFIG_DIR` lapses and the turns go back to the personal account, with no restart; unset = no deadline. Unlike the other options a value that cannot be read refuses to start the daemon |
| `TG_LOCALE` | `en` | language of everything the bot and `orc-status` say: `en` or `ru` |
| `TG_FLUSH_WORDS` | *(empty)* | comma-separated words that close the burst window at once; matched after trim, lowercase and a leading `/`. Empty by default — a reaction does this now |
| `TG_AUTO_TOPIC` | `1` | give every message in the forum's General a topic of its own; `0`/`false`/`off`/`no` to leave them in General |
| `TG_LEARNING_TOPIC` | *(unset)* | `chat_id:thread_id` of the approval-gate topic; unset = the gate is off |
| `TG_PROPOSAL_TTL_MS` | 24 h | silence after which a posted proposal is applied |
| `TG_EVENTS_DB` | `~/.config/tg-orchestrator/events.sqlite` | durable event log (inbound + turn outcomes) |
| `CLAIMS_DB` | `~/.config/claude-agents/claims.sqlite` | registry database, shared with other agents |
| `CLAIMS_COOP` | first existing `~/git/work/claude-coop`, `~/git/claude-coop`, `~/claude-coop` | claude-coop `coop.sh`, for hand-over |
| `CLAUDE_HOMES` | every `~/.claude*` | config dirs `sessions.mjs` scans |
| `TELEGRAM_MCP_DIR`, `WHISPER_LANGUAGE` | `~/git/telegram-mcp`, `ru` | voice fallback |

Runtime state: `~/.config/tg-orchestrator/` — `state.json` (offset, sessions),
`events.sqlite` (the durable event log), `status.json` (heartbeat),
`usage.jsonl` (ledger), `runner.log`, `wake/` (spool), `runner.pid`, `drain`
(restart flag). `state.json` and `status.json`
are written atomically (tmp + rename), so another process never reads a torn
file.

## Layout

```
ensure.sh                 idempotent start (the launchd/cron entrypoint)
src/runner.mjs            the entry point: boots the telegram plugin's `runner` service
                          through @tagents/core — and exits NON-ZERO with one sentence on
                          stderr and in runner.log if core or the plugin cannot be loaded
src/plugin.ts             the tagents plugin: the catalogue, the runner service, `status`
src/runner.ts             the daemon itself: poll, burst, dispatch, wake spool, commands,
                          heartbeat — startRunner(deps) → { drain, stop(reason), done }
src/agent-home.ts         which agent owns a topic: its home (the turn's cwd) and its brain
src/status-reply.ts       the /status sentence, said by the daemon and by the `status` verb
src/turn.mjs              one claude turn — the lifecycle (stream-json, timeout + warning,
                          grace kill after result) is @tagents/core's; what stays here is the
                          session spec, the retry decision and the claims on incoming messages
src/scheduler.mjs         per-topic queues, parallel across topics, serial within one
src/events.mjs            the durable event log (library + CLI: tail / trace / orphans / rebuild)
                          — a shim; the module is src/events.ts
src/atomic.mjs            writeAtomic(file, data) — tmp + rename, shared by runner and events
src/claims.mjs            the registry (library + CLI: owner / claim / release / lease / ask / inbox)
                          — a shim; the module is src/claims.ts
src/wake/spool.ts         the wake spool: the record schema, the file state machine
                          (json → .taken → done/ | .bad | .retry.json → .giveup), the prompt
src/status.mjs            monitoring snapshot (--watch, --json)
src/sessions.mjs          recent / search / show across every Claude session on the box —
                          the CLI here, the transcript reading in @tagents/core
src/arc-cdp.mjs           dependency-free Chrome DevTools driver (for browser chores)
scripts/wake.sh           background-job → turn bridge (call on every exit path)
scripts/restart-when-idle.sh   drain-based restart
scripts/transcribe-fallback.sh local whisper for a voice note, reports through wake.sh
scripts/migrate-agent-homes.sh  one-off, idempotent: build the agent homes, move memory into them
scripts/install-curator.sh      idempotent: the curator's home + its weekly launchd job
scripts/curator-weekly.sh       what that job runs: a wake record for the learning topic
src/learning.mjs          the approval gate (CLI: propose / list / show / apply / reject / wrap)
                          — a shim; the module is src/learning.ts
templates/curator/brain.md  the curator's system prompt ({{REPO}}, {{AGENTS_ROOT}} substituted)
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

**Event log CLI.** What happened to a message, and what never got an answer:
```sh
node src/events.mjs trace 4821 [--convo -1002:53]   # every event that touched that message
node src/events.mjs tail 50 [--convo K] [--kind turn_fail] [--json]
node src/events.mjs orphans                         # inbound nothing ever closed
node src/events.mjs sessions                        # {offset, sessions} projected from the log
node src/events.mjs rebuild --write                 # regenerate state.json (refuses under a live runner)
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
- Bot-facing text (`/help`, the timeout warning, `/reset`, the whole
  `orc-status` screen) goes through one i18next catalogue, `src/i18n/`. English
  is the default; `TG_LOCALE=ru` gives the author's own wording, byte for byte
  what the bot said before the catalogue existed. A third language is a third
  file — but plurals are still naive in both ("1 calls", "1 вызовов"), and the
  flush words are configuration (`TG_FLUSH_WORDS`), not translation: they are
  what you type, not what the bot says.
- Built for one person; there is no multi-user mode and none planned.

## License

MIT.
