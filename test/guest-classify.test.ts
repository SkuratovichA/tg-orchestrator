// node --test guest-classify.test.ts
//
// The silent gate in front of a guest's message (TG_GUESTS): `bot` wakes the
// agent, `owner` is closed without a trace in the chat. What is pinned here is
// the direction every doubt falls — a model that fails, stalls or babbles must
// read as `owner`, because a false wake hands a third party's words to an agent
// that runs with permissions off — and the shape of the one cheap call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { EventRecord, JsonValue } from '../src/events.ts';
import {
  CLASSIFIER_ARGS,
  classifierPrompt,
  classifyGuest,
  guestShortcut,
  recentFromEvents,
  type GuestClassifyInput,
} from '../src/guest-classify.ts';
import { haikuArgs } from '../src/haiku.ts';
import { plan } from '../src/split-plan.ts';

const OWNER = 424242;
const GUEST = 777001;
const BOT = 999000;

let dir: string;
before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guest-classify-')));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const envelope = (result: string): string => JSON.stringify({ type: 'result', is_error: false, result });

// A fake `claude`: records its argv (NUL-separated, so the empty `--tools ''`
// survives) and its stdin, then prints `out` and exits with `rc`.
let seq = 0;
function fakeBin(out: string, rc = 0, sleepS = 0): { bin: string; args: () => string[]; stdin: () => string } {
  const d = path.join(dir, `case-${++seq}`);
  fs.mkdirSync(d);
  const outFile = path.join(d, 'out');
  fs.writeFileSync(outFile, out);
  const bin = path.join(d, 'claude');
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env bash\n' +
      `printf '%s\\0' "$@" > '${d}/args'\n` +
      `cat > '${d}/stdin'\n` +
      (sleepS ? `exec sleep ${sleepS}\n` : '') +
      `cat '${outFile}'\nexit ${rc}\n`,
    { mode: 0o755 }
  );
  return {
    bin,
    args: () => fs.readFileSync(path.join(d, 'args'), 'utf8').split('\0').slice(0, -1),
    stdin: () => fs.readFileSync(path.join(d, 'stdin'), 'utf8'),
  };
}

const input = (extra: Partial<GuestClassifyInput> = {}): GuestClassifyInput => ({
  message: { message_id: 50, text: 'а как думаешь, завтра дождь будет?' },
  guestId: GUEST,
  guestName: 'Alice Guest',
  ownerId: OWNER,
  botId: BOT,
  botUsername: 'helper_bot',
  recent: [],
  ...extra,
});
const OPTS = { timeoutMs: 5_000 };

test('a reply to the bot and an @mention are answered without a model', async () => {
  const never = fakeBin(envelope('{"to":"owner"}'));
  const reply = input({ message: { message_id: 1, text: 'да, давай', reply_to_message: { text: 'Сделать?', from: { id: BOT } } } });
  assert.deepEqual(await classifyGuest(reply, { ...OPTS, bin: never.bin }), { to: 'bot', via: 'shortcut', reason: 'reply to the bot', ms: 0 });
  const mention = input({ message: { message_id: 2, text: '@Helper_Bot глянь погоду' } });
  assert.equal((await classifyGuest(mention, { ...OPTS, bin: never.bin })).via, 'shortcut');
  assert.equal(fs.existsSync(path.join(path.dirname(never.bin), 'args')), false, 'the model was never asked');
  // Not shortcuts: a reply to the owner, a longer username, no username known.
  assert.equal(guestShortcut(input({ message: { message_id: 3, text: 'ок', reply_to_message: { from: { id: OWNER } } } })), null);
  assert.equal(guestShortcut(input({ message: { message_id: 4, text: '@helper_bot_old привет' } })), null);
  assert.equal(guestShortcut(input({ botUsername: null, botId: null, message: { message_id: 5, text: '@helper_bot' } })), null);
});

test('the model decides the rest: bot and owner are taken as they come', async () => {
  const bot = fakeBin(envelope('{"to":"bot"}'));
  assert.deepEqual(
    { ...(await classifyGuest(input(), { ...OPTS, bin: bot.bin })), ms: 0 },
    { to: 'bot', via: 'haiku', reason: null, ms: 0 }
  );
  const owner = fakeBin(envelope('Sure! {"to":"owner"}'));
  const d = await classifyGuest(input(), { ...OPTS, bin: owner.bin });
  assert.equal(d.to, 'owner');
  assert.equal(d.via, 'haiku');
});

test('every failure is owner, with the reason kept', async () => {
  const cases: Array<[string, ReturnType<typeof fakeBin>, RegExp]> = [
    ['garbage', fakeBin(envelope('I think the bot, probably')), /no JSON/],
    ['not a verdict', fakeBin(envelope('{"to":"everyone"}')), /not a verdict/],
    ['model error', fakeBin(JSON.stringify({ is_error: true, result: 'usage limit' })), /model error/],
    ['unparsable envelope', fakeBin('not json at all'), /unparsable envelope/],
    ['non-zero exit', fakeBin('boom', 3), /rc=3/],
  ];
  for (const [name, fake, reason] of cases) {
    const d = await classifyGuest(input(), { ...OPTS, bin: fake.bin });
    assert.equal(d.to, 'owner', name);
    assert.equal(d.via, 'error', name);
    assert.match(d.reason ?? '', reason, name);
  }
  const missing = await classifyGuest(input(), { ...OPTS, bin: path.join(dir, 'no-such-claude') });
  assert.equal(missing.to, 'owner');
  assert.equal(missing.via, 'error');
});

