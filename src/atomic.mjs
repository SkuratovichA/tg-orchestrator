// Permanent shim: the implementation lives in atomic.ts, and every .mjs in
// src/ keeps importing './atomic.mjs' so the port is invisible to its callers.
export * from './atomic.ts';
