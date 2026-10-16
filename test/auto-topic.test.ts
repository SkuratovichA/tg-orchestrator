// node --test auto-topic.test.ts
//
// Every message dropped into the forum's General gets a topic of its own. What
// is pinned here is the part that decides WHICH messages (a private chat has no
// thread either, and must never sprout topics), what the provisional name looks
// like, and that retargeting keeps the original message_id — claims, events and
// voice transcription all key on it, and ids are chat-wide, so the id keeps
// working from the new topic while the copy is what gets replied to.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isGeneralForumMessage,
  provisionalTopicName,
  retargetToTopic,
  topicLink,
  TOPIC_NAME_MAX,
  type TopicNameTranslate,
} from '../src/auto-topic.ts';
import type { TgMessage } from '../src/runner.ts';

const CHAT = -1001234567890;
// The real catalogue is i18next; this is the shape the module asks for, spelled
// out so the test pins the placeholders rather than the English wording.
const t: TopicNameTranslate = (key, vars = {}) =>
  `${key}(${Object.entries(vars)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',')})`;

const msg = (extra: Partial<TgMessage> = {}): TgMessage =>
  ({
    message_id: 900,
    chat: { id: CHAT, type: 'supergroup', title: 'dev', is_forum: true },
    from: { id: 424242 },
    ...extra,
  }) as TgMessage;

test('General of a forum is the only place that gets an auto-topic', () => {
  assert.equal(isGeneralForumMessage(msg({ text: 'привет' })), true);
  assert.equal(
    isGeneralForumMessage(msg({ text: 'привет', message_thread_id: 426 })),
    false,
    'a message already in a topic stays where it is'
  );
  assert.equal(
    isGeneralForumMessage(msg({ chat: { id: 424242, type: 'private' } })),
    false,
    'a DM has no thread either — and no topics to create'
  );
  assert.equal(
    isGeneralForumMessage(msg({ chat: { id: CHAT, type: 'supergroup', title: 'dev' } })),
    false,
    'a plain supergroup cannot hold topics'
  );
  assert.equal(isGeneralForumMessage(msg({ chat: { id: -100123, type: 'group' } })), false);
});

test('the provisional name is one line of the message, cut on a word boundary', () => {
  assert.equal(provisionalTopicName(msg({ text: 'что там с давлением' }), t), '⏳ что там с давлением');
  assert.equal(
    provisionalTopicName(msg({ text: 'посмотри\nпожалуйста   что там\tс давлением' }), t),
    '⏳ посмотри пожалуйста что там с давлением',
    'newlines and runs of spaces collapse — a topic list is one line'
  );
  const long = provisionalTopicName(
    msg({ text: 'посмотри пожалуйста что там с давлением в правом заднем колесе' }),
    t
  );
  assert.equal(long, '⏳ посмотри пожалуйста что там с давлением…');
  assert.ok(!long.includes('дав…'), 'the cut lands between words, not inside one');
});

test('one word longer than the budget is cut mid-word rather than lost', () => {
  const name = provisionalTopicName(msg({ text: 'a'.repeat(60) }), t);
  assert.equal(name, `⏳ ${'a'.repeat(40)}…`);
});

test('the name never exceeds the 128 chars Telegram accepts', () => {
  const name = provisionalTopicName(
    msg({ document: { file_id: 'f', file_name: 'x'.repeat(400) } }),
    t
  );
  assert.equal(name.length, TOPIC_NAME_MAX);
  assert.ok(name.startsWith('⏳ autoTopic.file('), name);
});

test('a message with no text says what arrived instead', () => {
  assert.equal(provisionalTopicName(msg({ voice: { duration: 42 } }), t), '⏳ autoTopic.voice(seconds=42)');
  assert.equal(
    provisionalTopicName(msg({ video_note: { duration: 7 } }), t),
    '⏳ autoTopic.videoNote(seconds=7)'
  );
  assert.equal(provisionalTopicName(msg({ photo: [{ file_id: 'p' }] }), t), '⏳ autoTopic.photo()');
  assert.equal(
    provisionalTopicName(msg({ document: { file_id: 'd', file_name: 'plan.pdf' } }), t),
    '⏳ autoTopic.file(name=plan.pdf)'
  );
  assert.equal(
    provisionalTopicName(msg({ message_id: 771 }), t),
    '⏳ #771',
    'a sticker or a location has nothing to quote — the id is the only handle'
  );
  assert.equal(
    provisionalTopicName(msg({ caption: 'вот схема', photo: [{ file_id: 'p' }] }), t),
    '⏳ вот схема',
    'a caption is text'
  );
});

test('the pointer link is the chat id without its -100 prefix', () => {
  assert.equal(topicLink(CHAT, 1234), 'https://t.me/c/1234567890/1234');
  assert.equal(topicLink(-1001234567890, 7), 'https://t.me/c/1234567890/7');
});

test('retargeting keeps the original message_id and remembers the copy', () => {
  const original = msg({ text: 'привет', date: 1_780_000_000 });
  const moved = retargetToTopic(original, { threadId: 1234, copyMsgId: 901, name: '⏳ привет' });
  assert.equal(moved.message_thread_id, 1234);
  assert.equal(moved.message_id, 900, 'claims, events and transcription all key on this id');
  assert.equal(moved.text, 'привет');
  assert.equal(moved.date, 1_780_000_000);
  assert.deepEqual(moved.x_origin, { kind: 'general', copy_msg_id: 901, topic_name: '⏳ привет' });
  assert.equal(original.message_thread_id, undefined, 'the original is not mutated');
  assert.equal(original.x_origin, undefined);
});

test('a copy that failed leaves no id behind rather than a wrong one', () => {
  const moved = retargetToTopic(msg({ text: 'привет' }), {
    threadId: 1234,
    copyMsgId: undefined,
    name: '⏳ привет',
  });
  assert.deepEqual(moved.x_origin, { kind: 'general', topic_name: '⏳ привет' });
  assert.ok(moved.x_origin && !('copy_msg_id' in moved.x_origin));
});
