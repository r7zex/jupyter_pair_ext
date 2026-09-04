# Pair Notebook — Session/editor stability repair plan

**Status: completed — implementation, regression matrix, static audit, quality gate, and the separately delivered Prompt 15 PDF report are closed.**

This document records the original repair contracts and the evidence used to decide whether they are closed. Requirements are not rewritten after implementation to manufacture `[x]` status: a box is checked only where production code plus regression evidence satisfy the original contract.

## Non-negotiable contracts

- The logical participant is independent from any one physical route.
- Route loss, VPN/TUN change, half-open detection, signalling refresh, heartbeat delay, or ordinary Leave must not elect a new host.
- The one logical route-recovery contract is **30 seconds** (`LOGICAL_PEER_RECOVERY_MS = 30_000`).
- A guest reconnects only to the original pinned authenticated host identity.
- Terminal close reasons are typed and non-overlapping.
- Notebook non-structural updates are narrow; `NotebookEdit.replaceCells` is structure-only.
- Background editor persistence does not force `save()` and does not use full notebook replacement as a hot-path fallback.
- Ordinary guest Run Cell executes host-canonical CRDT text without project-wide file synchronization/materialization/flush.
- Remote execution and result delivery are idempotent/exactly-once at the logical operation boundary.
- New presence is file/cell/**line** semantic state, never an exact cursor offset/selection publisher.
- Resource/hardware/kernel telemetry is separate from semantic presence.
- Lifecycle diagnostics are correlated, bounded, sanitized, and passive.

## 1. Recovery state machine and authority

- [x] A physical route failure starts logical recovery, not participant replacement.
- [x] The shared recovery deadline is 30 seconds; there is no competing 60-second logical participant lease.
- [x] Authenticated replacement admission ends the current recovery cycle and reconciles state.
- [x] Missing every route for the full deadline emits one logical disconnect.
- [x] Route loss itself does not mutate `(sessionEpoch, hostEpoch, hostId)`.
- [x] Only explicit current-host transfer or an authenticated next-clock announcement from the trusted current host may advance authority.
- [x] A lost pinned host closes a guest as `host-unreachable`; it never self-promotes.
- [x] Manual Recent Session reconnect targets the same pinned host key and rejects a substitute identity.

Production anchors:

- `src/runtime/mesh.ts`: `LOGICAL_PEER_RECOVERY_MS = 30_000`, logical recovery/replacement handling.
- `src/core/election.ts`: route/heartbeat loss closes without election; authority mutation is confined to `manualTransfer()` and validated `applyAnnouncement()`.
- `src/runtime/session.ts`: manual reconnect checks `descriptor.hostPeerId`, pinned identity key, and waits with `LOGICAL_PEER_RECOVERY_MS`.

Evidence:

- `keeps recovery timing separate from heartbeat freshness and reconnects before the deadline`
- `cancels terminal disconnect when authenticated recovery completes near the deadline`
- `emits one logical disconnect only after every route misses the recovery lease`
- `keeps pinned host id and epoch unchanged throughout route recovery`
- `still allows an explicit current-host transfer after adding the recovery guard`
- `does not transfer host authority when the host simply leaves`
- `reconnects a guest only to the original authenticated host without role or epoch mutation`
- `fails when the original host has no route and never self-assigns authority`

## 2. Terminal lifecycle and Recent Sessions

Typed terminal reasons:

- `local-route-failed` — local `MeshTransport.start()` failed before the runtime established its own transport readiness.
- `host-unreachable` — an established guest exhausted recovery to its pinned host.
- `explicit-leave` — local explicit Leave/dispose.
- `session-ended` — authenticated Session Host ended the session.

- [x] Every terminal path emits one structured lifecycle payload.
- [x] Repeated disposal is idempotent.
- [x] Pending execution rejects with typed `SessionClosedError`.
- [x] Execution contexts/awareness are cleared during teardown.
- [x] Run Cell and Restart become unavailable without an execution context.
- [x] Pair-owned text/notebook/diff tabs are closed without closing unrelated tabs or the VS Code window.
- [x] Explicit Leave keeps the Recent Project record but removes reconnect metadata.
- [x] Host-unreachable preserves reconnectable pinned-host identity.

Evidence:

- `emits one structured terminal lifecycle payload for every close reason and repeated dispose is idempotent`
- `classifies failure to establish local transport readiness as local-route-failed`
- `rejects pending execution with typed SessionClosedError and stops an active route wait`
- `clears execution contexts and local awareness before awareness destruction`
- `disables Run Cell and Restart when execution context is not available`
- `closes only Pair text/notebook/diff tabs, leaves unrelated tabs/window alone and continues after one close failure`
- `persists session and original host identity without storing reconnect secrets`

## 3. Notebook update scopes and structure-only replacement

Semantic scopes are `cellText`, `cellMetadata`, `cellOutputs`, `cellExecution`, `notebookMetadata`, plus structural/unscoped reconciliation.

- [x] `cellText` uses a narrow text edit by stable cell ID.
- [x] `cellMetadata` changes metadata only.
- [x] `cellOutputs` renders outputs only.
- [x] `cellExecution` renders execution state only.
- [x] `notebookMetadata` does not replace cells.
- [x] `NotebookEdit.replaceCells` has one production call and is guarded by `minimalNotebookSplice()`.
- [x] Full `applyNotebookSnapshot()` is reachable only after proven structural mismatch/recovery.
- [x] Unscoped historical/state-vector reconciliation applies fields narrowly if structure already matches.
- [x] Structural insert/delete/reorder preserves unaffected stable IDs and restores best-effort editor selection/viewport state.
- [x] Public VS Code API limitation is explicit: exact pixel scroll offset cannot be restored; `NotebookEditor.revealRange(...AtTop)` is the supported stable best-effort primitive.

Static-audit classification:

- `src/vscode/sync.ts` contains the sole production `NotebookEdit.replaceCells` call inside `applyNotebookSnapshot()`, and only when `minimalNotebookSplice()` returns a structural splice.
- The sole production caller of `applyNotebookSnapshot()` is `applyStructuralRecoveryIfNeeded()`, after it proves a structural difference.

Evidence:

- `applies cellText by stable ID with one minimal text edit, zero replaceCells and no full snapshot`
- `applies cellMetadata by stable ID with updateCellMetadata only and preserves source/output/execution`
- `applies notebookMetadata without replacing cells and preserves every cell object`
- `does not escalate a cell metadata apply failure to a full notebook snapshot`
- `allows full snapshot only after a proven structural inconsistency`
- `uses one minimal structural splice for insert and preserves unaffected cell identities`
- `uses one minimal structural splice for delete and preserves unaffected cell identities`
- `uses a bounded structural splice for reorder and preserves unaffected prefix/suffix identities`
- `restores notebook/text selection and a stable viewport anchor after structural insert`

## 4. Persistence boundaries

- [x] Background open-notebook persistence reconciles through VS Code and does not call `notebook.save()`.
- [x] Background open-text persistence does not call `document.save()`.
- [x] `NotebookDocument.save()` and `TextDocument.save()` are guarded by `forceSave` inside `prepareWorkingCopy()` materialization.
- [x] Full storage `flush()` is an explicit persistence/barrier operation, not an ordinary guest Run Cell operation.

Explicit materialization/barrier contexts found by static audit:

- current-host `saveAsHost()`;
- host-transfer preparation before authority is committed;
- session-end fencing/final persistence;
- peer acknowledgement of explicit session ending;
- local execution when a physical workspace snapshot is required;
- explicit legacy execution-barrier commit.

Evidence:

- `keeps background persistence out of the open notebook save hot path`
- `keeps background text persistence unsaved and saves only at an explicit filesystem barrier`
- `keeps participant mirrors unsaved while allowing an explicit execution snapshot`
- `does not externally replace an open working file while still updating the backing copy`

## 5. Host-authoritative execution contract

Ordinary guest Run Cell is not a project barrier.

- [x] Request identity includes random request ID, notebook/stable cell identity, compute target/epoch, canonical cell revision and digest.
- [x] The host waits only for the target cell CRDT revision required by the request.
- [x] The host resolves code from its canonical CRDT state; guest payload text is not execution authority.
- [x] Revision/digest mutation or stale/mismatched authority is rejected.
- [x] Ordinary guest Run Cell does not call `synchronizeExecutionFiles()`.
- [x] Ordinary guest Run Cell does not call `prepareWorkingCopy()`.
- [x] Ordinary guest Run Cell does not perform full storage `flush()`.
- [x] `synchronizeExecutionFiles()` remains only an explicit legacy/protocol-compatible full-project barrier.
- [x] Local execution may materialize the workspace because imports must observe the physical host working copy.

Evidence:

- `executes lightweight requests from host canonical CRDT text and rejects request-id digest mutation`
- `deduplicates a duplicate lightweight request before acceptance and starts one kernel execution`
- `waits only for lagging target-cell CRDT convergence and executes without a project barrier`
- `times out a lagging target cell without execution or guest-payload fallback`
- `rejects stale guest revision without rolling back host-ahead canonical state`
- `rejects lightweight compute-epoch mismatch, wrong executor and invalid source before acceptance`

## 6. Exactly-once execution/output semantics

- [x] Duplicate identical execution requests do not launch a second kernel execution.
- [x] Request-ID reuse with changed identity/content is rejected.
- [x] Accepted execution ownership survives route loss.
- [x] Sequenced Jupyter events are deduplicated/reordered before requester completion.
- [x] Terminal result repeats until acknowledged and is resolved once.
- [x] Host canonical CRDT output/execution state is published once and reaches other participants.
- [x] VS Code renderer coalesces output bursts while retaining the last canonical output.

Evidence:

- `executes a repeated remote request exactly once and replays the terminal result until acknowledged`
- `keeps lightweight execution ownership across route loss after acceptance and replays without re-execution`
- `orders and deduplicates replayed execution events before resolving the result`
- `publishes one authoritative host CRDT output/execution state that reaches a third participant`
- `coalesces a remote output burst into one render and the last canonical output wins`
- `does not lose a terminal execution update that arrives inside the coalescing window`

## 7. Line-only semantic presence

- [x] New local presence publishes `activeFile`, stable `activeNotebookCellId`, `activeLine`, `shareCursor`, participant/name/color renderer metadata.
- [x] New local presence does not publish exact offset, anchor, active column, or selection range.
- [x] Legacy exact cursor is receive-only compatibility.
- [x] Same-line column/range movement is deduplicated and publishes no new semantic packet.
- [x] Real line/cell/file changes publish one semantic update.
- [x] Blur/leave clears stale semantic location without fabricating line zero.

Evidence:

- `publishes line semantics only and suppresses same-line column/range noise plus duplicate blur`
- `publishes a stable notebook cell id and one packet for a real cell change`
- `preserves incoming line-only presence while legacy cursor remains receive-only compatibility`
- `highlights the entire active line and never decorates an exact column or selection range`
- `deleted or invalid stable cells never render a fabricated first line and stay cleared until new presence`
- `peer blur and disconnect clear decorations/status immediately without a throttle`

## 8. Resources/hardware/kernel separation

- [x] `resourceTick()` samples resources and calls `publishResourcePresence()`, not `updatePresence()`.
- [x] Resource publication has an independent rate limit.
- [x] Hardware and kernel status have separate transport frames.
- [x] Resource/hardware/kernel updates do not mutate `activeLine` and do not cause semantic cursor redraw.
- [x] Dashboard compute/resource data continues to update from merged runtime metadata.

Evidence:

- `resource ticks are rate-limited and do not republish semantic awareness`
- `merges remote resource frames into snapshots so the dashboard still updates without a presence event`
- `advertises compute hardware only from the current host`
- `tracks kernel status independently for each notebook and publishes the per-notebook map`

## 9. Lifecycle diagnostic ring and correlation

- [x] Each recovery cycle gets one opaque random correlation ID.
- [x] Route-loss → recovery → replacement/deadline → runtime close → Pair-tab close can be correlated without raw secrets.
- [x] The next independent recovery cycle gets a new correlation ID.
- [x] The ring is fixed at 256 events and evicts oldest-first.
- [x] Session identifier is hashed/sanitized.
- [x] Metadata is allow-listed and bounded; token, proxy credentials, SDP, and notebook code are not retained.
- [x] Runtime disposal leaves the bounded ring available for final extension-level cleanup evidence.

Evidence:

- `keeps one opaque correlation id per recovery cycle and rotates it for the next cycle`
- `is fixed-size, evicts oldest first, and snapshot reads do not mutate the ring`
- `drops secret-shaped arbitrary fields and never exposes token, proxy credentials, SDP, or notebook code`
- `preserves route-loss -> recovery -> replacement order under one correlation id`
- `preserves route-loss -> deadline -> runtime close -> tabs close order with the same correlation id`
- `emits half-open, route loss, deadline and terminal peer disconnect under one id`

## 10. Prompt 16 static audit and quality gate

Static searches performed across the working tree:

- [x] all `NotebookEdit.replaceCells` / `replaceCells(`;
- [x] all `applyNotebookSnapshot`;
- [x] all `notebook.save()`;
- [x] all `document.save()`;
- [x] all `synchronizeExecutionFiles`;
- [x] all `prepareWorkingCopy`;
- [x] all full `.flush(` paths;
- [x] local legacy cursor publication;
- [x] `resourceTick` / `updatePresence()` coupling;
- [x] `local-route-failed`;
- [x] recovery constants;
- [x] host authority mutations;
- [x] lifecycle diagnostic correlation implementation.

Findings:

- no non-structural production `replaceCells`;
- no forbidden hot-path `applyNotebookSnapshot`;
- no background editor `save()` outside explicit `forceSave` materialization;
- no ordinary guest Run Cell project barrier/materialize/full flush;
- no new-peer exact cursor publisher;
- no resource sampling → semantic presence coupling;
- one pre-existing lint-only defect in `clearRecentReconnect()` was found and fixed without changing behavior; the regression test now also proves immutable cleanup.

Final Prompt 16 quality evidence after that fix:

- `npm run lint` — PASS, 0 errors/warnings;
- `npm test` — **392 passing, 1 pending, 0 failing**;
- pending test is the explicitly environment-dependent real-Jupyter capability test; CI Python lacks `jupyter_client`/`ipykernel`;
- `python3 test/jupyter_bridge_unit.py -v` — **7/7 OK**;
- `npm run compile` — PASS;
- `node scripts/make-artifacts.mjs --preflight-only` — PASS;
- `npx vsce ls --no-yarn --no-dependencies` — PASS without creating a VSIX;
- `git diff --check` — PASS;
- package version remained `0.5.8`;
- no Prompt-series tag, release, tracked VSIX, or release asset was created.

## 11. Completion gate

Implementation acceptance criteria above are fully evidenced. Documentation has been reconciled with the implementation instead of redefining the implementation to match stale documentation.

The previously open series-level administrative gap is now closed by the explicitly authorized follow-up task:

- [x] `pair-notebook-15-report.pdf` was generated as a separate user artifact, visually inspected on every rendered page, and intentionally kept out of git and release packages as required by Prompt 15. SHA-256: `7bf08cf5eecc0e99dc96ac74a4f8c84a91edf3831e7bb5ccab925f35170ee33f`.

The implementation acceptance criteria and the required reporting artifact are complete. Physical two-computer VPN-switch validation remains a separate environment-dependent release check and is not represented as having run here.
