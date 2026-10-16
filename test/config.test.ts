// node --test config.test.ts
//
// config.ts took over the hand parsing runner.mjs used to do inline, so what
// matters here is that it kept every quirk: which source wins for which
// variable, which bad values fall back instead of failing, and the one
// sentence the daemon prints when the credentials are unusable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_BURST_SETTLE_MS,
  DEFAULT_BURST_WINDOW_MAX_MS,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_FALLBACK_MODEL,
  DEFAULT_CLAUDE_FALLBACK_TTL_MS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_TIMEOUT_MS,
  DEFAULT_AUTO_TOPIC,
  DEFAULT_FLUSH_WORDS,
  DEFAULT_LIVE_STATUS,
  DEFAULT_LOCALE,
  DEFAULT_MAX_PARALLEL_TURNS,
  DEFAULT_MIDTURN_INPUT,
  DEFAULT_PROPOSAL_TTL_MS,
  activeClaudeConfigDir,
  BAD_CONFIG_DIR_UNTIL_MESSAGE,
  BAD_GUESTS_MESSAGE,
  loadConfig,
  resolveLocale,
  MISCONFIG_MESSAGE,
  parseEnvFile,
  SOURCES,
  type Config,
} from '../src/config.ts';
import { DEFAULT_STATUS_DELAY_MS, DEFAULT_STATUS_INTERVAL_MS } from '../src/live-status.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

let dir: string;
let envFile: string;

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-')));
  envFile = path.join(dir, 'env');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const CREDS = ['TELEGRAM_BOT_TOKEN=123456:TEST-TOKEN', 'OWNER_ID=424242'];

function ok(lines: string[], processEnv: Record<string, string | undefined> = {}): Config {
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
  const result = loadConfig({ envFile, processEnv });
  assert.equal(result.kind, 'ok', `expected ok, got ${result.kind}`);
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result.config;
}

function refused(lines: string[], processEnv: Record<string, string | undefined> = {}): string {
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
  const result = loadConfig({ envFile, processEnv });
  assert.equal(result.kind, 'invalid', `expected invalid, got ${result.kind}`);
  if (result.kind !== 'invalid') throw new Error('unreachable');
  return result.message;
}

// ------------------------------------------------------------- env file ---

test('the env-file grammar is the daemon’s, quirks included', () => {
  const parsed = parseEnvFile(
    ['# a comment', '', '   ', 'A=1', 'B=x=y', '  C=spaced  ', 'A=2'].join('\n')
  );
  assert.deepEqual(parsed, { A: '2', B: 'x=y', C: 'spaced' });
});

test('a missing env file is its own answer, not an error', () => {
  const result = loadConfig({ envFile: path.join(dir, 'not-there'), processEnv: {} });
  assert.deepEqual(result, { kind: 'missing-env-file' });
});

// ---------------------------------------------------------- credentials ---

test('the credentials come only from the env file', () => {
  assert.equal(SOURCES.TELEGRAM_BOT_TOKEN, 'env-file');
  assert.equal(SOURCES.OWNER_ID, 'env-file');
  const config = ok(CREDS, {
    TELEGRAM_BOT_TOKEN: 'from-the-shell',
    OWNER_ID: '1',
  });
  assert.equal(config.token, '123456:TEST-TOKEN', 'an inherited shell must not supply the token');
  assert.equal(config.ownerId, 424242);
});

test('every unusable credential gets the one pinned sentence', () => {
  assert.equal(MISCONFIG_MESSAGE, 'env must define TELEGRAM_BOT_TOKEN and OWNER_ID');
  for (const lines of [
    ['OWNER_ID=1'],
    ['TELEGRAM_BOT_TOKEN=', 'OWNER_ID=1'],
    ['TELEGRAM_BOT_TOKEN=PASTE_TOKEN_HERE', 'OWNER_ID=1'],
    ['TELEGRAM_BOT_TOKEN=t'],
    ['TELEGRAM_BOT_TOKEN=t', 'OWNER_ID=0'],
    ['TELEGRAM_BOT_TOKEN=t', 'OWNER_ID='],
    ['TELEGRAM_BOT_TOKEN=t', 'OWNER_ID=nope'],
  ]) {
    assert.equal(refused(lines), MISCONFIG_MESSAGE, lines.join(' | '));
  }
});

