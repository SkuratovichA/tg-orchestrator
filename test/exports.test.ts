// node --test exports.test.ts
//
// The runner kit is published as subpath exports (17.09.2026): another runner
// imports `@tagents/plugin-telegram/scheduler` and friends. Resolve each one
// through the package's own name, so a renamed file or a dropped entry fails here
// and not in the consumer.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the runner kit resolves through the package exports', async () => {
  const scheduler = await import('@tagents/plugin-telegram/scheduler');
  const fallback = await import('@tagents/plugin-telegram/model-fallback');
  const spool = await import('@tagents/plugin-telegram/wake-spool');
  const homes = await import('@tagents/plugin-telegram/agent-home');
  const live = await import('@tagents/plugin-telegram/live-status');
  assert.equal(typeof scheduler.createScheduler, 'function');
  assert.equal(typeof fallback.ModelFallback, 'function');
  assert.equal(typeof fallback.isUsageLimitError, 'function');
  assert.equal(typeof spool.claimPending, 'function');
  assert.equal(typeof spool.clipWakeText, 'function');
  assert.equal(typeof homes.resolveAgent, 'function');
  assert.equal(homes.DEFAULT_AGENT, 'orchestrator');
  assert.equal(typeof live.createLiveStatus, 'function');
  assert.equal(typeof live.describeTool, 'function');
  assert.equal(typeof live.renderStatus, 'function');
});
