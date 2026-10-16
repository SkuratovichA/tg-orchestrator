// Agent homes (docs/agent-learning.md §1): an agent is a directory under
// ~/.config/tg-orchestrator/agents/<name>/, and a turn runs with cwd = that
// directory, so Claude Code picks up the home's CLAUDE.md, .claude/settings.json
// (autoMemoryDirectory), rules and skills on its own.
//
// Published as `@tagents/plugin-telegram/agent-home` (17.09.2026): another runner
// passes its own agents root and its own default agent.
//
// Which agent answers a topic: every home may carry a `topics` file, one
// `chat_id:thread_id` per line; the first agent (names sorted) that lists the
// key owns it, and a key nobody lists belongs to `deps.defaultAgent` (here:
// `orchestrator`). The brain is `<home>/brain.md` when it exists, else
// `deps.defaultBrain`.
//
// The resolver is pure over an injected `AgentHomeFs`; `nodeAgentHomeFs` is the
// thin disk layer the runner passes in.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The agent that answers every topic nobody else claims, unless the caller names another. */
export const DEFAULT_AGENT = 'orchestrator';

/** A topic key as the runner builds it: `${chat.id}:${message_thread_id ?? 0}`. */
const TopicKey = z.string().regex(/^-?\d+:\d+$/);
/** `chat_id:*` — every topic of a chat; only read when a caller opts in (ResolveDeps.chatWildcards). */
const ChatWildcard = z.string().regex(/^-?\d+:\*$/);

/** The reads the resolver needs; every one of them answers "absent" instead of throwing. */
export interface AgentHomeFs {
  /** Names of the subdirectories of `dir`; [] when `dir` does not exist. */
  listDirs(dir: string): string[];
  /** The file's text, or null when it cannot be read. */
  readText(file: string): string | null;
  exists(file: string): boolean;
}

export interface ResolvedAgent {
  readonly name: string;
  /** The turn's cwd. */
  readonly home: string;
  /** --append-system-prompt-file for the turn. */
  readonly brainFile: string;
}

export interface ResolveDeps {
  /** The agent that answers every topic nobody else claims; DEFAULT_AGENT when omitted. */
  readonly defaultAgent?: string;
  /** The brain of an agent without brain.md (the orchestrator: the repo's agent.md). */
  readonly defaultBrain: string;
  readonly fs: AgentHomeFs;
  /**
   * Also read `chat_id:*` lines (added 17.09.2026 for a runner whose homes are
   * per audience, i.e. per chat). An exact `chat_id:thread_id` line in
   * ANY home wins over a wildcard; among wildcards the sorted-first name wins.
   * Off by default, so a topics file that never meant it keeps resolving as before.
   */
  readonly chatWildcards?: boolean;
}

/**
 * The keys a `topics` file lists: trimmed lines, `#` comments (whole-line or
 * trailing) and blank lines dropped, and anything that is not a
 * `chat_id:thread_id` key ignored rather than half-matched.
 */
export function parseTopicsFile(text: string, o: { readonly chatWildcards?: boolean } = {}): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => TopicKey.safeParse(line).success || (o.chatWildcards === true && ChatWildcard.safeParse(line).success));
}

/** The agent that owns `key`, its home and its brain. */
export function resolveAgent(agentsRoot: string, key: string, deps: ResolveDeps): ResolvedAgent {
  const names = [...deps.fs.listDirs(agentsRoot)].sort();
  const wildcards = deps.chatWildcards === true;
  const listed = new Map(
    names.map((name) => {
      const text = deps.fs.readText(path.join(agentsRoot, name, 'topics'));
      return [name, text === null ? [] : parseTopicsFile(text, { chatWildcards: wildcards })] as const;
    })
  );
  const chatWide = `${key.split(':')[0]}:*`;
  const owner =
    names.find((name) => listed.get(name)?.includes(key)) ??
    (wildcards ? names.find((name) => listed.get(name)?.includes(chatWide)) : undefined);
  const name = owner ?? deps.defaultAgent ?? DEFAULT_AGENT;
  const home = path.join(agentsRoot, name);
  const brain = path.join(home, 'brain.md');
  return { name, home, brainFile: deps.fs.exists(brain) ? brain : deps.defaultBrain };
}

export const nodeAgentHomeFs: AgentHomeFs = {
  listDirs(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
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
  exists: (file) => fs.existsSync(file),
};
