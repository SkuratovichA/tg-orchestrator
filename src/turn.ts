// One headless Claude invocation and the bookkeeping around it.
//
// The lifecycle itself no longer lives here: @tagents/core owns spawning
// `claude -p`, reading its stream-json, the timeout killer, the grace kill
// after a `result` event, and what an outcome IS (TurnOutcome). What stays in
// the orchestrator is everything Telegram-shaped — the SessionSpec this daemon
// runs its turns under, the retry policy, the `attempt` object runner.mjs
// books, and the claims-registry dedup of incoming messages.
//
// The rule the whole file is built around is still the one from 10.09.2026:
// THE EXIT CODE IS NOT WORK COMPLETION. A turn is over when its `result` event
// arrives; a child that printed its result and then hung on the way out is
// killed afterwards and still succeeded. Reading that kill as a failure is what
// made the runner re-run a finished job and deliver every report twice.
//
// Pure library: no config, no network, nothing runs on import.
import os from 'node:os';
import {
  ClaudeHeadlessDriver,
  DEFAULT_TIMEOUT_MS,
  evidence,
  formatAttemptError,
  outcomeSessionId,
  outcomeToolUses,
  succeeded,
  type SessionDriver,
  type StreamEvent,
  type SessionSpec,
  type TurnInput,
  type TurnOutcome,
} from '@tagents/core';
import { match } from 'ts-pattern';
import { annotateMessages, claimMessages, releaseMessages, type ClaimsDb } from './claims.ts';
import { isUsageLimitError } from './model-fallback.ts';

// The names runner.mjs and the suites have always imported. The values are
// core's, so there is one definition of each and it cannot drift.
export { RESULT_EXIT_GRACE_MS, TIMEOUT_WARN_BEFORE_MS } from '@tagents/core';
export const DEFAULT_CLAUDE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export const CLAIM_OWNER = 'orchestrator';

/** What the tagents dashboard shows for a turn of this daemon (child $TA_LABEL). */
export const TURN_LABEL = 'tg-orchestrator';

/**
 * The label of one topic's turn when mid-turn input is on: `tg-orchestrator:`
 * and the topic's thread id, or the chat id where there is no thread (key
 * `<chat>:0`). Parallel topics then show up as separate rows in the dashboard.
 */
export function topicLabel(key: string): string {
  const [chat = key, thread] = key.split(':');
  return `${TURN_LABEL}:${thread !== undefined && thread !== '0' ? thread : chat}`;
}

export type Log = (...parts: string[]) => void;
export type WarnInfo = { elapsedMs: number; leftMs: number };
export type OnWarn = (info: WarnInfo) => unknown;

