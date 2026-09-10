#!/usr/bin/env node
// claims.mjs — shared registry of "who is handling which Telegram message / chat".
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
// No dependencies. Usable as a library (import) and as a CLI (JSON on stdout).
//
// Exit codes: 0 = acquired / free / delivered, 3 = busy or not yours, 1 = error.
//
// Env overrides: CLAIMS_DB (db file), CLAIMS_COOP (coop.sh path), COOP_ROOT
// (coop data dir; passed through to coop.sh).

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// node:sqlite is still flagged experimental in node 22; the warning would land in
// every agent's transcript. Keep every other warning.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.error(w.stack ?? String(w));
});

export const DB_PATH =
  process.env.CLAIMS_DB || path.join(os.homedir(), '.config', 'claude-agents', 'claims.sqlite');
// coop.sh (claude-coop cross-session mailboxes): CLAIMS_COOP points at it;
// otherwise the first usual checkout location that exists, else the first
// candidate so an error names a concrete path.
const COOP_CANDIDATES = ['git/work/claude-coop', 'git/claude-coop', 'claude-coop'].map((d) =>
  path.join(os.homedir(), d, 'coop.sh')
);
export const COOP_SH =
  process.env.CLAIMS_COOP || COOP_CANDIDATES.find((p) => existsSync(p)) || COOP_CANDIDATES[0];
const COOP_ROOT = process.env.COOP_ROOT || path.dirname(COOP_SH);

export const EXIT = { OK: 0, ERROR: 1, BUSY: 3 };
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

// ---------------------------------------------------------------- helpers ---

export class ClaimsError extends Error {}

function checkName(name, what = 'owner') {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ClaimsError(
      `${what} must match ${NAME_RE} (lowercase letters, digits, - and _), got '${name}'`,
    );
  }
  return name;
}

export function parseTtl(v, fallback = DEFAULT_TTL_MS) {
  if (v === undefined || v === null || v === '') return fallback;
  const m = String(v)
    .trim()
    .match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) throw new ClaimsError(`bad ttl '${v}' — use 90s, 30m, 2h, 1d`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[m[2] ?? 's'];
  if (n <= 0) throw new ClaimsError('ttl must be positive');
  return n * unit;
}

export function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

// Compact "how long": 12s, 5m, 2h10m, 3d4h. Negative input → "0s".
export function human(ms) {
  ms = Math.max(0, Math.round(ms));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
}

// true = alive, false = dead, null = unknown (no pid recorded).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours — still alive
  }
}

function psLine(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/^(\d+)\s+([\s\S]*)$/);
  return m ? { ppid: Number(m[1]), command: m[2] } : null;
}

// The CLI is a short-lived child of the agent's shell, so its own pid is useless.
// The pid worth recording is the nearest `claude` ancestor — the agent itself.
// Non-claude callers (daemons) pass --pid explicitly; with nothing found the pid
// stays null and liveness falls back to the TTL alone.
export function resolveAgentPid(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== true) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n < 0) throw new ClaimsError(`bad --pid '${explicit}'`);
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

function tx(db, fn) {
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

// --------------------------------------------------------------------- db ---

export function openDb(file = DB_PATH) {
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

export function prune(db, now = Date.now()) {
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
  return { claims: a.changes, leases: b.changes };
}

// ------------------------------------------------------------ message claims ---

// Take (chat_id, message_id) for `owner`. Exactly one caller wins per message:
// the whole batch runs under BEGIN IMMEDIATE (SQLite's cross-process write lock),
// and the INSERT itself only overwrites a row whose status is 'dropped'. A 'done'
// claim stays done — the message was already answered, nobody answers it twice.
export function claimMessages(db, { chatId, messageIds, owner, pid = null, note = null, now = Date.now() }) {
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
    const acquired = [];
    const busy = [];
    for (const messageId of messageIds) {
      const row = current.get(chatId, messageId);
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
    return { ok: busy.length === 0, chat_id: chatId, owner, acquired, busy };
  });
}

export function releaseMessages(
  db,
  { chatId, messageIds, owner, status = 'done', note = undefined, now = Date.now() },
) {
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
    const released = [];
    const refused = [];
    for (const messageId of messageIds) {
      if (upd.run(status, now, note ?? null, chatId, messageId, owner).changes === 1) {
        released.push({ message_id: messageId, status });
        continue;
      }
      const row = current.get(chatId, messageId);
      refused.push({
        message_id: messageId,
        owner: row?.owner ?? null,
        reason: !row ? 'not claimed' : row.owner !== owner ? `held by ${row.owner}` : `already ${row.status}`,
      });
    }
    return { ok: refused.length === 0, chat_id: chatId, owner, released, refused };
  });
}

