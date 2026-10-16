// The sentence wrap (docs/agent-learning.md §4): a markdown line longer than
// `maxLen` is broken after sentence ends, so an agent's CLAUDE.md, rules and
// memory stay reviewable as diffs — one long paragraph line turns every edit
// into a whole-paragraph change.
//
// Pure and total: it never throws, never drops or reorders a character other
// than the whitespace at a split point, and wrap(wrap(x)) === wrap(x). What it
// does not understand it leaves alone — fenced code, headings, tables, a
// leading frontmatter block, HTML comments, blank lines, and any line with no
// sentence end to split at (a URL).

export const DEFAULT_WRAP_LEN = 300;

export const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const TABLE = /^[ \t]*\|/;
const QUOTE = /^(?:[ \t]*>[ ]?)*/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
// Spans a split must never land inside: inline code, a wiki link, a markdown
// link, an HTML tag or autolink.
const PROTECTED = /`[^`]*`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|<[^>]*>/g;
// A split whose next line would start with one of these would turn prose into
// a list item, a quote, a heading, a table or a fence.
const BLOCK_START = /^(?:[-*+][ \t]|\d{1,9}[.)][ \t]|[#>|<]|`{3}|~{3})/;
const SENTENCE_END = /[.!?]([ \t]+)(?=\S)/g;

export interface Piece {
  /** The whitespace that separated this sentence from the previous one ('' for the first). */
  readonly sep: string;
  readonly text: string;
}

/** Sentences of `content`, split only where a split is safe. Also used by
 *  split-plan.ts to cut a single over-long Telegram block at sentence ends. */
export function sentences(content: string): Piece[] {
  const guarded: Array<[number, number]> = [];
  for (const m of content.matchAll(PROTECTED)) guarded.push([m.index, m.index + m[0].length]);
  const pieces: Piece[] = [];
  let start = 0;
  let sep = '';
  for (const m of content.matchAll(SENTENCE_END)) {
    const wsStart = m.index + 1;
    const next = wsStart + (m[1] ?? '').length;
    if (guarded.some(([a, b]) => wsStart > a && wsStart < b)) continue;
    if (BLOCK_START.test(content.slice(next))) continue;
    pieces.push({ sep, text: content.slice(start, wsStart) });
    sep = content.slice(wsStart, next);
    start = next;
  }
  pieces.push({ sep, text: content.slice(start) });
  return pieces;
}

/** One over-long prose line → one or more lines (without line endings). */
function wrapLine(line: string, maxLen: number): string[] {
  const quote = QUOTE.exec(line)?.[0] ?? '';
  const rest = line.slice(quote.length);
  const item = LIST_ITEM.exec(rest)?.[0];
  const head = quote + (item ?? /^[ \t]*/.exec(rest)?.[0] ?? '');
  const cont = item === undefined ? head : quote + ' '.repeat(item.length);
  const pieces = sentences(line.slice(head.length));
  if (pieces.length < 2) return [line];

  const out: string[] = [];
  let cur = head + (pieces[0]?.text ?? '');
  for (const p of pieces.slice(1)) {
    if (cur.length + p.sep.length + p.text.length <= maxLen) {
      cur += p.sep + p.text;
    } else {
      out.push(cur);
      cur = cont + p.text;
    }
  }
  out.push(cur);
  return out;
}

/** Wrap every over-long paragraph, list-item and blockquote line of `md`. */
export function wrapLongLines(md: string, maxLen: number = DEFAULT_WRAP_LEN): string {
  // [line, eol, line, eol, …, last]: the endings are kept per line, so CRLF
  // stays CRLF and a missing trailing newline stays missing.
  const parts = md.split(/(\r?\n)/);
  const eolOf = (i: number): string => parts[i + 1] ?? (md.includes('\r\n') ? '\r\n' : '\n');
  const lines = parts.filter((_, i) => i % 2 === 0);

  let frontmatterEnd = -1;
  if (lines[0] === '---') frontmatterEnd = lines.findIndex((l, i) => i > 0 && l === '---');

  let fence: string | null = null;
  let inComment = false;
  const out: string[] = [];
  lines.forEach((line, n) => {
    const i = n * 2;
    const eol = parts[i + 1] ?? '';
    const keep = (): void => void out.push(line + eol);

    if (n <= frontmatterEnd) return keep();
    const f = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (f !== undefined && f[0] === fence[0] && f.length >= fence.length) fence = null;
      return keep();
    }
    if (f !== undefined) {
      fence = f;
      return keep();
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return keep();
    }
    if (line.includes('<!--')) {
      inComment = !line.slice(line.lastIndexOf('<!--')).includes('-->');
      return keep();
    }
    if (line.length <= maxLen || line.trim() === '' || HEADING.test(line) || TABLE.test(line)) return keep();

    out.push(wrapLine(line, maxLen).join(eolOf(i)) + eol);
  });
  return out.join('');
}
