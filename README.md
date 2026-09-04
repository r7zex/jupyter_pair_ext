# Pair Notebook

[![Latest release](https://img.shields.io/github/v/release/r7zex/jupyter_pair_ext?display_name=tag&sort=semver)](https://github.com/r7zex/jupyter_pair_ext/releases/latest)
[![Release workflow](https://github.com/r7zex/jupyter_pair_ext/actions/workflows/release.yml/badge.svg)](https://github.com/r7zex/jupyter_pair_ext/actions/workflows/release.yml)
[![Download VSIX](https://img.shields.io/badge/download-VSIX-2ea44f)](https://github.com/r7zex/jupyter_pair_ext/releases/latest)

Pair Notebook is a self-contained VS Code extension for collaborative editing and remote execution across project files and Jupyter notebooks. Yjs keeps document state conflict-free; authenticated peers use direct WebRTC when possible and automatically retain a redundant encrypted Nostr/MQTT full-data route when direct connectivity is unavailable.

## What it provides

- Live text, notebook structure, outputs, files, directories, renames, deletions, and participant cursors.
- Host-owned durable storage with folderless joins, host authority pinned until an explicit transfer, and safe folder selection after transfer.
- Direct WebRTC for the normal low-latency path, optional user-configured TURN, and two independent encrypted emergency relay families.
- Recoverable remote notebook execution with idempotent requests, route-aware file barriers, ordered output replay, and exactly-once stdin handling.
- A bundled runtime: collaborators install only the VSIX and do not need a Pair Notebook account, daemon, server, mesh client, or npm package.

## Install

Open the [latest GitHub Release](https://github.com/r7zex/jupyter_pair_ext/releases/latest), download its single `pair-notebook-<version>.vsix` file, and install it on **both computers** from **Extensions: Install from VSIX...**, or run:

```powershell
code --install-extension ".\path\to\pair-notebook-<version>.vsix" --force
```

That is the complete collaboration setup. Trystero, the Nostr discovery client, WebSocket compatibility code, and the WebRTC implementation are bundled into the VSIX. Users do not install a mesh client, daemon, server, npm package, or port-forwarding rule. There is no account, no API key and no runtime download after installation.

VS Code 1.95 or newer and internet access are required. Python, `jupyter_client`, and `ipykernel` are required only on the session host, because every participant's notebook cells execute there. Text and notebook collaboration on guest computers does not require Python.

## How Pair Notebook connects

Pair Notebook tries several independent ways to reach the other participant and always shows which one is currently in use:

1. **Direct P2P** — encrypted WebRTC over ICE (STUN-assisted). Near-ping latency; this is the normal path.
2. **Optional custom TURN relay** — when you configure `pairNotebook.turnUrls`, WebRTC can relay through that service; UDP, TCP and TLS transports are probed and reachable ones are preferred. Pair Notebook does not ship anonymous TURN credentials or claim a dead public demo as a fallback.
3. **Redundant encrypted emergency relay** — if ICE cannot build any path (cross-VPN setups, UDP blocked), every session frame is sent as AES-256-GCM ciphertext through independent Nostr and MQTT infrastructures. Either family can carry the complete session. The token and plaintext frames never reach relay operators, but the operators can observe the stable session topic, routing identifiers, timing, packet sizes, and chunk counts.

Signalling runs over TWO independent families concurrently — multiple health-checked public Nostr relays plus a public MQTT broker set — so the failure of one family or relay no longer stalls discovery; a participant discovered through both families still appears exactly once. All WebSocket-based channels honour `pairNotebook.proxyUrl`, `http.proxy` from VS Code, the standard `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables, and the current Windows system proxy. HTTP(S), SOCKS4, SOCKS5 and SOCKS5h are supported; proxy credentials are never logged or displayed. For an authenticated explicit proxy, keep only the endpoint and optional username in `pairNotebook.proxyUrl`, then run **Pair Notebook: Set Proxy Password** so the password stays in VS Code SecretStorage and remains bound to that exact endpoint and username.

Start and Join include a strict relay-readiness barrier: Pair Notebook requires an encrypted publish-to-receive self-check through at least one complete emergency family (Nostr or MQTT) before it declares the local transport ready. A merely open WebSocket, rejected subscription, or write-only relay cannot pass. Both families are attempted, established paths are periodically revalidated, and a later publication rejection retires that path and triggers recovery. Join is reported as connected only after the two computers complete the signed end-to-end handshake. With a common working outbound WSS route, Flowseal/zapret and Karing therefore retain independently tested full-data paths even when WebRTC and TURN are unavailable.

A lost physical route enters a 60-second logical recovery lease instead of immediately removing the participant or changing the host. Pair Notebook checks network adapters every two seconds; after a VPN/TUN or proxy-route change it reloads the Windows system proxy, refreshes signalling sockets, reannounces remembered peers, and retires a half-open data channel only after repeated failed probes. Cell requests, file-version barriers, ordered Jupyter events, terminal results, stdin replies, Interrupt, and Restart wait for or reconcile across the replacement authenticated route. An accepted cell is keyed by one idempotent request ID, so recovery cannot execute it twice.

## Windows VPN setup: Karing or Happ

Use these steps on every computer whose provider or network blocks the normal Pair Notebook paths. Download only from the official projects: [Karing releases](https://github.com/KaringX/karing/releases) / [Karing site](https://karing.app/) or [Happ Desktop releases](https://github.com/Happ-proxy/happ-desktop/releases).

1. Add a working profile to Karing or Happ and connect it before starting or joining Pair Notebook.
2. Prefer **TUN mode**. It routes VS Code and its extension-host process without per-application proxy support. Do not run two TUN/VPN clients at the same time; Karing documents that another VPN can conflict with its TUN interface.
3. If TUN is unavailable, enable the client's Windows system-proxy mode. Pair Notebook reads the current user's WinINet proxy before Start, Join, Reconnect, and automatic VPN-route recovery.
4. If the client exposes a local proxy but does not register it as the Windows system proxy, copy the exact listener shown by the client into the VS Code setting `pairNotebook.proxyUrl`. Typical examples are `http://127.0.0.1:10809` and `socks5h://127.0.0.1:10808`; verify the actual protocol and port in your client. Happ's [local connections guide](https://github.com/HappDev/happ_su/blob/main/faq/local-network-connections.md) shows its HTTP/SOCKS listener and Windows proxy controls.
5. Run **Pair Notebook: Reconnect**, then open **Pair Notebook: Advanced Diagnostics**. The usable readiness signal is at least one verified encrypted Nostr or MQTT family followed by the signed peer handshake; a merely open proxy socket is not enough.

Keep a local proxy bound to `127.0.0.1` unless other devices deliberately need it. Do not enable **Allow LAN connections** or expose the proxy port to the local network just for Pair Notebook. Password-bearing proxy URLs are rejected; store an authenticated proxy password with **Pair Notebook: Set Proxy Password** so it remains in VS Code SecretStorage. No VPN vendor or public relay can guarantee availability on every provider, but TUN plus the verified emergency-relay check gives an observable end-to-end result.

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

## Host authority, transfer, and reconnect

The original host remains the host across heartbeat delays, signalling failures, VPN switches, partitions, and process stalls. No participant can elect or proclaim itself host.

- Host authority changes only when the current host selects **Transfer Host** and the selected participant completes the authenticated prepare/commit/finalize transfer.
- If the host route disappears, guests keep the current runtime during the bounded route-recovery window. If the host is still unreachable afterwards, guests leave the active runtime without deleting their isolated working copy, credentials, or Recent Projects entry.
- Opening that entry from **Recent Projects** retries the same pinned host identity. If its folder is already open, Pair Notebook reconnects in place without requiring a VS Code reload or another invite.
- Simply choosing **Leave Session** never transfers authority. Guests cannot replace an absent host; after a host-route loss they can only retry the same pinned host from Recent Projects.
- Continuous atomic host persistence uses a 750 ms idle debounce by default and does not repeatedly force-save open editors.
- During an explicit transfer, every participant sees a paused state. Persistence, invitations, and notebook execution remain disabled until the new host prepares storage.
- The new host has a persistent **Choose host folder** action even after cancelling a dialog. They explicitly choose either an empty folder that receives the current session, or an existing synchronized folder (for example Dropbox) that is fully hash-checked and attached without rewriting when it matches.
- The pause card and initial prompt also expose **Transfer Host** and **End Session**. Ending before a new shared folder is selected keeps the final merged state and authenticated termination marker in the participants' isolated working copies.
- A non-empty mismatched folder is never changed implicitly. The new host must explicitly write the current session into it or choose another folder; cancelling keeps the session paused and the retry action visible.
- The previous host folder is not deleted or moved. If it is synchronized by Dropbox or another provider, its last completed host writes remain available there.

Editing state remains in the CRDT during the short folder-selection pause, so an accidental keystroke is not discarded. The new host materializes the current merged state before the session resumes.

## Saving behavior

Live text and notebook updates are sent immediately; disk persistence is separate and debounced. The canonical host copy and join snapshots are serialized directly from current CRDT state, so an unsaved open editor cannot make a new participant receive stale disk contents.

Pair Notebook does not call VS Code's document or notebook `save()` method after every keystroke. That avoids repeatedly triggering format-on-save, save hooks, notebook serialization, and other extensions. Open editors are explicitly saved only for operations that require a physical filesystem barrier, such as execution, final host save, and host transfer. Closed files are written atomically.

The host also maintains rotating local recovery snapshots every five minutes and retains the latest three. Snapshot directories are staged and published atomically. Binary files, invalid-UTF-8 files, malformed notebooks treated as binary, empty directories, renames, deletions, notebook outputs, and stable cell IDs are included in synchronization.

## Network and security

Trystero uses public Nostr and MQTT services for encrypted discovery. Project data normally travels through encrypted WebRTC data channels; when ICE cannot form a path, both emergency families encrypt the complete Pair Notebook frame with AES-256-GCM before publishing it through Nostr relays and MQTT brokers. Duplicate deliveries are removed before the signed participant handshake. Public operators cannot read project frames or the token, but can observe the stable session topic, sender/recipient routing identifiers, timing, packet sizes, and chunk counts. The invite token is used as the Trystero room password and is stored in VS Code SecretStorage.

Each participant also owns an Ed25519 identity key. The private key remains in VS Code SecretStorage; the invite pins the host public key, and authenticated peer keys remain pinned across disconnects and voluntary transfer. This prevents another invite holder from impersonating a known offline participant. Protocol v5, first released in Pair Notebook 0.5.9, retains the signed emergency-relay envelope from v4 and makes host-canonical lightweight execution framing an admission boundary. It intentionally rejects v4 and older clients; all participants in a session must run a protocol-v5-compatible release.

The invite is a bearer secret: anyone who receives it can attempt to join. Every authenticated participant can run notebook code on the host, and there is deliberately no per-participant execution-deny flag, so sessions must contain only people the host trusts with code execution. Guests cannot redirect execution to their own computers or select a different executor. The invite-derived emergency-relay key does not provide forward secrecy: someone who records relay ciphertext and later obtains the invite may decrypt that recorded traffic. If an invite may have leaked, end the session and create a new one with a fresh invite; reconnecting the old session does not rotate its key.

Most consumer and office networks connect directly or through STUN alone. Where they cannot, Pair Notebook can use a custom TURN relay (`pairNotebook.turnUrls` + secret-stored password, for users who operate or trust one) and independently falls back to the built-in encrypted Nostr + MQTT emergency route, which needs nothing from the user. There is no built-in TURN service: the former Open Relay demo is not sent to Trystero, probed, or advertised because it is no longer operational anonymously. Direct peer-to-peer connections are always preferred when the network allows them; relays only carry already-encrypted traffic as a last resort.

## Development

```powershell
npm install
npm run lint
npm test
npm run test:live
npm run artifacts
```

`npm test` uses in-memory Trystero, Nostr and MQTT relays to make transport, pinned-host authority, and route-recovery tests deterministic. `npm run test:live` verifies public Nostr discovery plus a real WebRTC data-channel exchange. `npm run test:live:relay` disables WebRTC and both signalling rooms, then verifies eight-by-64-KiB direct-to-system-proxy bursts across all seven compatible ordered Nostr-only, MQTT-only, and redundant-family combinations.

The public GitHub Release intentionally has one uploaded asset:

- `pair-notebook-<version>.vsix` — the ready-to-install extension. GitHub displays its SHA-256 digest next to the file.

GitHub automatically adds **Source code (zip)** and **Source code (tar.gz)** links; those archives are for reading the source and are not installable extensions. The verified source snapshot is retained with the GitHub Actions run for audit and recovery instead of being presented as another user download.

To publish a new release, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then push a matching `v<version>` tag. GitHub Actions rebuilds and verifies the artifacts before publishing them; an existing tag can also be republished from the **Release Pair Notebook** workflow.

See the [documentation index](docs/README.md), [architecture](docs/architecture.md), and [protocol](docs/protocol.md) for current implementation details. Version-specific audits and repair records are preserved separately as release evidence.
