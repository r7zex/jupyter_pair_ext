# Pair Notebook: deterministic Start/Join across Workspace Trust, process death, and network loss

Date: 2026-09-09

Status: **root-cause analysis + implementation specification** for current `main` / `v0.5.26`.

This document supersedes the earlier versions of this plan. It is intentionally stricter: it removes several assumptions that looked reasonable at first but are not strong enough for the required product behavior.

The target is not “make the current callback usually work”. The target is a recoverable launch transaction whose correctness does not depend on timing, one particular Extension Host process, Workspace Trust being granted quickly, or one public relay being online.

---

# 0. Product contract and guarantee boundary

Required user flow:

```text
trusted source workspace
    -> user presses Start Session / Join Session
    -> Pair Notebook prepares exactly one local session identity
    -> all recovery/authorization state is durably written
    -> vscode.openFolder(isolated working folder)
    -> old Extension Host may die immediately
    -> target may be Restricted / Untrusted
    -> Pair Notebook may be completely disabled
    -> user may wait an hour, several hours, or restart VS Code
    -> user eventually grants Trust
    -> Pair Notebook activates in that exact folder
    -> it resumes the SAME requested launch automatically
    -> no second sessionId / peerId / keypair / working folder
    -> no stale-session confirmation prompt
    -> transient network failure remains retryable under the same identity
```

For **Start Session (host)**, local session creation must not require any public signalling or relay service to be reachable. A host with a valid local project may become locally established in a `network-unavailable` state and recover connectivity later.

For **Join Session (guest)**, bootstrap snapshot reception must still succeed before the target launch is committed. After the target folder is trusted, the guest must preserve the same identity while waiting for authenticated current host state.

## What “guaranteed” means here

The implementation can guarantee the state-machine properties below under ordinary VS Code/OS/filesystem semantics:

- Extension Host termination/restart;
- delayed Workspace Trust;
- VS Code restart before Trust;
- duplicate window attempts;
- normal process crashes between documented persistence steps;
- transient VPN/proxy/DNS/Nostr/MQTT/WebRTC/TURN failures;
- retry under the same local session identity.

It must **not** claim impossible guarantees against physical disk corruption, OS credential-store corruption, hostile modification of VS Code’s own extension storage, or an unrecoverable machine failure.

A release claim also requires an **installed-VSIX Workspace Trust acceptance test**. Unit tests alone are not sufficient.

---

# 1. Evidence levels used in this document

To avoid mixing proved code facts with design inference:

- **VERIFIED** — follows directly from the current repository code or official VS Code documentation.
- **DESIGN REQUIREMENT** — required consequence of the product contract.
- **PROTOCOL LIMITATION** — current protocol does not contain enough information to guarantee a stronger behavior.
- **NEEDS LIVE LOG** — the exact production exception cannot be identified from static code alone.

The current screenshot’s exact inner network exception remains **NEEDS LIVE LOG** until the Pair Notebook Output line after `Session startup failed:` is captured. However, the startup/lifecycle defects below are independently **VERIFIED** and must be fixed even if the final inner network exception is different.

---

# 2. Version regression boundary

## 2.1 `v0.5.23` is the last known-good lifecycle baseline

`v0.5.23/package.json` declared:

```json
"untrustedWorkspaces": {
  "supported": false
}
```

and the target-folder activation restored a saved workspace session from durable marker + SecretStorage state.

That version had an over-eager old-session restore problem, but it had one useful property: a newly requested launch did not require an in-memory callback to survive Workspace Trust.

Repository evidence:

- `v0.5.23/package.json`
- `v0.5.23/src/extension.ts`
- [`SESSION_LIFECYCLE_ROOT_CAUSE_REPORT.md`](./SESSION_LIFECYCLE_ROOT_CAUSE_REPORT.md)

## 2.2 The regression starts in `0.5.24`

The repository’s own lifecycle report names `v0.5.23` as baseline and documents the post-release `0.5.24` startup regression. `0.5.25` then tried to preserve Start/Join intent through an editor-session identity, and `0.5.26` changed that again to a process-derived identity plus `limited` Workspace Trust support.

The root mistake across the repair chain is that two different cases were conflated:

```text
A. fresh explicit Start/Join already authorized by the user
B. old saved marker from an earlier established session
```

A must survive `openFolder` + Trust automatically. B must remain manual-only.

The correct discriminator must therefore be **durable, session-specific launch intent**, not extension activation itself and not an in-memory callback.

---

# 3. Exact current `0.5.26` Trust failure

## 3.1 Current write/restore path — VERIFIED

`startSession()` / `joinSession()` currently do:

```text
saveDescriptor(...)
rememberProject(...)
openSessionWorkingFolder(...)
```

`openSessionWorkingFolder()` then:

```ts
const editorProcessId = currentEditorProcessIdentity();
await context.globalState.update(
  PENDING_SESSION_LAUNCH_KEY,
  createPendingSessionLaunch(descriptor, editorProcessId),
);
await vscode.commands.executeCommand(
  'vscode.openFolder',
  vscode.Uri.file(descriptor.workingFolder),
  false,
);
```

Source: [`src/extension.ts`](./src/extension.ts), functions `startSession`, `joinSession`, `openSessionWorkingFolder`.

Target activation then calls `offerWorkspaceSessionRestore()` -> `claimPendingSessionLaunch()`.

`claimPendingSessionLaunch()`:

1. reads the global pending record;
2. validates process identity/path/marker;
3. **deletes `PENDING_SESSION_LAUNCH_KEY`;**
4. returns the pending record into local memory.

If the folder is untrusted, `offerWorkspaceSessionRestore()` keeps that returned value only inside the closure waiting for `onDidGrantWorkspaceTrust`.

Source: [`src/extension.ts`](./src/extension.ts), functions `offerWorkspaceSessionRestore`, `claimPendingSessionLaunch`.

So the actual state transition is:

```text
durable globalState intent
        -> DELETE
RAM-only claimedLaunch
        -> wait for Trust
```

That is incompatible with “the user can press Trust an hour later even if Pair Notebook was disabled/reloaded”.

## 3.2 `vscode.openFolder()` is itself a hard process boundary — VERIFIED

VS Code documents that same-window `vscode.openFolder` shuts down the current Extension Host and starts a new one for the new folder/workspace.

Official source:

- https://code.visualstudio.com/api/references/commands

Therefore the architecture must assume:

```text
all correctness state must be durable BEFORE openFolder
openFolder may be the last instruction the source Extension Host ever executes
```

This is true even if Workspace Trust never appears.

## 3.3 Process identity is not launch authorization — VERIFIED/DESIGN REQUIREMENT

Current `currentEditorProcessIdentity()` hashes `VSCODE_PID` with `VSCODE_IPC_HOOK` / `VSCODE_IPC_HOOK_CLI`.

