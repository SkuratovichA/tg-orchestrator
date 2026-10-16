// learning-cli.test.mjs — `node src/learning.mjs` end to end.
//
// The curator and the working agents only ever reach the gate through this
// CLI: one JSON document on stdout and the exit code. Hermetic: HOME is a temp
// dir, so the store and the homes live under <tmp>/.config/tg-orchestrator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseSingleJson, rmDir, runSrc, tmpDir } from './helpers.mjs';

let home;
let cfg;
let agentHome;
before(() => {
  home = tmpDir('learning-cli');
  cfg = path.join(home, '.config', 'tg-orchestrator');
  agentHome = path.join(cfg, 'agents', 'psy');
  fs.mkdirSync(path.join(agentHome, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(agentHome, 'memory', 'MEMORY.md'), '- [a](a.md)\n');
});
after(() => rmDir(home));

const learning = (...args) => {
  const r = runSrc('learning.mjs', args, { env: { HOME: home } });
  return { ...r, json: r.stdout.startsWith('{') ? parseSingleJson(r.stdout) : null };
};

const writeInput = (name, value) => {
  const file = path.join(home, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

const LONG = 'Answer in the language the question was asked in. '.repeat(8).trim();

test('propose → list → show → apply → done', () => {
  const file = writeInput('good.json', {
    agent: 'psy',
    kind: 'memory',
    title: 'Language of answers',
    summary: 'Owner asked twice.',
    ops: [
      { op: 'write', path: 'memory/lang.md', content: `${LONG}\n` },
      { op: 'append', path: 'memory/MEMORY.md', text: '- [lang](lang.md)\n' },
    ],
    outcome: 'applied',
  });

  const proposed = learning('propose', '--file', file);
  assert.equal(proposed.code, 0, proposed.stdout);
  const id = proposed.json.id;
  assert.match(id, /^p[0-9a-z]+$/);
  const pending = JSON.parse(fs.readFileSync(path.join(cfg, 'proposals', 'pending', `${id}.json`), 'utf8'));
  assert.equal(pending.outcome, undefined, 'gate-only fields are dropped at propose');
  assert.equal(typeof pending.createdAt, 'number');

  const list = learning('list');
  assert.equal(list.code, 0);
  assert.deepEqual(list.json.proposals.map(({ age, ...rest }) => rest), [
    { state: 'pending', id, kind: 'memory', agent: 'psy', title: 'Language of answers' },
  ]);
  assert.deepEqual(list.json.broken, []);

  const show = learning('show', id);
  assert.equal(show.code, 0);
  assert.equal(show.json.state, 'pending');
  assert.equal(show.json.proposal.ops.length, 2);

  const applied = learning('apply', id);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(applied.json.proposal.outcome, 'applied');
  assert.ok(fs.existsSync(path.join(cfg, 'proposals', 'done', `${id}.json`)));
  assert.equal(fs.readFileSync(path.join(agentHome, 'memory', 'MEMORY.md'), 'utf8'), '- [a](a.md)\n- [lang](lang.md)\n');
  assert.ok(fs.readFileSync(path.join(agentHome, 'memory', 'lang.md'), 'utf8').split('\n').length > 2, 'wrapped');

  const again = learning('apply', id);
  assert.equal(again.code, 3, 'an already resolved proposal is a no, not an error');
  assert.match(again.json.error, /already resolved/);
});

test('propose refuses a bad file with the reasons, exit 1', () => {
  const file = writeInput('bad.json', {
    agent: 'psy',
    kind: 'rule',
    title: 't',
    summary: 's',
    ops: [{ op: 'write', path: '../../etc/x', content: '' }, { op: 'write', path: 'brain.md', content: '' }],
  });
  const r = learning('propose', '--file', file);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /'\.\.' segment/);
  assert.match(r.json.error, /brain\.md/);

  const invalid = learning('propose', '--file', writeInput('invalid.json', { agent: 'psy', kind: 'nope' }));
  assert.equal(invalid.code, 1);
  assert.equal(invalid.json.ok, false);
});

test('reject closes a pending proposal', () => {
  const file = writeInput('rej.json', {
    id: 'prej',
    agent: 'psy',
    kind: 'rule',
    title: 't',
    summary: 's',
    ops: [{ op: 'write', path: 'CLAUDE.md', content: 'x\n' }],
  });
  assert.equal(learning('propose', '--file', file).code, 0);
  assert.equal(learning('propose', '--file', file).code, 1, 'the same id twice');
  const r = learning('reject', 'prej');
  assert.equal(r.code, 0);
  assert.equal(r.json.proposal.outcome, 'rejected');
  assert.equal(fs.existsSync(path.join(agentHome, 'CLAUDE.md')), false);
});

test('wrap <file> and wrap --agent', () => {
  const file = path.join(home, 'loose.md');
  fs.writeFileSync(file, `${LONG}\n`);
  assert.equal(learning('wrap', file).json.result, 'changed');
  assert.equal(learning('wrap', file).json.result, 'unchanged');

  fs.mkdirSync(path.join(agentHome, 'memory', '.archive'), { recursive: true });
  fs.writeFileSync(path.join(agentHome, 'memory', '.archive', 'old.md'), `${LONG}\n`);
  fs.writeFileSync(path.join(agentHome, 'brain.md'), `${LONG}\n`);
  const r = learning('wrap', '--agent', 'psy');
  assert.equal(r.code, 0);
  const byFile = Object.fromEntries(r.json.files.map((f) => [f.file, f.result]));
  assert.equal(byFile['brain.md'], 'changed');
  assert.equal(byFile['memory/MEMORY.md'], 'unchanged');
  assert.equal(byFile['memory/.archive/old.md'], undefined, 'the archive is left alone');
  assert.equal(fs.readFileSync(path.join(agentHome, 'memory', '.archive', 'old.md'), 'utf8'), `${LONG}\n`);
});

test('usage and unknown commands', () => {
  const help = learning();
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^learning\.mjs/);
  const unknown = learning('frobnicate');
  assert.equal(unknown.code, 1);
  assert.match(unknown.json.error, /unknown command/);
  assert.equal(learning('show', 'pnothere').code, 1);
});
