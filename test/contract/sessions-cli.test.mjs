// sessions-cli.test.mjs — the external contract of `node src/sessions.mjs`.
//
// This one is pure formatted text: the agent reads it out of a shell and
// paraphrases it into Telegram, so column widths, the `~`-folded project path,
// the `01-02 03:04` timestamp shape and the trailer line are all part of what
// callers see. Driven by synthetic transcripts under CLAUDE_HOMES with FIXED
// mtimes, so every byte of the output is deterministic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { expectFixture, rmDir, runSrc, tmpDir } from './helpers.mjs';

let tmp;
let claudeHome;

// sessions.mjs skips anything under 2000 bytes ("empty shells and aborted
// starts"), reads the first prompt out of the head 64 KB and the last
// assistant text out of the tail 48 KB. The padding below must therefore be
// big enough to clear 2000 bytes and must contain neither `"user"` nor
// `"assistant"`, or it would be parsed as a turn.
function transcript({ prompt, reply }) {
  const pad = JSON.stringify({ type: 'system', subtype: 'pad', note: 'x'.repeat(2400) });
  return [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<command-name>/init</command-name>' } }),
    JSON.stringify({ type: 'user', message: { content: prompt } }),
    pad,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first pass, superseded' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }),
    '',
  ].join('\n');
}

// The synthetic home every fixture path is rendered from. Deliberately NOT
// home-shaped: scripts/publish.sh refuses to export a tree matching
// /Users/[A-Za-z] or /home/[a-z], and a recorded fixture is plain text to that
// grep. Keep it hyphen-free too — the slug decode is lossy ('-' → '/'), so a
// home like '/opt/demo-home' renders as '/opt/demo/home/…' and trips the
// /home/ half of the very same guard.
const HOME_SLUG = '-opt-demo';

// Project dir names are the absolute cwd with '/' → '-'. A name that does NOT
// start with the (temp) home keeps the fixture independent of $TMPDIR.
function session({ slug, id, prompt, reply, mtime }) {
  const dir = path.join(claudeHome, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, transcript({ prompt, reply }));
  assert.ok(fs.statSync(file).size > 2000, 'transcript must clear the 2000-byte floor');
  const at = new Date(mtime);
  fs.utimesSync(file, at, at);
}

const sessions = (args) =>
  runSrc('sessions.mjs', args, { env: { HOME: tmp, CLAUDE_HOMES: claudeHome } });

before(() => {
  tmp = tmpDir('sessions-contract');
  claudeHome = path.join(tmp, '.claude');
  session({
    slug: `${HOME_SLUG}-git-demo`,
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    prompt: 'Fix the deploy script for the staging cluster',
    reply: 'Deploy script fixed and staging is green.',
    mtime: '2026-01-02T03:04:05.000Z',
  });
  session({
    slug: `${HOME_SLUG}-git-other-repo`,
    id: 'ffffffff-1111-2222-3333-444444444444',
    prompt: 'Собери сводку по топикам за неделю',
    reply: 'Сводка готова, отправил в «dev».',
    mtime: '2026-02-03T04:05:06.000Z',
  });
});
after(() => rmDir(tmp));

test('recent: newest first, two lines per session, trailer', () => {
  const r = sessions(['recent']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  expectFixture('sessions/recent.txt', r.stdout);
  // No subcommand at all behaves exactly like `recent`.
  assert.equal(sessions([]).stdout, r.stdout);
});

test('recent N caps the list', () => {
  const r = sessions(['recent', '1']);
  assert.equal(r.code, 0);
  expectFixture('sessions/recent-1.txt', r.stdout);
});

test('search <word>: matches project path + opening prompt', () => {
  const hit = sessions(['search', 'deploy']);
  assert.equal(hit.code, 0);
  expectFixture('sessions/search-deploy.txt', hit.stdout);

  const miss = sessions(['search', 'zzzznothing']);
  assert.equal(miss.code, 0);
  expectFixture('sessions/search-miss.txt', miss.stdout);
});

test('search without words is a usage error (exit 1)', () => {
  const r = sessions(['search']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'usage: sessions.mjs search <words…>\n');
});

test('show <id-prefix>: opening prompt + last assistant reply from the tail', () => {
  const r = sessions(['show', 'aaaaaaaa']);
  assert.equal(r.code, 0);
  expectFixture('sessions/show.txt', r.stdout);
});

test('show: an unknown prefix and a missing prefix both exit 1', () => {
  const missing = sessions(['show']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, 'usage: sessions.mjs show <id-prefix>\n');

  const unknown = sessions(['show', 'nope']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, 'no session starts with "nope"\n');
});

test('an unknown command prints the usage line (exit 0)', () => {
  const r = sessions(['bogus']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'usage: sessions.mjs [recent [N] | search <words…> | show <id-prefix>]\n');
});