Those are implementation environment values, not the public Workspace Trust contract. `vscode.env.sessionId` is also an editor-session identifier, not a durable Start/Join transaction identifier.

They may remain useful for diagnostics or liveness, but they must not decide whether a valid pending launch is authorized after a restart.

## 3.4 The single global pending key is a multi-window race — VERIFIED

Current code has one:

```text
pairNotebook.pendingSessionLaunch
```

Two VS Code windows starting different sessions can overwrite the same global pending record.

The natural namespace already exists:

```text
sessionId + localPeer.peerId
```

The authoritative pending intent must be stored with that exact session identity, not in one singleton.

---

# 4. The current “still restoring” error is a symptom, not a root cause

Current Start/Join rejects whenever module-level `workspaceSessionRestore` is set:

```text
The existing Pair Notebook workspace session is still restoring.
Wait for it to finish or report an error.
```

`startWorkspaceSessionRestore()` uses that Promise as an intra-Extension-Host single-flight guard.

Source: [`src/extension.ts`](./src/extension.ts).

That guard is valid as an internal assertion, but it cannot protect across:

- Extension Host replacement;
- two VS Code windows;
- Restricted Mode where the extension is disabled.

DESIGN REQUIREMENT:

- never create a restore Promise merely to “wait for Trust”;
- while untrusted there is no startup attempt at all;
- after trusted activation, acquire cross-process ownership first, then start one attempt;
- disable/replace Start/Join buttons with a pending-state UI instead of surfacing this internal mutex error to the user.

---

# 5. Recent Sessions are currently written with the wrong lifecycle meaning

## 5.1 `rememberProject()` is called before startup — VERIFIED

Start and Join currently call `rememberProject(context, descriptor)` before `openFolder()` and before `SessionRuntime.start()` succeeds.

## 5.2 `rememberProject()` records an EXIT timestamp — VERIFIED

Current implementation:

```ts
const leftAt = options.leftAt ?? Date.now();
...
rememberRecentProject(... {
  at: leftAt,
  leftAt,
  ...
})
```

Source: [`src/extension.ts`](./src/extension.ts), `rememberProject`.

`RecentProject` presents this timestamp as “N minutes/hours/days ago”.

Source: [`src/core/recentProjects.ts`](./src/core/recentProjects.ts).

Therefore the repeated cards seen in the UI are not merely cosmetic duplication. Fresh launches that never became usable are being recorded semantically as if the user had already **left** them.

## 5.3 Correct lifecycle split — DESIGN REQUIREMENT

Do not call `rememberProject()`:

- when Start/Join is merely requested;
- when pending launch is committed to disk;
- merely because a fresh runtime becomes ready.

Use three distinct concepts:

```text
Pending Session
  explicit Start/Join not yet established

Established/Active Session
  reached the appropriate runtime commit point

Recent Session
  an established session that was actually left/disconnected/suspended
```

`Recent Session` should be written only on true lifecycle exits such as:

- explicit Leave;
- graceful VS Code deactivation of an established session;
- detected system suspend of an established session;
- established guest host-unreachable path where reconnect state is retained.

This fixes both ghost cards and the false “you left” timestamp.

---

# 6. Current `local-route-failed` recovery UI is internally impossible

## 6.1 Terminal behavior — VERIFIED

`SessionRuntime.start()` does:

```ts
try {
  await this.transport.start();
} catch (error) {
  await this.disposeAsync('local-route-failed');
  throw error;
}
```

`restoreWorkspaceSession()` then handles that terminal reason and sets:

```ts
runtime = undefined;
```

Source: [`src/runtime/session.ts`](./src/runtime/session.ts), `start`; [`src/extension.ts`](./src/extension.ts), `restoreWorkspaceSession`.

## 6.2 The warning tells the user to reconnect — VERIFIED

Current UI says:

```text
...проверьте VPN/proxy и повторите reconnect...
```

But the Reconnect command executes:

```ts
await requireRuntime().reconnect();
```

and `requireRuntime()` throws when `runtime` is undefined.

Therefore after the exact failure the message describes, the prescribed Reconnect action cannot work.

This is a deterministic bug independent of the underlying network exception.

DESIGN REQUIREMENT:

- transient startup network failure must keep a retryable runtime/pending launch, **or** expose a dedicated pending-start retry action that reconstructs the same runtime identity;
- never instruct the user to call an action whose precondition was destroyed by the failure path.

---

# 7. The network stack is not actually redundant during startup

This is the deepest transport finding and is a separate cause of fragility.

## 7.1 Current order — VERIFIED

`MeshTransport.start()` currently performs, in order:

```text
1. ensureWebSocketRuntime()
2. create PRIMARY Nostr/Trystero room
3. if primary factory throws synchronously -> THROW ENTIRE start
4. this.hasStarted = true
5. await startRelayFallback()
6. only after fallback readiness succeeds:
     - start heartbeat timer
     - start ping timer
     - start metrics timer
     - start cleanup timer
     - start relay sweep timer
     - start SECONDARY MQTT signalling
     - start NetworkChangeWatcher
7. return success
```

Source: [`src/runtime/mesh.ts`](./src/runtime/mesh.ts), `MeshTransport.start`.

## 7.2 “Emergency fallback” is a mandatory startup gate — VERIFIED

`startRelayFallback()` creates `RedundantFrameRelay`, starts it, then awaits:

```ts
await this.relay.waitUntilReady(15_000);
```

If neither Nostr nor MQTT emergency data relay becomes ready, it stops the relay object, discards it, and throws.

`RedundantFrameRelay.waitUntilReady()` uses `Promise.any()` and throws if no family becomes ready.

Sources:

- [`src/runtime/mesh.ts`](./src/runtime/mesh.ts), `startRelayFallback`
- [`src/runtime/redundantFrameRelay.ts`](./src/runtime/redundantFrameRelay.ts), `waitUntilReady`

So a fallback that is described as emergency/last-resort is currently stronger than the primary route: its initial 15-second failure can kill the entire startup.

## 7.3 Secondary signalling is suppressed by fallback failure — VERIFIED

Because `startSecondarySignalling()` is called only after `await startRelayFallback()`, a failed emergency relay readiness check prevents MQTT secondary signalling from even starting.

This is a resilience inversion:

```text
optional family unavailable
    -> prevents another independent family from starting
```

## 7.4 Network-change recovery is also suppressed — VERIFIED

`networkWatcher.start()` is also after the fallback wait.

Therefore the failure can prevent the component that should notice “VPN/network route changed” from ever being armed.

## 7.5 Primary construction failure prevents every fallback — VERIFIED

If primary `factory(...)` throws synchronously, `MeshTransport.start()` throws before:

- secondary MQTT signalling;
- emergency Nostr/MQTT data relay;
- network watcher.

A redundant architecture must initialize independent families independently.

## 7.6 The current `start()` is unsafe for a simple retry — VERIFIED

At the top:

```ts
if (this.room) return 0;
```

If primary room creation succeeded but later emergency readiness threw, `this.room` already exists while timers/secondary/watcher were never initialized.

So a naive future implementation that catches the first failure and calls `transport.start()` again can get:

```text
room exists -> immediate return 0 -> false success
```

without completing the rest of startup.

DESIGN REQUIREMENT: refactor transport startup into explicit idempotent phases/state, not “call the existing start() again”.

## 7.7 Emergency relay objects already know how to recover — VERIFIED

`NostrFrameRelay.start()` schedules reconnects when sockets close. Its `waitUntilReady()` is only a deadline check. `NostrFrameRelay.stop()` permanently disables those loops.

Source: [`src/runtime/nostrRelay.ts`](./src/runtime/nostrRelay.ts).

Therefore stopping and discarding the relay merely because it did not become ready within the first 15 seconds destroys recovery machinery that already exists.

---

# 8. Bootstrap Join can be killed by an optional fallback while direct transport is usable

`downloadProjectSnapshot()`:

1. creates `MeshTransport` with `purpose: 'bootstrap'`;
2. installs snapshot message handlers;
3. starts a discovery/idle timeout;
4. calls:

```ts
void transport.start().catch(error => fail(error));
```

Source: [`src/runtime/bootstrap.ts`](./src/runtime/bootstrap.ts).

Because `MeshTransport.start()` waits for emergency relay readiness, this can happen:

```text
primary Trystero room exists
WebRTC host discovery/transfer may be working
snapshot bootstrap is in progress
emergency Nostr+MQTT fallback does not verify within 15s
transport.start() rejects
bootstrap fail() runs
working direct path is torn down
```

That is architecturally wrong. Bootstrap success/failure should be decided by whether the authenticated host snapshot can be obtained before the bootstrap deadline, not by whether an optional fallback family passed an unrelated initial readiness probe.

---

# 9. Why current tests missed the production startup class

## 9.1 In-memory transport tests skip production fallback — VERIFIED

`startRelayFallback()` explicitly returns when a test room factory is injected unless a relay factory is explicitly supplied.

Therefore most in-memory `MeshTransport.start()` tests do not exercise the exact mandatory emergency-readiness gate used in production.

## 9.2 Existing Extension Host E2E disables Workspace Trust — VERIFIED

`scripts/run-vscode-e2e.mjs` launches with:

```text
--disable-workspace-trust
```

So it cannot exercise:

```text
Start -> openFolder -> Restricted Mode -> extension disabled/limited
-> delayed Trust -> re-enable -> automatic exact resume
```

Source: [`scripts/run-vscode-e2e.mjs`](./scripts/run-vscode-e2e.mjs).

Official VS Code guidance says trusted and untrusted behavior must be tested in separate runs and normal extension tests cannot programmatically grant/revoke Trust:

- https://code.visualstudio.com/api/working-with-extensions/testing-extension

## 9.3 Release publishing does not currently run E2E — VERIFIED

`npm run artifacts` runs packaging/lint/unit-style gates, but does not run `npm run test:e2e`, `test:live`, or `test:live:relay`.

Source: [`package.json`](./package.json), `scripts`.

The release workflow’s verify job runs `npm run artifacts`, but it does not run `npm run test:e2e` and it is not defined as depending on the separate E2E workflow.

Source: [`.github/workflows/release.yml`](./.github/workflows/release.yml).

The E2E workflow itself runs on pull requests, pushes to `main`, and manual dispatch — not release tags.

Source: [`.github/workflows/e2e.yml`](./.github/workflows/e2e.yml).

DESIGN REQUIREMENT: a stable release must not be publishable solely because `artifacts` passed while the actual Extension Host/Trust gate failed or never ran.

---

# 10. Authoritative pending-launch storage: exact SecretStorage record

The current code already has a session-specific secret key:

```text
pairNotebook.sessionToken.<sessionId>.<peerId>
```

and current `saveDescriptor()` writes SecretStorage before atomically publishing `.pair-notebook-session.json`.

Source: [`src/extension.ts`](./src/extension.ts), `saveDescriptor`, `secretKey`.

This is a stronger authority than a process-global pending key.

## 10.1 Do NOT use an “immutable descriptor subset digest”

An earlier version of this plan proposed hashing only identity fields. Deeper review shows that is insufficient for automatic post-Trust network startup.

The marker also contains behavior-sensitive values, for example host `backingFolder` and Python/runtime configuration. `normalizeSessionDescriptor()` accepts host `backingFolder` from the marker, and runtime later accepts a broad executable path shape for `pythonPath`.

Sources:

- [`src/extension.ts`](./src/extension.ts), `normalizeSessionDescriptor`
- [`src/runtime/session.ts`](./src/runtime/session.ts), `safeExecutableName`

If only identity fields were attested, a marker modified during the untrusted interval could change non-hashed behavior while still passing the pending-launch check.

## 10.2 Stronger rule: attest the exact initial marker bytes

For a fresh launch:

```text
markerBytes0 = exact bytes that will be written before openFolder
H0 = SHA-256(markerBytes0)
```

Store H0 inside the exact per-peer SecretStorage pending record, then atomically write those exact bytes.

On trusted activation:

```text
1. read bounded regular marker bytes
2. minimally parse ONLY enough to obtain validated sessionId + local peerId
3. read EXACT secret key pairNotebook.sessionToken.<sessionId>.<peerId>
4. do NOT use legacy fallback
5. require lifecycle == pending/committing
6. require SHA-256(actual raw marker bytes) matches an allowed attested hash
7. require stored private key derives marker local public identity
8. only then normalize/use the full descriptor
```

A copied or modified marker cannot authorize automatic networking because workspace files cannot manufacture the matching extension SecretStorage value.

Whitespace-only modification may also reject auto-resume. That is acceptable: automatic startup should fail closed on unexpected marker mutation.

---

# 11. Automatic pending resume must be stricter than manual legacy reconnect

Current `descriptorSecret()` falls back to the legacy shared key:

```text
pairNotebook.sessionToken.<sessionId>
```

and migrates it into the per-peer key.

Current `ensureDescriptorIdentity()` may also repair a marker missing its public identity by deriving it from the private key and rewriting the descriptor.

Source: [`src/extension.ts`](./src/extension.ts).

Those are compatibility behaviors for old/manual recovery. They must **not** participate in automatic pending post-Trust authorization.

DESIGN REQUIREMENT: introduce two separate paths.

### Strict pending path

