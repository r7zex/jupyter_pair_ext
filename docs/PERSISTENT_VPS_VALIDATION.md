> Исторический отчёт: актуальная реализация и проверки — [0.6.3](PERSISTENT_VPS_REVIEW_0.6.3.md).

# Проверки постоянных VPS-сессий

Это исторические результаты сборки **0.6.0**. Повторная проверка требований, исправления и результаты **0.6.1** приведены в [отдельном отчёте](PERSISTENT_VPS_REVIEW_0.6.1.md).

Дата отчёта: **13 октября 2026 года**. Проверена первая стадия постоянных сессий: сервер хранит участников, права, файлы и результаты независимо от окон VS Code; Linux agent выполняет интерактивные Public notebooks; переключение ресурсов контролируется сервером. Синхронизация файлов происходит при сохранении. Посимвольный серверный CRDT, выполнение Private notebooks и изолированные agents для Windows/macOS в эту стадию не входят.

Полный локальный `npm test` завершился с **4838 passing (9m), exit 0, без pending/failing**. После последних дополнений окончательный source прошёл compile, lint, **396 focused tests** и повторный настоящий CPU integration. Эти прогоны приводятся раздельно: полный suite не приписывается последующим изменениям.

На VPS `144.172.69.57` установка не выполнялась: SSH credentials не предоставлены. Публичный TLS handshake, renewal сертификата, reboot, systemd recovery и работа в лимитах 1 CPU / 1 GB RAM / 25 GB диска на этой машине не проверены. Измерений месячной или годовой доступности нет. Старые отчёты о durable **background jobs** не являются доказательством работы нового Session Host.

## Матрица сценариев

«Локально PASS» означает указанный уровень доказательства, а не ручную проверку двух окон VS Code или готовность целевого VPS.

| № | Сценарий | Фактическое доказательство | Статус и предел проверки |
|---|---|---|---|
| 1 | Создатель закрывает VS Code | API сохраняет сессию без owner heartbeat; настоящий CPU execution завершается после ухода owner | Локально PASS; закрытие настоящего окна VS Code не проверено |
| 2 | Последний участник выходит | Storage/API восстанавливают файлы и ACL; policy считает только присутствующих людей и выбирает VPS для новых запусков | Локально PASS |
| 3 | Повторный вход спустя время | Новый клиент получает серверный snapshot; credentials сохраняются после process restart | Локально PASS для короткого цикла; длительность и публичный TLS VPS не проверены |
| 4 | Неверный пароль | API отвергает пароль и ограничивает попытки; administrative bearer не заменяет member credential | Локально PASS |
| 5 | Прямой доступ к Private | Storage/API блокируют чтение, listing, replay, rename и compute snapshot, включая Public descendants под Private ancestor | Локально PASS; production sandbox isolation отдельно не подтверждена |
| 6 | CPU на VPS без других людей | Настоящие HTTP Session Host → agent → Jupyter → сохранённый notebook; реальный CPU PyTorch tensor | Локально PASS с тестовым DirectSandbox; целевой VPS и production bubblewrap не проверены |
| 7 | Один участник использует свою машину | Policy разрешает исключение только для собственного явно shared устройства | Локально PASS |
| 8 | Пришёл второй участник | Policy отменяет sole-human exception для новых claims; accepted execution сохраняет target | Локально PASS |
| 9 | Запрещён чужой switch | Policy/API отвергают переключение и обход роли посредством administrative credential | Локально PASS |
| 10 | Чужая машина требует consent | Target не меняется до действительного решения владельца; stale approvals не перекрывают новое решение | Локально PASS |
| 11 | Отказ consent | Target остаётся прежним, отклонённое устройство не получает новые запуски | Локально PASS |
| 12 | Scope CPU/GPU grant | Session/requester/device owner/exact GPU проверяются перед claim; heartbeat и sharing обязательны | Локально PASS для policy; реальная GPU allocation не проверена |
| 13 | Реальный NVIDIA CUDA | Требуется tensor operation в удалённом CUDA kernel | **Не проверено: NVIDIA hardware отсутствует** |
| 14 | Все вышли: новый target VPS | Policy оставляет accepted work на прежнем устройстве, новые work направляет на VPS | Локально PASS |
| 15 | Восстановление VPS | Новый настоящий server process восстанавливает session ID, credentials, ACL, files; живой agent сохраняет тот же kernel PID без повторного выполнения | Локально PASS для process restart; reboot VPS не проверен |
| 16 | Конкурентные запросы | CAS conflict, единичный claim, frozen target, sequence/hash report idempotence и stale report rejection | Локально PASS |
| 17 | Падение worker | Durable receipt fences ambiguous execution; recoverOnly без локальной receipt не запускает код повторно | Локально PASS для agent/recovery tests; отказ production host не воспроизводился |
| 18 | Смена kernel устройства | Новый generation сбрасывает namespace; late result не перезаписывает изменённый source/outputs; UI lifecycle commands ждут terminal result | Локально PASS для API/agent/настоящего Jupyter и mocked VS Code API; ручной UI не проверен |
| 19 | Обычный P2P режим | Полный regression suite, включая настоящие Jupyter suites и transport/core tests | 4838 PASS; пара настоящих VS Code и ручной P2P-сеанс не проверены |
| 20 | Создание непосредственно на VPS | 3 CLI tests: HTTPS/private owner JSON/no secret stdout; Session Host API create/list и сохранение owner authority | Локально PASS; импорт owner JSON в настоящем VS Code не проверен |
| 21 | Больше 32 запусков и output retention | History/API сохраняют replay identity после restart и pruning; expired output имеет явный tombstone; новые запуски не ограничены lifetime count | Локально PASS |
| 22 | Освобождение конкретного kernel | API/agent tests: release ждёт accepted execution, закрывает точный kernel, не создаёт отсутствующий и не меняет notebook outputs; mocked UI ждёт результат | Локально PASS; ручной UI не проверен |
| 23 | Удаление с выполняемой работой | API удаляет session data и отвергает late result; agent завершает accepted работу локально и продолжает обслуживать другие sessions | Локально PASS для API/agent tests |

