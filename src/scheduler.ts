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
// Pure: no I/O, no timers, no globals — see scheduler.test.ts.
import { match } from 'ts-pattern';

// The two kinds of work a conversation queue carries. Both are open shapes on
// purpose: the runner hangs its own bookkeeping on an item (`notify`, `taken`,
// `file`, `recovered`) and `takeNext` spreads it through untouched.
export type MsgsItem = { kind: 'msgs'; msgs: unknown[]; [extra: string]: unknown };
export type WakeItem = { kind: 'wake'; [extra: string]: unknown };
export type SchedulerItem = MsgsItem | WakeItem;

export type InflightTurn = { key: string; since: number; kind: SchedulerItem['kind']; size: number };
export type SchedulerSnapshot = { inflight: InflightTurn[]; queued: number; workers: number };

export type SchedulerOptions = {
  maxParallel?: number;
  run: (key: string, item: SchedulerItem) => unknown;
  onChange?: (snapshot: SchedulerSnapshot) => void;
  log?: (...parts: unknown[]) => void;
};

export type Scheduler = {
  // `item` is unknown, not SchedulerItem: enqueue is the trust boundary — the
  // runner feeds it values shaped by Telegram and by the wake spool, so the
  // kind is validated at runtime and the caller gets a loud throw, not a cast.
  enqueue: (key: string, item: unknown) => void;
  snapshot: () => SchedulerSnapshot;
  idle: () => boolean;
  drain: () => Promise<void>;
};

// `e?.message ?? e` spelled for an unknown: anything thrown gets logged, an
// Error by its message and a bare string by itself.
const messageOf = (e: unknown): unknown => (e as { message?: unknown } | null | undefined)?.message ?? e;
const kindOf = (item: unknown): unknown => (item as { kind?: unknown } | null | undefined)?.kind;

function asItem(item: unknown): SchedulerItem | null {
  const kind = kindOf(item);
  if (kind !== 'msgs' && kind !== 'wake') return null;
  return item as SchedulerItem;
}

export function createScheduler({
  maxParallel = 3,
  run,
  onChange = () => {},
  log = () => {},
}: SchedulerOptions): Scheduler {
  if (!Number.isInteger(maxParallel) || maxParallel < 1)
    throw new Error(`maxParallel must be a positive integer, got ${maxParallel}`);
  if (typeof run !== 'function') throw new Error('run(key, item) is required');

  const queues = new Map<string, SchedulerItem[]>(); // key -> item[]
  const workers = new Set<string>(); // keys with a worker alive (running or waiting for a slot)
  const active = new Map<string, { since: number; item: SchedulerItem }>(); // key -> turns actually in flight
  const waiters: Array<() => void> = []; // FIFO slot waiters
  const idlers: Array<() => void> = []; // drain() resolvers
  let slots = maxParallel;

  const snapshot = (): SchedulerSnapshot => ({
    inflight: [...active].map(([key, a]) => ({
      key,
      since: a.since,
      kind: a.item.kind,
      size: match(a.item)
        .with({ kind: 'msgs' }, (m) => m.msgs.length)
        .otherwise(() => 1),
    })),
    queued: [...queues.values()].reduce((n, q) => n + q.length, 0),
    workers: workers.size,
  });
  const idle = (): boolean => active.size === 0 && workers.size === 0;
  const notify = (): void => {
    try {
      onChange(snapshot());
    } catch (e) {
      log('scheduler onChange threw:', messageOf(e));
    }
    if (idle()) while (idlers.length) idlers.shift()!();
  };

  const acquire = (): Promise<void> => {
    if (slots > 0) {
      slots--;
      return Promise.resolve();
    }
    return new Promise<void>((r) => waiters.push(r));
  };
  const release = (): void => {
    const w = waiters.shift();
    if (w) w(); // hand the slot straight over, slot count unchanged
    else slots++;
  };

  // Head of the queue; a run of `msgs` items collapses into one.
  const takeNext = (q: SchedulerItem[]): SchedulerItem => {
    const first = q.shift()!;
    if (first.kind !== 'msgs') return first;
    const msgs = [...first.msgs];
    while (q.length && q[0]!.kind === 'msgs') msgs.push(...(q.shift() as MsgsItem).msgs);
    return { ...first, msgs };
  };

  const worker = async (key: string): Promise<void> => {
    const q = queues.get(key)!;
    while (q.length) {
      await acquire();
      const item = takeNext(q);
      active.set(key, { since: Date.now(), item });
      notify();
      try {
        await run(key, item);
      } catch (e) {
        log(`[${key}] turn threw:`, messageOf(e));
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

  const enqueue = (key: string, item: unknown): void => {
    if (typeof key !== 'string' || !key) throw new Error('enqueue: key must be a non-empty string');
    const checked = asItem(item);
    if (!checked) throw new Error(`enqueue: item.kind must be "msgs" or "wake", got ${kindOf(item)}`);
    if (checked.kind === 'msgs' && !Array.isArray(checked.msgs))
      throw new Error('enqueue: msgs item needs msgs[]');
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key)!.push(checked);
    if (!workers.has(key)) {
      workers.add(key);
      void worker(key); // detached on purpose; errors are contained inside
    }
    notify();
  };

  const drain = (): Promise<void> =>
    idle() ? Promise.resolve() : new Promise<void>((r) => idlers.push(r));

  return { enqueue, snapshot, idle, drain };
}
