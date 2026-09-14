// i18n.test.ts — the catalogue's own invariants.
//
// Three ways a translation file rots, all of them silent at runtime because
// i18next answers a missing key with the key itself:
//   1. a key added to one language and not the other;
//   2. a value whose {{placeholders}} drifted from the other language's, so a
//      number lands in one locale and a bare `{{n}}` in the other;
//   3. a call site asking for a key nobody wrote.
// The first two are pure data checks; the third needs a scan of the sources,
// because the .mjs entry points are not type-checked and the typed key union
// in src/i18n/index.ts cannot help them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { en } from '../src/i18n/en.ts';
import { ru } from '../src/i18n/ru.ts';
import { getI18n, resources } from '../src/i18n/index.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const AREAS = ['help', 'turn', 'reset', 'status', 'wake', 'recovery', 'duration', 'statusCli'];

type Catalogue = Record<string, Record<string, string>>;

function flatten(catalogue: Catalogue): Map<string, string> {
  const out = new Map<string, string>();
  for (const [area, messages] of Object.entries(catalogue)) {
    for (const [name, value] of Object.entries(messages)) out.set(`${area}.${name}`, value);
  }
  return out;
}

const EN = flatten(en);
const RU = flatten(ru);

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();

// Every `t('…')` in src/, including the keys inside a ternary
// (`t(cond ? 'a.b' : 'a.c', …)`). The call is found by the identifier boundary
// — `sendText(`, `.at(`, `format(` all end in `t(` and none of them is ours —
// and the argument list is then walked with the quotes and nesting respected,
// which a single regex cannot do.
export function scanKeys(src: string): string[] {
  const keys: string[] = [];
  for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_$.])t\(/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        const start = ++i;
        while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
        if (quote === "'" && depth === 0) keys.push(src.slice(start, i));
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' && depth === 0) break; // end of the call
      else if (c === ',' && depth === 0) break; // end of the first argument
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
  }
  return keys;
}

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const rel of fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.mjs') && !rel.endsWith('.ts')) continue;
    if (rel.startsWith('i18n')) continue; // the catalogue is not a call site
    out.push({ file: rel, text: fs.readFileSync(path.join(SRC, rel), 'utf8') });
  }
  return out;
}

test('the scanner finds keys in a plain call and inside a ternary', () => {
  const sample = [
    "await sendText(chat, t('turn.failed', { error: e.message }), thread);",
    "const head = t(\n  ok ? 'wake.failedToProcessFinished' : 'wake.failedToProcessFailed',\n  { job }\n);",
    "const x = list.at(0); const y = fmt('%s', t('reset.done'));",
  ].join('\n');
  assert.deepEqual(scanKeys(sample), [
    'turn.failed',
    'wake.failedToProcessFinished',
    'wake.failedToProcessFailed',
    'reset.done',
  ]);
});

test('en and ru describe exactly the same set of keys', () => {
  assert.deepEqual(
    [...RU.keys()].filter((k) => !EN.has(k)),
    [],
    'keys in ru that en does not have — en defines the key set'
  );
  assert.deepEqual(
    [...EN.keys()].filter((k) => !RU.has(k)),
    [],
    'keys in en that ru does not have — they would silently fall back to English'
  );
});

test('every key uses the same placeholders in both languages', () => {
  const drifted: string[] = [];
  for (const [key, value] of EN) {
    const other = RU.get(key) ?? '';
    const mine = placeholders(value).join(',');
    const theirs = placeholders(other).join(',');
    if (mine !== theirs) drifted.push(`${key}: en {${mine}} vs ru {${theirs}}`);
  }
  assert.deepEqual(drifted, []);
});

test('no value is empty, and every key lives under a known area', () => {
  for (const [name, catalogue] of [['en', EN], ['ru', RU]] as const) {
    for (const [key, value] of catalogue) {
      assert.ok(value.length > 0, `${name}: ${key} is empty`);
      assert.ok(AREAS.includes(key.split('.')[0] ?? ''), `${name}: ${key} is in no known area`);
    }
  }
});

test('every t() call in src/ asks for a key the catalogue has', () => {
  const missing: string[] = [];
  let seen = 0;
  for (const { file, text } of sources()) {
    for (const key of scanKeys(text)) {
      seen++;
      if (!EN.has(key)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(seen > 10, `only ${seen} t() calls found — the scanner probably broke`);
});

test('the instance answers in the locale it was built with, and falls back to en', () => {
  const i18n = getI18n('ru');
  assert.equal(i18n.t('reset.doneThisTopic'), RU.get('reset.doneThisTopic'));
  // Interpolation is unescaped: «guillemets» and & must reach Telegram as typed.
  assert.equal(
    i18n.t('wake.fullOutput', { file: '/tmp/a&b' }),
    (RU.get('wake.fullOutput') ?? '').replace('{{file}}', '/tmp/a&b')
  );
  assert.deepEqual(Object.keys(resources).sort(), ['en', 'ru']);
});
