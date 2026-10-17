"""Download wheels over verified HTTPS; unpack them only inside the offline sandbox."""
from __future__ import annotations

import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import uuid

REQUIREMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:==[A-Za-z0-9][A-Za-z0-9.!+_-]*)?$")


def installation_requirements(code: str) -> list[str] | None:
    lines = [line.strip() for line in code.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if not lines or not re.match(r"^%pip\s+install(?:\s|$)", lines[0]):
        return None
    if len(lines) != 1:
        raise ValueError("Use %pip install in its own cell, then import the package in another cell.")
    arguments = shlex.split(lines[0])
    if arguments[:2] != ["%pip", "install"] or not 3 <= len(arguments) <= 34:
        raise ValueError("Use %pip install package or %pip install package==version. Only binary wheels from PyPI are supported.")
    requirements = arguments[2:]
    if not all(REQUIREMENT.fullmatch(item) for item in requirements):
        raise ValueError("Package installation accepts package names and exact versions only; index, URL, shell and filesystem options are disabled.")
    return requirements


def install_wheels(sandbox, package_root: Path, requirements: list[str]) -> str:
    package_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if package_root.is_symlink():
        raise ValueError("The package environment must not be a symlink.")
    with tempfile.TemporaryDirectory(prefix="install-", dir=package_root) as temporary:
        staging = Path(temporary)
        wheels = staging / "wheels"
        wheels.mkdir()
        environment = sandbox.environment(None)
        environment.pop("PAIR_NOTEBOOK_PACKAGES", None)
        download = subprocess.run([sandbox.python, "-I", "-m", "pip", "--isolated", "download", "--disable-pip-version-check",
                                   "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "--dest", str(wheels), *requirements],
                                  env=environment, cwd=staging, capture_output=True, text=True, timeout=150)
        if download.returncode:
            output = download.stderr + download.stdout
            reason = ("No compatible binary wheel was found on PyPI." if "No matching distribution" in output else
                      "The package index TLS certificate could not be verified." if "certificate" in output.lower() else
                      "PyPI could not be reached or the wheel download failed.")
            raise ValueError(reason + " No package environment was replaced.")
        current = package_root / "current"
        site = staging / "site"
        if current.exists():
            resolved = current.resolve()
            if resolved.parent != package_root.resolve() or not resolved.is_dir():
                raise ValueError("Invalid managed package environment.")
            shutil.copytree(resolved, site, symlinks=False)
        result = subprocess.run(sandbox.command(staging, None, ["-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
                                                                "--no-index", "--find-links", "/work/wheels", "--only-binary=:all:",
                                                                "--upgrade", "--target", "/work/site", *requirements]),
                                env=environment, cwd=staging, capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise ValueError("The offline sandbox could not install the downloaded wheels. The previous package environment is preserved.")
        version = package_root / ("site-" + uuid.uuid4().hex)
        site.rename(version)
        pointer = package_root / (".current-" + uuid.uuid4().hex)
        pointer.symlink_to(version.name, target_is_directory=True)
        os.replace(pointer, current)
    return "Installed " + ", ".join(requirements) + ". Packages belong to this notebook kernel and access scope on this compute device; they survive kernel restart and server update. Python variables are cleared by restart."
