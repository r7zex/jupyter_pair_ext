# Shared-terminal training environment — 9 October 2026

Version: 0.5.35. Branch: `codex/vps-persistent-compute`. Baseline: `672d4b0903273a679439712c787be28f7a3a4699`, fetched and confirmed against GitHub before editing. The [8 October audit](HOST_TRAINING_AUDIT_2026-10-08.md), [PyTorch audit](HOST_TRAINING_AUDIT_0.5.33_2026-10-09.md) and [input recovery audit](HOST_TRAINING_AUDIT_0.5.34_2026-10-09.md) remain historical records.

## Reproduced failures

Two new real-shell tests failed against the baseline:

- A shell inherited a stale `PAIR_NOTEBOOK_WORKSPACE` pointing outside the current owner's repository. It did not provide its own workspace identity, unlike the Jupyter kernel and VPS agent.
- After `cd nested`, a real Python entrypoint failed with `ModuleNotFoundError: No module named 'owner_helper'` when importing a module in the owner's repository root. Its inherited Python module path did not include the repository.

## Changes

Shell launch now captures the current owner directory once, uses it as `cwd`, sets `PAIR_NOTEBOOK_WORKSPACE` to that directory and prepends it to `PYTHONPATH`. Existing Python module paths are retained. An inherited workspace from another process cannot redirect training data loading. Ordinary shell state, including `cd`, remains persistent; `PAIR_NOTEBOOK_WORKSPACE` continues to identify the owner root after a directory change. Shell reset and repository replacement launch with the current directory again.

The first new regression verifies a repository path containing spaces, persistent `cd`, replacement of an inherited workspace and refreshed workspace identity after reset to another repository. The second runs a nested Python entrypoint and verifies imports from both the owner root and a separate inherited module directory.

## Complete training through the terminal

The four live integration scenarios now each perform two complete training runs: a guest-requested Jupyter run and a host-command terminal run. Together with the two detached-agent scenarios, this covers ten actual model-training runs: five standard-library fits and five CPU PyTorch fits.

For terminal execution, the host changes into `cli` and invokes a real nested Python script. The script imports the canonical project helper, locates configuration and data through `PAIR_NOTEBOOK_WORKSPACE`, trains, writes a separate checkpoint, reloads and evaluates it, and checks that its actual current directory is still `cli`. Dataset files exist only in the owner's repository; guests do not receive them. PyTorch loads real binary tensors, uses `DataLoader`, autograd and SGD with momentum for 100 epochs/300 steps, and reloads both model and optimizer state. Evaluation requires MSE below `1e-10` and prediction error below `1e-4`.

Both peer-mesh and VPS-only routes verify that the guest sees completed terminal training while shell input remains restricted to the host. In each VPS-only scenario, the broker also stops during terminal training. The host finishes and publishes its checkpoint while the broker is down; after restart, the guest recovers the terminal's completion output. The existing notebook outage, missing-input recovery, terminal repository replacement and detached-agent/editor outage checks remain covered.

## Verification

```bash
npm run compile
npm run lint
PYTHONPATH=/workspace/.jupyter_pair_ext_python \
PAIR_NOTEBOOK_TEST_TORCH_PYTHON=/workspace/.pair_torch_venv/bin/python \
node node_modules/mocha/bin/mocha.js --timeout 20000 --exit 'out/test/**/*.test.js'
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
node scripts/make-artifacts.mjs --preflight-only
```

The cloud retains the separately installed Jupyter modules and an isolated PyTorch 2.14.1+cpu interpreter from earlier audits. No machine-learning package is added to the extension or distribution. Final results are recorded in [the machine-readable report](HOST_TRAINING_AUDIT_0.5.35_2026-10-09.json). VSIX/source ZIP contents and native-library hashes are verified before push.

## Scope

Filesystem access, shell processes, Python/Jupyter, broker HTTP/WebSockets and the detached agent are real production paths. Integration tests substitute the unavailable native VS Code editor/window boundary. Native rendering, physical CUDA training and Windows process lifetime remain unverified in this Linux cloud environment. The user selected local-broker acceptance; no external VPS was tested. Detached jobs require large/binary datasets to exist in the selected agent owner's workspace. Terminal input restrictions do not sandbox trusted notebook Python execution.

The current date is 9 October 2026. New commits use the actual date; the 8 October history is preserved.
