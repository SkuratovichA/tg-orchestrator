// Mid-turn input: a message typed into a topic whose turn is still running is
// written into that turn (core's PromptOptions.input) instead of waiting for
// the next one. Behind TG_MIDTURN_INPUT, off by default.
//
// This file is the pure half — the port a turn reads from and the bookkeeping
// of what it took. The runner owns the I/O: which turn a port belongs to, the
// event rows, the claims registry and the requeue (src/runner.ts, `deliver`).
//
// Pure: no I/O, no timers, no globals — see mid-turn.test.ts.
import type { TurnInput } from '@tagents/core';

/** One item offered to a port, and whether the turn's reader ever took it. */
export type Offered<T> = { readonly item: T; readonly pulled: boolean };

export interface InputPort<T extends TurnInput> {
  /** What the turn reads. One reader: every call hands back the same iterator. */
  readonly input: AsyncIterable<TurnInput>;
  /**
   * Hand an item to the running turn. False once the port is closed — the
   * reader stopped (the driver calls return() the moment the turn is over) or
   * the runner closed it — and then the caller must queue the item itself.
   */
  offer(item: T): boolean;
  /** Is offer() still accepted? */
  isOpen(): boolean;
  /** Close the port and hand back every item ever offered, in order. */
  close(): Offered<T>[];
}

export function createInputPort<T extends TurnInput>(): InputPort<T> {
  const offered: { item: T; pulled: boolean }[] = [];
  let next = 0; // index of the first item the reader has not taken yet
  let open = true;
  let waiter: ((r: IteratorResult<TurnInput>) => void) | null = null;

  const done = (): IteratorResult<TurnInput> => ({ done: true, value: undefined });
  const take = (): IteratorResult<TurnInput> | null => {
    const slot = offered[next];
    if (slot === undefined) return null;
    next += 1;
    slot.pulled = true;
    return { done: false, value: slot.item };
  };
  const shut = (): void => {
    open = false;
    const w = waiter;
    waiter = null;
    w?.(done());
  };

  const iterator: AsyncIterator<TurnInput> = {
    next: () => {
      const got = take();
      if (got) return Promise.resolve(got);
      if (!open) return Promise.resolve(done());
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    // The driver's way of saying "the turn is over, I read nothing more". An
    // item offered after this must not look delivered, so the port refuses it.
    return: () => {
      shut();
      return Promise.resolve(done());
    },
  };

  return {
    input: { [Symbol.asyncIterator]: () => iterator },
    offer(item) {
      if (!open) return false;
      offered.push({ item, pulled: false });
      const w = waiter;
      if (w) {
        const got = take();
        if (got) {
          waiter = null;
          w(got);
        }
      }
      return true;
    },
    isOpen: () => open,
    close() {
      shut();
      return offered.map((o) => ({ item: o.item, pulled: o.pulled }));
    },
  };
}

/**
 * Which of the offered items the turn absorbed and which it still owes. Only
 * an item claude echoed back (`replayed: true`) was read by the model; one it
 * never pulled, pulled but could not write, or wrote and never echoed (a kill)
 * is owed a turn of its own. No `delivered` at all — a driver that ignores
 * input — means nothing was absorbed.
 */
export function splitDelivered<T extends TurnInput>(
  offered: readonly Offered<T>[],
  delivered: readonly { readonly id: string; readonly replayed: boolean }[] | undefined
): { absorbed: T[]; owed: T[] } {
  const replayed = new Set((delivered ?? []).filter((d) => d.replayed).map((d) => d.id));
  const absorbed: T[] = [];
  const owed: T[] = [];
  for (const { item } of offered) (replayed.has(item.id) ? absorbed : owed).push(item);
  return { absorbed, owed };
}

/** The id an injected batch travels under: its message ids, which are unique per chat. */
export const injectionId = (messageIds: readonly number[]): string => `m${messageIds.join('-')}`;

/**
 * The English line the model reads above an injected batch (the batch itself
 * is rendered exactly like a turn's prompt). It says the three things the
 * model cannot know: the owner wrote while it was working, the answer belongs
 * in THIS turn with reply_to, and nobody will ask again.
 */
export const MID_TURN_NOTICE =
  'MID-TURN MESSAGE: the owner sent this while you were working on the turn above. ' +
  'Answer it in this turn, with reply_to_message_id so the owner sees which message the answer belongs to; ' +
  'it will not be delivered to you again.';

export const injectedText = (rendered: string): string => `${MID_TURN_NOTICE}\n\n${rendered}`;