// -------------------------------------------------------------- options ---

test('an env file with nothing but credentials prefaults every option', () => {
  const config = ok(CREDS);
  assert.deepEqual(config, {
    token: '123456:TEST-TOKEN',
    ownerId: 424242,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    claudeTimeoutMs: DEFAULT_CLAUDE_TIMEOUT_MS,
    maxParallelTurns: DEFAULT_MAX_PARALLEL_TURNS,
    burstSettleMs: DEFAULT_BURST_SETTLE_MS,
    burstWindowMaxMs: DEFAULT_BURST_WINDOW_MAX_MS,
    claudeModel: DEFAULT_CLAUDE_MODEL,
    claudeEffort: DEFAULT_CLAUDE_EFFORT,
    claudeFallbackModel: DEFAULT_CLAUDE_FALLBACK_MODEL,
    claudeFallbackTtlMs: DEFAULT_CLAUDE_FALLBACK_TTL_MS,
    claudeConfigDir: null,
    claudeConfigDirUntil: null,
    locale: DEFAULT_LOCALE,
    flushWords: [...DEFAULT_FLUSH_WORDS],
    autoTopic: DEFAULT_AUTO_TOPIC,
    learningTopic: null,
    proposalTtlMs: DEFAULT_PROPOSAL_TTL_MS,
    liveStatus: DEFAULT_LIVE_STATUS,
    liveStatusIntervalMs: DEFAULT_STATUS_INTERVAL_MS,
    liveStatusDelayMs: DEFAULT_STATUS_DELAY_MS,
  });
});

// --------------------------------------------------------------- stage S2 ---

test('TG_LOCALE: file, process env over file, and a typo that falls back', () => {
  assert.equal(SOURCES.TG_LOCALE, 'process-env-over-file');
  assert.equal(ok([...CREDS]).locale, 'en', 'unset is English — the new default');
  assert.equal(ok([...CREDS, 'TG_LOCALE=ru']).locale, 'ru');
  assert.equal(ok([...CREDS, 'TG_LOCALE=ru'], { TG_LOCALE: 'en' }).locale, 'en');
  assert.equal(
    ok([...CREDS, 'TG_LOCALE=klingon']).locale,
    DEFAULT_LOCALE,
    'an unknown locale is a cosmetic typo, not a reason to refuse to start'
  );
});

test('resolveLocale reads the same file with the same precedence, without credentials', () => {
  fs.writeFileSync(envFile, 'TG_LOCALE=ru\n');
  assert.equal(resolveLocale({ envFile, processEnv: {} }), 'ru', 'no token needed: status.mjs has none');
  assert.equal(resolveLocale({ envFile, processEnv: { TG_LOCALE: 'en' } }), 'en');
  assert.equal(
    resolveLocale({ envFile: path.join(dir, 'nope'), processEnv: {} }),
    DEFAULT_LOCALE,
    'a missing env file is the default locale, not a throw'
  );
  // ...and the two paths cannot disagree.
  assert.equal(resolveLocale({ envFile, processEnv: {} }), ok([...CREDS, 'TG_LOCALE=ru']).locale);
});

test('TG_FLUSH_WORDS: comma-separated, trimmed, lowercased, overridable', () => {
  assert.equal(SOURCES.TG_FLUSH_WORDS, 'process-env-over-file');
  assert.deepEqual(ok([...CREDS, 'TG_FLUSH_WORDS= GO , Answer ,,go']).flushWords, [
    'go',
    'answer',
    'go',
  ]);
  assert.deepEqual(ok([...CREDS, 'TG_FLUSH_WORDS=']).flushWords, [], 'no flush words is a choice');
  assert.deepEqual(ok([...CREDS, 'TG_FLUSH_WORDS=x'], { TG_FLUSH_WORDS: 'y' }).flushWords, ['y']);
});

