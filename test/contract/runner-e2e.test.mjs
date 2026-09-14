// runner-e2e.test.mjs — the daemon's observable behaviour, end to end.
//
// runner.mjs has no unit-testable surface: it IS the wiring. So it is driven
// here the way the world drives it — a Bot API it long-polls, a `claude`
// binary it spawns, files under ~/.config/tg-orchestrator that other tools
// read (runner.log, runner.pid, status.json, state.json, usage.jsonl, the
// drain flag) — and everything those observers see is pinned.
//
// Hermetic: a node:http server on 127.0.0.1 stands in for api.telegram.org
// (reached through the TG_API_BASE_URL seam, whose default is the real URL),
// a script on PATH stands in for `claude`, and HOME is a temp dir — so
// os.homedir() puts the whole install under it. Every child is spawned
// detached and the process GROUP is killed in a finally, so a fake claude
// left sleeping mid-turn cannot outlive the test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  baseEnv, expectFixture, NODE, readIf, rmDir, ROOT, run, runSrc, scrubJson, scrubText,
  SRC, startFakeTelegram, tmpDir, waitFor,
} from './helpers.mjs';
// The sentence the owner is shown comes from the catalogue, never from a copy:
// a reworded key must fail this case rather than pass it against stale text.
import { ru } from '../../src/i18n/ru.ts';

// The sentence the CLI prints when the model's usage bucket is empty. Shared by
// the fake `claude` below and by the case that pins the fallback.
const OUT_OF_CREDITS =
  "You're out of usage credits. Switch to another model, or manage usage credits " +
  'at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.';

const TOKEN = '123456:TEST-TOKEN';
const OWNER_ID = 424242;
const CHAT_ID = -1007770001;
const THREAD_ID = 5;
const CONVO = `${CHAT_ID}:${THREAD_ID}`;
// How long a getUpdates call is held when the queue is empty. Short: the
// runner asks for 50 s and the burst window asks for 10 s, but nothing in the
// contract depends on the server honouring that — only on it answering.
const LONGPOLL_MS = 150;

let tmp;
let binDir;

// ------------------------------------------------------------ fake `claude` ---
// Extensionless and CommonJS on purpose: node treats a file with no extension
// and no nearby package.json as CJS, and `claude` must be spelled exactly that
// on PATH because runner.mjs spawns the bare name.
const FAKE_CLAUDE = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_FILE) {
  fs.appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv) + '\\n');
}
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const model = argv[argv.indexOf('--model') + 1];
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const answer = () => {
  line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  line({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  line({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1',
         result: 'готово', total_cost_usd: 0.25, num_turns: 3, duration_ms: 1234 });
};
// FAKE_HEAL_FILE: the bucket refills when that file appears, so one daemon can
// be walked through refusal -> probe -> recovery (FAKE_CLAUDE_MODE is fixed for
// its lifetime, the file is not). Unset = the bucket never refills.
const healed = !!process.env.FAKE_HEAL_FILE && fs.existsSync(process.env.FAKE_HEAL_FILE);
if (mode === 'usage-limit-on-fable' && model === 'fable' && !healed) {
  // 11.09.2026, verbatim: an init, an assistant message whose TEXT is the
  // error, a result with is_error, exit 1. Every other model still answers.
  // process.exitCode, not process.exit: a hard exit truncates the pipe.
  line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  line({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: OUT_OF_CREDITS }] } });
  line({ type: 'result', subtype: 'success', is_error: true, session_id: 'sess-1',
         result: OUT_OF_CREDITS, total_cost_usd: 0, num_turns: 1, duration_ms: 12 });
  process.exitCode = 1;
} else if (mode === 'ok' || mode === 'usage-limit-on-fable') {
  answer();
} else if (mode === 'fail') {
  process.stderr.write('boom\\n');
  process.exit(1);
} else {
  setInterval(() => {}, 1000); // 'sleep': hang until killed
}
`;

// ------------------------------------------------------- fake Telegram API ---
// The server itself lives in helpers.mjs, so the in-process case in
// runner-driver.test.mjs drives the same fake Bot API.
const startTelegram = () => startFakeTelegram({ token: TOKEN, longpollMs: LONGPOLL_MS });

const ownerMsg = (message_id, text, extra = {}) => ({
  message_id,
  from: { id: OWNER_ID, is_bot: false, first_name: 'Sasha' },
  chat: { id: CHAT_ID, type: 'supergroup', title: 'dev' },
  message_thread_id: THREAD_ID,
  text,
  ...extra,
});

// ---------------------------------------------------------------- harness ---

// TG_LOCALE=ru by default: these fixtures were recorded from the pre-i18n
// daemon, whose only language was Russian, and they are what proves the
// catalogue reproduces it byte for byte. A case that wants the new default
// locale passes an env without the line.
function install(name, { env = ['TELEGRAM_BOT_TOKEN=' + TOKEN, 'OWNER_ID=' + OWNER_ID, 'TG_LOCALE=ru'] } = {}) {
  const home = path.join(tmp, name);
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  fs.mkdirSync(cfg, { recursive: true });
  if (env) fs.writeFileSync(path.join(cfg, 'env'), env.join('\n') + '\n');
  return {
    home,
    cfg,
    argvFile: path.join(home, 'claude-argv.jsonl'),
    file: (f) => path.join(cfg, f),
    log: () => readIf(path.join(cfg, 'runner.log')),
  };
}

function spawnRunner(inst, apiBase, extraEnv = {}) {
  const child = spawn(NODE, [path.join(SRC, 'runner.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv({
      HOME: inst.home,
      PATH: `${binDir}:${path.dirname(NODE)}:/usr/bin:/bin`,
      TG_API_BASE_URL: apiBase ?? 'http://127.0.0.1:1', // unusable on purpose when unset
      CLAIMS_DB: path.join(inst.home, 'claims.sqlite'),
      TG_EVENTS_DB: path.join(inst.home, 'events.sqlite'),
      FAKE_ARGV_FILE: inst.argvFile,
      FAKE_CLAUDE_MODE: 'ok',
      ...extraEnv,
    }),
  });
  const r = { child, pid: child.pid, stdout: '', stderr: '', exit: null };
  child.stdout.on('data', (d) => (r.stdout += d));
  child.stderr.on('data', (d) => (r.stderr += d));
  child.on('exit', (code, signal) => (r.exit = { code, signal }));
  return r;
}

// Kill the whole process GROUP: a fake claude sleeping mid-turn is a child of
// the runner, and a runner that exited on SIGTERM leaves it orphaned.
function killGroup(r) {
  if (!r) return;
  try {
    process.kill(-r.pid, 'SIGKILL');
  } catch {
    /* group already gone */
  }
}

const waitExit = (r, timeoutMs) => waitFor('the runner to exit', () => r.exit, { timeoutMs, everyMs: 20 });
const waitUp = (inst) => waitFor('the up banner', () => /tg-orchestrator up:/.test(inst.log()));

// Exactly how scripts/restart-when-idle.sh reads the phase (line 40).
const phaseOf = (inst) =>
  run('sed', ['-n', 's/.*"phase":"\\([a-z]*\\)".*/\\1/p', inst.file('status.json')]).stdout.trim();

const scrubLog = (text, inst, r) =>
  scrubText(text, [[inst.home, '<HOME>'], [ROOT, '<ROOT>'], [String(r?.pid ?? ''), '<pid>']]);

before(() => {
  tmp = tmpDir('runner-contract');
  binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'claude');
  fs.writeFileSync(
    bin,
    `#!${NODE}\nconst OUT_OF_CREDITS = ${JSON.stringify(OUT_OF_CREDITS)};\n${FAKE_CLAUDE}`
  );
  fs.chmodSync(bin, 0o755);
});
after(() => rmDir(tmp));

