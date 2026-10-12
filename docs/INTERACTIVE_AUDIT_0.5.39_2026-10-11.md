# Интерактивное выполнение: аудит 0.5.39, 11 октября 2026

Проверены изменённые исходники подготовки 0.5.39 поверх актуальной основы
`7e75dec` ветки `codex/vps-persistent-compute`. Итоговый коммит, общий прогон
и push указываются в основном отчёте. Этот документ не переносит результаты
предыдущего аудита 0.5.38 на новую реализацию.

## Воспроизведения и исправления

| Ошибка | Воспроизведение до исправления | Изменение и проверка |
|---|---|---|
| Следующая ячейка повторно использовала умершее ядро. | Реальный дочерний Node-процесс изображает bridge: сначала `complete` с `KernelDied`, затем отложенные `fatal`/exit. Немедленная следующая ячейка получила `success=false`; регрессия упала на `false !== true`. Это проверка реального процесса и порядка протокола, а не настоящий Jupyter в этой конкретной регрессии. | Bridge снимается с текущего владения до разрешения failed completion. Старые события не меняют replacement. Проверены протокольная регрессия и отдельный настоящий Jupyter: `os._exit(23)`, failed result, затем успешная новая ячейка. |
| Старое согласие могло остановить новое выполнение с тем же run ID. | Реальный `SessionRuntime` выдаёт challenge; запись владельца заменяется новой записью с тем же `runId` и notebook/compute scope. До изменения `applyExecutionStop(..., 'CONFIRM')` не отклонял запрос и вызывал stop replacement. | Challenge содержит случайное поколение конкретной записи владельца. Исполнитель сравнивает его при применении; совпадения одного run ID недостаточно. Новое поколение не наследует подтверждение. Подготовка и принятие одного запуска сохраняют тот же объект владельца и поколение. |
| Время remote preparation в подтверждении было неизвестно или начиналось заново. | После `reserveRemoteExecutionOwner` поле `startedAt` было `undefined`; регрессия ожидала числовое время. Диалог подставлял текущее время при каждом запросе. | Время фиксируется при резервировании. Переход к исполнению сохраняет его, поэтому elapsed включает подготовку. Регрессия проверяет соответствие owner/challenge. |
| После смерти ядра оставался redirected worker. | Настоящее ядро запустило Python subprocess с stdout/stderr в `/dev/null`, записало PID и вызвало `os._exit(23)`. После `KernelDied` и ещё одной секунды проверка процесса дала `workerAlive=true`. | На Linux cleanup запоминает членов принадлежащей ядру process group как PID + `/proc` starttime, посылает TERM и через 750 мс эскалирует до KILL только при сохранении исходного живого участника группы. Опустевшая группа не разрешает эскалацию в группу с повторно использованным PGID. Новое ядро ждёт cleanup. Настоящая регрессия использует worker, игнорирующий TERM; после смерти ядра replacement работает, worker прекращён, отдельный посторонний `sleep` остаётся жив. |

Изменены только:

- [pythonKernel.ts](../src/core/pythonKernel.ts): немедленное восстановление и очистка принадлежащих failed kernel процессов;
- [session.ts](../src/runtime/session.ts): поколение owner в CONFIRM и стабильное время remote admission;
- [pythonKernel.test.ts](../test/pythonKernel.test.ts) и [interactiveStopProtection.test.ts](../test/interactiveStopProtection.test.ts): регрессии.

Остановка descendants после системного отказа ядра является cleanup уже
ошибочного исполнения. Она не заменяет CONFIRM для пользовательского
прерывания работающего вычисления. Отказ cleanup публикуется как protocol
error и не позволяет незаметно запустить replacement.

## Проверенные границы жизненного цикла

В штатных API Stop/Interrupt/Restart, Ctrl+C, выход, окончание сессии,
передача хоста и изменение compute используют отдельный challenge либо
отвергают прямой разрушительный вызов при активной работе. Проверяются
точная строка `CONFIRM`, identity, action/scope, expiry, host authority,
список run IDs, поколение owner и compute epoch. Повтор применённой операции
не выполняет остановку повторно. Изменение notebook scope, новый run или
новый shell во время диалога требуют нового подтверждения.

