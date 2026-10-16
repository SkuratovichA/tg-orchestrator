// node --test learning.test.ts
//
// The approval gate (docs/agent-learning.md §2): the path policy, the store,
// apply and reject on a real home in a temp dir, the matchers the runner will
// call on reactions and replies, and the message text in both locales.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createTwoFilesPatch } from 'diff';
import { getI18n } from '../src/i18n/index.ts';
import {
  applyProposal,
  checkProposalPaths,
  ensureStore,
  expiredProposals,
  isRejectReply,
  listProposals,
  matchProposalReaction,
  matchRejectReply,
  moveProposal,
  newProposalId,
  PROPOSAL_TEXT_MAX,
  readProposal,
  rejectProposal,
  renderProposal,
  writeProposal,
  type Proposal,
  type ProposalOp,
} from '../src/learning.ts';
import type { TgReaction } from '../src/reactions.ts';

const CHAT = -1001234567890;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 15, 12);

let tmp: string;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'learning-')));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/** A fresh config root and agents root, with a home for `psy`. */
function fixture(): { root: string; agents: string; home: string } {
  const base = path.join(tmp, `case-${++seq}`);
  const root = path.join(base, 'cfg');
  const agents = path.join(root, 'agents');
  const home = path.join(agents, 'psy');
  fs.mkdirSync(home, { recursive: true });
  ensureStore(root);
  return { root, agents, home };
}

const proposal = (ops: ProposalOp[], extra: Partial<Proposal> = {}): Proposal => ({
  id: `p${++seq}`,
  agent: 'psy',
  kind: 'rule',
  title: 'Answer in the language of the question',
  summary: 'The owner switched to English twice and got Russian back.',
  ops,
  createdAt: NOW - HOUR,
  ...extra,
});

const read = (file: string): string => fs.readFileSync(file, 'utf8');

// ---------------------------------------------------------- path policy ---

test('path policy: what may be written, and what is refused', () => {
  const rows: Array<[ProposalOp, boolean]> = [
    [{ op: 'write', path: 'CLAUDE.md', content: '' }, true],
    [{ op: 'write', path: '.claude/rules/lang.md', content: '' }, true],
    [{ op: 'patch', path: '.claude/skills/deploy/SKILL.md', diff: '' }, true],
    [{ op: 'append', path: 'memory/MEMORY.md', text: '' }, true],
    [{ op: 'move', from: 'memory/old.md', to: 'memory/.archive/old.md' }, true],
    [{ op: 'move', from: '.claude/rules/a.md', to: '.claude/rules/b.md' }, true],
    [{ op: 'move', from: 'memory/old.md', to: 'memory/new.md' }, false],
    [{ op: 'move', from: 'memory/old.md', to: '.claude/rules/old.md' }, false],
    [{ op: 'write', path: 'brain.md', content: '' }, false],
    [{ op: 'write', path: '.claude/settings.json', content: '' }, false],
    [{ op: 'write', path: 'claude.md', content: '' }, false],
    [{ op: 'write', path: 'memory/../topics', content: '' }, false],
    [{ op: 'write', path: '/etc/passwd', content: '' }, false],
    [{ op: 'write', path: 'memory\\x.md', content: '' }, false],
    [{ op: 'write', path: 'memory//x.md', content: '' }, false],
    [{ op: 'write', path: 'memory/', content: '' }, false],
    [{ op: 'write', path: 'memory/x\0.md', content: '' }, false],
    [{ op: 'write', path: '', content: '' }, false],
    [{ op: 'append', path: './CLAUDE.md', text: '' }, false],
    [{ op: 'move', from: '../other/memory/a.md', to: 'memory/.archive/a.md' }, false],
  ];
  for (const [op, allowed] of rows) {
    const reasons = checkProposalPaths({ ops: [op] });
    assert.equal(reasons.length === 0, allowed, `${JSON.stringify(op)} → ${reasons.join('; ')}`);
  }
});

test('newProposalId: p + base36 time + 4 base36 chars', () => {
  assert.equal(newProposalId(36 ** 3, () => 0.5), 'p1000iiii');
  assert.match(newProposalId(), /^p[0-9a-z]{12}$/);
});

// ----------------------------------------------------------------- store ---

