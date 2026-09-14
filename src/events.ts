// events.ts — the durable event log of the orchestrator ("event sourcing lite").
//
// Why: until this file existed the runner was at-most-once. `pollOnce` moved
// `state.offset` past an update BEFORE the message was processed, so a hard
// death (kill -9, OOM, a panicking Mac) during the burst window or mid-turn
// lost the message for good: Telegram never redelivers past an acknowledged
// offset, and nothing on disk remembered that a message had ever arrived.
// On top of that the truth about "what happened to message N" was scattered
// over three partial logs (runner.log, usage.jsonl, the wake spool) and one
// mutable snapshot (state.json) that only ever shows the present.
//
// So: ONE append-only typed stream. Every inbound message is written here
// BEFORE the offset moves; everything that can close a message (a turn result,
// a command, a flush word, a dedup skip) is written here too. What is open is
// then a query, not a guess — see `orphanedInbound`, which is what the runner
// re-queues at startup.
//
// state.json stays as the hot snapshot the daemon reads on boot; it is now
// derivable (`rebuild`), so a corrupted one is no longer a lost install.
//
// Storage: SQLite via node:sqlite (WAL, synchronous=FULL — inbound durability
// is the entire point) at ~/.config/tg-orchestrator/events.sqlite.
// Env override: TG_EVENTS_DB.
//
// Usable as a library (import) and as a CLI — src/events.mjs is the file the
// world runs and imports. Exit codes: 0 ok, 1 error, 2 usage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
// Reused from the claims registry rather than re-implemented: the same CLI
// argument parser, the same ms->ISO helper, the same "is that pid alive"
// probe. Importing it also installs the ExperimentalWarning filter node:sqlite
// needs, so this module does not repeat that either.
import { iso, parseArgs, pidAlive } from './claims.ts';
import { writeAtomic } from './atomic.ts';

const CFG_DIR = path.join(os.homedir(), '.config', 'tg-orchestrator');
export const DB_PATH = process.env.TG_EVENTS_DB || path.join(CFG_DIR, 'events.sqlite');
const STATE_FILE = path.join(CFG_DIR, 'state.json');
const PID_FILE = path.join(CFG_DIR, 'runner.pid');

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2 } as const;

// Kinds that CLOSE an inbound message: once one of them exists for the same
// (convo, msg_id) at a LATER seq, that message is accounted for. Anything else
// (turn_start, session_reset, ...) is progress, not closure.
export const CLOSING_KINDS = ['turn_result', 'turn_fail', 'command', 'flush_word', 'skipped'] as const;
/** One of the five kinds that account for an inbound message. */
export type ClosingKind = (typeof CLOSING_KINDS)[number];

