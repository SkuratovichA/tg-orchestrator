#!/usr/bin/env node
// turn.test.mjs — dedup + timeout/retry policy of the runner.   Run:  node --test turn.test.mjs
//
// Pins the 10.09 incident: a turn that finished its work and printed its result
// was killed by the runner's own timeout, read as a failure and re-run from
// scratch, so the owner got the whole job twice. Everything runs against a
// throwaway claims DB and a fake `claude` (a node script) under $TMPDIR.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { openDb, claimMessages } from '../src/claims.mjs';
import {
  attemptTurn,
  claimIncoming,
  parseStream,
  parseTimeoutMs,
  retryDecision,
  runClaude,
  settleIncoming,
} from '../src/turn.mjs';

// A stand-in for `claude -p --output-format stream-json`. FAKE_MODE picks the
// scenario; every invocation appends its mode to FAKE_COUNT so a test can see
// how many times the runner spawned it.
const FAKE_CLAUDE = `
import fs from 'node:fs';
const mode = process.env.FAKE_MODE;
if (process.env.FAKE_COUNT) fs.appendFileSync(process.env.FAKE_COUNT, mode + '\\n');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const init = () => line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
const tool = () => line({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
const result = () => line({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1',
  result: 'Отправил в «dev»: сводку (msg 470)', total_cost_usd: 0.1, num_turns: 3, duration_ms: 5 });
const hang = () => setInterval(() => {}, 1000);
if (mode === 'ok') { init(); tool(); result(); }
else if (mode === 'hang-after-result') { init(); tool(); result(); hang(); }
else if (mode === 'hang-with-tools') { init(); tool(); hang(); }
else if (mode === 'hang-silent') { hang(); }
else if (mode === 'resume-fail') { process.stderr.write('No conversation found with session ID: abc\\n'); process.exitCode = 1; }
else { process.stderr.write('unknown FAKE_MODE ' + mode + '\\n'); process.exitCode = 2; }
`;

let tmp;
let db;
let fake;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'turn-test-'));
  db = openDb(path.join(tmp, 'claims.sqlite'));
  fake = path.join(tmp, 'fake-claude.mjs');
  writeFileSync(fake, FAKE_CLAUDE);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const msg = (id, chatId = -100123) => ({ message_id: id, chat: { id: chatId, type: 'supergroup' }, text: `m${id}` });
const quiet = () => {};
const collect = (lines) => (...a) => lines.push(a.join(' '));

function run(mode, opts = {}) {
  return runClaude({
    bin: process.execPath,
    args: [fake],
    env: { ...process.env, FAKE_MODE: mode, ...(opts.countFile ? { FAKE_COUNT: opts.countFile } : {}) },
    timeoutMs: 1500,
    warnBeforeMs: 0,
    exitGraceMs: 300,
    log: quiet,
    ...opts,
  });
}

// ------------------------------------------------------------------ dedup ---

test('a message delivered twice is sent to the model once', () => {
  const lines = [];
  const first = claimIncoming(db, [msg(1)], { log: collect(lines) });
  assert.equal(first.length, 1);
  assert.match(lines[0], /^claimed \[-100123:1\]/);
  // Redelivered while the first turn is still running (same process holds it).
  const again = claimIncoming(db, [msg(1)], { log: collect(lines) });
  assert.equal(again.length, 0);
  assert.match(lines[1], /^already-claimed \[-100123:1\]/);
  // Answered; a later replay must not open a new turn either.
  settleIncoming(db, [msg(1)], { note: 'answered', log: collect(lines) });
  assert.match(lines[2], /^done \[-100123:1\] answered/);
  const replay = claimIncoming(db, [msg(1)], { log: collect(lines) });
  assert.equal(replay.length, 0);
  assert.match(lines[3], /^already-handled \[-100123:1\]/);
});

test('new messages in the same batch as a duplicate still go through', () => {
  claimIncoming(db, [msg(2)], { log: quiet });
  settleIncoming(db, [msg(2)], { log: quiet });
  const out = claimIncoming(db, [msg(2), msg(3)], { log: quiet });
  assert.deepEqual(out.map((m) => m.message_id), [3]);
});

test('a message another agent holds is not touched', () => {
  claimMessages(db, { chatId: -100123, messageIds: [4], owner: 'other-bot', pid: process.pid });
  const lines = [];
  assert.equal(claimIncoming(db, [msg(4)], { log: collect(lines) }).length, 0);
  assert.match(lines[0], /^busy \[-100123:4\]: held by other-bot/);
});

test('a message our dead predecessor held is reclaimed', () => {
  claimMessages(db, { chatId: -100123, messageIds: [5], owner: 'orchestrator', pid: 99999 });
  const lines = [];
  assert.equal(claimIncoming(db, [msg(5)], { log: collect(lines) }).length, 1);
  assert.match(lines[0], /^reclaimed \[-100123:5\]: previous holder pid 99999 is dead$/);
  // ...and it is now held by THIS process, so a second delivery is blocked.
  assert.equal(claimIncoming(db, [msg(5)], { log: quiet }).length, 0);
});

test('without a registry every message passes', () => {
  assert.equal(claimIncoming(null, [msg(6), msg(6)], { log: quiet }).length, 2);
});

// ----------------------------------------------------------- turn / retry ---