## Границы данных и восстановления

Storage tests проверяют traversal/absolute paths, portable filename collisions, symlink/hardlink, вложенные ACL, CAS, атомарную публикацию manifest/blobs, квоты и отказ запуска при corrupt metadata. Privacy tests дополнительно проверяют смену ACL и перемещение зависимости под Private ancestor: новый public kernel generation, отсутствие Private source в recovery claims и доступ guest к результатам только при действующих Public path/ACL. Owner сохраняет доступ к архивным результатам и artifacts после перемещения или удаления исходного notebook.

History tests проверяют bounded output retention, SHA-256 digest, постоянную request identity, восстановление частично опубликованного архива и запрет скрытого повторного запуска после истечения хранения outputs. Agent tests проверяют повторную отправку неизменного отчёта после потерянного acknowledgement, crash receipts, точные stdin/restart/release controls, capacity без неявного eviction живого namespace и drain accepted work после удаления session или потери report authority. Сохранение результатов использует canonical server source и проверяет version/ACL перед записью.

Настоящие Jupyter проверки покрывают stateful namespace, stdin, restart, interrupt и rich MIME. Финальные дополнения проверяют nbformat outputs: stream coalescing, display-id updates без transient fields, `clear_output(wait=True)`, errors/execution counts и видимое сообщение о truncation. Device usage определяется из серверных running executions; сообщённый agent список пользователей не считается authority. Для legacy background broker добавлены canary/race checks, блокирующие `pair-vps:` до чтения credentials или отправки snapshot, в том числе при смене workspace во время диалога.

Public output может содержать секрет, который пользователь сам вставил в код или результат. ACL/snapshot tests подтверждают, что система не добавляет Private storage в execution snapshot независимо от роли инициатора. Проверки конфигурации sandbox не заменяют успешный запуск production isolation на Ubuntu.

## Результаты этой сборки

| Проверка | Результат | Что подтверждает / предел |
|---|---|---|
| Полный TypeScript regression suite (`npm test`, включает compile) | **4838 passing (9m), exit 0, без pending/failing** | Core, transport, storage/policy/API, UI API mocks и настоящие доступные Jupyter suites; snapshot до последних дополнений |
| Финальные `npm run compile` и `npm run lint` | **Оба exit 0** | Окончательный source; type contracts, сборка и lint |
| Финальные затронутые TypeScript suites | **396 passing (1m), exit 0, без pending/failing** | Persistent suites, vpsCompute, pythonKernel, core/dashboard; rich outputs, revocation, device usage и legacy privacy guard |
| `python3 test/persistent_session_agent_test.py -q` | **29 tests: 28 PASS, 1 SKIP, exit 0** | Agent protocol/state/receipts, real direct CPU bridge; production bubblewrap smoke пропущен из-за запрета user namespaces в текущем окружении |
| `python3 test/persistent_session_admin_test.py -q` | **3 PASS, exit 0** | HTTPS, private regular token/owner files, headless create без печати secrets; native VS Code import не проверен |
| `python3 test/jupyter_bridge_unit.py -q` | **9 PASS, exit 0** | Existing Python Jupyter bridge unit checks |
| `python3 test/persistent_session_cpu_integration_test.py -q` | **2 PASS, exit 0; финальный повтор — 10.945 s** | Настоящие HTTP server/agent/Jupyter, saved outputs/artifacts, offline owner, process restart, generation reset и PyTorch CPU против окончательной сборки |
| `git diff --check` | **Чисто** | Проверка whitespace в diff |
| Standalone server из упакованного архива | **12 проверок PASS, exit 0; 17 SHA-256 файлов BUILD.json совпали** | Bundled CLI без `node_modules` из пустого cwd, версия 0.6.0, Node v24.19.0; password/credential separation, Public/Private ACL, owner leave, writer lock, SIGTERM и восстановление новым процессом |
| VSIX и source ZIP artifact checks | **PASS, exit 0; VSIX 0.6.0 — 99 файлов; 7 native SHA-256 совпали** | Все runtime assets присутствуют, внешних непоставленных imports, sensitive paths и вложенных архивов в VSIX нет; установка в настоящем VS Code отдельно |