// Everything this daemon writes today. The log is append-only and open: the
// `append` subcommand exists so a script can add a kind nobody has thought of
// yet, and an unknown kind is data, not an error. So the union names what we
// know and `AnyEventKind` is what the column actually accepts.
export const EVENT_KINDS = [
  'inbound',
  'turn_start',
  'turn_result',
  'turn_fail',
  'command',
  'flush_word',
  'skipped',
  'session_reset',
  'snapshot',
  'runner_start',
  'runner_stop',
  'model_fallback',
  'wake_posted',
  'wake_enqueued',
  'wake_done',
  'wake_fail',
] as const;
/** A kind this file knows about by name. */
export type EventKind = (typeof EVENT_KINDS)[number];
/** What may be written: a known kind, or any other string a caller invents. */
export type AnyEventKind = EventKind | (string & {});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  v         INTEGER NOT NULL DEFAULT 1,
  kind      TEXT    NOT NULL,
  convo     TEXT,
  msg_id    INTEGER,
  update_id INTEGER,
  actor     TEXT    NOT NULL,
  payload   TEXT
);
CREATE INDEX IF NOT EXISTS events_convo ON events (convo, seq);
CREATE INDEX IF NOT EXISTS events_msg ON events (convo, msg_id);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, seq);
`;

export class EventsError extends Error {}

/** The open log handle. */
export type EventsDb = DatabaseSync;

/** A payload is whatever JSON the writer handed over — including nothing. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const isJsonObject = (v: JsonValue | null | undefined): v is { [key: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/** One field of a payload, for the projections that read into it. */
const field = (payload: JsonValue | null, key: string): JsonValue | undefined =>
  isJsonObject(payload) ? payload[key] : undefined;

/** One row of the log, decoded: the column names in their camelCase spelling. */
export interface EventRecord {
  seq: number;
  at: number;
  v: number;
  kind: string;
  convo: string | null;
  msgId: number | null;
  updateId: number | null;
  actor: string;
  payload: JsonValue | null;
}

/** An inbound message nothing ever closed, as the recovery pass reads it. */
export interface OrphanedInbound {
  seq: number;
  at: number;
  convo: string | null;
  msgId: number | null;
  updateId: number | null;
  message: JsonValue | null;
}

/** Per-topic Claude sessions, exactly as the runner writes them back. */
export type SessionMap = { [convo: string]: JsonValue };

export interface Snapshot {
  seq: number;
  offset: number;
  sessions: SessionMap;
}

/** What `sessions` / `rebuild` derive: the daemon's whole persistent state. */
export interface ProjectedState {
  offset: number;
  sessions: SessionMap;
}

// The handle is the DatabaseSync itself — same shape as claims.ts `openDb`, so
// every helper below reads `(db, ...)` and callers can hold one connection for
// the life of the process.
export function openEvents(dbPath: string = DB_PATH): EventsDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Writers are parallel processes (the daemon, wake.sh, the CLI): wait for the
  // lock instead of failing with BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  // FULL, not NORMAL: this log exists so a message survives a power loss. A
  // fsync per inbound message is cheap next to a Claude turn.
  db.exec('PRAGMA synchronous = FULL');
  db.exec(SCHEMA);
  return db;
}

const INSERT = `INSERT INTO events (at, v, kind, convo, msg_id, update_id, actor, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const num = (v: number | string | null | undefined): number | null =>
  v === undefined || v === null ? null : Number(v);
const str = (v: string | number | null | undefined): string | null =>
  v === undefined || v === null ? null : String(v);
const enc = (p: JsonValue | undefined): string | null =>
  p === undefined || p === null ? null : JSON.stringify(p);

/** Everything about an event except its kind. */
export interface EventFields {
  convo?: string | null | undefined;
  msgId?: number | string | null | undefined;
  updateId?: number | string | null | undefined;
  payload?: JsonValue | undefined;
  actor?: string | undefined;
  at?: number | undefined;
  v?: number | undefined;
}

/**
 * One row for `recordMany`: the fields plus the kind they belong to. `kind` is
 * nullable because the column is NOT NULL and the batch must fail on a row
 * without one -- half a turn's messages closed and half re-queued is the bug
 * the single transaction exists to prevent, and this is how it is exercised.
 */
export interface EventInput extends EventFields {
  kind?: AnyEventKind | null | undefined;
}

function bind(kind: AnyEventKind | null | undefined, fields: EventFields = {}): SQLInputValue[] {
  const { convo, msgId, updateId, payload, actor, at, v } = fields;
  return [
    at ?? Date.now(),
    v ?? 1,
    kind ?? null, // NOT NULL in the schema: a bad row must fail, not be guessed
    str(convo),
    num(msgId),
    num(updateId),
    actor ?? 'cli',
    enc(payload),
  ];
}

export function record(db: EventsDb, kind: AnyEventKind, fields: EventFields = {}): number {
  return Number(db.prepare(INSERT).run(...bind(kind, fields)).lastInsertRowid);
}

// One transaction for a whole batch. Used for per-message turn results: a crash
// must never leave half of a turn's messages "open" and half closed, because
// the open half would be re-queued and answered twice.
export function recordMany(db: EventsDb, rows: readonly EventInput[]): number[] {
  if (!Array.isArray(rows)) throw new EventsError('recordMany expects an array of rows');
  if (!rows.length) return [];
  const stmt = db.prepare(INSERT);
  db.exec('BEGIN IMMEDIATE');
  try {
    const seqs = rows.map((r) => Number(stmt.run(...bind(r.kind, r)).lastInsertRowid));
    db.exec('COMMIT');
    return seqs;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

type SqlRow = Record<string, SQLOutputValue>;

const colNum = (v: SQLOutputValue | undefined): number =>
  typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
const colNumOrNull = (v: SQLOutputValue | undefined): number | null =>
  v === null || v === undefined ? null : colNum(v);
const colText = (v: SQLOutputValue | undefined): string => (typeof v === 'string' ? v : String(v ?? ''));
const colTextOrNull = (v: SQLOutputValue | undefined): string | null =>
  v === null || v === undefined ? null : colText(v);

function parsePayload(row: SqlRow): EventRecord {
  let payload: JsonValue | null = null;
  const raw = row['payload'];
  if (raw != null) {
    try {
      payload = JSON.parse(colText(raw));
    } catch {
      payload = { unparseable: colText(raw) };
    }
  }
  return {
    seq: colNum(row['seq']),
    at: colNum(row['at']),
    v: colNum(row['v']),
    kind: colText(row['kind']),
    convo: colTextOrNull(row['convo']),
    msgId: colNumOrNull(row['msg_id']),
    updateId: colNumOrNull(row['update_id']),
    actor: colText(row['actor']),
    payload,
  };
}

// Inbound messages nothing ever closed: the daemon died between "message on
// disk" and "message answered". `IS` (not `=`) so a NULL convo/msg_id compares
// null-safely instead of swallowing the row.
const ORPHANS_SQL = `
SELECT * FROM events e
 WHERE e.kind = 'inbound'
   AND NOT EXISTS (
         SELECT 1 FROM events c
          WHERE c.kind IN (${CLOSING_KINDS.map(() => '?').join(', ')})
            AND c.convo IS e.convo
            AND c.msg_id IS e.msg_id
            AND c.seq > e.seq)
 ORDER BY e.seq`;

export function orphanedInbound(db: EventsDb): OrphanedInbound[] {
  return db
    .prepare(ORPHANS_SQL)
    .all(...CLOSING_KINDS)
    .map((row) => {
      const e = parsePayload(row);
      return { seq: e.seq, at: e.at, convo: e.convo, msgId: e.msgId, updateId: e.updateId, message: e.payload };
    });
}

export function latestSnapshot(db: EventsDb): Snapshot | null {
  const row = db.prepare(`SELECT * FROM events WHERE kind = 'snapshot' ORDER BY seq DESC LIMIT 1`).get();
  if (!row) return null;
  const e = parsePayload(row);
  const offset = field(e.payload, 'offset');
  const sessions = field(e.payload, 'sessions');
  return {
    seq: e.seq,
    offset: typeof offset === 'number' ? offset : 0,
    sessions: isJsonObject(sessions) ? { ...sessions } : {},
  };
}

// Rebuild `{offset, sessions}` from the log: newest snapshot + everything after
// it. The runner decides AT WRITE TIME whether a transcript was kept (the
// generation check against a /reset that landed mid-turn) and puts the result
// in `payload.session`; this projection must not re-derive that logic, or the
// two would drift apart on exactly the case they disagree about.
export function projectSessions(db: EventsDb): ProjectedState {
  const snap = latestSnapshot(db);
  const sessions: SessionMap = { ...(snap?.sessions ?? {}) };
  const from = snap?.seq ?? 0;
  let offset = snap?.offset ?? 0;
  for (const row of db.prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq`).all(from)) {
    const e = parsePayload(row);
    if (e.kind === 'inbound' && e.updateId != null) offset = Math.max(offset, e.updateId);
    else if (e.kind === 'session_reset' && e.convo) delete sessions[e.convo];
    else if ((e.kind === 'turn_result' || e.kind === 'turn_fail') && e.convo) {
      const s = field(e.payload, 'session');
      if (s && typeof s === 'object') sessions[e.convo] = s;
    }
  }
  return { offset, sessions };
}

// Everything that ever touched message N — including the turn that swallowed it
// into a multi-message prompt, which carries no msg_id of its own but lists the
// ids it answered in payload.msg_ids.
const TRACE_SQL = `
SELECT * FROM events
 WHERE (msg_id = ? AND (? IS NULL OR convo = ?))
    OR (kind = 'turn_start'
        AND (? IS NULL OR convo = ?)
        AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(payload, '$.msg_ids'), '[]'))
                     WHERE value = ?))
 ORDER BY seq`;

export function trace(db: EventsDb, msgId: number | string, convo: string | null = null): EventRecord[] {
  const id = Number(msgId);
  const c = convo ?? null;
  return db.prepare(TRACE_SQL).all(id, c, c, c, c, id).map(parsePayload);
}

export function tail(
  db: EventsDb,
  { n = 50, convo = null, kind = null }: { n?: number | string; convo?: string | null; kind?: string | null } = {}
): EventRecord[] {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (convo) {
    where.push('convo = ?');
    args.push(convo);
  }
  if (kind) {
    where.push('kind = ?');
    args.push(kind);
  }
  const sql =
    `SELECT * FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, Math.max(1, Number(n) || 50))
    .map(parsePayload)
    .reverse();
}