// ------------------------------------------------------------------ cases ---

test('(a) a missing env file: the misconfig line on stderr, exit 0', async () => {
  const inst = install('no-env', { env: null });
  const r = spawnRunner(inst, null);
  try {
    await waitExit(r, 10_000);
    assert.deepEqual(r.exit, { code: 0, signal: null });
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `no ${inst.file('env')} — refusing to start (see orchestrator/README.md)\n`);
    assert.equal(inst.log(), '', 'nothing is logged: the refusal happens before the log file exists');
  } finally {
    killGroup(r);
  }
});

test('(a2) an env file without a token: refused the same way, exit 0', async () => {
  const inst = install('bad-env', { env: ['TELEGRAM_BOT_TOKEN=PASTE-ME', 'OWNER_ID=1'] });
  const r = spawnRunner(inst, null);
  try {
    await waitExit(r, 10_000);
    assert.deepEqual(r.exit, { code: 0, signal: null });
    assert.equal(r.stderr, 'env must define TELEGRAM_BOT_TOKEN and OWNER_ID\n');
  } finally {
    killGroup(r);
  }
});

test('(b,c,d,h) startup: banner, silent stdout, status.json phases, pid singleton', async () => {
  const tg = await startTelegram();
  const inst = install('startup');
  const r = spawnRunner(inst, tg.base);
  let second = null;
  try {
    await waitUp(inst);

    // (b) the line scripts/restart-when-idle.sh:94 greps for.
    const grepped = run('grep', ['tg-orchestrator up', inst.file('runner.log')]);
    assert.equal(grepped.code, 0, 'restart-when-idle.sh greps this line to report the new runner');
    const banner = grepped.stdout.trim().split('\n').at(-1);
    expectFixture('runner/up-banner.txt', scrubLog(banner + '\n', inst, r));

    // (c) non-TTY: the log grows, the child's stdout stays empty.
    assert.ok(inst.log().length > 0);
    assert.equal(r.stdout, '', 'with stdout piped the runner must not echo — ensure.sh redirects it into the log');

    // (d) status.json: always parseable (writeAtomic), phase reachable with
    // restart-when-idle.sh's own sed, and idle when nothing is queued.
    const phases = new Set();
    for (let i = 0; i < 25; i++) {
      const raw = readIf(inst.file('status.json'));
      if (raw) {
        const parsed = JSON.parse(raw); // a torn write would throw here
        assert.equal(parsed.pid, r.pid);
        phases.add(phaseOf(inst));
      }
      await new Promise((s) => setTimeout(s, 20));
    }
    assert.ok(phases.has('idle'), `phase never reached idle (saw ${[...phases].join(', ')})`);
    assert.deepEqual([...phases].filter((p) => !['idle', 'burst', 'claude', 'draining', 'down'].includes(p)), []);

    // (h) pid file + singleton.
    assert.equal(readIf(inst.file('runner.pid')), String(r.pid));
    const logBefore = inst.log();
    second = spawnRunner(inst, tg.base);
    await waitExit(second, 10_000);
    assert.deepEqual(second.exit, { code: 0, signal: null }, 'a second runner with the same HOME just leaves');
    assert.equal(second.stdout, '');
    assert.equal(readIf(inst.file('runner.pid')), String(r.pid), 'it must not steal the pid file');
    assert.equal(inst.log(), logBefore, 'it must not touch the log either');
    assert.equal(tg.state.getMe, 1, 'and it must not talk to Telegram');
  } finally {
    killGroup(second);
    killGroup(r);
    await tg.stop();
  }
});

