# Critical training lifecycle audit — 9 October 2026

Version: **0.5.36**. Branch: `codex/vps-persistent-compute`. Baseline: `3ad515a881ae70412d168ea0142365e254f20a2e`, fetched and confirmed against GitHub before editing. Earlier audits remain historical records; this audit continues the [0.5.35 training verification](HOST_TRAINING_AUDIT_0.5.35_2026-10-09.md).

## Most critical reproduced failures

| Priority | Failure in the baseline | Result after correction |
| --- | --- | --- |
| P1 | Killing a detached VPS runner left training alive, while recovery could release its claim as interrupted. Cancellation could no longer stop it. | Supervision contains training descendants; recovery waits for runner and execution locks through cleanup, without replaying accepted intent. |
| P1 | Deleting and recreating a notebook reused its previous live kernel and Python variables. A deleted running notebook could continue writing checkpoints. | Deletion stops the kernel, cancels pending preparation, and removes notebook-specific interpreter/compute state. Recreated notebooks start with clean variables. |
| P1 | Changing the host repository, including selecting the same folder again, terminated training running in the shared terminal. | A live terminal blocks repository replacement until the host explicitly stops it with Ctrl+C. Rejected replacement leaves training alive. |
| P2 | Selecting CPU removed `CUDA_VISIBLE_DEVICES`, exposing available GPUs instead of hiding them. | CPU launch and restart set an empty CUDA mask; GPU selection keeps its explicit device mapping. A real Jupyter test checks the environment. |
| P2 | Pasting an overlong terminal command silently discarded its suffix and executed the prefix. | The entire overlong line is rejected. Bounded input state handles chunked paste, Unicode, backspace and lifecycle reset. |

These are concrete functional failures with reproductions and regression checks. They do not imply that every possible platform or third-party environment has been exhaustively tested.

## Additional issues caught before publication

Review of the notebook deletion fix exposed an overwrite-rename ordering defect: moving the source kernel before collaborative replacement deleted that source kernel. The real two-kernel reproduction failed before the correction. Replacement now deletes the old destination first and then moves the source runtime state. An old destination execution cannot decrement the moved source's active counter or change its status. The regression checks continuing training, Busy state, source compute/interpreter settings and retained Python variables.

Independent process testing exposed a second prepublication issue: killing the newly introduced private supervisor could leave Linux training alive and publish failure prematurely. The runner now acts as a second Linux subreaper, stopping and reaping adopted descendants before failure publication and stream closure. Real supervisor-SIGKILL regressions cover both ordinary workers and workers in separate sessions. Independent reproduction confirms that training and workers are already dead when failure first becomes visible, heartbeats stop, and the runner exits without an output-close deadlock. The existing polling-daemon outage continues to preserve training.

## Complete model-training acceptance

The final acceptance reruns ten actual training programs from the production integration fixtures:

- Four live notebook runs: standard-library and CPU PyTorch models through both the peer mesh and the local VPS-only route.
- Four shared-terminal runs with the same model/transport combinations, launched after `cd cli` from nested Python entrypoints importing the owner's repository modules.
- Two detached-agent runs, one per model, including editor/polling-daemon disconnection and broker outage while training continues.

The pipeline loads configuration, Python helpers and datasets from the owner repository, trains, saves a checkpoint, reloads and evaluates it. PyTorch loads binary tensors through `TensorDataset`/`DataLoader`, uses autograd and SGD with momentum for 100 epochs/300 steps, then reloads both model and optimizer. Acceptance requires MSE below `1e-10` and prediction error below `1e-4`.

Owner-only datasets, `.git` content and model checkpoints are not sent to guests or embedded in text job snapshots. Detached jobs access separately provisioned owner data through `PAIR_NOTEBOOK_WORKSPACE`. Guests see host terminal output, including recovered completion after a broker outage; remote shell-input frames remain rejected.

## Verification

```bash
npm run compile
npm run lint
PYTHONPATH=/workspace/.jupyter_pair_ext_python \
PAIR_NOTEBOOK_TEST_TORCH_PYTHON=/workspace/.pair_torch_venv/bin/python \
node node_modules/mocha/bin/mocha.js --timeout 20000 --exit 'out/test/**/*.test.js'
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
```

Final results: **4670 TypeScript tests passed**, with zero failures or skips; compilation and lint passed. **90 Python audit tests passed in 33.655 seconds**, with `ResourceWarning` treated as an error. After the final Python change, the 23-test durable VPS suite and both detached model-training cases were rerun successfully. These repeats are already part of the 4670 cases and are not added to that unique count.

The full suite completed all ten model-training programs described above. Targeted terminal/CPU/deletion checks also passed (24 cases), and the subsequent lifecycle check passed five cases including the new overwrite-rename regression. Four lifecycle cases overlap earlier focused coverage and are not counted as additional unique tests.

Release validation checks VSIX/source ZIP integrity, version agreement and byte-for-byte inclusion of the tested extension bundle, Python bridge, final agent script and regression sources. Packaging preflight verifies the bundled native assets for seven platforms. The Python agent is distributed in the complete source archive and repository; it is not embedded in the extension VSIX.

## Practical limits

- As requested by the owner, VPS acceptance uses a real local broker and Python agent. No external deployed VPS was accessed.
- The production runtime, filesystem, child processes, Jupyter, transport framing and broker are exercised; the unavailable VS Code API boundary is substituted in integration tests. The model fixtures simulate the peer topology with an in-memory Trystero boundary. Native VS Code UI and a physical internet peer topology are not launched here.
- CPU masking is checked in a real Jupyter process. No physical GPU training was performed in this CPU environment.
- Windows Job Object containment is implemented and source-reviewed; native Windows execution is unverified here.
- Guest terminal input restriction is not an operating-system sandbox for notebook Python. Collaboration remains a trusted workspace: notebook execution can access the executor's files and OS account.
- The shared terminal supports persistent line commands and streamed output. Full-screen TTY applications and interactive password prompts use the host's ordinary local terminal.

Install the updated extension on every participant and replace `scripts/pair-notebook-agent.py` on every compute owner's machine to receive both parts of the fixes.
