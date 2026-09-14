// node --test model-fallback.test.ts
//
// Pins the 11.09.2026 incident from the other side: recognising the CLI's
// "out of usage credits" refusal, and the daemon-wide memory that keeps the
// next turns off a model whose bucket is empty without keeping them off it
// forever. Pure data and an injected clock — nothing here spawns anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  continuationNotice,
  isUsageLimitError,
  ModelFallback,
  USAGE_LIMIT_PATTERNS,
} from '../src/model-fallback.ts';

// The exact sentence the CLI printed on 11.09.2026, as it reaches the runner:
// `result` text, wrapped by formatAttemptError into attempt.error.
const OUT_OF_CREDITS =
  "You're out of usage credits. Switch to another model, or manage usage credits " +
  'at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.';
const ATTEMPT_ERROR = `exit=1 ${OUT_OF_CREDITS}`;

const TTL = 60 * 60 * 1000;

/** A ModelFallback whose clock the test moves by hand. */
function at(start = 1_000_000, fallback: string | null = 'opus'): {
  fb: ModelFallback;
  tick: (ms: number) => void;
  now: () => number;
} {
  let clock = start;
  const fb = new ModelFallback({ primary: 'fable', fallback, ttlMs: TTL, now: () => clock });
  return { fb, tick: (ms: number): void => void (clock += ms), now: (): number => clock };
}

// ------------------------------------------------------------ recognition ---

test('the 11.09 refusal is recognised, with and without the attempt.error prefix', () => {
  assert.equal(isUsageLimitError(OUT_OF_CREDITS), true);
  assert.equal(isUsageLimitError(ATTEMPT_ERROR), true);
  assert.ok(USAGE_LIMIT_PATTERNS.length >= 1);
});

test('the older CLI wordings are recognised too', () => {
  for (const line of [
    'exit=1 Claude AI usage limit reached|1757600000',
    'exit=1 You have hit your usage limit. Try again later.',
    'exit=1 You have reached your weekly limit for this model.',
    "exit=1 YOU'RE OUT OF USAGE CREDITS.",
  ]) {
    assert.equal(isUsageLimitError(line), true, line);
  }
});

test('every other failure stays what it was — this must not swallow real errors', () => {
  for (const line of [
    'exit=1 No conversation found with session ID: abc',
    'exit=1 Connection error.',
    'exit=SIGKILL (timeout 3000000ms, 4 tool call(s)) ',
    'exit=null spawn: spawn claude ENOENT',
    'exit=1 the rate limiter says slow down',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isUsageLimitError(line), false, String(line));
  }
});

// --------------------------------------------------------------- the memory ---

test('idle: every turn starts on the primary', () => {
  const { fb } = at();
  assert.equal(fb.modelFor(), 'fable');
  assert.equal(fb.active(), false);
  assert.deepEqual(fb.snapshot(), {
    primary: 'fable',
    fallback: 'opus',
    active: false,
    since: null,
    until: null,
  });
});

test('a trip makes the next turns start on the fallback, until the TTL is over', () => {
  const { fb, tick } = at(1_000_000);
  assert.equal(fb.trip(), 'tripped');
  assert.equal(fb.active(), true);
  assert.equal(fb.modelFor(), 'opus');
  assert.deepEqual(fb.snapshot(), {
    primary: 'fable',
    fallback: 'opus',
    active: true,
    since: 1_000_000,
    until: 1_000_000 + TTL,
  });

  tick(TTL - 1);
  assert.equal(fb.modelFor(), 'opus', 'one millisecond before the TTL it is still sticky');

  tick(1);
  assert.equal(fb.active(), false);
  assert.equal(fb.modelFor(), 'fable', 'at the TTL the next turn probes the primary again');
});

