# Server installation

For new servers use the [interactive installer](SERVER_SETUP.md). The manual procedure below remains for existing deployments. VPS command identifiers and `pair-vps` URIs remain compatible.

# Persistent VPS sessions — 0.6.5

Use the main Pair Notebook panel to create, join, configure or leave a persistent VPS session. The VPS retains session authority, membership, files and execution receipts while editors are offline. The panel displays the endpoint, session ID, matching Explorer folder, participants and selected compute device. Legacy broker commands remain callable for compatibility but have no separate sidebar view.

Version 0.6.6 uses one Pair Notebook controller for both session types. When no session is connected, the panel exposes separate temporary-session and persistent-session actions. Saved connections display the project name and membership identity; Configure Persistent Sessions can reconnect or forget a local saved connection without deleting the server project.

**My computer** can prepare and launch the bundled isolated agent directly. Windows requires an existing Ubuntu/Debian WSL2 distribution; Linux requires working bubblewrap isolation. Preparation creates a dedicated Python environment rather than modifying system Python. A ready owner agent is reused automatically, and newly enabled owner sharing becomes the default compute target. If local isolation is unavailable, the VPS remains the fallback. Explicitly selected Python environments are preserved; the default temporary-session interpreter can discover Jupyter in the original project's `.venv`.

Temporary invitations can carry an HTTPS Pair Notebook relay origin. Set `pairNotebook.relayUrl` once, or reuse the last connected persistent VPS. Guests need only the invitation; they do not receive the team administration token. The additional relay route is end-to-end encrypted, bounded and independent of WebRTC; direct P2P and existing public fallbacks are still used. Measured latency depends on the endpoints and route; 100 ms is a target, not an unconditional network guarantee.

Install the same 0.6.5 release on editors, server and interactive agents. [Architecture](PERSISTENT_VPS_ARCHITECTURE.md) explains the boundaries; [acceptance evidence](PERSISTENT_VPS_ACCEPTANCE_2026_10_14.md) records target HTTPS/VPS, native editor API and WSL/CUDA checks with their source identities. Physical UI, macOS compute and a completed 24-hour soak are not implied by a release or short smoke test.

## Participant permissions and comments

The session owner can use **Manage Persistent VPS Session → Права участников** or **Pair Notebook: Права участников** to manage each member’s editable files, execution and comments. These policies and comments persist on the server. The existing VPS service has no shared operating-system shell; shared terminal permissions apply to P2P host terminals. See [instructions](PARTICIPANT_PERMISSIONS_AND_COMMENTS.md).

## Release files and requirements

