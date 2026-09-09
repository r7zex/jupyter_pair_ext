# Pair Notebook: deterministic Start/Join across Workspace Trust, process death, network loss, and delayed launch

Date: 2026-09-09

Status: **deep root-cause analysis + implementation specification** for current `main` / `v0.5.26`.

This document supersedes all earlier versions of this plan.

The target is not another timing patch around `openFolder()`, Workspace Trust, or relay startup. The target is a recoverable launch transaction whose correctness does not depend on:

- one particular VS Code Extension Host surviving;
- Workspace Trust being granted quickly;
- a single public Nostr/MQTT endpoint being reachable at startup;
- a fixed 15/30/45/120 second wall-clock window;
- an in-memory Promise being the only owner of lifecycle state;
- the user refraining from editing the original project for an hour while the isolated folder is untrusted.

The repair must also avoid changing protocol-v7 CRDT/editor/notebook semantics unless a separate failing test proves that a sync-layer change is required.

---

# 0. Product contract and guarantee boundary

The required host flow is:

```text
trusted source workspace
    -> user presses Start Session once
    -> one stable local session identity is created
    -> a consistent isolated copy is prepared
    -> durable launch-control state is committed
    -> vscode.openFolder(isolated workspace)
    -> old Extension Host may die immediately
    -> target may open Restricted / Untrusted
    -> Pair Notebook may be completely disabled
    -> user may wait one hour, several hours, suspend Windows, close VS Code, or restart VS Code
    -> user grants Trust later
    -> the exact same sessionId / peerId / private identity resumes automatically
    -> temporary network/proxy/relay failure is retryable, not terminal
    -> failed/pending attempts do not become Recent Sessions
    -> established session uses the existing protocol-v7 synchronization semantics
```

The required guest flow is the analogous sequence after authenticated snapshot bootstrap.

No software can guarantee that an unavailable internet connection, dead public infrastructure, deleted local credentials, a corrupted filesystem, or an uninstalled extension will become available. What this design can guarantee is:

1. **no timing-dependent loss of an explicit Start/Join intent**;
2. **no silent replacement of the local participant identity**;
3. **no automatic network activity from an unrelated old/copied marker**;
4. **no terminal teardown merely because network availability is temporarily bad**;
5. **no silent overwrite of backing-folder changes made during a long Trust delay**;
6. **no duplicate local runtime using the same private participant identity**;
7. **no release claim until real installed-VSIX Trust acceptance passes**.

---

# 1. Verified current call graph

Current host Start:

```text
startSession()
  -> requireTrustedWorkspaceForSessionStart()
  -> applyMeshNetworkConfiguration()
  -> choose backing folder
  -> create sessionId/projectId/peerId/keypair/token
  -> copyProject(backingFolder, workingFolder)
  -> saveDescriptor()
       -> SecretStorage(sessionId, peerId)
       -> atomic marker write
  -> rememberProject()                         <-- too early
  -> openSessionWorkingFolder()
       -> globalState[PENDING_SESSION_LAUNCH_KEY]
       -> vscode.openFolder(...)
```

Current target activation:

```text
activate()
  -> applyMeshNetworkConfiguration()           <-- runs even in limited untrusted activation
  -> create dashboard/controller/status
  -> register all commands
  -> start Windows proxy polling
  -> startLifecycleWatchdog()
  -> offerWorkspaceSessionRestore()
       -> claimPendingSessionLaunch()
            -> DELETE global pending record    <-- durable intent consumed too early
       -> if untrusted: keep claimedLaunch only in RAM
       -> later Trust event
       -> startWorkspaceSessionRestore()
            -> restoreWorkspaceSession()
```

Current restore:

```text
restoreWorkspaceSession()
  -> read marker
  -> read SecretStorage
  -> runtime = new SessionRuntime(...)
  -> await runtime.start()
  -> new EditorSynchronizer(...)
  -> bind runtime writer/editor resolver
  -> new PresenceRenderer(...)
  -> bind NotebookController/dashboard
  -> install extension-level runtime event handlers
  -> lifecycleReadyRuntime = runtime
```

Current runtime start:

```text
SessionRuntime.start()
  -> if initialized: return
  -> normalize backing folder
  -> check termination marker
  -> initialized = true
  -> load host CRDT project
  -> index binaries
  -> create StorageAdapter (host backingRoot already active)
  -> install runtime handlers
  -> await MeshTransport.start()
  -> guest: await stateReady for 45 seconds
  -> install file watcher
  -> install presence tracking
  -> refresh hardware
  -> descriptor.freshStart = false
  -> persist descriptor
  -> refresh autosave
  -> setContext(inSession=true, executionAvailable=true)
  -> emit ready
  -> transition ready
```

Current transport start:

```text
MeshTransport.start()
  -> if room exists: return 0
  -> create PRIMARY Nostr/Trystero room
       synchronous failure => THROW immediately
  -> hasStarted = true
  -> await startRelayFallback()
       -> start Nostr + MQTT emergency data relays
       -> await at least one emergency family for up to 15 s
       -> no family ready => THROW
  -> install heartbeat/ping/metrics/recovery timers
  -> start SECONDARY MQTT signalling
  -> start NetworkChangeWatcher
```

These orderings are the basis for the findings below.

Primary source files:

- [`src/extension.ts`](./src/extension.ts)
- [`src/core/manualSessionRestore.ts`](./src/core/manualSessionRestore.ts)
- [`src/runtime/session.ts`](./src/runtime/session.ts)
- [`src/runtime/mesh.ts`](./src/runtime/mesh.ts)
- [`src/runtime/bootstrap.ts`](./src/runtime/bootstrap.ts)
- [`src/runtime/redundantFrameRelay.ts`](./src/runtime/redundantFrameRelay.ts)
- [`src/vscode/sync.ts`](./src/vscode/sync.ts)
- [`src/core/persistence.ts`](./src/core/persistence.ts)
- [`src/core/projectFiles.ts`](./src/core/projectFiles.ts)

---

# 2. Root causes already established by previous analysis

These remain valid.

## 2.1 `v0.5.23` is the last known-good lifecycle baseline

`0.5.24` changed the Start/Join handoff and introduced the first lifecycle regression. The repository's existing lifecycle reports already document the subsequent `0.5.24` / `0.5.25` repairs.

## 2.2 `openFolder()` is a hard process boundary

Same-window `vscode.openFolder()` may terminate the current Extension Host and start a new one for the target folder. Nothing kept only in source-process RAM may be required after this call.

Official reference:

https://code.visualstudio.com/api/references/commands#_built-in-commands

## 2.3 Current `0.5.26` deletes durable handoff evidence before Trust

`claimPendingSessionLaunch()` removes the global pending record and then keeps the authorization only in `claimedLaunch` RAM while waiting for Trust.

This is incompatible with the requirement that Pair Notebook may be disabled for an arbitrary delay.

## 2.4 The current global pending key is a singleton

`pairNotebook.pendingSessionLaunch` can represent only one launch. It is not a safe multi-window transaction store.

## 2.5 Process identity is not launch identity

`VSCODE_PID`, `VSCODE_IPC_HOOK`, and editor session IDs may be useful diagnostics. They are not durable authorization for a Start/Join transaction that must survive restart or process replacement.

