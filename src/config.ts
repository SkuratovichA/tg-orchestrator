// Everything the runner daemon reads out of ~/.config/tg-orchestrator/env and
// out of its own process environment, in one place and with one parse.
//
// The precedence is NOT uniform, and that is deliberate — it is the shape the
// daemon already had, kept variable by variable so this port changes nothing
// an observer can see (the contract oracle in test/contract/ proves it):
//   - the credentials come ONLY from the env file: a token picked up from an
//     inherited shell environment is exactly the accident the file exists to
//     prevent;
//   - the seams the tests and the operator drive (API base, turn timeout,
//     parallelism) take the process environment FIRST and the file second;
//   - the burst-window knobs and the model/effort pair are process-env only,
//     the way runner.mjs read them;
//   - the usage-limit fallback pair (TG_CLAUDE_FALLBACK_MODEL,
//     TG_CLAUDE_FALLBACK_TTL_MS) takes the process environment first and the
//     file second: they are operator seams, and the launchd job gets its
//     configuration out of ~/.config/tg-orchestrator/env;
//   - the account pair (TG_CLAUDE_CONFIG_DIR, TG_CLAUDE_CONFIG_DIR_UNTIL) the
//     same way and for the same reason: it is set once, in that file, and the
//     process environment still wins for an ad-hoc run.
//
// loadConfig never throws and never prints: it answers with a tagged union and
// the caller owns the wording, because those two misconfig sentences and the
// exit code that follows them are part of the daemon's contract.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_STATUS_DELAY_MS, DEFAULT_STATUS_INTERVAL_MS } from './live-status.ts';

/** The daemon's config and state root: env, state, homes, proposals, the wake spool. */
export const CONFIG_ROOT = path.join(os.homedir(), '.config', 'tg-orchestrator');

// Mirrors turn.mjs: DEFAULT_CLAUDE_TIMEOUT_MS (50 min — the 30-min cap killed
// two finished turns on 10.09) and the leniency of its parseTimeoutMs. turn.mjs
// is still .mjs, so it cannot be imported from here without allowJs; the two
// are pinned against each other in test/config.test.ts.
export const DEFAULT_CLAUDE_TIMEOUT_MS = 50 * 60 * 1000;
export const DEFAULT_MAX_PARALLEL_TURNS = 3;
export const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
export const DEFAULT_BURST_SETTLE_MS = 3 * 60 * 1000;
export const DEFAULT_BURST_WINDOW_MAX_MS = 15 * 60 * 1000;
// Owner's call (10.09.2026): the orchestrator itself runs on fable.
export const DEFAULT_CLAUDE_MODEL = 'fable';
export const DEFAULT_CLAUDE_EFFORT = 'xhigh';
// ...and where a turn goes when that model's usage bucket is empty (11.09.2026:
// fable answered every turn with "You're out of usage credits" while opus on
// the same login kept working, so every topic was dead). Owner's call: opus.
// An empty value switches the fallback off; so does naming the primary model.
export const DEFAULT_CLAUDE_FALLBACK_MODEL = 'opus';
// How long the daemon stays on the fallback before it probes the primary again.
export const DEFAULT_CLAUDE_FALLBACK_TTL_MS = 60 * 60 * 1000;

/** Owner-facing language. English is the default; TG_LOCALE=ru is the owner's. */
export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

// "I have finished the thought, read it now": a message that is EXACTLY one of
// these ends the burst window at once and is never forwarded to the model.
// They used to be a literal Set in runner.mjs, which made them look like
// translatable text — they are not. They are the words the OWNER types, in
// whatever language he types, and they stay the same whatever TG_LOCALE says.
// isFlush compares after trim + lowercase and after stripping a leading `/`,
// so `/answer` matches the `answer` entry and the list is stored lowercased.
//
// The default is now EMPTY, and the mechanism stays: a reaction on any pending
// message closes the window (reactions.ts), which says the same thing without
// putting a word into the conversation that then has to be stripped back out —
// and without «все» ending a burst because it happened to be the whole message.
// Set TG_FLUSH_WORDS to bring the words back.
export const DEFAULT_FLUSH_WORDS = [] as const;

