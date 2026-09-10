#!/usr/bin/env node
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './claims.mjs';
import { createScheduler } from './scheduler.mjs';
import {
  annotateIncoming,
  attemptTurn,
  claimIncoming,
  parseTimeoutMs,
  runClaude,
  settleIncoming,
  TIMEOUT_WARN_BEFORE_MS,
} from './turn.mjs';

const CFG_DIR = path.join(os.homedir(), '.config', 'tg-orchestrator');
const ENV_FILE = path.join(CFG_DIR, 'env');
const STATE_FILE = path.join(CFG_DIR, 'state.json');
const PID_FILE = path.join(CFG_DIR, 'runner.pid');
const LEDGER = path.join(CFG_DIR, 'usage.jsonl');
const LOG_FILE = path.join(CFG_DIR, 'runner.log');
// Deferred-job spool: see "wake spool" below.
const WAKE_DIR = path.join(CFG_DIR, 'wake');
const WAKE_DONE = path.join(WAKE_DIR, 'done');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // agent.md and agents/ live at the repo root, code in src/
const AGENT_MD = path.join(ROOT, 'agent.md');
// Per-topic brains. A topic is a workstream, and some workstreams want their
// own agent rather than the generic orchestrator: drop
// agents/<chat_id>_<thread_id>.md and that topic gets it as its system prompt
// INSTEAD of agent.md. Such a file must be self-contained (channel rules
// included) — see agents/README.md.
const AGENTS_DIR = path.join(ROOT, 'agents');

function agentMdFor(key) {
  const file = path.join(AGENTS_DIR, key.replace(':', '_') + '.md');
  return fs.existsSync(file) ? file : AGENT_MD;
}

// Per-topic sessions die after this much silence. Personal threads are
// long-lived on purpose — a topic IS a workstream — but replaying a week-old
// transcript on every message is the cost pattern that killed an earlier bot,
// so idle ones still reset.
const SESSION_IDLE_RESET_MS = 6 * 60 * 60 * 1000;
// Burst window. Answering one message at a time forces whoever is typing to
// cram a whole thought into a single bubble; in practice a reply arrives as
// three texts and two voice notes. So the window SLIDES: every new message
// re-arms the timer, and the agent gets the whole run as one turn.
// Cost: a reply never lands sooner than BURST_SETTLE_MS after the last message.
const BURST_SETTLE_MS = Number(process.env.TG_BURST_SETTLE_MS ?? 3 * 60 * 1000);
// ...but a steady drip must not postpone the answer forever.
const BURST_WINDOW_MAX_MS = Number(process.env.TG_BURST_WINDOW_MAX_MS ?? 15 * 60 * 1000);
// How often the window wakes up while waiting. Short hops (not one long sleep)
// are what make an explicit flush word land immediately instead of at the end
// of the settle period.
const BURST_POLL_S = 10;
// ...and the flush itself: "I've finished the thought, read it now". A message
// that is EXACTLY one of these ends the window at once and is not forwarded to
// the model — it is punctuation, not content. Anything longer is a normal
// message, so "читай доку" waits like everything else.
const FLUSH_WORDS = new Set([
  'читай',
  'прочитай',
  'ответь',
  'отвечай',
  'го',
  'go',
  'answer',
  'всё',
  'все',
]);
const isFlush = (m) =>
  FLUSH_WORDS.has(
    (m.text ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\//, '')
      .replace(/[.!?,;\s]+$/, '')
  );

const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  // Under ensure.sh stdout is redirected into LOG_FILE, so echoing there too
  // doubled every line; keep the echo for interactive runs only.
  if (process.stdout.isTTY) console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
};