test('there are no flush words by default — a reaction closes the window now', () => {
  // The words are input, not output, and they are no longer typed: reacting to
  // a pending message says «читай сейчас» without adding a message that then
  // has to be stripped out of the prompt. The mechanism stays for whoever wants
  // it back, which is what TG_FLUSH_WORDS is for.
  assert.deepEqual([...DEFAULT_FLUSH_WORDS], []);
  assert.deepEqual(ok(CREDS).flushWords, []);
  assert.deepEqual(ok([...CREDS, 'TG_FLUSH_WORDS=читай,го']).flushWords, ['читай', 'го']);
});

test('TG_AUTO_TOPIC: on by default, off only for the four ways of saying no', () => {
  assert.equal(SOURCES.TG_AUTO_TOPIC, 'process-env-over-file');
  assert.equal(ok(CREDS).autoTopic, true, 'unset is on');
  for (const value of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(ok([...CREDS, `TG_AUTO_TOPIC=${value}`]).autoTopic, false, value);
  }
  for (const value of ['1', 'true', 'on', 'yes', 'da', '']) {
    assert.equal(ok([...CREDS, `TG_AUTO_TOPIC=${value}`]).autoTopic, true, `"${value}" is not a no`);
  }
  assert.equal(
    ok([...CREDS, 'TG_AUTO_TOPIC=0'], { TG_AUTO_TOPIC: '1' }).autoTopic,
    true,
    'the process env wins over the file, like the other operator seams'
  );
});

test('TG_MIDTURN_INPUT: off by default, on only for the four ways of saying yes', () => {
  assert.equal(SOURCES.TG_MIDTURN_INPUT, 'process-env-over-file');
  assert.equal(DEFAULT_MIDTURN_INPUT, false);
  // Off is the key's absence, so a config without the switch is unchanged.
  assert.ok(!('midturnInput' in ok(CREDS)), 'unset is off');
  for (const value of ['0', 'false', 'off', 'no', 'OFF', 'da', '']) {
    assert.ok(!('midturnInput' in ok([...CREDS, `TG_MIDTURN_INPUT=${value}`])), `"${value}" is not a yes`);
  }
  for (const value of ['1', 'true', 'on', 'yes', 'ON', ' Yes ']) {
    assert.equal(ok([...CREDS, `TG_MIDTURN_INPUT=${value}`]).midturnInput, true, value);
  }
  assert.equal(
    ok([...CREDS, 'TG_MIDTURN_INPUT=off'], { TG_MIDTURN_INPUT: 'on' }).midturnInput,
    true,
    'the process env wins over the file, like the other operator seams'
  );
  assert.ok(!('midturnInput' in ok([...CREDS, 'TG_MIDTURN_INPUT=on'], { TG_MIDTURN_INPUT: 'off' })));
});

test('TG_LEARNING_TOPIC: chat_id:thread_id, anything else disables the gate', () => {
  assert.equal(SOURCES.TG_LEARNING_TOPIC, 'process-env-over-file');
  assert.equal(ok(CREDS).learningTopic, null, 'absent = no gate');
  assert.deepEqual(ok([...CREDS, 'TG_LEARNING_TOPIC=-1001234567890:1022']).learningTopic, {
    chatId: -1001234567890,
    threadId: 1022,
  });
  assert.deepEqual(
    ok([...CREDS, 'TG_LEARNING_TOPIC=-1:2'], { TG_LEARNING_TOPIC: '-3:4' }).learningTopic,
    { chatId: -3, threadId: 4 },
    'the process env wins'
  );
  for (const bad of ['', '-100', 'abc:1', '-1:', '-1:2:3', '-1:x']) {
    assert.equal(ok([...CREDS, `TG_LEARNING_TOPIC=${bad}`]).learningTopic, null, bad);
  }
});

