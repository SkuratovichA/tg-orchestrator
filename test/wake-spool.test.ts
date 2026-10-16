// node --test wake-spool.test.ts
//
// The wake spool as a state machine, away from the daemon. runner-e2e pins what
// the RUNNING runner does with a record; this pins the rules it obeys — which
// name means what, what a claim leaves on disk, which records are dead-lettered
// and which get their one retry, and when a result is old enough to be LATE.
//
// Hermetic: every case gets its own spool under $TMPDIR and passes it in, so
// nothing here can touch ~/.config/tg-orchestrator/wake.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  claimPending,
  classify,
  deferItem,
  ensureSpool,
  nextDeferral,
  releaseDue,
  WAKE_DEFER_BACKOFF_MS,
  finishItem,
  parseWakeRecord,
  planRequeue,
  applyRequeue,
  clipWakeText,
  renderWakePrompt,
  wakeAgeMs,
  WAKE_LATE_MS,
  WAKE_MAX_TEXT,
  requeueDestination,
  resolveNotify,
  wakeRecordSchema,
  WAKE_DIR,
  WAKE_DONE,
} from '../src/wake/spool.ts';

const REC = {
  convo: '-1007770001:5',
  job: 'whisper msg 380',
  kind: 'voice-transcript',
  ok: true,
  text: 'расшифровка',
  file: '/tmp/voice.txt',
  startedAt: '2026-09-11T10:00:00.000Z',
  finishedAt: '2026-09-11T10:05:00.000Z',
};

function spool(t: TestContext): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wake-spool-')), 'wake');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  ensureSpool(dir);
  return dir;
}

const drop = (dir: string, name: string, body: unknown): string => {
  fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return name;
};
const names = (dir: string) => fs.readdirSync(dir).filter((f) => f !== 'done').sort();
const done = (dir: string) => fs.readdirSync(path.join(dir, 'done')).sort();

// ------------------------------------------------------------ the schema ----

test('the record wake.sh writes parses field for field', () => {
  const rec = parseWakeRecord(JSON.stringify(REC));
  assert.deepEqual(rec, REC);
});

test('unknown extra fields survive: a producer may carry its own', () => {
  const rec = parseWakeRecord(JSON.stringify({ ...REC, attempt: 2, tags: ['voice'] }));
  assert.equal(rec['attempt'], 2);
  assert.deepEqual(rec['tags'], ['voice']);
});

test('a field of the wrong type degrades to absent, it does not kill the record', () => {
  const rec = parseWakeRecord(JSON.stringify({ ...REC, ok: 'yes', text: 42 }));
  assert.equal(rec.ok, undefined, 'a non-boolean ok is dropped, so the job reads as succeeded');
  assert.equal(rec.text, undefined);
  assert.equal(rec.job, REC.job, 'the fields that were right are still there');
});

test('nulls are what wake.sh writes for "nothing here"', () => {
  const rec = parseWakeRecord(JSON.stringify({ convo: '1:2', file: null, startedAt: null }));
  assert.equal(rec.file, null);
  assert.equal(rec.startedAt, null);
  assert.equal(wakeRecordSchema.safeParse({}).success, true, 'an empty object is a record with no fields');
});

test('JSON that is not an object becomes a record with no address', () => {
  assert.deepEqual(parseWakeRecord('42'), {});
  assert.deepEqual(parseWakeRecord('"hello"'), {});
  assert.throws(() => parseWakeRecord('{nope'), 'unparseable JSON still throws — that is the .bad path');
});

// ----------------------------------------------------------- the address ----

test('resolveNotify reads <chat_id>:<thread_id>, and refuses everything else', () => {
  assert.deepEqual(resolveNotify('-1007770001:5'), { chatId: -1007770001, threadId: 5 });
  assert.deepEqual(resolveNotify('424242:0'), { chatId: 424242, threadId: undefined }, 'thread 0 is a DM');
  assert.deepEqual(resolveNotify('424242'), { chatId: 424242, threadId: undefined });
  for (const bad of [undefined, null, '', 'нет такого', ':5', '0:5']) {
    assert.equal(resolveNotify(bad), null, `"${String(bad)}" is not an address`);
  }
});

// ------------------------------------------------------------ the prompt ----

const NOW = Date.parse('2026-09-11T10:10:00.000Z');

