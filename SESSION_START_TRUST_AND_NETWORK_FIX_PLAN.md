# Pair Notebook: durable session start across Workspace Trust and transient network failure

Date: 2026-09-09

Status: root-cause analysis + implementation specification for the current `main` / `v0.5.26` startup path.

This document is intentionally stricter than the previous `0.5.24`–`0.5.26` fixes. The goal is not another timing workaround. The goal is to make **Start Session** and **Join Session** correct across a real VS Code process boundary, Workspace Trust delay, extension-host restart, and transient network failure **without changing protocol-v7 synchronization semantics**.

---

# 0. Required product behavior

The target behavior is:

1. User presses **Start Session** or **Join Session** in a trusted source workspace.
2. Pair Notebook creates/downloads the isolated working copy and persists the exact launch intent.
3. Pair Notebook calls `vscode.openFolder()` for the isolated folder.
4. VS Code may open that folder in Restricted Mode and may completely disable Pair Notebook.
5. The user may leave the folder untrusted for one hour, several hours, close/reopen VS Code, or let the extension host restart.
6. When that exact folder is eventually trusted and Pair Notebook is activated again, it must continue the **same** launch:
   - same `sessionId`;
   - same `projectId`;
   - same local `peerId` and identity key;
   - same working folder;
   - same host authority;
   - no second session card;
   - no stale-session confirmation prompt;
   - no dependency on in-memory state left by the source window.
7. A temporary VPN/proxy/Nostr/MQTT/WebRTC outage must not destroy a freshly prepared session. It must remain retryable under the same session identity.
8. Existing CRDT/Yjs/notebook/output/execution synchronization stays out of scope unless a separate failing test proves a sync defect.

The release must not claim this is guaranteed merely because unit tests pass. The guarantee is the combination of the state-machine invariants below **plus an installed-VSIX Workspace Trust acceptance gate**.

---

# 1. Verified root causes in the current repository

## 1.1 `v0.5.23` is the last known good lifecycle baseline

`v0.5.23` declared:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": false
  }
}
```

and activation called `startWorkspaceSessionRestore(context)` after the target folder opened. Start/Join persisted the marker and SecretStorage credentials before `vscode.openFolder()`.

That implementation had an over-eager automatic restore problem for old sessions, but it accidentally had one important property that the later fixes lost: **the newly requested launch could survive the Trust boundary using durable state rather than an in-memory handoff**.

References:

- `v0.5.23/package.json`
- `v0.5.23/src/extension.ts`
- `SESSION_LIFECYCLE_ROOT_CAUSE_REPORT.md`

## 1.2 `0.5.24` changed a durable workflow into a consent/lifecycle workflow and introduced the regression

The repository's own lifecycle report identifies `v0.5.23` as baseline and documents the `0.5.24` regression. The core issue is that two different cases became entangled:

- a **fresh explicit Start/Join already authorized by the user**;
- an **old marker from a previous session**, which must remain manual-only.

The correct fix is not to make every marker automatic again. It is to persist a durable proof that a specific marker belongs to an unfinished explicit Start/Join.

## 1.3 `0.5.26` still destroys the only durable launch evidence before Trust

Current path:

```text
startSession()/joinSession()
  -> saveDescriptor(...)
  -> rememberProject(...)
  -> openSessionWorkingFolder(...)
  -> globalState[PENDING_SESSION_LAUNCH_KEY] = pending launch
  -> vscode.openFolder(...)

new target activation
  -> offerWorkspaceSessionRestore(...)
  -> claimPendingSessionLaunch(...)
  -> DELETE PENDING_SESSION_LAUNCH_KEY
  -> keep claimedLaunch only in extension-host memory
  -> wait for Workspace Trust
  -> startWorkspaceSessionRestore(...)
```

The unsafe transition is:

```text
DURABLE launch intent
      ↓ deleted
RAM-only claimedLaunch
      ↓
wait for Trust
```

That means correctness still depends on the extension host remaining alive for the whole Restricted Mode interval.

The user requirement is the opposite: **Restricted Mode must be allowed to kill Pair Notebook completely for an arbitrary delay**.

Relevant files:

- `src/extension.ts`
- `src/core/manualSessionRestore.ts`
- `WORKSPACE_TRUST_SESSION_START_ROOT_CAUSE.md`

## 1.4 `vscode.openFolder()` is itself a hard process boundary

VS Code documents that opening a folder in the same window shuts down the current extension host process and starts a new one for the new folder/workspace.

Official reference:

https://code.visualstudio.com/api/references/commands#_built-in-commands

Therefore **no line executed after a successful same-window `vscode.openFolder()` call may be required for correctness**.

Treat `openFolder()` as a one-way handoff/commit boundary:

```text
persist everything required
        ↓
