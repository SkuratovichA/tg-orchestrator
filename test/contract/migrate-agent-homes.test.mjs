// node --test test/contract/migrate-agent-homes.test.mjs
//
// scripts/migrate-agent-homes.sh (docs/agent-learning.md §1) against a temp
// HOME: the homes it builds, what it moves, the psy brain with its paths
// rewritten, a second run that changes nothing, and a conflict that is reported
// instead of overwritten.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ROOT, rmDir, run, SCRIPTS, tmpDir } from './helpers.mjs';

const SCRIPT = path.join(SCRIPTS, 'migrate-agent-homes.sh');
// The old per-topic brain the script copies: private, so absent from a public export.
const AGENTS_DIR = path.join(ROOT, 'agents');
const REPO_BRAIN = fs.existsSync(AGENTS_DIR) && fs.readdirSync(AGENTS_DIR).find((f) => /^-?\d+_\d+\.md$/.test(f));
let tmp;

before(() => {
  tmp = tmpDir('migrate-homes');
});
after(() => rmDir(tmp));

/** A HOME with the bot's memory in its $HOME project dir and a psy dossier dir. */
function fakeHome(name) {
  const home = path.join(tmp, name);
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  const memory = path.join(home, '.claude', 'projects', home.replace(/[/.]/g, '-'), 'memory');
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), '- [fact](fact.md)\n');
  fs.writeFileSync(path.join(memory, 'fact.md'), 'a fact\n');
  fs.mkdirSync(path.join(cfg, 'psy', 'log'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'psy', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'psy', 'DOSSIER.md'), 'dossier\n');
  fs.writeFileSync(path.join(cfg, 'psy', 'log', '2026-09-01.md'), 'log\n');
  return { home, cfg, memory, agents: path.join(cfg, 'agents') };
}

const tree = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();

test('first run builds both homes and moves memory and the dossier; the second run is a no-op', () => {
  const h = fakeHome('defaults');
  const first = run('bash', [SCRIPT], { env: { HOME: h.home } });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /moved {3}2 entries/);
  assert.match(first.stdout, /moved {3}3 entries/);

  const orc = path.join(h.agents, 'orchestrator');
  const psy = path.join(h.agents, 'psy');
  assert.deepEqual(fs.readdirSync(h.memory), [], 'memory moved out, not copied');
  assert.equal(fs.readFileSync(path.join(orc, 'memory', 'fact.md'), 'utf8'), 'a fact\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(orc, '.claude', 'settings.json'), 'utf8')), {
    autoMemoryDirectory: path.join(orc, 'memory'),
  });
  for (const d of ['skills-drafts', '.claude/rules', '.claude/skills']) {
    assert.ok(fs.statSync(path.join(orc, d)).isDirectory(), d);
    assert.ok(fs.statSync(path.join(psy, d)).isDirectory(), d);
  }
  assert.ok(fs.readFileSync(path.join(orc, 'CLAUDE.md'), 'utf8').includes('approval gate'));
  assert.ok(!fs.existsSync(path.join(orc, 'brain.md')), 'the orchestrator keeps the repo agent.md');

  assert.ok(!fs.existsSync(path.join(h.cfg, 'psy')), 'the emptied psy dir is gone');
  assert.equal(fs.readFileSync(path.join(psy, 'DOSSIER.md'), 'utf8'), 'dossier\n');
  assert.equal(fs.readFileSync(path.join(psy, 'log', '2026-09-01.md'), 'utf8'), 'log\n');
  if (REPO_BRAIN) {
    assert.equal(fs.readFileSync(path.join(psy, 'topics'), 'utf8'), REPO_BRAIN.replace('.md', '').replace('_', ':') + '\n');
    const brain = fs.readFileSync(path.join(psy, 'brain.md'), 'utf8');
    assert.ok(brain.includes('~/.config/tg-orchestrator/agents/psy'));
    assert.ok(!/tg-orchestrator\/psy\b/.test(brain), 'no old dossier path survives');
  } else {
    assert.ok(!fs.existsSync(path.join(psy, 'brain.md')));
  }

  const before = tree(h.home);
  const second = run('bash', [SCRIPT], { env: { HOME: h.home } });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.ok(!/created|wrote|moved|CONFLICT/.test(second.stdout), second.stdout);
  assert.deepEqual(tree(h.home), before);
});

test('an entry whose target exists is left in place and fails the run', () => {
  const h = fakeHome('conflict');
  const cfg = path.join(tmp, 'elsewhere');
  const orcMemory = path.join(cfg, 'agents', 'orchestrator', 'memory');
  fs.mkdirSync(orcMemory, { recursive: true });
  fs.writeFileSync(path.join(orcMemory, 'fact.md'), 'already here\n');

  const r = run('bash', [SCRIPT], { env: { HOME: h.home, TG_ORC_HOME: cfg, CLAUDE_PROJECT_MEMORY: h.memory } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /CONFLICT .*fact\.md exists/);
  assert.equal(fs.readFileSync(path.join(orcMemory, 'fact.md'), 'utf8'), 'already here\n');
  assert.equal(fs.readFileSync(path.join(h.memory, 'fact.md'), 'utf8'), 'a fact\n');
  assert.ok(fs.existsSync(path.join(orcMemory, 'MEMORY.md')), 'the rest still moves');
  // TG_ORC_HOME decides where psy is read from: the default one is untouched.
  assert.ok(fs.existsSync(path.join(h.cfg, 'psy', 'DOSSIER.md')));
});
