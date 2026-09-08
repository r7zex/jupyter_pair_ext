# Pair Notebook: durable session start across Workspace Trust and transient network failure

Date: 2026-09-09

Status: implementation plan based on the current `main` / `v0.5.26` code path and the observed installed-VSIX failure.

## Goal

Make **Start Session** and **Join Session** deterministic even when the isolated Pair Notebook working folder opens in VS Code Restricted Mode and Pair Notebook is completely disabled there for an arbitrary amount of time.

Required behavior:

1. User starts or joins from a trusted workspace.
2. Pair Notebook creates/downloads the isolated working copy and persists all local session state needed to continue.
3. `vscode.openFolder()` opens the isolated working folder.
4. If VS Code marks that folder untrusted, Pair Notebook may be completely disabled. This must be treated as a normal lifecycle state, not as an error.
5. The user may wait **at least one hour** before pressing **Trust**.
6. After Trust, Pair Notebook activates again, recognizes the exact unfinished Start/Join operation, and continues that same session automatically. It must not create a second session, show a stale-session reconnect prompt, or lose the requested launch.
7. A transient network/VPN/proxy/relay outage must not destroy a freshly created host session or convert it into a dead Recent Session. The same session must remain retryable.
8. Existing protocol-v7 CRDT/text/notebook synchronization semantics must remain unchanged.

The implementation must be correct even if Pair Notebook does **not execute at all** while the target workspace is untrusted.

---

# 1. Verified facts from the current repository

## 1.1 `v0.5.23` worked by relying on durable state and post-Trust activation

In `v0.5.23`, `package.json` declared:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": false
  }
}
```

and activation unconditionally called `startWorkspaceSessionRestore(context)`. Start/Join saved the descriptor and then opened the isolated working folder.

This meant Restricted Mode could disable Pair Notebook, but after the user granted Trust, normal extension activation could read the persisted marker/SecretStorage state and restore the session.

Reference:

- `v0.5.23/package.json`
- `v0.5.23/src/extension.ts`

## 1.2 The regression starts in `0.5.24`

The current repository's own `SESSION_LIFECYCLE_ROOT_CAUSE_REPORT.md` identifies `v0.5.23` as the baseline and documents the post-release `0.5.24` regression: Start/Join opened the isolated folder, but the new lifecycle rules no longer preserved the explicit Start/Join intent correctly across the folder/trust transition.

`0.5.25` then attempted an in-memory/`vscode.env.sessionId` handoff, which was also insufficient.

## 1.3 `0.5.26` still depends on an in-memory claim during the Trust interval

Current flow:

```text
startSession()/joinSession()
  -> saveDescriptor(...)
  -> rememberProject(...)
  -> openSessionWorkingFolder(...)
  -> write PENDING_SESSION_LAUNCH_KEY
  -> vscode.openFolder(...)

new target-folder activation
  -> offerWorkspaceSessionRestore(...)
  -> claimPendingSessionLaunch(...)
  -> DELETE PENDING_SESSION_LAUNCH_KEY
  -> keep `claimedLaunch` only in extension-host memory
  -> wait for vscode.workspace.isTrusted / onDidGrantWorkspaceTrust
  -> startWorkspaceSessionRestore(...)
```

The critical flaw is the transition:

```text
durable globalState record
       ↓ deleted before Trust
