// The live status message: ONE message per turn, posted into the topic a few
// seconds after the turn starts, edited in place while the model works, and
// deleted when the turn is over.
//
// Why this is code and not an instruction. It WAS an instruction — agent.md
// told the model to post «принял, делаю» and to delete it once the answer was
// out — and an instruction is the first thing a model drops when the turn gets
// long or interesting. The owner noticed the status messages had disappeared
// (20.09.2026); nothing had broken, because there had never been anything to
// break. A turn cannot forget a ticker that is not its to run.
//
// What it shows comes from the stream the driver is ALREADY reading
// (`--output-format stream-json`): every `tool_use` event is one line of "what
// is happening right now". Nothing here parses a transcript, polls a file or
// waits for the child.
//
// Pure library except for the channel it is handed: no config, no network, no
// Telegram vocabulary, and — deliberately — no user-facing text. The two
// runners that use it (this daemon and a ticket-agent) pass their own
// `post/edit/remove` and their own phrases out of their own i18n catalogue,
// which is also what keeps this repo's Cyrillic inventory (test/contract)
// true: a Russian sentence belongs in src/i18n/ru.ts, not here.
import type { StreamEvent } from '@tagents/core';
import { match, P } from 'ts-pattern';

/** How often the message is edited. Telegram tolerates ~20 writes/min per chat. */
export const DEFAULT_STATUS_INTERVAL_MS = 5_000;
/**
 * How long a turn must run before it gets a status message at all. A turn that
 * answers in four seconds should not flash a message and delete it — that is
 * noise, and in a forum topic it is noise with a notification attached.
 */
export const DEFAULT_STATUS_DELAY_MS = 8_000;

/** How much of a file path, command or query one line may carry. */
const TARGET_LIMIT = 52;
/** How many finished actions are kept behind the current one. */
const TRAIL = 3;

/** The kinds of "what is happening" a phrase book has to be able to say. */
export type ActionKind =
  | 'read'
  | 'edit'
  | 'run'
  | 'search'
  | 'web'
  | 'agent'
  | 'message'
  | 'plan'
  | 'skill'
  | 'telegram'
  | 'mcp'
  | 'tool';

export interface StatusAction {
  readonly kind: ActionKind;
  /** The one thing the phrase names: a file, a command, a pattern, a brief. */
  readonly target: string;
}

/**
 * The phrase book, injected. Every value is a template over `{{placeholders}}`;
 * every `actions` value may name `{{target}}`.
 */
export interface StatusPhrases {
  /** `{{elapsed}}`, `{{steps}}` — the header line. */
  readonly head: string;
  /** Shown while the model has not called a tool yet. */
  readonly thinking: string;
  /** `{{items}}` — the trail of what it did just before. */
  readonly before: string;
  /** `{{count}}`, `{{items}}` — the subagents this turn has started. */
  readonly agents: string;
  readonly actions: Readonly<Record<ActionKind, string>>;
}

export interface StatusSnapshot {
  readonly elapsedMs: number;
  readonly steps: number;
  /** What the model is doing right now; null before the first tool call. */
  readonly now: StatusAction | null;
  /** The previous actions, newest first, `now` excluded. */
  readonly before: readonly StatusAction[];
  /** The briefs of the subagents started in this turn, in order. */
  readonly agents: readonly string[];
}

// ---------------------------------------------------------------- rendering ---

const clip = (raw: string, limit = TARGET_LIMIT): string => {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

/** The last path segment — `src/runner.ts` reads as `runner.ts`. */
const base = (raw: string): string => {
  const trimmed = raw.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
};

const host = (raw: string): string => {
  try {
    return new URL(raw).host;
  } catch {
    return clip(raw);
  }
};

const fill = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '').trim();

/** `m:ss` under an hour, `h:mm:ss` over it — the way a stopwatch reads. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * One `tool_use` event as one line of status. The mapping is deliberately
 * coarse: the owner wants to see THAT the turn is reading, running, searching
 * or fanning out to agents — not a faithful rendering of the tool call.
 *
 * A SECOND describer exists, in ../../ticket-agent/src/progress.ts, and stays
 * separate on purpose: it reads a finished transcript and answers with a verb
 * that is also a --json output field (agents[].lastTool.verb) — an interface,
 * pinned by that repo's goldens and never translated, where this answers with
 * a kind a catalogue turns into a sentence. ticket-agent's
 * test/live-status.test.ts pins the two against each other, so a tool added
 * there is flagged here.
 */
