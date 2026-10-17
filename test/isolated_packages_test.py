"""Package parser and transactional offline installer tests."""
import importlib.util
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
