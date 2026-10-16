#!/usr/bin/env node
// Permanent shim, the learning.mjs pattern: the implementation lives in
// split-plan.ts, and this is the file tg-send.sh runs (`node src/split-plan.mjs
// plan …`). `import.meta.url` in the .ts is never the path node was given, so
// the "am I the program?" question is answered here.
export * from './split-plan.ts';

import { pathToFileURL } from 'node:url';
import { runCli } from './split-plan.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