vscode.openFolder(target)
        ↓
old extension host may disappear immediately
```

This is broader than Workspace Trust. Even in a trusted target folder, the source extension-host lifetime cannot be part of the protocol.

## 1.5 The current process-identity binding is unsuitable as correctness state

`currentEditorProcessIdentity()` hashes `VSCODE_PID` and `VSCODE_IPC_HOOK` / `VSCODE_IPC_HOOK_CLI`. Those values are not the public Workspace Trust contract. `vscode.env.sessionId` is also an editor-session identifier, not a durable Start/Join transaction identifier.

These values can remain in diagnostics, but they must not decide whether a valid explicit Start/Join is resumed.

A one-hour delay, extension-host restart, VS Code restart, or process replacement must not invalidate the launch.

## 1.6 The current single `PENDING_SESSION_LAUNCH_KEY` is also a multi-window correctness hazard

The current design stores one global pending launch. Two VS Code windows can therefore race or overwrite the only record.

A fresh launch is already naturally namespaced by:

```text
sessionId + local peerId
```

The durable intent should be stored with that session's existing SecretStorage record, not in one process-global singleton.

## 1.7 `saveDescriptor()` already gives us a stronger durable anchor than globalState

Current `saveDescriptor()` does:

```text
SecretStorage(sessionId, peerId) = { token, identityPrivateKey }
      ↓
atomic write of .pair-notebook-session.json
      ↓
rollback SecretStorage if marker write fails normally
```

The current key is already unique:

```text
pairNotebook.sessionToken.<sessionId>.<peerId>
```

Current stored value is version 1:

```ts
interface StoredSessionSecret {
  version: 1;
  token: string;
  identityPrivateKey?: string;
}
```

This is the best place to attest an unfinished explicit Start/Join, because:

- it survives extension-host death and long Trust delays;
- workspace files cannot forge SecretStorage;
- it is already bound to the exact `sessionId` + local `peerId`;
- it avoids a second global singleton correctness store.

## 1.8 Current `rememberProject()` runs too early and creates ghost Recent Sessions

`startSession()` / `joinSession()` call `rememberProject()` before the target workspace successfully restores and before `SessionRuntime.start()` reaches usable state.

So an attempt can fail before a session ever existed as a usable collaboration runtime, yet still become a Recent Session card. Repeating Start creates the repeated `project_test` entries observed in the UI.

A pending launch is not a historical session. It must not be promoted to Recent until startup commits.

## 1.9 Current Trust E2E explicitly disables Workspace Trust

`scripts/run-vscode-e2e.mjs` currently includes:

```text
--disable-workspace-trust
```

That means the real failure path is not exercised:

```text
Start
 -> openFolder
 -> Restricted Mode
 -> extension disabled/limited
 -> delayed Trust
 -> extension re-enabled
 -> activation
 -> continue exact pending launch
```

VS Code's official testing guide explicitly says trusted and untrusted Workspace Trust scenarios need separate runs and that normal extension tests cannot programmatically grant/revoke Trust.

Official reference:

https://code.visualstudio.com/api/working-with-extensions/testing-extension#testing-workspace-trust-behavior

## 1.10 VS Code explicitly allows the extension to disappear in Restricted Mode

Official Workspace Trust documentation says extensions unsupported in Restricted Mode are disabled and their commands/UI disappear. Users can trust the folder later; VS Code's own trust enablement test plan verifies that extensions disabled by the Trust requirement become enabled after Trust is granted.

References:

- https://code.visualstudio.com/api/extension-guides/workspace-trust
- https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- https://github.com/microsoft/vscode/issues/128004

Therefore the Pair Notebook design must work when `onDidGrantWorkspaceTrust` never fires because Pair Notebook was not running at all.

## 1.11 `local-route-failed` is a second independent startup defect

Current runtime startup contains this terminal boundary:

```text
SessionRuntime.start()
  -> MeshTransport.start()
  -> throw
  -> disposeAsync('local-route-failed')
```

Inside `MeshTransport.start()` the primary Trystero room is created and then the code awaits:

```text
startRelayFallback()
  -> RedundantFrameRelay.waitUntilReady(15_000)
```

If neither emergency relay family becomes ready, startup throws. A temporary infrastructure/VPN/proxy failure therefore destroys the new runtime instead of leaving the same local session retryable.

Relevant files:

- `src/runtime/session.ts`
- `src/runtime/mesh.ts`
- `src/runtime/redundantFrameRelay.ts`

## 1.12 Guest startup has a second retryability problem after delayed Trust

`downloadProjectSnapshot()` happens **before** the target folder handoff. It is a bootstrap transport with `purpose: 'bootstrap'`; if the host cannot be reached there, Join already fails in the trusted source workspace and no pending target launch should be committed. This part is a good boundary and should remain.

But after snapshot bootstrap, the target folder may remain untrusted for an hour. Once it is trusted, `SessionRuntime.start()` for a guest does:

```text
transport.connect(host)
  -> wait for initial project state
  -> 45 second timeout if host does not provide state
