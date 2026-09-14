// English catalogue — the default locale (TG_LOCALE unset) and the fallback
// for anything a translation forgets. It is `en` that defines the key set:
// test/i18n.test.ts asserts every other catalogue has exactly these keys and
// exactly these {{placeholders}} in each of them.
//
// The wording is natural English, not a gloss of the Russian — but the SHAPE
// is the same: no plural forms (both catalogues say "1 calls" in their own
// language today; proper plurals are a later change with their own fixtures),
// and on the status screen each line carries its own label and column padding.
//
// One deliberate divergence: the Russian /help lists the flush words inline,
// because they are Russian words the owner types. English points at the
// setting instead — the words themselves are configuration now
// (TG_FLUSH_WORDS), not text.
export const en = {
  help: {
    body:
      'Personal orchestrator. Write or record a voice note — what is happening in a project, ' +
      'where some script lives, what I did about X, create a topic, send a file, run something.\n' +
      'Messages pile up until you stay quiet for {{settleMin}} min, so you can write in a series. ' +
      'Done sooner? Send a flush word as its own message (TG_FLUSH_WORDS): ' +
      'the window closes at once and the word itself never reaches the agent.\n' +
      '/reset — clear this topic, /status — is the daemon alive',
  },
  turn: {
    slowWarning:
      '⏳ This turn is taking longer than usual: {{elapsedMin}} min so far. ' +
      'In {{leftMin}} min I will stop it on the timeout ' +
      '(limit {{limitMin}} min, TG_CLAUDE_TIMEOUT_MS).',
    failed: '⚠️ Could not handle it: {{error}}',
    modelFallback:
      '⚠️ {{from}} is out of usage credits — this turn and the next ones run on {{to}}. ' +
      'I will try {{from}} again in {{ttlMin}} min ' +
      '(TG_CLAUDE_FALLBACK_MODEL / TG_CLAUDE_FALLBACK_TTL_MS).',
    modelRecovered: '✅ {{model}} answers again — back on it.',
  },
  reset: {
    done: '🔄 Context cleared. The turn in flight finishes on the old context, the next one starts from scratch.',
    doneThisTopic: '🔄 Context of this topic cleared.',
  },
  status: {
    alive: '🟢 alive: pid {{pid}}, uptime {{uptimeMin}} min, topics with context: {{topics}}{{usage}}{{busy}}',
    usageToday: 'today: {{calls}} calls, ${{cost}}',
    usageTodayWithFails: 'today: {{calls}} calls, ${{cost}}, failed: {{fails}}',
    inflight: 'in flight: {{keys}}',
    inflightWithQueue: 'in flight: {{keys}}, {{queued}} queued',
    modelFallback: 'model: {{model}} (fallback — {{primary}} is out of usage credits)',
  },
  wake: {
    failedToProcessFailed:
      '⚠️ Background job "{{job}}" failed and I could not process it. Raw result:',
    failedToProcessFinished:
      '⚠️ Background job "{{job}}" finished and I could not process it. Raw result:',
    emptyPayload: '(empty)',
    fullOutput: 'Full output: {{file}}',
    badRecord: '⚠️ Broken record in the wake spool: {{file}} ({{error}})',
    noAddress:
      '⚠️ Wake-spool record with nowhere to answer (convo={{convo}}): "{{job}}". ' +
      'Left in wake/done/{{file}}.bad',
  },
  recovery: {
    tooOld:
      '⚠️ Message {{msgId}} from {{at}} was left unanswered ' +
      'when the runner died, and is too old to replay — write again if it still matters.',
  },
  duration: {
    seconds: '{{s}}s',
    minutes: '{{m}}m{{s}}s',
    hours: '{{h}}h{{m}}m',
  },
  statusCli: {
    daemonUp: 'Daemon    🟢 pid {{pid}}, uptime {{etime}}',
    daemonDown: 'Daemon    🔴 NOT RUNNING (ensure.sh brings it back within 5 min, or start it by hand)',
    phaseLine: 'Phase     {{desc}}{{stale}}',
    phaseIdle: 'idle — waiting for messages (since {{at}})',
    phaseBurst: 'burst — collecting a run: {{msgs}} msg, window open for {{age}}',
    phaseDraining:
      'draining — finishing {{turns}} turn(s){{queued}}, taking no new work, then exiting for a restart',
    phaseClaudeParallel: 'claude — {{turns}} turns in parallel{{queued}}',
    phaseClaudeOne: 'claude — working on {{convo}} ({{msgs}} msg), {{age}} so far{{queued}}',
    phaseOther: '{{phase}} ({{at}})',
    queued: ', {{queued}} queued',
    stalePid: ' ⚠️ (from an old pid)',
    turnLine: 'Turn      {{key}} · {{what}} · {{age}} so far',
    turnWake: 'wake job',
    turnMsgs: '{{size}} msg',
    burstAlso: '          + collecting a run: {{msgs}} msg, window open for {{age}}',
    callLine: 'Call      claude pid {{pid}} · elapsed {{etime}} · cpu {{cpu}}%',
    callMissing: 'Call      ⚠️ phase is claude but no process — the runner was probably killed mid-call',
    pendingLine: 'Telegram  undelivered on the server: {{pending}}{{waiting}}',
    pendingWaiting: ' ⚠️ (waiting for the daemon to free up / wake up)',
    sessionsLine: 'Sessions  {{topics}} topics with context · freshest {{key}} ({{age}} ago)',
    usageRoll: '{{calls}} calls · ${{cost}} · avg {{avg}} · max {{max}}{{fails}}',
    usageFails: ' · {{fails}} failed',
    usageToday: 'Usage     today:  {{roll}}',
    usageWeek: '          7 days: {{roll}}',
    logHeading: 'Log       latest events:',
  },
} as const;
