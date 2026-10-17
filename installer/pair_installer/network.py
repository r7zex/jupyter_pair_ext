"""Endpoint validation and managed proxy configuration."""
from __future__ import annotations

import ipaddress
from pathlib import Path
import re
import socket
from urllib.parse import urlsplit

from .system import CONFIG, ROOT, InstallError, run, write


def endpoint(value: str, mode: str) -> tuple[str, str]:
    if "://" not in value:
        try:
            if ipaddress.ip_address(value).version == 6:
                value = f"[{value}]"
        except ValueError:
            pass
    parsed = urlsplit(value if "://" in value else f"https://{value}")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise InstallError("Use an HTTPS origin without a path, password or query.")
    host = parsed.hostname
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", host):
            raise InstallError("Invalid DNS hostname.")
        address = None
    if mode == "ip" and (address is None or not address.is_global):
        raise InstallError("Public-IP mode requires a globally routable IPv4 or IPv6 address; CGNAT/private addresses need LAN mode.")
    if mode == "domain" and address is not None:
        raise InstallError("Choose public-IP mode for an IP address.")
    if mode == "proxy" and address is not None and not address.is_global:
        raise InstallError("Existing-proxy public TLS requires a global IP or domain. Choose managed LAN mode for private addresses.")
    if parsed.port in {0, 80}:
        raise InstallError("Choose an HTTPS port between 1 and 65535, other than the HTTP challenge port 80.")
    return parsed.geturl().rstrip("/"), host


def free_port(port: int, host: str = "0.0.0.0") -> None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind((host, port))
        if host == "0.0.0.0" and socket.has_ipv6:
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as listener:
                listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                listener.bind(("::", port))
    except OSError as error:
        raise InstallError(f"Port {port} is occupied. Select an existing proxy or a different server; no service was stopped.") from error


def addresses(host: str) -> set[str]:
    try:
        return {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except socket.gaierror as error:
        raise InstallError("DNS resolution failed. Correct the domain's A/AAAA records before installing.") from error


def proxy_config(host: str, mode: str, port: int, certificate: str = "", https_port: int = 443) -> str:
    target = f"127.0.0.1:{port}"
    site = f"https://{host}" if ":" not in host else f"https://[{host}]"
    site += f":{https_port}"
    tls = "tls internal" if mode == "lan" else f"tls {certificate}/fullchain.pem {certificate}/privkey.pem"
    content = f"""{{
    admin off
    auto_https disable_redirects
    default_sni {host}
}}
{site} {{
    {tls}
    @pair path /health /v1/sessions/rpc /v1/temporary-relay
    route {{
        reverse_proxy @pair {target}
        respond 404
    }}
}}
"""
    if mode != "lan":
        content += """:80 {
    handle /.well-known/acme-challenge/* {
        root * /var/lib/pair-notebook-acme
        file_server
    }
    handle {
        respond 404
    }
}
"""
    return content


def configure_proxy(config: dict, initial: bool = False) -> None:
    mode, host = config["network"], config["host"]
    if mode == "proxy":
        return
    if initial and mode in {"domain", "ip"}:
        content = ":80 {\n root * /var/lib/pair-notebook-acme\n file_server\n}\n"
    else:
        content = proxy_config(host, mode, config["port"], f"/etc/letsencrypt-pair/live/{host}", config.get("httpsPort", 443))
    write(CONFIG / "Caddyfile", content, 0o644)
    run(str(ROOT / "runtime/caddy"), "validate", "--config", str(CONFIG / "Caddyfile"), "--adapter", "caddyfile")


def certificate(config: dict) -> None:
    """Certbot >=5.4 supports IP identifiers and the shortlived ACME profile."""
    if not managed_certificate(config):
        return
    executable = ROOT / "certbot/bin/certbot"
    Path("/var/lib/pair-notebook-acme").mkdir(parents=True, exist_ok=True, mode=0o755)
    if not executable.exists():
        run("python3", "-m", "venv", str(ROOT / "certbot"))
        run(str(ROOT / "certbot/bin/pip"), "install", "certbot>=5.4,<6")
    args = [str(executable), "certonly", "--non-interactive", "--agree-tos", "--register-unsafely-without-email",
            "--config-dir", "/etc/letsencrypt-pair", "--work-dir", "/var/lib/pair-notebook-acme-work",
            "--logs-dir", "/var/log/pair-notebook-acme", "--webroot", "-w", "/var/lib/pair-notebook-acme"]
    if config.get("certificateMode", config["network"]) == "ip":
        args += ["--preferred-profile", "shortlived", "--ip-address", config["host"]]
    else:
        args += ["-d", config["host"]]
    run(*args)
    run("chgrp", "-R", "pair-proxy", "/etc/letsencrypt-pair")
    run("chmod", "-R", "g+rX,o-rwx", "/etc/letsencrypt-pair")


def managed_certificate(config: dict) -> bool:
    return config["network"] in {"domain", "ip"} or config.get("proxy") == "nginx"


def existing_proxy(config: dict, kind: str) -> None:
    """Add an isolated virtual host; never replace an existing site's configuration."""
    host, port = config["host"], config["port"]
    if kind == "caddy":
        main = Path("/etc/caddy/Caddyfile")
        content = main.read_text()
        marker = "# Pair Notebook managed include"
        if marker not in content:
            # Refuse ambiguous host collisions; do not silently shadow another service.
            if host in content:
                raise InstallError("This hostname already appears in the existing Caddyfile. Use a separate hostname or address.")
            backup = main.with_name("Caddyfile.before-pair")
            if not backup.exists():
                write(backup, content, 0o600)
            write(main, content + f"\n{marker}\nimport /etc/pair-notebook/proxy-site.caddy\n", 0o644)
        snippet = f"{config['endpoint']} {{\n @pair path /health /v1/sessions/rpc /v1/temporary-relay\n route {{\n reverse_proxy @pair 127.0.0.1:{port}\n respond 404\n }}\n}}\n"
        write(CONFIG / "proxy-site.caddy", snippet, 0o644)
        try:
            run("caddy", "validate", "--config", str(main))
            run("systemctl", "reload", "caddy")
        except InstallError:
            if (main.with_name("Caddyfile.before-pair")).exists():
                write(main, main.with_name("Caddyfile.before-pair").read_text(), 0o644)
            raise
    else:
        from .nginx import configure
        configure(config, tls=True)