test('the prompt names the job, the result and the files, and says it is not the owner', () => {
  const p = renderWakePrompt(parseWakeRecord(JSON.stringify(REC)), NOW);
  assert.match(p, /^Background job finished — this is NOT a new message from the owner\.$/m);
  assert.match(p, /^Now: 2026-09-11T10:10:00\.000Z$/m);
  assert.match(p, /^Job: whisper msg 380 \(kind=voice-transcript, ok=true\)$/m);
  assert.match(p, /^Started: 2026-09-11T10:00:00\.000Z$/m);
  assert.match(p, /^Output file: \/tmp\/voice\.txt$/m);
  assert.match(p, /^Result:$/m);
  assert.ok(p.endsWith('расшифровка'), 'the payload is the last thing the model reads');
  assert.doesNotMatch(p, /LATE/, 'five minutes old is not late');
});

test('a failed job is presented as failed, with the retry rule attached', () => {
  const p = renderWakePrompt(parseWakeRecord(JSON.stringify({ ...REC, ok: false, text: 'ffmpeg exited 1' })), NOW);
  assert.match(p, /^Job: whisper msg 380 \(kind=voice-transcript, ok=false\)$/m);
  assert.match(p, /^The job FAILED\. Error output:$/m);
  assert.doesNotMatch(p, /^Result:$/m);
  assert.match(p, /Retry at most\nonce, and only if the error looks transient\.$/);
});

test('the shared prompt bits: the age since finishedAt (0 when unknown) and the clip', () => {
  assert.equal(wakeAgeMs(parseWakeRecord(JSON.stringify(REC)), NOW), 5 * 60_000);
  assert.equal(wakeAgeMs({ convo: '1:2' }, NOW), 0);
  assert.equal(WAKE_LATE_MS, 30 * 60_000);
  const long = 'я'.repeat(WAKE_MAX_TEXT + 5_000);
  const clipped = clipWakeText(parseWakeRecord(JSON.stringify({ ...REC, text: long })));
  assert.ok(clipped.endsWith(`[...clipped, full text in ${REC.file}]`));
  assert.ok(clipped.length < WAKE_MAX_TEXT + 200);
  assert.equal(clipWakeText({ convo: '1:2', text: 'short' }), 'short');
  assert.equal(clipWakeText({ convo: '1:2' }), '');
});

test('LATE appears past 30 minutes and carries how long it waited', () => {
  const at = (mins: number) =>
    renderWakePrompt(parseWakeRecord(JSON.stringify({ ...REC, finishedAt: new Date(NOW - mins * 60_000).toISOString() })), NOW);
  assert.doesNotMatch(at(29), /LATE/);
  assert.doesNotMatch(at(30), /LATE/, 'exactly 30 minutes is not yet late');
  assert.match(at(31), /^LATE: this result waited 31 min before reaching you\.$/m);
  assert.match(at(180), /^LATE: this result waited 180 min before reaching you\.$/m);
  assert.match(at(31), /^Say so plainly in your answer instead of pretending it is fresh\.$/m);
  // No finishedAt: there is no age to judge, so nothing is claimed about it.
  assert.doesNotMatch(renderWakePrompt({ convo: '1:2' }, NOW), /LATE/);
});

test('a transcript longer than the cap is clipped and points at the file', () => {
  const long = 'я'.repeat(25_000);
  const p = renderWakePrompt(parseWakeRecord(JSON.stringify({ ...REC, text: long })), NOW);
  assert.ok(p.includes(`[...clipped, full text in ${REC.file}]`));
  assert.ok(p.length < long.length + 2000, 'the prompt does not carry the whole 25k');
  const noFile = renderWakePrompt(parseWakeRecord(JSON.stringify({ ...REC, text: long, file: null })), NOW);
  assert.ok(noFile.includes('[...clipped, full text in the job output]'));
});

// ------------------------------------------------------- the file states ----

test('the name is the state', () => {
  assert.deepEqual(classify('20260911T120000-1-job.json'), {
    state: 'queued',
    name: '20260911T120000-1-job.json',
    base: '20260911T120000-1-job.json',
  });
  assert.equal(classify('20260911T120000-1-job.json.taken').state, 'claimed');
  assert.equal(classify('20260911T120000-1-job.retry.json.taken').state, 'retried');
  assert.equal(classify('20260911T120000-1-job.json.bad').state, 'other');
  assert.equal(classify('done').state, 'other');
});

