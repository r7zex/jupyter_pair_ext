"""Tests for installation boundaries and trust-preserving configuration."""
import hashlib
import io
from pathlib import Path
import socket
import json
import shlex
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "installer"))
from pair_installer.network import endpoint, free_port, proxy_config
from pair_installer.system import VERSION, InstallError, extract, release, upgrade_version, verify, write
from pair_installer import legacy, recovery, system


class InstallerTests(unittest.TestCase):
    def test_older_utility_rejects_newer_server_before_installation(self):
        upgrade_version("0.6.7")
        upgrade_version(VERSION)
        with self.assertRaisesRegex(InstallError, "older than"):
            upgrade_version("99.0.0")

    def test_embedded_release_is_verified_without_another_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "package/payload"
            payload.mkdir(parents=True)
            archive = payload / "pair-notebook-server-persistent.tar.gz"
            code = b"verified server"
            manifest = json.dumps({"version": VERSION, "files": {"server.js": hashlib.sha256(code).hexdigest()}}).encode()
            with tarfile.open(archive, "w:gz") as bundle:
                for name, content in (("server/server.js", code), ("server/BUILD.json", manifest)):
                    entry = tarfile.TarInfo(name)
                    entry.size = len(content)
                    bundle.addfile(entry, io.BytesIO(content))
            checksum = Path(str(archive) + ".sha256")
            write(checksum, hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
            destination = root / "good"
            destination.mkdir()
            with patch.object(system.resources, "files", return_value=payload.parent), patch.object(system, "fetch") as fetch:
                result = release(destination)
                self.assertEqual((result / "server.js").read_bytes(), code)
                fetch.assert_not_called()
                archive.write_bytes(b"damaged embedded archive")
                broken = root / "broken"
                broken.mkdir()
                with self.assertRaisesRegex(InstallError, "Checksum mismatch"):
                    release(broken)
    def test_public_ip_requires_global_address(self):
        for host in ["192.168.1.8", "100.64.1.1", "127.0.0.1", "169.254.1.1", "[::1]"]:
            with self.subTest(host=host), self.assertRaises(InstallError):
                endpoint(host, "ip")
        self.assertEqual(endpoint("8.8.8.8", "ip"), ("https://8.8.8.8", "8.8.8.8"))

    def test_lan_accepts_private_address_and_enforces_tls(self):
        self.assertEqual(endpoint("192.168.1.8", "lan")[0], "https://192.168.1.8")
        for value in ["http://192.168.1.8", "https://user:secret@example.com", "https://example.com/path", "https://example.com/#token"]:
            with self.subTest(value=value), self.assertRaises(InstallError):
                endpoint(value, "lan")

    def test_ipv6_and_alternate_https_ports_preserve_other_listeners(self):
        self.assertEqual(endpoint("2606:4700:4700::1111", "ip"), ("https://[2606:4700:4700::1111]", "2606:4700:4700::1111"))
        self.assertEqual(endpoint("8.8.8.8:8443", "ip")[0], "https://8.8.8.8:8443")
        value = proxy_config("192.168.1.8", "lan", 8787, https_port=8443)
        self.assertIn("https://192.168.1.8:8443", value)
        self.assertNotIn(":80 {", value)

    def test_proxy_includes_real_websocket_and_rpc_routes(self):
        value = proxy_config("192.168.1.8", "lan", 8787)
        self.assertIn("tls internal", value)
        self.assertIn("/v1/temporary-relay", value)
        self.assertIn("/v1/sessions/rpc", value)
        self.assertNotIn("insecure", value)
        self.assertIn("admin off", value)

    def test_occupied_port_fails_without_stopping_owner(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with self.assertRaisesRegex(InstallError, "occupied"):
                free_port(listener.getsockname()[1], "127.0.0.1")
            self.assertNotEqual(listener.fileno(), -1)

    def test_archive_rejects_traversal_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, kind in [("../escape", tarfile.REGTYPE), ("server/link", tarfile.SYMTYPE)]:
                archive = root / "bad.tar.gz"
                with tarfile.open(archive, "w:gz") as bundle:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
                    member.size = 0
                    bundle.addfile(member, io.BytesIO())
                with self.assertRaises(InstallError):
                    extract(archive, root / "destination")
            self.assertFalse((root / "escape").exists())

    def test_checksum_and_atomic_private_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, sums = root / "server.tar.gz", root / "checksums"
            write(archive, "verified")
            write(sums, hashlib.sha256(archive.read_bytes()).hexdigest() + "  server.tar.gz\n")
            verify(archive, sums)
            write(archive, "tampered")
            with self.assertRaises(InstallError):
                verify(archive, sums)


class ExistingInstallationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.root, self.config, self.state = (base / name for name in ("opt", "etc", "state"))
        self.data, self.worker = (base / name for name in ("data", "worker"))
        for directory in (self.root / "server", self.config, self.state, self.data, self.worker):
            directory.mkdir(parents=True)
        self.server = self.root / "server"
        write(self.server / "BUILD.json", json.dumps({"version": "0.6.6"}))
        self.node = self.root / "node/bin/node"
        write(self.node, "existing Node")
        self.token = "fixture_" + "x" * 40
        self.environment = (f"PAIR_VPS_BIND=127.0.0.1\nPAIR_VPS_PORT=8788\n"
                            f"PAIR_VPS_DATA={shlex.quote(str(self.data))}\nPAIR_VPS_CLIENT_TOKEN={self.token}\n")
        write(self.config / "server.env", self.environment)
        self.units = {
            "pair-notebook-server": "ExecStart=" + shlex.join([str(self.node), str(self.server / "out/src/vps/cli.js")])
                + "\nEnvironmentFile=" + shlex.quote(str(self.config / "server.env")),
            "pair-notebook-worker": "WorkingDirectory=" + str(self.worker) + "\nExecStart=" + shlex.join([
                "/usr/bin/python3", str(self.server / "scripts/pair-notebook-session-agent.py"),
                "--url", "http://127.0.0.1:8788", "--bridge", str(self.server / "media/jupyter_kernel_bridge.py"),
            ]),
            "pair-notebook-proxy": "ExecStart=/existing/caddy run --config /existing/Caddyfile",
        }
        self.calls = []

        def run(*arguments, **kwargs):
            self.calls.append(arguments)
            if arguments[:2] == ("systemctl", "cat"):
                return self.units[arguments[2]]
            return ""

        for name, value in (("ROOT", self.root), ("CONFIG", self.config), ("STATE", self.state), ("run", run)):
            replacement = patch.object(legacy, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_existing_installation_discovers_custom_port_and_runtime(self):
        config = legacy.discover()
        self.assertEqual(config["port"], 8788)
        self.assertEqual(config["node"], str(self.node))
        self.assertEqual(config["data"], str(self.data))
        self.assertNotIn(self.token, json.dumps(config))
        self.assertEqual((self.config / "server.env").read_text(), self.environment)
        self.assertTrue(all(call[:2] == ("systemctl", "cat") for call in self.calls))

    def test_existing_persistent_release_before_066_can_be_detected(self):
        write(self.server / "BUILD.json", json.dumps({"version": "0.6.3"}))
        self.assertEqual(legacy.discover()["version"], "0.6.3")

    def test_existing_proxy_supplies_https_origin_with_custom_port(self):
        write(self.config / "Caddyfile", "https://example.com:9443 {\n reverse_proxy 127.0.0.1:8788\n}\n")
        self.assertEqual(legacy.default_endpoint(), "https://example.com:9443")
        write(self.config / "Caddyfile", "https://one.example {\n}\nhttps://two.example {\n}\n")
        self.assertEqual(legacy.default_endpoint(), "")

    def test_adoption_reuses_existing_admin_token_without_changing_server(self):
        config = {**legacy.discover(), "endpoint": "https://example.com:9443"}
        legacy.owner_credential(config)
        credential = json.loads((self.state / "owner-server.json").read_text())
        self.assertEqual(credential, {"endpoint": config["endpoint"], "adminToken": self.token})
        self.assertEqual((self.config / "server.env").read_text(), self.environment)
        legacy.owner_credential(config)

    def test_different_owner_recovery_credential_is_not_overwritten(self):
        write(self.state / "owner-server.json", '{"adminToken":"other"}')
        with self.assertRaisesRegex(InstallError, "differs"):
            legacy.owner_credential({"endpoint": "https://example.com"})
        self.assertEqual((self.state / "owner-server.json").read_text(), '{"adminToken":"other"}')

    def test_adoption_rejects_different_worker_port_before_stopping_services(self):
        self.units["pair-notebook-worker"] = self.units["pair-notebook-worker"].replace("8788", "9999")
        with self.assertRaisesRegex(InstallError, "unsupported"):
            legacy.discover()
        self.assertFalse(any(call[:2] == ("systemctl", "stop") for call in self.calls))

    def test_adoption_rejects_recursive_backup_paths(self):
        write(self.config / "server.env", self.environment.replace(shlex.quote(str(self.data)), shlex.quote(str(self.root.parent))))
        with self.assertRaisesRegex(InstallError, "overlaps"):
            legacy.discover()

    def test_bad_release_never_stops_existing_services(self):
        config = {**legacy.discover(), "endpoint": "https://example.com"}
        with patch.object(legacy.checks, "wait_health", side_effect=InstallError("Old server is unavailable")), \
                patch.object(legacy, "release", side_effect=InstallError("Checksum mismatch")):
            with self.assertRaisesRegex(InstallError, "Checksum mismatch"):
                legacy.update(config, None)
        self.assertFalse(any(call[:2] == ("systemctl", "stop") for call in self.calls))
        self.assertTrue(self.server.is_dir())

    def test_failed_backup_preserves_original_directory_and_service_state(self):
        config = {**legacy.discover(), "endpoint": "https://example.com"}
        package = self.root.parent / "package"
        package.mkdir()
        write(package / "BUILD.json", '{"version":"0.6.7"}')
        original_copy = legacy.shutil.copytree

        def copy(source, destination, **kwargs):
            if str(source) == str(self.data):
                raise OSError("Disk full")
            return original_copy(source, destination, **kwargs)

        with patch.object(legacy.checks, "wait_health"), patch.object(legacy, "release", return_value=package), \
                patch.object(legacy, "active_services", return_value=["pair-notebook-server"]), \
                patch.object(legacy.shutil, "copytree", side_effect=copy), patch.object(legacy, "switch") as switch:
            with self.assertRaisesRegex(OSError, "Disk full"):
                legacy.update(config, None)
        switch.assert_not_called()
        self.assertEqual(json.loads((self.server / "BUILD.json").read_text())["version"], "0.6.6")
        self.assertIn(("systemctl", "start", "pair-notebook-server"), self.calls)
        self.assertNotIn(("systemctl", "start", "pair-notebook-worker"), self.calls)


class OwnerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.data, self.state = self.base / "data", self.base / "private"
        self.file = self.data / "sessions/project-id/session.json"
        self.record = {"id": "project-id", "name": "Preserved project", "ownerId": "owner-id", "members": [
            {"id": "owner-id", "role": "owner", "revoked": False, "tokenHash": "a" * 64},
            {"id": "guest-id", "role": "member", "revoked": False, "tokenHash": "b" * 64},
        ]}
        write(self.file, json.dumps(self.record))
        self.original = self.file.read_text()
        self.config = {"data": str(self.data), "port": 8788, "endpoint": "https://example.com:9443"}
        for target, value in (("STATE", self.state),):
            context = patch.object(recovery, target, value)
            context.start()
            self.addCleanup(context.stop)

    def test_lost_owner_key_can_be_recovered_without_changing_project_or_members(self):
        project = recovery.projects(self.config)[0]
        with patch.object(legacy, "active_services", return_value=list(legacy.PAIR_SERVICES)), \
                patch.object(legacy, "stop"), patch.object(legacy, "run"), \
                patch.object(recovery.os, "chown", create=True), patch.object(recovery.checks, "wait_health"), \
                patch.object(recovery.checks, "rpc", return_value={"ownerId": "owner-id", "memberId": "owner-id"}):
            output = recovery.recover(self.config, project)
        credential = json.loads(output.read_text())
        updated = json.loads(self.file.read_text())
        self.assertEqual(credential["memberId"], self.record["ownerId"])
        self.assertEqual(updated["members"][0]["tokenHash"], hashlib.sha256(credential["token"].encode()).hexdigest())
        self.assertEqual(updated["members"][1], self.record["members"][1])
        self.assertEqual(updated["id"], self.record["id"])
        backups = list((self.state / "backups").glob("*/session.json"))
        self.assertEqual(backups[0].read_text(), self.original)

    def test_failed_owner_recovery_restores_original_authority(self):
        project = recovery.projects(self.config)[0]
        with patch.object(legacy, "active_services", return_value=list(legacy.PAIR_SERVICES)), \
                patch.object(legacy, "stop"), patch.object(legacy, "run"), \
                patch.object(recovery.os, "chown", create=True), patch.object(recovery.checks, "wait_health"), \
                patch.object(recovery.checks, "rpc", side_effect=InstallError("Verification failed")):
            with self.assertRaisesRegex(InstallError, "Verification failed"):
                recovery.recover(self.config, project)
        self.assertEqual(self.file.read_text(), self.original)
        self.assertFalse((self.state / "recovered-owners").exists())


if __name__ == "__main__":
    unittest.main()
