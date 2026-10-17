"""Recover lost editor owner credentials with local server-administrator access."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat

from . import checks, legacy
from .system import STATE, InstallError, write


def projects(config: dict) -> list[dict]:
    directory = Path(config.get("data", "/var/lib/pair-notebook-vps")) / "sessions"
    result = []
    for file in sorted(directory.glob("*/session.json")):
        if file.is_symlink() or file.parent.is_symlink():
            raise InstallError("Linked project authority files cannot be recovered automatically.")
        record = json.loads(file.read_text())
        if record.get("id") != file.parent.name or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", file.parent.name):
            raise InstallError("Invalid saved project identity.")
        result.append({"id": record["id"], "name": record["name"], "file": file})
    return result


def recover(config: dict, project: dict) -> Path:
    file = project["file"]
    active = legacy.active_services()
    if "pair-notebook-server" not in active:
        raise InstallError("Start the Pair server before recovering owner access.")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    backup = STATE / "backups" / f"owner-recovery-{stamp}"
    backup.mkdir(parents=True, mode=0o700)
    original = None
    changed = False
    token = secrets.token_urlsafe(48)
    try:
        legacy.stop()
        original, metadata = file.read_text(), file.stat()
        record = json.loads(original)
        owner = next(member for member in record["members"] if member["id"] == record["ownerId"] and member["role"] == "owner" and not member["revoked"])
        shutil.copy2(file, backup / "session.json")
        owner["tokenHash"] = hashlib.sha256(token.encode()).hexdigest()
        changed = True
        write(file, json.dumps(record, indent=2) + "\n", stat.S_IMODE(metadata.st_mode))
        os.chown(file, metadata.st_uid, metadata.st_gid)
        for name in active:
            legacy.run("systemctl", "start", name)
        local = f"http://127.0.0.1:{config['port']}"
        checks.wait_health(local)
        view = checks.rpc(local, "view", {"sessionId": record["id"]}, token)
        if view.get("ownerId") != record["ownerId"] or view.get("memberId") != record["ownerId"]:
            raise InstallError("Recovered owner identity could not be verified.")
        output = STATE / "recovered-owners" / f"{record['id']}-{stamp}.json"
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        write(output, json.dumps({"endpoint": config["endpoint"], "sessionId": record["id"],
                                 "memberId": record["ownerId"], "token": token, "name": record["name"]}, indent=2) + "\n")
    except BaseException:
        legacy.stop()
        if changed and original is not None:
            write(file, original, stat.S_IMODE(metadata.st_mode))
            os.chown(file, metadata.st_uid, metadata.st_gid)
        for name in active:
            legacy.run("systemctl", "start", name)
        raise
    return output
