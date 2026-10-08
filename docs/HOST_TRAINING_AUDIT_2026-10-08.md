# Host repository, shared terminal and model training — 8 October 2026

Version: 0.5.31. Branch: `codex/vps-persistent-compute`. Work ran in the cloud Linux environment against the latest branch head available on 8 October. The user selected local VPS-broker acceptance; no external VPS credentials or physical GPU were supplied.

## Changes and reproduced problems

- The previous `terminal` runtime event represented session shutdown, not a command terminal. The new shared host command terminal accepts input only from the current local host, runs under the extension host's OS account, and rejects remote shell-input frames. Guests receive sequenced output and bounded snapshot recovery. Host transfer/shutdown stop the old process tree, Ctrl+C cancels pending commands, and retained Unicode output preserves surrogate pairs. Native input handling also ignores arrow-key escape sequences and stale closed terminal callbacks.
- Live kernels previously used the isolated working copy. They now use the host backing repository after canonical file barriers; `PAIR_NOTEBOOK_WORKSPACE` points there. Missing canonical binary assets are streamed into a new backing repository without removing host-only files. Changing the backing repository stops idle old kernels/shells, while active notebook execution prevents that change.
- VPS snapshots previously omitted non-Python resources and standalone project dependencies. Tracked text configuration/data files and dirty editors are now included within the existing 256-file/4-MiB limits. Binary datasets are skipped without hashing/loading them in the standalone snapshot path. Credentials retain the existing exclusions.
- Python entrypoints in subdirectories previously lacked the snapshot root on `sys.path`. The agent now adds it to `PYTHONPATH`, retaining the owner's inherited import paths.

## Real model pipelines

The reusable fixture fits a two-parameter linear model from CSV rows, imports a project helper, reads JSON configuration, performs 400 gradient-descent steps, writes a checkpoint, reloads it, checks mean-squared error below `1e-10`, and verifies an out-of-sample prediction within `1e-4`.

1. **Live host execution through the peer mesh.** A guest receives the host's canonical notebook/modules/configuration and submits its cell through `SessionRuntime`. A real Jupyter kernel reads a dataset available only in the host backing repository. The guest never receives that excluded dataset. The model/checkpoint assertions pass, and the guest receives live output. The host shell streams output to the guest while guest commands and forged `shellInput` are rejected.
2. **Live host execution through the VPS alone.** Discovery/data exchange through direct peers is disabled; the production mesh uses `VpsFrameRelay` and a real loopback broker. The authenticated guest route is verified as Relay. The broker stops after training begins, the real host kernel finishes while it is offline, and execution events/results reconcile after the broker restarts. The same model/checkpoint and shared-terminal authority checks pass.
3. **Detached VPS-agent execution from a repository snapshot.** The production `VpsComputeController` captures a nested Python entrypoint, root module, JSON configuration and CSV dataset, including an unsaved module replacing a deliberately failing disk version. A real Python agent runs that immutable job. The editor controller and broker stop during training; the checkpoint is produced, the broker restarts, the result/logs recover, and exactly one job is stored.

The mesh, broker, filesystem, Python processes, Jupyter execution and model fitting are production paths. Tests replace the unavailable VS Code API boundary for editor/UI operations. They do not replace Python computation or VPS HTTP/WebSocket transport.

## Reproduction

```bash
npm ci
python3 -m pip install jupyter_client ipykernel
npm run compile
npm run lint
node node_modules/mocha/bin/mocha.js --timeout 20000 --exit 'out/test/**/*.test.js'
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
node scripts/make-artifacts.mjs --preflight-only
```

In this cloud environment, Jupyter dependencies were already prepared outside the repository at `/workspace/.jupyter_pair_ext_python`; the test command used that directory as `PYTHONPATH`. The existing two audit matrices are part of the full TypeScript suite; the independent Python audit contains 79 checks. Final totals and capabilities are recorded in [the result file](HOST_TRAINING_AUDIT_RESULTS.json).

## Limits

- Native VS Code Extension Host E2E was attempted and could not launch: `Could not find VS Code`. Production terminal/controller logic is covered through a substituted VS Code API boundary; native rendering remains unverified here.
- Real computation was on Linux CPU. Physical CUDA training, Windows process/service lifetime, public VPS certificates/routing and the earlier two-computer VPN acceptance scenario remain unverified in this environment.
- The terminal supports persistent line commands and streamed output. Full-screen TTY tools and interactive password prompts require the host's ordinary local terminal. Closing the shared terminal tab preserves its shell until session shutdown; Ctrl+C stops the shell and its child commands, and subsequent input starts a fresh shell.
- Terminal restrictions do not turn notebook execution into an OS sandbox. Trusted participants still execute Python on the host and can call operating-system APIs.
- Small text datasets can be included in a VPS snapshot. Large/binary host datasets must already be available on the selected compute PC through its configured `PAIR_NOTEBOOK_WORKSPACE` or the owner's file-transfer method.
