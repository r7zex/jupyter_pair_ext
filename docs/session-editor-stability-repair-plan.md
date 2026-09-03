# Session, notebook, and presence stability repair

Status: in progress. Each completed checkpoint is tested, committed, and pushed before the next checkpoint begins.

## Incident findings

- The coordinator could expire the pinned host heartbeat before the mesh classified a VPN-switched WebRTC channel as half-open.
- Logical route recovery was represented as `online`, leaving a disconnected participant visible in the host panel.
- Runtime shutdown did not have one UI-visible reason or close the isolated-session tabs.
- Output and execution updates reapplied a complete notebook, including unrelated cells, which recreated editor state and caused viewport movement.
- Guest execution performed a complete filesystem barrier before sending the host execution request.
- Presence updates carried precise offsets and were republished with resource data; deleted or replaced cells could resolve an obsolete offset to the first line.

## Checkpoints

- [x] **1. Route-recovery state contract.** Model `connected`, `recovering`, and `disconnected` separately; use a 30-second bounded recovery lease; do not report recovery as online; coordinator retains the pinned host while recovery is active.
- [x] **2. Deterministic guest termination.** Emit one close reason, persist the reconnectable recent session, clear collaboration state, notify the user, and close only tabs under the isolated Pair working copy.
- [x] **3. Targeted notebook synchronization.** Apply structural, text, metadata, output, and execution changes independently; preserve viewport/selection; coalesce output updates; eliminate background editor saves.
- [x] **4. Fast host-only execution.** Send a cell request directly to the pinned host without the normal full-project barrier, retain legacy barrier compatibility, and preserve output/event idempotency.
- [x] **5. Line presence.** Publish and render the active line rather than offsets; invalid focus/cell state is omitted instead of falling back to line one.
- [ ] **6. Evidence and release hygiene.** Add lifecycle diagnostics and regression coverage, run the package-quality checks, and keep the work source-only without a version/tag/release change.

## Baseline contract snapshot (prompt 01)

Audited at repository SHA `3165ce0216eac1c1f67c4e400748ab52581b551d`. This section records the required invariants and the observed implementation without converting unresolved implementation or evidence gaps into completed checkpoints.

### Session authority and recovery

- `PeerRuntime.online` is distinct from `connectionState: connected|recovering|disconnected`.
- Canonical route-recovery timing is `LOGICAL_PEER_RECOVERY_MS = 30_000`; route probes run every 1000 ms, half-open retirement requires 3 failed probes and 3000 ms of inbound staleness, and the coordinator heartbeat lease defaults to 1600 ms.
- Required state machine: `connected -> recovering -> connected|disconnected`.
- `recovering` must never be reported as `online`.
- Route loss must not change `hostId` or `hostEpoch`. Host authority advances only through `SessionCoordinator.manualTransfer()` or a valid authenticated `applyAnnouncement()` from the currently trusted host; bootstrap only establishes the initial clock.
- The runtime close-reason contract is exactly `host-unreachable`, `local-route-failed`, `explicit-leave`, and `session-ended`.
- Host loss closes only editor tabs rooted in the isolated Pair working copy; the reconnectable entry is retained through the existing Recent Projects model (`pairNotebook.recent`, `RecentProject { name, workingFolder, at }`).
- **Open documentation mismatch:** `docs/protocol.md` still describes a 60-second recovery lease and a recovering participant as logically online. That text is stale relative to the current 30-second/`online=false` runtime contract.

### Execution protocol

- Ordinary guest Run Cell uses the `executeRequest` fast path and does not invoke a full project manifest/file barrier.
- `synchronizeExecutionFiles()` and the `executionBarrierCheck/status/commit/ack` frames are retained only as an explicit protocol-compatibility path for peers that still request the legacy barrier.
- Execution-event compatibility still accepts pre-sequencing peers when `eventSequence` is absent; newer peers use ordered event sequencing and acknowledgements.
- Required invariant: ordinary guest Run Cell must execute the host-canonical CRDT text for the selected cell.
- **Open implementation gap:** the current VS Code controller calls `runtime.executeCell(..., cell.document.getText(), ...)`; therefore the canonical-CRDT-text invariant must remain an explicit acceptance requirement until the execution construction path is changed and regression-tested.

### Notebook synchronization

- Notebook CRDT scopes are exactly `structure`, `cellText`, `cellMetadata`, `notebookMetadata`, `cellOutputs`, and `cellExecution`.
- Background persistence must not force editor saves; `notebook.save()` and `document.save()` are gated by `forceSave`.
- Required invariant: structural replacement must be narrowly scoped and must never recreate unrelated cells or viewport state.
- `applyNotebookSnapshot()` uses a minimal structural splice for true structure changes.
- **VS Code 1.95 Notebook API boundary (prompt 07):** output/execution synchronization no longer uses `NotebookEdit.replaceCells`. Remote output is rendered with a controller-owned `NotebookCellExecution.replaceOutput()`; execution order uses the writable `executionOrder`, running state uses `start()`, and final success/failure uses `end(success, endTime)`. `NotebookCellExecutionSummary` itself is read-only, so arbitrary summary assignment is not a supported public-API path.
- **Timing limitation:** `startTime` can only be supplied when `NotebookCellExecution.start(startTime)` is called. If a live running update first arrives without a start timestamp, a later final update cannot retroactively rewrite that start timestamp through the public API; the final `endTime` can still be supplied.
- **Viewport limitation:** `NotebookEditor.visibleRanges` is read-only in the supported VS Code 1.95 API. Structural edits therefore preserve a stable visible-cell anchor and use `revealRange` only if that anchor falls outside the post-edit viewport; exact pixel scroll offset cannot be restored through the stable API.

