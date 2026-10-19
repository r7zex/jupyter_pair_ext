"""Package parser and transactional offline installer tests."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("isolated_packages", Path(__file__).resolve().parents[1] / "scripts/isolated_packages.py")
PACKAGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGES)


class PackageRequestTests(unittest.TestCase):
    def test_only_package_names_and_exact_versions_are_accepted(self):
        self.assertEqual(PACKAGES.installation_requirements("%pip install numpy==2.2.6 pandas"), ["numpy==2.2.6", "pandas"])
        self.assertIsNone(PACKAGES.installation_requirements("print('hello')"))
        self.assertIsNone(PACKAGES.installation_requirements("%pip list"))
        for code in ("%pip install --index-url http://host numpy", "%pip install /tmp/pkg.whl", "%pip install numpy;whoami",
                     "%pip install git+https://host/project", "%pip install numpy\nprint(1)"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                PACKAGES.installation_requirements(code)


class SessionEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pair-session-packages-")
        self.state = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def legacy_environment(self, session, scope, kernel, content):
        root = self.state / "packages" / hashlib.sha256(json.dumps((session, kernel, scope)).encode()).hexdigest()
        site = root / "site-original"
        site.mkdir(parents=True)
        (site / "example.py").write_text(content)
        (root / "current").symlink_to(site.name, target_is_directory=True)
        return root

    def test_one_environment_serves_one_hundred_notebooks_and_generations(self):
        roots = {PACKAGES.session_environment(self.state, "session", "public", f"session:public:{index}:book-{index}")
                 for index in range(100)}
        self.assertEqual(len(roots), 1)
        root = roots.pop()
        site = root / "site-installed"
        site.mkdir()
        (site / "example.py").write_text("value = 42")
        (root / "current").symlink_to(site.name, target_is_directory=True)
        reopened = PACKAGES.session_environment(self.state, "session", "public", "session:public:101:recreated-book")
        self.assertEqual((reopened / "current/example.py").read_text(), "value = 42")

    def test_sessions_and_access_scopes_have_separate_environments(self):
        roots = {PACKAGES.session_environment(self.state, session, scope, "same-notebook")
                 for session in ("first", "second") for scope in ("public", "private")}
        self.assertEqual(len(roots), 4)

    def test_first_legacy_environment_is_copied_without_overwriting_or_deleting_others(self):
        original = self.legacy_environment("session", "public", "first-book", "value = 42")
        other = self.legacy_environment("session", "public", "second-book", "value = 99")
        root = PACKAGES.session_environment(self.state, "session", "public", "first-book")
        reopened = PACKAGES.session_environment(self.state, "session", "public", "second-book")
        self.assertEqual(root, reopened)
        self.assertEqual((root / "current/example.py").read_text(), "value = 42")
        self.assertEqual((root / "current").resolve().parent, root)
        self.assertEqual((original / "current/example.py").read_text(), "value = 42")
        self.assertEqual((other / "current/example.py").read_text(), "value = 99")

    def test_private_legacy_packages_do_not_seed_public_environment(self):
        self.legacy_environment("session", "private", "first-book", "private = True")
        public = PACKAGES.session_environment(self.state, "session", "public", "first-book")
        self.assertFalse((public / "current").exists())

    def test_legacy_environment_cannot_follow_a_pointer_outside_its_root(self):
        legacy = self.legacy_environment("session", "public", "first-book", "value = 42")
        (legacy / "current").unlink()
        (legacy / "current").symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Invalid managed package environment"):
            PACKAGES.session_environment(self.state, "session", "public", "first-book")
        self.assertTrue((legacy / "site-original/example.py").exists())


if __name__ == "__main__":
    unittest.main()