const noop: Log = () => {};

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function parseTimeoutMs(raw: unknown, fallback = DEFAULT_CLAUDE_TIMEOUT_MS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ----------------------------------------------------------------- driver ---

// ONE driver for the process. Core 0.2 takes a turn's diagnostics sink on the
// PROMPT ("claude timed out after N min — killing", "printed its result but did
// not exit within N ms"), not on the driver, so every turn hands over its own
// log and the daemon no longer needs a driver per sink to keep parallel turns
// apart. Lazy, because constructing one must not be an import side effect.
let shared: SessionDriver | null = null;

function headless(): SessionDriver {
  shared ??= new ClaudeHeadlessDriver();
  return shared;
}

/** Everything a caller may say about one turn. `prompt` is the only must. */
export interface TurnRequest {
  readonly prompt: string;
  /** The claude session id to continue; null/absent starts a fresh transcript. */
  readonly resumeId?: string | null;
  /** --append-system-prompt-file: agent.md, or the agent home's brain.md. */
  readonly systemPromptFile?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Reaches the child as TA_LOG so the dashboard can preview this daemon's log. */
  readonly logFile?: string;
  /** Merged last into the child env — the bot token and the owner id. */
  readonly env?: Readonly<Record<string, string>>;
  /** The agent's home (src/agent-home.ts); absent = the owner's home. */
  readonly cwd?: string;
  /** The Claude Code account this turn logs in as; null/absent = the personal one. */
  readonly configDir?: string | null;
  readonly label?: string;
  /** Tests point this at a fake `claude`; production leaves it alone. */
  readonly bin?: string;
  /** The session backend. The plugin host passes ctx.driver; absent = the process's own. */
  readonly driver?: SessionDriver;
  readonly timeoutMs?: number;
  readonly warnBeforeMs?: number;
  readonly exitGraceMs?: number;
  readonly onWarn?: OnWarn | null;
  /**
   * Watches the turn's stream-json as it arrives — what the live status
   * message is built from (src/live-status.ts). Called from the stream reader,
   * so it must be cheap and must not throw; core swallows what it throws
   * anyway, and a watcher must never fail the turn it is only watching.
   */
  readonly onEvent?: ((e: StreamEvent) => void) | undefined;
  /**
   * Messages written into the turn while it runs (src/mid-turn.ts). Present =
   * the prompt goes through stdin and the attempt reports `delivered`; absent =
   * the turn is exactly what it was before mid-turn input existed.
   */
  readonly input?: AsyncIterable<TurnInput>;
  readonly log?: Log;
}

/**
 * The session this daemon runs a turn under. Everything the child sees comes
 * from here: cwd = the agent's home ($HOME when none is given), the Claude
 * account (configDir null = the personal one, and it drops an inherited
 * CLAUDE_CONFIG_DIR — an account is a whole login, not a setting; a string =
 * that account, chosen by the runner from TG_CLAUDE_CONFIG_DIR per turn, so a
 * deadline reverts without a restart), permissions skipped because there is
 * nobody at a terminal to answer, and the label/log pair the tagents dashboard
 * reads.
 */
export function turnSpec(req: TurnRequest): SessionSpec {
  return {
    kind: 'claude',
    cwd: req.cwd ?? os.homedir(),
    label: req.label ?? TURN_LABEL,
    configDir: req.configDir ?? null,
    skipPermissions: true,
    ...(req.model === undefined ? {} : { model: req.model }),
    ...(req.effort === undefined ? {} : { effort: req.effort }),
    ...(req.systemPromptFile === undefined ? {} : { systemPromptFile: req.systemPromptFile }),
    ...(req.logFile === undefined ? {} : { logFile: req.logFile }),
    ...(req.env === undefined ? {} : { env: req.env }),
    ...(req.bin === undefined ? {} : { bin: req.bin }),
  };
}

// ---------------------------------------------------------------- attempt ---

/** The loose object the runner books, derived from one typed outcome. */
export interface Attempt {
  /** The turn COMPLETED: a `result` with is_error=false arrived. */
  readonly ok: boolean;
  readonly outcome: TurnOutcome;
  readonly sessionId: string | null;
  readonly toolUses: number;
  readonly text: string;
  readonly timedOut: boolean;
  readonly killedAfterResult: boolean;
  readonly costUSD: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  /** The owner-facing one-liner, or null for a turn that worked. */
  readonly error: string | null;
  /** Only for a turn that had `input`: every item it took, and whether claude echoed it. */
  readonly delivered?: readonly { readonly id: string; readonly replayed: boolean }[];
}

/** The one place a TurnOutcome becomes the attempt the runner books. */
export function toAttempt(outcome: TurnOutcome): Attempt {
  const done = succeeded(outcome);
  return {
    ok: done,
    outcome,
    sessionId: outcomeSessionId(outcome),
    toolUses: outcomeToolUses(outcome),
    text: done ? outcome.text : '',
    timedOut: outcome.kind === 'timeout',
    // The exit code is about the shutdown, not the work.
    killedAfterResult: outcome.kind === 'killed-after-result',
    costUSD: done ? outcome.costUsd : null,
    numTurns: done ? outcome.numTurns : null,
    durationMs: done ? outcome.durationMs : null,
    error: formatAttemptError(outcome),
    ...(outcome.delivered === undefined ? {} : { delivered: outcome.delivered }),
  };
}

/** Run one turn and resolve with what it ended as. Never throws for a failed turn. */
export async function runClaude(req: TurnRequest): Promise<Attempt> {
  const log = req.log ?? noop;
  const onWarn = req.onWarn ?? null;
  const driver = req.driver ?? headless();
  const ref = await driver.open(turnSpec(req), req.resumeId ?? null);
  const outcome = await driver.prompt(ref, req.prompt, {
    timeoutMs: req.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS,
    // This turn's diagnostics, into this turn's log — the daemon's runner.log.
    log: (line: string): void => log(line),
    ...(req.warnBeforeMs === undefined ? {} : { warnBeforeMs: req.warnBeforeMs }),
    ...(req.exitGraceMs === undefined ? {} : { exitGraceMs: req.exitGraceMs }),
    ...(req.onEvent === undefined ? {} : { onEvent: req.onEvent }),
    ...(req.input === undefined ? {} : { input: req.input }),
    // A warning is a Telegram send: it may reject, and a rejected notification
    // must never take the turn down with it.
    ...(onWarn === null
      ? {}
      : {
          onWarn: (info: WarnInfo): void => {
            try {
              void Promise.resolve(onWarn(info)).catch((e: unknown) =>
                log('timeout warning failed:', errMessage(e))
              );
            } catch (e) {
              log('timeout warning failed:', errMessage(e));
            }
          },
        }),
  });
  return toAttempt(outcome);
}

// ------------------------------------------------------------------ retry ---

export interface RetryDecision {
  readonly retry: boolean;
  readonly reason: string;
}

const DECISION_OK: RetryDecision = { retry: false, reason: 'ok' };
const DECISION_NO_FALLBACK: RetryDecision = {
  retry: false,
  reason: 'fresh session already — nothing to fall back to',
};

/**
 * Whether a failed attempt may be re-run from scratch. Only a turn that never
 * got going is safe to repeat: once the model has used a tool it may already
 * have sent messages, and a turn that produced text or a result is not "not
 * done" — running it again duplicates the work (10.09: a site recon done twice,
 * two reports in the chat, by the runner's own retry).
 */
export function retryDecision(attempt: Attempt, resumeId: string | null | undefined): RetryDecision {
  return match(attempt.outcome)
    .when(succeeded, () => DECISION_OK)
    .with({ kind: 'timeout' }, () => fromEvidence(attempt, resumeId, true))
    .otherwise(() => fromEvidence(attempt, resumeId, false));
}

function fromEvidence(
  attempt: Attempt,
  resumeId: string | null | undefined,
  timedOut: boolean
): RetryDecision {
  if (!resumeId) return DECISION_NO_FALLBACK;
  // What the turn managed to do before it ended comes off the OUTCOME (core
  // 0.2's `evidence`), not off a tally this file kept while the stream ran.
  const saw = evidence(attempt.outcome);
  const did: string[] = [];
  if (saw.toolUses > 0) did.push(`${saw.toolUses} tool call(s)`);
  if (saw.sawText) did.push('assistant text');
  if (saw.sawResult) did.push('a result');
  if (did.length)
    return {
      retry: false,
      reason: `retry-suppressed: turn already produced ${did.join(', ')}${timedOut ? ' before the timeout' : ''}`,
    };
  return {
    retry: true,
    reason: timedOut
      ? 'retry-fresh: timed out before doing anything'
      : 'retry-fresh: resume failed before doing anything',
  };
}

/** Why an attempt carries a RUNNER NOTICE: the turn changed model mid-flight. */
export interface Continuation {
  readonly from: string;
  readonly to: string;
  readonly toolUses: number;
  /**
   * Whether THIS attempt resumes the dead attempt's transcript. False on the
   * fresh re-run below, where there is none — and the notice has to say so
   * instead of promising a transcript that is not there.
   */
  readonly resumed: boolean;
}

/**
 * What ONE attempt runs as. `run` receives this instead of a bare resume id,
 * because a turn that falls back changes two more things about the attempt:
 * which model it spawns and what the prompt has to say about the previous one.
 */
export interface AttemptPlan {
  readonly resumeId: string | null;
  /** undefined = the caller's own default model. */
  readonly model?: string;
  /** Set when this attempt continues a turn the primary ran out of usage on. */
  readonly continuation?: Continuation;
}

/** Where a turn goes when the model it started on says it is out of usage. */
export interface FallbackPolicy {
  /** The model the FIRST attempt starts on (ModelFallback.modelFor()). */
  readonly model: string;
  /** Where to continue on a usage limit; null = nowhere, i.e. today's behaviour. */
  readonly fallbackModel: string | null;
  /**
   * Fired ONCE, before the fallback attempt. It is a Telegram send at the call
   * site, so it may reject — and a rejected notification must never take the
   * turn down with it (the same guard onWarn gets).
   */
  readonly onFallback?: (info: { from: string; to: string; attempt: Attempt }) => unknown;
}

export interface TurnRun {
  readonly attempt: Attempt;
  readonly retried: boolean;
  readonly decision: RetryDecision;
  /** The model the FINAL attempt ran on; undefined when the caller gave no policy. */
  readonly model?: string;
  /** The turn changed model mid-flight because the first one was out of usage. */
  readonly fellBack: boolean;
}

/** The fallback notice is best-effort, exactly like the timeout warning. */
function fireFallback(
  policy: FallbackPolicy,
  info: { from: string; to: string; attempt: Attempt },
  log: Log
): void {
  const notify = policy.onFallback;
  if (!notify) return;
  try {
    void Promise.resolve(notify(info)).catch((e: unknown) =>
      log('fallback notice failed:', errMessage(e))
    );
  } catch (e) {
    log('fallback notice failed:', errMessage(e));
  }
}

/**
 * One turn = one attempt, plus at most one continuation on the fallback model
 * (when the first attempt died on a usage limit) plus at most one fresh re-run
 * when the last attempt died before doing anything. `run(plan)` performs one
 * attempt.
 *
 * The order matters: a usage limit is judged BEFORE retryDecision, because the
 * refusal arrives as a `result` event and retryDecision reads a result as "this
 * turn already did something, never repeat it" — which is right for every other
 * failure and is exactly what left every topic dead on 11.09. Continuing the
 * SAME session on another model is not a repeat: the transcript is resumed, not
 * replayed, and the notice tells the model what it is looking at.
 */
export async function attemptTurn(
  run: (plan: AttemptPlan) => Promise<Attempt>,
  resumeId: string | null | undefined,
  log: Log = noop,
  policy?: FallbackPolicy
): Promise<TurnRun> {
  const started = policy?.model;
  const first: AttemptPlan = {
    resumeId: resumeId ?? null,
    ...(started === undefined ? {} : { model: started }),
  };
  let attempt = await run(first);
  let ranOn = started;
  let fellBack = false;
  let sessionId = resumeId ?? null;
  let continuation: Continuation | undefined;
  const done = (retried: boolean, decision: RetryDecision): TurnRun => ({
    attempt,
    retried,
    decision,
    ...(ranOn === undefined ? {} : { model: ranOn }),
    fellBack,
  });
  if (attempt.ok) return done(false, DECISION_OK);

  const to = policy?.fallbackModel ?? null;
  if (policy && to !== null && policy.model !== to && isUsageLimitError(attempt.error)) {
    const from = policy.model;
    log(`usage-limit on ${from}: continuing the same session on ${to}: ${attempt.error}`);
    fireFallback(policy, { from, to, attempt }, log);
    // A turn that died on its FIRST attempt still has the session id the CLI
    // announced on system/init, and that transcript holds the owner's prompt.
    sessionId = attempt.sessionId ?? sessionId;
    continuation = { from, to, toolUses: attempt.toolUses, resumed: sessionId !== null };
    attempt = await run({ resumeId: sessionId, model: to, continuation });
    ranOn = to;
    fellBack = true;
    if (attempt.ok) return done(false, DECISION_OK);
  }

  const decision = retryDecision(attempt, sessionId);
  log(`${decision.reason}: ${attempt.error}`);
  if (decision.retry)
    attempt = await run({
      resumeId: null,
      ...(ranOn === undefined ? {} : { model: ranOn }),
      // A fresh session cannot see the partial work, but the notice is what
      // tells the model to go and look at the topic before redoing it — which
      // is only true of its no-transcript wording (`resumed: false`).
      ...(continuation === undefined ? {} : { continuation: { ...continuation, resumed: false } }),
    });
  return done(decision.retry, decision);
}

// ---------------------------------------------------------------- dedup ---

/** The only part of a Telegram message the registry cares about. */
export interface ClaimableMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number };
}