in-memory claimedLaunch
```

If the extension is disabled, unloaded, restarted, or its extension host is replaced before Trust, the only automatic-launch evidence is gone.

This is incompatible with the required behavior "Trust may be granted an hour later".

Relevant current files:

- `src/extension.ts`
- `src/core/manualSessionRestore.ts`
- `WORKSPACE_TRUST_SESSION_START_ROOT_CAUSE.md`

## 1.4 Current `manualSessionRestore.ts` uses undocumented process environment as correctness state

`currentEditorProcessIdentity()` hashes `VSCODE_PID` plus `VSCODE_IPC_HOOK`/`VSCODE_IPC_HOOK_CLI`.

Those process environment variables are not the public Workspace Trust API. They may be useful diagnostics, but session-start correctness should not depend on them.

VS Code publicly documents `vscode.env.sessionId`, but only guarantees that it identifies the current editor session and changes when the editor is started. It is not a durable launch transaction identifier.

Reference: VS Code API `env.sessionId` documentation:

https://code.visualstudio.com/api/references/vscode-api

## 1.5 Current E2E cannot catch the real Trust regression

`scripts/run-vscode-e2e.mjs` launches VS Code with:

```text
--disable-workspace-trust
```

Therefore the real Start -> `openFolder` -> Restricted Mode -> disabled extension -> delayed Trust -> reactivation path is excluded from the existing E2E environment.

This explains why Extension Host E2E can pass while the installed VSIX still fails at the Trust boundary.

VS Code's official testing documentation explicitly says trusted and untrusted Workspace Trust behavior must be tested separately; trust cannot be programmatically granted/revoked from a normal extension test.

References:

- `scripts/run-vscode-e2e.mjs`
- https://code.visualstudio.com/api/working-with-extensions/testing-extension

## 1.6 `local-route-failed` is a second, independent startup problem

The visible warning

```text
Pair Notebook: локальный сетевой маршрут не удалось запустить...
```

comes from this exact boundary:

```text
restoreWorkspaceSession()
  -> SessionRuntime.start()
  -> MeshTransport.start()
  -> throw
  -> disposeAsync('local-route-failed')
```

This is not a CRDT/editor synchronization failure.

`MeshTransport.start()` currently awaits `startRelayFallback()`, and `startRelayFallback()` awaits `RedundantFrameRelay.waitUntilReady(15_000)`. If neither emergency relay family becomes ready, startup throws and the entire fresh runtime becomes terminal.

Relevant files:

- `src/runtime/session.ts`
- `src/runtime/mesh.ts`
- `src/runtime/redundantFrameRelay.ts`

## 1.7 Failed fresh launches are persisted too early

`startSession()` currently calls `rememberProject(context, descriptor)` **before** the newly opened target workspace has successfully restored and before `SessionRuntime.start()` has reached ready state.

Therefore a fresh session that never successfully starts can still appear in Recent Sessions and leave behind marker/SecretStorage/working-copy state. Repeating Start creates multiple dead-looking entries.

This is a lifecycle bug, not expected history behavior.

---

# 2. Workspace Trust contract to design against

Official VS Code Workspace Trust behavior:

- `untrustedWorkspaces.supported: false` means the extension remains disabled until Trust is granted.
- `untrustedWorkspaces.supported: "limited"` means the extension may remain active with limited functionality.
- users can override an extension's untrusted-workspace support level with `extensions.supportUntrustedWorkspaces`.
- users may leave a workspace in Restricted Mode and trust it later.
- `vscode.workspace.isTrusted` and `vscode.workspace.onDidGrantWorkspaceTrust` are available to extensions that are actually running.

Reference:

https://code.visualstudio.com/api/extension-guides/workspace-trust

Therefore **correctness must not depend on `onDidGrantWorkspaceTrust` firing**. The extension may be completely disabled while untrusted, either by its own manifest or by a user's override.

The durable state written before `vscode.openFolder()` must be sufficient for a later trusted activation to resume the exact requested launch.

---

# 3. Target architecture

## 3.1 Core rule

Treat Workspace Trust as a process boundary:

```text
trusted source activation
      |
      | persist complete, non-secret launch transaction
      v
vscode.openFolder(target)
      |
      | extension may disappear completely for minutes/hours
      v
Restricted Mode
      |
      | user grants Trust whenever they choose
      v
fresh trusted extension activation
      |
      | re-read durable launch transaction
      v
continue exact Start/Join once
```

No correctness state may exist only in memory between `openFolder()` and Trust.

## 3.2 Recommended manifest behavior

For maximum determinism and minimum security surface, use:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": false,
    "description": "Pair Notebook starts networking, project synchronization and Python execution only after this isolated session folder is trusted. A pending Start/Join is preserved while Restricted Mode is active."
  }
}
```

This intentionally accepts that Pair Notebook disappears in Restricted Mode. That is safe and is exactly the state the implementation must survive.

If product UX later prefers `"limited"`, that can be kept as an optional enhancement, but the startup state machine must behave identically if VS Code or a user override disables the extension completely.

Do **not** use limited-mode in-memory listeners as the only continuation mechanism.

---

# 4. Durable pending-launch transaction

