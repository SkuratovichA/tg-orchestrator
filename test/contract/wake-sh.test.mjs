// wake-sh.test.mjs — the external contract of scripts/wake.sh.
//
// wake.sh is the ONLY way back into the daemon for work that outlives the turn
// that started it, and it is called from other people's scripts. Two consumers
// read what it produces: the runner's drainWake() (the spool file — its name,
// its atomicity, its JSON shape) and events.mjs (the mirrored wake_posted
// row). Both are pinned here.
//
// Hermetic: HOME points at a temp dir, so the spool is <tmp>/.config/
// tg-orchestrator/wake, and TG_EVENTS_DB at a temp sqlite file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { rmDir, run, runSrc, SCRIPTS, tmpDir } from './helpers.mjs';

const WAKE_SH = path.join(SCRIPTS, 'wake.sh');
const NAME_RE = /^\d{8}T\d{6}-\d+-([\w.-]+)\.json$/;

let tmp;
let home;
let eventsDb;
let spool;

const wake = (args) =>
  run('bash', [WAKE_SH, ...args], { env: { HOME: home, TG_EVENTS_DB: eventsDb } });

const spoolFiles = () => fs.readdirSync(spool).filter((f) => f !== 'done').sort();

const tailJson = () =>
  runSrc('events.mjs', ['tail', '--json'], { env: { HOME: home, TG_EVENTS_DB: eventsDb } })
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

before(() => {
  tmp = tmpDir('wake-contract');
  home = path.join(tmp, 'home');
  eventsDb = path.join(tmp, 'events.sqlite');
  spool = path.join(home, '.config', 'tg-orchestrator', 'wake');
  fs.mkdirSync(home, { recursive: true });
});
after(() => rmDir(tmp));

test('a successful job: spool record + wake_posted event', () => {
  const textFile = path.join(tmp, 'transcript.txt');
  fs.writeFileSync(textFile, 'расшифровка голосового\nвторая строка\n');

  const r = wake(['--convo', '1:2', '--job', 'x', '--ok', '--text-file', textFile]);
  assert.equal(r.code, 0, r.stderr);

  // stdout names the record it queued, and nothing else.
  const files = spoolFiles();
  assert.equal(files.length, 1);
  assert.equal(r.stdout, `wake queued: ${path.join(spool, files[0])}\n`);

  // <UTC compact timestamp>-<pid>-<kind>.json, kind defaulting to "job".
  const m = files[0].match(NAME_RE);
  assert.ok(m, `spool name ${files[0]} must match ${NAME_RE}`);
  assert.equal(m[1], 'job');

  // The dot-tmp + mv dance left nothing behind: the runner reads whole files,
  // so a half-written record must never be visible under a *.json name.
  assert.deepEqual(fs.readdirSync(spool).filter((f) => f.startsWith('.') || f.endsWith('.tmp')), []);
  assert.ok(fs.existsSync(path.join(spool, 'done')), 'wake/done is created up front');

  const rec = JSON.parse(fs.readFileSync(path.join(spool, files[0]), 'utf8'));
  assert.deepEqual(Object.keys(rec), ['convo', 'job', 'kind', 'ok', 'text', 'file', 'startedAt', 'finishedAt']);
  assert.equal(rec.convo, '1:2');
  assert.equal(rec.job, 'x');
  assert.equal(rec.kind, 'job');
  assert.equal(rec.ok, true);
  assert.equal(rec.text, 'расшифровка голосового\nвторая строка\n');
  assert.equal(rec.file, textFile, '--text-file doubles as the output file when --file is absent');
  assert.equal(rec.startedAt, null);
  assert.match(rec.finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/);

  // ...and the durable mirror of the same post.
  const rows = tailJson();
  assert.equal(rows.length, 1);
  const ev = rows[0];
  assert.equal(ev.kind, 'wake_posted');
  assert.equal(ev.convo, '1:2');
  assert.equal(ev.actor, 'wake.sh');
  assert.equal(ev.msgId, null);
  assert.equal(ev.updateId, null);
  assert.deepEqual(ev.payload, { job: 'x', kind: 'job', ok: true, file: textFile });

  fs.rmSync(path.join(spool, files[0]));
});

