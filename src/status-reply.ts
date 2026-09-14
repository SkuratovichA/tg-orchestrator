// The /status answer, in one place.
//
// Two callers say it: the daemon, out of its live scheduler, and the plugin's
// `status` CLI verb, out of the files the daemon leaves behind. The sentence
// itself must not depend on which one is asking — an owner who reads a
// different wording in the terminal than in Telegram has to wonder which of
// the two is lying — so the rendering lives here and each caller only supplies
// the facts it has.
import fs from 'node:fs';
import { z } from 'zod';
import { t } from './i18n/index.ts';
import type { FallbackSnapshot } from './model-fallback.ts';

// One usage.jsonl row, as runTurn writes it. Everything is optional on the way
// in: the ledger is append-only and a row from an older version must not make
// today's rollup unreadable.
const LedgerRow = z.looseObject({
  ts: z.string().optional(),
  ok: z.boolean().optional(),
  costUSD: z.number().nullish(),
});

/**
 * The "today: N calls, $X" line, with the leading newline it is glued on with,
 * or '' when there is no ledger to read. Byte for byte what the daemon printed
 * before: an unreadable file is no line at all, an empty day is a zero line.
 */
export function usageLine(ledgerFile: string, now: number = Date.now()): string {
  try {
    const today = new Date(now).toISOString().slice(0, 10);
    const rows = fs
      .readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parsed = LedgerRow.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : null;
      })
      .filter((r) => r !== null && r.ts?.startsWith(today));
    const cost = rows.reduce((s, r) => s + (r?.costUSD ?? 0), 0);
    const fails = rows.filter((r) => !r?.ok).length;
    const args = { calls: rows.length, cost: cost.toFixed(2), fails };
    return '\n' + (fails ? t('status.usageTodayWithFails', args) : t('status.usageToday', args));
  } catch {
    return '';
  }
}

export interface StatusFacts {
  readonly pid: number;
  readonly uptimeMin: number;
  /** Topics with a remembered session — state.json's `sessions`. */
  readonly topics: number;
  /** Conversation keys in a turn right now. */
  readonly inflight: readonly string[];
  readonly queued: number;
  readonly ledgerFile: string;
  readonly now?: number;
  /** The usage-limit model fallback. Absent or inactive = not a word about it. */
  readonly fallback?: FallbackSnapshot;
}

export function statusReply(f: StatusFacts): string {
  const usage = usageLine(f.ledgerFile, f.now ?? Date.now());
  const keys = f.inflight.join(', ');
  const busy = f.inflight.length
    ? '\n' +
      (f.queued ? t('status.inflightWithQueue', { keys, queued: f.queued }) : t('status.inflight', { keys }))
    : '';
  const alive = t('status.alive', { pid: f.pid, uptimeMin: f.uptimeMin, topics: f.topics, usage, busy });
  // "Which model am I answering on" is only worth a line when the answer is not
  // the configured one — an inactive fallback leaves the reply byte-identical.
  const fb = f.fallback;
  return fb?.active && fb.fallback
    ? alive + '\n' + t('status.modelFallback', { model: fb.fallback, primary: fb.primary })
    : alive;
}
