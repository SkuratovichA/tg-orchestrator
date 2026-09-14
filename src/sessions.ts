// What was I working on, across every Claude project on this machine?
//
//   sessions.mjs recent [N]          latest sessions, newest first (default 15)
//   sessions.mjs search <words…>     find sessions by opening prompt / project
//   sessions.mjs show <id-prefix>    one session: opening prompt + last replies
//
// The reading itself — which config dirs count as accounts, the 64 KB head and
// 48 KB tail windows that keep a listing of 400 megabyte-sized transcripts
// cheap, the `~`-folded project path, every column width — lives in
// @tagents/core's transcript reader, which was ported FROM this file. What is
// left here is the CLI: the grammar, the two usage lines, and the exit codes.
//
// The rendered text is a contract (an agent reads it out of a shell and
// paraphrases it into Telegram), so this file prints exactly what core renders
// and adds nothing: test/contract/fixtures/sessions/* is the oracle.
import { renderRecent, renderSearch, renderShow, SESSIONS_PROGRAM } from '@tagents/core';

const USAGE = `usage: ${SESSIONS_PROGRAM} [recent [N] | search <words…> | show <id-prefix>]`;

/** Runs one invocation and returns its exit code. Prints, never throws. */
export function main(argv: readonly string[]): number {
  const [cmd, ...args] = argv;

  if (cmd === 'recent' || cmd === undefined) {
    process.stdout.write(renderRecent(Number(args[0]) || 15));
    return 0;
  }

  if (cmd === 'search') {
    if (!args.join(' ')) {
      process.stderr.write(`usage: ${SESSIONS_PROGRAM} search <words…>\n`);
      return 1;
    }
    process.stdout.write(renderSearch(args));
    return 0;
  }

  if (cmd === 'show') {
    const prefix = args[0];
    if (!prefix) {
      process.stderr.write(`usage: ${SESSIONS_PROGRAM} show <id-prefix>\n`);
      return 1;
    }
    const text = renderShow(prefix);
    if (text === null) {
      process.stderr.write(`no session starts with "${prefix}"\n`);
      return 1;
    }
    process.stdout.write(text);
    return 0;
  }

  process.stdout.write(`${USAGE}\n`);
  return 0;
}

// A CLI, the way sessions.mjs has always been: importing it runs it. exitCode
// rather than exit(), so a long listing cannot be truncated on its way out.
process.exitCode = main(process.argv.slice(2));