// Auto-topics (auto-topic.ts) are on: General is a single conversation key, so
// two unrelated questions typed there share one session and one queue, and the
// answer to the second lands under the first.
export const DEFAULT_AUTO_TOPIC = true;

// The approval gate (learning.ts): a posted proposal nobody reacted to is
// applied after this much silence.
export const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

// The live status message (src/live-status.ts). On by default: it is the only
// thing that tells the owner a long turn is alive, and the pace is Telegram's
// — an edit every few seconds is well inside the per-chat write budget.
export const DEFAULT_LIVE_STATUS = true;

// Mid-turn input (src/mid-turn.ts): a message typed into a topic whose turn is
// still running is written into that turn instead of waiting for the next one.
// Off by default until it has run live; with it off nothing about a turn changes.
export const DEFAULT_MIDTURN_INPUT = false;

/** The forum topic proposals are posted into. */
export type TopicAddress = { chatId: number; threadId: number };
/** A third party whose messages in one chat may reach the agent (TG_GUESTS). */
export type GuestPair = { chatId: number; userId: number };
/** How an operator says "no" to a switch in an env file. */
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
/**
 * How an operator says "yes" to a switch that is off by default. Only these
 * turn it on, so a typo leaves an experimental switch off rather than on.
 */
const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

// The one sentence the daemon prints when the env file exists but says nothing
// usable. Pinned by the contract oracle — do not reword.
export const MISCONFIG_MESSAGE = 'env must define TELEGRAM_BOT_TOKEN and OWNER_ID';

// The other way the config can be unusable, and the only option here that is
// allowed to refuse a value outright (see TG_CLAUDE_CONFIG_DIR_UNTIL below).
export const BAD_CONFIG_DIR_UNTIL_MESSAGE =
  'TG_CLAUDE_CONFIG_DIR_UNTIL must be an ISO-8601 timestamp, e.g. 2026-09-21T16:00:00Z';

// The third refusal. A guest list is a permission: a typo that silently
// dropped one pair would hide a friend's messages, and one that silently
// widened it cannot happen only because every pair is refused or taken whole.
export const BAD_GUESTS_MESSAGE =
  'TG_GUESTS must be comma-separated chat_id:user_id pairs, e.g. -1001234567890:123456789';

/** Where a single variable is allowed to come from. */
export type VarSource = 'env-file' | 'process-env' | 'process-env-over-file';

