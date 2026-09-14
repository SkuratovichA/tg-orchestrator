#!/usr/bin/env node
// claims.test.ts — race test for the claims registry.  Run:  node claims.test.ts
//
// N processes (default 24) each open the DB, sleep until a shared start instant
// and then try to take the SAME message claim / chat lease within the same
// millisecond. Exactly one must win and every loser must be told who won.
// A negative control runs the identical race against a naive SELECT-then-INSERT
// with no transaction: it MUST produce duplicate winners — if it does not, the
// race is too loose to prove anything and the test fails.
//
// Everything runs against a throwaway DB and a throwaway coop root under $TMPDIR;
// the real ~/.config/claude-agents/claims.sqlite and claude-coop are untouched.
// Env: CLAIMS_TEST_WORKERS (24), CLAIMS_TEST_ROUNDS (5).
//
// The library is loaded through a DYNAMIC import on purpose, here and in the
// worker: claims.ts reads CLAIMS_DB at module load, so the env has to be in
// place first. The CLI, by contrast, is spawned as src/claims.mjs — that is the
// path every other caller uses.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { ClaimResult, LeaseResult } from '../src/claims.ts';

const SELF = fileURLToPath(import.meta.url);
const LIB = path.join(path.dirname(SELF), '..', 'src', 'claims.mjs');
const N = Number(process.env.CLAIMS_TEST_WORKERS || 24);
const ROUNDS = Number(process.env.CLAIMS_TEST_ROUNDS || 5);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loadClaims = () => import('../src/claims.ts');

// ------------------------------------------------------------------ worker ---

interface NaiveOutcome {
  ok: boolean;
  owner: string;
  acquired: Array<{ message_id: number }>;
  busy: Array<{ message_id: number; owner: string }>;
}

// What the registry must NOT do: look, then write, with no lock held in between.
function naiveClaim(db: DatabaseSync, chatId: number, messageId: number, owner: string): NaiveOutcome {
  const row = db
    .prepare('SELECT owner FROM message_claims WHERE chat_id = ? AND message_id = ?')
    .get(chatId, messageId);
  if (row) return { ok: false, owner, acquired: [], busy: [{ message_id: messageId, owner: String(row['owner']) }] };
  db.prepare(
    `INSERT OR REPLACE INTO message_claims (chat_id, message_id, owner, status, claimed_at)
     VALUES (?, ?, ?, 'held', ?)`,
  ).run(chatId, messageId, owner, Date.now());
  return { ok: true, owner, acquired: [{ message_id: messageId }], busy: [] };
}

async function worker(args: readonly string[]): Promise<void> {
  const [mode = '', t0 = '0', owner = '', chat = '0', msg = '0'] = args;
  const lib = await loadClaims(); // CLAIMS_DB comes from the parent's env
  const db = lib.openDb();
  const chatId = Number(chat);
  const messageId = Number(msg);
  const start = Number(t0);
  // Sleep to just before the barrier, then spin: all workers act in the same ms.
  const wait = start - Date.now() - 15;
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  while (Date.now() < start) {
    /* spin */
  }
  let r: ClaimResult | LeaseResult | NaiveOutcome;
  if (mode === 'claim') r = lib.claimMessages(db, { chatId, messageIds: [messageId], owner, pid: process.pid });
  else if (mode === 'lease') r = lib.leaseChat(db, { chatId, owner, pid: process.pid, ttlMs: 60_000 });
  else if (mode === 'naive') r = naiveClaim(db, chatId, messageId, owner);
  else throw new Error(`unknown worker mode '${mode}'`);
  process.stdout.write(JSON.stringify({ started_late_ms: Math.max(0, Date.now() - start), ...r }));
  // A lease carries the winner's pid and a dead pid frees it. A winner that exits
  // at once would therefore be taken over legitimately by the next worker in line —
  // the first version of this test did exactly that and reported 12 "winners".
  // Stay alive until every other worker has had its turn.
  if (mode === 'lease' && r.ok) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
}

