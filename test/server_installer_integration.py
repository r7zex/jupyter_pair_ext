"""Isolated systemd-container acceptance; never targets an existing server.

Run on a Linux Docker host after package:persistent-server. These are same-host
container checks, not physical-computer, public-ACME or real VS Code UI evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
from pathlib import Path
import subprocess
import tarfile
import time


def faulty_archive(source: Path, destination: Path) -> None:
    with tarfile.open(source) as archive:
        files = {entry.name: archive.extractfile(entry).read() for entry in archive.getmembers() if entry.isfile()}
    files["server/out/src/vps/cli.js"] = b"process.exit(1);\n"
    manifest = json.loads(files["server/BUILD.json"])
    manifest["files"]["out/src/vps/cli.js"] = hashlib.sha256(files["server/out/src/vps/cli.js"]).hexdigest()
    files["server/BUILD.json"] = json.dumps(manifest).encode()
    with tarfile.open(destination, "w:gz") as archive:
        for name, content in files.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(content), 0o644
            archive.addfile(entry, io.BytesIO(content))
    Path(str(destination) + ".sha256").write_text(hashlib.sha256(destination.read_bytes()).hexdigest() + "  " + destination.name + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--docker-config")
    parser.add_argument("--mode", choices=["full", "relay"], default="full")
    parser.add_argument("--keep-container", action="store_true", help="Retain this isolated test server for further acceptance")
    parser.add_argument("--occupied-https", action="store_true", help="Keep an unrelated TCP 443 service running and select 8443")
    parser.add_argument("--repair-runtime", action="store_true", help="Verify repair of a deliberately broken private Node executable")
    args = parser.parse_args()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    docker = ["docker"] + (["--config", args.docker_config] if args.docker_config else [])
    evidence = {"image": args.image, "mode": args.mode, "scope": "isolated systemd container on one Docker host", "checks": []}

    def command(*values: str, input: str | None = None, success: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run([*docker, *values], input=input, text=True, capture_output=True, timeout=900)
        if success and result.returncode:
            # Installer stdout contains generated test credentials: do not print it.
            errors = [line for line in (result.stderr + result.stdout).splitlines() if "installation failed:" in line or "Traceback" in line]
            errors += result.stderr.splitlines()[-3:]
            errors = [re.sub(r"[A-Za-z0-9_-]{32,}", "[redacted]", line) for line in errors]
            raise RuntimeError(f"Container operation failed (exit {result.returncode}): " + " ".join(errors))
        return result

    def check(label: str) -> None:
        evidence["checks"].append(label)
        print("PASS: " + label, flush=True)

    def project_fixture(action: str) -> None:
        program = '''import base64, json, pathlib, sys, urllib.request
root = pathlib.Path('/var/lib/pair-notebook-install')
def rpc(operation, token='', **fields):
    request = urllib.request.Request('http://127.0.0.1:8787/v1/sessions/rpc', data=json.dumps(dict(fields, operation=operation)).encode(), headers={'Content-Type':'application/json', **({'Authorization':'Bearer '+token} if token else {})})
    with urllib.request.urlopen(request, timeout=15) as reply: return json.load(reply)
if sys.argv[1] == 'create':
    admin = json.loads((root / 'owner-server.json').read_text())['adminToken']
    owner = rpc('create', admin, name='Preserved acceptance project', password='acceptance survival password')
    invitation = rpc('createInvitation', owner['token'], sessionId=owner['sessionId'], lifetimeSeconds=3600, readOnly=False)
    guest = rpc('acceptInvitation', sessionId=owner['sessionId'], invitationToken=invitation['invitationToken'], name='Second participant')
    rpc('write', owner['token'], sessionId=owner['sessionId'], path='survival.txt', expectedRevision=0, content=base64.b64encode(b'preserved project and owner access').decode())
    (root / 'acceptance-project.json').write_text(json.dumps(dict(owner=owner, guest=guest)))
identities = json.loads((root / 'acceptance-project.json').read_text())
for identity in identities.values():
    result = rpc('read', identity['token'], sessionId=identity['sessionId'], path='survival.txt')
    assert base64.b64decode(result['content']) == b'preserved project and owner access'
'''
        command("exec", "-i", args.name, "python3", "-", action, input=program)

    created = False
    try:
        command("run", "-d", "--name", args.name, "--privileged", "--cgroupns=private", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp",
                "-v", f"{args.artifacts.resolve()}:/release:ro", args.image)
        created = True
        for _ in range(40):
            if command("exec", args.name, "systemctl", "is-system-running", success=False).stdout.strip() in {"running", "degraded"}:
                break
            time.sleep(0.5)
        ip = command("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", args.name).stdout.strip()
        unrelated_pid = None
        if args.occupied_https:
            command("exec", args.name, "systemd-run", "--unit=pair-unrelated-443", "/usr/bin/python3", "-m", "http.server", "443", "--bind", "127.0.0.1")
            for _ in range(30):
                if command("exec", args.name, "curl", "--fail", "--silent", "--output", "/dev/null", "http://127.0.0.1:443", success=False).returncode == 0:
                    break
                time.sleep(.1)
            unrelated_pid = command("exec", args.name, "systemctl", "show", "-p", "MainPID", "pair-unrelated-443").stdout
        installer = ["exec", "-i", args.name, "python3", "/release/pair-notebook-install.pyz", "--archive", "/release/pair-notebook-server-persistent.tar.gz", "--mode", args.mode]
        print(f"Installing {args.mode} on clean {args.image}", flush=True)
        command(*installer, input=f"lan\n{ip}\n8787\n" + ("\n" if args.occupied_https else "") + "yes\n")
        check("clean installation; trusted LAN HTTPS; real encrypted WebSocket exchange and reconnect" + ("; real isolated Jupyter cell returns 42" if args.mode == "full" else "; no Jupyter worker"))
        credential_hash = command("exec", args.name, "sha256sum", "/var/lib/pair-notebook-install/owner-server.json").stdout
        if args.mode == "full":
            project_fixture("create")
            check("owner creates a durable project; second participant joins by invitation and reads its file")
        command(*installer, "--action", "check")
        check("repeat invocation detects installation and verifies it")
        command(*installer, "--action", "repair")
        if args.mode == "full":
            project_fixture("verify")
        assert credential_hash == command("exec", args.name, "sha256sum", "/var/lib/pair-notebook-install/owner-server.json").stdout
        check("repair retains owner credentials")
        if args.repair_runtime:
            program = "from pathlib import Path; p=Path('/opt/pair-notebook/runtime/node/bin/node'); p.rename(p.with_name('node.fixture-backup')); p.write_text('#!/bin/sh\\nexit 1\\n'.replace('\\\\n','\\n')); p.chmod(0o755)"
            command("exec", args.name, "python3", "-c", program)
            command(*installer, "--action", "repair")
            if args.mode == "full":
                project_fixture("verify")
            check("repair replaces a broken private Node runtime and retains project access")
        command(*installer, "--action", "update")
        if args.mode == "full":
            project_fixture("verify")
        assert credential_hash == command("exec", args.name, "sha256sum", "/var/lib/pair-notebook-install/owner-server.json").stdout
        check("update retains owner credentials")
        command(*installer, "--action", "rollback")
        if args.mode == "full":
            project_fixture("verify")
        check("explicit rollback passes readiness checks")
        if args.mode == "full":
            fault = args.report.parent / f"{args.name}-fault.tar.gz"
            faulty_archive(args.artifacts / "pair-notebook-server-persistent.tar.gz", fault)
            command("cp", str(fault), f"{args.name}:/var/lib/pair-notebook-install/fault.tar.gz")
            # Keep the filename in the checksum equal to the copied fixture.
            command("exec", args.name, "sh", "-c", "cd /var/lib/pair-notebook-install && sha256sum fault.tar.gz > fault.tar.gz.sha256")
            failed = command("exec", args.name, "python3", "/release/pair-notebook-install.pyz", "--archive", "/var/lib/pair-notebook-install/fault.tar.gz", "--action", "update", success=False)
            assert failed.returncode != 0 and "Previous server restored and health checked" in failed.stdout
            command(*installer, "--action", "check")
            project_fixture("verify")
            assert credential_hash == command("exec", args.name, "sha256sum", "/var/lib/pair-notebook-install/owner-server.json").stdout
            check("injected server-start failure automatically restores working previous release and owner access")
        else:
            result = command("exec", args.name, "sh", "-c", "test ! -d /opt/pair-notebook/worker-venv && ! systemctl is-enabled pair-notebook-worker.service >/dev/null 2>&1")
            assert result.returncode == 0
            check("relay-only installation has no Python/Jupyter worker runtime or unit")
        if args.occupied_https:
            assert unrelated_pid == command("exec", args.name, "systemctl", "show", "-p", "MainPID", "pair-unrelated-443").stdout
            command("exec", args.name, "curl", "--fail", "--silent", "--output", "/dev/null", "http://127.0.0.1:443")
            check("installer uses HTTPS 8443 while the unrelated TCP 443 service keeps its PID")
        evidence["passed"] = True
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(evidence, indent=2) + "\n")
        if created and not args.keep_container:
            command("rm", "-f", args.name, success=False)


if __name__ == "__main__":
    main()
