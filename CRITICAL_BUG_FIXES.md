# Critical bug repair checkpoints

Source audit: [CRITICAL_BUG_AUDIT.md](CRITICAL_BUG_AUDIT.md), commit `1afa67c`.

Workflow: fix one finding, validate it, and push its commit. The user subsequently canceled further agent reviews to conserve usage. Publish the GitHub release after all checkpoints and final artifact gates pass. The original audit remains a historical reproduction record.

| Finding | Implementation | Post-push review |
| --- | --- | --- |
| CB-001 | Fixed in `42c7594`, review correction `d812f93` | Luna re-reviewed `d812f93`: no P1/P2 blockers |
| CB-002 | Fixed in `e6730f6`; performance correction `48167ea` validated | Further review canceled by user |
| CB-003 | Structural deltas preserve canonical fields and unseen remote cells; 36 editor tests and lint passed | Not requested |
| CB-004 | Native summaries preserve protocol request ownership; active native output echoes are ignored | Not requested |
| CB-005 | Pending | Pending |
| CB-006 | Pending | Pending |
| CB-007 | Pending | Pending |
| CB-008 | Pending | Pending |
| CB-009 | Pending | Pending |
| CB-010 | Pending | Pending |
| CB-011 | Pending | Pending |

## Validation evidence

- CB-001: TypeScript compilation passed. The two-runtime regression now checks a guest-edited dependency whose host working file remains unsaved until execution. Route retries retain one request identity and perform one dependency barrier. Accepted lightweight requests release completed barrier authorization. Luna found that acceptance timeout included the file barrier; moved the acceptance timer after synchronization and verified no timer exists during transfer. The subprocess now reads the updated dependency before returning its result. Targeted runtime tests: 2 passing; targeted ESLint and TypeScript passed. Full runtime file: 63 passing, one host-loss closure timeout; isolated rerun reproduced that timeout. This remains an open release gate.

- CB-002: TypeScript and targeted ESLint passed; all 32 editor integration tests passed. Six gated regressions cover concurrent append, identical insertion and deletion in both a file and a notebook cell. The test boundary now emits native text-change events and rejects edits after a document version change. Displayed source replicas preserve Yjs identities, strip unrelated cell/output payloads, and merge only newly authored transactions; received editor echoes never republish remote updates. VS Code's [bulk-edit version provider](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostBulkEdits.ts) supplies text-document versions at submission.

- CB-002 review correction: Luna identified full-notebook decoding once per cell. A single incremental source-only template now supplies shared displayed versions. A 100-cell notebook with a 1 MiB output is encoded from canonical state once; the shared displayed update remains below 50 KiB. Concurrent local edits retain neighboring cells and the original rich output. Targeted replica regression passed; editor integration file passed (36 tests including the pending CB-003 scenarios).

- CB-004: The native-summary/output regression and production controller rendering test passed; TypeScript and targeted ESLint passed. Completed outputs can still be explicitly cleared. Installed two-window native-event timing remains a separate acceptance check.

## Release gates

- [ ] Every fix validated and pushed; previously reported review findings resolved.
- [ ] Full tests, lint, Python bridge tests, production dependency audit.
- [ ] Version, changelog, and current architecture/protocol documentation updated.
- [ ] VSIX and source archive built and inspected.
- [ ] Version tag and GitHub Release published; remote commit and assets verified.
- Physical two-computer and installed VS Code UI acceptance must be reported separately; automated tests do not imply either was performed.
