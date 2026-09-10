// turn.mjs — one headless Claude invocation and the bookkeeping around it:
// timeout + "taking longer than usual" warning, what counts as a finished
// turn, whether a failed turn may be re-run, and message dedup through the
// claims registry (claims.mjs). Pure library: no config, no network, nothing
// runs on import. runner.mjs wires it to Telegram; turn.test.mjs drives it
// with a fake `claude`.
import { spawn } from 'node:child_process';
import { annotateMessages, claimMessages, releaseMessages } from './claims.mjs';

export const DEFAULT_CLAUDE_TIMEOUT_MS = 50 * 60 * 1000;
// The owner hears about a long turn this much before it is killed.
export const TIMEOUT_WARN_BEFORE_MS = 5 * 60 * 1000;
// A turn whose `result` event has arrived is OVER. If the process is still
// around after this, something is stuck on the way out (an MCP server, a
// grandchild holding the pipe) — kill it and keep the result. On 10.09 two
// turns in a row finished their work, printed the result, then sat until the
// 30-minute killer came; the runner read the kill as a failure and re-ran the
// whole job, so the owner got every report twice.
export const RESULT_EXIT_GRACE_MS = 60 * 1000;
// After `exit`, how long to wait for the stdio pipes before giving up on them:
// a nohup'd grandchild can hold stdout open for hours, and `close` never fires.
const PIPE_DRAIN_MS = 5 * 1000;

export const CLAIM_OWNER = 'orchestrator';

export function parseTimeoutMs(raw, fallback = DEFAULT_CLAUDE_TIMEOUT_MS) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// stream-json output: one JSON object per line. The `result` event is exactly
// what `--output-format json` used to print; the events BEFORE it say how far
// the turn got, which is what decides whether a retry is safe.
export function parseStream(out) {
  const seen = { payload: null, sessionId: null, toolUses: 0, text: '' };
  for (const raw of String(out).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev.session_id === 'string') seen.sessionId = ev.session_id;
    if (ev.type === 'result') seen.payload = ev;
    else if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_use') seen.toolUses += 1;
        else if (c.type === 'text' && c.text) seen.text += c.text;
      }
    } else if (!ev.type && 'is_error' in ev) seen.payload = ev; // plain --output-format json
  }
  return seen;
}

const isResultLine = (line) => {
  if (!line.startsWith('{') || !line.includes('"type":"result"')) return false;
  try {
    return JSON.parse(line).type === 'result';
  } catch {
    return false;
  }
};

