// node --test scheduler.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler, type SchedulerItem, type SchedulerOptions } from '../src/scheduler.ts';

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void };

const deferred = (): Deferred => {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// noUncheckedIndexedAccess: reading past the end is a test bug, so say so here
// instead of threading `?.` through every assertion.
function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`nothing at index ${i} (length ${list.length})`);
  return v;
}
function msgsOf(item: SchedulerItem): unknown[] {
  if (item.kind !== 'msgs') throw new Error(`expected a msgs item, got ${item.kind}`);
  return item.msgs;
}
function jobOf(item: SchedulerItem): string | number {
  if (item.kind !== 'wake') throw new Error(`expected a wake item, got ${item.kind}`);
  return (item.rec as { job: string | number }).job;
}

type Call = { key: string; item: SchedulerItem };

// A `run` that records every call and blocks until the test releases it.
function harness(opts: Omit<SchedulerOptions, 'run'> = {}) {
  const calls: Call[] = [];
  const gates: Deferred[] = [];
  const run = (key: string, item: SchedulerItem): Promise<void> => {
    const g = deferred();
    calls.push({ key, item });
    gates.push(g);
    return g.promise;
  };
  const sched = createScheduler({ run, ...opts });
  return { sched, calls, gates };
}

test('different keys run side by side', async () => {
  const { sched, calls, gates } = harness({ maxParallel: 3 });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [1] });
  sched.enqueue('b:0', { kind: 'msgs', msgs: [2] });
  await tick();
  assert.deepEqual(
    calls.map((c) => c.key),
    ['a:0', 'b:0']
  );
  assert.equal(sched.snapshot().inflight.length, 2);
  at(gates, 0).resolve();
  at(gates, 1).resolve();
  await sched.drain();
  assert.equal(sched.idle(), true);
});

test('same key is serial and messages typed mid-turn fold into one next turn', async () => {
  const { sched, calls, gates } = harness({ maxParallel: 3 });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [1] });
  await tick();
  assert.equal(calls.length, 1);
  sched.enqueue('a:0', { kind: 'msgs', msgs: [2] });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [3, 4] });
  await tick();
  assert.equal(calls.length, 1, 'second turn must not start while the first runs');
  assert.equal(sched.snapshot().queued, 2);
  at(gates, 0).resolve();
  await tick();
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(msgsOf(at(calls, 1).item), [2, 3, 4]);
  at(gates, 1).resolve();
  await sched.drain();
});

test('maxParallel caps concurrent turns, waiters served FIFO', async () => {
  const { sched, calls, gates } = harness({ maxParallel: 2 });
  for (const k of ['a:0', 'b:0', 'c:0', 'd:0']) sched.enqueue(k, { kind: 'msgs', msgs: [k] });
  await tick();
  assert.deepEqual(
    calls.map((c) => c.key),
    ['a:0', 'b:0']
  );
  assert.equal(sched.snapshot().inflight.length, 2);
  at(gates, 1).resolve(); // b finishes first — c takes its slot, d still waits
  await tick();
  await tick();
  assert.deepEqual(
    calls.map((c) => c.key),
    ['a:0', 'b:0', 'c:0']
  );
  at(gates, 0).resolve();
  await tick();
  await tick();
  assert.deepEqual(
    calls.map((c) => c.key),
    ['a:0', 'b:0', 'c:0', 'd:0']
  );
  at(gates, 2).resolve();
  at(gates, 3).resolve();
  await sched.drain();
});

test('a throwing run is logged and the queue keeps going', async () => {
  const logged: string[] = [];
  const { sched, calls, gates } = harness({
    maxParallel: 1,
    log: (...a: unknown[]) => logged.push(a.join(' ')),
  });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [1] });
  sched.enqueue('a:0', { kind: 'wake', rec: { job: 'x' } });
  await tick();
  at(gates, 0).reject(new Error('boom'));
  await tick();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(at(calls, 1).item.kind, 'wake');
  assert.ok(
    logged.some((l) => l.includes('boom')),
    'error must be logged'
  );
  at(gates, 1).resolve();
  await sched.drain();
  assert.equal(sched.snapshot().inflight.length, 0);
});

test('wake items never fold and keep their position', async () => {
  const { sched, calls, gates } = harness({ maxParallel: 1 });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [1] });
  sched.enqueue('a:0', { kind: 'wake', rec: { job: 'w1' } });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [2] });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [3] });
  sched.enqueue('a:0', { kind: 'wake', rec: { job: 'w2' } });
  for (let i = 0; i < 4; i++) {
    await tick();
    at(gates, i).resolve();
    await tick();
  }
  await sched.drain();
  assert.deepEqual(
    calls.map((c) => (c.item.kind === 'wake' ? jobOf(c.item) : msgsOf(c.item))),
    [[1], 'w1', [2, 3], 'w2']
  );
});