test('a claimed record gets one retry; a retried one is given up', (t) => {
  const dir = spool(t);
  assert.equal(
    requeueDestination('20260911T120000-1-job.json.taken', dir),
    path.join(dir, '20260911T120000-1-job.retry.json')
  );
  assert.equal(
    requeueDestination('20260911T120000-1-job.retry.json.taken', dir),
    path.join(dir, 'done', '20260911T120000-1-job.retry.json.taken.giveup')
  );
  assert.equal(requeueDestination('20260911T120000-1-job.json', dir), null, 'a queued record is not an orphan');
});

test('planRequeue moves both kinds of orphan and leaves queued records alone', (t) => {
  const dir = spool(t);
  drop(dir, 'a.json.taken', REC);
  drop(dir, 'b.retry.json.taken', REC);
  drop(dir, 'c.json', REC);
  const moves = planRequeue(dir).sort((x, y) => x.from.localeCompare(y.from));
  assert.deepEqual(moves.map((m) => [m.from, m.to]), [
    ['a.json.taken', 'a.retry.json'],
    ['b.retry.json.taken', 'b.retry.json.taken.giveup'],
  ]);
  for (const m of moves) assert.deepEqual(applyRequeue(m), { ok: true });
  assert.deepEqual(names(dir), ['a.retry.json', 'c.json']);
  assert.deepEqual(done(dir), ['b.retry.json.taken.giveup']);
  assert.deepEqual(planRequeue(dir), [], 'and nothing is left to requeue');
});

test('a rename that cannot happen is reported, not thrown', (t) => {
  const dir = spool(t);
  drop(dir, 'gone.json.taken', REC);
  const [move] = planRequeue(dir);
  assert.ok(move);
  fs.rmSync(move.fromPath);
  const r = applyRequeue(move);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /ENOENT/);
});

// ---------------------------------------------------------------- claims ----

test('claiming renames the record and hands back where to answer', (t) => {
  const dir = spool(t);
  const name = drop(dir, '20260911T120000-1-voice-transcript.json', REC);
  const [item, ...rest] = claimPending(dir);
  assert.deepEqual(rest, []);
  assert.ok(item && item.kind === 'ready');
  assert.equal(item.file, name);
  assert.equal(item.taken, path.join(dir, `${name}.taken`));
  assert.deepEqual(item.notify, { chatId: -1007770001, threadId: 5 });
  assert.equal(item.rec.job, REC.job);

  // The claim IS the rename: a second pass finds nothing, which is what keeps
  // two drains (or two runners) from answering the same record twice.
  assert.deepEqual(names(dir), [`${name}.taken`]);
  assert.deepEqual(claimPending(dir), []);

  finishItem(item.taken, item.file, dir);
  assert.deepEqual(names(dir), []);
  assert.deepEqual(done(dir), [name]);
});

test('records are claimed in name order — the spool name sorts by time', (t) => {
  const dir = spool(t);
  for (const n of ['20260911T120300-1-job.json', '20260911T120100-1-job.json', '20260911T120200-1-job.json']) {
    drop(dir, n, REC);
  }
  assert.deepEqual(claimPending(dir).map((i) => i.file), [
    '20260911T120100-1-job.json',
    '20260911T120200-1-job.json',
    '20260911T120300-1-job.json',
  ]);
});

test('an unreadable record is dead-lettered to done/<f>.bad with the reason', (t) => {
  const dir = spool(t);
  const name = drop(dir, '20260911T120000-1-job.json', '{ truncated');
  const [item] = claimPending(dir);
  assert.ok(item && item.kind === 'unreadable');
  assert.equal(item.file, name);
  assert.ok(item.error.length > 0, 'the parse error is carried out, for the owner’s message');
  assert.deepEqual(names(dir), []);
  assert.deepEqual(done(dir), [`${name}.bad`]);
  assert.equal(fs.readFileSync(path.join(dir, 'done', `${name}.bad`), 'utf8'), '{ truncated', 'kept as written');
});

test('a record with nowhere to answer is dead-lettered too, with what it said', (t) => {
  const dir = spool(t);
  const name = drop(dir, '20260911T120000-1-job.json', { ...REC, convo: 'нет такого' });
  const [item] = claimPending(dir);
  assert.ok(item && item.kind === 'no-address');
  assert.equal(item.rec.convo, 'нет такого', 'the owner is told the address the record really carried');
  assert.equal(item.rec.job, REC.job);
  assert.deepEqual(done(dir), [`${name}.bad`]);
});

