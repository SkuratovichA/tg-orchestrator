// events-cli.test.mjs — the external contract of `node src/events.mjs`.
//
// The event log is what makes the daemon at-least-once, and three different
// callers read it through this CLI alone: scripts/wake.sh (append), a human
// debugging "what happened to message N" (tail/trace/orphans), and recovery
// tooling (sessions/rebuild/snapshot). Pinned here: the exit codes documented
// in the EXIT constant (0 ok, 1 error, 2 usage), the column layout, the raw
// --json lines, and the refusal to rewrite state.json under a live runner.
//
// Hermetic: TG_EVENTS_DB and HOME both point into a temp dir, so the real
// ~/.config/tg-orchestrator is never read or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  expectFixture, NODE, parseSingleJson, rmDir, run, runSrc, scrubJson, scrubText, SRC, tmpDir,
} from './helpers.mjs';

let tmp;
const db = (name) => path.join(tmp, `${name}.sqlite`);

// A HOME per case: HOME decides where state.json and runner.pid live, and two
// cases that share one would decide each other's outcome.
function mkHome(name) {
  const home = path.join(tmp, 'homes', name);
  fs.mkdirSync(path.join(home, '.config', 'tg-orchestrator'), { recursive: true });
  return home;
}

const events = (dbName, args, { home = mkHome(dbName) } = {}) =>
  runSrc('events.mjs', args, { env: { HOME: home, TG_EVENTS_DB: db(dbName) } });

// `--json` prints one compact JSON document PER LINE (not one array), so it is
// pinned as the scrubbed list of those documents.
const jsonLines = (stdout) =>
  stdout.split('\n').filter(Boolean).map((l) => scrubJson(JSON.parse(l), [[tmp, '<TMP>']]));

// The flow every other case reads: two inbound messages, one of them answered,
// a turn_start that names the message it swallowed, and a wake_posted written
// exactly the way scripts/wake.sh writes it.
const FLOW = [
  ['append', 'inbound', '--convo', '-100777:5', '--msg-id', '501', '--update-id', '900',
    '--json', '{"message_id":501,"text":"привет"}', '--actor', 'runner:111'],
  ['append', 'turn_start', '--convo', '-100777:5',
    '--json', '{"kind":"msgs","msg_ids":[501],"fresh":true}', '--actor', 'runner:111'],
  ['append', 'turn_result', '--convo', '-100777:5', '--msg-id', '501',
    '--json', '{"ok":true,"session":{"id":"sess-1","last":1}}', '--actor', 'runner:111'],
  ['append', 'inbound', '--convo', '-100777:5', '--msg-id', '502', '--update-id', '901',
    '--json', '{"message_id":502,"text":"ещё"}', '--actor', 'runner:111'],
  // Byte-for-byte the invocation in scripts/wake.sh.
  ['append', 'wake_posted', '--convo', '-100777:5', '--actor', 'wake.sh',
    '--json', '{"job":"whisper msg 380","kind":"voice-transcript","ok":true,"file":null}'],
];

before(() => {
  tmp = tmpDir('events-contract');
  const home = mkHome('flow');
  FLOW.forEach((args, i) => {
    const r = events('flow', args, { home });
    assert.equal(r.code, 0, `seeding row ${i}: ${r.stderr}`);
  });
});
after(() => rmDir(tmp));

