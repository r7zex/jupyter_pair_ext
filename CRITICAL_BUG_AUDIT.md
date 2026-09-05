# Critical functional bug audit

Audit date: 2026-09-05. Source version: 0.5.11.

Audited commit: `d7308cf8e41941a8f4d135e955ed448522fc694b`.

Branch: `codex/networking-root-cause-repair`.

Status: **11 confirmed functional defects; no fixes applied.** This report is the only intended tracked change. No release, tag, dependency, configuration, or implementation changes are part of this audit.

## Scope and interpretation

The requested scope is connection/bootstrap/reconnect, collaborative editing and synchronization, and the shared notebook interpreter. "Critical" here means a broken core workflow: a participant cannot finish joining, edits or shared state are lost, the wrong filesystem/kernel is used, or execution cannot be controlled as requested. These are functional findings, not CVSS security ratings.

Every finding below identifies its required conditions. A deterministic failure **under those conditions** does not mean every session fails. In particular, CB-002, CB-003, and the rendering consequence of CB-004 depend on a specified ordering of normal asynchronous editor events. Their reproductions explicitly control that ordering; no claim about their incidence in physical sessions is made. The audit did not establish an unconditional blocker for two fresh participants joining a small project on a working network.

The audit combines production-source review, the full existing test suite, and additional deterministic probes. It is a bounded audit of this commit, not a mathematical guarantee that no other defect exists. Obsolete findings from previous versions were not copied into this list.

## Findings at a glance

| ID | Broken workflow | Trigger | Evidence |
| --- | --- | --- | --- |
| CB-001 | Guest execution reads stale host files | Dependency/data file open and dirty on host | Real Jupyter + production runtime and editor persistence path |
| CB-002 | Local typing disappears from shared state | Local edit arrives while a remote editor edit is awaiting completion | Production EditorSynchronizer with controlled VS Code API completion |
| CB-003 | Adding/moving a cell overwrites a collaborator's text | Canonical remote update has arrived but editor reconciliation is queued | Production editor/CRDT paths with controlled queue |
| CB-004 | Execution echo protection breaks | Native execution-summary event republishes state without request ID | Production summary conversion and renderer; documented API constraint enforced |
| CB-005 | New participant cannot follow later host transfers | Join using a fresh invite after an earlier host transfer | Two production runtimes and authenticated in-memory transport |
| CB-006 | Joining/reconciling a large live notebook fails | Individually accepted outputs grow one CRDT update beyond wire limit | Production CRDT setters/encoder and wire encoder |
| CB-007 | Renaming a notebook loses interpreter continuity | Execute, rename notebook, execute again | Real Jupyter through production runtime |
| CB-008 | Pair-labelled Run action can run a local/native kernel | A different VS Code notebook controller is selected | Production command dispatch + installed VS Code API declarations |
| CB-009 | Type-changing file exists twice in materialization | Previously collaborative file becomes binary | Two production runtimes, real filesystem/binary transfer |
| CB-010 | Guest Interrupt/Restart waits behind a joining participant | Host is processing an unfinished snapshot | Production inbound queues and kernel-command handler |
| CB-011 | Stop during Run All still runs subsequent cells | A multi-cell request is interrupted during its first cell | Production NotebookController and execution queue |

All entries warrant fixing before claiming reliable support for their corresponding workflows. The order groups related problems; it is not a claim that every entry has the same frequency or blast radius.

## CB-001 — Guest execution reads stale dependencies even after flush

**Impact:** A guest can receive a successful execution result computed from old Python modules, configuration, or data. Waiting for the normal persistence debounce does not fix the open-file case. This can silently invalidate a paired experiment.

**Locations:** `src/runtime/session.ts:1201-1294`, `src/runtime/session.ts:5594-5599`, `src/runtime/session.ts:5938-5955`; `src/vscode/sync.ts:121-168`; `src/core/persistence.ts:83-130`.

**Cause:** Normal guest execution always uses the lightweight path. It checks the target cell's canonical revision/digest, then passes `materializeWorkspace = false`. Consequently `executeLocally()` skips both `prepareWorkingCopy()` and `flush()`. Normal persistence delegates open files to `persistWorkingCopy()`, which updates their editor content and returns `true` without saving them. Storage treats this as handled and does not write their physical working-copy files. The backing copy can therefore be current while the directory used by Python remains stale indefinitely.

**Reproduce:**

1. On the host, save `helper.py` containing `VALUE = 1`, and keep it open.
2. Change its shared/editor content to `VALUE = 2` without explicitly saving the working file. Let ordinary flush complete.
3. From a guest, run `print(open("helper.py").read().strip())` in a shared cell.
4. Compare Python's output with the canonical shared text.

**Observed:** The real kernel completed successfully and printed `VALUE = 1`; canonical text was `VALUE = 2`; physical host working-file content was still `VALUE = 1`. The probe used the production open-file persistence methods and the production lightweight request handler. `open()` avoids confusing this defect with Python's import cache.

**Expected:** Execution reads the agreed current dependency state, or explicitly rejects a run that cannot meet that guarantee. The target cell digest alone does not establish dependency freshness.

**Repair acceptance:** Cover an already-open host file, a closed file with a pending write, and a guest-originated dependency change. Verify actual Python file reads, not just CRDT equality. Preserve immediate editing without introducing per-keystroke saves.

## CB-002 — Remote-apply flag discards unrelated local typing

**Impact:** A local character can remain visible in VS Code while never entering Yjs or reaching the partner. A later reconciliation/save can erase it.

**Locations:** `src/vscode/sync.ts:549-576`, `src/vscode/sync.ts:580-597`, `src/vscode/sync.ts:692-721`.

