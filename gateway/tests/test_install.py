import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install


class GatewayInstallerTests(unittest.TestCase):
    def test_installer_preserves_existing_profile_data_and_token(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".hermes"
            profile = home / "plugins" / "model-providers" / "hermes-browser"
            profile.mkdir(parents=True)
            (profile / "user-note.txt").write_text("keep", encoding="utf-8")
            env = home / ".env"
            env.write_text("OTHER_KEY=leave-me\nHERMEXTENT_BRIDGE_TOKEN=local-secret-value-long-enough-1234567890\n", encoding="utf-8")

            install.ensure_gateway_token(env)
            installed = install.install_profile(home)

            self.assertTrue((installed / "__init__.py").is_file())
            self.assertEqual((installed / "user-note.txt").read_text(encoding="utf-8"), "keep")
            content = env.read_text(encoding="utf-8")
            self.assertIn("OTHER_KEY=leave-me", content)
            self.assertEqual(content.count("HERMEXTENT_BRIDGE_TOKEN="), 1)
            self.assertIn("local-secret-value-long-enough-1234567890", content)

    def test_installer_adds_a_secret_without_printing_or_returning_its_value(self):
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / ".hermes" / ".env"
            install.ensure_gateway_token(env)
            value = next(line.split("=", 1)[1] for line in env.read_text(encoding="utf-8").splitlines() if line.startswith("HERMEXTENT_BRIDGE_TOKEN="))
            self.assertGreaterEqual(len(value), 32)
            self.assertNotEqual(value, "")


if __name__ == "__main__":
    unittest.main()
