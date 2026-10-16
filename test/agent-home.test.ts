// node --test agent-home.test.ts
//
// Which home a topic's turn runs in (docs/agent-learning.md §1). The resolver
// is pure over an in-memory fs here; one case goes through the real disk layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_AGENT,
  nodeAgentHomeFs,
  parseTopicsFile,
  resolveAgent,
  type AgentHomeFs,
} from '../src/agent-home.ts';

const ROOT = '/cfg/agents';
const AGENT_MD = '/repo/agent.md';
const PSY_KEY = '-1001234567890:120';

/** An fs made of a path → text map; a directory exists when some file lies under it. */
function memFs(files: Record<string, string>): AgentHomeFs {
  const paths = Object.keys(files);
  return {
    listDirs(dir) {
      const prefix = dir + '/';
      const names = paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/'));
      return [...new Set(names.filter((parts) => parts.length > 1).map((parts) => parts[0] ?? ''))];
    },
    readText: (file) => files[file] ?? null,
    exists: (file) => file in files,
  };
}

const resolve = (files: Record<string, string>, key: string) =>
  resolveAgent(ROOT, key, { defaultBrain: AGENT_MD, fs: memFs(files) });

test('topics file: keys trimmed, comments, blanks and malformed lines dropped', () => {
  const text = [
    '# psy topics',
    '  -1001234567890:120  ',
    '',
    '-1001234567890:121 # trailing comment',
    'not a key',
    '-100:abc',
    '12345',
    ':7',
    '42:0',
  ].join('\n');
  assert.deepEqual(parseTopicsFile(text), ['-1001234567890:120', '-1001234567890:121', '42:0']);
});

test('no agents dir at all: orchestrator home, the repo agent.md', () => {
  assert.deepEqual(resolve({}, PSY_KEY), {
    name: DEFAULT_AGENT,
    home: path.join(ROOT, 'orchestrator'),
    brainFile: AGENT_MD,
  });
});

test('only the orchestrator home: it answers every key', () => {
  const files = { [`${ROOT}/orchestrator/CLAUDE.md`]: 'rules' };
  assert.equal(resolve(files, PSY_KEY).name, 'orchestrator');
  assert.equal(resolve(files, '1:0').brainFile, AGENT_MD);
});

test('psy claims its key and brings its own brain; other keys stay with the orchestrator', () => {
  const files = {
    [`${ROOT}/orchestrator/CLAUDE.md`]: '',
    [`${ROOT}/psy/topics`]: `${PSY_KEY}\n`,
    [`${ROOT}/psy/brain.md`]: 'you are psy',
  };
  assert.deepEqual(resolve(files, PSY_KEY), {
    name: 'psy',
    home: path.join(ROOT, 'psy'),
    brainFile: path.join(ROOT, 'psy', 'brain.md'),
  });
  assert.deepEqual(resolve(files, '-1001234567890:1022'), {
    name: 'orchestrator',
    home: path.join(ROOT, 'orchestrator'),
    brainFile: AGENT_MD,
  });
});

test('two agents claim the same key: the sorted-first name wins', () => {
  const files = {
    [`${ROOT}/zeta/topics`]: PSY_KEY,
    [`${ROOT}/alpha/topics`]: PSY_KEY,
  };
  assert.equal(resolve(files, PSY_KEY).name, 'alpha');
});

test('an agent without brain.md falls back to the repo agent.md', () => {
  const files = { [`${ROOT}/curator/topics`]: '5:6' };
  assert.deepEqual(resolve(files, '5:6'), {
    name: 'curator',
    home: path.join(ROOT, 'curator'),
    brainFile: AGENT_MD,
  });
});

test('a malformed topics line never matches half a key', () => {
  const files = { [`${ROOT}/psy/topics`]: `x${PSY_KEY}\n${PSY_KEY}0` };
  assert.equal(resolve(files, PSY_KEY).name, 'orchestrator');
});

test('the disk layer: a real agents tree resolves the same way, a missing root is empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
  try {
    const root = path.join(tmp, 'agents');
    fs.mkdirSync(path.join(root, 'psy'), { recursive: true });
    fs.mkdirSync(path.join(root, 'orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(root, 'psy', 'topics'), `${PSY_KEY}\n`);
    fs.writeFileSync(path.join(root, 'psy', 'brain.md'), 'psy');
    // A stray file next to the homes is not an agent.
    fs.writeFileSync(path.join(root, 'README'), 'x');
    const deps = { defaultBrain: AGENT_MD, fs: nodeAgentHomeFs };
    assert.equal(resolveAgent(root, PSY_KEY, deps).brainFile, path.join(root, 'psy', 'brain.md'));
    assert.equal(resolveAgent(root, '1:0', deps).home, path.join(root, 'orchestrator'));
    assert.deepEqual(nodeAgentHomeFs.listDirs(path.join(tmp, 'nope')), []);
    assert.deepEqual(nodeAgentHomeFs.listDirs(root).sort(), ['orchestrator', 'psy']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('chat wildcards: read only when asked for, and an exact key anywhere beats them', () => {
  const CTO_CHAT = '-1007770003';
  const files = {
    [`${ROOT}/cto/topics`]: `${CTO_CHAT}:*\n`,
    [`${ROOT}/cto/brain.md`]: 'cto',
    [`${ROOT}/zeta/topics`]: `${CTO_CHAT}:385\n`,
    [`${ROOT}/zeta/brain.md`]: 'zeta',
  };
  assert.deepEqual(parseTopicsFile(`${CTO_CHAT}:*\n1:2`), ['1:2'], 'off by default: a wildcard line is not a key');
  assert.deepEqual(parseTopicsFile(`${CTO_CHAT}:*\n1:2\n1:x*`, { chatWildcards: true }), [`${CTO_CHAT}:*`, '1:2']);
  const deps = { defaultAgent: 'default', defaultBrain: '', fs: memFs(files), chatWildcards: true };
  assert.equal(resolveAgent(ROOT, `${CTO_CHAT}:12`, deps).name, 'cto', 'any topic of the chat');
  assert.equal(resolveAgent(ROOT, `${CTO_CHAT}:0`, deps).name, 'cto', 'its General too');
  assert.equal(resolveAgent(ROOT, `${CTO_CHAT}:385`, deps).name, 'zeta', 'an exact key wins, even from a later name');
  assert.equal(resolveAgent(ROOT, '-100777:1', deps).name, 'default');
  assert.equal(resolve(files, `${CTO_CHAT}:12`).name, DEFAULT_AGENT, 'without the option nothing changes');
  assert.equal(DEFAULT_AGENT, 'orchestrator', 'the default when a caller names none');
});