## 2.6 `rememberProject()` runs before the session ever becomes usable

That is why failed attempts become repeated Recent cards such as multiple `project_test` entries.

---

# 3. New deeper findings

The following findings were identified by tracing the full startup, persistence, transport, teardown, and editor-binding paths rather than only the Trust callback.

## 3.1 Source Start/Join itself is not single-flight

`startSession()` and `joinSession()` guard:

```text
workspaceSessionRestore
runtime
```

but there is no `launchPreparation` mutex covering the interval from command invocation through copy/bootstrap, descriptor persistence, and `openFolder()`.

Two rapid Start invocations in the same window can therefore both pass the guards, create independent IDs and working copies, and race two `openFolder()` calls. One may become the visible target while the other becomes an orphan pending launch.

**Required fix:** one same-window launch-preparation Promise/context key. The dashboard button must be disabled while it is set.

This guard is local to one window; two separate VS Code windows may intentionally create two separate sessions.

---

## 3.2 `activate()` performs trusted-only initialization before checking Trust

Current `activate()` immediately:

- reads/migrates proxy credentials;
- calls `applyMeshNetworkConfiguration()`;
- installs the proxy-aware WebSocket runtime;
- constructs the notebook controller;
- registers every session/credential command;
- starts Windows system-proxy polling.

This occurs before `offerWorkspaceSessionRestore()` decides whether the workspace is trusted.

The manifest currently says `supported: "limited"`, but the implementation is not actually a minimal limited-mode activation.

**Required fix:** even if the manifest returns to `supported: false`, retain a code-level Trust guard because users can override untrusted-workspace support. Untrusted activation must not initialize networking, Python/notebook execution, runtime restoration, credential migration, or proxy polling.

Use an idempotent `initializeTrustedServices(context)` path that can be called either immediately in a trusted workspace or after `onDidGrantWorkspaceTrust` when limited mode is explicitly enabled.

---

## 3.3 `runtime !== undefined` currently means both “starting” and “established”

`restoreWorkspaceSession()` assigns:

```ts
runtime = new SessionRuntime(...)
```

before awaiting `runtime.start()`.

But `deactivate()` tests only:

```text
context && runtime
```

and then calls `leaveActiveSession()`.

`leaveActiveSession()` writes a Recent entry before calling `active.leave()`.

Therefore even if the early `rememberProject()` calls are removed, an Extension Host deactivation **during pre-commit startup** can still convert an unfinished launch into a Recent Session.

This is a second independent source of ghost Recent entries.

**Required fix:** lifecycle phase must be explicit. Deactivation behavior must distinguish:

```text
PRECOMMIT ATTEMPT
  -> stop process-local resources
  -> preserve durable pending control
  -> NO Recent Session
  -> NO established leave semantics

ESTABLISHED SESSION
  -> existing leave/Recent semantics
```

Never infer establishment from `runtime !== undefined`.

---

## 3.4 `SessionRuntime.start()` is not retry-safe or concurrently awaitable

At the beginning of `start()`:

```ts
if (this.initialized) return;
...
this.initialized = true;
```

`initialized` becomes true before most local preparation and before transport startup.

Consequences:

1. if startup later fails, calling `start()` again on the same runtime returns immediately even though startup never completed;
2. a second concurrent caller can receive an immediate “success” while the first caller is still starting;
3. availability retry cannot be implemented safely by simply calling `runtime.start()` again.

Current outer error handling then calls `runtime.leave()`, so a guest host timeout becomes an explicit local teardown.

**Required fix:** replace the boolean-as-promise pattern with explicit phase/promise state, or split startup into deterministic phases. Transient network/host absence should keep the same runtime attempt alive where possible. A failed local preparation should discard that runtime object and create a fresh object using the **same durable session identity**, not generate a new session.

---

## 3.5 `SessionRuntime.start()` commits descriptor/runtime state before outer VS Code bindings exist

Near the end of `SessionRuntime.start()` it already:

```text
descriptor.freshStart = false
persistDescriptor()
refreshAutosaveManager()
setContext(pairNotebook.inSession = true)
setContext(pairNotebook.executionAvailable = true)
emit('ready')
```

Only **after `start()` resolves** does `extension.ts` create/bind:

- `EditorSynchronizer`;
- editor line resolver;
- working-copy writer;
- `PresenceRenderer`;
- `NotebookController` runtime;
- dashboard runtime;
- extension-level terminal/network/host event handlers.

So there is a real interval where the marker says the fresh launch is no longer fresh and the runtime declares itself ready, while essential outer bindings do not yet exist.

If the Extension Host dies in this interval, a marker can look established even though the explicit Start/Join transaction never completed.

**Required fix:** the outer launch coordinator, not `SessionRuntime.start()`, owns the commit point. `freshStart=false`, context keys, final marker write, and established lifecycle state must be part of the outer commit.

---

## 3.6 Runtime event handlers are installed too late

Extension-level handlers for:

- `terminal`;
- `networkChanged`;
- `sessionEnded`;
- host pause/resume/folder requirements;
- compute changes;

are registered only after `runtime.start()` resolves.

Events occurring during startup are therefore either missed or must be reconstructed indirectly in the catch path.

**Required fix:** install lifecycle observers immediately after runtime construction, before any network starts. Keep user-facing actions gated by lifecycle phase.

---

## 3.7 There is a host startup editor/file capture gap

For a fresh host the runtime does:

```text
loadCrdtProject(workingFolder)
...
await transport.start()
...
installFileWatcher()
```

and `EditorSynchronizer` is constructed only after `runtime.start()` returns.

During the transport wait there is therefore no ordinary file watcher and no VS Code editor synchronizer.

This is not merely theoretical. `EditorSynchronizer.rememberText()` treats an already-dirty editor as local work and publishes it, but for a **saved/non-dirty document whose text differs from canonical CRDT**, it records an initial baseline and queues canonical projection back into the editor. A saved edit made during the startup gap can therefore be treated as stale display state instead of local authorship.

Closed-file/external edits made before the filesystem watcher is registered are even simpler: there is no listener retroactively replaying the missed filesystem event.

**Required fix for fresh host:**

```text
load initial CRDT
-> install local file/editor capture
-> only then expose network/admit peers
```

The existing sync algorithms do not need to be rewritten. Reorder startup so they are present before the network wait.

Required regression test:

```text
hold transport/network readiness
edit + SAVE a host file in VS Code during startup
release network readiness
assert editor == CRDT == working copy == backing copy
```

Also test a closed file modified externally during the same interval.

---

## 3.8 Long Trust delay creates a backing-folder overwrite hazard

This is one of the most important new findings for the explicit “user may wait an hour before Trust” requirement.

Host Start copies the backing project **before** `openFolder()`:

```text
backing folder at T0
   -> copyProject(...)
   -> isolated working copy snapshot at T0
   -> open target
   -> user waits one hour
```

Nothing currently revalidates the backing folder at T1 when Trust is finally granted.

After runtime startup, `createStorage()` gives the host `StorageAdapter` the backing root immediately. Then every CRDT project key is scheduled. `StorageAdapter.flush()` deliberately writes the backing root **before** updating the working copy.

Therefore this valid sequence is possible:

```text
T0: Start Session copies foo.py = OLD
T0+5m: another VS Code window / formatter / git checkout changes original backing foo.py = NEW
T0+60m: user grants Trust to isolated folder
runtime loads OLD working copy
storage becomes active against original backing folder
scheduled flush writes OLD to backing folder
NEW is overwritten
```

This is silent data loss caused specifically by delayed Trust.

**Required fix: a backing-write fence.**

For a pending fresh host:

- create `StorageAdapter` with `backingRoot: undefined`;
- never write to the backing folder before launch reconciliation/commit;
- persist a content baseline of the project captured at Start;
- re-scan both the isolated working copy and the original backing folder after Trust, before network exposure or backing writes.

Use three-way classification against the Start baseline:

```text
working == baseline && backing == baseline
  -> safe normal start

working == baseline && backing != baseline
  -> source changed while waiting; refresh isolated copy from latest backing safely

working != baseline && backing == baseline
  -> user edited isolated pending workspace; treat working copy as intended new initial host state

working == backing && working != baseline
  -> both converge to the same new state; safe

working != baseline && backing != baseline && working != backing
  -> divergent concurrent edits; DO NOT overwrite either side
  -> pause startup and present conflict-safe recovery
```

Only after this fence is resolved may the host backing root be attached and flushed.

---

## 3.9 `copyProject()` is not a snapshot-consistent copy

Current `copyProject()` calls recursive `cp()` with filtering and size checks. It does not prove that the source stopped changing while the copy was in progress.

For an actively edited project, the isolated copy can contain files from different source moments.

**Required fix:** stable-copy protocol before committing the pending launch:

```text
manifest A = scan source
copy to clean/staging destination
manifest B = scan source again
manifest C = scan destination

accept only if A == B == C
```

If the source changed during copy, retry from a clean staging copy a bounded number of times, then ask the user to stop source writes and retry.

A manifest must be content based, not timestamp based. Sort entries and include at least:

```text
relative path
kind
size
content hash
directory set
```

`scanProject()` / `scanDirectories()` already provide most of the required primitives.

---

## 3.10 Backing-folder path itself can change identity during the delay

`copyProject()` canonicalizes the source through `realpath()`, but the descriptor stores the path selected in the dialog. A symlink/junction can later point somewhere else, or the original folder can be deleted and recreated at the same textual path.

The delayed launch must persist:

- canonical real source path;
- optionally a filesystem identity fingerprint (`dev`/`ino` where meaningful);
- baseline manifest digest.

Before attaching `StorageAdapter.backingRoot`, resolve it again. A changed physical target must not silently receive the old session state.

---

## 3.11 Exact marker hashing alone is not sufficient to bind the physical workspace

`normalizeSessionDescriptor()` intentionally returns:

```ts
workingFolder: path.resolve(workspaceFolder)
```

instead of trusting `raw.workingFolder` from the marker.

Therefore a byte-for-byte copied marker can be normalized to a different folder.

A raw marker SHA-256 is useful integrity evidence, but **it does not by itself prove that the current physical directory is the originally created session workspace**.

Required automatic-resume checks include all three:

```text
raw marker hash matches launch control
AND current workspace realpath == launch-control workingFolderRealPath
AND current workspace is exactly the expected globalStorage sessions/<sessionId>/<peerId>/workspace path
```

This is stronger than the current `path.resolve()` + Windows lowercase comparison.

---

## 3.12 Automatic pending restore must not use legacy SecretStorage fallback

Current `descriptorSecret()` can migrate from the legacy session-only key, and `ensureDescriptorIdentity()` can repair a marker lacking a public identity.

Those are useful manual compatibility paths for old sessions. They are too permissive for an automatic post-Trust continuation.

For a new explicit pending launch, require:

```text
exact per-peer SecretStorage key
exact private identity
public key matches marker
no TOFU repair
no legacy secret fallback
```

If those checks fail, stop automatic network activity and offer explicit recovery.

---

## 3.13 SecretStorage is a good credential store but a poor lifecycle database

The earlier version of this plan proposed storing `pendingLaunch` directly inside the session SecretStorage value. Deeper review shows a cleaner design.

SecretStorage has no enumeration API, no compare-and-swap primitive, and is awkward for dashboard discovery and crash-state inspection. Rewriting credentials for every lifecycle transition also couples two independent concerns.

**Revised design:**

- SecretStorage stores stable credential material only;
- an atomic, authenticated **session control record outside the collaborative workspace** stores launch lifecycle;
- the control record is MACed with a key derived from the local participant private identity, so workspace content cannot forge it;
- a separate per-session baseline record stores the potentially larger manifest data.

This gives us atomic filesystem state transitions using the project's existing `atomicWriteFile()` implementation while keeping credentials out of files.

---

## 3.14 A simple time-based startup lock is unsafe

The previous plan suggested an exclusive lock file with a stale timeout. A pure `acquiredAt + 120s` stale rule is unsafe.

A valid Extension Host can be suspended longer than the timeout. Automatically stealing the lock by age could start a second runtime with the **same peer ID and private key** while the original process later resumes.

**Required fix:** runtime ownership is based on process liveness, not elapsed time.

Store outside the workspace:

```json
{
  "version": 1,
  "pid": 12345,
  "ownerNonce": "random-id",
  "launchId": "...",
  "acquiredAt": 0
}
```

Create it with exclusive `open(..., 'wx')`.

On collision:

- if the recorded process is definitely alive (or liveness is uncertain), do **not** steal automatically;
- if the OS definitively reports no such process, remove stale ownership and retry exclusive create;
- PID reuse may cause a false block after reboot, which is safe; provide an explicit user “Take over local session” action rather than risking dual identity use.

The ownership record is held for the **entire runtime lifetime**, not only the startup function.

---

## 3.15 `MeshTransport.start()` serializes supposedly redundant transports into a fail-fast chain

Current behavior is not truly redundant at startup.

### Case A — primary Nostr/Trystero construction fails

The function throws immediately. Secondary MQTT signalling and emergency relay fallback are never started.

### Case B — primary room exists, emergency relay readiness fails

`startRelayFallback()` stops/discards the relay and throws. The already-created primary room is treated as startup failure. Secondary MQTT signalling and NetworkChangeWatcher are never started.

So redundancy exists only **after** one particular serial startup sequence succeeds.

**Required fix:** start independent engines independently:

```text
primary Nostr signalling       ┐
secondary MQTT signalling      ├─ start/record health independently
emergency Nostr+MQTT data      ┘
heartbeat/ping timers
NetworkChangeWatcher
```

One engine's availability failure must not prevent the others from existing and recovering.

---

## 3.16 `this.room` is not a valid “transport started” flag

Current `MeshTransport.start()` begins with:

```ts
if (this.room) return 0;
```

But `this.room` is assigned **before** emergency readiness, timers, secondary signalling, and network watcher are established.

A second/concurrent `start()` call can therefore return success while the first call is still only partially initialized.

If retry code were added naively around the current implementation, this guard would create false success.

**Required fix:** explicit transport start state + shared start Promise:

```ts
type TransportStartState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';
```

Concurrent callers await the same `startPromise`. “Started” means structural initialization finished, not merely “primary room object exists.”

---

## 3.17 Emergency relay readiness can abort an otherwise working long snapshot bootstrap