test('a key enqueued right after its worker exits gets a fresh worker', async () => {
  const { sched, calls, gates } = harness({ maxParallel: 2 });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [1] });
  await tick();
  at(gates, 0).resolve();
  await sched.drain();
  sched.enqueue('a:0', { kind: 'msgs', msgs: [2] });
  await tick();
  assert.equal(calls.length, 2);
  at(gates, 1).resolve();
  await sched.drain();
});

test('onChange sees every transition and idle() is true only when nothing is left', async () => {
  const seen: Array<[number, number]> = [];
  const { sched, gates } = harness({
    maxParallel: 1,
    onChange: (s) => seen.push([s.inflight.length, s.queued]),
  });
  sched.enqueue('a:0', { kind: 'msgs', msgs: [1] });
  sched.enqueue('b:0', { kind: 'msgs', msgs: [2] });
  await tick();
  assert.equal(sched.idle(), false);
  at(gates, 0).resolve();
  await tick();
  await tick();
  at(gates, 1).resolve();
  await sched.drain();
  assert.equal(sched.idle(), true);
  assert.deepEqual(seen.at(-1), [0, 0]);
  assert.ok(seen.some(([inflight, queued]) => inflight === 1 && queued === 1));
});

test('rejects bad input loudly', () => {
  const { sched } = harness();
  assert.throws(() => sched.enqueue('', { kind: 'msgs', msgs: [] }));
  assert.throws(() => sched.enqueue('a:0', { kind: 'nope' }));
  assert.throws(() => sched.enqueue('a:0', { kind: 'msgs' }));
  assert.throws(() => createScheduler({ maxParallel: 0, run() {} }));
});

// The invariants the runner relies on, checked under random interleavings of
// enqueues and completions rather than the hand-picked cases above. Seeded, so
// a failure reproduces.
test('randomized interleavings: same key never overlaps, cap holds, every item runs once in order', async () => {
  let seed = 20260911;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 40; round++) {
    const maxParallel = 1 + Math.floor(rnd() * 3);
    const keys = ['a:0', 'b:0', 'c:0', 'd:0'].slice(0, 1 + Math.floor(rnd() * 4));
    const runningByKey = new Map<string, number>();
    let inflight = 0;
    let maxInflight = 0;
    const runs: Call[] = [];
    const pending: Deferred[] = [];
    const run = (key: string, item: SchedulerItem): Promise<void> => {
      assert.equal(runningByKey.get(key) ?? 0, 0, `round ${round}: key ${key} ran twice at once`);
      runningByKey.set(key, 1);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      runs.push({ key, item });
      const g = deferred();
      pending.push(g);
      return g.promise.finally(() => {
        runningByKey.set(key, 0);
        inflight--;
      });
    };
    const sched = createScheduler({ maxParallel, run });
    const sent = new Map<string, string[]>(keys.map((k) => [k, []]));
    let seq = 0;
    const total = 5 + Math.floor(rnd() * 20);
    for (let i = 0; i < total; i++) {
      const k = at(keys, Math.floor(rnd() * keys.length));
      const into = sent.get(k);
      if (!into) throw new Error(`unknown key ${k}`);
      if (rnd() < 0.25) {
        sched.enqueue(k, { kind: 'wake', rec: { job: seq } });
        into.push(`w${seq}`);
        seq++;
      } else {
        const n = 1 + Math.floor(rnd() * 3);
        const msgs = Array.from({ length: n }, (_, j) => seq + j);
        sched.enqueue(k, { kind: 'msgs', msgs });
        into.push(...msgs.map(String));
        seq += n;
      }
      await tick();
      while (pending.length && rnd() < 0.5) {
        at(pending.splice(Math.floor(rnd() * pending.length), 1), 0).resolve();
        await tick();
      }
    }
    while (pending.length) {
      at(pending, 0).resolve();
      pending.shift();
      await tick();
    }
    await sched.drain();
    assert.ok(maxInflight <= maxParallel, `round ${round}: ${maxInflight} > cap ${maxParallel}`);
    assert.equal(inflight, 0);
    assert.equal(sched.idle(), true);
    for (const k of keys) {
      const got = runs
        .filter((r) => r.key === k)
        .flatMap((r) => (r.item.kind === 'wake' ? [`w${jobOf(r.item)}`] : msgsOf(r.item).map(String)));
      assert.deepEqual(got, sent.get(k), `round ${round}: order/coverage broken for ${k}`);
    }
  }
});
