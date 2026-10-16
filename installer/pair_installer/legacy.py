"""Maintain an existing packaged installation without replacing its service setup."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile

from . import checks, services
from .system import CONFIG, ROOT, STATE, VERSION, InstallError, release, run, switch, write

PAIR_SERVICES = ("pair-notebook-server", "pair-notebook-worker")


def present() -> bool:
    return (ROOT / "server").exists() or any(
        (services.UNITS / f"{name}.service").exists() for name in services.SERVICES
    )


def settings(name: str) -> dict[str, str]:
    content = run("systemctl", "cat", name, capture=True)
    values = {}
    for line in content.replace("\\\n", "").splitlines():
        if line.startswith(("#", ";", "[")) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def discover() -> dict:
    server = ROOT / "server"
    target = server.resolve()
    if not target.is_relative_to(ROOT.resolve()) or not (target / "BUILD.json").is_file():
        raise InstallError("Existing server must be a packaged release inside /opt/pair-notebook. No services were changed.")
    manifest = json.loads((target / "BUILD.json").read_text())
    if not re.fullmatch(r"0\.6\.[67]", manifest.get("version", "")):
        raise InstallError("Automatic adoption supports packaged 0.6.6 and 0.6.7 installations. No services were changed.")
    host, worker = (settings(name) for name in PAIR_SERVICES)
    arguments = shlex.split(host.get("ExecStart", ""))
    if len(arguments) != 2 or arguments[1] != str(server / "out/src/vps/cli.js"):
        raise InstallError("Existing server service does not use the supported release path. No services were changed.")
    node = Path(arguments[0])
    if not node.is_absolute() or not node.is_file():
        raise InstallError("Existing Node.js executable is unavailable. No services were changed.")
    if shlex.split(host.get("EnvironmentFile", "")) != [str(CONFIG / "server.env")]:
        raise InstallError("Existing server must use /etc/pair-notebook/server.env. No services were changed.")
    values = {}
    for line in (CONFIG / "server.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            if key in {"PAIR_VPS_DATA", "PAIR_VPS_PORT", "PAIR_VPS_BIND", "PAIR_VPS_CLIENT_TOKEN"}:
                parsed = shlex.split(value)
                if len(parsed) != 1:
                    raise InstallError("Unsupported existing server environment. No services were changed.")
                values[key] = parsed[0]
    if values.get("PAIR_VPS_BIND") != "127.0.0.1":
        raise InstallError("Existing server must bind to loopback behind its HTTPS proxy. No services were changed.")
    port = int(values.get("PAIR_VPS_PORT", "8787"))
    data = Path(values.get("PAIR_VPS_DATA", "/var/lib/pair-notebook-vps"))
    worker_data = Path(worker.get("WorkingDirectory", ""))
    worker_arguments = shlex.split(worker.get("ExecStart", ""))
    if (not 1024 <= port <= 65535 or not data.is_absolute() or not data.is_dir()
            or not worker_data.is_absolute() or not worker_data.is_dir()
            or str(server / "scripts/pair-notebook-session-agent.py") not in worker_arguments
            or str(server / "media/jupyter_kernel_bridge.py") not in worker_arguments
            or f"http://127.0.0.1:{port}" not in worker_arguments):
        raise InstallError("Existing data paths or worker configuration are unsupported. No services were changed.")
    for directory in (data, worker_data):
        if any(path.resolve().is_relative_to(directory.resolve()) for path in (ROOT, STATE, CONFIG)):
            raise InstallError("Existing data overlaps installer or configuration storage. No services were changed.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", values.get("PAIR_VPS_CLIENT_TOKEN", "")):
        raise InstallError("Existing administrative credential is unavailable. No services were changed.")
    return {"layout": "existing", "version": manifest["version"], "mode": "full", "network": "existing",
            "port": port, "node": str(node), "data": str(data), "workerData": str(worker_data)}


def default_endpoint() -> str:
    file = CONFIG / "Caddyfile"
    if not file.is_file():
        return ""
    candidates = re.findall(r"^\s*(https://[^\s,{]+)\s*\{", file.read_text(), re.MULTILINE)
    return candidates[0] if len(candidates) == 1 else ""


def owner_credential(config: dict) -> None:
    for line in (CONFIG / "server.env").read_text().splitlines():
        if line.startswith("PAIR_VPS_CLIENT_TOKEN="):
            token = shlex.split(line.split("=", 1)[1])[0]
            file = STATE / "owner-server.json"
            value = {"endpoint": config["endpoint"], "adminToken": token}
            if file.exists():
                if json.loads(file.read_text()) != value:
                    raise InstallError("Existing owner recovery credential differs. No services were changed.")
            else:
                write(file, json.dumps(value, indent=2) + "\n")
            return
    raise InstallError("Existing administrative credential is unavailable.")


def active_services() -> list[str]:
    return [name for name in PAIR_SERVICES if subprocess.run(
        ["systemctl", "is-active", "--quiet", name], check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0]


def start() -> None:
    for name in PAIR_SERVICES:
        run("systemctl", "start", name)


def stop() -> None:
    for name in reversed(PAIR_SERVICES):
        run("systemctl", "stop", name)


def restore(target: Path, active: list[str]) -> None:
    stop()
    switch(target)
    for name in active:
        run("systemctl", "start", name)


def update(config: dict, archive: Path | None) -> None:
    # Recheck the live layout on maintenance runs; never trust stale paths.
    current = discover()
    if any(current[key] != config[key] for key in ("port", "node", "data", "workerData")):
        raise InstallError("Existing service configuration changed. No services were changed.")
    owner_credential(config)
    local = f"http://127.0.0.1:{config['port']}"
    checks.wait_health(local)
    checks.wait_health(config["endpoint"])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    backup = STATE / "backups" / stamp
    backup.mkdir(parents=True, mode=0o700)
    shutil.copytree(CONFIG, backup / "configuration", symlinks=True)
    for name in services.SERVICES:
        write(backup / f"{name}.service", run("systemctl", "cat", name, capture=True))
    with tempfile.TemporaryDirectory(prefix="pair-update-") as temporary:
        # Download, checksum and manifest checks finish before interruption.
        package = release(Path(temporary), archive)
        destination = ROOT / "releases" / f"{VERSION}-{stamp}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(package, destination)
    server = ROOT / "server"
    previous = server.resolve()
    was_link = server.is_symlink()
    active = active_services()
    moved = False
    switched = False
    try:
        stop()
        shutil.copytree(config["data"], backup / "server-data", symlinks=True)
        shutil.copytree(config["workerData"], backup / "worker-data", symlinks=True)
        if not was_link:
            previous = ROOT / "releases" / f"{config['version']}-original-{stamp}"
            server.rename(previous)
            moved = True
        switch(destination)
        switched = True
        start()
        checks.verify({**config, "checkTools": str(destination)})
        updated = {**config, "version": VERSION, "previous": str(previous), "backup": str(backup), "checkTools": str(destination)}
        write(STATE / "installation.json", json.dumps(updated, indent=2) + "\n")
        config.update(updated)
        print("Existing installation updated. Projects, owner/member access, service limits and HTTPS retained.")
    except BaseException:
        stop()
        if moved:
            if switched:
                server.unlink()
            previous.rename(server)
        elif switched:
            switch(previous)
        for name in active:
            run("systemctl", "start", name)
        if "pair-notebook-server" in active:
            checks.wait_health(local)
        print("Previous server restored and health checked. Project data and owner credentials retained.")
        raise


def rollback(config: dict) -> None:
    target = Path(config.get("previous", ""))
    if not target.is_absolute() or not target.resolve().is_relative_to(ROOT.resolve()) or not (target / "BUILD.json").is_file():
        raise InstallError("No retained previous release is available.")
    current, active = (ROOT / "server").resolve(), active_services()
    try:
        stop()
        switch(target)
        start()
        # An older retained server may not implement compatibility discovery.
        checks.verify(config)
        version = json.loads((target / "BUILD.json").read_text())["version"]
        updated = {**config, "version": version, "previous": str(current)}
        write(STATE / "installation.json", json.dumps(updated, indent=2) + "\n")
        config.update(updated)
    except BaseException:
        restore(current, active)
        raise
