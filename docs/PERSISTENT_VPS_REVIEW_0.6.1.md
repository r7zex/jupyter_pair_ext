# Проверка постоянных VPS-сессий — 0.6.1

Проверен [коммит 0.6.0 `1e67bea`](https://github.com/r7zex/jupyter_pair_ext/commit/1e67beab4c7167258142af8a3127f38e7fdf4ee4) по исходному промту. Исправления находятся в `codex/review-persistent-v0.6.1`. Дата проверки: 13 октября 2026 года.

**Результат по полноте: реализован первый этап; весь исходный промт ещё не закрыт.** VPS является отдельным постоянным Session Host и хранилищем, самостоятельный agent исполняет интерактивный Jupyter. Синхронизация происходит при сохранении, вычисления используют Public snapshots, защищённый agent поддерживает Linux. CRDT, Private kernels и изоляция Windows/macOS требуют реализации; физический CUDA, production bubblewrap, настоящий интерфейс VS Code и целевой VPS требуют проверки. Эти ограничения нельзя объявлять прошедшими тестами.

## Исправленные ошибки

| Ошибка 0.6.0 | Исправление 0.6.1 и исходники |
|---|---|
| Отклонённые delete/rename/visibility могли изменить kernel generation до проверки CAS, пути и прав | Storage сначала валидирует мутацию, затем сохраняет privacy barrier перед публикацией. [Storage](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentStorage.ts#L232), [API](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentServer.ts#L215) |
| Сбой после durable terminal report, но до публикации outputs/files оставлял результат вне проекта; повторный ACK не завершал публикацию | `mergePending` восстанавливается при старте и retry. Частично опубликованные одинаковые файлы распознаются; более новые другие редакции сохраняются. Отказ записи receipt оставляет тот же offset повторяемым. [Recovery](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentServer.ts#L523) |
| VPS claim мог выдать вторую сессию, пока worker занят первой; stopped session теряла recovery | Один worker сначала получает recoverOnly для принятой работы во всех сессиях. Scoped API не обходит ограничение. Остановка не допускает новый код, но позволяет reconcile принятую работу. [Claim](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentServer.ts#L468) |
| Notebook queue и поздние filesystem ответы могли попасть в новое соединение после переподключения | Queue, observer, stdin, reads/saves закреплены за исходным connection; старые queued cells не отправляются, поздний ответ не меняет новый baseline. [UI](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vscode/persistent.ts#L591) |
| Refresh перед execute мог разрешить другую сохранённую версию ячейки, ещё не показанную пользователю | Клиент передаёт SHA-256 отображаемого source; сервер проверяет canonical cell перед admission и при повторе request ID. [Admission](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentServer.ts#L430) |

Все эти случаи покрыты [серверными fault/race tests](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/test/persistentSession.test.ts) и [UI regression tests](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/test/persistentClient.test.ts). Дополнительно [manifest](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/package.json) активирует `pair-vps` filesystem, [P2P restore](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/extension.ts) не читает локальный marker по виртуальному пути, меню отзыва доступа соответствует owner-only API.

## Сверка разделов промта

| Раздел | Реализация и граница готовности | Доказательство |
|---|---|---|
| 1. Изучение проекта | Проверены commit, архитектура, конкретные реализации и тесты | [Архитектура 0.6.0](https://github.com/r7zex/jupyter_pair_ext/blob/1e67beab4c7167258142af8a3127f38e7fdf4ee4/docs/PERSISTENT_VPS_ARCHITECTURE.md) |
| 2. Постоянная сессия | Дисковые ID/password hash/member credentials/files/ACL, независимый leave, owner/admin lifecycle | [Host](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentServer.ts) |
| 3. Хранилище | Binary blobs, CAS, inherited ACLs, traversal/link rejection, upload; синхронизация при сохранении, CRDT отсутствует | [Storage](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentStorage.ts), [Explorer](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vscode/persistent.ts) |
| 4. Python/Jupyter executor | Stateful kernel на выбранном Linux executor; Host/storage не переезжают; Python RAM не мигрирует | [Agent](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/scripts/pair-notebook-session-agent.py) |
| 5. Права switch | Owner setting, sole-human own/shared exception, второй человек отменяет исключение, fallback новых запусков | [Policy](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentCompute.ts#L371), [tests](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/test/persistentCompute.test.ts) |
| 6. Consent | Session/requester/device owner/точная GPU, отказ не меняет target, проверки перед claim, отзыв новых ресурсов | [Consent/admission](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentCompute.ts#L249) |
| 7. CUDA | NVIDIA inventory, настоящий PyTorch probe, UUID mask; CPU скрывает CUDA. Реальный NVIDIA tensor test не выполнен | [Sandbox/probe](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/scripts/pair-notebook-session-agent.py#L304) |
| 8. VS Code | Create/join/import, lifecycle, ACL, device/consent и kernel controls. API mocks проверены; ручной UI и два настоящих VS Code ещё не проверены | [Controller](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vscode/persistent.ts) |
| 9. HTTPS/пароль | Salted scrypt, password только при join, отдельные member tokens, revocation, rate limit; HTTPS вне loopback с обычной TLS verification | [Join](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentServer.ts#L367), [client](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentClient.ts) |
| 10. Эксплуатация | Single writer, restore, systemd restart/limits, TLS renewal и backup/update instructions. Реальный reboot/renewal и годовой uptime не подтверждены | [Units](https://github.com/r7zex/jupyter_pair_ext/tree/codex/review-persistent-v0.6.1/deploy/persistent), [guide](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/docs/PERSISTENT_VPS.md) |
| 11. Privacy/execution | Private source исключён из compute/recovery snapshots и guest results; public-only kernel, clean environment, non-root/bubblewrap fail closed. Production isolation требует отдельного испытания | [Snapshot](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/src/vps/persistentStorage.ts#L135), [privacy tests](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/test/persistentPrivacyBoundary.test.ts) |
| 12. Сценарии 1–19 | Локальные API/policy/recovery/CPU доказательства отделены от физического GPU, actual UI, production isolation и VPS | [Исходная матрица](https://github.com/r7zex/jupyter_pair_ext/blob/1e67beab4c7167258142af8a3127f38e7fdf4ee4/docs/PERSISTENT_VPS_VALIDATION.md) |
| 13. Поставка | Matching VSIX/server/source сборки и Ubuntu команды. CI добавляет новые Python suites и standalone server artifact; push не публикует GitHub Release | [Packaging](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/scripts/package-persistent-server.mjs), [CI](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/.github/workflows/training.yml) |
| 14. Итог | Независимые Host/storage/credentials/executor работают в первом этапе; полная приёмка всех платформ и production впереди | [Architecture](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/docs/PERSISTENT_VPS_ARCHITECTURE.md) |

## Проверки 0.6.1

Среда: Linux, настоящий Python/Jupyter, CPU PyTorch `2.14.1+cpu`. Для loopback tests выдано network permission; исходные `listen EPERM` без него являлись ограничением среды.

| Проверка | Результат |
|---|---|
| Compile и lint | PASS |
| Предварительный focused TS: Session Host, client/UI, privacy, storage | 62 PASS; до последней regression записи final merge receipt |
| Полный TypeScript regression suite (`npm test`), окончательный код | **4867 PASS (4m), exit 0; без pending/failing** |
| Python agent | 29 tests: 28 PASS, 1 SKIP (production sandbox недоступен) |
| Python admin / Jupyter bridge | 3 PASS / 9 PASS |
| Настоящий CPU integration | 2 PASS; HTTP Host → agent → настоящий Jupyter → persisted outputs/artifacts; tensor sum `10.0`, CUDA unavailable, device count `0` |
| VSIX/server/source artifacts | PASS: VSIX runtime assets и 7 native SHA-256; source ZIP; standalone server — 18 SHA-256 и 9 smoke-сценариев |

CPU integration использует **тестовый DirectSandbox** для доверенного кода и не подтверждает production bubblewrap. Подставленный GPU inventory/consent не доказывает CUDA. Внешний `192.0.2.10` не посещался и не изменялся.

Standalone smoke воспроизводится командами `npm run package:persistent-server` и `npm run test:persistent:server`. [Тест](https://github.com/r7zex/jupyter_pair_ext/blob/codex/review-persistent-v0.6.1/test/persistent_server_archive_smoke.mjs) распаковывает архив в отдельный временный каталог, запускает bundled CLI из пустого cwd и проверяет version/hashes, password/credential separation, Public/Private API, single-writer lock, SIGTERM и восстановление новым процессом. CI сохраняет matching server archive и checksum рядом с VSIX и ZIP; успешного remote CI для этой ветки до её push ещё нет.

## Следующие критерии полной приёмки

1. На целевом Ubuntu проверить production mount/environment isolation, отсутствие доступа kernel к secrets, RAM/CPU limits, systemd reboot, доверенный TLS и renewal.
2. В двух настоящих VS Code пройти create/join/save/conflict/ACL/consent/device switch/recovery и обычный P2P; отдельно реализовать VPS CRDT для совместного несохранённого редактирования.
3. На настоящей NVIDIA машине сохранить CUDA availability, GPU UUID/name и успешную tensor operation; проверить CPU mask и переключение двух физических executor.
4. Реализовать эквивалентную изоляцию Windows/macOS agents и отдельную owner-only Private execution, прежде чем заявлять их поддержку.
5. Завершить длительный soak, проверить disk retention и backup restore под нагрузкой в пределах 1 vCPU / 1 GB RAM / 25 GB SSD. Эта проверка не доказывает годовой uptime.
