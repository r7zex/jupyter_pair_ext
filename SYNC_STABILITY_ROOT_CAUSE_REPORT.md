# Pair Notebook text synchronization and phantom line-lock root-cause report

Date: 2026-09-07

Repository: `r7zex/jupyter_pair_ext`

Investigated baseline: `bdce97d5341cd9bf92d1398422101fc9790b9e5a` (`v0.5.19`, current `origin/main`)

Scope: investigation and documentation only; no production fix is included in this branch.

## Executive conclusion

The reported behavior is not one isolated defect. It is the interaction of at least two confirmed production problems:

1. **A receiving editor can publish a non-user follow-up event as a new local CRDT edit.**
   During a remote `WorkspaceEdit`, Pair Notebook identifies the point at which the requested remote target appeared, then treats every later text event as genuine local typing. VS Code's `TextDocumentChangeEvent` does not identify the author of an edit. Therefore an editor participant, formatter, language extension, notebook text-model normalization, or another programmatic follow-up can be laundered into `LOCAL_EDITOR_ORIGIN`. A newline produced on a receiver is then written into the shared Yjs document and sent back to the host. This exactly accounts for the observed order: the host initially sees one line, the peer already sees the split text, and the host later converges to the peer's inserted newline.
2. **The line-lock policy blocks edits based on selection presence, not active typing or edit ownership.**
   Presence always publishes `typing: false`, but `lineLockMessage()` does not inspect `typing`. A remote selection, a stale selection, or a mis-mapped selection is sufficient to reject a local edit. Policy rejection deliberately bypasses the non-destructive stale-baseline recovery and queues a canonical editor rewrite. This accounts for both the false `Line is currently selected by user2` warning and the apparently blocked deletion/typing.

There are also two deterministic amplifiers in the line-lock implementation:

- an insertion at the first offset of the next line is considered to touch the previous locked line;
- a displayed editor line offset is encoded directly against canonical Yjs text, even when the displayed replica and canonical text are temporarily different.

These are source-level, deterministic failures, not speculative code-quality concerns. The exact external VS Code/editor participant that produces the first non-user tail event in a particular physical session still requires runtime tracing, but Pair Notebook's incorrect ownership decision and propagation of that event are proven independently of which participant produced it.

## User-visible symptom mapped to the implementation

### Symptom A: the receiver splits text first, then the host also splits

Observed order:

1. The host types and still sees the intended single-line text.
2. Another participant already sees the text split across lines.
3. After the host pauses, the host receives an update and also displays the split text.

Required causal fact: the receiver must have originated a shared update containing the extra newline. Merely rendering an incorrect local projection cannot change the host. On the receiver, the editor synchronization path is the component that converts a `TextDocumentChangeEvent` into a `LOCAL_EDITOR_ORIGIN` Yjs update.

Current production flow:

1. A remote Yjs update reaches `EditorSynchronizer` and queues `applyText()`.
2. `renderText()` computes a minimal `WorkspaceEdit` and installs a `PendingTextEdit` containing the displayed baseline, requested target, and captured editor events (`src/vscode/sync.ts:791-823`).
3. After `applyEdit()` succeeds, `findRemoteEchoEnd()` finds the last captured event whose reconstructed state equals the requested remote target (`src/vscode/sync.ts:1442-1452`).
4. All events after that target are passed to `publishBufferedTextEvents()` (`src/vscode/sync.ts:828-833`).
5. `publishBufferedTextEvents()` sends each such event to `publishTextChanges()`; if reconstruction is not exact, it sends the complete displayed-vs-replica diff through `publishPostApplyText()` (`src/vscode/sync.ts:897-939`).
6. `publishTextChanges()` applies the change to the private editor replica or canonical project as a local edit (`src/vscode/sync.ts:977-1000`).
7. `EditorTextReplica.edit()` merges that update into the canonical collaborative project. The transport then distributes it like any real user edit.

