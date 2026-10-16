#!/usr/bin/env node
// turn.test.ts — dedup + timeout/retry policy of the runner.   Run: node --test
//
// Pins the 10.09 incident: a turn that finished its work and printed its result
// was killed by the runner's own timeout, read as a failure and re-run from
// scratch, so the owner got the whole job twice.
//
// The lifecycle now belongs to @tagents/core, so the fake `claude` comes from
// core's testkit: a REAL executable, spawned by the REAL driver. Nothing about
// the turn is stubbed — which is the only way a test can pin "killed after the
// result is still a success". Everything runs under $TMPDIR: a throwaway claims
// DB, a throwaway agent-state dir, one fake per scenario, all removed after.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fakeClaude, type FakeClaude, type FakeScript } from '@tagents/core';
import { claimMessages, openDb, type ClaimsDb } from '../src/claims.ts';
import { continuationNotice } from '../src/model-fallback.ts';
import {
  attemptTurn,
  CLAIM_OWNER,
  claimIncoming,
  DEFAULT_CLAUDE_TIMEOUT_MS,
  parseTimeoutMs,
  RESULT_EXIT_GRACE_MS,
  retryDecision,
  runClaude,
  settleIncoming,
  TIMEOUT_WARN_BEFORE_MS,
  turnSpec,
  type Attempt,
  type AttemptPlan,
  type FallbackPolicy,
  type TurnRequest,
} from '../src/turn.ts';

const REPLY = 'Отправил в «dev»: сводку (msg 470)';

let tmp: string;
let db: ClaimsDb;
const fakes: FakeClaude[] = [];