```text
readExactSessionSecret(sessionId, peerId)
- exact key only
- v2 lifecycle required
- no legacy migration
- no TOFU
- no marker identity repair
- fail closed on any mismatch
```

### Manual established/legacy reconnect path

May retain controlled legacy compatibility after explicit user confirmation.

Do not let compatibility logic silently broaden the authority used for automatic network startup.

---

# 12. Stored session secret v2: explicit transaction journal

Use one exact SecretStorage value as the authoritative launch journal.

Suggested format:

```ts
type PendingKind = 'start' | 'join';

type SessionSecretLifecycle =
  | {
      state: 'pending';
      launchId: string;
      kind: PendingKind;
      createdAt: number;       // diagnostics only, NOT expiry
      markerSha256: string;    // H0
    }
  | {
      state: 'committing';
      launchId: string;
      kind: PendingKind;
      beforeMarkerSha256: string; // H0
      afterMarkerSha256: string;  // H1
    }
  | {
      state: 'established';
    };

interface StoredSessionSecretV2 {
  version: 2;
  token: string;
  identityPrivateKey: string;
  lifecycle: SessionSecretLifecycle;
}
```

`createdAt` must never become an authorization TTL. Waiting an hour, a day, or changing the wall clock does not invalidate explicit launch intent.

`decodeSessionSecret()` must continue to read v1 for manual established-session compatibility, but **v1 cannot authorize automatic pending launch**.

---

# 13. Initial write-ahead transaction before `openFolder()`

`openFolder()` is the last step.

## 13.1 Host Start

```text
1. require trusted source workspace
2. prompt display name / backing folder
3. generate sessionId/projectId/peerId/token/keypair ONCE
4. create isolated working copy
5. create initial descriptor
6. serialize exact markerBytes0
7. compute H0 = sha256(markerBytes0)
8. SecretStorage exact key <- v2 lifecycle=pending(H0)
9. atomicWriteFile(marker, markerBytes0)
10. best-effort Pending Session index update
11. vscode.openFolder(target) LAST
```

Do not call `rememberProject()`.

## 13.2 Guest Join

Keep snapshot bootstrap before the durable target handoff:

```text
1. trusted source workspace
2. parse invite
3. create local peerId/keypair ONCE
4. authenticate host and receive verified project snapshot
5. create descriptor using the exact local identity established during bootstrap
6. serialize markerBytes0 / H0
7. exact SecretStorage <- pending(kind='join', H0)
8. atomic marker write
9. pending index best-effort
10. openFolder(target) LAST
```

If snapshot bootstrap cannot complete, no committed target pending launch should exist.

## 13.3 `openFolder()` failure behavior

Current code clears pending state when the command throws. New rule:

- if source process is still alive and VS Code explicitly reports navigation failure, **keep** the durable pending transaction;
- offer `Retry Open Pending Session` or `Cancel Pending Session`;
- never create a second session identity just to retry folder navigation.

A normal same-window process shutdown after `openFolder` is not an error signal.

---

# 14. Marker persistence must be frozen until pending launch commit

This is a critical correction to the raw-marker attestation design.

Current `SessionRuntime.start()` installs project/transport/awareness handlers before network startup. `localIdentityUpdated` mutates `descriptor.localPeer` and calls background descriptor persistence. Other project/file paths can also call `persistDescriptor()`.

At the normal end of startup, current code also does:

```ts
this.descriptor.freshStart = false;
await this.persistDescriptor();
```

Source: [`src/runtime/session.ts`](./src/runtime/session.ts).

If the marker were rewritten during a still-pending launch, then a crash before SecretStorage finalization would leave:

```text
pending secret attests H0
marker has unexpected Hx
next activation fails integrity check
```

Therefore:

## DESIGN REQUIREMENT — descriptor persistence gate

While lifecycle is `pending` or `committing`:

- runtime may mutate descriptor in memory;
- ordinary `persistDescriptor()` calls must be deferred/coalesced, not published;
- the pre-launch marker remains exactly H0 until transaction commit;
- the commit path serializes one canonical final marker H1 and publishes it deliberately;
- after established state is finalized, normal descriptor persistence is enabled and deferred writes may proceed.

Suggested runtime API:

```ts
beginLaunchPersistenceGate();
markDescriptorDirty();
serializeDescriptorForLaunchCommit();
finishLaunchPersistenceGate();
```

Do not implement this by scattering `if (pending)` checks around every handler.

---

# 15. Two-phase commit across SecretStorage + marker

SecretStorage and filesystem marker are two different durability domains. There is no cross-resource atomic transaction.

Therefore “clear pending and then write final marker” and “write final marker and then clear pending” both have crash gaps.

Use the `committing` journal state.

## 15.1 Commit protocol

After the appropriate runtime commit criteria are satisfied:

```text
0. current marker bytes verified == H0
1. keep descriptor persistence gated
2. build final descriptor bytes markerBytes1 (normally freshStart=false + valid runtime metadata)
3. H1 = sha256(markerBytes1)
4. SecretStorage <- lifecycle=committing(H0,H1)
5. atomicWriteFile(marker, markerBytes1)
6. verify/readback if practical
7. SecretStorage <- lifecycle=established
8. release descriptor persistence gate
9. remove Pending Session index entry best-effort
10. release startup ownership lease only when appropriate
```

Do **not** add a Recent Session entry at commit.

## 15.2 Crash recovery table

| Secret lifecycle | Marker hash | Meaning | Next activation |
| --- | --- | --- | --- |
| no secret | anything | no authority | no auto-start |
| v1 | marker exists | legacy/established compatibility | manual-only |
| pending(H0) | H0 | unfinished explicit launch | auto-resume same launch |
| pending(H0) | other | integrity mismatch | fail closed |
| committing(H0,H1) | H0 | commit marker not published | auto-resume/retry same launch |
| committing(H0,H1) | H1 | marker commit published, final secret write interrupted | auto-resume exact transaction and finalize only after runtime is usable again |
| committing | other | corruption/tamper | fail closed |
| established | valid marker | established saved session | no automatic old-session reconnect |

This makes the launch crash-recoverable without pretending SecretStorage + filesystem can commit atomically.

---

# 16. Cross-window ownership must live OUTSIDE the collaborative workspace

An earlier draft proposed `.pair-notebook-start.lock` inside the working folder. Deeper review shows that is unsafe.

`shouldTrackProjectPath()` explicitly excludes the session marker, termination marker, autosave marker, transfer directory, and atomic temp files — but not an arbitrary startup lock filename.

Source: [`src/core/projectFiles.ts`](./src/core/projectFiles.ts).

A lock inside the workspace risks being scanned/watched/synchronized as project content.

## 16.1 Runtime ownership path

Use extension-owned storage outside `workspace`, for example:

```text
<globalStorage>/sessions/<sessionId>/<peerId>/runtime-owner/
```

The current working folder is already:

```text
<globalStorage>/sessions/<sessionId>/<peerId>/workspace
```

Source: [`src/extension.ts`](./src/extension.ts), `sessionWorkingFolder`.

## 16.2 Hold ownership for the entire active runtime, not only startup

Protecting only the startup window is insufficient: a second VS Code window could open the same established/pending working folder after the first runtime is already active.

Use a runtime ownership lease:

```json
{
  "version": 1,
  "leaseId": "random-id",
  "pid": 12345,
  "acquiredAt": 0,
  "heartbeatAt": 0
}
```

Acquisition:

- atomic `mkdir(ownerDir)` or equivalent exclusive create;
- only one process can win initial acquisition;
- PID is for liveness only, never launch authorization;
- heartbeat updates while owner is alive;
- if owner PID is still alive, do not steal merely because the machine slept and heartbeat is old;
- if owner is dead, stale owner may be atomically renamed to a tombstone before reacquisition;
- owner periodically verifies its own `leaseId`; loss of ownership must stop use of that session identity;
- release only if on-disk `leaseId` still equals local owner.

A PID reuse false-positive may conservatively block recovery; it must never authorize a duplicate runtime. Safety beats automatic stealing.

The module-level `workspaceSessionRestore` Promise can remain as a second same-process guard.

---

# 17. Trusted activation must reconcile from durable state, not claim it

Pseudo-flow:

```ts
async function reconcileSessionWorkspaceOnActivation(context) {
  const folder = singleLocalWorkspaceFolder();
  if (!folder) return;

  const markerBytes = await readMarkerIfPresentAsBoundedRegularFile(folder);
  if (!markerBytes) return;

  // If limited mode happens to keep us running, remain inert.
  if (!vscode.workspace.isTrusted) {
    renderAwaitingTrustOnly();
    return;
  }

  const ids = minimallyParseAndValidateSessionAndPeerIds(markerBytes);
  if (!ids) return failClosed();

  const secret = await readExactSessionSecret(ids.sessionId, ids.peerId);
  if (!secret) return offerManualDiagnostics();

  if (secret.version === 2 && secret.lifecycle.state !== 'established') {
    verifyPendingMarkerHash(secret.lifecycle, markerBytes);
    verifyPrivateKeyOwnsMarkerPeerIdentity(secret, markerBytes);
    verifyNoAuthenticatedLocalTermination(markerBytes, secret.token);
    const owner = await acquireRuntimeOwnership(...);
    if (!owner) return showAlreadyOpenElsewhere();
    await resumeExactLaunch(...);
    return;
  }

  // v1 or established v2: old/saved session; fresh confirmation required.
  await offerManualSavedSessionReconnect(...);
}
```

Rules:

- never delete durable pending intent merely because it was “claimed”;
- never start network before Trust;
- never auto-create replacement credentials;
- never fall through from a pending-integrity mismatch into old-session manual logic without making the mismatch explicit;
- never use wall-clock age as the authorization decision.

---

# 18. Manifest strategy: correctness must work when Pair Notebook is fully disabled in Restricted Mode

Recommended security posture:

```json
"untrustedWorkspaces": {
  "supported": false,
  "description": "Pair Notebook remains disabled until this isolated session folder is trusted. A pending Start/Join is stored durably and resumes after Trust."
}
```

This matches the user-observed behavior and minimizes code running before Trust.

Official Workspace Trust sources:

- https://code.visualstudio.com/api/extension-guides/workspace-trust
- https://code.visualstudio.com/docs/editing/workspaces/workspace-trust

If `supported: "limited"` is retained for UX, it is only an optimization. Correctness must remain identical if the user/VS Code disables the extension entirely while untrusted.

In limited mode, untrusted activation may show only inert UI. It must not:

- apply session network runtime;
- consume pending launch;
- start Trystero/WebRTC/Nostr/MQTT;
- start filesystem synchronization;
- start Python execution.

---

# 19. Activation prelude must not be able to wedge pending recovery

Current `activate()` calls `applyMeshNetworkConfiguration(...)` before dashboard/controller/commands/restore reconciliation are fully registered.

Source: [`src/extension.ts`](./src/extension.ts), `activate`.

If network/proxy configuration throws during trusted reactivation, activation itself can fail before the pending state machine gets a chance to render a retryable state.

DESIGN REQUIREMENT:

```text
minimal activation shell first
  - activationContext
  - Output
  - safe dashboard/pending-state UI
  - ownership/recovery diagnostics

then Trust check

then trusted reconciliation

network configuration failures
  -> classified into pending startup state
  -> NEVER erase pending intent
  -> UI remains available with diagnostics/retry
```

Do not make successful proxy autodetection a prerequisite for the extension becoming capable of explaining/retrying a pending launch.

---

# 20. Activation after Trust: exact marker event is a good trigger but must be release-tested

Current activation event includes:

```text
workspaceContains:.pair-notebook-session.json
```

Source: [`package.json`](./package.json).

VS Code documents `workspaceContains:path` activation:

- https://code.visualstudio.com/api/references/activation-events

The marker is already present before `openFolder`, so this is the correct primary activation shape after Trust re-enables the extension.

But static reasoning is not enough. Required installed-VSIX gate:

```text
open target Restricted Mode
Pair Notebook disabled
wait
press Trust
Pair Notebook activates automatically
same pending launch proceeds with no second Start click
```

A historical VS Code issue where activation after Trust failed was fixed, and VS Code’s own Trust test plan checks re-enablement; nevertheless this project must test its exact path:

- https://github.com/microsoft/vscode/issues/127067
- https://github.com/microsoft/vscode/issues/128004

---

# 21. Refactor transport startup into independent engines

Do not patch `MeshTransport.start()` by swallowing one exception around the current sequence. The sequence itself is wrong.

## 21.1 Required transport lifecycle

Suggested internal states:

```ts
type TransportEngineState = 'idle' | 'starting' | 'running' | 'stopped';

type NetworkAvailability =
  | 'available'
  | 'degraded'
  | 'unavailable';
```

`MeshTransport.startEngine()` should establish local machinery exactly once:

```text
1. validate local identity/token/runtime invariants
2. install heartbeat/ping/metrics/cleanup timers
3. start NetworkChangeWatcher (production)
4. attempt PRIMARY signalling independently
5. attempt SECONDARY signalling independently
6. start emergency relay independently and KEEP it alive even if initially unready
7. emit readiness/diagnostic state
8. return once the transport ENGINE is initialized, not when every/one public endpoint passes a fixed initial deadline
```

Family failures become diagnostics/availability state unless they prove a local invariant is broken.

