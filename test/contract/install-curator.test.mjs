// node --test test/contract/install-curator.test.mjs
//
// scripts/install-curator.sh (docs/agent-learning.md §3) against a temp HOME
// with TG_ORC_NO_LAUNCHD=1: the curator's home, its brain with the placeholders
// substituted, its topics, the launchd plist, a second run that changes
// nothing, and a refusal without a learning topic. And the weekly job it
// schedules: curator-weekly.sh drops a wake record for the learning topic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT, rmDir, run, SCRIPTS, tmpDir } from './helpers.mjs';

const INSTALL = path.join(SCRIPTS, 'install-curator.sh');
const WEEKLY = path.join(SCRIPTS, 'curator-weekly.sh');
const TOPIC = '-1007770001:77';
let tmp;

before(() => {
  tmp = tmpDir('install-curator');
});
after(() => rmDir(tmp));

function fakeHome(name, envLines) {
  const home = path.join(tmp, name);
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'env'), envLines.join('\n') + '\n');
  return { home, cfg, curator: path.join(cfg, 'agents', 'curator') };
}

const install = (h) => run('bash', [INSTALL], { env: { HOME: h.home, TG_ORC_NO_LAUNCHD: '1' } });
const read = (f) => fs.readFileSync(f, 'utf8');

test('first run builds the home, brain, topics and plist; the second run is a no-op', () => {
  const h = fakeHome('fresh', ['TELEGRAM_BOT_TOKEN=x', 'OWNER_ID=1', `TG_LEARNING_TOPIC="${TOPIC}"`]);
  const first = install(h);
  assert.equal(first.code, 0, first.stdout + first.stderr);

  for (const d of ['memory', 'skills-drafts', '.claude/rules', '.claude/skills']) {
    assert.ok(fs.statSync(path.join(h.curator, d)).isDirectory(), d);
  }
  assert.deepEqual(JSON.parse(read(path.join(h.curator, '.claude', 'settings.json'))), {
    autoMemoryDirectory: path.join(h.curator, 'memory'),
  });
  const brain = read(path.join(h.curator, 'brain.md'));
  assert.ok(!brain.includes('{{'), 'every placeholder substituted');
  assert.ok(brain.includes(`node ${ROOT}/src/learning.mjs propose --file`));
  assert.ok(brain.includes(`node ${ROOT}/src/sessions.mjs search`));
  assert.ok(brain.includes(`${path.join(h.cfg, 'agents')}/*/memory/`));
  assert.equal(read(path.join(h.curator, 'topics')), `${TOPIC}\n`);

  const plist = read(path.join(h.home, 'Library', 'LaunchAgents', 'personal.tg-orchestrator.curator.plist'));
  assert.match(plist, /<key>Label<\/key>\s*<string>personal\.tg-orchestrator\.curator<\/string>/);
  assert.ok(plist.includes(`<string>/bin/bash</string>\n    <string>${ROOT}/scripts/curator-weekly.sh</string>`));
  assert.match(
    plist,
    /<key>Weekday<\/key>\s*<integer>0<\/integer>\s*<key>Hour<\/key>\s*<integer>20<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/
  );
  assert.equal(plist.match(new RegExp(`<string>${h.cfg}/launchd-curator\\.log</string>`, 'g'))?.length, 2);
  assert.equal(run('plutil', ['-lint', path.join(h.home, 'Library', 'LaunchAgents', 'personal.tg-orchestrator.curator.plist')]).code, 0);
  assert.match(first.stdout, /skip {4}launchctl \(TG_ORC_NO_LAUNCHD=1\)/);

  const second = install(h);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.ok(!/^(wrote|created)/m.test(second.stdout), second.stdout);
  assert.equal(second.stdout.split('\n').filter((l) => l.startsWith('kept')).length, 5, second.stdout);

  // An owner-edited brain survives a reinstall.
  fs.writeFileSync(path.join(h.curator, 'brain.md'), 'edited\n');
  assert.equal(install(h).code, 0);
  assert.equal(read(path.join(h.curator, 'brain.md')), 'edited\n');
});

test('without TG_LEARNING_TOPIC it refuses with exit 1 and installs nothing', () => {
  const h = fakeHome('no-topic', ['TELEGRAM_BOT_TOKEN=x', 'OWNER_ID=1']);
  const r = install(h);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /TG_LEARNING_TOPIC=<chat_id>:<thread_id> must be set/);
  assert.equal(fs.existsSync(path.join(h.cfg, 'agents')), false);
  assert.equal(fs.existsSync(path.join(h.home, 'Library')), false);
});

test('curator-weekly.sh drops a curator-weekly wake record for the learning topic', () => {
  const h = fakeHome('weekly', ['TELEGRAM_BOT_TOKEN=x', 'OWNER_ID=1', `TG_LEARNING_TOPIC=${TOPIC}`]);
  const r = run('bash', [WEEKLY], { env: { HOME: h.home, TG_EVENTS_DB: path.join(h.home, 'events.sqlite') } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const spool = path.join(h.cfg, 'wake');
  const [name] = fs.readdirSync(spool).filter((f) => f.endsWith('.json'));
  const rec = JSON.parse(read(path.join(spool, name)));
  assert.equal(rec.convo, TOPIC);
  assert.equal(rec.job, 'curator-weekly');
  assert.equal(rec.ok, true);
  assert.match(rec.text, /^Weekly curation pass: do it now\./);

  const off = fakeHome('weekly-off', ['TELEGRAM_BOT_TOKEN=x', 'OWNER_ID=1']);
  const refused = run('bash', [WEEKLY], { env: { HOME: off.home } });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /TG_LEARNING_TOPIC is not set/);
  assert.equal(fs.existsSync(path.join(off.cfg, 'wake')), false);
});
