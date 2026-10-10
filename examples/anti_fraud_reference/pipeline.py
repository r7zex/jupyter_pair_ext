"""Train, resume and evaluate a small *synthetic* PyTorch reference."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import subprocess
import tempfile
import uuid

import numpy as np
import torch
from torch import nn

from .checkpoints import (CheckpointError, CheckpointStore, atomic_json, capture_random_state,
                          digest_file, digest_json, restore_random_state)
from .data import chronological_split, fit_preprocessor, load_dataset, transform
from .metrics import average_precision, evaluate, select_thresholds


def validate_config(config: dict) -> None:
    required = {"experiment_name", "model", "seed", "device", "epochs", "batch_size", "learning_rate",
                "checkpoint_every_epochs", "use_history", "amp", "split", "operating_point"}
    if set(config) != required:
        raise ValueError(f"configuration keys differ from schema: {sorted(set(config) ^ required)}")
    for name in ["epochs", "batch_size", "checkpoint_every_epochs"]:
        if type(config[name]) is not int or config[name] <= 0:
            raise ValueError(f"{name} must be a positive integer")
    if type(config["seed"]) is not int or config["seed"] < 0 or not isinstance(config["experiment_name"], str) or not config["experiment_name"]:
        raise ValueError("seed/name invalid")
    if config["model"] not in {"logistic", "mlp"} or config["device"] not in {"cpu", "cuda"}:
        raise ValueError("model/device unsupported")
    if type(config["amp"]) is not bool or type(config["use_history"]) is not bool:
        raise ValueError("amp/use_history must be booleans")
    if config["amp"] and config["device"] != "cuda":
        raise ValueError("AMP in this reference requires CUDA")
    if not math.isfinite(config["learning_rate"]) or config["learning_rate"] <= 0:
        raise ValueError("learning_rate invalid")
    costs = config["operating_point"]
    if set(costs) != {"max_fpr", "review_fraction", "false_positive_cost", "false_negative_cost"}:
        raise ValueError("operating point schema invalid")
    if not all(math.isfinite(value) for value in costs.values()) or not (0 < costs["max_fpr"] < 1 and 0 < costs["review_fraction"] < 1 and costs["false_positive_cost"] > 0 and costs["false_negative_cost"] > 0):
        raise ValueError("operating point values invalid")


def source_identity() -> dict:
    directory = Path(__file__).parent
    files = {path.name: digest_file(path) for path in sorted(directory.glob("*.py"))}
    files["requirements.txt"] = digest_file(directory / "requirements.txt")
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=directory, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        commit = "unavailable"
    return {"sha256": digest_json(files), "files": files, "git_commit": commit}


def make_model(config: dict, features: int) -> nn.Module:
    if config["model"] == "logistic":
        return nn.Linear(features, 1)
    return nn.Sequential(nn.Linear(features, 16), nn.ReLU(), nn.Dropout(.2), nn.Linear(16, 1))


def _environment(device: str) -> dict:
    return {"python": platform.python_version(), "numpy": np.__version__, "torch": str(torch.__version__),
            "cuda_runtime": torch.version.cuda, "device": device,
            "cuda_device_count": torch.cuda.device_count() if device == "cuda" else 0,
            "cuda_device_names": [torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())] if device == "cuda" else [],
            "deterministic_algorithms": True, "torch_threads": 1}


def _stream_snapshot(source: Path, destination: Path, expected_sha: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".dataset-", suffix=".tmp", dir=destination.parent)
    sha = hashlib.sha256()
    try:
        with source.open("rb") as incoming, os.fdopen(descriptor, "wb") as outgoing:
            for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                sha.update(chunk)
                outgoing.write(chunk)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        if sha.hexdigest() != expected_sha:
            raise ValueError("dataset changed during snapshot")
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def train(config: dict, dataset: Path, manifest: Path, output: Path, *, resume: bool = False,
          allow_fallback: bool = False, stop_after_epoch: int | None = None) -> dict:
    """Resume only from epoch boundaries, with the original full config.

    stop_after_epoch is an explicit test/controlled-pause boundary, not a hidden
    runtime limit. It leaves a complete resume checkpoint and never exports a
    scientifically interpreted result for an unfinished training run.
    """
    config = copy.deepcopy(config)
    validate_config(config)
    if stop_after_epoch is not None and (type(stop_after_epoch) is not int or stop_after_epoch < 1):
        raise ValueError("stop_after_epoch must be a positive epoch")
    if config["device"] == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but no real CUDA device is available")
    # CUBLAS must see this before first CUDA allocation. A caller that already
    # initialized CUDA must configure deterministic workspace before launch.
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)
    random.seed(config["seed"])
    np.random.seed(config["seed"])
    torch.manual_seed(config["seed"])
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config["seed"])

    rows, dataset_manifest = load_dataset(Path(dataset), Path(manifest))
    splits = chronological_split(rows, config["split"])
    preprocessor = fit_preprocessor(splits["train"], config["use_history"])
    identities = {
        "config_sha256": digest_json(config),
        "dataset_id": dataset_manifest["dataset_id"], "dataset_sha256": dataset_manifest["sha256"],
        "manifest_sha256": digest_json(dataset_manifest),
        "source": source_identity(), "environment": _environment(config["device"]),
        "compute_agent": {key: os.environ.get(key) for key in ["PAIR_NOTEBOOK_JOB_ID", "PAIR_NOTEBOOK_SOURCE_SHA256", "PAIR_NOTEBOOK_DATA_SHA256", "PAIR_NOTEBOOK_DATA_VERSION"]},
    }
    output = Path(output)
    if not resume and output.exists() and any(output.iterdir()):
        raise ValueError("output already contains an experiment; use an empty directory or explicit resume")
    output.mkdir(parents=True, exist_ok=True)
    store = CheckpointStore(output / "checkpoints")
    if resume:
        saved, checkpoint_path, fell_back = store.load("resume", allow_fallback)
        previous = saved["provenance"]
        for key in ["config_sha256", "dataset_id", "dataset_sha256", "manifest_sha256", "environment"]:
            if previous[key] != identities[key]:
                raise CheckpointError(f"resume rejected: {key} changed")
        if previous["source"]["sha256"] != identities["source"]["sha256"]:
            raise CheckpointError("resume rejected: source version changed")
        if saved["config"] != config or saved["preprocessor"] != preprocessor:
            raise CheckpointError("resume rejected: config or train-only preprocessing mismatch")
        run_id = saved["run_id"]
        identities = previous
        if not (output / "inputs" / "transactions.csv").is_file() or digest_file(output / "inputs" / "transactions.csv") != identities["dataset_sha256"]:
            raise CheckpointError("frozen dataset snapshot missing or changed")
        try:
            if digest_json(json.loads((output / "inputs/config.json").read_text())) != identities["config_sha256"]:
                raise CheckpointError("frozen config snapshot changed")
            if digest_json(json.loads((output / "inputs/dataset-manifest.json").read_text())) != identities["manifest_sha256"]:
                raise CheckpointError("frozen dataset manifest changed")
            for filename, expected_sha in identities["source"]["files"].items():
                frozen_source = output / "source_snapshot" / filename
                if frozen_source.is_symlink() or digest_file(frozen_source) != expected_sha:
                    raise CheckpointError("frozen source snapshot changed")
        except (OSError, ValueError) as error:
            if isinstance(error, CheckpointError):
                raise
            raise CheckpointError(f"frozen input/source snapshot incomplete: {error}") from error
    else:
        saved = None
        run_id = uuid.uuid4().hex
        fell_back = False
        _stream_snapshot(Path(dataset), output / "inputs" / "transactions.csv", dataset_manifest["sha256"])
        atomic_json(output / "inputs" / "dataset-manifest.json", dataset_manifest)
        atomic_json(output / "inputs" / "config.json", config)
        source_directory = output / "source_snapshot"
        source_directory.mkdir()
        for filename, expected_sha in identities["source"]["files"].items():
            _stream_snapshot(Path(__file__).parent / filename, source_directory / filename, expected_sha)
        atomic_json(output / "provenance.json", {"run_id": run_id, **identities})

    # Freeze the actual training view to the verified snapshot, even if an
    # editor changes the owner data after launch.
    rows, _ = load_dataset(output / "inputs" / "transactions.csv", output / "inputs" / "dataset-manifest.json")
    splits = chronological_split(rows, config["split"])
    preprocessor = fit_preprocessor(splits["train"], config["use_history"])
    device = torch.device(config["device"])
    tensors = {name: (torch.from_numpy(transform(selected, preprocessor)).to(device),
                      torch.tensor([row["label"] for row in selected], dtype=torch.float32, device=device))
               for name, selected in splits.items()}
    model = make_model(config, len(preprocessor["feature_indices"])).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=config["learning_rate"])
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=4, gamma=.8)
    scaler = torch.amp.GradScaler("cuda", enabled=config["amp"])
    epoch, global_step = 0, 0
    history = []
    best_validation_pr_auc = -1.0
    best_checkpoint = None
    if saved is not None:
        model.load_state_dict(saved["model"])
        optimizer.load_state_dict(saved["optimizer"])
        scheduler.load_state_dict(saved["scheduler"])
        scaler.load_state_dict(saved["scaler"])
        epoch, global_step = saved["epoch"], saved["global_step"]
        if not (0 <= epoch <= config["epochs"]) or type(global_step) is not int or global_step < 0:
            raise CheckpointError("resume epoch/step invalid")
        history = saved["history"]
        best_validation_pr_auc = saved["best_validation_pr_auc"]
        best_checkpoint = saved.get("best_checkpoint")
        restore_random_state(saved["rng"], config["device"])
        # Keep an explicit continuation receipt; never disguise a new start as
        # resume. This records a rollback when the owner enabled fallback.
        atomic_json(output / f"continuation-{uuid.uuid4().hex}.json", {
            "run_id": run_id, "resumed_checkpoint": checkpoint_path.name,
            "start_epoch": epoch, "start_global_step": global_step, "retained_fallback": fell_back,
            "continuation_compute_agent": {key: os.environ.get(key) for key in ["PAIR_NOTEBOOK_JOB_ID", "PAIR_NOTEBOOK_SOURCE_SHA256", "PAIR_NOTEBOOK_DATA_SHA256", "PAIR_NOTEBOOK_DATA_VERSION"]},
        })
    training_x, training_y = tensors["train"]
    positives = float(training_y.sum())
    criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor((len(training_y) - positives) / positives, device=device))

    def scores_for(name: str) -> np.ndarray:
        model.eval()
        with torch.no_grad():
            return torch.sigmoid(model(tensors[name][0]).flatten()).cpu().numpy().astype(np.float64)

    def state_payload() -> dict:
        return {"run_id": run_id, "experiment_name": config["experiment_name"], "model": model.state_dict(),
                "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
                "rng": capture_random_state(), "epoch": epoch, "global_step": global_step,
                "config": config, "provenance": identities, "preprocessor": preprocessor,
                "history": history, "best_validation_pr_auc": best_validation_pr_auc, "best_checkpoint": best_checkpoint}

    last_resume = None
    while epoch < config["epochs"]:
        model.train()
        permutation = torch.randperm(len(training_y))
        loss_sum = 0.0
        for offset in range(0, len(permutation), config["batch_size"]):
            indices = permutation[offset:offset + config["batch_size"]].to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, enabled=config["amp"]):
                loss = criterion(model(training_x[indices]).flatten(), training_y[indices])
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            global_step += 1
            loss_sum += float(loss.detach()) * len(indices)
        scheduler.step()
        epoch += 1
        validation_scores = scores_for("validation")
        validation_labels = tensors["validation"][1].cpu().numpy().astype(np.int64)
        pr_auc = average_precision(validation_labels, validation_scores)
        history.append({"epoch": epoch, "global_step": global_step, "loss": loss_sum / len(training_y),
                        "validation_pr_auc": pr_auc, "learning_rate": scheduler.get_last_lr()[0]})
        if pr_auc > best_validation_pr_auc:
            best_validation_pr_auc = pr_auc
            best_checkpoint = store.save("best", state_payload()).name
        if epoch % config["checkpoint_every_epochs"] == 0 or epoch == config["epochs"] or epoch == stop_after_epoch:
            last_resume = store.save("resume", state_payload())
        atomic_json(output / "training-metrics.json", {"run_id": run_id, "epochs": history})
        print(json.dumps({"run_id": run_id, **history[-1], "last_checkpoint": last_resume.name if last_resume else None}), flush=True)
        if epoch == stop_after_epoch and epoch < config["epochs"]:
            return {"status": "paused-at-epoch-checkpoint", "run_id": run_id, "epoch": epoch,
                    "global_step": global_step, "checkpoint": str(last_resume)}

    # Best checkpoint is selected only on validation and separately retained
    # from last resumable state. Do not replace the resume optimizer with best.
    if not best_checkpoint:
        raise CheckpointError("best validation checkpoint missing")
    best_metadata = json.loads((store.root / (best_checkpoint + ".json")).read_text())
    best, best_path = store._read(best_metadata, "best")
    model.load_state_dict(best["model"])
    validation_scores, test_scores = scores_for("validation"), scores_for("test")
    validation_labels = tensors["validation"][1].cpu().numpy().astype(np.int64)
    test_labels = tensors["test"][1].cpu().numpy().astype(np.int64)
    thresholds = select_thresholds(validation_labels, validation_scores, config["operating_point"])
    metrics = evaluate(test_labels, test_scores, thresholds, config["operating_point"])
    known_customers = {row["customer_id"] for row in splits["train"]}
    subgroup_metrics = {}
    for group, mask in [("known_customers", np.asarray([row["customer_id"] in known_customers for row in splits["test"]])),
                        ("new_customers", np.asarray([row["customer_id"] not in known_customers for row in splits["test"]]))]:
        subgroup_metrics[group] = evaluate(test_labels[mask], test_scores[mask], thresholds, config["operating_point"]) if mask.any() else {"status": "not-evaluated-no-rows"}
    export_path = store.save("export", {"run_id": run_id, "epoch": best["epoch"], "global_step": best["global_step"],
                                        "model": model.state_dict(), "config": config, "preprocessor": preprocessor,
                                        "provenance": identities, "thresholds": thresholds})
    result = {"format_version": 1, "status": "completed", "kind": "synthetic-infrastructure-only",
              "run_id": run_id, "experiment_name": config["experiment_name"], "model": config["model"],
              "seed": config["seed"], "ablation": "full-history" if config["use_history"] else "history-removed",
              "config": config, "provenance": identities, "epoch": epoch, "global_step": global_step,
              "best_epoch": best["epoch"], "thresholds": thresholds, "test": metrics, "test_subgroups": subgroup_metrics,
              "split_rows": {name: len(selected) for name, selected in splits.items()},
              "checkpoints": {"last_resume": json.loads((store.root / "latest_resume.json").read_text())["file"],
                              "best_validation": best_path.name, "final_export": export_path.name},
              "scientific_status": {"real_data": "absent", "real_model_superiority": "not-evaluated",
                                    "physical_gpu": "executed" if device.type == "cuda" else "not-evaluated",
                                    "uncertainty": "requires multiple independent configured seeds; see generated table"}}
    atomic_json(output / "test-predictions.json", {"run_id": run_id, "records": [
        {"transaction_id": row["transaction_id"], "event_time": row["event_time"], "label": int(label), "score": float(score)}
        for row, label, score in zip(splits["test"], test_labels, test_scores)]})
    atomic_json(output / "results.json", result)
    return result


def export_predictions(export_directory: Path, dataset: Path, manifest: Path, output: Path) -> dict:
    """Load the weights-only inference artifact and frozen preprocessing."""
    exported, path, _ = CheckpointStore(export_directory).load("export")
    rows, data_manifest = load_dataset(dataset, manifest)
    if exported["provenance"]["dataset_sha256"] != data_manifest["sha256"]:
        raise ValueError("export evaluation dataset identity differs")
    config = exported["config"]
    selected = chronological_split(rows, config["split"])["test"]
    model = make_model(config, len(exported["preprocessor"]["feature_indices"]))
    model.load_state_dict(exported["model"])
    model.eval()
    with torch.no_grad():
        scores = torch.sigmoid(model(torch.from_numpy(transform(selected, exported["preprocessor"]))).flatten()).numpy().astype(np.float64)
    labels = np.asarray([row["label"] for row in selected])
    result = {"run_id": exported["run_id"], "export": path.name,
              "test": evaluate(labels, scores, exported["thresholds"], config["operating_point"])}
    atomic_json(output, result)
    return result
