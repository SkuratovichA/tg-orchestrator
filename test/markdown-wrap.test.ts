// node --test markdown-wrap.test.ts
//
// The sentence wrap (docs/agent-learning.md §4). What is pinned: which lines
// are wrapped and how their continuations are prefixed, which lines are never
// touched, that no character but the split whitespace is lost, and that a
// second pass changes nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapLongLines } from '../src/markdown-wrap.ts';

const MAX = 90;
const wrap = (md: string): string => wrapLongLines(md, MAX);

/** A sentence of exactly `len` characters, ending in a period. */
const sentence = (word: string, len: number): string => `${word} ${'x'.repeat(len - word.length - 2)}.`;
const S1 = sentence('One', 40);
const S2 = sentence('Two', 40);
const S3 = sentence('Three', 40);
const LONG = `${S1} ${S2} ${S3}`;

/** Every non-whitespace character outside the quote prefixes, in order: what a wrap must never change. */
const ink = (s: string): string => s.replace(/^[ \t>]*/gm, '').replace(/\s+/g, '');

const FIXTURES: Record<string, string> = {
  paragraph: `${LONG}\n`,
  list: `- ${LONG}\n`,
  nestedList: `  * ${LONG}\n`,
  ordered: `12) ${LONG}\n`,
  quote: `> ${LONG}\n`,
  quotedList: `> - ${LONG}\n`,
  fence: '```\n' + LONG + '\n```\n',
  tilde: '~~~md\n' + LONG + '\n~~~\n' + LONG + '\n',
  heading: `# ${LONG}\n`,
  table: `| ${LONG} |\n`,
  frontmatter: `---\ndescription: ${LONG}\n---\n${LONG}\n`,
  comment: `<!--\n${LONG}\n-->\n${LONG}\n`,
  url: `https://example.com/${'a'.repeat(200)}\n`,
  crlf: `${LONG}\r\n${LONG}\r\n`,
  noTrailingNewline: LONG,
  links: `See [[some. link here]] and [a. b](https://x.y/z. w) now. ${S2} ${S3}\n`,
  giant: `${sentence('Huge', 200)} ${S2}\n`,
  blockStart: `${S1} 1. ${S2} - ${S3}\n`,
  blank: '\n\n\n',
};

test('a long paragraph line is split greedily after sentence ends', () => {
  assert.equal(wrap(`${LONG}\n`), `${S1} ${S2}\n${S3}\n`);
  const bang = `${S1.slice(0, -1)}! ${S2.slice(0, -1)}? ${S3}\n`;
  assert.equal(wrap(bang), `${S1.slice(0, -1)}! ${S2.slice(0, -1)}?\n${S3}\n`);
});

test('a line exactly at maxLen is untouched, one over is wrapped', () => {
  const exact = `${sentence('A', 49)} ${sentence('B', 40)}`;
  assert.equal(exact.length, MAX);
  assert.equal(wrap(exact), exact);
  const over = `${sentence('A', 50)} ${sentence('B', 40)}`;
  assert.equal(wrap(over), `${sentence('A', 50)}\n${sentence('B', 40)}`);
});

test('list continuations are indented to the item content column', () => {
  assert.deepEqual(wrap(`- ${LONG}\n`).split('\n'), [`- ${S1} ${S2}`, `  ${S3}`, '']);
  assert.deepEqual(wrap(`  * ${LONG}\n`).split('\n'), [`  * ${S1} ${S2}`, `    ${S3}`, '']);
  assert.deepEqual(wrap(`12) ${LONG}\n`).split('\n'), [`12) ${S1} ${S2}`, `    ${S3}`, '']);
});

test('blockquote continuations keep the > prefix', () => {
  assert.deepEqual(wrap(`> ${LONG}\n`).split('\n'), [`> ${S1} ${S2}`, `> ${S3}`, '']);
  assert.deepEqual(wrap(`> - ${LONG}\n`).split('\n'), [`> - ${S1} ${S2}`, `>   ${S3}`, '']);
});

test('fences, headings, tables, frontmatter, comments and blank lines are left alone', () => {
  for (const name of ['fence', 'heading', 'table', 'url', 'blank'] as const) {
    assert.equal(wrap(FIXTURES[name] ?? ''), FIXTURES[name], name);
  }
  assert.equal(wrap(FIXTURES.tilde ?? ''), '~~~md\n' + LONG + '\n~~~\n' + `${S1} ${S2}\n${S3}\n`);
  assert.equal(wrap(FIXTURES.frontmatter ?? ''), `---\ndescription: ${LONG}\n---\n${S1} ${S2}\n${S3}\n`);
  assert.equal(wrap(FIXTURES.comment ?? ''), `<!--\n${LONG}\n-->\n${S1} ${S2}\n${S3}\n`);
});

test('a single sentence longer than maxLen stays whole', () => {
  assert.equal(wrap(FIXTURES.giant ?? ''), `${sentence('Huge', 200)}\n${S2}\n`);
});

test('links are never split inside', () => {
  const out = wrap(FIXTURES.links ?? '');
  assert.ok(out.includes('[[some. link here]]'), out);
  assert.ok(out.includes('[a. b](https://x.y/z. w)'), out);
});

test('a split never makes a new list item', () => {
  const out = wrap(FIXTURES.blockStart ?? '');
  for (const line of out.split('\n').slice(1)) assert.doesNotMatch(line, /^(?:\d+\.|-) /, out);
});

test('CRLF stays CRLF and a missing trailing newline stays missing', () => {
  assert.equal(wrap(FIXTURES.crlf ?? ''), `${S1} ${S2}\r\n${S3}\r\n`.repeat(2));
  assert.equal(wrap(LONG), `${S1} ${S2}\n${S3}`);
  assert.equal(wrap(`x\r\n${LONG}`), `x\r\n${S1} ${S2}\r\n${S3}`);
});

test('every fixture: idempotent, and no character but split whitespace changes', () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    const once = wrap(md);
    assert.equal(wrap(once), once, `${name}: second pass changed it`);
    assert.equal(ink(once), ink(md), `${name}: text changed`);
    if (md.includes('\r\n')) assert.doesNotMatch(once, /(?<!\r)\n/, `${name}: a bare LF in a CRLF file`);
    assert.equal(once.endsWith('\n'), md.endsWith('\n'), `${name}: trailing newline`);
  }
});

test('the default maxLen is 300', () => {
  const para = Array.from({ length: 12 }, (_, i) => sentence(`S${i}`, 40)).join(' ');
  const lines = wrapLongLines(para).split('\n');
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= 300, line);
});
