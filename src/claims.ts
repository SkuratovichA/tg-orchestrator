// claims.ts — shared registry of "who is handling which Telegram message / chat".
//
// Why: on 03.09.2026 two agents answered the same voice note in the same DM two
// minutes apart. A detached watcher was sitting on the chat; the orchestrator did
// not know and wrote there directly. This file is the arbiter both consult
// BEFORE writing into a chat:
//
//   message claim  (chat_id, message_id) — taken atomically by exactly one owner.
//   chat lease     (chat_id, thread_id)  — "agent X owns this chat until T". Carries
//                  the owner's pid: a dead owner's lease counts as expired, and an
//                  expired lease can be taken over.
//   ask / inbox    the "бро, ты отвечаешь по ним?" channel — a thin wrapper over
//                  claude-coop's coop.sh mailboxes (one mailbox per owner
//                  name, unread-only reads, cursor-based, locked). Detached agents
//                  have no other inbound channel.
//
// Storage: SQLite via node:sqlite (WAL) at ~/.config/claude-agents/claims.sqlite.
// Atomicity: every decision runs inside BEGIN IMMEDIATE, i.e. under SQLite's
// cross-process write lock; the losing side gets the current owner, not an error.
// Usable as a library (import) and as a CLI (JSON on stdout) — src/claims.mjs is
// the file the world runs and imports, and it is a shim over this one.
//
// Exit codes: 0 = acquired / free / delivered, 3 = busy or not yours, 1 = error.
//
// Env overrides: CLAIMS_DB (db file), CLAIMS_COOP (coop.sh path), COOP_ROOT
// (coop data dir; passed through to coop.sh).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { match } from 'ts-pattern';

// node:sqlite is still flagged experimental in node 22; the warning would land in
// every agent's transcript. Keep every other warning.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.error(w.stack ?? String(w));
});

/** The open registry handle. `null` everywhere means "no registry configured". */
export type ClaimsDb = DatabaseSync;

export const DB_PATH =
  process.env.CLAIMS_DB || path.join(os.homedir(), '.config', 'claude-agents', 'claims.sqlite');
// coop.sh (claude-coop cross-session mailboxes): CLAIMS_COOP points at it;
// otherwise the first usual checkout location that exists, else the first
// candidate so an error names a concrete path.
const coopCandidate = (dir: string) => path.join(os.homedir(), dir, 'coop.sh');
const COOP_CANDIDATES: [string, ...string[]] = [
  coopCandidate('git/work/claude-coop'),
  coopCandidate('git/claude-coop'),
  coopCandidate('claude-coop'),
];
export const COOP_SH =
  process.env.CLAIMS_COOP || COOP_CANDIDATES.find((p) => existsSync(p)) || COOP_CANDIDATES[0];
const COOP_ROOT = process.env.COOP_ROOT || path.dirname(COOP_SH);

export const EXIT = { OK: 0, ERROR: 1, BUSY: 3 } as const;
export const DEFAULT_TTL_MS = 2 * 3600 * 1000;

// Same rule as coop.sh, so every owner name is also a valid coop mailbox.
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DAY_MS = 24 * 3600 * 1000;
const RELEASED_KEEP_MS = DAY_MS; // released rows are pruned after a day
const HELD_CLAIM_KEEP_MS = 7 * DAY_MS; // a held claim nobody ever released: a week

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message_claims (
  chat_id     INTEGER NOT NULL,
  message_id  INTEGER NOT NULL,
  owner       TEXT    NOT NULL,
  pid         INTEGER,
  status      TEXT    NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'done', 'dropped')),
  note        TEXT,
  claimed_at  INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_claims_owner ON message_claims (owner, status);

