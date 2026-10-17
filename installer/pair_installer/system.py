"""Small, checked operating-system and release operations."""
from __future__ import annotations

import hashlib
from importlib import resources
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

VERSION = "0.6.8"
REPOSITORY = "r7zex/jupyter_pair_ext"
ROOT = Path("/opt/pair-notebook")
CONFIG = Path("/etc/pair-notebook")
STATE = Path("/var/lib/pair-notebook-install")


class InstallError(RuntimeError):
    pass


def upgrade_version(current: str) -> None:
    if not all(part.isdigit() for part in current.split('.')) or len(current.split('.')) != 3:
        raise InstallError("Installed release version is invalid.")
    if tuple(map(int, current.split('.'))) > tuple(map(int, VERSION.split('.'))):
        raise InstallError("This setup utility is older than the installed server. Download the latest utility from GitHub; no services were changed.")


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, check=False)
    if result.returncode:
        # Commands can contain credentials. Do not include argv or captured output.
        raise InstallError(f"{Path(args[0]).name} failed (exit {result.returncode}). Check the service journal locally.")
    return result.stdout.strip() if capture else ""


def write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), mode)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(content)
    temporary.chmod(mode)
    temporary.replace(path)


def switch(target: Path) -> None:
    temporary = ROOT / "server.next"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target, target_is_directory=True)
    temporary.replace(ROOT / "server")


def supported_system() -> str:
    if platform.system() != "Linux" or os.geteuid() != 0:
        raise InstallError("Run with sudo on Ubuntu 24.04 LTS or Debian 12 with systemd.")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    name, version = (release.get(key, "").strip('"') for key in ("ID", "VERSION_ID"))
    if (name, version) not in {("ubuntu", "24.04"), ("debian", "12")}:
        raise InstallError(f"Unsupported OS: {name} {version}. Supported: Ubuntu 24.04 LTS, Debian 12.")
    if not Path("/run/systemd/system").exists():
        raise InstallError("A running systemd is required. Ordinary containers and WSL without systemd are not supported servers.")
    architecture = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    if not architecture:
        raise InstallError("Supported CPU architectures: x86_64 and aarch64.")
    return architecture


def fetch(url: str, destination: Path) -> None:
    if not url.startswith("https://"):
        raise InstallError("Downloads require HTTPS.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": f"PairNotebookInstaller/{VERSION}"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        if not response.url.startswith("https://"):
            raise InstallError("Download redirected outside HTTPS.")
        shutil.copyfileobj(response, output)


def verify(file: Path, checksums: Path, algorithm: str = "sha256") -> None:
    matches = [line.split()[0] for line in checksums.read_text().splitlines()
               if len(line.split()) == 2 and line.split()[1].lstrip("*") == file.name]
    if len(matches) != 1 or hashlib.new(algorithm, file.read_bytes()).hexdigest() != matches[0]:
        raise InstallError(f"Checksum mismatch: {file.name}.")


def extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        for member in members:
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination.resolve()) or not (member.isfile() or member.isdir()):
                raise InstallError("Unsafe path or linked entry in archive.")
        if hasattr(tarfile, "data_filter"):
            bundle.extractall(destination, members=members, filter="data")
        else:
            # Debian 12's Python predates extraction filters. Every member was
            # checked above; links, special files and escapes are prohibited.
            bundle.extractall(destination, members=members)


def release(directory: Path, local_archive: Path | None = None) -> Path:
    archive = directory / "pair-notebook-server-persistent.tar.gz"
    checksums = directory / "pair-notebook-server-persistent.tar.gz.sha256"
    if local_archive:
        verify(local_archive, Path(str(local_archive) + ".sha256"))
        shutil.copyfile(local_archive, archive)
        checksums.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
    else:
        payload = resources.files("pair_installer").joinpath("payload")
        if not payload.joinpath(archive.name).is_file():
            raise InstallError("Download pair-notebook-server-setup.sh from the matching GitHub release; it includes the verified server package.")
        archive.write_bytes(payload.joinpath(archive.name).read_bytes())
        checksums.write_bytes(payload.joinpath(checksums.name).read_bytes())
    verify(archive, checksums)
    extract(archive, directory / "unpacked")
    server = directory / "unpacked/server"
    manifest = json.loads((server / "BUILD.json").read_text())
    if manifest["version"] != VERSION:
        raise InstallError("Installer and server versions differ.")
    for name, digest in manifest["files"].items():
        file = (server / name).resolve()
        if not file.is_relative_to(server.resolve()) or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise InstallError("Server manifest verification failed.")
    return server


def account(name: str, directory: str) -> None:
    if subprocess.run(["getent", "passwd", name], stdout=subprocess.DEVNULL, check=False).returncode:
        run("useradd", "--system", "--user-group", "--home-dir", directory, "--shell", "/usr/sbin/nologin", name)


def executable_version(file: Path, argument: str, prefix: str) -> bool:
    try:
        result = subprocess.run([str(file), argument], text=True, capture_output=True, timeout=10, check=False)
        return result.returncode == 0 and result.stdout.strip().startswith(prefix)
    except (OSError, subprocess.TimeoutExpired):
        return False


def runtime(directory: Path, architecture: str) -> None:
    """Install private upstream binaries; leave host Node and reverse proxies alone."""
    runtime_root = ROOT / "runtime"
    runtime_root.mkdir(parents=True, exist_ok=True)
    if not executable_version(runtime_root / "node/bin/node", "--version", "v22."):
        sums = directory / "SHASUMS256.txt"
        fetch("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt", sums)
        filenames = [line.split()[1] for line in sums.read_text().splitlines()
                     if line.split()[1].endswith(f"-linux-{architecture}.tar.xz")]
        if len(filenames) != 1:
            raise InstallError("Could not select the supported Node.js 22 build.")
        archive = directory / filenames[0]
        fetch(f"https://nodejs.org/dist/latest-v22.x/{archive.name}", archive)
        verify(archive, sums)
        node = runtime_root / "node/bin/node"
        node.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as bundle:
            member = next(item for item in bundle.getmembers() if item.name.endswith("/bin/node"))
            source = bundle.extractfile(member)
            if not member.isfile() or source is None:
                raise InstallError("Node.js archive does not contain a regular executable.")
            temporary = node.with_suffix(".new")
            with source, temporary.open("wb") as output:
                shutil.copyfileobj(source, output)
        temporary.chmod(0o755)
        temporary.replace(node)
    if not executable_version(runtime_root / "caddy", "version", "v2."):
        metadata = directory / "caddy-release.json"
        fetch("https://api.github.com/repos/caddyserver/caddy/releases/latest", metadata)
        tag = json.loads(metadata.read_text())["tag_name"]
        cpu = {"x64": "amd64", "arm64": "arm64"}[architecture]
        archive = directory / f"caddy_{tag.removeprefix('v')}_linux_{cpu}.tar.gz"
        sums = directory / "caddy_checksums.txt"
        base = f"https://github.com/caddyserver/caddy/releases/download/{tag}"
        fetch(f"{base}/{archive.name}", archive)
        fetch(f"{base}/caddy_{tag.removeprefix('v')}_checksums.txt", sums)
        verify(archive, sums, "sha512")
        extract(archive, directory / "caddy")
        temporary = runtime_root / "caddy.new"
        shutil.copyfile(directory / "caddy/caddy", temporary)
        temporary.chmod(0o755)
        temporary.replace(runtime_root / "caddy")
