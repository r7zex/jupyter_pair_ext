#!/usr/bin/env python3
"""Isolated interactive executor for independent Pair Notebook VPS sessions.

The membership credential authorizes one person's device; the separately
configured VPS agent credential authorizes device ``vps``. Neither is exposed
to Python. Linux bubblewrap or an isolated Linux-container runtime is mandatory. Windows uses the WSL2 launcher; macOS uses Docker Desktop Linux containers. Interactive
state survives cells and network outages, but not an executor process restart.
Accepted commands are journalled before execution and are never replayed after
an ambiguous crash. This agent deliberately does not alter the legacy broker.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
import uuid

_PACKAGES_SPEC = importlib.util.spec_from_file_location("pair_isolated_packages", Path(__file__).with_name("isolated_packages.py"))
_PACKAGES = importlib.util.module_from_spec(_PACKAGES_SPEC)
_PACKAGES_SPEC.loader.exec_module(_PACKAGES)

ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
GPU_ID = re.compile(r"^GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$")
MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
MAX_FILES = 4096
MAX_ARTIFACT_FILES = 256
MAX_EVENT_BYTES = 4 * 1024 * 1024
# The server retains at most 8 MiB per execution. Reserve room for array
# punctuation, a final completion and an explicit output-limit diagnostic.
MAX_JOURNAL_BYTES = 8 * 1024 * 1024 - 32 * 1024
# The host admits a 64 MiB command; recovery adds bounded live controls.
# A smaller response bound can strand an accepted global VPS claim forever.
MAX_RESPONSE_BYTES = 80 * 1024 * 1024
MAX_BRIDGE_BYTES = 32 * 1024 * 1024
MAX_KERNELS = 2
MAX_ARTIFACT_ENTRIES = 8192
MAX_ARTIFACT_DEPTH = 16


class AgentError(ValueError):
    pass


class PackageInstallationError(AgentError):
    pass


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("x", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def safe_path(value):
    return (isinstance(value, str) and 0 < len(value.encode("utf-8")) <= 512
            and not re.search(r'[\\:*?"<>|\x00-\x1f\x7f]', value)
            and all(part and part not in (".", "..") and len(part.encode("utf-8")) <= 255
                    and not part.endswith((".", " ")) for part in value.split("/")))


def regular_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise AgentError("Workspace contains a symlink, hardlink or special file.")
    return info


def workspace_directory(root, relative, create=False):
    """Anchor every lookup to no-follow directory descriptors, including races.

    Python inside /work can create a symlink naming an inaccessible host secret.
    The unsandboxed synchronizer must not follow that link when collecting output.
    """
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in relative.split("/")[:-1]:
            if create:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_workspace_file(root, relative):
    if not safe_path(relative):
        raise AgentError("Invalid artifact path.")
    parent = workspace_directory(root, relative)
    descriptor = None
    try:
        descriptor = os.open(relative.split("/")[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise AgentError("Workspace contains a symlink, hardlink or special file.")
        if info.st_size > MAX_SNAPSHOT_BYTES:
            raise AgentError("Generated artifact exceeds the 128 MiB project limit.")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            data = stream.read(MAX_SNAPSHOT_BYTES + 1)
        if len(data) > MAX_SNAPSHOT_BYTES:
            raise AgentError("Generated artifact exceeds the 128 MiB project limit.")
        return data
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def workspace_path(root, relative, create=False):
    if not safe_path(relative):
        raise AgentError("Invalid public workspace path.")
    target = root
    for component in relative.split("/")[:-1]:
        target /= component
        if not target.exists() and not target.is_symlink() and create:
            target.mkdir(mode=0o700)
        info = target.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise AgentError("Workspace directory is unsafe.")
    return target / relative.split("/")[-1]


def install_snapshot(root, files, previous=(), fetch=None):
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise AgentError("Public compute snapshot exceeds the file limit.")
    decoded, total, seen = [], 0, set()
    for item in files:
        name = item.get("path")
        if not safe_path(name) or name.casefold() in seen:
            raise AgentError("Invalid or conflicting snapshot paths.")
        seen.add(name.casefold())
        content = item.get("content")
        if content is None and fetch is not None:
            size, digest = item.get("size"), item.get("sha256")
            if not isinstance(size, int) or size < 0 or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise AgentError("Invalid streamed input descriptor.")
            total += size
            if total > MAX_SNAPSHOT_BYTES:
                raise AgentError("Public compute snapshot exceeds the byte limit.")
            decoded.append((name, None, item.get("version", 0), item))
            continue
        if not isinstance(content, str) or len(content) > MAX_SNAPSHOT_BYTES * 4 // 3 + 4:
            raise AgentError("Public compute snapshot exceeds the byte limit.")
        try:
            data = base64.b64decode(content, validate=True)
        except (ValueError, TypeError) as error:
            raise AgentError("Invalid public snapshot encoding.") from error
        total += len(data)
        if total > MAX_SNAPSHOT_BYTES:
            raise AgentError("Public compute snapshot exceeds the byte limit.")
        decoded.append((name, data, item.get("version", 0), item))
    baseline = {}
    for name, data, version, item in decoded:
        size = len(data) if data is not None else item["size"]
        digest = hashlib.sha256(data).hexdigest() if data is not None else item["sha256"]
        parent = workspace_directory(root, name, create=True)
        target = name.split("/")[-1]
        temporary = ".pair-" + uuid.uuid4().hex
        try:
            try:
                info = os.stat(target, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise AgentError("Workspace snapshot target is unsafe.")
            except FileNotFoundError:
                info = None
            if info is not None and info.st_size == size and stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.geteuid():
                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                with os.fdopen(descriptor, "rb") as current:
                    actual = os.fstat(current.fileno())
                    if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1:
                        raise AgentError("Workspace snapshot target is unsafe.")
                    hasher = hashlib.sha256()
                    for chunk in iter(lambda: current.read(256 * 1024), b""):
                        hasher.update(chunk)
                    actual_hash = hasher.hexdigest()
                    if actual.st_uid == os.geteuid() and stat.S_IMODE(actual.st_mode) == 0o600 and actual_hash == digest:
                        baseline[name] = {"sha256": digest, "version": version}
                        continue
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(descriptor, "wb") as stream:
                copied, actual_hash = 0, hashlib.sha256()
                for chunk in ([data] if data is not None else fetch(item)):
                    copied += len(chunk)
                    if copied > size:
                        raise AgentError("Streamed input exceeds its pinned size.")
                    stream.write(chunk); actual_hash.update(chunk)
                if copied != size or actual_hash.hexdigest() != digest:
                    raise AgentError("Streamed input checksum differs from the accepted snapshot.")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(parent)
        baseline[name] = {"sha256": digest, "version": version}
    for name in previous:
        if name not in baseline:
            try:
                parent = workspace_directory(root, name)
                try:
                    os.unlink(name.split("/")[-1], dir_fd=parent)
                finally:
                    os.close(parent)
            except FileNotFoundError:
                pass
    return baseline


def collect_changes(root, baseline, staging=None):
    changes, warnings, present, total, visited = [], set(), set(), 0, 0
    stack = [""]
    truncated = False
    while stack:
        directory = stack.pop()
        descriptor = None
        try:
            descriptor = workspace_directory(root, directory + "/.entry" if directory else ".entry")
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    visited += 1
                    if visited > MAX_ARTIFACT_ENTRIES:
                        truncated = True
                        break
                    relative = directory + "/" + entry.name if directory else entry.name
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        warnings.add("A generated symlink was excluded from synchronization.")
                    elif stat.S_ISDIR(info.st_mode):
                        if len(relative.split("/")) >= MAX_ARTIFACT_DEPTH:
                            truncated = True
                        else:
                            stack.append(relative)
                    else:
                        present.add(relative)
                        if not safe_path(relative):
                            warnings.add("An unsupported generated path was excluded from synchronization.")
                            continue
                        try:
                            if staging is not None and info.st_size > 256 * 1024:
                                if info.st_size > MAX_SNAPSHOT_BYTES or total + info.st_size > MAX_SNAPSHOT_BYTES or len(changes) >= MAX_ARTIFACT_FILES:
                                    warnings.add("Generated artifacts exceed the project transfer limit."); continue
                                staging.mkdir(parents=True, exist_ok=True, mode=0o700)
                                local_name = hashlib.sha256(relative.encode()).hexdigest()
                                target = staging / local_name
                                parent = workspace_directory(root, relative)
                                try:
                                    source_fd = os.open(relative.split("/")[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                                finally:
                                    os.close(parent)
                                digest, copied = hashlib.sha256(), 0
                                with os.fdopen(source_fd, "rb") as source, target.open("wb") as destination:
                                    actual = os.fstat(source.fileno())
                                    if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or actual.st_size != info.st_size:
                                        raise AgentError("Generated artifact changed before staging.")
                                    while True:
                                        chunk = source.read(256 * 1024)
                                        if not chunk:
                                            break
                                        copied += len(chunk)
                                        if copied > MAX_SNAPSHOT_BYTES:
                                            raise AgentError("Generated artifact grew beyond the project limit.")
                                        destination.write(chunk); digest.update(chunk)
                                    destination.flush(); os.fsync(destination.fileno())
                                if copied != info.st_size:
                                    raise AgentError("Generated artifact changed during staging.")
                                original = baseline.get(relative); checksum = digest.hexdigest()
                                if original and checksum == original["sha256"]:
                                    target.unlink(); continue
                                total += copied
                                changes.append({"path": relative, "localFile": local_name, "sha256": checksum, "size": copied,
                                                "version": original["version"] if original else 0})
                                continue
                            data = read_workspace_file(root, relative)
                            original = baseline.get(relative)
                            if original and hashlib.sha256(data).hexdigest() == original["sha256"]:
                                continue
                            if len(changes) >= MAX_ARTIFACT_FILES or total + len(data) > MAX_SNAPSHOT_BYTES:
                                warnings.add("Generated artifacts exceed the bounded transport limit.")
                                continue
                            total += len(data)
                            changes.append({"path": relative, "content": base64.b64encode(data).decode("ascii"),
                                            "version": original["version"] if original else 0})
                        except (AgentError, OSError) as error:
                            warnings.add(str(error) if isinstance(error, AgentError) else "Generated artifact could not be read safely.")
                    if len(warnings) >= 32:
                        truncated = True
                        break
        except OSError:
            warnings.add("A generated directory could not be scanned safely.")
            truncated = True
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if visited > MAX_ARTIFACT_ENTRIES or len(warnings) >= 32:
            break
    if truncated:
        warnings.add("Artifact synchronization reached the directory/entry limit; omitted results remain in the local public workspace.")
    # An incomplete scan must never report unvisited files as deleted.
    removed = [] if truncated else [{"path": name, "version": item["version"]} for name, item in baseline.items() if name not in present]
    return changes, removed, sorted(warnings)


def clean_environment():
    # A small allowlist prevents future server credentials from silently becoming
    # kernel environment variables. The sandbox supplies its own private home.
    allowed = ("PATH", "LANG", "LC_ALL", "TZ")
    result = {key: os.environ[key] for key in allowed if key in os.environ}
    for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        value = os.environ.get(key, "")
        if value.isdecimal() and 1 <= int(value) <= 64:
            result[key] = value
    result.update({"HOME": "/tmp/home", "PYTHONUNBUFFERED": "1", "PYTHONNOUSERSITE": "1",
                   "PAIR_NOTEBOOK_CWD": "/work", "PAIR_NOTEBOOK_WORKSPACE": "/work",
                   "CUDA_DEVICE_ORDER": "PCI_BUS_ID"})
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise AgentError("VPS redirects are forbidden for device credentials.")


class Transport:
    def __init__(self, endpoint, token_file=None, token=None):
        url = urllib.parse.urlsplit(endpoint)
        if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
                or url.query or url.fragment or (url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"))):
            raise AgentError("Use a verified HTTPS endpoint; HTTP is only allowed on loopback.")
        self.endpoint = endpoint.rstrip("/") + "/v1/sessions/rpc"
        self.token = token if token is not None else Path(token_file).expanduser().read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", self.token):
            raise AgentError("Invalid device credential file.")
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, operation, **body):
        request = urllib.request.Request(self.endpoint, method="POST",
                                        data=json.dumps({"operation": operation, **body}, separators=(",", ":")).encode(),
                                        headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        with self.opener.open(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise AgentError("VPS response exceeded the transport limit.")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise AgentError("Invalid VPS response.")
            return result


class Sandbox:
    def __init__(self, python, bridge):
        self.python = shutil.which(str(Path(python).expanduser()))
        self.bridge = Path(bridge).resolve()
        if not self.python or not self.bridge.is_file():
            raise AgentError("Selected Python or Jupyter bridge is unavailable.")
        self.python = os.path.abspath(self.python)  # Preserve venv interpreter symlinks.
        self.bwrap = shutil.which("bwrap")
        self.reason = ""
        self.gpus = []
        self.roots = []
        self.ready = False
        self.cuda_available = False
        if sys.platform != "linux" or not hasattr(os, "geteuid") or os.geteuid() == 0:
            self.reason = "Interactive execution requires Linux and a dedicated non-root account."
            return
        if not self.bwrap:
            self.reason = "Install bubblewrap; execution is disabled until filesystem isolation is available."
            return
        try:
            inspected = subprocess.run([self.python, "-I", "-c",
                                        "import json,sys,jupyter_client,ipykernel;print(json.dumps([sys.prefix,sys.base_prefix]))"],
                                       env=clean_environment(), capture_output=True, text=True, timeout=10, check=True)
            roots = json.loads(inspected.stdout)
            for root in roots:
                path = Path(root).resolve()
                if str(path) in ("/", "/home", "/etc", "/opt", "/workspace", "/tmp", "/var"):
                    raise AgentError("Select an isolated Python installation or virtual environment.")
                if not any(path == existing or path.is_relative_to(existing) for existing in self.roots):
                    self.roots.append(path)
            self.gpus = self.inventory_gpus()
            # Verify actual namespace availability, not only the bwrap binary.
            with __import__("tempfile").TemporaryDirectory(prefix="pair-sandbox-probe-") as temporary:
                result = subprocess.run(self.command(Path(temporary), None, ["-I", "-c", "import jupyter_client,ipykernel;print('ready')"]),
                                        env=self.environment(None), capture_output=True, text=True, timeout=15)
                if result.returncode or result.stdout.strip() != "ready":
                    detail = result.stderr.strip()[:500] or "check unprivileged user namespaces and selected environment"
                    raise AgentError("Bubblewrap isolation is unavailable: " + detail)
            self.ready = True
            self.reason = "Linux bubblewrap: public workspace only; no network; private host files and credentials withheld."
            if self.gpus:
                self.cuda_available = any(self.probe_cuda(gpu["uuid"]) for gpu in self.gpus)
                if not self.cuda_available:
                    self.reason += " NVIDIA hardware detected, but CUDA PyTorch could not initialize in the selected environment."
        except (OSError, subprocess.SubprocessError, ValueError, ImportError) as error:
            self.reason = str(error) if isinstance(error, AgentError) else "Selected Python needs working jupyter_client/ipykernel and bubblewrap isolation."

    @staticmethod
    def inventory_gpus():
        try:
            result = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"],
                                    capture_output=True, text=True, timeout=5, check=True)
            values = []
            for row in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
                index, identity, name, memory = [item.strip() for item in row]
                if not GPU_ID.fullmatch(identity) or not index.isdecimal():
                    raise ValueError("Invalid NVIDIA inventory.")
                values.append({"index": int(index), "uuid": identity, "name": name, "memoryMb": int(memory)})
            return values
        except (OSError, subprocess.SubprocessError, ValueError):
            return []

    def environment(self, gpu_uuid):
        env = clean_environment()
        env["CUDA_VISIBLE_DEVICES"] = gpu_uuid or ""
        if getattr(self, "package_root", None):
            env["PAIR_NOTEBOOK_PACKAGES"] = "/packages/current"
        return env

    def command(self, workspace, gpu_uuid, python_args=None):
        if not self.bwrap:
            raise AgentError("Bubblewrap is required; no unsafe executor fallback exists.")
        args = [self.bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home", "--dir", "/etc"]
        roots = [Path(value) for value in ("/usr", "/lib", "/lib64", "/bin", "/sbin") if Path(value).exists()]
        roots += [root for root in self.roots if not any(root == system or root.is_relative_to(system) for system in roots)]
        for root in roots:
            args += ["--ro-bind", str(root), str(root)]
        # Loader cache contains library paths, never server credentials.
        if Path("/etc/ld.so.cache").is_file():
            args += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
        if getattr(self, "package_root", None):
            args += ["--ro-bind", str(self.package_root), "/packages"]
        args += ["--bind", str(workspace), "/work", "--dir", "/bridge",
                 "--ro-bind", str(self.bridge), "/bridge/jupyter_kernel_bridge.py", "--chdir", "/work"]
        if gpu_uuid:
            gpu = next((item for item in self.gpus if item["uuid"] == gpu_uuid), None)
            if not gpu or not GPU_ID.fullmatch(gpu_uuid):
                raise AgentError("Selected NVIDIA GPU is no longer available.")
            if Path("/dev/dxg").exists():
                # WSL exposes one shared GPU device rather than per-GPU nodes.
                if len(self.gpus) != 1:
                    raise AgentError("WSL GPU isolation requires exactly one available NVIDIA GPU.")
                args += ["--dev-bind", "/dev/dxg", "/dev/dxg"]
            for device in (f"/dev/nvidia{gpu['index']}", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools"):
                if Path(device).exists():
                    args += ["--dev-bind", device, device]
        return args + ["--", self.python] + (python_args if python_args is not None else ["-I", "/bridge/jupyter_kernel_bridge.py"])

    def probe_cuda(self, gpu_uuid):
        try:
            with __import__("tempfile").TemporaryDirectory(prefix="pair-cuda-probe-") as temporary:
                probe = "import torch;assert torch.cuda.is_available();assert torch.cuda.device_count()==1;print(torch.cuda.get_device_name(0))"
                result = subprocess.run(self.command(Path(temporary), gpu_uuid, ["-I", "-c", probe]),
                                        env=self.environment(gpu_uuid), capture_output=True, text=True, timeout=30)
                return result.returncode == 0
        except (AgentError, OSError, subprocess.SubprocessError):
            return False


class ContainerSandbox:
    """Linux containers; Docker Desktop's Linux VM is the runtime on macOS/Windows."""
    def __init__(self, image, python, bridge, cpus=1.0, memory_mb=512, scope="default"):
        self.python, self.bridge = python, Path(bridge).resolve()
        self.docker = shutil.which("docker")
        self.image, self.cpus, self.memory_mb = image, cpus, memory_mb
        self.uid = os.getuid() if hasattr(os, "getuid") else 1000
        self.gid = os.getgid() if hasattr(os, "getgid") else 1000
        self.ready, self.cuda_available, self.gpus = False, False, []
        self.containers = {}
        self.label = hashlib.sha256(str(scope).encode()).hexdigest()
        self.reason = "Container execution is disabled until the isolated runtime passes readiness."
        try:
            if self.uid == 0:
                raise AgentError("Run the container agent with a dedicated non-root account.")
            if not self.docker or not re.fullmatch(r"(?:sha256:[a-f0-9]{64}|[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64})", image or ""):
                raise AgentError("Install/start Docker Desktop (Windows/macOS) or Docker Engine; supply the installed immutable image ID with --runtime-image.")
            if not python.startswith("/") or ".." in python.split("/") or not self.bridge.is_file():
                raise AgentError("--runtime-python must be the actual absolute Python path INSIDE the Linux image.")
            if not 0.1 <= cpus <= 64 or not 128 <= memory_mb <= 65536:
                raise AgentError("Container CPU/RAM limits are invalid.")
            info = subprocess.run([self.docker, "info", "--format", "{{.OSType}}"], capture_output=True, text=True, timeout=15, check=True)
            if info.stdout.strip() != "linux":
                raise AgentError("Use the Linux-container runtime (Docker Desktop VM on Windows/macOS).")
            self.image = subprocess.run([self.docker, "image", "inspect", image, "--format", "{{.Id}}"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
            with __import__("tempfile").TemporaryDirectory(prefix="pair-container-probe-") as temporary:
                workspace = Path(temporary)
                workspace.chmod(0o777)
                probe = subprocess.run(self.command(workspace, None, ["-I", "-c", "import json,sys,jupyter_client,ipykernel;print(json.dumps({'python':sys.executable,'uid':__import__('os').getuid()}))"]), env=self.environment(None), capture_output=True, text=True, timeout=30, check=True)
                actual = json.loads(probe.stdout)
                if actual["python"] != python or actual["uid"] != self.uid:
                    raise AgentError("Selected container Python or non-root UID disagrees with readiness.")
                self.stop(workspace)
            self.ready = True
            self.reason = f"Linux container {self.image}; UID {self.uid}; Docker Desktop VM on Windows/macOS; Python {python}; workspace-only mounts; no network; {cpus} CPUs/{memory_mb} MiB."
            self.gpus = Sandbox.inventory_gpus()
            self.cuda_available = any(self.probe_cuda(gpu["uuid"]) for gpu in self.gpus)
        except (OSError, ValueError, subprocess.SubprocessError, KeyError) as error:
            self.reason = str(error) if isinstance(error, AgentError) else "Container readiness failed; check Docker, installed image and its Python/Jupyter environment."

    def recover(self):
        result = subprocess.run([self.docker, "ps", "-aq", "--filter", "label=pair.agent=" + self.label], capture_output=True, text=True, timeout=15, check=True)
        identifiers = [value for value in result.stdout.split() if re.fullmatch(r"[a-f0-9]{12,64}", value)]
        if identifiers:
            subprocess.run([self.docker, "rm", "--force", *identifiers], capture_output=True, timeout=30, check=True)

    def environment(self, gpu_uuid):
        environment = clean_environment()
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            if key in os.environ:
                environment[key] = os.environ[key]
        return environment

    def command(self, workspace, gpu_uuid, python_args=None):
        if not self.docker:
            raise AgentError("Container runtime is unavailable; no direct subprocess fallback.")
        workspace = Path(workspace).resolve()
        if "," in str(workspace) or "," in str(self.bridge):
            raise AgentError("Container mount paths cannot contain commas.")
        if gpu_uuid and (not GPU_ID.fullmatch(gpu_uuid) or not any(gpu["uuid"] == gpu_uuid for gpu in self.gpus)):
            raise AgentError("Selected GPU is unavailable.")
        name = "pair-kernel-" + uuid.uuid4().hex
        self.containers[str(workspace)] = name
        args = [self.docker, "run", "--rm", "--pull=never", "--interactive", "--name", name,
                "--label=pair.agent=" + self.label, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                f"--user={self.uid}:{self.gid}", "--pids-limit=128", f"--cpus={self.cpus}", f"--memory={self.memory_mb}m",
                f"--memory-swap={self.memory_mb}m", "--ipc=private", "--ulimit=nofile=1024:1024",
                "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777", f"--tmpfs=/home/pair:rw,nosuid,nodev,size=16m,uid={self.uid},gid={self.gid}",
                "--mount", f"type=bind,src={workspace},dst=/work",
                "--mount", f"type=bind,src={self.bridge},dst=/bridge.py,readonly",
                "--workdir=/work", "--env=HOME=/home/pair", "--env=USER=pair", "--env=LOGNAME=pair", "--env=PAIR_NOTEBOOK_CWD=/work", "--env=PAIR_NOTEBOOK_WORKSPACE=/work",
                "--env=PYTHONDONTWRITEBYTECODE=1", "--env=PYTHONNOUSERSITE=1", "--env=JUPYTER_PLATFORM_DIRS=1",
                "--env=CUDA_VISIBLE_DEVICES=" + (gpu_uuid or ""), "--env=HTTP_PROXY=", "--env=HTTPS_PROXY=",
                "--env=ALL_PROXY=", "--env=NO_PROXY=", "--env=http_proxy=", "--env=https_proxy=", "--env=all_proxy=", "--env=no_proxy="]
        if gpu_uuid:
            args += ["--gpus", "device=" + gpu_uuid]
        return args + ["--entrypoint", self.python, self.image] + (python_args if python_args is not None else ["-I", "/bridge.py"])

    def stop(self, workspace):
        name = self.containers.pop(str(Path(workspace).resolve()), None)
        if name:
            subprocess.run([self.docker, "rm", "--force", name], capture_output=True, timeout=15, check=False)

    def probe_cuda(self, gpu_uuid):
        if not GPU_ID.fullmatch(gpu_uuid):
            return False
        try:
            with __import__("tempfile").TemporaryDirectory(prefix="pair-container-cuda-") as temporary:
                workspace = Path(temporary); workspace.chmod(0o777)
                result = subprocess.run(self.command(workspace, gpu_uuid, ["-I", "-c", "import torch;assert torch.cuda.is_available();assert torch.cuda.device_count()==1;assert torch.tensor([1.,2.],device='cuda').sum().item()==3;print('cuda-ready')"]), env=self.environment(gpu_uuid), capture_output=True, text=True, timeout=30)
                self.stop(workspace)
                return result.returncode == 0 and result.stdout.strip() == "cuda-ready"
        except (OSError, subprocess.SubprocessError):
            return False


class Bridge:
    def __init__(self, sandbox, workspace, gpu_uuid):
        if not sandbox.ready:
            raise AgentError(sandbox.reason)
        if gpu_uuid and not sandbox.probe_cuda(gpu_uuid):
            raise AgentError("Selected GPU requires a compatible NVIDIA driver and CUDA-enabled PyTorch in this Python environment.")
        self.events = queue.Queue(maxsize=64)
        self.workspace = workspace
        self.sandbox = sandbox
        self.baseline = {}
        self.last_used = time.monotonic()
        self.process = subprocess.Popen(sandbox.command(workspace, gpu_uuid), env=sandbox.environment(gpu_uuid),
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        start_new_session=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                raw = self.process.stdout.readline(MAX_BRIDGE_BYTES + 1)
                if not raw:
                    break
                if len(raw) > MAX_BRIDGE_BYTES or not raw.endswith(b"\n"):
                    self.events.put({"type": "fatal", "message": "Jupyter bridge exceeded the bounded protocol limit."})
                    break
                event = json.loads(raw)
                if not isinstance(event, dict):
                    raise ValueError("Invalid bridge event.")
                if len(raw) > MAX_EVENT_BYTES:
                    request_id = str(event.get("requestId", ""))[:256]
                    if event.get("type") == "complete":
                        event = {"type": "complete", "requestId": request_id, "success": False,
                                 "content": {"status": "error", "ename": "OutputTooLarge",
                                             "evalue": "Jupyter reply exceeded the bounded interactive transport limit."}}
                    elif event.get("type") == "fatal":
                        event = {"type": "fatal", "message": "Jupyter bridge diagnostic exceeded the transport limit."}
                    else:
                        event = {"type": "channelError", "requestId": request_id, "channel": "output",
                                 "message": "Jupyter output exceeded the bounded interactive transport limit and was omitted."}
                self.events.put(event)
        except (ValueError, OSError):
            self.events.put({"type": "fatal", "message": "Jupyter bridge protocol failed."})
        finally:
            self.events.put({"type": "bridgeExited"})

    def start(self):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=min(1, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if event.get("type") == "ready":
                return event
            if event.get("type") in ("fatal", "bridgeExited"):
                raise AgentError("Jupyter failed to start in the isolated selected environment.")
        raise AgentError("Jupyter kernel startup timed out.")

    def send(self, command):
        data = json.dumps(command, separators=(",", ":")).encode() + b"\n"
        if len(data) > MAX_SNAPSHOT_BYTES:
            raise AgentError("Jupyter command exceeds the transport limit.")
        self.process.stdin.write(data)
        self.process.stdin.flush()
        self.last_used = time.monotonic()

    def close(self):
        try:
            self.send({"command": "shutdown"})
        except (OSError, AgentError):
            pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                if hasattr(self.sandbox, "stop"):
                    self.sandbox.stop(self.workspace)
                if hasattr(os, "killpg"):
                    os.killpg(self.process.pid, signal.SIGKILL)
                else:
                    self.process.kill()
            except ProcessLookupError:
                pass
            self.process.wait(timeout=5)
        if hasattr(self.sandbox, "stop"):
            self.sandbox.stop(self.workspace)
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()


class SessionAgent:
    def __init__(self, args, transport=None, sandbox=None, bridge_factory=Bridge):
        self.args = args
        if not ID.fullmatch(args.id) or (args.session and not ID.fullmatch(args.session)):
            raise AgentError("Invalid device/session identifier.")
        if args.id != "vps" and not args.session:
            raise AgentError("Personal devices require --session and that session's membership credential.")
        self.transport = transport or Transport(args.url, args.token_file, getattr(args, "config_token", None))
        self.sandbox = sandbox or (ContainerSandbox(args.runtime_image, getattr(args, "runtime_python", "/opt/pair-python/bin/python"), args.bridge, getattr(args, "runtime_cpus", 1), getattr(args, "runtime_memory_mb", 512), str(Path(args.state).expanduser().resolve())) if getattr(args, "runtime_image", None) else Sandbox(args.python, args.bridge))
        self.bridge_factory = bridge_factory
        state_path = Path(args.state).expanduser()
        if state_path.is_symlink():
            raise AgentError("Device state directory must not be a symlink.")
        self.state = state_path.resolve()
        if self.sandbox.ready and hasattr(self.sandbox, "roots"):
            mounts = [Path(value).resolve() for value in ("/usr", "/lib", "/lib64", "/bin", "/sbin") if Path(value).exists()]
            mounts += self.sandbox.roots
            protected = [self.state]
            for value in (getattr(args, "token_file", None), getattr(args, "config", None)):
                if value:
                    protected.append(Path(value).expanduser().resolve())
            if any(item == mount or item.is_relative_to(mount) for item in protected for mount in mounts):
                raise AgentError("Private agent state and credentials must be outside every read-only Python/system sandbox mount.")
            if any(item == self.sandbox.bridge for item in protected):
                raise AgentError("The bridge must not expose a device credential file.")
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.state.is_symlink():
            raise AgentError("Device state directory must not be a symlink.")
        if sys.platform not in ("linux", "darwin", "win32"):
            raise AgentError("Unsupported interactive agent platform.")
        if sys.platform == "win32":
            raise AgentError("Use pair-notebook-wsl-agent.ps1: the protected Windows agent runs inside WSL2 with Linux no-follow filesystem operations. Native Windows filesystem synchronization is disabled.")
        if sys.platform != "linux" and not isinstance(self.sandbox, ContainerSandbox):
            raise AgentError("Windows/macOS agents require the isolated Linux container VM runtime.")
        self.lock = (self.state / "agent.lock").open("a+")
        try:
            if sys.platform == "win32":
                import msvcrt
                self.lock.write(" "); self.lock.flush(); self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.lock.close()
            raise AgentError("Another interactive agent owns this state directory.") from error
        identity_file = self.state / "identity.json"
        identity = {"deviceId": args.id, "sessionId": args.session, "endpoint": args.url.rstrip("/")}
        if identity_file.exists():
            if json.loads(identity_file.read_text()) != identity:
                self.lock.close()
                raise AgentError("Device state belongs to a different endpoint, session or device.")
        else:
            atomic_json(identity_file, identity)
        if isinstance(self.sandbox, ContainerSandbox) and self.sandbox.ready:
            self.sandbox.recover()
        self.kernels = {}
        self.active = None
        self.last_registration = None
        self.initial_share_applied = False
        self.closed = False
        self.credentials_revoked = False
        self.session_deleted = False

    def scoped(self):
        return {"sessionId": self.args.session} if self.args.session else {}

    def register(self):
        gpus = [{key: value for key, value in gpu.items() if key != "index"} for gpu in self.sandbox.gpus]
        device = {"id": self.args.id, "ownerId": "vps" if self.args.id == "vps" else "", "name": self.args.name or self.args.id,
                  "python": self.sandbox.python or self.args.python, "cpu": f"{os.cpu_count() or 1} logical CPUs",
                  "gpus": gpus, "enabled": self.args.share and self.sandbox.ready, "online": True,
                  "isolation": self.sandbox.reason, "ready": self.sandbox.ready,
                  "cudaAvailable": self.sandbox.cuda_available, "cpuCount": os.cpu_count() or 1}
        self.transport.request("registerDevice", **self.scoped(), deviceId=self.args.id, device=device)
        if self.args.id != "vps" and not self.initial_share_applied:
            # Heartbeats must never override a later UI revocation of sharing.
            # Persist the initial CLI preference, so systemd restarts also retain
            # revocation. Toggling --share locally is an explicit fresh grant.
            marker_path = self.state / "sharing-preference.json"
            previous = json.loads(marker_path.read_text()) if marker_path.exists() else None
            enabled = self.args.share and self.sandbox.ready
            if (previous is None or previous.get("requested") != self.args.share
                    or (enabled and not previous.get("applied"))):
                self.transport.request("share", **self.scoped(), deviceId=self.args.id, enabled=enabled)
                atomic_json(marker_path, {"requested": self.args.share, "applied": enabled})
            self.initial_share_applied = True
        self.last_registration = time.monotonic()

    def _directory(self, command):
        for field in ("id", "sessionId", "executionId", "deviceId"):
            if not isinstance(command.get(field), str) or not ID.fullmatch(command[field]):
                raise AgentError("Invalid command ownership envelope.")
        kernel_id = command.get("kernelId")
        if not isinstance(kernel_id, str) or not 0 < len(kernel_id) <= 768 or re.search(r"[\x00-\x1f\x7f]", kernel_id):
            raise AgentError("Invalid kernel identifier.")
        if command["deviceId"] != self.args.id or (self.args.session and command["sessionId"] != self.args.session):
            raise AgentError("Command is assigned to a different device or session.")
        if not isinstance(command.get("generation"), int) or command["generation"] < 0:
            raise AgentError("Invalid kernel generation.")
        directory = self.state / "commands" / command["id"]
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        return directory

    def _retire_idle_kernel(self, key):
        bridge = self.kernels.pop(key, None)
        if bridge is None:
            return
        bridge.close()
        # These kernels have completed their accepted work before the broker
        # admits release or a replacement generation. Receipts live separately.
        parent = self.state / "kernels" / hashlib.sha256(json.dumps(key).encode()).hexdigest()
        workspace = parent / key[4]
        if any(item.is_symlink() for item in (self.state / "kernels", parent, workspace)):
            raise AgentError("Kernel cleanup cannot follow directory links.")
        if workspace.exists():
            shutil.rmtree(workspace)
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()

    def _claim(self, command, recover_only=False):
        directory = self._directory(command)
        receipt_file = directory / "receipt.json"
        identity = {key: command.get(key) for key in ("id", "sessionId", "kernelId", "executionId", "deviceId", "generation", "gpuUuid", "scope")}
        identity["digest"] = hashlib.sha256(json.dumps(command, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if receipt_file.exists():
            receipt = json.loads(receipt_file.read_text())
            matched = receipt["identity"] == identity
            if recover_only:
                # Recovery claims intentionally redact source and files, which
                # may have become private since acceptance. Only the immutable
                # ownership envelope is consulted; no redacted input is run.
                matched = all(receipt["identity"].get(key) == value for key, value in identity.items() if key != "digest")
            if not matched:
                raise AgentError("Server claim disagrees with the immutable local command receipt.")
            if self.active and self.active["directory"] == directory:
                return
            if receipt["state"] == "running":
                receipt["state"] = "interrupted"
                receipt["error"] = "Interactive executor restarted; Python state was reset. The accepted cell was not rerun."
                atomic_json(receipt_file, receipt)
            self.active = {"directory": directory, "receipt": receipt, "bridge": None, "controls": set()}
            return
        receipt = {"identity": identity, "offset": 0, "state": "running", "events": [], "journalBytes": 0}
        # The durable receipt precedes kernel creation and the command write.
        atomic_json(receipt_file, receipt)
        self.active = {"directory": directory, "receipt": receipt, "bridge": None, "controls": set()}
        if recover_only:
            receipt["state"] = "interrupted"
            receipt["error"] = "Broker retained an accepted command but its local execution receipt is unavailable. The cell was not rerun."
            self._persist()
            return
        try:
            key = (command["sessionId"], command["kernelId"], command["generation"], command.get("gpuUuid"), command.get("scope", "public"))
            self.active["requestId"] = command["command"].get("requestId", "")
            self.active["commandKind"] = command["command"].get("command")
            if self.active["commandKind"] == "release":
                # The broker queues release behind accepted execution. Closing
                # obsolete idle generations cannot cancel an accepted run or
                # manufacture a kernel just to shut it down.
                obsolete = [entry for entry in self.kernels if entry[0] == key[0] and entry[2] < key[2]]
                for entry in obsolete:
                    self._retire_idle_kernel(entry)
                bridge = self.kernels.get(key)
                self._retire_idle_kernel(key)
                self._append({"type": "kernelState", "requestId": self.active["requestId"],
                              "generation": command["generation"],
                              "message": "The selected notebook kernel was released; its variables were cleared."
                              if bridge is not None or obsolete else "The selected notebook has no live kernel to release."})
                self._append({"type": "commandResult", "requestId": self.active["requestId"], "command": "release"})
                receipt["state"] = "completed"
                self._persist()
                return
            package_key = (command["sessionId"], command["kernelId"], command.get("scope", "public"))
            package_root = self.state / "packages" / hashlib.sha256(json.dumps(package_key).encode()).hexdigest()
            if isinstance(self.sandbox, Sandbox):
                package_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                self.sandbox.package_root = package_root
            bridge = self.kernels.get(key)
            if bridge is None:
                # No command is running in another bridge on this serial device.
                # Old generations cannot service future executions, so retire
                # them after their accepted execution has completed.
                obsolete = [entry for entry in self.kernels if entry[0] == key[0] and (entry[2] != key[2] or entry[4] != key[4])]
                for entry in obsolete:
                    self._retire_idle_kernel(entry)
                if len(self.kernels) >= getattr(self.args, "max_kernels", MAX_KERNELS):
                    raise AgentError("Live notebook kernel limit reached. Switch execution device or restart the interactive agent to release kernels; existing variables were retained.")
                workspace = self.state / "kernels" / hashlib.sha256(json.dumps(key).encode()).hexdigest() / command.get("scope", "public")
                workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
                baseline = install_snapshot(workspace, command["files"], fetch=lambda item: self._download(command, item))
                bridge = self.bridge_factory(self.sandbox, workspace, command.get("gpuUuid"))
                bridge.baseline = baseline
                self.active["bridge"] = bridge
                ready = bridge.start()
                self.kernels[key] = bridge
                self._append({"type": "kernelState", "requestId": command["command"].get("requestId", ""),
                              "message": "A fresh Python kernel was started; variables from other devices or generations are unavailable.",
                              "generation": command["generation"], "pythonExecutable": ready.get("pythonExecutable")})
            else:
                bridge.baseline = install_snapshot(bridge.workspace, command["files"], bridge.baseline, fetch=lambda item: self._download(command, item))
            self.active["bridge"] = bridge
            if self.active["commandKind"] == "restart":
                self._append({"type": "kernelState", "requestId": self.active["requestId"],
                              "message": "Restarting the selected Python kernel clears its variables."})
            submitted = command["command"]
            if self.active["commandKind"] == "execute":
                try:
                    requirements = _PACKAGES.installation_requirements(base64.b64decode(submitted.get("codeBase64", ""), validate=True).decode("utf-8"))
                    if requirements is not None:
                        if not isinstance(self.sandbox, Sandbox):
                            raise ValueError("Managed package installation currently requires Linux bubblewrap compute.")
                        message = _PACKAGES.install_wheels(self.sandbox, package_root, requirements)
                        replacement = "import site, importlib; site.addsitedir('/packages/current'); importlib.invalidate_caches(); print(" + repr(message) + ")"
                        submitted = {**submitted, "codeBase64": base64.b64encode(replacement.encode()).decode()}
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    raise PackageInstallationError(str(error) if isinstance(error, ValueError) else "Package installation failed; the previous environment is preserved.") from error
            bridge.send(submitted)
        except (OSError, ValueError, KeyError) as error:
            receipt["state"] = "failed"
            receipt["error"] = str(error) if isinstance(error, AgentError) else "Interactive kernel preparation failed."
            failed_bridge = self.active.get("bridge")
            if failed_bridge and not isinstance(error, PackageInstallationError):
                self.kernels = {key: value for key, value in self.kernels.items() if value is not failed_bridge}
                failed_bridge.close()
                self.active["bridge"] = None
            self._persist()

    def _persist(self):
        atomic_json(self.active["directory"] / "receipt.json", self.active["receipt"])

    def _download(self, command, item):
        offset = 0
        while offset < item["size"]:
            reply = self.transport.request("readChunk", sessionId=command["sessionId"], deviceId=command["deviceId"],
                                           executionId=command["executionId"], commandId=command["id"], generation=command["generation"],
                                           path=item["path"], offset=offset)
            chunk = base64.b64decode(reply["content"], validate=True)
            if not chunk or reply.get("offset") != offset + len(chunk) or reply.get("sha256") != item["sha256"]:
                raise AgentError("Server returned an invalid pinned input chunk.")
            offset += len(chunk)
            yield chunk

    def _append(self, event):
        receipt = self.active["receipt"]
        encoded_size = len(json.dumps(event, separators=(",", ":")).encode()) + 1
        if event.get("type") == "complete":
            if encoded_size > 16 * 1024:
                event = {"type": "complete", "requestId": event.get("requestId", ""), "success": False,
                         "content": {"status": "error", "ename": "OutputTooLarge",
                                     "evalue": "Execution completed, but its reply exceeded the bounded transport limit."}}
                encoded_size = len(json.dumps(event).encode())
            receipt["events"].append(event)
            receipt["journalBytes"] += encoded_size
            return
        if encoded_size > MAX_EVENT_BYTES or receipt["journalBytes"] + encoded_size > MAX_JOURNAL_BYTES:
            event = {"type": "channelError", "requestId": event.get("requestId", ""), "channel": "output",
                     "message": "Kernel output exceeded the bounded interactive transport limit and was omitted."}
            if receipt.get("outputLimited"):
                return
            receipt["outputLimited"] = True
            encoded_size = len(json.dumps(event).encode())
        receipt["events"].append(event)
        receipt["journalBytes"] += encoded_size

    def _drain(self):
        bridge = self.active["bridge"]
        if bridge is None or self.active["receipt"]["state"] != "running":
            return
        receipt = self.active["receipt"]
        changed = False
        for _ in range(128):
            try:
                event = bridge.events.get_nowait()
            except queue.Empty:
                break
            changed = True
            kind = event.get("type")
            if kind == "bridgeExited":
                receipt["state"] = "interrupted"
                receipt["error"] = "Interactive kernel exited; Python state is unavailable. Restart the kernel to continue."
                self.kernels = {key: value for key, value in self.kernels.items() if value is not bridge}
                break
            if kind == "fatal":
                receipt["state"] = "failed"
                receipt["error"] = "Isolated Jupyter kernel failed."
                self.kernels = {key: value for key, value in self.kernels.items() if value is not bridge}
            self._append(event)
            completed = kind == "complete" or (kind == "commandResult" and self.active.get("commandKind") in ("restart", "interrupt"))
            if completed and event.get("requestId") == self.active.get("requestId"):
                receipt["state"] = "failed" if kind == "complete" and not event.get("success") else "completed"
                changes, removed, warnings = collect_changes(bridge.workspace, bridge.baseline, self.active["directory"] / "artifacts")
                receipt["files"], receipt["removedFiles"] = changes, removed
                for warning in warnings:
                    self._append({"type": "channelError", "requestId": self.active["requestId"], "channel": "files", "message": warning})
                if warnings:
                    receipt["state"] = "failed"
                    receipt["error"] = "Code finished, but one or more generated files could not be synchronized; originals remain on this device."
                break
            if kind == "commandError" and event.get("requestId") == self.active.get("requestId"):
                receipt["state"] = "failed"
                receipt["error"] = "Jupyter rejected the accepted command."
                break
        if changed:
            self._persist()

    def _report(self):
        receipt = self.active["receipt"]
        if receipt.get("authorityUnavailable"):
            if receipt["state"] != "running":
                self._retain_unreportable_result()
            return
        identity = receipt["identity"]
        for index, artifact in enumerate(receipt.get("files", [])):
            if "localFile" not in artifact:
                continue
            upload_id = hashlib.sha256((artifact["path"] + "\0" + artifact["sha256"]).encode()).hexdigest()
            try:
                with (self.active["directory"] / "artifacts" / artifact["localFile"]).open("rb") as source:
                    offset = 0
                    while True:
                        chunk = source.read(256 * 1024)
                        if not chunk:
                            break
                        reply = self.transport.request("artifactChunk", sessionId=identity["sessionId"], deviceId=identity["deviceId"],
                            executionId=identity["executionId"], commandId=identity["id"], generation=identity["generation"],
                            path=artifact["path"], uploadId=upload_id, size=artifact["size"], sha256=artifact["sha256"],
                            version=artifact["version"], offset=offset, content=base64.b64encode(chunk).decode("ascii"))
                        offset += len(chunk)
                        if reply.get("offset") != offset:
                            raise AgentError("Server acknowledged an invalid artifact offset.")
                receipt["files"][index] = {key: value for key, value in artifact.items() if key != "localFile"}
                receipt["files"][index]["uploadId"] = upload_id
                self._persist()
            except urllib.error.HTTPError as error:
                if error.code not in (400, 409, 413):
                    raise
                error.close()
                receipt["state"] = "failed"
                receipt["error"] = "Artifact transfer was rejected; its verified local copy is retained for recovery."
                receipt["files"] = [item for item in receipt["files"] if "localFile" not in item]
                self._persist()
                break
        offset = receipt["offset"]
        body = receipt.get("pendingReport")
        if body is None:
            pending, size = [], 0
            for event in receipt["events"][offset:]:
                event_size = len(json.dumps(event).encode())
                if len(pending) >= 512 or (pending and size + event_size > MAX_EVENT_BYTES):
                    break
                pending.append(event)
                size += event_size
            final = offset + len(pending) == len(receipt["events"]) and receipt["state"] != "running"
            if not pending and not final:
                return
            body = {"sessionId": identity["sessionId"], "deviceId": identity["deviceId"], "commandId": identity["id"],
                    "executionId": identity["executionId"], "generation": identity["generation"], "offset": offset,
                    "events": pending, "state": receipt["state"] if final else "running"}
            if final:
                for key in ("error", "files", "removedFiles"):
                    if key in receipt:
                        body[key] = receipt[key]
            # A lost HTTP acknowledgement must replay byte-identical events and
            # state at this offset, even if the kernel produced more output.
            receipt["pendingReport"] = body
            self._persist()
        final = body["state"] != "running"
        try:
            result = self.transport.request("report", **body)
        except urllib.error.HTTPError as error:
            if error.code not in (401, 403, 404):
                raise
            error.close()
            self._lose_authority(error.code)
            if receipt["state"] != "running":
                self._retain_unreportable_result()
            return
        acknowledged = result.get("offset")
        if acknowledged != body["offset"] + len(body["events"]):
            raise AgentError("Server acknowledged an unexpected event offset.")
        receipt["offset"] = acknowledged
        del receipt["pendingReport"]
        self._persist()
        if final:
            self.active = None

    def _lose_authority(self, status):
        if status in (401, 403):
            self.credentials_revoked = True
        elif self.args.session:
            self.session_deleted = True
        if self.active:
            self.active["receipt"]["authorityUnavailable"] = "session-deleted" if status == 404 else "credential-revoked"
            self._persist()
        if status in (401, 403) or (self.args.session and not self.active):
            running_bridge = self.active.get("bridge") if self.active else None
            for key, bridge in list(self.kernels.items()):
                if bridge is not running_bridge:
                    self.kernels.pop(key).close()
        print("Session deleted or execution credential revoked. Accepted code continues; its results will be retained in private local agent state.",
              file=sys.stderr, flush=True)

    def _retain_unreportable_result(self):
        receipt = self.active["receipt"]
        session_id = receipt["identity"]["sessionId"]
        receipt["resultRetainedLocally"] = True
        receipt.pop("pendingReport", None)
        self._persist()
        for key in [entry for entry in self.kernels if entry[0] == session_id]:
            self.kernels.pop(key).close()
        self.active = None

    def tick(self):
        try:
            self._tick()
        except urllib.error.HTTPError as error:
            if error.code not in (401, 403) and not (error.code == 404 and self.args.session):
                raise
            error.close()
            self._lose_authority(error.code)
            if self.active:
                self._report()

    def _tick(self):
        if self.active:
            # Persist output before any network operation, including failed
            # heartbeats; a connection outage must not discard kernel results.
            self._drain()
            if self.active["receipt"].get("authorityUnavailable"):
                self._report()
                if self.active:
                    return
        if self.credentials_revoked or self.session_deleted:
            return
        if self.last_registration is None or time.monotonic() - self.last_registration >= 10:
            self.register()
        if not self.args.share or not self.sandbox.ready:
            return
        if self.active:
            self._drain()
            self._report()
            if self.credentials_revoked or (self.active and self.active["receipt"].get("authorityUnavailable")):
                return
        response = self.transport.request("claim", **self.scoped(), deviceId=self.args.id)
        command = response.get("command")
        if command:
            if self.active and self.active["receipt"]["identity"]["id"] != command.get("id"):
                raise AgentError("Server attempted concurrent execution on one device.")
            self._claim(command, bool(response.get("recoverOnly")))
        if self.active and self.active["bridge"]:
            for control in response.get("controls", []):
                if (control.get("id") not in self.active["controls"] and
                        control.get("executionId", self.active["receipt"]["identity"]["executionId"]) == self.active["receipt"]["identity"]["executionId"] and
                        control.get("generation", self.active["receipt"]["identity"]["generation"]) == self.active["receipt"]["identity"]["generation"]):
                    value = control.get("command", {})
                    if value.get("command") not in ("inputReply", "interrupt"):
                        raise AgentError("Unsupported live kernel control.")
                    self.active["bridge"].send(value)
                    self.active["controls"].add(control["id"])
        if self.active:
            self._drain()
            self._report()

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.active and self.active["receipt"]["state"] == "running":
            self.active["receipt"]["state"] = "interrupted"
            self.active["receipt"]["error"] = "Interactive executor stopped; Python state was reset."
            self._persist()
        bridges = set(self.kernels.values())
        if self.active and self.active.get("bridge"):
            bridges.add(self.active["bridge"])
        for bridge in bridges:
            bridge.close()
        self.kernels.clear()
        if self.active:
            try:
                self._report()
            except Exception:
                pass  # The durable receipt is reconciled when the service returns.
        self.lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="Private VS Code exported {endpoint,sessionId,memberId,token} JSON")
    parser.add_argument("--url")
    parser.add_argument("--id")
    parser.add_argument("--session", help="Required for personal devices; omitted by the configured VPS worker")
    parser.add_argument("--name", default="")
    parser.add_argument("--token-file")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--runtime-image", help="Installed immutable Linux image ID; Docker Desktop VM on Windows/macOS")
    parser.add_argument("--runtime-python", default="/opt/pair-python/bin/python", help="Python INSIDE the container, not a host environment")
    parser.add_argument("--runtime-cpus", type=float, default=1)
    parser.add_argument("--runtime-memory-mb", type=int, default=512)
    parser.add_argument("--bridge", default=str(Path(__file__).resolve().parents[1] / "media" / "jupyter_kernel_bridge.py"))
    parser.add_argument("--state", default=str(Path.home() / ".pair-notebook-session-agent"))
    parser.add_argument("--share", action="store_true", help="Explicitly allow this session's Python code to run in the isolated public workspace")
    parser.add_argument("--poll-seconds", type=float, default=0.1)
    parser.add_argument("--max-kernels", type=int, default=MAX_KERNELS, choices=(1, 2))
    parser.add_argument("--check-isolation", action="store_true", help="Verify the actual selected isolated runtime and exit without credentials")
    args = parser.parse_args()
    if args.check_isolation:
        sandbox = ContainerSandbox(args.runtime_image, args.runtime_python, args.bridge, args.runtime_cpus, args.runtime_memory_mb) if args.runtime_image else Sandbox(args.python, args.bridge)
        print(sandbox.reason, flush=True)
        return 0 if sandbox.ready else 2
    if args.config:
        if args.url or args.session or args.token_file:
            parser.error("--config cannot be combined with --url, --session or --token-file")
        config_path = Path(args.config).expanduser()
        if config_path.stat().st_size > 16 * 1024:
            parser.error("Device configuration is too large")
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            args.url, args.session, args.config_token = config["endpoint"], config["sessionId"], config["token"]
            args.id = args.id or ("pc-" + config["memberId"])
        except (ValueError, KeyError, TypeError):
            parser.error("Invalid exported device configuration")
    if not args.url or not args.id or (not args.token_file and not getattr(args, "config_token", None)):
        parser.error("Supply --config or --url, --id and --token-file")
    if not 0.1 <= args.poll_seconds <= 60:
        parser.error("--poll-seconds must be between 0.1 and 60")
    agent = None
    try:
        agent = SessionAgent(args)
        print("Interactive device registered with explicit resource sharing " + ("enabled." if args.share else "disabled."), flush=True)
        if not agent.sandbox.ready:
            print(agent.sandbox.reason, file=sys.stderr, flush=True)
        disconnected = False
        while True:
            try:
                agent.tick()
                if disconnected:
                    print("VPS connection restored; retained interactive events reconciled.", flush=True)
                disconnected = False
            except Exception:
                if not disconnected:
                    print("VPS request failed; retrying without replaying accepted cells. Check connectivity and membership/device credentials.",
                          file=sys.stderr, flush=True)
                disconnected = True
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        pass
    except AgentError as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        if agent:
            agent.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