test('(e,k) /status and /help are answered without a model; a stranger is ignored', async () => {
  const tg = await startTelegram();
  // No TG_BURST_SETTLE_MS override here: commands are siphoned BEFORE the
  // burst window, so the /help text renders the real 3-minute default.
  const inst = install('commands');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    tg.push({
      message_id: 100,
      from: { id: 999999, is_bot: false, first_name: 'Somebody' },
      chat: { id: CHAT_ID, type: 'supergroup', title: 'dev' },
      message_thread_id: THREAD_ID,
      text: '/status',
    });
    tg.push(ownerMsg(101, '/status'));
    tg.push(ownerMsg(102, '/help'));

    await waitFor('two command replies', () => tg.state.sent.length >= 2);
    await new Promise((s) => setTimeout(s, 300)); // nothing more must arrive
    assert.equal(tg.state.sent.length, 2, 'the stranger must not be answered');
    assert.equal(readIf(inst.argvFile), '', 'a command never spawns claude');

    const [statusReply, helpReply] = tg.state.sent;
    assert.equal(statusReply.chat_id, CHAT_ID);
    assert.equal(statusReply.message_thread_id, THREAD_ID);
    expectFixture('runner/reply-status.txt', scrubLog(statusReply.text + '\n', inst, r));
    expectFixture('runner/reply-help.txt', helpReply.text + '\n');

    // ...and the stranger left no trace in the durable log either.
    const rows = eventRows(inst);
    assert.deepEqual(rows.filter((e) => e.msgId === 100), [], 'a foreign message is dropped before the event log');
    assert.deepEqual(
      rows.filter((e) => e.kind === 'command').map((e) => [e.msgId, e.payload.cmd]),
      [[101, 'status'], [102, 'help']]
    );
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(e2) with TG_LOCALE unset the same /help comes back in English', async () => {
  const tg = await startTelegram();
  const inst = install('commands-en', {
    env: ['TELEGRAM_BOT_TOKEN=' + TOKEN, 'OWNER_ID=' + OWNER_ID],
  });
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    tg.push(ownerMsg(110, '/help'));
    await waitFor('the help reply', () => tg.state.sent.length >= 1);
    expectFixture('runner/reply-help.en.txt', tg.state.sent[0].text + '\n');
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(f,g) a text message: exactly one claude spawn, its argv, and the usage ledger', async () => {
  const tg = await startTelegram();
  const inst = install('turn');
  const r = spawnRunner(inst, tg.base, { TG_BURST_SETTLE_MS: '1' });
  try {
    await waitUp(inst);
    tg.push(ownerMsg(201, 'что там по деплою?'));
    await waitFor('the usage ledger line', () => readIf(inst.file('usage.jsonl')).includes('\n'));
    await new Promise((s) => setTimeout(s, 300));

    // (f) one spawn, and an argv status.mjs can recognise in `ps`.
    const spawns = readIf(inst.argvFile).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(spawns.length, 1, 'one message, one turn, one claude');
    const argv = spawns[0];
    for (const flag of ['-p', '--output-format', 'stream-json', '--append-system-prompt-file']) {
      assert.ok(argv.includes(flag), `argv must carry ${flag}`);
    }
    const promptFile = argv[argv.indexOf('--append-system-prompt-file') + 1];
    assert.equal(promptFile, path.join(ROOT, 'agent.md'));
    assert.ok(promptFile.startsWith(ROOT), 'status.mjs finds our turns by the repo root in the ps line');
    expectFixture('runner/claude-argv.json', argv.slice(0, -1).map((a) => a.split(ROOT).join('<ROOT>')));
    // The last argument is the prompt: the rendered message run.
    const prompt = argv.at(-1);
    assert.match(prompt, /^New Telegram message from the owner\. Now: /);
    assert.ok(
      prompt.includes(`[msg 201 · chat_id=${CHAT_ID} · topic_thread=${THREAD_ID} · "dev" · sent `)
    );
    // The send time is the point: "Now" is the turn's clock, this is the message's.
    assert.match(prompt, /· sent \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(\d+[smhd]\S* ago\)\]/);
    assert.ok(!prompt.includes('EDITED'), 'an unedited message carries no edit marker');
    assert.ok(prompt.endsWith('что там по деплою?'));

    // (g) the ledger keys, exactly as written today.
    const lines = readIf(inst.file('usage.jsonl')).split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(row), [
      'ts', 'kind', 'ok', 'convo', 'sessionId', 'resumedFrom', 'costUSD',
      'numTurns', 'durationMs', 'toolUses', 'timedOut', 'killedAfterResult',
    ]);
    expectFixture('runner/usage-row.json', scrubJson(row, [[tmp, '<TMP>']]));

    // The runner posts nothing itself on a good turn — the agent answers.
    assert.deepEqual(tg.state.sent, []);
    // ...and the session is remembered for the topic.
    const state = JSON.parse(readIf(inst.file('state.json')));
    assert.equal(state.offset, 1000);
    assert.equal(state.sessions[CONVO].id, 'sess-1');
    assert.ok(Number.isInteger(state.sessions[CONVO].last));

    const kinds = eventRows(inst).map((e) => e.kind);
    assert.deepEqual(kinds, ['runner_start', 'snapshot', 'inbound', 'turn_start', 'turn_result']);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(k) a claude that dies without a result is reported into the topic', async () => {
  const tg = await startTelegram();
  const inst = install('claude-fail');
  const r = spawnRunner(inst, tg.base, { TG_BURST_SETTLE_MS: '1', FAKE_CLAUDE_MODE: 'fail' });
  try {
    await waitUp(inst);
    tg.push(ownerMsg(301, 'сделай отчёт'));
    await waitFor('the failure message', () => tg.state.sent.length >= 1);
    expectFixture('runner/reply-turn-failed.txt', tg.state.sent[0].text + '\n');
    assert.equal(tg.state.sent[0].message_thread_id, THREAD_ID);
    assert.equal(eventRows(inst).filter((e) => e.kind === 'turn_fail').length, 1);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(k) a turn killed by TG_CLAUDE_TIMEOUT_MS is reported with the timeout in the text', async () => {
  const tg = await startTelegram();
  const inst = install('claude-timeout');
  const r = spawnRunner(inst, tg.base, {
    TG_BURST_SETTLE_MS: '1',
    TG_CLAUDE_TIMEOUT_MS: '800',
    FAKE_CLAUDE_MODE: 'sleep',
  });
  try {
    await waitUp(inst);
    assert.match(inst.log(), /turn timeout 0 min/, 'the banner rounds sub-minute timeouts to 0');
    tg.push(ownerMsg(401, 'долгая задача'));
    await waitFor('the timeout message', () => tg.state.sent.length >= 1);
    expectFixture('runner/reply-turn-timeout.txt', tg.state.sent[0].text + '\n');
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(k) the topic is warned before the kill, TIMEOUT_WARN_BEFORE_MS in advance', async () => {
  const tg = await startTelegram();
  const inst = install('claude-warn');
  // Just over TIMEOUT_WARN_BEFORE_MS (5 min), so the warning fires ~500 ms in
  // while the kill itself stays 5 minutes away — the test never waits for it.
  const r = spawnRunner(inst, tg.base, {
    TG_BURST_SETTLE_MS: '1',
    TG_CLAUDE_TIMEOUT_MS: '300500',
    FAKE_CLAUDE_MODE: 'sleep',
  });
  try {
    await waitUp(inst);
    tg.push(ownerMsg(501, 'очень долгая задача'));
    await waitFor('the slow-turn warning', () => tg.state.sent.length >= 1);
    expectFixture('runner/reply-turn-slow.txt', tg.state.sent[0].text + '\n');
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(i) the drain flag makes the runner finish and leave, taking the flag with it', async () => {
  const tg = await startTelegram();
  const inst = install('drain');
  // A flag a dead watcher left behind must not drain the NEXT runner: it is
  // cleared at startup instead.
  fs.writeFileSync(inst.file('drain'), '');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    assert.match(inst.log(), /stale drain flag removed/);
    assert.equal(fs.existsSync(inst.file('drain')), false);
    assert.equal(r.exit, null, 'the stale flag did not drain it');

    fs.writeFileSync(inst.file('drain'), '');
    await waitExit(r, 15_000);
    assert.deepEqual(r.exit, { code: 0, signal: null }, 'a drained runner exits 0 by itself');
    assert.equal(fs.existsSync(inst.file('drain')), false, 'the flag is removed on the way out');
    assert.equal(fs.existsSync(inst.file('runner.pid')), false, 'and so is the pid file');
    assert.equal(phaseOf(inst), 'down');
    const tailLines = inst.log().trimEnd().split('\n').slice(-3).join('\n');
    expectFixture('runner/drain.log.txt', scrubLog(tailLines + '\n', inst, r));
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(j) SIGTERM mid-turn: immediate exit, no drain', async () => {
  const tg = await startTelegram();
  const inst = install('sigterm');
  const r = spawnRunner(inst, tg.base, { TG_BURST_SETTLE_MS: '1', FAKE_CLAUDE_MODE: 'sleep' });
  try {
    await waitUp(inst);
    tg.push(ownerMsg(601, 'запусти сборку'));
    await waitFor('claude to be spawned', () => readIf(inst.argvFile).includes('\n'));
    const t0 = Date.now();
    process.kill(r.pid, 'SIGTERM');
    await waitExit(r, 5000);
    const took = Date.now() - t0;
    // Exit code, not a signal: the handler exits 0 on purpose.
    assert.deepEqual(r.exit, { code: 0, signal: null });
    assert.ok(took < 1500, `SIGTERM must not wait for the turn (took ${took}ms)`);
    assert.equal(fs.existsSync(inst.file('runner.pid')), false);
    assert.equal(phaseOf(inst), 'down');
    assert.match(inst.log(), new RegExp(`SIGTERM with turns in flight: ${CONVO.replace(/[-:]/g, '\\$&')}\n`));
    const stop = eventRows(inst).filter((e) => e.kind === 'runner_stop');
    assert.equal(stop.length, 1);
    assert.deepEqual(stop[0].payload, { reason: 'SIGTERM', inflight: [CONVO] });
    // The turn itself is NOT closed: that is what the startup recovery is for.
    assert.deepEqual(eventRows(inst).filter((e) => e.kind === 'turn_result'), []);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

// The entrypoint the world actually uses. LEARNING 2026-08-07: the daemon's
// PATH is a configuration choice, not an inheritance — a runner that starts
// fine from a developer shell still dies with "spawn claude ENOENT" under
// ensure.sh. So this case never spawns runner.mjs itself: it runs `bash
// ensure.sh`, with a fake HOME carrying the nvm release .node-version names
// and the fake `claude` in ~/.local/bin, exactly where ensure.sh looks.
test('(l) ensure.sh starts the runner once, a second call is a silent no-op', async () => {
  const tg = await startTelegram();
  // No TG_API_BASE_URL in the process env here: ensure.sh passes nothing
  // through, so the seam has to be read out of the env FILE.
  const inst = install('ensure', {
    env: [`TELEGRAM_BOT_TOKEN=${TOKEN}`, `OWNER_ID=${OWNER_ID}`, `TG_API_BASE_URL=${tg.base}`],
  });
  const wanted = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
  const nvmBin = path.join(inst.home, '.nvm', 'versions', 'node', `v${wanted}`, 'bin');
  fs.mkdirSync(nvmBin, { recursive: true });
  fs.symlinkSync(NODE, path.join(nvmBin, 'node'));
  // A decoy that sorts ABOVE the pinned release: the old "newest nvm node by
  // sort -V" rule would pick this one and nothing would ever start. It is what
  // makes this case prove .node-version is honoured, not merely that some node
  // was found.
  const decoyBin = path.join(inst.home, '.nvm', 'versions', 'node', 'v99.0.0', 'bin');
  fs.mkdirSync(decoyBin, { recursive: true });
  fs.writeFileSync(path.join(decoyBin, 'node'), '#!/bin/sh\necho "decoy node" >&2\nexit 1\n');
  fs.chmodSync(path.join(decoyBin, 'node'), 0o755);
  const localBin = path.join(inst.home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.copyFileSync(path.join(binDir, 'claude'), path.join(localBin, 'claude'));
  fs.chmodSync(path.join(localBin, 'claude'), 0o755);

  const ensure = () =>
    run('bash', [path.join(ROOT, 'ensure.sh')], {
      env: {
        HOME: inst.home,
        CLAIMS_DB: path.join(inst.home, 'claims.sqlite'),
        TG_EVENTS_DB: path.join(inst.home, 'events.sqlite'),
      },
    });

  let pid = 0;
  try {
    const first = ensure();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^tg-orchestrator started \(pid \d+\)\n$/);
    await waitUp(inst);
    assert.doesNotMatch(inst.log(), /decoy node/, '.node-version decides, not the newest nvm release');
    pid = Number(readIf(inst.file('runner.pid')));
    assert.ok(pid > 0, 'ensure.sh must leave a pid file behind');
    assert.equal(`tg-orchestrator started (pid ${pid})\n`, first.stdout, 'the pid it printed is the daemon');

    const second = ensure();
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'a live runner makes ensure.sh a silent no-op');
    assert.equal(second.stderr, '');
    assert.equal(Number(readIf(inst.file('runner.pid'))), pid, 'and it must not start a second runner');
    assert.equal(inst.log().match(/tg-orchestrator up:/g).length, 1, 'one banner, one daemon');

    // Leave nothing running: the drain handshake, the same way the watcher does.
    fs.writeFileSync(inst.file('drain'), '');
    await waitFor('the drained runner to leave', () => !fs.existsSync(inst.file('runner.pid')), {
      timeoutMs: 20_000,
    });
  } finally {
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await tg.stop();
  }
});

// Reading the event log through its own CLI, the way a human would.
function eventRows(inst) {
  const r = runSrc('events.mjs', ['tail', '--json'], {
    env: { HOME: inst.home, TG_EVENTS_DB: path.join(inst.home, 'events.sqlite') },
  });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------- wake spool ------
// The OTHER half of the wake contract. wake-sh.test.mjs pins what the producer
// writes; these cases pin what the RUNNING daemon does with it: the claim by
// rename, the single claude turn, the prompt that turn is given, where the file
// ends up, what the owner is told when the record is unusable, and the startup
// requeue of a record a dead daemon had already claimed.
//
// Recorded from the current runner.mjs before the wake logic moves out of it —
// so the port has to reproduce them byte for byte.

const WAKE_REC = {
  convo: CONVO,
  job: 'whisper msg 380',
  kind: 'voice-transcript',
  ok: true,
  text: 'расшифровка голосового\nвторая строка',
  file: '/tmp/tg-voice-380/voice.txt',
  startedAt: '2026-09-11T10:00:00.000Z',
  finishedAt: null, // filled per case: the age is what LATE is derived from
};

const wakeDir = (inst) => path.join(inst.cfg, 'wake');

// Written the way wake.sh writes it — a dot-tmp file moved into place — so the
// daemon can never see a half record under a *.json name.
function dropWake(inst, name, body) {
  const dir = wakeDir(inst);
  fs.mkdirSync(path.join(dir, 'done'), { recursive: true });
  const tmpFile = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmpFile, typeof body === 'string' ? body : JSON.stringify(body));
  fs.renameSync(tmpFile, path.join(dir, name));
  return name;
}

const spoolNames = (inst) => fs.readdirSync(wakeDir(inst)).filter((f) => f !== 'done').sort();
const doneNames = (inst) => fs.readdirSync(path.join(wakeDir(inst), 'done')).sort();

const lastPrompt = (inst) => {
  const lines = readIf(inst.argvFile).split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1)).at(-1);
};
const promptCount = (inst) => readIf(inst.argvFile).split('\n').filter(Boolean).length;

// The prompt carries two volatile things a fixture cannot hold: wall-clock
// instants (scrubText already turns those into <ts>) and the LATE line's
// rendered age in minutes, which grows while the test runs.
const scrubPrompt = (text, inst) =>
  scrubText(text, [[inst.home, '<HOME>'], [ROOT, '<ROOT>']]).replace(/waited \d+ min/, 'waited <min> min');

test('(m) a wake record: one claude turn, the job and the result in its prompt, then done/', async () => {
  const tg = await startTelegram();
  const inst = install('wake-ok');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    const name = dropWake(inst, '20260911T120000-4242-voice-transcript.json', {
      ...WAKE_REC,
      finishedAt: new Date().toISOString(),
    });

    await waitFor('the wake turn to be spawned', () => promptCount(inst) >= 1);
    await waitFor('the record to be filed under done/', () => doneNames(inst).includes(name));
    await new Promise((s) => setTimeout(s, 300)); // nothing more may follow

    assert.equal(promptCount(inst), 1, 'one record, one turn, one claude');
    assert.deepEqual(spoolNames(inst), [], 'the record leaves the spool');
    assert.deepEqual(doneNames(inst), [name], 'and lands under done/ under its own name');
    expectFixture('runner/wake-prompt.txt', scrubPrompt(lastPrompt(inst) + '\n', inst));
    assert.deepEqual(tg.state.sent, [], 'a turn that ran needs no fallback delivery');

    const rows = eventRows(inst);
    const enq = rows.filter((e) => e.kind === 'wake_enqueued');
    assert.equal(enq.length, 1);
    assert.equal(enq[0].convo, CONVO);
    assert.deepEqual(enq[0].payload, {
      file: name,
      job: WAKE_REC.job,
      kind: WAKE_REC.kind,
      ok: true,
      started: WAKE_REC.startedAt,
    });
    const done = rows.filter((e) => e.kind === 'wake_done');
    assert.equal(done.length, 1);
    assert.equal(done[0].convo, CONVO);
    assert.deepEqual(done[0].payload, { file: name, job: WAKE_REC.job, fallbackDelivered: false });
    assert.deepEqual(rows.filter((e) => e.kind === 'wake_fail'), []);
    // The turn rows carry the record, not a message: msgId null, kind wake.
    const start = rows.find((e) => e.kind === 'turn_start');
    assert.equal(start.payload.kind, 'wake');
    assert.equal(start.payload.file, name);
    const result = rows.find((e) => e.kind === 'turn_result');
    assert.equal(result.msgId, null);
    assert.equal(result.payload.wake, name);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(m2) while the turn runs the record sits in the spool as <name>.taken', async () => {
  const tg = await startTelegram();
  const inst = install('wake-taken');
  const r = spawnRunner(inst, tg.base, { FAKE_CLAUDE_MODE: 'sleep' });
  try {
    await waitUp(inst);
    const name = dropWake(inst, '20260911T120100-4242-job.json', {
      ...WAKE_REC,
      finishedAt: new Date().toISOString(),
    });
    await waitFor('the wake turn to be spawned', () => promptCount(inst) >= 1);
    // The claim is the rename: the record is unreachable to a second drain, and
    // still on disk so a daemon death can requeue it at the next startup.
    assert.deepEqual(spoolNames(inst), [`${name}.taken`]);
    assert.deepEqual(doneNames(inst), []);
    assert.equal(JSON.parse(readIf(path.join(wakeDir(inst), `${name}.taken`))).job, WAKE_REC.job);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(n) a record older than 30 minutes carries the LATE marker in the prompt', async () => {
  const tg = await startTelegram();
  const inst = install('wake-late');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    dropWake(inst, '20260911T120200-4242-voice-transcript.json', {
      ...WAKE_REC,
      finishedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    });
    await waitFor('the wake turn to be spawned', () => promptCount(inst) >= 1);
    const prompt = lastPrompt(inst);
    assert.match(prompt, /^LATE: this result waited \d+ min before reaching you\.$/m);
    expectFixture('runner/wake-prompt-late.txt', scrubPrompt(prompt + '\n', inst));
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(o) a --fail record is presented to the model as a failed job', async () => {
  const tg = await startTelegram();
  const inst = install('wake-failed-job');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    const name = dropWake(inst, '20260911T120300-4242-voice-transcript.json', {
      ...WAKE_REC,
      ok: false,
      text: 'ffmpeg exited 1',
      finishedAt: new Date().toISOString(),
    });
    await waitFor('the wake turn to be spawned', () => promptCount(inst) >= 1);
    await waitFor('the record to be filed under done/', () => doneNames(inst).includes(name));
    expectFixture('runner/wake-prompt-fail.txt', scrubPrompt(lastPrompt(inst) + '\n', inst));

    const enq = eventRows(inst).filter((e) => e.kind === 'wake_enqueued');
    assert.equal(enq[0].payload.ok, false, 'the event log records the job as failed too');
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(p) an unreadable record goes to done/<f>.bad and the owner is told', async () => {
  const tg = await startTelegram();
  const inst = install('wake-bad');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    // A truncated record: exactly what a producer that did not write through a
    // temp file would leave behind.
    const name = dropWake(inst, '20260911T120400-4242-job.json', '');
    await waitFor('the owner to be warned', () => tg.state.sent.length >= 1);
    await new Promise((s) => setTimeout(s, 300));

    assert.deepEqual(spoolNames(inst), []);
    assert.deepEqual(doneNames(inst), [`${name}.bad`], 'the record is kept, not deleted');
    assert.equal(promptCount(inst), 0, 'an unreadable record never reaches the model');
    assert.equal(tg.state.sent.length, 1);
    assert.equal(tg.state.sent[0].chat_id, OWNER_ID, 'the dead letter goes to the owner DM');
    assert.equal(tg.state.sent[0].message_thread_id, undefined);
    expectFixture('runner/wake-bad-record.txt', tg.state.sent[0].text + '\n');
    assert.deepEqual(eventRows(inst).filter((e) => e.kind.startsWith('wake_')), []);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(q) a record with no resolvable convo goes to done/<f>.bad with the "без адреса" note', async () => {
  const tg = await startTelegram();
  const inst = install('wake-no-convo');
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    const name = dropWake(inst, '20260911T120500-4242-job.json', {
      ...WAKE_REC,
      convo: 'нет такого',
      finishedAt: new Date().toISOString(),
    });
    await waitFor('the owner to be warned', () => tg.state.sent.length >= 1);
    await new Promise((s) => setTimeout(s, 300));

    assert.deepEqual(spoolNames(inst), []);
    assert.deepEqual(doneNames(inst), [`${name}.bad`]);
    assert.equal(promptCount(inst), 0, 'a turn whose answer lands nowhere is not worth a model call');
    assert.equal(tg.state.sent.length, 1);
    assert.equal(tg.state.sent[0].chat_id, OWNER_ID);
    expectFixture('runner/wake-no-address.txt', tg.state.sent[0].text + '\n');
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(r) a .taken orphan is requeued as .retry.json at startup and then runs', async () => {
  const tg = await startTelegram();
  const inst = install('wake-orphan');
  const base = '20260911T120600-4242-voice-transcript.json';
  fs.mkdirSync(path.join(wakeDir(inst), 'done'), { recursive: true });
  fs.writeFileSync(
    path.join(wakeDir(inst), `${base}.taken`),
    JSON.stringify({ ...WAKE_REC, finishedAt: new Date().toISOString() })
  );
  const retry = '20260911T120600-4242-voice-transcript.retry.json';
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    assert.match(inst.log(), new RegExp(`wake: requeueing orphaned ${base}\\.taken -> ${retry.replace(/\./g, '\\.')}\n`));
    await waitFor('the requeued record to run', () => promptCount(inst) >= 1);
    await waitFor('the requeued record to be filed', () => doneNames(inst).includes(retry));

    assert.deepEqual(spoolNames(inst), [], 'no .taken is left behind');
    assert.deepEqual(doneNames(inst), [retry]);
    assert.equal(promptCount(inst), 1, 'one retry, not a loop');
    assert.equal(eventRows(inst).filter((e) => e.kind === 'wake_enqueued')[0].payload.file, retry);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

test('(s) a record that already had its retry is given up into done/<f>.giveup', async () => {
  const tg = await startTelegram();
  const inst = install('wake-giveup');
  const retryTaken = '20260911T120700-4242-job.retry.json.taken';
  fs.mkdirSync(path.join(wakeDir(inst), 'done'), { recursive: true });
  fs.writeFileSync(
    path.join(wakeDir(inst), retryTaken),
    JSON.stringify({ ...WAKE_REC, finishedAt: new Date().toISOString() })
  );
  const r = spawnRunner(inst, tg.base);
  try {
    await waitUp(inst);
    await waitFor('the record to be given up', () => doneNames(inst).includes(`${retryTaken}.giveup`));
    await new Promise((s) => setTimeout(s, 300));

    assert.match(inst.log(), new RegExp(`wake: requeueing orphaned ${retryTaken.replace(/\./g, '\\.')} -> `));
    assert.deepEqual(spoolNames(inst), []);
    assert.deepEqual(doneNames(inst), [`${retryTaken}.giveup`]);
    assert.equal(promptCount(inst), 0, 'a record that already killed one runner is never replayed again');
    assert.deepEqual(tg.state.sent, []);
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

// ------------------------------------------------- usage-limit model fallback ---
// 11.09.2026: fable's usage bucket ran dry and every turn came back with a
// `result` event saying so — evidence, which the retry policy refuses to
// repeat — so every topic in Telegram went silent. The turn now CONTINUES on
// TG_CLAUDE_FALLBACK_MODEL in the same session, and the daemon remembers.

const OTHER_THREAD = 6;
const spawnArgv = (inst) => readIf(inst.argvFile).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const modelOf = (argv) => argv[argv.indexOf('--model') + 1];

test('(x) a turn cut off by a usage limit is continued on the fallback model, and sticks', async () => {
  const tg = await startTelegram();
  const inst = install('usage-limit');
  const r = spawnRunner(inst, tg.base, {
    TG_BURST_SETTLE_MS: '1',
    FAKE_CLAUDE_MODE: 'usage-limit-on-fable',
  });
  try {
    await waitUp(inst);
    tg.push(ownerMsg(701, 'что там по деплою?'));
    await waitFor('the continuation to be spawned', () => spawnArgv(inst).length >= 2);
    await waitFor('the fallback notice', () => tg.state.sent.length >= 1);
    await new Promise((s) => setTimeout(s, 300)); // nothing more may follow

    const spawns = spawnArgv(inst);
    assert.equal(spawns.length, 2, 'the dead attempt and its continuation — nothing re-run');
    assert.equal(modelOf(spawns[0]), 'fable', 'the turn starts on the configured model');
    assert.equal(modelOf(spawns[1]), 'opus', 'and continues on TG_CLAUDE_FALLBACK_MODEL');
    assert.equal(spawns[1][spawns[1].indexOf('--resume') + 1], 'sess-1', 'the SAME session');
    assert.match(spawns[1].at(-1), /^RUNNER NOTICE: the previous attempt at this very turn stopped/);
    assert.ok(spawns[1].at(-1).endsWith(spawns[0].at(-1)), 'the notice is a prefix: the prompt survives');

    // The topic is told once, in its own language, out of the catalogue.
    assert.equal(tg.state.sent.length, 1);
    assert.equal(
      tg.state.sent[0].text,
      ru.turn.modelFallback
        .split('{{from}}').join('fable')
        .split('{{to}}').join('opus')
        .split('{{ttlMin}}').join('60')
    );
    assert.equal(tg.state.sent[0].message_thread_id, THREAD_ID);
    assert.match(inst.log(), /model fallback tripped: fable -> opus\n/);

    // ...and the turn counts as ANSWERED, which is the whole point.
    const rows = eventRows(inst);
    assert.deepEqual(rows.filter((e) => e.kind === 'turn_fail'), []);
    assert.equal(rows.filter((e) => e.kind === 'turn_result').length, 1);
    assert.equal(rows.filter((e) => e.kind === 'model_fallback').length, 1);

    // Sticky: another topic does not pay for the empty bucket a second time.
    tg.push(ownerMsg(702, 'а по второму?', { message_thread_id: OTHER_THREAD }));
    await waitFor('the next topic to be answered', () => spawnArgv(inst).length >= 3);
    await new Promise((s) => setTimeout(s, 300));
    const all = spawnArgv(inst);
    assert.equal(all.length, 3, 'one spawn for the second topic, not two');
    assert.equal(modelOf(all[2]), 'opus', 'it starts on the fallback straight away');
    assert.equal(tg.state.sent.length, 1, 'and the owner is not told a second time');
  } finally {
    killGroup(r);
    await tg.stop();
  }
});

// The other half of the same memory: the bucket refills, the next turn after the
// TTL probes the primary, and the owner is told it is back. Without this the
// daemon could stay on the fallback for ever AND — because only the FIRST
// refusal is announced — never warn about an outage again.
test('(xi) once the primary answers again the daemon goes back to it, and says so once', async () => {
  const tg = await startTelegram();
  const inst = install('usage-limit-recovery');
  const heal = path.join(inst.home, 'bucket-refilled');
  const r = spawnRunner(inst, tg.base, {
    TG_BURST_SETTLE_MS: '1',
    FAKE_CLAUDE_MODE: 'usage-limit-on-fable',
    FAKE_HEAL_FILE: heal,
    TG_CLAUDE_FALLBACK_TTL_MS: '400', // the probe is due in well under a second
  });
  const ttlOver = () => new Promise((s) => setTimeout(s, 600));
  try {
    await waitUp(inst);

    // 1. The bucket is empty: trip, continue on opus, tell the owner once.
    tg.push(ownerMsg(711, 'что там по деплою?'));
    await waitFor('the continuation', () => spawnArgv(inst).length >= 2);
    await waitFor('the fallback notice', () => tg.state.sent.length >= 1);
    assert.match(inst.log(), /model fallback tripped: fable -> opus\n/);

    // 2. The bucket refills and the TTL runs out, so the next turn probes fable.
    fs.writeFileSync(heal, '');
    await ttlOver();
    tg.push(ownerMsg(712, 'а теперь?'));
    await waitFor('the probe', () => spawnArgv(inst).length >= 3);
    await waitFor('the recovery notice', () => tg.state.sent.length >= 2);
    await new Promise((s) => setTimeout(s, 300)); // nothing more may follow
    const probe = spawnArgv(inst);
    assert.equal(probe.length, 3, 'the probe answered — no continuation behind it');
    assert.equal(modelOf(probe[2]), 'fable', 'at the TTL the turn starts on the primary again');
    assert.equal(
      tg.state.sent[1].text,
      ru.turn.modelRecovered.split('{{model}}').join('fable')
    );
    assert.equal(tg.state.sent[1].message_thread_id, THREAD_ID);
    assert.match(inst.log(), /model recovered: fable\n/);
    const kinds = eventRows(inst).filter((e) => e.kind === 'model_fallback');
    assert.deepEqual(
      kinds.map((e) => e.payload.change),
      ['tripped', 'recovered'],
      'both transitions are in the event log, once each'
    );
    assert.equal(kinds[1].payload.model, 'fable');

    // 3. ...and because the memory was cleared, the NEXT outage is news again —
    // a trip that stayed armed would be announced as 'extended', i.e. silently.
    fs.unlinkSync(heal);
    tg.push(ownerMsg(713, 'и ещё раз'));
    await waitFor('the second outage', () => tg.state.sent.length >= 3);
    await new Promise((s) => setTimeout(s, 300));
    assert.equal(
      tg.state.sent[2].text,
      ru.turn.modelFallback
        .split('{{from}}').join('fable')
        .split('{{to}}').join('opus')
        .split('{{ttlMin}}').join('0')
    );
    assert.deepEqual(
      eventRows(inst).filter((e) => e.kind === 'model_fallback').map((e) => e.payload.change),
      ['tripped', 'recovered', 'tripped']
    );
  } finally {
    killGroup(r);
    await tg.stop();
  }
});
