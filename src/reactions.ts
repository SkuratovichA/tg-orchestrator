// «Читай сейчас», said with an emoji instead of a word.
//
// Why: the burst window exists so a series of messages is answered as one turn,
// and until now the only way to close it early was a flush word typed as its own
// message — a word that then had to be stripped out of the prompt so the model
// would not answer «го». A reaction says the same thing without adding a message
// to the conversation at all: the owner taps any emoji on something he has just
// sent, the window closes, and nothing about the prompt changes.
//
// Only a reaction on a message that is STILL in the window means anything. One
// on an already-dispatched message changes nothing — that topic's turn is either
// running or queued, and there is no window left to close.
//
// Pure: no I/O, no globals — see test/reactions.test.ts.
import { z } from 'zod';
import type { TgMessage } from './runner.ts';

// Here rather than in runner.ts so the leaf modules that match reactions
// (this one, learning.ts) never import the daemon.
export const TgChatSchema = z.looseObject({
  id: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
  // Only a forum supergroup has topics, and only there does a missing
  // `message_thread_id` mean "General" rather than "this chat has no topics"
  // (auto-topic.ts).
  is_forum: z.boolean().optional(),
});

// A reaction the owner put on one of his own messages. The Bot API delivers it
// as its own update kind (`message_reaction`, and only if it is asked for in
// allowed_updates), with the FULL list before and after the change rather than
// a "what happened" flag — so "he added one" is old vs new.
export const TgReactionSchema = z.looseObject({
  chat: TgChatSchema,
  message_id: z.number(),
  user: z.looseObject({ id: z.number().optional() }).optional(),
  date: z.number().optional(),
  old_reaction: z
    .array(z.looseObject({ type: z.string(), emoji: z.string().optional() }))
    .catch([])
    .prefault([]),
  new_reaction: z
    .array(z.looseObject({ type: z.string(), emoji: z.string().optional() }))
    .catch([])
    .prefault([]),
});
export type TgReaction = z.infer<typeof TgReactionSchema>;

/**
 * The buffered message a flush reaction was put on, or null if this reaction is
 * not one: it removed a reaction rather than added one, it is on a message the
 * window is not holding, or it was left by somebody other than the message's
 * own author.
 *
 * The runner hands us only the owner's reactions (pollOnce filters on OWNER_ID
 * before anything else), so the author check is belt and braces — but it is
 * checkable here, where there is no network.
 */
export function matchFlushReaction(
  r: TgReaction,
  buffered: readonly TgMessage[]
): TgMessage | null {
  // Telegram sends the whole reaction list after every change, so "added" is a
  // comparison, not a flag: taking a reaction OFF a message is not a flush.
  if (r.new_reaction.length <= r.old_reaction.length) return null;
  const on = buffered.find((m) => m.chat.id === r.chat.id && m.message_id === r.message_id);
  if (!on) return null;
  if (r.user?.id !== undefined && on.from?.id !== undefined && r.user.id !== on.from.id) return null;
  return on;
}

/** Does this reaction close the burst window? */
export function isFlushReaction(r: TgReaction, buffered: readonly TgMessage[]): boolean {
  return matchFlushReaction(r, buffered) !== null;
}

/** The emoji that was just added, for the event log. Custom emoji have none. */
export function addedEmoji(r: TgReaction): string | null {
  return r.new_reaction.at(-1)?.emoji ?? null;
}