// Change the note on claims `owner` still holds — the message's progress
// ("read" -> "in-turn") without touching who owns it. Rows that are not held
// by `owner` are reported back, never modified.
export function annotateMessages(db, { chatId, messageIds, owner, note, now = Date.now() }) {
  checkName(owner);
  const upd = db.prepare(
    `UPDATE message_claims SET note = ?
      WHERE chat_id = ? AND message_id = ? AND owner = ? AND status = 'held'`,
  );
  return tx(db, () => {
    const updated = [];
    const skipped = [];
    for (const messageId of messageIds) {
      if (upd.run(note, chatId, messageId, owner).changes === 1) updated.push(messageId);
      else skipped.push(messageId);
    }
    return { ok: skipped.length === 0, chat_id: chatId, owner, note, at: iso(now), updated, skipped };
  });
}

// --------------------------------------------------------------- chat leases ---

// What a lease row means right now. 'held' only when status is held, the TTL
// has not passed AND the owner's process is not known to be dead.
export function leaseState(row, now = Date.now()) {
  if (!row) return { state: 'free', reason: 'no lease' };
  if (row.status !== 'held') return { state: 'free', reason: `released (${row.status})` };
  if (row.expires_at <= now) return { state: 'free', reason: 'ttl expired' };
  const alive = pidAlive(row.pid);
  if (alive === false) return { state: 'free', reason: 'owner process dead' };
  return { state: 'held', reason: null, alive };
}

function describeLease(row, now, extra = {}) {
  if (!row) return { state: 'free', reason: 'no lease', owner: null, ...extra };
  const st = leaseState(row, now);
  return {
    state: st.state,
    reason: st.reason,
    owner: row.owner,
    pid: row.pid,
    alive: st.alive ?? pidAlive(row.pid),
    inbox: row.inbox,
    note: row.note,
    status: row.status,
    leased_at: iso(row.leased_at),
    age: human(now - row.leased_at),
    expires_at: iso(row.expires_at),
    expires_in: row.expires_at > now ? human(row.expires_at - now) : 'expired',
    released_at: iso(row.released_at),
    ...extra,
  };
}

const SELECT_LEASE = `SELECT * FROM chat_leases WHERE chat_id = ? AND thread_id = ?`;