test('a stalled model is killed at the timeout and reads as owner', async () => {
  const slow = fakeBin(envelope('{"to":"bot"}'), 0, 10);
  const t0 = Date.now();
  const d = await classifyGuest(input(), { bin: slow.bin, timeoutMs: 400 });
  assert.equal(d.to, 'owner');
  assert.match(d.reason ?? '', /timed out after 400 ms/);
  assert.ok(Date.now() - t0 < 5_000, 'did not wait for the stalled child');
});

test('one cheap call: haiku, low effort, no settings, no tools — the planner’s shape plus the effort', async () => {
  const fake = fakeBin(envelope('{"to":"owner"}'));
  await classifyGuest(input(), { ...OPTS, bin: fake.bin });
  const args = fake.args();
  assert.deepEqual(args, [...CLASSIFIER_ARGS]);
  for (const [flag, value] of [['--model', 'haiku'], ['--effort', 'low'], ['--setting-sources', ''], ['--tools', ''], ['--output-format', 'json']]) {
    assert.equal(args[args.indexOf(flag ?? '') + 1], value, flag);
  }
  // The split planner (split-plan.ts) makes the same call without the effort;
  // both go through haikuArgs, and this keeps it that way.
  const planner = fakeBin(envelope('{"groups":[[1],[2]]}'));
  plan('один\n\nдва', { minChars: 0, bin: planner.bin, log: () => {} });
  const withoutEffort = args.filter((_, i) => i !== args.indexOf('--effort') && i !== args.indexOf('--effort') + 1);
  const pa = planner.args();
  assert.deepEqual(withoutEffort.slice(0, -1), pa.slice(0, -1), 'same flags, only the system prompt differs');
  assert.deepEqual(haikuArgs('S'), [...pa.slice(0, -1), 'S']);
});

test('the prompt carries who is who, the reply-to and the recent chat', async () => {
  const fake = fakeBin(envelope('{"to":"owner"}'));
  const recent = [
    { role: 'owner' as const, name: 'Owen', text: 'Вика, ты завтра на трек?' },
    { role: 'bot' as const, name: null, text: 'Напоминаю: шины 5 бар.' },
  ];
  const msg = { message_id: 9, text: 'а мне сколько качать?', reply_to_message: { text: 'Напоминаю: шины 5 бар.', from: { id: OWNER } } };
  await classifyGuest(input({ message: msg, recent }), { ...OPTS, bin: fake.bin });
  const prompt = fake.stdin();
  assert.equal(prompt, classifierPrompt(input({ message: msg, recent })));
  assert.match(prompt, /The OWNER is Owen\. .* The GUEST is Alice Guest\./);
  assert.match(prompt, /\[OWNER Owen\] Вика, ты завтра на трек\?\n\[BOT\] Напоминаю: шины 5 бар\./);
  assert.match(prompt, /a reply to a message by the OWNER: "Напоминаю: шины 5 бар\."/);
  assert.match(prompt, /The GUEST's new message:\nа мне сколько качать\?$/);
  const long = 'x'.repeat(1000);
  const clipped = classifierPrompt(input({ message: { message_id: 10, text: 'да', reply_to_message: { text: long, from: { id: BOT } } } }));
  assert.ok(clipped.includes(`by the BOT: "${'x'.repeat(300)}…"`), 'reply-to is cut at 300 characters');
});

const row = (seqNo: number, kind: string, msgId: number | null, payload: JsonValue): EventRecord => ({
  seq: seqNo,
  at: seqNo,
  v: 1,
  kind,
  convo: '-100:0',
  msgId,
  updateId: null,
  actor: 'test',
  payload,
});

test('recent context: inbound and outbound before the message, the last eight, nothing after', () => {
  const rows: EventRecord[] = [];
  for (let i = 1; i <= 6; i++) rows.push(row(rows.length + 1, 'inbound', i, { message_id: i, text: `owner ${i}`, from: { id: OWNER, first_name: 'Owen' } }));
  rows.push(row(rows.length + 1, 'turn_start', null, { kind: 'msgs' }));
  rows.push(row(rows.length + 1, 'outbound', null, { message_id: '70', text: 'bot answer' }));
  rows.push(row(rows.length + 1, 'outbound', null, { message_id: '71', chars: 10 })); // before tg-send.sh sent text
  rows.push(row(rows.length + 1, 'inbound', 20, { message_id: 20, voice: { duration: 3 }, from: { id: GUEST } }));
  rows.push(row(rows.length + 1, 'inbound', 21, { message_id: 21, text: 'guest earlier', from: { id: GUEST }, x_guest: { id: GUEST, name: 'Alice Guest' } }));
  rows.push(row(rows.length + 1, 'inbound', 22, { message_id: 22, text: 'THE message', from: { id: GUEST }, x_guest: { id: GUEST, name: 'Alice Guest' } }));
  rows.push(row(rows.length + 1, 'inbound', 23, { message_id: 23, text: 'after it', from: { id: OWNER } }));
  const lines = recentFromEvents(rows, { ownerId: OWNER, msgId: 22 });
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.at(0), { role: 'owner', name: 'Owen', text: 'owner 1' });
  assert.deepEqual(lines.slice(-2), [
    { role: 'bot', name: null, text: 'bot answer' },
    { role: 'guest', name: 'Alice Guest', text: 'guest earlier' },
  ]);
  assert.equal(recentFromEvents(rows, { ownerId: OWNER, msgId: 22 }, 3).length, 3);
});
