// live-status.test.ts — the one message a running turn keeps in its topic.
//
// The clock and the ticker are both injected (`now`, `manual: true`), so every
// case here is deterministic: no timers, no waiting, and the assertions are
// about the CALLS the channel received — which is the whole contract with
// Telegram.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLiveStatus,
  describeTool,
  elapsedLabel,
  renderStatus,
  type StatusChannel,
  type StatusPhrases,
} from '../src/live-status.ts';

const PHRASES: StatusPhrases = {
  head: 'W {{elapsed}} / {{steps}}',
  thinking: 'thinking',
  before: 'before: {{items}}',
  agents: 'agents ({{count}}): {{items}}',
  actions: {
    read: 'reading {{target}}',
    edit: 'editing {{target}}',
    run: 'running: {{target}}',
    search: 'searching for {{target}}',
    web: 'web: {{target}}',
    agent: 'agent: {{target}}',
    message: 'messaging {{target}}',
    plan: 'planning',
    skill: 'skill {{target}}',
    telegram: 'telegram: {{target}}',
    mcp: 'mcp {{target}}',
    tool: '{{target}}',
  },
};

type Call = { readonly kind: 'post' | 'edit' | 'remove'; readonly text: string };

function fakeChannel(o: { postId?: number | null; editFails?: string } = {}): {
  channel: StatusChannel;
  calls: Call[];
} {
  const calls: Call[] = [];
  const channel: StatusChannel = {
    post: (text: string): Promise<number | null> => {
      calls.push({ kind: 'post', text });
      return Promise.resolve(o.postId === undefined ? 77 : o.postId);
    },
    edit: (_id: number, text: string): Promise<void> => {
      calls.push({ kind: 'edit', text });
      return o.editFails === undefined ? Promise.resolve() : Promise.reject(new Error(o.editFails));
    },
    remove: (_id: number): Promise<void> => {
      calls.push({ kind: 'remove', text: '' });
      return Promise.resolve();
    },
  };
  return { channel, calls };
}

const clock = (): { now: () => number; at: (ms: number) => void } => {
  let value = 1_000_000;
  const start = value;
  return { now: (): number => value, at: (ms: number): void => void (value = start + ms) };
};

const live = (channel: StatusChannel, now: () => number) =>
  createLiveStatus({ channel, phrases: PHRASES, now, manual: true, firstDelayMs: 8000 });

test('describeTool names the thing, not the call', () => {
  assert.deepEqual(describeTool('Read', { file_path: '/a/b/runner.ts' }), {
    kind: 'read',
    target: 'runner.ts',
  });
  assert.deepEqual(describeTool('Edit', { file_path: 'src/config.ts' }), {
    kind: 'edit',
    target: 'config.ts',
  });
  // The human sentence the caller already wrote wins over the command itself.
  assert.deepEqual(describeTool('Bash', { command: 'git log --oneline', description: 'Read git log' }), {
    kind: 'run',
    target: 'Read git log',
  });
  assert.deepEqual(describeTool('Bash', { command: 'ls -la' }), { kind: 'run', target: 'ls -la' });
  assert.deepEqual(describeTool('Grep', { pattern: 'editMessageText' }), {
    kind: 'search',
    target: 'editMessageText',
  });
  assert.deepEqual(describeTool('WebFetch', { url: 'https://core.telegram.org/bots/api#editmessagetext' }), {
    kind: 'web',
    target: 'core.telegram.org',
  });
  assert.deepEqual(describeTool('Task', { description: 'map the send layer', subagent_type: 'Explore' }), {
    kind: 'agent',
    target: 'map the send layer',
  });
  assert.deepEqual(describeTool('mcp__telegram__transcribe_voice', {}), {
    kind: 'telegram',
    target: 'transcribe_voice',
  });
  assert.deepEqual(describeTool('mcp__claude_ai_Gmail__send_message', {}), {
    kind: 'mcp',
    target: 'claude_ai_Gmail: send_message',
  });
  assert.deepEqual(describeTool('TodoWrite', {}), { kind: 'plan', target: '' });
  // A phrase that names a target and is given none would read as a dangling
  // colon, so the tool's own name stands in.
  assert.deepEqual(describeTool('Read', {}), { kind: 'tool', target: 'Read' });
  assert.deepEqual(describeTool('SomethingNew', {}), { kind: 'tool', target: 'SomethingNew' });
});

