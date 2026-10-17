"""Remove Pair-owned installation data after exporting Python sources and notebooks."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess

from . import nginx, services, removal_volumes
from .system import CONFIG, ROOT, STATE, InstallError, run, write


def safe_root(value: Path, allowed: tuple[Path, ...]) -> Path:
    if value not in allowed or value.is_symlink() or value.resolve() != value:
        raise InstallError("Refusing to remove a directory outside the recorded Pair Notebook installation.")
    return value


def source_files(data: Path) -> list[tuple[str, Path, str]]:
    result = []
    sessions = data / "sessions"
    if not sessions.exists():
        return result
    if sessions.is_symlink():
        raise InstallError("Session storage must not be a symlink.")
    for directory in sorted(sessions.iterdir()):
        if not re.fullmatch(r"[a-f0-9-]{36}", directory.name):
            continue
        manifest = directory / "workspace/manifest.json"
        if not manifest.exists():
            continue
        if directory.is_symlink() or directory.resolve().parent != sessions.resolve():
            raise InstallError("Unsafe session directory.")
        record = json.loads((directory / "session.json").read_text())
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(record.get("name", "project"))).strip("._")[:80] or "project"
        for entry in json.loads(manifest.read_text())["entries"]:
            relative = PurePosixPath(entry["path"])
            if entry.get("type") != "file" or relative.suffix.lower() not in {".py", ".ipynb"}:
                continue
            digest = entry.get("blob", "")
            if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts) or "\\" in str(relative) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise InstallError("Invalid project source entry; no files were removed.")
            blob = directory / "workspace/blobs" / digest
            if blob.is_symlink() or not blob.is_file() or blob.resolve().parent != (directory / "workspace/blobs").resolve() or not blob.resolve().is_relative_to(directory.resolve()):
                raise InstallError("Unsafe project source blob.")
            if hashlib.sha256(blob.read_bytes()).hexdigest() != digest:
                raise InstallError("Project source checksum mismatch; no files were removed.")
            result.append((f"{name}-{directory.name}/{relative}", blob, digest))
    return result


def preserve_sources(data: Path, destination: Path) -> int:
    files = source_files(data)
    if destination.exists() or destination.is_symlink():
        raise InstallError("Choose a new, empty source export directory.")
    destination.mkdir(parents=True, mode=0o700)
    destination.chmod(0o700)
    for name, blob, digest in files:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with target.open("xb") as output:
            output.write(blob.read_bytes())
        target.chmod(0o600)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise InstallError("Source export verification failed; no installation files were removed.")
    return len(files)


def remove_proxy(config: dict) -> None:
    if config.get("proxy") == "nginx":
        if nginx.SITE.exists():
            if not nginx.SITE.read_text().startswith(nginx.MARKER):
                raise InstallError("The nginx snippet is no longer Pair-owned.")
            original = nginx.SITE.read_text()
            nginx.SITE.unlink()
            try:
                run("nginx", "-t")
            except BaseException:
                write(nginx.SITE, original, 0o644)
                raise
            run("systemctl", "reload", "nginx")
    elif config.get("network") == "proxy":
        file = Path("/etc/caddy/Caddyfile")
        content = file.read_text()
        managed = "# Pair Notebook managed include\nimport /etc/pair-notebook/proxy-site.caddy\n"
        if managed not in content:
            raise InstallError("The existing Caddy include was changed; remove only its Pair virtual host manually.")
        write(file, content.replace(managed, ""), 0o644)
        try:
            run("caddy", "validate", "--config", str(file))
        except BaseException:
            write(file, content, 0o644)
            raise
        run("systemctl", "reload", "caddy")


def uninstall(config: dict, destination: Path | None = None) -> tuple[Path, int]:
    data = Path(config.get("data", "/var/lib/pair-notebook-vps"))
    worker = Path(config.get("workerData", "/var/lib/pair-notebook-worker"))
    allowed = (ROOT, CONFIG, STATE, Path("/var/lib/pair-notebook-vps"), Path("/var/lib/pair-notebook-worker"), Path("/var/lib/pair-notebook-proxy"), Path("/etc/letsencrypt-pair"), Path('/var/lib/pair-notebook-acme'), Path('/var/lib/pair-notebook-acme-work'), Path('/var/log/pair-notebook-acme'))
    machine_id = Path('/etc/machine-id').read_text().strip()
    if re.fullmatch(r'[a-f0-9]{32}', machine_id):
        allowed += tuple(Path(root) / (machine_id + '.pair-notebook') for root in ('/var/log/journal', '/run/log/journal'))
    for directory in (*allowed, data, worker):
        safe_root(directory, allowed)
    volumes = removal_volumes.plan((data, worker))
    source_files(data)  # Validate the export before interrupting services.
    destination = destination or Path("/root/pair-notebook-files") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    resolved = destination.resolve()
    if not destination.is_absolute() or any(resolved.is_relative_to(directory) for directory in allowed):
        raise InstallError("Export sources outside the installation directories being removed.")
    units = services.SERVICES + ["pair-notebook-certificate.timer", "pair-notebook-certificate", "pair-notebook-cert-renew.timer", "pair-notebook-cert-renew", "pair-notebook-tls-refresh.timer", "pair-notebook-tls-refresh", "pair-notebook-soak", "systemd-journald@pair-notebook", "pair-notebook.slice"]
    unit_files = [services.UNITS / (name if name.endswith(('.timer', '.slice')) else name + '.service') for name in units if not name.startswith('systemd-journald@')]
    for file in unit_files:
        dropins = file.with_name(file.name + '.d')
        if dropins.is_symlink():
            raise InstallError('Unsafe Pair service override directory.')
    active = [name for name in units if subprocess.run(["systemctl", "is-active", "--quiet", name], check=False).returncode == 0]
    for name in units:
        subprocess.run(["systemctl", "stop", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        count = preserve_sources(data, destination)
        removal_volumes.detach(volumes)
        remove_proxy(config)
    except BaseException:
        removal_volumes.restore(volumes)
        for name in active:
            run("systemctl", "start", name)
        raise
    for name in units:
        if name.startswith('systemd-journald@'):
            continue
        subprocess.run(["systemctl", "disable", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for file in unit_files:
        file.unlink(missing_ok=True)
        dropins = file.with_name(file.name + '.d')
        if dropins.exists():
            shutil.rmtree(dropins)
    Path('/etc/systemd/journald@pair-notebook.conf').unlink(missing_ok=True)
    run("systemctl", "daemon-reload")
    profile = Path("/etc/apparmor.d/pair-notebook-bwrap")
    if profile.exists():
        if str(ROOT / "runtime/bin/bwrap") not in profile.read_text():
            raise InstallError("The Pair AppArmor profile was changed; retained for manual removal.")
        run("apparmor_parser", "-R", str(profile))
        profile.unlink()
    trust = Path("/usr/local/share/ca-certificates/pair-notebook-local.crt")
    if trust.exists():
        source = CONFIG / "local-ca.crt"
        if trust.is_symlink() or not source.is_file() or trust.read_bytes() != source.read_bytes():
            raise InstallError("The Pair trust certificate was changed; retained for manual removal.")
        trust.unlink()
        run("update-ca-certificates")
    for directory in dict.fromkeys((data, worker, *allowed)):
        if directory.exists():
            shutil.rmtree(directory)
    removal_volumes.remove_images(volumes)
    for name in ("pair-server", "pair-worker", "pair-proxy"):
        if subprocess.run(["id", "-u", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            run("userdel", name)
    print(f"Pair Notebook removed. Preserved {count} Python/notebook files at {destination} (root only).")
    print("Pair services, credentials, session history, caches and private runtimes removed. Shared OS packages, SSH, firewall, VPN and other services were retained.")
    return destination, count
