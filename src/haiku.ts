// The one tool-less headless model call this repo makes, in two places: the
// split planner behind tg-send.sh (split-plan.ts, synchronous — it is a CLI) and
// the guest classifier inside the daemon (guest-classify.ts, asynchronous — the
// runner is a long-lived event loop, and a spawnSync there would freeze polling
// for as long as the model thinks). The invocation and the reading of the JSON
// envelope are shared here so the two cannot drift; how the child is spawned is
// each caller's own.
import { execFile } from 'node:child_process';
import os from 'node:os';

/**
 * The argument list, the invocation shape of scripts/guard_common.py:85-90.
 * `extra` goes before the system prompt; the planner passes none.
 */
export function haikuArgs(systemPrompt: string, extra: readonly string[] = []): string[] {
  // --setting-sources '': no user/project settings, so none of the owner's
  // hooks, plugins or CLAUDE.md load into this call — measured 08.10.2026 at
  // 569 input tokens against 5567 with them. --bare would cut more but never
  // reads OAuth, and this machine is logged in with OAuth.
  return ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--setting-sources', '', '--output-format', 'json', ...extra, '--system-prompt', systemPrompt];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface ModelAnswer {
  /** The first `{…}` object in the model's text, parsed. */
  readonly raw: unknown;
  readonly inputTokens: number | null;
}

/** `claude --output-format json` stdout → the JSON the model wrote, or why not. */
export function readEnvelope(stdout: string): ModelAnswer | string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return `unparsable envelope: ${stdout.trim().slice(0, 200)}`;
  }
  if (typeof envelope !== 'object' || envelope === null) return 'envelope is not an object';
  const result = 'result' in envelope ? String(envelope.result) : '';
  if ('is_error' in envelope && envelope.is_error === true) return `model error: ${result.slice(0, 200)}`;
  const usage = 'usage' in envelope && typeof envelope.usage === 'object' && envelope.usage !== null ? envelope.usage : null;
  const inputTokens = usage
    ? num('input_tokens' in usage ? usage.input_tokens : 0) +
      num('cache_creation_input_tokens' in usage ? usage.cache_creation_input_tokens : 0) +
      num('cache_read_input_tokens' in usage ? usage.cache_read_input_tokens : 0)
    : null;
  const start = result.indexOf('{');
  const end = result.lastIndexOf('}');
  if (start < 0 || end < start) return `no JSON in the answer: ${result.slice(0, 200)}`;
  try {
    return { raw: JSON.parse(result.slice(start, end + 1)), inputTokens };
  } catch {
    return `invalid JSON in the answer: ${result.slice(0, 200)}`;
  }
}

/**
 * The asynchronous call: the prompt on stdin, cwd the temp dir (no project
 * CLAUDE.md to pick up), killed at `timeoutMs`. Never rejects — every failure
 * comes back as the string that explains it.
 */
export function askHaikuAsync(
  bin: string,
  args: readonly string[],
  input: string,
  timeoutMs: number
): Promise<ModelAnswer | string> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      [...args],
      { cwd: os.tmpdir(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) return resolve(`${bin}: timed out after ${timeoutMs} ms`);
          const rc = typeof error.code === 'number' ? `rc=${error.code}` : String(error.code ?? error.message);
          return resolve(`${bin} ${rc}: ${(stderr || stdout || error.message).trim().slice(-200)}`);
        }
        resolve(readEnvelope(stdout));
      }
    );
    // A binary that is missing or dies at once closes its stdin under us; that
    // EPIPE is the same failure the callback above already reports.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
