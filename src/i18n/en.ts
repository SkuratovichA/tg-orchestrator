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
// Both catalogues now point at the setting rather than listing flush words:
// there are none by default (a reaction on a pending message closes the burst
// window instead), and whatever TG_FLUSH_WORDS holds is configuration, not
// text — the Russian /help keeps two of the old words as an example of the
// shape, nothing more.
export const en = {
  help: {
    body:
      'Personal orchestrator. Write or record a voice note — what is happening in a project, ' +
      'where some script lives, what I did about X, create a topic, send a file, run something.\n' +
      'Messages pile up until you stay quiet for {{settleMin}} min, so you can write in a series. ' +
      'Done sooner? React to any of your pending messages with any emoji — the window closes at once. ' +
      'Trigger words do the same, if you set TG_FLUSH_WORDS.\n' +
      '/reset — clear this topic, /status — is the daemon alive',
  },
  autoTopic: {
    pointer: '→ {{name}}\n{{link}}',
    voice: '[voice {{seconds}}s]',
    videoNote: '[video note {{seconds}}s]',
    photo: '[photo]',
    file: '[file {{name}}]',
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
    limitDeferred: '⏸ "{{job}}": hit the account limit, will retry at {{time}}',
    limitGaveUp: 'The account limit held through {{count}} retries — delivering it as is.',
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
  // The approval gate's message in the learning topic (learning.ts renderProposal).
  learning: {
    header: '#{{id}} · {{kind}} · {{agent}}',
    opWrite: 'write {{path}} ({{chars}} chars)',
    opAppend: 'append {{path}} (+{{chars}} chars)',
    opPatch: 'patch {{path}} (+{{added}}/-{{removed}} lines)',
    opMove: 'move {{from}} → {{to}}',
    legend: '👍 apply · 👎 reject · silence {{hours}} h = apply',
    // The runner's own messages in the learning topic (runner.ts, the gate pass).
    documentCaption: 'Full dump of #{{id}}',
    applyFailed: '#{{id}}: {{error}}',
    // Not a message: the replies to a proposal that reject it, `|`-separated.
    // learning.ts accepts the words of EVERY catalogue, whatever the locale.
    rejectReplies: 'no|nope',
  },
  // The live status message (src/live-status.ts): one message per turn, edited
  // in place while the turn runs and deleted when it ends.
  liveStatus: {
    head: '⏳ {{elapsed}} · step {{steps}}',
    thinking: 'thinking',
    before: 'before that: {{items}}',
    agents: 'agents ({{count}}): {{items}}',
    read: 'reading {{target}}',
    edit: 'editing {{target}}',
    run: 'running: {{target}}',
    search: 'searching for {{target}}',
    web: 'on the web: {{target}}',
    agent: 'agent: {{target}}',
    message: 'messaging {{target}}',
    plan: 'planning',
    skill: 'loading skill {{target}}',
    telegram: 'telegram: {{target}}',
    mcp: 'mcp {{target}}',
    tool: '{{target}}',
  },
} as const;
