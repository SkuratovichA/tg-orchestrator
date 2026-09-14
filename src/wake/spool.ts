// wake/spool.ts — the deferred-job spool: its records, its file states, and the
// prompt a record turns into.
//
// A turn can start work that outlives it: a local whisper run, a long build, a
// scrape. In a purely message-driven daemon NOTHING can wake that topic's
// session when the work finishes, so a turn could end with "I'll report back
// when the job is done" and the report would simply never come. That is not a
// hypothetical: on 05.09 a 6.5-minute voice note was transcribed correctly at
// 18:56, the text sat in /tmp, and the owner heard nothing for a day.
//
// The contract, for every background job: on exit — success OR failure — drop
// one JSON record in the spool (use scripts/wake.sh). runner.mjs turns each
// record into a turn on the same topic, so the agent finishes what the earlier
// turn promised. What lives HERE is everything about that which is not the
// daemon's wiring: the record's shape, the rename dance that claims a record
// exactly once, the dead-letter moves, the one-shot requeue of a record a dead
// runner had already claimed, and the prompt itself.
//
// The file NAME is the state, because a rename is the only atomic operation
// two processes can agree on:
//
//   <ts>-<pid>-<kind>.json        queued, nobody has it
//   …json.taken                   claimed; a turn is running or the runner died
//   …retry.json                   a claimed record a later startup gave back
//   …retry.json.taken             claimed again; it has used up its one retry
//   done/<name>.json              handled
//   done/<name>.json.bad          unreadable, or with nowhere to answer
//   done/…retry.json.taken.giveup twice claimed, never finished: given up
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { match } from 'ts-pattern';
import { z } from 'zod';

const CFG_DIR = path.join(os.homedir(), '.config', 'tg-orchestrator');
/** The spool itself. Every function below defaults to it. */
export const WAKE_DIR = path.join(CFG_DIR, 'wake');
/** Where a record goes once it is accounted for, whatever the outcome. */
export const WAKE_DONE = path.join(WAKE_DIR, 'done');

// A whole transcript can be tens of thousands of characters; the prompt carries
// the head and points at the file for the rest.
const WAKE_MAX_TEXT = 20_000;
// Past this, the result is stale enough that saying "here is your answer" alone
// would misrepresent it — the prompt says so instead of pretending it is fresh.
const WAKE_LATE_MS = 30 * 60 * 1000;

/**
 * The record scripts/wake.sh writes. Every field is optional and every field
 * that is present but of the wrong type degrades to absent (`.catch`) rather
 * than failing the record: a background job's result reaching the owner
 * mangled beats it not reaching them at all, which is the entire point of the
 * spool. Unknown extra fields are kept — a producer may carry its own, and the
 * event row reads some of them.
 *
 * `convo` stays unknown on purpose: `resolveNotify` is its validator, and a
 * record with an unusable address must reach the owner quoting the value it
 * really carried.
 */
export const wakeRecordSchema = z.looseObject({
  convo: z.unknown().optional(),
  job: z.string().optional().catch(undefined),
  kind: z.string().optional().catch(undefined),
  ok: z.boolean().optional().catch(undefined),
  text: z.string().optional().catch(undefined),
  file: z.string().nullish().catch(undefined),
  startedAt: z.string().nullish().catch(undefined),
  finishedAt: z.string().nullish().catch(undefined),
});

export type WakeRecord = z.infer<typeof wakeRecordSchema>;

/** Where the answer goes: one chat, one forum topic (0 folds into undefined). */
export interface WakeNotify {
  chatId: number;
  threadId?: number | undefined;
}

/** Decode one record. Throws only on JSON that does not parse at all. */
export function parseWakeRecord(text: string): WakeRecord {
  const raw: unknown = JSON.parse(text);
  const parsed = wakeRecordSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Not an object at all (a bare number, a string, an array). There is no
  // address in it, so it dead-letters as "без адреса" — the same way it always
  // has, rather than as a parse failure it is not.
  return {};
}

/** "<chat_id>:<thread_id>" → where to answer. null when there is no address. */
export function resolveNotify(convo: unknown): WakeNotify | null {
  const [chatId, threadId] = String(convo ?? '').split(':');
  if (!Number(chatId)) return null;
  return { chatId: Number(chatId), threadId: Number(threadId) || undefined };
}

/**
 * The turn's prompt. It says three things the model cannot infer: that this is
 * not the owner speaking, that a previous turn of its own promised this answer,
 * and — when the result sat in the spool — how long it waited.
 */
export function renderWakePrompt(rec: WakeRecord, now: number = Date.now()): string {
  const text = String(rec.text ?? '');
  const clipped =
    text.length > WAKE_MAX_TEXT
      ? text.slice(0, WAKE_MAX_TEXT) + `\n[...clipped, full text in ${rec.file ?? 'the job output'}]`
      : text;
  const age = rec.finishedAt ? now - Date.parse(rec.finishedAt) : 0;
  const lines = [
    `Background job finished — this is NOT a new message from the owner.`,
    `Now: ${new Date(now).toISOString()}`,
    ``,
    `A previous turn of yours in this topic started this job and told the owner`,
    `it would report back. Finish that promise now: act on the result and answer`,
    `in the topic via the Bot API. The owner has heard nothing since.`,
    ``,
    `Job: ${rec.job ?? rec.kind ?? 'unknown'} (kind=${rec.kind ?? '?'}, ok=${rec.ok !== false})`,
    rec.startedAt ? `Started: ${rec.startedAt}` : null,
    rec.finishedAt ? `Finished: ${rec.finishedAt}` : null,
    rec.file ? `Output file: ${rec.file}` : null,
  ].filter(Boolean);
  if (age > WAKE_LATE_MS)
    lines.push(
      ``,
      `LATE: this result waited ${Math.round(age / 60000)} min before reaching you.`,
      `Say so plainly in your answer instead of pretending it is fresh.`
    );
  lines.push(``, rec.ok === false ? `The job FAILED. Error output:` : `Result:`, ``, clipped);
  if (rec.ok === false)
    lines.push(
      ``,
      `Tell the owner it failed and what you are doing about it. Retry at most`,
      `once, and only if the error looks transient.`
    );
  return lines.join('\n');
}

