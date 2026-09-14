// node --test lint-no-any.test.ts
//
// A house rule with teeth. `any` switches the checker off exactly where the
// code is hardest to reason about, and the port from .mjs is precisely when it
// is tempting: an untyped value crossing a boundary, one escape hatch, and the
// type that was supposed to describe the daemon describes nothing. tsc cannot
// catch this (a declared `any` is legal TypeScript), so the grep is the gate.
//
// The patterns are assembled from pieces on purpose: spelled out, this file
// would trip its own scan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOTS = ['src', 'test'];

const ESCAPE = 'any';
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: `: ${ESCAPE}`, re: new RegExp(`:\\s*${ESCAPE}\\b`) },
  { label: `<${ESCAPE}>`, re: new RegExp(`<${ESCAPE}>`) },
  { label: `as ${ESCAPE}`, re: new RegExp(`\\bas\\s+${ESCAPE}\\b`) },
  { label: `${ESCAPE}[]`, re: new RegExp(`\\b${ESCAPE}\\[\\]`) },
];

// Comments and string bodies are blanked out (newlines kept, so line numbers
// survive) before the patterns run: prose about the rule must not trip it.
// A `//` inside a regex literal would end that line early — a missed hit, never
// a false alarm, which is the right way round for a gate.
function blankNonCode(src: string): string {
  const out = src.split('');
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    const next = src[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && (next === '/' || next === '*')) {
        state = next === '/' ? 'line' : 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') state = c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === state) state = 'code';
    else if (c !== '\n') out[i] = ' ';
    i += 1;
  }
  return out.join('');
}

function typescriptFiles(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    const dir = path.join(ROOT, root);
    if (!fs.existsSync(dir)) continue;
    for (const rel of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) found.push(path.join(dir, rel));
    }
  }
  return found.sort();
}

test('src and test carry TypeScript files to lint at all', () => {
  const files = typescriptFiles();
  assert.ok(files.length >= 4, `expected the ported modules and their suites, found ${files.length}`);
});

test('no type escape hatch anywhere in src/**/*.ts or test/**/*.ts', () => {
  const hits: string[] = [];
  for (const file of typescriptFiles()) {
    const lines = blankNonCode(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, n) => {
      for (const { label, re } of PATTERNS) {
        if (re.test(line)) hits.push(`${path.relative(ROOT, file)}:${n + 1}  ${label}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], `type escape hatches found:\n${hits.join('\n')}`);
});

test('the scanner itself sees a hit that is code and ignores one that is not', () => {
  const sample = [
    `// a comment mentioning ${ESCAPE}[] must not count`,
    `const prose = "text about ${ESCAPE}[] in a string";`,
    `function f(x: ${ESCAPE}) { return x; }`,
  ].join('\n');
  const lines = blankNonCode(sample).split('\n');
  const flagged = lines
    .map((line, n) => (PATTERNS.some((p) => p.re.test(line)) ? n + 1 : 0))
    .filter(Boolean);
  assert.deepEqual(flagged, [3]);
});
