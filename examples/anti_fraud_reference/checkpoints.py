"""Retained, atomic, integrity-checked local training artifacts.

SHA-256 detects incomplete writes/corruption, not malicious replacement. PyTorch
resume files deserialize Python state: load only artifacts from a trusted owner.
"""
from __future__ import annotations

from contextlib import contextmanager
import errno
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


@contextmanager
def experiment_lock(directory: Path):
    """One writer per run, with a kernel-owned lock released on process exit.

    Keep the lock inode permanently: unlinking it would let a new process lock
    another inode while an existing writer still owns the original one.
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ".experiment.lock"
    if path.is_symlink():
        raise CheckpointError("unsafe experiment lock path")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    acquired = False
    try:
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"0")
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError as error:
            if error.errno in {errno.EACCES, errno.EAGAIN}:
                raise CheckpointError("experiment already has an active writer; observe it instead of starting another train/resume") from error
            raise
        yield
    finally:
        if acquired:
            if os.name == "nt":
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


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

    def _read(self, metadata: dict, expected_role: str, expected_run_id: str | None = None) -> tuple[dict, Path]:
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
            if expected_run_id is not None and payload["run_id"] != expected_run_id:
                raise CheckpointError("checkpoint belongs to a different experiment")
            if any(type(payload.get(key)) is not int or payload[key] < 0 or payload[key] != metadata[key]
                   for key in ["epoch", "global_step"]):
                raise CheckpointError("checkpoint epoch/step metadata mismatch")
            required = {"model", "config", "provenance", "preprocessor"}
            if expected_role in {"resume", "best"}:
                required |= {"optimizer", "scheduler", "scaler", "rng", "epoch", "global_step", "history", "best_validation_pr_auc"}
            else:
                required.add("thresholds")
            if not required.issubset(payload):
                raise CheckpointError("checkpoint state incomplete")
            return payload, path
        except CheckpointError:
            raise
        except Exception as error:
            raise CheckpointError(f"invalid/incomplete checkpoint: {error}") from error

    def load(self, role: str = "resume", allow_fallback: bool = False, *, expected_run_id: str | None = None) -> tuple[dict, Path, bool]:
        pointer = self.root / f"latest_{role}.json"
        try:
            payload, path = self._read(json.loads(pointer.read_text()), role, expected_run_id)
            return payload, path, False
        except (CheckpointError, OSError, ValueError) as error:
            if not allow_fallback:
                raise CheckpointError(f"latest {role} checkpoint unusable: {error}") from error
        valid = []
        for sidecar in self.root.glob(f"{role}-*.pt.json"):
            try:
                metadata = json.loads(sidecar.read_text())
                payload, path = self._read(metadata, role, expected_run_id)
                valid.append((payload["epoch"], payload["global_step"], path.name, payload, path))
            except (CheckpointError, OSError, ValueError):
                continue
        if not valid:
            raise CheckpointError(f"no retained usable {role} checkpoint")
        _, _, _, payload, path = max(valid, key=lambda entry: entry[:3])
        return payload, path, True