test('TG_GUESTS: chat_id:user_id pairs; absent or empty is owner-only and leaves no field', () => {
  assert.equal(SOURCES.TG_GUESTS, 'process-env-over-file');
  assert.equal('guests' in ok(CREDS), false, 'absent = the config is the value it was before guests existed');
  assert.equal('guests' in ok([...CREDS, 'TG_GUESTS=']), false, 'empty = the same');
  assert.deepEqual(ok([...CREDS, 'TG_GUESTS=-1001234567890:123456789']).guests, [
    { chatId: -1001234567890, userId: 123456789 },
  ]);
  assert.deepEqual(ok([...CREDS, 'TG_GUESTS=-1:2, -3:4']).guests, [
    { chatId: -1, userId: 2 },
    { chatId: -3, userId: 4 },
  ]);
  assert.deepEqual(ok([...CREDS, 'TG_GUESTS=-1:2'], { TG_GUESTS: '-5:6' }).guests, [{ chatId: -5, userId: 6 }], 'the process env wins');
});

test('TG_GUESTS: a malformed list refuses to start instead of guessing', () => {
  for (const bad of ['-1', 'abc:1', '-1:', '-1:2:3', '-1:x', '-1:2,', '-1:2,,-3:4', '-1:-2']) {
    assert.equal(refused([...CREDS, `TG_GUESTS=${bad}`]), BAD_GUESTS_MESSAGE, bad);
  }
});

test('TG_PROPOSAL_TTL_MS: 24 h by default, a nonsense value falls back', () => {
  assert.equal(SOURCES.TG_PROPOSAL_TTL_MS, 'process-env-over-file');
  assert.equal(DEFAULT_PROPOSAL_TTL_MS, 24 * 3600 * 1000);
  assert.equal(ok(CREDS).proposalTtlMs, DEFAULT_PROPOSAL_TTL_MS);
  assert.equal(ok([...CREDS, 'TG_PROPOSAL_TTL_MS=60000']).proposalTtlMs, 60_000);
  for (const bad of ['0', '-5', 'soon']) {
    assert.equal(ok([...CREDS, `TG_PROPOSAL_TTL_MS=${bad}`]).proposalTtlMs, DEFAULT_PROPOSAL_TTL_MS, bad);
  }
});

test('the operator seams take the process env first and the file second', () => {
  for (const name of [
    'TG_API_BASE_URL',
    'TG_CLAUDE_TIMEOUT_MS',
    'TG_MAX_PARALLEL_TURNS',
    // The fallback pair is a seam too: it is what an operator reaches for when
    // one model's bucket runs dry, and the launchd job reads the env FILE.
    'TG_CLAUDE_FALLBACK_MODEL',
    'TG_CLAUDE_FALLBACK_TTL_MS',
  ] as const) {
    assert.equal(SOURCES[name], 'process-env-over-file');
  }
  const FILE = [
    ...CREDS,
    'TG_API_BASE_URL=http://127.0.0.1:9',
    'TG_CLAUDE_TIMEOUT_MS=120000',
    'TG_MAX_PARALLEL_TURNS=5',
    'TG_CLAUDE_FALLBACK_MODEL=sonnet',
    'TG_CLAUDE_FALLBACK_TTL_MS=900000',
  ];
  const fromFile = ok(FILE);
  assert.equal(fromFile.apiBaseUrl, 'http://127.0.0.1:9');
  assert.equal(fromFile.claudeTimeoutMs, 120000, 'strings coerce to numbers');
  assert.equal(fromFile.maxParallelTurns, 5);
  assert.equal(fromFile.claudeFallbackModel, 'sonnet');
  assert.equal(fromFile.claudeFallbackTtlMs, 900000);

  const overridden = ok(FILE, {
    TG_API_BASE_URL: 'http://127.0.0.1:1',
    TG_CLAUDE_TIMEOUT_MS: '1000',
    TG_MAX_PARALLEL_TURNS: '1',
    TG_CLAUDE_FALLBACK_MODEL: 'opus',
    TG_CLAUDE_FALLBACK_TTL_MS: '60000',
  });
  assert.equal(overridden.apiBaseUrl, 'http://127.0.0.1:1');
  assert.equal(overridden.claudeTimeoutMs, 1000);
  assert.equal(overridden.maxParallelTurns, 1);
  assert.equal(overridden.claudeFallbackModel, 'opus');
  assert.equal(overridden.claudeFallbackTtlMs, 60000);
});