function byChat<M extends ClaimableMessage>(msgs: readonly M[]): Map<number, M[]> {
  const m = new Map<number, M[]>();
  for (const msg of msgs) {
    const id = msg.chat.id;
    const list = m.get(id);
    if (list) list.push(msg);
    else m.set(id, [msg]);
  }
  return m;
}

const tag = (chatId: number, id: number): string => `[${chatId}:${id}]`;

export interface ClaimOptions {
  readonly owner?: string;
  readonly pid?: number;
  readonly note?: string;
  readonly log?: Log;
}

/**
 * Dedup at the door. Every owner message is claimed for CLAIM_OWNER before it
 * goes anywhere; a message somebody already holds or has already answered is
 * logged with the reason and dropped. Returns the messages this runner may
 * process. With no registry (db=null) or a registry error the messages pass:
 * dedup guards against duplicates, not against loss.
 */
export function claimIncoming<M extends ClaimableMessage>(
  db: ClaimsDb | null,
  msgs: readonly M[],
  { owner = CLAIM_OWNER, pid = process.pid, note = 'read', log = noop }: ClaimOptions = {}
): M[] {
  if (!db || !msgs.length) return [...msgs];
  const accepted: M[] = [];
  for (const [chatId, list] of byChat(msgs)) {
    const ids = list.map((m) => m.message_id);
    let r;
    try {
      r = claimMessages(db, { chatId, messageIds: ids, owner, pid, note });
    } catch (e) {
      log(`claim ERROR chat=${chatId}: ${errMessage(e)} — passing ${ids.length} msg(s) unchecked`);
      accepted.push(...list);
      continue;
    }
    const mine = new Map(r.acquired.map((a) => [a.message_id, a]));
    const busy = new Map(r.busy.map((b) => [b.message_id, b]));
    for (const m of list) {
      const id = m.message_id;
      const a = mine.get(id);
      if (a && !a.already_mine) {
        log(`claimed ${tag(chatId, id)}`);
        accepted.push(m);
      } else if (a && a.alive) {
        log(
          `already-claimed ${tag(chatId, id)}: in flight since ${a.since} (pid ${a.pid}) — not sent to the model again`
        );
      } else if (a) {
        // Our own earlier incarnation died holding it: take it over.
        let took = false;
        try {
          releaseMessages(db, {
            chatId,
            messageIds: [id],
            owner,
            status: 'dropped',
            note: `orphaned by pid ${a.pid}`,
          });
          took = claimMessages(db, { chatId, messageIds: [id], owner, pid, note }).ok;
        } catch (e) {
          log(`claim ERROR ${tag(chatId, id)}: ${errMessage(e)}`);
        }
        log(
          `reclaimed ${tag(chatId, id)}: previous holder pid ${a.pid} is dead${took ? '' : ' (re-claim refused, passing anyway)'}`
        );
        accepted.push(m);
      } else {
        const b = busy.get(id);
        if (b?.status === 'done')
          log(`already-handled ${tag(chatId, id)}: answered by ${b.owner} ${b.age} ago — dropped`);
        else if (b)
          log(
            `busy ${tag(chatId, id)}: held by ${b.owner} (pid ${b.pid ?? '?'}, ${b.alive ? 'alive' : 'dead'}) since ${b.since} — dropped`
          );
        else log(`claim ${tag(chatId, id)}: no verdict from the registry — dropped`);
      }
    }
  }
  return accepted;
}

