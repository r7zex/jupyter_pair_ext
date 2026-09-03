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

## Acceptance scenarios

1. Switching a VPN/TUN route starts recovery immediately and the same authenticated host resumes within 30 seconds; no participant becomes host.
2. If the host remains unreachable after 30 seconds, only the guest runtime terminates, its Pair tabs close, the host is retained in Recent Sessions, and the existing host has no ghost online participant.
3. A notebook execution update touches only the executed cell and does not replace unrelated cells or move the active viewport.
4. A guest cell run reaches the host without a full manifest/file barrier, executes exactly once, and publishes one authoritative result for every participant.
5. Presence shows an active line/cell only, never a fabricated first-line cursor after a cell disappears.
