// Typed keys. With this augmentation `t('statusCli.daemonUp')` is checked
// against the English catalogue at compile time and `t('statusCli.daemonUpp')`
// is an error — the reason en.ts is the one that defines the key set.
//
// Only .ts callers get this (the .mjs entry points are not type-checked), but
// test/i18n.test.ts closes that gap from the other side: it scans every
// t('…') literal in src/ and fails on a key the catalogue does not have.
import type { en } from './en.ts';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'tg';
    resources: { tg: typeof en };
    returnNull: false;
  }
}
