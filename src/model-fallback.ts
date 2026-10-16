// "The model we run on has no usage left" — recognising it, remembering it,
// and the notice the continuation attempt carries. Published as
// `@tagents/plugin-telegram/model-fallback` on 17.09.2026, for other runners.
//
// The incident (11.09.2026): fable's usage bucket was empty. Every turn came
// back as `exit=1 You're out of usage credits. Switch to another model, …` —
// with a `result` event, so the retry policy correctly refused to re-run it
// (turn.ts: a turn that produced a result is not "not done"), and every topic
// in Telegram went dead until somebody noticed. `claude -p --model opus` on the
// SAME account answered fine, and `--fallback-model` does not cover this error,
// so the switch has to be ours.
//
// Two pieces, both here because they are the whole policy and neither of them
// needs the daemon: what the CLI's refusal LOOKS like, and how long one such
// refusal is allowed to speak for the next turns (a failed turn is expensive —
// re-discovering the empty bucket once per turn is not worth it).
//
// Pure library: no config, no I/O, nothing runs on import.

/**
 * The CLI's usage-limit refusals, as they reach us in the `result` text and
 * therefore in `attempt.error` (which prefixes them with `exit=1 `).
 *
 * Deliberately a list of loose phrases rather than one exact sentence: the
 * wording has already changed once (the 08.2026 CLI said "Claude AI usage limit
 * reached|<timestamp>"), and the cost of the two mistakes is not symmetric —
 * missing a real usage limit leaves every topic dead, while a false positive
 * re-runs one failed turn on another model and says so.
 */
export const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  // 11.09.2026: "You're out of usage credits. Switch to another model, or
  // manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message,
  // to continue."
  /out of usage credits/i,
  // Older CLI wording: "Claude AI usage limit reached|1757600000".
  /usage limit reached/i,
  /hit your (usage |session |weekly )?limit/i,
  /reached your (usage |session |weekly )?limit/i,
];

/** Does this attempt error say "this model has nothing left in the bucket"? */
export function isUsageLimitError(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(detail));
}

/** What one `trip()`/`primaryOk()` changed, for a caller deciding whether to announce it. */
export type FallbackChange = 'tripped' | 'extended' | 'recovered' | 'none';

export interface FallbackSnapshot {
  readonly primary: string;
  readonly fallback: string | null;
  /** Tripped AND still inside the TTL: the next turn starts on the fallback. */
  readonly active: boolean;
  /** When the primary first refused, epoch ms; null while idle. */
  readonly since: number | null;
  /** When the primary gets probed again, epoch ms; null while idle. */
  readonly until: number | null;
}

/**
 * Process-wide memory of "the primary model is out of usage". One per daemon.
 *
 * Sticky, because the failure is: a bucket that is empty for this turn is empty
 * for the next one too, and paying a whole failed turn per topic to re-learn it
 * is exactly what made 11.09 expensive. It expires, because a bucket that
 * refills has to be noticed without a restart — at the TTL the next turn simply
 * STARTS on the primary again (a probe). A probe that refuses re-arms the TTL.
 */
export class ModelFallback {
  readonly #primary: string;
  readonly #fallback: string | null;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #since: number | null = null;
  #until: number | null = null;

  constructor(o: {
    primary: string;
    fallback: string | null;
    ttlMs: number;
    now?: () => number;
  }) {
    this.#primary = o.primary;
    this.#fallback = o.fallback;
    this.#ttlMs = o.ttlMs;
    this.#now = o.now ?? Date.now;
  }

  /** Tripped and still inside the TTL. Without a fallback model: never. */
  active(): boolean {
    if (this.#fallback === null || this.#until === null) return false;
    return this.#now() < this.#until;
  }

  /** The model the next turn STARTS on: the fallback while active, else the primary. */
  modelFor(): string {
    return this.active() ? (this.#fallback ?? this.#primary) : this.#primary;
  }

  /**
   * The primary refused on a usage limit. 'tripped' on idle→tripped (worth
   * telling the topic about), 'extended' when it had already refused and has
   * not answered since — a probe that failed is not news, and announcing it
   * every hour is how a useful warning becomes noise. Either way the TTL is
   * re-armed from now. Note the test is "has it refused before", not "is the
   * window still open": the window expiring is what LET the probe happen.
   */
  trip(): 'tripped' | 'extended' {
    const at = this.#now();
    const change = this.#until === null ? 'tripped' : 'extended';
    if (change === 'tripped') this.#since = at;
    this.#until = at + this.#ttlMs;
    return change;
  }

  /**
   * A turn that RAN ON THE PRIMARY succeeded — so the bucket has refilled.
   * 'recovered' if we were tripped (worth telling the topic), else 'none'.
   *
   * `startedAt` is when that turn STARTED, and it is not decoration: topics run
   * side by side, so a long turn that began on the primary before the bucket
   * emptied can finish AFTER another topic's refusal tripped us. Its success
   * proves nothing about the bucket now — accepting it would clear a fresh trip,
   * announce a false recovery, and make the next turn re-discover the empty
   * bucket the expensive way. Only a turn that began after the refusal is a probe.
   */
  primaryOk(startedAt: number): 'recovered' | 'none' {
    if (this.#until === null) return 'none';
    if (this.#since !== null && startedAt < this.#since) return 'none';
    this.#since = null;
    this.#until = null;
    return 'recovered';
  }

  snapshot(): FallbackSnapshot {
    return {
      primary: this.#primary,
      fallback: this.#fallback,
      active: this.active(),
      since: this.#since,
      until: this.#until,
    };
  }
}

/**
 * The prompt prefix of the attempt that continues a usage-limited turn on the
 * fallback model. Same shape and same job as runner.ts's RECOVERY NOTICE: the
 * transcript the model is resumed into ends in an error it did not write, and
 * without being told why, a model reading its own half-finished work is as
 * likely to redo it as to continue it.
 *
 * Two wordings, because there are two attempts and they see different things.
 * `resumed`: the transcript is there, so the model is told to read on from it.
 * Not resumed (the dead-resume re-run, turn.ts): there is NO transcript — telling
 * it to "pick up where the transcript ends" over an empty context is a lie and
 * leaves it nowhere to learn what already happened, so it is pointed at the
 * topic instead, exactly as the RECOVERY NOTICE does (runner.ts).
 *
 * English on purpose — this is said to the model, not to the owner, and the
 * agent's whole system prompt is English.
 */
export function continuationNotice(c: {
  from: string;
  to: string;
  toolUses: number;
  resumed: boolean;
}): string {
  const head =
    `RUNNER NOTICE: the previous attempt at this very turn stopped because the model \`${c.from}\` ` +
    `is out of usage credits (it had made ${c.toolUses} tool call(s) before that). `;
  return c.resumed
    ? head +
        `This attempt continues the SAME session on \`${c.to}\` — pick up where the transcript ends, ` +
        `do not repeat side effects that already happened, and answer what is still unanswered.\n\n`
    : head +
        `Its transcript could NOT be resumed, so this attempt starts a FRESH session on \`${c.to}\` — ` +
        `check the topic for anything already posted, do not repeat side effects that already ` +
        `happened, and answer what is still unanswered.\n\n`;
}
