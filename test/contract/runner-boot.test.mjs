// runner-boot.test.mjs — the entry point's failure modes.
//
// src/runner.mjs is a contract: ensure.sh runs it, launchd keeps ensure.sh
// alive, and since S5 what it boots is the telegram plugin's `runner` service
// through @tagents/core. Two new things can therefore fail before the daemon
// exists at all — core, and the plugin — and both of them must be LOUD.
//
// A dead bot that exited 0 is the outcome this repo is built to avoid: nobody
// sees it, ensure.sh "starts" it again five minutes later, and the owner writes
// into a topic nothing is reading. So: exit 1, one sentence on stderr AND in
// runner.log. The only silent exit-0 refusal stays the missing/unusable env
// file, which belongs to the daemon and is pinned by runner-e2e cases (a)/(a2).
//
// Hermetic: a temp copy of src/ with its own node_modules, where @tagents/core
// is pointed at an empty directory (the shape of "the package is there, its
// dist is not" and of a link into a checkout nobody built). HOME is a temp dir
// with a VALID env file, so an exit 0 here could only mean the failure was
// swallowed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { NODE, ROOT, readIf, rmDir, run, SRC, tmpDir } from './helpers.mjs';

const TOKEN = '123456:TEST-TOKEN';
const OWNER_ID = 424242;
const REAL_MODULES = path.join(ROOT, 'node_modules');

let tmp;

before(() => {
  tmp = tmpDir('runner-boot');
});
after(() => rmDir(tmp));

/**
 * A standalone copy of src/ with its own dependency tree: every real dependency
 * is symlinked, and @tagents/core is whatever `core` says — a link to the real
 * package, or an empty directory standing in for one that was never built.
 */
function install(name, { core }) {
  const dir = path.join(tmp, name);
  const home = path.join(dir, 'home');
  const cfg = path.join(home, '.config', 'tg-orchestrator');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\nOWNER_ID=${OWNER_ID}\n`);
  fs.cpSync(SRC, path.join(dir, 'src'), { recursive: true });

  const modules = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(modules, '@tagents'), { recursive: true });
  for (const entry of fs.readdirSync(REAL_MODULES)) {
    if (entry === '@tagents' || entry.startsWith('.')) continue;
    fs.symlinkSync(path.join(REAL_MODULES, entry), path.join(modules, entry));
  }
  const target = path.join(modules, '@tagents', 'core');
  if (core === 'missing') fs.mkdirSync(target); // present, and unusable
  else fs.symlinkSync(fs.realpathSync(path.join(REAL_MODULES, '@tagents', 'core')), target);

  return {
    dir,
    home,
    entry: path.join(dir, 'src', 'runner.mjs'),
    log: () => readIf(path.join(cfg, 'runner.log')),
  };
}

const boot = (inst) =>
  run(NODE, [inst.entry], {
    cwd: inst.dir,
    env: {
      HOME: inst.home,
      // Nothing of the real installation may decide anything here.
      CLAIMS_DB: path.join(inst.home, 'claims.sqlite'),
      TG_EVENTS_DB: path.join(inst.home, 'events.sqlite'),
      TG_API_BASE_URL: 'http://127.0.0.1:1',
    },
  });

test('core that cannot be loaded is exit 1, on stderr and in runner.log', () => {
  const inst = install('no-core', { core: 'missing' });
  const r = boot(inst);
  assert.notEqual(r.code, 0, 'a bot that cannot start must never exit 0');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  const line = r.stderr.trim();
  assert.match(line, /^tg-orchestrator: cannot start — @tagents\/core is not usable \(/);
  assert.match(line, /build it: pnpm -C \.\.\/\.\.\/tagents\/packages\/core build$/);
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, 'one sentence, not a stack trace');
  // ...and the same sentence where an operator looks next.
  assert.ok(inst.log().includes(line), `runner.log must carry the reason, got: ${inst.log()}`);
  // The daemon never got far enough to take the pid.
  assert.equal(fs.existsSync(path.join(inst.home, '.config', 'tg-orchestrator', 'runner.pid')), false);
});

test('a plugin that cannot be loaded is exit 1 with its own reason', () => {
  const inst = install('bad-plugin', { core: 'real' });
  fs.writeFileSync(path.join(inst.dir, 'src', 'plugin.ts'), "import './nothing-here.ts';\n");
  const r = boot(inst);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  const line = r.stderr.trim();
  assert.match(line, /^tg-orchestrator: cannot start — the telegram plugin failed to load \(/);
  assert.ok(inst.log().includes(line));
});

test('a plugin without the runner service is exit 1, not a silently idle process', () => {
  const inst = install('no-service', { core: 'real' });
  fs.writeFileSync(
    path.join(inst.dir, 'src', 'plugin.ts'),
    "export default { name: 'telegram', apiVersion: 1, services: [] };\n"
  );
  const r = boot(inst);
  assert.equal(r.code, 1);
  assert.match(r.stderr.trim(), /^tg-orchestrator: cannot start — the runner service did not start \(/);
  assert.match(r.stderr, /has no service "runner"/);
});