Replace the current one-record, process-identity-bound `PendingSessionLaunch v2` with a durable `v3` transaction that survives extension-host death and long Trust delays.

Suggested shape:

```ts
export interface PendingSessionLaunchV3 {
  version: 3;
  launchId: string;
  kind: 'start' | 'join';
  sessionId: string;
  projectId: string;
  peerId: string;
  workingFolder: string;
  descriptorDigest: string;
  createdAt: number;
  autoResumeUntil: number;
  lastAttemptAt?: number;
  lastFailure?: 'network' | 'startup';
}
```

Properties:

- `launchId`: cryptographically random non-secret ID generated specifically for this Start/Join transaction.
- `kind`: distinguishes host Start from guest Join.
- `sessionId`, `projectId`, `peerId`, `workingFolder`: exact binding to the target marker.
- `descriptorDigest`: SHA-256 of a canonical non-secret descriptor subset. This prevents an unrelated or modified marker from consuming a pending launch.
- `createdAt`: diagnostics and cleanup.
- `autoResumeUntil`: at least 24 hours after creation. This guarantees a one-hour Trust delay while bounding surprising auto-start of forgotten state.
- no session token or private identity key in globalState. Secrets remain only in VS Code SecretStorage.

Store pending launches as a **bounded map/list**, not one global singleton, so two VS Code windows cannot overwrite each other's launches.

Suggested key:

```text
pairNotebook.pendingSessionLaunch.v3
```

with maximum 16 records and deterministic stale cleanup.

## 4.1 Do not bind correctness to `VSCODE_PID`, IPC hook, or `vscode.env.sessionId`

Those values may be retained in diagnostics, but they must not determine whether a valid delayed Trust can continue the launch.

The correctness binding is:

```text
exact working folder
+ exact sessionId
+ exact projectId
+ exact peerId
+ exact descriptor digest
+ matching SecretStorage credentials
```

That is sufficient to prove this activation belongs to the pending local Start/Join transaction.

## 4.2 Persist in the correct order

For host Start:

```text
1. validate trusted source workspace
2. choose backing folder
3. create isolated working copy
4. create descriptor + SecretStorage credentials
5. write .pair-notebook-session.json
6. write durable PendingSessionLaunchV3
7. ONLY NOW call vscode.openFolder(target)
```

For guest Join:

```text
1. validate trusted source workspace
2. parse invite and bootstrap snapshot
3. create descriptor + SecretStorage credentials
4. write .pair-notebook-session.json
5. write durable PendingSessionLaunchV3
6. ONLY NOW call vscode.openFolder(target)
```

If step 6 fails, do not open the target folder. Roll back the fresh local session artifacts.

If `vscode.openFolder()` itself throws, remove the pending launch and roll back the fresh launch or offer an explicit retry.

---

# 5. Trusted activation algorithm

Replace `offerWorkspaceSessionRestore()` / `claimPendingSessionLaunch()` semantics with activation-time reconciliation.

Pseudo-code:

```ts
async function reconcileWorkspaceSessionOnActivation(context) {
  const folder = currentWorkspaceFolder();
  if (!folder) return;

  const marker = await readMarkerIfPresent(folder);
  if (!marker) return;

  // If Pair Notebook happens to be running in limited Restricted Mode,
  // do nothing except wait. NEVER consume durable launch state here.
  if (!vscode.workspace.isTrusted) return;

  const pending = await findExactPendingLaunch(context, marker, folder);

  if (pending && pending.autoResumeUntil >= Date.now()) {
    await continuePendingLaunch(context, pending, marker);
    return;
  }

  if (pending) {
    // Expired pending launches are not silently destroyed. Require one fresh
    // confirmation, then continue the same session if credentials still match.
    await offerExpiredPendingLaunchResume(context, pending, marker);
    return;
  }

  // Marker with no matching pending launch is an old/recent session.
  // It stays manual-only.
  await offerManualSavedSessionReconnect(context, marker);
}
```

Important invariants:

- never delete a valid pending launch because the workspace is untrusted;
- never convert the pending launch to an in-memory-only claim;
- never start networking while `workspace.isTrusted === false`;
- never auto-resume a marker that lacks an exact pending transaction;
- never let an unrelated old marker consume a pending transaction;
- never create a second session ID when continuing the pending launch.

