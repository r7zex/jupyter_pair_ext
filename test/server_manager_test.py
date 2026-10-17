"""Behavior of the installed server updater, without changing local services."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'installer'))
from pair_installer import manager
from pair_installer.system import InstallError


class ServerManagerTests(unittest.TestCase):
    def metadata(self, content=b'#!/bin/sh\nexit 0\n'):
        return {'tag_name': 'v0.6.10', 'draft': False, 'prerelease': False, 'assets': [{
            'name': 'pair-notebook-server-setup.sh', 'size': len(content),
            'browser_download_url': 'https://github.com/r7zex/jupyter_pair_ext/releases/download/v0.6.10/pair-notebook-server-setup.sh',
            'digest': 'sha256:' + hashlib.sha256(content).hexdigest()}]}

    def test_release_identity_and_digest_are_required(self):
        for mutation in ['prerelease', 'url', 'digest', 'size', 'version']:
            metadata = self.metadata()
            if mutation == 'prerelease': metadata['prerelease'] = True
            if mutation == 'url': metadata['assets'][0]['browser_download_url'] = 'https://example.com/setup.sh'
            if mutation == 'digest': metadata['assets'][0]['digest'] = ''
            if mutation == 'size': metadata['assets'][0]['size'] = manager.MAX_SETUP_BYTES + 1
            if mutation == 'version': metadata['tag_name'] = 'v0.6.10-beta'
            with self.subTest(mutation=mutation), patch.object(manager, 'download', return_value=json.dumps(metadata).encode()):
                with self.assertRaises(InstallError): manager.latest_release()

    def test_redirects_cannot_downgrade_tls_or_leave_release_hosts(self):
        self.assertTrue(manager.allowed_url('https://release-assets.githubusercontent.com/download'))
        for url in ['http://github.com/file', 'https://github.com.evil.example/file', 'https://user:secret@github.com/file', 'https://github.com:444/file']:
            self.assertFalse(manager.allowed_url(url))

    def test_corrupt_download_never_runs_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory); (state / 'installation.json').write_text(json.dumps({'version': '0.6.9'}))
            with patch.object(manager, 'STATE', state), patch.object(manager, 'latest_release', return_value=('0.6.10', self.metadata()['assets'][0])), patch.object(manager, 'download', return_value=b'damaged'), patch.object(manager.subprocess, 'run') as run:
                with self.assertRaisesRegex(InstallError, 'checksum'): manager.update()
                run.assert_not_called()

    def test_verified_update_executes_once_and_checks_installed_version(self):
        content = b'#!/bin/sh\nexit 0\n'
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory); config = state / 'installation.json'
            config.write_text(json.dumps({'version': '0.6.9'}))
            def installed(args, **kwargs):
                self.assertEqual(Path(args[1]).read_bytes(), content)
                self.assertEqual(args[2:], ['--action', 'update'])
                config.write_text(json.dumps({'version': '0.6.10'}))
                return Mock(returncode=0)
            with patch.object(manager, 'STATE', state), patch.object(manager, 'latest_release', return_value=('0.6.10', self.metadata(content)['assets'][0])), patch.object(manager, 'download', return_value=content), patch.object(manager.subprocess, 'run', side_effect=installed) as run:
                manager.update(); self.assertEqual(run.call_count, 1)

    def test_auto_update_defers_running_projects_queued_work_and_relays(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory); session = data / 'sessions' / 'project'; session.mkdir(parents=True)
            config = {'mode': 'full', 'data': str(data)}
            for state, work, allowed in [('running', [], False), ('stopped', [{'execution': {'state': 'queued'}}], False), ('stopped', [], True)]:
                (session / 'session.json').write_text(json.dumps({'state': state, 'executions': work}))
                self.assertEqual(manager.automatic_update_ready(config), allowed)
            self.assertFalse(manager.automatic_update_ready({'mode': 'relay'}))

    def test_install_retains_private_zipapp_and_writes_disabled_timer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'setup.pyz'
            with zipfile.ZipFile(source, 'w') as archive: archive.writestr('__main__.py', 'print(42)')
            with patch.object(manager, 'ROOT', root / 'install'), patch.object(manager, 'COMMAND', root / 'bin/manager'), patch.object(manager.services, 'UNITS', root / 'units'), patch.object(manager, 'run') as run:
                self.assertTrue(manager.install(source))
                self.assertEqual((root / 'install/manager.pyz').read_bytes(), source.read_bytes())
                self.assertEqual((root / 'bin/manager').read_text(), manager.WRAPPER)
                self.assertIn('OnCalendar=daily', (root / 'units/pair-notebook-update.timer').read_text())
                run.assert_called_once_with('systemctl', 'daemon-reload')
                manager.remove_command(); self.assertFalse((root / 'bin/manager').exists())


if __name__ == '__main__': unittest.main()
