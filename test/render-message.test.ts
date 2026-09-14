// node --test render-message.test.ts
//
// The header the agent reads before anything else. What is pinned here is the
// send time: a burst is answered as ONE turn and a turn can run for tens of
// minutes, so the "Now" at the top of the prompt says nothing about when any
// single message was actually sent. Before this the owner had to spell the
// timing out by hand. The EDITED marker is the same failure in a different
// coat — Telegram replaces the text silently, and the superseded figure got
// quoted back to him once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMessage, type TgMessage } from '../src/runner.ts';

const NOW = Date.parse('2026-09-12T14:00:00.000Z');
const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
// noUncheckedIndexedAccess is on: [0] of a split is string | undefined.
const headOf = (rendered: string): string => rendered.split('\n')[0] ?? '';
const base = (extra: Partial<TgMessage> = {}): TgMessage =>
  ({
    message_id: 786,
    chat: { id: -1001234567890, title: 'dev' },
    date: secs('2026-09-12T13:30:15.000Z'),
    text: 'привет',
    ...extra,
  }) as TgMessage;

test('header carries the send time and how long ago it was', () => {
  const head = headOf(renderMessage(base(), NOW));
  assert.match(head, /sent 2026-09-12T13:30:15Z \(29m ago\)/);
  assert.ok(head.startsWith('[msg 786 · chat_id=-1001234567890'), head);
  assert.ok(head.endsWith(']'), head);
});

test('the stamp reads Unix seconds, not milliseconds', () => {
  const head = headOf(renderMessage(base(), NOW));
  assert.ok(!head.includes('1970'), head);
  assert.match(head, /sent 2026-09-12T/);
});

test('an edited message is flagged, and the original send time survives', () => {
  const head = headOf(renderMessage(base({ edit_date: secs('2026-09-12T13:58:00.000Z') }), NOW));
  assert.match(head, /EDITED 2026-09-12T13:58:00Z \(2m ago\)/);
  assert.match(head, /sent 2026-09-12T13:30:15Z/);
});

test('no edit means no marker', () => {
  assert.ok(!renderMessage(base(), NOW).includes('EDITED'));
});

test('a message without a date still renders — nothing is dropped', () => {
  const head = headOf(renderMessage(base({ date: undefined }), NOW));
  assert.equal(head, '[msg 786 · chat_id=-1001234567890 · "dev"]');
});

test('a DM stays labelled DM, with the time after it', () => {
  const head = headOf(renderMessage(base({ chat: { id: 123456789 } }), NOW));
  assert.match(head, /· DM · sent 2026-09-12T13:30:15Z/);
});

test('thread, voice and reply lines are untouched', () => {
  const out = renderMessage(
    base({
      message_thread_id: 53,
      voice: { duration: 152 },
      reply_to_message: { message_id: 700, text: 'раньше' },
      text: undefined,
    }),
    NOW
  );
  assert.match(out, /topic_thread=53/);
  assert.match(out, /\[VOICE 152s/);
  assert.match(out, /\[reply to msg 700: раньше\]/);
});