### Presence and awareness

- New local presence publication contains `activeLine` and does not publish `cursor`, exact offsets, columns, or ranges.
- `SharedCursorPosition` plus `sanitizeCursor()`/`resolvePresenceCursor()` remain receive-side compatibility support for older peers only.
- Remote awareness state is removed with `removeAwarenessStates()` when the peer is cleaned up.
- Required invariant: resource sampling must update resource state without republishing line presence.
- **Open implementation gap:** `resourceTick()` currently calls `updatePresence()`, so a resource sample republishes the whole local awareness payload, including line presence. This remains unresolved and must not be marked complete until changed and regression-tested.

### Diagnostics and evidence

- Required invariant: lifecycle diagnostics use a bounded in-memory ring and every lifecycle record carries a correlation ID that lets route-loss, recovery, terminal close, and UI-visible outcome be associated without unbounded logging.
- **Open implementation gap:** no correlation-ID lifecycle ring is present in the audited source.
- Checkpoint 6 stays unchecked until lifecycle diagnostics/regression coverage exists and the package-quality commands have actually passed.
- Required verification evidence before claiming the remaining work complete: `npm run lint`, full `npm test` with exact counts, Python bridge tests when separate from npm test, and the repository compile/build script.
- Version, tag, release, and release-VSIX must remain unchanged for this repair series.

## Acceptance scenarios

1. Switching a VPN/TUN route starts recovery immediately and the same authenticated host resumes within 30 seconds; no participant becomes host.
2. If the host remains unreachable after 30 seconds, only the guest runtime terminates, its Pair tabs close, the host is retained in Recent Sessions, and the existing host has no ghost online participant.
3. A notebook execution update touches only the executed cell and does not replace unrelated cells or move the active viewport.
4. A guest cell run reaches the host without a full manifest/file barrier, executes exactly once, and publishes one authoritative result for every participant.
5. Presence shows an active line/cell only, never a fabricated first-line cursor after a cell disappears.


## Notebook persistence hot-path contract (prompt 08)

- Output/execution coalescing uses one named `NOTEBOOK_CELL_STATE_COALESCE_MS = 75` window per notebook. Pending work is a `Set` of stable cell IDs, so duplicate events for one cell collapse to one render.
- The coalescing timer never stores output/execution payload snapshots. On expiry (or explicit persistence drain), it reads the latest canonical CRDT cell state, so obsolete intermediate iopub states are not replayed and a terminal execution update supersedes an earlier running state.
- `dispose()` clears every notebook coalescing timer and pending stable-cell set.
- Production editor `.save()` calls are intentionally limited to exactly two guarded calls in `EditorSynchronizer.persistOpenWorkingCopy()`: `notebook.save()` and `document.save()`, both only when `forceSave === true`.
- Ordinary CRDT text, notebook output/execution, metadata, presence, and debounced persistence never call editor `save()`. `prepareWorkingCopy()` is the explicit filesystem barrier used by local execution, final host save/session end, and host transfer.
- Physical persistence is independently debounced by `StorageAdapter.schedule()` using the configured `persistenceDebounceMs` (default 750 ms). It serializes CRDT state and writes the durable backing copy before requesting a non-saving open-editor reconciliation; the editor hot path does not await this timer.
- `applyNotebookSnapshot()` is no longer an initial-bind or routine-persistence operation. Initial bind and persistence use narrow unscoped reconciliation. The only production caller is `applyStructuralRecoveryIfNeeded()`, after `minimalNotebookSplice()` proves a real structural inconsistency; that path emits a `[structural-recovery]` diagnostic.
- Text, metadata, output, and execution failures remain scope-specific. Output/execution renderer failures are logged separately and do not escalate into a generic full-notebook fallback.


## Lightweight execution request contract (prompt 09)

