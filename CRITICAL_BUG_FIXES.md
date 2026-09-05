# Critical bug repair checkpoints

Source audit: [CRITICAL_BUG_AUDIT.md](CRITICAL_BUG_AUDIT.md), commit `1afa67c`.

Workflow: fix one finding, validate it, and push its commit. The user subsequently canceled further agent reviews to conserve usage. Publish the GitHub release after all checkpoints and final artifact gates pass. The original audit remains a historical reproduction record.

| Finding | Implementation | Post-push review |
| --- | --- | --- |
| CB-001 | Fixed in `42c7594`, review correction `d812f93` | Luna re-reviewed `d812f93`: no P1/P2 blockers |
| CB-002 | Fixed in `e6730f6`; performance correction `48167ea` validated | Further review canceled by user |
| CB-003 | Structural deltas preserve canonical fields and unseen remote cells; 36 editor tests and lint passed | Not requested |
| CB-004 | Native summaries preserve protocol request ownership; active native output echoes are ignored | Not requested |
| CB-005 | Invitations pin the current host epoch; bootstrap and join preserve it | Not requested |
| CB-006 | Incremental source/output/metadata mutations enforce the aggregate notebook budget, including retained cells | Not requested |
| CB-007 | Rename migrates live kernels, execution ownership, status and notebook settings; controller queues retain identity | Not requested |
| CB-008 | Pair Run explicitly selects its own controller and invokes its execution path | Not requested |
| CB-009 | File type transitions remove obsolete collaborative documents and binary versions before materialization | Not requested |
| CB-010 | Kernel commands use a separate bounded control queue, independent of bulk snapshot/file work | Not requested |
| CB-011 | Stop cancels remaining and queued notebook batches; fresh runs retain a new cancellation generation | Not requested |

## Validation evidence

- CB-001: TypeScript compilation passed. The two-runtime regression now checks a guest-edited dependency whose host working file remains unsaved until execution. Route retries retain one request identity and perform one dependency barrier. Accepted lightweight requests release completed barrier authorization. Luna found that acceptance timeout included the file barrier; moved the acceptance timer after synchronization and verified no timer exists during transfer. The subprocess now reads the updated dependency before returning its result. Targeted runtime tests: 2 passing; targeted ESLint and TypeScript passed. Full runtime file: 63 passing, one host-loss closure timeout; isolated rerun reproduced that timeout. This remains an open release gate.

- CB-002: TypeScript and targeted ESLint passed; all 32 editor integration tests passed. Six gated regressions cover concurrent append, identical insertion and deletion in both a file and a notebook cell. The test boundary now emits native text-change events and rejects edits after a document version change. Displayed source replicas preserve Yjs identities, strip unrelated cell/output payloads, and merge only newly authored transactions; received editor echoes never republish remote updates. VS Code's [bulk-edit version provider](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostBulkEdits.ts) supplies text-document versions at submission.

- CB-002 review correction: Luna identified full-notebook decoding once per cell. A single incremental source-only template now supplies shared displayed versions. A 100-cell notebook with a 1 MiB output is encoded from canonical state once; the shared displayed update remains below 50 KiB. Concurrent local edits retain neighboring cells and the original rich output. Targeted replica regression passed; editor integration file passed (36 tests including the pending CB-003 scenarios).

- CB-004: The native-summary/output regression and production controller rendering test passed; TypeScript and targeted ESLint passed. Completed outputs can still be explicitly cleared. Installed two-window native-event timing remains a separate acceptance check.

- CB-005: Invite round-trip, legacy default and malformed-epoch checks passed. The production transport test transferred host A to B, joined C using B's new invite, transferred B to C, and verified epoch 2 plus pause/resume on all three runtimes. TypeScript and targeted lint passed.

- CB-006: Three budget/replica tests and 17 focused CRDT tests passed, plus TypeScript and lint. Three 10 MiB rich outputs remain transferable; the next over-budget output is rejected before mutation. A fresh peer applies the accepted state document, clearing outputs restores capacity, and retained deleted cells remain accounted for. Incremental source growth uses the same budget.

- CB-007: A real Jupyter process retained `x = 42`, completed an active execution across rename, and returned `43` from the renamed notebook using the same kernel. Old CRDT/status paths were absent. Three relevant runtime/controller tests, TypeScript and lint passed. Host output callbacks and local controller execution track document rename events.

- CB-008: Both production controller tests passed, including a preselected native kernel and a rejected Pair selection. Pair Run never invoked the generic native execute command. TypeScript and targeted lint passed.

- CB-009: The two-runtime regression passed for text/notebook to binary and back, followed by host transfer and backing-folder reuse. Each path retained exactly one materialized representation. TypeScript and targeted ESLint passed.

- CB-010: A gated inbound snapshot regression verified Interrupt and Restart complete before the snapshot is released, with queue counters fully reclaimed. Existing per-peer rate and global admission limits remain enforced. TypeScript and targeted ESLint passed.

- CB-011: The production controller regression verified that Stop cancels the remaining Run All cell and an already queued batch, while a fresh Run succeeds afterward. Restart and runtime replacement also invalidate old batches. TypeScript and targeted ESLint passed.

- Host-loss release gate: Terminal disconnect now clears the coordinator's stale `recovering` state. The coordinator regression and previously failing three-runtime host-loss test both passed; guests close without changing authority. TypeScript and targeted ESLint passed.

## Release gates

- [x] Every fix validated and pushed; previously reported review findings resolved.
- [x] Full tests, lint, Python bridge tests, production dependency audit: 407 TypeScript tests and 7 Python bridge tests passed; zero production dependency vulnerabilities.
- [x] Version 0.5.13, changelog, and current architecture/protocol documentation updated.
- [x] VSIX and source archive built and inspected: required runtime assets present, no unsafe or sensitive archive paths.
- [x] Version tag and [GitHub Release v0.5.13](https://github.com/r7zex/jupyter_pair_ext/releases/tag/v0.5.13) published; remote tag resolves to `04544ad97695871abe337627bd583223e4133af2`. [Release CI](https://github.com/r7zex/jupyter_pair_ext/actions/runs/33984321692) passed all 407 tests, lint, 7 Python tests and the production dependency audit. The downloaded public VSIX matches the CI SHA-256 `4cb136e2c041b9bf3ddb6ef1f5a8b8e1eb3d698e8d2d2862cd45a640fe391c42`. The verified complete source ZIP is retained in that workflow's artifact, SHA-256 `d485ed4e3871de96067a9976c46fdc78f8b6bb4d082a51a20a5ce1b27566ed21`.
- The v0.5.12 CI run had 405 passing, one skipped and one failed real-kernel test because the clean runner lacked Jupyter dependencies. The tag remains unchanged and unpublished. Release 0.5.13 installs the locally validated `jupyter_client==8.6.3` and `ipykernel==6.29.5` before running the full gate; no application-code change was needed after the 407-test local pass.
- Physical two-computer and installed VS Code UI acceptance must be reported separately; automated tests do not imply either was performed.