test('append: seq + kind back as one JSON object, exit 0', () => {
  const r = events('append', ['append', 'wake_posted', '--convo', '1:2', '--actor', 'wake.sh',
    '--json', '{"job":"x","kind":"job","ok":true,"file":null}']);
  assert.equal(r.code, 0);
  expectFixture('events/append-wake-posted.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));

  const inbound = events('append', ['append', 'inbound', '--convo', '1:2', '--msg-id', '77',
    '--update-id', '900', '--json', '{"message_id":77}'], { home: mkHome('append') });
  assert.equal(inbound.code, 0);
  expectFixture('events/append-inbound.json', scrubJson(parseSingleJson(inbound.stdout), [[tmp, '<TMP>']]));
});

test('append: a bad --json is an error (exit 1)', () => {
  const r = events('append-bad', ['append', 'inbound', '--json', '{nope']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  expectFixture('events/append-bad-json.err.txt', scrubText(r.stderr, [[tmp, '<TMP>']]));
});

test('append: no <kind> is an error (exit 1)', () => {
  const r = events('append-nokind', ['append']);
  assert.equal(r.code, 1);
  expectFixture('events/append-no-kind.err.txt', scrubText(r.stderr, [[tmp, '<TMP>']]));
});

test('tail: columns by default, raw JSON lines with --json', () => {
  const cols = events('flow', ['tail']);
  assert.equal(cols.code, 0);
  expectFixture('events/tail.txt', scrubText(cols.stdout, [[tmp, '<TMP>']]));

  const json = events('flow', ['tail', '--json']);
  assert.equal(json.code, 0);
  expectFixture('events/tail.json', jsonLines(json.stdout));

  // N and the filters.
  expectFixture('events/tail-2-kind.txt', scrubText(events('flow', ['tail', '2']).stdout, [[tmp, '<TMP>']]));
  expectFixture('events/tail-kind-inbound.txt',
    scrubText(events('flow', ['tail', '--kind', 'inbound']).stdout, [[tmp, '<TMP>']]));
  assert.equal(events('flow', ['tail', '--convo', 'nope:0']).stdout, '');
});

test('trace: everything that touched a message, including the turn that swallowed it', () => {
  const cols = events('flow', ['trace', '501', '--convo', '-100777:5']);
  assert.equal(cols.code, 0);
  expectFixture('events/trace.txt', scrubText(cols.stdout, [[tmp, '<TMP>']]));

  const json = events('flow', ['trace', '501']);
  expectFixture('events/trace-501.txt', scrubText(json.stdout, [[tmp, '<TMP>']]));
  expectFixture('events/trace.json', jsonLines(events('flow', ['trace', '501', '--json']).stdout));
});

test('trace: a missing <msg_id> is an error (exit 1)', () => {
  const r = events('flow', ['trace']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  expectFixture('events/trace-no-id.err.txt', scrubText(r.stderr, [[tmp, '<TMP>']]));
});

test('orphans: inbound rows nothing ever closed', () => {
  const cols = events('flow', ['orphans']);
  assert.equal(cols.code, 0);
  expectFixture('events/orphans.txt', scrubText(cols.stdout, [[tmp, '<TMP>']]));
  expectFixture('events/orphans.json', jsonLines(events('flow', ['orphans', '--json']).stdout));

  // Nothing open: stdout empty, the note goes to stderr, still exit 0.
  const empty = events('orphans-empty', ['orphans']);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr, 'no orphaned inbound messages\n');
});

test('sessions: {offset, sessions} projected from the log', () => {
  const r = events('flow', ['sessions']);
  assert.equal(r.code, 0);
  const body = parseSingleJson(r.stdout);
  assert.equal(body.offset, 901);
  expectFixture('events/sessions.json', scrubJson(body, [[tmp, '<TMP>']]));
});

test('rebuild: read-only by default, prints the same projection', () => {
  const r = events('flow', ['rebuild']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  expectFixture('events/rebuild.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
});

test('rebuild --write: refuses while a live runner.pid owns state.json (exit 1)', () => {
  const home = mkHome('rebuild-live');
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  // Our own pid: guaranteed alive for the length of the assertion, which is
  // exactly what the refusal is about.
  fs.writeFileSync(path.join(cfg, 'runner.pid'), String(process.pid));
  const r = events('flow', ['rebuild', '--write'], { home });
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(path.join(cfg, 'state.json')), false, 'state.json must not be written');
  expectFixture('events/rebuild-refused.err.txt',
    scrubText(r.stderr, [[home, '<HOME>'], [String(process.pid), '<pid>']]));
});

test('rebuild --write: with no live runner it replaces state.json atomically (exit 0)', () => {
  const home = mkHome('rebuild-write');
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  const r = events('flow', ['rebuild', '--write'], { home });
  assert.equal(r.code, 0);
  expectFixture('events/rebuild-wrote.err.txt', scrubText(r.stderr, [[home, '<HOME>']]));
  const written = JSON.parse(fs.readFileSync(path.join(cfg, 'state.json'), 'utf8'));
  assert.deepEqual(written, JSON.parse(r.stdout));
  assert.deepEqual(fs.readdirSync(cfg), ['state.json'], 'writeAtomic must leave no .tmp behind');
});

test('snapshot: records a snapshot event from state.json', () => {
  const home = mkHome('snapshot');
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  fs.writeFileSync(path.join(cfg, 'state.json'),
    JSON.stringify({ offset: 42, sessions: { '-100777:5': { id: 'sess-1', last: 1 } } }));
  const r = events('snapshot', ['snapshot'], { home });
  assert.equal(r.code, 0);
  expectFixture('events/snapshot.json', scrubJson(parseSingleJson(r.stdout), [[tmp, '<TMP>']]));
  // ...and the projection now folds onto it.
  const after2 = events('snapshot', ['sessions'], { home });
  assert.deepEqual(JSON.parse(after2.stdout), { offset: 42, sessions: { '-100777:5': { id: 'sess-1', last: 1 } } });
});

test('snapshot: without state.json it is an error (exit 1)', () => {
  const r = events('snapshot-nostate', ['snapshot']);
  assert.equal(r.code, 1);
  expectFixture('events/snapshot-no-state.err.txt', scrubText(r.stderr, [[tmp, '<TMP>']]));
});

test('help / no command: usage on stdout, exit 0', () => {
  const r = events('help', ['help']);
  assert.equal(r.code, 0);
  expectFixture('events/help.txt', scrubText(r.stdout, [[tmp, '<TMP>']]));
  assert.equal(events('help', []).stdout, r.stdout);
});

test('an unknown command is a usage error (exit 2, stderr)', () => {
  const r = events('unknown', ['bogus']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  expectFixture('events/unknown.err.txt', scrubText(r.stderr, [[tmp, '<TMP>']]));
});

// events.mjs is two things at once, like claims.mjs: scripts/wake.sh runs it
// (`node .../src/events.mjs append wake_posted …`) and runner.mjs imports it.
// A shim that ran the CLI on import would append a row and set an exit code in
// every importer; one that never ran it would silence wake.sh.
test('the shim is a CLI when it is the program, and a silent library when imported', () => {
  const home = mkHome('dual');
  const dbFile = db('dual');
  const cli = run(NODE, [path.join(SRC, 'events.mjs'), 'append', 'wake_posted', '--convo', '9:9'], {
    env: { HOME: home, TG_EVENTS_DB: dbFile },
  });
  assert.equal(cli.code, 0);
  assert.equal(parseSingleJson(cli.stdout).kind, 'wake_posted');

  const url = pathToFileURL(path.join(SRC, 'events.mjs')).href;
  const probe = `import(${JSON.stringify(url)}).then((m) => {
      process.stderr.write(JSON.stringify({
        openEvents: typeof m.openEvents,
        record: typeof m.record,
        recordMany: typeof m.recordMany,
        orphanedInbound: typeof m.orphanedInbound,
        latestSnapshot: typeof m.latestSnapshot,
        closing: m.CLOSING_KINDS,
        exit: m.EXIT,
      }));
    });`;
  const imported = run(NODE, ['-e', probe], { env: { HOME: home, TG_EVENTS_DB: dbFile } });
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(imported.stdout, '', 'importing the shim must print nothing — it is not the program');
  assert.deepEqual(JSON.parse(imported.stderr), {
    openEvents: 'function',
    record: 'function',
    recordMany: 'function',
    orphanedInbound: 'function',
    latestSnapshot: 'function',
    closing: ['turn_result', 'turn_fail', 'command', 'flush_word', 'skipped'],
    exit: { OK: 0, ERROR: 1, USAGE: 2 },
  });
  // ...and the import appended nothing.
  const rows = events('dual', ['tail', '--json'], { home }).stdout.split('\n').filter(Boolean);
  assert.equal(rows.length, 1);
});
