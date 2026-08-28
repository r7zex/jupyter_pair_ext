# Pair Notebook 0.5.4 execution and host-transfer repair record

Date: 2026-08-27

Target release: 0.5.4

Incident scope: a two-participant Windows session connected successfully, but remote notebook execution lost its route, recent participant edits were not visible on the original host, host authority moved without an intentional transfer, and cancelling a non-empty-folder warning left the promoted host without an obvious recovery action.

This document preserves the incident evidence, implementation contract, completed checkpoints, and release acceptance for the 0.5.4 repair. See the [documentation index](README.md) for current project guidance.

Status: implementation checkpoints A-F were completed on PR #11 for release 0.5.4. The exact two reported physical computers remained the only external acceptance item unavailable in the development environment.

## Evidence from the reported incident

The screenshot records all of the following at the same time:

- Pair Notebook 0.5.3 throws `Error: No route to peer ...` from `MeshTransport.sendTo`, called by `SessionRuntime.synchronizeExecutionFiles` during `PairNotebookController.executeCell`.
- Two participants are still displayed in the online panel while the direct route required by `sendTo` is absent.
- Host ownership is already assigned to `user2` and the session is paused in `waiting-for-host-folder`.
- The notebook controller has surfaced the transport exception inside a cell instead of completing useful execution.

## Confirmed defects in 0.5.3

### 1. A physical route loss becomes a logical participant loss too early

`MeshTransport.onPeerLeave` immediately removes the identity route and emits `peerDisconnected`. `SessionRuntime` immediately marks that participant offline. `SessionCoordinator.evaluate` treats `online === false` as a hard loss and can elect a replacement as soon as its next tick.

This is earlier than recovery: the emergency-relay sweep runs only every 20 seconds and a relay identity negotiation may take up to 12 seconds. A recoverable direct-route flap can therefore move host authority before the already-running Nostr/MQTT fallback gets a chance to replace the route.

### 2. Execution starts with a stale online/route assumption

Compute availability checks consult presence and `peerRuntime`, but the actual execution barrier performs a synchronous `sendTo`. The route can disappear between those two operations. The exact result is the reported `No route to peer` exception.

### 3. Remote execution has no acceptance or result-delivery acknowledgement

After the file barrier, `executeRequest` is sent once. The requester then owns a four-hour timer. If the request or final `executeResult` is lost during route replacement, there is no bounded acceptance timeout, idempotent resend, or result replay. On the executor, failure to send the result can itself throw while handling the original error.

### 4. Project changes are not durable across the same route gap

Realtime CRDT and file lifecycle updates use best-effort broadcast. A failed per-peer enqueue is logged and discarded. State vectors can heal this after a successful reconnection, but the premature host-clock change can make otherwise valid old-clock frames stale before reconciliation completes. This explains the observed combination of a visible participant, absent route, and edits that did not appear on the other computer.

### 5. Cancelling the non-empty-folder warning is a UI dead end

`promptForNewHostFolder` returns after cancellation and is triggered only by the one-time `hostFolderRequired` event. A command still exists, but the only panel button is below the fold in Quick Actions. The paused status card shown in the incident has no retry button, so normal UI use provides no discoverable next action.

### 6. Existing-folder semantics are ambiguous and destructive-only

The current prompt offers only `Replace folder contents`. Materialization writes the session snapshot and removes files/directories absent from that snapshot. It cannot safely express the distinct user intentions “copy the current session into an empty folder” and “attach an existing Dropbox/shared copy”.

## Required invariants

1. A route is not a participant. Loss of one WebRTC path must not change host authority while another route is being established.
2. A host change requires either a completed explicit transfer protocol or continuous loss of every authenticated route beyond a bounded recovery lease.
3. Every cell execution reaches a terminal VS Code execution state. A request that was not accepted fails promptly; an accepted request survives route replacement and returns or reports a bounded recovery error.
4. Execution barriers operate on reconciled project state and cannot silently omit participant edits.
5. Reconnection performs explicit state-vector, filesystem-state, compute-state, awareness, and pending-execution reconciliation before the route is considered application-ready.
6. Cancelling any folder dialog keeps the session paused and leaves a prominent retry action visible.
7. Folder intent is explicit. No non-empty directory is deleted or overwritten without a mode choice and a final confirmation.
8. A promoted host broadcasts `hostStorageReady` only after authoritative state is safely materialized or an existing folder has passed the selected reconciliation policy.

## Implemented phases and incremental GitHub checkpoints

### Checkpoint A — plan and deterministic reproductions

- Recorded the plan before implementation.
- Added a transport test where the active direct route dies while the emergency relay remains available.
- Added a runtime test proving the old host is retained during recovery and participant edits converge after the replacement route appears.
- Added execution tests for route loss before barrier send, after request acceptance, and while returning the result.
- Added UI/runtime tests for warning cancellation, retry, empty-folder mode, existing-folder match, and existing-folder conflict.

### Checkpoint B — logical route recovery lease

- Introduced an authenticated logical-peer recovery state in `MeshTransport`.
- Started relay fallback and direct rediscovery immediately after active-route loss instead of waiting for the 20-second sweep.
- Kept host/election presence alive for a bounded recovery lease and cancelled the pending logical disconnect when a signed replacement route was admitted.
- Emitted `peerDisconnected` exactly once only after every recovery path missed the deadline.
- Exposed `waitForRoute(peerId, timeout)` so higher layers did not race a stale route snapshot against `sendTo`.

### Checkpoint C — execution delivery state machine