test('a spool that does not exist yet is empty, not an error', () => {
  assert.deepEqual(claimPending(path.join(os.tmpdir(), 'no-such-wake-spool-ever')), []);
});

test('non-record files in the spool are ignored', (t) => {
  const dir = spool(t);
  drop(dir, '.20260911T120000-1-job.json.tmp', REC); // wake.sh mid-write
  drop(dir, 'notes.txt', 'whatever');
  assert.deepEqual(claimPending(dir), []);
  assert.deepEqual(names(dir).sort(), ['.20260911T120000-1-job.json.tmp', 'notes.txt']);
});

test('the module defaults point at the real spool under $HOME', () => {
  assert.equal(WAKE_DIR, path.join(os.homedir(), '.config', 'tg-orchestrator', 'wake'));
  assert.equal(WAKE_DONE, path.join(WAKE_DIR, 'done'));
});

// --------------------------------------------------------------- deferral ---

test('a deferred name carries its base and its not-before', () => {
  assert.deepEqual(classify('20260911T120000-1-job.json.until-1760000000000'), {
    state: 'deferred',
    name: '20260911T120000-1-job.json.until-1760000000000',
    base: '20260911T120000-1-job.json',
    notBefore: 1760000000000,
  });
  assert.equal(classify('a.retry.json.until-5').state, 'deferred');
  assert.equal(classify('a.json.until-soon').state, 'other');
});

test('the backoff is 30 min, 1 h, 2 h, 4 h, 8 h, then nothing', () => {
  const MIN = 60_000;
  assert.deepEqual(WAKE_DEFER_BACKOFF_MS, [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 480 * MIN]);
  assert.deepEqual(nextDeferral(parseWakeRecord(JSON.stringify(REC)), 1000), { deferrals: 1, notBefore: 1000 + 30 * MIN });
  assert.deepEqual(nextDeferral({ ...REC, deferrals: 4 }, 0), { deferrals: 5, notBefore: 480 * MIN });
  assert.equal(nextDeferral({ ...REC, deferrals: 5 }, 0), null);
});

test('deferItem puts the record back under its not-before, the count written into it', (t) => {
  const dir = spool(t);
  const file = drop(dir, 'a.json', { ...REC, extra: 'kept' });
  const [item] = claimPending(dir, 0);
  assert.ok(item && item.kind === 'ready');
  assert.deepEqual(deferItem(item.taken, file, 1, 5000, dir), { ok: true, name: 'a.json.until-5000' });
  assert.deepEqual(names(dir), ['a.json.until-5000']);
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'a.json.until-5000'), 'utf8'));
  assert.deepEqual(back, { ...REC, extra: 'kept', deferrals: 1 });
  assert.equal(parseWakeRecord(JSON.stringify(back)).deferrals, 1);
});

test('a deferral that cannot happen is reported, not thrown, and leaves no tmp file', (t) => {
  const dir = spool(t);
  const r = deferItem(path.join(dir, 'gone.json.taken'), 'gone.json', 1, 5000, dir);
  assert.equal(r.ok, false);
  assert.deepEqual(names(dir), []);
});

test('a deferred record is skipped until due, then claimed like any other', (t) => {
  const dir = spool(t);
  drop(dir, 'a.json.until-5000', { ...REC, deferrals: 1 });
  assert.deepEqual(claimPending(dir, 4999), [], 'not due yet');
  assert.deepEqual(names(dir), ['a.json.until-5000']);
  assert.deepEqual(releaseDue(dir, 4999), []);
  const [item, ...rest] = claimPending(dir, 5000);
  assert.deepEqual(rest, []);
  assert.ok(item && item.kind === 'ready');
  assert.equal(item.file, 'a.json');
  assert.equal(item.rec.deferrals, 1);
  assert.deepEqual(names(dir), ['a.json.taken']);
});

test('the startup requeue leaves a deferred record alone', (t) => {
  const dir = spool(t);
  drop(dir, 'a.json.until-9999999999999', REC);
  drop(dir, 'b.retry.json.until-9999999999999', REC);
  assert.deepEqual(planRequeue(dir), []);
  assert.equal(requeueDestination('a.json.until-9999999999999', dir), null);
});
