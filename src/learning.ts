// learning.ts — the approval gate's model, store and CLI (docs/agent-learning.md §2).
//
// An agent does not edit its own rules, skills or memory index in a turn: it
// files a PROPOSAL, the owner sees it in the learning topic, and a 👍, a 👎, a
// "нет" reply or silence decides. A proposal is one JSON file under
// `<root>/proposals/`, and its directory is its state:
//
//   pending/<id>.json   filed, not yet shown to the owner
//   posted/<id>.json    shown; messageId/chatId say where
//   done/<id>.json      resolved: outcome applied | rejected
//
// A failed apply is NOT resolved: it stays where it was with `outcome: failed`
// and the error, and the owner decides again.
//
// What lives here is everything but the daemon's wiring: the schema, the path
// policy, the store (rename between sibling directories, like wake/spool.ts),
// apply/reject, the pure matchers the runner calls on reactions and replies,
// and the message text. The store takes an injected `LearningFs`
// (`nodeLearningFs` for the real disk), and every function takes the root, so
// tests point it at a temp dir.
//
// Exit codes (runCommand in claims.ts): 0 = done, 3 = the gate said no (an
// apply that failed, a proposal already resolved), 1 = error (bad input).
import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { writeAtomic } from './atomic.ts';
import { CONFIG_ROOT } from './config.ts';
import { human, parseArgs, runCommand, type CommandOutcome } from './claims.ts';
import { NS, resources, t } from './i18n/index.ts';
import { wrapLongLines } from './markdown-wrap.ts';
import { addedEmoji, type TgReaction } from './reactions.ts';

// ---------------------------------------------------------------- model ---

/** Safe as a file name and as a directory name. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const ProposalOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('write'), path: z.string(), content: z.string() }),
  z.object({ op: z.literal('append'), path: z.string(), text: z.string() }),
  /** A unified diff against the file as it is when the proposal is applied. */
  z.object({ op: z.literal('patch'), path: z.string(), diff: z.string() }),
  /** Archiving is a move; there is no delete. */
  z.object({ op: z.literal('move'), from: z.string(), to: z.string() }),
]);
export type ProposalOp = z.infer<typeof ProposalOpSchema>;

export const PROPOSAL_KINDS = ['rule', 'memory', 'skill'] as const;
export const PROPOSAL_OUTCOMES = ['applied', 'rejected', 'failed'] as const;