test('parseStream: result event, tool uses, plain-json fallback', () => {
  const s = parseStream(
    '{"type":"system","subtype":"init","session_id":"s"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"tool_use"},{"type":"text","text":"hi"}]}}\n' +
      'not json\n' +
      '{"type":"result","is_error":false,"result":"done","session_id":"s"}\n'
  );
  assert.equal(s.toolUses, 1);
  assert.equal(s.text, 'hi');
  assert.equal(s.payload.result, 'done');
  assert.equal(s.sessionId, 's');
  assert.equal(parseStream('{"is_error":false,"result":"legacy"}').payload.result, 'legacy');
  assert.equal(parseTimeoutMs('abc', 7), 7);
  assert.equal(parseTimeoutMs('120000'), 120000);
});

test('a clean turn is ok', async () => {
  const a = await run('ok');
  assert.equal(a.ok, true);
  assert.equal(a.killedAfterResult, false);
  assert.equal(a.code, 0);
  assert.equal(a.sessionId, 'sess-1');
  assert.equal(a.toolUses, 1);
});

test('a turn killed after printing its result is accepted, not retried', async () => {
  const lines = [];
  const t0 = Date.now();
  const a = await run('hang-after-result', { log: collect(lines) });
  assert.equal(a.ok, true, 'result received => the turn succeeded');
  assert.equal(a.killedAfterResult, true);
  assert.equal(a.timedOut, false, 'killed by the post-result grace, not by the timeout');
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the full timeout');
  assert.match(lines.join('\n'), /printed its result but did not exit/);
  assert.equal(a.payload.result, 'Отправил в «dev»: сводку (msg 470)');
  assert.deepEqual(retryDecision(a, 'old-session'), { retry: false, reason: 'ok' });
});

test('a turn that timed out after tool calls is a failure but NOT retried', async () => {
  const a = await run('hang-with-tools', { timeoutMs: 400 });
  assert.equal(a.ok, false);
  assert.equal(a.timedOut, true);
  assert.equal(a.toolUses, 1);
  assert.match(a.error, /^exit=SIGKILL \(timeout 400ms, 1 tool call\(s\)\)/);
  const d = retryDecision(a, 'old-session');
  assert.equal(d.retry, false);
  assert.match(d.reason, /^retry-suppressed: turn already produced 1 tool call\(s\) before the timeout$/);
});

test('a failed resume that did nothing IS retried fresh', async () => {
  const a = await run('resume-fail');
  assert.equal(a.ok, false);
  assert.equal(a.code, 1);
  assert.equal(a.toolUses, 0);
  assert.match(a.error, /No conversation found/);
  assert.deepEqual(retryDecision(a, 'old-session'), {
    retry: true,
    reason: 'retry-fresh: resume failed before doing anything',
  });
  assert.equal(retryDecision(a, null).retry, false, 'a fresh session has nothing to fall back to');
});

test('a silent timeout (nothing produced) is retried fresh', async () => {
  const a = await run('hang-silent', { timeoutMs: 300 });
  assert.equal(a.ok, false);
  assert.equal(a.timedOut, true);
  assert.equal(retryDecision(a, 'old-session').reason, 'retry-fresh: timed out before doing anything');
});

test('attemptTurn: the runner spawns once for a killed-after-result turn, twice for a dead resume', async () => {
  const counts = path.join(tmp, 'spawns.txt');
  writeFileSync(counts, '');
  const lines = [];
  const r1 = await attemptTurn((resume) => run('hang-after-result', { countFile: counts }), 'old-session', collect(lines));
  assert.equal(r1.attempt.ok, true);
  assert.equal(r1.retried, false);
  assert.equal(readFileSync(counts, 'utf8'), 'hang-after-result\n');

  writeFileSync(counts, '');
  const modes = ['resume-fail', 'ok'];
  const r2 = await attemptTurn((resume) => run(modes.shift(), { countFile: counts }), 'old-session', collect(lines));
  assert.equal(r2.retried, true);
  assert.equal(r2.attempt.ok, true);
  assert.equal(readFileSync(counts, 'utf8'), 'resume-fail\nok\n');
  assert.match(lines.at(-1), /^retry-fresh: resume failed before doing anything: exit=1/);

  writeFileSync(counts, '');
  const r3 = await attemptTurn((resume) => run('hang-with-tools', { countFile: counts, timeoutMs: 300 }), 'old-session', collect(lines));
  assert.equal(r3.retried, false);
  assert.equal(readFileSync(counts, 'utf8'), 'hang-with-tools\n');
  assert.match(lines.at(-1), /^retry-suppressed/);
});

test('the topic is warned before the kill', async () => {
  const warns = [];
  const a = await run('hang-with-tools', { timeoutMs: 700, warnBeforeMs: 300, onWarn: (w) => warns.push(w) });
  assert.equal(a.timedOut, true);
  assert.equal(warns.length, 1);
  assert.ok(warns[0].elapsedMs >= 350 && warns[0].elapsedMs < 700, `warned at ${warns[0].elapsedMs}ms`);
  assert.equal(warns[0].leftMs, 300);
  // ...but not for a turn that finished in time.
  const w2 = [];
  await run('ok', { timeoutMs: 5000, warnBeforeMs: 4000, onWarn: (w) => w2.push(w) });
  assert.equal(w2.length, 0);
});

test('a missing binary is a plain failure', async () => {
  const a = await runClaude({ bin: path.join(tmp, 'no-such-claude'), args: [], timeoutMs: 1000, log: quiet });
  assert.equal(a.ok, false);
  assert.match(a.error, /spawn: /);
});
