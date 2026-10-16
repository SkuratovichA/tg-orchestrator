// Every message the owner drops into the forum's General gets a topic of its
// own, immediately.
//
// Why: General is a single conversation key (`chat:0`), so two unrelated
// questions typed there share one session, one queue and one transcript — and
// the answer to the second arrives under the first. Topics are what this whole
// daemon is organised around, and the owner should not have to create one by
// hand before he can ask something. So the runner creates it for him: a topic
// with a provisional `⏳ …` name taken from the message itself, the message
// copied into it, a pointer left behind in General, and the model told (in the
// message header, see renderMessage) to rename the topic once it knows what the
// subject actually is.
//
// The name is provisional on purpose. Forty characters of the first message are
// enough to find the topic in the list five minutes later; they are NOT a title.
// The ⏳ is the marker the model looks for — a topic still carrying it has never
// been named by anyone.
//
// Pure: no I/O, no Bot API, no globals — the runner does the calls, this module
// decides what to call them with. See test/auto-topic.test.ts.
import type { TranslationKey, TranslationVars } from './i18n/index.ts';
import type { TgMessage } from './runner.ts';

/** The t() this module needs: owner-facing placeholders for a media message. */
export type TopicNameTranslate = (key: TranslationKey, vars?: TranslationVars) => string;

/** Telegram's own limit on a forum topic's name. Longer is an API error. */
export const TOPIC_NAME_MAX = 128;
/** The marker that says "nobody has named this topic yet". */
export const PROVISIONAL_PREFIX = '⏳ ';
/** How much of the message goes into the name. A handle, not a title. */
export const NAME_BUDGET = 40;

/**
 * A message in the General section of a forum supergroup — the one place where
 * `message_thread_id` is absent because there is no topic, not because the chat
 * has none. A private chat has no thread either and must never get a topic:
 * `is_forum` is what tells the two apart.
 */
export function isGeneralForumMessage(m: TgMessage): boolean {
  return m.chat.type === 'supergroup' && m.chat.is_forum === true && m.message_thread_id === undefined;
}

// Cut on a word boundary when there is one near the end, otherwise mid-word:
// «сходи посмотри что там с пресс…» reads, «сходи посмотри что там с прес» plus
// a hard stop reads like a truncated file name.
function cut(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const lastSpace = head.lastIndexOf(' ');
  const body = lastSpace > budget / 2 ? head.slice(0, lastSpace) : head;
  return `${body.replace(/[\s.,;:!?-]+$/, '')}…`;
}

// No text at all (a voice note, a photo, a file) — the name says what arrived,
// in the owner's language. Anything else — a sticker, a location, a contact —
// falls back to the message id: it is the only handle such a message has, and
// an id is not a sentence to translate.
function describeMedia(m: TgMessage, t: TopicNameTranslate): string {
  if (m.voice) return t('autoTopic.voice', { seconds: m.voice.duration });
  if (m.video_note) return t('autoTopic.videoNote', { seconds: m.video_note.duration });
  if (m.photo) return t('autoTopic.photo');
  if (m.document) return t('autoTopic.file', { name: m.document.file_name ?? '' });
  return `#${m.message_id}`;
}

/** The `⏳ …` name a freshly created topic gets, within Telegram's 128 chars. */
export function provisionalTopicName(m: TgMessage, t: TopicNameTranslate): string {
  // Newlines are legal in a message and illegal-looking in a topic list, so the
  // whole thing collapses to one line before anything is measured.
  const text = (m.text ?? m.caption ?? '').replace(/\s+/g, ' ').trim();
  const body = text ? cut(text, NAME_BUDGET) : describeMedia(m, t);
  return `${PROVISIONAL_PREFIX}${body}`.slice(0, TOPIC_NAME_MAX);
}

/**
 * The t.me link to a topic. Supergroup ids are `-100` + the internal id, and
 * the link wants the internal one.
 */
export function topicLink(chatId: number, threadId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${threadId}`;
}

/** Where a retargeted message came from, and what to reply to in its new home. */
export type TopicOrigin = { kind: 'general'; copy_msg_id?: number; topic_name: string };

/**
 * The same message, seen as belonging to its new topic.
 *
 * The `message_id` is deliberately NOT the copy's: claims, events and voice
 * transcription all key on the id the owner's message actually has, and ids are
 * chat-wide, so the original id keeps working from the topic. The copy's id
 * travels separately in `x_origin` because that is the one the model must
 * `reply_to_message_id` — replying to the General original would answer in
 * General.
 */
export function retargetToTopic(
  m: TgMessage,
  to: { threadId: number; copyMsgId?: number | undefined; name: string }
): TgMessage {
  return {
    ...m,
    message_thread_id: to.threadId,
    x_origin: {
      kind: 'general',
      ...(to.copyMsgId === undefined ? {} : { copy_msg_id: to.copyMsgId }),
      topic_name: to.name,
    },
  };
}