test('elapsedLabel reads like a stopwatch', () => {
  assert.equal(elapsedLabel(0), '0:00');
  assert.equal(elapsedLabel(9_400), '0:09');
  assert.equal(elapsedLabel(222_000), '3:42');
  assert.equal(elapsedLabel(3_723_000), '1:02:03');
});

test('renderStatus stacks head, now, trail and agents', () => {
  const text = renderStatus(
    {
      elapsedMs: 222_000,
      steps: 47,
      now: { kind: 'edit', target: 'runner.ts' },
      before: [
        { kind: 'read', target: 'turn.ts' },
        { kind: 'search', target: 'onEvent' },
      ],
      agents: ['map the send layer', 'status history'],
    },
    PHRASES
  );
  assert.equal(
    text,
    [
      'W 3:42 / 47',
      'editing runner.ts',
      'before: reading turn.ts · searching for onEvent',
      'agents (2): map the send layer, status history',
    ].join('\n')
  );
  // Nothing has happened yet: one line of header and the thinking line.
  assert.equal(
    renderStatus({ elapsedMs: 3_000, steps: 0, now: null, before: [], agents: [] }, PHRASES),
    'W 0:03 / 0\nthinking'
  );
});

test('a short turn never gets a message at all', async () => {
  const { channel, calls } = fakeChannel();
  const c = clock();
  const status = live(channel, c.now);
  status.onEvent({ kind: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } });
  c.at(4_000);
  await status.tick();
  await status.done();
  assert.deepEqual(calls, []);
});

test('posts once the turn is slow, edits in place, deletes at the end', async () => {
  const { channel, calls } = fakeChannel();
  const c = clock();
  const status = live(channel, c.now);
  status.onEvent({ kind: 'tool_use', name: 'Read', input: { file_path: 'src/runner.ts' } });
  c.at(9_000);
  await status.tick();
  // The same tick text twice is not an edit: Telegram answers those with a 400.
  await status.tick();
  status.onEvent({ kind: 'tool_use', name: 'Task', input: { description: 'send layer' } });
  c.at(14_000);
  await status.tick();
  await status.done();

  assert.deepEqual(
    calls.map((call) => call.kind),
    ['post', 'edit', 'remove']
  );
  assert.equal(calls[0]?.text, 'W 0:09 / 1\nreading runner.ts');
  assert.equal(
    calls[1]?.text,
    ['W 0:14 / 2', 'agent: send layer', 'before: reading runner.ts', 'agents (1): send layer'].join('\n')
  );
});

test('a send that fails switches the status off for the whole turn', async () => {
  const { channel, calls } = fakeChannel({ postId: null });
  const c = clock();
  const status = live(channel, c.now);
  c.at(9_000);
  await status.tick();
  c.at(20_000);
  await status.tick();
  await status.done();
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['post']
  );
});

test('a message the owner deleted stops the ticker instead of being retried', async () => {
  const { channel, calls } = fakeChannel({ editFails: 'editMessageText: 400 Bad Request: message to edit not found' });
  const c = clock();
  const lines: string[] = [];
  const status = createLiveStatus({
    channel,
    phrases: PHRASES,
    now: c.now,
    manual: true,
    firstDelayMs: 8000,
    log: (line: string): void => void lines.push(line),
  });
  c.at(9_000);
  await status.tick();
  c.at(15_000);
  await status.tick();
  c.at(21_000);
  await status.tick();
  await status.done();
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['post', 'edit']
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /message to edit not found/);
});

test('done() waits for a post that is still in flight, then deletes it', async () => {
  const calls: Call[] = [];
  let release = (): void => {};
  const channel: StatusChannel = {
    post: (text: string): Promise<number | null> => {
      calls.push({ kind: 'post', text });
      return new Promise<number | null>((resolve) => {
        release = (): void => resolve(91);
      });
    },
    edit: (_id: number, text: string): Promise<void> => {
      calls.push({ kind: 'edit', text });
      return Promise.resolve();
    },
    remove: (_id: number): Promise<void> => {
      calls.push({ kind: 'remove', text: '' });
      return Promise.resolve();
    },
  };
  const c = clock();
  const status = live(channel, c.now);
  c.at(9_000);
  const posting = status.tick();
  // Let the queued write actually enter `post()` — done() before that point is
  // a turn that ended too fast to deserve a status at all, which case 4 pins.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ending = status.done();
  release();
  await posting;
  await ending;
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['post', 'remove']
  );
});