The ownership assumption in step 4 is invalid. "Occurred after the requested target was visible" is not equivalent to "was typed by the local user." The VS Code change event has no Pair Notebook transaction ID or editor-author identity. Pair Notebook nevertheless upgrades every tail event to user-authored shared state.

### Deterministic reproduction of the newline propagation

A temporary test probe was added to the existing VS Code boundary test, executed, and removed before this report was committed. The probe used a notebook cell with displayed/canonical text `ab`:

1. A remote operation requested `a\nb`.
2. The fake VS Code boundary emitted the correct remote echo, so the target `a\nb` was observed.
3. With no local user edit, an editor-participant tail inserted one additional `\n`, producing `a\n\nb`.
4. Pair Notebook treated the tail as local input.

The intended assertion was:

```text
editor:       "a\nb"
canonical:    "a\nb"
localUpdates: 0
```

The actual result was:

```text
editor:       "a\n\nb"
canonical:    "a\n\nb"
localUpdates: 1
```

The focused test failed exactly as expected:

```text
0 passing
1 failing
AssertionError: actual "a\n\nb" !== expected "a\nb"
```

This proves all three necessary parts of the field failure:

- a non-user receiver-side tail is accepted;
- it becomes canonical shared state;
- it produces an outbound local update that can return to the host.

The probe did not assert which installed VS Code extension or notebook editor participant produced the tail in the user's physical run. That is not necessary to establish the Pair Notebook root cause: an untrusted projection-side event must never be promoted to shared authorship without proof.

### Why the failure appears random and can affect host or guest

Every participant runs the same `EditorSynchronizer`, owns a writable CRDT replica, and is allowed to publish local Yjs updates. There is no permanently authoritative text writer.

The bug therefore depends on event timing:

- which participant is rendering a remote change;
- whether another editor participant changes the document during or immediately after that render;
- whether the requested target is visible as an intermediate state;
- whether a subsequent event is reconstructed exactly or reduced to `minimalEdit(displayed, current)`;
- when the generated Yjs update is delivered back to other peers.

The receiver is the first computer that displays the wrong line structure. The host changes only after the receiver's newly generated CRDT operation arrives. If the same interleaving happens while a guest's genuine edit is being rendered by the host, the host can be the contaminating receiver. That makes the defect symmetric even though the host owns persistence and compute.

## Root cause of phantom `Line is currently selected` rejection

### The policy uses presence selection, not active editing

`SessionRuntime.updatePresence()` publishes:

```ts
{
  activeFile,
  activeNotebookCellId,
  activeLine,
  activeLineAnchor,
  shareCursor: true,
  typing: false,
}
```

See `src/runtime/session.ts:3620-3684`.

`lineLockMessage()` checks the following remote fields:

- peer identity;
- `shareCursor`;
- active file;
- active notebook cell ID;
- resolved line anchor/line number.

It does **not** check `typing`, editor focus, an active edit transaction, a recent keystroke timestamp, or a lock lease. See `src/runtime/session.ts:1616-1646`.

Consequently, the warning text says "selected," and the implementation really does make mere selection exclusive. A participant does not need to be typing. A selection can also remain semantically active while the user is looking at another panel/window or while an awareness update is delayed. The hard rejection is therefore expected from the current policy even when no participant believes they are actively editing that cell.

### Confirmed adjacent-line false positive

`lineEndOffset()` includes the trailing newline in the locked interval. For an insertion, `changeTouchesLine()` uses an inclusive end comparison:

```ts
return change.rangeLength === 0
  ? start >= lineStart && start <= lineEnd
  : start < lineEnd && end > lineStart;
```

See `src/runtime/session.ts:6394-6408`.

For canonical text `one\ntwo`:

- first line start = `0`;
- first line end = `4` (the offset immediately after `\n`, also the start of line two);
- typing at the start of line two has `rangeOffset = 4` and `rangeLength = 0`;
- the predicate `4 >= 0 && 4 <= 4` is true.

Therefore a participant selecting line one can block another participant typing at the start of line two. This is a deterministic off-by-one policy error.

