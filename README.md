# Pair Notebook

Pair Notebook 0.6.16 supports encrypted peer sessions, [persistent server workspaces](docs/PERSISTENT_VPS.md), and independent [background compute jobs](docs/PERSISTENT_RESEARCH.md). Persistent notebooks use durable Yjs replicas, optimistic local input, shared cursors and unrestricted same-line editing. Public and owner-only Private execution use separate isolated kernels and results.

See the [current documentation](docs/README.md) and [0.6.16 verification report](docs/SERVER_RELEASE_0_6_16.md) for executed installer, protocol and collaboration checks, measurement conditions and unverified acceptance layers. Historical evidence is source-specific and does not automatically qualify this release.

[![Latest release](https://img.shields.io/github/v/release/r7zex/jupyter_pair_ext?display_name=tag&sort=semver)](https://github.com/r7zex/jupyter_pair_ext/releases/latest)
[![Release workflow](https://github.com/r7zex/jupyter_pair_ext/actions/workflows/release.yml/badge.svg)](https://github.com/r7zex/jupyter_pair_ext/actions/workflows/release.yml)
[![Download VSIX](https://img.shields.io/badge/download-VSIX-2ea44f)](https://github.com/r7zex/jupyter_pair_ext/releases/latest)

Pair Notebook is a self-contained VS Code extension for collaborative editing and remote execution across project files and Jupyter notebooks. Yjs keeps document state conflict-free; authenticated peers use WebRTC and redundant encrypted Nostr, MQTT and Iroh data paths.

## Start a self-host session

1. [Download the VSIX](https://github.com/r7zex/jupyter_pair_ext/releases/latest), install with **Extensions: Install from VSIX...**, and reload VS Code.
2. Open Pair Notebook and choose **Start self-host session**. Choose your project folder and name.
3. Click **Invitation → Copy** and send the invitation to a collaborator.
4. They install the same extension, choose **Join self-host session**, and paste the invitation. Trust the empty guest folder when VS Code asks; connection and file download start afterward. Guest copies are removed on leave, failed join or editor exit. Your computer keeps the original project.

### Optional: your own WebSocket server

1. Download and extract **pair-notebook-ws-server.zip** from the same release.
2. **Windows:** double-click **pair-notebook-ws-server.cmd**, select the recommended Wi-Fi/Ethernet address (or enter your domain/IP), and trust `server/relay-ca.crt` on every participating computer. On Windows: `certutil -user -addstore Root server\relay-ca.crt`, then fully restart VS Code. **Linux VPS:** run `sh pair-notebook-ws-server.sh` for managed domain/IP HTTPS.
3. Set VS Code **Pair Notebook: Relay Url** to the HTTPS address (tray menu **Copy HTTPS address** on Windows), then create/share a self-host session.
4. On Windows, click the tray icon once to stop/start the server; **Exit** stops it and closes the tray. Internet hosting requires reachable/forwarded ports; the Windows launcher uses a local trust certificate.

## Create a VPS-hosted project

1. Use **Ubuntu 24.04 LTS or Debian 12 with systemd**. Connect with `ssh USER@SERVER_IP`.
2. Download and run setup on the VPS:

   ```sh
   curl -fL --proto '=https' --proto-redir '=https' https://github.com/r7zex/jupyter_pair_ext/releases/latest/download/pair-notebook-server-setup.sh -o pair-notebook-server-setup.sh && sh pair-notebook-server-setup.sh
   ```

3. Choose **domain** if your DNS A/AAAA record points to the VPS, or **ip** if you only have its public IP. Allow incoming TCP **80** and the selected HTTPS port, usually **443**. Existing Caddy/nginx and LAN modes are also available.
4. Confirm and wait for the checks. Setup installs HTTPS, automatic services, isolated Jupyter and the relay, then deletes the downloaded setup script.
5. In VS Code choose **Create server project**, enter the printed HTTPS address and administrative credential, then your project name, **owner name** and session password. You become the owner; **VPS** is the host.
6. Others choose **Connect to server → Join a persistent session** with the address/password, or use your copied invitation. Open notebooks from **Server project** in Explorer.

To update after this setup, run `sudo pair-notebook-server update`; no manual download is needed. Check first with `sudo pair-notebook-server check`. For daily automatic updates, run `sudo pair-notebook-server auto-update enable` (`disable` turns it off, `status` checks it). Automatic installation waits until all saved server projects are stopped, including their interactive kernels; a relay-only server requires an explicit update. An older installation needs this setup once to install the management command.

To remove the server, download **pair-notebook-server-remove.sh**, run `sh pair-notebook-server-remove.sh` and confirm. Removal exports only `.py` and `.ipynb` files to a private directory on the VPS, then removes Pair services, keys, history and runtimes. [Detailed setup and recovery](docs/SERVER_SETUP.md).

### Karing TUN: keep local/server connections outside the VPN tunnel

1. On both computers open **Settings → Diversion → Diversion rules → Edit → Custom diversion group** and add a group for Pair Notebook.
2. Add the relay/server address under **IP Cidr**, for example `192.168.1.20/32` for one LAN host, or its actual LAN subnet if all local devices must use direct routing. For a domain use **Domain**. Use the address selected by the WS launcher, not the VPN adapter address.
3. Save the group, return to **Diversion rules**, and set its matching action to **Direct connection**. Apply the configuration using Karing's reconnect control when convenient. See [Karing custom rules](https://karing.app/en/tutorial/custom-diversion) and [matching actions](https://karing.app/en/tutorial/diversion).
4. Set **Pair Notebook: Relay Url** before creating the invitation. Both computers must reach the same HTTPS address and trust its certificate. Internet access through a home router additionally requires port forwarding or a reachable VPS.

These steps change only matching traffic. Sharing a VPN exit does not place two computers on the same LAN or guarantee WebRTC connectivity. Pair Notebook keeps its encrypted outbound fallback paths; a private WS server provides a separate route when those services are blocked. The extension and launcher do not modify VPN routes.

## What it provides

- Peer sessions: live text, notebook structure, outputs, files, directories, renames, deletions and participant cursors. Persistent server sessions: live notebook replicas and file/folder reconciliation; live character editing of ordinary text files is not established by the notebook acceptance.
- Host-owned durable storage with folderless joins, host authority pinned until an explicit transfer, and safe folder selection after transfer.
- Direct WebRTC, optional user-configured TURN, Nostr/MQTT relay fallback and bundled Iroh QUIC with independent discovery and relay support.
- Recoverable remote notebook execution with idempotent requests, route-aware file barriers, ordered output replay, and exactly-once stdin handling.
- A shared host command terminal: everyone can view its output; the current host enters commands and confirms shell interruption with exact typed `CONFIRM`. Open **Host terminal** in the session sidebar or **Pair Notebook: Open Shared Host Terminal** from the Command Palette.
- Optional [own server relay and persistent compute agents](docs/VPS_COMPUTE.md): encrypted collaboration through your server and CPU/GPU Python jobs on any registered PC, continuing while the submitting laptop is off.
- [Server-hosted projects](docs/PERSISTENT_VPS.md): durable projects, password membership, public/private folder ACLs, device-owner consent, CPU/GPU selection, and stateful interactive Jupyter through a Linux compute agent. Use **Connect to Server**; the earlier broker connection is **Connect to Server Compute**.
- A bundled extension runtime. Peer collaborators need only the VSIX; persistent sessions additionally require an operator-managed HTTPS server and an isolated compute agent.

## Install the extension

Open [release v0.6.16](https://github.com/r7zex/jupyter_pair_ext/releases/tag/v0.6.16), download `pair-notebook-0.6.16.vsix`, and install it on every participating computer with **Extensions: Install from VSIX...**. Reload VS Code when prompted. The server setup utility contains its matching verified server package. The separate WebSocket server download provides a relay without Jupyter. GitHub adds source archives automatically. [Server installation and upgrades](docs/PERSISTENT_VPS.md) preserve session data and keep accepted execution separate from editor lifetime.

```powershell
code --install-extension ".\path\to\pair-notebook-0.6.16.vsix" --force
```

That is the extension setup for peer sessions. Trystero, the Nostr discovery client, WebSocket compatibility code, and the WebRTC implementation are bundled into the VSIX. Users do not install a mesh client, daemon, server, npm package, or port-forwarding rule. There is no account, no API key and no runtime download after installation.

The 0.6.16 VSIX also contains Iroh native binaries for Windows x64/ARM64,
Linux x64/ARM64 (glibc and musl), and macOS ARM64. Other platforms retain the
WebRTC/Nostr/MQTT paths. Iroh uses the existing authenticated invite identity;
Install 0.6.16 on every participant to use the matching runtime. HTTPS address lookup verifies the participant's signature
and complements native DNS TXT discovery.

If an application proxy is selected, Iroh is disabled because its current native
binding cannot apply that proxy. The other paths keep using the configured proxy.
VPN TUN routing works at the operating-system level. An unavailable selected
proxy produces an explicit endpoint error; the extension never changes or bypasses
your proxy settings automatically.

Session creation prepares the local host workspace while independent network
paths start concurrently. This does not mean a remote participant is already
connected. Connecting and receiving a snapshot can be cancelled; a failed attempt
does not stay locked behind its warning notification. A fixed connection duration
does not force an established-session exit.

Public services do not establish a 99% connection-success guarantee. That target
requires measurements across the intended Russian/German providers and VPN modes,
plus suitable relay capacity. Network diagnostics show the available paths and
authenticated participants separately.

VS Code 1.95 or newer and internet access are required. Python, `jupyter_client`, and `ipykernel` are required on the selected executor: the human host in peer mode, or an independent isolated agent in persistent mode. Text and notebook collaboration on guest computers does not require Python.

## How peer sessions connect

Pair Notebook tries several independent ways to reach the other participant and always shows which one is currently in use:

1. **Direct P2P** — encrypted WebRTC over ICE (STUN-assisted). Latency depends on the selected route and editor work; measure it on the participating networks.
2. **Optional custom TURN relay** — when you configure `pairNotebook.turnUrls`, WebRTC can relay through that service; UDP, TCP and TLS transports are probed and reachable ones are preferred. Pair Notebook does not ship anonymous TURN credentials or claim a dead public demo as a fallback.
3. **Redundant encrypted emergency relay** — if ICE cannot build any path (cross-VPN setups, UDP blocked), every session frame is sent as AES-256-GCM ciphertext through independent Nostr and MQTT infrastructures. Either family can carry the complete session. The token and plaintext frames never reach relay operators, but the operators can observe the stable session topic, routing identifiers, timing, packet sizes, and chunk counts.

Signalling runs over TWO independent families concurrently — multiple health-checked public Nostr relays plus a public MQTT broker set — so the failure of one family or relay no longer stalls discovery; a participant discovered through both families still appears exactly once. All WebSocket-based channels honour `pairNotebook.proxyUrl`, `http.proxy` from VS Code, the standard `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables, and the current Windows system proxy. HTTP(S), SOCKS4, SOCKS5 and SOCKS5h are supported; proxy credentials are never logged or displayed. For an authenticated explicit proxy, keep only the endpoint and optional username in `pairNotebook.proxyUrl`, then run **Pair Notebook: Set Proxy Password** so the password stays in VS Code SecretStorage and remains bound to that exact endpoint and username.

Start and Join include a strict relay-readiness barrier: Pair Notebook requires an encrypted publish-to-receive self-check through at least one complete emergency family (Nostr or MQTT) before it declares the local transport ready. A merely open WebSocket, rejected subscription, or write-only relay cannot pass. Both families are attempted, established paths are periodically revalidated, and a later publication rejection retires that path and triggers recovery. Join is reported as connected only after the two computers complete the signed end-to-end handshake. With a common working outbound WSS route, Flowseal/zapret and Karing therefore retain independently tested full-data paths even when WebRTC and TURN are unavailable.

A lost physical route enters a 30-second logical recovery lease instead of immediately removing the participant or changing the host. Pair Notebook checks network adapters every two seconds; after a VPN/TUN or proxy-route change it reloads the Windows system proxy, refreshes signalling sockets, reannounces remembered peers, and retires a half-open data channel only after repeated failed probes. Cell requests, file-version barriers, ordered Jupyter events, terminal results, stdin replies, Interrupt, and Restart wait for or reconcile across the replacement authenticated route. An accepted cell is keyed by one idempotent request ID, so recovery cannot execute it twice.

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

## Participant permissions and comments

Use **Pair Notebook: Права участников** (or **Права участников** in the session panel / server management menu) to choose editable files and additional permissions. Select lines in a file or notebook cell, right-click and choose **Pair Notebook: Комментарий к строкам**. The line highlight and badge use the author’s cursor color; hover shows the full comment. **Закрыть комментарий** is available to its author and the host/owner. [Usage and execution boundaries](docs/PARTICIPANT_PERMISSIONS_AND_COMMENTS.md).

## Start a peer session

1. Open the Pair Notebook activity-bar panel.
2. Select **Start session**.
3. Enter the participant name other people should see.
4. Select the folder the host will own and persist. A separate extension-managed working copy opens automatically.
5. If VS Code asks for Workspace Trust in that isolated folder, select **Trust**. Pair Notebook then completes this one Start action automatically.
6. Copy the invite and send it only to trusted participants.

The host is the only participant that writes the canonical backing folder. A Dropbox, OneDrive, or other synchronized folder can be selected, but the cloud-storage provider is not used for live transport.

## Join a peer session

1. Install the VSIX and open the Pair Notebook panel.
2. Select **Join**, paste the complete `pair-notebook://` invite, and enter your name.
3. Wait for the host snapshot to finish. If VS Code asks for Workspace Trust after opening the isolated copy, select **Trust**; the already requested Join continues once automatically.

A joining participant is never asked for a project folder. Pair Notebook creates an isolated working copy under the local application-data directory, opens it, and keeps it synchronized with the session. The participant name is validated and must be unique within the live room.

## Host authority, transfer, and reconnect

The original host remains the host across heartbeat delays, signalling failures, VPN switches, partitions, and process stalls. No participant can elect or proclaim itself host.

- Host authority changes only when the current host selects **Transfer Host** and the selected participant completes the authenticated prepare/commit/finalize transfer.
- If the host route disappears, guests keep the current runtime during the bounded route-recovery window. If the host is still unreachable afterwards, guests leave the active runtime without deleting their isolated working copy, credentials, or Recent Projects entry.
- A Start/Join action may continue once after its isolated folder becomes trusted, but only in the same VS Code main process and for the exact saved session, participant, and folder. Pair Notebook remains loaded in Restricted Mode only for this explicit handoff; it starts no runtime or network session until Trust is granted. A VS Code restart, extension reinstall, and unrelated markers never reconnect by themselves; they only offer a manual **Connect** action.
- Opening an entry from **Recent Projects** explicitly retries the same pinned host identity. If its folder is already open, Pair Notebook reconnects in place; otherwise it opens the isolated folder and asks for confirmation after the VS Code reload.
- Graceful VS Code shutdown and a detected system-suspend gap leave the active runtime locally and record the exit. Suspend detection is armed only after startup completes, so folder Trust and startup delays cannot eject a new runtime. Recent Sessions show the Session Host nickname, relative minutes/hours/days since exit, and the exact `dd/mm/yy` date.
- Simply choosing **Leave Session** never transfers authority. Guests cannot replace an absent host; after a host-route loss they can only retry the same pinned host from Recent Projects.
- Continuous atomic host persistence uses a 750 ms idle debounce by default and does not repeatedly force-save open editors.
- During an explicit transfer, every participant sees a paused state. Persistence, invitations, and notebook execution remain disabled until the new host prepares storage.
- The new host has a persistent **Choose host folder** action even after cancelling a dialog. They explicitly choose either an empty folder that receives the current session, or an existing synchronized folder (for example Dropbox) that is fully hash-checked and attached without rewriting when it matches.
- The pause card and initial prompt also expose **Transfer Host** and **End Session**. Ending before a new shared folder is selected keeps the final merged state and authenticated termination marker in the participants' isolated working copies.
- A non-empty mismatched folder is never changed implicitly. The new host must explicitly write the current session into it or choose another folder; cancelling keeps the session paused and the retry action visible.
- The previous host folder is not deleted or moved. If it is synchronized by Dropbox or another provider, its last completed host writes remain available there.

Editing state remains in the CRDT during the short folder-selection pause, so an accidental keystroke is not discarded. The new host materializes the current merged state before the session resumes.

## Saving and execution in peer sessions

Before guest execution, Pair Notebook synchronizes edited project dependencies and materializes the host workspace. The Jupyter kernel runs from the host backing repository, so relative paths and `PAIR_NOTEBOOK_WORKSPACE` can read the host's own datasets, including files omitted from guest snapshots. Activating a shared notebook selects the Pair Jupyter controller without restarting its kernel; Pair Run also selects the controller explicitly. Stop first requests exact typed `CONFIRM` for the captured execution IDs, then cancels remaining Run All cells and queued batches for that notebook; a subsequent Run starts a new batch. Renaming a notebook keeps its live kernel and variables.

The shared terminal uses the host's operating-system account and starts in that same repository. It keeps shell variables and `cd` changes between commands. `PAIR_NOTEBOOK_WORKSPACE` identifies the owner repository even after `cd`; the repository is also prepended to `PYTHONPATH` while preserving inherited module paths, so nested training scripts can import project modules and load owner-only datasets. A shell reset or repository change refreshes that environment. Guest terminals are view only by default. The host can disable access or explicitly grant command input per participant with **Pair Notebook: Права участников**. Incoming input and queued commands are checked against the current host policy. This command terminal supports line commands and streamed output; full-screen TTY tools and interactive password prompts require the host's ordinary local terminal. Closing its tab preserves the shell until the session ends; Ctrl+C first requests a separate empty-field `CONFIRM`; only valid consent stops that shell generation and its child commands, and the next command starts a fresh shell. Commands exceeding the 8192-character limit are rejected in full. Install 0.6.16 on every participant's computer for the current terminal, repository and launch fixes.

Before each cell or terminal command, missing canonical project inputs are restored in the host repository. Text and notebooks are serialized from the shared project; binary files are copied atomically from the working copy with SHA-256 verification. Recovery retains the running kernel's variables, existing host files, private datasets and generated checkpoints. If the canonical binary is unavailable or has changed, preparation fails before execution and can be retried after the file is recovered. Files deleted from the shared project are not recreated.

Before changing or replacing the host repository, finish managed execution or use its separate exact typed `CONFIRM` stop. Ctrl+C uses the same confirmation rule for the shared terminal. A running shell or queued terminal command blocks folder replacement, including replacement of the same folder, so selecting a folder cannot silently kill terminal training. While a folder change is in progress, new execution, another folder change, host transfer and session finalization are rejected with a retry message. A failed change restores the previous repository and permits another attempt. Simultaneous requests for the same notebook share one kernel; confirmed cancellation during preparation prevents that request from launching a new kernel. Observer disconnect or notebook UI deletion alone does not interrupt accepted work; interactive kernels remain limited by Extension Host lifetime.

Deleting a notebook or its directory stops its kernel and discards that notebook's compute/interpreter settings. Recreating the same path starts with clean Python state. Selecting CPU hides CUDA devices from the notebook kernel; selecting a GPU preserves its explicit device mapping.

File editing, notebook execution, terminal access and line comments have separate participant permissions. Python and shell access can modify files through operating-system APIs, so disable both execution and shell input when a participant must only edit an allowed subset through the editor.

Live text and notebook updates are sent immediately; disk persistence is separate and debounced. The canonical host copy and join snapshots are serialized directly from current CRDT state, so an unsaved open editor cannot make a new participant receive stale disk contents.

Text editing is local-first. A genuine editor change updates the participant's local canonical Yjs text immediately, then the same idempotent CRDT update is transported to the host and peers. Network latency cannot delay or repaint local typing, while concurrent file and notebook-cell operations converge through Yjs. The Session Host remains authoritative for durable storage, execution, snapshots, and explicit host transfer. Participant line highlights are advisory and never reject or roll back text.

Pair Notebook does not call VS Code's document or notebook `save()` method after every keystroke. That avoids repeatedly triggering format-on-save, save hooks, notebook serialization, and other extensions. Open editors are explicitly saved only for operations that require a physical filesystem barrier, such as execution, final host save, and host transfer. Closed files are written atomically.

The host also maintains rotating local recovery snapshots every five minutes and retains the latest three. Snapshot directories are staged and published atomically. Binary files, invalid-UTF-8 files, malformed notebooks treated as binary, empty directories, renames, deletions, notebook outputs, and stable cell IDs are included in synchronization.

## Network and security

Trystero uses public Nostr and MQTT services for encrypted discovery. Project data normally travels through encrypted WebRTC data channels; when ICE cannot form a path, both emergency families encrypt the complete Pair Notebook frame with AES-256-GCM before publishing it through Nostr relays and MQTT brokers. Duplicate deliveries are removed before the signed participant handshake. Public operators cannot read project frames or the token, but can observe the stable session topic, sender/recipient routing identifiers, timing, packet sizes, and chunk counts. The invite token is used as the Trystero room password and is stored in VS Code SecretStorage.

Each participant also owns an Ed25519 identity key. The private key remains in VS Code SecretStorage; the invite pins the host public key, and authenticated peer keys remain pinned across disconnects and voluntary transfer. This prevents another invite holder from impersonating a known offline participant. Protocol v8 adds authenticated host-managed participant policies and line comments while retaining local-first Yjs text authorship and signed relay envelopes. Every P2P participant must run Pair Notebook 0.6.9 or later; older protocol versions are rejected.

The invite is a bearer secret: anyone who receives it can attempt to join. Notebook execution is allowed by default and can now be disabled per participant by the host. Grant Python or shell access only to people trusted with code execution in that environment. Guests cannot redirect execution to their own computers or select a different executor. The invite-derived emergency-relay key does not provide forward secrecy: someone who records relay ciphertext and later obtains the invite may decrypt that recorded traffic. If an invite may have leaked, end the session and create a new one with a fresh invite; reconnecting the old session does not rotate its key.

Most consumer and office networks connect directly or through STUN alone. Where they cannot, Pair Notebook can use a custom TURN relay (`pairNotebook.turnUrls` + secret-stored password, for users who operate or trust one) and independently falls back to the built-in encrypted Nostr + MQTT emergency route, which needs nothing from the user. There is no built-in TURN service: the former Open Relay demo is not sent to Trystero, probed, or advertised because it is no longer operational anonymously. Direct peer-to-peer connections are always preferred when the network allows them; relays only carry already-encrypted traffic as a last resort.

## Development

```powershell
npm ci
npm run lint
npm test
npm run test:live
npm run artifacts
```

`npm test` uses in-memory Trystero, Nostr and MQTT relays to make transport, pinned-host authority, and route-recovery tests deterministic. `npm run test:live` verifies public Nostr discovery plus a real WebRTC data-channel exchange. `npm run test:live:relay` disables WebRTC and both signalling rooms, then verifies eight-by-64-KiB direct-to-system-proxy bursts across all seven compatible ordered Nostr-only, MQTT-only, and redundant-family combinations.

Release 0.6.16 includes matching editor and server packages:

- `pair-notebook-0.6.16.vsix` — the ready-to-install extension. GitHub displays its SHA-256 digest next to the file.
- `pair-notebook-server-setup.sh` — install, update, repair or recover access to your own server; matching server and integrity checks are embedded.
- `pair-notebook-ws-server.zip` — standalone encrypted WebSocket relay with an automatic HTTPS/service installer.

GitHub adds source ZIP/tar archives. Internal checksums and detailed build artifacts remain in the workflow artifacts, outside the public download list.

GitHub's automatic **Source code** archives are not installable extensions. Build/test artifacts are also retained with the workflow run. On Windows PowerShell use `npm.cmd` for the development commands above; real POSIX isolation tests require the supported Linux backend.

To publish a new release, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then push a matching `v<version>` tag. GitHub Actions rebuilds and verifies the artifacts before publishing them; an existing tag can also be republished from the **Release Pair Notebook** workflow.

See the [documentation index](docs/README.md), [architecture](docs/architecture.md), and [protocol](docs/protocol.md). Superseded plans/audits remain in Git history; current acceptance records retain their exact source and backend boundaries.