```

That timeout is currently a generic startup failure. For a delayed Trust scenario it must be classified as **host temporarily unavailable**, not as a reason to destroy the pending Join identity.

Relevant files:

- `src/runtime/bootstrap.ts`
- `src/runtime/session.ts`

---

# 2. Non-negotiable invariants

The implementation is correct only if all of these are true.

## T1 — Trust independence

A valid fresh Start/Join remains resumable if Pair Notebook executes zero code between `openFolder()` and the eventual Trust grant.

## T2 — No time dependency

A valid fresh Start/Join does not expire merely because the user waited one hour. Prefer **no time-based automatic invalidation at all**. Pending intent ends only by:

- successful startup commit;
- explicit Cancel;
- authenticated `session-ended` / known terminal invalidation;
- irrecoverable integrity mismatch or missing credentials.

Do not use a 15 min / 1 h / 24 h TTL as the correctness mechanism. Clock changes and long user delays must not change identity semantics.

## T3 — At-most-one local startup attempt

The same `(sessionId, peerId, workingFolder)` cannot be started concurrently by two VS Code windows.

## T4 — At-least-once retry until commit

If the extension host crashes after Trust but before startup commits, the same pending launch remains available on the next activation.

Together T3 + T4 give effectively-once startup **commit** semantics without pretending the actual network side effects are transactional.

## T5 — No automatic old-session reconnect

A marker without an authenticated pending-launch intent stays manual-only.

## T6 — No networking before Trust

`SessionRuntime`, Trystero, WebRTC, Nostr/MQTT relay, filesystem synchronization, and Python execution must not start while `vscode.workspace.isTrusted === false`.

## T7 — No ghost Recent Session

A launch is not added to normal Recent Sessions until the first successful startup commit.

## T8 — Network outage preserves identity

A network/VPN/proxy/relay outage before first ready state never creates a new session ID, peer ID, keypair, or working folder.

## T9 — Sync protocol isolation

No fix in this plan changes protocol-v7 CRDT ownership, Yjs text updates, notebook stable-cell IDs, output synchronization, execution synchronization, or wire compatibility.

## T10 — Fail closed on integrity mismatch

A marker that does not match its SecretStorage-attested launch record must never auto-start network activity.

---

# 3. Recommended durable design: SecretStorage-attested launch intent

The previous plan proposed `PendingSessionLaunchV3` in globalState. A deeper review shows a stronger design is available: **make the session's existing SecretStorage record the source of truth for the unfinished explicit launch**.

GlobalState may keep a bounded secondary index for dashboard discovery/garbage collection, but it must not be required to resume the target folder.

## 3.1 Upgrade the session secret format

Keep backwards compatibility with version 1 and introduce version 2:

```ts
interface StoredPendingLaunch {
  version: 1;
  launchId: string;
  kind: 'start' | 'join';
  createdAt: number;
  descriptorDigest: string;
}