## 5.1 Consume pending state only after successful startup

Current `0.5.26` deletes the durable record too early.

New rule:

```text
pending launch exists
   -> restore exact existing descriptor
   -> SessionRuntime.start()
   -> bind synchronizer/controller/presence
   -> runtime reaches usable state
   -> remember Recent Session
   -> remove pending launch
```

If the extension host crashes halfway through startup, the pending launch remains recoverable.

Use an idempotent startup lease only to prevent duplicate simultaneous attempts; do not use the lease as the durable intent itself.

A lease can be short-lived, for example 120 seconds:

```ts
{
  launchId,
  attemptId,
  startedAt
}
```

If the process dies, the lease expires and the same durable launch may retry.

---

# 6. Remove the `still restoring` dead-end from user flow

`workspaceSessionRestore` should protect only an **actual trusted startup attempt**, not the whole Trust waiting period.

Rules:

1. While untrusted: no restore promise exists.
2. After trusted activation: create one startup promise for the exact pending session.
3. The dashboard Start/Join buttons should be disabled while that promise is active instead of allowing a click that throws:

```text
The existing Pair Notebook workspace session is still restoring...
```

4. The promise must always clear in `finally`.
5. A failed startup must transition to a specific retryable UI state, not leave the window appearing permanently busy.

The internal guard may remain, but it should be an invariant assertion, not a normal user-visible error path.

---

# 7. Fresh launch vs Recent Session lifecycle

Do not call `rememberProject()` before the first successful runtime startup.

New lifecycle:

```text
fresh launch requested
  -> pending launch store
  -> target folder / Trust
  -> runtime starting
  -> SUCCESS
      -> rememberProject(...)
      -> remove pending launch

  -> FAILURE BEFORE READY
      -> do NOT create normal Recent Session history
      -> keep one Pending Session transaction
      -> offer Retry / Cancel
```

This prevents repeated failed attempts from creating many identical `project_test` cards.

For an already established session that later disconnects, current Recent Session semantics may remain unchanged.

## 7.1 Cancel pending launch

Add an explicit cleanup path for a fresh session that never became ready:

```text
Cancel Pending Session
```

It should:

- remove the durable pending launch;
- remove its SecretStorage credentials;
- remove the marker;
- remove any accidental Recent Session entry for that exact fresh launch;
- optionally delete the isolated working copy after explicit confirmation;
- never affect another session.

---

# 8. Network startup must be retryable, not terminal

The Trust fix alone is insufficient because current startup can still terminate on transient relay/network readiness.

## 8.1 Current problematic behavior

Current `MeshTransport.start()`:

```text
create primary Trystero room
  -> await startRelayFallback()
       -> RedundantFrameRelay.waitUntilReady(15s)
            -> both Nostr/MQTT emergency families fail
                 -> throw
  -> SessionRuntime marks local-route-failed terminal
```

A temporary VPN/proxy/public-relay problem therefore destroys a fresh host runtime even though the local project/session identity is valid.

## 8.2 Required behavior

Separate **session creation** from **external network reachability**.

For a host:

```text
local session created
project loaded
credentials valid
transport objects initialized
        ↓
network currently unavailable?
        ↓ yes
runtime state = network-unavailable / reconnecting
same session remains alive
background retry continues
        ↓
network becomes available
        ↓
ready for peers
```

Do not create a new session ID for retries.

## 8.3 Concrete transport change

`MeshTransport.start()` should not make emergency relay readiness a fatal requirement when the failure is transient.

Recommended split:

```ts
await initializeTransportObjects();
startTransportTimersAndWatcher();
void ensureSignallingAndRelayReadinessWithRetry();
```

or return structured startup status:

```ts
interface MeshStartupResult {
  initialized: true;
  readyFamilies: Array<'nostr' | 'mqtt' | 'relay-nostr' | 'relay-mqtt'>;
  degraded: boolean;
}
```

External reachability errors should be recorded in diagnostics and retried with bounded backoff, for example:

```text
1s -> 2s -> 5s -> 10s -> 30s -> 30s ...
```

A terminal `local-route-failed` should be reserved for truly unrecoverable local initialization errors such as invalid cryptographic/session configuration or impossible internal state, not a temporary public relay outage.

