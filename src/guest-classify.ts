// Is a guest's message for the bot, or for the owner?
//
// A guest (TG_GUESTS) shares a chat with the owner and the bot. The owner's
// rule for that chat: a guest's message wakes the agent ONLY when it is
// addressed to the bot, and the decision is invisible — no status, no
// reaction, no reply. So it is made before any turn exists, by the cheapest
// model there is, and every doubt resolves to "owner": a missed question costs
// the guest a nudge ("@bot …"), a false wake costs a stranger's words reaching
// an agent that runs with permissions off.
//
// Two deterministic answers come first and never reach a model: a reply to one
// of the bot's own messages, and an @mention of the bot.
import type { EventRecord, JsonValue } from './events.ts';
import { askHaikuAsync, haikuArgs } from './haiku.ts';

export type GuestVerdict = 'bot' | 'owner';

export interface GuestDecision {
  readonly to: GuestVerdict;
  /** shortcut = no model was asked; error = the model failed and `owner` is the fallback. */
  readonly via: 'shortcut' | 'haiku' | 'error';
  /** Which shortcut, or what went wrong. */
  readonly reason: string | null;
  readonly ms: number;
}

/** The fields of a Telegram message this module reads; runner.ts's TgMessage fits. */
export interface GuestMessage {
  readonly message_id: number;
  readonly text?: string | undefined;
  readonly caption?: string | undefined;
  readonly reply_to_message?:
    | {
        readonly text?: string | undefined;
        readonly caption?: string | undefined;
        readonly from?: { readonly id?: number | undefined } | undefined;
      }
    | undefined;
}

export type Role = 'owner' | 'guest' | 'bot';

/** One line of the chat as haiku is shown it. */
export interface ContextLine {
  readonly role: Role;
  readonly name: string | null;
  readonly text: string;
}

export interface GuestClassifyInput {
  readonly message: GuestMessage;
  readonly guestId: number;
  readonly guestName: string;
  readonly ownerId: number;
  /** The bot's own user id and @username (getMe); null when getMe did not say. */
  readonly botId: number | null;
  readonly botUsername: string | null;
  /** The chat before this message, oldest first (recentFromEvents). */
  readonly recent: readonly ContextLine[];
}

export interface GuestClassifyOptions {
  /** The model command; TG_GUEST_CLAUDE_BIN, for tests. */
  readonly bin: string;
  readonly timeoutMs: number;
}

/** Kill the classifier after this long and answer `owner`. */
export const GUEST_CLASSIFY_TIMEOUT_MS = 25_000;
/** How much of the chat before the message haiku sees. */
export const RECENT_LINES = 8;
const CLIP = 300;

const SYSTEM_PROMPT = `You route messages in a Telegram group chat with three participants: the OWNER, the BOT (the owner's personal AI assistant), and a GUEST (a friend of the owner).
Decide whether the GUEST's new message is addressed to the BOT: asking the bot something, telling it to do something, answering a question the bot asked, or continuing a conversation the guest is having with the bot.
Everything else — talking to the owner, talking to the chat in general, reacting to what the owner said, small talk — is addressed to the owner.
When you are not sure, the answer is owner.
Answer with JSON only, nothing else: {"to":"bot"} or {"to":"owner"}.`;

/** Exported so a test can pin the call shape against split-plan.ts. */
export const CLASSIFIER_ARGS: readonly string[] = haikuArgs(SYSTEM_PROMPT, ['--effort', 'low']);

const clip = (s: string, n = CLIP): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const textOf = (m: { readonly text?: string | undefined; readonly caption?: string | undefined }): string =>
  m.text ?? m.caption ?? '';

/** The deterministic answers; null = ask the model. */
export function guestShortcut(input: Pick<GuestClassifyInput, 'message' | 'botId' | 'botUsername'>): string | null {
  const { message, botId, botUsername } = input;
  if (botId !== null && message.reply_to_message?.from?.id === botId) return 'reply to the bot';
  if (botUsername) {
    // Usernames are [A-Za-z0-9_] and case-insensitive; the boundary keeps
    // @mybot from matching inside @mybot_old.
    const escaped = botUsername.replace(/[^A-Za-z0-9_]/g, '');
    if (new RegExp(`@${escaped}(?![A-Za-z0-9_])`, 'i').test(textOf(message))) return 'mentions the bot';
  }
  return null;
}

