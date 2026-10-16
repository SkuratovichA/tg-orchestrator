// status-cli.test.mjs — the external contract of `node src/status.mjs`.
//
// `orc-status` is the only window an operator has into a running daemon, and
// its whole output is one rendered text block: every phase sentence, every
// roll-up, the duration and clock formats. Stage S2 moves those sentences into
// an i18n catalogue, so what the CLI prints TODAY has to be written down first
// — this file is that oracle. Scenarios are driven purely through files under
// a temp HOME (state.json, status.json, usage.jsonl, runner.log, runner.pid),
// which is exactly how the real one is driven.
//
// Hermetic: HOME is a temp dir (os.homedir() puts the whole install under it),
// CLAIMS_DB / TG_EVENTS_DB point into it so an inherited developer environment
// cannot reach the real databases, and the Telegram call behind the "pending"
// line goes to a node:http server on 127.0.0.1 through the TG_API_BASE_URL
// seam — the same seam runner.mjs has, resolved the same way.
//
// Two things in the rendering are not ours: `ps` (the daemon's elapsed time,
// a claude child's cpu%) and the wall clock. Both are scrubbed the way
// helpers.mjs scrubs volatile values — but never the UNITS, because the unit
// letters are Russian text and therefore part of what S2 must keep identical.
// Durations that come from the clock are seeded at hour scale, where a second
// of jitter cannot change the rendered string; the second- and minute-scale
// formats are pinned through usage roll-ups, whose durations come from the
// ledger rows and not from the clock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  baseEnv, expectFixture, NODE, readIf, rmDir, ROOT, runSrc, scrubJson, scrubText, SRC, tmpDir,
  waitFor,
} from './helpers.mjs';

const TOKEN = '123456:TEST-TOKEN';
const CHAT_ID = -1007770001;
const CONVO = `${CHAT_ID}:5`;
const CONVO2 = `${CHAT_ID}:9`;
const HOUR = 3600_000;
// 2h15m30s ago: the `ч`/`м` branch of fmtDur, whose rendering cannot move
// unless the test itself takes half a minute between seeding and rendering.
const LONG_AGO = 2 * HOUR + 15 * 60_000 + 30_000;
const DAY = 24 * HOUR;

let tmp;

// ------------------------------------------------------------------ setup ---

function mkHome(name) {
  const home = path.join(tmp, name);
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  fs.mkdirSync(cfg, { recursive: true });
  return {
    home,
    cfg,
    file: (f) => path.join(cfg, f),
    env: (lines = [`TELEGRAM_BOT_TOKEN=${TOKEN}`, 'OWNER_ID=424242']) =>
      fs.writeFileSync(path.join(cfg, 'env'), lines.join('\n') + '\n'),
    pid: (value) => fs.writeFileSync(path.join(cfg, 'runner.pid'), String(value)),
    json: (f, value) => fs.writeFileSync(path.join(cfg, f), JSON.stringify(value)),
    text: (f, value) => fs.writeFileSync(path.join(cfg, f), value),
  };
}

// A pid that is guaranteed not to be alive: claimed, then released.
const DEAD_PID = 2_147_483_646;

// Our own pid is the only one guaranteed alive for the whole assertion — the
// trick events-cli.test.mjs uses for the same reason.
const LIVE_PID = process.pid;

