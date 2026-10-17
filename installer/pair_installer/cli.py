"""Interactive first installation and transactional maintenance."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
try:
    import fcntl
except ImportError:
    fcntl = None  # Unsupported systems are rejected before acquiring the Linux lock.
import json
import ipaddress
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.error import URLError
from urllib.parse import urlsplit

from . import checks, legacy, network, recovery, removal, services
from .system import CONFIG, ROOT, STATE, VERSION, InstallError, release, run, runtime, supported_system, switch, upgrade_version, write


def prompt(label: str, default: str = "", choices: tuple[str, ...] = ()) -> str:
    while True:
        result = input(f"{label}{f' [{default}]' if default else ''}: ").strip() or default
        if choices:
            result = result.casefold()
        if result and (not choices or result in choices):
            return result
        print(f"Choose one of: {', '.join(choices)}" if choices else "A value is required.")


def collect(mode: str) -> dict:
    print("Server location is independent of provider: dedicated, physical, cloud or LAN.")
    print("Public modes require incoming TCP 80 and the chosen HTTPS port (default 443) forwarded to this machine. CGNAT needs a public route or LAN mode.")
    kind = prompt("Connection: domain / ip / lan / proxy", "domain", ("domain", "ip", "lan", "proxy"))
    value = prompt("Server domain or HTTPS address" if kind != "lan" else "LAN IP or DNS name")
    url, host = network.endpoint(value, kind)
    resolved = network.addresses(host)
    print("Resolved server addresses: " + ", ".join(sorted(resolved)))
    port = int(prompt("Private broker port", "8787"))
    if not 1024 <= port <= 65535:
        raise InstallError("Choose a private port between 1024 and 65535.")
    network.free_port(port, "127.0.0.1")
    config = {"version": VERSION, "mode": mode, "network": kind, "endpoint": url, "host": host, "port": port}
    config["httpsPort"] = urlsplit(url).port or 443
    if kind == "proxy":
        default = "nginx" if shutil.which("nginx") else "caddy"
        config["proxy"] = prompt("Existing proxy to integrate: caddy / nginx", default, ("caddy", "nginx"))
        if config["proxy"] == "caddy":
            try:
                ipaddress.ip_address(host)
            except ValueError:
                pass
            else:
                raise InstallError("Existing Caddy integration uses a new public domain. Choose nginx or managed IP mode for public-IP certificates.")
        else:
            try:
                ipaddress.ip_address(host)
                config["certificateMode"] = "ip"
            except ValueError:
                config["certificateMode"] = "domain"
        print("A new virtual host will be added with backup and validation. Existing hostnames are refused.")
    else:
        if kind != "lan":
            network.free_port(80)
        try:
            network.free_port(config["httpsPort"])
        except InstallError:
            if urlsplit(url).port is not None:
                raise
            alternative = int(prompt("HTTPS port 443 is occupied. Use another HTTPS port", "8443"))
            host_port = f"[{host}]:{alternative}" if ":" in host else f"{host}:{alternative}"
            url, _ = network.endpoint(host_port, kind)
            network.free_port(alternative)
            config.update(endpoint=url, httpsPort=alternative)
        if config["httpsPort"] == port:
            raise InstallError("The private broker and HTTPS proxy need different ports.")
    if kind == "lan":
        print("Each owner and participant must trust the generated local-ca.crt. TLS verification remains enabled.")
    if network.managed_certificate(config):
        print("Continuing accepts the Let's Encrypt subscriber agreement: https://letsencrypt.org/repository/")
    if prompt("Install these Pair Notebook services? yes / no", "yes", ("yes", "no")) != "yes":
        raise InstallError("Installation cancelled.")
    return config


def install(config: dict, architecture: str, archive: Path | None) -> None:
    upgrade_version(config["version"])
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    ROOT.mkdir(parents=True, exist_ok=True)
    if (ROOT / "server").exists() and not (ROOT / "server").is_symlink():
        raise InstallError("An unmanaged server directory already exists. Back it up and use the documented manual migration; it will not be overwritten.")
    previous = (ROOT / "server").resolve() if (ROOT / "server").exists() and (STATE / "installation.json").exists() else None
    write(STATE / "installation-pending.json", json.dumps(config, indent=2) + "\n")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    backup = STATE / "backups" / stamp
    backup.mkdir(parents=True, mode=0o700)
    active = [name for name in services.SERVICES if subprocess.run(["systemctl", "is-active", "--quiet", name], check=False).returncode == 0]
    tracked = [CONFIG, STATE / "installation.json"] + [services.UNITS / f"{name}.service" for name in services.SERVICES]
    if config["network"] == "proxy":
        tracked.append(Path("/etc/caddy/Caddyfile") if config["proxy"] == "caddy" else Path("/etc/nginx/conf.d/pair-notebook.conf"))
    originals = {}
    for index, item in enumerate(tracked):
        if item.exists():
            saved = backup / str(index)
            if item.is_dir():
                shutil.copytree(item, saved)
            else:
                shutil.copy2(item, saved)
            originals[item] = saved
    with tempfile.TemporaryDirectory(prefix="pair-install-") as temporary:
        directory = Path(temporary)
        package = release(directory, archive)
        # All downloads and hash verification precede service interruption.
        packages = ["ca-certificates", "openssl", "xz-utils"]
        if config["mode"] == "full" or network.managed_certificate(config):
            packages.append("python3-venv")
        if config["mode"] == "full":
            packages += ["bubblewrap", "python3", "apparmor"]
        run("apt-get", "update")
        run("env", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l", "apt-get", "install", "-y", "--no-install-recommends", *packages)
        runtime(directory, architecture)
        services.prepare_accounts(config["mode"] == "full")
        destination = ROOT / "releases" / f"{VERSION}-{stamp}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(package, destination)
        try:
            for name in reversed(active):
                run("systemctl", "stop", name)
            if previous and Path("/var/lib/pair-notebook-vps/sessions").exists():
                shutil.copytree("/var/lib/pair-notebook-vps/sessions", backup / "sessions")
            services.credentials(config)
            if config["mode"] == "full":
                services.worker_runtime()
            switch(destination)
            network.configure_proxy(config, initial=previous is None)
            services.configure(config)
            services.start(config)
            if config.get("proxy") == "nginx":
                from .nginx import configure as configure_nginx
                configure_nginx(config)
            network.certificate(config)
            network.configure_proxy(config)
            if config["network"] == "proxy":
                network.existing_proxy(config, config["proxy"])
            else:
                run("systemctl", "restart", "pair-notebook-proxy")
            checks.verify(config)
            write(STATE / "installation.json", json.dumps({**config, "version": VERSION, "previous": str(previous) if previous else None}, indent=2) + "\n")
            (STATE / "installation-pending.json").unlink(missing_ok=True)
        except BaseException:
            for name in services.SERVICES:
                subprocess.run(["systemctl", "stop", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for item, saved in originals.items():
                if saved.is_dir():
                    shutil.copytree(saved, item, dirs_exist_ok=True)
                else:
                    shutil.copy2(saved, item)
            if config["network"] == "proxy":
                site = Path("/etc/nginx/conf.d/pair-notebook.conf")
                if config["proxy"] == "nginx" and site not in originals:
                    site.unlink(missing_ok=True)
                run("systemctl", "reload", config["proxy"])
            if previous:
                switch(previous)
                run("systemctl", "daemon-reload")
                for name in active:
                    run("systemctl", "start", name)
                checks.wait_health(f"http://127.0.0.1:{config['port']}")
                print("Previous server restored and health checked. Project data and owner credentials retained.")
            else:
                for name in services.SERVICES + ["pair-notebook-certificate.timer"]:
                    subprocess.run(["systemctl", "disable", name], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print("Installation incomplete. Pair services stopped; rerun and choose repair. Diagnostic files retained.")
            raise


def show(config: dict) -> None:
    print(f"\nServer: {config['endpoint']}\nInstalled Pair Notebook: {config.get('version', VERSION)}")
    if config["mode"] == "full":
        credentials = json.loads((STATE / "owner-server.json").read_text())
        print("Owner: choose Pair Notebook: Create Server Project in VS Code, then enter this server address and administrative credential:")
        print(credentials["adminToken"])
        print(f"Recovery copy (root only): {STATE / 'owner-server.json'}")
        print("Choose a project name and a session password (12+ characters). Share the project invitation or server address and session password with participants. Never share the administrative credential.")
        print("Existing projects: reconnect your saved VS Code connection or import your existing owner JSON. If it was lost after reinstalling VS Code/the extension, rerun this utility and choose recover-owner.")
    else:
        print("Set Pair Notebook: Relay Url to this HTTPS server address, then create a temporary session. The invitation carries the relay address; no administrative credential is needed.")
    if config["network"] == "lan":
        print(f"LAN trust certificate: {CONFIG / 'local-ca.crt'}. Install it into each client's trusted roots before connecting; see SERVER_SETUP.md.")
    print("Local HTTPS, WebSocket, encrypted exchange and reconnect checks completed.")
    print("Public Internet/LAN client reachability is not proven by a check from this server. Run the release relay-check command from each participant's network before sharing access.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Install or maintain the prebuilt Pair Notebook server")
    parser.add_argument("--mode", choices=["full", "relay"], default="full")
    parser.add_argument("--archive", type=Path, help="Matching release archive with adjacent .sha256 (offline/local acceptance)")
    parser.add_argument("--action", choices=["check", "repair", "update", "rollback", "recover-owner", "uninstall"], help="Maintenance action; omitted opens an interactive menu")
    parser.add_argument("--export", type=Path, help="Uninstall: preserve .py/.ipynb files in this new absolute directory")
    args = parser.parse_args()
    try:
        architecture = supported_system()
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (STATE / "installer.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise InstallError("Another Pair Notebook installation is running.") from error
            path = STATE / "installation.json"
            if not path.exists() and (STATE / "installation-pending.json").exists():
                path = STATE / "installation-pending.json"
            if args.action == "uninstall":
                config = json.loads(path.read_text()) if path.exists() else legacy.discover()
                print("Remove all Pair Notebook services, sessions, credentials and runtimes. Python sources and notebooks will be exported first; active kernels stop.")
                if prompt("Uninstall Pair Notebook? yes / no", "no", ("yes", "no")) != "yes":
                    raise InstallError("Uninstall cancelled.")
                removal.uninstall(config, args.export)
                return
            if not path.exists() and legacy.present():
                config = legacy.discover()
                print(f"Detected existing Pair Notebook {config['version']}. Existing services, projects, credentials and HTTPS will be retained.")
                value = prompt("Existing server HTTPS address", legacy.default_endpoint())
                config["endpoint"], config["host"] = network.endpoint(value, "existing")
                if args.action in {"rollback", "recover-owner"}:
                    raise InstallError("Run this utility once to update the existing installation before rollback or owner recovery.")
                if args.action == "check":
                    legacy.owner_credential(config)
                    checks.verify(config)
                    show(config)
                    return
                print("Updating restarts only the Pair server and worker; active Python kernels will stop.")
                if prompt("Back up and update this installation? yes / no", "yes", ("yes", "no")) != "yes":
                    raise InstallError("Update cancelled.")
                legacy.update(config, args.archive)
                show(config)
                return
            if path.exists():
                config = json.loads(path.read_text())
                print(f"Detected Pair Notebook {config['version']} at {config['endpoint']}. Owner access and projects will be retained.")
                default = "update" if config["version"] != VERSION else "check"
                if path.name == "installation-pending.json":
                    default = "repair"
                actions = ("check", "repair", "update", "rollback") + (("recover-owner",) if config["mode"] == "full" else ())
                action = args.action or prompt("Action: " + " / ".join(actions), default, actions)
                if action == "recover-owner":
                    if config["mode"] != "full":
                        raise InstallError("Relay-only servers have no persistent project owners.")
                    projects = recovery.projects(config)
                    if not projects:
                        raise InstallError("No saved projects. Create one with Pair Notebook: Create Server Project.")
                    for index, project in enumerate(projects, 1):
                        print(f"{index}. {project['name']} ({project['id']})")
                    selected = int(prompt("Project number")) - 1
                    if not 0 <= selected < len(projects):
                        raise InstallError("Invalid project selection.")
                    print("Recovery replaces only this project's owner credential and restarts Pair server/worker. Previous owner credentials stop working; project data and other participants stay intact.")
                    if prompt("Recover owner access? yes / no", "no", ("yes", "no")) != "yes":
                        raise InstallError("Owner recovery cancelled.")
                    output = recovery.recover(config, projects[selected])
                    print(f"Owner JSON (private): {output}\nCopy this file securely to your computer. In VS Code choose Connect to Server > Import existing owner / member credential.")
                    return
                elif config.get("layout") == "existing":
                    if action == "check":
                        checks.verify(config)
                    elif action == "rollback":
                        legacy.rollback(config)
                    else:
                        legacy.update(config, args.archive)
                elif action == "check":
                    checks.verify(config)
                elif action == "rollback":
                    previous = Path(config.get("previous") or "")
                    if not previous.is_dir() or not previous.is_relative_to(ROOT / "releases"):
                        raise InstallError("No verified previous release is available.")
                    current = (ROOT / "server").resolve()
                    try:
                        switch(previous)
                        services.start(config)
                        checks.verify(config)
                    except BaseException:
                        switch(current)
                        services.start(config)
                        raise
                    config["version"] = json.loads((previous / "BUILD.json").read_text())["version"]
                    config["previous"] = str(current)
                    write(path, json.dumps(config, indent=2) + "\n")
                else:
                    install(config, architecture, args.archive)
                    config = json.loads((STATE / "installation.json").read_text())
            else:
                config = collect(args.mode)
                install(config, architecture, args.archive)
            show(config)
    except (InstallError, OSError, ValueError, URLError) as error:
        parser.exit(1, f"Pair Notebook installation failed: {error}\nProjects and local owner recovery files were not deleted.\n")