// Take or renew the lease on (chat_id, thread_id). Same owner → renew (TTL, pid,
// inbox refreshed). Free / expired / dead-owner lease → take over. Live lease of
// someone else → refused, with the holder's details so the caller can `ask`.
export function leaseChat(
  db,
  { chatId, threadId = 0, owner, pid = null, ttlMs = DEFAULT_TTL_MS, inbox = null, note = null, now = Date.now() },
) {
  checkName(owner);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new ClaimsError('ttlMs must be a positive integer');
  inbox ??= `coop:${owner}`;
  const expiresAt = now + ttlMs;
  return tx(db, () => {
    const row = db.prepare(SELECT_LEASE).get(chatId, threadId);
    const st = leaseState(row, now);
    if (st.state === 'held' && row.owner !== owner) {
      return { ok: false, acquired: false, chat_id: chatId, thread_id: threadId, ...describeLease(row, now) };
    }
    const renewed = Boolean(row) && row.owner === owner && st.state === 'held';
    if (renewed) {
      db.prepare(
        `UPDATE chat_leases SET pid = ?, inbox = ?, note = COALESCE(?, note), expires_at = ?
          WHERE chat_id = ? AND thread_id = ?`,
      ).run(pid, inbox, note, expiresAt, chatId, threadId);
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO chat_leases
           (chat_id, thread_id, owner, pid, inbox, note, status, leased_at, expires_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, NULL)`,
      ).run(chatId, threadId, owner, pid, inbox, note, now, expiresAt);
    }
    const fresh = db.prepare(SELECT_LEASE).get(chatId, threadId);
    return {
      ok: true,
      acquired: true,
      renewed,
      took_over_from: !renewed && row && row.owner !== owner ? { owner: row.owner, reason: st.reason } : null,
      chat_id: chatId,
      thread_id: threadId,
      ...describeLease(fresh, now),
    };
  });
}

export function unleaseChat(db, { chatId, threadId = 0, owner, status = 'done', now = Date.now() }) {
  checkName(owner);
  return tx(db, () => {
    const r = db
      .prepare(
        `UPDATE chat_leases SET status = ?, released_at = ?
          WHERE chat_id = ? AND thread_id = ? AND owner = ? AND status = 'held'`,
      )
      .run(status, now, chatId, threadId, owner);
    if (r.changes === 1) return { ok: true, released: true, chat_id: chatId, thread_id: threadId, owner };
    const row = db.prepare(SELECT_LEASE).get(chatId, threadId);
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
export function chatOwner(db, { chatId, threadId = 0, now = Date.now() }) {
  const get = db.prepare(SELECT_LEASE);
  const exact = get.get(chatId, threadId);
  const base = { chat_id: chatId, thread_id: threadId };
  const exactView = describeLease(exact, now, { ...base, scope: 'thread' });
  if (exactView.state === 'held' || threadId === 0) return { ok: exactView.state === 'free', ...exactView };
  const whole = describeLease(get.get(chatId, 0), now, { ...base, scope: 'chat' });
  if (whole.state === 'held') return { ok: false, ...whole };
  return { ok: true, ...exactView };
}

export function status(db, { chatId = null, now = Date.now() } = {}) {
  const where = chatId == null ? '' : ' AND chat_id = ?';
  const args = chatId == null ? [] : [chatId];
  const claims = db
    .prepare(`SELECT * FROM message_claims WHERE status = 'held'${where} ORDER BY claimed_at DESC`)
    .all(...args)
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
    .map((r) => ({ chat_id: r.chat_id, thread_id: r.thread_id, ...describeLease(r, now) }));
  return { ok: true, now: iso(now), db: DB_PATH, claims, leases };
}

// ------------------------------------------------------------ coop channel ---

function coop(args) {
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
export function ensureCoopJoined(name) {
  checkName(name);
  const joined =
    existsSync(path.join(COOP_ROOT, 'cursors', name)) && existsSync(path.join(COOP_ROOT, 'mailbox', `${name}.md`));
  if (joined) return false;
  coop(['join', name, process.cwd(), 'telegram agent; reach it via claims.mjs ask <chat_id> --from <me> --text ...']);
  return true;
}

export function coopAvailable() {
  return existsSync(COOP_SH);
}

// "бро, ты отвечаешь по ним?" — drop a note into the chat owner's mailbox.
// Refuses when the chat has no live owner: then there is nobody to ask, claim
// the message and answer yourself.
export function askOwner(db, { chatId, threadId = 0, from, text, to = null, now = Date.now() }) {
  checkName(from, 'from');
  if (!text || !String(text).trim()) throw new ClaimsError('empty --text');
  const target = to ? { state: 'held', owner: checkName(to, 'to') } : chatOwner(db, { chatId, threadId, now });
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

export function parseInbox(out, owner) {
  const res = { ok: true, owner, messages: [], general: [], pending: [], more: 0 };
  if (/^inbox empty/.test(out)) return res;
  let section = null;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.text = cur.lines.join('\n').trim();
    delete cur.lines;
    const chat = cur.subject.match(/tg chat (-?\d+)(?:\/(\d+))?/);
    if (chat) {
      cur.chat_id = Number(chat[1]);
      cur.thread_id = chat[2] ? Number(chat[2]) : 0;
    }
    (section === 'general' ? res.general : res.messages).push(cur);
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
      const msg = { seq: Number(h[1]), from: h[2], to: h[3], at: h[4], subject: h[5] };
      if (section === 'headers') res.pending.push(msg);
      else cur = { ...msg, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return res;
}

// Read and consume (mark read) the owner's mailbox. Bounded by coop: full bodies
// for the first few, the rest come back as `pending` headers — call again.
export function readInbox({ owner, peek = false }) {
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

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos.shift();
  const need = (v, what) => {
    if (v === undefined || v === true || v === '') throw new ClaimsError(`missing ${what}`);
    return v;
  };
  const int = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new ClaimsError(`${what} must be an integer, got '${v}'`);
    return n;
  };
  const thread = () => (opts.thread === undefined ? 0 : int(opts.thread, '--thread'));

  switch (cmd) {
    case 'claim': {
      const chatId = int(need(pos[0], 'chat_id'), 'chat_id');
      const ids = pos.slice(1).map((v) => int(v, 'message_id'));
      const owner = need(opts.owner, '--owner');
      const db = openDb();
      const r = claimMessages(db, { chatId, messageIds: ids, owner, pid: resolveAgentPid(opts.pid), note: opts.note ?? null });
      const holder = chatOwner(db, { chatId, threadId: thread() });
      r.chat_owner = holder.state === 'held' ? { owner: holder.owner, alive: holder.alive, inbox: holder.inbox, scope: holder.scope } : null;
      if (r.chat_owner && r.chat_owner.owner !== owner) {
        r.warning = `chat is leased by ${holder.owner} — do not write there yourself, ask: claims.mjs ask ${chatId} --from ${owner} --text "..."`;
      }
      out(r);
      return r.ok ? EXIT.OK : EXIT.BUSY;
    }
    case 'release': {
      const chatId = int(need(pos[0], 'chat_id'), 'chat_id');
      const ids = pos.slice(1).map((v) => int(v, 'message_id'));
      if (!ids.length) throw new ClaimsError('at least one message_id is required');
      const r = releaseMessages(openDb(), { chatId, messageIds: ids, owner: need(opts.owner, '--owner'), status: opts.status ?? 'done' });
      out(r);
      return r.ok ? EXIT.OK : EXIT.BUSY;
    }
    case 'lease': {
      const chatId = int(need(pos[0], 'chat_id'), 'chat_id');
      const owner = need(opts.owner, '--owner');
      const r = leaseChat(openDb(), {
        chatId,
        threadId: thread(),
        owner,
        pid: resolveAgentPid(opts.pid),
        ttlMs: parseTtl(opts.ttl),
        inbox: opts.inbox ?? null,
        note: opts.note ?? null,
      });
      if (r.ok && String(r.inbox).startsWith('coop:')) {
        try {
          r.coop_joined = ensureCoopJoined(r.inbox.slice(5));
        } catch (e) {
          r.warning = `lease taken, but the coop mailbox could not be prepared: ${e.message}`;
        }
      }
      if (!r.ok) r.hint = `chat is held by a live agent — hand over instead: claims.mjs ask ${chatId} --from ${owner} --text "..."`;
      out(r);
      return r.ok ? EXIT.OK : EXIT.BUSY;
    }
    case 'unlease': {
      const r = unleaseChat(openDb(), { chatId: int(need(pos[0], 'chat_id'), 'chat_id'), threadId: thread(), owner: need(opts.owner, '--owner') });
      out(r);
      return r.ok ? EXIT.OK : EXIT.BUSY;
    }
    case 'owner': {
      const r = chatOwner(openDb(), { chatId: int(need(pos[0], 'chat_id'), 'chat_id'), threadId: thread() });
      out(r);
      return r.ok ? EXIT.OK : EXIT.BUSY;
    }
    case 'status': {
      out(status(openDb(), { chatId: opts.chat === undefined ? null : int(opts.chat, '--chat') }));
      return EXIT.OK;
    }
    case 'ask': {
      const r = askOwner(openDb(), {
        chatId: int(need(pos[0], 'chat_id'), 'chat_id'),
        threadId: thread(),
        from: need(opts.from, '--from'),
        text: need(opts.text, '--text'),
        to: opts.to ?? null,
      });
      out(r);
      return r.ok ? EXIT.OK : EXIT.BUSY;
    }
    case 'inbox': {
      const raw = opts.owner ?? pos[0];
      const owner = String(need(raw, 'inbox owner (coop:NAME, NAME or --owner NAME)')).replace(/^coop:/, '');
      out(readInbox({ owner, peek: Boolean(opts.peek) }));
      return EXIT.OK;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`);
      return EXIT.OK;
    default:
      throw new ClaimsError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    out({ ok: false, error: e instanceof ClaimsError ? e.message : (e.stack ?? String(e)) });
    process.exitCode = EXIT.ERROR;
  }
}
