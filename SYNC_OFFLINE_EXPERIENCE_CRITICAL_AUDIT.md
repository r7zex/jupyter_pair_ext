# Critical audit: offline-like collaborative editing

Date: 2026-09-13.

Audited version: **Pair Notebook 0.5.29**, GitHub `main`, commit [`119081736b4b757df66aea54210f4dd6f424b8df`](https://github.com/r7zex/jupyter_pair_ext/tree/119081736b4b757df66aea54210f4dd6f424b8df). The remote branch still pointed to this commit at the final check.

The user selected current GitHub `main` rather than the original dirty local 0.5.16 checkout. Production code was inspected and compiled in the separate `pair-notebook-sync-audit-20260913` worktree. This audit did not change production code or the user's existing modifications.

## Verdict

**The requirement that local writing feel identical to offline writing is not met. One critical root cause was confirmed: genuine local input can be discarded after a remote text edit.** It affects both ordinary text files and notebook-cell source. The same root cause can keep discarding a continuous sequence of input and can discard an entire multi-cursor edit.

Only this confirmed, practically relevant defect is included as a finding. The audit does not establish a percentage of production sessions affected or certify that all other interactions are equivalent to offline editing.

## P1 — Post-projection quarantine silently removes genuine input

Status: reproduced on the audited commit; existing GitHub [issue #19](https://github.com/r7zex/jupyter_pair_ext/issues/19) was **OPEN** when checked. This is a confirmed remaining defect, not a newly discovered issue.

### Everyday trigger and visible result

A collaborator changes text on a line. Within 100 ms after that change is rendered locally, the user continues editing that same line. The local character appears in the document event stream, but the synchronizer restores the shared text without that character. The character never reaches canonical Yjs state and is not published to collaborators.

Example reproduced for both a file and a notebook cell:

```text
Initial:                 remote = 0\nlocal = 0
Collaborator changes:    remote = 1\nlocal = 0
User inserts !:          remote = 1!\nlocal = 0
Actual final editor:     remote = 1\nlocal = 0
Actual shared state:     remote = 1\nlocal = 0
Local publications:      0
```

The reproduction delivers a genuine Yjs update from a second `CollaborativeProject`, waits for the production editor projection to finish, and then emits a separate local edit. It does not inject that edit into an unfinished remote-render event. The local event is still rejected because the subsequent quarantine is active.

This directly affects simultaneous editing of an expression or line. It is input loss rather than just delayed delivery. The timing condition is an explicit 100 ms window after every applicable remote projection.

### Why the interruption can last longer than 100 ms

The corrective render that removes the user's input arms another quarantine. Consequently, continuing to type or repeat a key can keep extending the interval during which the input is discarded, even after the collaborator stops editing.

Controlled reproduction after **one** remote update:

| Local input | File result | Notebook-cell result |
|---|---|---|
| 20 insertions, 80 ms requested interval | 20/20 lost; 0 local publications; about 1.76 s | 20/20 lost; 0 local publications; about 1.76 s |
| 20 insertions, 130 ms requested interval | First insertion lost; next 19 retained | First insertion lost; next 19 retained |

Intervals are requested timer delays; elapsed times are observations from this run, not UI latency measurements or a benchmark of a physical keyboard.

### Multi-cursor consequence

The overlap decision applies to the entire `TextDocumentChangeEvent`. If one change overlaps a protected line, all changes in the event are suppressed.

With a protected first line, simultaneous insertion of `!` at the ends of both lines produced this result in both document types:

```text
Expected: remote = 1!\nlocal = 0!
Actual:   remote = 1\nlocal = 0
```

The second insertion is lost even though its line is outside the protected range. This is another consequence of the same input-suppression decision, not a separate finding.

### Exact cause

All source links below are pinned to the audited commit.

1. [`src/vscode/sync.ts:35`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/src/vscode/sync.ts#L35) defines `REMOTE_TEXT_QUARANTINE_MS = 100`.
2. [`renderText()`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/src/vscode/sync.ts#L949-L955) arms a quarantine after a successful `workspace.applyEdit()`.
3. [`armProjectionQuarantine()`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/src/vscode/sync.ts#L990-L1009) resets its expiry to the current time plus 100 ms.
4. [`suppressProjectionTail()`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/src/vscode/sync.ts#L1017-L1059) checks time and line overlap. It has no positive evidence that the overlapping event is actually a delayed remote-projection echo. For any overlap, it calls `applyText()` with current canonical text and returns `true`.
5. [`onTextChanged()`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/src/vscode/sync.ts#L849-L875) and [`onNotebookCellTextChanged()`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/src/vscode/sync.ts#L1358) return before publishing the user's edit. The corrective projection subsequently starts another quarantine.

### Why passing existing tests does not clear this defect

The real Extension Host regression is explicitly disabled with `test.skip` at [`test/e2e/extensionHost.e2e.ts:181`](https://github.com/r7zex/jupyter_pair_ext/blob/119081736b4b757df66aea54210f4dd6f424b8df/test/e2e/extensionHost.e2e.ts#L181-L200). Its comment links to issue #19. Several integration cases wait for quarantine expiry before checking follow-up typing, or deliberately assert that an ambiguous tail is removed. Those expectations do not prove that a genuine local edit inside the window survives.

The current different-line exception works in the controlled single-cursor case. It leaves the same-line case and the multi-cursor consequence above unresolved.

### Acceptance criteria for a fix

- Genuine typing, deletion, paste and multi-cursor edits following a remote projection reach canonical state exactly once and remain visible.
- Sustained local input cannot renew a suppression window that keeps discarding subsequent input.
- A protected range cannot discard unrelated edits from the same event.
- Actual delayed or reshaped remote echoes still cannot create duplicate characters or newlines in shared state.
- Enable the existing skipped E2E regression and verify it in real VS Code, including notebook cells. Retain the existing replay and concurrent-edit regressions.

## Verification performed

Commands executed in `pair-notebook-sync-audit-20260913`:

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run compile
.\node_modules\.bin\mocha.cmd --timeout 15000 --exit out/test/editorSync.integration.test.js out/test/editorSync.replayStress.test.js out/test/editorTextReplica.test.js out/test/initialTextChanges.test.js --reporter dot
.\node_modules\.bin\mocha.cmd --timeout 15000 --exit out/test/runtime.integration.test.js --grep 'replicates local-first guest text through the real encrypted runtime route' --reporter spec
node audit/typing-probe.cjs
```

Results:

- Compilation passed.
- **125** existing focused editor, replay, replica and initial-binding tests passed.
- **1** focused encrypted-runtime local-first replication test passed. This verifies the repository's integration route; it is not a physical two-computer network acceptance test.
- **14** audit scenarios ran against production `EditorSynchronizer`, production `CollaborativeProject` and the repository's controlled VS Code boundary: eight single-edit timing/line controls, four sustained-input cases, and two multi-cursor cases. Results are recorded in `audit/typing-results.json`. The probe asserts the observed defect and its controls; its successful exit does not mean the product meets the requested behavior.
- Positive controls confirmed that input is published immediately when there is no recent remote projection, on an unrelated line in a single-cursor edit, and after the quarantine expires.

Reproduction scripts and raw results remain in the separate worktree's `audit/` directory. They load the compiled existing test harness without modifying production files or the existing tests.

## Real VS Code verification boundary

A fresh isolated Extension Host run was attempted using the installed `E:\Microsoft VS Code\Code.exe` (installation manifest: 1.136.1). It exited before running the audit scenarios:

```text
checkInnoSetupMutex: vscode-updating still held after 31247ms, giving up
Error: Code is currently being updated. Please wait for the update to complete before launching.
```

The log is `audit/real-editor-console.log`. Therefore this audit claims fresh deterministic production-path reproduction, not a successful new installed-VS-Code or physical two-computer run. The native typing and Undo probes did not run; no Undo finding is asserted.

Issue #19 separately records earlier real Extension Host reproduction on Windows, Linux, macOS and minimum VS Code 1.95.0. That is prior repository evidence read during this audit, not fresh cross-platform testing performed here. Its historical description predates the current different-line exception; the same-line defect remains reproduced on the audited revision.
