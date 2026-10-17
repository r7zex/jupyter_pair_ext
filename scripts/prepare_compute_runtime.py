#!/usr/bin/env python3
"""Prepare a versioned local runtime without modifying an existing environment."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import venv

JUPYTER_CLIENT = "8.10.0"
IPYKERNEL = "7.3.0"


def prepare(root: Path, agent: Path, bridge: Path) -> Path:
    if sys.version_info < (3, 10):
        raise RuntimeError("Python 3.10 or newer is required for the managed compute runtime.")
    root = root.expanduser().resolve()
    candidate = root.with_name(f"{root.name}-py{sys.version_info.major}{sys.version_info.minor}-jc810-ik730")
    if candidate.is_symlink():
        raise RuntimeError("The managed runtime destination must not be a symlink.")
    python = candidate / "bin" / "python"
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(candidate)
    check = [str(python), "-I", "-c", "from importlib.metadata import version; assert version('jupyter_client') == '8.10.0'; assert version('ipykernel') == '7.3.0'"]
    if subprocess.run(check, capture_output=True).returncode:
        subprocess.run([str(python), "-m", "pip", "install", f"jupyter_client=={JUPYTER_CLIENT}", f"ipykernel=={IPYKERNEL}"],
                       stdout=sys.stderr, check=True, timeout=210)
    subprocess.run(check, check=True, capture_output=True)
    subprocess.run([str(python), str(agent), "--python", str(python), "--bridge", str(bridge), "--check-isolation"],
                   check=True, stdout=sys.stderr, timeout=30)
    return python


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--agent", type=Path, required=True)
    parser.add_argument("--bridge", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps({"python": str(prepare(args.root, args.agent, args.bridge))}))


if __name__ == "__main__":
    main()