// Every instant is epoch ms.
export const ProposalSchema = z.object({
  id: z.string().regex(NAME_RE),
  agent: z.string().regex(NAME_RE),
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().min(1),
  summary: z.string(),
  /** chat:thread:msg_id of the message that taught it. */
  source: z.string().optional(),
  ops: z.array(ProposalOpSchema).min(1),
  /** How long silence waits before it counts as consent; default TG_PROPOSAL_TTL_MS. */
  ttlMs: z.number().positive().optional(),
  createdAt: z.number(),
  postedAt: z.number().optional(),
  messageId: z.number().int().optional(),
  /** The document with the full dump, when the text did not fit (renderProposal overflow). */
  documentMessageId: z.number().int().optional(),
  chatId: z.number().int().optional(),
  resolvedAt: z.number().optional(),
  outcome: z.enum(PROPOSAL_OUTCOMES).optional(),
  error: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * What `propose` accepts: the gate assigns id and createdAt when they are
 * missing, and the fields only the gate writes (posting, outcome) are dropped.
 */
export const ProposalInputSchema = ProposalSchema.omit({
  postedAt: true,
  messageId: true,
  documentMessageId: true,
  chatId: true,
  resolvedAt: true,
  outcome: true,
  error: true,
}).partial({ id: true, createdAt: true });

export class LearningError extends Error {}

/** `p` + base36 time + 4 base36 random chars: sortable by creation, short to type. */
export function newProposalId(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = Array.from({ length: 4 }, () => Math.floor(random() * 36).toString(36)).join('');
  return `p${now.toString(36)}${tail}`;
}

// ---------------------------------------------------------- path policy ---

const WRITABLE_PREFIXES = ['.claude/rules/', '.claude/skills/', 'memory/'] as const;
const MEMORY = 'memory/';
const ARCHIVE = 'memory/.archive/';

/** Why a home-relative path is malformed, or null. */
function malformed(p: string): string | null {
  if (p === '') return 'empty path';
  if (p.includes('\0')) return 'NUL in path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('/') || path.isAbsolute(p)) return 'absolute path';
  const segments = p.split('/');
  if (segments.includes('')) return 'empty path segment';
  if (segments.includes('..')) return "'..' segment";
  if (segments.includes('.')) return "'.' segment";
  return null;
}

/** Why the gate refuses `p` as a place to write, or null. */
function refused(p: string): string | null {
  const bad = malformed(p);
  if (bad !== null) return bad;
  if (p === 'CLAUDE.md' || WRITABLE_PREFIXES.some((prefix) => p.startsWith(prefix))) return null;
  return 'outside CLAUDE.md, .claude/rules/, .claude/skills/, memory/';
}

/**
 * Every reason the proposal's paths are refused; empty = allowed. Checked at
 * `propose` and again at `apply` (where applyProposal also resolves symlinks).
 */
export function checkProposalPaths(p: Pick<Proposal, 'ops'>): string[] {
  const reasons: string[] = [];
  const check = (i: number, field: string, value: string): void => {
    const why = refused(value);
    if (why !== null) reasons.push(`ops[${i}].${field} ${JSON.stringify(value)}: ${why}`);
  };
  p.ops.forEach((op, i) => {
    if (op.op !== 'move') return check(i, 'path', op.path);
    check(i, 'from', op.from);
    check(i, 'to', op.to);
    if (op.from.startsWith(MEMORY) && !op.to.startsWith(ARCHIVE)) {
      reasons.push(`ops[${i}]: a move out of memory/ may only go to memory/.archive/`);
    }
  });
  return reasons;
}

// ----------------------------------------------------------------- store ---

export const PROPOSAL_STATES = ['pending', 'posted', 'done'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** The disk operations the gate needs; `nodeLearningFs` is the real one. */
export interface LearningFs {
  mkdirp(dir: string): void;
  /** Plain file names in `dir`; [] when it does not exist. */
  listFiles(dir: string): string[];
  /** The file's text, or null when it does not exist. */
  readText(file: string): string | null;
  /** Atomic replace (same-directory temp + rename). */
  writeText(file: string, data: string): void;
  rename(from: string, to: string): void;
  exists(file: string): boolean;
  /** Like exists, but a symlink counts as present even when its target is not. */
  existsNoFollow(file: string): boolean;
  /** Is `file` itself a symlink (dangling or not)? false when it does not exist. */
  lstatIsSymlink(file: string): boolean;
  isDirectory(file: string): boolean;
  /** fs.realpathSync; throws when the path does not exist. */
  realpath(file: string): string;
}

export const nodeLearningFs: LearningFs = {
  mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true }),
  listFiles(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
  readText(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: writeAtomic,
  rename: (from, to) => fs.renameSync(from, to),
  exists: (file) => fs.existsSync(file),
  existsNoFollow: (file) => {
    try {
      fs.lstatSync(file);
      return true;
    } catch {
      return false;
    }
  },
  lstatIsSymlink: (file) => {
    try {
      return fs.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  },
  isDirectory: (file) => {
    try {
      return fs.statSync(file).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (file) => fs.realpathSync(file),
};

const stateDir = (root: string, state: ProposalState): string => path.join(root, 'proposals', state);

function fileOf(root: string, state: ProposalState, id: string): string {
  if (!NAME_RE.test(id)) throw new LearningError(`bad proposal id ${JSON.stringify(id)}`);
  return path.join(stateDir(root, state), `${id}.json`);
}

export function ensureStore(root: string, lfs: LearningFs = nodeLearningFs): void {
  for (const state of PROPOSAL_STATES) lfs.mkdirp(stateDir(root, state));
}

export interface StoredProposal {
  readonly state: ProposalState;
  readonly proposal: Proposal;
}

/** A file in the store that is not a proposal: reported, never thrown over. */
export interface BrokenProposal {
  readonly state: ProposalState;
  readonly id: string;
  readonly error: string;
}

export type ReadResult =
  | ({ kind: 'ok' } & StoredProposal)
  | ({ kind: 'broken' } & BrokenProposal)
  | { kind: 'missing'; id: string };

function parseProposal(text: string): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const parsed = ProposalSchema.safeParse(raw);
  return parsed.success ? { ok: true, proposal: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

function readAt(root: string, state: ProposalState, id: string, lfs: LearningFs): ReadResult {
  const text = lfs.readText(fileOf(root, state, id));
  if (text === null) return { kind: 'missing', id };
  const parsed = parseProposal(text);
  return parsed.ok ? { kind: 'ok', state, proposal: parsed.proposal } : { kind: 'broken', state, id, error: parsed.error };
}

/** The proposal wherever it is (pending, then posted, then done). */
export function readProposal(root: string, id: string, lfs: LearningFs = nodeLearningFs): ReadResult {
  for (const state of PROPOSAL_STATES) {
    const r = readAt(root, state, id, lfs);
    if (r.kind !== 'missing') return r;
  }
  return { kind: 'missing', id };
}

export function listProposals(
  root: string,
  lfs: LearningFs = nodeLearningFs,
  states: readonly ProposalState[] = PROPOSAL_STATES
): { proposals: StoredProposal[]; broken: BrokenProposal[] } {
  const proposals: StoredProposal[] = [];
  const broken: BrokenProposal[] = [];
  for (const state of states) {
    // `.json` only: writeAtomic's temp files end in `.tmp`.
    const ids = lfs
      .listFiles(stateDir(root, state))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    for (const id of ids) {
      if (!NAME_RE.test(id)) {
        broken.push({ state, id, error: 'not a proposal file name' });
        continue;
      }
      const r = readAt(root, state, id, lfs);
      if (r.kind === 'ok') proposals.push({ state, proposal: r.proposal });
      if (r.kind === 'broken') broken.push({ state: r.state, id: r.id, error: r.error });
    }
  }
  return { proposals, broken };
}

export function writeProposal(root: string, state: ProposalState, p: Proposal, lfs: LearningFs = nodeLearningFs): void {
  lfs.mkdirp(stateDir(root, state));
  lfs.writeText(fileOf(root, state, p.id), `${JSON.stringify(p, null, 2)}\n`);
}

export function moveProposal(
  root: string,
  id: string,
  from: ProposalState,
  to: ProposalState,
  lfs: LearningFs = nodeLearningFs
): void {
  lfs.mkdirp(stateDir(root, to));
  lfs.rename(fileOf(root, from, id), fileOf(root, to, id));
}

// --------------------------------------------------------- apply / reject ---

export interface ApplyDeps {
  readonly fs?: LearningFs;
  readonly now?: number;
}

export type ResolveResult = { ok: true; proposal: Proposal } | { ok: false; error: string; proposal?: Proposal };

/** The proposal, if it is still open (pending or posted). */
function openProposal(root: string, id: string, lfs: LearningFs): { ok: true; stored: StoredProposal } | { ok: false; error: string } {
  const r = readProposal(root, id, lfs);
  return match(r)
    .with({ kind: 'missing' }, () => ({ ok: false as const, error: `no proposal ${id}` }))
    .with({ kind: 'broken' }, (b) => ({ ok: false as const, error: `proposal ${id} is unreadable: ${b.error}` }))
    .with({ kind: 'ok', state: 'done' }, () => ({ ok: false as const, error: `proposal ${id} is already resolved` }))
    .with({ kind: 'ok' }, (s) => ({ ok: true as const, stored: { state: s.state, proposal: s.proposal } }))
    .exhaustive();
}

/**
 * `rel` under the real home, refusing a symlink as the file itself (even one
 * that points inside, even a dangling one — a write would land at its target)
 * and a path that a symlinked ancestor carries outside of the home.
 */
function insideHome(homeReal: string, rel: string, lfs: LearningFs): string {
  const target = path.join(homeReal, rel);
  if (lfs.lstatIsSymlink(target)) throw new LearningError(`${rel}: is a symlink`);
  // lstat-based: a dangling symlinked ancestor is found here and then fails to
  // resolve, instead of reading as "missing" and being walked past.
  let existing = target;
  while (!lfs.existsNoFollow(existing) && existing !== homeReal) existing = path.dirname(existing);
  let real: string;
  try {
    real = path.join(lfs.realpath(existing), path.relative(existing, target));
  } catch {
    throw new LearningError(`${rel}: cannot resolve`);
  }
  if (real !== homeReal && !real.startsWith(homeReal + path.sep)) {
    throw new LearningError(`${rel}: resolves outside the agent's home (symlink)`);
  }
  return target;
}

function runOp(homeReal: string, op: ProposalOp, lfs: LearningFs): string {
  return match(op)
    .with({ op: 'write' }, ({ path: rel, content }) => {
      const file = insideHome(homeReal, rel, lfs);
      lfs.mkdirp(path.dirname(file));
      lfs.writeText(file, content);
      return rel;
    })
    .with({ op: 'append' }, ({ path: rel, text }) => {
      const file = insideHome(homeReal, rel, lfs);
      const before = lfs.readText(file) ?? '';
      lfs.mkdirp(path.dirname(file));
      lfs.writeText(file, before === '' || before.endsWith('\n') ? before + text : `${before}\n${text}`);
      return rel;
    })
    .with({ op: 'patch' }, ({ path: rel, diff }) => {
      const file = insideHome(homeReal, rel, lfs);
      let patched: string | false;
      try {
        patched = applyPatch(lfs.readText(file) ?? '', diff);
      } catch (e) {
        throw new LearningError(`${rel}: bad patch: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (patched === false) throw new LearningError(`${rel}: the patch does not apply`);
      lfs.mkdirp(path.dirname(file));
      lfs.writeText(file, patched);
      return rel;
    })
    .with({ op: 'move' }, ({ from, to }) => {
      const src = insideHome(homeReal, from, lfs);
      const dst = insideHome(homeReal, to, lfs);
      if (!lfs.exists(src)) throw new LearningError(`${from}: does not exist`);
      if (lfs.exists(dst)) throw new LearningError(`${to}: already exists, a move never overwrites`);
      lfs.mkdirp(path.dirname(dst));
      lfs.rename(src, dst);
      return to;
    })
    .exhaustive();
}

/**
 * Apply an open proposal to `<agentsRoot>/<agent>` and resolve it.
 *
 * The ops are NOT transactional: they run in order and stop at the first one
 * that fails, and the ones before it stay applied. Every path is checked
 * (policy and symlinks) before the first op runs, so what can still fail
 * midway is a patch that does not apply or a move onto an existing file —
 * the owner sees the error and decides.
 */
export function applyProposal(root: string, agentsRoot: string, id: string, deps: ApplyDeps = {}): ResolveResult {
  const lfs = deps.fs ?? nodeLearningFs;
  const now = deps.now ?? Date.now();
  const open = openProposal(root, id, lfs);
  if (!open.ok) return open;
  const { state, proposal } = open.stored;

  try {
    const home = path.join(agentsRoot, proposal.agent);
    if (!lfs.isDirectory(home)) throw new LearningError(`no home for agent ${proposal.agent} at ${home}`);
    const reasons = checkProposalPaths(proposal);
    if (reasons.length) throw new LearningError(reasons.join('; '));
    const homeReal = lfs.realpath(home);
    for (const op of proposal.ops) {
      for (const rel of op.op === 'move' ? [op.from, op.to] : [op.path]) insideHome(homeReal, rel, lfs);
    }

    const touched = new Set(proposal.ops.map((op) => runOp(homeReal, op, lfs)));
    for (const rel of touched) {
      if (!rel.endsWith('.md')) continue;
      const file = path.join(homeReal, rel);
      const text = lfs.readText(file);
      if (text === null) continue;
      const wrapped = wrapLongLines(text);
      if (wrapped !== text) lfs.writeText(file, wrapped);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const failed: Proposal = { ...proposal, outcome: 'failed', error };
    writeProposal(root, state, failed, lfs);
    return { ok: false, error, proposal: failed };
  }

  return resolve(root, state, { ...withoutError(proposal), outcome: 'applied', resolvedAt: now }, lfs);
}

/** Close an open proposal without touching the home. */
export function rejectProposal(root: string, id: string, deps: ApplyDeps = {}): ResolveResult {
  const lfs = deps.fs ?? nodeLearningFs;
  const open = openProposal(root, id, lfs);
  if (!open.ok) return open;
  const { state, proposal } = open.stored;
  return resolve(root, state, { ...withoutError(proposal), outcome: 'rejected', resolvedAt: deps.now ?? Date.now() }, lfs);
}

function withoutError(p: Proposal): Proposal {
  const copy = { ...p };
  delete copy.error;
  return copy;
}

function resolve(root: string, state: ProposalState, p: Proposal, lfs: LearningFs): ResolveResult {
  writeProposal(root, state, p, lfs);
  moveProposal(root, p.id, state, 'done', lfs);
  return { ok: true, proposal: p };
}

// -------------------------------------------------------------- matchers ---

const APPLY_EMOJI = '👍';
const REJECT_EMOJI = '👎';
// Every locale's words, whatever the process locale is: the owner answers in
// whichever language they type in.
const REJECT_REPLIES = new Set(
  Object.values(resources).flatMap((catalogues) => catalogues[NS].learning.rejectReplies.split('|'))
);

/**
 * The verdict an owner reaction gives a posted proposal, or null: 👍 applies,
 * 👎 rejects, anything else — another emoji, a removed reaction, a message that
 * is no posted proposal — means nothing.
 */
export function matchProposalReaction(
  r: TgReaction,
  posted: readonly Proposal[]
): { proposal: Proposal; verdict: 'apply' | 'reject' } | null {
  const emoji = addedEmoji(r);
  // addedEmoji is the last of the new list; it was only ADDED if the old list
  // did not have it (taking a second reaction off leaves the first one last).
  if (emoji === null || r.old_reaction.some((o) => o.emoji === emoji)) return null;
  const verdict = emoji === APPLY_EMOJI ? 'apply' : emoji === REJECT_EMOJI ? 'reject' : null;
  if (verdict === null) return null;
  const proposal = posted.find((p) => p.messageId === r.message_id && p.chatId === r.chat.id);
  return proposal ? { proposal, verdict } : null;
}

/** Is this reply to a posted proposal a "no"? Exactly one of the words, nothing more. */
export function isRejectReply(text: string): boolean {
  return REJECT_REPLIES.has(text.trim().toLowerCase());
}

/**
 * Posted proposals whose silence has run out: postedAt + ttl <= now. One whose
 * apply already failed is not among them — silence consented once, the apply
 * said no, and retrying it on every pass would repeat the error forever; the
 * owner decides it with a reaction.
 */
export function expiredProposals(posted: readonly Proposal[], now: number, defaultTtlMs: number): Proposal[] {
  return posted.filter(
    (p) => p.outcome !== 'failed' && p.postedAt !== undefined && p.postedAt + (p.ttlMs ?? defaultTtlMs) <= now
  );
}

/** The fields of an incoming message a reject reply is recognised by. */
export interface ReplyLike {
  readonly chat: { readonly id: number };
  readonly message_thread_id?: number | undefined;
  readonly text?: string | undefined;
  readonly reply_to_message?: { readonly message_id: number } | undefined;
}

/**
 * The posted proposal an owner message rejects, or null: it must be in the
 * learning topic, reply to the proposal's own message, and say only "no".
 */
export function matchRejectReply(
  m: ReplyLike,
  topic: { readonly chatId: number; readonly threadId: number },
  posted: readonly Proposal[]
): Proposal | null {
  if (m.chat.id !== topic.chatId || (m.message_thread_id ?? 0) !== topic.threadId) return null;
  const replyTo = m.reply_to_message?.message_id;
  if (replyTo === undefined || m.text === undefined || !isRejectReply(m.text)) return null;
  return posted.find((p) => p.chatId === m.chat.id && p.messageId === replyTo) ?? null;
}

// ------------------------------------------------------------- rendering ---

/** Under the Bot API's 4096 with room for the caller's own framing. */
export const PROPOSAL_TEXT_MAX = 3500;

function patchStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  try {
    for (const file of parsePatch(diff)) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) added++;
          else if (line.startsWith('-')) removed++;
        }
      }
    }
  } catch {
    /* an unparsable diff counts as nothing; apply will say why */
  }
  return { added, removed };
}

function opLine(op: ProposalOp): string {
  return match(op)
    .with({ op: 'write' }, (o) => t('learning.opWrite', { path: o.path, chars: o.content.length }))
    .with({ op: 'append' }, (o) => t('learning.opAppend', { path: o.path, chars: o.text.length }))
    .with({ op: 'patch' }, (o) => t('learning.opPatch', { path: o.path, ...patchStats(o.diff) }))
    .with({ op: 'move' }, (o) => t('learning.opMove', { from: o.from, to: o.to }))
    .exhaustive();
}

function opBody(op: ProposalOp): string | null {
  return match(op)
    .with({ op: 'write' }, (o) => o.content)
    .with({ op: 'append' }, (o) => o.text)
    .with({ op: 'patch' }, (o) => o.diff)
    .with({ op: 'move' }, () => null)
    .exhaustive();
}

/**
 * The learning-topic message for a proposal (plain text). When the contents
 * and diffs fit, they are inlined under their op lines; when they do not,
 * `text` is the op list alone and `overflow` the full dump, which the runner
 * sends as a document.
 */
export function renderProposal(p: Proposal, opts: { ttlMs: number }): { text: string; overflow?: string } {
  const hours = Number(((p.ttlMs ?? opts.ttlMs) / 3_600_000).toFixed(1));
  const head = [t('learning.header', { id: p.id, kind: p.kind, agent: p.agent }), p.title, p.summary].filter(Boolean);
  const legend = t('learning.legend', { hours });
  const dump = p.ops
    .map((op) => {
      const body = opBody(op);
      return body === null ? opLine(op) : `${opLine(op)}\n${body.endsWith('\n') ? body.slice(0, -1) : body}`;
    })
    .join('\n\n');
  const full = [...head, '', dump, '', legend].join('\n');
  if (full.length <= PROPOSAL_TEXT_MAX) return { text: full };
  return { text: [...head, '', ...p.ops.map(opLine), '', legend].join('\n'), overflow: `${dump}\n` };
}

// ------------------------------------------------------------------- CLI ---

const USAGE = `learning.mjs — the agent-learning approval gate (JSON out; exit 0 ok, 3 refused, 1 error)

  propose --file <proposal.json>   validate, assign id/createdAt, file into pending/
  list                             every proposal: state, id, kind, agent, title, age
  show <id>                        the proposal as stored
  apply <id>                       apply to the agent's home and move to done/
  reject <id>                      move to done/ as rejected
  wrap <file.md>                   sentence-wrap one file in place
  wrap --agent <name>              sentence-wrap every .md in the home (not memory/.archive)

Store: ~/.config/tg-orchestrator/proposals/{pending,posted,done}; homes: ~/.config/tg-orchestrator/agents/`;

export interface CliEnv {
  readonly root: string;
  readonly agentsRoot: string;
  readonly now: number;
}

/** Every .md file under `dir`, relative paths, skipping memory/.archive and dot-dirs other than .claude. */
function markdownFiles(home: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const d of fs.readdirSync(path.join(home, rel), { withFileTypes: true })) {
      const child = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (child === 'memory/.archive' || d.name === 'node_modules' || d.name === '.git') continue;
        walk(child);
      } else if (d.isFile() && d.name.endsWith('.md')) {
        found.push(child);
      }
    }
  };
  walk('');
  return found.sort();
}

function wrapFile(file: string): { file: string; result: 'changed' | 'unchanged' } {
  const text = nodeLearningFs.readText(file);
  if (text === null) throw new LearningError(`cannot read ${file}`);
  const wrapped = wrapLongLines(text);
  if (wrapped === text) return { file, result: 'unchanged' };
  writeAtomic(file, wrapped);
  return { file, result: 'changed' };
}

const json = <T extends { ok: boolean }>(value: T): CommandOutcome => ({ kind: 'json', value });

export function main(
  argv: readonly string[] = process.argv.slice(2),
  env: CliEnv = { root: CONFIG_ROOT, agentsRoot: path.join(CONFIG_ROOT, 'agents'), now: Date.now() }
): CommandOutcome {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos.shift();
  const need = (v: string | true | undefined, what: string): string => {
    if (v === undefined || v === true || v === '') throw new LearningError(`missing ${what}`);
    return v;
  };

  switch (cmd) {
    case 'propose': {
      const file = need(opts['file'], '--file');
      const text = nodeLearningFs.readText(file);
      if (text === null) throw new LearningError(`cannot read ${file}`);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        throw new LearningError(`${file}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      const parsed = ProposalInputSchema.safeParse(raw);
      if (!parsed.success) throw new LearningError(`${file}: ${z.prettifyError(parsed.error)}`);
      const proposal: Proposal = {
        ...parsed.data,
        id: parsed.data.id ?? newProposalId(env.now),
        createdAt: parsed.data.createdAt ?? env.now,
      };
      const reasons = checkProposalPaths(proposal);
      if (reasons.length) throw new LearningError(`${file}: refused paths:\n${reasons.join('\n')}`);
      if (readProposal(env.root, proposal.id).kind !== 'missing') {
        throw new LearningError(`proposal ${proposal.id} already exists`);
      }
      ensureStore(env.root);
      writeProposal(env.root, 'pending', proposal);
      return json({ ok: true, id: proposal.id });
    }
    case 'list': {
      const { proposals, broken } = listProposals(env.root);
      return json({
        ok: true,
        proposals: proposals.map(({ state, proposal: p }) => ({
          state,
          id: p.id,
          kind: p.kind,
          agent: p.agent,
          title: p.title,
          age: human(env.now - p.createdAt),
          ...(p.outcome ? { outcome: p.outcome } : {}),
        })),
        broken,
      });
    }
    case 'show': {
      const r = readProposal(env.root, need(pos[0], 'id'));
      return match(r)
        .with({ kind: 'missing' }, ({ id }) => {
          throw new LearningError(`no proposal ${id}`);
        })
        .with({ kind: 'broken' }, (b) => json({ ok: false, state: b.state, id: b.id, error: b.error }))
        .with({ kind: 'ok' }, (s) => json({ ok: true, state: s.state, proposal: s.proposal }))
        .exhaustive();
    }
    case 'apply':
    case 'reject': {
      const id = need(pos[0], 'id');
      const r =
        cmd === 'apply'
          ? applyProposal(env.root, env.agentsRoot, id, { now: env.now })
          : rejectProposal(env.root, id, { now: env.now });
      return json(r);
    }
    case 'wrap': {
      if (opts['agent'] !== undefined) {
        const name = need(opts['agent'], '--agent');
        if (!NAME_RE.test(name)) throw new LearningError(`bad agent name ${JSON.stringify(name)}`);
        const home = path.join(env.agentsRoot, name);
        if (!nodeLearningFs.isDirectory(home)) throw new LearningError(`no home for agent ${name} at ${home}`);
        const files = markdownFiles(home).map((rel) => ({ ...wrapFile(path.join(home, rel)), file: rel }));
        return json({ ok: true, agent: name, files });
      }
      return json({ ok: true, ...wrapFile(need(pos[0], 'file')) });
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'text', text: `${USAGE}\n` };
    default:
      throw new LearningError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

export function runCli(argv: readonly string[] = process.argv.slice(2)): number {
  return runCommand(() => main(argv), (e) => e instanceof LearningError);
}