test('store: write, list, read and move round-trip; a broken file is reported', () => {
  const { root } = fixture();
  const p = proposal([{ op: 'append', path: 'memory/MEMORY.md', text: '- x\n' }]);
  writeProposal(root, 'pending', p);
  assert.deepEqual(readProposal(root, p.id), { kind: 'ok', state: 'pending', proposal: p });

  moveProposal(root, p.id, 'pending', 'posted');
  fs.writeFileSync(path.join(root, 'proposals', 'pending', 'pbroken.json'), '{"id":');
  fs.writeFileSync(path.join(root, 'proposals', 'done', 'pnotaproposal.json'), '{"id":"x"}');
  fs.writeFileSync(path.join(root, 'proposals', 'pending', 'pwip.json.123.tmp'), '');

  const { proposals, broken } = listProposals(root);
  assert.deepEqual(proposals, [{ state: 'posted', proposal: p }]);
  assert.deepEqual(
    broken.map((b) => [b.state, b.id]),
    [
      ['pending', 'pbroken'],
      ['done', 'pnotaproposal'],
    ]
  );
  assert.equal(readProposal(root, 'pbroken').kind, 'broken');
  assert.equal(readProposal(root, 'pnothere').kind, 'missing');
  assert.throws(() => readProposal(root, '../escape'), /bad proposal id/);
});

// --------------------------------------------------------------- apply ---

test('apply runs all four ops in order, wraps the markdown, and resolves to done', () => {
  const { root, agents, home } = fixture();
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(home, 'memory', 'MEMORY.md'), '- [a](a.md)'); // no trailing newline
  fs.writeFileSync(path.join(home, 'memory', 'old.md'), 'stale\n');
  const before = 'line one\nline two\n';
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), before);
  const long = `${'Sentence number one is here. '.repeat(15)}End.`;

  const p = proposal([
    { op: 'write', path: '.claude/rules/lang.md', content: `${long}\n` },
    { op: 'append', path: 'memory/MEMORY.md', text: '- [b](b.md)\n' },
    { op: 'append', path: 'memory/new-index.md', text: 'first\n' },
    { op: 'patch', path: 'CLAUDE.md', diff: createTwoFilesPatch('CLAUDE.md', 'CLAUDE.md', before, 'line one\nline 2\n') },
    { op: 'move', from: 'memory/old.md', to: 'memory/.archive/old.md' },
  ]);
  writeProposal(root, 'posted', p);

  const r = applyProposal(root, agents, p.id, { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));

  const rule = read(path.join(home, '.claude', 'rules', 'lang.md'));
  assert.ok(rule.split('\n').length > 2, 'the long rule line was wrapped');
  assert.ok(rule.split('\n').every((l) => l.length <= 300));
  assert.equal(read(path.join(home, 'memory', 'MEMORY.md')), '- [a](a.md)\n- [b](b.md)\n', 'a newline before the appended text');
  assert.equal(read(path.join(home, 'memory', 'new-index.md')), 'first\n', 'append creates a missing file');
  assert.equal(read(path.join(home, 'CLAUDE.md')), 'line one\nline 2\n');
  assert.equal(fs.existsSync(path.join(home, 'memory', 'old.md')), false);
  assert.equal(read(path.join(home, 'memory', '.archive', 'old.md')), 'stale\n');

  const stored = readProposal(root, p.id);
  assert.equal(stored.kind === 'ok' && stored.state, 'done');
  assert.equal(stored.kind === 'ok' && stored.proposal.outcome, 'applied');
  assert.equal(stored.kind === 'ok' && stored.proposal.resolvedAt, NOW);
  assert.equal(fs.existsSync(path.join(root, 'proposals', 'posted', `${p.id}.json`)), false);
});

test('a patch that does not apply fails the proposal, which stays in posted', () => {
  const { root, agents, home } = fixture();
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'something else entirely\n');
  const p = proposal([
    { op: 'append', path: 'memory/MEMORY.md', text: 'kept\n' },
    { op: 'patch', path: 'CLAUDE.md', diff: createTwoFilesPatch('CLAUDE.md', 'CLAUDE.md', 'a\nb\n', 'a\nc\n') },
    { op: 'write', path: 'memory/never.md', content: 'x' },
  ]);
  writeProposal(root, 'posted', p);

  const r = applyProposal(root, agents, p.id, { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /CLAUDE\.md: the patch does not apply/);
  const stored = readProposal(root, p.id);
  assert.equal(stored.kind === 'ok' && stored.state, 'posted');
  assert.equal(stored.kind === 'ok' && stored.proposal.outcome, 'failed');
  assert.match(stored.kind === 'ok' ? (stored.proposal.error ?? '') : '', /does not apply/);
  assert.equal(stored.kind === 'ok' && stored.proposal.resolvedAt, undefined);
  assert.equal(read(path.join(home, 'memory', 'MEMORY.md')), 'kept\n', 'not transactional: the op before stays');
  assert.equal(fs.existsSync(path.join(home, 'memory', 'never.md')), false, 'stops at the first failure');
});

