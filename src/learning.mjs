#!/usr/bin/env node
// Permanent shim: the implementation lives in learning.ts, and this is still the
// file the world imports (`from './learning.mjs'`) AND runs (`node
// src/learning.mjs apply …`), so the port is invisible from the outside.
//
// The CLI cannot start from learning.ts: `import.meta.url` there is the .ts
// file's, never the path node was given on the command line. So the "am I the
// program?" question is answered HERE, where the two can actually be equal,
// and the answer is handed to learning.ts, which owns the exit codes.
export * from './learning.ts';

import { pathToFileURL } from 'node:url';
import { runCli } from './learning.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
