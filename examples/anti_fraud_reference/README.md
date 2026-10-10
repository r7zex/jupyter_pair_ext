# Synthetic anti-fraud reference

This small PyTorch project verifies training infrastructure. No real fraud data
were supplied, and no result from this example establishes real fraud detection
quality, a new method, or MLP superiority. Its files can be collaboratively
edited alongside the manuscript scaffold in `paper/outline.md`.

## Environment and run

Run commands from the repository root with your training interpreter. The
validated CPU environment uses Python 3.12.14, NumPy 2.5.3 and PyTorch 2.14.1+cpu.
Install dependencies into an isolated environment; they are not extension/VSIX
dependencies. Install Torch from its CPU index when no GPU is intended:

```sh
python -m venv /tmp/pair-fraud-env
/tmp/pair-fraud-env/bin/python -m pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
/tmp/pair-fraud-env/bin/python -m pip install -r examples/anti_fraud_reference/requirements.txt
/tmp/pair-fraud-env/bin/python -m examples.anti_fraud_reference generate-data \
  --output examples/anti_fraud_reference/.runs/data
/tmp/pair-fraud-env/bin/python -m examples.anti_fraud_reference train \
  --config examples/anti_fraud_reference/configs/reference.json \
  --data examples/anti_fraud_reference/.runs/data/transactions.csv \
  --manifest examples/anti_fraud_reference/.runs/data/dataset-manifest.json \
  --output examples/anti_fraud_reference/.runs/logistic-seed7
```

Use the corresponding `Scripts/python.exe` path on Windows. The source is
portable Python; Windows filesystem durability and real CUDA execution require
their own tests. Configured epochs are the algorithm's completion condition.
There is no duration limit or inactivity cancellation in this pipeline.

The run directory freezes streamed, SHA-256 verified data, configuration,
source files and environment metadata before training. Results record the run
ID, dataset/source hashes, actual Git base commit and package versions; the
source hash also identifies uncommitted Python changes. When the compute agent
sets `PAIR_NOTEBOOK_JOB_ID`, `PAIR_NOTEBOOK_SOURCE_SHA256`,
`PAIR_NOTEBOOK_DATA_SHA256` and `PAIR_NOTEBOOK_DATA_VERSION`, those authoritative
job identities are also retained. Do not edit or share private run datasets
with every participant automatically.

## Resume and artifacts

`resume` uses the same arguments and original full configuration as `train`:

```sh
python -m examples.anti_fraud_reference resume \
  --config examples/anti_fraud_reference/configs/reference.json \
  --data examples/anti_fraud_reference/.runs/data/transactions.csv \
  --manifest examples/anti_fraud_reference/.runs/data/dataset-manifest.json \
  --output examples/anti_fraud_reference/.runs/logistic-seed7
```

For a controlled demonstration, add `--stop-after-epoch 4` to `train`; then
resume. This explicit pause produces a complete epoch checkpoint. It does not
publish a completed experiment's results or restart from scratch. Every
continuation records its start epoch/step and source checkpoint. A resume from
an already completed run only regenerates evaluation artifacts.

- `checkpoints/resume-*.pt`: full last-epoch model, optimizer, scheduler, AMP
  scaler (empty when disabled), Python/NumPy/Torch CPU/CUDA RNG, epoch/global
  step, history, train-only preprocessing, configuration and provenance.
- `checkpoints/best-*.pt`: separate state selected by validation PR-AUC.
- `checkpoints/export-*.pt`: inference weights, frozen preprocessing,
  validation thresholds, configuration and provenance; safe weights-only
  deserialization is used for this role.
- `results.json`, `training-metrics.json`, `test-predictions.json`: durable
  structured experiment artifacts independent of terminal scrollback.

Writes go to a temporary file, fsync it, atomically rename it, then publish an
integrity sidecar and finally an atomic role pointer. Uncommitted files and
temporary writes are ignored. Format/schema, size and SHA-256 are checked before
loading. Prior checkpoints are retained indefinitely: this example has **no
automatic rotation or deletion**, and ordinary editor autosave is unrelated.
Owners must plan disk space and explicitly archive/remove complete experiments.
Set `checkpoint_every_epochs` to control checkpoint cost. Each save is at a
complete epoch; an interrupted epoch is replayed from the last saved boundary.

A damaged latest checkpoint fails by default. Add
`--allow-retained-fallback` to `resume` to explicitly permit rollback to an older
usable retained checkpoint. The continuation receipt records that rollback.
Changing configuration, source version, dataset bytes/version, train
preprocessing, device or tested environment rejects exact resume. Missing or
altered frozen data also rejects it. Power-loss durability depends on the
filesystem/provider; SHA-256 is an integrity check, not owner authentication.
Resume artifacts include Python state, so load only trusted owner artifacts.