interface StoredSessionSecretV2 {
  version: 2;
  token: string;
  identityPrivateKey: string;
  pendingLaunch?: StoredPendingLaunch;
}
```

`decodeSessionSecret()` must accept both v1 and v2.

For a newly requested Start/Join, write v2 with `pendingLaunch` present.

After startup commits, rewrite the **same SecretStorage key** without `pendingLaunch`:

```ts
{
  version: 2,
  token,
  identityPrivateKey
}
```

That one field is the durable distinction between:

```text
fresh explicit unfinished launch  => auto-resume after Trust
old/established saved session     => manual reconnect only
```

## 3.2 Descriptor digest must cover immutable identity, not mutable runtime state

Do not hash raw `JSON.stringify(descriptor)` as the contract. Property order and mutable fields would make it fragile.

Define a canonical immutable subset:

```ts
interface LaunchDescriptorIdentity {
  sessionId: string;
  projectId: string;
  role: 'host' | 'peer';
  peerId: string;
  peerIdentityKey: string;
  hostPeerId: string;
  workingFolder: string;
  sessionEpoch: number;
}
```

Canonicalize strings and path representation, serialize in a fixed field order, then SHA-256 it.

Do **not** include fields expected to change during runtime startup, such as:

- `freshStart`;
- `knownPeers`;
- file-state maps;
- compute state;
- notebook state;
- transient runtime metadata.

The digest exists to bind the pending launch to immutable local identity, not to freeze the entire descriptor forever.

## 3.3 Path binding should use the real physical target

The current `sameWorkspacePath()` only uses `path.resolve()` and case-folding on Windows.

For the launch identity, resolve the working folder to a canonical real path after it is created and reject symlink/junction substitution where practical. The session working copy already lives below extension-owned global storage, so the expected path is known before `openFolder()`.

At minimum validate:

```text
current workspace real path
== descriptor workingFolder real path
== pending-launch canonical path
```

A copied marker in another folder must never be enough to auto-start.

## 3.4 GlobalState becomes an index, never the authority

Optional structure:

```ts
interface PendingLaunchIndexEntry {
  sessionId: string;
  peerId: string;
  workingFolder: string;
  createdAt: number;
}
```

Use it only for:

- showing "Pending Sessions" in the dashboard;
- orphan cleanup;
- recovery if `openFolder()` never happened.

If that index is lost, the exact target folder must still resume from marker + SecretStorage alone.

This also removes the current single-key multi-window overwrite problem.

---

# 4. Write-ahead transaction before `openFolder()`

`openFolder()` must be the final step. All recovery data must already be committed.

## 4.1 Host Start

```text
1. require trusted source workspace
2. prompt display name
3. choose backing folder
4. create sessionId/projectId/peerId/keypair/token
5. create isolated working copy
6. create descriptor
7. compute canonical immutable descriptor digest
8. store SecretStorage v2 with pendingLaunch
9. atomically write .pair-notebook-session.json
10. optionally update pending-launch index
11. call vscode.openFolder(target) LAST
```

No `rememberProject()` before step 11.

## 4.2 Guest Join

Keep snapshot bootstrap before the Trust handoff:

```text
1. require trusted source workspace
2. parse invite
3. create local peerId/keypair
4. download and verify host snapshot in trusted source context
5. create local descriptor
6. compute canonical immutable descriptor digest
7. store SecretStorage v2 with pendingLaunch(kind='join')
8. atomically write marker
9. optionally update pending index
10. call vscode.openFolder(target) LAST
```

If snapshot bootstrap cannot reach the host, fail before creating a committed pending target launch.

## 4.3 Crash-consistency matrix

The implementation must explicitly handle every crash point:

| Crash point | Durable state | Correct next behavior |
| --- | --- | --- |
| before SecretStorage write | working copy only | no auto-resume; safe orphan cleanup |
| after SecretStorage, before marker | secret only | no auto-resume because marker absent; cleanup later |
| after marker, before `openFolder` | complete pending launch | source window may offer "Open pending session"; target can be opened later |
| during successful `openFolder` | complete pending launch | old extension host may die; target activation owns continuation |
| target opens untrusted | complete pending launch | do nothing until Trust; state remains durable indefinitely |
| extension host dies while untrusted | complete pending launch | no effect |
| VS Code closes/restarts while untrusted | complete pending launch | reopening exact folder and trusting it still resumes |
| crash after Trust during startup | complete pending launch + stale startup lock | later activation retries after lock expiry |
| startup reaches commit, crash before index cleanup | secret has no pending launch; index may be stale | treat as established/manual session; clean stale index |

The important rule is that **pending intent is removed only at the startup commit point, never at claim time**.

## 4.4 Do not roll back merely because `openFolder()` does not return normally

A successful same-window `openFolder()` intentionally shuts down the current extension host. Therefore absence of a normal continuation after the call is not evidence of failure.

If VS Code explicitly reports an error while the source host is still alive, keep the pending launch and offer:

- **Retry Open Folder**;
- **Cancel Pending Session**.

Do not delete the launch automatically just because navigation failed once.

---

# 5. Trusted target activation: deterministic reconciliation

Replace the current claim-and-delete model with reconciliation from durable state.

```ts
async function reconcileSessionWorkspaceOnActivation(context) {
  const folder = singleLocalWorkspaceFolder();
  if (!folder) return;

  const marker = await readAndValidateMarker(folder);
  if (!marker) return;

  // If limited-mode happens to be allowed, remain inert here.
  if (!vscode.workspace.isTrusted) {
    renderAwaitingTrustOnly();
    return;
  }

  const secret = await descriptorSecret(context, marker);
  if (!secret) {
    showMissingCredentialsRecovery();
    return;
  }

  const pending = secret.pendingLaunch;
  if (pending && pendingMatchesMarkerAndFolder(pending, marker, folder)) {
    await startExactPendingLaunchSingleFlight(context, marker, secret, pending);
    return;
  }

  if (pending) {
    // Secret says a fresh launch exists but the marker/folder identity does not match.
    // This is an integrity failure, not an old-session reconnect case.
    failClosedAndOfferDiagnostics();
    return;
  }

  // Existing marker + credentials but no pending intent = old/established session.
  await offerManualSavedSessionReconnect(context, marker);
}
```

### Important

A valid pending launch should **not have an age-based auto-resume cutoff**. The explicit Start/Join is already the consent. Waiting one hour does not turn it into an unrelated old session.

If product UX wants to warn after a long delay, show a warning **without invalidating the pending identity**.

---

# 6. Cross-window single-flight: filesystem startup lease

A module-level `workspaceSessionRestore` promise only protects one extension host. It does not protect two VS Code windows opening the same session working folder.

Use a small local lock file created atomically with exclusive create (`open(..., 'wx')`) after Trust:

```text
.pair-notebook-start.lock
```

Suggested contents:

```json
{
  "version": 1,
  "launchId": "...",
  "attemptId": "...",
  "acquiredAt": 1788912345678
}
```

Rules:

1. Acquire only after workspace is trusted and pending identity has been verified.
2. `wx` / exclusive-create means only one process wins.
3. If another non-stale lock exists, do not start a second runtime.
4. If the extension host crashes, the file is allowed to become stale.
5. A stale lock may be removed after a bounded lease (for example 120 seconds) and acquisition retried.
6. Removing a stale lock is race-safe because the next exclusive create still has one winner.
7. Delete the lock in `finally` on normal success/failure.
8. The lock is **not** the durable launch intent. Losing it never loses the session.

Keep the module-level promise as an additional same-process guard, but stop surfacing "existing session is still restoring" as a normal user error.

---

# 7. Workspace Trust manifest strategy

## 7.1 Safe default: `supported: false`

For a security-sensitive extension that synchronizes files and runs Python, the cleanest default is:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": false,
    "description": "Pair Notebook remains disabled until this isolated session folder is trusted. An explicit pending Start/Join is persisted and resumes after Trust."
  }
}
```

