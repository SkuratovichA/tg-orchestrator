#!/usr/bin/env node
// Permanent shim: the implementation lives in events.ts, and this is still the
// file the world imports (runner.mjs) AND runs (`node src/events.mjs append …`
// from scripts/wake.sh), so the port is invisible from the outside.
//
// As in claims.mjs, the "am I the program?" question can only be answered here:
// import.meta.url inside events.ts is never the path node was handed.
export * from './events.ts';

import { pathToFileURL } from 'node:url';
import { runCli } from './events.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
