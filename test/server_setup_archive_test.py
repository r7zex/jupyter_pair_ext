"""Verify the actual three-file public download layout and embedded payloads."""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']


def installer_payload(content: bytes) -> bytes:
    header, encoded = content.split(b'\n__PAIR_NOTEBOOK_PAYLOAD__\n', 1)
    payload = base64.b64decode(b''.join(encoded.splitlines()), validate=True)
    expected = re.search(rb"'([a-f0-9]{64})' >", header).group(1).decode()
    assert hashlib.sha256(payload).hexdigest() == expected
    assert f'PAIR_VERSION={VERSION}'.encode() in header
    return payload


class SetupArchiveTests(unittest.TestCase):
    def test_single_setup_contains_matching_verified_server_and_no_extra_download(self):
        payload = installer_payload((ARTIFACTS / 'pair-notebook-server-setup.sh').read_bytes())
        with zipfile.ZipFile(io.BytesIO(payload)) as installer:
            names = installer.namelist()
            self.assertFalse(any('__pycache__' in name or name.endswith('.pyc') for name in names))
            filename = 'pair_installer/payload/pair-notebook-server-persistent.tar.gz'
            server = installer.read(filename)
            expected = installer.read(filename + '.sha256').decode().split()[0]
            self.assertEqual(hashlib.sha256(server).hexdigest(), expected)
            with tarfile.open(fileobj=io.BytesIO(server)) as archive:
                manifest = json.load(archive.extractfile('server/BUILD.json'))
                self.assertEqual(manifest['version'], VERSION)
                for name, digest in manifest['files'].items():
                    self.assertEqual(hashlib.sha256(archive.extractfile('server/' + name).read()).hexdigest(), digest)

    def test_ws_server_zip_has_clear_launcher_bundled_relay_and_matching_manifest(self):
        with zipfile.ZipFile(ARTIFACTS / 'pair-notebook-ws-server.zip') as archive:
            self.assertEqual(set(archive.namelist()), {'pair-notebook-ws-server.sh', 'relay.js', 'check.js', 'README.md', 'LICENSE', 'BUILD.json'})
            manifest = json.loads(archive.read('BUILD.json'))
            self.assertEqual(manifest['version'], VERSION)
            for name, digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest)
            self.assertIn(b'PAIR_DEFAULT_MODE=relay', archive.read('pair-notebook-ws-server.sh'))
            self.assertEqual(installer_payload(archive.read('pair-notebook-ws-server.sh')),
                             installer_payload((ARTIFACTS / 'pair-notebook-server-setup.sh').read_bytes()))


if __name__ == '__main__':
    unittest.main()