test('a move never overwrites', () => {
  const { root, agents, home } = fixture();
  fs.mkdirSync(path.join(home, 'memory', '.archive'), { recursive: true });
  fs.writeFileSync(path.join(home, 'memory', 'a.md'), 'new\n');
  fs.writeFileSync(path.join(home, 'memory', '.archive', 'a.md'), 'old\n');
  const p = proposal([{ op: 'move', from: 'memory/a.md', to: 'memory/.archive/a.md' }]);
  writeProposal(root, 'pending', p);
  const r = applyProposal(root, agents, p.id, { now: NOW });
  assert.match(r.ok ? '' : r.error, /already exists/);
  assert.equal(read(path.join(home, 'memory', '.archive', 'a.md')), 'old\n');
  const stored = readProposal(root, p.id);
  assert.equal(stored.kind === 'ok' && stored.state, 'pending', 'a failed apply stays where it was');
  assert.equal(stored.kind === 'ok' && stored.proposal.outcome, 'failed');
});

test('a symlink that leads out of the home is refused before any op runs', () => {
  const { root, agents, home } = fixture();
  const outside = path.join(tmp, `outside-${seq}`);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, 'memory'));
  const p = proposal([
    { op: 'write', path: 'CLAUDE.md', content: 'first\n' },
    { op: 'write', path: 'memory/pwned.md', content: 'x' },
  ]);
  writeProposal(root, 'posted', p);
  const r = applyProposal(root, agents, p.id, { now: NOW });
  assert.match(r.ok ? '' : r.error, /outside the agent's home/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(home, 'CLAUDE.md')), false, 'checked before the first op');
});

test('a symlink as the file itself is refused, dangling or not', () => {
  const { root, agents, home } = fixture();
  const outside = path.join(tmp, `dangling-target-${seq}`);
  fs.mkdirSync(path.join(home, 'memory'));
  fs.symlinkSync(outside, path.join(home, 'memory', 'MEMORY.md'));
  fs.writeFileSync(path.join(home, 'memory', 'real.md'), 'inside\n');
  fs.symlinkSync(path.join(home, 'memory', 'real.md'), path.join(home, 'CLAUDE.md'));
  for (const op of [
    { op: 'write', path: 'memory/MEMORY.md', content: 'x' },
    { op: 'append', path: 'memory/MEMORY.md', text: 'x' },
    { op: 'write', path: 'CLAUDE.md', content: 'x' },
  ] satisfies ProposalOp[]) {
    const p = proposal([op]);
    writeProposal(root, 'posted', p);
    const r = applyProposal(root, agents, p.id, { now: NOW });
    assert.match(r.ok ? '' : r.error, /is a symlink/, JSON.stringify(op));
  }
  assert.equal(fs.existsSync(outside), false, 'nothing was created at the dangling target');
  assert.equal(read(path.join(home, 'memory', 'real.md')), 'inside\n');
});

test('apply refuses paths, a missing home, and a resolved proposal', () => {
  const { root, agents } = fixture();
  const bad = proposal([{ op: 'write', path: 'brain.md', content: '' }]);
  writeProposal(root, 'pending', bad);
  assert.match(JSON.stringify(applyProposal(root, agents, bad.id)), /outside CLAUDE\.md/);

  const homeless = proposal([{ op: 'write', path: 'CLAUDE.md', content: '' }], { agent: 'ghost' });
  writeProposal(root, 'pending', homeless);
  assert.match(JSON.stringify(applyProposal(root, agents, homeless.id)), /no home for agent ghost/);

  const good = proposal([{ op: 'write', path: 'CLAUDE.md', content: 'x\n' }]);
  writeProposal(root, 'pending', good);
  assert.equal(applyProposal(root, agents, good.id).ok, true);
  assert.deepEqual(applyProposal(root, agents, good.id), { ok: false, error: `proposal ${good.id} is already resolved` });
});

test('reject resolves to done without touching the home', () => {
  const { root, home } = fixture();
  const p = proposal([{ op: 'write', path: 'CLAUDE.md', content: 'x\n' }], { outcome: 'failed', error: 'earlier' });
  writeProposal(root, 'posted', p);
  const r = rejectProposal(root, p.id, { now: NOW });
  assert.equal(r.ok, true);
  const stored = readProposal(root, p.id);
  assert.equal(stored.kind === 'ok' && stored.state, 'done');
  assert.equal(stored.kind === 'ok' && stored.proposal.outcome, 'rejected');
  assert.equal(stored.kind === 'ok' && stored.proposal.error, undefined);
  assert.equal(fs.existsSync(path.join(home, 'CLAUDE.md')), false);
  assert.equal(rejectProposal(root, p.id).ok, false);
});

