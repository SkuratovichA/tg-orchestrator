#!/usr/bin/env node
// Permanent shim: the implementation lives in claims.ts, and this is still the
// file the world imports (`from './claims.mjs'`) AND runs (`node
// src/claims.mjs claim …`), so the port is invisible from the outside.
//
// The CLI cannot start from claims.ts: `import.meta.url` there is the .ts
// file's, never the path node was given on the command line. So the "am I the
// program?" question is answered HERE, where the two can actually be equal,
// and the answer is handed to claims.ts, which owns the exit codes.
export * from './claims.ts';

import { pathToFileURL } from 'node:url';
import { runCli } from './claims.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