// Spawn `bin args` and resolve with an attempt:
//   { ok, payload, error?, sessionId, toolUses, text, timedOut,
//     killedAfterResult, code, signal, durationMs }
// ok means the turn COMPLETED: a `result` event with is_error=false arrived.
// The exit code is about the shutdown, not the work — a process killed after
// printing its result still succeeded (killedAfterResult=true).
export function runClaude({
  bin = 'claude',
  args,
  cwd,
  env,
  timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
  warnBeforeMs = TIMEOUT_WARN_BEFORE_MS,
  exitGraceMs = RESULT_EXIT_GRACE_MS,
  onWarn = null,
  log = () => {},
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let pending = '';
    let timedOut = false;
    let resultAt = null;
    let exit = null; // { code, signal } once the process is gone
    let spawnError = null;
    let done = false;
    const timers = [];
    const later = (fn, ms) => {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    };
    const kill = (why) => {
      log(why);
      try {
        child.kill('SIGKILL');
      } catch {}
    };

    const killer = later(() => {
      timedOut = true;
      kill(`claude timed out after ${Math.round(timeoutMs / 60000)} min — killing`);
    }, timeoutMs);
    if (onWarn && timeoutMs > warnBeforeMs)
      later(() => {
        if (resultAt || exit) return;
        log(`claude running ${Math.round((Date.now() - startedAt) / 60000)} min — warning the topic`);
        Promise.resolve(onWarn({ elapsedMs: Date.now() - startedAt, leftMs: warnBeforeMs })).catch((e) =>
          log('timeout warning failed:', e.message)
        );
      }, timeoutMs - warnBeforeMs);

    child.stdout.on('data', (d) => {
      const s = String(d);
      out += s;
      pending += s;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (resultAt || !isResultLine(line)) continue;
        // The work is done; from here on only the shutdown can go wrong.
        resultAt = Date.now();
        clearTimeout(killer);
        later(() => {
          if (!exit) kill(`claude printed its result but did not exit within ${exitGraceMs} ms — killing`);
        }, exitGraceMs);
      }
    });
    child.stderr.on('data', (d) => (err += d));

    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      const seen = parseStream(out);
      const p = seen.payload;
      const code = exit?.code ?? null;
      const signal = exit?.signal ?? null;
      const base = {
        payload: p ?? {},
        sessionId: p?.session_id ?? seen.sessionId ?? null,
        toolUses: seen.toolUses,
        text: seen.text,
        timedOut,
        killedAfterResult: Boolean(resultAt) && code !== 0,
        code,
        signal,
        durationMs: Date.now() - startedAt,
      };
      if (p && p.is_error === false) return resolve({ ok: true, ...base });
      const what = spawnError
        ? `spawn: ${spawnError}`
        : String(p?.result ?? err ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 300);
      resolve({
        ok: false,
        ...base,
        error: `exit=${code ?? signal ?? 'null'} ${timedOut ? `(timeout ${timeoutMs}ms, ${seen.toolUses} tool call(s)) ` : ''}${what}`,
      });
    };

    child.on('error', (e) => {
      spawnError = e.message;
      exit = { code: null, signal: null };
      finish();
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      later(finish, PIPE_DRAIN_MS); // in case `close` never comes
    });
    child.on('close', finish);
  });
}

// Whether a failed attempt may be re-run from scratch. Only a turn that never
// got going is safe to repeat: once the model has used a tool it may already
// have sent messages, and a turn that produced text or a result is not "not
// done" — running it again duplicates the work (10.09: a site recon done
// twice, two reports in the chat, by the runner's own retry).
export function retryDecision(attempt, resumeId) {
  if (attempt.ok) return { retry: false, reason: 'ok' };
  if (!resumeId) return { retry: false, reason: 'fresh session already — nothing to fall back to' };
  const did = [];
  if (attempt.toolUses > 0) did.push(`${attempt.toolUses} tool call(s)`);
  if (attempt.text) did.push('assistant text');
  if (attempt.payload?.result) did.push('a result');
  if (did.length)
    return {
      retry: false,
      reason: `retry-suppressed: turn already produced ${did.join(', ')}${attempt.timedOut ? ' before the timeout' : ''}`,
    };
  return {
    retry: true,
    reason: attempt.timedOut
      ? 'retry-fresh: timed out before doing anything'
      : 'retry-fresh: resume failed before doing anything',
  };
}

// One turn = one attempt, plus at most one fresh re-run when the first
// attempt died before doing anything. `run(resumeId)` performs an attempt.
export async function attemptTurn(run, resumeId, log = () => {}) {
  let attempt = await run(resumeId);
  if (attempt.ok) return { attempt, retried: false, decision: { retry: false, reason: 'ok' } };
  const decision = retryDecision(attempt, resumeId);
  log(`${decision.reason}: ${attempt.error}`);
  if (decision.retry) attempt = await run(null);
  return { attempt, retried: decision.retry, decision };
}

// ---------------------------------------------------------------- dedup ---

function byChat(msgs) {
  const m = new Map();
  for (const msg of msgs) {
    const id = msg.chat.id;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(msg);
  }
  return m;
}

const tag = (chatId, id) => `[${chatId}:${id}]`;

