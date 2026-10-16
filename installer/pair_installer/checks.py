"""Behavioral readiness checks, including execution and the encrypted relay."""
from __future__ import annotations

import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from .system import CONFIG, ROOT, STATE, InstallError, run


def rpc(url: str, operation: str, fields: dict | None = None, token: str = "") -> dict:
    data = json.dumps({**(fields or {}), "operation": operation}).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url + "/v1/sessions/rpc", data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as reply:
        return json.load(reply)


def wait_health(url: str, attempts: int = 30) -> dict:
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url + "/health", timeout=3) as reply:
                value = json.load(reply)
                if value.get("status") == "ok":
                    return value
        except (OSError, ValueError):
            time.sleep(1)
    raise InstallError("HTTPS readiness failed. Check DNS, certificate renewal, NAT/CGNAT, port forwarding and external TCP 80/443 access. No public reachability claim was made.")


def verify(config: dict, public: bool = True) -> None:
    local = f"http://127.0.0.1:{config['port']}"
    health = wait_health(local)
    run(str(ROOT / "runtime/node/bin/node"), str(ROOT / "server/out/src/vps/relayCheck.js"), local)
    if config["mode"] == "full":
        # The smoke script creates its own project, executes a real kernel cell,
        # verifies output and removes only that project in a finally block.
        run("python3", str(ROOT / "server/scripts/pair-notebook-server-check.py"), "--url", local, "--credentials", str(STATE / "owner-server.json"))
    if public and config["network"] != "lan":
        if wait_health(config["endpoint"]).get("instanceId") != health.get("instanceId"):
            raise InstallError("The configured HTTPS address reaches a different server. Correct DNS or proxy routing.")
        run(str(ROOT / "runtime/node/bin/node"), str(ROOT / "server/out/src/vps/relayCheck.js"), config["endpoint"])
    if config["network"] == "lan":
        root = Path("/var/lib/pair-notebook-proxy/.local/share/caddy/pki/authorities/local/root.crt")
        for _ in range(20):
            if root.exists():
                break
            time.sleep(1)
        if not root.exists():
            raise InstallError("The local HTTPS authority did not start.")
        run("cp", str(root), "/usr/local/share/ca-certificates/pair-notebook-local.crt")
        run("update-ca-certificates")
        run("cp", str(root), str(CONFIG / "local-ca.crt"))
        if wait_health(config["endpoint"]).get("instanceId") != health.get("instanceId"):
            raise InstallError("The LAN address reaches a different Pair server.")
        run("env", f"NODE_EXTRA_CA_CERTS={CONFIG / 'local-ca.crt'}", str(ROOT / "runtime/node/bin/node"), str(ROOT / "server/out/src/vps/relayCheck.js"), config["endpoint"])