## 8.4 Runtime/UI state

Add an explicit state such as:

```text
network-unavailable
```

or reuse `reconnecting` with a precise detail string.

The host dashboard should say that the session exists locally and is waiting for network reachability. `Reconnect` should retry the same runtime/session.

Do not label this as "host lost" for the host's own fresh startup.

## 8.5 Guest Join

Guest snapshot bootstrap genuinely needs a route to the host. It may remain network-blocking, but it must be retryable without losing the invite-derived pending intent.

If snapshot download fails transiently:

- keep the same Join transaction and local identity;
- offer Retry;
- do not create a fake Recent Session;
- do not require the user to paste a new invite unless the host explicitly ended/revoked the session.

---

# 9. Do not change normal synchronization while fixing startup

This repair should be scoped to startup/lifecycle/network-readiness code.

Unless a new failing test proves otherwise, do not modify:

- protocol v7 semantics;
- `src/core/crdt.ts`;
- Yjs local-first text ownership;
- notebook cell stable-ID synchronization;
- output/execution synchronization;
- text projection rules in `src/vscode/sync.ts`.

Likely production files to modify:

```text
package.json
src/extension.ts
src/core/manualSessionRestore.ts   (or replace with pendingSessionLaunch.ts)
src/core/recentProjects.ts         (only if needed to separate Pending vs Recent)
src/runtime/mesh.ts
src/runtime/session.ts
src/vscode/dashboard.ts            (pending/network UI only)
```

Normal collaboration logic should remain untouched.

---

# 10. Tests that must exist before release

## 10.1 Pure pending-launch state-machine tests

Required automated cases:

1. pending Start survives 1 minute;
2. pending Start survives **2 hours** of simulated time;
3. pending Join survives 2 hours;
4. pending state survives extension module disposal/reactivation;
5. untrusted activation does not consume/delete pending state;
6. trusted activation with exact marker resumes automatically;
7. wrong session ID cannot consume pending launch;
8. wrong project ID cannot consume pending launch;
9. wrong peer ID cannot consume pending launch;
10. wrong working folder cannot consume pending launch;
11. modified descriptor digest cannot consume pending launch;
12. missing SecretStorage credentials cannot auto-start;
13. old marker with no pending launch remains manual-only;
14. successful startup removes pending launch exactly once;
15. startup exception keeps the same pending launch retryable;
16. expired auto-resume window requires confirmation instead of silently starting;
17. no pending-launch record contains token/private key;
18. multiple simultaneous pending launches do not overwrite each other;
19. Cancel removes only the selected pending launch;
20. retry reuses the same sessionId/projectId/peerId.

Use an injectable clock. Do not make CI literally sleep for an hour.

## 10.2 Fresh-launch lifecycle tests

Required:

- `rememberProject()` is not called before runtime success;
- failed fresh host startup produces no normal Recent Session card;
- repeated Retry does not create duplicate Recent Sessions;
- successful Retry creates exactly one Recent Session;
- terminal remote `session-ended` still clears reconnect credentials correctly;
- explicit Leave after a successfully established session keeps current semantics.

## 10.3 Network startup tests

Required:

- both emergency relay families unavailable at first -> host session remains retryable, not terminal;
- network becomes available later -> same session reaches ready state;
- one relay family available -> startup works;
- primary signalling unavailable but fallback later recovers -> same session works;
- VPN/proxy configuration refresh does not recreate session identity;
- unrecoverable local configuration error still produces a typed terminal failure;
- no text/CRDT sync tests regress.

## 10.4 Real VS Code Trust tests

Keep the existing E2E suite for normal trusted editor/runtime behavior, but it cannot be the Trust test because it uses `--disable-workspace-trust`.

Add a separate Trust acceptance track with Workspace Trust enabled and a fresh user-data directory.

At minimum, release acceptance must manually exercise the installed VSIX:

```text
A. start from trusted normal project
B. click Start Session
C. isolated folder opens in Restricted Mode
D. verify session/network does not start while untrusted
E. wait (manual test can be short; automated state-machine test covers 2h)
F. click Trust
G. verify same sessionId is resumed automatically
H. verify dashboard reaches active/ready or retryable-network state
I. verify exactly one Recent Session exists after success
J. connect a second physical computer
K. verify two-way notebook/text/output sync
```