**Cause:** `applyText()` sets a flag for the entire document URI and keeps it set across `await vscode.workspace.applyEdit(...)`. Both ordinary-file and notebook-cell text listeners drop every change while that flag is set. There is no check that the discarded event actually belongs to the remote edit, and no buffering/rebasing of a user's concurrent edit.

**Deterministic event order:**

1. Editor and CRDT contain `abc`.
2. Receive a remote insertion of `R` at offset zero. CRDT is now `Rabc`.
3. Hold completion of the normal remote `applyEdit` request.
4. User appends `L` to the still-visible `abc`; deliver that local change event.
5. Complete the remote editor edit.

**Observed:** Editor = `RabcL`; canonical CRDT = `Rabc`. The local event was silently ignored. This uses a delayed API boundary, not a modified synchronizer. The same URI-wide suppression exists for notebook cell text.

**Expected:** Distinguish the remote edit's echo from intervening local changes and preserve both authors' input. Applying raw editor offsets to a newer canonical buffer also needs a consistent editor version/baseline.

**Repair acceptance:** Deliver a local keystroke before, during, and immediately after an asynchronous remote apply, including edits on different lines. Assert identical editor and replica text with both contributions retained.

## CB-003 — Structural notebook edits write stale fields back over remote state

**Impact:** A normal insert/delete/move can erase a collaborator's already-received source change in a different cell. Outputs, execution metadata, and notebook metadata are exposed to the same whole-snapshot overwrite pattern.

**Locations:** `src/vscode/sync.ts:171-228`, `src/vscode/sync.ts:623-631`, `src/vscode/sync.ts:841-856`; `src/core/crdt.ts:281-332`.

**Cause:** Any local `contentChanges` event calls `reconcileNotebook()` with a snapshot of every current editor cell. Remote application is asynchronous. `reconcileNotebook()` replaces each existing cell's source if it differs and rewrites its metadata/outputs/execution, even when the user's action only changed the cell structure. An out-of-date editor snapshot is thus treated as a new authoritative edit.

**Reproduce:** Start with cell A containing `OLD`. Receive `REMOTE` into A's Y.Text, while its editor apply remains queued. Insert cell B locally and deliver the structural event before draining the remote queue.

**Observed:** Canonical A changed back from `REMOTE` to `OLD`. The structural reconciliation itself generated the rollback; no lost packet was required.

**Expected:** A structural change modifies the intended structure and fields of newly inserted cells. It must preserve unrelated canonical fields updated by another participant.

**Repair acceptance:** Delay remote rendering, then insert/move/delete another cell; remote source, outputs, execution identity, and metadata must survive. Include actual editor event paths rather than testing Yjs convergence alone.

## CB-004 — Native execution-summary echo removes the shared request identity

**Impact:** The initiator's authoritative-echo suppression can stop working during execution. A subsequent shared-state render can attempt a second `NotebookCellExecution` for an already-running cell, which VS Code forbids, leaving remote output/execution rendering failed.

**Locations:** `src/vscode/sync.ts:623-688`, `src/vscode/sync.ts:1028-1035`; `src/core/crdt.ts:408-423`; `src/vscode/jupyterController.ts:106-125`, `src/vscode/jupyterController.ts:250-256`.

**Cause:** Runtime execution state includes a `requestId`. VS Code's native `executionSummary` contains order/success/timing, but no Pair request ID. The ordinary notebook-change listener converts that summary with `executionFromCell()` and replaces the entire CRDT execution object. It neither preserves the request ID nor restricts such publication to the host. The renderer suppresses initiator echoes only when the incoming request ID matches its WeakMap entry.

**Reproduce:**

1. Shared cell execution is `{requestId: "host-request", executionOrder: 1}`.
2. Deliver a normal native summary update `{executionOrder: 1}` for the running cell through `onNotebookChanged()`.
3. Render the resulting shared state on an initiator that is already executing `host-request`.

**Observed:** CRDT state becomes `{executionOrder: 1}`. The production renderer attempts another cell execution. A boundary enforcing the installed VS Code API's one-active-execution-per-cell rule rejects it. The declaration of that rule is in `node_modules/@types/vscode/index.d.ts:15427-15441` for the pinned API version.

**Evidence limit:** Request-ID loss and the renderer's duplicate-execution attempt were reproduced locally. The exact extension-host event timing was not validated in an installed two-window VS Code session. The probe explicitly supplies the native summary event and active-execution precondition.

**Expected / repair acceptance:** Native output/summary events must preserve canonical request ownership and must not let an initiator overwrite the host's execution identity. Test the synchronizer and controller together with native change events and enforcement of the one-execution rule.

## CB-005 — Invites after host transfer initialize new peers with the wrong host epoch

**Impact:** Joining appears successful, but the new participant does not share the actual authority clock. Later host-transfer preparation/announcements cannot be accepted normally; pause/readiness heartbeats with the real clock are ignored.

**Locations:** `src/core/types.ts:159-169`, `src/core/types.ts:187-202`; `src/extension.ts:359-375`, `src/extension.ts:651-670`; `src/runtime/bootstrap.ts:116-126`; `src/runtime/session.ts:2592-2601`, `src/runtime/session.ts:2890-2938`; `src/core/election.ts:85-96`.

**Cause:** A fresh invite contains the session epoch and current host identity but omits the host epoch. Both snapshot bootstrap and the new session descriptor hardcode `hostEpoch: 0`. A transferred host is already at epoch 1 or later. No authenticated initial-state path adopts that current epoch. Heartbeats require exact clock equality, and voluntary transfer requires exactly local epoch + 1.

**Reproduce:** Transfer host A to B, choose B's backing folder, copy B's fresh invite, and join C. Then transfer from B to C, or send an authenticated pause heartbeat from B.

