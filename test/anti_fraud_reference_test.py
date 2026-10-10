"""Real CPU/filesystem reference checks. Run with an isolated Torch interpreter.

No broker/VS Code/GPU availability is implied by these standalone ML checks.
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from examples.anti_fraud_reference.checkpoints import CheckpointError, CheckpointStore, atomic_json, digest_file
from examples.anti_fraud_reference.data import chronological_split, fit_preprocessor, generate_dataset, load_dataset, transform
from examples.anti_fraud_reference.metrics import average_precision, evaluate, select_thresholds
from examples.anti_fraud_reference.pipeline import export_predictions, train
from examples.anti_fraud_reference.report import generate_tables


class ReferencePipelineTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pair-anti-fraud-")
        self.root = Path(self.temporary.name)
        self.data = self.root / "owner-data"
        generate_dataset(self.data, rows=1600, seed=91, label_delay=16)
        self.dataset = self.data / "transactions.csv"
        self.manifest = self.data / "dataset-manifest.json"
        self.config = json.loads((REPO / "examples/anti_fraud_reference/configs/reference.json").read_text())
        self.config.update(epochs=5, batch_size=96, model="mlp")
        self.config["split"] = {"train_end": 850, "validation_start": 900, "validation_end": 1200,
                                "test_start": 1250, "test_end": 1600, "gap": 50}

    def tearDown(self):
        self.temporary.cleanup()

    def run_train(self, output, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return train(self.config, self.dataset, self.manifest, output, **kwargs)

    def assert_state_equal(self, left, right):
        if isinstance(left, torch.Tensor):
            self.assertTrue(torch.equal(left, right))
        elif isinstance(left, np.ndarray):
            np.testing.assert_array_equal(left, right)
        elif isinstance(left, dict):
            self.assertEqual(left.keys(), right.keys())
            for key in left:
                self.assert_state_equal(left[key], right[key])
        elif isinstance(left, (tuple, list)):
            self.assertEqual(len(left), len(right))
            for first, second in zip(left, right):
                self.assert_state_equal(first, second)
        else:
            self.assertEqual(left, right)

    def test_uninterrupted_and_resumed_training_have_identical_states_and_results(self):
        uninterrupted = self.root / "uninterrupted"
        resumed = self.root / "resumed"
        final = self.run_train(uninterrupted)
        pause = self.run_train(resumed, stop_after_epoch=2)
        self.assertEqual(pause["status"], "paused-at-epoch-checkpoint")
        self.assertFalse((resumed / "results.json").exists())
        finished = self.run_train(resumed, resume=True)
        first, _, _ = CheckpointStore(uninterrupted / "checkpoints").load()
        second, _, _ = CheckpointStore(resumed / "checkpoints").load()
        for state in ["model", "optimizer", "scheduler", "scaler", "rng", "history", "epoch", "global_step", "preprocessor"]:
            self.assert_state_equal(first[state], second[state])
        self.assertEqual(final["test"], finished["test"])
        self.assertEqual(final["thresholds"], finished["thresholds"])
        self.assertEqual(final["best_epoch"], finished["best_epoch"])
        evaluated = export_predictions(resumed / "checkpoints", self.dataset, self.manifest, self.root / "export-evaluation.json")
        self.assertEqual(evaluated["test"], finished["test"])
        self.assertEqual(finished["run_id"], pause["run_id"])
        receipt = json.loads(next(resumed.glob("continuation-*.json")).read_text())
        self.assertEqual(receipt["start_epoch"], 2)
        self.assertGreater(receipt["start_global_step"], 0)
        self.assertFalse(receipt["retained_fallback"])

    def test_configuration_change_is_rejected_instead_of_restart(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        self.config["learning_rate"] *= 2
        with self.assertRaisesRegex(CheckpointError, "config_sha256 changed"):
            self.run_train(output, resume=True)
        self.assertFalse((output / "results.json").exists())

    def test_data_change_missing_data_and_frozen_snapshot_corruption_are_rejected(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        original = self.dataset.read_bytes()
        self.dataset.write_bytes(original + b"\n")
        with self.assertRaisesRegex(ValueError, "integrity/version changed"):
            self.run_train(output, resume=True)
        self.dataset.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.run_train(output, resume=True)
        self.dataset.write_bytes(original)
        (output / "inputs/transactions.csv").write_bytes(b"corrupt")
        with self.assertRaisesRegex(CheckpointError, "frozen dataset snapshot missing or changed"):
            self.run_train(output, resume=True)

    def test_valid_but_different_dataset_version_is_rejected(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        generate_dataset(self.data, rows=1600, seed=92, label_delay=16)
        with self.assertRaisesRegex(CheckpointError, "dataset_id changed"):
            self.run_train(output, resume=True)

    def test_tampered_frozen_source_and_config_artifacts_are_rejected(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        source = output / "source_snapshot/data.py"
        original = source.read_bytes()
        source.write_bytes(original + b"\n# changed frozen provenance\n")
        with self.assertRaisesRegex(CheckpointError, "frozen source snapshot changed"):
            self.run_train(output, resume=True)
        source.write_bytes(original)
        frozen_config = copy.deepcopy(self.config)
        frozen_config["epochs"] += 1
        atomic_json(output / "inputs/config.json", frozen_config)
        with self.assertRaisesRegex(CheckpointError, "frozen config snapshot changed"):
            self.run_train(output, resume=True)

    def test_corrupt_latest_requires_explicit_retained_fallback(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        store = CheckpointStore(output / "checkpoints")
        saved, latest, _ = store.load()
        self.assertEqual(saved["epoch"], 2)
        latest.write_bytes(b"corruption")
        with self.assertRaisesRegex(CheckpointError, "integrity mismatch"):
            store.load()
        retained, retained_path, fallback = store.load(allow_fallback=True)
        self.assertTrue(fallback)
        self.assertEqual(retained["epoch"], 1)
        self.assertNotEqual(retained_path, latest)
        result = self.run_train(output, resume=True, allow_fallback=True)
        self.assertEqual(result["status"], "completed")
        receipt = json.loads(next(output.glob("continuation-*.json")).read_text())
        self.assertTrue(receipt["retained_fallback"])

    def test_process_exit_mid_checkpoint_does_not_publish_partial_file(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        store = CheckpointStore(output / "checkpoints")
        pointer = (store.root / "latest_resume.json").read_bytes()
        # Deterministically inject a process exit at the actual serialization
        # boundary; all paths, files and publication code are production.
        script = """