### Confirmed wrong-line anchor risk during replica divergence

`lineAnchorForEditor()` obtains a numeric line-start offset from the VS Code document and passes that offset directly to `encodeRelativeOffset()` for the canonical project Y.Text (`src/runtime/session.ts:3687-3697`).

That conversion assumes:

```text
displayed editor text at offset N == canonical Y.Text at offset N
```

The editor synchronization architecture explicitly permits those baselines to differ while remote changes are queued or rebased. `EditorTextReplica.canonicalChanges()` exists precisely because raw displayed offsets cannot always be used against canonical text. Presence publication does not use that mapping. If a newline exists in only one baseline, every following line-start offset can point at a different logical canonical line. A peer can therefore publish a valid CRDT-relative anchor for the wrong visible line.

This creates a direct feedback loop:

1. text projection temporarily diverges;
2. presence encodes a displayed offset against a different canonical baseline;
3. another participant receives a lock for the wrong line;
4. their valid edit is rejected;
5. canonical restoration changes their displayed text and creates more projection activity.

### The rejection path is intentionally destructive

`publishTextChanges()` throws `EditorPolicyRejection` when `lineLockMessage()` returns a message (`src/vscode/sync.ts:981-985`).

`recoverRejectedText()` explicitly refuses to recover/rebase an `EditorPolicyRejection` (`src/vscode/sync.ts:1153-1162`). The catch path then calls `restoreRejectedText()`, which queues `applyText(document, canonical)` (`src/vscode/sync.ts:1138-1144`, `1184-1191`).

Thus the warning and the visible rollback are one operation:

```text
selection presence -> EditorPolicyRejection -> no rebase -> canonical WorkspaceEdit
```

This explains why deletion or recently typed text appears to be blocked or restored. It is not network latency alone; the application deliberately rejects the local operation and rewrites the editor.

## Relationship to versions 0.5.12 and 0.5.13

The suspected release boundary is slightly different from the Git history:

- `d7308cf8e41941a8f4d135e955ed448522fc694b` introduced the hard line-lock behavior and is already contained in `v0.5.11`.
- `e6730f647491ec0edff4536659dfbf71ae6febe1` introduced `EditorTextReplica` and the remote render/echo architecture and is first contained in `v0.5.12`.
- `v0.5.12` points to `3dbe7ce8cb6892ff553810c19651b5cebf763ce3`.
- `v0.5.13` points to `04544ad97695871abe337627bd583223e4133af2`, whose parent is the `v0.5.12` commit.
- `git diff --exit-code v0.5.12..v0.5.13 -- src` exits `0`: there is no source-code change between those tags.
- The `0.5.12 -> 0.5.13` diff changes only release workflow/documentation/package version files.

Therefore `0.5.13` did not introduce a new safe synchronization mode. A user who first installed or exercised this code in `0.5.13` would naturally associate the regression with that release, but the responsible text-replica implementation was already in `0.5.12`; the line lock predates both.

Later changes repaired important subcases without removing the invalid ownership model:

- `d541cf2`: accepted split/reshaped remote echoes for issue #12;
- `fc03b1e`: replaced the exact `version + 1` assumption with buffered transition reconstruction;
- `dd9fed0`: preserved initial typing and rebased line-lock checks;
- `f837e86`: canceled stale renders and reused incremental replicas;
- `4c78b9a`: stopped renders before teardown completed;
- `40d87e7`: added stale-baseline recovery and notebook output/text prioritization.

Those changes substantially reduce known races, but the current `fc03b1e` rule still says that post-target captured events are local input. The deterministic probe above exercises that remaining rule on `v0.5.19`.

## Why existing automated tests pass

The focused current suites completed successfully:

```text
npm.cmd run compile
npx.cmd mocha --timeout 15000 --exit \
  out/test/editorSync.integration.test.js \
  out/test/presencePublication.test.js

83 passing
```

The two focused lock/rollback tests also pass:

```text
npx.cmd mocha --timeout 15000 --exit \
  out/test/presencePublication.test.js \
  out/test/editorSync.integration.test.js \
  --grep "remote line lock|participant-selected line"

2 passing
```

Those passing tests confirm the current behavior; they do not prove the desired stability property.

The existing echo tests are strong at reconstructing event sequences, version jumps, hidden intermediate targets, newlines, and concurrent edits. However, the test boundary and production code share an unproven semantic assumption: an event after the remote target is considered local input. Tests preserve such a tail and call that preservation success. They do not tag a tail as "programmatic/non-user" and assert that it produces zero CRDT updates.

The temporary adversarial probe changed only that ownership premise. It reached the correct target first, then emitted a non-user tail. Production code published the tail and the test failed with editor/canonical corruption and one outbound update.

The presence tests likewise verify that a selected remote line blocks another participant and that rejection restores canonical text. They encode the current policy rather than the requested stability-first behavior.

## Recommended stability-first design

### Decision

Use a permanently host-authoritative text protocol and remove hard line-lock enforcement. Do not implement a blind full-cell replacement on every keystroke.

The host should be authoritative for the lifetime of the session, not only during a recovery window. If the host is unreachable, shared canonical editing should pause or queue explicit edit intents until the same host returns. A guest must never silently become the canonical text authority after a timeout. This directly matches the requested priority: predictable text over temporary offline write availability.

### Why continuous full snapshots are not the preferred mechanism

Replacing every cell with the host snapshot after every keystroke would eventually force convergence, but it would introduce its own instability:

- cursor/selection movement;
- undo-stack destruction;
- high bandwidth and render churn;
- lost in-flight guest typing;
- repeated notebook-cell text model recreation;
- a larger window for extension/editor participant follow-up events.

Authority should be enforced at the operation protocol, with snapshots used as repair/checkpoints.

### Target protocol

1. **Host sequence.** Maintain a monotonically increasing text revision per file/cell, owned by the session host.
2. **Guest intent.** A guest sends an edit intent containing document key, stable cell ID, base host revision, unique operation ID, and immutable text deltas captured from a known displayed baseline.
3. **Host serialization.** The host validates/rebases the intent against its current revision, applies it once, increments the revision, and broadcasts the accepted operation plus resulting digest.
4. **Acknowledgement.** The originating guest matches the operation ID and advances its optimistic editor state only when the host acknowledges it.
5. **Receiver suppression.** Applying an accepted host operation to VS Code creates a render transaction. Text events from that transaction are projection echoes and are never allowed to create a new shared operation. A post-target editor participant event is either discarded/re-rendered to host state or retained only as an unshared local draft until converted into a new explicit user intent.
6. **Digest repair.** Periodically compare a host revision/digest. On mismatch, request a host snapshot and replace only the affected cell/file after the text-apply queue is quiescent.
7. **Host loss.** Mark collaboration read-only/queued while the permanent host is unreachable. Do not elect a temporary text authority if stability is the priority.

This removes the circular update path:

```text
host operation -> guest projection -> projection tail -> new canonical operation
```

and replaces it with:

```text
guest intent -> host serialization -> accepted host operation -> projection-only render
```

### Line-lock policy

Remove `lineLockGuard` from the text publication path. Presence should be advisory UI only: show participant cell/line highlights, but never reject or restore text because of a selection.

If conflict avoidance is later desired, use a short explicit editing lease based on actual accepted intents, with host-issued expiry and no destructive rollback. It should not be inferred from cursor/selection presence.

## Minimal interim repair if host-authoritative protocol cannot ship immediately

The following is a containment plan, not the final architecture:

1. Disable hard line-lock rejection and canonical restoration for selection conflicts.
2. Fix `changeTouchesLine()` so a zero-length insertion at `lineEnd` belongs to the next line, not both lines.
3. Map presence line offsets through the displayed `EditorTextReplica` into canonical text before creating a relative anchor.
4. Stop calling `publishBufferedTextEvents()`/`publishPostApplyText()` for unproven events captured inside a remote render transaction. Stability-first behavior should restore the accepted remote target instead of broadcasting ambiguous tails.
5. Add an explicit render transaction ID and log every captured transition: URI, cell ID, document version, baseline digest, target digest, result digest, event count, and whether an outbound local update was generated. Do not log source text.
6. Add a bounded host snapshot/digest repair after render queues become idle.