**Observed:** A production runtime at host epoch 1 admitted a fresh guest initialized exactly as the join path does. Guest remained at epoch 0 after startup. Delivering an epoch-1 pause heartbeat and an epoch-2 transfer preparation to the production handler with the pinned host's source ID neither paused it nor created a prepared transfer. The startup used authenticated transport; the two follow-up control frames were supplied directly at the runtime handler boundary. The probe initialized the post-transfer host clock directly; the existing suite separately exercises the actual A-to-B transfer.

**Expected:** A new participant pins both the current host identity and the authenticated current authority epoch. This must not reintroduce arbitrary epoch adoption from unrelated peers.

**Repair acceptance:** Perform a real transfer, then create a new invite and admit a third runtime. All clocks must match, and a second transfer involving that newly joined runtime must finish. Include subsequent pause/resume and descriptor restore.

## CB-006 — Accepted per-cell outputs can make the notebook impossible to send to a joiner

**Impact:** A notebook accumulated during a valid live session can no longer be sent through initial CRDT state synchronization. The host logs a wire-limit failure and never sends that transfer's `stateEnd`; the guest startup times out. This is a deterministic connection failure once the notebook exceeds the framing limit.

**Locations:** `src/core/crdt.ts:54-61`, `src/core/crdt.ts:380-390`, `src/core/crdt.ts:664-698`; `src/runtime/session.ts:3154-3163`, `src/runtime/session.ts:821-828`; `src/core/wire.ts:1-22`; `src/runtime/mesh.ts:3227-3232`.

**Cause:** `setCellOutputs()` enforces per-cell output limits but not an aggregate notebook-state limit. The 48 MiB aggregate check is only in full snapshot normalization, which incremental output setters bypass. `sendProjectState()` serializes the entire notebook Y.Doc into one `stateDocument` frame. Its failure aborts the loop before `stateEnd`. CRDT state frames have a 64 MiB payload allowance; the overall encoder has a corresponding bounded frame size.

**Reproduce:** Create five ordinary code cells and give each approximately 10 MiB of output bytes. Each cell remains below the 16 MiB renderer budget and its Base64/JSON representation below the 32 MiB per-cell CRDT limit. Then admit/reconcile a fresh participant.

**Observed boundary proof:** All five production output setters accepted the synthetic output blobs. `encodeUpdate()` produced **69,906,759 bytes**. Passing that update to the production wire encoder as `stateDocument` threw `Pair Notebook frame exceeds the wire size limit.` The production sender has no document-level chunking fallback.

**Evidence limit:** The size/encoder failure was reproduced directly; a physical large-project join was not run. The existing bootstrap supports file chunks, but that does not change the subsequent runtime CRDT framing path.

**Expected / repair acceptance:** No accepted live state should become unjoinable solely because sending it uses a smaller incompatible limit. Exercise accumulating outputs across cells, full-state join, reconnect, save/reload, and error cleanup. An explicit aggregate limit must reject before committing unusable state, or the protocol must transport it safely.

## CB-007 — Notebook rename leaves the interpreter under its old path

**Impact:** The next execution after a notebook rename runs in a fresh interpreter and loses existing variables. The previous interpreter remains allocated under the obsolete path. Renaming a running notebook also disconnects the visible path from the kernel addressed by Interrupt/Restart.

**Locations:** `src/runtime/session.ts:3804-3838`, `src/runtime/session.ts:2838-2888`, `src/runtime/session.ts:1567-1584`, `src/runtime/session.ts:5938-5988`; `src/core/crdt.ts:146-177`.

**Cause:** Rename updates CRDT documents, file-state maps, binaries, and directories. It does not migrate or retire `kernels`, `kernelStatuses`, `kernelLastUsed`, or execution ownership keyed by notebook path. `executeLocally()` looks up kernels using the new path and starts another one.

**Reproduce:** Run `x = 42` in `work.ipynb`; rename it to `renamed.ipynb` through the Explorer rename path; run `print(x)`.

**Observed with real Jupyter:** The second run failed with `NameError`. The runtime retained two kernel entries: `work.ipynb` and `renamed.ipynb`.

**Expected / repair acceptance:** Rename preserves the running notebook's interpreter identity and its control routing, or performs an explicit coordinated cancellation/restart with visible state. It must not silently leave the old kernel alive while showing the renamed notebook as the same shared work. Test file and containing-folder renames, including a running cell.

## CB-008 — The Pair Run action delegates to whichever notebook controller VS Code selected

**Impact:** The action labelled "Run Active Cell on Compute" can execute on a participant's local/native kernel instead of the session host. Remote host execution/interrupt semantics do not apply to that run.

**Locations:** `src/extension.ts:199`; `src/runtime/session.ts:1192-1199`; `src/vscode/jupyterController.ts:35-74`; `package.json` contribution for `pairNotebook.runActiveCell`.

**Cause:** `executeActiveCell()` invokes the generic `notebook.cell.execute` command. It does not call the Pair controller or verify its selection. Setting `NotebookControllerAffinity.Preferred` changes presentation preference; it is not controller selection. The pinned VS Code declarations describe this at `node_modules/@types/vscode/index.d.ts:15483-15491`.

**Reproduce:** Select a native Python/Jupyter kernel for a shared notebook, then invoke the Pair-specific Run action. A restored notebook with an existing non-Pair selection is another relevant setup.

**Observed boundary proof:** The production Pair action emitted exactly `[["notebook.cell.execute"]]`, with no controller selection/identifier or direct Pair execution dispatch. The native-kernel consequence follows from that command's selected-controller routing; installed VS Code UI execution was not run during this audit.

**Expected / repair acceptance:** A Pair-specific command either dispatches to Pair's shared executor or explicitly requires selecting the Pair controller before a run. Test with a different controller already selected, not only with Pair preselected.

## CB-009 — A file changing from collaborative text to binary retains stale CRDT state on receivers