// ------------------------------------------------- the usage-limit fallback ---

test('the fallback model defaults to opus and can be switched off', () => {
  assert.equal(DEFAULT_CLAUDE_FALLBACK_MODEL, 'opus');
  assert.equal(DEFAULT_CLAUDE_FALLBACK_TTL_MS, 60 * 60 * 1000);
  assert.equal(ok(CREDS).claudeFallbackModel, 'opus', 'unset: fable falls back to opus');
  assert.equal(ok(CREDS).claudeFallbackTtlMs, DEFAULT_CLAUDE_FALLBACK_TTL_MS);

  assert.equal(
    ok([...CREDS, 'TG_CLAUDE_FALLBACK_MODEL=']).claudeFallbackModel,
    null,
    'an empty value is how an operator says "report the failure, do not switch"'
  );
  assert.equal(ok([...CREDS, 'TG_CLAUDE_FALLBACK_MODEL=   ']).claudeFallbackModel, null);
});

test('a fallback that IS the primary model is no fallback at all', () => {
  assert.equal(
    ok([...CREDS, 'TG_CLAUDE_FALLBACK_MODEL=opus'], { TG_CLAUDE_MODEL: 'opus' }).claudeFallbackModel,
    null,
    're-running the same empty bucket is a second failure, not a fallback'
  );
  assert.equal(
    ok([...CREDS, 'TG_CLAUDE_FALLBACK_MODEL=fable'], { TG_CLAUDE_MODEL: 'opus' }).claudeFallbackModel,
    'fable',
    'a different model is still a fallback, whichever way round'
  );
});

test('a nonsense fallback TTL falls back to the default, like every other number', () => {
  for (const raw of ['abc', '', '0', '-1']) {
    assert.equal(
      ok(CREDS, { TG_CLAUDE_FALLBACK_TTL_MS: raw }).claudeFallbackTtlMs,
      DEFAULT_CLAUDE_FALLBACK_TTL_MS,
      raw
    );
  }
});

test('the burst knobs are process-env only', () => {
  for (const name of ['TG_BURST_SETTLE_MS', 'TG_BURST_WINDOW_MAX_MS'] as const) {
    assert.equal(SOURCES[name], 'process-env');
  }
  const ignored = ok([...CREDS, 'TG_BURST_SETTLE_MS=1', 'TG_BURST_WINDOW_MAX_MS=2']);
  assert.equal(ignored.burstSettleMs, DEFAULT_BURST_SETTLE_MS, 'the env file never set these');
  assert.equal(ignored.burstWindowMaxMs, DEFAULT_BURST_WINDOW_MAX_MS);

  const honoured = ok(CREDS, { TG_BURST_SETTLE_MS: '1', TG_BURST_WINDOW_MAX_MS: '2' });
  assert.equal(honoured.burstSettleMs, 1);
  assert.equal(honoured.burstWindowMaxMs, 2);
});

test('the model pair is a standing choice in the env file, and the process environment still wins', () => {
  for (const name of ['TG_CLAUDE_MODEL', 'TG_CLAUDE_EFFORT'] as const) {
    assert.equal(SOURCES[name], 'process-env-over-file');
  }
  const absent = ok(CREDS);
  assert.equal(absent.claudeModel, DEFAULT_CLAUDE_MODEL);
  assert.equal(absent.claudeEffort, DEFAULT_CLAUDE_EFFORT);

  // What a launchd start sees: the file and an empty environment.
  const fromFile = ok([...CREDS, 'TG_CLAUDE_MODEL=opus', 'TG_CLAUDE_EFFORT=xhigh']);
  assert.equal(fromFile.claudeModel, 'opus');
  assert.equal(fromFile.claudeEffort, 'xhigh');
  assert.equal(fromFile.claudeFallbackModel, null, 'opus falling back to opus is no fallback');

  const adHoc = ok([...CREDS, 'TG_CLAUDE_MODEL=opus', 'TG_CLAUDE_EFFORT=xhigh'], {
    TG_CLAUDE_MODEL: 'fable',
    TG_CLAUDE_EFFORT: 'low',
  });
  assert.equal(adHoc.claudeModel, 'fable');
  assert.equal(adHoc.claudeEffort, 'low');
});

