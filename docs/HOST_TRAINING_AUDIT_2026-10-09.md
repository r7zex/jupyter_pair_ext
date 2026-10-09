# Repository preparation and kernel concurrency — 9 October 2026

Version: 0.5.32. Branch: `codex/vps-persistent-compute`. Baseline: `fdd982f4f46ac2e174166f8b89439ba8974b41f5`, fetched and verified against the remote branch. The 8 October changes and [their verification record](HOST_TRAINING_AUDIT_2026-10-08.md) are retained. This continuation uses the actual 9 October date.

## Reproduced failures and fixes

Four focused regression checks failed against the baseline before the runtime changes:

- An execution reached repository preparation during an unfinished folder replacement, and another replacement could overlap it.
- Changing the repository was allowed while execution was still preparing files because the active-execution counter had not been incremented yet.
- Closing the session during preparation left a newly created orphan kernel in the runtime afterward (`kernels.size` was 1).
- Two requests finishing their file barriers together created two real Jupyter kernels. The notebook's Python variables were split between processes.

The runtime now reserves the repository through the entire local preparation/execution operation and terminal file preparation. Folder replacement acquires its guard before any filesystem await; replacement of the same path is also protected. Execution, another folder replacement, host transfer and finalization cannot overlap that operation. Exceptions release the guard, and failed replacement restores the previous binding while that host still owns it.

Local execution rechecks session lifetime, host epoch and notebook compute target after asynchronous preparation. It reuses a kernel installed by another request during the file barrier. A late continuation cannot start a kernel after shutdown or host transfer.

Seven new checks cover replacement exclusion, notebook/terminal preparation, same-path protection, failure/retry, shutdown, host transfer and two simultaneous requests using one real Jupyter kernel with shared variables.

## Model and terminal acceptance

The existing real model pipelines were rerun with this runtime:

1. Guest execution through the production peer mesh reads a dataset present only in the host repository, imports a helper, reads configuration, fits a model, writes/reloads its checkpoint and verifies its prediction.
2. Guest execution solely through the production VPS relay performs the same pipeline. The broker stops during training; the host kernel completes, and output/results reconcile after the broker restarts.
3. The production VPS controller captures a repository snapshot with a nested Python entrypoint, root module, JSON, CSV and an unsaved module. A real detached Python agent completes training while the editor controller and broker are stopped, then reports its durable result after recovery.

The shared terminal continues to execute under the current host's OS account. Guests can view output and recover snapshots but cannot type, interrupt or inject `shellInput` frames. Terminal preparation now participates in the repository guard.

## Reproduction and scope

```bash
npm run compile
npm run lint
PYTHONPATH=/workspace/.jupyter_pair_ext_python node node_modules/mocha/bin/mocha.js --timeout 20000 --exit 'out/test/**/*.test.js'
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
node scripts/make-artifacts.mjs --preflight-only
```

Final test totals are recorded in [the result file](HOST_TRAINING_AUDIT_2026-10-09.json). The VSIX is checked with `scripts/make-artifacts.mjs` before push. Filesystem operations, Jupyter, Python model fitting, broker HTTP/WebSocket transport and detached-agent computation are real; editor/window APIs use the existing VS Code boundary substitutes.

This cloud environment has no native VS Code executable or physical GPU. Native Extension Host rendering, CUDA training and Windows process lifetime remain unverified. The user explicitly selected local-broker acceptance instead of testing an external VPS. Large/binary datasets for detached jobs must already exist on the compute agent's configured workspace. Notebook collaborators remain trusted Python executors; terminal input restrictions are not an OS sandbox.
