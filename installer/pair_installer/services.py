"""Generate only Pair-owned service units and credentials."""
from __future__ import annotations

import json
from pathlib import Path
import secrets
import shutil

from .system import CONFIG, ROOT, STATE, account, run, write
from .network import managed_certificate

UNITS = Path("/etc/systemd/system")
SERVICES = ["pair-notebook-server", "pair-notebook-worker", "pair-notebook-proxy"]


def credentials(config: dict) -> None:
    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o755)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not (CONFIG / "server.env").exists():
        admin, worker = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
        write(CONFIG / "server.env", f"PAIR_VPS_CLIENT_TOKEN={admin}\nPAIR_VPS_AGENT_TOKENS={json.dumps({'vps': worker}, separators=(',', ':'))}\nPAIR_VPS_DATA=/var/lib/pair-notebook-vps\nPAIR_VPS_BIND=127.0.0.1\nPAIR_VPS_PORT={config['port']}\n")
        if config["mode"] == "full":
            write(CONFIG / "interactive-vps.token", worker + "\n", 0o640)
        write(STATE / "owner-server.json", json.dumps({"endpoint": config["endpoint"], "adminToken": admin}, indent=2) + "\n")
    run("chown", "root:pair-server", str(CONFIG / "server.env"))
    (CONFIG / "server.env").chmod(0o640)
    if config["mode"] == "full":
        run("chown", "root:pair-worker", str(CONFIG / "interactive-vps.token"))


def prepare_accounts(full: bool) -> None:
    for name, home in [("pair-server", "/var/lib/pair-notebook-vps"), ("pair-proxy", "/var/lib/pair-notebook-proxy")] + ([("pair-worker", "/var/lib/pair-notebook-worker")] if full else []):
        account(name, home)
        directory = Path(home)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        run("chown", f"{name}:{name}", home)


def worker_runtime() -> None:
    venv = ROOT / "worker-venv"
    if not venv.exists():
        run("python3", "-m", "venv", str(venv))
    run(str(venv / "bin/pip"), "install", "jupyter_client>=8.6,<9", "ipykernel>=6.29,<8")
    # A dedicated executable/profile avoids changing global user-namespace policy.
    binary = ROOT / "runtime/bin/bwrap"
    binary.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile("/usr/bin/bwrap", binary)
    binary.chmod(0o755)
    restriction = Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
    if restriction.exists() and restriction.read_text().strip() == "1":
        profile = Path("/etc/apparmor.d/pair-notebook-bwrap")
        write(profile, f"abi <abi/4.0>,\ninclude <tunables/global>\n{binary} flags=(unconfined) {{\n userns,\n}}\n", 0o644)
        run("apparmor_parser", "-r", str(profile))


def unit(name: str, text: str) -> None:
    write(UNITS / f"{name}.service", text, 0o644)


def configure(config: dict) -> None:
    full = config["mode"] == "full"
    node = ROOT / "runtime/node/bin/node"
    server = ROOT / "server"
    base = f"""[Unit]
Description=Pair Notebook server
After=network-online.target
Wants=network-online.target
[Service]
User=pair-server
Group=pair-server
WorkingDirectory=/var/lib/pair-notebook-vps
EnvironmentFile=/etc/pair-notebook/server.env
ExecStart={node} {server}/out/src/vps/{'cli.js' if full else 'relayCli.js'}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=
ReadWritePaths=/var/lib/pair-notebook-vps
MemoryMax=512M
TasksMax=128
[Install]
WantedBy=multi-user.target
"""
    unit("pair-notebook-server", base)
    if full:
        content = (server / "deploy/persistent/pair-notebook-worker.service").read_text()
        content = content.replace("/opt/pair-notebook-worker-venv", str(ROOT / "worker-venv"))
        content = content.replace("--url http://127.0.0.1:8787", f"--url http://127.0.0.1:{config['port']}")
        content = content.replace("[Service]\n", f"[Service]\nEnvironment=PATH={ROOT}/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n")
        unit("pair-notebook-worker", content)
    if config["network"] != "proxy":
        unit("pair-notebook-proxy", f"""[Unit]
Description=Pair Notebook HTTPS proxy
After=network-online.target
[Service]
User=pair-proxy
Group=pair-proxy
Environment=HOME=/var/lib/pair-notebook-proxy
ExecStart={ROOT}/runtime/caddy run --config /etc/pair-notebook/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/pair-notebook-proxy
UMask=0077
[Install]
WantedBy=multi-user.target
""")
    if managed_certificate(config):
        hook = CONFIG / "certificate-deploy.sh"
        reload = "systemctl reload nginx.service" if config.get("proxy") == "nginx" else "systemctl restart pair-notebook-proxy.service"
        write(hook, f"#!/bin/sh\nset -eu\nchgrp -R pair-proxy /etc/letsencrypt-pair\nchmod -R g+rX,o-rwx /etc/letsencrypt-pair\n{reload}\n", 0o700)
        unit("pair-notebook-certificate", f"""[Unit]
Description=Renew Pair Notebook TLS certificate
[Service]
Type=oneshot
ExecStart={ROOT}/certbot/bin/certbot renew --quiet --config-dir /etc/letsencrypt-pair --work-dir /var/lib/pair-notebook-acme-work --logs-dir /var/log/pair-notebook-acme --deploy-hook {hook}
""")
        write(UNITS / "pair-notebook-certificate.timer", "[Unit]\nDescription=Check Pair Notebook certificate renewal every hour\n[Timer]\nOnBootSec=5m\nOnUnitActiveSec=1h\nRandomizedDelaySec=5m\nPersistent=true\n[Install]\nWantedBy=timers.target\n", 0o644)
    run("systemctl", "daemon-reload")


def start(config: dict) -> None:
    names = ["pair-notebook-server"]
    if config["mode"] == "full":
        names.append("pair-notebook-worker")
    if config["network"] != "proxy":
        names.append("pair-notebook-proxy")
    for name in names:
        run("systemctl", "enable", name)
        run("systemctl", "restart", name)
    if managed_certificate(config):
        run("systemctl", "enable", "--now", "pair-notebook-certificate.timer")