`downloadProjectSnapshot()` installs message handlers, then starts transport asynchronously:

```ts
void transport.start().catch(fail)
```

The primary room can already discover the host and transfer snapshot data while `MeshTransport.start()` is still awaiting emergency relay readiness.

If that snapshot is still legitimately transferring after 15 seconds, and both emergency relay families fail their readiness check, `transport.start()` rejects and calls the bootstrap `fail()` path even though the primary route may be healthy and making progress.

This means an unrelated emergency-relay outage can kill a valid direct/TURN snapshot simply because the project transfer lasts longer than the fallback readiness deadline.

**Required fix:** emergency availability is not a structural transport-start failure. Bootstrap termination must be governed by its own host-discovery/progress/error logic, not by an unrelated fallback family's 15-second readiness timer.

---

## 3.18 Guest initial runtime sync has inconsistent timeout budgets

Guest runtime startup waits:

```text
stateReady: 45 seconds absolute
```

but the host's `sendProjectState()` is allowed to wait up to **120 seconds** for outbound drain before sending `stateEnd`.

So the sender considers a slow initial transfer valid for up to 120 seconds while the receiver abandons it at 45 seconds.

This is a direct protocol timeout mismatch.

**Required fix:** no absolute 45-second terminal timeout for a progressing initial state transfer.

Use two concepts:

```text
HOST DISCOVERY / NO-PROGRESS WARNING
STATE TRANSFER IDLE TIMEOUT
```

Re-arm the idle timer on authenticated initial-state progress. A transfer that is actively progressing must not be killed by an unrelated absolute deadline.

A host that is absent produces `host-unavailable` and remains retryable under the same pending Join identity.

---

## 3.19 `local-route-failed` currently tells the user to Reconnect after deleting the only runtime that Reconnect needs

On `local-route-failed`, restore sets:

```text
runtime = undefined
```

and the UI message says to check VPN/proxy and retry reconnect.

But the Reconnect command calls:

```text
requireRuntime().reconnect()
```

No runtime exists, so the suggested action cannot work.

This is a concrete product inconsistency, not merely wording.

**Required fix:** pending startup owns Retry. Do not route pre-commit availability failure through the established-session Reconnect command.

---

## 3.20 Network change watching starts too late to rescue startup

`NetworkChangeWatcher` starts only after emergency relay readiness succeeds.

If the user enables/disables VPN while the startup is stuck waiting on fallback readiness, the transport that most needs a network-change wakeup is not yet watching network changes.

**Required fix:** start passive network-change observation as part of structural transport initialization, before waiting for any availability signal.

---

## 3.21 Recreating transports repeatedly is the wrong retry strategy

TURN probing installs temporary process-level `unhandledRejection` containment while library-internal sockets may still fail late. Repeatedly constructing transports during startup retry can multiply process-level guards and socket churn.

The emergency relay implementations already contain reconnect loops.

**Required fix:** after structural transport initialization, keep transport engines alive and let them recover. Retry should refresh/reannounce/wake existing engines, not recursively recreate Start Session or repeatedly construct complete MeshTransport instances.

---

## 3.22 Pending guest workspace edits require an explicit data-loss policy

After snapshot bootstrap the guest target can remain untrusted for an hour. The user can still edit files in that folder before Trust.

After Trust, current guest runtime waits for authoritative host state before installing the normal file watcher and before `EditorSynchronizer` is created.

If the local working copy changed during the delay, blindly applying a newer host state can overwrite or conflict with those local changes.

**Minimum safe behavior:** persist the verified snapshot baseline manifest. Before automatic guest continuation, compare the current working copy to that baseline.

If unchanged, proceed automatically.

If changed, do not silently project host state over it. Preserve a backup/staging copy and require a conflict-safe continuation path.

A later enhancement may load the verified snapshot into a local CRDT and merge pre-ready edits, but that is a synchronization-semantic change and must be designed/tested separately rather than smuggled into the lifecycle fix.

---

## 3.23 Pending-state schemas must survive extension auto-update

A user can press Start, remain Untrusted for an hour, and receive an extension update before granting Trust.

Therefore the pending control format is itself a durable compatibility surface.

Rules:

- version every control/baseline record;
- new versions must read at least the immediately previous pending schema;
- unknown future versions fail closed without deleting credentials/working copies;
- never silently convert “cannot understand control record” into “old marker, auto-connect anyway.”

---

## 3.24 Full arbitrary-delay guest authority recovery is a protocol problem, not only a lifecycle problem

There is an important limit to what a v0.5.26 lifecycle repair can honestly guarantee.

Example:

```text
Guest bootstraps snapshot from Host A
-> guest target remains untrusted for one hour
-> during that hour A transfers host authority to B
-> A goes offline
-> guest trusts target
```

The guest descriptor is pinned to A. The transport handshake carries session/purpose/peer identity but does not itself carry a verifiable host-transfer chain. `helloAck` may contain clock metadata, but the runtime does not simply adopt a newer host clock from an arbitrary peer; host control messages are intentionally constrained by current authority.

So a completely offline stale guest cannot safely invent that B is the new host.

Similarly, if the session is ended while the guest is completely offline/untrusted, the current local HMAC termination marker is not magically delivered to that guest.

**Conclusion:**

- fixing host Start across arbitrary Trust delay requires no protocol change;
- fixing ordinary guest delayed Trust where the pinned host is still authoritative requires no protocol change;
- guaranteeing guest recovery across host transfer/end while the guest was entirely offline requires a separate authenticated authority/termination rendezvous design (likely a protocol version change).

Do not weaken host pinning to “fix” this edge case.

---

# 4. Revised durable architecture

The strongest design after this deeper review is:

```text
SecretStorage
  = stable secret credentials only

extension-owned session control directory OUTSIDE collaborative workspace
  = durable authenticated lifecycle + baselines + runtime ownership

workspace marker
  = runtime descriptor, integrity-bound to control record
```

Recommended layout:

```text
<globalStorage>/sessions/<sessionId>/<peerId>/
    control.json
    baseline.json
    runtime-owner.json
    workspace/
        .pair-notebook-session.json
        ... collaborative project files ...
```

`control.json`, `baseline.json`, and `runtime-owner.json` are outside `workspace/`, so they cannot enter project scan/sync paths.

---

# 5. SecretStorage stays stable

Keep the exact per-peer key:

```text
pairNotebook.sessionToken.<sessionId>.<peerId>
```

Store:

```ts
interface StoredSessionCredentialsV2 {
  version: 2;
  token: string;
  identityPrivateKey: string;
}
```

`decodeSessionSecret()` may retain v1 compatibility for manual old-session recovery.

Automatic pending continuation requires the exact v2 per-peer credentials. No legacy session-level fallback.

Do not rewrite SecretStorage merely to advance lifecycle phases.

---

# 6. Authenticated `control.json`

Suggested shape:

```ts
type LaunchControlState = 'pending' | 'committing' | 'established';

interface SessionLaunchControlV1 {
  version: 1;
  generation: number;
  launchId: string;
  kind: 'start' | 'join';
  state: LaunchControlState;

  sessionId: string;
  projectId: string;
  peerId: string;
  role: 'host' | 'peer';

  workingFolderRealPath: string;
  backingFolderRealPath?: string;

  markerSha256: string;
  nextMarkerSha256?: string;
  baselineSha256: string;

  createdAt: number;       // diagnostics only; never expiry authority
  mac: string;
}
```

