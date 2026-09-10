#!/usr/bin/env node
// What was I working on, across every Claude project on this machine?
//
// Reads the session transcripts both Claude accounts keep on disk
// (~/.claude/projects/*/*.jsonl, plus ~/.claude-<name>/projects/ for every
// additional account or client-specific config dir) and
// answers the three questions Telegram actually asks:
//
//   sessions.mjs recent [N]          latest sessions, newest first (default 15)
//   sessions.mjs search <words…>     find sessions by opening prompt / project
//   sessions.mjs show <id-prefix>    one session: opening prompt + last replies
//
// Reading strategy matters: transcripts run to megabytes, so this never reads
// one whole. The opening human prompt lives in the first ~64 KB; the latest
// assistant text lives in the last ~48 KB. Head + tail covers both questions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every Claude config dir on this machine: ~/.claude and any ~/.claude-<name>.
// CLAUDE_HOMES=dir1,dir2 overrides the discovery.
function discoverAccounts() {
  const home = os.homedir();
  const dirs = process.env.CLAUDE_HOMES
    ? process.env.CLAUDE_HOMES.split(',').map((d) => d.trim()).filter(Boolean)
    : fs
        .readdirSync(home)
        .filter((d) => /^\.claude(-[\w.-]+)?$/.test(d))
        .map((d) => path.join(home, d));
  return dirs
    .map((dir) => ({
      name: path.basename(dir) === '.claude' ? 'personal' : path.basename(dir).replace(/^\.claude-/, ''),
      dir: path.join(dir, 'projects'),
    }))
    .filter((a) => fs.existsSync(a.dir));
}
const ACCOUNTS = discoverAccounts();
// The home directory as it appears in ~/.claude*/projects/ dir names.
const HOME_ENC = os.homedir().replace(/\//g, '-');

const slice = (file, from, len) => {
  const size = fs.statSync(file).size;
  const start = from === 'head' ? 0 : Math.max(0, size - len);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(len, size));
  const n = fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const s = buf.subarray(0, n).toString('utf8');
  return start ? s.slice(s.indexOf('\n') + 1) : s;
};

function firstPrompt(file) {
  for (const line of slice(file, 'head', 65536).split('\n')) {
    if (!line || line.indexOf('"user"') === -1) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'user' || d.isMeta) continue;
    const c = d.message?.content;
    if (typeof c === 'string' && c.trim() && !c.startsWith('<')) return c.trim();
  }
  return '';
}

function lastAssistantText(file) {
  let text = '';
  for (const line of slice(file, 'tail', 49152).split('\n')) {
    if (!line || line.indexOf('"assistant"') === -1) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'assistant') continue;
    const c = d.message?.content;
    if (Array.isArray(c))
      for (const b of c) if (b?.type === 'text' && b.text?.trim()) text = b.text.trim();
  }
  return text;
}

function collect() {
  const rows = [];
  for (const acct of ACCOUNTS) {
    let projects;
    try {
      projects = fs.readdirSync(acct.dir);
    } catch {
      continue;
    }
    for (const proj of projects) {
      const dir = path.join(acct.dir, proj);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, e.name);
        const st = fs.statSync(file);
        if (st.size < 2000) continue; // empty shells and aborted starts
        rows.push({
          id: e.name.slice(0, -6),
          account: acct.name,
          // Claude names a project dir after the absolute path with '/' → '-':
          // '<home encoded>-git-work-x' → '~/git/work/x'. Lossy (a '-' inside a
          // segment also becomes '/'), which is fine for a listing.
          project: proj.startsWith(HOME_ENC)
            ? '~' + proj.slice(HOME_ENC.length).replace(/-/g, '/')
            : proj.replace(/-/g, '/'),
          file,
          mtime: st.mtime,
          size: st.size,
        });
      }
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

const fmtWhen = (d) =>
  d.toISOString().slice(5, 16).replace('T', ' ') +
  (Date.now() - d.getTime() < 86400e3 ? ' (today/yday)' : '');

const oneLine = (s, n) => s.replace(/\s+/g, ' ').slice(0, n);

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'recent' || cmd === undefined) {
  const n = Number(args[0]) || 15;
  for (const r of collect().slice(0, n)) {
    console.log(`${r.id.slice(0, 8)}  ${fmtWhen(r.mtime).padEnd(18)} ${r.account.padEnd(8)} ${r.project}`);
    console.log(`          ${oneLine(firstPrompt(r.file) || '(no opening prompt)', 150)}`);
  }
  console.log('\nfull text of one: sessions.mjs show <id-prefix>');
} else if (cmd === 'search') {
  const q = args.join(' ').toLowerCase();
  if (!q) {
    console.error('usage: sessions.mjs search <words…>');
    process.exit(1);
  }
  const words = q.split(/\s+/);
  let hits = 0;
  for (const r of collect().slice(0, 400)) {
    const hay = (r.project + ' ' + firstPrompt(r.file)).toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    hits++;
    console.log(`${r.id.slice(0, 8)}  ${fmtWhen(r.mtime).padEnd(18)} ${r.account.padEnd(8)} ${r.project}`);
    console.log(`          ${oneLine(firstPrompt(r.file), 150)}`);
    if (hits >= 12) break;
  }
  if (!hits) console.log(`nothing matches "${q}" in the last 400 sessions' opening prompts`);
} else if (cmd === 'show') {
  const prefix = args[0];
  if (!prefix) {
    console.error('usage: sessions.mjs show <id-prefix>');
    process.exit(1);
  }
  const r = collect().find((x) => x.id.startsWith(prefix));
  if (!r) {
    console.error(`no session starts with "${prefix}"`);
    process.exit(1);
  }
  console.log(`session ${r.id}\naccount ${r.account} · project ${r.project} · last activity ${r.mtime.toISOString()}\n`);
  console.log('── opening prompt ──');
  console.log(oneLine(firstPrompt(r.file) || '(none)', 1500));
  console.log('\n── last assistant reply (tail) ──');
  console.log(oneLine(lastAssistantText(r.file) || '(none in tail window)', 1500));
} else {
  console.log('usage: sessions.mjs [recent [N] | search <words…> | show <id-prefix>]');
}
