#!/usr/bin/env node
// Permanent shim: the implementation lives in sessions.ts, and this is still
// the file every caller runs (`node src/sessions.mjs recent`), so the port is
// invisible from the outside.
export * from './sessions.ts';
