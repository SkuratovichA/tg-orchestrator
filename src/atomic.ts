// Atomic file replace, shared by everything in this repo that owns a file on
// disk (runner.mjs: state.json / status.json, events.mjs: `rebuild --write`).
//
// A reader in another process (status.mjs, restart-when-idle.sh, the events
// CLI) must see either the old file or the new one, never a truncated or
// half-written JSON. Write to a temp name in the SAME directory — rename() is
// atomic only within one filesystem — and move it into place.
import fs from 'node:fs';

export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