CREATE TABLE IF NOT EXISTS chat_leases (
  chat_id     INTEGER NOT NULL,
  thread_id   INTEGER NOT NULL DEFAULT 0,
  owner       TEXT    NOT NULL,
  pid         INTEGER,
  inbox       TEXT,
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'done', 'dropped')),
  leased_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (chat_id, thread_id)
) WITHOUT ROWID;
`;

// ----------------------------------------------------------------- types ---

/** A claim or a lease as the DDL spells it. */
export type RowStatus = 'held' | 'done' | 'dropped';
/** What a release may set — a claim is either answered or abandoned. */
export type ReleaseStatus = Extract<RowStatus, 'done' | 'dropped'>;

/** The columns every "who holds this claim" read asks for. */
export interface ClaimFacts {
  owner: string;
  pid: number | null;
  status: string;
  note: string | null;
  claimed_at: number;
  released_at: number | null;
}

export interface ClaimRow extends ClaimFacts {
  chat_id: number;
  message_id: number;
}

export interface LeaseRow {
  chat_id: number;
  thread_id: number;
  owner: string;
  pid: number | null;
  inbox: string | null;
  note: string | null;
  status: string;
  leased_at: number;
  expires_at: number;
  released_at: number | null;
}

export interface ClaimAcquired {
  message_id: number;
  /** We already held it — possibly from a previous incarnation (see `pid`). */
  already_mine?: boolean;
  took_over_dropped?: boolean | undefined;
  pid?: number | null;
  alive?: boolean | null;
  since?: string | null;
}

export interface ClaimBusy {
  message_id: number;
  owner: string;
  pid: number | null;
  alive: boolean | null;
  status: string;
  note: string | null;
  since: string | null;
  age: string;
}

interface ClaimBody {
  chat_id: number;
  owner: string;
  acquired: ClaimAcquired[];
  busy: ClaimBusy[];
}
/** Tagged by `ok`: false means at least one message belongs to somebody else. */
export type ClaimResult = ({ ok: true } & ClaimBody) | ({ ok: false } & ClaimBody);

export interface ReleaseResult {
  ok: boolean;
  chat_id: number;
  owner: string;
  released: Array<{ message_id: number; status: ReleaseStatus }>;
  refused: Array<{ message_id: number; owner: string | null; reason: string }>;
}

export interface AnnotateResult {
  ok: boolean;
  chat_id: number;
  owner: string;
  note: string;
  at: string | null;
  updated: number[];
  skipped: number[];
}

/** What a lease row means right now, before it is dressed up for a caller. */
export type LeaseState =
  | { state: 'free'; reason: string }
  | { state: 'held'; reason: null; alive: boolean | null };

interface LeaseFacts {
  pid: number | null;
  alive: boolean | null;
  inbox: string | null;
  note: string | null;
  status: string;
  leased_at: string | null;
  age: string;
  expires_at: string | null;
  expires_in: string;
  released_at: string | null;
}

/**
 * A lease rendered for a caller. Tagged by `state`; the "no lease at all" case
 * is the short member — there is no row to describe, so there are no facts.
 */
export type LeaseView =
  | { state: 'free'; reason: string; owner: null }
  | ({ state: 'free' | 'held'; reason: string | null; owner: string } & LeaseFacts);

/** Which lease answered the question: the exact topic, or the whole chat. */
export interface LeaseScope {
  chat_id: number;
  thread_id: number;
  scope: 'thread' | 'chat';
}

/** `owner <chat_id>`: tagged by `state` — 'free' means you may take the chat. */
export type OwnerVerdict = { ok: boolean } & LeaseView & LeaseScope;

interface LeaseAddress {
  chat_id: number;
  thread_id: number;
}
/**
 * `lease <chat_id>`: tagged by `acquired`. A refusal describes the LIVE holder,
 * an acquisition describes the lease as it now stands plus how it was obtained.
 */
export type LeaseResult =
  | ({ ok: false; acquired: false } & LeaseAddress & LeaseView)
  | ({
      ok: true;
      acquired: true;
      renewed: boolean;
      took_over_from: { owner: string; reason: string } | null;
    } & LeaseAddress &
      LeaseView);

export interface UnleaseResult {
  ok: boolean;
  released: boolean;
  chat_id: number;
  thread_id: number;
  owner: string;
  reason?: string;
  current?: LeaseView | null;
}

export interface StatusClaim {
  chat_id: number;
  message_id: number;
  owner: string;
  pid: number | null;
  alive: boolean | null;
  note: string | null;
  claimed_at: string | null;
  age: string;
}

export interface StatusResult {
  ok: true;
  now: string | null;
  db: string;
  claims: StatusClaim[];
  leases: Array<LeaseAddress & LeaseView>;
}

export interface AskResult {
  ok: boolean;
  delivered: boolean;
  chat_id?: number;
  thread_id?: number;
  owner?: OwnerVerdict | { state: 'held'; owner: string };
  hint?: string;
  to?: string;
  inbox?: string;
  seq?: number | null;
  coop?: string | undefined;
}

export interface InboxHeader {
  seq: number;
  from: string;
  to: string;
  at: string;
  subject: string;
}

export interface InboxMessage extends InboxHeader {
  text: string;
  chat_id?: number;
  thread_id?: number;
}

export interface InboxResult {
  ok: true;
  owner: string;
  messages: InboxMessage[];
  general: InboxMessage[];
  pending: InboxHeader[];
  more: number;
}

// ---------------------------------------------------------------- helpers ---

export class ClaimsError extends Error {}

function checkName(name: string | true | undefined, what = 'owner'): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ClaimsError(
      `${what} must match ${NAME_RE} (lowercase letters, digits, - and _), got '${String(name)}'`,
    );
  }
  return name;
}

const TTL_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS } as const;
type TtlUnit = keyof typeof TTL_UNITS;
const isTtlUnit = (v: string): v is TtlUnit => v in TTL_UNITS;

export function parseTtl(v: string | true | undefined | null, fallback = DEFAULT_TTL_MS): number {
  if (v === undefined || v === null || v === '') return fallback;
  const m = String(v)
    .trim()
    .match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  const unitName = m?.[2] ?? 's';
  if (!m || !isTtlUnit(unitName)) throw new ClaimsError(`bad ttl '${String(v)}' — use 90s, 30m, 2h, 1d`);
  const n = Number(m[1]);
  const unit = TTL_UNITS[unitName];
  if (n <= 0) throw new ClaimsError('ttl must be positive');
  return n * unit;
}

export function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

// Compact "how long": 12s, 5m, 2h10m, 3d4h. Negative input → "0s".
export function human(input: number): string {
  const ms = Math.max(0, Math.round(input));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
}

/** The `code` of a thrown system error, when it has one. */
function errorCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string') return e.code;
  return null;
}
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// true = alive, false = dead, null = unknown (no pid recorded).
export function pidAlive(pid: number | null | undefined): boolean | null {
  if (!Number.isInteger(pid) || pid == null || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === 'EPERM'; // exists but not ours — still alive
  }
}

function psLine(pid: number): { ppid: number; command: string } | null {
  const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/^(\d+)\s+([\s\S]*)$/);
  return m ? { ppid: Number(m[1]), command: m[2] ?? '' } : null;
}

// The CLI is a short-lived child of the agent's shell, so its own pid is useless.
// The pid worth recording is the nearest `claude` ancestor — the agent itself.
// Non-claude callers (daemons) pass --pid explicitly; with nothing found the pid
// stays null and liveness falls back to the TTL alone.
export function resolveAgentPid(explicit?: string | number | boolean | null): number | null {
  if (explicit !== undefined && explicit !== null && explicit !== true) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n < 0) throw new ClaimsError(`bad --pid '${String(explicit)}'`);
    return n === 0 ? null : n;
  }
  let pid = process.ppid;
  for (let i = 0; i < 15 && pid > 1; i++) {
    const info = psLine(pid);
    if (!info) return null;
    if (/^(\S*\/)?claude(\s|$)/.test(info.command)) return pid;
    pid = info.ppid;
  }
  return null;
}

function tx<T>(db: ClaimsDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

// --------------------------------------------------------------- row reads ---
// node:sqlite hands back `Record<string, SQLOutputValue>`; these turn one such
// bag into the row the DDL describes. Nothing here may invent a value: a column
// the schema declares NOT NULL is read as its type, a nullable one as `| null`.

type SqlRow = Record<string, SQLOutputValue>;

const colNum = (v: SQLOutputValue | undefined): number =>
  typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
const colNumOrNull = (v: SQLOutputValue | undefined): number | null =>
  v === null || v === undefined ? null : colNum(v);
const colText = (v: SQLOutputValue | undefined): string => (typeof v === 'string' ? v : String(v ?? ''));
const colTextOrNull = (v: SQLOutputValue | undefined): string | null =>
  v === null || v === undefined ? null : colText(v);

function toClaimFacts(r: SqlRow): ClaimFacts {
  return {
    owner: colText(r['owner']),
    pid: colNumOrNull(r['pid']),
    status: colText(r['status']),
    note: colTextOrNull(r['note']),
    claimed_at: colNum(r['claimed_at']),
    released_at: colNumOrNull(r['released_at']),
  };
}

const toClaimRow = (r: SqlRow): ClaimRow => ({
  ...toClaimFacts(r),
  chat_id: colNum(r['chat_id']),
  message_id: colNum(r['message_id']),
});

function toLeaseRow(r: SqlRow): LeaseRow {
  return {
    chat_id: colNum(r['chat_id']),
    thread_id: colNum(r['thread_id']),
    owner: colText(r['owner']),
    pid: colNumOrNull(r['pid']),
    inbox: colTextOrNull(r['inbox']),
    note: colTextOrNull(r['note']),
    status: colText(r['status']),
    leased_at: colNum(r['leased_at']),
    expires_at: colNum(r['expires_at']),
    released_at: colNumOrNull(r['released_at']),
  };
}

const optional = <T>(r: SqlRow | undefined, to: (row: SqlRow) => T): T | null => (r ? to(r) : null);

// --------------------------------------------------------------------- db ---

export function openDb(file: string = DB_PATH): ClaimsDb {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // Writers are parallel processes: wait for the lock instead of failing with BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  prune(db);
  return db;
}

export function prune(db: ClaimsDb, now = Date.now()): { claims: number; leases: number } {
  const a = db
    .prepare(
      `DELETE FROM message_claims
        WHERE (released_at IS NOT NULL AND released_at < ?)
           OR (status = 'held' AND claimed_at < ?)`,
    )
    .run(now - RELEASED_KEEP_MS, now - HELD_CLAIM_KEEP_MS);
  const b = db
    .prepare(
      `DELETE FROM chat_leases
        WHERE (released_at IS NOT NULL AND released_at < ?)
           OR (status = 'held' AND expires_at < ?)`,
    )
    .run(now - RELEASED_KEEP_MS, now - RELEASED_KEEP_MS);
  return { claims: Number(a.changes), leases: Number(b.changes) };
}

// ------------------------------------------------------------ message claims ---

export interface ClaimOptions {
  chatId: number;
  messageIds: readonly number[];
  owner: string;
  pid?: number | null;
  note?: string | null;
  now?: number;
}

// Take (chat_id, message_id) for `owner`. Exactly one caller wins per message:
// the whole batch runs under BEGIN IMMEDIATE (SQLite's cross-process write lock),
// and the INSERT itself only overwrites a row whose status is 'dropped'. A 'done'
// claim stays done — the message was already answered, nobody answers it twice.
export function claimMessages(
  db: ClaimsDb,
  { chatId, messageIds, owner, pid = null, note = null, now = Date.now() }: ClaimOptions
): ClaimResult {
  checkName(owner);
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new ClaimsError('at least one message_id is required');
  }
  const upsert = db.prepare(
    `INSERT INTO message_claims (chat_id, message_id, owner, pid, status, note, claimed_at, released_at)
     VALUES (?, ?, ?, ?, 'held', ?, ?, NULL)
     ON CONFLICT (chat_id, message_id) DO UPDATE SET
       owner = excluded.owner, pid = excluded.pid, note = excluded.note,
       claimed_at = excluded.claimed_at, released_at = NULL, status = 'held'
     WHERE message_claims.status = 'dropped'
     RETURNING owner`,
  );
  const current = db.prepare(
    `SELECT owner, pid, status, note, claimed_at, released_at
       FROM message_claims WHERE chat_id = ? AND message_id = ?`,
  );
  return tx(db, () => {
    const acquired: ClaimAcquired[] = [];
    const busy: ClaimBusy[] = [];
    for (const messageId of messageIds) {
      const row = optional(current.get(chatId, messageId), toClaimFacts);
      if (row && row.status === 'held' && row.owner === owner) {
        // Same owner name, but maybe not the same process: a daemon restarted
        // mid-turn re-claims under its old name, so report the holder's pid.
        acquired.push({
          message_id: messageId,
          already_mine: true,
          pid: row.pid,
          alive: pidAlive(row.pid),
          since: iso(row.claimed_at),
        });
        continue;
      }
      if (upsert.get(chatId, messageId, owner, pid, note, now)) {
        acquired.push({ message_id: messageId, took_over_dropped: Boolean(row) || undefined });
        continue;
      }
      if (!row) throw new ClaimsError(`claim on ${chatId}/${messageId} was refused with no row to explain it`);
      busy.push({
        message_id: messageId,
        owner: row.owner,
        pid: row.pid,
        alive: pidAlive(row.pid),
        status: row.status,
        note: row.note,
        since: iso(row.claimed_at),
        age: human(now - row.claimed_at),
      });
    }
    const body: ClaimBody = { chat_id: chatId, owner, acquired, busy };
    return busy.length === 0 ? { ok: true, ...body } : { ok: false, ...body };
  });
}

export interface ReleaseOptions {
  chatId: number;
  messageIds: readonly number[];
  owner: string;
  status?: ReleaseStatus;
  note?: string | null | undefined;
  now?: number;
}

export function releaseMessages(
  db: ClaimsDb,
  { chatId, messageIds, owner, status = 'done', note = undefined, now = Date.now() }: ReleaseOptions
): ReleaseResult {
  checkName(owner);
  if (!['done', 'dropped'].includes(status)) throw new ClaimsError(`status must be done|dropped, got '${status}'`);
  // `note` is optional: undefined keeps whatever the claim said, a string
  // (or null) replaces it — so a release can record HOW the message ended.
  const upd = db.prepare(
    `UPDATE message_claims SET status = ?, released_at = ?, note = COALESCE(?, note)
      WHERE chat_id = ? AND message_id = ? AND owner = ? AND status = 'held'`,
  );
  const current = db.prepare(`SELECT owner, status FROM message_claims WHERE chat_id = ? AND message_id = ?`);
  return tx(db, () => {
    const released: ReleaseResult['released'] = [];
    const refused: ReleaseResult['refused'] = [];
    for (const messageId of messageIds) {
      if (Number(upd.run(status, now, note ?? null, chatId, messageId, owner).changes) === 1) {
        released.push({ message_id: messageId, status });
        continue;
      }
      const row = current.get(chatId, messageId);
      const rowOwner = row ? colText(row['owner']) : null;
      refused.push({
        message_id: messageId,
        owner: rowOwner,
        reason: !row
          ? 'not claimed'
          : rowOwner !== owner
            ? `held by ${rowOwner}`
            : `already ${colText(row['status'])}`,
      });
    }
    return { ok: refused.length === 0, chat_id: chatId, owner, released, refused };
  });
}

// Change the note on claims `owner` still holds — the message's progress
// ("read" -> "in-turn") without touching who owns it. Rows that are not held
// by `owner` are reported back, never modified.
export function annotateMessages(
  db: ClaimsDb,
  {
    chatId,
    messageIds,
    owner,
    note,
    now = Date.now(),
  }: { chatId: number; messageIds: readonly number[]; owner: string; note: string; now?: number }
): AnnotateResult {
  checkName(owner);
  const upd = db.prepare(
    `UPDATE message_claims SET note = ?
      WHERE chat_id = ? AND message_id = ? AND owner = ? AND status = 'held'`,
  );
  return tx(db, () => {
    const updated: number[] = [];
    const skipped: number[] = [];
    for (const messageId of messageIds) {
      if (Number(upd.run(note, chatId, messageId, owner).changes) === 1) updated.push(messageId);
      else skipped.push(messageId);
    }
    return { ok: skipped.length === 0, chat_id: chatId, owner, note, at: iso(now), updated, skipped };
  });
}

// --------------------------------------------------------------- chat leases ---

// What a lease row means right now. 'held' only when status is held, the TTL
// has not passed AND the owner's process is not known to be dead.
export function leaseState(row: LeaseRow | null | undefined, now = Date.now()): LeaseState {
  if (!row) return { state: 'free', reason: 'no lease' };
  if (row.status !== 'held') return { state: 'free', reason: `released (${row.status})` };
  if (row.expires_at <= now) return { state: 'free', reason: 'ttl expired' };
  const alive = pidAlive(row.pid);
  if (alive === false) return { state: 'free', reason: 'owner process dead' };
  return { state: 'held', reason: null, alive };
}

function describeLease(row: LeaseRow | null, now: number): LeaseView {
  if (!row) return { state: 'free', reason: 'no lease', owner: null };
  const st = leaseState(row, now);
  return {
    state: st.state,
    reason: st.reason,
    owner: row.owner,
    pid: row.pid,
    alive: st.state === 'held' ? (st.alive ?? pidAlive(row.pid)) : pidAlive(row.pid),
    inbox: row.inbox,
    note: row.note,
    status: row.status,
    leased_at: iso(row.leased_at),
    age: human(now - row.leased_at),
    expires_at: iso(row.expires_at),
    expires_in: row.expires_at > now ? human(row.expires_at - now) : 'expired',
    released_at: iso(row.released_at),
  };
}

const SELECT_LEASE = `SELECT * FROM chat_leases WHERE chat_id = ? AND thread_id = ?`;

const readLease = (db: ClaimsDb, chatId: number, threadId: number): LeaseRow | null =>
  optional(db.prepare(SELECT_LEASE).get(chatId, threadId), toLeaseRow);

/**
 * What `leaseChat` is about to do, decided before anything is written: refuse
 * (somebody else is alive on it), renew (ours and still live) or take it over.
 */
type LeaseDecision =
  | { kind: 'refuse'; row: LeaseRow }
  | { kind: 'renew' }
  | { kind: 'take'; from: { owner: string; reason: string } | null };

function decideLease(row: LeaseRow | null, st: LeaseState, owner: string): LeaseDecision {
  if (!row) return { kind: 'take', from: null };
  if (st.state === 'held') return row.owner === owner ? { kind: 'renew' } : { kind: 'refuse', row };
  return { kind: 'take', from: row.owner === owner ? null : { owner: row.owner, reason: st.reason } };
}

export interface LeaseOptions {
  chatId: number;
  threadId?: number;
  owner: string;
  pid?: number | null;
  ttlMs?: number;
  inbox?: string | null;
  note?: string | null;
  now?: number;
}

// Take or renew the lease on (chat_id, thread_id). Same owner → renew (TTL, pid,
// inbox refreshed). Free / expired / dead-owner lease → take over. Live lease of
// someone else → refused, with the holder's details so the caller can `ask`.
export function leaseChat(
  db: ClaimsDb,
  {
    chatId,
    threadId = 0,
    owner,
    pid = null,
    ttlMs = DEFAULT_TTL_MS,
    inbox = null,
    note = null,
    now = Date.now(),
  }: LeaseOptions
): LeaseResult {
  checkName(owner);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new ClaimsError('ttlMs must be a positive integer');
  const mailbox = inbox ?? `coop:${owner}`;
  const expiresAt = now + ttlMs;
  return tx(db, () => {
    const row = readLease(db, chatId, threadId);
    const decision = decideLease(row, leaseState(row, now), owner);
    // The write, then the row as it now stands: `describeLease(fresh)` is what
    // the caller sees, so a renewal and a takeover report identically.
    const acquire = (renewed: boolean, from: { owner: string; reason: string } | null): LeaseResult => {
      const fresh = readLease(db, chatId, threadId);
      return {
        ok: true,
        acquired: true,
        renewed,
        took_over_from: from,
        chat_id: chatId,
        thread_id: threadId,
        ...describeLease(fresh, now),
      };
    };
    return match(decision)
      .with({ kind: 'refuse' }, ({ row: held }) => ({
        ok: false as const,
        acquired: false as const,
        chat_id: chatId,
        thread_id: threadId,
        ...describeLease(held, now),
      }))
      .with({ kind: 'renew' }, () => {
        db.prepare(
          `UPDATE chat_leases SET pid = ?, inbox = ?, note = COALESCE(?, note), expires_at = ?
            WHERE chat_id = ? AND thread_id = ?`,
        ).run(pid, mailbox, note, expiresAt, chatId, threadId);
        return acquire(true, null);
      })
      .with({ kind: 'take' }, ({ from }) => {
        db.prepare(
          `INSERT OR REPLACE INTO chat_leases
             (chat_id, thread_id, owner, pid, inbox, note, status, leased_at, expires_at, released_at)
           VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, NULL)`,
        ).run(chatId, threadId, owner, pid, mailbox, note, now, expiresAt);
        return acquire(false, from);
      })
      .exhaustive();
  });
}

export function unleaseChat(
  db: ClaimsDb,
  {
    chatId,
    threadId = 0,
    owner,
    status = 'done',
    now = Date.now(),
  }: { chatId: number; threadId?: number; owner: string; status?: ReleaseStatus; now?: number }
): UnleaseResult {
  checkName(owner);
  return tx(db, () => {
    const r = db
      .prepare(
        `UPDATE chat_leases SET status = ?, released_at = ?
          WHERE chat_id = ? AND thread_id = ? AND owner = ? AND status = 'held'`,
      )
      .run(status, now, chatId, threadId, owner);
    if (Number(r.changes) === 1) return { ok: true, released: true, chat_id: chatId, thread_id: threadId, owner };
    const row = readLease(db, chatId, threadId);
    return {
      ok: false,
      released: false,
      chat_id: chatId,
      thread_id: threadId,
      owner,
      reason: !row ? 'no lease' : row.owner !== owner ? `held by ${row.owner}` : `already ${row.status}`,
      current: row ? describeLease(row, now) : null,
    };
  });
}

// Who holds the chat right now. For a forum topic the exact (chat, thread) lease
// wins; if that is free, a live whole-chat lease (thread 0) is reported with
// scope 'chat' so the caller still knows somebody sits on the chat.
export function chatOwner(
  db: ClaimsDb,
  { chatId, threadId = 0, now = Date.now() }: { chatId: number; threadId?: number; now?: number }
): OwnerVerdict {
  const base = { chat_id: chatId, thread_id: threadId };
  const exactView: LeaseView & LeaseScope = {
    ...describeLease(readLease(db, chatId, threadId), now),
    ...base,
    scope: 'thread',
  };
  return match(exactView)
    .with({ state: 'held' }, (held) => ({ ok: false, ...held }))
    .otherwise((free) => {
      if (threadId === 0) return { ok: true, ...free };
      const whole: LeaseView & LeaseScope = {
        ...describeLease(readLease(db, chatId, 0), now),
        ...base,
        scope: 'chat',
      };
      if (whole.state === 'held') return { ok: false, ...whole };
      return { ok: true, ...free };
    });
}

export function status(
  db: ClaimsDb,
  { chatId = null, now = Date.now() }: { chatId?: number | null; now?: number } = {}
): StatusResult {
  const where = chatId == null ? '' : ' AND chat_id = ?';
  const args: number[] = chatId == null ? [] : [chatId];
  const claims = db
    .prepare(`SELECT * FROM message_claims WHERE status = 'held'${where} ORDER BY claimed_at DESC`)
    .all(...args)
    .map(toClaimRow)
    .map((r) => ({
      chat_id: r.chat_id,
      message_id: r.message_id,
      owner: r.owner,
      pid: r.pid,
      alive: pidAlive(r.pid),
      note: r.note,
      claimed_at: iso(r.claimed_at),
      age: human(now - r.claimed_at),
    }));
  const leases = db
    .prepare(`SELECT * FROM chat_leases WHERE 1 = 1${where} ORDER BY leased_at DESC`)
    .all(...args)
    .map(toLeaseRow)
    .map((r) => ({ chat_id: r.chat_id, thread_id: r.thread_id, ...describeLease(r, now) }));
  return { ok: true, now: iso(now), db: DB_PATH, claims, leases };
}

// ------------------------------------------------------------ coop channel ---

function coop(args: readonly string[]): string {
  if (!existsSync(COOP_SH)) {
    throw new ClaimsError(`coop.sh not found at ${COOP_SH} — set CLAIMS_COOP to your claude-coop checkout`);
  }
  const r = spawnSync('bash', [COOP_SH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COOP_ROOT },
  });
  if (r.status !== 0) {
    throw new ClaimsError(`coop.sh ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