// Dedup at the door. Every owner message is claimed for CLAIM_OWNER before it
// goes anywhere; a message somebody already holds or has already answered is
// logged with the reason and dropped. Returns the messages this runner may
// process. With no registry (db=null) or a registry error the messages pass:
// dedup guards against duplicates, not against loss.
export function claimIncoming(db, msgs, { owner = CLAIM_OWNER, pid = process.pid, note = 'read', log = () => {} } = {}) {
  if (!db || !msgs.length) return msgs;
  const accepted = [];
  for (const [chatId, list] of byChat(msgs)) {
    const ids = list.map((m) => m.message_id);
    let r;
    try {
      r = claimMessages(db, { chatId, messageIds: ids, owner, pid, note });
    } catch (e) {
      log(`claim ERROR chat=${chatId}: ${e.message} — passing ${ids.length} msg(s) unchecked`);
      accepted.push(...list);
      continue;
    }
    const mine = new Map(r.acquired.map((a) => [a.message_id, a]));
    const busy = new Map(r.busy.map((b) => [b.message_id, b]));
    for (const m of list) {
      const id = m.message_id;
      const a = mine.get(id);
      if (a && !a.already_mine) {
        log(`claimed ${tag(chatId, id)}`);
        accepted.push(m);
      } else if (a && a.alive) {
        log(`already-claimed ${tag(chatId, id)}: in flight since ${a.since} (pid ${a.pid}) — not sent to the model again`);
      } else if (a) {
        // Our own earlier incarnation died holding it: take it over.
        let took = false;
        try {
          releaseMessages(db, { chatId, messageIds: [id], owner, status: 'dropped', note: `orphaned by pid ${a.pid}` });
          took = claimMessages(db, { chatId, messageIds: [id], owner, pid, note }).ok;
        } catch (e) {
          log(`claim ERROR ${tag(chatId, id)}: ${e.message}`);
        }
        log(`reclaimed ${tag(chatId, id)}: previous holder pid ${a.pid} is dead${took ? '' : ' (re-claim refused, passing anyway)'}`);
        accepted.push(m);
      } else {
        const b = busy.get(id);
        if (b?.status === 'done')
          log(`already-handled ${tag(chatId, id)}: answered by ${b.owner} ${b.age} ago — dropped`);
        else if (b)
          log(`busy ${tag(chatId, id)}: held by ${b.owner} (pid ${b.pid ?? '?'}, ${b.alive ? 'alive' : 'dead'}) since ${b.since} — dropped`);
        else log(`claim ${tag(chatId, id)}: no verdict from the registry — dropped`);
      }
    }
  }
  return accepted;
}

// Progress note on messages we hold ("read" -> "in-turn"). Best-effort.
export function annotateIncoming(db, msgs, { owner = CLAIM_OWNER, note, log = () => {} } = {}) {
  if (!db || !msgs.length) return;
  for (const [chatId, list] of byChat(msgs)) {
    try {
      annotateMessages(db, { chatId, messageIds: list.map((m) => m.message_id), owner, note });
    } catch (e) {
      log(`annotate ERROR chat=${chatId}: ${e.message}`);
    }
  }
}

// The messages are handled: mark them done (or dropped) with what happened.
export function settleIncoming(db, msgs, { owner = CLAIM_OWNER, status = 'done', note = null, log = () => {} } = {}) {
  if (!db || !msgs.length) return;
  for (const [chatId, list] of byChat(msgs)) {
    const ids = list.map((m) => m.message_id);
    try {
      const r = releaseMessages(db, { chatId, messageIds: ids, owner, status, note });
      const refused = r.refused.map((x) => `${x.message_id} ${x.reason}`).join('; ');
      log(`${status} [${chatId}:${ids.join(',')}]${note ? ` ${note}` : ''}${refused ? ` (refused: ${refused})` : ''}`);
    } catch (e) {
      log(`release ERROR chat=${chatId}: ${e.message}`);
    }
  }
}