export function describeTool(name: string, input: Readonly<Record<string, unknown>>): StatusAction {
  const s = (key: string): string => {
    const value = input[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const action = match(name)
    .with('Read', 'NotebookRead', (): StatusAction => ({ kind: 'read', target: base(s('file_path')) }))
    .with('Edit', 'Write', 'NotebookEdit', (): StatusAction => ({ kind: 'edit', target: base(s('file_path')) }))
    .with('Bash', 'BashOutput', 'KillShell', (): StatusAction => ({
      kind: 'run',
      // `description` is the human sentence the caller already wrote for this
      // command; the command itself is the fallback.
      target: clip(s('description') || s('command')),
    }))
    .with('Grep', 'Glob', (): StatusAction => ({ kind: 'search', target: clip(s('pattern') || s('path')) }))
    .with('WebSearch', (): StatusAction => ({ kind: 'web', target: clip(s('query')) }))
    .with('WebFetch', (): StatusAction => ({ kind: 'web', target: host(s('url')) }))
    .with('Task', 'Agent', (): StatusAction => ({
      kind: 'agent',
      target: clip(s('description') || s('subagent_type')),
    }))
    .with('SendMessage', (): StatusAction => ({ kind: 'message', target: clip(s('to')) }))
    .with('TodoWrite', 'ExitPlanMode', 'ScheduleWakeup', (): StatusAction => ({ kind: 'plan', target: '' }))
    .with('Skill', (): StatusAction => ({ kind: 'skill', target: clip(s('skill')) }))
    .with(P.string.startsWith('mcp__telegram__'), (raw): StatusAction => ({
      kind: 'telegram',
      target: raw.slice('mcp__telegram__'.length),
    }))
    .with(P.string.startsWith('mcp__'), (raw): StatusAction => {
      const [, server = '', tool = ''] = raw.split('__');
      return { kind: 'mcp', target: clip(tool ? `${server}: ${tool}` : server) };
    })
    .otherwise((raw): StatusAction => ({ kind: 'tool', target: clip(raw) }));
  // A phrase that names a target and gets none reads as a dangling colon; the
  // tool's own name is always something.
  return action.target === '' && action.kind !== 'plan' ? { kind: 'tool', target: clip(name) } : action;
}

const phrase = (a: StatusAction, p: StatusPhrases): string =>
  fill(p.actions[a.kind], { target: a.target });

/** The whole message, as it should stand right now. */
export function renderStatus(snapshot: StatusSnapshot, p: StatusPhrases): string {
  const lines = [
    fill(p.head, { elapsed: elapsedLabel(snapshot.elapsedMs), steps: String(snapshot.steps) }),
    snapshot.now ? phrase(snapshot.now, p) : p.thinking,
  ];
  if (snapshot.before.length > 0)
    lines.push(fill(p.before, { items: snapshot.before.map((a) => phrase(a, p)).join(' · ') }));
  if (snapshot.agents.length > 0)
    lines.push(
      fill(p.agents, {
        count: String(snapshot.agents.length),
        items: snapshot.agents.map((a) => clip(a, 32)).join(', '),
      })
    );
  return lines.join('\n');
}

// ------------------------------------------------------------------- live ---

/**
 * The three Telegram calls this needs, and nothing else — so the caller keeps
 * its own client, its own chat/thread and its own error policy. `post` answers
 * null when the send failed: the status then stays off for this turn rather
 * than retrying into a rate limit.
 */
export interface StatusChannel {
  post(text: string): Promise<number | null>;
  edit(messageId: number, text: string): Promise<void>;
  remove(messageId: number): Promise<void>;
}

export interface LiveStatusOptions {
  readonly channel: StatusChannel;
  readonly phrases: StatusPhrases;
  readonly intervalMs?: number;
  readonly firstDelayMs?: number;
  /** Injected by the tests; `Date.now` otherwise. */
  readonly now?: () => number;
  /**
   * Drive `tick()` yourself (tests, a runner with its own loop) instead of the
   * internal `setInterval`. Default false.
   */
  readonly manual?: boolean;
  readonly log?: (line: string) => void;
}

export interface LiveStatus {
  /** Hand this to `driver.prompt({ onEvent })`. Never throws. */
  readonly onEvent: (e: StreamEvent) => void;
  /** Post or edit, if anything is due. The ticker calls it; tests call it too. */
  tick(): Promise<void>;
  /** Stop ticking and delete the message. Idempotent. */
  done(): Promise<void>;
  /** What the message would say right now. */
  text(): string;
}

/** Telegram's own words for "that message is not there any more". */
// Telegram's own back-off: ~20 writes/min per chat is shared with everything
// else the runner sends there, so a busy topic can 429 a ticker that is well
// within its own interval. The number it gives back is seconds; obey it plus
// one rather than hammering the next tick and earning a longer one.
const FLOOD = /retry after (\d+)/i;
const GONE = /message to edit not found|message to delete not found|MESSAGE_ID_INVALID|message can't be edited/i;

export function createLiveStatus(o: LiveStatusOptions): LiveStatus {
  const now = o.now ?? ((): number => Date.now());
  const intervalMs = o.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
  const firstDelayMs = o.firstDelayMs ?? DEFAULT_STATUS_DELAY_MS;
  const log = o.log ?? ((): void => {});
  const startedAt = now();

  let steps = 0;
  let current: StatusAction | null = null;
  const trail: StatusAction[] = [];
  const agents: string[] = [];

  let messageId: number | null = null;
  let lastText = '';
  /** Nothing is written before this moment: Telegram asked for quiet. */
  let quietUntil = 0;
  let stopped = false;
  // Set when Telegram says the message is gone, or when posting failed: the
  // turn goes on without a status rather than hammering the API.
  let off = false;
  // Every write is appended to one chain, so an edit can never overtake the
  // post that created the message — or the delete that ends it.
  let chain: Promise<void> = Promise.resolve();

  const snapshot = (): StatusSnapshot => ({
    elapsedMs: now() - startedAt,
    steps,
    now: current,
    before: trail,
    agents,
  });

  const text = (): string => renderStatus(snapshot(), o.phrases);

  const onEvent = (e: StreamEvent): void => {
    if (e.kind !== 'tool_use') return;
    steps += 1;
    const action = describeTool(e.name, e.input);
    if (action.kind === 'agent' && action.target) agents.push(action.target);
    // The trail keeps what it was doing, not how many times in a row.
    if (current && !(current.kind === action.kind && current.target === action.target)) {
      trail.unshift(current);
      trail.splice(TRAIL);
    }
    current = action;
  };

  const write = async (): Promise<void> => {
    if (stopped || off) return;
    const next = text();
    if (messageId === null) {
      if (now() - startedAt < firstDelayMs) return;
      const id = await o.channel.post(next);
      if (id === null) {
        off = true;
        return;
      }
      messageId = id;
      lastText = next;
      return;
    }
    if (next === lastText) return;
    if (Date.now() < quietUntil) return;
    await o.channel.edit(messageId, next);
    // Only once it landed: a failed edit must be retried on the next tick, not
    // remembered as if it had gone out.
    lastText = next;
  };

  const guarded = (fn: () => Promise<void>, what: string): Promise<void> => {
    chain = chain.then(fn).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (GONE.test(message)) off = true;
      const flood = FLOOD.exec(message);
      if (flood !== null) quietUntil = Date.now() + (Number(flood[1]) + 1) * 1_000;
      log(`live status ${what} failed: ${message}`);
    });
    return chain;
  };

  const timer =
    o.manual === true
      ? null
      : setInterval(() => {
          void guarded(write, 'edit');
        }, intervalMs);
  // A status ticker must never be the reason the process stays alive.
  timer?.unref?.();

  return {
    onEvent,
    tick: (): Promise<void> => guarded(write, 'edit'),
    text,
    done: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      // An in-flight post has to finish first, or the message it is creating
      // right now is the one nobody deletes.
      await chain;
      const id = messageId;
      messageId = null;
      // `off` here means Telegram already told us the message is gone — the
      // owner deleted it, or the topic did. Deleting it again is one doomed
      // call per turn.
      if (id === null || off) return;
      await guarded(async (): Promise<void> => {
        await o.channel.remove(id);
      }, 'delete');
    },
  };
}
