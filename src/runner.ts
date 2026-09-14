// tg-orchestrator daemon: Sasha's personal Claude orchestrator in Telegram.
//
// Long-polls the Bot API and feeds every owner message to a headless Claude
// invocation (personal ~/.claude account, fable by default at xhigh effort,
// overridable with TG_CLAUDE_MODEL / TG_CLAUDE_EFFORT, cwd = $HOME).
// The agent answers via the Bot API itself; this runner only ferries messages
// in and keeps one Claude session alive PER FORUM TOPIC — topics are the
// structure: each one is its own long-lived conversation with its own context.
//
// Singleton (pid lock). Config: ~/.config/tg-orchestrator/env
// State (offset + sessions per topic): ~/.config/tg-orchestrator/state.json
// Log: ~/.config/tg-orchestrator/runner.log
//
// It is a FUNCTION now, not a program: `startRunner(deps)` starts the daemon
// and hands back the three handles a supervisor holds (drain / stop / done),
// which is what lets @tagents/core run it as the telegram plugin's service.
// src/runner.mjs is still the entry point the world uses — it boots the plugin
// through core's host and this is what that service starts. Everything an
// observer can see (the log lines, status.json, the pid file, the exit codes,
// the Telegram calls) is unchanged and pinned by test/contract/runner-e2e.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { match } from 'ts-pattern';
import { z } from 'zod';
import type { SessionDriver } from '@tagents/core';
import { human, openDb, type ClaimsDb } from './claims.ts';
import { writeAtomic } from './atomic.ts';
import { loadConfig, type Config } from './config.ts';
import { getI18n, t } from './i18n/index.ts';
import {
  latestSnapshot,
  openEvents,
  orphanedInbound,
  record,
  recordMany,
  type AnyEventKind,
  type EventFields,
  type EventInput,
  type EventsDb,
  type JsonValue,
} from './events.ts';
import { continuationNotice, ModelFallback } from './model-fallback.ts';
import { tryCatch } from './result.ts';
import { createScheduler, type Scheduler } from './scheduler.ts';
import { statusReply } from './status-reply.ts';
import {
  applyRequeue,
  claimPending,
  ensureSpool,
  finishItem,
  planRequeue,
  renderWakePrompt,
  resolveNotify,
  type WakeNotify,
  type WakeRecord,
} from './wake/spool.ts';
import { annotateIncoming, attemptTurn, claimIncoming, runClaude, settleIncoming, TIMEOUT_WARN_BEFORE_MS, type Attempt, type AttemptPlan, type FallbackPolicy } from './turn.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** agent.md and agents/ live at the repo root, code in src/. */
export const REPO_ROOT = path.resolve(HERE, '..');
export const CONFIG_ROOT = path.join(os.homedir(), '.config', 'tg-orchestrator');

// Per-topic sessions die after this much silence. Personal threads are
// long-lived on purpose — a topic IS a workstream — but replaying a week-old
// transcript on every message is the cost pattern that killed an earlier bot,
// so idle ones still reset.
const SESSION_IDLE_RESET_MS = 6 * 60 * 60 * 1000;
// Burst window. Answering one message at a time forces whoever is typing to
// cram a whole thought into a single bubble; in practice a reply arrives as
// three texts and two voice notes. So the window SLIDES: every new message
// re-arms the timer, and the agent gets the whole run as one turn.
// Cost: a reply never lands sooner than BURST_SETTLE_MS after the last message
// (TG_BURST_SETTLE_MS) — and, because a steady drip must not postpone the
// answer forever, BURST_WINDOW_MAX_MS caps the run (TG_BURST_WINDOW_MAX_MS).
// Both are resolved with the rest of the configuration (config.ts).
//
// How often the window wakes up while waiting. Short hops (not one long sleep)
// are what make an explicit flush word land immediately instead of at the end
// of the settle period.
const BURST_POLL_S = 10;
// Older than this and a silent replay is worse than the silence: the owner has
// moved on, and an answer to a two-day-old question reads as a malfunction.
const RECOVERY_MAX_AGE_MS = 48 * 60 * 60 * 1000;

// --- what the daemon reads off the wire -------------------------------------
// Loose on purpose: a Telegram message carries far more than this daemon looks
// at, the whole object is what lands in the event log, and the recovery pass
// replays it from there. Nothing is dropped — only the fields below are typed.
const TgChatSchema = z.looseObject({
  id: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
});
const TgMessageSchema = z.looseObject({
  message_id: z.number(),
  chat: TgChatSchema,
  message_thread_id: z.number().optional(),
  from: z.looseObject({ id: z.number().optional() }).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: z.looseObject({ duration: z.number() }).optional(),
  video_note: z.looseObject({ duration: z.number() }).optional(),
  photo: z.array(z.looseObject({ file_id: z.string() })).optional(),
  document: z.looseObject({ file_id: z.string(), file_name: z.string().optional() }).optional(),
  reply_to_message: z.looseObject({ message_id: z.number(), text: z.string().optional() }).optional(),
  // Unix seconds. `date` is when the owner actually sent it, which is NOT the
  // turn's "Now" — a burst waits out the settle window and a slow turn can run
  // for tens of minutes. `edit_date` is present only on an edited message.
  date: z.number().optional(),
  edit_date: z.number().optional(),
});
export type TgMessage = z.infer<typeof TgMessageSchema>;

