# Постоянные VPS-сессии: установка на Ubuntu

Для сборки 0.6.3 см. [реализацию и текущие границы приёмки](PERSISTENT_VPS_REVIEW_0.6.3.md). Выберите уже активное устройство через **Select Persistent Compute Device**, чтобы запросить персональное разрешение на выполнение: запрет переключения не запрещает такой запрос и не меняет kernel. SHA готового VSIX указан в `PAIR_BUILD.json`, сервера — в `BUILD.json`; для поставки из чистого commit оба признака local changes должны быть `false`.

Переименование Public notebook или его папки меняет generation kernels сессии. Последующие запуски используют пустой namespace с явным уведомлением; уже принятые вычисления продолжаются. Сначала сохраните нужные Python objects в файлы, если хотите загрузить их после переименования или смены устройства.

Используйте одинаковую версию сервера и VSIX, сейчас **0.6.3**. [Текущий отчёт](PERSISTENT_VPS_REVIEW_0.6.3.md) описывает реализацию и оставшиеся критерии приёмки. При обновлении дождитесь завершения принятого исполнения и сохраните backup; незавершённый перенос durable results восстанавливается при запуске нового сервера, без повторного запуска ячейки.

Эта инструкция относится к новой реализации постоянного Session Host и соответствующей сборке расширения. Обычный P2P Session Host и существующий broker фоновых задач — другие режимы. Опубликованная базовая версия описана в [VPS_COMPUTE.md на исходном commit](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/docs/VPS_COMPUTE.md) и [PERSISTENT_RESEARCH.md на исходном commit](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/docs/PERSISTENT_RESEARCH.md). Новые файлы этой итерации пока следует читать в поставленной сборке/локальном checkout: ссылка на исходный commit не является подтверждением наличия новой функции на GitHub.

Целевой сервер: Ubuntu, `144.172.69.57`, 1 vCPU, 1 GB RAM, SSD 25 GB. Команды ниже предназначены для администратора, подключённого по SSH. Доступа SSH и пароля сервера в этой рабочей среде нет: установка, выдача сертификата и перезагрузка именно этого VPS здесь **не выполнялись**. Результаты локальных тестов и незавершённые проверки перечисляются отдельно в [PERSISTENT_VPS_VALIDATION.md](PERSISTENT_VPS_VALIDATION.md).

## 1. Что устанавливается и что сохраняется

Один Node.js процесс держит серверную сессию, права, авторизацию, версии файлов и очередь интерактивного выполнения. Он запускается пользователем `pair-server`, слушает только `127.0.0.1:8787` и хранит данные в `/var/lib/pair-notebook-vps`. Caddy принимает внешние HTTPS-соединения на 443. Участникам нужны HTTPS-адрес, ID сессии и пароль; SSH и администраторский токен им не выдаются.

Отдельный `pair-worker` получает только разрешённые публичные файлы и команды. Его Python/Jupyter работает внутри bubblewrap, с отдельными namespaces, без сети и без доступа к серверному каталогу данных и секретам. На этом VPS worker выполняет CPU-код; мощные вычисления нужно вынести на отдельную машину. Не запускайте Node.js, compute agent или notebook kernel от root. Root используется только для установки, настройки systemd и сертификатов.

