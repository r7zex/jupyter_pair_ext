"""Synthetic chronological data with delayed labels and causal features."""
from __future__ import annotations

import csv
from collections import defaultdict
import io
import json
import math
from pathlib import Path

import numpy as np

from .checkpoints import atomic_bytes, atomic_json, digest_file

FEATURES = ["log_amount", "hour_sin", "hour_cos", "past_customer_count", "past_customer_mean_amount", "new_customer"]


def generate_dataset(directory: Path, rows: int = 4000, seed: int = 91, label_delay: int = 24) -> dict:
    """Generate infrastructure test data, never a claim about real customers."""
    if rows < 100 or label_delay < 0:
        raise ValueError("rows must be >=100 and label delay nonnegative")
    directory.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(["transaction_id", "event_time", "customer_id", "amount", "label_available_at", "fraud"])
    positives = 0
    for time in range(rows):
        # New customers arrive in later windows as well as recurrent customers.
        customer = f"customer-{rng.integers(0, 150) if time < rows * .7 or rng.random() < .7 else rng.integers(150, 250)}"
        amount = float(np.exp(rng.normal(3.0, 1.05)))
        # Approximately 3% fraud, with noisy nonlinear dependency; not an
        # invented demonstration of any architecture's superiority.
        logit = -4.25 + 1.2 * (math.log(amount) - 3.0) + .6 * math.sin(time / 24.0)
        fraud = int(rng.random() < 1 / (1 + math.exp(-logit)))
        positives += fraud
        writer.writerow([f"synthetic-{time}", time, customer, f"{amount:.8f}", time + label_delay, fraud])
    dataset = directory / "transactions.csv"
    atomic_bytes(dataset, buffer.getvalue().encode())
    manifest = {
        "format_version": 1, "kind": "synthetic-infrastructure-only",
        "dataset_id": f"synthetic-v1-seed{seed}-rows{rows}-delay{label_delay}",
        "file": dataset.name, "sha256": digest_file(dataset), "size": dataset.stat().st_size,
        "rows": rows, "seed": seed, "label_delay": label_delay,
        "fraud_count": positives,
        "scientific_claim": "No real fraud data or validated fraud-model result is provided.",
    }
    atomic_json(directory / "dataset-manifest.json", manifest)
    # This is the separate compute-agent provisioning manifest; its paths are
    # relative to the workspace passed when starting that owner agent.
    atomic_json(directory / "owner-data-manifest.json", {
        "version": manifest["dataset_id"],
        "files": [{"path": dataset.name, "size": manifest["size"], "sha256": manifest["sha256"]},
                  {"path": "dataset-manifest.json", "size": (directory / "dataset-manifest.json").stat().st_size,
                   "sha256": digest_file(directory / "dataset-manifest.json")}],
    })
    return manifest


def load_dataset(path: Path, manifest_path: Path) -> tuple[list[dict], dict]:
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("format_version") != 1 or manifest.get("kind") != "synthetic-infrastructure-only":
        raise ValueError("unsupported dataset manifest; this reference accepts explicitly synthetic test data")
    if not path.is_file() or path.is_symlink():
        raise ValueError("dataset missing or symlink; provision the owner data before running")
    if path.stat().st_size != manifest["size"] or digest_file(path) != manifest["sha256"]:
        raise ValueError("dataset integrity/version changed")
    with path.open(newline="", encoding="utf-8") as stream:
        source_rows = list(csv.DictReader(stream))
    if digest_file(path) != manifest["sha256"]:
        raise ValueError("dataset changed during read")
    if len(source_rows) != manifest["rows"]:
        raise ValueError("dataset row count mismatch")
    rows = []
    last_time = -math.inf
    seen_ids = set()
    history = defaultdict(lambda: [0, 0.0])
    # History uses only already observed transaction amounts, never fraud
    # outcomes (including labels that would be unavailable at prediction time).
    for source in source_rows:
        time = float(source["event_time"])
        amount = float(source["amount"])
        ready = float(source["label_available_at"])
        fraud = int(source["fraud"])
        transaction_id = source["transaction_id"]
        if not all(math.isfinite(value) for value in [time, amount, ready]) or time <= last_time or amount <= 0 or ready < time or fraud not in {0, 1} or transaction_id in seen_ids:
            raise ValueError("invalid or unordered transaction data")
        seen_ids.add(transaction_id)
        last_time = time
        customer = source["customer_id"]
        count, total = history[customer]
        rows.append({
            "transaction_id": transaction_id, "event_time": time,
            "label_available_at": ready, "customer_id": customer, "label": fraud,
            "features": [math.log(amount), math.sin(time / 24), math.cos(time / 24),
                         math.log1p(count), math.log1p(total / count) if count else 0.0, float(count == 0)],
        })
        history[customer][0] += 1
        history[customer][1] += amount
    return rows, manifest


def chronological_split(rows: list[dict], config: dict) -> dict[str, list[dict]]:
    train_end, val_start, val_end, test_start, test_end, gap = [float(config[key]) for key in
        ["train_end", "validation_start", "validation_end", "test_start", "test_end", "gap"]]
    if not all(math.isfinite(value) for value in [train_end, val_start, val_end, test_start, test_end, gap]) or not (
        0 < train_end < val_start < val_end < test_start < test_end and gap >= 0 and
        val_start - train_end >= gap and test_start - val_end >= gap
    ):
        raise ValueError("chronological windows must be ordered with the configured gaps")
    splits = {
        "train": [row for row in rows if row["event_time"] < train_end and row["label_available_at"] <= train_end],
        "validation": [row for row in rows if val_start <= row["event_time"] < val_end and row["label_available_at"] <= val_end],
        "test": [row for row in rows if test_start <= row["event_time"] < test_end and row["label_available_at"] <= test_end],
    }
    for name, selected in splits.items():
        if not selected or {row["label"] for row in selected} != {0, 1}:
            raise ValueError(f"{name} needs mature positive and negative labels")
    return splits


def fit_preprocessor(training: list[dict], use_history: bool) -> dict:
    indices = list(range(len(FEATURES))) if use_history else [0, 1, 2, 5]
    values = np.asarray([row["features"] for row in training], dtype=np.float64)[:, indices]
    return {"feature_indices": indices, "feature_names": [FEATURES[index] for index in indices],
            "mean": values.mean(axis=0).tolist(), "scale": np.maximum(values.std(axis=0), 1e-8).tolist(),
            "fit_scope": "train-mature-labels-only", "training_rows": len(training)}


def transform(rows: list[dict], preprocessor: dict) -> np.ndarray:
    values = np.asarray([row["features"] for row in rows], dtype=np.float64)[:, preprocessor["feature_indices"]]
    return ((values - np.asarray(preprocessor["mean"])) / np.asarray(preprocessor["scale"])).astype(np.float32)
