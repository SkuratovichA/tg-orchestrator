// The tagents plugin: what this repo IS, to a host that can run it.
//
// A plugin is data — a name, an api version, a catalogue, the services it can
// run and the verbs it offers — and the host walks it without executing
// anything beyond the import. So nothing here starts, opens or reads at import
// time; `services[0].start` is the only door into the daemon, and it is the one
// src/runner.mjs (launchd's entry point, through @tagents/core's runService)
// goes through.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { definePlugin, type CliCommand, type PluginContext, type ServiceHandle } from '@tagents/core';
import { z } from 'zod';
import { resolveLocale } from './config.ts';
import { getI18n, resources } from './i18n/index.ts';
import { CONFIG_ROOT, startRunner } from './runner.ts';
import { statusReply } from './status-reply.ts';

// --- the status verb --------------------------------------------------------
// The same sentence /status answers in Telegram, for a terminal. It asks the
// DAEMON's files rather than a model or the Bot API, so it works while the
// daemon is busy and costs nothing.

const StatusFile = z
  .looseObject({
    turns: z.array(z.looseObject({ key: z.string() })).optional(),
    queued: z.number().optional(),
    // Written by the daemon ONLY while the usage-limit model fallback is
    // active. Forwarded below so the terminal and the topic say the same
    // sentence about which model is answering — the whole point of this module.
    modelFallback: z.looseObject({ model: z.string(), primary: z.string() }).optional(),
  })
  .catch({});

const StateFile = z
  .looseObject({ sessions: z.record(z.string(), z.unknown()).catch({}).prefault({}) })
  .catch({ sessions: {} });

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/** Seconds this pid has been alive, the way status.mjs asks for them. 0 if it is not. */
function uptimeSeconds(pid: number): number {
  if (!pid) return 0;
  try {
    return Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)]).toString().trim()) || 0;
  } catch {
    return 0;
  }
}

const StatusArgs = z.object({});

const status: CliCommand<typeof StatusArgs> = {
  name: 'status',
  describe: 'what the Telegram daemon is doing, as /status answers it',
  args: StatusArgs,
  run: async (_args, ctx: PluginContext): Promise<number> => {
    // The daemon picks its locale once, from its own env file; a status screen
    // in a different language from the topic it describes would be its own bug.
    getI18n(resolveLocale({ envFile: path.join(CONFIG_ROOT, 'env') }));
    const pid = Number(readText(path.join(CONFIG_ROOT, 'runner.pid'))) || 0;
    const live = StatusFile.parse(readJson(path.join(CONFIG_ROOT, 'status.json')));
    const state = StateFile.parse(readJson(path.join(CONFIG_ROOT, 'state.json')));
    // status.json carries the key only while the fallback is on, so its mere
    // presence IS `active` — there is no clock to consult from out here.
    const fb = live.modelFallback;
    ctx.log(
      statusReply({
        pid,
        uptimeMin: Math.round(uptimeSeconds(pid) / 60),
        topics: Object.keys(state.sessions).length,
        inflight: (live.turns ?? []).map((turn) => turn.key),
        queued: live.queued ?? 0,
        ledgerFile: path.join(CONFIG_ROOT, 'usage.jsonl'),
        ...(fb === undefined
          ? {}
          : {
              fallback: {
                primary: fb.primary,
                fallback: fb.model,
                active: true,
                since: null,
                until: null,
              },
            }),
      })
    );
    return 0;
  },
};

// --- the plugin -------------------------------------------------------------

export default definePlugin({
  name: 'telegram',
  apiVersion: 1,
  // The catalogue the daemon already had, under its own 'tg' namespace: core's
  // strings stay core's and neither can shadow the other.
  locales: resources,
  services: [
    {
      name: 'runner',
      /**
       * The daemon. `ctx.driver` is the session backend the host owns — a
       * plugin never spawns `claude` itself — and everything else the runner
       * needs (its config dir, its log file, its locale) it reads where it has
       * always read it: ~/.config/tg-orchestrator. Its log deliberately does
       * NOT go through ctx.log: runner.log is a file with a format other tools
       * grep, and stdout is where ensure.sh redirects that same file.
       */
      start: async (ctx: PluginContext): Promise<ServiceHandle> => {
        const runner = await startRunner({ driver: ctx.driver });
        return {
          drain: runner.drain,
          stop: (reason?: string): void => runner.stop(reason ?? 'stop'),
          done: runner.done,
        };
      },
    },
  ],
  commands: [status],
});
