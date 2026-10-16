"""Tests for installation boundaries and trust-preserving configuration."""
import hashlib
import io
from pathlib import Path
import socket
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "installer"))
from pair_installer.network import endpoint, free_port, proxy_config
from pair_installer.system import InstallError, extract, verify, write


class InstallerTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