**Impact:** One path simultaneously becomes a text/notebook document and a binary in the receiver's materialization manifest. Host-folder materialization rejects duplicate paths; a receiver that becomes host can no longer materialize that state normally. On a receiving current host, the same defect contaminates subsequent snapshot manifests.

**Locations:** `src/core/projectFiles.ts:224-235`; `src/runtime/session.ts:3867-3912`, `src/runtime/session.ts:4147-4196`, `src/runtime/session.ts:4950-5002`, `src/runtime/session.ts:3406-3449`; `src/core/persistence.ts:578-596`.

**Cause:** The local watcher deletes its own CRDT document when classification changes to binary. The receiving `finishBinary()` updates the file state and binary-version map but never removes the previous CRDT document. `ensureLivePathMaterialized()` has no binary-transition cleanup. `collectMaterialization()` iterates both maps independently and filters deleted entries, not incompatible kinds.

**Reproduce:** Synchronize a closed text file, then replace it with bytes classified as binary. Supported classification transitions include a formerly small tracked text file growing past the 32 MiB text threshold, or an encoding change that no longer decodes as UTF-8. The compact probe used bytes `[255, 0, 1]` in `switch.py` to exercise the same transition without a large fixture.

**Observed:** The sender no longer had a CRDT document, while the receiver had `guestKind: "text"`, `fileKind: "binary"`, and stale canonical text `OLD = 1`. The received binary was present. Production `collectMaterialization()` emitted **two entries for `switch.py`**. The materialization validator rejects duplicate file paths.

**Evidence limit:** No claim is made that the binary is immediately overwritten on disk. The confirmed defect is inconsistent document/binary ownership and the duplicate manifest it produces.

**Expected / repair acceptance:** A path has exactly one active representation after every kind transition. Test text-to-binary, notebook-to-binary, and reverse transitions with real transfer and materialization, including a host transfer afterward.

## CB-010 — Guest kernel control waits behind bulk snapshot work

**Impact:** A guest cannot promptly stop or restart its running computation while the host is transmitting a snapshot to another joining participant. The command is already received but is not dispatched to the kernel until the unrelated snapshot finishes or fails.

**Locations:** `src/runtime/session.ts:280-287`, `src/runtime/session.ts:2423-2459`, `src/runtime/session.ts:2753-2771`, `src/runtime/session.ts:5826-5863`; `src/runtime/session.ts:1662-1812`.

**Cause:** `snapshotRequest`, binary work, and `kernelCommand` share one serial `backgroundMessageQueue`. The snapshot message handler awaits the entire `sendSnapshot()` operation, including flow-control/checkpoint waits. Marking kernel control as background prevents it from overtaking any of that work.

**Reproduce:** Start a long cell from guest B. While participant C is receiving a sufficiently large snapshot, press Interrupt from B. Keep C's snapshot unfinished, then complete it.

**Observed:** With production dispatch/queues and a gated snapshot transfer, the real kernel-command handler was not invoked while the snapshot was pending. After releasing the snapshot, the kernel's interrupt method was invoked. This is head-of-line blocking, not packet loss. The probe substituted only the long-running snapshot body and kernel interrupt endpoint.

**Expected / repair acceptance:** Kernel control must remain responsive during unrelated snapshot and binary traffic. Test an unfinished third-participant join and a guest interrupt concurrently, including a stalled checkpoint.

## CB-011 — Interrupting Run All does not cancel the controller's remaining cells

**Impact:** Stop interrupts the currently submitted execution, but subsequent cells in the same Run All request still execute. A user cannot rely on Stop to prevent the rest of a batch from modifying interpreter state or files.

**Locations:** `src/vscode/jupyterController.ts:45-49`, `src/vscode/jupyterController.ts:167-185`, `src/vscode/jupyterController.ts:188-303`; `src/core/executionQueue.ts:17-35`.

**Cause:** The controller serially loops through all requested cells. `interruptHandler` only invokes `runtime.interruptNotebook()`; it does not cancel the remaining controller work or mark the batch interrupted. `executeCell()` handles the failed/interrupt result and returns, after which the outer loop starts the next cell.

**Reproduce:** Run All with cell A executing a long loop and cell B performing an observable side effect. Interrupt while A is running. Allow A to return `KeyboardInterrupt`.

**Observed through the production controller:** `['run:first', 'interrupt', 'run:second']`. The probe returned an interrupted result for the first runtime execution; the second cell was nevertheless submitted.

**Expected / repair acceptance:** Interrupting a batch cancels cells in that batch that have not started. Test both a single Run All request and additional requests already queued for the same notebook, while preserving independence of other notebooks.

## Validation and coverage

| Check | Result | Meaning / limitation |
| --- | --- | --- |
| `npm.cmd test` | PASS: **389 passing (2m)** | Full existing suite, including TypeScript/esbuild compile and Python bridge tests |
| `npm.cmd run lint` | PASS | Existing repository lint gate |
| Editor audit probes | PASS: reproduced CB-002, CB-003, CB-004 | Production sync/CRDT/controller with deterministic editor event boundaries |
| Runtime audit probes | PASS: reproduced CB-001, CB-005, CB-006 | Real Jupyter for CB-001; authenticated in-memory transport for clock startup; direct size/framing proof |
| Lifecycle audit probes | PASS: reproduced CB-007, CB-008, CB-009 | Real Jupyter for rename, command-boundary observation, real binary transfer/filesystem |
| Queue audit probes | PASS: reproduced CB-010, CB-011 | Production dispatch/controller, controlled waiting/completion |
| Installed VSIX / two-window VS Code UI | NOT RUN | Do not interpret API-boundary probes as installed UI validation |
| Two physical machines, VPN/TUN switch, public relay availability | NOT RUN | Existing deterministic network tests passed; no new physical connectivity claim |
| Release/package publication | NOT RUN | Outside this report-only request |

