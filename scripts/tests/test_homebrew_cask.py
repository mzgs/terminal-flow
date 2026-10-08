import runpy
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
updated_cask = runpy.run_path(str(ROOT / "scripts/update-homebrew-cask.py"))["updated_cask"]


class HomebrewCaskTests(unittest.TestCase):
    def setUp(self):
        self.cask = (ROOT / "Casks/terminalflow.rb").read_text()
        self.digest = "a" * 64
        self.checksums = (
            f'{"b" * 64}  TerminalFlow-Finder-mac-arm64.zip\n'
            f"{self.digest}  TerminalFlow-mac-arm64.zip\n"
        )

    def test_release_uses_main_app_checksum_and_keeps_install_artifact(self):
        result = updated_cask(self.cask, "v2.3.4", self.checksums)
        self.assertIn('version "2.3.4"', result)
        self.assertIn(f'sha256 "{self.digest}"', result)
        self.assertIn('app "TerminalFlow.app"', result)
        self.assertIn('releases/download/v#{version}/TerminalFlow-mac-arm64.zip', result)

    def test_invalid_release_inputs_are_rejected(self):
        for tag in ("2.3.4", "v2.3.4-rc1", 'v2.3.4"\napp "bad.app'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                updated_cask(self.cask, tag, self.checksums)
        for checksums in ("", self.checksums * 2, self.checksums.replace(self.digest, "bad")):
            with self.subTest(checksums=checksums), self.assertRaises(ValueError):
                updated_cask(self.cask, "v2.3.4", checksums)

    def test_changed_cask_format_is_rejected(self):
        with self.assertRaises(ValueError):
            updated_cask(self.cask.replace('  version ', '  # version '), "v2.3.4", self.checksums)


if __name__ == "__main__":
    unittest.main()