Step 4 may sacrifice a keystroke typed at the exact instant a remote render is pending. That is preferable to converting a non-user newline into canonical state and contaminating every participant. The host-authoritative intent protocol is the correct way to preserve both stability and concurrent input.

## Required regression tests before declaring the defect fixed

### Deterministic adapter tests

- Remote target is reached, then a non-user newline tail fires: zero outbound updates and canonical remains the remote target.
- Same case with deletion, indentation, auto-closing bracket, and multi-change tail.
- Tail before target, between split echo events, after target, and after `applyEdit()` resolution.
- No exact intermediate target appears.
- Document version advances by more than one.
- Follow-up real keystroke after each case maps to the correct host revision.
- Assertions cover all four states: VS Code document, displayed replica, canonical host text, and second peer.

### Presence/lock tests

- A remote selection with `typing: false` never rejects an edit.
- An inactive/window-blurred participant never blocks a line.
- Insertion at the beginning of the next line is not attributed to the previous line.
- A displayed/canonical newline mismatch cannot move the published presence anchor to another logical line.
- Presence packets from a disconnected/reconnected peer cannot retain a blocking state.

### Physical installed-VS-Code acceptance

Use two installed VS Code instances and the packaged VSIX, not only the mocked boundary:

- host types continuously for at least five minutes while guest observes;
- guest types continuously while host observes;
- both alternate rapid typing, Enter, Backspace, Delete, paste, undo, and redo;
- Python auto-indent and bracket completion enabled;
- format-on-type and common notebook/language extensions enabled;
- temporary network loss and reconnection without host-authority transfer;
- active editor moved between cells, terminal, side bar, and another window;
- assert no phantom newline, no joined line, no duplicated character, no `Rejected unsafe notebook cell update`, and exact text hash equality after every idle checkpoint.

Automated/package success must not be reported as physical acceptance.

## Evidence summary

| Claim | Evidence |
|---|---|
| `0.5.12 -> 0.5.13` introduced no source change | `git diff --exit-code v0.5.12..v0.5.13 -- src` returned `0` |
| Post-target tail is published as local | `sync.ts:828-833`, `897-939`, `977-1000` |
| Non-user newline contaminates canonical and emits an update | temporary deterministic probe: editor/canonical `a\n\nb`, `localUpdates=1` |
| Locks are selection-based, not typing-based | `session.ts:1616-1646`, `3620-3684` |
| Next-line insertion can touch previous locked line | `session.ts:6394-6408` plus offset example above |
| Wrong-line anchor is possible under replica divergence | `session.ts:3687-3697` uses editor offset directly against canonical Y.Text |
| Policy rejection causes canonical rewrite | `sync.ts:981-985`, `1138-1144`, `1153-1162`, `1184-1191` |
| Existing tests encode lock/rollback as success | focused lock tests: `2 passing` |
| Existing sync/presence suites do not catch ownership failure | current focused suites: `83 passing`; adversarial ownership probe fails |

## Final assessment

The newline defect is not fixed by adding more special cases to echo shape matching. The current adapter has no reliable authorship boundary between a remote render and editor-side follow-up changes, yet it grants those changes full local CRDT authority. The line-lock mechanism then uses potentially stale/mis-mapped selection presence to reject edits and force canonical rewrites. Together they form a feedback loop that can create, propagate, and then enforce corrupted line structure.

For the requested priority, the correct resolution is:

1. remove selection-based hard rejections;
2. stop promoting ambiguous render-tail events;
3. move text authority permanently to the session host with sequenced edit intents and digest/snapshot repair;
4. pause or queue shared editing during host loss instead of transferring canonical authority after a timeout.

No production code was changed as part of this report.