"PASS" for an audit probe means that its assertions successfully demonstrated the defect; it does **not** mean the affected behavior is correct.

The first sandboxed full-test attempt stopped in esbuild with `Access is denied`; the successful complete run used approved execution outside the filesystem sandbox. A sandboxed real-Jupyter probe also failed before `kernel_info`; rerunning outside that sandbox produced the successful kernel evidence reported above. These environment failures are not listed as product defects. Early probe-output collection also needed event-sequence deduplication because execution events are intentionally replayed; the final CB-001 observation uses that deduplication.

Reviewed production areas include invitation/restore wiring, Mesh admission and framing, snapshot and state synchronization, Nostr/MQTT relay framing and recovery, runtime host/compute authority, file lifecycle and persistence, Yjs notebook/text representation, editor event application and presence/line-lock boundaries, NotebookController queues/rendering, and the Python/Jupyter bridge. Existing regression coverage exercised handshake authentication, route recovery/optimization, relay-only bootstrap, transfer integrity, stable cell identities, host authority, execution replay/input, persistence, and terminal lifecycle. Passing those tests did not cover the cross-boundary cases listed here.

Public relay outages, absence of an independently configured TURN server, version-mismatched peers, and hypothetical rare packet-loss chains were not promoted to confirmed critical code defects. No statistical failure-frequency claims were made from synthetic transport tests.

## Reproducible audit probes

The following scripts are evidence fixtures, embedded in this report so the requested publication remains documentation-only. They load the compiled production modules and reuse the existing test suite's small VS Code/in-memory transport boundaries. `describe`/hooks are disabled only while importing those helper modules; the standalone scripts explicitly arrange and clean up their own runtime state. Temporary overrides affect objects inside the probe process only.

Run the normal compilation/test command **before** extracting the scripts: compilation deletes `out/`. Then extract each JavaScript block marked `<!-- audit-probe: NAME -->` to `out/audit/NAME`. For example, from the repository root:

```powershell
npm.cmd test
New-Item -ItemType Directory -Force out/audit | Out-Null
$auditMarkdown = Get-Content -Raw -LiteralPath CRITICAL_BUG_AUDIT.md
$auditPattern = '(?s)<!-- audit-probe: ([a-z-]+\.cjs) -->\r?\n```javascript\r?\n(.*?)\r?\n```'
foreach ($auditMatch in [regex]::Matches($auditMarkdown, $auditPattern)) {
    $auditTarget = Join-Path 'out/audit' $auditMatch.Groups[1].Value
    [System.IO.File]::WriteAllText($auditTarget, $auditMatch.Groups[2].Value)
}
node out/audit/editor-probes.cjs
node out/audit/runtime-probes.cjs
node out/audit/lifecycle-probes.cjs
node out/audit/queue-probes.cjs
```

Requirements: the audited checkout's installed npm dependencies and a `python` executable with `jupyter_client` and `ipykernel` for the runtime/lifecycle scripts. The live kernel probes start local child processes; execute them in an environment that permits Jupyter startup. Fixtures stay under the ignored `out/audit` directory. Do not run these probes against valuable data or substitute a real project folder for their temporary folders.

The fixtures intentionally assert the observed **buggy** behavior at the audited commit. They are not regression tests to preserve after fixing the defects. The clock fixture starts a host at epoch 1 to isolate fresh admission; the existing suite covers reaching epoch 1 through a real transfer. The large-output fixture isolates accepted-state/wire incompatibility without sending tens of megabytes across a public relay.

### editor-probes.cjs