Исходники новой реализации: [серверный entrypoint](../src/vps/cli.ts), [HTTP-сервер](../src/vps/server.ts), [RPC-контракт](../src/vps/persistentProtocol.ts), [интерактивный агент](../scripts/pair-notebook-session-agent.py), [Jupyter bridge](../media/jupyter_kernel_bridge.py). Старый entrypoint можно сверить с [базовым кодом GitHub](https://github.com/r7zex/jupyter_pair_ext/blob/3cc515793a4dfaa9b9a1803af60a85c64899b48b/src/vps/cli.ts). После публикации используйте immutable commit ссылки именно на новую версию.

Notebook editing uses the existing host editor components (`EditorSynchronizer`, `EditorTextReplica`, `PresenceRenderer`) with the VPS as the permanent authority. An authenticated event stream on the session RPC endpoint pushes committed text updates and participant presence immediately. Text intents have durable actor/sequence identities, so reconnecting or recovering a lost acknowledgement does not repeat an edit. Folder reconciliation retains its durable journal and server CAS.

Cursor presence is advisory: participants can edit the same line or different lines of one cell. Local typing, deletion, and line changes do not wait for a VPS acknowledgement. The editor projects newer pending input over confirmed server text, using durable actor receipts to avoid replaying an already published edit. Consecutive unsent edits in one cell are coalesced while each in-flight request retains its original identity. Presence follows Yjs relative anchors, is filtered by file visibility, and is released on leave, stream disconnect, revocation, or five seconds without renewal. Character carets and participant names use the existing presence renderer. Private cursors and source updates are never sent to members without access.

The native VS Code ipynb serializer envelope is normalized before publication; transient `cells` and reserved `pair_crdt` state are not recursively copied into user metadata. Legacy inflated replicas are archived locally before repair. Structural changes use a state-vector fence and conflicting local changes remain archived. Server files, permissions and results persist, but Python objects in RAM do not survive a worker/VPS restart or move between compute devices.

Execution notifications use the same authenticated stream and the existing Jupyter observation/rendering code. Other participants see permitted outputs but never answer another participant's stdin prompt. Stored outputs use the same native NotebookController state renderer as the human-host path. Private promotion also removes legacy serialized copies of Private outputs before making the file readable to members.

Execution admission validates the acknowledged notebook identity, stable cell ID, source hash and selected compute generation. Unrelated live edits do not invalidate an unchanged cell. Running results can merge after a trusted edit to another cell; replacing the notebook, editing the executed source or changing privacy still fences the old result. Raw notebook replacement resets its stored replica rather than allowing an obsolete embedded CRDT to restore old text.

Run Cell starts its native execution indicator immediately, publishes pending live edits, and submits the acknowledged cell without an implicit notebook save or repeated snapshot reads. Explicit Save retains its fresh server reconciliation. Authenticated execution updates up to 64 KiB carry the current execution directly; larger results use a bounded notification followed by a read. Observers wake immediately, with a bounded polling fallback after a missed notification. Cached results belong to the original connection and cannot replace a later completion. The worker polls at 100 ms by default and persists or reports only changed running receipts; silent computations retain their normal lifecycle without an elapsed execution deadline. Saved outputs are restored as completed snapshots after the Pair controller is selected. Empty native serializer summaries do not schedule execution rendering during typing.

For a selected WSL GPU, the agent binds `/dev/dxg` in addition to the runtime libraries. CPU kernels do not receive that device. Because WSL exposes a shared GPU node, this sandbox permits GPU execution only when exactly one NVIDIA GPU is advertised; multiple-GPU WSL hosts fail closed rather than exposing unselected devices.

## 2. Совпадающие артефакты и зависимости

Используйте VSIX и серверный архив **из одной сборки**. Имя ниже — локальное имя файла, а не заявление о наличии GitHub release:

```bash
# На компьютере с полученными артефактами:
scp pair-notebook-server-persistent.tar.gz pair-notebook-server-persistent.tar.gz.sha256 root@144.172.69.57:/root/
ssh root@144.172.69.57
```

Сборку TypeScript и упаковку лучше выполнить на другом компьютере: на сервере с 1 GB RAM установка всех dev dependencies и компиляция могут вызвать OOM. Поставленный серверный архив содержит внешний каталог `server/`, standalone bundle `out/src/vps/cli.js` с включёнными Node dependencies, `scripts/pair-notebook-session-agent.py`, `scripts/pair-notebook-session-admin.py`, `media/jupyter_kernel_bridge.py` и `deploy/persistent/`. Команда распаковки ниже удаляет внешний каталог, чтобы unit использовал `/opt/pair-notebook/server/out/src/vps/cli.js`. Поэтому `npm ci`/`node_modules` на VPS не нужны. Установите поддерживаемый Node.js 20+ до запуска службы; конкретный путь бинарника в unit — `/usr/bin/node`.

```bash
apt-get update
apt-get install -y ca-certificates curl openssl python3 python3-venv bubblewrap ufw rsync dnsutils snapd
cd /root
sha256sum -c pair-notebook-server-persistent.tar.gz.sha256
node --version
python3 --version
command -v node
```

Если `node` отсутствует или версия ниже 20, установите текущую поддерживаемую LTS из официальной инструкции [Node.js](https://nodejs.org/en/download). Не продолжайте с устаревшим системным Node.js. Если установленная LTS находится в другом каталоге, измените `ExecStart` в unit.

```bash
useradd --system --user-group --home-dir /var/lib/pair-notebook-vps --shell /usr/sbin/nologin pair-server
useradd --system --user-group --home-dir /var/lib/pair-notebook-worker --shell /usr/sbin/nologin pair-worker
install -d -o root -g root -m 0755 /opt/pair-notebook/server
tar -xzf /root/pair-notebook-server-persistent.tar.gz -C /opt/pair-notebook/server --strip-components=1
test -f /opt/pair-notebook/server/out/src/vps/cli.js
test -f /opt/pair-notebook/server/scripts/pair-notebook-session-agent.py
test -f /opt/pair-notebook/server/scripts/pair-notebook-session-admin.py
chown -R root:root /opt/pair-notebook/server
chmod -R go-w /opt/pair-notebook/server
install -d -o pair-server -g pair-server -m 0700 /var/lib/pair-notebook-vps
install -d -o pair-worker -g pair-worker -m 0700 /var/lib/pair-notebook-worker
install -d -o root -g root -m 0755 /etc/pair-notebook
python3 -m venv /opt/pair-notebook-worker-venv
/opt/pair-notebook-worker-venv/bin/python -m pip install jupyter_client ipykernel
```

При повторной установке не повторяйте `useradd`, если пользователи уже существуют. Не перезаписывайте живой каталог сервера при обновлении; порядок обновления приведён ниже. Torch для обычных CPU-ячеек не нужен. Если notebook импортирует PyTorch, установите CPU-вариант по [официальному выбору платформы](https://pytorch.org/get-started/locally/) в выбранное окружение. Его размер, RAM и дополнительные библиотеки нужно учитывать отдельно; GPU на данном VPS нет.

## 3. Два независимых служебных секрета

Этот шаг генерирует независимые администраторский и worker токены, не выводя их в терминал. Не повторяйте его при каждом рестарте: замена credentials отзывает доступ ранее настроенных клиентов.

```bash
python3 - <<'PY'
import grp, json, os, secrets
from pathlib import Path
server = Path('/etc/pair-notebook/server.env')
admin = Path('/etc/pair-notebook/admin.token')
worker = Path('/etc/pair-notebook/interactive-vps.token')
if any(path.exists() for path in (server, admin, worker)):
    raise SystemExit('Credentials already exist; keep them or rotate them deliberately.')
admin_token, worker_token = secrets.token_hex(32), secrets.token_hex(32)
contents = '\n'.join([
    'PAIR_VPS_CLIENT_TOKEN=' + admin_token,
    'PAIR_VPS_AGENT_TOKENS=' + json.dumps({'vps': worker_token}, separators=(',', ':')),
    'PAIR_VPS_DATA=/var/lib/pair-notebook-vps',
    'PAIR_VPS_BIND=127.0.0.1', 'PAIR_VPS_PORT=8787', ''
])
for path, value, group in [(server, contents, 'root'), (admin, admin_token + '\n', 'root'),
                           (worker, worker_token + '\n', 'pair-worker')]:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(value)
    os.chown(path, 0, grp.getgrnam(group).gr_gid)
    os.chmod(path, 0o640 if group == 'pair-worker' else 0o600)
PY
```

`PAIR_VPS_CLIENT_TOKEN` — административный credential создания/перечисления сессий и оператор старого broker API. Его приватная копия `/etc/pair-notebook/admin.token` нужна локальному CLI; оба файла имеют режим `0600`. Он не является паролем приглашения или credential владельца уже созданной сессии. После создания/входа сессия выдаёт отдельный credential участника; расширение хранит секреты через VS Code SecretStorage. `interactive-vps.token` выдаётся только доверенному локальному agent и не передаётся notebook kernel. Служебные токены не нужно выводить в терминал или передавать участникам.

## 4. systemd и проверка изоляции

```bash
install -m 0644 /opt/pair-notebook/server/deploy/persistent/pair-notebook-server.service /etc/systemd/system/
install -m 0644 /opt/pair-notebook/server/deploy/persistent/pair-notebook-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pair-notebook-server.service
systemctl enable --now pair-notebook-worker.service
systemctl status pair-notebook-server.service pair-notebook-worker.service --no-pager
ss -ltnp '( sport = :8787 )'
```

У 8787 должен быть только loopback listener. Приведённый worker unit использует `http://127.0.0.1:8787` внутри того же VPS; HTTP через интернет не поддерживается. Внешним клиентам и другим compute-машинам нужен HTTPS.

Прежде чем принимать пользовательский код, проверьте, что worker не читает секреты сервера и пользовательские namespaces работают:

```bash
runuser -u pair-worker -- test ! -r /etc/pair-notebook/server.env
runuser -u pair-worker -- test ! -r /etc/pair-notebook/admin.token
runuser -u pair-worker -- test ! -r /var/lib/pair-notebook-vps
runuser -u pair-worker -- bwrap --unshare-all \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --proc /proc --dev /dev /usr/bin/true
journalctl -u pair-notebook-server.service -u pair-notebook-worker.service --since '10 minutes ago' --no-pager
```

Наличие `bwrap` само по себе не доказывает работоспособность sandbox. В новых Ubuntu политики AppArmor могут запрещать unprivileged user namespaces; исправляйте установку/профиль bubblewrap по документации вашей Ubuntu, сохраняя изоляцию. Не отключайте системную защиту глобально и не запускайте агент root. При недоступном sandbox или зависимостях агент должен показывать устройство как недоступное для запуска; обычное непривилегированное выполнение без sandbox не является запасным вариантом.

В unit worker разрешены namespaces, необходимые bubblewrap. Шаблон является CPU-шаблоном (`PrivateDevices=true`); его нельзя переносить на GPU-машину без настройки доступа к реальным NVIDIA devices. Сервер и worker имеют разные UID, разные каталоги данных и разные credentials.

The worker checks its actual selected sandbox with `ExecStartPre` inside the
systemd unit. A standalone `runuser` probe does not establish unit readiness.
`ProtectKernelTunables=false` is deliberate for this worker: systemd's procfs
masking prevents bubblewrap from mounting its own private `/proc`. Keep the
remaining systemd restrictions and bubblewrap isolation enabled; do not disable
AppArmor user-namespace restrictions globally. Ubuntu may require a confined
AppArmor profile for the worker's bubblewrap executable.

## 5. HTTPS непосредственно для 144.172.69.57

Покупать домен необязательно. На дату 12 октября 2026 года Let's Encrypt официально выдаёт публично доверенные IPv4/IPv6 сертификаты; срок действия — 160 часов. [Объявление доступности](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) и [инструкция Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) требуют профиль `shortlived`; для webroot с IP нужен **Certbot 5.4 или новее**. Просто указать IP в стандартном Caddyfile недостаточно: [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) описывает локальный CA для IP по умолчанию. Здесь Caddy загружает сертификат, выданный Certbot.

Установите Caddy из [официального стабильного репозитория Ubuntu](https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/caddy-stable.key
gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/caddy-stable.key
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
snap install --classic certbot
/snap/bin/certbot --version
```

Если версия Certbot ниже 5.4, обновите её и остановитесь до обновления. В правилах firewall провайдера и Ubuntu разрешите TCP 80/443; 80 нужен для HTTP-01 challenge и redirect, а не для передачи сессионных данных.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
install -d -o root -g caddy -m 0755 /var/lib/pair-acme
install -m 0644 /opt/pair-notebook/server/deploy/persistent/Caddyfile.ip.bootstrap /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

Bootstrap-конфигурация публикует по HTTP только challenge-файлы. Затем запросите сертификат production CA (используйте свой действующий e-mail):

```bash
read -r -p 'ACME contact email: ' pair_acme_email
/snap/bin/certbot certonly --non-interactive --agree-tos \
  --email "$pair_acme_email" --preferred-profile shortlived \
  --webroot --webroot-path /var/lib/pair-acme \
  --cert-name 144.172.69.57 --ip-address 144.172.69.57
unset pair_acme_email
install -m 0750 /opt/pair-notebook/server/deploy/persistent/pair-cert-deploy /usr/local/sbin/pair-cert-deploy
/usr/local/sbin/pair-cert-deploy
install -m 0644 /opt/pair-notebook/server/deploy/persistent/Caddyfile.ip /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

В тестовой инфраструктуре можно сначала добавить `--staging`; такой сертификат **не доверенный**, и его нельзя использовать для подключения участников. Замените staging сертификат production сертификатом до проверки HTTPS. Копирование ключа в `/etc/caddy/pair-tls` даёт доступ только root и группе Caddy; права `/etc/letsencrypt` не расширяются.

Для коротких сертификатов автоматическое продление обязательно. Шаблон проверяет продление дважды в день и перезагружает сертификат Caddy после успешной выдачи:

```bash
# Используем один расписанный renewal job вместо двух таймеров.
systemctl disable --now snap.certbot.renew.timer
install -m 0644 /opt/pair-notebook/server/deploy/persistent/pair-cert-renew.service /etc/systemd/system/
install -m 0644 /opt/pair-notebook/server/deploy/persistent/pair-cert-renew.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pair-cert-renew.timer
systemctl list-timers pair-cert-renew.timer
/snap/bin/certbot renew --dry-run
```

Если snap не установил `snap.certbot.renew.timer`, сообщение «unit does not exist» на первом шаге означает, что отключать нечего; собственный таймер всё равно нужно включить. Проверка `--dry-run` не доказывает, что новая production цепочка уже была выдана. Проверяйте журнал renewal job, фактический срок сертификата и HTTPS извне; при отказе продления исправляйте причину до истечения шести дней.

## 6. Бесплатное DNS-имя как альтернативный способ

Вместо IP-сертификата можно зарегистрировать имя в **собственном** аккаунте [DuckDNS](https://www.duckdns.org/), например выбранное вами `YOUR_OWN_NAME.duckdns.org`, и установить его A record в `144.172.69.57`. Доступность имени не гарантируется. Удалите неправильную AAAA record. Не используйте чужое имя или имя, автоматически предоставленное неизвестным владельцем; аккаунт DNS управляет вашим публичным адресом.

```bash
dig +short YOUR_OWN_NAME.duckdns.org A
dig +short YOUR_OWN_NAME.duckdns.org AAAA
install -m 0644 /opt/pair-notebook/server/deploy/persistent/Caddyfile.dns /etc/caddy/Caddyfile
# Отредактируйте YOUR_OWN_NAME в /etc/caddy/Caddyfile на своё имя.
editor /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

В этом варианте Caddy сам получает и продлевает сертификат DNS-имени; отдельные Certbot и IP renewal timer не нужны. Если вы переходите с IP-варианта на DNS, явно отключите `pair-cert-renew.timer`. При постоянном IP достаточно записи, выставленной в кабинете DuckDNS. Если IP меняется, настройте обновление по [документации DuckDNS](https://www.duckdns.org/install.jsp), используя HTTPS с проверкой сертификата. Некоторые примеры на сайте провайдера используют отключение проверки TLS/HTTP — их здесь применять нельзя.

## 7. Проверка подключения и создание сессии

С другого компьютера проверьте выбранный публичный адрес. Не добавляйте `-k`/`--insecure`:

```bash
curl --fail --show-error https://144.172.69.57/health
openssl s_client -connect 144.172.69.57:443 -verify_ip 144.172.69.57 -verify_return_error </dev/null
```

Для DNS используйте свой HTTPS hostname и `openssl s_client -servername YOUR_OWN_NAME.duckdns.org -verify_hostname YOUR_OWN_NAME.duckdns.org -connect YOUR_OWN_NAME.duckdns.org:443 -verify_return_error`. Health показывает доступность процесса, но не доказывает права, файловую синхронизацию или выполнение kernel.

Сессию можно создать прямо на VPS без VS Code. После запуска службы выполните по SSH:

```bash
python3 /opt/pair-notebook/server/scripts/pair-notebook-session-admin.py create \
  --token-file /etc/pair-notebook/admin.token \
  --public-url https://144.172.69.57 --name research --output /root/owner.json
python3 /opt/pair-notebook/server/scripts/pair-notebook-session-admin.py list \
  --token-file /etc/pair-notebook/admin.token
```

Для DNS замените `--public-url` своим проверенным HTTPS origin. Создание выполняется через loopback; публичный URL записывается для последующего подключения расширения. CLI запрашивает новый пароль сессии дважды, скрывает ввод и сохраняет owner credential в новом файле `0600`. Он выводит ID и путь к файлу, но не токен или пароль; существующий файл не перезаписывается. Имя сессии не заменяет ID.

Скопируйте `/root/owner.json` по SSH в приватный каталог своего компьютера **вне project workspace**. Например, на Linux/macOS:

```bash
install -d -m 0700 "$HOME/.pair-notebook-private"
(umask 077; scp root@144.172.69.57:/root/owner.json "$HOME/.pair-notebook-private/owner.json")
chmod 0600 "$HOME/.pair-notebook-private/owner.json"
```

В Windows выберите личный каталог с доступом только своего аккаунта; не помещайте файл в общий cloud folder или Git. Этот JSON предоставляет права владельца, поэтому не отправляйте его участникам.

В VS Code установите соответствующий VSIX, откройте выделенную локальную папку проекта и выполните **Pair Notebook: Connect to VPS → Import existing owner / member credential**. Выберите свой JSON: расширение проверяет session membership и сохраняет credential в SecretStorage. Повторный вход через пароль создаёт обычного участника и не восстанавливает owner-права; для владельца нужен импорт сохранённого owner credential.

Также можно создать сессию из расширения через **Create a persistent session**, введя HTTPS URL, административный токен, имя и отдельный пароль приглашения длиной не менее 12 символов. Другому участнику передайте только HTTPS URL, ID сессии и пароль: он выбирает **Join a persistent session**, вводит их и своё отображаемое имя. Серверный технический host остаётся VPS.

Для начальной загрузки используйте действие загрузки файлов/папки в VPS-сессию: сначала выбирается **Private (owner only)** или **Public**, затем файлы и новый серверный каталог назначения. Private предлагается по умолчанию; Public каталог публикуется после завершения загрузки. До публикации проверьте, что каталог/файл имеет нужное правило. Вложенное Private правило ограничивает доступ даже внутри Public каталога. Права меняются через **Make VPS Folder Public** / **Make VPS Folder Private** и сохраняются сервером. Участник получает только разрешённый снимок; не копируйте токены и секреты в Public файл.

В 0.6.3 Public kernels получают только Public snapshot. Private notebooks исполняет только владелец, на VPS либо своей выбранной машине. Private scope имеет отдельный kernel ID, workspace, receipt, outputs и artifacts; содержимое Private не передаётся машине другого участника. Новые Private artifacts публикуются как Private; Public файлы из такого исполнения не перезаписываются. При переводе notebook в Public сервер атомарно удаляет старые outputs/CRDT replica и меняет generation. Python RAM не переносится между scopes.

Проверьте полный цикл вручную:

1. Создайте небольшой публичный `.ipynb` и приватный файл с уникальным контрольным текстом.
2. Подключите второго пользователя; убедитесь, что приватный файл недоступен через UI и прямой RPC.
3. Выполните две последовательные ячейки `x = 42` и `print(x)` на VPS, проверьте stdout и сохранение notebook outputs.
4. Закройте оба VS Code, затем подключитесь снова: сессия и файлы должны остаться.
5. Перезапустите только серверную службу и снова войдите; затем отдельно проверьте reboot VPS.
6. Смените compute устройство; следующий запуск должен явно сообщить о новом kernel, без обещания сохранённых Python-переменных.

Список сессий доступен CLI выше; права/остановка/запуск/перезапуск/удаление выполняются действиями владельца или делегированного администратора постоянной сессии. Для CLI lifecycle нужен именно member credential:

```bash
python3 /opt/pair-notebook/server/scripts/pair-notebook-session-admin.py stop --member-config /root/owner.json
python3 /opt/pair-notebook/server/scripts/pair-notebook-session-admin.py start --member-config /root/owner.json
```

`restart` и `delete` используют такой же `--member-config`; административный server token не подменяет владельца. Выход участника и смена compute не прерывают уже принятую работу. Остановленная сессия сохраняет файлы. Удаление отдельно и необратимо удаляет серверные данные; уже принятая agent работа может закончиться локально, после чего idle kernel освобождается, но сервер больше не принимает её результаты. Не путайте `systemctl stop` всей службы с остановкой конкретной сессии.

## 8. Отдельная вычислительная машина

Владелец машины сам выбирает Python environment и включает предоставление ресурсов. Используйте экспортированный расширением конфиг session agent: это credential отдельного участника для конкретной сессии, не admin token VPS. Конфиг создаётся как новый приватный файл вне всех workspace; не переносите его в синхронизируемые папки. Запуск agent на Linux:

```bash
python3 /opt/pair-notebook/server/scripts/pair-notebook-session-agent.py \
  --config /PRIVATE_PATH/session-agent.json \
  --python /opt/SELECTED_VENV/bin/python \
  --state /var/lib/SEPARATE_WORKER_STATE --share
```

Каталог state должен принадлежать выделенному непривилегированному worker account. Передача управления третьему человеку требует подтверждения владельца машины, которое проверяется сервером перед запуском. Отключение sharing запрещает новые работы; политика активных работ отображается явно.

Защищённые runtimes: Linux/bubblewrap, macOS/Linux Docker containers и Windows/WSL2 launcher. Для контейнера требуется immutable installed image ID; Python выбирается внутри image. Нативная приёмка Windows/macOS ещё не проведена. Установка и readiness описаны ниже; agent всегда отказывает при недоступной изоляции.

Для NVIDIA нужны работающий драйвер на реальной машине, доступ sandbox к нужным GPU devices и CUDA-совместимый PyTorch **в выбранном Python environment**. Имя GPU, результат `nvidia-smi` и mock объявления capabilities не заменяют реального kernel теста:

```python
import sys, torch
print(sys.executable)
print(torch.__version__, torch.version.cuda)
print(torch.cuda.is_available())
assert torch.cuda.is_available()
x = torch.ones(16, device='cuda')
print(torch.cuda.get_device_name(0), x.device, x.sum().item())
```

Такой тест на NVIDIA hardware в этой итерации не выполнялся. GPU-выполнение считается проверенным только после успешной операции в действительном удалённом kernel, а не по наличию GPU в меню.

## 9. Ограничения маленького VPS и эксплуатация

Шаблоны ограничивают Node.js примерно 256 MB RAM и CPU worker 512 MB, оставляя ресурс для ОС и Caddy. Это cgroup пределы, а не обещание, что любой notebook в них поместится. Выход за предел RAM может завершить worker/kernel; автоматически повторять пользовательский код при неопределённом результате нельзя. На этом VPS запускается не более одного интерактивного kernel (`--max-kernels 1`); тяжёлые модели, обучение, большие pandas datasets и много kernels нужно вынести на внешний worker.

Сервер допускает до 16 постоянных сессий, до четырёх ожидающих/активных execution на сессию. Его workspace ограничен 128 MiB, 8 MiB на файл и 4096 путями. Публичный compute snapshot ограничен 10 MiB в сериализованном JSON/base64 виде, RPC — 12 MiB; agent дополнительно допускает не более 256 файлов и 4 MiB суммарных декодированных данных. Большой проект не означает, что весь его объём разрешён в одном запросе исполнения. Начните с небольшого проекта; большие datasets не загружайте в общий snapshot.

Недавняя история ограничена 32 execution и 4 MiB общего output cache на сессию; отдельный поток execution — 1 MiB. Окончательные outputs вытесненной истории архивируются на диск с лимитом 128 MiB на сессию. После исчерпания retention старые outputs удаляются с явной отметкой об истечении срока хранения. Маленькие постоянные receipts сохраняют request/execution identity даже после удаления outputs: повтор того же request ID возвращает его состояние, а не запускает код снова. Поэтому нет lifetime лимита в 32 запуска, но permanent receipts продолжают занимать диск. Исходные notebook outputs и объединённые project artifacts учитываются в лимите workspace отдельно.

Эти ограничения не являются disk quota для всего VPS: сохранённые версии, receipts, broker данные, worker checkpoints, журналы, резервные копии и Python dependencies тоже занимают диск. Внешний agent по умолчанию хранит не более двух kernel, VPS unit — одного; освобождение или вытеснение idle kernel сбрасывает Python RAM и должно быть видно пользователю.

```bash
df -h / /var/lib
du -sh /var/lib/pair-notebook-vps /var/lib/pair-notebook-worker /opt/pair-notebook-worker-venv
systemctl show pair-notebook-server pair-notebook-worker -p MemoryCurrent -p MemoryPeak -p NRestarts
journalctl --disk-usage
systemctl list-timers pair-cert-renew.timer
```

Для 25 GB SSD держите минимум 3–5 GB свободными. Настройте ограничение journald, например отдельный `/etc/systemd/journald.conf.d/pair-notebook.conf` с `SystemMaxUse=128M` и `SystemKeepFree=1G`, затем перезапустите journald. Проверяйте диск и ошибки; systemd restart не лечит полный диск или повреждённые данные. Не удаляйте workspace, receipts, executions или broker lock вручную для «исправления» ошибок. Один data directory принадлежит одному процессу; второй writer должен отказать при старте.

`Restart=always` обеспечивает запуск службы после её неожиданного выхода; `systemctl stop` остаётся явной остановкой. ОС перезапускает службы после reboot. Это механизм восстановления, а не измеренный год uptime. Плановая смена версии worker или перезагрузка сбрасывает RAM kernel; сохранённые файлы и окончательные результаты должны оставаться на VPS. Неизвестное состояние execution нужно показать пользователю и проверить, а не скрыто повторить.

## 10. Резервная копия и восстановление

Резервируйте полный серверный data directory и credentials. Пароль хранится как salted hash, но токены участников и результаты всё равно являются секретными данными. Snapshot только Public файлов недостаточен для восстановления Private файлов и ACL. Плановая остановка worker теряет Python RAM; предварительно завершите ячейки и сохраните файлы.

Сервер хранит только hash member token: data directory сам по себе не восстанавливает credential владельца. Следующий пример включает `/root/owner.json`, созданный в разделе 7. Если сессию создали в VS Code, сначала экспортируйте owner credential через управление сессией и сохраните его отдельную защищённую копию; замените путь в команде архивации своим файлом. Не помещайте credentials в project workspace.

```bash
systemctl stop pair-notebook-worker.service
systemctl stop pair-notebook-server.service
install -d -o root -g root -m 0700 /root/pair-backups
pair_backup=/root/pair-backups/pair-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
umask 077
tar -czf "$pair_backup" -C / var/lib/pair-notebook-vps etc/pair-notebook root/owner.json
sha256sum "$pair_backup" > "$pair_backup.sha256"
systemctl start pair-notebook-server.service
systemctl start pair-notebook-worker.service
unset pair_backup
```

Копию храните также вне VPS, по защищённому каналу и с шифрованием хранилища: архив на том же диске не защищает от отказа VPS. Если нужны worker artifacts, дополнительно резервируйте `/var/lib/pair-notebook-worker` после остановки worker; это не перенос Python RAM. Сертификаты могут быть перевыпущены; резервирование `/etc/letsencrypt` и Caddy settings требует такого же ограничения доступа.

Восстанавливайте только собственный проверенный архив, на остановленных службах, сначала в временный каталог. Перед заменой текущих данных сделайте свежую резервную копию. Например:

```bash
systemctl stop pair-notebook-worker.service
systemctl stop pair-notebook-server.service
pair_restore=$(mktemp -d /var/tmp/pair-restore.XXXXXX)
tar -xzf /root/pair-backups/SELECTED_BACKUP.tar.gz -C "$pair_restore"
test -d "$pair_restore/var/lib/pair-notebook-vps"
test -f "$pair_restore/etc/pair-notebook/server.env"
test -f "$pair_restore/root/owner.json"
rsync -a --delete "$pair_restore/var/lib/pair-notebook-vps/" /var/lib/pair-notebook-vps/
rsync -a "$pair_restore/etc/pair-notebook/" /etc/pair-notebook/
install -o root -g root -m 0600 "$pair_restore/root/owner.json" /root/owner.json
chown -R pair-server:pair-server /var/lib/pair-notebook-vps
chmod 0700 /var/lib/pair-notebook-vps
chown root:root /etc/pair-notebook/server.env /etc/pair-notebook/admin.token
chmod 0600 /etc/pair-notebook/server.env /etc/pair-notebook/admin.token
chown root:pair-worker /etc/pair-notebook/interactive-vps.token
chmod 0640 /etc/pair-notebook/interactive-vps.token
systemctl start pair-notebook-server.service
systemctl start pair-notebook-worker.service
unset pair_restore
```

После восстановления проверьте тот же ID сессии, пароль, участника, Private ACL, содержимое контрольного файла и новый execution. Проверьте неопределённые jobs до повторного запуска. Не копируйте живой data directory между двумя одновременно работающими серверами.

## 11. Обновление и откат

1. Завершите активные интерактивные execution, сохраните файлы, сделайте полную копию, запишите установленную версию.
2. Распакуйте и проверьте новую **совпадающую** пару server/VSIX отдельно. Не запускайте новый server на production data directory до остановки старого.
3. Остановите worker и server. Переместите прежний `/opt/pair-notebook/server` в отдельный каталог версии; установите новую версию на прежний путь, сохраняя root ownership.
4. Не меняйте `/etc/pair-notebook` и `/var/lib/pair-notebook-vps`; обновите unit только если этого требует новая версия. Запустите server, проверьте health и существующий вход/ACL, затем worker и notebook execution.
5. Обновите расширения участников той же версией. При несовместимой миграции rollback требует прежнего server, прежнего VSIX **и данных из копии до миграции**. Не направляйте старый код на мигрированную базу без подтверждённой обратной совместимости.

Проверка отсутствия приватных данных, работа двух реальных VS Code, реальный GPU, reboot данного VPS, испытание renewal и продолжительное наблюдение являются отдельными критериями готовности. Эта инструкция не выдаёт их за уже выполненные проверки.


## 12. Синхронизация, discovery и приглашения 0.6.3

Join требует адрес VPS и пароль. `discover` возвращает только подходящие running sessions; при нескольких сессиях расширение предлагает выбор. Пароль повторно проверяется при join. Общий rate limit ограничивает password/discovery/invitation attempts. Owner создаёт invitation в Manage: read-only либо Public edit/execute, lifetime до семи дней (UI — 24 часа). Ссылка содержит session ID и отдельный случайный invitation token в fragment; сервер хранит hash. Revoke invitation отзывает полученные через неё member credentials. Password rotation отзывает приглашения и участников. Invitation не является admin/member bearer.

Открытые VPS notebooks синхронизируются через Yjs. Stable cell IDs, порядок, source и metadata сохраняются вместе с CRDT state в атомарном notebook blob; retry одного update не заменяет поздние edits. Локальный replica journal записывается до отправки. При смене privacy/замене notebook старый epoch отвергается: UI предлагает сохранить replica отдельно и загрузить серверную версию. Execution admission сверяет отображаемый source hash, ID и acknowledged revision; сохранённые request IDs предотвращают скрытый rerun после потерянного HTTP ACK.

Manage → Synchronize a local folder continuously связывает выбранную локальную папку с server folder. Состояние связи восстанавливается после reload, reconciliation использует durable hash baseline, CAS, rename с сохранением ACL и ручной выбор конфликтующей версии. До выбора обе копии сохраняются. `.git` и `.pair-notebook-conflicts` исключены; links/special files отвергаются. Неоднозначный offline rename с одновременной правкой Private файла сохраняет Private lineage в журнале до удаления старого пути; новый файл и новые родительские папки создаются атомарно как Private. Публикация такой копии требует отдельной явной смены ACL. Большие datasets не входят в этот протокол. Сочетание одновременного локального редактирования notebook через folder sync и виртуального notebook editor требует отдельной проверки двумя настоящими VS Code; целесообразно открывать shared notebook в VPS workspace.

## 13. Защищённые VM/container agents

Windows: установите WSL2 и выделенную Ubuntu distribution штатными средствами Microsoft. Launcher использует выбранное имя distribution; не завершает чужие службы и не удаляет distro. `-Action Install` устанавливает Linux venv, bubblewrap и копии только agent/bridge; `Check` выполняет настоящую readiness probe. Запуск от root запрещён. Используйте non-root default user и credentials в его Linux private directory.

```powershell
./scripts/pair-notebook-wsl-agent.ps1 -Distro PairNotebook -Action Install
./scripts/pair-notebook-wsl-agent.ps1 -Distro PairNotebook -Action Check
./scripts/pair-notebook-wsl-agent.ps1 -Distro PairNotebook -Action Run -AgentArguments @('--config','/home/pair/device.json','--state','/home/pair/agent-state','--share')
```

Python и runtime находятся в WSL2; это Linux compute, не выбранный Windows conda/venv. Bubblewrap разрешает только workspace, system/Python roots и bridge, не `/mnt/c`, Windows home или весь диск. Отзыв sharing/consent выполняется через server UI; foreground launcher завершается Ctrl-C с освобождением kernels. Для unattended startup настройте службу в выбранной distro и подтвердите её lifecycle на Windows; автоматическая установка Windows service пока не реализована.

macOS/Linux: установите Docker Desktop/Engine, запустите Linux daemon. На macOS включите штатный локальный Docker socket в настройках Desktop; coordinator не меняет host HOME и использует только уже настроенные Docker selectors. Containerfile готовит реальный venv. CA для build — доверенный bundle вашей среды; не отключайте verification. В образе нет credentials, host home и Docker socket. Зафиксируйте immutable image ID после сборки:

```bash
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -f deploy/persistent/Containerfile --iidfile /tmp/pair-runtime-image deploy/persistent
python3 scripts/pair-notebook-session-agent.py --runtime-image "$(cat /tmp/pair-runtime-image)" --runtime-python /opt/pair-python/bin/python --check-isolation
python3 scripts/pair-notebook-session-agent.py --config /PRIVATE/device.json --state /PRIVATE/agent-state --share --runtime-image "$(cat /tmp/pair-runtime-image)" --runtime-python /opt/pair-python/bin/python --runtime-cpus 1 --runtime-memory-mb 512
```

На macOS выберите существующий trusted CA bundle для build. Docker Desktop использует Linux VM: выбранный interpreter — `/opt/pair-python/bin/python` внутри image. Host Python только запускает coordinator. Каждый kernel: non-root UID/GID владельца coordinator (согласован с правами bind workspace), read-only image, network none, cap-drop ALL, no-new-privileges, pids 128, CPU/RAM/swap limits, bounded tmpfs и два mounts `/work`, `/bridge.py`. Остановка удаляет точный container; восстановление agent удаляет только orphan containers с его label после получения single-writer lock. Native Windows Python coordinator запрещён: Linux no-follow operations выполняет WSL2.

## 14. Полный disk budget: обязательное production решение

Workspace quota сама по себе недостаточна. Для VPS 25 GB выделите отдельные quota-limited файловые системы/volumes: server data **4 GiB** (workspace/blobs/commands/receipts/results/broker), worker state **4 GiB**, фиксированные dependencies/images **до 6 GiB**, journald **128 MiB**, reserve root **не менее 5 GiB**. Docker writable kernels используют тот же ограниченный worker volume; tmpfs не заменяет его disk quota. Backup храните вне этих volumes и вне VPS. Конкретное устройство/partition/quota ID устанавливается только после инвентаризации и проверенного backup; данный checkout не форматирует VPS.

Provisioning считается незавершённым до реальной проверки kernel/worker write до границы quota, `ENOSPC`/`EDQUOT`, сохранения опубликованных manifests, retry после освобождения безопасного места и reboot с установленными mounts. Настройте alerts при 70/85%, запрет нового admission при 90%, bounded journald, fixed images и off-host backup retention. Никогда не удаляйте permanent receipts: их потеря допускает повторное исполнение старых request IDs. При исчерпании quota сохраняйте receipts/ACL и останавливайте новые записи; переносите session store целиком на больший проверенный volume или явно завершайте старую сессию. Outputs имеют существующую bounded history retention; blobs собираются на recovery; worker receipts/retained results сохраняются в пределах OS quota до ручного завершения сессии и проверенного archive. Без настроенной OS quota полная disk bound **не подтверждена**.

## 15. Длительный soak

`scripts/persistent-session-soak.py --evidence /PRIVATE/soak --image-file /PRIVATE/image-id` запускает реальные Host, два sessions, два isolated executor, Jupyter, reconnect, idempotent admission, consent/revoke, kernel restart и Host restart. Default duration — 24 часа реального monotonic time; меньшая acceptance duration запрещена. `--check` выполняет короткую проверку harness и явно записывает `acceptance24Hours=false`. JSONL содержит elapsed time, execution IDs, ledger counts, RSS/disk/process/kernel samples; summary становится true только после измеренных 86400 секунд. Состояние/credentials evidence directory — Private, не включайте его в публичные CI artifacts. Публичны только очищенные metrics/summary, runtime image ID и test logs. Ни короткий harness, ни запущенный процесс не являются завершённой 24-hour приёмкой; успешные 24 часа не доказывают год uptime.