/** A fake `claude` for one scenario; every one of them is cleaned up after. */
function fake(script: FakeScript): string {
  const f = fakeClaude(script);
  fakes.push(f);
  return f.bin;
}

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'turn-test-'));
  db = openDb(path.join(tmp, 'claims.sqlite'));
  // The driver reads the tmux hook's records to find a transcript when a turn
  // resumes. Point it at an empty temp dir so the suite never touches the real
  // ~/.claude/agent-state.
  process.env['TA_STATE_DIR'] = path.join(tmp, 'agent-state');
});
after(() => {
  for (const f of fakes) f.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

const msg = (id: number, chatId = -100123) => ({
  message_id: id,
  chat: { id: chatId, type: 'supergroup' },
  text: `m${id}`,
});
const quiet = (): void => {};
const collect = (lines: string[]) => (...a: string[]): void => {
  lines.push(a.join(' '));
};

type RunOpts = Omit<Partial<TurnRequest>, 'bin' | 'prompt'>;

// Every "it hung and we killed it" case has to let the fake PRINT first — its
// tool call is the evidence the retry policy is judged on, and a kill that
// lands before node has booted would make the case pass for the wrong reason.
// Generous on purpose: the suite runs its files in parallel.
const KILL_MS = 1500;

function run(bin: string, opts: RunOpts = {}): Promise<Attempt> {
  return runClaude({
    prompt: 'go',
    bin,
    cwd: tmp,
    timeoutMs: KILL_MS,
    warnBeforeMs: 0,
    exitGraceMs: 300,
    log: quiet,
    ...opts,
  });
}

// ------------------------------------------------------------------ dedup ---

test('a message delivered twice is sent to the model once', () => {
  const lines: string[] = [];
  const first = claimIncoming(db, [msg(1)], { log: collect(lines) });
  assert.equal(first.length, 1);
  assert.match(lines[0] ?? '', /^claimed \[-100123:1\]/);
  // Redelivered while the first turn is still running (same process holds it).
  const again = claimIncoming(db, [msg(1)], { log: collect(lines) });
  assert.equal(again.length, 0);
  assert.match(lines[1] ?? '', /^already-claimed \[-100123:1\]/);
  // Answered; a later replay must not open a new turn either.
  settleIncoming(db, [msg(1)], { note: 'answered', log: collect(lines) });
  assert.match(lines[2] ?? '', /^done \[-100123:1\] answered/);
  const replay = claimIncoming(db, [msg(1)], { log: collect(lines) });
  assert.equal(replay.length, 0);
  assert.match(lines[3] ?? '', /^already-handled \[-100123:1\]/);
});

test('new messages in the same batch as a duplicate still go through', () => {
  claimIncoming(db, [msg(2)], { log: quiet });
  settleIncoming(db, [msg(2)], { log: quiet });
  const out = claimIncoming(db, [msg(2), msg(3)], { log: quiet });
  assert.deepEqual(
    out.map((m) => m.message_id),
    [3]
  );
});

test('a message another agent holds is not touched', () => {
  claimMessages(db, { chatId: -100123, messageIds: [4], owner: 'other-bot', pid: process.pid });
  const lines: string[] = [];
  assert.equal(claimIncoming(db, [msg(4)], { log: collect(lines) }).length, 0);
  assert.match(lines[0] ?? '', /^busy \[-100123:4\]: held by other-bot/);
});

test('a message our dead predecessor held is reclaimed', () => {
  claimMessages(db, { chatId: -100123, messageIds: [5], owner: CLAIM_OWNER, pid: 99999 });
  const lines: string[] = [];
  assert.equal(claimIncoming(db, [msg(5)], { log: collect(lines) }).length, 1);
  assert.match(lines[0] ?? '', /^reclaimed \[-100123:5\]: previous holder pid 99999 is dead$/);
  // ...and it is now held by THIS process, so a second delivery is blocked.
  assert.equal(claimIncoming(db, [msg(5)], { log: quiet }).length, 0);
});

test('without a registry every message passes', () => {
  assert.equal(claimIncoming(null, [msg(6), msg(6)], { log: quiet }).length, 2);
});

// ----------------------------------------------------------- turn / retry ---

test('the constants runner.mjs imports keep their values', () => {
  assert.equal(DEFAULT_CLAUDE_TIMEOUT_MS, 50 * 60 * 1000);
  assert.equal(TIMEOUT_WARN_BEFORE_MS, 5 * 60 * 1000);
  assert.equal(RESULT_EXIT_GRACE_MS, 60 * 1000);
  assert.equal(CLAIM_OWNER, 'orchestrator');
  assert.equal(parseTimeoutMs('abc', 7), 7);
  assert.equal(parseTimeoutMs('120000'), 120000);
  assert.equal(parseTimeoutMs(''), DEFAULT_CLAUDE_TIMEOUT_MS);
});

// An account is a whole login, not a setting, so turnSpec never guesses: null
// (the default) means the personal one AND drops an inherited CLAUDE_CONFIG_DIR
// in the driver, and a string is what the runner picked for THIS turn out of
// TG_CLAUDE_CONFIG_DIR — which is how the deadline reverts with no restart.
test('turnSpec carries the account the runner chose, and null when it chose none', () => {
  const base: TurnRequest = { prompt: 'hi' };
  assert.equal(turnSpec(base).configDir, null, 'an omitted account is the personal one');
  assert.equal(turnSpec({ ...base, configDir: null }).configDir, null);
  assert.equal(
    turnSpec({ ...base, configDir: '/var/x/.claude-work' }).configDir,
    '/var/x/.claude-work'
  );
});

test('the session spec becomes the argv and the env the daemon has always sent', async () => {
  const argvFile = path.join(tmp, 'argv.json');
  const bin = fake({ result: { text: 'done' }, argvFile });
  const a = await run(bin, {
    model: 'fable',
    effort: 'xhigh',
    systemPromptFile: path.join(tmp, 'agent.md'),
    resumeId: 'sess-9',
    logFile: path.join(tmp, 'runner.log'),
    env: { TELEGRAM_BOT_TOKEN: 'tok', OWNER_ID: '7' },
  });
  assert.equal(a.ok, true);
  const seen = JSON.parse(readFileSync(argvFile, 'utf8')) as {
    argv: string[];
    env: Record<string, string | undefined>;
  };
  assert.deepEqual(seen.argv, [
    '-p',
    '--model',
    'fable',
    '--effort',
    'xhigh',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file',
    path.join(tmp, 'agent.md'),
    '--resume',
    'sess-9',
    'go',
  ]);
  assert.equal(seen.env['TA_LABEL'], 'tg-orchestrator');
  assert.equal(seen.env['TA_LOG'], path.join(tmp, 'runner.log'));
  assert.equal(seen.env['TELEGRAM_BOT_TOKEN'], 'tok');
  assert.equal(seen.env['OWNER_ID'], '7');
  // The personal account: every CLAUDE* variable is dropped before the child.
  assert.deepEqual(
    Object.keys(seen.env).filter((k) => k.startsWith('CLAUDE')),
    []
  );
});

test('a clean turn is ok', async () => {
  const a = await run(fake({ tools: ['Bash'], text: REPLY, result: { text: REPLY } }));
  assert.equal(a.ok, true);
  assert.equal(a.outcome.kind, 'ok');
  assert.equal(a.killedAfterResult, false);
  assert.equal(a.timedOut, false);
  assert.equal(a.error, null);
  assert.equal(a.sessionId, 'sess-1');
  assert.equal(a.toolUses, 1);
  assert.equal(a.text, REPLY);
  assert.equal(a.costUSD, 0.1);
  assert.equal(a.numTurns, 3);
  assert.ok(typeof a.durationMs === 'number');
});

test('a turn killed after printing its result is accepted, not retried', async () => {
  const lines: string[] = [];
  const bin = fake({ tools: ['Bash'], text: REPLY, result: { text: REPLY }, hangAfterResult: true });
  const t0 = Date.now();
  const a = await run(bin, { log: collect(lines) });
  assert.equal(a.ok, true, 'result received => the turn succeeded');
  assert.equal(a.outcome.kind, 'killed-after-result');
  assert.equal(a.killedAfterResult, true);
  assert.equal(a.timedOut, false, 'killed by the post-result grace, not by the timeout');
  assert.equal(a.error, null, 'a killed shutdown is not an error the owner hears about');
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the full timeout');
  assert.match(lines.join('\n'), /printed its result but did not exit/);
  assert.equal(a.text, REPLY);
  assert.deepEqual(retryDecision(a, 'old-session'), { retry: false, reason: 'ok' });
});

test('a turn that timed out after tool calls is a failure but NOT retried', async () => {
  const bin = fake({ tools: ['Bash'], result: null, hang: true });
  const a = await run(bin, { timeoutMs: KILL_MS });
  assert.equal(a.ok, false);
  assert.equal(a.outcome.kind, 'timeout');
  assert.equal(a.timedOut, true);
  assert.equal(a.toolUses, 1);
  assert.match(a.error ?? '', new RegExp(`^exit=SIGKILL \\(timeout ${KILL_MS}ms, 1 tool call\\(s\\)\\)`));
  const d = retryDecision(a, 'old-session');
  assert.equal(d.retry, false);
  assert.match(d.reason, /^retry-suppressed: turn already produced 1 tool call\(s\) before the timeout$/);
});

test('a timeout after assistant text alone is not retried either', async () => {
  const bin = fake({ text: 'начал разбираться', result: null, hang: true });
  const a = await run(bin, { timeoutMs: KILL_MS });
  assert.equal(a.timedOut, true);
  assert.equal(a.toolUses, 0);
  assert.equal(
    retryDecision(a, 'old-session').reason,
    'retry-suppressed: turn already produced assistant text before the timeout'
  );
});

test('a failed resume that did nothing IS retried fresh', async () => {
  const bin = fake({
    result: null,
    stderr: 'No conversation found with session ID: abc\n',
    exitCode: 1,
  });
  const a = await run(bin);
  assert.equal(a.ok, false);
  assert.equal(a.outcome.kind, 'exited');
  assert.equal(a.toolUses, 0);
  assert.match(a.error ?? '', /^exit=1 No conversation found/);
  assert.deepEqual(retryDecision(a, 'old-session'), {
    retry: true,
    reason: 'retry-fresh: resume failed before doing anything',
  });
  assert.equal(retryDecision(a, null).retry, false, 'a fresh session has nothing to fall back to');
});

test('a silent timeout (nothing produced) is retried fresh', async () => {
  const a = await run(fake({ silent: true }), { timeoutMs: 300 });
  assert.equal(a.ok, false);
  assert.equal(a.timedOut, true);
  assert.equal(retryDecision(a, 'old-session').reason, 'retry-fresh: timed out before doing anything');
});

test('attemptTurn: the runner spawns once for a killed-after-result turn, twice for a dead resume', async () => {
  const counts = path.join(tmp, 'spawns.txt');
  const lines: string[] = [];
  const runs = (): number => readFileSync(counts, 'utf8').split('\n').filter(Boolean).length;

  const killed = fake({
    tools: ['Bash'],
    text: REPLY,
    result: { text: REPLY },
    hangAfterResult: true,
    countFile: counts,
  });
  const r1 = await attemptTurn(() => run(killed, { log: collect(lines) }), 'old-session', collect(lines));
  assert.equal(r1.attempt.ok, true);
  assert.equal(r1.retried, false);
  assert.equal(runs(), 1, 'a finished turn is never run a second time');

  const counts2 = path.join(tmp, 'spawns2.txt');
  const dead = fake({ result: null, stderr: 'No conversation found\n', exitCode: 1, countFile: counts2 });
  const good = fake({ tools: ['Bash'], text: REPLY, result: { text: REPLY }, countFile: counts2 });
  const bins = [dead, good];
  const r2 = await attemptTurn(() => run(bins.shift() ?? good), 'old-session', collect(lines));
  assert.equal(r2.retried, true);
  assert.equal(r2.attempt.ok, true);
  assert.equal(readFileSync(counts2, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.match(lines.at(-1) ?? '', /^retry-fresh: resume failed before doing anything: exit=1/);

  const counts3 = path.join(tmp, 'spawns3.txt');
  const busy = fake({ tools: ['Bash'], result: null, hang: true, countFile: counts3 });
  const r3 = await attemptTurn(() => run(busy, { timeoutMs: KILL_MS }), 'old-session', collect(lines));
  assert.equal(r3.retried, false);
  assert.equal(readFileSync(counts3, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.match(lines.at(-1) ?? '', /^retry-suppressed/);
});

test('the topic is warned before the kill', async () => {
  const warns: Array<{ elapsedMs: number; leftMs: number }> = [];
  const busy = fake({ tools: ['Bash'], result: null, hang: true });
  const a = await run(busy, {
    timeoutMs: 700,
    warnBeforeMs: 300,
    onWarn: (w) => {
      warns.push(w);
    },
  });
  assert.equal(a.timedOut, true);
  assert.equal(warns.length, 1);
  const first = warns[0];
  assert.ok(first && first.elapsedMs >= 350 && first.elapsedMs < 700, `warned at ${first?.elapsedMs}ms`);
  assert.equal(first?.leftMs, 300);
  // ...but not for a turn that finished in time.
  const w2: Array<{ elapsedMs: number; leftMs: number }> = [];
  await run(fake({ result: { text: 'done' } }), {
    timeoutMs: 5000,
    warnBeforeMs: 4000,
    onWarn: (w) => {
      w2.push(w);
    },
  });
  assert.equal(w2.length, 0);
});

test('a rejected warning does not take the turn down with it', async () => {
  const lines: string[] = [];
  const busy = fake({ tools: ['Bash'], result: null, hang: true });
  const a = await run(busy, {
    timeoutMs: 700,
    warnBeforeMs: 300,
    log: collect(lines),
    onWarn: () => Promise.reject(new Error('telegram is down')),
  });
  assert.equal(a.timedOut, true);
  assert.match(lines.join('\n'), /timeout warning failed: telegram is down/);
});

// ------------------------------------------------------- usage-limit fallback ---
// 11.09.2026: fable's usage bucket was empty, so every turn came back with a
// `result` event carrying "You're out of usage credits" — evidence, which the
// retry policy correctly refuses to repeat. Result: every topic dead. The turn
// has to CONTINUE on another model instead, in the same session.

/** The exact sentence the CLI printed, as it reaches attempt.error. */
const OUT_OF_CREDITS =
  "You're out of usage credits. Switch to another model, or manage usage credits " +
  'at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.';

/** A fake whose turn dies the way fable died: text, an is_error result, exit 1. */
const outOfCredits = (extra: Partial<FakeScript> = {}): FakeScript => ({
  sessionId: 'sess-fable',
  tools: ['Bash'],
  text: OUT_OF_CREDITS,
  result: { isError: true, text: OUT_OF_CREDITS },
  exitCode: 1,
  ...extra,
});

/**
 * What runner.ts does with an AttemptPlan, in miniature: the model picks the
 * binary, the plan's resume id is the one used, and a continuation prefixes the
 * prompt with the RUNNER NOTICE. `bins` maps a model to the fakes it gets, in
 * order — the last one answers every further spawn.
 */
function planned(bins: Record<string, string[]>): (plan: AttemptPlan) => Promise<Attempt> {
  return (plan: AttemptPlan): Promise<Attempt> => {
    const model = plan.model ?? 'fable';
    const queue = bins[model] ?? [];
    assert.ok(queue.length > 0, `no fake claude for model ${model}`);
    const bin = (queue.length > 1 ? queue.shift() : queue[0]) ?? '';
    return runClaude({
      prompt: (plan.continuation ? continuationNotice(plan.continuation) : '') + 'go',
      bin,
      cwd: tmp,
      timeoutMs: KILL_MS,
      warnBeforeMs: 0,
      exitGraceMs: 300,
      log: quiet,
      resumeId: plan.resumeId,
      ...(plan.model === undefined ? {} : { model: plan.model }),
    });
  };
}

const argvOf = (file: string): string[] =>
  (JSON.parse(readFileSync(file, 'utf8')) as { argv: string[] }).argv;
const spawnCount = (file: string): number => readFileSync(file, 'utf8').split('\n').filter(Boolean).length;

test('a turn cut off by a usage limit continues on the fallback model in the same session', async () => {
  const counts = path.join(tmp, 'fb-spawns.txt');
  const fableArgv = path.join(tmp, 'fb-fable-argv.json');
  const opusArgv = path.join(tmp, 'fb-opus-argv.json');
  const lines: string[] = [];
  const fired: Array<{ from: string; to: string }> = [];

  const fable = fake(outOfCredits({ argvFile: fableArgv, countFile: counts }));
  const opus = fake({
    tools: ['Bash'],
    text: REPLY,
    result: { text: REPLY },
    argvFile: opusArgv,
    countFile: counts,
  });

  const policy: FallbackPolicy = {
    model: 'fable',
    fallbackModel: 'opus',
    onFallback: ({ from, to }) => fired.push({ from, to }),
  };
  const r = await attemptTurn(planned({ fable: [fable], opus: [opus] }), null, collect(lines), policy);

  assert.equal(r.attempt.ok, true, 'the turn was answered — on the other model');
  assert.equal(r.fellBack, true);
  assert.equal(r.model, 'opus');
  assert.equal(r.retried, false, 'a continuation is not a fresh re-run');
  assert.equal(r.attempt.text, REPLY);
  assert.equal(spawnCount(counts), 2, 'one attempt per model, no more');

  // The dead attempt ran on fable...
  assert.ok(argvOf(fableArgv).includes('fable'));
  // ...and the continuation resumes ITS transcript on opus.
  const opusArgs = argvOf(opusArgv);
  assert.equal(opusArgs[opusArgs.indexOf('--model') + 1], 'opus');
  assert.equal(opusArgs[opusArgs.indexOf('--resume') + 1], 'sess-fable');
  const prompt = opusArgs.at(-1) ?? '';
  assert.match(prompt, /^RUNNER NOTICE: /);
  assert.match(prompt, /continues the SAME session on `opus` — pick up where the transcript ends/);
  assert.ok(prompt.includes('1 tool call(s)'), 'the notice says what the dead attempt had already done');
  assert.ok(prompt.endsWith('go'), 'the owner\'s prompt is still there, after the notice');

  assert.deepEqual(fired, [{ from: 'fable', to: 'opus' }], 'the topic is told once, before the retry');
  assert.match(
    lines.join('\n'),
    /^usage-limit on fable: continuing the same session on opus: exit=1 You're out of usage credits\./m
  );
});

test('without a fallback model a usage-limit failure is reported exactly as before', async () => {
  const suppressed = (r: Awaited<ReturnType<typeof attemptTurn>>, counts: string): void => {
    assert.equal(r.attempt.ok, false);
    assert.equal(r.fellBack, false);
    assert.equal(r.retried, false);
    assert.match(r.decision.reason, /^retry-suppressed: turn already produced/);
    assert.equal(spawnCount(counts), 1, 'nothing is re-run — that is the 10.09 rule');
  };

  // The knob explicitly switched off (TG_CLAUDE_FALLBACK_MODEL=)...
  const offCounts = path.join(tmp, 'fb-off-null.txt');
  const off = fake(outOfCredits({ countFile: offCounts }));
  suppressed(
    await attemptTurn(planned({ fable: [off] }), 'old-session', quiet, {
      model: 'fable',
      fallbackModel: null,
    }),
    offCounts
  );

  // ...and a caller that passes no policy at all (every other attemptTurn user).
  const bareCounts = path.join(tmp, 'fb-off-none.txt');
  const bare = fake(outOfCredits({ countFile: bareCounts }));
  const r = await attemptTurn(planned({ fable: [bare] }), 'old-session', quiet);
  suppressed(r, bareCounts);
  assert.equal(r.model, undefined, 'no policy, no opinion about which model ran');
});

test('a usage limit on the fallback model itself is not run a second time', async () => {
  const counts = path.join(tmp, 'fb-sticky.txt');
  const lines: string[] = [];
  // The daemon is already on opus (sticky after an earlier trip) and opus is out
  // of credits too: there is nowhere left to go, so it stays one spawn.
  const opus = fake(outOfCredits({ countFile: counts }));
  const r = await attemptTurn(
    planned({ opus: [opus] }),
    'old-session',
    collect(lines),
    { model: 'opus', fallbackModel: 'opus' }
  );
  assert.equal(r.attempt.ok, false);
  assert.equal(r.fellBack, false);
  assert.equal(r.model, 'opus');
  assert.equal(spawnCount(counts), 1);
  assert.match(lines.at(-1) ?? '', /^retry-suppressed/);
});

test('a dead resume on the fallback attempt is retried fresh, still on the fallback model', async () => {
  const counts = path.join(tmp, 'fb-dead-resume.txt');
  const freshArgv = path.join(tmp, 'fb-fresh-argv.json');
  const lines: string[] = [];
  const fable = fake(outOfCredits({ countFile: counts }));
  const deadResume = fake({
    result: null,
    stderr: 'No conversation found with session ID: sess-fable\n',
    exitCode: 1,
    countFile: counts,
  });
  const good = fake({
    tools: ['Bash'],
    text: REPLY,
    result: { text: REPLY },
    argvFile: freshArgv,
    countFile: counts,
  });

  const r = await attemptTurn(
    planned({ fable: [fable], opus: [deadResume, good] }),
    null,
    collect(lines),
    { model: 'fable', fallbackModel: 'opus' }
  );
  assert.equal(r.attempt.ok, true);
  assert.equal(r.retried, true);
  assert.equal(r.fellBack, true);
  assert.equal(r.model, 'opus');
  assert.equal(spawnCount(counts), 3, 'fable, the continuation, then the fresh re-run');

  const argv = argvOf(freshArgv);
  assert.equal(argv.includes('--resume'), false, 'the fresh run has no transcript to resume');
  assert.equal(argv[argv.indexOf('--model') + 1], 'opus', 'and it must not go back to the empty bucket');
  const freshPrompt = argv.at(-1) ?? '';
  assert.match(freshPrompt, /^RUNNER NOTICE: /);
  assert.match(
    freshPrompt,
    /check the topic for anything already posted/,
    'with no transcript, the topic is the only place it can see what already happened'
  );
  assert.equal(
    /continues the SAME session/.test(freshPrompt),
    false,
    'and it must not be told it is continuing a session it cannot see'
  );
});

test('a missing binary is a plain failure', async () => {
  const a = await run(path.join(tmp, 'no-such-claude'), { timeoutMs: 1000 });
  assert.equal(a.ok, false);
  assert.equal(a.outcome.kind, 'spawn-failed');
  assert.match(a.error ?? '', /^exit=null spawn: /);
  assert.equal(a.toolUses, 0);
  assert.equal(a.sessionId, null);
});