// ------------------------------------------------------------ file states ---

/** What a name in the spool says about the record it holds. */
export type SpoolName =
  | { state: 'queued'; name: string; base: string }
  | { state: 'claimed'; name: string; base: string }
  | { state: 'retried'; name: string; base: string }
  | { state: 'other'; name: string };

export function classify(name: string): SpoolName {
  if (name.endsWith('.json.taken')) {
    const base = name.slice(0, -'.taken'.length);
    return base.endsWith('.retry.json') ? { state: 'retried', name, base } : { state: 'claimed', name, base };
  }
  if (name.endsWith('.json')) return { state: 'queued', name, base: name };
  return { state: 'other', name };
}

/** One rename the startup requeue wants to perform. */
export interface RequeueMove {
  /** The claimed record, by name. */
  from: string;
  /** Where it goes, by name — what the log line shows. */
  to: string;
  fromPath: string;
  toPath: string;
}

/**
 * Where an orphaned `.taken` belongs. A record claimed once gets one more go as
 * `.retry.json`; a record that was ALREADY the retry is given up, because
 * `.taken.taken` would mean the record itself is what kills the runner.
 */
export function requeueDestination(name: string, dir: string = WAKE_DIR): string | null {
  return match(classify(name))
    .with({ state: 'retried' }, ({ name: n }) => path.join(dir, 'done', `${n}.giveup`))
    .with({ state: 'claimed' }, ({ base }) => path.join(dir, base.replace(/\.json$/, '.retry.json')))
    .otherwise(() => null);
}

/** The spool must exist before any job tries to write into it. */
export function ensureSpool(dir: string = WAKE_DIR): void {
  fs.mkdirSync(path.join(dir, 'done'), { recursive: true });
}

/** Everything a previous run claimed and never finished, and where it goes. */
export function planRequeue(dir: string = WAKE_DIR): RequeueMove[] {
  const moves: RequeueMove[] = [];
  for (const from of fs.readdirSync(dir).filter((f) => f.endsWith('.json.taken'))) {
    const toPath = requeueDestination(from, dir);
    if (!toPath) continue;
    moves.push({ from, to: path.basename(toPath), fromPath: path.join(dir, from), toPath });
  }
  return moves;
}

export function applyRequeue(move: RequeueMove): { ok: true } | { ok: false; error: string } {
  try {
    fs.renameSync(move.fromPath, move.toPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- draining ---

/**
 * What one pass over the spool found, per record. `ready` is the only outcome
 * that still has a file in the spool (as `.taken`, waiting for its turn); the
 * other two have already been dead-lettered into done/ and are the owner's
 * problem, not the model's.
 */
export type ClaimOutcome =
  | { kind: 'ready'; file: string; taken: string; rec: WakeRecord; notify: WakeNotify }
  | { kind: 'unreadable'; file: string; error: string }
  | { kind: 'no-address'; file: string; rec: WakeRecord };

const deadLetter = (taken: string, dir: string, file: string): void => {
  try {
    fs.renameSync(taken, path.join(dir, 'done', `${file}.bad`));
  } catch {
    /* the record is already gone; there is nothing left to file */
  }
};

/**
 * Claim every queued record, by rename. Claiming FIRST is what keeps a record
 * that makes the runner crash from being replayed forever; the `.taken` file
 * stays in the spool until the turn ran, and a daemon death in between is
 * covered by the requeue at startup.
 */
export function claimPending(dir: string = WAKE_DIR): ClaimOutcome[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  const outcomes: ClaimOutcome[] = [];
  for (const file of files) {
    const taken = path.join(dir, `${file}.taken`);
    let rec: WakeRecord;
    try {
      fs.renameSync(path.join(dir, file), taken);
      rec = parseWakeRecord(fs.readFileSync(taken, 'utf8'));
    } catch (e) {
      deadLetter(taken, dir, file);
      outcomes.push({ kind: 'unreadable', file, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // A record with no usable convo has nowhere to answer — running the turn
    // would burn a model call whose output lands nowhere, i.e. the same silence
    // this spool exists to kill.
    const notify = resolveNotify(rec.convo);
    if (!notify) {
      deadLetter(taken, dir, file);
      outcomes.push({ kind: 'no-address', file, rec });
      continue;
    }
    outcomes.push({ kind: 'ready', file, taken, rec, notify });
  }
  return outcomes;
}

/** The turn ran (well or badly): the record is accounted for. Best effort. */
export function finishItem(taken: string, file: string, dir: string = WAKE_DIR): void {
  try {
    fs.renameSync(taken, path.join(dir, 'done', file));
  } catch {
    /* already filed, or the spool is gone: either way there is nothing to do */
  }
}