// ------------------------------------------------------------- matchers ---

const reaction = (emoji: string, extra: Partial<TgReaction> = {}): TgReaction =>
  ({
    chat: { id: CHAT, type: 'supergroup' },
    message_id: 700,
    user: { id: 424242 },
    old_reaction: [],
    new_reaction: [{ type: 'emoji', emoji }],
    ...extra,
  }) as TgReaction;

const posted = [
  proposal([{ op: 'write', path: 'CLAUDE.md', content: '' }], { messageId: 700, chatId: CHAT, postedAt: NOW - 2 * HOUR }),
  proposal([{ op: 'write', path: 'CLAUDE.md', content: '' }], { messageId: 701, chatId: CHAT, postedAt: NOW - 30 * HOUR }),
];

test('👍 on a posted proposal applies it, 👎 rejects it', () => {
  assert.deepEqual(matchProposalReaction(reaction('👍'), posted), { proposal: posted[0], verdict: 'apply' });
  assert.deepEqual(matchProposalReaction(reaction('👎', { message_id: 701 }), posted), {
    proposal: posted[1],
    verdict: 'reject',
  });
  const swapped = reaction('👎', { old_reaction: [{ type: 'emoji', emoji: '👍' }] });
  assert.equal(matchProposalReaction(swapped, posted)?.verdict, 'reject', 'changing 👍 to 👎 is a reject');
});

test('anything else is no verdict', () => {
  assert.equal(matchProposalReaction(reaction('🔥'), posted), null, 'another emoji');
  assert.equal(matchProposalReaction(reaction('👍', { message_id: 999 }), posted), null, 'not a proposal');
  assert.equal(matchProposalReaction(reaction('👍', { chat: { id: 1, type: 'private' } }), posted), null, 'other chat');
  const removed = reaction('👍', { old_reaction: [{ type: 'emoji', emoji: '👍' }, { type: 'emoji', emoji: '🔥' }] });
  assert.equal(matchProposalReaction(removed, posted), null, 'taking a reaction off');
  assert.equal(matchProposalReaction(reaction('👍', { new_reaction: [] }), posted), null, 'no reaction left');
  assert.equal(matchProposalReaction(reaction('👍', { new_reaction: [{ type: 'custom_emoji' }] }), posted), null);
});

test('isRejectReply: exactly one of the words, trimmed, any case', () => {
  for (const yes of ['нет', 'не надо', 'no', 'nope', '  НЕТ ', 'No', 'NOPE\n', 'Не надо']) {
    assert.equal(isRejectReply(yes), true, yes);
  }
  for (const no of ['нет.', 'нет, не надо', 'no way', 'n', '', 'ok', 'не  надо', 'да']) {
    assert.equal(isRejectReply(no), false, no);
  }
});

test('expiredProposals: postedAt + (ttlMs ?? default) <= now', () => {
  assert.deepEqual(expiredProposals(posted, NOW, 24 * HOUR), [posted[1]]);
  assert.deepEqual(expiredProposals(posted, NOW, 2 * HOUR), posted, 'exactly at the ttl counts');
  const own = { ...posted[0], ttlMs: HOUR } as Proposal;
  assert.deepEqual(expiredProposals([own], NOW, 24 * HOUR), [own], 'the proposal’s own ttl wins');
  const unposted = proposal([{ op: 'write', path: 'CLAUDE.md', content: '' }]);
  assert.deepEqual(expiredProposals([unposted], NOW + 100 * HOUR, HOUR), []);
  const failed = { ...posted[1], outcome: 'failed', error: 'the patch does not apply' } as Proposal;
  assert.deepEqual(expiredProposals([failed], NOW, HOUR), [], 'a failed apply is never retried by silence');
});