- Ordinary guest Run Cell uses `executeRequest` with no code payload and no project manifest. The request identity is `requestId + notebookKey + stable cellId + pinned host executorId + computeEpoch + cellRevision + cellDigest`.
- `cellRevision` is a CRDT marker stored with the logical cell and changed only in the same transaction as canonical cell-text mutations. Output, execution and metadata transactions never change it. A new stable cell gets a new revision lineage.
- `cellDigest` is SHA-256 over the canonical UTF-8 CRDT cell text. Filesystem mtime, editor save state, outputs, execution and metadata are excluded.
- Guests compute revision/digest from their canonical CRDT state. The host recomputes both from its own canonical CRDT state and executes only that host-side source after an exact match.
- Request retries reuse the same request ID and request identity. Active/completed dedupe stores a digest over the lightweight identity, so reusing one request ID with another revision/digest is rejected and cannot launch a second kernel execution.
- Ordinary guest Run Cell does not call `synchronizeExecutionFiles()`, `executionManifest()`, `prepareWorkingCopy()` or full `flush()`. The legacy non-fast-path execution barrier is retained only for explicitly barrier-framed requests.
- The lightweight framing intentionally omits the old `target` and manifest fields. A pre-prompt-09 fast-path peer is rejected as malformed rather than accidentally executing an empty payload; legacy barrier framing remains separately parseable.
- Raw cell source is never included in request metadata or diagnostics.


## Host-authoritative target-cell convergence contract (prompt 10)

- A lightweight execution request is accepted only after the private runtime handler receives a valid authenticated MeshTransport source identity, validates request ID/notebook/stable cell/executor/host/compute epoch, and proves an exact host-side canonical CRDT revision+digest match.
- Cell text revisions are now ordered markers of the form `r<sequence>_<id>`. A new stable cell starts at revision 1; a canonical cell-text mutation advances the sequence. Metadata, outputs, execution state, filesystem mtime and editor save state never advance it.
- If host revision+digest already match, execution proceeds immediately. If the host sequence is behind the request, the host waits up to `TARGET_CELL_CONVERGENCE_TIMEOUT_MS` for only that notebook's target-cell text update. Unrelated documents, metadata/output/execution updates, binaries and directories do not satisfy the wait.
- The target-cell wait subscribes only to scoped `cellText` updates for the requested stable cell (plus unscoped bootstrap/state-vector updates that may contain it). It recalculates host canonical revision+digest after each relevant update.
- If host sequence is already ahead of the request, the request is rejected as `StaleCellRevision`; host CRDT state is never rolled back. If convergence does not arrive before the bounded timeout, the request is rejected as `CellStateUnavailable`. Neither case executes stale host text or falls back to guest payload.
- `executeAccepted` is emitted only after authority and canonical-state validation has completed. The kernel receives only host canonical CRDT text.
- Ordinary guest Run Cell never invokes project-wide `synchronizeExecutionFiles()`, `executionManifest()`, `prepareWorkingCopy()` or full `flush()`. Full materialization remains explicit for host save, host transfer, final session save and the retained legacy/manual project barrier.
- Project-import semantics are therefore deliberate: the target cell itself is exact host-canonical CRDT text, while Python imports read the host physical working copy maintained asynchronously by normal persistence. A caller that requires an exact project-wide filesystem barrier must use an explicit save/transfer/manual synchronization path; ordinary guest Run Cell does not silently reintroduce that global barrier.


## Exactly-once execution and authoritative output contract (prompt 11)

- A lightweight request ID is reserved on the Session Host before any asynchronous target-cell convergence wait. The reservation stores the authenticated peer, notebook, request-identity digest and stable cell ID. An identical duplicate observes the same reservation; it never creates a second waiter or kernel execution.
- A pre-start reservation is not considered accepted. `deliverActiveRemoteExecution()` sends no `executeAccepted` until host authority and canonical target-cell validation complete. After acceptance, losing the acknowledgement is harmless because an identical retry resends the same acceptance and replays retained events from the same owner.
- Active execution ownership is independent of the current transport route. Route replacement/reconnect reuses the same owner, event sequence and request ID. Completed requests retain bounded event/result replay state until `executeResultAck` or expiry; an identical duplicate replays the cached result, while a changed digest/cell/compute epoch is rejected.
- Execution events remain zero-based and ordered. The initiator buffers gaps, drops sequences below `nextEventSequence`, deduplicates buffered sequence numbers, and defers the terminal result until `eventCount` proves every preceding event was delivered.
- The Session Host is now the sole CRDT publisher for a guest-triggered execution. Real kernel events are accumulated with the same notebook-output normalization used by the VS Code controller, and the host publishes target-cell `cellOutputs` and `cellExecution` scopes directly to the collaborative CRDT. Replay delivery never re-applies those events to CRDT, so reconnect cannot multiply authoritative outputs.
- The initiating participant still renders live execution events immediately through its local NotebookCellExecution, but when compute is remote it does not call `project.setCellOutputs()` or `project.setCellExecution()`. Host `cellExecution` state carries the bounded `requestId`; the initiator retains the latest remote request identity for the lifetime of the NotebookCell and suppresses matching CRDT output/execution echo even when that authoritative final echo arrives after the terminal result. The host CRDT copy remains authoritative without a second NotebookCellExecution/output application.
- Local host execution continues to publish through the local controller. Guest-triggered host execution publishes through SessionRuntime. In both cases one physical kernel execution yields one authoritative final CRDT output/execution state visible to every participant.
- `synchronizeExecutionFiles()` remains a legacy/explicit project-barrier mechanism. Ordinary Run Cell never enters it. Full project materialization remains available for final durable host save, host transfer and explicit/manual working-folder synchronization.