Derive the MAC key from the **local participant private identity**, not the shared session token, using an explicit domain separator such as:

```text
pair-notebook-local-launch-control-v1
```

The exact KDF choice can reuse existing crypto primitives; the important property is that remote participants who know the session token still cannot forge another participant's local launch control.

MAC a fixed canonical field order. `mac` itself is excluded from the MAC input.

All control updates use `atomicWriteFile()`.

---

# 7. `baseline.json`

Do not put a 50k-entry project manifest inside `control.json`.

Suggested separate record:

```ts
interface LaunchBaselineV1 {
  version: 1;
  working: ProjectManifest;
  source?: ProjectManifest;          // host backing folder baseline
  sourceRealPath?: string;
  sourceDevice?: string;
  sourceInode?: string;
  snapshotHostId?: string;           // guest
  snapshotClock?: HostClock;         // guest, when authenticated at bootstrap
}
```

`control.baselineSha256` hashes the exact canonical baseline record.

Manifest entries are sorted and content based.

No wall-clock mtime is used as authority.

---

# 8. Stable host copy transaction before `openFolder()`

Host Start should become:

```text
1. trusted source required
2. acquire same-window launchPreparation mutex
3. choose backing folder
4. canonicalize source realpath and inspect directory identity
5. scan source manifest A
6. create staging working copy
7. scan source manifest B
8. scan staging manifest C
9. require A == B == C
   - if source changed: discard staging and retry boundedly
10. create sessionId/projectId/peerId/token/keypair
11. create descriptor
12. create exact marker bytes H0
13. store exact per-peer SecretStorage credentials
14. atomically write baseline.json
15. atomically write authenticated control.json(state=pending, markerSha256=H0)
16. atomically write marker bytes H0
17. publish/move staging content into the final session workspace safely
18. call vscode.openFolder() LAST
```

The exact staging/publish order may be adjusted to avoid moving an already-open root, but the invariant is unchanged: **the final workspace must contain a verified stable copy before `openFolder()` and all recovery state must already exist**.

`rememberProject()` is not called.

If `openFolder()` reports a failure while the source Extension Host remains alive, keep `control.state=pending` and offer **Retry Open Folder** / **Cancel Pending Session**. Do not destroy the transaction automatically.

---

# 9. Guest bootstrap transaction

Keep project snapshot bootstrap before target handoff.

Change `downloadProjectSnapshot()` to return a small receipt instead of `void`, for example:

```ts
interface SnapshotBootstrapReceipt {
  manifestDigest: string;
  hostPeerId: string;
  authenticatedHostClock?: HostClock;
}
```

The file manifest itself may be persisted in `baseline.json`.

Guest Join becomes:

```text
1. trusted source required
2. acquire same-window launchPreparation mutex
3. parse invite / create one local peer identity
4. bootstrap authenticated snapshot
5. persist verified snapshot baseline
6. create descriptor with the best authenticated bootstrap host clock available
7. write exact credentials/control/marker transaction
8. openFolder() LAST
```

Do not create a second peer ID when post-Trust host availability is bad.

---

# 10. Target activation: Trust is a hard gate

Recommended manifest default:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": false
  }
}
```

But code must still be safe if a user overrides that behavior.

Pseudo-activation:

```ts
export async function activate(context) {
  registerMinimalOutputAndSafeDashboard();

  if (!vscode.workspace.isTrusted) {
    renderAwaitingTrustOnly();
    vscode.workspace.onDidGrantWorkspaceTrust(() => initializeTrustedServices(context));
    return;
  }

  await initializeTrustedServices(context);
}
```

`initializeTrustedServices()` must be idempotent.

Before Trust:

- no session SecretStorage migration;
- no runtime construction;
- no proxy/network initialization;
- no signalling sockets;
- no file synchronization;
- no Python/kernel/controller activation for the session;
- no pending-control consumption.

If the extension is completely disabled, none of this code runs, which is explicitly supported by the durable transaction.

---

# 11. Trusted target reconciliation

On trusted activation:

```text
1. require exactly one local workspace folder for automatic session restore
2. read raw marker as bounded regular file
3. parse enough identity to locate exact per-peer credentials/control
4. compute current marker SHA
5. resolve current workspace realpath
6. derive expected session workspace path from globalStorage + sessionId + peerId
7. require all physical paths to match
8. load exact SecretStorage credentials (NO legacy fallback)
9. verify private->public identity against marker
10. load control.json
11. verify control MAC
12. verify control identity + marker hash + baseline digest
13. if control.state == pending/committing: automatic explicit continuation
14. if control.state == established: ordinary saved-session policy (manual reconnect unless another explicit policy exists)
15. marker with no valid control => manual old-session recovery only
```

A copied/tampered marker never auto-starts.

A long elapsed time never invalidates a correct pending control.

---

# 12. Runtime ownership: at-most-one local participant process

Before constructing a pending/established runtime, acquire:

```text
<session control dir>/runtime-owner.json
```

with exclusive creation.

The owner record includes:

```text
process.pid
random owner nonce
launchId
```

Do not use a wall-clock stale timeout as automatic authority.

Ownership is held until the runtime is completely stopped.

Every operation that can mutate launch lifecycle (`commit`, `cancel`, `take over`, established leave) must respect this owner.

A source-window Pending UI must not be allowed to Cancel a session that a live target window currently owns.

---

# 13. Split runtime startup into explicit phases

The current monolithic `SessionRuntime.start()` combines too many responsibilities.

Use a phase model similar to:

```ts
type RuntimeLaunchPhase =
  | 'constructed'
  | 'local-preparing'
  | 'local-prepared'
  | 'editor-capture-ready'
  | 'transport-starting'
  | 'network-wait'
  | 'host-wait'
  | 'state-syncing'
  | 'outer-bindings-ready'
  | 'committing'
  | 'established'
  | 'stopping'
  | 'closed';
```

Do not use one `initialized` boolean as both reentrancy guard and completion state.

---

# 14. Fresh host startup order

Recommended host sequence after Trust/control validation:

```text
A. acquire runtime ownership
B. revalidate delayed backing/working baselines (Section 15)
C. construct SessionRuntime with explicit pending-start launch context
D. local prepare:
     - load CRDT from current working copy
     - index binaries
     - create storage with backingRoot = undefined
     - sweep temp transfers
     - install project/transport/awareness handlers
E. install extension-level lifecycle handlers
F. install host local edit capture BEFORE network wait:
     - filesystem watcher
     - EditorSynchronizer
     - working-copy writer / editor anchor resolver
G. keep notebook execution disabled
H. structurally start all network engines independently
I. admission CLOSED while fresh host is pre-commit
J. wait/retry network infrastructure availability without destroying runtime
K. when commit conditions are met:
     - finalize marker/control two-phase commit
     - attach validated backingRoot
     - schedule/flush canonical state
     - bind Presence/NotebookController/dashboard active runtime
     - enable execution context
     - open participant admission
