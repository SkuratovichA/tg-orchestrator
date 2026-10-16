// claims-cli.test.mjs — the external contract of `node src/claims.mjs`.
//
// claims.mjs is consulted by OTHER processes (the runner, detached agents, a
// human in a shell) that only ever see three things: the exit code, the single
// JSON object on stdout, and the state left in the database. All three are
// pinned here, as they behave TODAY — including the shapes that look odd (an
// `ask` with no live owner exiting 3, `inbox` failing with exit 1 when coop.sh
// is missing). S0 records; it does not fix.
//
// Hermetic: CLAIMS_DB and HOME point into a temp dir, so no real claims
// registry and no real coop.sh checkout is ever touched. CLAIMS_COOP stays
// unset on purpose — that is the "no coop.sh installed" path.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import {
  expectFixture,
  NODE,
  parseSingleJson,
  rmDir,
  ROOT,
  run,
  runSrc,
  scrubJson,
  scrubText,
  SRC,
  tmpDir,
} from './helpers.mjs';

let tmp;
before(() => {
  tmp = tmpDir('claims-contract');
});
after(() => rmDir(tmp));

// One database per case: a case must not depend on what an earlier case left
// behind, or adding a case silently rewrites another one's fixture.
const claims = (name, args) =>
  runSrc('claims.mjs', args, {
    env: { HOME: tmp, CLAIMS_DB: path.join(tmp, `${name}.sqlite`) },
  });

// Every JSON-answering subcommand: exit code + exactly one pretty JSON object
// on stdout + the scrubbed object against a fixture.
function pin(name, args, { exit, fixture = `claims/${name}.json` } = {}) {
  const r = claims(name, args);
  assert.equal(r.code, exit, `exit code for: claims.mjs ${args.join(' ')}\nstderr: ${r.stderr}`);
  const body = parseSingleJson(r.stdout);
  expectFixture(fixture, scrubJson(body, [[tmp, '<TMP>']]));
  return body;
}