// --- message rendering ------------------------------------------------------
// What the agent is told about one incoming message. The header carries the
// message's own SEND time, not just the turn's "Now": a burst is answered as a
// single turn, so without per-message stamps the agent cannot tell a question
// asked a minute ago from one that has been waiting half an hour, and cannot
// place messages that arrived while it was already working against its own
// replies. `EDITED` is here for the same class of reason — Telegram delivers an
// edit with no announcement, and acting on the superseded text has already cost
// us once (a tyre pressure was corrected by an edit and the old figure was the
// one that got repeated back).
export function renderMessage(m: TgMessage, nowMs: number): string {
  // Telegram timestamps are Unix SECONDS; milliseconds here would render 1970.
  const stamp = (unixSec: number): string => {
    const iso = new Date(unixSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return `${iso} (${human(nowMs - unixSec * 1000)} ago)`;
  };
  const head =
    `[msg ${m.message_id} · chat_id=${m.chat.id}` +
    (m.message_thread_id ? ` · topic_thread=${m.message_thread_id}` : '') +
    (m.chat.title ? ` · "${m.chat.title}"` : ' · DM') +
    (m.date === undefined ? '' : ` · sent ${stamp(m.date)}`) +
    (m.edit_date === undefined ? '' : ` · EDITED ${stamp(m.edit_date)}`) +
    `]`;
  const parts: string[] = [];
  if (m.voice)
    parts.push(
      `[VOICE ${m.voice.duration}s — transcribe FIRST via mcp__telegram__transcribe_voice` +
        `(chat_id=${m.chat.id}, message_id=${m.message_id}), then act on the transcript]`
    );
  if (m.video_note) parts.push(`[video note ${m.video_note.duration}s — transcribe the same way]`);
  if (m.photo) parts.push(`[photo file_id=${m.photo.at(-1)?.file_id}]`);
  if (m.document) parts.push(`[file "${m.document.file_name}" file_id=${m.document.file_id}]`);
  if (m.reply_to_message)
    parts.push(
      `[reply to msg ${m.reply_to_message.message_id}: ${(m.reply_to_message.text ?? '').slice(0, 200)}]`
    );
  const text = m.text ?? m.caption ?? '';
  if (text) parts.push(text);
  return `${head}\n${parts.join('\n')}`;
}


const UpdateSchema = z.looseObject({
  update_id: z.number(),
  message: TgMessageSchema.optional().catch(undefined),
});
const UpdatesSchema = z.array(UpdateSchema).catch([]);
const MeSchema = z.looseObject({ username: z.string().optional() }).catch({});

// The Bot API envelope. `ok` false is an error with the API's own words in it.
const EnvelopeSchema = z
  .looseObject({
    ok: z.boolean().optional(),
    error_code: z.union([z.number(), z.string()]).optional(),
    description: z.string().optional(),
    result: z.unknown().optional(),
  })
  .catch({});

const StateSchema = z
  .looseObject({
    offset: z.number().catch(0).prefault(0),
    sessions: z
      .record(z.string(), z.looseObject({ id: z.string(), last: z.number() }))
      .catch({})
      .prefault({}),
  })
  .catch({ offset: 0, sessions: {} });

/** Where a turn's answer goes. */
type Notify = { chatId: number; threadId?: number | undefined };
/** Why a message run is being replayed: the previous daemon died holding it. */
type Recovered = { diedAt: string };
/** What a turn is FOR — what ties its event rows back to what asked for it. */
type TurnMeta =
  | { kind: 'msgs'; msgIds: number[]; recovered?: Recovered }
  | { kind: 'wake'; file: string; job: string | undefined };

/** The two shapes this file ever enqueues. */
type QueuedMsgs = { kind: 'msgs'; msgs: TgMessage[]; recovered?: Recovered };
type QueuedWake = { kind: 'wake'; rec: WakeRecord; taken: string; file: string; notify: WakeNotify };
type Queued = QueuedMsgs | QueuedWake;

/**
 * What the daemon is doing, as ONE value instead of three flags that could
 * disagree. status.json's `phase` is derived from it (plus the scheduler's own
 * snapshot) — see `heartbeat` — and keeps the five words its readers know:
 * idle, burst, claude, draining, down.
 */
type Phase =
  | { kind: 'startup' }
  | { kind: 'poll' }
  | { kind: 'burst'; since: string; msgs: number }
  | { kind: 'dispatch' }
  | { kind: 'draining' }
  | { kind: 'down'; reason: string };

export interface RunnerDeps {
  /**
   * Where a log line goes, already timestamped. Default: runner.log, echoed to
   * stdout only when it is a TTY — under ensure.sh stdout IS the log file, and
   * echoing there too doubled every line (LEARNING 13.08.2026).
   */
  readonly log?: (line: string) => void;
  /** ~/.config/tg-orchestrator: env, state.json, the pid file, the log, the spool. */
  readonly configRoot?: string;
  /** The repo root: agent.md and agents/ are read from here. */
  readonly repoRoot?: string;
  /** The session backend. The plugin host passes ctx.driver. */
  readonly driver?: SessionDriver;
  /** The clock. */
  readonly now?: () => number;
  /** What config.ts reads its process-env seams from. */
  readonly processEnv?: NodeJS.ProcessEnv;
  /**
   * How the daemon leaves. The two misconfig refusals and the pid-lock no-op
   * exit 0 through this; default `process.exit`.
   */
  readonly exit?: (code: number) => void;
  /** Where the refusals go before there is a log file. Default: console.error. */
  readonly stderr?: (line: string) => void;
}

/** What a supervisor holds. `done` resolves when the daemon is over. */
export interface RunningRunner {
  /** Take no new work, finish what is in flight, then exit — the drain handshake. */
  drain(): Promise<void>;
  /** Stop now. `reason` is the word the log and the runner_stop event carry. */
  stop(reason: string): void;
  readonly done: Promise<void>;
}

/** A daemon that refused to start: nothing running, nothing to drain. */
const NOT_STARTED: RunningRunner = {
  drain: (): Promise<void> => Promise.resolve(),
  stop: (): void => undefined,
  done: Promise.resolve(),
};

// The event log stores JSON, and these payloads are assembled out of values the
// Bot API handed us and out of fields that are legitimately absent. One
// round-trip is exactly what the writer does with them anyway, and it keeps
// `undefined` — which JSON.stringify drops — out of a type with no room for it.
const asPayload = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function startRunner(deps: RunnerDeps = {}): Promise<RunningRunner> {
  const CFG_DIR = deps.configRoot ?? CONFIG_ROOT;
  const ROOT = deps.repoRoot ?? REPO_ROOT;
  const ENV_FILE = path.join(CFG_DIR, 'env');
  const STATE_FILE = path.join(CFG_DIR, 'state.json');
  const PID_FILE = path.join(CFG_DIR, 'runner.pid');
  const LEDGER = path.join(CFG_DIR, 'usage.jsonl');
  const LOG_FILE = path.join(CFG_DIR, 'runner.log');
  const STATUS_FILE = path.join(CFG_DIR, 'status.json');
  const DRAIN_FILE = path.join(CFG_DIR, 'drain');
  const WAKE_DIR = path.join(CFG_DIR, 'wake');
  const AGENT_MD = path.join(ROOT, 'agent.md');
  // Per-topic brains. A topic is a workstream, and some workstreams want their
  // own agent rather than the generic orchestrator: drop
  // agents/<chat_id>_<thread_id>.md and that topic gets it as its system prompt
  // INSTEAD of agent.md. Such a file must be self-contained (channel rules
  // included) — see agents/README.md.
  const AGENTS_DIR = path.join(ROOT, 'agents');

  const now = deps.now ?? Date.now;
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const stderr = deps.stderr ?? ((line: string): void => console.error(line));

  const sink =
    deps.log ??
    ((line: string): void => {
      // Under ensure.sh stdout is redirected into LOG_FILE, so echoing there
      // too doubled every line; keep the echo for interactive runs only.
      if (process.stdout.isTTY) console.log(line);
      try {
        fs.appendFileSync(LOG_FILE, line + '\n');
      } catch {
        /* the log is a convenience, never a gate */
      }
    });
  const log = (...a: string[]): void => sink(new Date(now()).toISOString() + ' ' + a.join(' '));

  function agentMdFor(key: string): string {
    const file = path.join(AGENTS_DIR, key.replace(':', '_') + '.md');
    return fs.existsSync(file) ? file : AGENT_MD;
  }

  // --- config ---------------------------------------------------------------
  // One parse for the env file and the process environment (config.ts); the two
  // refusals below are the daemon's contract, so the wording and the exit code
  // stay here, where an operator reading the log expects to find them.
  const loaded = loadConfig({
    envFile: ENV_FILE,
    ...(deps.processEnv === undefined ? {} : { processEnv: deps.processEnv }),
  });
  if (loaded.kind === 'missing-env-file') {
    stderr(`no ${ENV_FILE} — refusing to start (see orchestrator/README.md)`);
    exit(0);
    return NOT_STARTED;
  }
  if (loaded.kind === 'invalid') {
    stderr(loaded.message);
    exit(0);
    return NOT_STARTED;
  }
  const CFG: Config = loaded.config;
  const TOKEN = CFG.token;
  const OWNER_ID = CFG.ownerId;
  // Bot API root. TG_API_BASE_URL (process env or the env file) overrides it the
  // same way TG_CLAUDE_TIMEOUT_MS does; the default is the real API. The override
  // exists so the contract tests can drive a local fake Bot API instead of the
  // live one — nothing else reads it.
  const API = `${CFG.apiBaseUrl}/bot${TOKEN}`;
  // Hard cap on one Claude turn. TG_CLAUDE_TIMEOUT_MS (process env or the env
  // file) overrides; the topic gets a warning TIMEOUT_WARN_BEFORE_MS before the
  // kill, so a long turn never dies silently. Default 50 min: the 30-min cap
  // killed two finished turns on 10.09.
  const CLAUDE_TIMEOUT_MS = CFG.claudeTimeoutMs;
  // How many conversations may be in a Claude turn at once. Turns on the SAME
  // topic are always serial (one session, one transcript); different topics run
  // side by side, so a question in «dev» no longer waits for an analysis in
  // another topic — that wait is what looked like a dead agent on 10.09.
  // TG_MAX_PARALLEL_TURNS (process env or the env file) overrides; default 3.
  const MAX_PARALLEL_TURNS = CFG.maxParallelTurns;
  // The sliding burst window described above: TG_BURST_SETTLE_MS re-arms on
  // every message, TG_BURST_WINDOW_MAX_MS caps the whole run.
  const BURST_SETTLE_MS = CFG.burstSettleMs;
  const BURST_WINDOW_MAX_MS = CFG.burstWindowMaxMs;
  // The flush words, and the language everything below is said in: TG_LOCALE
  // picks the catalogue once, here, for the whole process.
  const FLUSH_WORDS = new Set(CFG.flushWords);
  getI18n(CFG.locale);
  // Where a turn goes when TG_CLAUDE_MODEL's usage bucket is empty (11.09.2026:
  // fable refused every turn with "You're out of usage credits" while opus on
  // the same login answered fine, and every topic went dead). ONE memory for the
  // whole daemon: the bucket is a property of the account, not of a topic, so
  // the first topic that discovers it saves every other topic a failed turn.
  const fallback = new ModelFallback({
    primary: CFG.claudeModel,
    fallback: CFG.claudeFallbackModel,
    ttlMs: CFG.claudeFallbackTtlMs,
    now,
  });

  // ...and the flush itself: "I've finished the thought, read it now". A message
  // that is EXACTLY one of these ends the window at once and is not forwarded to
  // the model — it is punctuation, not content. Anything longer is a normal
  // message, so a flush word followed by anything else waits like the rest. The
  // list itself is configuration (TG_FLUSH_WORDS, config.ts), not translation:
  // these are the words the owner types, and they do not follow TG_LOCALE.
  const isFlush = (m: TgMessage): boolean =>
    FLUSH_WORDS.has(
      (m.text ?? '')
        .trim()
        .toLowerCase()
        .replace(/^\//, '')
        .replace(/[.!?,;\s]+$/, '')
    );

  // --- singleton ------------------------------------------------------------
  try {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (old > 0) {
      process.kill(old, 0);
      exit(0); // another runner is alive
      return NOT_STARTED;
    }
  } catch {
    /* stale or missing pid — take over */
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  // Drain handshake (see the main loop): restart-when-idle.sh touches this file,
  // the runner finishes what is in flight, takes no new work and exits. A flag
  // left behind by a watcher that died must not drain the next runner.
  try {
    fs.unlinkSync(DRAIN_FILE);
    log('stale drain flag removed');
  } catch {
    /* no flag: the normal case */
  }
  const removePid = (): void => {
    try {
      if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE);
    } catch {
      /* somebody else's pid file, or none */
    }
  };

  // --- state ----------------------------------------------------------------
  let state: z.infer<typeof StateSchema> = { offset: 0, sessions: {} };
  try {
    state = StateSchema.parse(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch {
    /* no state yet, or an unreadable one: start from zero */
  }
  // Atomic replace (atomic.ts): a reader in another process (status.mjs,
  // restart-when-idle.sh, the events CLI) sees either the old file or the new
  // one, never a truncated or half-written JSON.
  const saveState = (): void => writeAtomic(STATE_FILE, JSON.stringify(state));

  // Session generations. A turn captures its resume id when it starts and writes
  // the resulting session id back when it ends; a /reset in between would be
  // silently undone by that write-back. The turn therefore remembers the
  // generation it started in and only writes back if nobody reset since.
  const sessionGen = new Map<string, number>();
  const genOf = (key: string): number => sessionGen.get(key) ?? 0;
  const bumpGen = (key: string): Map<string, number> => sessionGen.set(key, genOf(key) + 1);

  // Who is handling which message — the shared SQLite registry (claims.ts,
  // ~/.config/claude-agents/claims.sqlite), NOT state.json: read / in-turn /
  // done survive a runner restart and are visible to the other agents. Every
  // incoming message is claimed before processing and released after it, so a
  // redelivered or replayed message never reaches a model twice.
  let claimsDb: ClaimsDb | null = null;
  try {
    claimsDb = openDb();
  } catch (e) {
    log('claims registry unavailable — running WITHOUT dedup:', errMessage(e));
  }

  // The durable event log (events.ts). Every inbound message lands here BEFORE
  // the Telegram offset moves past it, and everything that can close a message
  // lands here too — which is what makes the startup recovery below possible.
  // It is an observer, never a gate: if it cannot be opened or a write fails the
  // daemon runs exactly as it did before, just without crash recovery.
  let eventsDb: EventsDb | null = null;
  try {
    eventsDb = openEvents();
  } catch (e) {
    log('event log unavailable — running WITHOUT crash recovery:', errMessage(e));
  }
  const ACTOR = `runner:${process.pid}`;
  let evBroken = false;
  const evFailed = (e: unknown): void => {
    if (evBroken) return;
    evBroken = true;
    log('event log write failed (further failures are silent):', errMessage(e));
  };
  // The ONLY way this file writes events: a no-op without a db, never throws.
  function ev(kind: AnyEventKind, fields: EventFields = {}): number | null {
    if (!eventsDb) return null;
    try {
      return record(eventsDb, kind, { actor: ACTOR, ...fields });
    } catch (e) {
      evFailed(e);
      return null;
    }
  }
  // Same, for a batch that must land all-or-nothing (a turn's per-message rows).
  function evMany(rows: readonly EventInput[]): number[] | null {
    if (!eventsDb || !rows.length) return null;
    try {
      return recordMany(
        eventsDb,
        rows.map((r) => ({ actor: ACTOR, ...r }))
      );
    } catch (e) {
      evFailed(e);
      return null;
    }
  }

  // A conversation = one chat + one forum topic. DMs and non-forum groups fold
  // into thread 0.
  const convoKey = (m: TgMessage): string => `${m.chat.id}:${m.message_thread_id ?? 0}`;

  // --- heartbeat --------------------------------------------------------------
  // "What is the daemon doing", for status.mjs and restart-when-idle.sh: idle
  // (nothing in flight, nothing queued), burst (buffering a message run) or
  // claude (≥1 turn in flight — `turns` lists them; `convo`/`msgs`/`at` mirror
  // the first one for older readers). Best-effort, never throws. `phase: idle`
  // is what restart-when-idle.sh waits for, so it must mean "safe to kill".
  function setStatus(phase: string, extra: Record<string, unknown> = {}): void {
    try {
      // `modelFallback` is written ONLY while the fallback is active, so a
      // normal status.json is byte-for-byte what it has always been and every
      // reader of it (status.mjs, restart-when-idle.sh, the plugin's `status`
      // verb) is unaffected until there is something to say.
      const fb = fallback.snapshot();
      writeAtomic(
        STATUS_FILE,
        JSON.stringify({
          phase,
          at: new Date(now()).toISOString(),
          pid: process.pid,
          ...extra,
          ...(fb.active
            ? {
                modelFallback: {
                  model: fb.fallback,
                  primary: fb.primary,
                  since: fb.since === null ? null : new Date(fb.since).toISOString(),
                  until: fb.until === null ? null : new Date(fb.until).toISOString(),
                },
              }
            : {}),
        })
      );
    } catch {
      /* the heartbeat is an observer, never a gate */
    }
  }
  let phase: Phase = { kind: 'startup' };
  let sched: Scheduler | null = null; // the per-conversation scheduler, created before the main loop
  function heartbeat(): void {
    const s = sched ? sched.snapshot() : { inflight: [], queued: 0 };
    const turns = s.inflight.map((turn) => ({ ...turn, since: new Date(turn.since).toISOString() }));
    const burst = phase.kind === 'burst' ? { since: phase.since, msgs: phase.msgs } : null;
    const first = turns[0];
    match(phase)
      .with({ kind: 'down' }, (p) => setStatus('down', { reason: p.reason }))
      .with({ kind: 'draining' }, () => setStatus('draining', { turns, queued: s.queued }))
      .otherwise(() => {
        if (first)
          setStatus('claude', {
            at: first.since,
            convo: first.key,
            msgs: first.size,
            turns,
            queued: s.queued,
            burst,
          });
        else if (burst) setStatus('burst', burst);
        else setStatus('idle', { queued: s.queued });
      });
  }

  // --- telegram -------------------------------------------------------------
  async function tg(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctl.signal,
      });
      const body = EnvelopeSchema.parse(await res.json());
      if (!body.ok) throw new Error(`${method}: ${body.error_code} ${body.description}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
  const sendText = (chatId: number, text: string, threadId?: number | undefined): Promise<unknown> =>
    tg('sendMessage', {
      chat_id: chatId,
      text,
      ...(threadId ? { message_thread_id: threadId } : {}),
    }).catch((e: unknown) => log('sendText failed:', errMessage(e)));

  async function pollOnce(timeout: number): Promise<TgMessage[]> {
    const updates = UpdatesSchema.parse(
      await tg(
        'getUpdates',
        { offset: state.offset + 1, timeout, allowed_updates: ['message'] },
        (timeout + 15) * 1000
      )
    );
    const msgs: TgMessage[] = [];
    for (const u of updates) {
      const m = u.message;
      // Owner-only, hard. This agent runs with permissions off on a personal
      // machine; anyone else's messages are dropped before they reach a model.
      if (!m || m.from?.id !== OWNER_ID) continue;
      if (!['private', 'group', 'supergroup'].includes(m.chat.type ?? '')) continue;
      msgs.push(m);
      ev('inbound', { convo: convoKey(m), msgId: m.message_id, updateId: u.update_id, payload: asPayload(m) });
    }
    // Only NOW may the offset move: Telegram never redelivers an update once the
    // offset is past it, so an offset ahead of the event log is a message that a
    // kill -9 erases from existence. Every accepted message above is on disk.
    for (const u of updates) state.offset = Math.max(state.offset, u.update_id);
    if (updates.length) saveState();
    // Dedup: claim every message before it goes anywhere (logs claimed /
    // already-claimed / already-handled / busy per message).
    const accepted = claimIncoming(claimsDb, msgs, { log });
    if (accepted.length !== msgs.length) {
      const mine = new Set(accepted);
      for (const m of msgs) {
        if (!mine.has(m)) {
          ev('skipped', {
            convo: convoKey(m),
            msgId: m.message_id,
            payload: { reason: 'claimed elsewhere' },
          });
        }
      }
    }
    return accepted;
  }

  // --- claude ---------------------------------------------------------------
  // The turn itself — argv, child env, stream-json, the timeout killer and the
  // grace kill after a `result` — belongs to @tagents/core now, through
  // src/turn.ts. All this end says is WHICH session to run: the owner's home as
  // cwd, the model/effort pair from the config, the brain for this topic, and the
  // two variables the agent needs in order to answer in Telegram by itself.
  function runClaudeTurn(
    prompt: string,
    plan: AttemptPlan,
    agentMd: string,
    notify: Notify | null
  ): Promise<Attempt> {
    return runClaude({
      // A continuation resumes a transcript that ends in an error the model did
      // not write — the notice is what tells it so (src/model-fallback.ts).
      prompt: (plan.continuation ? continuationNotice(plan.continuation) : '') + prompt,
      resumeId: plan.resumeId,
      systemPromptFile: agentMd,
      // Owner's call (10.09.2026): the orchestrator itself runs on fable. Env-driven
      // so switching back is a variable, not a patch. attemptTurn overrides it
      // per attempt while the primary model is out of usage credits.
      model: plan.model ?? CFG.claudeModel,
      effort: CFG.claudeEffort,
      logFile: LOG_FILE,
      env: { TELEGRAM_BOT_TOKEN: TOKEN, OWNER_ID: String(OWNER_ID) },
      timeoutMs: CLAUDE_TIMEOUT_MS,
      warnBeforeMs: TIMEOUT_WARN_BEFORE_MS,
      log,
      ...(deps.driver === undefined ? {} : { driver: deps.driver }),
      onWarn: notify
        ? ({ elapsedMs, leftMs }): void => {
            void sendText(
              notify.chatId,
              t('turn.slowWarning', {
                elapsedMin: Math.round(elapsedMs / 60000),
                leftMin: Math.round(leftMs / 60000),
                limitMin: Math.round(CLAUDE_TIMEOUT_MS / 60000),
              }),
              notify.threadId
            );
          }
        : null,
    });
  }

  // One Claude turn on a conversation: resume that topic's session, run, book the
  // cost, and never end silently — a failure is reported into the topic. `notify`
  // is passed in rather than derived from a message because a turn can also be
  // driven by a background job (see the wake spool below), which has no message.
  // `meta` describes what this turn is FOR — { kind: 'msgs', msgIds, recovered? }
  // or { kind: 'wake', file, job } — and is what ties the event rows below back
  // to the individual messages the turn answers.
  async function runTurn(
    key: string,
    prompt: string,
    notify: Notify | null,
    meta: TurnMeta = { kind: 'msgs', msgIds: [] }
  ): Promise<Attempt> {
    const sess = state.sessions[key];
    const gen = genOf(key);
    const fresh = !sess || now() - (sess.last ?? 0) > SESSION_IDLE_RESET_MS;
    const resumeId = fresh ? null : (sess?.id ?? null);
    const agentMd = agentMdFor(key);
    if (agentMd !== AGENT_MD) log(`[${key}] brain: ${path.basename(agentMd)}`);
    ev('turn_start', { convo: key, payload: asPayload({ ...meta, resumeId, fresh, gen }) });

    // When this turn STARTS, kept for the recovery check at the end of it.
    const startedAt = now();
    // Which model this turn STARTS on: the fallback while the primary is known
    // to be out of usage credits, the primary otherwise (and, once the TTL is
    // over, as a probe that costs nothing when the bucket has refilled).
    const policy: FallbackPolicy = {
      model: fallback.modelFor(),
      fallbackModel: CFG.claudeFallbackModel,
      onFallback: async ({ from, to }): Promise<void> => {
        const change = fallback.trip();
        log(`[${key}] model fallback ${change}: ${from} -> ${to}`);
        ev('model_fallback', { convo: key, payload: { change, from, to } });
        // A probe that failed again ('extended') is not news: the topic was
        // told an hour ago and nothing about the answer changed.
        if (change === 'tripped' && notify)
          await sendText(
            notify.chatId,
            t('turn.modelFallback', {
              from,
              to,
              ttlMin: Math.round(CFG.claudeFallbackTtlMs / 60000),
            }),
            notify.threadId
          );
      },
    };
    // Never re-run a turn that already did something: it may already have
    // answered in the topic, and a second run duplicates every side effect.
    // attemptTurn logs the decision (retry-fresh / retry-suppressed).
    const { attempt, model: ranOn, fellBack } = await attemptTurn(
      (plan) => runClaudeTurn(prompt, plan, agentMd, notify),
      resumeId,
      (line) => log(`[${key}]`, line),
      policy
    );
    // ...and the other direction: a turn that RAN ON THE PRIMARY and worked is
    // the proof the bucket has refilled, so the next turns go back to it.
    // `startedAt`, not "now": a turn that BEGAN before somebody else's refusal
    // says nothing about the bucket that refusal found empty (model-fallback.ts).
    if (
      !fellBack &&
      ranOn === CFG.claudeModel &&
      attempt.ok &&
      fallback.primaryOk(startedAt) === 'recovered'
    ) {
      log(`[${key}] model recovered: ${CFG.claudeModel}`);
      ev('model_fallback', { convo: key, payload: { change: 'recovered', model: CFG.claudeModel } });
      if (notify)
        await sendText(notify.chatId, t('turn.modelRecovered', { model: CFG.claudeModel }), notify.threadId);
    }
    // A turn that ran tools left a transcript worth resuming even if it failed.
    let kept = false;
    if (attempt.sessionId && (attempt.ok || attempt.toolUses > 0)) {
      if (genOf(key) === gen) {
        state.sessions[key] = { id: attempt.sessionId, last: now() };
        kept = true;
      } else log(`[${key}] /reset arrived mid-turn — this transcript is not kept`);
    }
    saveState();
    // One row PER MESSAGE, in ONE transaction: that is what closes each inbound
    // event, and a crash must not close half a turn's messages and re-queue the
    // other half. `session` carries the decision made just above — the projection
    // in events.ts replays it instead of re-deriving the generation logic.
    const outcome = {
      ok: attempt.ok,
      sessionId: attempt.sessionId ?? null,
      ...(kept ? { session: state.sessions[key] } : {}),
      resumedFrom: resumeId,
      costUSD: attempt.costUSD ?? null,
      numTurns: attempt.numTurns ?? null,
      durationMs: attempt.durationMs ?? null,
      toolUses: attempt.toolUses ?? null,
      timedOut: attempt.timedOut ?? false,
      killedAfterResult: attempt.killedAfterResult ?? false,
      ...(attempt.ok ? {} : { error: String(attempt.error ?? '').slice(0, 500) }),
      kind: meta.kind,
      ...(meta.kind === 'wake' ? { wake: meta.file } : {}),
      ...(meta.kind === 'msgs' && meta.recovered ? { recovered: true } : {}),
    };
    const ids: Array<number | null> =
      meta.kind === 'msgs' && meta.msgIds.length ? meta.msgIds : [null];
    evMany(
      ids.map((msgId) => ({
        kind: attempt.ok ? 'turn_result' : 'turn_fail',
        convo: key,
        msgId,
        payload: asPayload(outcome),
      }))
    );
    // The usage ledger stays as it was — it is now a projection cache (status.mjs
    // reads it), not the only record of what a turn cost.
    try {
      fs.appendFileSync(
        LEDGER,
        JSON.stringify({
          ts: new Date(now()).toISOString(),
          kind: 'tg-orchestrator',
          ok: attempt.ok,
          convo: key,
          sessionId: attempt.sessionId ?? null,
          resumedFrom: resumeId,
          costUSD: attempt.costUSD ?? null,
          numTurns: attempt.numTurns ?? null,
          durationMs: attempt.durationMs ?? null,
          toolUses: attempt.toolUses ?? null,
          timedOut: attempt.timedOut ?? false,
          killedAfterResult: attempt.killedAfterResult ?? false,
        }) + '\n'
      );
    } catch {
      /* the ledger is a cache now: the event log already has the row */
    }
    // The two lines an operator greps for. Their format is unchanged for every
    // turn that did NOT change model; a turn that did says so, because "which
    // model answered this" is the one thing a reader cannot derive from the log.
    const on = fellBack ? ` (on ${ranOn ?? CFG.claudeModel}, fallback)` : '';
    if (attempt.ok) {
      const how = attempt.killedAfterResult ? ' (result accepted; process killed after it)' : '';
      log(`claude ok${how}${on} [${key}]:`, String(attempt.text ?? '').replace(/\s+/g, ' ').slice(0, 160));
    } else await reportTurnFailure(key, String(attempt.error), notify, on);
    return attempt;
  }

  // What a failed turn owes the log and the topic, whichever way it failed: the
  // line an operator greps for and the ⚠️ the owner sees. Shared by the failed
  // Attempt above and by a driver that rejected outright (handleConversation) —
  // a turn must never end in silence, so the two must not drift apart.
  // Best-effort by construction: sendText already swallows a rejected Bot API
  // call into a log line, so nothing here throws back at the caller.
  async function reportTurnFailure(
    key: string,
    error: string,
    notify: Notify | null,
    on = ''
  ): Promise<void> {
    log(`claude FAILED${on} [${key}]:`, error);
    if (notify)
      await sendText(notify.chatId, t('turn.failed', { error: error.slice(0, 200) }), notify.threadId);
  }

  async function handleConversation(
    key: string,
    msgs: TgMessage[],
    recovered: Recovered | null = null
  ): Promise<void> {
    const m = msgs[0];
    if (!m) return;
    // `recovered` = these messages came back from the event log at startup, i.e.
    // the previous daemon died holding them. The model has to be told, because a
    // half-finished turn may already have posted something in the topic.
    const notice = recovered
      ? `RECOVERY NOTICE: the orchestrator daemon died before finishing these messages ` +
        `(received ${human(now() - Date.parse(recovered.diedAt))} ago, at ${recovered.diedAt}). ` +
        `A previous attempt may have partially run — check the topic for anything already posted, ` +
        `do not repeat side effects that already happened, and answer what is still unanswered.\n\n`
      : '';
    const prompt =
      notice +
      `New Telegram message${msgs.length > 1 ? 's' : ''} from the owner. ` +
      `Now: ${new Date(now()).toISOString()}\n\n` +
      msgs.map((x) => renderMessage(x, now())).join('\n\n');
    annotateIncoming(claimsDb, msgs, { note: 'in-turn', log });
    const notify: Notify = { chatId: m.chat.id, threadId: m.message_thread_id };
    // A turn REJECTS when the session driver does — a third-party driver handed
    // in through RunnerDeps.driver, i.e. the plugin host's ctx.driver, whose
    // open()/prompt() threw instead of returning an outcome. Nothing inside
    // runTurn ran then: no ⚠️, no closing row, and the messages would stay
    // 'in-turn' in the registry until the next daemon start re-queued them
    // (CLOSING_KINDS in events.ts). So the throw owes exactly what a failed
    // Attempt owes, written with the same fields so no reader can tell them apart.
    const [attempt, thrown] = await tryCatch(
      runTurn(key, prompt, notify, {
        kind: 'msgs',
        msgIds: msgs.map((x) => x.message_id),
        ...(recovered ? { recovered } : {}),
      })
    );
    if (thrown !== null) {
      const error = errMessage(thrown);
      evMany(
        msgs.map((x) => ({
          kind: 'turn_fail' as const,
          convo: key,
          msgId: x.message_id,
          payload: asPayload({
            ok: false,
            sessionId: null,
            resumedFrom: null,
            costUSD: null,
            numTurns: null,
            durationMs: null,
            toolUses: null,
            timedOut: false,
            killedAfterResult: false,
            error: error.slice(0, 500),
            kind: 'msgs',
            ...(recovered ? { recovered: true } : {}),
          }),
        }))
      );
      await reportTurnFailure(key, error, notify);
      settleIncoming(claimsDb, msgs, { note: `failed: ${error.slice(0, 120)}`, log });
      return;
    }
    // Either way the owner got an answer (the result or the ⚠️), so the message
    // is done — a replay must not open a second turn on it.
    const note = attempt.ok
      ? attempt.killedAfterResult
        ? 'answered (killed after result)'
        : 'answered'
      : `failed: ${String(attempt.error ?? '').slice(0, 120)}`;
    settleIncoming(claimsDb, msgs, { note, log });
  }

  // --- wake spool (deferred jobs) -------------------------------------------
  // A turn can start work that outlives it: a local whisper run, a long build, a
  // scrape. In a purely message-driven daemon NOTHING can wake that topic's
  // session when the work finishes, so a turn could end with "I'll report back
  // when the job is done" and the report would simply never come. That is not a
  // hypothetical: on 05.09 a 6.5-minute voice note was transcribed correctly at
  // 18:56, the text sat in /tmp, and the owner heard nothing for a day.
  //
  // The contract, for every background job: on exit — success OR failure — drop
  // one JSON record in the spool (use wake.sh). The record's shape, the rename
  // dance that claims it exactly once and the prompt it becomes all live in
  // wake/spool.ts; what is left here is the wiring: the log lines, the event
  // rows, the Telegram messages and the scheduler.
  //
  // Deliver the payload as plain text when the model turn itself could not run.
  // The content reaching the owner raw beats it reaching nobody.
  async function wakeFallbackDelivery(rec: WakeRecord): Promise<void> {
    const n = resolveNotify(rec.convo);
    if (!n) return;
    const head = t(rec.ok === false ? 'wake.failedToProcessFailed' : 'wake.failedToProcessFinished', {
      job: rec.job ?? rec.kind ?? '',
    });
    await sendText(n.chatId, head, n.threadId);
    const text = String(rec.text ?? t('wake.emptyPayload'));
    for (const chunk of text.match(/[\s\S]{1,3500}/g) ?? []) await sendText(n.chatId, chunk, n.threadId);
    if (rec.file) await sendText(n.chatId, t('wake.fullOutput', { file: rec.file }), n.threadId);
  }

  async function drainWake(): Promise<void> {
    // claimPending has already renamed each record to <name>.taken and has
    // dead-lettered the two kinds it cannot use; what is owed here is the owner's
    // message for those, and a queued turn for the rest.
    for (const item of claimPending(WAKE_DIR)) {
      if (item.kind === 'unreadable') {
        log('wake record unreadable:', item.file, item.error);
        await sendText(OWNER_ID, t('wake.badRecord', { file: item.file, error: item.error }));
        continue;
      }
      if (item.kind === 'no-address') {
        const { rec } = item;
        log('wake record has no usable convo:', item.file, JSON.stringify(rec.convo));
        await sendText(
          OWNER_ID,
          t('wake.noAddress', {
            convo: String(rec.convo),
            job: rec.job ?? rec.kind ?? '',
            file: item.file,
          })
        );
        continue;
      }
      const { rec, taken, file: f, notify } = item;
      log(`wake [${String(rec.convo)}] ${rec.job ?? rec.kind} ok=${rec.ok !== false} — queued`);
      ev('wake_enqueued', {
        convo: String(rec.convo),
        payload: asPayload({
          file: f,
          job: rec.job,
          kind: rec.kind,
          ok: rec.ok !== false,
          started: rec.startedAt ?? rec['started'] ?? null,
        }),
      });
      // Through the scheduler, not inline: that topic may be mid-turn (one
      // session cannot run two turns at once) and other topics must not wait.
      // The .taken file stays in the spool until the turn ran; a daemon death in
      // between is covered by the orphan requeue at startup.
      sched?.enqueue(String(rec.convo), { kind: 'wake', rec, taken, file: f, notify });
    }
  }

  async function runWakeItem(key: string, item: QueuedWake): Promise<void> {
    const { rec, taken, file, notify } = item;
    let ok = false;
    try {
      const attempt = await runTurn(key, renderWakePrompt(rec), notify, {
        kind: 'wake',
        file,
        job: rec.job,
      });
      ok = attempt.ok;
    } catch (e) {
      log('wake turn threw:', errMessage(e));
    }
    let fallbackDelivered = false;
    if (!ok) {
      await wakeFallbackDelivery(rec);
      fallbackDelivered = true;
    }
    ev(ok ? 'wake_done' : 'wake_fail', {
      convo: key,
      payload: asPayload({ file, job: rec.job, fallbackDelivered }),
    });
    finishItem(taken, file, WAKE_DIR);
  }

  // --- commands (no model) --------------------------------------------------
  function commandOf(m: TgMessage): string | null {
    const first = (m.text ?? '').trim().split(/\s+/)[0] ?? '';
    if (!first.startsWith('/')) return null;
    return (first.slice(1).split('@')[0] ?? '').toLowerCase();
  }

  // Wrapper, so the `command` event is recorded once no matter which call site
  // handled it (the main loop or siphonCommands during a burst) — and so a
  // command always CLOSES its own inbound event.
  async function handleCommand(m: TgMessage, cmd: string): Promise<boolean> {
    const handled = await runCommand(m, cmd);
    if (handled) ev('command', { convo: convoKey(m), msgId: m.message_id, payload: { cmd } });
    return handled;
  }

  async function runCommand(m: TgMessage, cmd: string): Promise<boolean> {
    const key = convoKey(m);
    if (cmd === 'reset') {
      const inFlight = Boolean(sched?.snapshot().inflight.some((turn) => turn.key === key));
      delete state.sessions[key];
      bumpGen(key); // an in-flight turn on this key must not write its session back
      ev('session_reset', { convo: key, msgId: m.message_id, payload: { inFlight } });
      saveState();
      await sendText(m.chat.id, inFlight ? t('reset.done') : t('reset.doneThisTopic'), m.message_thread_id);
      return true;
    }
    if (cmd === 'status') {
      const sn = sched?.snapshot() ?? { inflight: [], queued: 0 };
      await sendText(
        m.chat.id,
        statusReply({
          pid: process.pid,
          uptimeMin: Math.round(process.uptime() / 60),
          topics: Object.keys(state.sessions).length,
          inflight: sn.inflight.map((turn) => turn.key),
          queued: sn.queued,
          ledgerFile: LEDGER,
          now: now(),
          fallback: fallback.snapshot(),
        }),
        m.message_thread_id
      );
      return true;
    }
    if (cmd === 'help') {
      await sendText(
        m.chat.id,
        t('help.body', { settleMin: Math.round(BURST_SETTLE_MS / 60000) }),
        m.message_thread_id
      );
      return true;
    }
    return false;
  }

  // Commands answer instantly (no model), so they must not sit in the burst
  // window: a /status that replies three minutes later answers nothing.
  // Returns the non-command remainder.
  async function siphonCommands(list: TgMessage[]): Promise<TgMessage[]> {
    const rest: TgMessage[] = [];
    for (const m of list) {
      const cmd = commandOf(m);
      if (cmd && (await handleCommand(m, cmd))) {
        settleIncoming(claimsDb, [m], { note: `command /${cmd}`, log });
        continue;
      }
      rest.push(m);
    }
    return rest;
  }

  // --- shutdown -------------------------------------------------------------
  let running = true;
  let settleDone: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    settleDone = resolve;
  });
  // SIGINT/SIGTERM are wired by whoever owns the process — core's runService
  // does it for the plugin entry point and calls this with the signal's name.
  const shutdown = (sig: string): void => {
    const sn = sched?.snapshot();
    if (sn?.inflight.length)
      log(`${sig} with turns in flight: ${sn.inflight.map((turn) => turn.key).join(', ')}`);
    log(`${sig} — shutting down`);
    ev('runner_stop', { payload: { reason: sig, inflight: sn?.inflight.map((turn) => turn.key) ?? [] } });
    phase = { kind: 'down', reason: sig };
    heartbeat();
    running = false;
    removePid();
    settleDone();
    exit(0);
  };
  process.on('exit', removePid);

  let me: z.infer<typeof MeSchema>;
  try {
    me = MeSchema.parse(await tg('getMe'));
  } catch (e) {
    stderr(`getMe failed (bad token?): ${errMessage(e)}`);
    removePid();
    exit(0);
    return NOT_STARTED;
  }
  log(
    `tg-orchestrator up: @${me.username}, pid=${process.pid}, offset=${state.offset}, ` +
      `turn timeout ${Math.round(CLAUDE_TIMEOUT_MS / 60000)} min, dedup ${claimsDb ? 'on' : 'OFF'}, ` +
      `parallel turns ${MAX_PARALLEL_TURNS}`
  );
  ev('runner_start', {
    payload: {
      pid: process.pid,
      offset: state.offset,
      parallel: MAX_PARALLEL_TURNS,
      timeoutMs: CLAUDE_TIMEOUT_MS,
    },
  });
  // A pre-existing install has state.json but no history. Seed one snapshot from
  // what is in memory so `events.mjs sessions/rebuild` has a baseline to fold
  // onto instead of projecting from an empty log.
  try {
    if (eventsDb && !latestSnapshot(eventsDb)) {
      ev('snapshot', { payload: asPayload({ offset: state.offset, sessions: state.sessions }) });
      log('event log: seeded the baseline snapshot from state.json');
    }
  } catch (e) {
    log('event log snapshot check failed:', errMessage(e));
  }

  // The spool must exist before any job tries to write into it, and anything a
  // previous run claimed but never finished gets one more chance — a job whose
  // result died with the daemon is exactly the silence this whole thing exists
  // to prevent. One retry only: `.taken.taken` would mean the record itself is
  // what kills the runner.
  ensureSpool(WAKE_DIR);
  for (const move of planRequeue(WAKE_DIR)) {
    log(`wake: requeueing orphaned ${move.from} -> ${move.to}`);
    const done = applyRequeue(move);
    if (!done.ok) log('wake requeue failed:', done.error);
  }

  // One queue per conversation: turns on different topics overlap (up to
  // MAX_PARALLEL_TURNS), turns on the same topic never do, and messages that
  // arrive while a topic is mid-turn fold into its next turn instead of waiting
  // unread in Telegram. See scheduler.ts.
  const scheduler = createScheduler({
    maxParallel: MAX_PARALLEL_TURNS,
    log: (...parts) => log(...parts.map((p) => String(p))),
    onChange: heartbeat,
    // enqueue is the scheduler's trust boundary and this file is its only
    // caller: everything that goes in was built as a Queued a few lines above.
    run: (key, item) => runQueued(key, item as Queued),
  });
  sched = scheduler;

  const runQueued = (key: string, item: Queued): Promise<void> =>
    item.kind === 'wake' ? runWakeItem(key, item) : handleConversation(key, item.msgs, item.recovered ?? null);

  // --- crash recovery -------------------------------------------------------
  // The whole reason the event log exists. Every inbound message was written to
  // disk before the offset moved past it, so anything the previous daemon never
  // closed (no turn_result / turn_fail / command / flush_word / skipped) is still
  // owed an answer — Telegram will not send it again. Re-queue it, with the model
  // told it is a replay so it does not repeat side effects the dead turn may have
  // already produced.
  try {
    const orphans = eventsDb ? orphanedInbound(eventsDb) : [];
    const byConvoOrphans = new Map<string | null, typeof orphans>();
    for (const r of orphans) {
      const rows = byConvoOrphans.get(r.convo);
      if (rows) rows.push(r);
      else byConvoOrphans.set(r.convo, [r]); // seq order preserved by orphanedInbound
    }
    let requeued = 0;
    let topics = 0;
    for (const [convo, rows] of byConvoOrphans) {
      const [chatId, threadId] = String(convo ?? '')
        .split(':')
        .map(Number);
      const recent: TgMessage[] = [];
      let diedAt = 0;
      for (const r of rows) {
        const stored = TgMessageSchema.safeParse(r.message);
        // No convo or no stored message = nothing to replay and nowhere to say
        // so. Close it, otherwise it is re-examined on every single startup.
        if (!convo || !stored.success) {
          ev('skipped', { convo, msgId: r.msgId, payload: { reason: 'recovery: no replayable message' } });
          continue;
        }
        if (now() - r.at <= RECOVERY_MAX_AGE_MS) {
          if (!recent.length) diedAt = r.at;
          recent.push(stored.data);
          continue;
        }
        ev('skipped', { convo, msgId: r.msgId, payload: { reason: 'recovery: too old' } });
        if (chatId) {
          await sendText(
            chatId,
            t('recovery.tooOld', { msgId: String(r.msgId), at: new Date(r.at).toLocaleString() }),
            threadId || undefined
          );
        }
      }
      if (!recent.length) continue;
      // Same gate as a live message: another agent may have taken it meanwhile.
      const accepted = claimIncoming(claimsDb, recent, { log });
      const mine = new Set(accepted);
      for (const m of recent) {
        if (!mine.has(m)) {
          ev('skipped', { convo, msgId: m.message_id, payload: { reason: 'recovery: claimed elsewhere' } });
        }
      }
      if (!accepted.length) continue;
      scheduler.enqueue(String(convo), {
        kind: 'msgs',
        msgs: accepted,
        recovered: { diedAt: new Date(diedAt).toISOString() },
      });
      requeued += accepted.length;
      topics++;
    }
    if (requeued) log(`recovery: ${requeued} message(s) in ${topics} topic(s) re-queued`);
    else if (orphans.length) log(`recovery: ${orphans.length} orphaned message(s), none re-queued`);
  } catch (e) {
    // Recovery is a bonus, never a precondition: a broken log must not keep the
    // daemon from starting and answering the NEXT message.
    log('recovery failed — starting anyway:', errMessage(e));
  }

  // --- main loop ------------------------------------------------------------
  let drainAsked = false;
  async function mainLoop(): Promise<void> {
    let backoff = 1000;
    phase = { kind: 'poll' };
    heartbeat();
    while (running) {
      try {
        // Restart handshake. The watcher cannot know whether a turn started in the
        // milliseconds between its last status sample and its kill, so it does
        // not kill: it touches DRAIN_FILE and the runner takes it from here —
        // nothing new is polled (unpolled messages stay on Telegram's side and are
        // delivered to the next runner; wake records stay in the spool), queued
        // and in-flight turns run to completion, then the process exits.
        if (drainAsked || fs.existsSync(DRAIN_FILE)) {
          phase = { kind: 'draining' };
          const sn = scheduler.snapshot();
          log(
            `drain requested — ${sn.inflight.length} turn(s) in flight, ${sn.queued} queued; taking no new work`
          );
          heartbeat();
          await scheduler.drain();
          log('drained — exiting for restart');
          try {
            fs.unlinkSync(DRAIN_FILE);
          } catch {
            /* a drain asked for in-process leaves no flag behind */
          }
          shutdown('drain');
          return;
        }
        let msgs = await pollOnce(50);
        backoff = 1000;
        // Before anything else: a background job that finished while we were
        // long-polling is waiting to be reported. Nothing else can wake it.
        await drainWake();
        if (!msgs.length) continue;
        msgs = await siphonCommands(msgs);
        if (!msgs.length) continue;
        const burstStart = now();
        let lastAt = now();
        phase = { kind: 'burst', since: new Date(burstStart).toISOString(), msgs: msgs.length };
        heartbeat();
        while (!msgs.some(isFlush)) {
          let more: TgMessage[];
          try {
            more = await pollOnce(BURST_POLL_S);
          } catch (e) {
            // The offset is already past the buffered messages (at-most-once), so
            // a poll hiccup here — Mac sleep aborting the fetch, a network blip —
            // must flush what we have, NOT unwind into the outer catch and drop
            // it. Cost a voice note on 13.08 before this guard existed.
            log(`burst poll error — flushing ${msgs.length} buffered msg(s):`, errMessage(e));
            break;
          }
          if (more.length) {
            const rest = await siphonCommands(more);
            if (rest.length) {
              msgs = msgs.concat(rest);
              lastAt = now(); // only content re-arms the window, not commands
              phase = { kind: 'burst', since: new Date(burstStart).toISOString(), msgs: msgs.length };
              heartbeat();
            }
            continue; // re-arm: the flush check at the top runs against the new ones
          }
          if (now() - lastAt >= BURST_SETTLE_MS) break;
          if (now() - burstStart >= BURST_WINDOW_MAX_MS) {
            log(`burst cap ${BURST_WINDOW_MAX_MS}ms reached with ${msgs.length} msgs — flushing`);
            break;
          }
        }
        phase = { kind: 'dispatch' };
        if (msgs.some(isFlush)) log(`flush word after ${now() - burstStart}ms, ${msgs.length} msgs`);

        const passthrough: TgMessage[] = [];
        for (const m of msgs) {
          if (isFlush(m)) {
            ev('flush_word', { convo: convoKey(m), msgId: m.message_id });
            settleIncoming(claimsDb, [m], { note: 'flush word', log }); // punctuation, not content
            continue;
          }
          const cmd = commandOf(m);
          if (cmd && (await handleCommand(m, cmd))) {
            settleIncoming(claimsDb, [m], { note: `command /${cmd}`, log });
            continue;
          }
          passthrough.push(m);
        }
        // Group by conversation and hand each group to that topic's queue — no
        // await: the loop goes straight back to polling while the turns run.
        const byConvo = new Map<string, TgMessage[]>();
        for (const m of passthrough) {
          const k = convoKey(m);
          const group = byConvo.get(k);
          if (group) group.push(m);
          else byConvo.set(k, [m]);
        }
        for (const [key, group] of byConvo) scheduler.enqueue(key, { kind: 'msgs', msgs: group });
        heartbeat();
      } catch (e) {
        phase = { kind: 'poll' };
        heartbeat();
        log('poll error:', errMessage(e));
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  const loop = mainLoop().catch((e: unknown) => {
    log('runner loop failed:', errMessage(e));
    settleDone();
  });

  return {
    done: Promise.race([loop, stopped]),
    drain: async (): Promise<void> => {
      drainAsked = true;
      await Promise.race([loop, stopped]);
    },
    stop: (reason: string): void => shutdown(reason),
  };
}
