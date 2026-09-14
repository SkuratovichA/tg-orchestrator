// node --test status-reply.test.ts
//
// The /status sentence is now said by two callers — the daemon, out of its live
// scheduler, and the plugin's `status` verb, out of the files the daemon leaves
// behind — so the rendering itself lives in one module. What is pinned here is
// the part the contract oracle cannot reach: the e2e fixture records a status
// reply on a fresh install (no ledger at all), and these are the other shapes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { FallbackSnapshot } from '../src/model-fallback.ts';
import { statusReply, usageLine } from '../src/status-reply.ts';

let tmp: string;
const ledger = (rows: object[]): string => {
  const file = path.join(tmp, `ledger-${rows.length}-${Math.random()}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
};
const today = (): string => new Date().toISOString();

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-reply-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('no ledger at all is no usage line — the daemon printed none either', () => {
  assert.equal(usageLine(path.join(tmp, 'nope.jsonl')), '');
});

test("today's rows are rolled up, and a failed one changes the sentence", () => {
  const file = ledger([
    { ts: today(), ok: true, costUSD: 0.25 },
    { ts: today(), ok: true, costUSD: 0.5 },
    { ts: '2020-01-01T00:00:00.000Z', ok: true, costUSD: 99 }, // another day
  ]);
  assert.equal(usageLine(file), '\ntoday: 2 calls, $0.75');
  const withFail = ledger([
    { ts: today(), ok: true, costUSD: 0.25 },
    { ts: today(), ok: false },
  ]);
  assert.equal(usageLine(withFail), '\ntoday: 2 calls, $0.25, failed: 1');
});

test('a half-written row does not take the rollup down with it', () => {
  const file = path.join(tmp, 'torn.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ ts: today(), ok: true, costUSD: 1 })}\n{"ts":`);
  assert.equal(usageLine(file), '', 'a broken line aborts the rollup rather than lying about it');
});

test('the reply carries pid, uptime and topics, and the in-flight keys when there are any', () => {
  const empty = path.join(tmp, 'none.jsonl');
  const base = { pid: 4242, uptimeMin: 7, topics: 3, ledgerFile: empty };
  assert.equal(
    statusReply({ ...base, inflight: [], queued: 0 }),
    '🟢 alive: pid 4242, uptime 7 min, topics with context: 3'
  );
  assert.equal(
    statusReply({ ...base, inflight: ['-100:5'], queued: 0 }),
    '🟢 alive: pid 4242, uptime 7 min, topics with context: 3\nin flight: -100:5'
  );
  assert.equal(
    statusReply({ ...base, inflight: ['-100:5', '-100:9'], queued: 2 }),
    '🟢 alive: pid 4242, uptime 7 min, topics with context: 3\nin flight: -100:5, -100:9, 2 queued'
  );
});

test('the model fallback is a line only while it is active', () => {
  const empty = path.join(tmp, 'none.jsonl');
  const base = { pid: 4242, uptimeMin: 7, topics: 3, ledgerFile: empty, inflight: [], queued: 0 };
  const alive = '🟢 alive: pid 4242, uptime 7 min, topics with context: 3';

  const idle: FallbackSnapshot = {
    primary: 'fable',
    fallback: 'opus',
    active: false,
    since: null,
    until: null,
  };
  assert.equal(statusReply({ ...base, fallback: idle }), alive, 'nothing to report, nothing said');
  assert.equal(statusReply(base), alive, 'and a caller with no facts about it says nothing either');

  const tripped: FallbackSnapshot = {
    primary: 'fable',
    fallback: 'opus',
    active: true,
    since: 1_000_000,
    until: 4_600_000,
  };
  assert.equal(
    statusReply({ ...base, fallback: tripped }),
    `${alive}\nmodel: opus (fallback — fable is out of usage credits)`
  );

  // With the fallback switched off there is no model to name, so no line.
  const off: FallbackSnapshot = { ...tripped, fallback: null };
  assert.equal(statusReply({ ...base, fallback: off }), alive);
});