export const SOURCES = {
  TELEGRAM_BOT_TOKEN: 'env-file',
  OWNER_ID: 'env-file',
  TG_API_BASE_URL: 'process-env-over-file',
  TG_CLAUDE_TIMEOUT_MS: 'process-env-over-file',
  TG_MAX_PARALLEL_TURNS: 'process-env-over-file',
  TG_BURST_SETTLE_MS: 'process-env',
  TG_BURST_WINDOW_MAX_MS: 'process-env',
  // The model/effort pair was process-env only until 18.09.2026. Then the owner
  // made it a standing choice («дефолт ответ в оркестраторе через опуса, xhigh»),
  // and a standing choice must survive a launchd start, which hands ensure.sh no
  // environment at all — only restart-when-idle.sh exports the file. So: the
  // file, with the process environment still winning for an ad-hoc run.
  TG_CLAUDE_MODEL: 'process-env-over-file',
  TG_CLAUDE_EFFORT: 'process-env-over-file',
  // The fallback pair is something the operator sets once, in the same file.
  TG_CLAUDE_FALLBACK_MODEL: 'process-env-over-file',
  TG_CLAUDE_FALLBACK_TTL_MS: 'process-env-over-file',
  // Which account the CHILD sessions log in as, and until when. Set once in the
  // env file like the fallback pair, because it must survive a launchd start.
  TG_CLAUDE_CONFIG_DIR: 'process-env-over-file',
  TG_CLAUDE_CONFIG_DIR_UNTIL: 'process-env-over-file',
  // Both added in stage S2, and both take the process environment first so a
  // one-off `TG_LOCALE=ru orc-status` works without editing the env file.
  TG_LOCALE: 'process-env-over-file',
  TG_FLUSH_WORDS: 'process-env-over-file',
  // The auto-topic switch: on by default, and off is a one-off `TG_AUTO_TOPIC=0`
  // away for the rare session where messages in General must stay in General.
  TG_AUTO_TOPIC: 'process-env-over-file',
  // The approval gate: set once in the env file, like the fallback pair.
  // No TG_LEARNING_TOPIC = no gate.
  TG_LEARNING_TOPIC: 'process-env-over-file',
  TG_PROPOSAL_TTL_MS: 'process-env-over-file',
  // The live status message: on by default, `TG_LIVE_STATUS=0` for a session
  // where the topic must stay clean, and the two paces for tuning it.
  TG_LIVE_STATUS: 'process-env-over-file',
  TG_LIVE_STATUS_INTERVAL_MS: 'process-env-over-file',
  TG_LIVE_STATUS_DELAY_MS: 'process-env-over-file',
  // Mid-turn input: set in the env file to keep it, or `TG_MIDTURN_INPUT=on`
  // for one ad-hoc run.
  TG_MIDTURN_INPUT: 'process-env-over-file',
  // Guests: who besides the owner may wake the agent, and only in which chat.
  // A standing choice in the env file, like the learning topic.
  TG_GUESTS: 'process-env-over-file',
} as const satisfies Record<string, VarSource>;

export type VarName = keyof typeof SOURCES;

// A locale nobody knows is ignored in favour of the default, like every other
// malformed option here: the daemon must not refuse to start over a typo in a
// cosmetic setting.
const LocaleSchema = z.enum(LOCALES).prefault(DEFAULT_LOCALE).catch(DEFAULT_LOCALE);

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const wholeAtLeastOne = (n: number): boolean => Number.isInteger(n) && n >= 1;
/** An ISO-8601 timestamp (`2026-09-21T16:00:00Z`) as epoch ms; NaN = unreadable. */
const epochMs = (raw: string): number => Date.parse(raw.trim());

// Credentials: the only two values whose absence stops the daemon.
const CredentialsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().refine((t) => t.length > 0 && !t.includes('PASTE')),
  // `Number(env.OWNER_ID || 0)` and then `!OWNER_ID`: anything that lands on 0
  // or NaN is a refusal, anything else is taken as given.
  OWNER_ID: z.coerce.number().refine((n) => Number.isFinite(n) && n !== 0),
});

