// node --test events.test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  CLOSING_KINDS,
  type EventFields,
  latestSnapshot,
  openEvents,
  orphanedInbound,
  projectSessions,
  record,
  recordMany,
  tail,
  trace,
} from '../src/events.ts';

// The shim, not the module: the children below are what a second process looks
// like, and a second process imports src/events.mjs.
const EVENTS_URL = new URL('../src/events.mjs', import.meta.url).href;

// A throwaway DB per test: node:sqlite is synchronous and file-backed, so the
// only way to keep suites independent is a fresh directory each time.
function tmpDb(t: TestContext): { file: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.sqlite');
  return { file, db: openEvents(file) };
}

const inbound = (db: DatabaseSync, convo: string, msgId: number, extra: EventFields = {}) =>
  record(db, 'inbound', { convo, msgId, payload: { message_id: msgId, text: `m${msgId}` }, ...extra });

// --------------------------------------------------------------- append ----

test('seq is monotonic and tail filters by convo and kind', (t) => {
  const { db } = tmpDb(t);
  const a = record(db, 'inbound', { convo: '1:2', msgId: 10, updateId: 100, payload: { text: 'a' } });
  const b = record(db, 'turn_start', { convo: '1:2', payload: { msg_ids: [10] } });
  const c = record(db, 'inbound', { convo: '9:0', msgId: 11, updateId: 101, payload: { text: 'b' } });
  assert.ok(a < b && b < c, `expected increasing seqs, got ${a} ${b} ${c}`);

  const all = tail(db, { n: 50 });
  assert.deepEqual(all.map((e) => e.seq), [a, b, c], 'tail comes back in seq order');
  assert.deepEqual(all[0]?.payload, { text: 'a' }, 'payload is parsed back');
  assert.equal(all[0]?.actor, 'cli', 'actor defaults to cli');
  assert.equal(all[0]?.v, 1);

  assert.deepEqual(tail(db, { convo: '1:2' }).map((e) => e.seq), [a, b]);
  assert.deepEqual(tail(db, { kind: 'inbound' }).map((e) => e.seq), [a, c]);
  assert.deepEqual(tail(db, { n: 1 }).map((e) => e.seq), [c], 'n keeps the NEWEST rows');
});

test('a null payload stays null, not the string "null"', (t) => {
  const { db } = tmpDb(t);
  record(db, 'flush_word', { convo: '1:2', msgId: 7 });
  assert.equal(tail(db)[0]?.payload, null);
});

// ------------------------------------------------------- orphanedInbound ----

test('a bare inbound event is an orphan', (t) => {
  const { db } = tmpDb(t);
  inbound(db, '1:2', 10);
  const orphans = orphanedInbound(db);
  assert.equal(orphans.length, 1);
  assert.deepEqual(
    { convo: orphans[0]?.convo, msgId: orphans[0]?.msgId },
    { convo: '1:2', msgId: 10 }
  );
  assert.deepEqual(orphans[0]?.message, { message_id: 10, text: 'm10' }, 'the raw message comes back');
});

test('each closing kind closes an inbound message', (t) => {
  const { db } = tmpDb(t);
  let msgId = 100;
  const ids: number[] = [];
  for (const kind of CLOSING_KINDS) {
    msgId += 1;
    ids.push(msgId);
    inbound(db, '1:2', msgId);
    record(db, kind, { convo: '1:2', msgId });
  }
  assert.deepEqual(orphanedInbound(db), [], `none of ${CLOSING_KINDS.join('/')} left an orphan`);

  // ...and a NON-closing kind does not: progress is not an answer.
  inbound(db, '1:2', 999);
  record(db, 'turn_start', { convo: '1:2', msgId: 999 });
  assert.deepEqual(orphanedInbound(db).map((r) => r.msgId), [999]);
});