Download from [release v0.6.5](https://github.com/r7zex/jupyter_pair_ext/releases/tag/v0.6.5):

- `pair-notebook-0.6.5.vsix`: install on every editor, then reload VS Code.
- `pair-notebook-server-persistent.tar.gz` and `.sha256`: bundled server, agent/bridge, operator guide and service templates. No npm install/build is needed on the VPS.
- `pair-notebook-complete-0.6.5.zip`: matching source, tests and background agent.

The server needs Node.js 20 or newer, private durable storage and verified HTTPS. The Linux worker needs its own non-root account, Python environment with `jupyter_client`/`ipykernel`, and working bubblewrap/user namespaces or an isolated Linux-container runtime. Python dependencies and CUDA belong to the selected executor. Do not silently switch interpreters when readiness fails.

Verify the archive before extraction:

```bash
sha256sum --check pair-notebook-server-persistent.tar.gz.sha256
tar -tzf pair-notebook-server-persistent.tar.gz
```

`server/BUILD.json` records the source commit, `localChangesIncluded` and every payload SHA-256. The installed VSIX contains `PAIR_BUILD.json` with corresponding provenance. A clean release has local changes set to false. Check the actual activated extension after reload; replacing its files does not reload an existing Extension Host.

## Server and HTTPS

Extract into a new retained release directory. Use a stable `/opt/pair-notebook/server` symlink after verifying the payload. Keep data outside release directories. The packaged `deploy/persistent/server.env.example` and systemd units describe supported accounts/settings; adapt paths and limits to the inventoried host before starting services.

| Setting | Purpose |
|---|---|
| `PAIR_VPS_BIND=127.0.0.1` | Keep the broker behind the HTTPS proxy |
| `PAIR_VPS_PORT` | Private listener; template default 8787 |
| `PAIR_VPS_DATA` | Durable store private to the server account |
| `PAIR_VPS_CLIENT_TOKEN` | Separate administrative/legacy operator credential |
| `PAIR_VPS_AGENT_TOKENS` | Independent tokens keyed by worker ID |
| `PAIR_VPS_SESSION_AGENT_ID` | Default VPS worker ID, normally `vps` |

Generate independent random secrets into private service files. Do not put secrets in command lines, shared folders, Git, diagnostic output or kernel snapshots. A session password/member token is not the creation token. Retain owner credentials privately.

Terminate TLS at a dedicated reverse-proxy route. The archive contains Caddy DNS and IP certificate examples; select the one matching the actual certificate identity and ACME support. Verify trust and hostname using the same HTTPS origin as editors. Preserve authorized SSE streaming. Do not expose the loopback broker or administrative credentials through an unauthenticated route.

On an existing server, inventory unrelated services, routes, ports, certificates and renewal hooks first. Add only Pair-specific configuration. A health response does not prove authentication, Private ACLs or kernel isolation; exercise those separately with test credentials.

## Sessions and editors

Create/list sessions over loopback with the packaged admin helper. Creation prompts for a password and writes a new private owner JSON:

```bash
python3 scripts/pair-notebook-session-admin.py create \
  --url http://127.0.0.1:8787 --public-url https://pair.example.com \
  --token-file /PRIVATE/admin.token --name research \
  --output /PRIVATE/research-owner.json
```

Use the configured port. Import the owner file through the extension's persistent-session actions; members connect using the public endpoint and session password or an authorized invitation. Lifecycle commands `start`, `stop`, `restart` and `delete` use `--member-config` with an owner/delegated credential. Inspect `--help` before administrative operations.

Owners control invitations, membership revocation, visibility and device policy. Invitations can expire or be revoked; read-only grants cannot mutate Public content. Private files, notebooks, results and execution identities are owner-only. Private execution uses an isolated owner namespace and eligible owner/VPS target. Visibility changes reset the relevant namespace; ambiguous reconciliation must not turn Private data Public.

## Notebook editing and saving

Typing, paste and deletion use local Yjs replicas and send character identities. Same-line concurrent editing is allowed; presence does not lock a row. Pending updates remain in a local journal until acknowledgement and retry idempotently. Cursors do not wait for text acknowledgements. Peer latency includes the network, server and editor application. Update the extension and server together to 0.6.6; the extension checks the server's text protocol before editing. Zero-byte notebooks are initialized as valid empty notebooks. Their first unsaved editor cells are committed against the server's initial state vector, without restoring cells deleted from an existing populated notebook.

Native Save persists source, user metadata, outputs and execution counts. Editing an executed cell retains previous output. Results from a changed source/cell identity/generation remain fenced. Save immediately after Run settles the native execution lifecycle; a save racing with a later remote document version can require a further save. Reopen and verify the stored notebook when qualifying a new build.

Open ordinary UTF-8 project files also synchronize characters live. Run flushes unsaved Python modules before taking its input snapshot. Native Save is available independently. Replaced notebooks/files reconnect automatically after archiving the old replica in extension storage; dirty text from an old privacy scope is not republished into the new one. Malformed local journals are archived and rebuilt.

**Synchronize a local folder continuously** uses durable three-way baselines, revision checks and ACL-preserving renames. Ambiguous offline file conflicts retain copies for explicit choice. `.git` and conflict scratch directories are excluded; links/special files are rejected. Unchanged remote contents are cached by file version. Physical folder/offline/rename acceptance remains separately identified in the evidence.

## Compute, consent and isolation

The selected device runs independent stateful Jupyter kernels. Select the active device to request personal execution consent without switching it. Server policy rechecks machine-owner consent, sharing and membership. Revocation prevents subsequent unauthorized work. Changing device or privacy scope advances kernel generation. Ordinary rename and unrelated file deletion preserve the notebook kernel and its variables. Save Python objects to files explicitly when changing devices: files transfer, RAM does not.

All editors use the same selected session compute target. A ready, explicitly shared owner computer becomes the initial default; the VPS is used while that computer is absent or unavailable. With the owner offline, any number of connected members can select the VPS or their own shared computer, and cannot select a different member's computer. The owner's baseline is restored when the owner returns. Switching devices applies to future admissions and never rewrites the immutable target of already accepted work.

Accepted inputs are immutable snapshots. Large files transfer in checked 256 KiB chunks; returned models publish atomically after checksum and version checks. The default project budget is 128 MiB and 4096 entries, with up to 256 changed artifacts per cell. Retained output is bounded to 8 MiB per execution, with an explicit diagnostic on overflow; overflow still accepts a final status and releases the queue. Run All stops after a failed cell, including failed artifact publication. Interrupt also cancels a run that has not reached its worker.

Closing or uninstalling the extension ends a P2P session when performed by its host; a guest leaves only its own connection. In VPS mode the editor leaves membership presence, journals local edits and closes its requests. Server sessions and accepted independent work continue. A forced process kill cannot execute extension cleanup; remote peers then rely on heartbeat expiry.

Verify the actual Linux runtime before registration:

```bash
python3 scripts/pair-notebook-session-agent.py \
  --python /opt/pair-worker/bin/python \
  --bridge /opt/pair-notebook/server/media/jupyter_kernel_bridge.py \
  --check-isolation
```

Use the worker service with a separate private token/state, `--max-kernels 1` on the small VPS, and explicit `--share`. Keep credentials and host-private data outside kernel mounts. Bubblewrap denies kernel network access and exposes only the admitted workspace, bridge and required Python/system roots. Isolation failure is an error, not permission to run unconfined.

Windows uses `scripts/pair-notebook-wsl-agent.ps1` with a selected WSL2 distribution. `-Action Check` verifies readiness; `-Action Run` starts the foreground agent with private Linux config/state and `--share`. `-Action Install` installs the selected agent runtime and requires a deliberate installation decision. Use a non-root Linux user and Linux filesystem storage for Python/CUDA; slow Windows-mounted environments can fail cold-start readiness. Do not change other distributions, global WSL settings, drivers or VPN routing.

Containers use an immutable installed image ID (`--runtime-image`) and the interpreter inside that image (`--runtime-python`). Build `deploy/persistent/Containerfile` with a trusted CA bundle. Kernels have read-only images, no network/Docker socket, dropped capabilities, bounded processes/tmpfs and explicit CPU/RAM/swap limits. macOS requires a Linux VM through Docker Desktop; Linux-container tests do not establish native macOS acceptance.

## Resource and disk limits

Service templates are starting points, not proof of aggregate limits. On the acceptance VPS all Pair processes share `/pair.slice/pair-notebook.slice`: **35% CPU, 384 MiB RAM, 128 MiB swap**. The worker has one kernel. The bounded soak has its own 25% CPU/256 MiB limit within the aggregate and a 25-hour maximum. Do not raise the aggregate to make tests pass. Inspect actual limits, OOM events, restarts and journal errors; a low memory peak alone does not prove success.

Keep hardening enabled. Only the interactive worker needs the narrowly scoped `ProtectKernelTunables=false` exception for its mount namespace. Do not apply it to other services or change global userns/AppArmor/sysctl settings as a workaround.

Workspace quotas do not bound all blobs, receipts, dependencies and backups. Provision dedicated quota-limited data/worker storage, reserve system space, bound logs/images and retain off-host backups. Validate ENOSPC/EDQUOT and recovery on disposable storage, not a production root filesystem. Never delete permanent execution receipts to unblock admission: their loss can permit repeated side effects. Stop new writes and archive/migrate the verified store when capacity is exhausted.

## Upgrade, backup and recovery

1. Record active source, hashes, service state, data paths and limits. Wait for accepted work or explicitly record interruption. Do not replace an active source-pinned soak runtime.
2. Protect backups of server/worker state, configuration and credentials. Retain the old release/symlink target. Encrypt off-host copies and test decryption/hash plus isolated restoration.
3. Verify the new release and matching editor/agent manifests. Switch only Pair's release path and restart only required Pair services in the maintenance window. Preserve unrelated services and configuration.
4. Check validated HTTPS, authenticated session access, Private denial, persistence, real execution, receipts and resource events. Rollback switches Pair's retained release and compatible backed-up state; it does not restore Python RAM.

Restore data into an isolated non-production namespace with disposable credentials. Isolated store restoration is distinct from bare-machine recovery. Windows DPAPI CurrentUser backups additionally require the same Windows account; they are not universally portable.

## Long-running acceptance

`scripts/persistent-session-soak.py` runs actual sessions, executors, Jupyter operations, reconnect/retry, consent and restart checks. Default acceptance duration is 24 elapsed hours; `--check` is a short harness check recording `acceptance24Hours=false`. Keep private state/credentials out of public artifacts; publish sanitized identities, execution/ledger counts, resource samples and final status.

Success requires `status=completed`, `acceptance24Hours=true`, elapsed time at least 86400 seconds, the expected source/evidence path and no hidden early failure. Do not combine interrupted runs or transfer elapsed time to a new source. The run started on 14 October 2026 remains pinned to `7b93d81fb073ea85d17eeb4f0a89365183f19def`; its eventual result qualifies that source, not every later release commit.