This exactly matches the user's observed VS Code behavior: the extension disappears in Restricted Mode and returns after Trust.

The startup architecture must intentionally support that behavior.

## 7.2 If `limited` is retained, it is only a UX optimization

If the project keeps `supported: "limited"`, correctness still must not depend on it because users can override untrusted-workspace support.

In limited mode:

- do not create `SessionRuntime`;
- do not open signalling sockets;
- do not run CRDT sync;
- do not run Python;
- do not consume/clear `pendingLaunch`;
- optionally show only an "Awaiting Workspace Trust" view;
- `onDidGrantWorkspaceTrust` may call the same reconciliation function as a fast path.

## 7.3 Audit `activate()` ordering under limited mode

Current `activate()` calls `applyMeshNetworkConfiguration()` before the Trust-specific restore logic. If limited mode remains, move untrusted activation into a deliberately minimal branch so the extension does not perform unnecessary proxy/SecretStorage migration/network configuration work before Trust.

Pseudo-structure:

```ts
activate(context) {
  register safe UI / output;

  if (!vscode.workspace.isTrusted) {
    register trust-only UI;
    onDidGrantWorkspaceTrust(() => reconcile...);
    return;
  }

  initialize trusted-only network/config/runtime integrations;
  reconcileSessionWorkspaceOnActivation(context);
}
```

With `supported: false`, VS Code enforces this boundary for us.

---

# 8. Activation after Trust must be a release-tested contract

Current activation events include:

```json
[
  "onView:pairNotebook.dashboard",
  "workspaceContains:.pair-notebook-session.json"
]
```

When the exact session working folder becomes trusted, the marker is already present. That should provide a natural activation reason. VS Code's Trust enablement test plan confirms extensions disabled by Trust become enabled after Trust.

However, because "re-enabled" and "our exact activation sequence fired correctly" are distinct implementation details, **do not treat static reasoning as sufficient**.

Release acceptance must prove on installed VSIX:

```text
Start
 -> target folder opens Restricted Mode
 -> Pair Notebook disabled
 -> wait
 -> click Trust
 -> Pair Notebook activates automatically
 -> exact pending launch starts without another Start/Join click
```

This is mandatory because the current automated E2E disables Workspace Trust and cannot prove it.

---

# 9. Startup commit point

A fresh pending launch becomes an established session only after all local bindings needed for normal operation exist.

Suggested commit criteria:

```text
SessionRuntime local state prepared
+ transport state classified (ready or retryable offline state)
+ EditorSynchronizer bound
+ PresenceRenderer bound
+ NotebookController bound
+ terminal handlers installed
+ session context keys set consistently
```

Then:

```text
1. persist descriptor with freshStart=false where applicable
2. clear pendingLaunch from SecretStorage
3. add/update Recent Session
4. remove pending-launch index entry
5. release startup lock
```

Order matters: clear the authoritative pending intent only when enough state exists that a later activation can safely treat this as an established saved session.

If commit step 2 succeeds but Recent indexing fails, the session is still established; repair the index later. Recent UI is not the source of truth.

---

# 10. Network startup must stop being terminal for transient availability

