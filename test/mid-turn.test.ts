// node --test mid-turn.test.ts
//
// Mid-turn input (TG_MIDTURN_INPUT): the port a running turn reads new owner
// messages from, the split of what it took into absorbed and owed, the label
// a topic's turn carries, and the event log leaving an absorbed message owed
// until its turn's result row. The runner's wiring of these is behind the switch; with it off,
// test/turn.test.ts pins that a turn is what it always was.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fakeClaude, type FakeClaude, type FakeScript, type TurnInput } from '@tagents/core';
import { EVENT_KINDS, openEvents, orphanedInbound, record } from '../src/events.ts';
import {
  createInputPort,
  injectedText,
  injectionId,
  MID_TURN_NOTICE,
  splitDelivered,
} from '../src/mid-turn.ts';
import { runClaude, topicLabel, TURN_LABEL } from '../src/turn.ts';

let tmp = '';
const fakes: FakeClaude[] = [];

function fake(script: FakeScript): string {
  const f = fakeClaude(script);
  fakes.push(f);
  return f.bin;
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mid-turn-test-')));
  // Keep the driver off the real ~/.claude/agent-state, like turn.test.ts.
  process.env['TA_STATE_DIR'] = path.join(tmp, 'agent-state');
});
after(() => {
  for (const f of fakes) f.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Item = TurnInput & { readonly n: number };
const item = (n: number): Item => ({ id: `i${n}`, text: `text ${n}`, n });

// ------------------------------------------------------------------ port ---

test('an item offered before the reader asks is handed over on its next()', async () => {
  const port = createInputPort<Item>();
  assert.equal(port.offer(item(1)), true);
  const it = port.input[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { done: false, value: item(1) });
  assert.equal(port.isOpen(), true);
  assert.deepEqual(port.close(), [{ item: item(1), pulled: true }]);
});

test('a reader already waiting gets an item the moment it is offered', async () => {
  const port = createInputPort<Item>();
  const it = port.input[Symbol.asyncIterator]();
  const pending = it.next();
  port.offer(item(2));
  assert.deepEqual(await pending, { done: false, value: item(2) });
});

test('return() ends a waiting next() and the port refuses every later offer', async () => {
  const port = createInputPort<Item>();
  const it = port.input[Symbol.asyncIterator]();
  const pending = it.next();
  await it.return?.();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(port.isOpen(), false);
  assert.equal(port.offer(item(3)), false, 'an item offered after the turn stopped reading is refused');
  assert.deepEqual(port.close(), [], 'a refused item was never offered');
});

test('close() reports an item the reader never took as not pulled', () => {
  const port = createInputPort<Item>();
  port.offer(item(4));
  assert.deepEqual(port.close(), [{ item: item(4), pulled: false }]);
  assert.equal(port.offer(item(5)), false);
});

// ----------------------------------------------------------------- split ---

test('only an item claude echoed back is absorbed; everything else is owed', () => {
  const offered = [
    { item: item(1), pulled: true },
    { item: item(2), pulled: true },
    { item: item(3), pulled: false },
  ];
  const delivered = [
    { id: 'i1', replayed: true },
    { id: 'i2', replayed: false },
  ];
  assert.deepEqual(splitDelivered(offered, delivered), { absorbed: [item(1)], owed: [item(2), item(3)] });
  assert.deepEqual(
    splitDelivered(offered, undefined),
    { absorbed: [], owed: [item(1), item(2), item(3)] },
    'no delivered list (a driver that threw) means nothing was read'
  );
});

// ------------------------------------------------------------------ text ---

test('an injected batch is the rendered messages under one English notice line', () => {
  assert.ok(!MID_TURN_NOTICE.includes('\n'), 'the notice is one line');
  assert.match(MID_TURN_NOTICE, /reply_to_message_id/);
  assert.match(MID_TURN_NOTICE, /will not be delivered to you again/);
  assert.equal(injectedText('[msg 7] hi'), `${MID_TURN_NOTICE}\n\n[msg 7] hi`);
  assert.equal(injectionId([7, 8]), 'm7-8');
});

test('a topic label names the thread, or the chat where there is none', () => {
  assert.equal(topicLabel('-1001:42'), `${TURN_LABEL}:42`);
  assert.equal(topicLabel('555:0'), `${TURN_LABEL}:555`);
});

// ------------------------------------------------------------ events log ---

test('the three mid-turn kinds are known, and none of them closes a message', (t) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openEvents(path.join(dir, 'events.sqlite'));
  for (const kind of ['msg_injected', 'msg_absorbed', 'msg_requeued'] as const) {
    assert.ok(EVENT_KINDS.includes(kind), kind);
  }
  const inbound = (msgId: number): void => {
    record(db, 'inbound', { convo: '1:2', msgId, payload: { message_id: msgId, text: `m${msgId}` } });
  };
  inbound(10);
  record(db, 'msg_injected', { convo: '1:2', msgId: 10, payload: { id: 'm10' } });
  record(db, 'msg_absorbed', { convo: '1:2', msgId: 10, payload: { id: 'm10' } });
  inbound(11);
  record(db, 'msg_injected', { convo: '1:2', msgId: 11, payload: { id: 'm11' } });
  record(db, 'msg_requeued', { convo: '1:2', msgId: 11, payload: { id: 'm11' } });
  assert.deepEqual(
    orphanedInbound(db).map((r) => r.msgId),
    [10, 11],
    'no mid-turn row closes a message: a daemon dying mid-turn leaves both for recovery'
  );
  record(db, 'turn_result', { convo: '1:2', msgId: 10, payload: {} });
  assert.deepEqual(
    orphanedInbound(db).map((r) => r.msgId),
    [11],
    'the absorbing turn\'s own result row closes an absorbed message; a requeued one is still owed'
  );
});

// ------------------------------------------------------------------ turn ---

test('a turn with input: the prompt goes through stdin, and the attempt says what was echoed', async () => {
  const argvFile = path.join(tmp, 'argv-input.json');
  const linesFile = path.join(tmp, 'lines-input.txt');
  const bin = fake({ argvFile, sleepMs: 400, stdin: { linesFile }, result: { text: 'done' } });
  const port = createInputPort<Item>();
  const replays: string[] = [];
  const turn = runClaude({
    prompt: 'go',
    bin,
    cwd: tmp,
    label: topicLabel('1:42'),
    input: port.input,
    onEvent: (e) => {
      if (e.kind === 'replay') replays.push(e.id);
    },
  });
  port.offer(item(1));
  const attempt = await turn;
  assert.equal(attempt.ok, true);
  assert.deepEqual(attempt.delivered, [{ id: 'i1', replayed: true }]);
  assert.deepEqual(replays, ['i1']);
  assert.deepEqual(splitDelivered(port.close(), attempt.delivered), { absorbed: [item(1)], owed: [] });
  assert.equal(port.offer(item(2)), false, 'the driver stopped reading when the turn ended');
  const seen: { argv: string[]; env: Record<string, string>; stdin: string } = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(seen.env['TA_LABEL'], `${TURN_LABEL}:42`);
  assert.ok(seen.argv.includes('--input-format'));
  assert.ok(!seen.argv.includes('go'), 'the prompt is not in argv');
  assert.equal(fs.readFileSync(linesFile, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('a turn without input is unchanged: prompt in argv, no stdin, no delivered', async () => {
  const argvFile = path.join(tmp, 'argv-plain.json');
  const bin = fake({ argvFile, result: { text: 'done' } });
  const attempt = await runClaude({ prompt: 'go', bin, cwd: tmp });
  assert.equal(attempt.ok, true);
  assert.ok(!('delivered' in attempt));
  const seen: { argv: string[]; env: Record<string, string>; stdin: string } = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(seen.argv.at(-1), 'go');
  assert.equal(seen.stdin, 'null');
  assert.equal(seen.env['TA_LABEL'], TURN_LABEL);
});