## 21.2 Do not let one family suppress another

Required test matrix:

```text
primary works, secondary fails, emergency fails -> usable/degraded
primary fails, secondary works -> usable/degraded
primary+secondary fail, emergency works -> usable/degraded
all unavailable -> engine alive, availability=unavailable
network later returns -> same engine transitions available
```

## 21.3 Add an explicit retry API for absent families

Existing `refreshSignalling()` refreshes sockets belonging to already-created production rooms. It is not a complete “construct every missing engine” operation.

Add something like:

```ts
retryUnavailableFamilies(): Promise<NetworkAvailability>
```

that can:

- recreate an absent primary room;
- create/recreate secondary signalling;
- ensure emergency relay remains started;
- rerun endpoint verification without destroying healthy routes.

Network-change events and explicit Reconnect should wake this same path.

---

# 22. Fresh HOST commit semantics

A new host is fundamentally different from a guest.

Current fresh host already has the authoritative initial project locally. It does not need a remote peer to prove that its local session identity exists.

Therefore:

```text
local project/storage/CRDT initialization succeeds
+ editor/controller bindings can be installed safely
= host may reach LOCAL ESTABLISHED
```

If network availability is zero:

```text
runtimeState = network-unavailable
same sessionId/token/peerId/keypair remain alive
transport engine continues retrying
Reconnect wakes retryUnavailableFamilies()
when network becomes available -> transition to ready/reachable
```

Do not terminate or recreate the host merely because public infrastructure is unavailable.

The dashboard must distinguish:

```text
SESSION ESTABLISHED LOCALLY
NETWORK UNAVAILABLE
```

from a local-fatal startup error.

A host can optionally copy its invite while offline, but UI must not claim that others can currently reach it.

---

# 23. Pending GUEST commit semantics

A guest must be more conservative because current synchronization semantics intentionally wait for authenticated host state.

Current `SessionRuntime.start()` guest path:

```text
connect pinned host
transition syncing
await stateReady for 45 seconds
```

and `stateEnd` resolves the initial state only when it comes from the current host.

Source: [`src/runtime/session.ts`](./src/runtime/session.ts).

DESIGN REQUIREMENT:

- preserve the same pending guest identity after the 45-second host wait expires;
- classify as `host-unavailable`, not terminal corruption;
- keep transport engine alive/retrying;
- do **not** create a new peerId/keypair;
- do **not** mark Recent;
- do **not** declare the guest fully established until authenticated initial host state has arrived.

To avoid changing synchronization semantics, do not bind the normal `EditorSynchronizer` in a way that can project an empty/not-yet-authoritative guest CRDT onto the bootstrap working files before initial host state is ready.

Offline editing of a pending guest before first authenticated state is **not guaranteed by the current protocol** and should not be silently introduced as part of this startup fix.

---

# 24. Host transfer during a long pending Guest delay is a protocol gap

This is an important limit discovered by the deeper review.

A Join descriptor created after bootstrap currently stores only the invite’s original host in `knownPeers`.

Source: [`src/extension.ts`](./src/extension.ts), `joinSession`.

The transport handshake’s local handshake currently contains:

```text
version
sessionId
purpose
peer
nonce
```

but not the current `HostClock`.

Source: [`src/runtime/mesh.ts`](./src/runtime/mesh.ts), `localHandshake`.

Runtime `hostAnnouncement` is accepted only when the announcement comes from the receiver’s **currently believed host**.

Source: [`src/runtime/session.ts`](./src/runtime/session.ts), `hostAnnouncement` handling.

Therefore consider:

```text
guest bootstrap succeeds against Host A
-> guest target stays untrusted for 1 hour
-> during that hour Host A transfers authority to Host B
-> Host A later becomes unavailable
-> guest trusts target
```

The pending guest may have no authenticated durable evidence telling it that Host B is now authoritative. A timeout cannot distinguish “Host A temporarily offline” from “authority moved while I was absent”.

This means a full guarantee for **arbitrary host transfer while a guest is offline/untrusted** cannot be honestly claimed from protocol v7 alone.

### Safe behavior in this startup fix

- never clear/recreate pending guest merely because original host is unavailable;
- show `host-unavailable / authority update not yet observed`;
- retry known authenticated authority paths;
- if authenticated authority update is eventually learned, continue.

### If deterministic offline host-transfer discovery is a product requirement

That requires a separate protocol design, for example a durable, authenticated host-clock/rendezvous record that an offline participant can retrieve later. It must be signed/authorized so an invite/token holder cannot forge host authority.

That is a protocol change and must be reviewed/tested separately from this lifecycle repair. Do not smuggle it into protocol-v7 startup work.

---

# 25. Session-ended while a guest waited untrusted is also not always knowable locally

Current termination evidence is written to:

```text
current host backingFolder || host workingFolder
```

as `.pair-notebook-ended.json`, HMAC-protected by the session token.

`readSessionTermination()` checks the local descriptor roots.

Source: [`src/core/sessionTermination.ts`](./src/core/sessionTermination.ts).

If a guest was completely offline/untrusted while the host ended the session, its local working copy may never receive that termination marker or live network event.

Therefore current protocol cannot always distinguish after Trust:

```text
host temporarily offline
vs
session ended while guest was absent
```

Safe rule:

- **timeout is not termination evidence**;
- keep pending identity until explicit Cancel or authenticated termination evidence arrives;
- never destroy pending Join merely because host is absent.

A deterministic “offline guest always learns session-ended” feature would require a durable remotely retrievable authenticated tombstone/rendezvous mechanism — again a separate protocol feature.

---

# 26. Startup failure taxonomy

Replace generic startup throw -> terminal teardown with explicit classes.

```ts
type StartupFailureKind =
  | 'local-fatal'
  | 'network-unavailable'
  | 'host-unavailable'
  | 'integrity-failure'
  | 'session-ended';
```

### local-fatal

Examples:

- unsafe/unreadable local working folder;
- invalid local CRDT/storage construction;
- required runtime dependency unavailable;
- impossible local invariant.

### network-unavailable

Examples:

- VPN/proxy blocks sockets;
- DNS/TCP/TLS unavailable;
- Nostr unavailable;
- MQTT unavailable;
- no emergency relay verified yet;
- direct ICE/TURN unavailable.

### host-unavailable

- pending guest cannot authenticate/reach current known host;
- initial state wait exceeded deadline.

### integrity-failure

- pending SecretStorage hash does not match marker;
- marker local identity does not match stored private key;
- working folder ownership/path mismatch.

### session-ended

- cryptographically/authentically verified termination evidence.

Only local-fatal, integrity-failure, and authenticated session-ended are terminal to automatic pending retry.

Network/host unavailability preserve identity.

---

# 27. Retry scheduler