// --- config ---------------------------------------------------------------
if (!fs.existsSync(ENV_FILE)) {
  console.error(`no ${ENV_FILE} — refusing to start (see orchestrator/README.md)`);
  process.exit(0);
}
const env = Object.fromEntries(
  fs
    .readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = Number(env.OWNER_ID || 0);
if (!TOKEN || TOKEN.includes('PASTE') || !OWNER_ID) {
  console.error('env must define TELEGRAM_BOT_TOKEN and OWNER_ID');
  process.exit(0);
}
const API = `https://api.telegram.org/bot${TOKEN}`;
// Hard cap on one Claude turn. TG_CLAUDE_TIMEOUT_MS (process env or the env
// file) overrides; the topic gets a warning TIMEOUT_WARN_BEFORE_MS before the
// kill, so a long turn never dies silently. Default 50 min: the 30-min cap
// killed two finished turns on 10.09.
const CLAUDE_TIMEOUT_MS = parseTimeoutMs(process.env.TG_CLAUDE_TIMEOUT_MS ?? env.TG_CLAUDE_TIMEOUT_MS);
// How many conversations may be in a Claude turn at once. Turns on the SAME
// topic are always serial (one session, one transcript); different topics run
// side by side, so a question in «dev» no longer waits for an analysis in
// another topic — that wait is what looked like a dead agent on 10.09.
// TG_MAX_PARALLEL_TURNS (process env or the env file) overrides; default 3.
function parseParallel(raw, fallback = 3) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}
const MAX_PARALLEL_TURNS = parseParallel(process.env.TG_MAX_PARALLEL_TURNS ?? env.TG_MAX_PARALLEL_TURNS);

