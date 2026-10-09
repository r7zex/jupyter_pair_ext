# Shared terminal recovery and PyTorch training — 9 October 2026

Version: 0.5.33. Branch: `codex/vps-persistent-compute`. Baseline: `a27427b8a7e6ba74ac68190e75fa5adce70f77f4`, fetched and confirmed against GitHub before editing. The [8 October report](HOST_TRAINING_AUDIT_2026-10-08.md) and [0.5.32 report](HOST_TRAINING_AUDIT_2026-10-09.md) remain historical records.

## Reproduced defects and changes

Two new regression tests failed against the baseline:

- A late snapshot from the previous shell generation replaced the new repository's terminal history. Subsequent old output was then appended to that history. This also affected guests that had not seen the previous generation before joining.
- A delayed `open` callback from a closed Pseudoterminal erased input in the reopened terminal. An asynchronous command failure from the old binding also printed into that new terminal.

Terminal output now identifies its process stream, repository generation and ordered sequence. A new stream is adopted only after a snapshot echoes the guest's current request ID. Within that stream, a generation counter prevents old snapshots and output from restoring an earlier repository. Fresh output invalidates old-generation history before snapshot recovery; retry and reconnect preserve bounded recovery.

An additional restart regression was caught while implementing the counter: a new host process starts its own counter under the same session/host clock. Stream verification now allows that restart while rejecting old process snapshots and RPC replies. Both framed regression tests and replacement real shell processes verify recovery.

Native terminal callbacks and asynchronous error reporting check their runtime and binding before writing. Closed bindings cannot reset the current input or render old errors. Host-only input, forged-input rejection, bounded Unicode output, cancellation and receive compatibility with older hosts remain covered. Update every participant to 0.5.33 for ordered terminal recovery.

## Real PyTorch pipelines

The cloud installed **PyTorch 2.14.1+cpu** in a separate test interpreter. No Torch dependency is added to the extension or VSIX; users retain their configured Python environments. The tests use a real binary `.pt` dataset in the owner's repository, a canonical configuration file and a project helper module. The binary dataset is deliberately absent from guest/job snapshots.

Each PyTorch run uses `TensorDataset`, `DataLoader`, autograd, a linear model and SGD with momentum. It executes **100 epochs and 300 optimizer steps**, writes an atomic `.pt` checkpoint, reloads model and optimizer state into fresh objects, evaluates the model and verifies MSE below `1e-10` and prediction error below `1e-4`.

1. **Live guest execution on the host through the peer mesh.** A real Jupyter kernel loads the owner's binary data from the host repository through `PAIR_NOTEBOOK_WORKSPACE`. The guest receives the results without receiving the dataset.
2. **Live guest execution solely through the VPS relay.** Direct discovery is disabled. The broker stops during training, the host completes and reloads the checkpoint while offline, and events/results recover after the broker restarts.
3. **Detached owner-agent execution.** The production controller captures a nested entrypoint, configuration and an unsaved root module. A real Python agent loads the owner's existing binary dataset through its configured workspace. The editor controller and broker stop during training; weights, optimizer state, evaluation and a single durable result recover afterward.

The earlier standard-library model pipeline is also retained. All four live training cases additionally change the host repository, run a command in the new shell, verify its output reaches the guest, verify the old history is absent and verify the command's file is written only in the new repository.

## Reproduction

```bash
npm run compile
npm run lint
python3 -m pip install jupyter_client ipykernel
python3 -m venv --system-site-packages /tmp/pair-torch-env
/tmp/pair-torch-env/bin/python -m pip install jupyter_client ipykernel
/tmp/pair-torch-env/bin/python -m pip install --index-url https://download.pytorch.org/whl/cpu torch
PAIR_NOTEBOOK_TEST_TORCH_PYTHON=/tmp/pair-torch-env/bin/python node node_modules/mocha/bin/mocha.js --timeout 20000 --exit 'out/test/**/*.test.js'
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
node scripts/make-artifacts.mjs --preflight-only
```

The cloud retained Jupyter at `/workspace/.jupyter_pair_ext_python`, passed that directory as `PYTHONPATH` and selected `/workspace/.pair_torch_venv/bin/python` only for Torch scenarios. This keeps the general runtime regression suite independent of optional machine-learning packages. The Torch interpreter uses the separately installed CPU wheels from `/workspace/.pair_torch_deps`.

Final counts are recorded in [the result file](HOST_TRAINING_AUDIT_0.5.33_2026-10-09.json). The VSIX, native library hashes, compiled runtime, bridge and reports are checked before push.

## Scope

Computation, checkpoint files, shell processes, Jupyter, broker HTTP/WebSockets and agent persistence are real production paths. Tests substitute the unavailable VS Code window/editor boundary. Native VS Code rendering, physical CUDA training and Windows process lifetime remain unverified in this Linux cloud environment. The user explicitly selected local-broker acceptance; no external VPS was tested. Large/binary datasets for detached jobs must already exist on the selected owner's agent workspace. The terminal supports line commands, and its input restriction does not sandbox trusted notebook Python execution.
