// strings.snapshot.test.mjs — every Russian-facing string literal in src/.
//
// Stage S2 pulled these out into an i18n catalogue. The inventory stayed: it
// scans src/ for every string literal (single quote, double quote, template)
// whose source contains a Cyrillic character and compares the set to
// fixtures/strings.ru.json — so a Russian sentence reappearing inline in
// runner.mjs or status.mjs fails the suite instead of quietly becoming
// untranslatable text again.
//
// After S2 the inventory has two legitimate homes, and the second test below
// is the rule: src/i18n/ru.ts (the catalogue) and src/config.ts (the flush
// words, which are what the OWNER types — input, not output). Comments are not
// literals and are not scanned: a comment quoting the owner is prose.
//
// Why a tokenizer and not one regex: a line regex cannot tell `'...'` inside a
// comment or a regex literal from a real string, and the sources contain both
// (`/^(\S*\/)?claude(\s|$)/`, `.replace(/-/g, '/')`). The scanner below walks
// the file in the states JavaScript actually has — code / line comment / block
// comment / string / template (with ${} nesting) / regex literal — and the
// test asserts it finished in the code state, which is what catches a desync.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expectFixture, SRC } from './helpers.mjs';

const CYRILLIC = /[Ѐ-ӿ]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
// After one of these a `/` opens a regex literal, not a division.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'case', 'yield', 'await', 'throw',
]);

// Returns every string literal in `src` as its RAW source text, delimiters
// included: that is unambiguous (no guessing about escapes) and is what an
// extraction step has to rewrite.
export function scanStringLiterals(src) {
  const found = [];
  const n = src.length;
  // Template literals nest: `a ${ `b` } c`. The stack remembers, for each open
  // `${`, the brace depth at which the template resumes.
  const tmplStack = [];
  let braceDepth = 0;
  let i = 0;
  let prevChar = '';
  let prevWord = '';

  const regexAllowed = () => {
    if (prevChar === '') return true;
    if (ID_CHAR.test(prevChar)) return REGEX_KEYWORDS.has(prevWord);
    return !')]}'.includes(prevChar);
  };
  const mark = (c) => {
    prevChar = c;
    prevWord = '';
  };

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break; // unterminated: bail rather than swallow the file
        i++;
      }
      i++; // closing slash
      while (i < n && /[a-z]/.test(src[i])) i++; // flags
      assert.ok(src.slice(start, i).length > 1, 'regex literal scan made no progress');
      mark('/');
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < n && src[i] !== c) i = src[i] === '\\' ? i + 2 : i + 1;
      i++;
      found.push(src.slice(start, i));
      mark(c);
      continue;
    }
    if (c === '`') {
      const start = i;
      i++;
      for (;;) {
        if (i >= n) break;
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Hand control back to the code scanner; the matching `}` resumes
          // this template. The raw text of the whole literal is taken from the
          // outermost start index once it closes.
          tmplStack.push({ start, brace: braceDepth });
          braceDepth++;
          i += 2;
          break;
        }
        i++;
      }
      if (tmplStack.length && tmplStack.at(-1).start === start && tmplStack.at(-1).brace === braceDepth - 1) {
        mark('$'); // inside ${ … }: keep scanning as code
        continue;
      }
      found.push(src.slice(start, i));
      mark('`');
      continue;
    }
    if (c === '{') {
      braceDepth++;
      i++;
      mark('{');
      continue;
    }
    if (c === '}') {
      braceDepth--;
      i++;
      const open = tmplStack.at(-1);
      if (open && open.brace === braceDepth) {
        // Back inside the template that opened this ${ … }.
        tmplStack.pop();
        for (;;) {
          if (i >= n) break;
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '`') { i++; break; }
          if (src[i] === '$' && src[i + 1] === '{') {
            tmplStack.push({ start: open.start, brace: braceDepth });
            braceDepth++;
            i += 2;
            break;
          }
          i++;
        }
        if (tmplStack.length && tmplStack.at(-1).start === open.start && tmplStack.at(-1).brace === braceDepth - 1) {
          mark('$');
          continue;
        }
        found.push(src.slice(open.start, i));
        mark('`');
        continue;
      }
      mark('}');
      continue;
    }
    if (ID_CHAR.test(c)) {
      let e = i;
      while (e < n && ID_CHAR.test(src[e])) e++;
      prevWord = src.slice(i, e);
      prevChar = src[e - 1];
      i = e;
      continue;
    }
    mark(c);
    i++;
  }

  assert.equal(tmplStack.length, 0, 'scanner ended inside a template literal — it desynced');
  return found;
}

// The only file a Cyrillic string literal may live in. It used to be two: the
// flush-word default in src/config.ts was the second, and it is empty now that
// a reaction closes the burst window instead of a typed word — set
// TG_FLUSH_WORDS and the words live in the env file, which is not source.
const RUSSIAN_FILES = ['src/i18n/ru.ts'];

function collect() {
  const entries = [];
  const names = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => (f.endsWith('.mjs') || f.endsWith('.ts')) && !f.endsWith('.d.ts'))
    .sort();
  for (const name of names) {
    const src = fs.readFileSync(path.join(SRC, name), 'utf8');
    for (const text of scanStringLiterals(src)) {
      if (CYRILLIC.test(text)) entries.push({ file: `src/${name}`, text });
    }
  }
  return entries;
}

test('the tokenizer does not mistake comments, regexes or division for strings', () => {
  const sample = [
    "const a = 'один';",
    'const b = "два"; // «три» in a comment',
    '/* «четыре» in a block comment */',
    "const re = /^(\\S*\\/)?claude(\\s|$)/; const d = a.length / 2;",
    "const slash = x.replace(/-/g, '/');",
    'const t = `пять ${a} шесть`;',
    'const nested = `семь ${cond ? `восемь ${b}` : "девять"} десять`;',
  ].join('\n');
  const got = scanStringLiterals(sample);
  assert.deepEqual(got, [
    "'один'",
    '"два"',
    "'/'",
    '`пять ${a} шесть`',
    '`восемь ${b}`',
    '"девять"',
    '`семь ${cond ? `восемь ${b}` : "девять"} десять`',
  ]);
});

test('Russian text lives in the catalogue, nowhere else', () => {
  const files = [...new Set(collect().map((e) => e.file))].sort();
  assert.deepEqual(
    files,
    RUSSIAN_FILES,
    'a Russian literal outside src/i18n/ru.ts is a sentence that cannot be translated'
  );
});

test('every Cyrillic string literal in src/ is inventoried', () => {
  const entries = collect();
  expectFixture('strings.ru.json', entries);
  assert.ok(entries.length > 0, 'the daemon speaks Russian — an empty inventory means the scanner broke');
  // Report the size so a diff in the count is visible without reading the JSON.
  console.log(`# Cyrillic string literals in src/: ${entries.length}`);
});