function startTelegram(pendingCount) {
  const server = http.createServer((req, res) => {
    const ok = (req.url ?? '').startsWith(`/bot${TOKEN}/getWebhookInfo`);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        ok
          ? { ok: true, result: { pending_update_count: pendingCount } }
          : { ok: false, error_code: 401, description: 'Unauthorized' }
      )
    );
  });
  server.unref();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        async stop() {
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

// 127.0.0.1:1 is refused immediately, so the "Telegram unreachable" branch
// costs no timeout and never touches the real Bot API.
const NO_API = 'http://127.0.0.1:1';

// TG_LOCALE=ru unless a case asks for null: every fixture below except the
// English one was recorded from the pre-i18n CLI, whose only language was
// Russian, and that is what they are for. `locale: null` leaves the variable
// unset, which is the new default — English.
// The repo root status.mjs matches `claude -p` calls against. A per-instance
// path under the temp HOME, so the production daemon's own calls — which carry
// the REAL repo root — can never appear in a snapshot, whichever checkout the
// suite runs from.
const fakeRoot = (inst) => path.join(inst.home, 'repo');

function statusEnv(inst, { api = NO_API, locale = 'ru', extra = {} } = {}) {
  return {
    HOME: inst.home,
    TG_API_BASE_URL: api,
    TG_ORCHESTRATOR_ROOT: fakeRoot(inst),
    ...(locale === null ? {} : { TG_LOCALE: locale }),
    CLAIMS_DB: path.join(inst.home, 'claims.sqlite'),
    TG_EVENTS_DB: path.join(inst.home, 'events.sqlite'),
    ...extra,
  };
}

// --------------------------------------------------------------- scrubbing ---

// `ps` elapsed times ([[dd-]hh:]mm:ss) and wall clocks (HH:MM:SS, HH:MM) —
// same marker for both: what matters is that the digits do not reach a
// fixture, the words around them do.
function scrubVolatile(text, inst) {
  return scrubText(text, [[fakeRoot(inst), '<ROOT>'], [inst.home, '<HOME>'], [ROOT, '<ROOT>']])
    .replace(/\b\d+-\d{2}:\d{2}:\d{2}\b/g, '<t>')
    .replace(/\b\d{1,2}(?::\d{2}){1,2}\b/g, '<t>')
    .replace(/pid (\d+)/g, 'pid <pid>')
    .replace(/"pid": \d+/g, '"pid": "<pid>"')
    .replace(/"last": \d+/g, '"last": "<ms>"')
    .replace(/cpu \d+(?:\.\d+)?%/g, 'cpu <cpu>%')
    .replace(/elapsed \S+/g, 'elapsed <t>');
}

// Asynchronously, never spawnSync: the fake Bot API lives in THIS process, so
// a blocking child would be waiting on a server that cannot answer until the
// child exits — a deadlock that ends as a 5s abort and a silent "—".
function runStatus(inst, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(SRC, 'status.mjs'), ...args], {
      cwd: ROOT,
      env: baseEnv(statusEnv(inst, opts)),
    });
    const r = { code: null, stdout: '', stderr: '' };
    child.stdout.on('data', (d) => (r.stdout += d));
    child.stderr.on('data', (d) => (r.stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ ...r, code }));
  });
}

// `claude -p` children are found in the FULL process table. With the root
// pinned per instance (statusEnv) nothing foreign should match any more; the
// re-render loop stays as a belt to that brace, and its failure message names
// the one thing that can still go wrong.
const callPids = (text) =>
  [...text.matchAll(/^\S+ +claude pid (\d+)/gm)].map((m) => Number(m[1]));

async function renderStable(inst, { args = [], allow = [], ...opts } = {}) {
  for (let i = 0; i < 25; i++) {
    const r = await runStatus(inst, args, opts);
    assert.equal(r.code, 0, `status.mjs exited ${r.code}: ${r.stderr}`);
    const foreign = callPids(r.stdout).filter((p) => !allow.includes(p));
    if (!foreign.length) return r;
    await new Promise((s) => setTimeout(s, 150));
  }
  throw new Error('another test kept a `claude -p` process in the table for 4s');
}

// ------------------------------------------------------------------ cases ---

before(() => {
  tmp = tmpDir('status-contract');
});
after(() => rmDir(tmp));

test('(a) no runner.pid at all: the CLI dies on it, loudly, exit 1', () => {
  const inst = mkHome('no-pid');
  inst.env();
  const r = runSrc('status.mjs', [], { env: statusEnv(inst) });
  // Not a nicety — it is what the tool does today, and the port must not
  // quietly turn it into a rendered "down" screen.
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Error: ENOENT[\s\S]*runner\.pid/);
});

test('(b) a dead pid and nothing else: the bare "down" screen', async () => {
  const inst = mkHome('down');
  inst.env();
  inst.pid(DEAD_PID);
  const r = await renderStable(inst);
  expectFixture('status/down.txt', scrubVolatile(r.stdout, inst));
});

test('(c) an empty pid file is the same as a dead one', async () => {
  const inst = mkHome('empty-pid');
  inst.env();
  inst.pid('');
  const r = await renderStable(inst);
  expectFixture('status/down.txt', scrubVolatile(r.stdout, inst));
});