test('a probe that fails again extends the TTL and is not announced twice', () => {
  const { fb, tick } = at(1_000_000);
  assert.equal(fb.trip(), 'tripped');
  tick(TTL);
  assert.equal(fb.modelFor(), 'fable', 'the probe');
  assert.equal(fb.trip(), 'extended', 'still tripped, so the topic has already been told');
  assert.equal(fb.modelFor(), 'opus');
  assert.equal(fb.snapshot().until, 1_000_000 + 2 * TTL, 'a fresh TTL from the failed probe');
  assert.equal(fb.snapshot().since, 1_000_000, 'but it has been out of credits since the FIRST refusal');
  // ...and inside a live window a second trip is 'extended' too.
  assert.equal(fb.trip(), 'extended');
});

test('a turn that worked on the primary recovers, and says so exactly once', () => {
  const { fb, tick, now } = at();
  assert.equal(fb.primaryOk(now()), 'none', 'nothing to recover from while idle');
  fb.trip();
  tick(1);
  assert.equal(fb.primaryOk(now()), 'recovered');
  assert.equal(fb.active(), false);
  assert.equal(fb.modelFor(), 'fable');
  assert.equal(fb.primaryOk(now()), 'none', 'the second turn is not news');
  // A window that merely EXPIRED still recovers when the probe comes back ok.
  fb.trip();
  tick(TTL + 1);
  assert.equal(fb.active(), false);
  assert.equal(fb.primaryOk(now()), 'recovered');
});

test('a turn that STARTED before the refusal cannot clear it', () => {
  // Topics run side by side: A starts on the primary, B is refused while A is
  // still running, and A then finishes fine. Accepting A as a probe would erase
  // the trip B just armed, tell the owner the model is back, and send the next
  // turn into the same empty bucket.
  const { fb, tick, now } = at(1_000_000);
  const startedA = now();
  tick(60_000);
  assert.equal(fb.trip(), 'tripped', 'B is refused while A is still running');
  tick(1_000);
  assert.equal(fb.primaryOk(startedA), 'none', 'A proves nothing about the bucket B found empty');
  assert.equal(fb.active(), true, 'so the trip stands');
  assert.equal(fb.modelFor(), 'opus');
  assert.equal(fb.snapshot().since, 1_060_000, 'and it is still out of credits since B was refused');
  // A turn that started AFTER the refusal is a real probe.
  assert.equal(fb.primaryOk(now()), 'recovered');
});

test('without a fallback model the memory is inert: the primary, always', () => {
  const { fb } = at(1_000_000, null);
  assert.equal(fb.modelFor(), 'fable');
  assert.equal(fb.trip(), 'tripped', 'the refusal is still recorded');
  assert.equal(fb.active(), false, 'but there is nowhere to be active about');
  assert.equal(fb.modelFor(), 'fable');
  assert.equal(fb.snapshot().fallback, null);
});

// -------------------------------------------------------------- the notice ---

test('the continuation notice names both models and what the dead attempt did', () => {
  const notice = continuationNotice({ from: 'fable', to: 'opus', toolUses: 5, resumed: true });
  assert.match(notice, /^RUNNER NOTICE: /);
  assert.ok(notice.includes('`fable`'));
  assert.ok(notice.includes('`opus`'));
  assert.ok(notice.includes('5 tool call(s)'));
  assert.match(notice, /do not repeat side effects that already happened/);
  assert.ok(notice.endsWith('\n\n'), 'it is a prompt PREFIX: the real prompt follows');
});

test('with no transcript to resume the notice points at the topic instead', () => {
  const fresh = continuationNotice({ from: 'fable', to: 'opus', toolUses: 5, resumed: false });
  assert.match(fresh, /^RUNNER NOTICE: /);
  assert.ok(fresh.includes('5 tool call(s)'), 'it still says what was already done');
  assert.match(fresh, /check the topic for anything already posted/);
  assert.equal(
    /pick up where the transcript ends/.test(fresh),
    false,
    'there is no transcript — promising one is how the work gets redone'
  );
  assert.match(fresh, /do not repeat side effects that already happened/);
  assert.ok(fresh.endsWith('\n\n'));
});