<!-- audit-probe: editor-probes.cjs -->
```javascript
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
global.describe = () => {};
const filename = path.resolve('out/test/editorSync.integration.test.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = {vscodeBoundary, EditorSynchronizer, fakeNotebook, fakeCell, fakeTextDocument, reindex, logger};', filename);
const {vscodeBoundary:v, EditorSynchronizer, fakeNotebook, fakeCell, fakeTextDocument, reindex, logger} = loaded.exports;
const {CollaborativeProject} = require('../src/core/crdt');
const {REMOTE_ORIGIN} = require('../src/core/types');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  // A normal awaited VS Code edit keeps the document applying flag set.
  const root = path.resolve('out/audit/editor');
  const d = fakeTextDocument(path.join(root, 'work.py'), 'abc');
  v.__resetText(d);
  const p = new CollaborativeProject();
  const s = new EditorSynchronizer(p, root, logger());
  let entered, release;
  const started = new Promise(r => entered = r);
  const gate = new Promise(r => release = r);
  v.__beforeApplyEdit = async () => { entered(); await gate; };
  p.applyTextChanges('work.py', [{offset:0,deleteCount:0,insertText:'R'}], REMOTE_ORIGIN);
  await started;
  d.text = 'abcL';
  v.__fireTextChange(d, [{rangeOffset:3,rangeLength:0,text:'L'}]);
  release(); await tick(); await tick();
  console.log('AUDIT editor edit during remote apply', JSON.stringify({editor:d.text,canonical:p.text('work.py').toString()}));
  assert.equal(d.text, 'RabcL'); assert.equal(p.text('work.py').toString(), 'Rabc');
  s.dispose(); p.destroy();

  const n = fakeNotebook(root, [fakeCell('OLD', 'a')]);
  v.__reset(n);
  const p2 = new CollaborativeProject();
  const s2 = new EditorSynchronizer(p2, root, logger());
  await s2.whenNotebookReady(n);
  let drain;
  s2.notebookApplyQueues.set('work.ipynb', new Promise(r => drain = r));
  p2.applyCellTextChanges('work.ipynb','a',[{offset:0,deleteCount:3,insertText:'REMOTE'}],REMOTE_ORIGIN);
  n.cells.push(fakeCell('NEW CELL','b')); reindex(n);
  v.__fireNotebookChange(n,true);
  console.log('AUDIT structural edit overwrites remote source', JSON.stringify({canonical:p2.cellSource('work.ipynb','a').toString()}));
  assert.equal(p2.cellSource('work.ipynb','a').toString(),'OLD');
  drain(); await tick(); await tick(); s2.dispose(); p2.destroy();

  const n3 = fakeNotebook(root,[fakeCell('print(1)','a')]);
  v.__reset(n3);
  const p3 = new CollaborativeProject();
  const s3 = new EditorSynchronizer(p3,root,logger());
  await s3.whenNotebookReady(n3);
  p3.setCellExecution('work.ipynb','a',{requestId:'host-request',executionOrder:1});
  n3.cells[0].executionSummary = {executionOrder:1};
  s3.onNotebookChanged({notebook:n3,contentChanges:[],cellChanges:[{cell:n3.cells[0],executionSummary:{executionOrder:1}}]});
  console.log('AUDIT execution identity after VS Code summary echo',JSON.stringify(p3.notebookCellSnapshot('work.ipynb','a').execution));
  assert.equal(p3.notebookCellSnapshot('work.ipynb','a').execution?.requestId,undefined);
  const previousLoad=Module._load;
  Module._load=function(request,parent,isMain){return request==='vscode'?v:previousLoad.call(this,request,parent,isMain);};
  const {PairNotebookController}=require('../src/vscode/jupyterController');
  Module._load=previousLoad;
  const controller=Object.create(PairNotebookController.prototype);
  controller.remoteExecutionRequestIds=new WeakMap([[n3.cells[0],'host-request']]);
  controller.mirroredExecutions=new Map();
  // Enforce the documented VS Code rule: one active execution per cell.
  controller.controller={createNotebookCellExecution:()=>{throw new Error('Cell already has an active execution');}};
  await assert.rejects(controller.renderRemoteCellState(n3.cells[0],{outputs:[],execution:p3.notebookCellSnapshot('work.ipynb','a').execution,outputsChanged:true,executionChanged:true,executionMode:'live'}),/already has an active execution/);
  console.log('AUDIT stripped request ID attempts a second active cell execution');
  s3.dispose();p3.destroy();
})().catch(error => {console.error(error);process.exitCode=1;});
```

### runtime-probes.cjs

