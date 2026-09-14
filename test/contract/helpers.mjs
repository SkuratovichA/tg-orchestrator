// helpers.mjs — shared plumbing for the contract suite (stage S0).
//
// The contract tests are an executable oracle: they record what the CURRENT
// .mjs code does on its outside edges (CLI stdout/exit codes, files on disk,
// Telegram calls) so a later port can prove it changed nothing. Everything
// here therefore serves two goals: hermetic runs (temp dirs only, never the
// real ~/.config or the real Bot API) and stable comparisons (volatile fields
// — clocks, pids, temp paths — scrubbed before they reach a fixture).
//
// Not a *.test.mjs file on purpose: `node --test test/**/*.test.mjs` must not
// pick it up as a suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const SRC = path.join(ROOT, 'src');
export const SCRIPTS = path.join(ROOT, 'scripts');
export const FIXTURES = path.join(HERE, 'fixtures');
export const NODE = process.execPath;
export const UPDATE_FIXTURES = process.env.UPDATE_FIXTURES === '1';

// A deliberately small env: inheriting the developer's shell would let
// CLAIMS_DB / CLAUDE_HOMES / TG_* from the outside world decide what the code
// under test reads. Everything a case needs is passed in explicitly.
export function baseEnv(extra = {}) {
  return {
    PATH: `${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    ...extra,
  };
}

// realpath: on macOS os.tmpdir() is a symlink (/var → /private/var) and a
// child process may report either spelling. Resolving once up front keeps the
// temp-path scrubbing below exact.
export function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
}

export function rmDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------- exec ---

export function run(bin, args, { env = {}, cwd = ROOT, inheritPath = false } = {}) {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: inheritPath ? { ...process.env, ...env } : baseEnv(env),
  });
  if (r.error) throw r.error;
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

export const runSrc = (script, args, opts) => run(NODE, [path.join(SRC, script), ...args], opts);

// --------------------------------------------------------------- scrubbing ---

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;

// Keys whose value is a wall-clock instant (ISO string or epoch ms).
const TS_KEYS = new Set([
  'at', 'now', 'ts', 'since', 'claimed_at', 'released_at', 'leased_at', 'expires_at',
  'startedAt', 'finishedAt', 'date',
]);
// Keys whose value is a duration rendered from the clock.
const DUR_KEYS = new Set(['age', 'expires_in', 'durationMs', 'duration_ms']);

export function scrubText(s, subs = []) {
  let out = String(s);
  for (const [from, to] of subs) if (from) out = out.split(from).join(to);
  return out.replace(ISO_RE, '<ts>');
}

// Same idea for a parsed JSON value. Volatile fields become a marker instead of
// being dropped, so a fixture still pins that the field IS THERE and non-null.
export function scrubJson(value, subs = []) {
  if (typeof value === 'string') return scrubText(value, subs);
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, subs));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) out[k] = v;
      else if (TS_KEYS.has(k)) out[k] = '<ts>';
      else if (DUR_KEYS.has(k)) out[k] = '<dur>';
      else if (k === 'pid' && typeof v === 'number') out[k] = '<pid>';
      else if (k === 'db') out[k] = '<db>';
      else out[k] = scrubJson(v, subs);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- fixtures ---

// One pretty-printed JSON object + a newline is the shape claims.mjs and the
// JSON-emitting events.mjs subcommands print, so fixtures are stored the same
// way and compared as text: key ORDER is part of the contract too.
export function expectFixture(rel, actual) {
  const file = path.join(FIXTURES, rel);
  const text = typeof actual === 'string' ? actual : `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE_FIXTURES) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `missing fixture ${rel} — record it with UPDATE_FIXTURES=1`);
  assert.equal(text, fs.readFileSync(file, 'utf8'), `fixture mismatch: ${rel}`);
}

// A CLI that answers in JSON must put exactly ONE pretty-printed object on
// stdout and nothing else — no banner, no second document, no missing newline.
export function parseSingleJson(stdout) {
  assert.ok(stdout.endsWith('\n'), 'stdout must end with a newline');
  const body = stdout.slice(0, -1);
  assert.ok(body.startsWith('{'), 'stdout must start with a JSON object');
  const value = JSON.parse(body); // throws if it is not exactly one document
  assert.equal(`${JSON.stringify(value, null, 2)}`, body, 'stdout must be pretty-printed JSON, nothing else');
  return value;
}

// ------------------------------------------------------------------- wait ---

export async function waitFor(what, fn, { timeoutMs = 15_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const readIf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
