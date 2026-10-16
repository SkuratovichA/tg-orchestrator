// The split plan behind scripts/tg-send.sh (08.10.2026): a long reply goes out
// as several messages, one thought each, instead of one wall of text on a phone.
// The cut points are chosen by haiku by meaning; this module only numbers the
// blocks, asks, and refuses any answer that is not a clean partition.
//
// Blocks are never rewritten: a part is its original blocks joined by one blank
// line, so the bytes the owner gets are the bytes the turn wrote. Every failure
// of the model — no JSON, a timeout, a non-zero exit, a usage limit — is a
// fallback and never a failed send: a text that fits goes whole, a longer one
// is packed greedily by blocks.
//
// CLI (tg-send.sh is the caller; it owns the TG_SPLIT_MIN_CHARS default):
//   plan --text-file F --min-chars N [--out PLAN.json]   plan; print it, or write it and print the part count
//   part --plan PLAN.json --index I                      part I (1-based), raw bytes on stdout
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { writeAtomic } from './atomic.ts';
import { haikuArgs, readEnvelope, type ModelAnswer } from './haiku.ts';
import { FENCE, sentences } from './markdown-wrap.ts';

/** The Bot API's hard limit, in characters (tg-send.sh counts the same way). */
export const TG_LIMIT = 4096;
/** A packed fallback part stays under this, with room below TG_LIMIT. */
export const PACK_LIMIT = 4000;
export const MAX_GROUPS = 6;
export const PLANNER_TIMEOUT_MS = 30_000;

export type PlanSource = 'single' | 'model' | 'fallback';

export interface Plan {
  readonly source: PlanSource;
  readonly parts: string[];
  /** The model's groups (1-based block numbers) when source is 'model'. */
  readonly groups: number[][] | null;
  /** Why the model's answer was not used, when source is 'fallback'. */
  readonly reason: string | null;
  readonly ms: number | null;
  /** input + cache-creation + cache-read tokens of the model call. */
  readonly inputTokens: number | null;
}

export type GroupCheck = { ok: true; groups: number[][] } | { ok: false; reason: string };

/** Characters as Python's len() counts them — code points, not UTF-16 units. */
export function chars(s: string): number {
  return [...s].length;
}

/**
 * The text cut on blank lines. A fenced code block is one block even when it
 * contains blank lines; an unclosed fence runs to the end.
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}

export function joinBlocks(blocks: readonly string[]): string {
  return blocks.join('\n\n');
}

/** Strict: every block exactly once, in order, at most MAX_GROUPS, each part within TG_LIMIT. */
export function validateGroups(raw: unknown, blocks: readonly string[]): GroupCheck {
  if (typeof raw !== 'object' || raw === null || !('groups' in raw) || !Array.isArray(raw.groups)) {
    return { ok: false, reason: 'no "groups" array' };
  }
  const groups: unknown[] = raw.groups;
  if (groups.length === 0) return { ok: false, reason: 'no groups' };
  if (groups.length > MAX_GROUPS) return { ok: false, reason: `${groups.length} groups, at most ${MAX_GROUPS}` };
  const out: number[][] = [];
  let expected = 1;
  for (const g of groups) {
    if (!Array.isArray(g) || g.length === 0) return { ok: false, reason: 'a group is not a non-empty array' };
    const ids: number[] = [];
    for (const id of g) {
      if (typeof id !== 'number' || !Number.isInteger(id)) return { ok: false, reason: `block id ${String(id)} is not an integer` };
      if (id > blocks.length) return { ok: false, reason: `block ${id} does not exist (${blocks.length} blocks)` };
      if (id !== expected) return { ok: false, reason: `block ${id} where block ${expected} was expected` };
      ids.push(id);
      expected++;
    }
    out.push(ids);
  }
  if (expected - 1 !== blocks.length) return { ok: false, reason: `block ${expected} missing (${blocks.length} blocks)` };
  for (const [i, ids] of out.entries()) {
    const n = chars(joinBlocks(ids.map((id) => blocks[id - 1] ?? '')));
    if (n > TG_LIMIT) return { ok: false, reason: `part ${i + 1} is ${n} characters, over ${TG_LIMIT}` };
  }
  return { ok: true, groups: out };
}