Also run the same path with `extensions.supportUntrustedWorkspaces` forcing Pair Notebook unsupported, because VS Code allows the user to override extension Workspace Trust support. This proves correctness does not rely on limited-mode activation.

Official references:

- https://code.visualstudio.com/api/extension-guides/workspace-trust
- https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- https://code.visualstudio.com/api/working-with-extensions/testing-extension

---

# 11. Required release gates

Do not cut the next stable VSIX until all are true:

- [ ] Start Session survives a delayed Trust of at least 2 simulated hours.
- [ ] Join Session survives a delayed Trust of at least 2 simulated hours.
- [ ] Correctness works even when the extension is completely disabled during Restricted Mode.
- [ ] No pending launch is consumed before Trust.
- [ ] No launch correctness depends on `VSCODE_PID`, IPC hook, or extension-host memory.
- [ ] A successful launch produces exactly one Recent Session entry.
- [ ] A failed fresh launch does not produce duplicate Recent Session cards.
- [ ] A temporary network/relay outage does not terminally destroy a fresh host session.
- [ ] Retry uses the same session identity.
- [ ] Existing protocol-v7 sync tests pass unchanged.
- [ ] Existing Extension Host E2E passes on Windows/Linux/macOS/minimum VS Code.
- [ ] Separate Workspace Trust acceptance passes with Workspace Trust enabled.
- [ ] Installed VSIX passes a physical two-computer Start -> Trust -> Join -> sync test.

---

# 12. Suggested implementation sequence

Implement in this order so failures remain attributable.

## Phase A — durable Trust handoff

1. Introduce `PendingSessionLaunchV3` and bounded persistent store.
2. Remove correctness dependency on process identity.
3. Write pending launch before `openFolder()`.
4. Do not delete pending launch while untrusted.
5. On trusted activation, exact-match and resume it.
6. Remove pending only after runtime startup succeeds.
7. Move `rememberProject()` after successful startup.
8. Add Pending Session cancel/retry paths.
9. Add 2-hour simulated delay tests.

Do not touch sync or mesh behavior in this phase.

## Phase B — transient network startup

1. Make relay/signalling reachability retryable instead of fresh-session terminal.
2. Add explicit degraded/network-unavailable runtime state.
3. Preserve the exact same session during retries.
4. Add failure -> network recovery tests.

Do not touch CRDT/text/notebook sync behavior.

## Phase C — Trust-specific acceptance

1. Add a Trust-specific test/acceptance workflow that does **not** pass `--disable-workspace-trust`.
2. Keep the existing E2E as the trusted baseline.
3. Record installed-VSIX Trust acceptance before release.
4. Run physical two-computer sync acceptance.

---

# 13. Expected final user flow

### Normal trusted target

```text
Start Session
  -> copy project
  -> open isolated folder
  -> trusted
  -> same pending transaction resumes
  -> runtime ready
```

### Target opens untrusted and user trusts immediately

```text
Start Session
  -> copy project
  -> persist pending launch
  -> open isolated folder
  -> Pair Notebook disabled
  -> Trust
  -> Pair Notebook activates
  -> exact pending launch found
  -> same session starts
```

### Target remains untrusted for one hour

```text
Start Session
  -> persist pending launch
  -> open isolated folder
  -> Restricted Mode for 60+ minutes
  -> no extension memory required
  -> Trust
  -> activation reads durable pending launch
  -> same session starts
```

### Network is unavailable after Trust

```text
Trust
  -> exact pending launch resumes
  -> local session remains valid
  -> network unavailable state
  -> user changes VPN/proxy or waits
  -> background/manual retry
  -> same session becomes reachable
```

No second session ID, no stale reconnect confusion, no duplicate Recent Session cards, and no changes to normal CRDT synchronization are required.

---

# Final design rule

The Start/Join action must be represented as a **durable transaction**, not as an extension-host promise or in-memory claim.

Workspace Trust may disable Pair Notebook for an arbitrary interval. That interval must be treated exactly like a process crash/restart boundary: after Trust, the extension reconstructs the launch solely from authenticated/persisted local state and continues the same session.

Only after the session has actually started successfully should that transaction become normal Recent Session history.
