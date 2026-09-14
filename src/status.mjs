#!/usr/bin/env node
// tg-orchestrator status: what the daemon is doing right now, what a running
// claude call is chewing on, usage roll-ups from the ledger, recent events.
//
//   node status.mjs            one-shot snapshot
//   node status.mjs --watch    re-render every 3s (Ctrl-C to quit)
//   node status.mjs --json     machine-readable snapshot
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_API_BASE_URL, parseEnvFile, resolveLocale } from './config.ts';
import { getI18n, t } from './i18n/index.ts';

const CFG_DIR = path.join(os.homedir(), '.config', 'tg-orchestrator');
const ENV_FILE = path.join(CFG_DIR, 'env');
const STATE_FILE = path.join(CFG_DIR, 'state.json');
const STATUS_FILE = path.join(CFG_DIR, 'status.json');
const PID_FILE = path.join(CFG_DIR, 'runner.pid');
const LEDGER = path.join(CFG_DIR, 'usage.jsonl');
const LOG_FILE = path.join(CFG_DIR, 'runner.log');
// claude -p runs with cwd=$HOME, so its transcripts live under the home
// "project" dir (path munged the way claude code does: / and . become -).
const TRANSCRIPTS = path.join(
  os.homedir(),
  '.claude',
  'projects',
  os.homedir().replace(/[/.]/g, '-')
);

// Same file, same variable, same precedence as the daemon: a status screen in
// a different language from the topic it describes would be its own bug.
getI18n(resolveLocale({ envFile: ENV_FILE }));

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('duration.seconds', { s });
  const m = Math.floor(s / 60);
  return m < 60
    ? t('duration.minutes', { m, s: String(s % 60).padStart(2, '0') })
    : t('duration.hours', { h: Math.floor(m / 60), m: m % 60 });
};
const fmtLocal = (iso) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const ago = (iso) => fmtDur(Date.now() - new Date(iso).getTime());

// --- daemon -----------------------------------------------------------------
function daemonInfo() {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').toString().trim() || 0);
  if (!pid || !alive(pid)) return { up: false };
  let etime = '';
  try {
    etime = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)]).toString().trim();
  } catch {}
  return { up: true, pid, etime };
}

// --- current claude call ------------------------------------------------------
// Any `claude -p` whose system prompt file lives in this repo is ours — child
// of the runner normally, orphan after a runner restart.
function claudeCalls() {
  let out = '';
  try {
    out = execFileSync('ps', ['-axww', '-o', 'pid=,etime=,%cpu=,command=']).toString();
  } catch {
    return [];
  }
  // Our claude children carry `--append-system-prompt-file <repo>/agent.md`,
  // so the repo root (not src/) is what identifies them in ps output.
  // TG_ORCHESTRATOR_ROOT overrides the root to match — the contract oracle
  // sets it to a per-test path so the production daemon's live calls never
  // show up in a test snapshot; nothing else sets it.
  const root =
    process.env.TG_ORCHESTRATOR_ROOT ??
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return out
    .split('\n')
    .filter((l) => l.includes('claude -p') && l.includes(root))
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) return null;
      const resume = m[4].match(/--resume\s+(\S+)/);
      return { pid: Number(m[1]), etime: m[2], cpu: m[3], resume: resume?.[1] ?? null };
    })
    .filter(Boolean);
}

// Peek into the live transcript: the last thing the agent actually did.
function transcriptPeek(sessionId) {
  let file = sessionId && path.join(TRANSCRIPTS, `${sessionId}.jsonl`);
  if (!file || !fs.existsSync(file)) {
    // fresh session: newest transcript touched in the last 5 minutes
    try {
      const cands = fs
        .readdirSync(TRANSCRIPTS)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: fs.statSync(path.join(TRANSCRIPTS, f)).mtimeMs }))
        .filter((x) => Date.now() - x.m < 5 * 60 * 1000)
        .sort((a, b) => b.m - a.m);
      if (!cands.length) return null;
      file = path.join(TRANSCRIPTS, cands[0].f);
    } catch {
      return null;
    }
  }
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.type !== 'assistant') continue;
      for (const c of (e.message?.content ?? []).slice().reverse()) {
        if (c.type === 'tool_use')
          return `→ ${c.name}(${JSON.stringify(c.input ?? {}).slice(0, 90)}…)`;
        if (c.type === 'text' && c.text?.trim())
          return `💬 ${c.text.trim().replace(/\s+/g, ' ').slice(0, 110)}`;
      }
    }
  } catch {}
  return null;
}

// --- telegram-side queue ------------------------------------------------------
async function pendingUpdates() {
  try {
    // The env file is parsed with the daemon's own grammar (config.ts), so the
    // two tools can never disagree about what a line in it means.
    const env = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
    // Bot API root, resolved exactly the way runner.mjs resolves it: the
    // process environment first, the env file second, the real API last. The
    // override exists so the contract tests can point this call at a local
    // fake instead of api.telegram.org — nothing else reads it.
    const base = process.env.TG_API_BASE_URL ?? env.TG_API_BASE_URL ?? DEFAULT_API_BASE_URL;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, {
      signal: ctl.signal,
    }).finally(() => clearTimeout(t));
    return (await res.json()).result?.pending_update_count ?? null;
  } catch {
    return null;
  }
}