L. state = established
```

This eliminates both the startup edit gap and the backing overwrite race.

---

# 15. Host delayed-Trust three-way reconciliation

Before local CRDT/network startup, compare:

```text
B = Start-time baseline
W = current isolated working-copy manifest
S = current source/backing-folder manifest
```

Decision table:

| W vs B | S vs B | W vs S | Action |
| --- | --- | --- | --- |
| same | same | same | continue |
| same | changed | different | safely refresh working copy from latest source, then continue |
| changed | same | different | accept working copy as pending user's intended local state |
| changed | changed | same | accept converged new state |
| changed | changed | different | conflict: no automatic overwrite; preserve both and require resolution |
| source missing/replaced | any | any | block backing writes; explicit recovery |

The refresh path itself must be stable-copy verified; do not mutate the open working tree from a source that is still changing without validation.

This is the necessary consequence of supporting an arbitrary Trust delay safely.

---

# 16. Guest delayed-Trust reconciliation

For a guest:

```text
B = authenticated snapshot baseline
W = current isolated working copy
```

If `W == B`, automatic continuation is safe.

If `W != B`, local edits exist before initial host reconciliation. Do not silently overwrite them.

Minimum first implementation:

- preserve a staging/backup copy of the locally changed paths;
- stop automatic state projection for those paths;
- present a clear recovery/merge action;
- never silently delete the changed content.

A richer offline-edit merge can be a separate feature with dedicated CRDT/notebook tests.

---

# 17. Mesh transport startup must be structural, not availability-terminal

Replace the current serial fail-fast start with independent engine initialization.

Pseudo-contract:

```ts
interface TransportEngineStatus {
  primaryNostr: 'started' | 'failed';
  secondaryMqtt: 'started' | 'failed';
  emergencyRelay: 'started' | 'failed';
}

interface TransportStartResult {
  structuralState: 'started';
  engines: TransportEngineStatus;
}
```

`start()` may throw for an actual local invariant/programming/configuration error that makes structural initialization impossible. Temporary DNS/TCP/TLS/proxy/public-relay availability is health state, not session destruction.

Start immediately:

- primary signalling;
- secondary signalling;
- emergency relay reconnect engines;
- heartbeat/ping/metrics timers;
- NetworkChangeWatcher.

Do not await emergency `waitUntilReady()` as a prerequisite for starting the others.

---

# 18. Host network-ready semantics

A host has no remote peer yet, so “end-to-end peer route proved” cannot be a startup requirement.

Use a positive infrastructure-ready condition such as any verified usable signalling/relay family, while continuing all other engines in background.

If nothing is currently reachable:

```text
Pending Session
Network unavailable — retrying
same sessionId / peerId / keypair
```

Do not create a new session.

Once the infrastructure-ready condition is met, the host may commit and become discoverable/established.

The exact readiness threshold should be tested against the supported network matrix; it must not require every redundant family simultaneously.

---

# 19. Guest initial state: progress-sensitive, nonterminal waiting

Do not do:

```text
await stateReady for fixed 45s -> throw -> leave runtime
```

Instead:

```text
no host route yet
  -> host-unavailable state
  -> keep transport/pending identity alive

host route authenticated
  -> state-syncing
  -> track authenticated progress

no state progress for bounded idle period
  -> warning / refresh signalling
  -> remain retryable

stateEnd from valid current host
  -> initial-state-ready
  -> continue commit
```

A fixed warning can still be shown after 45 seconds, but it must not destroy the pending Join.

---

# 20. Admission policy during pre-commit startup

Do not let a fresh host admit arbitrary participants before its editor/file capture and commit boundary are ready.

Recommended transport admission mode:

```ts
type AdmissionMode = 'closed' | 'pinned-host-only' | 'open';
```

- fresh host pre-commit: `closed`;
- pending guest: `pinned-host-only`;
- established session: `open` under existing protocol rules.

This prevents a participant from receiving an initial host state from a runtime whose local editors are not yet captured.

Do not overload existing `hostStorageReady` semantics if that field specifically represents backing-folder materialization. Add a distinct local startup/admission gate.

---

# 21. Outer commit is a two-phase durable transaction

Because marker and control are separate files, use a crash-recoverable two-phase sequence.

Let:

```text
H0 = exact pre-commit marker SHA
H1 = exact final marker SHA generated from final in-memory descriptor
```

Commit:

```text
1. all required runtime/editor/network conditions satisfied
2. generate exact final marker bytes H1 once
3. write authenticated control:
     state = committing
     markerSha256 = H0
     nextMarkerSha256 = H1
4. atomic write final marker H1
5. write authenticated control:
     state = established
     markerSha256 = H1
     nextMarkerSha256 = absent
6. attach/flush backing root if host
7. enable established UI/execution/admission
```

If desired, step 6/7 can be ordered around step 5 according to the exact chosen definition of “established”; the invariant is that recovery from every crash point is explicit and tested.

### Recovery matrix

```text
control=pending, marker=H0
  -> resume explicit pending launch

control=committing, marker=H0
  -> final marker was not published; resume/finalize pending launch

control=committing, marker=H1
  -> marker publish occurred but transaction was not finalized
  -> AUTO-RESUME under pending launch context, reconstruct runtime, then finalize

control=established, marker=H1
  -> established saved session; normal saved-session policy

any other hash/control combination
  -> integrity failure, no automatic network
```

Important: `committing + H1` must not be treated as an ordinary old marker merely because `freshStart` inside H1 is false. The authenticated control record is the stronger lifecycle authority.

---

# 22. Freeze ordinary descriptor persistence until commit

Current runtime can persist descriptor changes during startup, including local identity updates.

While control is `pending` / `committing`, ordinary descriptor writes must not independently mutate the marker behind the launch transaction.

Use a persistence gate:

```text
pre-commit descriptor mutations
  -> allowed in memory
  -> ordinary marker writes coalesced/deferred

commit
  -> serialize one final exact marker H1
  -> atomic publish

established
  -> release normal descriptor write queue