// The full screen: live daemon, idle phase, sessions, both roll-ups (with a
// failure), the last-calls list and the log tail.
function seedIdle(inst, { pid = LIVE_PID, fails = true } = {}) {
  const now = Date.now();
  inst.env();
  inst.pid(pid);
  inst.json('status.json', { phase: 'idle', at: new Date(now).toISOString(), pid });
  inst.json('state.json', {
    offset: 4242,
    sessions: {
      [CONVO2]: { id: 'sess-old', last: now - 5 * HOUR },
      [CONVO]: { id: 'sess-1', last: now - LONG_AGO },
    },
  });
  const rows = [
    { ts: new Date(now - 2 * DAY).toISOString(), ok: true, convo: CONVO, costUSD: 1.5, durationMs: 7_500_000 },
    { ts: new Date(now).toISOString(), ok: true, convo: CONVO, costUSD: 0.25, durationMs: 45_000 },
    { ts: new Date(now).toISOString(), ok: fails ? false : true, convo: CONVO2, costUSD: 0.1, durationMs: 125_000 },
  ];
  inst.text('usage.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Eight lines for a six-line tail, with one legacy double-write in the
  // middle (the daemon used to log every line twice) — the tail must collapse
  // it and still show six distinct lines.
  inst.text(
    'runner.log',
    [
      '2026-09-11T06:00:00.000Z tg-orchestrator up: @testbot, pid=1, offset=0',
      '2026-09-11T06:01:00.000Z inbound 501',
      '2026-09-11T06:02:00.000Z burst window opened',
      '2026-09-11T06:03:00.000Z burst window opened',
      '2026-09-11T06:04:00.000Z claude start [-1007770001:5]',
      '2026-09-11T06:05:00.000Z claude ok [-1007770001:5]: готово',
      '2026-09-11T06:06:00.000Z snapshot written',
      '2026-09-11T06:07:00.000Z idle',
    ].join('\n') + '\n'
  );
}

test('(d) the full screen: alive, idle, sessions, roll-ups, log tail', async () => {
  const inst = mkHome('idle');
  seedIdle(inst);
  const r = await renderStable(inst);
  expectFixture('status/idle.txt', scrubVolatile(r.stdout, inst));
});

test('(d2) a day with no failures drops the "ошибок" tail', async () => {
  const inst = mkHome('idle-clean');
  seedIdle(inst, { fails: false });
  const r = await renderStable(inst);
  expectFixture('status/idle-no-fails.txt', scrubVolatile(r.stdout, inst));
});

test('(e) --json prints the same snapshot as data', async () => {
  const inst = mkHome('idle-json');
  seedIdle(inst);
  const r = await renderStable(inst, { args: ['--json'] });
  const value = scrubJson(JSON.parse(r.stdout), [[fakeRoot(inst), '<ROOT>'], [inst.home, '<HOME>'], [ROOT, '<ROOT>']]);
  expectFixture('status/idle.json', scrubVolatile(`${JSON.stringify(value, null, 2)}\n`, inst));
});

test('(f) --watch renders the same frame, then keeps the process alive', async () => {
  const inst = mkHome('idle-watch');
  seedIdle(inst);
  const child = spawn(NODE, [path.join(SRC, 'status.mjs'), '--watch'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv(statusEnv(inst)),
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  try {
    // The frame ends with the log tail; the next one is 3s away.
    await waitFor('the first frame', () => out.includes('06:07'));
    await new Promise((s) => setTimeout(s, 100));
    assert.equal(child.exitCode, null, '--watch must not exit after the first frame');
    expectFixture('status/idle.txt', scrubVolatile(out, inst));
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

test('(g) burst: the open window and its message count', async () => {
  const inst = mkHome('burst');
  const now = Date.now();
  inst.env();
  inst.pid(LIVE_PID);
  inst.json('status.json', {
    phase: 'burst',
    at: new Date(now - LONG_AGO).toISOString(),
    since: new Date(now - LONG_AGO).toISOString(),
    msgs: 3,
    pid: LIVE_PID,
  });
  const r = await renderStable(inst);
  expectFixture('status/burst.txt', scrubVolatile(r.stdout, inst));
});

test('(h) claude with no claude process: the warning, the piggy-backed burst, a stale pid', async () => {
  const inst = mkHome('claude-gone');
  const now = Date.now();
  inst.env();
  inst.pid(LIVE_PID);
  inst.json('status.json', {
    phase: 'claude',
    at: new Date(now - LONG_AGO).toISOString(),
    pid: DEAD_PID, // written by a previous runner: the "от старого pid" mark
    convo: CONVO,
    msgs: 2,
    turns: [{ key: CONVO, kind: 'msgs', size: 2, since: new Date(now - LONG_AGO).toISOString() }],
    queued: 1,
    burst: { msgs: 4, since: new Date(now - LONG_AGO).toISOString() },
  });
  const r = await renderStable(inst);
  expectFixture('status/claude-no-process.txt', scrubVolatile(r.stdout, inst));
});

test('(i) two parallel turns, and a draining runner lists every turn', async () => {
  const inst = mkHome('draining');
  const now = Date.now();
  const since = new Date(now - LONG_AGO).toISOString();
  inst.env();
  inst.pid(LIVE_PID);
  inst.json('status.json', {
    phase: 'draining',
    at: since,
    pid: LIVE_PID,
    turns: [
      { key: CONVO, kind: 'msgs', size: 2, since },
      { key: CONVO2, kind: 'wake', since },
    ],
    queued: 2,
  });
  const r = await renderStable(inst);
  expectFixture('status/draining.txt', scrubVolatile(r.stdout, inst));
});

test('(i2) claude with more than one turn counts them instead of naming one', async () => {
  const inst = mkHome('parallel');
  const now = Date.now();
  const since = new Date(now - LONG_AGO).toISOString();
  inst.env();
  inst.pid(LIVE_PID);
  inst.json('status.json', {
    phase: 'claude',
    at: since,
    pid: LIVE_PID,
    convo: CONVO,
    msgs: 1,
    turns: [
      { key: CONVO, kind: 'msgs', size: 3, since },
      { key: CONVO2, kind: 'msgs', size: 1, since },
    ],
    queued: 1,
  });
  const r = await renderStable(inst);
  expectFixture('status/claude-parallel.txt', scrubVolatile(r.stdout, inst));
});

test('(j) a phase nobody knows is printed as itself', async () => {
  const inst = mkHome('unknown-phase');
  inst.env();
  inst.pid(LIVE_PID);
  inst.json('status.json', { phase: 'down', at: new Date().toISOString(), pid: LIVE_PID });
  const r = await renderStable(inst);
  expectFixture('status/unknown-phase.txt', scrubVolatile(r.stdout, inst));
});

test('(k) the Telegram queue: a count, a zero, and an unreachable API', async () => {
  const inst = mkHome('pending');
  inst.env();
  inst.pid(DEAD_PID);

  const busy = await startTelegram(4);
  try {
    const r = await renderStable(inst, { api: busy.base });
    expectFixture('status/pending-4.txt', scrubVolatile(r.stdout, inst));
  } finally {
    await busy.stop();
  }

  const quiet = await startTelegram(0);
  try {
    const r = await renderStable(inst, { api: quiet.base });
    expectFixture('status/pending-0.txt', scrubVolatile(r.stdout, inst));
  } finally {
    await quiet.stop();
  }

  // Unreachable: the em dash, and no crash. (This is the `down.txt` screen.)
  const r = await renderStable(inst);
  expectFixture('status/down.txt', scrubVolatile(r.stdout, inst));
});

test('(l) a live claude call is listed with what the transcript last showed', async () => {
  const inst = mkHome('claude-live');
  const now = Date.now();
  inst.env();
  inst.pid(LIVE_PID);
  inst.json('status.json', {
    phase: 'claude',
    at: new Date(now - LONG_AGO).toISOString(),
    pid: LIVE_PID,
    convo: CONVO,
    msgs: 1,
  });
  // A turn from before agent homes ran with cwd=$HOME, so status.mjs still looks
  // for its transcript in the home "project" dir, with / and . munged to -.
  const projects = path.join(inst.home, '.claude', 'projects', inst.home.replace(/[/.]/g, '-'));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(projects, 'sess-live.jsonl'),
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-live' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      }),
    ].join('\n') + '\n'
  );

  // A process that `ps` shows as `… claude -p … <ROOT>/agent.md`: that is the
  // whole of status.mjs's "this call is ours" test — with ROOT being the
  // per-instance fake root the CLI is told to match (TG_ORCHESTRATOR_ROOT).
  const bin = path.join(inst.home, 'claude');
  fs.writeFileSync(bin, `#!${NODE}\nsetInterval(() => {}, 1000);\n`);
  fs.chmodSync(bin, 0o755);
  const fake = spawn(bin, ['-p', '--append-system-prompt-file', path.join(fakeRoot(inst), 'agent.md'), '--resume', 'sess-live'], {
    detached: true,
    stdio: 'ignore',
    env: baseEnv({ HOME: inst.home }),
  });
  try {
    await waitFor('the fake claude in the process table', async () => {
      const r = await runStatus(inst, [], {});
      return r.code === 0 && callPids(r.stdout).includes(fake.pid) ? r : null;
    });
    const r = await renderStable(inst, { allow: [fake.pid] });
    expectFixture('status/claude-live.txt', scrubVolatile(r.stdout, inst));
  } finally {
    try {
      process.kill(-fake.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

test('(n) with TG_LOCALE unset the whole screen comes back in English', async () => {
  const inst = mkHome('idle-en');
  seedIdle(inst);
  const r = await renderStable(inst, { locale: null });
  expectFixture('status/idle.en.txt', scrubVolatile(r.stdout, inst));
});

test('(m) a broken status.json / state.json is ignored, not fatal', async () => {
  const inst = mkHome('garbage');
  inst.env();
  inst.pid(DEAD_PID);
  inst.text('status.json', '{"phase":"idl');
  inst.text('state.json', 'not json at all');
  inst.text('usage.jsonl', 'not json\n{"ts":"nope"\n');
  const r = await renderStable(inst);
  assert.equal(readIf(inst.file('status.json')), '{"phase":"idl', 'the CLI is read-only');
  expectFixture('status/garbage.txt', scrubVolatile(r.stdout, inst));
});
