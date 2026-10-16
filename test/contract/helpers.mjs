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
import http from 'node:http';
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

// --------------------------------------------------------- fake Telegram ---
// The Bot API the daemon long-polls, as a node:http server on 127.0.0.1 — it
// is reached through the TG_API_BASE_URL seam, whose default is the real URL.
// Shared, because more than one suite needs a daemon that can receive a message
// and be caught sending one: runner-e2e drives it from a spawned runner.mjs,
// runner-driver from an in-process startRunner.
//
// `longpollMs` is how long a getUpdates call is held when the queue is empty:
// short, because nothing in the contract depends on the server honouring the
// timeout the caller asks for — only on it answering.
export function startFakeTelegram({ token, longpollMs = 150 }) {
  // deleted: deleteMessage bodies; documents: sendDocument's file name and fields
  // (multipart). failNext: method -> how many upcoming calls answer ok:false.
  // rawControlCharsInEcho: emit the sendMessage response with U+0000–U+001F
  // unescaped, the way the Bot API does when the sent text carried them.
  const state = {
    queue: [], sent: [], deleted: [], documents: [], getMe: 0, methods: [],
    nextId: 9000, failNext: {}, rawControlCharsInEcho: false,
  };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref();
    timers.add(t);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const sendRaw = (text) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(text);
        } catch {
          /* the runner aborted this request (shutdown) */
        }
      };
      const send = (obj) => sendRaw(JSON.stringify(obj));
      const m = /^\/bot(.+?)\/(\w+)$/.exec(req.url ?? '');
      if (!m || m[1] !== token) return send({ ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2];
      let body = {};
      const raw = Buffer.concat(chunks);
      if (String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
        // Parsed by the same WHATWG FormData the runner builds it with.
        const form = await new Request('http://fake/', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] },
          body: raw,
        }).formData();
        for (const [k, v] of form) body[k] = typeof v === 'string' ? v : { name: v.name, content: await v.text() };
      } else if (String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
        // What curl posts. scripts/tg-send.sh sends the text with
        // --data-urlencode, so without this branch the fake sees an empty body
        // and can never echo back a reply_to_message.
        for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) body[k] = v;
      } else {
        try {
          body = chunks.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          /* keep {} */
        }
      }
      state.methods.push(method);
      if (state.failNext[method] > 0) {
        state.failNext[method]--;
        return send({ ok: false, error_code: 500, description: `injected ${method} failure` });
      }
      if (method === 'getMe') {
        state.getMe++;
        return send({ ok: true, result: { id: 7, is_bot: true, first_name: 'Test', username: 'testbot' } });
      }
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        const deadline = Date.now() + longpollMs;
        const tick = () => {
          const got = state.queue.filter((u) => u.update_id >= offset);
          if (got.length || Date.now() >= deadline) return send({ ok: true, result: got });
          later(tick, 15);
        };
        return tick();
      }
      if (method === 'sendMessage') {
        state.sent.push(body);
        const result = { message_id: state.nextId++, date: 1, chat: { id: body.chat_id }, text: body.text };
        // Real Telegram echoes the answered message back inside the response.
        // Without it the fixture holds exactly one message_id and cannot tell a
        // correct extraction apart from a greedy one that takes the LAST match —
        // which is the reply TARGET, and in a forum group that id belongs to
        // another topic.
        if (body.reply_to_message_id !== undefined) {
          result.reply_to_message = {
            message_id: Number(body.reply_to_message_id),
            date: 1,
            chat: { id: body.chat_id },
            text: 'the message being answered',
          };
        }
        // JSON.stringify escapes U+0000–U+001F; Telegram does not always, and
        // those raw bytes are what makes a strict JSON parser reject the body.
        if (state.rawControlCharsInEcho) {
          return sendRaw(
            JSON.stringify({ ok: true, result }).replace(/\\u00([0-1][0-9a-f])/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16)),
            ),
          );
        }
        return send({ ok: true, result });
      }
      if (method === 'deleteMessage') {
        state.deleted.push(body);
        return send({ ok: true, result: true });
      }
      if (method === 'sendDocument') {
        const { document, ...fields } = body;
        state.documents.push({ fileName: document?.name, content: document?.content, ...fields });
        return send({ ok: true, result: { message_id: state.nextId++, date: 1, chat: { id: Number(body.chat_id) } } });
      }
      return send({ ok: false, error_code: 404, description: `unsupported method ${method}` });
    });
  });
  server.unref();

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        base: `http://127.0.0.1:${port}`,
        push(message) {
          const update_id = 1000 + state.queue.length;
          // Real Telegram stamps the send time in Unix seconds and the prompt now
          // renders it; a fixed `date: 1` would print 1970 and a 56-year age.
          state.queue.push({ update_id, message: { date: Math.floor(Date.now() / 1000), ...message } });
          return update_id;
        },
        // Any other update kind, e.g. { message_reaction: {...} }.
        pushUpdate(update) {
          const update_id = 1000 + state.queue.length;
          state.queue.push({ update_id, ...update });
          return update_id;
        },
        async stop() {
          for (const t of timers) clearTimeout(t);
          timers.clear();
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}