// -------------------------------------------------------------------- CLI ---

const USAGE = `events.mjs — the orchestrator's durable event log (exit 0 ok, 1 error, 2 usage)

  tail [N] [--convo K] [--kind K]      last N events (default 50)
  trace <msg_id> [--convo K]           everything that touched that message
  orphans                              inbound messages nothing ever closed
  sessions                             {offset, sessions} projected from the log
  rebuild [--write] [--force]          derive state.json; --write replaces it
  snapshot                             record a snapshot event from state.json
  append <kind> [--convo K] [--msg-id N] [--update-id N] [--json '{...}'] [--actor NAME]

  --json                               raw JSON lines instead of columns

Closing kinds (what accounts for an inbound message): ${CLOSING_KINDS.join(', ')}
DB: ${DB_PATH}`;

const short = (payload: JsonValue | null, width = 110): string => {
  if (payload == null) return '';
  const s = JSON.stringify(payload).replace(/\s+/g, ' ');
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
};

function print(rows: readonly EventRecord[], asJson: boolean): void {
  for (const e of rows) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify(e)}\n`);
      continue;
    }
    process.stdout.write(
      [
        String(e.seq).padStart(6),
        iso(e.at),
        e.kind.padEnd(14),
        (e.convo ?? '-').padEnd(16),
        String(e.msgId ?? '-').padStart(8),
        short(e.payload),
      ].join('  ') + '\n'
    );
  }
}

function readState(): { [key: string]: JsonValue } {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    throw new EventsError(`cannot read ${STATE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isJsonObject(parsed)) throw new EventsError(`cannot read ${STATE_FILE}: not a JSON object`);
  return parsed;
}

function runnerPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos.shift();
  const asJson = Boolean(opts['json'] === true);
  const convo = typeof opts['convo'] === 'string' ? opts['convo'] : null;
  const out = (obj: object) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

  switch (cmd) {
    case 'tail': {
      const db = openEvents();
      print(
        tail(db, { n: pos[0] ?? 50, convo, kind: typeof opts['kind'] === 'string' ? opts['kind'] : null }),
        asJson
      );
      return EXIT.OK;
    }
    case 'trace': {
      if (pos[0] === undefined) throw new EventsError('trace needs a <msg_id>');
      print(trace(openEvents(), pos[0], convo), asJson);
      return EXIT.OK;
    }
    case 'orphans': {
      const rows = orphanedInbound(openEvents());
      if (asJson) {
        for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
        return EXIT.OK;
      }
      for (const r of rows) {
        process.stdout.write(
          [String(r.seq).padStart(6), iso(r.at), (r.convo ?? '-').padEnd(16), String(r.msgId ?? '-').padStart(8), short(r.message)].join('  ') + '\n'
        );
      }
      if (!rows.length) process.stderr.write('no orphaned inbound messages\n');
      return EXIT.OK;
    }
    case 'sessions': {
      out(projectSessions(openEvents()));
      return EXIT.OK;
    }
    case 'rebuild': {
      const derived = projectSessions(openEvents());
      out(derived);
      if (opts['write'] !== true) return EXIT.OK;
      // The daemon holds state in memory and rewrites state.json on its next
      // save, so writing under a live runner is worse than useless: it looks
      // like it worked and is silently reverted a minute later.
      const pid = runnerPid();
      if (pid && opts['force'] !== true) {
        process.stderr.write(
          `refusing to write ${STATE_FILE}: runner pid ${pid} is alive and would overwrite it.\n` +
            `Stop the daemon first, or pass --force if you know what you are doing.\n`
        );
        return EXIT.ERROR;
      }
      writeAtomic(STATE_FILE, JSON.stringify(derived));
      process.stderr.write(`wrote ${STATE_FILE}\n`);
      return EXIT.OK;
    }
    case 'snapshot': {
      const state = readState();
      const payload = { offset: state['offset'] ?? 0, sessions: state['sessions'] ?? {} };
      const seq = record(openEvents(), 'snapshot', { payload, actor: 'cli' });
      out({ ok: true, seq, ...payload });
      return EXIT.OK;
    }
    case 'append': {
      const kind = pos[0];
      if (!kind) throw new EventsError('append needs a <kind>');
      let payload: JsonValue | undefined = undefined;
      if (typeof opts['json'] === 'string') {
        try {
          payload = JSON.parse(opts['json']);
        } catch (e) {
          throw new EventsError(`bad --json: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const msgId = opts['msg-id'];
      const updateId = opts['update-id'];
      const seq = record(openEvents(), kind, {
        convo,
        msgId: msgId === undefined || msgId === true ? null : Number(msgId),
        updateId: updateId === undefined || updateId === true ? null : Number(updateId),
        payload,
        actor: typeof opts['actor'] === 'string' ? opts['actor'] : 'cli',
      });
      out({ ok: true, seq, kind });
      return EXIT.OK;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`);
      return EXIT.OK;
    default:
      process.stderr.write(`unknown command '${cmd}'\n${USAGE}\n`);
      return EXIT.USAGE;
  }
}

/**
 * The one funnel: every failure leaves on stderr with EXIT.ERROR, every command
 * chooses between OK and USAGE itself. Nothing else sets an exit code.
 */
export function runCli(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    return main(argv);
  } catch (e) {
    process.stderr.write(
      `${e instanceof EventsError ? e.message : e instanceof Error ? (e.stack ?? String(e)) : String(e)}\n`
    );
    return EXIT.ERROR;
  }
}