- Waited for a live route before beginning the file barrier.
- Added `executeAccepted` and idempotent request handling keyed by `requestId`.
- Used short bounded acceptance/recovery timers rather than relying on the four-hour kernel limit.
- Retained completed results for a bounded period and replayed them after a duplicate request or route restoration.
- Retried critical barrier/request/result frames only after authenticated route recovery and never executed the same request twice.
- Ensured controller output and `NotebookCellExecution.end(false)` received a concise actionable error when recovery failed.

### Checkpoint D — edit and filesystem reconciliation

- Marked a replacement route application-ready only after state vectors and filesystem/compute state were exchanged.
- Kept locally generated CRDT updates in Yjs and relied on state-vector diff for exact replay; failed best-effort broadcast was not treated as successful convergence.
- Queued bounded lifecycle controls needed for create/delete/rename reconciliation or included them in the reconnect manifest.
- Added an execution preflight that waits for this reconciliation barrier before hashing its manifest.
- Verified text, notebook structure/output, new/deleted/renamed files, binaries, and directories across a route flap.

### Checkpoint E — retryable and explicit host-folder workflow

- Put a persistent `Choose host folder` action directly inside the pause card and status bar, not only below the fold.
- Kept the pause card/action active after dialog cancellation and offered `Choose another folder` without requiring a new host event.
- Presented folder intent before browsing:
  - **Save current session to an empty folder** — required an empty directory, then materialized the authoritative session.
  - **Use an existing synchronized project folder** — scanned and compared it against the authoritative manifest without modifying it first.
- Bound an exact existing folder without destructive replacement; ignored local files could remain.
- Showed a bounded conflict summary when tracked contents differed and required an explicit follow-up choice: write the current authoritative session or choose another folder. It never inferred a winner from timestamps.
- Deliberately did not import a conflicting directory into the live session during host promotion. That would replace already-merged CRDT authority while peers were paused and could not be made equivalent to the user's requested “use the same Dropbox copy” operation. Exact copies attached without writes; mismatches required an explicit session-to-folder replacement or another folder.

### Checkpoint F — release and installed-artifact acceptance

- Bumped to 0.5.4 and replaced the tracked 0.5.3 VSIX.
- Ran lint, compile, deterministic tests, Python bridge tests, dependency audit, public Nostr/MQTT/WebRTC tests, and forced emergency-relay tests.
- Installed the exact VSIX and confirmed the installed version.
- Verified the packaged panel contains the persistent retry control.
- Verified GitHub `main` contains only the current VSIX and no generated, temporary, internal research, or old release files.
- Recorded the exact two-computer Flowseal/zapret-to-Karing acceptance as NOT RUN because the final VSIX was not exercised on those two computers in this environment.

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Direct route dies, relay succeeds | Same host, no session pause, edits converge, execution continues or retries once |
| Direct route dies, all fallback routes fail briefly then recover | Same host during recovery lease; route and state reconcile before new work |
| Every route to current host remains unavailable beyond the lease | One deterministic failover, then visible folder pause |
| Route dies before execution barrier | Bounded “recovering route” state, then execution or terminal error; never four-hour waiting |
| Route dies after executor accepts request | No duplicate kernel execution; result is replayed after recovery |
| Participant creates/renames/deletes files during route replacement | Both project trees converge before execution is allowed |
| Promoted host cancels warning or folder picker | Session stays paused and retry action remains visible |
| Empty-folder mode receives non-empty folder | No writes; user can choose again or switch mode |
| Existing synchronized folder matches | Folder attaches without deletion/rewrite and session resumes |
| Existing folder conflicts | No implicit overwrite; explicit conflict decision remains available |

## Research basis

- VS Code requires a notebook controller to create and finalize every `NotebookCellExecution`; failures must still call `end`. See the official [Notebook API guide](https://code.visualstudio.com/api/extension-guides/notebook).
- VS Code documents recursive workspace and external-root monitoring through `FileSystemWatcher` and `RelativePattern`. See the official [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api).
- Yjs document updates are commutative, associative, and idempotent, and state vectors are the intended way to transmit only missing changes after reconnection. See [Yjs Document Updates](https://docs.yjs.dev/api/document-updates).
- Trystero exposes physical `onPeerLeave` events and separate discovery/reconnection mechanisms; Pair Notebook must therefore own the logical recovery lease above those physical events. See the official [Trystero documentation](https://github.com/dmotz/trystero).

## Explicit limitations

The exact two computers from the report and their Dropbox contents were unavailable in the development environment. The implementation therefore used deterministic fault-injection tests while preserving final user-side acceptance as NOT RUN. No test result may be represented as a passed physical two-computer check until that check is actually performed.

## Completed checkpoints

- `aab46a6`: logical route recovery lease and immediate replacement-route search.
- `c41c76f`, `4bfec3e`: idempotent request/result delivery and retryable file barriers.
- `991661a`: full content request for newly discovered CRDT documents.
- `b5d58eb`: persistent folder retry, empty-folder mode, and exact shared-folder binding.
- `cbbf60e`, `7f0f7a7`, `bf09842`: ordered output replay, bounded large rich output, reliable stdin/control delivery, and protocol-v3 compatibility boundary.
- Release acceptance: `npm run artifacts` passed lint, compilation, 272 deterministic tests, VSIX packaging, and archive validation; VS Code CLI then installed `pair-notebook.pair-notebook@0.5.4` successfully. The installed JavaScript bundle and Python bridge hashes match the packaged build. Published VSIX SHA-256: `c0140d25644ce7b87159a4f3d8601bfba324a18edf0aa13aa7daf6eff8192603`.