For unavailable network families use bounded backoff with jitter, e.g. approximately:

```text
1s -> 2s -> 5s -> 10s -> 20s -> 30s -> 30s...
```

Exact timings are product choices, not protocol correctness.

Immediately wake retry on:

- network-interface change;
- proxy configuration change;
- user Reconnect;
- signalling family recovery event.

Retry must reuse:

- same runtime ownership lease;
- same sessionId;
- same token;
- same peerId/keypair;
- same working folder;
- same CRDT local state.

Never implement retry by recursively calling Start Session / Join Session.

---

# 28. Cancel Pending Session

A launch that never reached its role-specific commit point needs an explicit cancellation path.

Target the exact `(sessionId, peerId, workingFolder)` and ownership lease.

Cancel should:

1. stop pending retry engine;
2. close any partial runtime/transport owned by this lease;
3. delete exact pending SecretStorage credentials;
4. remove marker/transaction files for that exact session;
5. remove Pending Session index entry;
6. remove accidental legacy Recent entry for that exact working folder if migration left one;
7. optionally remove isolated working copy after explicit confirmation;
8. never touch another peer/session folder.

After lifecycle is `established`, this command is no longer “Cancel Pending”; normal Leave semantics apply.

---

# 29. Pending/Active/Recent dashboard model

Suggested pending states:

```text
Awaiting Workspace Trust
Starting local session
Network unavailable — retrying
Waiting for Session Host
Integrity problem — manual action required
Startup local error — Retry / Cancel
```

Do not render pending entries using the existing Recent Session “you left N minutes ago” component.

Established active states can use normal runtime status.

Recent Sessions remain a historical exit/reconnect list only.

---

# 30. Suspend/watchdog boundary

The `0.5.25/0.5.26` guard that requires the same ready runtime on both sides of a timer gap is conceptually correct.

Keep the stronger invariant:

```text
suspend watchdog may call local leave ONLY for a runtime
that has already reached its role-specific established commit
and still owns the same runtime lease
```

Never arm leave-on-gap behavior for:

- awaiting Trust;
- pending host local initialization;
- pending guest waiting for initial host state;
- transaction commit recovery.

A locally established host in `network-unavailable` is established, so ordinary suspend policy may apply after commit.

---

# 31. Test plan — state transaction

Unit tests must cover at minimum:

1. v1 secret decodes for manual compatibility.
2. v1 never authorizes pending auto-resume.
3. v2 pending Start exact marker hash succeeds.
4. v2 pending Join exact marker hash succeeds.
5. one-byte marker change fails closed.
6. whitespace marker change fails closed.
7. marker sessionId mismatch fails closed.
8. marker peerId mismatch fails closed.
9. private/public identity mismatch fails closed.
10. strict pending lookup never falls back to legacy key.
11. strict pending lookup never repairs missing identity.
12. pending intent remains valid after simulated >1 hour / days.
13. wall clock moving backwards does not invalidate pending intent.
14. two simultaneous different pending sessions do not overwrite each other.
15. pending index loss does not prevent exact target-folder recovery.
16. established secret does not auto-connect old marker.
17. copied marker without exact secret does not auto-connect.
18. malformed secret/marker fails closed.

---

# 32. Test plan — crash/transaction matrix

Inject crash/failure after each persistence boundary:

```text
A. working copy created, before secret
B. pending secret written, before marker
C. marker H0 written, before openFolder
D. target untrusted
E. trusted, before ownership acquisition
F. ownership acquired, before local runtime init
G. runtime commit-ready, before secret=committing
H. secret=committing, marker still H0
I. marker H1 published, secret still committing
J. secret established
```

Assert exact next activation semantics from the table in section 15.

Particularly verify that no crash point creates a new identity and no pending intent is silently reclassified as Recent.

---

# 33. Test plan — runtime ownership

- same pending folder opened in two windows -> one winner;
- second window never starts network under same peer identity;
- owner heartbeat persists while active;
- live owner PID prevents lock stealing after a long scheduler/suspend gap;
- dead owner is recoverable;
- stale owner cleanup has one atomic winner;
- owner only deletes its own leaseId;
- old process detecting lost lease shuts down session identity use;
- ownership files are outside collaborative project scan/watch paths.

---

# 34. Test plan — transport independence

Add production-shaped injected tests that do **not** skip the fallback behavior being tested.

Required cases:

1. primary direct room usable + both emergency relay families reject readiness -> direct data still succeeds; startup not terminal.
2. primary construction fails + secondary works -> transport usable.
3. primary fails + secondary fails + emergency relay works -> transport usable.
4. all public families unavailable -> transport engine remains alive/unavailable, does not throw availability as local corruption.
5. all unavailable then one family returns -> same transport becomes available.
6. failure of emergency relay does not suppress secondary signalling initialization.
7. network watcher starts even if no endpoint is initially available.
8. retry does not falsely return success just because `this.room` was created during an earlier partial attempt.
9. healthy route is never torn down just to retry another family.
10. emergency relay initial timeout does not call permanent `stop()` on self-healing relay machinery.

---

# 35. Test plan — bootstrap and guest delayed Trust

1. direct bootstrap route works while emergency relay readiness fails -> snapshot still completes.
2. snapshot bootstrap host unavailable -> fail before pending target commit.
3. snapshot completed -> target untrusted for synthetic >1h -> same guest identity resumes.
4. host offline at Trust -> `host-unavailable`, pending preserved.
5. host returns -> same peerId/keypair receives initial host state and commits.
6. no `EditorSynchronizer` projection before authoritative initial guest state.
7. authenticated termination evidence -> terminal cleanup.
8. mere timeout -> never treated as session-ended.
9. host transfer during offline delay is explicitly tested/documented according to protocol limitation section 24.

---

# 36. Real Workspace Trust acceptance gate

Current `--disable-workspace-trust` E2E remains useful as a baseline, but it is not a Trust test.

Official VS Code guidance:

- https://code.visualstudio.com/api/working-with-extensions/testing-extension

Until there is reliable external UI automation for Trust, installed-VSIX GUI acceptance is release-blocking.

## W1 — host delayed Trust

```text
clean profile
install candidate VSIX
open trusted source project
Start Session
target opens Restricted Mode
verify Pair Notebook inactive/inert
wait >=60s physical test + synthetic state age >1h
press Trust
verify automatic activation
verify same sessionId/projectId/peerId/keypair
verify host locally established
```

## W2 — close/reopen before Trust

```text
reach untrusted target
close VS Code completely
reopen exact target
Trust
same pending launch resumes
```

## W3 — Extension Host/window reload before Trust

Same identity and continuation.

## W4 — network unavailable after Trust

Host reaches locally established/network-unavailable under same identity, then recovers when network returns.