<!-- audit-probe: runtime-probes.cjs -->
```javascript
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
global.describe = global.beforeEach = global.afterEach = () => {};
const filename = path.resolve('out/test/runtime.integration.test.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename,'utf8') + '\nmodule.exports={SessionRuntime,descriptor,context,logger,fakeVscode,PairNotebookController};',filename);
const {SessionRuntime,descriptor,context,logger,fakeVscode:v,PairNotebookController} = loaded.exports;
const {MeshTransport,configureMeshNetwork} = require('../src/runtime/mesh');
const {createInMemoryTrysteroFactory,resetInMemoryTrystero} = require('../test/support/in_memory_trystero');
const {JupyterKernel} = require('../src/core/pythonKernel');
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){return request==='vscode'?v:originalLoad.call(this,request,parent,isMain);};
const {EditorSynchronizer} = require('../src/vscode/sync');
Module._load=originalLoad;
const {CollaborativeProject} = require('../src/core/crdt');
const {encodeFrame} = require('../src/core/wire');
const {serializeIpynb,parseIpynb} = require('../src/core/projectFiles');
const tick = () => new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const root=await fsp.mkdtemp(path.join(path.resolve('out/audit'),'runtime-'));
 const runtimes=[];
 const make=async (peerId,role,hostPeerId,knownPeers=[],epoch=0)=>{
   const folder=path.join(root,peerId);await fsp.mkdir(folder,{recursive:true});
   const d=descriptor({sessionId:path.basename(root),role,peerId,hostPeerId,knownPeers,workingFolder:folder,pythonPath:'python'});
   d.hostEpoch=epoch;
   const r=new SessionRuntime(d,'audit-local-token-at-least-32-characters',context(process.cwd()),logger());
   runtimes.push(r);return r;
 };
 configureMeshNetwork({disableRelayFallback:true,disableTurnProbe:true});
 MeshTransport.setRoomFactoryForTesting(createInMemoryTrysteroFactory());
 try {
   const host=await make('host','host','host',[],1);
   await host.start();
   const guest=await make('guest','peer','host',[{...host.descriptor.localPeer}]);
   await guest.start();
   await tick();
   assert.equal(host.coordinator.clock.hostEpoch,1);
   assert.equal(guest.coordinator.clock.hostEpoch,0);
   await guest.onMessage({type:'hostHeartbeat',payload:new Uint8Array(),meta:{clock:host.coordinator.clock,hostStorageReady:false}},'host');
   assert.equal(guest.waitingForHostFolder,false);
   await guest.onMessage({type:'hostTransferPrepare',payload:new Uint8Array(),meta:{clock:host.coordinator.clock,transferId:'audit-transfer',nextClock:{...host.coordinator.clock,hostEpoch:2,hostId:'guest'}}},'host');
   assert.equal(guest.preparedHostTransfers.size,0);
   console.log('AUDIT fresh join after transfer',JSON.stringify({hostEpoch:host.coordinator.clock.hostEpoch,guestEpoch:guest.coordinator.clock.hostEpoch,paused:guest.waitingForHostFolder,preparedTransfers:guest.preparedHostTransfers.size}));

   const file=path.join(host.descriptor.workingFolder,'helper.py');
   await fsp.writeFile(file,'VALUE = 1\n');
   host.project.ensureText('helper.py','VALUE = 2\n');
   const document={uri:v.Uri.file(file),getText:()=>host.project.text('helper.py').toString(),save:async()=>{await fsp.writeFile(file,document.getText());return true;}};
   v.workspace.textDocuments=[document];
   const sync=Object.create(EditorSynchronizer.prototype);
   Object.assign(sync,{project:host.project,root:host.descriptor.workingFolder,textApplyQueues:new Map(),applyingText:new Set()});
   host.setWorkingCopyWriter((key,bytes)=>sync.persistWorkingCopy(key,bytes),()=>sync.prepareWorkingCopy());
   await host.flush();
   host.project.ensureNotebook('work.ipynb',{metadata:{},cells:[{id:'a',kind:2,language:'python',source:'print(open("helper.py").read().strip())',metadata:{},outputs:[]}]});
   let stream=''; const seenEvents=new Set();
   const kernel=new JupyterKernel('python',path.resolve('media/jupyter_kernel_bridge.py'),host.descriptor.workingFolder);
   host.kernels.set('work.ipynb',kernel);
   host.updatePresence();
   const target=host.computeForNotebook('work.ipynb');
   const state=host.project.cellTextState('work.ipynb','a');
   const oldSend=host.transport.sendTo.bind(host.transport);
   host.transport.sendTo=(peer,type,meta,payload)=>{
     if(peer==='audit-requester'&&type==='executionEvent'){
       if(seenEvents.has(meta.eventSequence))return;seenEvents.add(meta.eventSequence);
       const event=JSON.parse(Buffer.from(payload).toString('utf8'));
       if(event.messageType==='stream')stream+=event.content.text;
       return;
     }
     if(peer==='audit-requester') { if(type==='executeResult') console.log('AUDIT execution result',Buffer.from(payload).toString('utf8')); return; }
     return oldSend(peer,type,meta,payload);
   };
   await host.handleExecutionRequest({type:'executeRequest',payload:new Uint8Array(),meta:{requestId:'audit-stale-file',notebookKey:'work.ipynb',cellId:'a',executorId:'host',computeEpoch:target.epoch,cellRevision:state.revision,cellDigest:createHash('sha256').update(state.source).digest('hex'),fastPath:true}},'audit-requester');
   console.log('AUDIT guest reads open working file',JSON.stringify({canonical:host.project.text('helper.py').toString().trim(),disk:(await fsp.readFile(file,'utf8')).trim(),python:stream.trim()}));
   assert.equal(stream.trim(),'VALUE = 1');
   assert.equal(host.project.text('helper.py').toString().trim(),'VALUE = 2');
   v.workspace.textDocuments=[];
 } finally {
   v.workspace.textDocuments=[];
   await Promise.allSettled(runtimes.map(r=>r.leave()));
   resetInMemoryTrystero();MeshTransport.setRoomFactoryForTesting(undefined);configureMeshNetwork({});
 }
 const p=new CollaborativeProject();
 p.ensureNotebook('large.ipynb',{metadata:{},cells:Array.from({length:5},(_,i)=>({id:`c${i}`,kind:2,language:'python',source:'',metadata:{},outputs:[]}))});
 const dataBase64=Buffer.alloc(10*1024*1024,65).toString('base64');
 for(let i=0;i<5;i++)p.setCellOutputs('large.ipynb',`c${i}`,[{metadata:{outputType:'display_data'},items:[{mime:'image/png',dataBase64}]}]);
 const update=p.encodeUpdate('large.ipynb');
 let failure;try{encodeFrame('stateDocument',{},update);}catch(e){failure=e.message;}
 console.log('AUDIT accepted outputs block full state',JSON.stringify({bytes:update.byteLength,error:failure}));
 assert.ok(failure);p.destroy();
})().catch(error=>{console.error(error);process.exitCode=1;});
```

### lifecycle-probes.cjs