// coop.sh insists both parties are registered (one mailbox per name). Register
// lazily and idempotently; the registry row is cheap and `leave` is optional.
export function ensureCoopJoined(name: string): boolean {
  checkName(name);
  const joined =
    existsSync(path.join(COOP_ROOT, 'cursors', name)) && existsSync(path.join(COOP_ROOT, 'mailbox', `${name}.md`));
  if (joined) return false;
  coop(['join', name, process.cwd(), 'telegram agent; reach it via claims.mjs ask <chat_id> --from <me> --text ...']);
  return true;
}

export function coopAvailable(): boolean {
  return existsSync(COOP_SH);
}

// "бро, ты отвечаешь по ним?" — drop a note into the chat owner's mailbox.
// Refuses when the chat has no live owner: then there is nobody to ask, claim
// the message and answer yourself.
export function askOwner(
  db: ClaimsDb,
  {
    chatId,
    threadId = 0,
    from,
    text,
    to = null,
    now = Date.now(),
  }: {
    chatId: number;
    threadId?: number;
    from: string;
    text: string;
    to?: string | true | null;
    now?: number;
  }
): AskResult {
  checkName(from, 'from');
  if (!text || !String(text).trim()) throw new ClaimsError('empty --text');
  const target: OwnerVerdict | { state: 'held'; owner: string } = to
    ? { state: 'held', owner: checkName(to, 'to') }
    : chatOwner(db, { chatId, threadId, now });
  if (target.state !== 'held') {
    return {
      ok: false,
      delivered: false,
      chat_id: chatId,
      thread_id: threadId,
      owner: target,
      hint: 'chat has no live owner — nobody to ask; claim the message and answer it yourself',
    };
  }
  if (target.owner === from) {
    return { ok: true, delivered: false, to: from, hint: 'you are the owner of this chat' };
  }
  ensureCoopJoined(from);
  const subject = `@${target.owner}: tg chat ${chatId}${threadId ? `/${threadId}` : ''}`;
  const out = coop(['ask', from, subject, String(text)]);
  const seq = out.match(/delivered \[m-(\d+)\]/);
  return {
    ok: true,
    delivered: true,
    to: target.owner,
    inbox: `coop:${target.owner}`,
    seq: seq ? Number(seq[1]) : null,
    coop: out.trim().split('\n')[0],
  };
}