test('a closing event BEFORE the inbound does not close it', (t) => {
  const { db } = tmpDb(t);
  // The same message id answered in an earlier life of the topic, then a new
  // message reusing that id (a replay, a re-delivery): still open.
  record(db, 'turn_result', { convo: '1:2', msgId: 10, payload: { ok: true } });
  inbound(db, '1:2', 10);
  assert.deepEqual(orphanedInbound(db).map((r) => r.msgId), [10]);
});

test('the same msg_id in two convos is tracked independently', (t) => {
  const { db } = tmpDb(t);
  inbound(db, '1:2', 10);
  inbound(db, '9:0', 10);
  record(db, 'turn_result', { convo: '9:0', msgId: 10, payload: { ok: true } });
  assert.deepEqual(orphanedInbound(db).map((r) => r.convo), ['1:2']);
});

test('orphans come back in seq order', (t) => {
  const { db } = tmpDb(t);
  for (const id of [3, 1, 2]) inbound(db, '1:2', id);
  assert.deepEqual(orphanedInbound(db).map((r) => r.msgId), [3, 1, 2]);
});

// -------------------------------------------------------- projectSessions ----

test('projectSessions folds the log onto the newest snapshot', (t) => {
  const { db } = tmpDb(t);
  record(db, 'snapshot', { payload: { offset: 500, sessions: { '1:2': { id: 'old', last: 1 } } } });
  assert.deepEqual(latestSnapshot(db)?.sessions, { '1:2': { id: 'old', last: 1 } });

  // a turn that kept its transcript replaces the session
  record(db, 'turn_result', { convo: '1:2', msgId: 1, payload: { ok: true, session: { id: 's1', last: 2 } } });
  assert.deepEqual(projectSessions(db).sessions, { '1:2': { id: 's1', last: 2 } });

  // /reset drops it
  record(db, 'session_reset', { convo: '1:2', msgId: 2, payload: { inFlight: false } });
  assert.deepEqual(projectSessions(db).sessions, {});

  // a turn WITHOUT a session (the /reset landed mid-turn, transcript dropped)
  // must not resurrect it
  record(db, 'turn_result', { convo: '1:2', msgId: 3, payload: { ok: true, sessionId: 'ghost' } });
  assert.deepEqual(projectSessions(db).sessions, {}, 'payload.session is the only source of truth');

  // a FAILED turn that ran tools still leaves a resumable transcript
  record(db, 'turn_fail', { convo: '1:2', msgId: 4, payload: { ok: false, session: { id: 's2', last: 3 } } });
  assert.deepEqual(projectSessions(db).sessions, { '1:2': { id: 's2', last: 3 } });
});

test('projected offset is the max of the snapshot and later inbound update_ids', (t) => {
  const { db } = tmpDb(t);
  record(db, 'snapshot', { payload: { offset: 500, sessions: {} } });
  assert.equal(projectSessions(db).offset, 500);
  record(db, 'inbound', { convo: '1:2', msgId: 1, updateId: 499, payload: {} });
  assert.equal(projectSessions(db).offset, 500, 'an older update_id never moves it back');
  record(db, 'inbound', { convo: '1:2', msgId: 2, updateId: 777, payload: {} });
  assert.equal(projectSessions(db).offset, 777);
});

test('projectSessions works with no snapshot at all', (t) => {
  const { db } = tmpDb(t);
  assert.deepEqual(projectSessions(db), { offset: 0, sessions: {} });
  record(db, 'turn_result', { convo: '4:5', payload: { ok: true, session: { id: 'x', last: 9 } } });
  assert.deepEqual(projectSessions(db), { offset: 0, sessions: { '4:5': { id: 'x', last: 9 } } });
});

// ------------------------------------------------------------------ trace ----

