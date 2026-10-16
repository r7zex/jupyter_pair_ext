# Server release 0.6.7 verification

This report is updated from actual command output before publication. It separates automated process/container evidence from installed VS Code, real public ACME issuance and physical-computer acceptance.

Baseline: GitHub main and latest release v0.6.6 at ca79de30c7df504de78e000e345c7ccf150c0edf. Existing worktrees and untracked output directories were preserved in place; implementation uses a separate worktree.

## Startup failure diagnosis

The existing Windows Extension Host log for 2026-10-16 17:26:27 (Europe/Moscow) records activation on `onFileSystem:pair-vps`. The same host's Pair Notebook output repeatedly records HTTP 426, and the renderer records the failed save of `test.ipynb`. The extension registry resolves Pair Notebook to 0.6.5. These logs establish the active failure path; registry metadata alone is not treated as an activated-version probe. The new build logs its activated version, extension path and protocol explicitly.

The exact 0.6.6 server condition is `notebookSync` on a zero-cell document with no CRDT bootstrap, where an old client sends neither `bootstrapEmpty: true` nor an update/snapshot/intent/stateVector. The server deliberately returns 426 to preserve the client's unsaved first cell. Heartbeat succeeds independently, explaining the contradictory connected notification. The new client checks compatibility and prepares restored notebooks before announcing readiness.

## Verification status

Pending execution of the release verification commands. No physical two-computer acceptance, public domain/IP ACME issuance, existing production-server installation or 24-hour soak is implied by packaging tests.