const HEADER_RE = /^## \[m-(\d+)\] from (\S+) to (\S+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.*)$/;

export function parseInbox(out: string, owner: string): InboxResult {
  const res: InboxResult = { ok: true, owner, messages: [], general: [], pending: [], more: 0 };
  if (/^inbox empty/.test(out)) return res;
  let section: 'you' | 'general' | 'headers' | null = null;
  let cur: { header: InboxHeader; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const msg: InboxMessage = { ...cur.header, text: cur.lines.join('\n').trim() };
    const chat = msg.subject.match(/tg chat (-?\d+)(?:\/(\d+))?/);
    if (chat) {
      msg.chat_id = Number(chat[1]);
      msg.thread_id = chat[2] ? Number(chat[2]) : 0;
    }
    (section === 'general' ? res.general : res.messages).push(msg);
    cur = null;
  };
  for (const line of out.split('\n')) {
    if (line === '=== to you ===') {
      flush();
      section = 'you';
      continue;
    }
    if (line === '=== channel general ===') {
      flush();
      section = 'general';
      continue;
    }
    const more = line.match(/^--- (\d+) more unread/);
    if (more) {
      flush();
      section = 'headers';
      res.more = Number(more[1]);
      continue;
    }
    const h = line.match(HEADER_RE);
    if (h) {
      flush();
      const msg: InboxHeader = {
        seq: Number(h[1]),
        from: h[2] ?? '',
        to: h[3] ?? '',
        at: h[4] ?? '',
        subject: h[5] ?? '',
      };
      if (section === 'headers') res.pending.push(msg);
      else cur = { header: msg, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return res;
}

// Read and consume (mark read) the owner's mailbox. Bounded by coop: full bodies
// for the first few, the rest come back as `pending` headers — call again.
export function readInbox({ owner, peek = false }: { owner: string; peek?: boolean }): InboxResult {
  checkName(owner);
  ensureCoopJoined(owner);
  const out = coop(['inbox', owner, ...(peek ? ['--peek'] : [])]);
  return parseInbox(out, owner);
}

// -------------------------------------------------------------------- CLI ---

const USAGE = `claims.mjs — who is handling which Telegram message / chat (JSON out; exit 0 ok, 3 busy, 1 error)

  claim   <chat_id> <msg_id...> --owner NAME [--note TEXT] [--pid N]
  release <chat_id> <msg_id...> --owner NAME [--status done|dropped]
  lease   <chat_id> [--thread N] --owner NAME [--ttl 2h] [--inbox ID] [--note TEXT] [--pid N]
  unlease <chat_id> [--thread N] --owner NAME
  owner   <chat_id> [--thread N]              who holds it, is the process alive (exit 0 = free)
  status  [--chat ID]                         everything held, by whom, how long
  ask     <chat_id> [--thread N] --from NAME --text "..." [--to NAME]
  inbox   <coop:NAME | NAME | --owner NAME> [--peek]

Owner names: lowercase letters, digits, - and _ (they double as coop.sh mailboxes).
DB: ${DB_PATH}   coop: ${COOP_SH}`;

/** A flag with no value of its own is `true`; everything else is its string. */
export type CliOpts = Record<string, string | true>;

export function parseArgs(argv: readonly string[]): { pos: string[]; opts: CliOpts } {
  const pos: string[] = [];
  const opts: CliOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--') || a.length === 2) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !(next.startsWith('--') && next.length > 2)) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { pos, opts };
}

function out(obj: object): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * What one command produced. Everything the CLI can answer is either the USAGE
 * text or exactly one JSON document whose `ok` decides between 0 and 3 — which
 * is why the exit codes are chosen in ONE place (`runCli`) and nowhere else.
 */
type CommandOutcome = { kind: 'text'; text: string } | { kind: 'json'; value: { ok: boolean } };

const json = (value: { ok: boolean }): CommandOutcome => ({ kind: 'json', value });

/** The claim command's answer, plus the chat-lease warning the CLI adds to it. */
type ClaimCliResult = ClaimResult & {
  chat_owner?: { owner: string; alive: boolean | null; inbox: string | null; scope: 'thread' | 'chat' } | null;
  warning?: string;
};
type LeaseCliResult = LeaseResult & { coop_joined?: boolean; warning?: string; hint?: string };

export function main(argv: readonly string[] = process.argv.slice(2)): CommandOutcome {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos.shift();
  const need = (v: string | true | undefined, what: string): string => {
    if (v === undefined || v === true || v === '') throw new ClaimsError(`missing ${what}`);
    return v;
  };
  const int = (v: string | true, what: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new ClaimsError(`${what} must be an integer, got '${String(v)}'`);
    return n;
  };
  // A flag written without a value parses as `true`; for the two that end up in
  // a TEXT column that is not a value, it is a typo.
  const valueOf = (v: string | true | undefined, what: string): string | null => {
    if (v === undefined) return null;
    if (v === true) throw new ClaimsError(`${what} needs a value`);
    return v;
  };
  const thread = () => (opts['thread'] === undefined ? 0 : int(opts['thread'], '--thread'));

  switch (cmd) {
    case 'claim': {
      const chatId = int(need(pos[0], 'chat_id'), 'chat_id');
      const ids = pos.slice(1).map((v) => int(v, 'message_id'));
      const owner = need(opts['owner'], '--owner');
      const db = openDb();
      const r: ClaimCliResult = claimMessages(db, {
        chatId,
        messageIds: ids,
        owner,
        pid: resolveAgentPid(opts['pid']),
        note: valueOf(opts['note'], '--note'),
      });
      const holder = chatOwner(db, { chatId, threadId: thread() });
      r.chat_owner =
        holder.state === 'held'
          ? { owner: holder.owner, alive: holder.alive, inbox: holder.inbox, scope: holder.scope }
          : null;
      if (r.chat_owner && r.chat_owner.owner !== owner) {
        r.warning = `chat is leased by ${r.chat_owner.owner} — do not write there yourself, ask: claims.mjs ask ${chatId} --from ${owner} --text "..."`;
      }
      return json(r);
    }
    case 'release': {
      const chatId = int(need(pos[0], 'chat_id'), 'chat_id');
      const ids = pos.slice(1).map((v) => int(v, 'message_id'));
      if (!ids.length) throw new ClaimsError('at least one message_id is required');
      const wanted = opts['status'] ?? 'done';
      if (wanted !== 'done' && wanted !== 'dropped') {
        throw new ClaimsError(`status must be done|dropped, got '${String(wanted)}'`);
      }
      return json(
        releaseMessages(openDb(), { chatId, messageIds: ids, owner: need(opts['owner'], '--owner'), status: wanted })
      );
    }
    case 'lease': {
      const chatId = int(need(pos[0], 'chat_id'), 'chat_id');
      const owner = need(opts['owner'], '--owner');
      const r: LeaseCliResult = leaseChat(openDb(), {
        chatId,
        threadId: thread(),
        owner,
        pid: resolveAgentPid(opts['pid']),
        ttlMs: parseTtl(opts['ttl']),
        inbox: valueOf(opts['inbox'], '--inbox'),
        note: valueOf(opts['note'], '--note'),
      });
      if (r.ok && 'inbox' in r && typeof r.inbox === 'string' && r.inbox.startsWith('coop:')) {
        try {
          r.coop_joined = ensureCoopJoined(r.inbox.slice(5));
        } catch (e) {
          r.warning = `lease taken, but the coop mailbox could not be prepared: ${errMessage(e)}`;
        }
      }
      if (!r.ok) r.hint = `chat is held by a live agent — hand over instead: claims.mjs ask ${chatId} --from ${owner} --text "..."`;
      return json(r);
    }
    case 'unlease': {
      return json(
        unleaseChat(openDb(), {
          chatId: int(need(pos[0], 'chat_id'), 'chat_id'),
          threadId: thread(),
          owner: need(opts['owner'], '--owner'),
        })
      );
    }
    case 'owner': {
      return json(chatOwner(openDb(), { chatId: int(need(pos[0], 'chat_id'), 'chat_id'), threadId: thread() }));
    }
    case 'status': {
      return json(status(openDb(), { chatId: opts['chat'] === undefined ? null : int(opts['chat'], '--chat') }));
    }
    case 'ask': {
      return json(
        askOwner(openDb(), {
          chatId: int(need(pos[0], 'chat_id'), 'chat_id'),
          threadId: thread(),
          from: need(opts['from'], '--from'),
          text: need(opts['text'], '--text'),
          to: opts['to'] ?? null,
        })
      );
    }
    case 'inbox': {
      const raw = opts['owner'] ?? pos[0];
      const owner = String(need(raw, 'inbox owner (coop:NAME, NAME or --owner NAME)')).replace(/^coop:/, '');
      return json(readInbox({ owner, peek: Boolean(opts['peek']) }));
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'text', text: `${USAGE}\n` };
    default:
      throw new ClaimsError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

/**
 * The whole CLI in one funnel: print, then choose the exit code. 0 when the
 * answer is yes, 3 when the registry said no (busy / not yours) — never for
 * anything else — and 1 for every failure, reported as JSON like the rest.
 */
export function runCli(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    return match(main(argv))
      .with({ kind: 'text' }, ({ text }) => {
        process.stdout.write(text);
        return EXIT.OK;
      })
      .with({ kind: 'json' }, ({ value }) => {
        out(value);
        return value.ok ? EXIT.OK : EXIT.BUSY;
      })
      .exhaustive();
  } catch (e) {
    out({ ok: false, error: e instanceof ClaimsError ? e.message : (e instanceof Error ? (e.stack ?? String(e)) : String(e)) });
    return EXIT.ERROR;
  }
}
