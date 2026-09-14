// node --test atomic.test.ts
//
// writeAtomic exists for ONE reason: a reader in another process (status.mjs,
// restart-when-idle.sh, the events CLI) must never see a half-written file. So
// what is pinned here is not "the bytes arrive" but "they arrive all at once".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { writeAtomic } from '../src/atomic.ts';

let dir: string;

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('writes a new file and overwrites an existing one', () => {
  const file = path.join(dir, 'state.json');
  writeAtomic(file, '{"offset":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"offset":1}');
  writeAtomic(file, '{"offset":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"offset":2}');
});

test('leaves no temp file behind, and leaves it in the target directory', () => {
  const file = path.join(dir, 'status.json');
  writeAtomic(file, 'x'.repeat(4096));
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes('.tmp')),
    [],
    'a leftover .tmp is a reader trap and a disk leak'
  );
  // Same directory: rename() is atomic only within one filesystem, so a temp
  // under os.tmpdir() would silently degrade to copy-then-truncate.
  assert.equal(fs.existsSync(path.join(dir, `${path.basename(file)}.${process.pid}.tmp`)), false);
});

test('a reader that already opened the file keeps seeing whole, old bytes', () => {
  const file = path.join(dir, 'inflight.json');
  writeAtomic(file, 'OLD-CONTENT');
  const fd = fs.openSync(file, 'r');
  try {
    writeAtomic(file, 'NEW');
    // Truncate-then-write would have shortened the inode under this fd; rename
    // swaps the directory entry instead and leaves it untouched.
    const buf = Buffer.alloc(32);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    assert.equal(buf.subarray(0, n).toString('utf8'), 'OLD-CONTENT');
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEW');
});

test('the parent directory has to exist — the caller owns the layout', () => {
  assert.throws(() => writeAtomic(path.join(dir, 'nope', 'state.json'), '{}'), {
    code: 'ENOENT',
  });
});