To verify the inference export independently:

```sh
python -m examples.anti_fraud_reference evaluate-export \
  --checkpoints examples/anti_fraud_reference/.runs/logistic-seed7/checkpoints \
  --data examples/anti_fraud_reference/.runs/data/transactions.csv \
  --manifest examples/anti_fraud_reference/.runs/data/dataset-manifest.json \
  --output examples/anti_fraud_reference/.runs/logistic-seed7/export-evaluation.json
```

## Data and evaluation protocol

The generator produces imbalanced synthetic chronological transactions with
explicit `label_available_at`. Each train/validation/test window excludes labels
that have not matured by its window end. Configured gaps separate windows.
This is a concrete test protocol, not a justified policy for an unknown real
fraud dataset; set real windows and delay assumptions using actual provenance.

Customer counts and mean amounts use only past observed transactions, never
future events or fraud labels. Events in gaps remain legitimate past events for
later features. The scaler is fit only on mature training rows. Validation
selects the best model and three operating thresholds: minimum configured
FP/FN cost, recall at a configured FPR constraint, and review capacity. Test
labels do not choose thresholds. Capacity accepts above-threshold transactions
ranked by score, at most `floor(review_fraction * window_rows)`; tie order is
stable. Future FPR can exceed the validation target and is reported honestly.

Metrics include noninterpolated PR-AUC/average precision, precision, recall,
FPR, confusion matrix, reviews, cost and Brier score. Known/new customers are
defined by presence in the training window. Subgroup metrics independently apply
the locked threshold/capacity policy to each subgroup, rather than claiming a
single global review allocation across groups. Calibration tuning, repeated
time windows and real-data uncertainty are not performed by this reference.

## Baseline, ablation and paper tables

Run a logistic baseline, small dropout MLP and history-removal MLP with explicit
independent seeds:

```sh
python -m examples.anti_fraud_reference suite \
  --config examples/anti_fraud_reference/configs/reference.json \
  --data examples/anti_fraud_reference/.runs/data/transactions.csv \
  --manifest examples/anti_fraud_reference/.runs/data/dataset-manifest.json \
  --output examples/anti_fraud_reference/.runs/comparison --seeds 7 13 29
```

`paper/tables.md` and `paper/table-provenance.json` are generated only from
completed saved results. Tables include mean/sample standard deviation across
distinct seeds, with configuration/data/source identities and checkpoint links.
Standard deviation is seed variation, not a confidence interval over real
transactions. Duplicate run IDs/seeds are rejected, and differing training
configurations are never pooled. To regenerate from chosen saved artifacts:

```sh
python -m examples.anti_fraud_reference tables --results /path/run-a/results.json \
  /path/run-b/results.json --output /path/manuscript-generated
```

## Separate compute agent and owner data

The generated `owner-data-manifest.json` follows the agent's versioned
`{version, files: [{path, size, sha256}]}` provisioning schema. Start the owner
agent with the data directory as `--workspace` and that manifest as
`--data-manifest`. Files are copied and verified into each immutable job
workspace before execution; source snapshots do not transport private CSV or
large binary datasets. Use nested entrypoint
`examples/anti_fraud_reference/run_reference.py` with arguments such as
`train --config examples/anti_fraud_reference/configs/reference.json --data
transactions.csv --manifest dataset-manifest.json --output artifacts/run-a`.

Example agent invocation (fill in the authorized broker/identity/state paths):

```sh
python scripts/pair-notebook-agent.py --url https://your-broker.example \
  --id owner-cpu --state /owner/agent-state \
  --workspace /owner/reference-data \
  --data-manifest /owner/reference-data/owner-data-manifest.json \
  --python /owner/venv/bin/python
```

Retrieve artifacts explicitly using owner filesystem/SSH access. For a new
accepted continuation job, provision the previous run's checkpoints and frozen
inputs deliberately and call `resume`; a new job ID and continuation receipt
identify it. Nothing automatically relaunches an accepted training job.

## Verification boundary

```sh
python -W error::ResourceWarning -m unittest test/anti_fraud_reference_test.py -v
```

The targeted suite contains 12 unique tests. They exercise real CPU Torch
training, owner files, checkpoint publication,
actual subprocess exit during serialization, corruption/format rejection,
dataset/config/source changes, deterministic model/optimizer/scheduler/scaler/
RNG/history equivalence, independent export evaluation, causal preprocessing and
generated-table provenance. The serialization fault is injected at the
`torch.save` boundary in a real child process. Native VS Code, broker networking,
external VPS, physical CUDA, Windows and multi-hour execution are separate
infrastructure acceptance tests and are not established by this model example.