// --- usage ----------------------------------------------------------------
function usage() {
  let rows = [];
  try {
    rows = fs
      .readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {}
  const roll = (from) => {
    const r = rows.filter((x) => new Date(x.ts).getTime() >= from);
    return {
      calls: r.length,
      fails: r.filter((x) => !x.ok).length,
      cost: r.reduce((s, x) => s + (x.costUSD ?? 0), 0),
      avgMs: r.length ? r.reduce((s, x) => s + (x.durationMs ?? 0), 0) / r.length : 0,
      maxMs: r.reduce((s, x) => Math.max(s, x.durationMs ?? 0), 0),
    };
  };
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return {
    today: roll(midnight.getTime()),
    week: roll(Date.now() - 7 * 24 * 3600 * 1000),
    last: rows.slice(-4).reverse(),
  };
}

// --- log tail ---------------------------------------------------------------
function logTail(n = 6) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-40);
    const out = [];
    for (const l of lines) if (out.at(-1) !== l) out.push(l); // legacy double-writes
    return out.slice(-n).map((l) => {
      const m = l.match(/^(\S+)\s(.*)$/);
      return m ? `${fmtLocal(m[1])} ${m[2].slice(0, 150)}` : l.slice(0, 160);
    });
  } catch {
    return [];
  }
}

// --- render -----------------------------------------------------------------
async function snapshot() {
  const daemon = daemonInfo();
  const status = readJson(STATUS_FILE);
  const state = readJson(STATE_FILE) ?? { sessions: {} };
  const calls = claudeCalls();
  return {
    daemon,
    status,
    calls,
    pending: await pendingUpdates(),
    sessions: state.sessions ?? {},
    usage: usage(),
    log: logTail(),
  };
}

function render(s) {
  const L = [];
  const now = new Date().toLocaleTimeString('ru-RU');
  L.push(`tg-orchestrator · ${now}`);
  L.push('');
  L.push(
    s.daemon.up
      ? t('statusCli.daemonUp', { pid: s.daemon.pid, etime: s.daemon.etime })
      : t('statusCli.daemonDown')
  );
  if (s.status) {
    const ph = s.status.phase;
    const turns = s.status.turns ?? [];
    const queued = s.status.queued ? t('statusCli.queued', { queued: s.status.queued }) : '';
    const desc =
      ph === 'idle'
        ? t('statusCli.phaseIdle', { at: fmtLocal(s.status.at) })
        : ph === 'burst'
          ? t('statusCli.phaseBurst', {
              msgs: s.status.msgs,
              age: ago(s.status.since ?? s.status.at),
            })
          : ph === 'draining'
            ? t('statusCli.phaseDraining', { turns: turns.length, queued })
            : ph === 'claude'
            ? turns.length > 1
              ? t('statusCli.phaseClaudeParallel', { turns: turns.length, queued })
              : t('statusCli.phaseClaudeOne', {
                  convo: s.status.convo,
                  msgs: s.status.msgs,
                  age: ago(s.status.at),
                  queued,
                })
            : t('statusCli.phaseOther', { phase: ph, at: fmtLocal(s.status.at) });
    const stale = s.daemon.up && s.status.pid !== s.daemon.pid ? t('statusCli.stalePid') : '';
    L.push(t('statusCli.phaseLine', { desc, stale }));
    if (turns.length > 1 || ph === 'draining')
      for (const turn of turns)
        L.push(
          t('statusCli.turnLine', {
            key: turn.key,
            what:
              turn.kind === 'wake'
                ? t('statusCli.turnWake')
                : t('statusCli.turnMsgs', { size: turn.size }),
            age: ago(turn.since),
          })
        );
    if (ph === 'claude' && s.status.burst)
      L.push(
        t('statusCli.burstAlso', {
          msgs: s.status.burst.msgs,
          age: ago(s.status.burst.since),
        })
      );
  }
  for (const c of s.calls) {
    L.push(t('statusCli.callLine', { pid: c.pid, etime: c.etime, cpu: c.cpu }));
    const peek = transcriptPeek(c.resume);
    if (peek) L.push(`          ${peek}`);
  }
  if (s.status?.phase === 'claude' && !s.calls.length) L.push(t('statusCli.callMissing'));
  L.push(
    t('statusCli.pendingLine', {
      pending: s.pending ?? '—',
      waiting: s.pending ? t('statusCli.pendingWaiting') : '',
    })
  );
  const sess = Object.entries(s.sessions).sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0));
  if (sess.length) {
    const [k, v] = sess[0];
    L.push(
      t('statusCli.sessionsLine', {
        topics: sess.length,
        key: k,
        age: fmtDur(Date.now() - v.last),
      })
    );
  }
  L.push('');
  const u = (r) =>
    t('statusCli.usageRoll', {
      calls: r.calls,
      cost: r.cost.toFixed(2),
      avg: fmtDur(r.avgMs),
      max: fmtDur(r.maxMs),
      fails: r.fails ? t('statusCli.usageFails', { fails: r.fails }) : '',
    });
  L.push(t('statusCli.usageToday', { roll: u(s.usage.today) }));
  L.push(t('statusCli.usageWeek', { roll: u(s.usage.week) }));
  for (const r of s.usage.last)
    L.push(
      `          ${fmtLocal(r.ts)} ${r.ok ? 'ok ' : 'FAIL'} $${(r.costUSD ?? 0).toFixed(2)} ${fmtDur(r.durationMs ?? 0).padStart(6)} ${r.convo}`
    );
  L.push('');
  L.push(t('statusCli.logHeading'));
  for (const l of s.log) L.push(`          ${l}`);
  return L.join('\n');
}

const args = new Set(process.argv.slice(2));
if (args.has('--json')) {
  console.log(JSON.stringify(await snapshot(), null, 2));
} else if (args.has('--watch')) {
  for (;;) {
    const s = await snapshot();
    console.clear();
    console.log(render(s));
    await new Promise((r) => setTimeout(r, 3000));
  }
} else {
  console.log(render(await snapshot()));
}
