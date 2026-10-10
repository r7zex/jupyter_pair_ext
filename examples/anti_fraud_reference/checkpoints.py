"""Retained, atomic, integrity-checked local training artifacts.

SHA-256 detects incomplete writes/corruption, not malicious replacement. PyTorch
resume files deserialize Python state: load only artifacts from a trusted owner.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import random
import tempfile
import uuid

import numpy as np
import torch

FORMAT_VERSION = 1


class CheckpointError(ValueError):
    pass


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest_json(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _sync_directory(directory: Path) -> None:
    # Windows does not expose POSIX directory fsync. Atomic rename still applies;
    # power-loss durability there depends on the filesystem/provider.
    if os.name == "posix":
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def atomic_json(path: Path, value: object) -> None:
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode())


def capture_random_state() -> dict:
    return {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch_cpu": torch.get_rng_state(),
        "torch_cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
    }


def restore_random_state(state: dict, device: str) -> None:
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(state["torch_cpu"].cpu())
    if device.startswith("cuda"):
        if not torch.cuda.is_available() or len(state["torch_cuda"]) != torch.cuda.device_count():
            raise CheckpointError("CUDA topology changed; exact random-state continuation is unavailable")
        torch.cuda.set_rng_state_all([entry.cpu() for entry in state["torch_cuda"]])


class CheckpointStore:
    """Every save is immutable; latest/best are small atomic pointers.

    No automatic artifact deletion. Interrupted *.tmp files and uncommitted
    checkpoint files are ignored. Cleanup is an explicit owner operation.
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, role: str, payload: dict) -> Path:
        if role not in {"resume", "best", "export"}:
            raise ValueError("unsupported artifact role")
        filename = f"{role}-e{payload.get('epoch', 0):06d}-s{payload.get('global_step', 0):09d}-{uuid.uuid4().hex}.pt"
        destination = self.root / filename
        descriptor, temporary = tempfile.mkstemp(prefix=f".{filename}.", suffix=".tmp", dir=self.root)
        envelope = {**payload, "format_version": FORMAT_VERSION, "role": role}
        try:
            with os.fdopen(descriptor, "wb") as stream:
                torch.save(envelope, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            _sync_directory(self.root)
            metadata = {
                "format_version": FORMAT_VERSION,
                "role": role,
                "file": filename,
                "sha256": digest_file(destination),
                "size": destination.stat().st_size,
                "run_id": envelope["run_id"],
                "epoch": envelope.get("epoch", 0),
                "global_step": envelope.get("global_step", 0),
            }
            # The sidecar commits this retained artifact. The pointer publishes
            # it only after both checkpoint and sidecar have completed.
            atomic_json(destination.with_suffix(".pt.json"), metadata)
            atomic_json(self.root / f"latest_{role}.json", metadata)
            return destination
        finally:
            Path(temporary).unlink(missing_ok=True)

    def _read(self, metadata: dict, expected_role: str) -> tuple[dict, Path]:
        try:
            filename = metadata["file"]
            if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith(".pt"):
                raise CheckpointError("invalid checkpoint path")
            path = self.root / filename
            if path.is_symlink() or not path.is_file():
                raise CheckpointError("checkpoint missing or unsafe")
            committed = json.loads(path.with_suffix(".pt.json").read_text())
            if committed != metadata or metadata["format_version"] != FORMAT_VERSION or metadata["role"] != expected_role:
                raise CheckpointError("checkpoint format, role or commit metadata mismatch")
            if path.stat().st_size != metadata["size"] or digest_file(path) != metadata["sha256"]:
                raise CheckpointError("checkpoint integrity mismatch")
            # This is intentionally full trusted training state, including
            # optimizer and Python/NumPy RNG, rather than a weights-only export.
            payload = torch.load(path, map_location="cpu", weights_only=expected_role == "export")
            if payload["format_version"] != FORMAT_VERSION or payload["role"] != expected_role or payload["run_id"] != metadata["run_id"]:
                raise CheckpointError("checkpoint envelope mismatch")
            required = {"model", "config", "provenance", "preprocessor"}
            if expected_role in {"resume", "best"}:
                required |= {"optimizer", "scheduler", "scaler", "rng", "epoch", "global_step", "history", "best_validation_pr_auc"}
            if not required.issubset(payload):
                raise CheckpointError("checkpoint state incomplete")
            return payload, path
        except CheckpointError:
            raise
        except Exception as error:
            raise CheckpointError(f"invalid/incomplete checkpoint: {error}") from error

    def load(self, role: str = "resume", allow_fallback: bool = False) -> tuple[dict, Path, bool]:
        pointer = self.root / f"latest_{role}.json"
        try:
            payload, path = self._read(json.loads(pointer.read_text()), role)
            return payload, path, False
        except (CheckpointError, OSError, ValueError) as error:
            if not allow_fallback:
                raise CheckpointError(f"latest {role} checkpoint unusable: {error}") from error
        valid = []
        for sidecar in self.root.glob(f"{role}-*.pt.json"):
            try:
                metadata = json.loads(sidecar.read_text())
                payload, path = self._read(metadata, role)
                valid.append((payload["epoch"], payload["global_step"], path.name, payload, path))
            except (CheckpointError, OSError, ValueError):
                continue
        if not valid:
            raise CheckpointError(f"no retained usable {role} checkpoint")
        _, _, _, payload, path = max(valid, key=lambda entry: entry[:3])
        return payload, path, True