test('trace finds the inbound, the folding turn_start and the result', (t) => {
  const { db } = tmpDb(t);
  const a = inbound(db, '1:2', 10);
  const b = inbound(db, '1:2', 11);
  // one turn answering both messages: it carries no msg_id of its own
  const c = record(db, 'turn_start', { convo: '1:2', payload: { kind: 'msgs', msg_ids: [10, 11] } });
  const d = record(db, 'turn_result', { convo: '1:2', msgId: 10, payload: { ok: true } });
  record(db, 'turn_result', { convo: '1:2', msgId: 11, payload: { ok: true } });
  // noise that must NOT show up
  record(db, 'turn_start', { convo: '9:0', payload: { msg_ids: [10] } });
  inbound(db, '9:0', 10);

  assert.deepEqual(trace(db, 10, '1:2').map((e) => e.seq), [a, c, d]);
  assert.deepEqual(trace(db, 10, '1:2').map((e) => e.kind), ['inbound', 'turn_start', 'turn_result']);
  assert.equal(trace(db, 11, '1:2')[0]?.seq, b);
  assert.equal(trace(db, 10).length, 5, 'without a convo the other topic is included too');
});

test('trace survives events with no payload and no msg_ids', (t) => {
  const { db } = tmpDb(t);
  record(db, 'runner_start', { payload: { pid: 1 } });
  record(db, 'turn_start', { convo: '1:2' }); // payload NULL
  const a = inbound(db, '1:2', 10);
  assert.deepEqual(trace(db, 10).map((e) => e.seq), [a]);
});

// ------------------------------------------------------------- recordMany ----

test('recordMany writes the whole batch or nothing', (t) => {
  const { db } = tmpDb(t);
  const seqs = recordMany(db, [
    { kind: 'turn_result', convo: '1:2', msgId: 10, payload: { ok: true } },
    { kind: 'turn_result', convo: '1:2', msgId: 11, payload: { ok: true } },
  ]);
  assert.equal(seqs.length, 2);
  const [first, second] = seqs;
  assert.ok(first !== undefined && second !== undefined && second > first);
  assert.equal(tail(db).length, 2);

  // kind is NOT NULL: the bad row must take the good ones down with it, or a
  // crash could close half a turn's messages and re-queue the other half.
  assert.throws(() =>
    recordMany(db, [
      { kind: 'turn_result', convo: '1:2', msgId: 12, payload: { ok: true } },
      { kind: null, convo: '1:2', msgId: 13 },
      { kind: 'turn_result', convo: '1:2', msgId: 14, payload: { ok: true } },
    ])
  );
  assert.equal(tail(db).length, 2, 'nothing from the failed batch landed');

  // the connection is usable afterwards (the ROLLBACK actually ran)
  assert.equal(recordMany(db, [{ kind: 'inbound', convo: '1:2', msgId: 15 }]).length, 1);
  assert.deepEqual(recordMany(db, []), []);
});

// ----------------------------------------------------------- concurrency ----

const CHILD = (dbFile: string, tag: number) => `
  import { openEvents, record } from ${JSON.stringify(EVENTS_URL)};
  const db = openEvents(${JSON.stringify(dbFile)});
  for (let i = 0; i < 25; i++) record(db, 'inbound', { convo: '1:${tag}', msgId: i, actor: 'child:${tag}', payload: { i } });
`;

test('parallel writers never collide or reuse a seq', async (t) => {
  const { file, db } = tmpDb(t);
  const kids = Array.from({ length: 8 }, (_, n) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD(file, n)], {
        env: { ...process.env, TG_EVENTS_DB: file },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr?.on('data', (b) => (err += String(b)));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${n} exited ${code}: ${err}`))));
    })
  );
  await Promise.all(kids);

  const rows = db.prepare('SELECT seq, actor FROM events ORDER BY seq').all();
  assert.equal(rows.length, 200, '8 writers x 25 rows');
  assert.equal(new Set(rows.map((r) => r['seq'])).size, 200, 'every seq is unique');
  assert.equal(new Set(rows.map((r) => r['actor'])).size, 8, 'all 8 writers got through');
});