## 10.1 Separate local preparation from network availability

Current startup couples:

```text
local project preparation
+
transport construction
+
emergency relay readiness
```

into one `SessionRuntime.start()` success/failure result.

Split the concepts:

```text
LOCAL_READY      = project/storage/handlers are valid locally
NETWORK_READY    = at least one usable discovery/data route family is available
HOST_READY       = guest has authenticated host route and current project state
```

A transient failure of NETWORK_READY must not destroy LOCAL_READY.

## 10.2 Typed startup failures

Introduce explicit classification instead of throwing generic errors into one terminal path:

```ts
type StartupFailureKind =
  | 'local-fatal'
  | 'network-unavailable'
  | 'host-unavailable'
  | 'session-ended';
```

Examples:

### `local-fatal`

- malformed/invalid marker;
- missing required SecretStorage identity;
- invalid local project path;
- unsafe storage state;
- unrecoverable local filesystem failure.

### `network-unavailable`

- no Nostr signalling endpoint ready;
- no MQTT signalling endpoint ready;
- emergency relay families unavailable;
- VPN/proxy blocks sockets;
- temporary DNS/TCP/TLS failure.

### `host-unavailable`

- guest target was trusted long after bootstrap and host is currently offline;
- 45 second initial-state wait expires;
- pinned host route is temporarily absent before first active commit.

### `session-ended`

- authenticated termination evidence proves the session ended.

Only `local-fatal` and authenticated `session-ended` are terminal for automatic retry semantics.

## 10.3 `MeshTransport.start()` should return readiness information for availability failures

Do not make "no emergency relay family ready within 15 seconds" equivalent to corrupt session state.

Preferred contract:

```ts
interface TransportStartResult {
  state: 'ready' | 'degraded' | 'unavailable';
  signallingFamilies: string[];
  emergencyRelayReady: boolean;
  diagnostics: ...;
}
```

Configuration/invariant errors can still throw. Availability errors become a result/state.

## 10.4 Fresh host behavior with no network

For a host:

```text
local project loads successfully
 -> transport unavailable
 -> keep same SessionRuntime / descriptor / identity
 -> show NETWORK UNAVAILABLE
 -> retry in background and on explicit Reconnect
 -> network becomes ready
 -> transition to active
```

Do not call `disposeAsync('local-route-failed')` merely because public signalling/relay infrastructure is temporarily unreachable.

A session invite can be generated from the same session identity, but UI should clearly indicate whether the host is currently reachable.

## 10.5 Guest behavior after delayed Trust

For a guest whose snapshot bootstrap already succeeded:

```text
Trust after 1 hour
 -> exact pending guest identity starts
 -> host currently unavailable
 -> keep pending Join / isolated snapshot
 -> show WAITING FOR HOST / RETRY
 -> same peerId and keypair retry later
```

Do not make the 45 second initial-state timeout destroy the pending guest launch.

If authenticated termination is later observed, clear the pending intent and mark the session ended.

---

# 11. Retry scheduler

Use bounded exponential backoff with jitter for transient startup networking:

```text
1 s
2 s
5 s
10 s
20 s
30 s
30 s ...
```

Reset backoff when:

- network interface changes;
- proxy configuration changes;
- user presses Reconnect;
- at least one signalling family becomes ready.

Retry must be idempotent and reuse:

- session ID;
- token;
- peer identity key;
- host clock;
- working folder;
- CRDT local state.

Never implement retry by recursively calling Start Session / Join Session.

---

# 12. Pending Session vs Recent Session UI

Add a distinct lifecycle category.

## Pending Session

A Start/Join explicitly requested but not yet committed.

Suggested states:

- `Awaiting Workspace Trust`
- `Starting`
- `Network unavailable — retrying`
- `Waiting for Session Host`
- `Startup error — Retry / Cancel`

## Recent Session

A session that reached the established commit point at least once and was later left/disconnected.

This removes the current ambiguity where failed launches appear as if the user had previously participated and left.

Do not display one pending attempt as repeated `project_test` cards.

---

# 13. Explicit Cancel semantics

Add **Cancel Pending Session** for a launch that never committed.

It must target the exact `(sessionId, peerId, workingFolder)` and:

1. stop any retry loop;
2. remove pending-launch SecretStorage intent;
3. remove session credentials if the session never committed;
4. remove marker;
5. remove pending index entry;
6. remove accidental Recent entry for that exact launch if migration left one;
7. optionally remove the isolated working copy after explicit user confirmation.

Never delete a working copy of another peer/session.

---

# 14. Terminal session-ended while pending

A long Trust delay creates a real edge case: the host may end the session before the guest ever trusts the target folder.

Required behavior:

