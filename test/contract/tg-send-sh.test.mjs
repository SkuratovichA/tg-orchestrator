// tg-send-sh.test.mjs — the external contract of scripts/tg-send.sh.
//
// tg-send.sh is the only way a turn posts to Telegram, and its two jobs are both
// pinned here:
//
//   1) the id it records is result.message_id and never the nested
//      reply_to_message.message_id. Ids in a forum group are chat-wide, so a
//      wrong id names a message in a different topic and a later cleanup would
//      delete the wrong thing.
//   2) a response it cannot read is NOT a failed send. It leaves a .inflight
//      marker and the next call with the same key refuses, because re-running
//      the send is how the owner got the same message twice on 20.09.2026.
//
// Hermetic: TG_SEND_API points at the fake Bot API, TG_SEND_STATE and
// TG_EVENTS_DB at temp paths. Nothing here reaches Telegram.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { baseEnv, rmDir, ROOT, runSrc, SCRIPTS, startFakeTelegram, tmpDir } from './helpers.mjs';

const TG_SEND = path.join(SCRIPTS, 'tg-send.sh');
const TOKEN = 'test-token';

// NOT helpers.run: that is spawnSync, and the fake Bot API lives in this very
// process — a blocked event loop can never answer the curl, so every send would
// sit until its --max-time and look like a network failure.
const sh = (args, env) =>
  new Promise((resolve) => {
    const p = spawn('bash', [TG_SEND, ...args], { cwd: ROOT, env: baseEnv(env) });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });

let tmp;
let home;
let state;
let eventsDb;
let fake;

const textFile = (name, body) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
};

// The split planner's model is a fake too: it counts its calls and answers
// with whatever envelope the test puts in FAKE_PLANNER_OUT. By default it
// fails, so a test that never expected a model call cannot pass on one.
let planner;
let plannerCalls;
const plannerCount = () => (fs.existsSync(plannerCalls) ? fs.readFileSync(plannerCalls, 'utf8').split('\n').filter(Boolean).length : 0);
const envelope = (result) => JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 3 } });

const send = (args, extraEnv = {}) =>
  sh(args, {
    HOME: home,
    TG_SEND_STATE: state,
    TG_EVENTS_DB: eventsDb,
    TG_SEND_API: `${fake.base}/bot${TOKEN}`,
    TG_SPLIT_CLAUDE_BIN: planner,
    TG_SPLIT_PAUSE: '0',
    FAKE_PLANNER_CALLS: plannerCalls,
    FAKE_PLANNER_RC: '1',
    ...extraEnv,
  });