import os, sys
from pathlib import Path
import torch
from examples.anti_fraud_reference.checkpoints import CheckpointStore
store = CheckpointStore(Path(sys.argv[1]))
state, _, _ = store.load()
def interrupted_save(value, stream):
    stream.write(b'incomplete checkpoint')
    stream.flush()
    os.fsync(stream.fileno())
    os._exit(73)
torch.save = interrupted_save
store.save('resume', state)
"""
        child = subprocess.run([sys.executable, "-c", script, str(store.root)], cwd=REPO, capture_output=True, timeout=30)
        self.assertEqual(child.returncode, 73, child.stderr.decode())
        self.assertEqual((store.root / "latest_resume.json").read_bytes(), pointer)
        self.assertTrue(list(store.root.glob("*.tmp")))
        state, _, fallback = store.load()
        self.assertEqual(state["epoch"], 2)
        self.assertFalse(fallback)

    def test_committed_checkpoint_format_and_incomplete_state_are_rejected(self):
        output = self.root / "run"
        self.run_train(output, stop_after_epoch=2)
        store = CheckpointStore(output / "checkpoints")
        state, path, _ = store.load()
        state["format_version"] = 999
        torch.save(state, path)
        metadata = json.loads(path.with_suffix(".pt.json").read_text())
        metadata.update(size=path.stat().st_size, sha256=digest_file(path))
        atomic_json(path.with_suffix(".pt.json"), metadata)
        atomic_json(store.root / "latest_resume.json", metadata)
        with self.assertRaisesRegex(CheckpointError, "envelope mismatch"):
            store.load()
        state["format_version"] = 1
        del state["optimizer"]
        torch.save(state, path)
        metadata.update(size=path.stat().st_size, sha256=digest_file(path))
        atomic_json(path.with_suffix(".pt.json"), metadata)
        atomic_json(store.root / "latest_resume.json", metadata)
        with self.assertRaisesRegex(CheckpointError, "state incomplete"):
            store.load()

    def test_source_change_in_real_copied_project_is_rejected(self):
        project = self.root / "copied-project"
        shutil.copytree(REPO / "examples/anti_fraud_reference", project / "examples/anti_fraud_reference",
                        ignore=shutil.ignore_patterns("__pycache__", ".runs"))
        config_path = project / "config.json"
        atomic_json(config_path, self.config)
        output = self.root / "source-change-run"
        arguments = ["--config", str(config_path), "--data", str(self.dataset), "--manifest", str(self.manifest), "--output", str(output)]
        child = subprocess.run([sys.executable, "-m", "examples.anti_fraud_reference", "train", *arguments, "--stop-after-epoch", "2"],
                               cwd=project, capture_output=True, timeout=30)
        self.assertEqual(child.returncode, 0, child.stderr.decode())
        source = project / "examples/anti_fraud_reference/data.py"
        with source.open("a") as stream:
            stream.write("\n# changed source identity\n")
        resumed = subprocess.run([sys.executable, "-m", "examples.anti_fraud_reference", "resume", *arguments],
                                 cwd=project, capture_output=True, timeout=30)
        self.assertNotEqual(resumed.returncode, 0)
        self.assertIn("source version changed", resumed.stderr.decode())

    def test_chronology_maturity_causal_history_and_train_only_preprocessing(self):
        rows, _ = load_dataset(self.dataset, self.manifest)
        splits = chronological_split(rows, self.config["split"])
        self.assertLess(max(row["event_time"] for row in splits["train"]), 850)
        self.assertLessEqual(max(row["label_available_at"] for row in splits["train"]), 850)
        self.assertGreaterEqual(min(row["event_time"] for row in splits["validation"]), 900)
        self.assertLessEqual(max(row["label_available_at"] for row in splits["validation"]), 1200)
        self.assertGreaterEqual(min(row["event_time"] for row in splits["test"]), 1250)
        processed = fit_preprocessor(splits["train"], True)
        np.testing.assert_allclose(transform(splits["train"], processed).mean(axis=0), 0, atol=1e-6)
        changed_test = copy.deepcopy(splits["test"])
        for row in changed_test:
            row["features"][0] += 1000
        self.assertEqual(processed, fit_preprocessor(splits["train"], True))
        self.assertGreater(float(transform(changed_test, processed)[:, 0].mean()), 100)
        # Changing all future rows cannot change a previously computed feature.
        earlier_features = [row["features"] for row in rows[:850]]
        lines = self.dataset.read_text().splitlines()
        for index in range(1001, len(lines)):
            fields = lines[index].split(",")
            fields[3] = "9999999"
            lines[index] = ",".join(fields)
        self.dataset.write_text("\n".join(lines) + "\n")
        changed_manifest = json.loads(self.manifest.read_text())
        changed_manifest.update(sha256=digest_file(self.dataset), size=self.dataset.stat().st_size)
        atomic_json(self.manifest, changed_manifest)
        altered_rows, _ = load_dataset(self.dataset, self.manifest)
        self.assertEqual(earlier_features, [row["features"] for row in altered_rows[:850]])

    def test_metrics_thresholds_capacity_and_tied_average_precision(self):
        labels = np.asarray([0, 1, 0, 1, 0, 0])
        scores = np.asarray([.1, .9, .5, .7, .4, .3])
        costs = self.config["operating_point"]
        costs["review_fraction"] = .34
        thresholds = select_thresholds(labels, scores, costs)
        self.assertEqual(thresholds["selected_on"], "validation")
        result = evaluate(labels, scores, thresholds, costs)
        self.assertEqual(result["pr_auc_average_precision"], 1.0)
        self.assertLessEqual(result["review_capacity"]["reviews"], 2)
        self.assertEqual(sum(result["minimum_cost"][key] for key in ["tp", "fp", "fn", "tn"]), 6)
        self.assertAlmostEqual(average_precision(np.asarray([0, 1]), np.asarray([.5, .5])), .5)
        # Evaluation can change labels but has no threshold-optimization path.
        original = copy.deepcopy(thresholds)
        evaluate(1 - labels, scores, thresholds, costs)
        self.assertEqual(thresholds, original)

    def test_generated_tables_use_saved_results_and_reject_duplicate_counts(self):
        first = self.root / "seed-7"
        second = self.root / "seed-13"
        self.run_train(first)
        self.config["seed"] = 13
        self.run_train(second)
        paths = [first / "results.json", second / "results.json"]
        record = generate_tables(paths, self.root / "paper")
        self.assertEqual(record["groups"][0]["seeds"], [7, 13])
        expected = sum(json.loads(path.read_text())["test"]["pr_auc_average_precision"] for path in paths) / 2
        self.assertEqual(record["groups"][0]["pr_auc"]["mean"], expected)
        self.assertIsNotNone(record["groups"][0]["pr_auc"]["sample_std"])
        self.assertIn("No real fraud-model performance", (self.root / "paper/tables.md").read_text())
        with self.assertRaisesRegex(ValueError, "duplicate run ID"):
            generate_tables([paths[0], paths[0]], self.root / "duplicate-paper")


if __name__ == "__main__":
    unittest.main()