test('a nonsense timeout or parallelism falls back instead of stopping the daemon', () => {
  for (const raw of ['abc', '', '0', '-1']) {
    assert.equal(ok(CREDS, { TG_CLAUDE_TIMEOUT_MS: raw }).claudeTimeoutMs, DEFAULT_CLAUDE_TIMEOUT_MS, raw);
  }
  for (const raw of ['abc', '', '0', '2.5', '-3']) {
    assert.equal(
      ok(CREDS, { TG_MAX_PARALLEL_TURNS: raw }).maxParallelTurns,
      DEFAULT_MAX_PARALLEL_TURNS,
      raw
    );
  }
});

test('a nonsense burst knob stays NaN, exactly as the bare Number() left it', () => {
  assert.ok(Number.isNaN(ok(CREDS, { TG_BURST_SETTLE_MS: 'abc' }).burstSettleMs));
  assert.equal(ok(CREDS, { TG_BURST_SETTLE_MS: '' }).burstSettleMs, 0, "Number('') is 0, not a fallback");
});

// ------------------------------------------------------------- the pins ---

// config.ts cannot import turn.mjs (no allowJs), so the timeout default and the
// leniency around it are a deliberate parallel copy. Pin them here so the two
// cannot drift apart silently.
const turn = (await import(new URL('../src/turn.mjs', import.meta.url).href)) as {
  DEFAULT_CLAUDE_TIMEOUT_MS: number;
  parseTimeoutMs: (raw: unknown, fallback?: number) => number;
};

test('the timeout default and its leniency still match turn.mjs', () => {
  assert.equal(DEFAULT_CLAUDE_TIMEOUT_MS, turn.DEFAULT_CLAUDE_TIMEOUT_MS);
  for (const raw of ['120000', '1', 'abc', '', '0', '-1', 'Infinity']) {
    assert.equal(
      ok(CREDS, { TG_CLAUDE_TIMEOUT_MS: raw }).claudeTimeoutMs,
      turn.parseTimeoutMs(raw),
      `TG_CLAUDE_TIMEOUT_MS=${raw}`
    );
  }
});

// The two refusals themselves are pinned end to end by the contract oracle
// (test/contract/runner-e2e.test.mjs cases (a) and (a2), which run the real
// daemon and compare stderr byte for byte). What is checked here is only that
// the DAEMON still owns the wording it prints — src/runner.ts since the daemon
// became the plugin's service; src/runner.mjs is the boot file now, and the one
// thing it must never do is turn a load failure into the same quiet exit 0
// (test/contract/runner-boot.test.mjs).
test('the daemon still prints both misconfig sentences itself', () => {
  const runner = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');
  assert.match(runner, /refusing to start \(see orchestrator\/README\.md\)/);
  assert.match(runner, /stderr\(loaded\.message\)/);
  assert.match(runner, /exit\(0\)/);
});

// -------------------------------------------------- the borrowed account ---
//
// TG_CLAUDE_CONFIG_DIR says which Claude Code login the CHILD sessions run
// under; TG_CLAUDE_CONFIG_DIR_UNTIL says when it goes back. The runner asks
// activeClaudeConfigDir per turn, so the deadline needs no restart to arrive.

const UNTIL = '2026-09-21T16:00:00Z';
const UNTIL_MS = Date.UTC(2026, 8, 21, 16, 0, 0);
const BORROWED = '/var/x/.claude-work';

