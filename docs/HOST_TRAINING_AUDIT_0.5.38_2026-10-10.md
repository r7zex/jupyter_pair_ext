# Pair Notebook 0.5.38 — проверка 10 октября 2026

Целевая ветка: `codex/vps-persistent-compute`. До изменений актуальная вершина GitHub проверена как `97042cc8d46ca842f3dc0885e347316c3246b45a`, версия 0.5.37. При возобновлении 10 октября удалённая вершина осталась той же. Локальная исходная облачная копия была 0.5.30 (`37124a6`); она не использовалась как основание исправлений. Рабочее дерево до перехода на целевую ветку было чистым. Reset, force push, Release и производственное развёртывание не выполнялись.

Предыдущие отчёты описывают свои версии. Этот отчёт относится к новым изменениям 0.5.38; окончательный коммит указывается после проверки и push. Для многочасового теста отдельно сохранены хеши фактически запущенного кода.

## Воспроизведённые проблемы и исправления

| Причина | Исправление | Проверка |
| --- | --- | --- |
| UI отменял VPS-задание обычной кнопкой; брокер принимал пустой cancel без доказательства согласия. | Пустое поле и точный `CONFIRM`; сервер выдаёт одноразовый challenge с identity, правами, action/scope, точными ID, generation и сроком. Повтор доставки использует сохранённый результат операции. | Воспроизведение старого UI на `97042cc` вызвало legacy cancel при пустом поле; исправленный UI этого не делает. Реальный HTTP проверяет неверный регистр, лишние символы, scope, права, expiry, старый run и смену authority. |
| Остановки Jupyter, Ctrl+C, Restart и изменения жизненного цикла обходили отдельное подтверждение. Новый запуск мог появиться во время диалога. | Executor проверяет собственный challenge, host/compute epochs, точные execution IDs и ревизию приёма shell-команд. Границы admission устанавливаются синхронно; новая работа и переименование notebook делают старое подтверждение непригодным. Ввод терминала блокируется до закрытия диалога, включая остаток вставленного текста после Ctrl+C. Разрушительные прямые API отвергаются при активной работе. | Регрессии API/диалога, настоящие Jupyter и shell-процессы, подготовка до запуска, новый shell, stop-session и повтор доставки. |
| Потеря гостя и удаление notebook UI прерывали принятую работу; удаление receipt/replay при disconnect мешало восстановлению результата. | Связь наблюдателя отделена от owner выполнения. Активная работа сохраняется при удалении её представления; replay/dedupe используют существующие ограниченные caches. Замена исполняемого notebook не уничтожает чужой run без его stop. | Исполнение продолжает записывать checkpoint после удаления UI и потери наблюдения; подтверждённая остановка подготовки не создаёт ядро позже. |
| Агент читал изменяемый workspace и унаследованный project PYTHONPATH во время обучения. | Изолированная копия исходников/конфигурации и явно подготовленных данных; pinned manifest, потоковая проверка размера/SHA-256, возобновляемое owner staging, проверка symlink и конфликтов. | Настоящие бинарные/Unicode файлы; изменение владельцем данных после подготовки не меняет run; отсутствующие/изменённые данные и escaping symlinks отвергаются. |
| Поздняя отмена могла переименовать уже сохранённый успешный результат в Cancelled. Недоступный исполнитель не доказывает остановку. | Сохранённое естественное завершение имеет приоритет. Брокер хранит `cancel_pending` до ответа исполнителя; scoped intent переживает рестарт. | Реальные гонки завершения, выключение наблюдателя, offline agent и перезапуск брокера; immutable completed result. |
| Нужно подтверждать прекращение descendants, включая перенаправленный вывод и отдельную сессию. | Кооперативные сигналы, ограниченная эскалация и supervision конкретного run; без поиска всех процессов python/node или всего пользователя. | Настоящие workers, graceful finally, игнорирование сигналов, crash runner/supervisor; посторонний Python остаётся жив. Нативный Windows отдельно не проверен. |
| Нельзя считать успешный torch.load проверенным продолжением эксперимента. | Полное состояние model/optimizer/scheduler/scaler/RNG, epoch/step и provenance; retained atomic resume/best/export artifacts, integrity sidecars и явный fallback. | Непрерывный и resumed CPU runs дают одинаковые состояния и историю; повреждение, незавершённая запись, смена config/data/source и среды обнаруживаются. |

## Архитектура и эксплуатация

Для unattended обучения используется отдельный compute agent: broker хранит registry/intent, detached supervisor владеет процессами, runner хранит execution receipt, вывод и артефакты. Редактор управляет и наблюдает. Принятый job не получает wall-clock deadline; тихий stdout не повод для остановки. Временные ограничения HTTP, доставки, приёма и подготовки не являются лимитом обучения.

Обычное интерактивное ядро и общий shell всё ещё зависят от Extension Host. Закрытие процесса редактора не превращено в гарантию их сохранности. Длительное обучение следует запускать через background jobs. [Руководство](PERSISTENT_RESEARCH.md) описывает launch, observation, owner data, resume, CONFIRM, права и поведение всех жизненных циклов. [VPS-инструкция](VPS_COMPUTE.md) содержит deployment-конфигурацию; в этой работе production не менялся.

Shared terminal читает и исполняет команды на текущем хосте под его учётной записью. Вывод общий; ввод и Ctrl+C только у хоста. Удалённый shell-input RPC отвергается. Доверенный Python не является OS sandbox.