test('claim: a free message is acquired (exit 0)', () => {
  const r = pin('claim-ok', ['claim', '-100123', '501', '--owner', 'orchestrator', '--pid', '0', '--note', 'read'], { exit: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.acquired.length, 1);
});

test('claim: a message another owner holds is refused (exit 3)', () => {
  const db = 'claim-busy';
  const first = claims(db, ['claim', '-100123', '501', '--owner', 'orchestrator', '--pid', '0']);
  assert.equal(first.code, 0);
  const r = claims(db, ['claim', '-100123', '501', '--owner', 'other-bot', '--pid', '0']);
  assert.equal(r.code, 3);
  expectFixture('claims/claim-busy.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
});

test('work claim: free work is acquired (exit 0), a second owner is refused (exit 3)', () => {
  const db = 'work-claim-ok';
  const key = 'gh:acme/shop#741';
  pin(db, ['work', 'claim', key, '--owner', 'shop-product', '--ttl', '3h', '--note', 'implementing', '--pid', '0'], { exit: 0, fixture: 'claims/work-claim-ok.json' });
  const r = claims(db, ['work', 'claim', key, '--owner', 'shop-cto', '--pid', '0']);
  assert.equal(r.code, 3);
  expectFixture('claims/work-claim-busy.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
  assert.equal(claims(db, ['work', 'owner', key]).code, 3, 'owner of held work exits 3');
  assert.equal(claims(db, ['work', 'owner', 'gh:acme/shop#1']).code, 0, 'work nobody claimed is free');
});

test('work release: the holder releases (exit 0), and the work reads as free again', () => {
  const db = 'work-release';
  const key = 'gh:acme/shop#742';
  assert.equal(claims(db, ['work', 'claim', key, '--owner', 'shop-product', '--pid', '0']).code, 0);
  const r = claims(db, ['work', 'release', key, '--owner', 'shop-product']);
  assert.equal(r.code, 0);
  expectFixture('claims/work-release-ok.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
  const owner = claims(db, ['work', 'owner', key]);
  assert.equal(owner.code, 0);
  assert.equal(parseSingleJson(owner.stdout).reason, 'released (done)');
});

test('release: the holder may release (exit 0)', () => {
  const db = 'release-ok';
  assert.equal(claims(db, ['claim', '-100123', '501', '--owner', 'orchestrator', '--pid', '0']).code, 0);
  const r = claims(db, ['release', '-100123', '501', '--owner', 'orchestrator']);
  assert.equal(r.code, 0);
  expectFixture('claims/release-ok.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
});

test('release: somebody else may not (exit 3)', () => {
  const db = 'release-not-yours';
  assert.equal(claims(db, ['claim', '-100123', '502', '--owner', 'orchestrator', '--pid', '0']).code, 0);
  const r = claims(db, ['release', '-100123', '502', '--owner', 'other-bot']);
  assert.equal(r.code, 3);
  expectFixture('claims/release-not-yours.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
});

test('lease → owner(3) → unlease → owner(0)', () => {
  const db = 'lease-cycle';
  const lease = claims(db, ['lease', '-100200', '--thread', '7', '--owner', 'orchestrator', '--ttl', '2h', '--pid', '0']);
  assert.equal(lease.code, 0);
  const leaseBody = parseSingleJson(lease.stdout);
  expectFixture('claims/lease-ok.json', scrubJson(leaseBody, [[tmp, '<TMP>']]));
  // No coop.sh anywhere under the temp HOME, so the lease is taken and the
  // mailbox preparation is reported as a warning — not an error.
  assert.equal(leaseBody.ok, true);
  assert.match(leaseBody.warning, /^lease taken, but the coop mailbox could not be prepared: coop\.sh not found at /);

  const held = claims(db, ['owner', '-100200', '--thread', '7']);
  assert.equal(held.code, 3);
  expectFixture('claims/owner-held.json', scrubJson(parseSingleJson(held.stdout), [[tmp, '<TMP>']]));

  const un = claims(db, ['unlease', '-100200', '--thread', '7', '--owner', 'orchestrator']);
  assert.equal(un.code, 0);
  expectFixture('claims/unlease-ok.json', scrubJson(parseSingleJson(un.stdout), [[tmp, '<TMP>']]));

  const free = claims(db, ['owner', '-100200', '--thread', '7']);
  assert.equal(free.code, 0);
  expectFixture('claims/owner-free.json', scrubJson(parseSingleJson(free.stdout), [[tmp, '<TMP>']]));
});

test('status: everything held, by whom, how long', () => {
  const db = 'status';
  assert.equal(claims(db, ['claim', '-100123', '777', '--owner', 'orchestrator', '--pid', '0', '--note', 'in-turn']).code, 0);
  assert.equal(claims(db, ['lease', '-100123', '--thread', '3', '--owner', 'watcher', '--ttl', '2h', '--pid', '0']).code, 0);
  const r = claims(db, ['status']);
  assert.equal(r.code, 0);
  expectFixture('claims/status.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
});

test('ask: a chat with no live owner has nobody to ask (exit 3, coop untouched)', () => {
  pin('ask-no-owner', ['ask', '-100123', '--from', 'orchestrator', '--text', 'бро, ты отвечаешь по ним?'], { exit: 3 });
});

test('inbox: without a coop.sh checkout it is an error (exit 1)', () => {
  const r = claims('inbox-no-coop', ['inbox', 'orchestrator']);
  assert.equal(r.code, 1);
  const body = parseSingleJson(r.stdout);
  assert.equal(body.ok, false);
  assert.match(body.error, /^coop\.sh not found at .*coop\.sh — set CLAIMS_COOP to your claude-coop checkout$/);
  expectFixture('claims/inbox-no-coop.json', scrubJson(body, [[tmp, '<TMP>']]));
});

test('an owner name outside [a-z0-9_-] is an error (exit 1)', () => {
  pin('invalid-owner', ['claim', '-100123', '501', '--owner', 'BadName', '--pid', '0'], { exit: 1 });
});

test('usage errors: unknown command and a missing option both exit 1 with JSON', () => {
  const unknown = claims('unknown-command', ['bogus']);
  assert.equal(unknown.code, 1);
  expectFixture('claims/unknown-command.json', scrubJson(parseSingleJson(unknown.stdout), [[tmp, '<TMP>']]));

  const missing = claims('missing-owner', ['claim', '-100123', '501']);
  assert.equal(missing.code, 1);
  expectFixture('claims/missing-owner.json', scrubJson(parseSingleJson(missing.stdout), [[tmp, '<TMP>']]));
});

test('help: plain usage text on stdout, exit 0 (NOT JSON)', () => {
  const r = claims('help', ['help']);
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.startsWith('{'), 'help is text, not JSON — that is the contract today');
  expectFixture('claims/help.txt', scrubText(r.stdout, [[tmp, '<TMP>']]));
  // No subcommand behaves identically.
  assert.equal(claims('help', []).stdout, r.stdout);
});

// src/claims.mjs is two things at once, and both have callers: `node
// src/claims.mjs claim …` (other agents, shell scripts) and `import … from
// './claims.mjs'` (runner.mjs, turn.ts, events). A shim that runs the CLI on
// import would print JSON into every importer's stdout and set its exit code;
// one that never runs it would break every script. So both are pinned.
test('the shim is a CLI when it is the program — by an absolute or a relative path', () => {
  const env = { HOME: tmp, CLAIMS_DB: path.join(tmp, 'dual.sqlite') };
  const absolute = run(NODE, [path.join(SRC, 'claims.mjs'), 'owner', '-100123'], { env });
  assert.equal(absolute.code, 0);
  assert.equal(parseSingleJson(absolute.stdout).state, 'free');

  // argv[1] as node received it is a relative path here; the main check has to
  // resolve it the same way node does or the CLI silently stops working.
  const relative = run(NODE, [path.join('src', 'claims.mjs'), 'owner', '-100123'], { env, cwd: ROOT });
  assert.equal(relative.code, 0);
  assert.equal(relative.stdout, absolute.stdout);
});

test('the shim is a silent library when it is imported', () => {
  const url = pathToFileURL(path.join(SRC, 'claims.mjs')).href;
  const probe = `import(${JSON.stringify(url)}).then((m) => {
      process.stderr.write(JSON.stringify({
        openDb: typeof m.openDb,
        claimMessages: typeof m.claimMessages,
        leaseChat: typeof m.leaseChat,
        parseArgs: typeof m.parseArgs,
        runCli: typeof m.runCli,
        iso: typeof m.iso,
        pidAlive: typeof m.pidAlive,
        human: m.human(90000),
        exit: m.EXIT,
      }));
    });`;
  const r = run(NODE, ['-e', probe], { env: { HOME: tmp, CLAIMS_DB: path.join(tmp, 'import.sqlite') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'importing the shim must print nothing — it is not the program');
  assert.deepEqual(JSON.parse(r.stderr), {
    openDb: 'function',
    claimMessages: 'function',
    leaseChat: 'function',
    parseArgs: 'function',
    runCli: 'function',
    iso: 'function',
    pidAlive: 'function',
    human: '1m',
    exit: { OK: 0, ERROR: 1, BUSY: 3 },
  });
});
