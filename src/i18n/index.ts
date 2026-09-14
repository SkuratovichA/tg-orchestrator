// One i18next instance for the whole process, one namespace ('tg'), resources
// inlined — the convention the owner's other bot already uses.
//
// The two callers are .mjs (runner.mjs, status.mjs) and they call t() from
// deep inside synchronous code. That is fine: with the resources already in
// memory i18next has no backend to wait for and init() finishes before it
// returns, so nothing in src/ ever awaits a translation.
//
// The locale is decided ONCE, by whoever starts the process (runner.mjs from
// its loaded config, status.mjs from resolveLocale) — the first getI18n() call
// wins and later ones get that instance. Unset means English, because English
// is the fallback too: a key missing from ru falls back to en rather than
// printing the key.
import i18next, { type i18n } from 'i18next';
import { DEFAULT_LOCALE, type Locale } from '../config.ts';
import { en } from './en.ts';
import { ru } from './ru.ts';

export const NS = 'tg';

export const resources = {
  en: { [NS]: en },
  ru: { [NS]: ru },
} as const;

let instance: i18n | null = null;

/** The process-wide instance; the first call fixes the locale. */
export function getI18n(locale: Locale = DEFAULT_LOCALE): i18n {
  if (instance) return instance;
  const created = i18next.createInstance();
  created.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    ns: [NS],
    defaultNS: NS,
    resources,
    returnNull: false,
    // The values are Telegram plain text and terminal output, never HTML:
    // escaping would turn «…» and & into entities in the owner's chat.
    interpolation: { escapeValue: false },
  });
  instance = created;
  return created;
}

// The catalogue is two levels deep by construction (area, then message), so
// the key union is spelled out rather than derived recursively.
type Catalogue = typeof en;
export type TranslationKey = {
  [Area in keyof Catalogue & string]: `${Area}.${keyof Catalogue[Area] & string}`;
}[keyof Catalogue & string];

/** What ever gets interpolated: rendered fragments and plain numbers. */
export type TranslationVars = Record<string, string | number>;

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

// Re-exporting instance.t directly would bind the instance at import time —
// before the entry point had a chance to pick the locale — so this forwards
// per call. i18next's own TFunction additionally types each key's
// {{placeholders}}, but it cannot be forwarded through a wrapper without
// reproducing its overload list; the key union above is what the call sites
// actually need, and test/i18n.test.ts checks the placeholders for every key
// in both catalogues.
export const t: Translate = (key, vars) => (getI18n().t as Translate)(key, vars);