function roleOf(id: number | undefined, input: GuestClassifyInput): string {
  if (id === undefined) return 'someone';
  if (id === input.botId) return 'the BOT';
  if (id === input.ownerId) return 'the OWNER';
  if (id === input.guestId) return 'the GUEST';
  return 'someone else';
}

const label = (l: ContextLine): string =>
  l.role === 'bot' ? 'BOT' : `${l.role.toUpperCase()}${l.name ? ` ${l.name}` : ''}`;

export function classifierPrompt(input: GuestClassifyInput): string {
  const owner = input.recent.find((l) => l.role === 'owner' && l.name)?.name;
  const parts = [
    `The OWNER is ${owner ?? 'the person the bot works for'}. The BOT is the owner's assistant. The GUEST is ${input.guestName}.`,
  ];
  parts.push(
    input.recent.length
      ? `Recent conversation in this chat, oldest first:\n${input.recent.map((l) => `[${label(l)}] ${clip(l.text)}`).join('\n')}`
      : 'There is no earlier conversation in this chat on record.'
  );
  const reply = input.message.reply_to_message;
  if (reply) {
    parts.push(`The guest's new message is a reply to a message by ${roleOf(reply.from?.id, input)}: "${clip(textOf(reply))}"`);
  }
  parts.push(`The GUEST's new message:\n${clip(textOf(input.message), 2000) || '(no text: a voice note, photo or file)'}`);
  return parts.join('\n\n');
}

function verdictOf(raw: unknown): GuestVerdict | null {
  if (typeof raw !== 'object' || raw === null || !('to' in raw)) return null;
  return raw.to === 'bot' || raw.to === 'owner' ? raw.to : null;
}

/** Never rejects: a failure is `owner`, with the reason in the decision. */
export async function classifyGuest(input: GuestClassifyInput, opts: GuestClassifyOptions): Promise<GuestDecision> {
  const shortcut = guestShortcut(input);
  if (shortcut) return { to: 'bot', via: 'shortcut', reason: shortcut, ms: 0 };
  const t0 = Date.now();
  const answer = await askHaikuAsync(opts.bin, CLASSIFIER_ARGS, classifierPrompt(input), opts.timeoutMs);
  const ms = Date.now() - t0;
  if (typeof answer === 'string') return { to: 'owner', via: 'error', reason: answer, ms };
  const to = verdictOf(answer.raw);
  if (!to) return { to: 'owner', via: 'error', reason: `not a verdict: ${JSON.stringify(answer.raw).slice(0, 200)}`, ms };
  return { to, via: 'haiku', reason: null, ms };
}

// --- the chat before the message, from the event log -------------------------
type JsonObject = { [key: string]: JsonValue };
const obj = (v: JsonValue | null | undefined): JsonObject | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null);

/**
 * The last `limit` things said in this convo before `msgId`: inbound messages
 * (the whole Telegram message is the payload) and the bot's own sends
 * (tg-send.sh's `outbound` rows, whose `text` is the first 500 characters).
 * `rows` is a tail of the convo's events, oldest first.
 */
export function recentFromEvents(
  rows: readonly EventRecord[],
  who: { readonly ownerId: number; readonly msgId: number },
  limit = RECENT_LINES
): ContextLine[] {
  const lines: ContextLine[] = [];
  for (const row of rows) {
    const p = obj(row.payload);
    if (!p) continue;
    if (row.kind === 'inbound') {
      // Everything at and after the message itself is not "before" it.
      if (row.msgId === who.msgId) break;
      const text = str(p['text']) ?? str(p['caption']);
      if (!text) continue;
      const from = obj(p['from']);
      const guest = obj(p['x_guest']);
      const owner = from?.['id'] === who.ownerId;
      lines.push({
        role: owner ? 'owner' : 'guest',
        name: (owner ? str(from?.['first_name']) : str(guest?.['name'])) ?? null,
        text,
      });
    } else if (row.kind === 'outbound') {
      const text = str(p['text']);
      if (text) lines.push({ role: 'bot', name: null, text });
    }
  }
  return lines.slice(-limit);
}
