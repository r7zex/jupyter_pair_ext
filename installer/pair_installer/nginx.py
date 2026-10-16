"""Install one isolated nginx virtual host without rewriting existing sites."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from .system import InstallError, run, write

SITE = Path("/etc/nginx/conf.d/pair-notebook.conf")
MARKER = "# Pair Notebook managed virtual host"


def configure(config: dict, tls: bool = False) -> None:
    host = config["host"]
    https_port = urlsplit(config.get("endpoint", f"https://{host}")).port or 443
    if SITE.exists():
        if not SITE.read_text().startswith(MARKER):
            raise InstallError("The nginx Pair configuration path is already owned by another configuration.")
    elif host in run("nginx", "-T", capture=True):
        raise InstallError("This hostname is already configured in nginx. Choose a new server hostname.")
    previous = SITE.read_text() if SITE.exists() else None
    content = f"""{MARKER}
server {{
    listen 80;
    listen [::]:80;
    server_name {host};
    location ^~ /.well-known/acme-challenge/ {{ root /var/lib/pair-notebook-acme; }}
    location / {{ return 404; }}
}}
"""
    if tls:
        content += f"""server {{
    listen {https_port} ssl;
    listen [::]:{https_port} ssl;
    server_name {host};
    ssl_certificate /etc/letsencrypt-pair/live/{host}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt-pair/live/{host}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 192m;
    location ~ ^/(health|v1/sessions/rpc|v1/temporary-relay)$ {{
        proxy_pass http://127.0.0.1:{config['port']};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }}
    location / {{ return 404; }}
}}
"""
    write(SITE, content, 0o644)
    try:
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
    except InstallError:
        if previous is None:
            SITE.unlink(missing_ok=True)
        else:
            write(SITE, previous, 0o644)
        raise
