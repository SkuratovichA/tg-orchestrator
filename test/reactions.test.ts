// node --test reactions.test.ts
//
// A reaction is the new flush word: the owner taps an emoji on something he has
// just sent and the burst window closes, without a «го» landing in the prompt.
// What is pinned here is what must NOT count — removing a reaction, reacting to
// a message the window is not holding, somebody else reacting — because each of
// those would cut a series short and answer half a thought.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedEmoji, isFlushReaction, matchFlushReaction } from '../src/reactions.ts';
import type { TgMessage } from '../src/runner.ts';
import type { TgReaction } from '../src/reactions.ts';

const CHAT = -1001234567890;
const OWNER = 424242;

const msg = (message_id: number, extra: Partial<TgMessage> = {}): TgMessage =>
  ({
    message_id,
    chat: { id: CHAT, type: 'supergroup', title: 'dev', is_forum: true },
    from: { id: OWNER },
    text: 'привет',
    ...extra,
  }) as TgMessage;

const reaction = (extra: Partial<TgReaction> = {}): TgReaction =>
  ({
    chat: { id: CHAT, type: 'supergroup' },
    message_id: 900,
    user: { id: OWNER },
    old_reaction: [],
    new_reaction: [{ type: 'emoji', emoji: '👀' }],
    ...extra,
  }) as TgReaction;

const buffered = [msg(900), msg(901)];

test('an emoji added to a buffered message closes the window', () => {
  assert.equal(isFlushReaction(reaction(), buffered), true);
  assert.equal(matchFlushReaction(reaction(), buffered)?.message_id, 900);
  assert.equal(
    isFlushReaction(reaction({ message_id: 901 }), buffered),
    true,
    'any message still in the window, not only the first'
  );
});

test('a General original still matches after the runner retargeted it', () => {
  // retargetToTopic keeps the message_id, which is what makes this work: the
  // reaction the owner puts on the message he sees in General finds the copy of
  // it the window is holding.
  const moved = [{ ...msg(900), message_thread_id: 1234 }];
  assert.equal(isFlushReaction(reaction(), moved), true);
});

test('removing a reaction is not a flush', () => {
  const removed = reaction({ old_reaction: [{ type: 'emoji', emoji: '👀' }], new_reaction: [] });
  assert.equal(isFlushReaction(removed, buffered), false);
  const swapped = reaction({
    old_reaction: [{ type: 'emoji', emoji: '👀' }],
    new_reaction: [{ type: 'emoji', emoji: '🔥' }],
  });
  assert.equal(isFlushReaction(swapped, buffered), false, 'same count: nothing was added');
});

test('a reaction on anything the window is not holding means nothing', () => {
  assert.equal(isFlushReaction(reaction({ message_id: 42 }), buffered), false);
  assert.equal(
    isFlushReaction(reaction({ chat: { id: -100999, type: 'supergroup' } }), buffered),
    false,
    'ids are per chat — the same number elsewhere is another message'
  );
  assert.equal(isFlushReaction(reaction(), []), false);
});

test('somebody else reacting to the owner is not the owner saying "read it"', () => {
  assert.equal(isFlushReaction(reaction({ user: { id: 99 } }), buffered), false);
  assert.equal(
    isFlushReaction(reaction({ user: undefined }), buffered),
    true,
    'an anonymous reaction in a channel-style chat is taken as given: pollOnce already filtered on the owner'
  );
});

test('the added emoji is what goes into the event log', () => {
  assert.equal(addedEmoji(reaction()), '👀');
  assert.equal(addedEmoji(reaction({ new_reaction: [{ type: 'custom_emoji' }] })), null);
  assert.equal(addedEmoji(reaction({ new_reaction: [] })), null);
});