test('TG_CLAUDE_CONFIG_DIR is an account, and an empty one is no account', () => {
  assert.equal(SOURCES.TG_CLAUDE_CONFIG_DIR, 'process-env-over-file');
  assert.equal(SOURCES.TG_CLAUDE_CONFIG_DIR_UNTIL, 'process-env-over-file');
  assert.equal(ok(CREDS).claudeConfigDir, null, 'unset = the personal account');
  assert.equal(ok([...CREDS, 'TG_CLAUDE_CONFIG_DIR=']).claudeConfigDir, null);
  assert.equal(ok([...CREDS, 'TG_CLAUDE_CONFIG_DIR=   ']).claudeConfigDir, null);
  assert.equal(ok([...CREDS, `TG_CLAUDE_CONFIG_DIR=${BORROWED}`]).claudeConfigDir, BORROWED);
  assert.equal(
    ok([...CREDS, `TG_CLAUDE_CONFIG_DIR=${BORROWED}`], {
      TG_CLAUDE_CONFIG_DIR: '/var/x/.claude',
    }).claudeConfigDir,
    '/var/x/.claude',
    'the process env still wins for an ad-hoc run'
  );
});

test('TG_CLAUDE_CONFIG_DIR_UNTIL is an ISO-8601 instant, or the daemon refuses', () => {
  assert.equal(Date.parse(UNTIL), UNTIL_MS, 'the fixture is the instant it reads as');
  assert.equal(ok(CREDS).claudeConfigDirUntil, null, 'unset = no deadline');
  assert.equal(ok([...CREDS, `TG_CLAUDE_CONFIG_DIR_UNTIL=${UNTIL}`]).claudeConfigDirUntil, UNTIL_MS);
  assert.equal(ok(CREDS, { TG_CLAUDE_CONFIG_DIR_UNTIL: UNTIL }).claudeConfigDirUntil, UNTIL_MS);
  // A deadline nobody can read is a deadline that never arrives, so this is the
  // one option here that refuses rather than falling back to its default.
  for (const raw of ['tomorrow', 'not-a-timestamp', '16:00', 'сегодня']) {
    assert.equal(
      refused([...CREDS, `TG_CLAUDE_CONFIG_DIR_UNTIL=${raw}`]),
      BAD_CONFIG_DIR_UNTIL_MESSAGE,
      raw
    );
  }
});

test('activeClaudeConfigDir answers with the account only while it is still ours', () => {
  assert.equal(activeClaudeConfigDir({ claudeConfigDir: null, claudeConfigDirUntil: null }), null);
  assert.equal(
    activeClaudeConfigDir({ claudeConfigDir: '', claudeConfigDirUntil: null }),
    null,
    'an empty dir is unset, not a path'
  );
  assert.equal(
    activeClaudeConfigDir({ claudeConfigDir: BORROWED, claudeConfigDirUntil: null }),
    BORROWED,
    'no deadline = for as long as the variable is set'
  );
  const dated = { claudeConfigDir: BORROWED, claudeConfigDirUntil: UNTIL_MS };
  assert.equal(activeClaudeConfigDir(dated, UNTIL_MS - 1), BORROWED);
  assert.equal(
    activeClaudeConfigDir(dated, UNTIL_MS),
    null,
    'the deadline itself is already over — no turn starts on the borrowed account at 16:00:00'
  );
  assert.equal(activeClaudeConfigDir(dated, UNTIL_MS + 60_000), null);
});

test('a lapsed deadline reverts the running daemon, not the env file', () => {
  const config = ok([
    ...CREDS,
    `TG_CLAUDE_CONFIG_DIR=${BORROWED}`,
    `TG_CLAUDE_CONFIG_DIR_UNTIL=${UNTIL}`,
  ]);
  assert.equal(activeClaudeConfigDir(config, UNTIL_MS - 1000), BORROWED);
  assert.equal(activeClaudeConfigDir(config, UNTIL_MS + 1000), null);
});
