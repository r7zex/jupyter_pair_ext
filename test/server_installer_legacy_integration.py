"""Exercise adoption only in an already prepared disposable Docker container."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import tarfile
import time

from server_installer_integration import faulty_archive


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--old-archive", type=Path, required=True)
    parser.add_argument("--new-archive", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--docker-config")
    args = parser.parse_args()
    with tarfile.open(args.new_archive) as archive:
        target_version = json.load(archive.extractfile('server/BUILD.json'))['version']
    with tarfile.open(args.old_archive) as archive:
        old_version = json.load(archive.extractfile('server/BUILD.json'))['version']
    docker = ["docker"] + (["--config", args.docker_config] if args.docker_config else [])
    evidence = {"scope": "disposable systemd container on one physical computer", "checks": []}

    def command(*values: str, input: str | None = None, success: bool = True):
        result = subprocess.run([*docker, *values], input=input, text=True, capture_output=True, timeout=600)
        if success and result.returncode:
            # Installer output and the fixture contain disposable credentials.
            if values[0] == "cp":
                raise RuntimeError("Docker copy failed: " + result.stderr.strip())
            errors = [line for line in result.stderr.splitlines() if line.startswith('Pair Notebook installation failed:')]
            raise RuntimeError(f"Docker operation failed (exit {result.returncode}): " + ' '.join(errors))
        return result

    def python(source: str):
        return command("exec", "-i", args.container, "python3", "-", input=source)

    def check(label: str):
        evidence["checks"].append(label)
        print("PASS: " + label, flush=True)

    def version():
        return json.loads(command("exec", args.container, "cat", "/opt/pair-notebook/server/BUILD.json").stdout)["version"]

    def preserved():
        python('''import base64, hashlib, json, pathlib, urllib.request
root = pathlib.Path('/var/lib/pair-notebook-install')
baseline = json.loads((root / 'adoption-baseline.json').read_text())
for file, digest in baseline.items():
    assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest() == digest
identities = json.loads((root / 'acceptance-project.json').read_text())
for identity in identities.values():
    fields = dict(operation='read', sessionId=identity['sessionId'], path='survival.txt')
    request = urllib.request.Request('http://127.0.0.1:8788/v1/sessions/rpc', data=json.dumps(fields).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+identity['token']})
    with urllib.request.urlopen(request, timeout=15) as reply: value = json.load(reply)
    assert base64.b64decode(value['content']) == b'preserved project and owner access'
''')
        for name, pid in pids.items():
            assert command("exec", args.container, "systemctl", "show", name, "-p", "MainPID", "--value").stdout == pid

    try:
        command("start", args.container)
        for _ in range(60):
            if command("exec", args.container, "systemctl", "is-system-running", success=False).stdout.strip() in {"running", "degraded"}:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Disposable systemd container did not become ready.")
        command("exec", args.container, "mkdir", "-p", "/var/lib/pair-adoption-fixture")
        command("cp", str(args.installer), f"{args.container}:/var/lib/pair-adoption-fixture/installer.pyz")
        for label, archive in (("old", args.old_archive), ("new", args.new_archive)):
            command("exec", args.container, "mkdir", "-p", f"/var/lib/pair-adoption-fixture/{label}")
            command("cp", str(archive), f"{args.container}:/var/lib/pair-adoption-fixture/{label}/pair-notebook-server-persistent.tar.gz")
            command("cp", str(archive) + ".sha256", f"{args.container}:/var/lib/pair-adoption-fixture/{label}/pair-notebook-server-persistent.tar.gz.sha256")
        command("exec", args.container, "systemctl", "stop", "pair-notebook-worker", "pair-notebook-server", "pair-notebook-proxy")
        command("exec", args.container, "mkdir", "-p", "/opt/pair-notebook/releases/manual-066")
        command("exec", args.container, "tar", "-xzf", "/var/lib/pair-adoption-fixture/old/pair-notebook-server-persistent.tar.gz", "-C", "/opt/pair-notebook/releases/manual-066")
        python('''import json, pathlib
root = pathlib.Path('/opt/pair-notebook')
server = root / 'server'
server.unlink()
server.symlink_to(root / 'releases/manual-066/server')
if not (root / 'node').exists():
    (root / 'node').symlink_to(root / 'runtime/node')
files = ['/etc/pair-notebook/server.env', '/etc/pair-notebook/Caddyfile', '/etc/systemd/system/pair-notebook-worker.service', '/etc/systemd/system/pair-notebook-server.service']
for filename in files:
    file = pathlib.Path(filename)
    text = file.read_text().replace('8787', '8788').replace(':443 {', ':9443 {').replace('/runtime/node/bin/node', '/node/bin/node')
    file.write_text(text)
identity_file = pathlib.Path('/var/lib/pair-notebook-worker/identity.json')
identity = json.loads(identity_file.read_text())
identity['endpoint'] = 'http://127.0.0.1:8788'
identity_file.write_text(json.dumps(identity))
for filename in ('installation.json', 'installation-pending.json', 'owner-server.json'):
    pathlib.Path('/var/lib/pair-notebook-install', filename).unlink(missing_ok=True)
''')
        command("exec", args.container, "systemctl", "daemon-reload")
        command("exec", args.container, "systemctl", "reset-failed", "pair-notebook-worker")
        command("exec", args.container, "systemctl", "start", "pair-notebook-server", "pair-notebook-worker", "pair-notebook-proxy")
        if command("exec", args.container, "systemctl", "is-active", "--quiet", "unrelated-vpn-fixture", success=False).returncode:
            command("exec", args.container, "systemd-run", "--unit=unrelated-vpn-fixture", "/usr/bin/python3", "-m", "http.server", "443", "--bind", "127.0.0.1")
        python('''import hashlib, json, pathlib
files = list(pathlib.Path('/etc/pair-notebook').rglob('*')) + list(pathlib.Path('/etc/systemd/system').glob('pair-notebook-*.service'))
baseline = {str(file): hashlib.sha256(file.read_bytes()).hexdigest() for file in files if file.is_file()}
pathlib.Path('/var/lib/pair-notebook-install/adoption-baseline.json').write_text(json.dumps(baseline))
''')
        pids = {name: command("exec", args.container, "systemctl", "show", name, "-p", "MainPID", "--value").stdout
                for name in ("pair-notebook-proxy", "unrelated-vpn-fixture")}
        assert all(int(pid.strip()) > 0 for pid in pids.values())
        assert version() == old_version
        preserved()
        check(f"real packaged {old_version} manual layout; broker 8788; HTTPS 9443; existing owner and participant access")
        fault = args.report.parent / "adoption-fault.tar.gz"
        fault.parent.mkdir(parents=True, exist_ok=True)
        faulty_archive(args.new_archive, fault)
        command("cp", str(fault), f"{args.container}:/var/lib/pair-adoption-fixture/new/adoption-fault.tar.gz")
        command("cp", str(fault) + ".sha256", f"{args.container}:/var/lib/pair-adoption-fixture/new/adoption-fault.tar.gz.sha256")
        installer = ["exec", "-i", args.container, "python3", "/var/lib/pair-adoption-fixture/installer.pyz"]
        for layout in ("symlink", "directory"):
            if layout == "directory":
                python('''import pathlib, shutil
server = pathlib.Path('/opt/pair-notebook/server')
copy = server.with_name('directory-fixture')
shutil.copytree(server.resolve(), copy)
server.unlink()
copy.rename(server)
''')
            failed = command(*installer, "--archive", "/var/lib/pair-adoption-fixture/new/adoption-fault.tar.gz", "--action", "update", input="\nyes\n", success=False)
            if failed.returncode == 0 or "Previous server restored and health checked" not in failed.stdout:
                errors = [line for line in failed.stderr.splitlines() if line.startswith('Pair Notebook installation failed:')]
                raise AssertionError("Expected automatic rollback: " + ' '.join(errors))
            assert version() == old_version
            if layout == "directory":
                assert command("exec", args.container, "test", "-L", "/opt/pair-notebook/server", success=False).returncode != 0
            preserved()
            check(f"failed adoption restores original {layout}, active services, projects and credentials")
            # The second adoption downloads the actual immutable release itself.
            flags = ["--archive", "/var/lib/pair-adoption-fixture/new/pair-notebook-server-persistent.tar.gz"] if layout == "symlink" else []
            command(*installer, *flags, "--action", "update", input="\nyes\n")
            assert version() == target_version
            preserved()
            check(f"{layout} adoption passes trusted HTTPS, encrypted WebSocket/reconnect and isolated Jupyter 42")
            command(*installer, "--action", "check")
            preserved()
            if layout == "symlink":
                command(*installer, "--action", "rollback")
                assert version() == old_version
                preserved()
                check(f"explicit rollback to {old_version} passes supported readiness checks; original access and proxy PID retained")
        evidence["passed"] = True
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