test('--fail records ok:false, in the spool and in the event', () => {
  const r = wake(['--convo', '-100777:5', '--job', 'whisper msg 380', '--kind', 'voice-transcript',
    '--fail', '--text', 'ffmpeg exited 1', '--started', '2026-09-11T10:00:00Z']);
  assert.equal(r.code, 0, r.stderr);

  const files = spoolFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].match(NAME_RE)[1], 'voice-transcript');

  const rec = JSON.parse(fs.readFileSync(path.join(spool, files[0]), 'utf8'));
  assert.equal(rec.ok, false);
  assert.equal(rec.convo, '-100777:5');
  assert.equal(rec.job, 'whisper msg 380');
  assert.equal(rec.kind, 'voice-transcript');
  assert.equal(rec.text, 'ffmpeg exited 1');
  assert.equal(rec.file, null, 'no --file and no --text-file leaves file null');
  assert.equal(rec.startedAt, '2026-09-11T10:00:00Z');

  const ev = tailJson().at(-1);
  assert.equal(ev.kind, 'wake_posted');
  assert.deepEqual(ev.payload, { job: 'whisper msg 380', kind: 'voice-transcript', ok: false, file: null });

  fs.rmSync(path.join(spool, files[0]));
});

test('an unreadable --text-file is reported inside the record, not as a failure', () => {
  const missing = path.join(tmp, 'no-such-file.txt');
  const r = wake(['--convo', '1:2', '--job', 'x', '--text-file', missing]);
  assert.equal(r.code, 0);
  const files = spoolFiles();
  const rec = JSON.parse(fs.readFileSync(path.join(spool, files[0]), 'utf8'));
  assert.match(rec.text, /^\[wake\.sh: could not read .*no-such-file\.txt: /);
  assert.equal(rec.file, missing);
  fs.rmSync(path.join(spool, files[0]));
});

test('WAKE_SPOOL sends the record to another daemon\'s spool, same name and shape', () => {
  const other = path.join(tmp, 'other-runner', 'wake');
  const r = run('bash', [WAKE_SH, '--convo', '-100:5', '--job', 'port gate', '--fail', '--text', 'log tail'], {
    env: { HOME: home, TG_EVENTS_DB: eventsDb, WAKE_SPOOL: other },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(spoolFiles(), [], 'the default spool stays untouched');
  const files = fs.readdirSync(other).filter((f) => f !== 'done');
  assert.equal(files.length, 1);
  assert.ok(fs.existsSync(path.join(other, 'done')), 'done/ is created beside the records, as in the default spool');
  assert.equal(r.stdout, `wake queued: ${path.join(other, files[0])}\n`);
  assert.match(files[0], NAME_RE);
  const rec = JSON.parse(fs.readFileSync(path.join(other, files[0]), 'utf8'));
  assert.deepEqual(
    { convo: rec.convo, job: rec.job, kind: rec.kind, ok: rec.ok, text: rec.text },
    { convo: '-100:5', job: 'port gate', kind: 'job', ok: false, text: 'log tail' },
  );
});

test('missing --convo / --job and an unknown argument all exit 2 and queue nothing', () => {
  const noConvo = wake(['--job', 'x']);
  assert.equal(noConvo.code, 2);
  assert.equal(noConvo.stdout, '');
  assert.equal(noConvo.stderr, 'wake.sh: --convo <chat_id>:<thread_id> is required\n');

  const noJob = wake(['--convo', '1:2']);
  assert.equal(noJob.code, 2);
  assert.equal(noJob.stderr, 'wake.sh: --job "<what this was>" is required\n');

  const unknown = wake(['--convo', '1:2', '--job', 'x', '--nope']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, 'wake.sh: unknown arg --nope\n');

  assert.deepEqual(spoolFiles(), [], 'a rejected invocation must not leave a record');
});
