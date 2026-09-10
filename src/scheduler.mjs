// Per-conversation turn scheduler for the tg-orchestrator runner.
//
// Why this exists: until 10.09 the main loop ran turns inline, one after
// another, for every topic. A question in «dev» therefore waited for whatever
// analysis was running in another topic — and to the owner that wait looked
// exactly like a dead agent («агент в топике сдох походу»). It was not dead;
// it was queued behind an unrelated turn.
//
// Rules:
//  - one queue per conversation key (`chat:thread`); items on the SAME key
//    run strictly one at a time (one Claude session, one transcript);
//  - DIFFERENT keys run side by side, up to `maxParallel` at once, waiters
//    served FIFO;
//  - consecutive `msgs` items at the head of a key's queue are folded into
//    one item, so messages typed while that topic was mid-turn arrive as a
//    single prompt («you kept writing while I worked»); `wake` items are
//    never folded and keep their position;
//  - a `run` that throws is logged and never stops the queue.
//
// Pure: no I/O, no timers, no globals — see scheduler.test.mjs.

export function createScheduler({ maxParallel = 3, run, onChange = () => {}, log = () => {} }) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1)
    throw new Error(`maxParallel must be a positive integer, got ${maxParallel}`);
  if (typeof run !== 'function') throw new Error('run(key, item) is required');

  const queues = new Map(); // key -> item[]
  const workers = new Set(); // keys with a worker alive (running or waiting for a slot)
  const active = new Map(); // key -> { since, item } — turns actually in flight
  const waiters = []; // FIFO slot waiters
  const idlers = []; // drain() resolvers
  let slots = maxParallel;

  const snapshot = () => ({
    inflight: [...active].map(([key, a]) => ({
      key,
      since: a.since,
      kind: a.item.kind,
      size: a.item.kind === 'msgs' ? a.item.msgs.length : 1,
    })),
    queued: [...queues.values()].reduce((n, q) => n + q.length, 0),
    workers: workers.size,
  });
  const idle = () => active.size === 0 && workers.size === 0;
  const notify = () => {
    try {
      onChange(snapshot());
    } catch (e) {
      log('scheduler onChange threw:', e?.message ?? e);
    }
    if (idle()) while (idlers.length) idlers.shift()();
  };

  const acquire = () => {
    if (slots > 0) {
      slots--;
      return Promise.resolve();
    }
    return new Promise((r) => waiters.push(r));
  };
  const release = () => {
    const w = waiters.shift();
    if (w) w(); // hand the slot straight over, slot count unchanged
    else slots++;
  };

  // Head of the queue; a run of `msgs` items collapses into one.
  const takeNext = (q) => {
    const first = q.shift();
    if (first.kind !== 'msgs') return first;
    const msgs = [...first.msgs];
    while (q.length && q[0].kind === 'msgs') msgs.push(...q.shift().msgs);
    return { ...first, msgs };
  };

  const worker = async (key) => {
    const q = queues.get(key);
    while (q.length) {
      await acquire();
      const item = takeNext(q);
      active.set(key, { since: Date.now(), item });
      notify();
      try {
        await run(key, item);
      } catch (e) {
        log(`[${key}] turn threw:`, e?.message ?? e);
      } finally {
        active.delete(key);
        release();
      }
      notify();
    }
    // Synchronously, with no await between the emptiness check and these two
    // lines: an enqueue that lands after them starts a fresh worker, one that
    // landed before is still in `q`. Deferring to .finally() would open a
    // microtask gap where an item could be pushed and never picked up.
    queues.delete(key);
    workers.delete(key);
    notify();
  };

  const enqueue = (key, item) => {
    if (typeof key !== 'string' || !key) throw new Error('enqueue: key must be a non-empty string');
    if (!item || (item.kind !== 'msgs' && item.kind !== 'wake'))
      throw new Error(`enqueue: item.kind must be "msgs" or "wake", got ${item?.kind}`);
    if (item.kind === 'msgs' && !Array.isArray(item.msgs)) throw new Error('enqueue: msgs item needs msgs[]');
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(item);
    if (!workers.has(key)) {
      workers.add(key);
      worker(key); // detached on purpose; errors are contained inside
    }
    notify();
  };

  const drain = () => (idle() ? Promise.resolve() : new Promise((r) => idlers.push(r)));

  return { enqueue, snapshot, idle, drain };
}
