# Длительное выполнение и границы проверки — 9 октября 2026

Это историческая запись запуска. Завершение исходного run и сохранённые
артефакты проверены 10 октября; итог находится в
`LONG_RUN_VALIDATION_0.5.38_2026-10-10.md/.json`.

Версия реализации: **0.5.38**. Этот отчёт относится к новой проверке, а не к
результатам версии 0.5.37. Запущен run **`soak-8face0e4ab42d957`**, каталог
**`/workspace/pair-notebook-soak-20261009-run1`**. Состояние и реальное время
на момент записи отчёта сохранены в соседнем JSON; тест ещё выполняется и
четыре часа не объявлены пройденными. Наличие сценария или CI не означает,
что соответствующее окружение уже прошло проверку.

## Наблюдаемый длительный CPU soak

`scripts/persistent-soak.py` запускает настоящие production broker CLI и
Python compute-agent на Linux loopback. Отдельный monitor, брокер, polling agent
и принятый training process имеют независимые ОС-сессии и файловое состояние.
Их stdin закрыт; stdout/stderr направлены в файлы. Открытый чат и редактор не
поддерживают живучесть задания.

По умолчанию явно настроены 14 400 шагов, минимум одна секунда на шаг и 20
обновлений logistic baseline на шаг. Минимальная длительность вычисления —
четыре часа; более медленная машина увеличит время. Это условие завершения
алгоритма, **не wall-clock timeout**. Строка вывода появляется каждые 300 шагов:
пять минут тишины не являются основанием отмены. Checkpoint записывается каждые
60 шагов атомарно с сохранением предыдущего; структурированные метрики пишутся
отдельно от stdout. Данные — обозначенная synthetic инфраструктурная fixture
в owner workspace, с SHA-256. Научное преимущество fraud-модели не проверяется.
Soak проверяет равенство загруженных model/optimizer состояний после публикации
checkpoint; эквивалентность продолженного обучения подтверждается отдельным
reference-pipeline тестом, а не этим сравнением JSON.

Запуск после компиляции:

```bash
python3 scripts/persistent-soak.py start --state /workspace/pair-notebook-soak-NEW
python3 scripts/persistent-soak.py status --state /workspace/pair-notebook-soak-20261009-run1
python3 scripts/persistent-soak.py cancel --state /workspace/pair-notebook-soak-20261009-run1
```

`start` требует новый каталог. Он замораживает скомпилированный production код,
Python agent и зависимость `ws`, сохраняет их hash и SHA исходного HEAD. Повторная
компиляция текущего репозитория не заменяет выполняемую реализацию. Секреты
хранятся исключительно в закрытом каталоге состояния с mode 0600 и не входят
в отчёт. Таймауты HTTP/readiness ограничивают сетевые операции и приём запроса.
У принятого training process ограничения общей продолжительности нет.
`cancel` показывает точный run ID, scope, checkpoint и охват descendants,
создаёт одноразовый server challenge, затем ждёт точный ввод `CONFIRM` в пустой
строке терминала. Неправильный регистр, EOF и Ctrl+C ничего не отменяют.
Ответ `cancel_pending` означает намерение остановки, а не подтверждённый выход
процессов. Для offline agent намерение сохраняет брокер.

Пороги fault events отсчитываются от запуска training process; действие
выполняется на ближайшем цикле наблюдения (до пяти секунд позже). Реальные
timestamps каждого действия сохранены в evidence JSON:

| Событие | Фактическое действие |
| --- | --- |
| 30–50 секунд | Брокер останавливается, затем поднимается с тем же реестром. |
| 65 секунд | Polling agent перезапускается с тем же persistent installation ID; training process сохраняется. |
| 85–115 секунд | Monitor прекращает HTTP-наблюдение, затем читает тот же run ID. |
| Каждые 5 секунд | Снимок elapsed time, шага, checkpoint, PID, RSS и числа training launches. |

