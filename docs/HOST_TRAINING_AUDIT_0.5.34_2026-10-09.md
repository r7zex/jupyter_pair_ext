# Host training input recovery — 9 October 2026

Version: 0.5.34. Branch: `codex/vps-persistent-compute`. Baseline: `de1605f8b64cec5f7a91e05fa3d08b6e4f3f86d9`, fetched and confirmed against GitHub before editing. Earlier reports, including the [8 October audit](HOST_TRAINING_AUDIT_2026-10-08.md) and [0.5.33 PyTorch audit](HOST_TRAINING_AUDIT_0.5.33_2026-10-09.md), remain historical records.

## Reproduced failures

Two real-process regression cases failed against the baseline after initial persistence had finished and files were removed from the host repository:

- A subsequent cell in the same Jupyter kernel could not load a removed canonical module or binary dataset. Binary preparation only ran when creating a new kernel.
- A host terminal command restored the binary but left a removed canonical Python module absent. Preparation only checked binary files.

Initial reproduction also checked the binary failure independently: with the module still available, the warm kernel returned `FileNotFoundError` for the removed dataset. With pending initial writes explicitly drained, the notebook returned `ModuleNotFoundError` and the terminal check returned `ENOENT` for the removed module.

## Resulting behavior

Every host cell and shared-terminal command now checks canonical project inputs in the host repository. Missing text, configuration and notebooks are serialized through the existing persistence adapter. Missing binaries are copied from the working copy using the existing atomic publication and SHA-256 verification. The kernel is looked up after preparation, preserving concurrent-kernel reuse and authority checks.

Recovery retains running Python variables, existing host edits, private datasets and generated checkpoints. It does not recreate shared-project deletions. A directory or unsafe path at a dependency location remains an error rather than being overwritten. An unavailable or changed canonical binary rejects preparation before code or shell input is submitted. The preparation guard is released and execution can be retried after restoring the canonical file.

## Verification

The two new Jupyter/shell cases restore missing inputs, retain kernel identity and variables, preserve private binary data and a generated checkpoint, reject a corrupt canonical copy without publishing a partial file or executing the command/cell, and successfully retry. They also verify that an existing host edit survives recovery.

All four live model-training cases first execute a guest warmup cell, finish persistence, and remove the host's canonical module, configuration and notebook. Subsequent guest training restores those inputs while retaining the same kernel and its Python variable. Both standard-library fitting and real CPU PyTorch training exercise the peer mesh and a VPS-only relay with a broker outage. Binary datasets remain exclusively in the owner's repository. Checkpoint reload, evaluation, terminal input authority, guest output and repository switching are checked afterward.

The full suite also revalidates both detached owner-agent model pipelines using a real Python agent and persistent local broker. The editor/controller and broker stop during execution; the job completes and its result is recovered. PyTorch uses `DataLoader`, autograd and SGD with momentum for 100 epochs/300 steps, restores model and optimizer state, and verifies MSE below `1e-10` and prediction error below `1e-4`.

```bash
npm run compile
npm run lint
PYTHONPATH=/workspace/.jupyter_pair_ext_python \
PAIR_NOTEBOOK_TEST_TORCH_PYTHON=/workspace/.pair_torch_venv/bin/python \
node node_modules/mocha/bin/mocha.js --timeout 20000 --exit 'out/test/**/*.test.js'
python3 -W error::ResourceWarning test/vps_agent_audit.py -q
node scripts/make-artifacts.mjs --preflight-only
```

The environment retains Jupyter and an isolated PyTorch 2.14.1+cpu interpreter installed during the previous audit; the extension adds no machine-learning dependencies. Final check counts and distribution details are recorded in [the result file](HOST_TRAINING_AUDIT_0.5.34_2026-10-09.json). Packaging verifies native binary hashes and the compiled runtime; archive contents are compared with the tested files before push.

## Scope

This audit uses the managed Linux cloud checkout and real filesystem, shell, Jupyter, HTTP/WebSocket broker and agent paths. The unavailable native VS Code editor/window boundary is substituted in integration tests. Native VS Code rendering, physical GPU training and Windows process lifetime remain unverified. The user selected local-broker acceptance; no external VPS was tested. Detached jobs require large/binary datasets to exist in the selected agent owner's workspace. Guests can read the shared terminal and only the current host can submit commands; this restriction does not sandbox trusted notebook Python execution.

The environment's current date is 9 October 2026. New changes and commits use that actual date; the 8 October history is preserved.
