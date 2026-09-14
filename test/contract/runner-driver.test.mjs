// runner-driver.test.mjs — a session driver that REJECTS must not leave a
// topic unanswered.
//
// Every other suite drives the daemon the way the world does: `node
// src/runner.mjs`, with a fake `claude` on PATH. That path cannot produce this
// failure — ClaudeHeadlessDriver maps a dead child into a failed TurnOutcome and
// never rejects. Only a driver handed in from OUTSIDE can: RunnerDeps.driver,
// i.e. the plugin host's ctx.driver. So this case starts the daemon in-process
// through startRunner() and gives it a driver whose prompt() throws.
//
// What that used to cost: the scheduler worker logged `turn threw:` and that
// was all. The owner saw nothing, the message stayed 'in-turn' in the claims
// registry, and with no closing row in the event log the next daemon start
// re-queued it (CLOSING_KINDS in events.ts). The three assertions below are
// exactly those three consequences.
//
// Hermetic: the same fake Bot API runner-e2e uses (helpers.mjs), a temp config
// root, and a temp claims/events database. Both databases resolve their path
// from the process environment when their module is FIRST imported, so the env
// is set before src/ is loaded — hence the dynamic imports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { rmDir, ROOT, runSrc, startFakeTelegram, tmpDir, waitFor } from './helpers.mjs';

const TOKEN = '123456:TEST-TOKEN';
const OWNER_ID = 424242;
const CHAT_ID = -1007770009;
const THREAD_ID = 11;
const CONVO = `${CHAT_ID}:${THREAD_ID}`;
const MSG_ID = 909;
// What the driver throws. It has to survive into all three records, so it is
// distinctive rather than pretty.
const BOOM = 'driver refused: no session backend';

const tmp = tmpDir('runner-driver');
const CFG = path.join(tmp, '.config', 'tg-orchestrator');
const CLAIMS_DB = path.join(tmp, 'claims.sqlite');
const EVENTS_DB = path.join(tmp, 'events.sqlite');
fs.mkdirSync(CFG, { recursive: true });
fs.writeFileSync(path.join(CFG, 'env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\nOWNER_ID=${OWNER_ID}\n`);
process.env.CLAIMS_DB = CLAIMS_DB;
process.env.TG_EVENTS_DB = EVENTS_DB;

const { startRunner } = await import('../../src/runner.ts');
const { openDb } = await import('../../src/claims.ts');
// The sentence the owner is shown comes from the catalogue, never from a copy.
const { en } = await import('../../src/i18n/en.ts');

after(() => rmDir(tmp));

// open() succeeds, prompt() rejects: the shape of a backend that accepted the
// session and then died — and the shape ClaudeHeadlessDriver never has.
const rejectingDriver = {
  name: 'claude-headless',
  open: (spec) => Promise.resolve({ id: 'fake-session', state: 'idle', transcript: null, spec }),
  prompt: () => Promise.reject(new Error(BOOM)),
  last: () => Promise.resolve(null),
  list: () => Promise.resolve([]),
  abort: () => Promise.resolve(),
};

const ownerMsg = {
  message_id: MSG_ID,
  from: { id: OWNER_ID, is_bot: false, first_name: 'Sasha' },
  chat: { id: CHAT_ID, type: 'supergroup', title: 'dev' },
  message_thread_id: THREAD_ID,
  text: 'посмотри логи',
};

const eventRows = () => {
  const r = runSrc('events.mjs', ['tail', '--json'], { env: { HOME: tmp, TG_EVENTS_DB: EVENTS_DB } });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

test('a driver that rejects: the ⚠️ in the topic, the claim settled, turn_fail recorded', async () => {
  const tg = await startFakeTelegram({ token: TOKEN });
  const lines = [];
  const registry = openDb(CLAIMS_DB);
  let runner = null;
  try {
    runner = await startRunner({
      configRoot: CFG,
      repoRoot: ROOT,
      driver: rejectingDriver,
      log: (line) => lines.push(line),
      // TG_BURST_SETTLE_MS is process-env only (config.ts SOURCES): a settle
      // window of minutes would make this case a minutes-long test.
      processEnv: {
        TG_API_BASE_URL: tg.base,
        TG_BURST_SETTLE_MS: '1',
        TG_BURST_WINDOW_MAX_MS: '500',
        TG_LOCALE: 'en',
      },
      // In-process: a refusal must fail the case, never take the test runner
      // down with it — and shutdown() ends with exit(0) on the happy path too.
      exit: () => undefined,
      stderr: (line) => lines.push(line),
    });
    assert.ok(
      lines.some((l) => l.includes('tg-orchestrator up:')),
      `the daemon did not start: ${lines.join('\n')}`
    );

    tg.push(ownerMsg);

    // (1) the owner is told. Without it the topic is simply silent: the message
    // was read, the turn died, and nothing was ever posted back.
    const sent = await waitFor('the failure notice in the topic', () => tg.state.sent[0]);
    assert.equal(sent.chat_id, CHAT_ID);
    assert.equal(sent.message_thread_id, THREAD_ID);
    assert.equal(sent.text, en.turn.failed.split('{{error}}').join(BOOM));

    // (2) the claim is settled. A message left 'in-turn' is a message the
    // registry still shows as being worked on by a turn that is long gone.
    const row = await waitFor('the claim to be settled', () => {
      const r = registry
        .prepare('SELECT status, note FROM message_claims WHERE chat_id = ? AND message_id = ?')
        .get(CHAT_ID, MSG_ID);
      return r && r.status !== 'held' ? r : null;
    });
    assert.equal(row.status, 'done');
    assert.equal(row.note, `failed: ${BOOM}`);

    // (3) the inbound event is CLOSED. turn_fail is one of CLOSING_KINDS, so
    // this is what stops the next daemon start from re-queueing the message.
    const fails = eventRows().filter((e) => e.kind === 'turn_fail');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].convo, CONVO);
    assert.equal(fails[0].msgId, MSG_ID);
    assert.equal(fails[0].payload.ok, false);
    assert.equal(fails[0].payload.error, BOOM);
    assert.equal(fails[0].payload.kind, 'msgs');
    assert.deepEqual(eventRows().filter((e) => e.kind === 'turn_result'), []);
  } finally {
    registry.close();
    await runner?.drain();
    await tg.stop();
  }
});