// Everything else. Each field falls back the way the daemon fell back: a bad
// value is ignored in favour of the default rather than being an error —
// except the two burst knobs, which were a bare Number() and are kept that way
// so a typo stays as visible as it was.
const OptionsSchema = z
  .object({
    TG_API_BASE_URL: z.string().prefault(DEFAULT_API_BASE_URL),
    TG_CLAUDE_TIMEOUT_MS: z.coerce
      .number()
      .refine(finitePositive)
      .prefault(DEFAULT_CLAUDE_TIMEOUT_MS)
      .catch(DEFAULT_CLAUDE_TIMEOUT_MS),
    TG_MAX_PARALLEL_TURNS: z.coerce
      .number()
      .refine(wholeAtLeastOne)
      .prefault(DEFAULT_MAX_PARALLEL_TURNS)
      .catch(DEFAULT_MAX_PARALLEL_TURNS),
    TG_BURST_SETTLE_MS: z.coerce.number().prefault(DEFAULT_BURST_SETTLE_MS).catch(Number.NaN),
    TG_BURST_WINDOW_MAX_MS: z.coerce
      .number()
      .prefault(DEFAULT_BURST_WINDOW_MAX_MS)
      .catch(Number.NaN),
    TG_CLAUDE_MODEL: z.string().prefault(DEFAULT_CLAUDE_MODEL),
    TG_CLAUDE_EFFORT: z.string().prefault(DEFAULT_CLAUDE_EFFORT),
    // An empty string is meaningful here ("no fallback"), so unlike the numbers
    // below it is kept as typed and interpreted once, further down.
    TG_CLAUDE_FALLBACK_MODEL: z.string().prefault(DEFAULT_CLAUDE_FALLBACK_MODEL),
    TG_CLAUDE_FALLBACK_TTL_MS: z.coerce
      .number()
      .refine(finitePositive)
      .prefault(DEFAULT_CLAUDE_FALLBACK_TTL_MS)
      .catch(DEFAULT_CLAUDE_FALLBACK_TTL_MS),
    // The Claude Code account the child sessions log in as: an absolute config
    // dir (`$HOME/.claude-work`). Absent or empty = the personal account
    // the daemon itself runs under, exactly as before this option existed.
    TG_CLAUDE_CONFIG_DIR: z
      .string()
      .prefault('')
      .transform((raw): string | null => raw.trim() || null),
    // ...and when that borrowed account goes back. Unlike every other option
    // here a typo is NOT ignored: a deadline nobody can read is a deadline that
    // never arrives, and the daemon would keep spending the wrong account's
    // limits for as long as it stayed up. So it refuses to start instead.
    TG_CLAUDE_CONFIG_DIR_UNTIL: z
      .string()
      .prefault('')
      .refine((raw) => raw.trim() === '' || !Number.isNaN(epochMs(raw)))
      .transform((raw): number | null => (raw.trim() === '' ? null : epochMs(raw))),
    TG_LOCALE: LocaleSchema,
    // Comma-separated on the way in, a list on the way out. An empty value is
    // an empty list — "no flush words" is a legitimate thing to configure.
    TG_FLUSH_WORDS: z
      .string()
      .prefault(DEFAULT_FLUSH_WORDS.join(','))
      .transform((raw) =>
        raw
          .split(',')
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean)
      ),
    // A switch, spelled the way switches are spelled in a shell: anything that
    // is not one of the four "no" words is a yes, because the feature is on by
    // default and a typo must not silently turn it off.
    TG_AUTO_TOPIC: z
      .string()
      .prefault(DEFAULT_AUTO_TOPIC ? '1' : '0')
      .transform((raw) => !OFF_VALUES.has(raw.trim().toLowerCase())),
    // `chat_id:thread_id`. Absent, empty or malformed = the gate is off: a typo
    // must not start posting proposals somewhere unexpected.
    TG_LEARNING_TOPIC: z
      .string()
      .prefault('')
      .transform((raw): TopicAddress | null => {
        const m = /^(-?\d+):(\d+)$/.exec(raw.trim());
        return m ? { chatId: Number(m[1]), threadId: Number(m[2]) } : null;
      }),
    TG_PROPOSAL_TTL_MS: z.coerce
      .number()
      .refine(finitePositive)
      .prefault(DEFAULT_PROPOSAL_TTL_MS)
      .catch(DEFAULT_PROPOSAL_TTL_MS),
    TG_LIVE_STATUS: z
      .string()
      .prefault(DEFAULT_LIVE_STATUS ? '1' : '0')
      .transform((raw) => !OFF_VALUES.has(raw.trim().toLowerCase())),
    TG_LIVE_STATUS_INTERVAL_MS: z.coerce
      .number()
      .refine(finitePositive)
      .prefault(DEFAULT_STATUS_INTERVAL_MS)
      .catch(DEFAULT_STATUS_INTERVAL_MS),
    TG_LIVE_STATUS_DELAY_MS: z.coerce
      .number()
      .refine(finitePositive)
      .prefault(DEFAULT_STATUS_DELAY_MS)
      .catch(DEFAULT_STATUS_DELAY_MS),
    TG_MIDTURN_INPUT: z
      .string()
      .prefault(DEFAULT_MIDTURN_INPUT ? '1' : '0')
      .transform((raw) => ON_VALUES.has(raw.trim().toLowerCase())),
    // `chat_id:user_id,chat_id:user_id`. Empty = owner-only, today's behaviour.
    // Unlike the learning topic a malformed value REFUSES to start: it is an
    // access list, and guessing what the operator meant is not an option.
    TG_GUESTS: z
      .string()
      .prefault('')
      .refine((raw) => raw.trim() === '' || raw.split(',').every((p) => /^\s*-?\d+:\d+\s*$/.test(p)))
      .transform((raw): GuestPair[] =>
        raw.trim() === ''
          ? []
          : raw.split(',').map((p) => {
              const [chat, user] = p.trim().split(':');
              return { chatId: Number(chat), userId: Number(user) };
            })
      ),
  })
  .prefault({});