// ------------------------------------------------------------------ harness ---

/** One worker's line of stdout, as the parent can read it: everything optional. */
interface RaceLine {
  ok?: boolean;
  owner?: string;
  state?: string;
  alive?: boolean | null;
  busy?: Array<{ message_id: number; owner: string; status?: string }>;
  took_over_from?: { owner: string; reason: string } | null;
  started_late_ms?: number;
  error?: string;
}

const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures.push(msg);
}

interface WorkerRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runWorker(args: readonly string[], env: NodeJS.ProcessEnv): Promise<WorkerRun> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SELF, '--worker', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => (stdout += String(d)));
    p.stderr?.on('data', (d) => (stderr += String(d)));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function race(
  mode: string,
  { chatId, messageId = 0, env, n = N }: { chatId: number; messageId?: number; env: NodeJS.ProcessEnv; n?: number }
): Promise<RaceLine[]> {
  const t0 = Date.now() + 1500;
  const raw = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runWorker([mode, String(t0), `w${String(i).padStart(2, '0')}`, String(chatId), String(messageId)], env),
    ),
  );
  return raw.map((r, i): RaceLine => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { owner: `w${String(i).padStart(2, '0')}`, error: (r.stderr || r.stdout).trim() || `exit ${r.code}` };
    }
  });
}

function summarize(res: readonly RaceLine[]) {
  const errors = res.filter((x) => x.error);
  const winners = res.filter((x) => x.ok);
  const losers = res.filter((x) => !x.ok && !x.error);
  const late = Math.max(0, ...res.map((x) => x.started_late_ms ?? 0));
  return { errors, winners, losers, late, winner: winners[0]?.owner ?? null };
}

/** What the CLI answered: an exit code and, when it spoke JSON, the document. */
interface CliJson {
  ok?: boolean;
  error?: string;
  acquired?: Array<{ message_id: number }> | boolean;
  busy?: Array<{ owner: string }>;
  released?: unknown[];
  claims?: unknown[];
  leases?: unknown[];
  owner?: string;
  alive?: boolean | null;
  state?: string;
  hint?: string;
  warning?: string;
  chat_owner?: { owner: string } | null;
  delivered?: boolean;
  seq?: number | null;
  messages?: Array<{ text?: string }>;
}

function cli(args: readonly string[]): { code: number | null; json: CliJson | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env: process.env });
  let json: CliJson | null = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const acquiredCount = (json: CliJson | null): number => (Array.isArray(json?.acquired) ? json.acquired.length : -1);

function deadPid(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = p.pid;
    p.on('close', () => resolve(pid));
  });
}