```text
pending guest launch
 -> later Trust
 -> attempt exact same host/session
 -> authenticated termination evidence received
 -> classify session-ended
 -> clear pending intent and credentials
 -> keep local working copy if useful
 -> tell user session was ended by host
```

Do not silently generate a new Join or ask the user to reuse a stale invite.

A simple host timeout is **not** termination evidence.

---

# 15. System suspend/watchdog interaction

The `0.5.25`/`0.5.26` readiness guard around the suspend watchdog is conceptually correct: a startup/Trust delay must never be mistaken for a suspended active session.

Keep the invariant:

```text
watchdog can leave only the same runtime
that was already observed as an established/ready runtime
on both sides of the timer gap
```

Do not arm it for:

- awaiting Trust;
- pending local startup;
- fresh host network-unavailable before commit;
- pending guest waiting for initial host state.

After session commit, existing suspend/recent semantics can remain.

---

# 16. Security model for automatic post-Trust resume

Automatic resume after Trust is safe only because it is backed by extension-owned secret state.

Required validation before any network starts:

```text
workspace is trusted
AND marker parses and normalizes safely
AND actual workspace path equals expected working folder
AND SecretStorage exists for marker sessionId + peerId
AND SecretStorage contains pendingLaunch
AND immutable descriptor digest matches
AND local public identity matches stored private key
AND session has no authenticated terminal marker
AND startup lock acquired
```

If any check fails:

```text
NO automatic network activity
NO fallback to "probably the same session"
NO creation of a replacement identity
```

Show diagnostics/manual recovery instead.

This is stronger than binding to `VSCODE_PID` because it validates the actual durable session identity rather than the editor process that happens to be running it.

---

# 17. Tests required before implementation is considered complete

## 17.1 Pure unit tests: durable launch identity

At minimum:

1. v1 session secret still decodes.
2. v2 pending Start secret decodes.
3. v2 pending Join secret decodes.
4. pending digest matches exact descriptor identity.
5. sessionId mismatch rejected.
6. projectId mismatch rejected.
7. peerId mismatch rejected.
8. identity public-key mismatch rejected.
9. hostPeerId mismatch rejected.
10. working-folder mismatch rejected.
11. path case normalization is correct on Windows.
12. symlink/junction substitution is rejected where supported.
13. mutable descriptor fields do not change immutable digest.
14. pending launch does not expire after simulated 1 hour.
15. pending launch does not expire after simulated multi-day clock advance.
16. clock moves backwards without invalidating identity.
17. clearing pending intent preserves token/private key.
18. old established secret has no auto-resume intent.
19. malformed pending record fails closed.
20. missing secret fails closed.

## 17.2 Transaction/crash tests

Simulate process death after every write step listed in the crash matrix and assert the next activation outcome.

Especially:

- crash after secret before marker;
- crash after marker before `openFolder`;
- target activation before Trust;
- extension-host reset while awaiting Trust;
- crash after Trust after startup-lock acquisition;
- crash after runtime ready before pending intent clear;
- crash after intent clear before Recent index update.

## 17.3 Multi-window tests

- two independent pending launches do not overwrite each other;
- two windows opening the same pending folder produce one startup winner;
- stale startup lock recovers;
- live startup lock blocks duplicate runtime;
- unrelated workspace cannot consume another pending launch.

## 17.4 Network classification tests

- both emergency relay families unavailable => `network-unavailable`, not terminal destruction;
- one family available => startup proceeds degraded/ready;
- network returns later => same runtime/session identity transitions ready;
- proxy/VPN change wakes retry;
- guest initial-state 45s timeout => `host-unavailable`, same pending identity preserved;
- host returns later => same guest identity completes startup;
- authenticated session-ended => terminal cleanup.

## 17.5 Existing sync regression suite

All existing text/notebook/output/execution tests must remain green without altering their expected protocol semantics.

---

# 18. Real Workspace Trust E2E / acceptance gate

The current `--disable-workspace-trust` run stays useful as a trusted baseline, but it is not a Trust test.

Add a separate Trust test lane as far as VS Code tooling permits, following the official recommendation for separate trusted/untrusted runs:

https://code.visualstudio.com/api/working-with-extensions/testing-extension#testing-workspace-trust-behavior

Because a normal extension test cannot grant Trust programmatically, an **installed-VSIX GUI acceptance** remains release-blocking until a reliable external UI automation harness exists.

Required physical/GUI cases:

### T-A — delayed Trust, host

1. clean VS Code user profile;
2. install candidate VSIX;
3. open trusted source project;
4. Start Session;
5. target isolated folder opens Restricted Mode;
6. verify Pair Notebook is disabled/limited and no session network is active;
7. wait at least 60 seconds in the fast acceptance run; also test a synthetic pending age >1 hour;
8. press Trust;
9. verify extension returns automatically;
10. verify same `sessionId/peerId` becomes active without another Start click.

