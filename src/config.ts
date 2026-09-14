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
//     configuration out of ~/.config/tg-orchestrator/env.
//
// loadConfig never throws and never prints: it answers with a tagged union and
// the caller owns the wording, because those two misconfig sentences and the
// exit code that follows them are part of the daemon's contract.
import fs from 'node:fs';
import { z } from 'zod';

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
export const DEFAULT_FLUSH_WORDS = [
  'читай',
  'прочитай',
  'ответь',
  'отвечай',
  'го',
  'go',
  'answer',
  'всё',
  'все',
] as const;

// The one sentence the daemon prints when the env file exists but says nothing
// usable. Pinned by the contract oracle — do not reword.
export const MISCONFIG_MESSAGE = 'env must define TELEGRAM_BOT_TOKEN and OWNER_ID';

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
  TG_CLAUDE_MODEL: 'process-env',
  TG_CLAUDE_EFFORT: 'process-env',
  // The fallback pair is NOT process-env only: unlike the model/effort pair it
  // is something the operator sets once, in the file launchd reads.
  TG_CLAUDE_FALLBACK_MODEL: 'process-env-over-file',
  TG_CLAUDE_FALLBACK_TTL_MS: 'process-env-over-file',
  // Both added in stage S2, and both take the process environment first so a
  // one-off `TG_LOCALE=ru orc-status` works without editing the env file.
  TG_LOCALE: 'process-env-over-file',
  TG_FLUSH_WORDS: 'process-env-over-file',
} as const satisfies Record<string, VarSource>;

export type VarName = keyof typeof SOURCES;

// A locale nobody knows is ignored in favour of the default, like every other
// malformed option here: the daemon must not refuse to start over a typo in a
// cosmetic setting.
const LocaleSchema = z.enum(LOCALES).prefault(DEFAULT_LOCALE).catch(DEFAULT_LOCALE);

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const wholeAtLeastOne = (n: number): boolean => Number.isInteger(n) && n >= 1;

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
  locale: Locale;
  flushWords: string[];
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
  const options = OptionsSchema.parse(raw); // every field catches or prefaults

  return {
    kind: 'ok',
    config: {
      token: credentials.data.TELEGRAM_BOT_TOKEN,
      ownerId: credentials.data.OWNER_ID,
      apiBaseUrl: options.TG_API_BASE_URL,
      claudeTimeoutMs: options.TG_CLAUDE_TIMEOUT_MS,
      maxParallelTurns: options.TG_MAX_PARALLEL_TURNS,
      burstSettleMs: options.TG_BURST_SETTLE_MS,
      burstWindowMaxMs: options.TG_BURST_WINDOW_MAX_MS,
      claudeModel: options.TG_CLAUDE_MODEL,
      claudeEffort: options.TG_CLAUDE_EFFORT,
      claudeFallbackModel: fallbackModel(options.TG_CLAUDE_FALLBACK_MODEL, options.TG_CLAUDE_MODEL),
      claudeFallbackTtlMs: options.TG_CLAUDE_FALLBACK_TTL_MS,
      locale: options.TG_LOCALE,
      flushWords: options.TG_FLUSH_WORDS,
    },
  };
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