/** One block over TG_LIMIT, cut at line and sentence ends into pieces within PACK_LIMIT. */
function cutBlock(block: string): string[] {
  const out: string[] = [];
  let cur = '';
  const lines = block.split('\n');
  for (const [j, line] of lines.entries()) {
    for (const [k, p] of sentences(line).entries()) {
      const sep = k === 0 ? (j === 0 ? '' : '\n') : p.sep;
      const joined = cur === '' ? p.text : cur + sep + p.text;
      if (chars(joined) <= PACK_LIMIT) {
        cur = joined;
        continue;
      }
      if (cur !== '') out.push(cur);
      cur = p.text;
      // No sentence end to cut at (a URL, a minified line): hard cut by characters.
      while (chars(cur) > PACK_LIMIT) {
        const cps = [...cur];
        out.push(cps.slice(0, PACK_LIMIT).join(''));
        cur = cps.slice(PACK_LIMIT).join('');
      }
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** The fallback: whole when it fits, else blocks packed greedily into parts within PACK_LIMIT. */
export function fallbackParts(text: string, blocks: readonly string[]): string[] {
  if (chars(text) <= TG_LIMIT) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const block of blocks) {
    const pieces = chars(block) > TG_LIMIT ? cutBlock(block) : [block];
    for (const piece of pieces) {
      const joined = cur === '' ? piece : `${cur}\n\n${piece}`;
      if (chars(joined) <= PACK_LIMIT || cur === '') {
        cur = joined;
      } else {
        parts.push(cur);
        cur = piece;
      }
    }
  }
  if (cur !== '') parts.push(cur);
  return parts;
}

export const SYSTEM_PROMPT = [
  'You split one chat reply into several Telegram messages so that each message carries one thought.',
  'You get the reply as numbered blocks. Group consecutive blocks into messages: blocks that continue the same thought stay together; a new topic, a new step or a separate aside starts a new message.',
  'A code block stays in the same message as the sentence that introduces it. A heading or a lead-in line stays with what follows it.',
  `Use at most ${MAX_GROUPS} messages, usually 2 to 4. If the whole reply is one thought, return one group. The blocks of one message must total under ${PACK_LIMIT} characters.`,
  'Every block exactly once, in order. Never rewrite text.',
  'Answer with JSON only, no prose, no code fence: {"groups":[[1,2],[3],[4,5]]}',
].join('\n');

export function plannerPrompt(blocks: readonly string[]): string {
  const body = blocks.map((b, i) => `[${i + 1}] (${chars(b)} characters)\n${b}`).join('\n\n');
  return `The reply has ${blocks.length} blocks.\n\n${body}`;
}

/** One tool-less headless call; the invocation and the envelope live in haiku.ts. */
function askModel(blocks: readonly string[], bin: string): ModelAnswer | string {
  const res = spawnSync(bin, haikuArgs(SYSTEM_PROMPT), {
    input: plannerPrompt(blocks),
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: PLANNER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (res.error) return `${bin}: ${res.error.message}`;
  if (res.status !== 0) return `${bin} rc=${String(res.status)}: ${(res.stderr || res.stdout).trim().slice(-200)}`;
  return readEnvelope(res.stdout);
}

export interface PlanOptions {
  readonly minChars: number;
  /** The model command; TG_SPLIT_CLAUDE_BIN, for tests. */
  readonly bin: string;
  /** Where the one-line fallback notice goes. */
  readonly log: (line: string) => void;
}

export function plan(text: string, opts: PlanOptions): Plan {
  const blocks = splitBlocks(text);
  if (chars(text) <= opts.minChars || blocks.length < 2) {
    return { source: 'single', parts: [text], groups: null, reason: null, ms: null, inputTokens: null };
  }
  const t0 = Date.now();
  const answer = askModel(blocks, opts.bin);
  const ms = Date.now() - t0;
  const check: GroupCheck = typeof answer === 'string' ? { ok: false, reason: answer } : validateGroups(answer.raw, blocks);
  const inputTokens = typeof answer === 'string' ? null : answer.inputTokens;
  if (check.ok) {
    const parts = check.groups.map((ids) => joinBlocks(ids.map((id) => blocks[id - 1] ?? '')));
    return { source: 'model', parts, groups: check.groups, reason: null, ms, inputTokens };
  }
  const parts = fallbackParts(text, blocks);
  opts.log(`tg-send split: planner fallback (${check.reason.replace(/\s+/g, ' ')}) — ${parts.length} part(s) after ${ms} ms`);
  return { source: 'fallback', parts, groups: null, reason: check.reason, ms, inputTokens };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readPlan(file: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('parts' in parsed) || !Array.isArray(parsed.parts)) return null;
    const parts: unknown[] = parsed.parts;
    const strings = parts.filter((p): p is string => typeof p === 'string');
    return strings.length === parts.length ? strings : null;
  } catch {
    return null;
  }
}

export function runCli(argv: readonly string[] = process.argv.slice(2)): number {
  const usage = (msg: string): number => {
    process.stderr.write(`split-plan: ${msg}\n`);
    return 2;
  };
  if (argv[0] === 'plan') {
    const file = flag(argv, '--text-file');
    const min = Number(flag(argv, '--min-chars'));
    if (!file || !Number.isInteger(min)) return usage('plan --text-file F --min-chars N [--out PLAN.json]');
    const out = flag(argv, '--out');
    // A cached plan wins: a re-run after a partial failure must send the same
    // parts, and haiku may cut differently the second time.
    const cached = out ? readPlan(out) : null;
    if (out && cached) {
      process.stdout.write(`${cached.length}\n`);
      return 0;
    }
    const text = fs.readFileSync(file, 'utf8');
    const p = plan(text, {
      minChars: min,
      bin: process.env.TG_SPLIT_CLAUDE_BIN || 'claude',
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (out) {
      // Only a real split is cached; one part means the caller's single-message path.
      if (p.parts.length > 1) writeAtomic(out, `${JSON.stringify(p)}\n`);
      process.stdout.write(`${p.parts.length}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(p, null, 2)}\n`);
    }
    return 0;
  }
  if (argv[0] === 'part') {
    const file = flag(argv, '--plan');
    const index = Number(flag(argv, '--index'));
    if (!file || !Number.isInteger(index)) return usage('part --plan PLAN.json --index I');
    const parts = readPlan(file);
    const part = parts?.[index - 1];
    if (part === undefined) return usage(`no part ${index} in ${file}`);
    process.stdout.write(part);
    return 0;
  }
  return usage('usage: plan --text-file F --min-chars N [--out PLAN.json] | part --plan PLAN.json --index I');
}
