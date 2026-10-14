# Persistent VPS sessions — 0.6.3

Use **Pair Notebook: Connect to VPS** for server-owned collaborative projects. The VPS retains session authority, membership, files and execution receipts while editors are offline. **Connect to VPS Compute** is the separate team relay/background-job connection described in [VPS_COMPUTE.md](VPS_COMPUTE.md).

Install the same 0.6.3 release on editors, server and interactive agents. [Architecture](PERSISTENT_VPS_ARCHITECTURE.md) explains the boundaries; [acceptance evidence](PERSISTENT_VPS_ACCEPTANCE_2026_10_14.md) records target HTTPS/VPS, native editor API and WSL/CUDA checks with their source identities. Physical UI, macOS compute and a completed 24-hour soak are not implied by a release or short smoke test.

## Release files and requirements

Download from [release v0.6.3](https://github.com/r7zex/jupyter_pair_ext/releases/tag/v0.6.3):

- `pair-notebook-0.6.3.vsix`: install on every editor, then reload VS Code.
- `pair-notebook-server-persistent.tar.gz` and `.sha256`: bundled server, agent/bridge, operator guide and service templates. No npm install/build is needed on the VPS.
- `pair-notebook-complete-0.6.3.zip`: matching source, tests and background agent.

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

Typing, paste and deletion use optimistic local replicas. Same-line concurrent editing is allowed; presence does not lock a row. Pending intents remain until actor acknowledgement and retry idempotently. Cursors do not wait for text acknowledgements. Peer latency includes the network, server and editor application; it is not a promise of zero delay.

Native Save persists source, user metadata, outputs and execution counts. Editing an executed cell retains previous output. Results from a changed source/cell identity/generation remain fenced. Save immediately after Run settles the native execution lifecycle; a save racing with a later remote document version can require a further save. Reopen and verify the stored notebook when qualifying a new build.

**Synchronize a local folder continuously** uses durable three-way baselines, revision checks and ACL-preserving renames. Reload/offline conflicts retain copies for explicit choice. `.git` and conflict scratch directories are excluded; links/special files are rejected. Notebook live editing does not establish live character synchronization for ordinary text files. Physical folder/offline/rename acceptance remains separately identified in the evidence.

## Compute, consent and isolation

The selected device runs independent stateful Jupyter kernels. Select the active device to request personal execution consent without switching it. Server policy rechecks machine-owner consent, sharing and membership. Revocation prevents subsequent unauthorized work. Changing device or renaming a Public notebook advances kernel generation; accepted work finishes on its original target, and subsequent execution uses a fresh namespace. Save Python objects to files explicitly if needed: files transfer, RAM does not.

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
