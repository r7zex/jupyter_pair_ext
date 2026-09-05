# Critical bug repair checkpoints

Source audit: [CRITICAL_BUG_AUDIT.md](CRITICAL_BUG_AUDIT.md), commit `1afa67c`.

Workflow: fix one finding, validate it, push its commit, obtain a read-only review from GPT-5.6 Luna, resolve blocking findings, then proceed. Publish the GitHub release after every checkpoint and the final artifact gates pass. The original audit remains a historical reproduction record.

| Finding | Implementation | Post-push review |
| --- | --- | --- |
| CB-001 | Guest dependency barrier and host working-copy materialization implemented; targeted tests passed | Pending |
| CB-002 | Pending | Pending |
| CB-003 | Pending | Pending |
| CB-004 | Pending | Pending |
| CB-005 | Pending | Pending |
| CB-006 | Pending | Pending |
| CB-007 | Pending | Pending |
| CB-008 | Pending | Pending |
| CB-009 | Pending | Pending |
| CB-010 | Pending | Pending |
| CB-011 | Pending | Pending |

## Validation evidence

- CB-001: TypeScript compilation passed. The two-runtime regression now checks a guest-edited dependency whose host working file remains unsaved until execution. Route retries retain one request identity and perform one dependency barrier. Accepted lightweight requests release completed barrier authorization. Targeted runtime tests: 2 passing; targeted ESLint and TypeScript passed. Full runtime file: 63 passing, one host-loss closure timeout; isolated rerun reproduced that timeout. This remains an open release gate.

## Release gates

- [ ] Every fix pushed and reviewed; blocking review findings resolved.
- [ ] Full tests, lint, Python bridge tests, production dependency audit.
- [ ] Version, changelog, and current architecture/protocol documentation updated.
- [ ] VSIX and source archive built and inspected.
- [ ] Version tag and GitHub Release published; remote commit and assets verified.
- Physical two-computer and installed VS Code UI acceptance must be reported separately; automated tests do not imply either was performed.