```

This includes changes to:

- `freshStart`;
- local join order;
- known peers;
- host clock;
- file state/binary maps;
- compute metadata.

For a pending fresh host, admission is closed, so the mutation surface should remain small.

---

# 23. Backing writes are also frozen until host commit

For a pending fresh host:

```text
StorageAdapter.backingRoot = undefined
```

Only after delayed-source reconciliation and commit may the original backing folder become a write target.

This is a separate invariant from marker persistence and must have its own test.

---

# 24. Deactivation / crash semantics

Introduce explicit orchestrator phase, for example:

```ts
type LocalSessionLifecycle = 'none' | 'preparing' | 'pending' | 'starting' | 'established';
```

On Extension Host deactivation:

### pending/starting

```text
stop process-local runtime/transport best effort
preserve control= pending/committing
preserve credentials
preserve working copy
release runtime ownership after stop
DO NOT rememberProject()
DO NOT clear explicit launch intent
```

### established

Use existing leave/reconnect history semantics.

Do not call established `leaveActiveSession()` merely because a pre-commit `runtime` object exists.

---

# 25. Pending / Active / Recent are three different product objects

## Pending Session

Explicit Start/Join requested but not committed.

Possible UI states:

- Awaiting Workspace Trust
- Preparing local state
- Source project changed — reconciling
- Network unavailable — retrying
- Waiting for Session Host
- Synchronizing initial state
- Startup conflict — action required

Actions:

- Open pending workspace
- Retry
- Cancel pending session
- Show diagnostics

## Active Session

Committed and currently running.

## Recent Session

A session that was established and later left/disconnected.

`rememberProject()` belongs only to a real exit/disconnect path.

Do **not** add a Recent entry merely because Start succeeded. “Recent” currently carries `leftAt` semantics.

---

# 26. Cancel Pending Session

Cancel must target the exact launch and respect runtime ownership.

If another live process owns it, refuse automatic cancellation and point the user to that window.

Otherwise:

```text
1. stop retry/attempt if any
2. remove marker first (safe: markerless secret/control cannot auto-start)
3. remove authenticated control/baseline
4. delete exact per-peer credentials if launch never established
5. remove pending UI/index data
6. optionally delete isolated working copy only after explicit confirmation
```

A crash halfway through cancellation may leave harmless orphan state, but must never create an auto-startable forged state.

---

# 27. GlobalState becomes non-authoritative

Remove `PENDING_SESSION_LAUNCH_KEY` from correctness.

A global index is optional, but even that is not necessary: the extension-owned sessions directory can be scanned in a bounded manner for `control.json` records when rendering Pending Sessions.

If an index remains for performance, it is cache-only. Losing it must not lose a valid pending launch.

---

# 28. Old-session compatibility

Rules:

- marker + v1 secret + no authenticated control => manual reconnect only;
- old `0.5.26` global pending handoff may be migrated only if marker/path/exact secret all validate strongly;
- if the old global pending was already deleted by `claimPendingSessionLaunch()`, do not guess that an arbitrary old marker was a fresh launch;
- never delete old working copies merely because they cannot be auto-classified.

For the repeated failed host cards created by `0.5.24`–`0.5.26`, a one-time cleanup tool can identify obvious `role=host && freshStart=true` failed launches, but deletion of working copies should remain explicit.

---

# 29. Full delayed-guest host-authority guarantee requires protocol work

If product requirements later demand:

```text
guest offline/untrusted for arbitrary time
AND host may transfer A -> B -> C
AND old hosts may disappear
AND guest must still securely find current host
```

then add an authenticated host-authority certificate chain/rendezvous rather than weakening source checks.

Conceptually:

```ts
interface HostAuthorityCertificate {
  sessionId: string;
  sessionEpoch: number;
  fromHostId: string;
  fromHostEpoch: number;
  toHostId: string;
  toHostIdentityKey: string;
  toHostEpoch: number;
  signatureByPreviousHost: string;
}
```

A stale guest can advance authority only through a cryptographically valid chain rooted in the host identity/clock it already trusts.

Offline session termination should similarly use a host-authenticated portable terminal certificate if it must be discoverable after all live peers disappear.

This is **not required** to fix the current host Start/Trust regression and should not be mixed into the first lifecycle repair unless the requirement explicitly includes host transfer during the guest's offline Trust delay.

---

# 30. Tests required before implementation is considered correct

## 30.1 Launch transaction tests

1. exact pending Start survives Extension Host reset;
2. exact pending Join survives Extension Host reset;
3. one-hour/multi-day elapsed time does not expire pending launch;
4. system clock moving backward/forward does not change validity;
5. copied marker at another path cannot auto-start;
6. tampered marker cannot auto-start;
7. missing exact secret cannot auto-start;
8. legacy secret fallback is not used for pending automatic restore;
9. private/public identity mismatch fails closed;
10. control MAC mismatch fails closed;
11. control schema previous version migrates safely;
12. unknown future control version preserves data and fails closed.

## 30.2 Crash matrix tests

Kill/reconstruct after:

- credentials write;
- baseline write;
- pending control write;
- marker write;
- successful `openFolder` handoff;
- Trust before runtime ownership;
- ownership acquisition;
- local prepare;
- transport structural start;
- control `committing` write;
- final marker H1 write;
- control `established` write.

Assert deterministic next activation behavior for each state.

## 30.3 Source command concurrency

- two concurrent Start commands in one window => exactly one preparation;
- two concurrent Join commands => exactly one local participant identity;
- Start while target restore is active does not create another session;
- UI button disabled while launchPreparation is in flight.

## 30.4 Runtime ownership

- second window cannot start same session identity while owner PID is alive;
- a 10-minute/1-hour stale timestamp with live PID is **not** stolen;
- dead PID ownership is recoverable;
- uncertain liveness fails safe;
- owner release requires matching owner nonce;
- cancel cannot delete a live runtime owned by another process.

## 30.5 Delayed backing/source tests

- Start -> wait -> backing unchanged => normal;
- Start -> backing changes while untrusted => old working state never overwrites new backing state;
- backing-only change can be safely refreshed under same session identity;
- working-only change is preserved as pending host state;
- divergent working+backing edits trigger conflict, no overwrite;
- source symlink/junction retarget is detected;
- source deleted/recreated is detected;
- source changing during initial copy causes retry/failure, never inconsistent accepted baseline.

## 30.6 Startup edit-capture tests

Host:

- saved open text edit while network startup is held;
- dirty open text edit while network startup is held;
- closed file external edit while network startup is held;
- notebook cell edit during the same window.

All must converge without silently reverting the local edit.

Guest:

- target unchanged from bootstrap baseline => automatic sync;
- target changed before Trust => no silent host overwrite; backup/recovery path activated.

## 30.7 Transport startup tests

- primary Nostr constructor failure does not prevent MQTT/emergency engines from starting;
- emergency relay unavailable does not kill a healthy primary engine;
- secondary signalling starts even if emergency relay is unavailable;
- network watcher starts before external readiness;
- concurrent `MeshTransport.start()` callers await one shared start result;
- no `room != undefined` partial-start false success;
- stop during `starting` cleans every engine exactly once;
- relay recovery after initial outage uses same transport object.

## 30.8 Bootstrap tests

- direct/TURN snapshot remains in progress >15 seconds while emergency relays fail; transfer still completes;
- emergency relay path alone still completes bootstrap;
- bootstrap host discovery timeout remains bounded when no host exists;
- bootstrap returns/persists manifest receipt and authenticated host clock when available.

## 30.9 Initial runtime state tests

- guest receives progress for >45 seconds and does not fail while progress continues;
- sender drain may legitimately approach existing 120-second budget without receiver terminating at 45 seconds;
- host absent => host-unavailable, same identity preserved;
- host returns => same runtime/pending Join reaches stateEnd and commits;
- authenticated session-ended => pending is terminated cleanly.

## 30.10 Deactivation semantics

- deactivate while pending runtime exists => no Recent entry;
- deactivate while committing => control remains recoverable;
- deactivate established runtime => existing Recent/leave semantics exactly once.

## 30.11 Existing sync regression suite

All existing protocol-v7 text/notebook/output/execution tests remain green.

Do not “fix” lifecycle tests by weakening sync assertions.

---

# 31. Real Workspace Trust acceptance gate

The current Extension Host E2E runner uses:

```text
--disable-workspace-trust
```

so it cannot prove the production Trust boundary.

Required installed-VSIX cases on Windows:

### T-A — delayed Trust host

```text
clean profile
install candidate VSIX
open trusted source
Start Session
isolated target opens Restricted Mode
verify Pair Notebook performs no session networking
wait
Trust
same sessionId/peerId resumes automatically
no second Start click
```

### T-B — close/reopen before Trust

Close VS Code completely while target is untrusted, reopen exact target, Trust, same launch resumes.

### T-C — extension update/reload before Trust

Pending schema survives extension-host/window reload and candidate-version update path.

### T-D — network unavailable after Trust

Trust with blocked network/proxy; session remains Pending/Network unavailable under same identity. Restore network; same launch continues.

### T-E — backing folder changes during Trust delay

Modify original backing project from another process/window before granting Trust. Candidate must not overwrite those changes silently.

### T-F — edit isolated host workspace while startup network is delayed

Saved edit must survive startup and synchronize.

### T-G — delayed guest host unavailable

Bootstrap snapshot, delay Trust, stop pinned host, Trust guest, verify host-unavailable without new peer ID, restore host, complete same Join.

### T-H — old/copied marker

No automatic network activity.

---

# 32. Release pipeline gate

Current packaging/release does not make the critical Trust path release-blocking:

- `npm run artifacts` does not run `test:e2e`;
- release workflow runs artifact verification on Ubuntu;
- `.github/workflows/e2e.yml` runs on PR/main push, not release tags;
- a tag workflow can therefore publish without directly proving the exact Windows Trust acceptance for that tag.

Before stable release:

1. unit/integration suite green;
2. real Extension Host E2E green on its matrix;
3. exact candidate commit has recorded Windows installed-VSIX Trust acceptance;
4. physical two-computer host/guest acceptance green;
5. release workflow verifies it is publishing that exact accepted commit.

Until automated external VS Code UI control is reliable, use a manual release-blocking acceptance artifact/check rather than pretending `@vscode/test-electron` with Workspace Trust disabled proves this path.

---

# 33. Implementation modules

Prefer extracting lifecycle logic from the already-large `extension.ts`.

Suggested modules:

```text
src/core/sessionCredentials.ts
src/core/sessionControl.ts
src/core/projectBaseline.ts
src/core/runtimeOwner.ts
src/core/launchPreparation.ts
```

Primary modified files:

```text
package.json
src/extension.ts
src/runtime/session.ts
src/runtime/mesh.ts
src/runtime/bootstrap.ts
src/core/projectFiles.ts
src/core/persistence.ts
src/vscode/dashboard.ts
scripts/run-vscode-e2e.mjs
.github/workflows/e2e.yml
.github/workflows/release.yml
```

`src/vscode/sync.ts` should not require algorithmic changes for the host startup repair; bind it earlier. Guest pre-ready offline-edit merge is a separate feature unless a targeted implementation proves safe.

---

# 34. Controlled implementation order

## Phase 1 — tests and observability only

Add failing tests for:

- source launch single-flight;
- pending deactivation no-Recent;
- control/path integrity;
- runtime owner process-liveness semantics;
- stable source copy;
- delayed backing drift;
- host startup saved-edit capture;
- transport independent engine startup;
- >15s bootstrap with fallback outage;
- >45s progressing initial state;
- no release on unaccepted Trust candidate.

No sync semantic changes.

## Phase 2 — local transaction/control layer

- exact per-peer credentials v2;
- authenticated `control.json`;
- `baseline.json`;
- physical workspace path binding;
- remove global pending singleton from authority;
- same-window launchPreparation mutex;
- runtime owner.

## Phase 3 — Trust activation architecture

- default `supported:false` unless there is a proven limited-mode UX requirement;
- minimal untrusted branch even if override activates extension;
- trusted service initializer;
- deterministic target reconciliation.

## Phase 4 — host data-safety fences

- stable source copy;
- delayed three-way backing/working baseline check;
- storage backing-write fence;
- host editor/file capture before network exposure.

## Phase 5 — runtime/outer commit split

- explicit runtime launch phases;
- outer event handlers before network;
- defer descriptor/context established flags;
- two-phase H0/H1 control+marker commit;
- precommit deactivation semantics.

## Phase 6 — transport structural startup

- startPromise/state machine;
- independent primary/secondary/emergency engines;
- early NetworkChangeWatcher;
- nonterminal availability;
- keep engines alive for recovery.

## Phase 7 — guest waiting semantics

- bootstrap receipt/baseline;
- progress-sensitive initial state;
- host-unavailable nonterminal state;
- guest local-drift safety.

## Phase 8 — UI lifecycle cleanup

- Pending / Active / Recent separation;
- Retry/Cancel/open pending;
- remove user-facing “still restoring” as a normal workflow error;
- never suggest established Reconnect when no runtime exists.

## Phase 9 — release acceptance

Installed VSIX Trust tests + physical two-computer test + exact-commit release gate.

---

# 35. Explicit non-goals for this repair

Do not opportunistically rewrite:

- Yjs local-first ownership;
- protocol-v7 wire shapes;
- notebook stable-cell identity;
- output/execution synchronization;
- text projection quarantine;
- route upgrade scoring;
- host-election semantics.

If any of those fail a new startup regression test, create a separate proven defect with its own reproduction rather than broadening this repair silently.

---

# 36. Final acceptance definition

The startup repair is complete only when this entire statement is true:

```text
one explicit Start/Join
AND exactly one local launch identity
AND source copy is internally consistent
AND all recovery state exists before openFolder
AND openFolder may kill the old Extension Host
AND Restricted Mode may disable Pair Notebook completely
AND user may wait arbitrary time before Trust
AND VS Code may close/restart/update before Trust
AND target Trust later finds the exact authenticated pending control
AND copied/tampered/old markers do not auto-connect
AND a second local window cannot reuse the same participant private key
AND backing folder changes during the delay are never silently overwritten
AND host edits during startup are captured before network exposure
AND primary/secondary/emergency network engines fail independently
AND temporary network failure does not destroy the pending session
AND long progressing bootstrap/state sync is not killed by unrelated absolute timeout
AND pending deactivation does not create Recent history
AND commit is crash-recoverable at every marker/control write boundary
AND established sessions retain existing protocol-v7 sync semantics
AND exact candidate VSIX passes Windows Trust acceptance
AND physical two-computer collaboration acceptance passes
```

The essential architectural change is:

```text
BEFORE
Start/Join
 -> copy once without stable snapshot proof
 -> secret + marker
 -> Recent entry too early
 -> global singleton pending
 -> openFolder
 -> claim/delete durable handoff
 -> RAM-only Trust wait
 -> monolithic runtime.start
 -> serial fail-fast transport startup
 -> descriptor says ready before VS Code bindings
 -> transient failure tears runtime down

AFTER
Start/Join single-flight
 -> stable verified project baseline
 -> static exact credentials
 -> authenticated per-session control outside workspace
 -> marker + control committed before openFolder
 -> zero required execution while untrusted
 -> arbitrary Trust delay/restart/update
 -> physical path + control + credential verification
 -> process-liveness runtime ownership
 -> delayed backing/working drift reconciliation
 -> local editor/file capture before host network exposure
 -> independent network engines kept alive for recovery
 -> progress-sensitive guest state wait
 -> outer two-phase commit
 -> only established exits become Recent
```

This removes the timing assumptions that caused the `0.5.24`–`0.5.26` repair chain and also closes the newly identified data-loss and partial-start boundaries that would otherwise remain even after the Trust handoff itself was fixed.