const records = () => fs.readdirSync(state).filter((f) => !f.endsWith('.inflight')).sort();
const markers = () => fs.readdirSync(state).filter((f) => f.endsWith('.inflight')).sort();
const record = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(path.join(state, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

before(async () => {
  tmp = tmpDir('tg-send-contract');
  home = path.join(tmp, 'home');
  eventsDb = path.join(tmp, 'events.sqlite');
  fs.mkdirSync(home, { recursive: true });
  planner = path.join(tmp, 'fake-claude.sh');
  fs.writeFileSync(
    planner,
    '#!/usr/bin/env bash\ncat > /dev/null\necho call >> "$FAKE_PLANNER_CALLS"\nprintf \'%s\' "${FAKE_PLANNER_OUT:-}"\nexit "${FAKE_PLANNER_RC:-0}"\n',
    { mode: 0o755 },
  );
  fake = await startFakeTelegram({ token: TOKEN });
});
after(async () => {
  await fake.stop();
  rmDir(tmp);
});
beforeEach(() => {
  state = fs.mkdtempSync(path.join(tmp, 'state-'));
  fake.state.sent.length = 0;
  fake.state.methods.length = 0;
  fake.state.rawControlCharsInEcho = false;
  plannerCalls = path.join(state, '..', `planner-calls-${path.basename(state)}`);
});

test('a reply: the recorded id is result.message_id, not the reply target', async () => {
  const f = textFile('reply.txt', 'ответ на вопрос');
  const r = await send(['--chat', '-100777', '--thread', '1493', '--reply', '1686', '--text-file', f]);
  assert.equal(r.code, 0, r.stderr);

  const target = Number(fake.state.sent[0].reply_to_message_id);
  const sentId = fake.state.nextId - 1;
  assert.equal(target, 1686);
  assert.notEqual(sentId, target);

  // The one line a caller reads. No JSON parsing anywhere downstream.
  assert.equal(r.stdout.trim(), `ok=true message_id=${sentId}`);

  const rec = record(records()[0]);
  assert.equal(rec.message_id, String(sentId));
  assert.notEqual(rec.message_id, '1686'); // the greedy `sed` bug, pinned
  assert.equal(rec.parsed, 'true');
  assert.equal(rec.reply, '1686');
  assert.deepEqual(markers(), []);
});

test('no reply: the response carries a single id and it is the one recorded', async () => {
  const f = textFile('plain.txt', 'без реплая');
  const r = await send(['--chat', '-100777', '--text-file', f]);
  assert.equal(r.code, 0, r.stderr);
  const sentId = fake.state.nextId - 1;
  assert.equal(r.stdout.trim(), `ok=true message_id=${sentId}`);
  assert.equal(record(records()[0]).message_id, String(sentId));
});

test('raw U+0000–U+001F in the echoed text: still ok=true and still the top-level id', async () => {
  // This body is the bug. jq says "control characters from U+0000 through
  // U+001F must be escaped" and a default json.load raises — and the send that
  // produced it had already been delivered.
  fake.state.rawControlCharsInEcho = true;
  const f = textFile('ctrl.txt', 'строка\u0001с\u000bконтрольными');
  const r = await send(['--chat', '-100777', '--reply', '1686', '--text-file', f]);
  assert.equal(r.code, 0, r.stderr);
  const sentId = fake.state.nextId - 1;
  assert.equal(r.stdout.trim(), `ok=true message_id=${sentId}`);

  const rec = record(records()[0]);
  assert.equal(rec.message_id, String(sentId));
  assert.notEqual(rec.message_id, '1686');
  // strict=False parses it, so the positional fallback is not what answered.
  assert.equal(rec.parsed, 'true');
});

test('the same key again: refuses, exits 0, and does not call the API', async () => {
  const f = textFile('same.txt', 'один и тот же текст');
  const first = await send(['--chat', '-100777', '--thread', '1493', '--text-file', f]);
  assert.equal(first.code, 0, first.stderr);
  const sentId = fake.state.nextId - 1;
  const callsBefore = fake.state.methods.length;

  const again = await send(['--chat', '-100777', '--thread', '1493', '--text-file', f]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.trim(), `already-sent message_id=${sentId} — NOT resending`);
  assert.equal(fake.state.methods.length, callsBefore, 'a second sendMessage was issued');
  assert.equal(records().length, 1);
});

test('the key separates chat, thread, reply and the text bytes', async () => {
  const a = textFile('k-a.txt', 'текст А');
  const b = textFile('k-b.txt', 'текст Б');
  for (const args of [
    ['--chat', '1', '--thread', '5', '--reply', '9', '--text-file', a],
    ['--chat', '2', '--thread', '5', '--reply', '9', '--text-file', a],
    ['--chat', '1', '--thread', '6', '--reply', '9', '--text-file', a],
    ['--chat', '1', '--thread', '5', '--reply', '8', '--text-file', a],
    ['--chat', '1', '--thread', '5', '--reply', '9', '--text-file', b],
  ]) {
    assert.equal((await send(args)).code, 0);
  }
  assert.equal(records().length, 5, 'one of the four variants collided with another key');
  // ...and the identical first call maps back onto the first key.
  const repeat = await send(['--chat', '1', '--thread', '5', '--reply', '9', '--text-file', a]);
  assert.match(repeat.stdout, /^already-sent /);
  assert.equal(records().length, 5);
});

test('a response that is not a confirmed ok:true keeps the .inflight marker and exits non-zero', async () => {
  const f = textFile('bad.txt', 'ушло или нет — неизвестно');
  const r = await send(['--chat', '-100777', '--text-file', f], { TG_SEND_API: `${fake.base}/botWRONG` });
  assert.notEqual(r.code, 0);
  assert.equal(records().length, 0, 'a failed send must not record an id');
  assert.equal(markers().length, 1);
  assert.match(r.stderr, /Marker kept/);

  // Same branch for a body that is not JSON at all, and for no body: nothing
  // here may decide "not delivered" on its own.
  const g = textFile('bad2.txt', 'некуда идти');
  const dead = await send(['--chat', '-100777', '--text-file', g], { TG_SEND_API: 'http://127.0.0.1:1/bot' });
  assert.notEqual(dead.code, 0);
  assert.equal(records().length, 0);
  assert.equal(markers().length, 2);
});

test('a stale marker with no id: refuses and exits non-zero even against a healthy API', async () => {
  const f = textFile('stale.txt', 'висящая отправка');
  const first = await send(['--chat', '-100777', '--text-file', f], { TG_SEND_API: `${fake.base}/botWRONG` });
  assert.notEqual(first.code, 0);
  const callsBefore = fake.state.methods.length;

  const again = await send(['--chat', '-100777', '--text-file', f]);
  assert.notEqual(again.code, 0, 'an unreadable response must never be retried blindly');
  assert.equal(fake.state.methods.length, callsBefore, 'it sent anyway');
  assert.match(again.stderr, /REFUSING to send/);
  // It must name the two ways to find out whether the message is already there.
  assert.match(again.stderr, /getUpdates/);
  assert.match(again.stderr, /list_messages/);
});

test('the length guard counts characters, not UTF-8 bytes', async () => {
  // The regression this pins: everything this bot sends is Russian, Cyrillic is
  // two bytes per character, so a byte-counting guard refuses a valid answer at
  // roughly half the real limit. 3000 'я' is 6000 bytes and must still go.
  const cyr = textFile('cyr.txt', 'я'.repeat(3000));
  assert.equal(fs.statSync(cyr).size, 6000, 'the fixture is not actually two-byte Cyrillic');
  const long = await send(['--chat', '1', '--text-file', cyr]);
  assert.equal(long.code, 0, long.stderr);
  assert.equal(record(records()[0]).chars, '3000');
  assert.equal(record(records()[0]).bytes, '6000');
});

test('over 4096 characters: refused before any API call', async () => {
  const callsBefore = fake.state.methods.length;
  const over = await send(['--chat', '1', '--text-file', textFile('big.txt', 'я'.repeat(4097))]);
  assert.equal(over.code, 2);
  assert.match(over.stderr, /4097 characters.*limit is 4096 characters/);
  assert.equal(fake.state.methods.length, callsBefore, 'Telegram would have truncated it silently');
  assert.equal(records().length, 0);
  assert.equal(markers().length, 0, 'a rejected send must not block the key');

  // Exactly at the limit still goes, in ASCII and in Cyrillic alike.
  const ascii = await send(['--chat', '1', '--text-file', textFile('edge.txt', 'y'.repeat(4096))]);
  assert.equal(ascii.code, 0, ascii.stderr);
  const edgeCyr = await send(['--chat', '1', '--text-file', textFile('edge-cyr.txt', 'я'.repeat(4096))]);
  assert.equal(edgeCyr.code, 0, edgeCyr.stderr);
});

test('a confirmed send appends one outbound event', async () => {
  const f = textFile('ev.txt', 'событие в лог');
  const r = await send(['--chat', '-100777', '--thread', '1493', '--text-file', f]);
  assert.equal(r.code, 0, r.stderr);
  const rows = runSrc('events.mjs', ['tail', '--json'], { env: { HOME: home, TG_EVENTS_DB: eventsDb } })
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'outbound');
  // The db is shared with the earlier sends in this file, so the send under
  // test is the last row, not the only one.
  const last = rows.at(-1);
  assert.equal(last.convo, '-100777:1493');
  assert.equal(last.actor, 'tg-send.sh');
  assert.equal(last.payload.message_id, String(fake.state.nextId - 1));
  assert.equal(last.payload.parsed, true);
  assert.equal(last.payload.bytes, fs.statSync(f).size);
  // The guest classifier's view of the bot's own words (src/guest-classify.ts).
  assert.equal(last.payload.text, fs.readFileSync(f, 'utf8').slice(0, 500));
});

// ------------------------------------------------------------------ split ---

const para = (word) => `${word} `.repeat(40).trim() + '.';
// Four blocks, ~1100 characters: over the 700 default, so the planner is asked.
const BLOCKS = [para('первое'), para('второе'), '```\nкод\n\nещё код\n```', para('четвёртое')];
const LONG = `${BLOCKS.join('\n\n')}\n`;
const okPlan = (groups) => ({ FAKE_PLANNER_RC: '0', FAKE_PLANNER_OUT: envelope(JSON.stringify({ groups })) });

test('split: a short text is one sendMessage and the planner is never called', async () => {
  const r = await send(['--chat', '-100777', '--text-file', textFile('short.txt', 'коротко\n\nи ещё абзац')]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.sent.length, 1);
  assert.equal(r.stdout.trim(), `ok=true message_id=${fake.state.nextId - 1}`);
  // Long but one block: nothing to group, so no model call either.
  const one = await send(['--chat', '-100777', '--text-file', textFile('one-block.txt', 'я'.repeat(1500))]);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(fake.state.sent.length, 2);
  assert.equal(plannerCount(), 0);
});

test('split: a long text goes as the planned parts, reply on the first only', async () => {
  const f = textFile('long.txt', LONG);
  const env = okPlan([[1, 2], [3], [4]]);
  const r = await send(['--chat', '-100777', '--thread', '1493', '--reply', '1686', '--text-file', f], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(plannerCount(), 1);
  assert.equal(fake.state.sent.length, 3);
  assert.deepEqual(
    fake.state.sent.map((s) => s.text),
    [`${BLOCKS[0]}\n\n${BLOCKS[1]}`, BLOCKS[2], BLOCKS[3]],
    'a part is its original blocks joined by one blank line',
  );
  assert.deepEqual(fake.state.sent.map((s) => s.reply_to_message_id), ['1686', undefined, undefined]);
  assert.deepEqual(fake.state.sent.map((s) => s.message_thread_id), ['1493', '1493', '1493']);
  const ids = [fake.state.nextId - 3, fake.state.nextId - 2, fake.state.nextId - 1];
  assert.equal(r.stdout.trim(), `ok=true message_id=${ids[0]} message_ids=${ids.join(',')} parts=3`);

  // The whole-text record: the same command again sends nothing.
  const again = await send(['--chat', '-100777', '--thread', '1493', '--reply', '1686', '--text-file', f], env);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.trim(), `already-sent message_id=${ids[0]} — NOT resending`);
  assert.equal(fake.state.sent.length, 3);
  assert.equal(plannerCount(), 1);
});

test('split: planner failure or a bad answer falls back, never fails', async () => {
  const bad = [
    { FAKE_PLANNER_RC: '1', FAKE_PLANNER_OUT: 'usage limit reached' },
    { FAKE_PLANNER_RC: '0', FAKE_PLANNER_OUT: envelope('сейчас разделю: [[1,2]]') },
    ...[[[1, 2], [4]], [[2, 1], [3, 4]], [[1, 2], [2, 3, 4]]].map((groups) => okPlan(groups)),
  ];
  for (const [i, env] of bad.entries()) {
    const f = textFile(`fb-${i}.txt`, `${LONG}вариант ${i}\n`);
    const before = fake.state.sent.length;
    const r = await send(['--chat', '-100777', '--text-file', f], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /planner fallback/);
    // Under 4096: one message, the turn's own bytes.
    assert.equal(fake.state.sent.length, before + 1);
    assert.equal(fake.state.sent.at(-1).text, fs.readFileSync(f, 'utf8'));
    assert.match(r.stdout.trim(), /^ok=true message_id=\d+$/);
  }
});

test('split: a fallback over 4096 characters is packed by blocks', async () => {
  // Three ~1920-character blocks: 5764 in all, so the whole does not fit.
  const big = [para('слово').repeat(8), para('фраза').repeat(8), para('мысль').repeat(8)];
  assert.ok(big.join('\n\n').length > 4096);
  const r = await send(['--chat', '1', '--text-file', textFile('big-split.txt', big.join('\n\n'))]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /planner fallback/);
  assert.ok(fake.state.sent.length >= 2);
  for (const s of fake.state.sent) assert.ok([...s.text].length <= 4000, `${[...s.text].length} characters`);
  assert.equal(fake.state.sent.map((s) => s.text).join('\n\n'), big.join('\n\n'));
  assert.match(r.stdout.trim(), new RegExp(`parts=${fake.state.sent.length}$`));
});

test('split: part 2 fails, the re-run sends from part 2 and never re-sends part 1', async () => {
  const f = textFile('partial.txt', LONG);
  const args = ['--chat', '-100777', '--reply', '1686', '--text-file', f];
  const env = okPlan([[1], [2], [3, 4]]);
  // Fail the second sendMessage: arm the fake once the first one has landed.
  const run = send(args, { ...env, TG_SPLIT_PAUSE: '0.5' });
  while (fake.state.sent.length < 1) await new Promise((r) => setTimeout(r, 10));
  fake.state.failNext.sendMessage = 1;
  const first = await run;
  assert.equal(first.code, 1, first.stderr);
  assert.match(first.stderr, /part 2 of 3 NOT sent/);
  assert.equal(fake.state.sent.length, 1);
  const part1Id = fake.state.nextId - 1;

  // The failed part left its own .inflight marker: the re-run refuses there…
  const refused = await send(args, env);
  assert.equal(refused.code, 3);
  assert.equal(fake.state.sent.length, 1, 'part 1 was re-sent');
  // …until the owner has verified it is not in the chat and removed it.
  for (const m of markers()) fs.rmSync(path.join(state, m));

  // A different cut from the model now must not matter: the plan is cached.
  const rerun = await send(args, okPlan([[1, 2, 3, 4]]));
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(plannerCount(), 1, 'the cached plan was not reused');
  assert.deepEqual(fake.state.sent.map((s) => s.text), [BLOCKS[0], BLOCKS[1], `${BLOCKS[2]}\n\n${BLOCKS[3]}`]);
  assert.equal(fake.state.sent[0].reply_to_message_id, '1686');
  assert.equal(fake.state.sent[1].reply_to_message_id, undefined);
  const ids = [part1Id, fake.state.nextId - 2, fake.state.nextId - 1];
  assert.equal(rerun.stdout.trim(), `ok=true message_id=${ids[0]} message_ids=${ids.join(',')} parts=3`);

  const third = await send(args, env);
  assert.match(third.stdout, /^already-sent message_id=/);
  assert.equal(fake.state.sent.length, 3);
});

test('split: --no-split sends one message, --plan-only sends nothing', async () => {
  const f = textFile('whole.txt', LONG);
  const r = await send(['--chat', '1', '--no-split', '--text-file', f], okPlan([[1], [2, 3, 4]]));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.sent.length, 1);
  assert.equal(fake.state.sent[0].text, LONG);
  assert.equal(plannerCount(), 0);

  const callsBefore = fake.state.methods.length;
  const p = await send(['--chat', '2', '--plan-only', '--text-file', f], okPlan([[1], [2, 3, 4]]));
  assert.equal(p.code, 0, p.stderr);
  assert.equal(fake.state.methods.length, callsBefore);
  const plan = JSON.parse(p.stdout);
  assert.equal(plan.source, 'model');
  assert.deepEqual(plan.groups, [[1], [2, 3, 4]]);
  assert.deepEqual(plan.parts, [BLOCKS[0], BLOCKS.slice(1).join('\n\n')]);
  assert.equal(records().length, 1, '--plan-only wrote state');
});