export type Config = {
  token: string;
  ownerId: number;
  apiBaseUrl: string;
  claudeTimeoutMs: number;
  maxParallelTurns: number;
  burstSettleMs: number;
  burstWindowMaxMs: number;
  claudeModel: string;
  claudeEffort: string;
  /** Where a usage-limited turn continues; null = nowhere (the fallback is off). */
  claudeFallbackModel: string | null;
  claudeFallbackTtlMs: number;
  /** The Claude Code account the child sessions run under; null = the personal one. */
  claudeConfigDir: string | null;
  /** Epoch ms after which that account choice lapses; null = it does not. */
  claudeConfigDirUntil: number | null;
  locale: Locale;
  flushWords: string[];
  /** Does a message in the forum's General get a topic of its own? */
  autoTopic: boolean;
  /** Where the approval gate posts proposals; null = the gate is disabled. */
  learningTopic: TopicAddress | null;
  /** Silence after which a posted proposal is applied, unless it carries its own ttlMs. */
  proposalTtlMs: number;
  /** Does a running turn keep a live status message in its topic? */
  liveStatus: boolean;
  /** How often that message is edited. */
  liveStatusIntervalMs: number;
  /** How long a turn must run before it gets one at all. */
  liveStatusDelayMs: number;
  /**
   * Is a message for a running turn written into it? Present only when on, so
   * a config with the switch off is the same value it was before the switch.
   */
  midturnInput?: true;
  /**
   * Third parties whose messages in one chat reach the guest classifier
   * (TG_GUESTS). Present only when non-empty, for the same reason as above.
   */
  guests?: GuestPair[];
};

export type LoadResult =
  | { kind: 'ok'; config: Config }
  | { kind: 'missing-env-file' }
  | { kind: 'invalid'; message: string };

export type LoadOptions = {
  /** Absolute path of the env file, ~/.config/tg-orchestrator/env in production. */
  envFile: string;
  /** Defaults to the real process environment; the tests pass their own. */
  processEnv?: Record<string, string | undefined>;
};

// The daemon's own env-file grammar, kept byte-for-byte: whole lines trimmed,
// blanks and `#` comments dropped, split on the FIRST `=`, key and value taken
// as they are (no per-side trim, no quote stripping), last duplicate wins.
export function parseEnvFile(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
}

function rawValue(
  name: VarName,
  fileEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>
): string | undefined {
  switch (SOURCES[name]) {
    case 'env-file':
      return fileEnv[name];
    case 'process-env':
      return processEnv[name];
    case 'process-env-over-file':
      return processEnv[name] ?? fileEnv[name];
  }
}

// Two ways to say "there is nowhere to fall back to", and they must both mean
// the same thing to every reader: an empty value (the operator switched it off)
// and a value that IS the primary model (falling back to yourself is not a
// fallback, it is a second run of the failure).
function fallbackModel(raw: string, primary: string): string | null {
  const wanted = raw.trim();
  return wanted === '' || wanted === primary.trim() ? null : wanted;
}