Существующий team token — credential назначенного team operator, а не удостоверение отдельного исследователя. Дополнительные authenticated principals поддерживают роли operator/member/viewer и ограничения проектов. Session stop ограничен точной парой project/session и закрывает её admission. UI показывает checkpoint как «не сообщён», если compute API не располагает его метаданными; reference pipeline сохраняет реальные метрики и checkpoint identities отдельно от scrollback.

## Реальные данные и исследовательская проверка

Исследовательский датасет не предоставлен. Добавлен явно **синтетический** [reference pipeline](../examples/anti_fraud_reference/README.md): delayed-label chronological split с gap/maturity, preprocessing только на train, causal history, logistic baseline/MLP/history ablation, validation-selected thresholds, PR-AUC, FPR/capacity, confusion/error cost и subgroup metrics. Рукопись — scaffold с пометками отсутствующих исследований, без придуманных научных результатов или ссылок.

Фактически выполнены девять запусков: три варианта × seeds 7/13/29, по 12 эпох, суммарно 2052 шага. Таблицы порождены из сохранённых результатов; превосходство MLP и качество реальной fraud-модели не утверждаются. При повторной проверке сохранённого архива проверены CRC, 182 checkpoint sidecars, source/config/data identities и 27 role pointers. Архив результатов отдельный от установочной сборки.

Отдельный интеграционный test запускает этот же pipeline через настоящий compiled broker/agent: owner data → immutable staging → preprocessing → train → checkpoint/state reload → export evaluation. SIGKILL polling observer и рестарт broker не вызывают повторного запуска. Подменена только пауза после первого сохранённого epoch для воспроизводимой orchestration-гонки; модель, filesystem, процессы и HTTP настоящие.

## Длительная проверка

Исходный soak `soak-8face0e4ab42d957` завершился: **14 427.668 секунды обучения**, один запуск, 14 400 шагов, итог `succeeded`, exit code 0. Он работал без открытого чата. Реальные broker/poller/observer outages восстановились; история, предыдущий/последний checkpoint и ограниченная память проверены по долговечным журналам. Хеши worker/broker/protocol этого запуска совпадают с проверяемой реализацией. Это Linux CPU loopback, не внешний VPS и не реальный fraud-эксперимент.

[Полный четырёхчасовой отчёт](LONG_RUN_VALIDATION_0.5.38_2026-10-10.md) и JSON фиксируют фактическое время, сбои, RSS, checksum и границы проверки. Отчёт 9 октября сохранён как исторический snapshot начала теста, а не его финальный результат.

## Проверки финального кода

Команды повторения (интерпретатор должен содержать проверенные CPU Torch/Jupyter dependencies):

```bash
npm ci
npm run lint
npm run compile
PATH=/path/to/validation-env/bin:$PATH node node_modules/mocha/bin/mocha.js \
  --timeout 20000 --forbid-pending --exit 'out/test/**/*.test.js'
python -W error::ResourceWarning test/jupyter_bridge_unit.py -q
python -W error::ResourceWarning test/vps_agent_audit.py -q
python -W error::ResourceWarning test/anti_fraud_reference_test.py -q
python -W error::ResourceWarning test/persistent_reference_integration_test.py -q
npm audit --omit=dev
```

Финальный общий прогон: **4750 TypeScript-тестов и 124 Python-теста**, все прошли, без пропусков. Python: bridge 9, worker 102, reference pipeline 12, реальный broker/agent reference integration 1. Повторные targeted runs не увеличивают число уникальных тестов. `npm run compile`, `npm run lint` и `npm audit --omit=dev` прошли; production vulnerabilities — 0. [JSON проверки](HOST_TRAINING_AUDIT_0.5.38_2026-10-10.json) содержит SHA-256 исходников, compiled backend и журналов. Build проверяет native assets семи платформ; это не проверка работы этих платформ. Packaging создаёт VSIX и полный source archive без credentials/runtime state; хеши готовых архивов сообщаются отдельно после упаковки.

## Ограничения

- Внешний развёрнутый VPS не проверен: текущий endpoint/credentials отсутствуют, TCP allowlist пуст. Исторический SSH отказ из 0.5.37 не выдаётся за новую проверку.
- Настоящий локальный VS Code отсутствует (`Could not find VS Code`). Linux/Windows/macOS/minimum-version Extension Host matrix настроена в CI; её результат нужно читать отдельно для финального commit. In-memory Trystero и подменённая VS Code API boundary не считаются двумя физическими окнами через Интернет.
- Физический GPU, нативный Windows Job Object и service lifetime не проверены. Четырёхчасовой CPU soak не доказывает CUDA resume.
- Owner-selected Python environment не клонируется автоматически. Используйте фиксированное окружение/image и не обновляйте pip/conda зависимости активного эксперимента. Project source/config/declared data фиксируются; OS owner и произвольный trusted Python могут обращаться к внешним абсолютным путям.
- Бинарные данные на отдельный compute agent подготавливает владелец явным transfer/staging. Broker source snapshot не является автоматической гигабайтной передачей owner-only dataset.
- Выключение executor, OOM, полный диск и аппаратные сбои не преодолеваются этим протоколом. После потери машины требуется явно идентифицированное новое продолжение из пригодного checkpoint, а не скрытый restart исходного job.

`CONFIRM` доказывает проверку scoped authenticated API и гарантии штатного UI. Оно не доказывает ручной ввод у произвольно модифицированного клиента и не защищает от владельца ОС.