/** Progress note on messages we hold ("read" -> "in-turn"). Best-effort. */
export function annotateIncoming(
  db: ClaimsDb | null,
  msgs: readonly ClaimableMessage[],
  { owner = CLAIM_OWNER, note, log = noop }: { owner?: string; note: string; log?: Log }
): void {
  if (!db || !msgs.length) return;
  for (const [chatId, list] of byChat(msgs)) {
    try {
      annotateMessages(db, { chatId, messageIds: list.map((m) => m.message_id), owner, note });
    } catch (e) {
      log(`annotate ERROR chat=${chatId}: ${errMessage(e)}`);
    }
  }
}

/** The messages are handled: mark them done (or dropped) with what happened. */
export function settleIncoming(
  db: ClaimsDb | null,
  msgs: readonly ClaimableMessage[],
  {
    owner = CLAIM_OWNER,
    status = 'done',
    note = null,
    log = noop,
  }: { owner?: string; status?: 'done' | 'dropped'; note?: string | null; log?: Log } = {}
): void {
  if (!db || !msgs.length) return;
  for (const [chatId, list] of byChat(msgs)) {
    const ids = list.map((m) => m.message_id);
    try {
      const r = releaseMessages(db, { chatId, messageIds: ids, owner, status, note });
      const refused = r.refused.map((x) => `${x.message_id} ${x.reason}`).join('; ');
      log(
        `${status} [${chatId}:${ids.join(',')}]${note ? ` ${note}` : ''}${refused ? ` (refused: ${refused})` : ''}`
      );
    } catch (e) {
      log(`release ERROR chat=${chatId}: ${errMessage(e)}`);
    }
  }
}
