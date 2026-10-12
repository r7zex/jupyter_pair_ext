# Compute worker: проверка 0.5.39, 2026-10-11

Основание: актуальная целевая ветка `codex/vps-persistent-compute`,
коммит `7e75dec` (0.5.38). Этот отчёт описывает новые проверки worker,
а не повторяет результаты исторического аудита 0.5.38.

## Воспроизведённые проблемы и исправления

1. Detached runner запускался без `-I -S`, с унаследованным
   `PYTHONPATH`. Настоящий `sitecustomize.py` в изменяемой папке
   наблюдателя записывал marker до чтения retained job. Задание при этом
   завершалось успешно: прежний результат `ownerStartupExecuted=true`,
   `status=succeeded`. Теперь все внутренние Python helpers используют
   изолированный запуск. Python bootstrap/search overrides наблюдателя
   удаляются; training получает `PYTHONPATH` сохранённого run.

2. Несуществующий унаследованный `PYTHONHOME` завершал detached runner
   с exit code 1, не публикуя `result.json`. Теперь owner-selected
   interpreter запускается независимо от этих overrides. Регрессия
   действительно запускает worker и training, проверяя успешный результат.

3. Retained data partial мог быть hardlink на частный файл владельца.
   Для source `b'ownerX'` и partial, связанного с private `b'owner'`,
   append менял private на `b'ownerX'`; staging проходил и публиковал
   тот же inode. Теперь partial и completed snapshot должны быть обычными
   файлами с одной ссылкой. Проверяется как metadata до открытия, так
   и `fstat` фактически открытого файла; на POSIX используются
   `O_NOFOLLOW` и `O_NONBLOCK`. Регрессии проверяют сохранность private
   файла для partial/completed hardlink и отказ от FIFO без блокировки.
   Это воспроизведение локального состояния filesystem; возможность
   удалённого клиента создавать hardlinks не утверждается.

4. Execution receipt не проверял `projectId`, `sessionId`,
   `ownerIdentity`. На коде основания запрос без всех трёх scope fields
   с `cancelRequested=true` создавал cancel marker, хотя retained receipt
   сохранял исходного владельца. Теперь проверяются все immutable fields,
   включая удаление ранее присутствовавшего поля, до доставки отмены.
   Реальный завершённый job в регрессии отвергает замену и удаление каждого
   owner/scope field, не создаёт cancel marker и не исполняется повторно.
   Compact `knownJobId` poll намеренно не передаёт `files`/`args`:
   отсутствие только этих payload fields разрешено; их изменение при
   явной передаче запрещено. Независимая интеграционная проверка реального
   broker/agent фиксирует этот контракт; blanket сравнение отсутствующих
   payload fields было исправлено после этой проверки.

## Проверки

Команда полного worker suite на финальной реализации:

```text
python -W error::ResourceWarning test/vps_agent_audit.py -q
```

Финальный прогон: **107 тестов, 131.615 секунды, все прошли, 0 пропусков**.
SHA-256 проверенных исходников:

```text
ef4d2107e4b839a995ecbe2a15747f98426ad6533a26fe3fec87cb7128f05906  scripts/pair-notebook-agent.py
e48489ebe567f3c4e83260205b72b2ee418e7e8a1d39723c38f82be1ba740ce2  test/vps_agent_audit.py
```

Для HTTP/TLS loopback tests явно предоставляется разрешение sandbox на
сеть. Первый запуск без этого разрешения дал восемь ошибок `PermissionError:
[Errno 1] Operation not permitted` при создании сокета; эти ошибки не
выдавались за дефекты реализации. Отдельный повторный прогон обнаружил
TCP reset вместо ожидавшегося `TimeoutError` при deadline shutdown:
регрессия теперь принимает оба допустимых network failure и по-прежнему
проверяет ограничение длительности запроса и отсутствие ложного успеха.
Повторные прогоны не увеличивают число
уникальных проверок: suite содержит 107 тестов, включая пять новых.

В suite используются реальные filesystem, training/worker subprocess,
сигналы, перенаправленный stdout и отдельные process sessions. Проверяются
runner/supervisor crash, перезапуск polling observer без replay,
graceful cleanup/escalation, сохранность постороннего процесса, ограничение
output retention с продолжением draining, binary/Unicode data staging,
проверка hash и возобновление partial copy. GPU inventory в этих тестах
подменяется; запуск на физическом GPU не утверждается.

`python -m py_compile scripts/pair-notebook-agent.py test/vps_agent_audit.py`
и `git diff --check` также проходят. Подробный финальный результат suite
и хеши исходников включены в общий аудит версии.

## Границы гарантии

Задание уже не имеет wall-clock deadline и не зависит от polling
соединения. Receipt сохраняется до spawn; неоднозначный запуск после
crash не повторяется. Linux subreaper/Windows Job Object cleanup сохраняет
execution lock до завершения относящихся к job процессов.

В этой среде проверен Linux CPU. Windows, внешний VPS, физический GPU и
многочасовой запуск не являются результатами этого worker suite;
их статус публикуется отдельно. Установка зависимостей Python не
копируется автоматически: owner должен использовать фиксированное
окружение/image. Изолируются project source/config/declared data и
bootstrap наблюдателя; произвольный trusted Python остаётся кодом под
учётной записью владельца. Эти проверки не подтверждают устойчивость к
OOM, выключению executor, заполнению диска или враждебной модификации
filesystem другим процессом той же OS-учётной записи.
