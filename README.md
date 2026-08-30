# Pair Notebook

[![Latest release](https://img.shields.io/github/v/release/r7zex/jupyter_pair_ext?display_name=tag&sort=semver)](https://github.com/r7zex/jupyter_pair_ext/releases/latest)
[![Release workflow](https://github.com/r7zex/jupyter_pair_ext/actions/workflows/release.yml/badge.svg)](https://github.com/r7zex/jupyter_pair_ext/actions/workflows/release.yml)
[![Download VSIX](https://img.shields.io/badge/download-VSIX-2ea44f)](https://github.com/r7zex/jupyter_pair_ext/releases/latest)

Pair Notebook is a self-contained VS Code extension for collaborative editing and remote execution across project files and Jupyter notebooks. Yjs keeps document state conflict-free; authenticated peers use direct WebRTC when possible and automatically retain a redundant encrypted Nostr/MQTT full-data route when direct connectivity is unavailable.

## What it provides

- Live text, notebook structure, outputs, files, directories, renames, deletions, and participant cursors.
- Host-owned durable storage with folderless joins, deterministic failover, and explicit safe folder selection after host transfer.
- Direct WebRTC for the normal low-latency path, optional user-configured TURN, and two independent encrypted emergency relay families.
- Recoverable remote notebook execution with idempotent requests, route-aware file barriers, ordered output replay, and exactly-once stdin handling.
- A bundled runtime: collaborators install only the VSIX and do not need a Pair Notebook account, daemon, server, mesh client, or npm package.

## Install

Open the [latest GitHub Release](https://github.com/r7zex/jupyter_pair_ext/releases/latest), download its single `pair-notebook-<version>.vsix` file, and install it on **both computers** from **Extensions: Install from VSIX...**, or run:

```powershell
code --install-extension ".\path\to\pair-notebook-<version>.vsix" --force
```

That is the complete collaboration setup. Trystero, the Nostr discovery client, WebSocket compatibility code, and the WebRTC implementation are bundled into the VSIX. Users do not install a mesh client, daemon, server, npm package, or port-forwarding rule. There is no account, no API key and no runtime download after installation.

VS Code 1.95 or newer and internet access are required. Python, `jupyter_client`, and `ipykernel` are only required on a computer selected to execute notebook cells; text and notebook collaboration itself does not require them.

## How Pair Notebook connects

Pair Notebook tries several independent ways to reach the other participant and always shows which one is currently in use:

1. **Direct P2P** — encrypted WebRTC over ICE (STUN-assisted). Near-ping latency; this is the normal path.
2. **Optional custom TURN relay** — when you configure `pairNotebook.turnUrls`, WebRTC can relay through that service; UDP, TCP and TLS transports are probed and reachable ones are preferred. Pair Notebook does not ship anonymous TURN credentials or claim a dead public demo as a fallback.
3. **Redundant encrypted emergency relay** — if ICE cannot build any path (cross-VPN setups, UDP blocked), every session frame is sent as AES-256-GCM ciphertext through independent Nostr and MQTT infrastructures. Either family can carry the complete session. The token and plaintext frames never reach relay operators, but the operators can observe the stable session topic, routing identifiers, timing, packet sizes, and chunk counts.

Signalling runs over TWO independent families concurrently — multiple health-checked public Nostr relays plus a public MQTT broker set — so the failure of one family or relay no longer stalls discovery; a participant discovered through both families still appears exactly once. All WebSocket-based channels honour `pairNotebook.proxyUrl`, `http.proxy` from VS Code, the standard `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables, and the current Windows system proxy. HTTP(S), SOCKS4, SOCKS5 and SOCKS5h are supported; proxy credentials are never logged or displayed. For an authenticated explicit proxy, keep only the endpoint and optional username in `pairNotebook.proxyUrl`, then run **Pair Notebook: Set Proxy Password** so the password stays in VS Code SecretStorage and remains bound to that exact endpoint and username.

Start and Join include a strict relay-readiness barrier: Pair Notebook requires an encrypted publish-to-receive self-check through at least one complete emergency family (Nostr or MQTT) before it declares the local transport ready. A merely open WebSocket, rejected subscription, or write-only relay cannot pass. Both families are attempted, established paths are periodically revalidated, and a later publication rejection retires that path and triggers recovery. Join is reported as connected only after the two computers complete the signed end-to-end handshake. With a common working outbound WSS route, Flowseal/zapret and Karing therefore retain independently tested full-data paths even when WebRTC and TURN are unavailable.

A lost physical route now enters a bounded logical recovery lease instead of immediately removing the participant or electing a new host. Cell requests, file-version barriers, ordered Jupyter events, terminal results, stdin replies, Interrupt, and Restart all wait for or reconcile across the replacement authenticated route. An accepted cell is keyed by one idempotent request ID, so recovery cannot execute it twice.

On Windows, Karing TUN needs no special setup because it transparently routes application traffic. Karing's **Auto Set System Proxy** mode is detected from the current user's WinINet settings; Pair Notebook refreshes that value before Start, Join and Reconnect. If another client uses PAC only or does not register its listener as the Windows system proxy, set `pairNotebook.proxyUrl` to its local HTTP/SOCKS URL, for example `http://127.0.0.1:10809`. Password-bearing URLs from older versions are migrated once on activation; newly entered embedded passwords are removed and rejected with guidance to use the secret-storage command.

## The Connection section

The left Pair Notebook panel shows, per participant:

- the current route (`Direct P2P · WebRTC · 23 мс` or the encrypted-relay fallback) with a colour-coded dot (theme-aware green/yellow/orange/gray plus text labels);
- an honest assessment: "Соединение уже оптимально" for healthy direct routes, "Возможно доступно более прямое соединение" only when diagnostics support it;
- live optimization progress ("Проверяем прямой канал… Текущее соединение активно") and remote migration notices ("Иван проверяет лучший маршрут…").

### Try to improve

The **Попробовать улучшить** button launches a safe route-optimization attempt with a make-before-break guarantee:

- the current connection keeps carrying traffic during the whole attempt;
- a candidate direct connection is built in parallel, authenticated with the same signed identity handshake, pinged and observed through a short stability window;
- only a proven better candidate is promoted atomically; the old route is retired afterwards;
- a failed attempt changes nothing — the message is "Улучшить не удалось — текущее соединение сохранено".

The button never modifies VPN/DNS/zapret/firewall/router settings and never requires administrator rights.

## Diagnostics

Passive diagnostics run automatically with ordinary user permissions: adapter classification (VPN/TUN detection), configured-proxy detection, DNS resolution checks of signalling hosts, and custom TURN probes when configured. UDP is reported unavailable only when UDP probes fail while a TCP/TLS control path succeeds; if every TURN path fails, UDP remains unknown because DNS, credentials, the TURN service, routing, or filtering can produce the same result. Every conclusion carries an explicit confidence level (confirmed/high/medium/low); filtering software such as zapret/Flowseal is never named as a confirmed cause without direct evidence — correlated symptoms are listed as possible causes instead. Nothing is ever changed on the system by diagnostics.

## Start a session

1. Open the Pair Notebook activity-bar panel.
2. Select **Start session**.
3. Enter the participant name other people should see.
4. Select the folder the host will own and persist. A separate extension-managed working copy opens automatically.
5. Copy the invite and send it only to trusted participants.

The host is the only participant that writes the canonical backing folder. A Dropbox, OneDrive, or other synchronized folder can be selected, but the cloud-storage provider is not used for live transport.

## Join a session

1. Install the VSIX and open the Pair Notebook panel.
2. Select **Join**, paste the complete `pair-notebook://` invite, and enter your name.
3. Wait for the host snapshot to finish.

A joining participant is never asked for a project folder. Pair Notebook creates an isolated working copy under the local application-data directory, opens it, and keeps it synchronized with the session. The participant name is validated and must be unique within the live room.

## Host transfer and failover

Every new session is resilient:

- A graceful host departure first drains peer traffic and flushes the latest state to the old host folder.
- An abrupt departure is covered by continuous atomic host persistence, which uses a 750 ms idle debounce by default and does not repeatedly force-save open editors.
- The earliest eligible connected participant becomes the new host deterministically.
- Every participant sees a paused state. Persistence, invitations, host transfer, session ending, and notebook execution remain disabled during the pause.
- The new host has a persistent **Choose host folder** action even after cancelling a dialog. They explicitly choose either an empty folder that receives the current session, or an existing synchronized folder (for example Dropbox) that is fully hash-checked and attached without rewriting when it matches.
- A non-empty mismatched folder is never changed implicitly. The new host must explicitly write the current session into it or choose another folder; cancelling keeps the session paused and the retry action visible.
- The previous host folder is not deleted or moved. If it is synchronized by Dropbox or another provider, its last completed host writes remain available there.

Editing state remains in the CRDT during the short folder-selection pause, so an accidental keystroke is not discarded. The new host materializes the current merged state before the session resumes.

## Saving behavior

Live text and notebook updates are sent immediately; disk persistence is separate and debounced. The canonical host copy and join snapshots are serialized directly from current CRDT state, so an unsaved open editor cannot make a new participant receive stale disk contents.

Pair Notebook does not call VS Code's document or notebook `save()` method after every keystroke. That avoids repeatedly triggering format-on-save, save hooks, notebook serialization, and other extensions. Open editors are explicitly saved only for operations that require a physical filesystem barrier, such as execution, final host save, and host transfer. Closed files are written atomically.

The host also maintains rotating local recovery snapshots every five minutes and retains the latest three. Snapshot directories are staged and published atomically. Binary files, invalid-UTF-8 files, malformed notebooks treated as binary, empty directories, renames, deletions, notebook outputs, and stable cell IDs are included in synchronization.

## Network and security

Trystero uses public Nostr and MQTT services for encrypted discovery. Project data normally travels through encrypted WebRTC data channels; when ICE cannot form a path, both emergency families encrypt the complete Pair Notebook frame with AES-256-GCM before publishing it through Nostr relays and MQTT brokers. Duplicate deliveries are removed before the signed participant handshake. Public operators cannot read project frames or the token, but can observe the stable session topic, sender/recipient routing identifiers, timing, packet sizes, and chunk counts. The invite token is used as the Trystero room password and is stored in VS Code SecretStorage.

Each participant also owns an Ed25519 identity key. The private key remains in VS Code SecretStorage; the invite pins the host public key, and authenticated peer keys remain pinned across disconnects and failover. This prevents another invite holder from impersonating a known offline participant. Protocol v4, first released in Pair Notebook 0.5.6, signs every emergency-relay envelope and intentionally rejects protocol-v3 and older clients; all participants must install 0.5.6 or another explicitly protocol-v4-compatible release.

The invite is a bearer secret: anyone who receives it can attempt to join. Remote notebook execution can run code on a selected participant's computer, so sessions must contain only trusted people. Beginning with Pair Notebook 0.5.6, remote-compute consent starts disabled for every new or restored session and must be enabled again locally for that active session. The invite-derived emergency-relay key does not provide forward secrecy: someone who records relay ciphertext and later obtains the invite may decrypt that recorded traffic. If an invite may have leaked, end the session and create a new one with a fresh invite; reconnecting the old session does not rotate its key.

Most consumer and office networks connect directly or through STUN alone. Where they cannot, Pair Notebook can use a custom TURN relay (`pairNotebook.turnUrls` + secret-stored password, for users who operate or trust one) and independently falls back to the built-in encrypted Nostr + MQTT emergency route, which needs nothing from the user. There is no built-in TURN service: the former Open Relay demo is not sent to Trystero, probed, or advertised because it is no longer operational anonymously. Direct peer-to-peer connections are always preferred when the network allows them; relays only carry already-encrypted traffic as a last resort.

## Development

```powershell
npm install
npm run lint
npm test
npm run test:live
npm run artifacts
```

`npm test` uses in-memory Trystero, Nostr and MQTT relays to make transport and failover tests deterministic. `npm run test:live` verifies public Nostr discovery plus a real WebRTC data-channel exchange. `npm run test:live:relay` disables WebRTC and both signalling rooms, then verifies eight-by-64-KiB direct-to-system-proxy bursts across all seven compatible ordered Nostr-only, MQTT-only, and redundant-family combinations.

The public GitHub Release intentionally has one uploaded asset:

- `pair-notebook-<version>.vsix` — the ready-to-install extension. GitHub displays its SHA-256 digest next to the file.

GitHub automatically adds **Source code (zip)** and **Source code (tar.gz)** links; those archives are for reading the source and are not installable extensions. The verified source snapshot is retained with the GitHub Actions run for audit and recovery instead of being presented as another user download.

To publish a new release, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then push a matching `v<version>` tag. GitHub Actions rebuilds and verifies the artifacts before publishing them; an existing tag can also be republished from the **Release Pair Notebook** workflow.

See the [documentation index](docs/README.md), [architecture](docs/architecture.md), and [protocol](docs/protocol.md) for current implementation details. Version-specific audits and repair records are preserved separately as release evidence.