## W5 — guest delayed Trust

Snapshot succeeds, target stays untrusted, host temporarily disappears, Trust -> waiting-for-host, original host returns -> same guest commits.

## W6 — old established marker

No pending secret -> no automatic reconnect merely because Trust was granted.

## W7 — copied/tampered marker

No automatic network activity.

## W8 — two-window same pending folder

Exactly one runtime ownership winner.

---

# 37. Release workflow must enforce the tests it claims

Current release verify job can publish after `npm run artifacts` without executing the separate Extension Host E2E workflow.

Required release hardening:

- run/require Extension Host E2E for the exact release commit/tag;
- keep Windows + Linux + macOS + minimum VS Code coverage;
- add transport independence tests to mandatory unit/integration gate;
- add a documented installed-VSIX Workspace Trust acceptance checkbox/evidence before stable tag creation;
- do not state that “all release gates passed” if Workspace Trust was disabled in the only E2E run.

Live public relay smoke tests may be unsuitable as deterministic every-commit CI because third-party infrastructure is external. Use deterministic injected failure/recovery tests as the mandatory gate and keep live smoke as supplemental evidence.

---

# 38. Files expected to change

Primary:

```text
package.json
src/extension.ts
src/runtime/session.ts
src/runtime/mesh.ts
src/runtime/bootstrap.ts (only lifecycle/error integration if needed)
src/vscode/dashboard.ts
src/core/recentProjects.ts (API/lifecycle split)
scripts/run-vscode-e2e.mjs
.github/workflows/e2e.yml
.github/workflows/release.yml
tests
```

Recommended new modules:

```text
src/core/sessionSecret.ts
src/core/pendingSessionLaunch.ts
src/core/runtimeOwnership.ts
src/core/sessionMarkerTransaction.ts
```

Keep transaction/authentication logic out of the already large `extension.ts`.

---

# 39. Synchronization scope lock

Do **not** opportunistically change the collaboration protocol while fixing startup.

Without a separate failing regression test, leave unchanged:

- `src/core/crdt.ts` local-first ownership semantics;
- protocol-v7 wire framing/compatibility;
- Yjs text update ownership;
- notebook stable-cell IDs;
- output synchronization;
- execution synchronization;
- text projection quarantine;
- host election/authority semantics.

The only exception is if the team explicitly decides to solve the protocol limitations in sections 24/25 (offline host transfer or durable remote termination discovery). Those must be separate, versioned protocol work, not hidden in this Start/Trust repair.

---

# 40. Implementation order

Do not implement all layers at once.

## Phase 0 — freeze sync scope and add failing tests

First add deterministic tests demonstrating:

- durable intent lost by current claim/delete;
- early Recent false-left semantics;
- Reconnect impossible after `local-route-failed`;
- fallback readiness killing otherwise usable direct startup;
- secondary signalling suppressed by fallback failure;
- partial `MeshTransport.start()` false-success retry hazard.

## Phase 1 — durable transaction modules

- session secret v2 journal;
- exact marker-byte attestation;
- strict per-peer secret read;
- no legacy auto-resume migration;
- pending index as non-authoritative UI index.

## Phase 2 — `openFolder` handoff

- remove process identity from authorization;
- remove global singleton pending key from correctness;
- write all durable state before `openFolder`;
- never claim/delete before Trust.

## Phase 3 — runtime ownership + descriptor persistence gate

- external ownership lease;
- pending marker persistence freeze;
- two-phase commit H0/H1;
- crash matrix tests.

## Phase 4 — lifecycle/UI split

- Pending vs Active vs Recent;
- no `rememberProject` on Start/Join/commit;
- Retry/Cancel pending actions;
- remove normal user exposure of `still restoring`.

## Phase 5 — transport engine refactor

- independent primary/secondary/emergency startup;
- no mandatory emergency readiness gate;
- network watcher/timers independent of endpoint readiness;
- retry missing families;
- host `network-unavailable` nonterminal state.

## Phase 6 — guest retry semantics

- preserve guest pending identity on initial host timeout;
- delay normal sync binding until authenticated state;
- document host-transfer/session-ended offline limitations.

## Phase 7 — release gates

- mandatory E2E for exact release commit;
- installed-VSIX Workspace Trust W1-W8;
- physical two-computer normal collaboration acceptance.

Only then tag a new stable release.

---

# 41. Final acceptance definition

The startup repair is complete only when all of these are simultaneously true:

```text
explicit Start/Join intent is durably session-specific
AND no correctness state depends on source Extension Host survival
AND openFolder may kill the source host immediately
AND Restricted Mode may disable Pair Notebook completely
AND Trust may happen hours later
AND VS Code may restart before Trust
AND exact marker + exact SecretStorage state authorize the same launch
AND automatic pending path uses no legacy-key fallback/identity repair
AND duplicate windows cannot run the same local peer identity concurrently
AND pending marker mutation before commit is impossible through normal runtime persistence
AND SecretStorage/marker cross-store commit is crash-recoverable
AND fresh host network outage is nonterminal
AND guest host absence is nonterminal to identity
AND one transport family cannot suppress the other families
AND emergency relay readiness is not a mandatory gate for a healthy direct route
AND Reconnect has a real runtime/pending target to operate on
AND failed launches never become false Recent/left sessions
AND established old sessions stay manual-only
AND protocol-v7 sync semantics remain unchanged
AND mandatory automated gates pass
AND installed-VSIX Trust acceptance passes
AND physical two-computer sync acceptance passes
```

The central architecture becomes:

```text
BEFORE (0.5.26)
Start/Join
 -> marker + secret
 -> premature Recent/left entry
 -> one global pending record tied to editor process
 -> openFolder
 -> delete durable pending
 -> RAM-only claim waits for Trust
 -> transport start requires emergency relay readiness
 -> transient failure disposes runtime
 -> UI says Reconnect although runtime no longer exists

AFTER
Start/Join
 -> one identity generated once
 -> exact marker H0 + exact per-peer SecretStorage pending journal
 -> no Recent entry
 -> openFolder as hard process boundary
 -> zero required Pair Notebook execution while untrusted
 -> arbitrary delay/restart
 -> Trust / fresh activation
 -> strict exact attestation
 -> cross-window runtime ownership
 -> descriptor writes frozen while pending
 -> independent transport engines start/retry
 -> host may establish locally even if network unavailable
 -> guest waits nonterminally for authenticated host state
 -> two-phase H0/H1 transaction commit
 -> established state
 -> normal runtime persistence
 -> Recent only when an established session is actually left/disconnected
```

That removes the timing dependency that produced the `0.5.24 -> 0.5.25 -> 0.5.26` repair chain, and it also removes the transport startup coupling that currently turns optional fallback availability into a terminal session-creation failure.