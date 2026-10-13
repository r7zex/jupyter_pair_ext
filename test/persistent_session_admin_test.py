"""Check credential file boundaries and the direct-VPS owner handoff without exposing secrets."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("session_admin", Path(__file__).resolve().parents[1] / "scripts/pair-notebook-session-admin.py")
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class OwnerHandoffTests(unittest.TestCase):
    def test_public_connection_requires_verified_https_and_no_embedded_credential(self):
        for value in ("http://144.172.69.57", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com/v1", "file:///tmp/secret"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                admin.endpoint(value)
        self.assertEqual(admin.endpoint("https://144.172.69.57/"), "https://144.172.69.57")
        self.assertEqual(admin.endpoint("http://127.0.0.1:8787"), "http://127.0.0.1:8787")

    def test_tokens_reject_world_readability_links_and_nonregular_files(self):
        with tempfile.TemporaryDirectory() as root:
            token = Path(root) / "admin.token"
            token.write_text("s" * 64)
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                admin.private_read(token)
            token.chmod(0o600)
            self.assertEqual(admin.private_read(token), "s" * 64)
            linked = Path(root) / "linked.token"
            os.link(token, linked)
            with self.assertRaises(ValueError):
                admin.private_read(token)
            linked.unlink()
            linked.symlink_to(token)
            with self.assertRaises(OSError):
                admin.private_read(linked)

    def test_creation_saves_owner_secret_privately_and_prints_no_password_or_token(self):
        with tempfile.TemporaryDirectory() as root:
            token = Path(root) / "admin.token"
            token.write_text("s" * 64)
            token.chmod(0o600)
            destination = Path(root) / "owner.json"
            membership = {"sessionId": "a-session", "memberId": "owner-member", "token": "o" * 64, "name": "Research"}
            output = io.StringIO()
            arguments = ["session-admin", "create", "--token-file", str(token), "--public-url", "https://144.172.69.57", "--name", "Research", "--output", str(destination)]
            with patch("sys.argv", arguments), patch.object(admin.getpass, "getpass", return_value="private-password"), patch.object(admin, "rpc", return_value=membership), contextlib.redirect_stdout(output):
                admin.main()
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            config = json.loads(destination.read_text())
            self.assertEqual(config["endpoint"], "https://144.172.69.57")
            self.assertEqual(config["token"], "o" * 64)
            self.assertNotIn("private-password", output.getvalue())
            self.assertNotIn("o" * 64, output.getvalue())
            self.assertNotIn("s" * 64, output.getvalue())


if __name__ == "__main__":
    unittest.main()
