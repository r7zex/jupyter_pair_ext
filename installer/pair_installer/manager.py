"""Installed update command; downloads only verified stable GitHub release assets."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

from . import services
from .system import ROOT, STATE, REPOSITORY, InstallError, run, supported_system, write

COMMAND = Path('/usr/local/bin/pair-notebook-server')
WRAPPER = '#!/bin/sh\n# Pair Notebook managed update command\nexec python3 /opt/pair-notebook/manager.pyz --manage "$@"\n'
MAX_SETUP_BYTES = 32 * 1024 * 1024


def version(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', value):
        raise InstallError('Invalid stable release version.')
    return tuple(map(int, value.split('.')))


def allowed_url(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == 'https' and not parts.username and not parts.password and parts.port in (None, 443) and parts.hostname in {
        'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
    }


class ReleaseRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not allowed_url(newurl):
            raise InstallError('Release download redirected outside trusted HTTPS hosts.')
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download(url: str, limit: int) -> bytes:
    if not allowed_url(url):
        raise InstallError('Untrusted release download URL.')
    request = Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Pair-Notebook-Server-Updater'})
    with build_opener(ReleaseRedirects()).open(request, timeout=60) as response:
        content = response.read(limit + 1)
    if len(content) > limit:
        raise InstallError('Release download exceeded its size limit.')
    return content


def latest_release() -> tuple[str, dict]:
    metadata = json.loads(download(f'https://api.github.com/repos/{REPOSITORY}/releases/latest', 2 * 1024 * 1024))
    tag = metadata.get('tag_name', '')
    if metadata.get('draft') or metadata.get('prerelease') or not tag.startswith('v'):
        raise InstallError('No stable release is available.')
    version(tag[1:])
    assets = [asset for asset in metadata.get('assets', []) if asset.get('name') == 'pair-notebook-server-setup.sh']
    if len(assets) != 1:
        raise InstallError('The stable release has no unique server setup asset.')
    asset = assets[0]
    expected_url = f'https://github.com/{REPOSITORY}/releases/download/{tag}/pair-notebook-server-setup.sh'
    if asset.get('browser_download_url') != expected_url or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest', '')):
        raise InstallError('The release asset has no trusted URL and SHA-256 digest.')
    if not isinstance(asset.get('size'), int) or not 0 < asset['size'] <= MAX_SETUP_BYTES:
        raise InstallError('Invalid setup asset size.')
    return tag[1:], asset


def automatic_update_ready(config: dict) -> bool:
    # A saved running project may still own an idle interactive kernel. Do not
    # infer that it is safe to restart merely because no cell is executing.
    if config.get('mode') != 'full':
        return False  # A relay has no persisted participant inventory.
    sessions = Path(config.get('data', '/var/lib/pair-notebook-vps')) / 'sessions'
    if not sessions.exists():
        return True
    for item in sessions.iterdir():
        if item.is_symlink():
            return False
        record = item / 'session.json'
        if not record.is_file():
            return False
        saved = json.loads(record.read_text())
        if saved.get('state') != 'stopped' or any(run.get('execution', {}).get('state') in {'queued', 'running'} for run in saved.get('executions', [])):
            return False
    return True


def update(check_only: bool = False, automatic: bool = False) -> None:
    config = json.loads((STATE / 'installation.json').read_text())
    current = config['version']
    latest, asset = latest_release()
    if version(latest) <= version(current):
        print(f'Pair Notebook {current} is up to date.')
        return
    print(f'Pair Notebook {current} -> {latest}.')
    if check_only:
        print('Run sudo pair-notebook-server update to install; active Pair kernels will restart.')
        return
    if automatic and not automatic_update_ready(config):
        print('Automatic update deferred: stop saved server projects first. Relay-only servers require an explicit update.')
        return
    payload = download(asset['browser_download_url'], MAX_SETUP_BYTES)
    if len(payload) != asset['size'] or hashlib.sha256(payload).hexdigest() != asset['digest'][7:]:
        raise InstallError('Setup download checksum mismatch; no services were changed.')
    with tempfile.TemporaryDirectory(prefix='pair-notebook-update-') as directory:
        setup = Path(directory) / 'pair-notebook-server-setup.sh'
        setup.write_bytes(payload)
        result = subprocess.run(['sh', str(setup), '--action', 'update'], check=False,
                                stdout=subprocess.DEVNULL if automatic else None,
                                stderr=subprocess.DEVNULL if automatic else None)
        if result.returncode:
            raise InstallError('Server update failed. Run the update command interactively for diagnostics; the installer retains project data and rolls back failed health checks.')
    installed = json.loads((STATE / 'installation.json').read_text())['version']
    if installed != latest:
        raise InstallError('Installed server version did not match the downloaded release.')
    print(f'Updated Pair Notebook to {installed}.')


def install(payload: Path | None = None) -> bool:
    source = payload or Path(sys.argv[0])
    if not source.is_file() or not zipfile.is_zipfile(source):
        return False
    validate_command()
    ROOT.mkdir(parents=True, exist_ok=True)
    temporary = ROOT / 'manager.pyz.new'
    shutil.copyfile(source, temporary)
    temporary.chmod(0o700)
    temporary.replace(ROOT / 'manager.pyz')
    write(COMMAND, WRAPPER, 0o755)
    write(services.UNITS / 'pair-notebook-update.service', '[Unit]\nDescription=Update an idle Pair Notebook server\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/pair-notebook-server update --automatic\nUMask=0077\n', 0o644)
    write(services.UNITS / 'pair-notebook-update.timer', '[Unit]\nDescription=Check for Pair Notebook server updates daily\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n', 0o644)
    run('systemctl', 'daemon-reload')
    return True


def validate_command() -> None:
    if COMMAND.is_symlink() or (COMMAND.exists() and COMMAND.read_text() != WRAPPER):
        raise InstallError('An unrelated or modified command occupies /usr/local/bin/pair-notebook-server.')


def remove_command() -> None:
    validate_command()
    COMMAND.unlink(missing_ok=True)


def main() -> None:
    import fcntl
    parser = argparse.ArgumentParser(description='Update Pair Notebook without downloading setup again')
    parser.add_argument('command', choices=['check', 'update', 'auto-update'])
    parser.add_argument('setting', nargs='?', choices=['enable', 'disable', 'status'], default='status')
    parser.add_argument('--automatic', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        supported_system()
        with (STATE / 'updater.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise InstallError('Another server update is running.') from error
            if args.command == 'auto-update':
                if args.setting == 'enable':
                    run('systemctl', 'enable', '--now', 'pair-notebook-update.timer')
                elif args.setting == 'disable':
                    run('systemctl', 'disable', '--now', 'pair-notebook-update.timer')
                else:
                    result = subprocess.run(['systemctl', 'is-enabled', '--quiet', 'pair-notebook-update.timer'], check=False)
                    print('Automatic updates: ' + ('enabled' if result.returncode == 0 else 'disabled'))
                print('Automatic installation requires all saved projects stopped; idle interactive kernels are protected. Use update for an explicit immediate update.')
            else:
                update(check_only=args.command == 'check', automatic=args.automatic)
    except (InstallError, OSError, ValueError, URLError) as error:
        parser.exit(1, f'Pair Notebook updater: {error}\n')
