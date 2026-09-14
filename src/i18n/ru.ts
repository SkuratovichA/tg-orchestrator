// Russian catalogue — the owner's own language and, until stage S2, the only
// one the daemon had. Every value here is the literal that used to sit in
// runner.mjs or status.mjs, character for character: punctuation, emoji,
// «guillemets», the trailing spaces that used to come from string
// concatenation, the exact column padding of the status screen. The contract
// fixtures (test/contract/fixtures/runner, .../status) are recorded from the
// pre-i18n code and compare bytes, so anything reworded here fails the suite —
// which is the point. Rewording is a separate change with its own fixtures.
//
// This is also the ONE file in src/ that is allowed to contain Cyrillic
// (test/contract/strings.snapshot.test.mjs enforces it), the flush-word
// default in config.ts aside — those are input, not output.
export const ru = {
  help: {
    body:
      'Личный оркестратор. Пиши текстом или голосом — что происходит в проектах, где какой скрипт, ' +
      'что я делал по теме X, создай топик, отправь файл, запусти что-то.\n' +
      'Сообщения копятся, пока ты не замолчишь на {{settleMin}} мин — можно писать серией. ' +
      'Закончил мысль раньше — отдельным сообщением «читай» (ещё: го, ответь, всё, /answer): ' +
      'окно закрывается сразу, само слово в агента не уходит.\n' +
      '/reset — сбросить контекст топика · /status — жив ли демон',
  },
  turn: {
    slowWarning:
      '⏳ Ход идёт дольше обычного: уже {{elapsedMin}} мин. ' +
      'Через {{leftMin}} мин прерву его по таймауту ' +
      '(лимит {{limitMin}} мин, TG_CLAUDE_TIMEOUT_MS).',
    failed: '⚠️ Не смог обработать: {{error}}',
    modelFallback:
      '⚠️ У {{from}} кончились usage credits — этот ход и следующие идут на {{to}}. ' +
      'Снова попробую {{from}} через {{ttlMin}} мин ' +
      '(TG_CLAUDE_FALLBACK_MODEL / TG_CLAUDE_FALLBACK_TTL_MS).',
    modelRecovered: '✅ {{model}} снова отвечает — вернулся на неё.',
  },
  reset: {
    done: '🔄 Контекст сброшен. Текущий ход дойдёт на старом контексте, следующий начнётся с чистого листа.',
    doneThisTopic: '🔄 Контекст этого топика сброшен.',
  },
  status: {
    alive:
      '🟢 живой: pid {{pid}}, аптайм {{uptimeMin}} мин, ' +
      'топиков с контекстом: {{topics}}{{usage}}{{busy}}',
    usageToday: 'сегодня: {{calls}} вызовов, ${{cost}}',
    usageTodayWithFails: 'сегодня: {{calls}} вызовов, ${{cost}}, ошибок: {{fails}}',
    inflight: 'в работе: {{keys}}',
    inflightWithQueue: 'в работе: {{keys}}, в очереди {{queued}}',
    modelFallback: 'модель: {{model}} (фолбэк — у {{primary}} кончились usage credits)',
  },
  wake: {
    // Two whole sentences rather than one with a «упала»/«закончилась» hole:
    // a catalogue that assembles sentences from fragments cannot be
    // translated, only reproduced.
    failedToProcessFailed:
      '⚠️ Фоновая задача «{{job}}» упала, но я не смог её обработать. Сырой результат:',
    failedToProcessFinished:
      '⚠️ Фоновая задача «{{job}}» закончилась, но я не смог её обработать. Сырой результат:',
    emptyPayload: '(пусто)',
    fullOutput: 'Полный вывод: {{file}}',
    badRecord: '⚠️ Битая запись в wake-спуле: {{file}} ({{error}})',
    noAddress:
      '⚠️ Запись в wake-спуле без адреса (convo={{convo}}): «{{job}}». ' +
      'Лежит в wake/done/{{file}}.bad',
  },
  recovery: {
    tooOld:
      '⚠️ Сообщение {{msgId}} от {{at}} осталось без ответа ' +
      'после падения раннера и слишком старое для автоповтора — напиши ещё раз, если актуально.',
  },
  // fmtDur in status.mjs: the unit letters are text, so they live here too.
  duration: {
    seconds: '{{s}}с',
    minutes: '{{m}}м{{s}}с',
    hours: '{{h}}ч{{m}}м',
  },
  // The status screen. Each line is one key INCLUDING its label and the
  // padding that aligns the second column — a translation gets to choose its
  // own label width, which it could not if the padding lived in the renderer.
  statusCli: {
    daemonUp: 'Демон     🟢 pid {{pid}}, аптайм {{etime}}',
    daemonDown: 'Демон     🔴 НЕ ЗАПУЩЕН (ensure.sh поднимет за ≤5 мин, или запусти руками)',
    phaseLine: 'Фаза      {{desc}}{{stale}}',
    phaseIdle: 'idle — жду сообщений (с {{at}})',
    phaseBurst: 'burst — копится пачка: {{msgs}} сообщ., окно открыто {{age}}',
    phaseDraining:
      'draining — доделываю {{turns}} ход(а){{queued}}, новых не беру, потом выйду для рестарта',
    phaseClaudeParallel: 'claude — {{turns}} хода параллельно{{queued}}',
    phaseClaudeOne: 'claude — обрабатываю {{convo}} ({{msgs}} сообщ.), уже {{age}}{{queued}}',
    phaseOther: '{{phase}} ({{at}})',
    queued: ', в очереди {{queued}}',
    stalePid: ' ⚠️ (от старого pid)',
    turnLine: 'Ход       {{key}} · {{what}} · уже {{age}}',
    turnWake: 'wake-задача',
    turnMsgs: '{{size}} сообщ.',
    burstAlso: '          + копится пачка: {{msgs}} сообщ., окно открыто {{age}}',
    callLine: 'Вызов     claude pid {{pid}} · elapsed {{etime}} · cpu {{cpu}}%',
    callMissing: 'Вызов     ⚠️ фаза claude, но процесса нет — вероятно, раннер убит посреди вызова',
    pendingLine: 'Telegram  недоставленных на сервере: {{pending}}{{waiting}}',
    pendingWaiting: ' ⚠️ (ждут, пока демон освободится/проснётся)',
    sessionsLine: 'Сессии    {{topics}} топиков с контекстом · свежайшая {{key}} ({{age}} назад)',
    usageRoll: '{{calls}} вызовов · ${{cost}} · ср {{avg}} · макс {{max}}{{fails}}',
    usageFails: ' · ошибок {{fails}}',
    usageToday: 'Usage     сегодня: {{roll}}',
    usageWeek: '          7 дней:  {{roll}}',
    logHeading: 'Лог       последние события:',
  },
} as const;