Эти секунды реально проходят. Здесь нет ускоренного отображения часов или
утверждения, что 115 секунд доказывают многочасовую надёжность. Длительный
результат считается завершённым только после терминального состояния брокера
и фактического elapsed time. Ранняя передача отчёта фиксирует **running**.

Артефакты состояния:

- `plan.json`: run ID, конфигурация, versions/hash исполнителей и workload.
- `snapshot.json`: последняя наблюдаемая стадия, actual elapsed, PID/RSS,
  checkpoint и единственность training launch.
- `events.jsonl`, `observations.jsonl`: последовательность fault events и
  наблюдений, без токенов и дампа окружения.
- `owner-workspace/owner-synthetic-data.json`, `data-manifest.json`: данные
  владельца и проверяемая версия, скопированная потоково в изолированный run.
- `agent/jobs/<runId>/work/artifacts/<runId>/metrics.jsonl`: сохранённые метрики.
- `resume.json`, `resume.previous.json`: опубликованный и предыдущий checkpoint.

Monitor не отменяет принятое вычисление при собственной ошибке. Если workspace
или машина уничтожены, сохранность файлов и процессов за пределами их жизни
не обещается. Этот local soak не является проверкой внешнего VPS, Windows Job
Object, GPU, VPN или реальных окон двух редакторов.

## Аудит существующих тестовых границ

| Проверка | Настоящий компонент | Подмена / предел доказательства |
| --- | --- | --- |
| `test/runtimeExecutionLifetime.test.ts` | Production session protocol, bridge и Jupyter process | API `vscode` подменён; прежние таймеры в регрессиях ускоряются. |
| `test/vpsCompute.test.ts` | Брокер HTTP/WebSocket, реальные detached Python процессы, persistent filesystem | Loopback; ряд protocol cases отправляет handcrafted agent inventory/reports. |
| `test/vpsAuditRound2.test.ts` acceptance | Два Y.Doc, production relay, HTTP broker, настоящий Python agent; filesystem checkpoint | Два редакторских документа, а не два физических окна VS Code. Модель мала, исполнение секундное. |
| `test/support/modelTraining.ts` | CPU fitting и загрузка model/optimizer из checkpoint | Synthetic regression fixture; не scientific anti-fraud experiment. |
| `test/support/in_memory_trystero.ts` | Production сообщения над управляемым room boundary | Mesh-доставка in-memory не доказывает физический интернет/VPN topology. |
| `.github/workflows/training.yml` | На runner устанавливаются Jupyter и CPU PyTorch, запускаются integration tests | CI timeout 30 минут ограничивает проверочную машину; не production вычисление. Наличие workflow не является результатом запуска. |
| `.github/workflows/e2e.yml` | Настоящий Extension Host на Windows/Linux/macOS и VS Code 1.95.0 | Результаты удалённой матрицы учитываются отдельно; Linux cloud shell не подтверждает Windows или native editor. |

Локальное окружение: Linux / Python 3.12.14; `code` и `nvidia-smi` отсутствуют.
Зависимости для ML/Jupyter, если установлены отдельно, отражаются в основном
аудите финальной версии. Реальный GPU и локальный VS Code здесь не проверены.

## Отдельный внешний VPS

В этой сессии не предоставлены адрес внешнего VPS, credential и разрешённая
сетевая цель. Внешний deployment, SSH-аутентификация, filesystem удалённой
машины и её настоящее восстановление **не проверены**. Локальный production
broker/agent учитывается отдельно. Сведения об отказе сети из старого аудита
0.5.37 являются историей, а не воспроизведённым результатом текущей версии.

Минимальные пункты A–H пользовательского запроса покрываются финальными
регрессионными и интеграционными проверками основного аудита с их собственными
результатами. Пункты I–J требуют отдельных результатов для native VS Code,
Windows, физического GPU и внешнего VPS. Не выполненные окружения не считаются
успешными и не добавляются к числу уникальных тестов.
