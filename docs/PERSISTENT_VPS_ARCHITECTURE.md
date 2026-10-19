# Persistent server architecture — 0.6.7

The server is the permanent Session Host. Editors may disconnect without transferring authority or ending accepted computation. The existing human-host peer runtime and detached background-job broker remain separate modes. Persistent sessions reuse the existing Yjs/editor/Jupyter mechanisms through an authenticated server adapter.

## Components

| Component | Responsibility |
|---|---|
| `src/vps/persistentServer.ts` | Membership, session lifecycle, permissions, discovery, execution admission and authorized result delivery |
| `persistentStorage.ts`, `persistentNotebookCrdt.ts` | Immutable blobs, atomic revisioned manifests, stable notebook identities and durable Yjs state |
| `persistentLive.ts`, `persistentClient.ts` | Authorized live events, presence and client RPC/recovery |
| `persistentHistory.ts` | Durable execution reservations, terminal receipts, bounded result archives and retry without hidden reruns |
| `persistentCompute.ts` | Target selection, machine-owner consent, sharing and kernel generations |
| `src/vscode/persistent.ts`, `persistentNotebookSync.ts` | Virtual filesystem, optimistic notebook replicas, journals, native save and execution integration |
| `scripts/pair-notebook-session-agent.py` | Independent isolated stateful Jupyter kernels and retained execution reports |
| `scripts/pair-notebook-session-admin.py` | Administrative creation/listing and owner-authorized lifecycle without VS Code |

## Editing and persistence

`EditorSynchronizer`, `EditorTextReplica` and `PresenceRenderer` retain their existing roles. The persistent notebook adapter applies local input optimistically, coalesces outgoing intents and keeps unacknowledged work until actor acknowledgement. Idempotent retries handle lost acknowledgements. Delayed echoes must not replace newer local typing. Cursors and selections are advisory; editing an occupied line is permitted.

Stable cell IDs, order, source, metadata and Yjs state are persisted together. Own-save reconciliation avoids replacing the editor with an older file snapshot. Source changes retain previous outputs/execution counts, as an ordinary local notebook does. The controller owns native execution handles and records their end before Save after Run settles. A save concurrent with a later incoming version can require another save; a successful earlier save cannot include future changes.

Open ordinary UTF-8 files use `PersistentTextSynchronizer` with Yjs updates and a write-ahead server replica. Run flushes unsaved modules before admission. Folder reconciliation uses durable baselines and versioned remote content caches. Ambiguous offline rename/edit conflicts retain both copies for explicit resolution. Epoch changes after replacement or privacy transitions archive old replicas and reconnect automatically. Native notebook intents carry Yjs character identities; structure deltas merge with unseen concurrent text rather than using snapshot CAS.

## Execution and privacy

Admission binds the acknowledged source hash, cell identity, privacy scope, target and kernel generation. Independent agents reuse a stateful namespace for compatible sequential cells. Small execution events and cursor updates avoid whole-project replay. Accepted healthy execution has no artificial training-duration deadline; network operations, preparation and resource use remain bounded.

Public and owner-only Private notebooks use separate snapshots, kernels, result namespaces and authorization. Member requests and live events cannot read Private files, outputs or execution identities. Declassification clears the appropriate namespace. Consent, sharing, membership and target eligibility are checked on the server.

Changing the device or generation creates a fresh Python namespace. Notebook kernels are keyed by stable notebook identity, so ordinary rename and unrelated removal preserve RAM. Files can transfer to the executor; Python RAM does not migrate. Inputs outside a 256 KiB inline budget are copied to immutable command storage and downloaded in checked chunks. Large artifacts use private staging, chunk retry verification and atomic content-addressed publication. Delayed output from an old source/identity/generation cannot publish into a replacement cell. Ordinary source edits preserving past output do not relax those fences.

## Session Python packages

On Linux bubblewrap compute, `%pip install numpy pandas` installs into one persistent Python package environment shared by all notebooks in the session and access scope on that device. Package storage is independent of notebook identity and compute generation. Reconnect, kernel restart and notebook recreation reuse it; Python variables remain local to each notebook kernel. Other sessions and the Public/Private scopes retain separate package environments. Packages do not migrate between compute devices.

Already running kernels discover newly installed packages on their next cell without clearing variables. Kernels that imported a package before an upgrade may need a restart to use the new version. Downloads use verified HTTPS and installation is published atomically; a failed install preserves the previous environment. The system Python and other sessions are unchanged.

An empty session environment can be seeded from the current notebook's legacy package environment. This copies the first available environment without deleting its source or merging conflicting versions from other notebooks. Existing session packages take precedence over subsequent legacy environments.

## Recovery and isolation

The server retains membership, manifests, execution identities and terminal results across restart. Reservations precede dispatch; ambiguous accepted execution is reconciled under its original ID. Permanent receipts outlive bounded output retention. Interrupted result publication retries without overwriting newer edits or repeating side effects. Old idle generations are released so they cannot occupy the worker's sole kernel slot indefinitely.

Agents run fail-closed isolation checks against the selected interpreter. Linux uses bubblewrap or a pinned Linux container; Windows uses a non-root WSL2 runtime. Kernel execution has no network or host credentials. The worker's narrowly scoped `ProtectKernelTunables=false` permits its mount namespace; other hardening remains enabled. The coordinator and private state stay outside untrusted kernel mounts.

Kernel RAM cannot survive executor reboot, OOM or kernel termination. Restoring durable files/receipts does not restore Python objects. Resource, disk, output and admission limits complement OS quotas and service budgets; workspace quotas alone do not cap historical blobs, receipts or dependencies.

See the [operator guide](PERSISTENT_VPS.md) and [source-specific acceptance](PERSISTENT_VPS_ACCEPTANCE_2026_10_14.md) for measured behavior and remaining physical UI/macOS/24-hour requirements.
