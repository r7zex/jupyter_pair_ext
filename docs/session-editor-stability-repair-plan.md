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
- **Documented VS Code API deviation:** output/execution synchronization also uses a one-cell `NotebookEdit.replaceCells` because the implementation has no direct `NotebookEdit` for those fields. The replacement is restricted to the affected cell and preserves its current source in the targeted cell-state path. This is not equivalent to permitting broad notebook replacement.

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