### T-B — close/reopen before Trust

1. reach untrusted target folder;
2. close VS Code completely;
3. reopen the exact target folder;
4. Trust it;
5. same pending launch resumes.

### T-C — extension-host/window reload before Trust

Same expected outcome.

### T-D — network unavailable after Trust

1. Trust target while VPN/network route is unavailable;
2. verify pending session is retained, not converted to Recent and not assigned a new ID;
3. restore network;
4. verify automatic retry reaches active state with same ID.

### T-E — delayed guest Trust

1. complete snapshot bootstrap;
2. leave guest target untrusted;
3. temporarily stop host;
4. Trust guest target;
5. verify WAITING FOR HOST, no new peer identity;
6. restore host;
7. same guest completes session.

### T-F — old marker

Open a previously established session folder with no pending secret intent. It must not auto-connect merely because the folder is trusted.

### T-G — copied/tampered marker

No automatic route.

---

# 19. Files expected to change

Primary:

- `package.json`
- `src/extension.ts`
- `src/core/manualSessionRestore.ts` or replacement `src/core/pendingSessionLaunch.ts`
- session-secret encode/decode helpers (prefer extracting them from `extension.ts`)
- `src/runtime/session.ts`
- `src/runtime/mesh.ts`
- `src/vscode/dashboard.ts`
- tests and E2E harness

Likely useful new modules:

```text
src/core/sessionSecret.ts
src/core/pendingSessionLaunch.ts
src/core/startupLease.ts
```

This reduces the amount of lifecycle state hidden inside the already large `extension.ts`.

---

# 20. Files/semantics that must not be changed without a separate proven defect

Do not opportunistically rewrite:

- `src/core/crdt.ts` local-first ownership;
- protocol v7 wire compatibility;
- Yjs text update rules;
- notebook stable-cell identity;
- output/execution synchronization;
- text projection quarantine model;
- host authority/election semantics.

The current failure happens before normal collaboration startup and must be repaired at the lifecycle/transport boundary.

---

# 21. Implementation order

Do this as a controlled sequence, not as another patch chain.

## Phase 1 — tests first

Add failing tests for:

- durable pending intent surviving process reset;
- no expiry after one hour;
- marker/secret digest binding;
- multi-window lock;
- no early Recent Session;
- network-unavailable retry;
- guest host-unavailable retry.

Do not touch sync semantics.

## Phase 2 — durable intent

- introduce session-secret v2;
- put pending launch in SecretStorage;
- stop using process identity as authorization;
- make global pending state index-only;
- persist before `openFolder`.

## Phase 3 — activation reconciliation

- stop claim-and-delete before Trust;
- reconcile only after trusted activation;
- add startup lock;
- consume pending intent only at commit.

## Phase 4 — lifecycle/UI cleanup

- Pending Sessions separate from Recent Sessions;
- Retry / Cancel;
- remove normal user exposure of `still restoring`.

## Phase 5 — transport retryability

- typed availability failures;
- non-terminal fresh-host network outage;
- non-terminal guest initial-host timeout;
- retry scheduler.

## Phase 6 — Trust release gate

Run installed VSIX cases T-A through T-G on Windows, then physical two-computer collaboration acceptance.

Only after these pass should a new stable release be tagged.

---

# 22. Final acceptance definition

The startup repair is complete only when all of the following are true simultaneously:

```text
Start/Join explicit intent is durable
AND openFolder may kill the old extension host
AND Restricted Mode may disable Pair Notebook completely
AND the user may wait >1 hour
AND VS Code may restart before Trust
AND Trust later reactivates the exact pending launch
AND no stale marker auto-connects
AND no duplicate local runtime can start
AND transient network failure preserves the same identity
AND failed fresh attempts do not pollute Recent Sessions
AND old established sessions remain manual-only
AND protocol-v7 sync behavior is unchanged
AND installed-VSIX Trust acceptance passes
AND physical two-computer sync acceptance passes
```

The key architectural change is:

```text
BEFORE (0.5.26)
explicit Start/Join
 -> global pending record
 -> openFolder
 -> claim/delete durable record
 -> RAM-only state while waiting for Trust
 -> fragile restore

AFTER
explicit Start/Join
 -> SecretStorage-attested pending intent + atomic marker
 -> openFolder as hard process boundary
 -> zero required Pair Notebook execution while untrusted
 -> arbitrary Trust delay / restart
 -> trusted activation verifies marker + secret intent
 -> single-flight startup
 -> retry transient network/host absence under same identity
 -> commit once
 -> clear pending intent
 -> only then become Recent/established session
```

That state machine removes the timing dependency that caused the `0.5.24`–`0.5.26` repair chain instead of adding another timing-specific workaround.
