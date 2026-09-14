#!/usr/bin/env node
// The entry point, and nothing else.
//
// `node src/runner.mjs` is a contract: ensure.sh runs it, launchd keeps ensure.sh
// alive, the pid file it leaves behind is what restart-when-idle.sh and the next
// ensure.sh read. So the path stays, and what moved is everything behind it —
// the daemon is now the `runner` service of the telegram plugin (src/plugin.ts),
// started by @tagents/core's host (src/runner.ts is the daemon itself).
//
// This file therefore does three things: load core, load the plugin, run the
// service. Every one of them can fail, and a failure here must be LOUD. A dead
// bot that exited 0 is the one outcome this whole repo is built to avoid: nobody
// would see it, ensure.sh would happily "start" it again five minutes later, and
// the owner would be writing into a topic nothing is reading. Hence exit 1 with
// one sentence, on stderr AND in runner.log — the two places somebody looks.
//
// The ONLY silent exit-0 refusal is the missing or unusable env file, and that
// one belongs to the daemon (src/runner.ts), not here: an unconfigured install
// is not a broken one, and launchd must not retry-loop on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Computed here, from nothing: this file has to be able to report that the
// imports failed, which means it must not depend on any of them.
const CFG_DIR = path.join(os.homedir(), '.config', 'tg-orchestrator');
const LOG_FILE = path.join(CFG_DIR, 'runner.log');

function die(reason) {
  const line = `tg-orchestrator: cannot start — ${reason}`;
  process.stderr.write(line + '\n');
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* stderr already carried it */
  }
  process.exit(1);
}

const reasonOf = (e) => (e instanceof Error ? e.message : String(e));

let core;
try {
  core = await import('@tagents/core');
} catch (e) {
  die(`@tagents/core is not usable (${reasonOf(e)}) — build it: pnpm -C ../../tagents/packages/core build`);
}

let plugin;
try {
  plugin = (await import('./plugin.ts')).default;
} catch (e) {
  die(`the telegram plugin failed to load (${reasonOf(e)})`);
}

try {
  // signals: true — SIGINT/SIGTERM reach the service as stop(<signal>), which is
  // the immediate exit the daemon has always done (a graceful stop is the drain
  // flag, not a signal).
  const ctx = core.createContext({
    plugin,
    log: (line) => {
      try {
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* the log is a convenience, never a gate */
      }
    },
  });
  const service = await core.runService(plugin, 'runner', ctx, { signals: true });
  await service.done;
} catch (e) {
  die(`the runner service did not start (${reasonOf(e)})`);
}
