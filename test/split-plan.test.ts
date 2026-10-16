// node --test split-plan.test.ts
//
// The planner behind tg-send.sh's split: the model's answer is accepted only as
// a clean partition of the blocks, and every fallback keeps the turn's bytes.
// The end-to-end path (fake model, fake Bot API) is in
// test/contract/tg-send-sh.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chars, fallbackParts, joinBlocks, MAX_GROUPS, PACK_LIMIT, plan, splitBlocks, TG_LIMIT, validateGroups } from '../src/split-plan.ts';

const FIVE = ['один', 'два', 'три', 'четыре', 'пять'];

test('blocks: blank lines cut, a fenced block with blank lines stays whole', () => {
  const text = 'первый\nабзац\n\n\nвторой\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nпоследний\n';
  assert.deepEqual(splitBlocks(text), ['первый\nабзац', 'второй', '```js\nconst a = 1;\n\nconst b = 2;\n```', 'последний']);
});

test('validate: a clean partition is accepted', () => {
  assert.deepEqual(validateGroups({ groups: [[1, 2], [3], [4, 5]] }, FIVE), { ok: true, groups: [[1, 2], [3], [4, 5]] });
  assert.equal(validateGroups({ groups: [[1, 2, 3, 4, 5]] }, FIVE).ok, true);
});

test('validate: every malformed answer is refused with a reason', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['missing block', { groups: [[1, 2], [3, 4]] }, /block 5 missing/],
    ['gap', { groups: [[1, 2], [4, 5]] }, /block 4 where block 3/],
    ['out of order', { groups: [[2, 1], [3, 4, 5]] }, /block 2 where block 1/],
    ['overlap', { groups: [[1, 2], [2, 3, 4, 5]] }, /block 2 where block 3/],
    ['extra block', { groups: [[1, 2, 3, 4, 5, 6]] }, /block 6 does not exist/],
    ['not integers', { groups: [['1'], [2, 3, 4, 5]] }, /not an integer/],
    ['empty group', { groups: [[1, 2], [], [3, 4, 5]] }, /non-empty/],
    ['no groups', { parts: [] }, /no "groups"/],
    ['not an object', '[[1,2]]', /no "groups"/],
  ];
  for (const [name, raw, reason] of cases) {
    const r = validateGroups(raw, FIVE);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.reason, reason, name);
  }
});

test(`validate: over ${MAX_GROUPS} groups is refused`, () => {
  const blocks = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => `блок ${i}`);
  const r = validateGroups({ groups: blocks.map((_, i) => [i + 1]) }, blocks);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /at most 6/);
});

test(`validate: a part over ${TG_LIMIT} characters is refused, counted in characters`, () => {
  // 2100 + 2 + 2100 = 4202 characters but 8402 bytes: the count is characters.
  const blocks = ['я'.repeat(2100), 'ю'.repeat(2100), 'конец'];
  const r = validateGroups({ groups: [[1, 2], [3]] }, blocks);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /part 1 is 4202 characters/);
  assert.equal(validateGroups({ groups: [[1], [2, 3]] }, blocks).ok, true);
});

test('fallback: a text that fits goes whole, byte for byte', () => {
  const text = 'а\n\n\n\nб\n';
  assert.deepEqual(fallbackParts(text, splitBlocks(text)), [text]);
});

test('fallback: an over-long text is packed by blocks, an over-long block cut at sentence ends', () => {
  const sentence = `${'слово '.repeat(30).trim()}.`; // 180 characters
  const huge = Array.from({ length: 30 }, () => sentence).join(' '); // one 5429-character block
  const blocks = ['вступление', huge, 'вывод'];
  const parts = fallbackParts(joinBlocks(blocks), blocks);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(chars(p) <= PACK_LIMIT, `${chars(p)} characters`);
  // Every cut inside the block is at a sentence end, and nothing is lost.
  for (const p of parts.slice(0, -1)) assert.match(p, /\.$/);
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), joinBlocks(blocks).replace(/\s+/g, ' '));
});

test('plan: short or single-block text never calls the model', () => {
  const opts = { minChars: 700, bin: '/nonexistent/claude', log: () => assert.fail('logged a fallback') };
  assert.equal(plan('коротко\n\nещё', opts).source, 'single');
  assert.equal(plan('я'.repeat(2000), opts).source, 'single');
});

test('plan: a model that cannot run is a fallback with one log line', () => {
  const lines: string[] = [];
  const text = joinBlocks(['а'.repeat(400), 'б'.repeat(400)]);
  const p = plan(text, { minChars: 700, bin: '/nonexistent/claude', log: (l) => lines.push(l) });
  assert.equal(p.source, 'fallback');
  assert.deepEqual(p.parts, [text]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /planner fallback/);
});