<!-- audit-probe: lifecycle-probes.cjs -->
```javascript
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const Module=require('node:module');
const assert=require('node:assert/strict');
global.describe=global.beforeEach=global.afterEach=()=>{};
const filename=path.resolve('out/test/runtime.integration.test.js');
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports={SessionRuntime,descriptor,context,logger,fakeVscode,PairNotebookController,fakeCell,notebookForController};',filename);
const {SessionRuntime,descriptor,context,logger,fakeVscode:v,PairNotebookController,fakeCell,notebookForController}=loaded.exports;
const {MeshTransport,configureMeshNetwork}=require('../src/runtime/mesh');
const {createInMemoryTrysteroFactory,resetInMemoryTrystero}=require('../test/support/in_memory_trystero');
const tick=()=>new Promise(r=>setTimeout(r,20));
(async()=>{
 const root=await fsp.mkdtemp(path.join(path.resolve('out/audit'),'lifecycle-'));
 const folder=path.join(root,'host');await fsp.mkdir(folder);
 const host=new SessionRuntime(descriptor({sessionId:path.basename(root),role:'host',peerId:'host',hostPeerId:'host',workingFolder:folder,pythonPath:'python'}),'audit-local-token-at-least-32-characters',context(process.cwd()),logger());
 let guest;
 configureMeshNetwork({disableRelayFallback:true,disableTurnProbe:true});MeshTransport.setRoomFactoryForTesting(createInMemoryTrysteroFactory());
 try{
   await host.start();
   host.project.ensureNotebook('work.ipynb',{metadata:{},cells:[{id:'a',kind:2,language:'python',source:'x=42',metadata:{},outputs:[]}]});
   let result=await host.executeCell('work.ipynb','a','x=42',()=>{});
   assert.equal(result.success,true);
   await host.flush();
   await fsp.rename(path.join(folder,'work.ipynb'),path.join(folder,'renamed.ipynb'));
   await host.onLocalRename(v.Uri.file(path.join(folder,'work.ipynb')),v.Uri.file(path.join(folder,'renamed.ipynb')));
   result=await host.executeCell('renamed.ipynb','a','print(x)',()=>{});
   console.log('AUDIT rename notebook kernel',JSON.stringify({success:result.success,error:result.content.ename,kernelKeys:[...host.kernels.keys()]}));
   assert.equal(result.content.ename,'NameError');assert.equal(host.kernels.size,2);

   // The Pair-labelled action delegates to the selected VS Code kernel command.
   v.window.activeNotebookEditor={notebook:{uri:v.Uri.file(path.join(folder,'renamed.ipynb'))}};
   v.__commands.length=0;
   await host.executeActiveCell();
   assert.deepEqual(v.__commands,[['notebook.cell.execute']]);
   console.log('AUDIT Pair Run command routing',JSON.stringify(v.__commands));
   v.window.activeNotebookEditor=undefined;

   host.project.ensureText('switch.py','OLD = 1\n');await host.flush();
   const guestFolder=path.join(root,'guest');await fsp.mkdir(guestFolder);
   guest=new SessionRuntime(descriptor({sessionId:path.basename(root),role:'peer',peerId:'guest',hostPeerId:'host',knownPeers:[{...host.descriptor.localPeer}],workingFolder:guestFolder,pythonPath:'python'}),'audit-local-token-at-least-32-characters',context(process.cwd()),logger());
   await guest.start();
   await guest.flush();
   await fsp.writeFile(path.join(folder,'switch.py'),Buffer.from([255,0,1]));
   await host.onLocalFile(v.Uri.file(path.join(folder,'switch.py')),'change');
   const until=Date.now()+5000;
   while(!guest.binaryVersions.has('switch.py')&&Date.now()<until)await tick();
   assert.equal(guest.binaryVersions.has('switch.py'),true);
   console.log('AUDIT text to binary',JSON.stringify({hostKind:host.project.kindOf('switch.py'),guestKind:guest.project.kindOf('switch.py'),fileKind:guest.fileStates.get('switch.py').kind,guestCanonical:guest.project.text('switch.py').toString()}));
   assert.equal(guest.project.kindOf('switch.py'),'text');
   const materialization=await guest.collectMaterialization();
   const copies=[...materialization.documents,...materialization.binaries].filter(item=>item.relativePath==='switch.py');
   console.log('AUDIT materialization duplicates changed file',JSON.stringify({entries:copies.length}));
   assert.equal(copies.length,2);
 }finally{
   v.window.activeNotebookEditor=undefined;await Promise.allSettled([host.leave(),guest?.leave()]);
   resetInMemoryTrystero();MeshTransport.setRoomFactoryForTesting(undefined);configureMeshNetwork({});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
```

### queue-probes.cjs

<!-- audit-probe: queue-probes.cjs -->
```javascript
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const assert=require('node:assert/strict');
global.describe=global.beforeEach=global.afterEach=()=>{};
const filename=path.resolve('out/test/runtime.integration.test.js');
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports={SessionRuntime,descriptor,context,logger,fakeVscode,PairNotebookController,fakeCell,notebookForController};',filename);
const {SessionRuntime,descriptor,context,logger,fakeVscode:v,PairNotebookController,fakeCell,notebookForController}=loaded.exports;
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const r=new SessionRuntime(descriptor({sessionId:'audit-queue',role:'host',peerId:'host',hostPeerId:'host',workingFolder:path.resolve('out/audit/queue'),pythonPath:'python'}),'audit-local-token-at-least-32-characters',context(process.cwd()),logger());
 let release;let interrupted=false;
 r.sendSnapshot=()=>new Promise(resolve=>{release=resolve;});
 r.kernels.set('work.ipynb',{interrupt:async()=>{interrupted=true;},stop:()=>{}});
 r.updatePresence();
 r.transport.sendTo=()=>{};
 r.enqueueIncomingMessage({type:'snapshotRequest',meta:{snapshotId:'audit-snapshot',completed:{}},payload:new Uint8Array()},'joining');
 await tick();
 r.enqueueIncomingMessage({type:'kernelCommand',meta:{requestId:'audit-interrupt',notebookKey:'work.ipynb',target:r.computeForNotebook('work.ipynb'),command:'interrupt'},payload:new Uint8Array()},'guest');
 await tick();await tick();
 assert.equal(interrupted,false);console.log('AUDIT interrupt while snapshot is pending',JSON.stringify({interrupted}));
 release();await r.backgroundMessageQueue;
 assert.equal(interrupted,true);console.log('AUDIT interrupt after snapshot finishes',JSON.stringify({interrupted}));
 await r.disposeAsync();

 let finishFirst;const calls=[];
 const controller=new PairNotebookController(logger());
 const runtime={descriptor:{localPeer:{peerId:'guest'}},notebookKey:uri=>uri.fsPath,notebookCellId:cell=>cell.id,computeForNotebook:()=>({executorId:'host'}),executeCell:async(key,id)=>{calls.push('run:'+id);if(id==='first')return new Promise(resolve=>{finishFirst=resolve;});return {success:true,content:{}};},interruptNotebook:async()=>{calls.push('interrupt');finishFirst({success:false,content:{ename:'KeyboardInterrupt'}});}};
 controller.setRuntime(runtime);
 const notebook=notebookForController('work.ipynb');const first=fakeCell('first',notebook);const second=fakeCell('second',notebook);
 const native=v.__controllers.at(-1);
 const run=native.executeHandler([first,second],notebook);await tick();
 await native.interruptHandler(notebook);await run;
 console.log('AUDIT Run All after Stop',JSON.stringify(calls));
 assert.deepEqual(calls,['run:first','interrupt','run:second']);controller.dispose();
})().catch(error=>{console.error(error);process.exitCode=1;});
```