// --- singleton ------------------------------------------------------------
try {
  const old = Number(fs.readFileSync(PID_FILE, 'utf8'));
  if (old > 0) {
    process.kill(old, 0);
    process.exit(0); // another runner is alive
  }
} catch {
  /* stale or missing pid — take over */
}
fs.writeFileSync(PID_FILE, String(process.pid));
// Drain handshake (see the main loop): restart-when-idle.sh touches this file,
// the runner finishes what is in flight, takes no new work and exits. A flag
// left behind by a watcher that died must not drain the next runner.
const DRAIN_FILE = path.join(CFG_DIR, 'drain');
try {
  fs.unlinkSync(DRAIN_FILE);
  log('stale drain flag removed');
} catch {}
const removePid = () => {
  try {
    if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
};

// --- state ----------------------------------------------------------------
let state = { offset: 0, sessions: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch {}
// Atomic replace: a reader in another process (status.mjs, restart-when-idle.sh)
// sees either the old file or the new one, never a truncated or half-written
// JSON. Same directory, so rename() is atomic on the same filesystem.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const saveState = () => writeAtomic(STATE_FILE, JSON.stringify(state));

// Session generations. A turn captures its resume id when it starts and writes
// the resulting session id back when it ends; a /reset in between would be
// silently undone by that write-back. The turn therefore remembers the
// generation it started in and only writes back if nobody reset since.
const sessionGen = new Map();
const genOf = (key) => sessionGen.get(key) ?? 0;
const bumpGen = (key) => sessionGen.set(key, genOf(key) + 1);

// Who is handling which message — the shared SQLite registry (claims.mjs,
// ~/.config/claude-agents/claims.sqlite), NOT state.json: read / in-turn /
// done survive a runner restart and are visible to the other agents. Every
// incoming message is claimed before processing and released after it, so a
// redelivered or replayed message never reaches a model twice.
let claimsDb = null;
try {
  claimsDb = openDb();
} catch (e) {
  log('claims registry unavailable — running WITHOUT dedup:', e.message);
}

// A conversation = one chat + one forum topic. DMs and non-forum groups fold
// into thread 0.
const convoKey = (m) => `${m.chat.id}:${m.message_thread_id ?? 0}`;

// --- heartbeat --------------------------------------------------------------
// "What is the daemon doing", for status.mjs and restart-when-idle.sh: idle
// (nothing in flight, nothing queued), burst (buffering a message run) or
// claude (≥1 turn in flight — `turns` lists them; `convo`/`msgs`/`at` mirror
// the first one for older readers). Best-effort, never throws. `phase: idle`
// is what restart-when-idle.sh waits for, so it must mean "safe to kill".
const STATUS_FILE = path.join(CFG_DIR, 'status.json');
function setStatus(phase, extra = {}) {
  try {
    writeAtomic(
      STATUS_FILE,
      JSON.stringify({ phase, at: new Date().toISOString(), pid: process.pid, ...extra })
    );
  } catch {}
}
let burst = null; // { since, msgs } while a message run is being buffered
let sched = null; // the per-conversation scheduler, created before the main loop
let draining = false; // drain flag seen: finishing in-flight turns, no new work
function heartbeat() {
  const s = sched ? sched.snapshot() : { inflight: [], queued: 0 };
  const turns = s.inflight.map((t) => ({ ...t, since: new Date(t.since).toISOString() }));
  if (draining) setStatus('draining', { turns, queued: s.queued });
  else if (s.inflight.length) {
    const first = turns[0];
    setStatus('claude', {
      at: first.since,
      convo: first.key,
      msgs: first.size,
      turns,
      queued: s.queued,
      burst,
    });
  } else if (burst) setStatus('burst', burst);
  else setStatus('idle', { queued: s.queued });
}

// --- telegram -------------------------------------------------------------
async function tg(method, params = {}, timeoutMs = 30_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctl.signal,
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`${method}: ${body.error_code} ${body.description}`);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}
const sendText = (chatId, text, threadId) =>
  tg('sendMessage', {
    chat_id: chatId,
    text,
    ...(threadId ? { message_thread_id: threadId } : {}),
  }).catch((e) => log('sendText failed:', e.message));

async function pollOnce(timeout) {
  const updates = await tg(
    'getUpdates',
    { offset: state.offset + 1, timeout, allowed_updates: ['message'] },
    (timeout + 15) * 1000
  );
  const msgs = [];
  for (const u of updates) {
    state.offset = Math.max(state.offset, u.update_id);
    const m = u.message;
    // Owner-only, hard. This agent runs with permissions off on a personal
    // machine; anyone else's messages are dropped before they reach a model.
    if (!m || m.from?.id !== OWNER_ID) continue;
    if (!['private', 'group', 'supergroup'].includes(m.chat?.type)) continue;
    msgs.push(m);
  }
  if (updates.length) saveState();
  // Dedup: claim every message before it goes anywhere (logs claimed /
  // already-claimed / already-handled / busy per message).
  return claimIncoming(claimsDb, msgs, { log });
}

// --- message rendering ----------------------------------------------------
function renderMessage(m) {
  const head =
    `[msg ${m.message_id} · chat_id=${m.chat.id}` +
    (m.message_thread_id ? ` · topic_thread=${m.message_thread_id}` : '') +
    (m.chat.title ? ` · "${m.chat.title}"` : ' · DM') +
    `]`;
  const parts = [];
  if (m.voice)
    parts.push(
      `[VOICE ${m.voice.duration}s — transcribe FIRST via mcp__telegram__transcribe_voice` +
        `(chat_id=${m.chat.id}, message_id=${m.message_id}), then act on the transcript]`
    );
  if (m.video_note) parts.push(`[video note ${m.video_note.duration}s — transcribe the same way]`);
  if (m.photo) parts.push(`[photo file_id=${m.photo.at(-1).file_id}]`);
  if (m.document) parts.push(`[file "${m.document.file_name}" file_id=${m.document.file_id}]`);
  if (m.reply_to_message)
    parts.push(
      `[reply to msg ${m.reply_to_message.message_id}: ${(m.reply_to_message.text ?? '').slice(0, 200)}]`
    );
  const text = m.text ?? m.caption ?? '';
  if (text) parts.push(text);
  return `${head}\n${parts.join('\n')}`;
}

// --- claude ---------------------------------------------------------------
function childEnv() {
  const e = { ...process.env, TELEGRAM_BOT_TOKEN: TOKEN, OWNER_ID: String(OWNER_ID) };
  // Land on the PERSONAL account: strip every CLAUDE* var (this runner may be
  // started from a shell whose env carries another account's CLAUDE_CONFIG_DIR).
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE')) delete e[k];
  // tagents dashboard: headless sessions carry a label + a log to preview.
  e.TA_LABEL = 'tg-orchestrator';
  e.TA_LOG = LOG_FILE;
  return e;
}

// stream-json (needs --verbose in -p mode) instead of plain json: the final
// `result` event is the same object, but the events before it show whether the
// turn already did anything — which is what decides if a retry is safe.
function claudeArgs(prompt, resumeId, agentMd) {
  const args = [
    '-p',
    '--model',
    // Owner's call (10.09.2026): the orchestrator itself runs on fable. Env-driven
    // so switching back is a variable, not a patch.
    process.env['TG_CLAUDE_MODEL'] ?? 'fable',
    '--effort',
    process.env['TG_CLAUDE_EFFORT'] ?? 'xhigh',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file',
    agentMd,
  ];
  if (resumeId) args.push('--resume', resumeId);
  args.push(prompt);
  return args;
}

function runClaudeTurn(prompt, resumeId, agentMd, notify) {
  return runClaude({
    bin: 'claude',
    args: claudeArgs(prompt, resumeId, agentMd),
    cwd: os.homedir(),
    env: childEnv(),
    timeoutMs: CLAUDE_TIMEOUT_MS,
    warnBeforeMs: TIMEOUT_WARN_BEFORE_MS,
    log,
    onWarn: notify
      ? ({ elapsedMs, leftMs }) =>
          sendText(
            notify.chatId,
            `⏳ Ход идёт дольше обычного: уже ${Math.round(elapsedMs / 60000)} мин. ` +
              `Через ${Math.round(leftMs / 60000)} мин прерву его по таймауту ` +
              `(лимит ${Math.round(CLAUDE_TIMEOUT_MS / 60000)} мин, TG_CLAUDE_TIMEOUT_MS).`,
            notify.threadId
          )
      : null,
  });
}

// One Claude turn on a conversation: resume that topic's session, run, book the
// cost, and never end silently — a failure is reported into the topic. `notify`
// is passed in rather than derived from a message because a turn can also be
// driven by a background job (see the wake spool below), which has no message.
async function runTurn(key, prompt, notify) {
  const sess = state.sessions[key];
  const gen = genOf(key);
  const fresh = !sess || Date.now() - (sess.last ?? 0) > SESSION_IDLE_RESET_MS;
  const resumeId = fresh ? null : sess.id;
  const agentMd = agentMdFor(key);
  if (agentMd !== AGENT_MD) log(`[${key}] brain: ${path.basename(agentMd)}`);

  // Never re-run a turn that already did something: it may already have
  // answered in the topic, and a second run duplicates every side effect.
  // attemptTurn logs the decision (retry-fresh / retry-suppressed).
  const { attempt } = await attemptTurn(
    (resume) => runClaudeTurn(prompt, resume, agentMd, notify),
    resumeId,
    (line) => log(`[${key}]`, line)
  );
  const p = attempt.payload ?? {};
  // A turn that ran tools left a transcript worth resuming even if it failed.
  if (attempt.sessionId && (attempt.ok || attempt.toolUses > 0)) {
    if (genOf(key) === gen) state.sessions[key] = { id: attempt.sessionId, last: Date.now() };
    else log(`[${key}] /reset arrived mid-turn — this transcript is not kept`);
  }
  saveState();
  try {
    fs.appendFileSync(
      LEDGER,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'tg-orchestrator',
        ok: attempt.ok,
        convo: key,
        sessionId: p.session_id ?? null,
        resumedFrom: resumeId,
        costUSD: p.total_cost_usd ?? null,
        numTurns: p.num_turns ?? null,
        durationMs: p.duration_ms ?? null,
        toolUses: attempt.toolUses ?? null,
        timedOut: attempt.timedOut ?? false,
        killedAfterResult: attempt.killedAfterResult ?? false,
      }) + '\n'
    );
  } catch {}
  if (attempt.ok) {
    const how = attempt.killedAfterResult ? ' (result accepted; process killed after it)' : '';
    log(`claude ok${how} [${key}]:`, String(p.result ?? '').replace(/\s+/g, ' ').slice(0, 160));
  } else {
    log(`claude FAILED [${key}]:`, attempt.error);
    if (notify)
      await sendText(
        notify.chatId,
        `⚠️ Не смог обработать: ${attempt.error.slice(0, 200)}`,
        notify.threadId
      );
  }
  return attempt;
}

