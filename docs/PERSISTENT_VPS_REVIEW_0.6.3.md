# Persistent VPS sessions — 0.6.3: implementation and acceptance

This is the historical implementation report. Later target observations and remaining limitations are recorded in [14 October target acceptance](PERSISTENT_VPS_ACCEPTANCE_2026_10_14.md); those observations supersede the earlier target-access/GPU/UI blockers below. Full acceptance remains incomplete.

Start: 13 October 2026. The clean local checkout was `work` at main
`1e67beab4c7167258142af8a3127f38e7fdf4ee4`. Git fetch and connected GitHub API
confirmed main at that SHA and open/unmerged PR #25 at
`97244d853194380d31f2f79edf54444d00961a35`, branch
`codex/review-persistent-v0.6.1`. The existing branch was fast-forwarded; no local
changes were discarded. Historical 0.6.1/0.6.2 reports were treated as claims.
The uploaded remaining-requirements prompt is the acceptance checklist.

**The full prompt remains incomplete.** Implemented behavior, real Linux/CPU
checks and external-resource blockers are separated below. Build manifests and
CI artifact names identify the final clean source commit; the final chat gives
its SHA and checks completed after the last functional changes.

## Requirement matrix

| Requirement | Current implementation | Missing/unverified part | Acceptance |
|---|---|---|---|
| Server notebook CRDT | [Yjs schema](../src/vps/persistentNotebookCrdt.ts), atomic state+notebook blob, stable cell IDs/order/source/metadata, epoch fencing, [VS Code replica journal](../src/vscode/persistentNotebookSync.ts) before submission | Two actual VS Code editors; simultaneous folder-based and virtual notebook editing; UI metadata/serializer behavior on actual Jupyter extension | [Actual HTTP two-replica/restart/ACK/ACL tests](../test/persistentSynchronization.test.ts); actual UI remains blocked |
| Continuous folder sync | [Three-way reconciler](../src/vps/persistentFolderSync.ts), [UI binding/reload](../src/vscode/persistent.ts); create/change/file+directory rename/delete, CAS, durable baseline, explicit conflicts, link rejection | Large-folder performance and two actual VS Code; remote removal of the mapping root and concurrent edit+rename need broader acceptance | Real HTTP/local filesystem regression including lost committed acknowledgement, rename ACL, conflict and recovery |
| Executed displayed source | Admission retains cell ID, SHA-256 and acknowledged revision; UI supplies ID/hash/revision; request receipts fence hidden reruns | Queues/source display in two actual VS Code | Existing source/admission/replay regressions and CRDT ID mismatch check |
| Private execution | Owner-only scope; full owner snapshot sent only to VPS or own target; separate kernel ID/workspace/receipt; private results remain owner-only after declassification; new artifacts atomically Private; Public files never overwritten by Private artifacts | Actual remote owner-device/Private workflow; native-platform confidentiality tests | Real Jupyter private import/output/declassification reset; direct API/recovery/artifact/stdin/privacy tests |
| Windows/macOS protected agents | [Container backend](../scripts/pair-notebook-session-agent.py) has immutable image, real in-image Python, non-root/read-only/no-network/CPU/RAM/PID bounds and exact cleanup. Windows [WSL2 launcher](../scripts/pair-notebook-wsl-agent.ps1) installs/verifies Linux bwrap runtime; native Windows no-follow coordinator fails closed | Actual WSL2/Windows and Docker Desktop/macOS; unattended native service installation/lifecycle | Real Linux-container test/evidence; no process.platform simulation counted |
| Discovery/invitations | Password-authorized discovery without manual ID; multi-session picker; separately hashed expiring invitations, read-only/Public edit permissions, session routing, revoke and password rotation; IP throttle | Real TLS invitation UI; measured expiration/reload in actual clients | Actual HTTP discovery/membership separation/revoke/restart tests |
| NVIDIA/CUDA/environment | Existing UUID inventory/mask/probe and repeated pre-run CUDA tensor check; container GPU selector and CPU mask | Physical NVIDIA and CPU→GPU→CPU; two physical devices | Actual CPU PyTorch `2.14.1+cpu`, sum 10.0; **no CUDA acceptance** |
| Two actual VS Code | Continuous sync/controller implemented; VSIX packaged | Owner/member install, simultaneous UI, reload/dialog/late-output/P2P acceptance | Existing mocked UI regressions; existing single Extension Host CI does not satisfy this row |
| Target VPS/TLS/reboot/backup | Existing non-root units, backup/restore runbook; comprehensive [OS disk-budget decision](PERSISTENT_VPS.md#14-полный-disk-budget-обязательное-production-решение) covers all stores/logs/dependencies | SSH credentials, authorized TCP route, domain/TLS and reboot window; actual quota/restore/renewal/reboot | HTTPS probe to `144.172.69.57` denied by proxy: `CONNECT tunnel failed, response 403`; no server modified |
| >=24-hour soak | [Measured harness](../scripts/persistent-session-soak.py): actual Host, two sessions/two isolated executors, Jupyter ledgers, replay, disconnect, consent/revoke and restart/recovery, elapsed/RSS/disk/process samples | Completed >=86400 seconds; external target VPS | Short real harness was 34.37 seconds, 4 unique executions, 2 cycles; expressly `acceptance24Hours=false`. Final clean-commit background run is recorded separately |

## Actual evidence and reproducible checks

- [Linux container](evidence/persistent-0.6.3/linux-container.json): real Docker
  Engine 28.4.0, immutable image ID, actual `/opt/pair-python/bin/python`, UID
  1000, only `/work` and `/bridge.py` bind mounts, network `none`, 512 MiB RAM,
  one CPU, two stateful cells. The test also checks inaccessible host credential
  canary, absent host secret environment, CPU CUDA mask and a denied network
  connection. [Required integration](../test/persistent_container_integration_test.py)
  fails for absent image/Docker/readiness; it never skips. This evidence has no
  physical GPU and does not prove native Windows/macOS.
- [CPU integration](../test/persistent_session_cpu_integration_test.py): five
  actual HTTP/agent/Jupyter tests, including Private dependency/variables/outputs,
  cleared outputs on declassification and a new Public namespace with one kernel.
  PyTorch CPU tensor sum 10.0 passed. Its DirectSandbox is a trusted test adapter;
  filesystem isolation proof comes from the separate real container test.
- [Short soak harness evidence](evidence/persistent-0.6.3/soak-harness.json)
  describes a dirty development tree based on `97244d8`, before final packaging.
  It proves harness execution only. No short duration or simulated clock is
  presented as long-soak evidence.
- TS full suite: 4901 passing with `--forbid-pending` after preparing the actual
  Python/Jupyter/CPU Torch environment. The initial unprepared run failed due to
  missing Jupyter and is not counted as a pass. The final full run includes late-generation/source output fencing and three
  replica-race/conflict regressions. Delivery manifests and remote CI are
  recorded in the final response.
- Linux bubblewrap exists locally but its probe fails `setting up uid map:
  Read-only file system`. Local bwrap smoke is explicitly skipped; required CI
  uses `PAIR_NOTEBOOK_REQUIRE_SANDBOX=1` and must fail if unavailable. Docker
  isolation was tested independently and is not a substitute for target-VPS bwrap.
- [Final checks and source hashes](evidence/persistent-0.6.3/final-checks.json)
  identify the exact tested functional files before the documentation/commit step.
- Python lifecycle/integration: 177 tests, 176 pass and one explicit local
  bubblewrap capability skip. The separate required real container suite passes
  without skips.
- Real frozen-reference integration: two tests pass with all runtime imports,
  including the new CRDT module; standalone delivery bundles both CLI and the
  importable Host, so the detached harness also works without checkout dependencies.

## 0.6.2 regression boundaries

The existing atomic publication receipt, post-rename/delete replay, fsync/rename
fault, orphan-blob, selected-owner consent/locked-switch, canonical bounded
kernel control, wire-limit, notebook-rename/reset, single VPS claim, UI connection
fencing and runtime/provenance tests remain in the suite. Private scopes reuse
those receipts; new artifact writes attach Private visibility in the **same**
workspace transaction. Declassification clears notebook outputs in the atomic
visibility transaction before publishing Public ACL. Public/Private scope IDs
and generations prevent namespace reuse; stale CRDT epochs fail before applying
an update. No P2P/broker protocol was replaced.

## Limits and outstanding work

The new native-platform launchers and VS Code synchronization integration have
not received their mandatory real-device/UI acceptance. WSL2 installation needs
a non-root default user; unattended native service setup is documented but not
automatically installed. CRDT retained state is bounded (6 MiB); compaction is an
explicit notebook replacement that fences old replicas. Journals remain on the
owning user's machine; conflict replicas are preserved before reset. Folder
sync uses bounded polling/reconciliation rather than a scalable file-event log.
Private rename+edit with lost deletion ACK now preserves a durable Private
lineage before deleting the old path; new copies/parents publish atomically
as Private. Broader concurrent edit+rename, large folder and multi-editor scenarios are
needed before declaring the complete synchronization requirement passed.

A fixed OS quota for server data, worker state, images/dependencies and bounded
logs is the production disk decision. It has **not** been configured or tested
on the target. Permanent execution receipts must never be pruned to recover
space; hit quota stops new writes until verified capacity is restored. A running
background soak can fail or lose its execution environment; only its saved
summary with measured duration and verified ledgers can establish acceptance.

Resources still needed: configured SSH credential and TCP route to the target,
trusted TLS/domain and allowed reboot window; physical NVIDIA/CUDA executors;
Windows/WSL2 and macOS/Docker Desktop hosts; two actual VS Code profiles; durable
24-hour execution environment. No annual availability claim is made.


CI on initial implementation commit `2404d3c9fa06e9b374568c7776cf845f62d2e6b2`:
[Host and VPS training](https://github.com/r7zex/jupyter_pair_ext/actions/runs/38442741532)
passed the full suite, mandatory actual non-root bubblewrap, required real
Linux-container test, Python lifecycle and standalone package checks; both
installable/server artifacts were saved. [Extension Host E2E](https://github.com/r7zex/jupyter_pair_ext/actions/runs/38442741522)
passed all four native editor jobs. This is not two-editor persistent acceptance.
The Private-lineage/container-metrics followup has its own final head CI and
clean delivery; never substitute the earlier artifact for its final SHA.