Реальные проверки включают игнорирование interrupt/TERM и остановку
redirected subprocess после CONFIRM. Модель ввода shell остаётся прежней:
вводит текущий хост, гости наблюдают вывод; удалённый `shellInput` RPC
отвергается. Закрытие представления native terminal снимает наблюдение,
само по себе не является подтверждённой остановкой shell.

У принятых local/remote execute нет таймера общей длительности. Сохранены
лимиты подключения, startup, приёма/доставки, ресурсов и времени эскалации
уже разрешённой остановки. Потеря связи наблюдателя не удаляет active/replay
ownership; принятая remote observation остаётся ожидающей при потере route.
Эти проверки не являются новым многочасовым soak test.

## Финальная целевая проверка

Один консолидированный прогон после последнего изменения:
**42 TypeScript-теста прошли, 0 failed, 0 skipped, фактическое время 22 с**.
Повторные прогоны не увеличивают количество уникальных тестов. Проверены
шесть suites: `pythonKernel`, `interactiveStopProtection`,
`sharedTerminalLifecycle`, `sharedTerminalUi`, `sharedTerminalUiRecovery`,
`sharedTerminal`.

Компиляция выполнялась в отдельную `/tmp`-папку, не изменяя основной
`out`. Для сохранения путей fixtures использовались ссылки на repository
`media` и `node_modules`. Команда проверяла compiled production source:

```bash
./node_modules/.bin/tsc -p tsconfig.json --outDir /tmp/pair-interactive-regressions
PATH=/workspace/validation-env/bin:$PATH \
PAIR_NOTEBOOK_TEST_PYTHON=/workspace/validation-env/bin/python \
./node_modules/.bin/mocha --timeout 25000 --forbid-pending --exit \
  /tmp/pair-interactive-regressions/test/pythonKernel.test.js \
  /tmp/pair-interactive-regressions/test/interactiveStopProtection.test.js \
  /tmp/pair-interactive-regressions/test/sharedTerminalLifecycle.test.js \
  /tmp/pair-interactive-regressions/test/sharedTerminalUi.test.js \
  /tmp/pair-interactive-regressions/test/sharedTerminalUiRecovery.test.js \
  /tmp/pair-interactive-regressions/test/sharedTerminal.test.js
```

В execution tool для реальных child processes/Jupyter было предоставлено
`network.enabled=true`. В исходном ограниченном sandbox child Node не
возвращал stdout, а Jupyter sockets получали `EPERM`; эти ограничения среды
не учитываются как дефекты production. Финальный журнал сохранён в
`/tmp/pair-interactive-final.log`. Targeted ESLint и `git diff --check`
прошли. Общая проверка финальной сборки фиксируется в основном отчёте.

Подменённая граница runtime/UI tests — API VS Code. Настоящий процесс
редактора в этих suites не запускался. Filesystem, shell, Python/Jupyter,
дочерние процессы и сигналы проверены настоящие.

## Ограничения

- Интерактивное ядро и общий shell по-прежнему принадлежат Extension Host.
  Native закрытие/kill редактора, reload и потеря машины не превращены в
  гарантию сохранности этих процессов. `deactivate` не предоставляет
  отменяемого VS Code shutdown с надёжным диалогом CONFIRM. Для обучения,
  которое должно переживать редактор, предназначен независимый compute
  agent и [background jobs](PERSISTENT_RESEARCH.md).
- Новая проверка владения process group при системном отказе основана на
  Linux `/proc`. Windows/macOS cleanup descendants при смерти ядра этой
  проверкой не подтверждён; Linux результат не означает их поддержку.
- Эта проверка не доказывает остановку произвольного кода, намеренно
  покидающего process group, и не является защитой от владельца ОС.
- CONFIRM защищает поддерживаемые managed UI/API paths. Произвольные
  доверенные команды хоста в shell (`exit`, `kill` и другие), Python-код
  и действия владельца ОС могут завершить процессы и находятся вне этой
  гарантии. В частности, естественное завершение shell очищает его
  process group; shell semantics этой работой не изменены.
- Физический GPU, внешний VPS и многочасовой тест не входили в эти
  интерактивные suites; их результаты и пропуски приводятся отдельно.