async function handleConversation(key, msgs) {
  const m = msgs[0];
  const prompt =
    `New Telegram message${msgs.length > 1 ? 's' : ''} from the owner. ` +
    `Now: ${new Date().toISOString()}\n\n` +
    msgs.map(renderMessage).join('\n\n');
  annotateIncoming(claimsDb, msgs, { note: 'in-turn', log });
  const attempt = await runTurn(key, prompt, { chatId: m.chat.id, threadId: m.message_thread_id });
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
// one JSON record in WAKE_DIR (use wake.sh). This loop turns each record into a
// turn on the same topic, so the agent finishes what the earlier turn promised.
// Shape: { convo: "<chat_id>:<thread_id>", job, kind, ok, text, file,
//          startedAt, finishedAt }
const WAKE_MAX_TEXT = 20_000;
const WAKE_LATE_MS = 30 * 60 * 1000;

function wakeNotify(convo) {
  const [chatId, threadId] = String(convo ?? '').split(':');
  if (!Number(chatId)) return null;
  return { chatId: Number(chatId), threadId: Number(threadId) || undefined };
}

function wakePrompt(rec) {
  const text = String(rec.text ?? '');
  const clipped =
    text.length > WAKE_MAX_TEXT
      ? text.slice(0, WAKE_MAX_TEXT) + `\n[...clipped, full text in ${rec.file ?? 'the job output'}]`
      : text;
  const age = rec.finishedAt ? Date.now() - Date.parse(rec.finishedAt) : 0;
  const lines = [
    `Background job finished — this is NOT a new message from the owner.`,
    `Now: ${new Date().toISOString()}`,
    ``,
    `A previous turn of yours in this topic started this job and told the owner`,
    `it would report back. Finish that promise now: act on the result and answer`,
    `in the topic via the Bot API. The owner has heard nothing since.`,
    ``,
    `Job: ${rec.job ?? rec.kind ?? 'unknown'} (kind=${rec.kind ?? '?'}, ok=${rec.ok !== false})`,
    rec.startedAt ? `Started: ${rec.startedAt}` : null,
    rec.finishedAt ? `Finished: ${rec.finishedAt}` : null,
    rec.file ? `Output file: ${rec.file}` : null,
  ].filter(Boolean);
  if (age > WAKE_LATE_MS)
    lines.push(
      ``,
      `LATE: this result waited ${Math.round(age / 60000)} min before reaching you.`,
      `Say so plainly in your answer instead of pretending it is fresh.`
    );
  lines.push(``, rec.ok === false ? `The job FAILED. Error output:` : `Result:`, ``, clipped);
  if (rec.ok === false)
    lines.push(
      ``,
      `Tell the owner it failed and what you are doing about it. Retry at most`,
      `once, and only if the error looks transient.`
    );
  return lines.join('\n');
}

// Deliver the payload as plain text when the model turn itself could not run.
// The content reaching the owner raw beats it reaching nobody.
async function wakeFallbackDelivery(rec) {
  const n = wakeNotify(rec.convo);
  if (!n) return;
  const head = `⚠️ Фоновая задача «${rec.job ?? rec.kind}» ${rec.ok === false ? 'упала' : 'закончилась'}, но я не смог её обработать. Сырой результат:`;
  await sendText(n.chatId, head, n.threadId);
  const text = String(rec.text ?? '(пусто)');
  for (const chunk of text.match(/[\s\S]{1,3500}/g) ?? []) await sendText(n.chatId, chunk, n.threadId);
  if (rec.file) await sendText(n.chatId, `Полный вывод: ${rec.file}`, n.threadId);
}

async function drainWake() {
  let files;
  try {
    files = fs
      .readdirSync(WAKE_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return;
  }
  for (const f of files) {
    const src = path.join(WAKE_DIR, f);
    // Claim first: a record that makes the runner crash must not be replayed
    // forever. A crash mid-turn leaves a .taken file, requeued once at startup.
    const taken = path.join(WAKE_DIR, `${f}.taken`);
    let rec;
    try {
      fs.renameSync(src, taken);
      rec = JSON.parse(fs.readFileSync(taken, 'utf8'));
    } catch (e) {
      log('wake record unreadable:', f, e.message);
      try {
        fs.renameSync(taken, path.join(WAKE_DONE, `${f}.bad`));
      } catch {}
      await sendText(OWNER_ID, `⚠️ Битая запись в wake-спуле: ${f} (${e.message})`);
      continue;
    }
    // A record with no usable convo has nowhere to answer — running the turn
    // would burn a model call whose output lands nowhere, i.e. the same silence
    // this spool exists to kill. Dead-letter it to the owner's DM instead.
    const notify = wakeNotify(rec.convo);
    if (!notify) {
      log('wake record has no usable convo:', f, JSON.stringify(rec.convo));
      try {
        fs.renameSync(taken, path.join(WAKE_DONE, `${f}.bad`));
      } catch {}
      await sendText(
        OWNER_ID,
        `⚠️ Запись в wake-спуле без адреса (convo=${rec.convo}): «${rec.job ?? rec.kind}». Лежит в wake/done/${f}.bad`
      );
      continue;
    }
    log(`wake [${rec.convo}] ${rec.job ?? rec.kind} ok=${rec.ok !== false} — queued`);
    // Through the scheduler, not inline: that topic may be mid-turn (one
    // session cannot run two turns at once) and other topics must not wait.
    // The .taken file stays in WAKE_DIR until the turn ran; a daemon death in
    // between is covered by the orphan requeue at startup.
    sched.enqueue(rec.convo, { kind: 'wake', rec, taken, file: f, notify });
  }
}

async function runWakeItem(key, { rec, taken, file, notify }) {
  let attempt = { ok: false };
  try {
    attempt = await runTurn(key, wakePrompt(rec), notify);
  } catch (e) {
    log('wake turn threw:', e.message);
  }
  if (!attempt.ok) await wakeFallbackDelivery(rec);
  try {
    fs.renameSync(taken, path.join(WAKE_DONE, file));
  } catch {}
}

// --- commands (no model) --------------------------------------------------
function commandOf(m) {
  const first = (m.text ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first.startsWith('/')) return null;
  return first.slice(1).split('@')[0].toLowerCase();
}

async function handleCommand(m, cmd) {
  const key = convoKey(m);
  if (cmd === 'reset') {
    delete state.sessions[key];
    bumpGen(key); // an in-flight turn on this key must not write its session back
    saveState();
    const inFlight = sched?.snapshot().inflight.some((t) => t.key === key);
    await sendText(
      m.chat.id,
      inFlight
        ? '🔄 Контекст сброшен. Текущий ход дойдёт на старом контексте, следующий начнётся с чистого листа.'
        : '🔄 Контекст этого топика сброшен.',
      m.message_thread_id
    );
    return true;
  }
  if (cmd === 'status') {
    const n = Object.keys(state.sessions).length;
    const up = Math.round(process.uptime() / 60);
    let usage = '';
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rows = fs
        .readFileSync(LEDGER, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((r) => r && r.ts?.startsWith(today));
      const cost = rows.reduce((s, r) => s + (r.costUSD ?? 0), 0);
      const fails = rows.filter((r) => !r.ok).length;
      usage = `\nсегодня: ${rows.length} вызовов, $${cost.toFixed(2)}${fails ? `, ошибок: ${fails}` : ''}`;
    } catch {}
    const sn = sched?.snapshot() ?? { inflight: [], queued: 0 };
    const busy = sn.inflight.length
      ? `\nв работе: ${sn.inflight.map((t) => t.key).join(', ')}${sn.queued ? `, в очереди ${sn.queued}` : ''}`
      : '';
    await sendText(
      m.chat.id,
      `🟢 живой: pid ${process.pid}, аптайм ${up} мин, топиков с контекстом: ${n}${usage}${busy}`,
      m.message_thread_id
    );
    return true;
  }
  if (cmd === 'help') {
    await sendText(
      m.chat.id,
      'Личный оркестратор. Пиши текстом или голосом — что происходит в проектах, где какой скрипт, ' +
        'что я делал по теме X, создай топик, отправь файл, запусти что-то.\n' +
        `Сообщения копятся, пока ты не замолчишь на ${Math.round(BURST_SETTLE_MS / 60000)} мин — можно писать серией. ` +
        'Закончил мысль раньше — отдельным сообщением «читай» (ещё: го, ответь, всё, /answer): ' +
        'окно закрывается сразу, само слово в агента не уходит.\n' +
        '/reset — сбросить контекст топика · /status — жив ли демон',
      m.message_thread_id
    );
    return true;
  }
  return false;
}

// Commands answer instantly (no model), so they must not sit in the burst
// window: a /status that replies three minutes later answers nothing.
// Returns the non-command remainder.
async function siphonCommands(list) {
  const rest = [];
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

// --- main loop ------------------------------------------------------------
let running = true;
const shutdown = (sig) => {
  const sn = sched?.snapshot();
  if (sn?.inflight.length) log(`${sig} with turns in flight: ${sn.inflight.map((t) => t.key).join(', ')}`);
  log(`${sig} — shutting down`);
  setStatus('down', { reason: sig });
  running = false;
  removePid();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', removePid);

const me = await tg('getMe').catch((e) => {
  console.error('getMe failed (bad token?):', e.message);
  removePid();
  process.exit(0);
});
log(
  `tg-orchestrator up: @${me.username}, pid=${process.pid}, offset=${state.offset}, ` +
    `turn timeout ${Math.round(CLAUDE_TIMEOUT_MS / 60000)} min, dedup ${claimsDb ? 'on' : 'OFF'}, ` +
    `parallel turns ${MAX_PARALLEL_TURNS}`
);

// The spool must exist before any job tries to write into it, and anything a
// previous run claimed but never finished gets one more chance — a job whose
// result died with the daemon is exactly the silence this whole thing exists
// to prevent. One retry only: `.taken.taken` would mean the record itself is
// what kills the runner.
fs.mkdirSync(WAKE_DONE, { recursive: true });
for (const f of fs.readdirSync(WAKE_DIR).filter((f) => f.endsWith('.json.taken'))) {
  const base = f.slice(0, -'.taken'.length);
  const dest = base.endsWith('.retry.json')
    ? path.join(WAKE_DONE, `${f}.giveup`)
    : path.join(WAKE_DIR, base.replace(/\.json$/, '.retry.json'));
  log(`wake: requeueing orphaned ${f} -> ${path.basename(dest)}`);
  try {
    fs.renameSync(path.join(WAKE_DIR, f), dest);
  } catch (e) {
    log('wake requeue failed:', e.message);
  }
}

// One queue per conversation: turns on different topics overlap (up to
// MAX_PARALLEL_TURNS), turns on the same topic never do, and messages that
// arrive while a topic is mid-turn fold into its next turn instead of waiting
// unread in Telegram. See scheduler.mjs.
sched = createScheduler({
  maxParallel: MAX_PARALLEL_TURNS,
  log,
  onChange: heartbeat,
  run: (key, item) =>
    item.kind === 'wake' ? runWakeItem(key, item) : handleConversation(key, item.msgs),
});

let backoff = 1000;
heartbeat();
while (running) {
  try {
    // Restart handshake. The watcher cannot know whether a turn started in the
    // milliseconds between its last status sample and its kill, so it does
    // not kill: it touches DRAIN_FILE and the runner takes it from here —
    // nothing new is polled (unpolled messages stay on Telegram's side and are
    // delivered to the next runner; wake records stay in the spool), queued
    // and in-flight turns run to completion, then the process exits.
    if (fs.existsSync(DRAIN_FILE)) {
      draining = true;
      const sn = sched.snapshot();
      log(`drain requested — ${sn.inflight.length} turn(s) in flight, ${sn.queued} queued; taking no new work`);
      heartbeat();
      await sched.drain();
      log('drained — exiting for restart');
      try {
        fs.unlinkSync(DRAIN_FILE);
      } catch {}
      shutdown('drain');
    }
    let msgs = await pollOnce(50);
    backoff = 1000;
    // Before anything else: a background job that finished while we were
    // long-polling is waiting to be reported. Nothing else can wake it.
    await drainWake();
    if (!msgs.length) continue;
    msgs = await siphonCommands(msgs);
    if (!msgs.length) continue;
    const burstStart = Date.now();
    let lastAt = Date.now();
    burst = { since: new Date(burstStart).toISOString(), msgs: msgs.length };
    heartbeat();
    while (!msgs.some(isFlush)) {
      let more;
      try {
        more = await pollOnce(BURST_POLL_S);
      } catch (e) {
        // The offset is already past the buffered messages (at-most-once), so
        // a poll hiccup here — Mac sleep aborting the fetch, a network blip —
        // must flush what we have, NOT unwind into the outer catch and drop
        // it. Cost a voice note on 13.08 before this guard existed.
        log(`burst poll error — flushing ${msgs.length} buffered msg(s):`, e.message);
        break;
      }
      if (more.length) {
        const rest = await siphonCommands(more);
        if (rest.length) {
          msgs = msgs.concat(rest);
          lastAt = Date.now(); // only content re-arms the window, not commands
          burst = { since: new Date(burstStart).toISOString(), msgs: msgs.length };
          heartbeat();
        }
        continue; // re-arm: the flush check at the top runs against the new ones
      }
      if (Date.now() - lastAt >= BURST_SETTLE_MS) break;
      if (Date.now() - burstStart >= BURST_WINDOW_MAX_MS) {
        log(`burst cap ${BURST_WINDOW_MAX_MS}ms reached with ${msgs.length} msgs — flushing`);
        break;
      }
    }
    burst = null;
    if (msgs.some(isFlush)) log(`flush word after ${Date.now() - burstStart}ms, ${msgs.length} msgs`);

    const passthrough = [];
    for (const m of msgs) {
      if (isFlush(m)) {
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
    const byConvo = new Map();
    for (const m of passthrough) {
      const k = convoKey(m);
      if (!byConvo.has(k)) byConvo.set(k, []);
      byConvo.get(k).push(m);
    }
    for (const [key, group] of byConvo) sched.enqueue(key, { kind: 'msgs', msgs: group });
    heartbeat();
  } catch (e) {
    burst = null;
    heartbeat();
    log('poll error:', e.message);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}