test('matchRejectReply: a "no" replying to a posted proposal in the learning topic', () => {
  const topic = { chatId: CHAT, threadId: 1022 };
  const msg = (extra: Record<string, unknown> = {}) => ({
    chat: { id: CHAT },
    message_thread_id: 1022,
    text: 'нет',
    reply_to_message: { message_id: 700 },
    ...extra,
  });
  assert.equal(matchRejectReply(msg(), topic, posted), posted[0]);
  assert.equal(matchRejectReply(msg({ text: ' Nope ', reply_to_message: { message_id: 701 } }), topic, posted), posted[1]);
  assert.equal(matchRejectReply(msg({ text: 'нет, но поправь' }), topic, posted), null, 'more than the word');
  assert.equal(matchRejectReply(msg({ reply_to_message: undefined }), topic, posted), null, 'not a reply');
  assert.equal(matchRejectReply(msg({ reply_to_message: { message_id: 999 } }), topic, posted), null, 'not a proposal');
  assert.equal(matchRejectReply(msg({ message_thread_id: 7 }), topic, posted), null, 'another topic');
  assert.equal(matchRejectReply(msg({ chat: { id: 1 } }), topic, posted), null, 'another chat');
  assert.equal(matchRejectReply(msg({ text: undefined }), topic, posted), null, 'no text');
});

// ------------------------------------------------------------ rendering ---

const diff = createTwoFilesPatch('CLAUDE.md', 'CLAUDE.md', 'a\nb\nc\n', 'a\nB\nc\nd\n');
const small = proposal(
  [
    { op: 'write', path: '.claude/rules/lang.md', content: 'Answer in the question’s language.\n' },
    { op: 'append', path: 'memory/MEMORY.md', text: '- [lang](lang.md)\n' },
    { op: 'patch', path: 'CLAUDE.md', diff },
    { op: 'move', from: 'memory/old.md', to: 'memory/.archive/old.md' },
  ],
  { id: 'pabc' }
);
const big = { ...small, ops: [{ op: 'write', path: 'CLAUDE.md', content: 'x'.repeat(PROPOSAL_TEXT_MAX) }] } as Proposal;

test('renderProposal in English: header, title, summary, ops with bodies, legend', () => {
  getI18n().changeLanguage('en');
  const { text, overflow } = renderProposal(small, { ttlMs: 24 * HOUR });
  assert.equal(overflow, undefined);
  const lines = text.split('\n');
  assert.equal(lines[0], '#pabc · rule · psy');
  assert.equal(lines[1], small.title);
  assert.equal(lines[2], small.summary);
  assert.ok(lines.includes('write .claude/rules/lang.md (35 chars)'), text);
  assert.ok(lines.includes('Answer in the question’s language.'), 'the content is inlined');
  assert.ok(lines.includes('append memory/MEMORY.md (+18 chars)'), text);
  assert.ok(lines.includes('patch CLAUDE.md (+2/-1 lines)'), text);
  assert.ok(lines.includes('+B'), 'the diff is inlined');
  assert.ok(lines.includes('move memory/old.md → memory/.archive/old.md'), text);
  assert.equal(lines.at(-1), '👍 apply · 👎 reject · silence 24 h = apply');
  assert.equal(renderProposal({ ...small, ttlMs: 6 * HOUR }, { ttlMs: 24 * HOUR }).text.split('\n').at(-1), '👍 apply · 👎 reject · silence 6 h = apply');
});

test('renderProposal overflow: the short form in text, the full dump beside it', () => {
  getI18n().changeLanguage('en');
  const { text, overflow } = renderProposal(big, { ttlMs: 24 * HOUR });
  assert.ok(text.length <= PROPOSAL_TEXT_MAX);
  assert.deepEqual(text.split('\n'), [
    '#pabc · rule · psy',
    small.title,
    small.summary,
    '',
    `write CLAUDE.md (${PROPOSAL_TEXT_MAX} chars)`,
    '',
    '👍 apply · 👎 reject · silence 24 h = apply',
  ]);
  assert.ok(overflow?.includes('x'.repeat(PROPOSAL_TEXT_MAX)));
});

test('renderProposal in Russian', () => {
  getI18n().changeLanguage('ru');
  try {
    const lines = renderProposal(small, { ttlMs: 24 * HOUR }).text.split('\n');
    assert.equal(lines[0], '#pabc · rule · psy');
    assert.ok(lines.includes('записать .claude/rules/lang.md (35 симв.)'), lines.join('\n'));
    assert.ok(lines.includes('дописать memory/MEMORY.md (+18 симв.)'));
    assert.ok(lines.includes('патч CLAUDE.md (+2/-1 строк)'));
    assert.ok(lines.includes('переместить memory/old.md → memory/.archive/old.md'));
    assert.equal(lines.at(-1), '👍 применить · 👎 отклонить · молчание 24 ч = применить');

    const short = renderProposal(big, { ttlMs: 24 * HOUR });
    assert.ok(short.overflow !== undefined);
    assert.ok(short.text.split('\n').includes(`записать CLAUDE.md (${PROPOSAL_TEXT_MAX} симв.)`));
  } finally {
    getI18n().changeLanguage('en');
  }
});
