// Permanent shim: the implementation lives in scheduler.ts, and every .mjs in
// src/ keeps importing './scheduler.mjs' so the port is invisible to its callers.
export * from './scheduler.ts';