async function main(): Promise<number> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'claims-test-'));
  const env = { CLAIMS_DB: path.join(tmp, 'claims.sqlite'), COOP_ROOT: path.join(tmp, 'coop') };
  Object.assign(process.env, env);
  const lib = await loadClaims();
  const db = lib.openDb();
  console.log(`claims.test: ${N} workers × ${ROUNDS} rounds — db ${env.CLAIMS_DB}`);

  console.log(`\n1. message claim — ${N} processes race for one message`);
  for (let r = 1; r <= ROUNDS; r++) {
    const s = summarize(await race('claim', { chatId: -1001, messageId: r, env }));
    check(s.errors.length === 0, `round ${r}: no worker crashed${s.errors[0] ? ` — ${String(s.errors[0].error).slice(0, 200)}` : ''}`);
    check(s.winners.length === 1, `round ${r}: exactly one winner (got ${s.winners.length}: ${s.winners.map((w) => w.owner).join(',') || '-'})`);
    const told = s.losers.filter((x) => x.busy?.[0]?.owner === s.winner && x.busy?.[0]?.status === 'held').length;
    check(told === N - 1, `round ${r}: ${told}/${N - 1} losers were told the winner is ${s.winner} (max start skew ${s.late}ms)`);
  }
  const heldRows = Number(
    db.prepare(`SELECT count(*) c FROM message_claims WHERE chat_id = -1001 AND status = 'held'`).get()?.['c']
  );
  check(heldRows === ROUNDS, `db holds exactly ${ROUNDS} claims for the chat (got ${heldRows})`);

  console.log('\n2. negative control — same race against SELECT-then-INSERT with no transaction (must break)');
  let dupRounds = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const s = summarize(await race('naive', { chatId: -1002, messageId: r, env }));
    console.log(`  round ${r}: ${s.winners.length} winners`);
    if (s.winners.length > 1) dupRounds++;
  }
  check(dupRounds > 0, `naive version produced duplicate winners in ${dupRounds}/${ROUNDS} rounds — the race is real, the transaction is what prevents it`);

  console.log(`\n3. chat lease — expired lease is taken over by exactly one of ${N}`);
  lib.leaseChat(db, { chatId: -2001, owner: 'stale', pid: process.pid, ttlMs: 1 });
  await sleep(10);
  check(lib.chatOwner(db, { chatId: -2001 }).reason === 'ttl expired', 'a lease past its ttl reads as free (ttl expired)');
  {
    const s = summarize(await race('lease', { chatId: -2001, env }));
    check(s.errors.length === 0, `no worker crashed${s.errors[0] ? ` — ${String(s.errors[0].error).slice(0, 200)}` : ''}`);
    check(s.winners.length === 1, `exactly one worker got the lease (got ${s.winners.length})`);
    check(s.winners[0]?.took_over_from?.owner === 'stale', `winner reports the takeover from 'stale' (${JSON.stringify(s.winners[0]?.took_over_from)})`);
    const told = s.losers.filter((x) => x.owner === s.winner && x.state === 'held').length;
    check(told === N - 1, `${told}/${N - 1} losers see ${s.winner} holding the chat`);
  }

  console.log(`\n4. chat lease — dead owner process is taken over by exactly one of ${N}`);
  const ghostPid = await deadPid();
  lib.leaseChat(db, { chatId: -2002, owner: 'ghost', pid: ghostPid ?? null, ttlMs: 3_600_000 });
  check(lib.chatOwner(db, { chatId: -2002 }).reason === 'owner process dead', `a lease whose pid ${ghostPid} is gone reads as free (owner process dead)`);
  {
    const s = summarize(await race('lease', { chatId: -2002, env }));
    check(s.winners.length === 1, `exactly one worker got the lease (got ${s.winners.length})`);
    check(s.winners[0]?.took_over_from?.owner === 'ghost', `winner reports the takeover from 'ghost'`);
  }

  console.log(`\n5. chat lease — live owner is NOT taken over by any of ${N}`);
  lib.leaseChat(db, { chatId: -2003, owner: 'alive-one', pid: process.pid, ttlMs: 3_600_000 });
  {
    const s = summarize(await race('lease', { chatId: -2003, env }));
    check(s.winners.length === 0, `nobody got the lease (got ${s.winners.length})`);
    const told = s.losers.filter((x) => x.owner === 'alive-one' && x.alive === true && x.state === 'held').length;
    check(told === N, `${told}/${N} were told alive-one holds it and is alive`);
  }
  const renew = lib.leaseChat(db, { chatId: -2003, owner: 'alive-one', pid: process.pid, ttlMs: 7_200_000 });
  check(renew.acquired && renew.renewed === true, 'same owner re-leasing = renew');
  check(lib.unleaseChat(db, { chatId: -2003, owner: 'other' }).reason === 'held by alive-one', 'unlease by a non-owner is refused');
  check(lib.unleaseChat(db, { chatId: -2003, owner: 'alive-one' }).ok === true, 'unlease by the owner works');
  check(lib.chatOwner(db, { chatId: -2003 }).reason === 'released (done)', 'released lease reads as free');
  lib.leaseChat(db, { chatId: -2004, owner: 'whole-chat', pid: process.pid, ttlMs: 3_600_000 });
  const topic = lib.chatOwner(db, { chatId: -2004, threadId: 120 });
  check(topic.state === 'held' && topic.owner === 'whole-chat' && topic.scope === 'chat', 'topic query falls back to a live whole-chat lease');

  console.log('\n6. claim semantics');
  const c1 = lib.claimMessages(db, { chatId: -1003, messageIds: [1], owner: 'a', pid: process.pid });
  const c2 = lib.claimMessages(db, { chatId: -1003, messageIds: [1], owner: 'a', pid: process.pid });
  check(c1.ok && c2.ok && c2.acquired[0]?.already_mine === true, 'claiming your own held message again is idempotent');
  const c3 = lib.claimMessages(db, { chatId: -1003, messageIds: [1, 2], owner: 'b', pid: process.pid });
  check(!c3.ok && c3.busy[0]?.owner === 'a' && c3.acquired[0]?.message_id === 2, 'batch: busy ones reported with the owner, free ones acquired');
  check(lib.releaseMessages(db, { chatId: -1003, messageIds: [1], owner: 'b' }).refused[0]?.reason === 'held by a', 'release by a non-owner is refused');
  check(lib.releaseMessages(db, { chatId: -1003, messageIds: [1], owner: 'a' }).ok, 'release by the owner (done)');
  check(lib.claimMessages(db, { chatId: -1003, messageIds: [1], owner: 'b' }).busy[0]?.status === 'done', 'a done message cannot be re-claimed');
  check(lib.releaseMessages(db, { chatId: -1003, messageIds: [2], owner: 'b', status: 'dropped' }).ok, 'release as dropped');
  check(lib.claimMessages(db, { chatId: -1003, messageIds: [2], owner: 'a' }).acquired[0]?.took_over_dropped === true, 'a dropped message can be claimed by someone else');
  let threw = false;
  try {
    lib.claimMessages(db, { chatId: -1003, messageIds: [3], owner: 'Bad Name' });
  } catch (e) {
    threw = e instanceof lib.ClaimsError;
  }
  check(threw, 'owner names are validated');
  check(
    lib.parseTtl('2h') === 7_200_000 && lib.parseTtl('90s') === 90_000 && lib.parseTtl('30m') === 1_800_000 && lib.parseTtl('1d') === 86_400_000 && lib.parseTtl('15') === 15_000,
    'ttl parsing: 2h 90s 30m 1d 15',
  );

  console.log('\n7. CLI — exit codes and JSON');
  let r = cli(['claim', '-3001', '7', '8', '--owner', 'cli-a', '--pid', String(process.pid)]);
  check(r.code === 0 && acquiredCount(r.json) === 2, `claim → exit 0, two acquired (exit ${r.code})`);
  r = cli(['claim', '-3001', '7', '--owner', 'cli-b', '--pid', '0']);
  check(r.code === 3 && r.json?.busy?.[0]?.owner === 'cli-a', `claim of a taken message → exit 3, busy by cli-a (exit ${r.code})`);
  r = cli(['lease', '-3001', '--owner', 'cli-a', '--ttl', '1h', '--pid', String(process.pid)]);
  check(r.code === 0 && r.json?.acquired === true, `lease → exit 0 (exit ${r.code}${r.json?.warning ? `, warning: ${r.json.warning}` : ''})`);
  r = cli(['owner', '-3001']);
  check(r.code === 3 && r.json?.owner === 'cli-a' && r.json?.alive === true, `owner of a held chat → exit 3, cli-a alive (exit ${r.code})`);
  r = cli(['lease', '-3001', '--owner', 'cli-b', '--pid', '0']);
  check(r.code === 3 && r.json?.owner === 'cli-a' && typeof r.json?.hint === 'string', `lease of a held chat → exit 3 with a hint to ask (exit ${r.code})`);
  r = cli(['claim', '-3001', '9', '--owner', 'cli-b', '--pid', '0']);
  check(r.code === 0 && r.json?.chat_owner?.owner === 'cli-a' && /leased by cli-a/.test(r.json?.warning ?? ''), 'claim in a chat leased by someone else → acquired, but warned');
  r = cli(['status', '--chat', '-3001']);
  check(r.code === 0 && r.json?.claims?.length === 3 && r.json?.leases?.length === 1, `status → 3 claims, 1 lease (got ${r.json?.claims?.length}/${r.json?.leases?.length})`);
  r = cli(['unlease', '-3001', '--owner', 'cli-a']);
  check(r.code === 0, `unlease → exit 0 (exit ${r.code})`);
  r = cli(['owner', '-3001']);
  check(r.code === 0 && r.json?.state === 'free', `owner of a free chat → exit 0 (exit ${r.code})`);
  r = cli(['release', '-3001', '7', '8', '--owner', 'cli-a']);
  check(r.code === 0 && r.json?.released?.length === 2, `release → exit 0 (exit ${r.code})`);
  r = cli(['bogus']);
  check(r.code === 1 && r.json?.ok === false, `unknown command → exit 1 (exit ${r.code})`);
  r = cli(['claim', 'x', '1', '--owner', 'a']);
  check(r.code === 1 && /integer/.test(r.json?.error ?? ''), `bad chat id → exit 1 (exit ${r.code})`);
  r = cli([]);
  check(r.code === 0 && /claims\.mjs/.test(r.stdout), 'no args → usage');

  console.log('\n8. ask / inbox — handover through coop.sh mailboxes');
  if (!lib.coopAvailable()) {
    console.log(`  skip: coop.sh not found at ${lib.COOP_SH}`);
  } else {
    lib.leaseChat(db, { chatId: 87791046, owner: 'watcher-t', pid: process.pid, ttlMs: 3_600_000 });
    lib.ensureCoopJoined('watcher-t');
    const a = lib.askOwner(db, { chatId: 87791046, from: 'orch-t', text: 'бро, ты отвечаешь по msg 501? тогда я не лезу' });
    check(a.ok && a.delivered && a.to === 'watcher-t' && Number.isInteger(a.seq), `ask → delivered to watcher-t as m-${a.seq}`);
    const inbox = lib.readInbox({ owner: 'watcher-t' });
    const m = inbox.messages[0];
    check(inbox.messages.length === 1 && m?.from === 'orch-t' && m?.chat_id === 87791046 && /msg 501/.test(m?.text ?? ''), `inbox → one message from orch-t about chat 87791046 (${JSON.stringify(m?.text)})`);
    check(lib.readInbox({ owner: 'watcher-t' }).messages.length === 0, 'inbox is consumed on read');
    const none = lib.askOwner(db, { chatId: -4001, from: 'orch-t', text: 'anyone?' });
    check(none.ok === false && none.delivered === false, 'ask on a chat without a live owner is refused (nobody to ask)');
    r = cli(['ask', '87791046', '--from', 'orch-t', '--text', 'second one via cli']);
    check(r.code === 0 && r.json?.delivered === true, `cli ask → exit 0 (exit ${r.code})`);
    r = cli(['inbox', 'coop:watcher-t']);
    check(r.code === 0 && r.json?.messages?.[0]?.text === 'second one via cli', 'cli inbox → the message, parsed');
    r = cli(['ask', '-4001', '--from', 'orch-t', '--text', 'anyone?']);
    check(r.code === 3, `cli ask without an owner → exit 3 (exit ${r.code})`);
  }

  console.log(`\n${failures.length ? `FAILED: ${failures.length}` : 'ALL PASSED'} — ${tmp}`);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  return failures.length ? 1 : 0;
}

if (process.argv[2] === '--worker') {
  await worker(process.argv.slice(3));
} else {
  process.exitCode = await main();
}
