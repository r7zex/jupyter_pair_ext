# Running-cell deletion synchronization root cause

Date: 2026-09-08
Baseline: Pair Notebook 0.5.22, `e9333d32e5449a1e3d0fb08e7f01fa484b97f577`

## Reported failure

When a cell remains in an endless execution and the authoritative notebook deletes it, another participant can retain the deleted running cell. Structural changes made after that deletion, including insertion and text updates for a replacement cell, can remain invisible. Deleting the stale cell locally releases the accumulated updates.

The failure is not specific to the host UI. It is triggered on any participant that mirrors a running execution while receiving the authoritative structural deletion.

## Proven causal chain

Three defects combine into the observed stall.

### 1. Cell-state rendering can block every later notebook update

`EditorSynchronizer.flushPendingNotebookCellStates()` enqueues output and execution rendering through the same per-notebook `notebookApplyQueues` chain used by structural updates. `applyNotebookCellState()` awaits `NotebookCellStateRenderer.renderRemoteCellState()` without a deadline.

`PairNotebookController.renderRemoteCellState()` in turn awaits `NotebookCellExecution.replaceOutput()`. VS Code owns that promise and Pair Notebook places no upper bound on it. A renderer operation that does not settle therefore keeps the shared queue pending forever. The subsequent canonical `structure` update, replacement-cell insertion, metadata changes, and ordinary queued cell text all wait behind that promise.

This is a head-of-line blocking defect: the CRDT can already contain the correct deletion and later cells while the editor projection is unable to consume them.

### 2. Structural deletion does not retire the mirrored execution

A remote running state creates a `NotebookCellExecution` and stores it in `PairNotebookController.mirroredExecutions`. It is removed only by a later non-running state, controller disposal, runtime removal, or execution of the same cell locally.

When the canonical notebook no longer contains the cell, `applyNotebookSnapshot()` calculates a minimal `replaceCells` deletion but does not tell the controller that the removed cell's mirrored execution must end. No cell-state update can perform that cleanup because `applyNotebookCellState()` returns when the canonical cell snapshot is absent. The deleted cell can consequently retain both a live VS Code execution handle and an unresolved output operation.

### 3. Kernel/runtime failure does not publish a terminal CRDT execution state

`PairNotebookController.executeCell()` publishes the authoritative terminal `setCellExecution(... success)` only on its success-path continuation after `runtime.executeCell()` returns a result. If the runtime throws because the kernel dies, transport fails, rendering overflows, or execution otherwise aborts, the catch path creates an error output and the local VS Code execution ends with `success=false`, but the shared execution remains at its earlier running snapshot (normally `{ requestId }`).

Participants therefore have no authoritative terminal event with which to end their mirrored executions. An endless execution and an abruptly dead kernel converge to the same permanent remote-running state.

## Why the stale cell's local deletion appears to release everything

Removing the stale editor cell invalidates or completes the VS Code-owned execution/output operation. The shared per-notebook promise chain can then continue and consumes the already accumulated canonical structure and cell state. This makes the replacement cells appear in a burst even though their CRDT updates arrived earlier.

## Existing coverage gap

The 0.5.22 tests prove minimal insert/delete/reorder splices and normal running-to-terminal rendering independently. They do not combine:

1. a remote running execution;
2. a never-settling cell-state render;
3. canonical deletion of that cell;
4. insertion and editing after the deletion; and
5. kernel failure before terminal execution publication.

The current focused baseline suite passes, which confirms that the reported scenario is outside existing coverage rather than a failure already caught by it.

## Required repair invariants

The repair must preserve the current scoped/minimal synchronization model.

- A cell output or execution render must never block a later structural update indefinitely.
- Before deleting or replacing a cell, Pair Notebook must retire any mirrored execution owned for that exact cell object.
- A kernel/runtime failure must publish an authoritative terminal `success:false` execution snapshot when the canonical cell still exists.
- Late output or terminal events for a deleted cell must be harmless and must not recreate it.
- A low-frequency structural watchdog must compare stable cell IDs and schedule a minimal canonical splice when an event was missed or an earlier projection failed. It must not perform periodic full notebook replacement or output refresh.
- Recovery must remain per-notebook, bounded, idempotent, disposal-safe, and independent across notebooks.
- Local typing and the existing 150 ms output/execution coalescing path must remain unchanged.

## Validation boundary

Deterministic regressions can prove the queue, deletion, late-event, kernel-failure, watchdog, teardown, and notebook-isolation invariants in the repository. Packaging and CI can independently verify the shipped code. Installed VS Code and two-physical-computer acceptance remain separate manual evidence and must not be inferred from headless tests.