Полный regression suite запускался с Python environment, содержащим `jupyter_client`, `ipykernel` и CPU PyTorch:

```bash
PATH="/tmp/pair-session-validation/bin:$PATH" \
PAIR_NOTEBOOK_TEST_PYTHON=/tmp/pair-session-validation/bin/python \
PAIR_NOTEBOOK_TEST_TORCH_PYTHON=/tmp/pair-session-validation/bin/python \
npm test
```

Финальный focused suite:

```bash
PATH="/tmp/pair-session-validation/bin:$PATH" \
PAIR_NOTEBOOK_TEST_PYTHON=/tmp/pair-session-validation/bin/python \
PAIR_NOTEBOOK_TEST_TORCH_PYTHON=/tmp/pair-session-validation/bin/python \
node_modules/.bin/mocha --timeout 15000 --exit \
  "out/test/persistent*.test.js" "out/test/vpsCompute*.test.js" \
  "out/test/pythonKernel*.test.js" out/test/core.test.js out/test/dashboard.test.js
```

Локальный журнал полного прогона: `/tmp/pair-notebook-final-test.log`. Python agent/CPU checks выбирали тот же interpreter через `PAIR_NOTEBOOK_TEST_PYTHON=/tmp/pair-session-validation/bin/python`.

Standalone archive сообщает base commit `3cc515793a4dfaa9b9a1803af60a85c64899b48b` и наличие локальных изменений. Независимый smoke распаковал его вне source checkout: `/health`, create/join с правильным и неверным паролем, разделение administrative/member credentials, Public read и `404` на Private для guest, owner leave, отказ второму writer без изменения данных, clean SIGTERM и durable restore новым server process. SHA самого архива не фиксируется в этом документе: после обновления отчёта документация перепаковывается вместе с тем же проверенным runtime.

Поставка собирается командами `npm run package:persistent-server` и `vsce package --no-yarn --no-dependencies --no-rewrite-relative-links --allow-missing-repository`. `node scripts/make-artifacts.mjs --preflight-only` проверил исходные пути; `node scripts/make-artifacts.mjs` проверил состав VSIX, SHA-256 семи native assets и source ZIP. Это проверка установочного файла, а не запуск VS Code. После включения итогового отчёта архивы перепаковываются; standalone smoke и проверки поставки повторяются на итоговых файлах.

CPU integration использует **тестовый DirectSandbox**, чтобы проверить настоящий kernel и transport в окружении с запрещёнными user namespaces. Production agent требует non-root Linux/bubblewrap и прекращает admission при недоступной изоляции; unsafe fallback отсутствует. Результат CPU integration нельзя считать доказательством production bubblewrap isolation.

Настоящий PyTorch kernel сохранил в notebook:

```json
{"torchVersion":"2.14.1+cpu","device":"cpu","sum":10.0,"cudaAvailable":false,"cudaDeviceCount":0}
```

Этот результат подтверждает выбранный CPU environment и tensor operation; он не проверяет CUDA. Для NVIDIA нужен отдельный реальный запуск с доступным устройством, его UUID и сохранённым CUDA tensor result.

## Непроверенные условия следующей приёмки

- Production bubblewrap на целевом Ubuntu, mount/environment isolation, CPU/RAM quotas под настоящей нагрузкой и ограничения свободного диска.
- Публичный HTTPS/TLS с проверкой сертификата, автоматический renewal, systemd start/recovery и полный reboot `144.172.69.57`.
- Реальный NVIDIA GPU, `CUDA_VISIBLE_DEVICES` для выбранного UUID, CPU/GPU переключение между двумя физическими машинами.
- Установка VSIX и ручной create/join/import/save/execute/consent/release/recovery workflow в двух настоящих VS Code; обычный P2P-сеанс.
- Длительный uptime/soak и native Windows/macOS agents. Посимвольный CRDT и Private execution требуют отдельной реализации, а не только проверки.

## Публичный TLS: проверенные источники, непроверенная установка

- [Let's Encrypt: public IP certificate availability](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), 15 января 2026: IPv4/IPv6, срок 160 часов.
- [Let's Encrypt: Certbot IP certificate guide](https://letsencrypt.org/2026/03/11/shorter-certs-certbot), 11 марта 2026: `--ip-address`, `--preferred-profile shortlived`, webroot в Certbot 5.4+, explicit webserver certificate loading/deploy hook.
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https): stock IP-конфигурация использует local CA; Public DNS может использовать публичный ACME CA.
- [Caddy Ubuntu installation](https://caddyserver.com/docs/install#debian-ubuntu-raspbian): официальный systemd package.
- [DuckDNS installation](https://www.duckdns.org/install.jsp): возможен пользовательский бесплатный DNS; используйте только HTTPS с проверкой сертификата.

Источники прочитаны 12 октября 2026 года. Файлы конфигурации и команды в [руководстве установки](PERSISTENT_VPS.md) подготовлены на их основе; выдача и renewal сертификата на `144.172.69.57` не исполнялись.