export function loadConfig({ envFile, processEnv = process.env }: LoadOptions): LoadResult {
  if (!fs.existsSync(envFile)) return { kind: 'missing-env-file' };
  const fileEnv = parseEnvFile(fs.readFileSync(envFile, 'utf8'));

  const raw: Record<string, string | undefined> = {};
  for (const name of Object.keys(SOURCES) as VarName[]) {
    const value = rawValue(name, fileEnv, processEnv);
    if (value !== undefined) raw[name] = value;
  }

  const credentials = CredentialsSchema.safeParse(raw);
  if (!credentials.success) return { kind: 'invalid', message: MISCONFIG_MESSAGE };
  // Every field here catches or prefaults except TG_CLAUDE_CONFIG_DIR_UNTIL and
  // TG_GUESTS, so these are the only values that can land in the branch below —
  // and loadConfig still answers, never throws.
  const options = OptionsSchema.safeParse(raw);
  if (!options.success) {
    const guests = options.error.issues.some((issue) => issue.path[0] === 'TG_GUESTS');
    return { kind: 'invalid', message: guests ? BAD_GUESTS_MESSAGE : BAD_CONFIG_DIR_UNTIL_MESSAGE };
  }

  const opts = options.data;
  return {
    kind: 'ok',
    config: {
      token: credentials.data.TELEGRAM_BOT_TOKEN,
      ownerId: credentials.data.OWNER_ID,
      apiBaseUrl: opts.TG_API_BASE_URL,
      claudeTimeoutMs: opts.TG_CLAUDE_TIMEOUT_MS,
      maxParallelTurns: opts.TG_MAX_PARALLEL_TURNS,
      burstSettleMs: opts.TG_BURST_SETTLE_MS,
      burstWindowMaxMs: opts.TG_BURST_WINDOW_MAX_MS,
      claudeModel: opts.TG_CLAUDE_MODEL,
      claudeEffort: opts.TG_CLAUDE_EFFORT,
      claudeFallbackModel: fallbackModel(opts.TG_CLAUDE_FALLBACK_MODEL, opts.TG_CLAUDE_MODEL),
      claudeFallbackTtlMs: opts.TG_CLAUDE_FALLBACK_TTL_MS,
      claudeConfigDir: opts.TG_CLAUDE_CONFIG_DIR,
      claudeConfigDirUntil: opts.TG_CLAUDE_CONFIG_DIR_UNTIL,
      locale: opts.TG_LOCALE,
      flushWords: opts.TG_FLUSH_WORDS,
      autoTopic: opts.TG_AUTO_TOPIC,
      learningTopic: opts.TG_LEARNING_TOPIC,
      proposalTtlMs: opts.TG_PROPOSAL_TTL_MS,
      liveStatus: opts.TG_LIVE_STATUS,
      liveStatusIntervalMs: opts.TG_LIVE_STATUS_INTERVAL_MS,
      liveStatusDelayMs: opts.TG_LIVE_STATUS_DELAY_MS,
      ...(opts.TG_MIDTURN_INPUT ? { midturnInput: true as const } : {}),
      ...(opts.TG_GUESTS.length ? { guests: opts.TG_GUESTS } : {}),
    },
  };
}

// The account a turn STARTING NOW runs under. Asked per turn rather than once
// at boot, so the deadline reverts the daemon to the personal account on its
// own — no restart, no operator awake at 16:00 to edit the env file.
export function activeClaudeConfigDir(
  cfg: Pick<Config, 'claudeConfigDir' | 'claudeConfigDirUntil'>,
  now: number = Date.now()
): string | null {
  const dir = cfg.claudeConfigDir?.trim();
  if (!dir) return null;
  return cfg.claudeConfigDirUntil !== null && now >= cfg.claudeConfigDirUntil ? null : dir;
}

// The locale alone, for a caller that has no credentials and must not need
// any: `orc-status` renders the same sentences as the daemon but reads no
// token. Same file, same grammar, same precedence as loadConfig — there is no
// second place where TG_LOCALE is interpreted.
export function resolveLocale({ envFile, processEnv = process.env }: LoadOptions): Locale {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  } catch {
    /* no env file: the default locale, exactly as if the variable were unset */
  }
  return LocaleSchema.parse(processEnv.TG_LOCALE ?? fileEnv.TG_LOCALE);
}
