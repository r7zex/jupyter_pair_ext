"""Source export must finish and verify before installation data can be removed."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "installer"))
from pair_installer import removal, removal_volumes
from pair_installer.system import InstallError


class ServerRemovalTests(unittest.TestCase):
    def fixture(self, root):
        session = root / "sessions/12345678-1234-1234-1234-123456789abc"
        blobs = session / "workspace/blobs"
        blobs.mkdir(parents=True)
        (session / "session.json").write_text(json.dumps({"name": "My project"}))
        entries = []
        for name, content in [("main.py", b"print(42)"), ("Private/research.ipynb", b'{"cells":[]}'), ("events.json", b'{}')]:
            digest = hashlib.sha256(content).hexdigest()
            (blobs / digest).write_bytes(content)
            entries.append({"path": name, "type": "file", "blob": digest})
        manifest = session / "workspace/manifest.json"
        manifest.write_text(json.dumps({"entries": entries}))
        return session, manifest

    def test_exports_only_python_and_notebooks_with_paths_and_exact_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root / "data")
            destination = root / "saved"
            self.assertEqual(removal.preserve_sources(root / "data", destination), 2)
            names = {str(file.relative_to(destination)).replace("\\", "/") for file in destination.rglob("*") if file.is_file()}
            self.assertEqual(names, {"My_project-12345678-1234-1234-1234-123456789abc/main.py", "My_project-12345678-1234-1234-1234-123456789abc/Private/research.ipynb"})
            self.assertEqual(next(destination.rglob("main.py")).read_bytes(), b"print(42)")
            self.assertEqual(next(destination.rglob("*.ipynb")).read_bytes(), b'{"cells":[]}')

    def test_corrupt_source_aborts_before_any_export_or_service_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session, manifest = self.fixture(root / "data")
            blob = json.loads(manifest.read_text())["entries"][0]["blob"]
            (session / "workspace/blobs" / blob).write_bytes(b"corrupted")
            with self.assertRaisesRegex(InstallError, "checksum"):
                removal.preserve_sources(root / "data", root / "saved")
            self.assertFalse((root / "saved").exists())
            self.assertTrue(session.exists())

    def test_rejects_path_traversal_and_existing_export_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, manifest = self.fixture(root / "data")
            value = json.loads(manifest.read_text())
            value["entries"][0]["path"] = "../outside.py"
            manifest.write_text(json.dumps(value))
            with self.assertRaisesRegex(InstallError, "Invalid"):
                removal.preserve_sources(root / "data", root / "saved")
            with self.assertRaises(InstallError):
                removal.safe_root(root, (Path("/opt/pair-notebook"),))

    def test_caddy_validation_failure_restores_original_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "Caddyfile"
            content = "example.com { respond ok }\n# Pair Notebook managed include\nimport /etc/pair-notebook/proxy-site.caddy\n"
            file.write_text(content)
            with patch.object(removal, "Path", return_value=file), patch.object(removal, "run", side_effect=InstallError("validation")):
                with self.assertRaises(InstallError):
                    removal.remove_proxy({"network": "proxy"})
            self.assertEqual(file.read_text(), content)

    def test_detaches_only_verified_pair_loop_volumes_and_retains_other_mounts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            volumes = root / 'volumes'
            volumes.mkdir()
            images = [volumes / 'server.ext4', volumes / 'worker.ext4']
            roots = (root / 'server', root / 'worker')
            for image in images:
                image.write_bytes(b'fixture volume')
            fstab = root / 'fstab'
            other = '# existing mounts\nUUID=unrelated /srv ext4 defaults 0 0\n'
            original = other + ''.join(f'{image} {target} ext4 loop,nodev,nosuid,noexec 0 0\n' for image, target in zip(images, roots))
            fstab.write_text(original)
            commands = []
            def run(*args, **kwargs):
                commands.append(args)
                if args[0] == 'findmnt':
                    return '/dev/loop9' if args[4] == str(roots[0]) else '/dev/loop10'
                if args[0] == 'losetup':
                    return str(images[0] if args[-1] == '/dev/loop9' else images[1])
                return ''
            with patch.object(removal_volumes.os.path, 'ismount', side_effect=lambda p: p in roots), patch.object(removal_volumes, 'run', side_effect=run):
                plan = removal_volumes.plan(roots, fstab, volumes)
                removal_volumes.detach(plan)
            self.assertEqual(fstab.read_text(), other)
            self.assertEqual([command for command in commands if command[0] == 'umount'], [('umount', str(roots[1])), ('umount', str(roots[0]))])
            with patch.object(removal_volumes.os.path, 'ismount', return_value=False), patch.object(removal_volumes, 'run') as mount:
                removal_volumes.restore(plan)
                self.assertEqual(fstab.read_text(), original)
                self.assertEqual(mount.call_count, 2)
            removal_volumes.remove_images(plan)
            self.assertFalse(volumes.exists())

    def test_rejects_unknown_mounted_storage_before_detaching_or_deleting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            fstab = root / 'fstab'
            fstab.write_text('/dev/unrelated /srv ext4 defaults 0 0\n')
            with patch.object(removal_volumes.os.path, 'ismount', return_value=True), patch.object(removal_volumes, 'run') as run:
                with self.assertRaisesRegex(InstallError, 'Unrecognized mounted'):
                    removal_volumes.plan((root / 'server', root / 'worker'), fstab, root / 'volumes')
                run.assert_not_called()

    def test_accepts_both_owned_sandbox_profiles_and_rejects_unrelated_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary) / 'pair-notebook-bwrap'
            for location in ('runtime/bin/bwrap', 'sandbox/bwrap'):
                profile.write_text(str(removal.ROOT / location))
                removal.validate_profile(profile)
            profile.write_text('/usr/bin/unrelated')
            with self.assertRaisesRegex(InstallError, 'no installation files were removed'):
                removal.validate_profile(profile)


if __name__ == "__main__":
    unittest.main()
