import os
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest


GENERATOR = Path(__file__).resolve().parents[1] / "rust-gui-base-app.sh"


class GeneratorTest(unittest.TestCase):
    def test_generation_validation_and_launcher(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "folder with spaces" / "my-app_2"
            project.mkdir(parents=True)
            binaries = root / "bin"
            binaries.mkdir()
            rustup = binaries / "rustup"
            rustup.write_text(
                '#!/bin/sh\nset -eu\n'
                'case "$1" in\n'
                'update) [ "$2" = stable ]; printf "%s\\n" "$*" >> "$UPDATE_LOG"; '
                'exit "${UPDATE_STATUS:-0}" ;;\n'
                'run) [ "$2" = stable ]; shift 2; exec "$@" ;;\n'
                '*) exit 1 ;;\nesac\n'
            )
            rustup.chmod(0o755)
            update_log = root / "updates"
            environment = {
                **os.environ,
                "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                "UPDATE_LOG": str(update_log),
            }

            def generate(directory=project):
                return subprocess.run(
                    ["sh", str(GENERATOR)], cwd=directory, stdin=subprocess.DEVNULL,
                    env=environment, text=True, capture_output=True,
                )

            for name in ("9app", "MyApp", "app name", 'app"', "$(touch injected)"):
                invalid = root / name
                invalid.mkdir()
                self.assertNotEqual(generate(invalid).returncode, 0, name)
                self.assertEqual(list(invalid.iterdir()), [])
            self.assertFalse(update_log.exists())

            environment["UPDATE_STATUS"] = "1"
            self.assertNotEqual(generate().returncode, 0)
            self.assertEqual(list(project.iterdir()), [])
            del environment["UPDATE_STATUS"]

            result = generate()
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = tomllib.loads((project / "Cargo.toml").read_text())
            self.assertEqual(manifest["package"]["name"], "my-app_2")
            self.assertNotIn("rust-version", manifest["package"])
            toolchain = tomllib.loads((project / "rust-toolchain.toml").read_text())
            self.assertEqual(toolchain["toolchain"]["channel"], "stable")
            self.assertEqual(update_log.read_text().splitlines(), ["update stable"] * 2)
            self.assertEqual(manifest["dependencies"]["gpui-kit"]["features"], ["gpui-fast"])
            self.assertTrue(os.access(project / "run.sh", os.X_OK))
            self.assertTrue(os.access(project / "build.sh", os.X_OK))
            subprocess.run(["cargo", "fmt", "--check"], cwd=project, check=True)

            subprocess.run(
                ["cargo", "test", "--offline", "--target-dir", str(GENERATOR.parent / "target")],
                cwd=project, check=True,
            )

            templates = {
                name: (project / name).read_bytes()
                for name in ("Cargo.toml", "src/main.rs", "src/settings.rs", "src/settings_view.rs", "run.sh", "build.sh", ".gitignore", "rust-toolchain.toml")
            }
            for name in templates:
                (project / name).write_text("old template\n")
            extra_source = project / "src/custom.rs"
            extra_source.write_text("// existing source\n")
            lockfile = project / "Cargo.lock"
            lockfile.write_text("existing lockfile\n")
            result = generate()
            self.assertEqual(result.returncode, 0, result.stderr)
            for name, original in templates.items():
                self.assertEqual((project / name).read_bytes(), original)
            self.assertEqual(extra_source.read_text(), "// existing source\n")
            self.assertEqual(lockfile.read_text(), "existing lockfile\n")

            cargo = binaries / "cargo"
            cargo.write_text('#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\nexit 7\n')
            cargo.chmod(0o755)
            result = subprocess.run(
                [str(project / "run.sh"), "argument with spaces"], cwd=root,
                env=environment,
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 7)
            self.assertEqual(result.stdout.splitlines(), [str(project), "run", "--", "argument with spaces"])

            result = subprocess.run(
                [str(project / "build.sh")], cwd=root,
                env=environment, text=True, capture_output=True,
            )
            bundle = project / "target/release/my-app_2.app"
            self.assertFalse(bundle.exists())
            if sys.platform == "darwin":
                self.assertEqual(result.returncode, 7)
                host = subprocess.check_output(["rustc", "-vV"], text=True).split("host: ")[1].splitlines()[0]
                self.assertEqual(result.stdout.splitlines(), [str(project), "build", "--release", "--target", host, "--target-dir", "target"])

                executable_fixture = root / "test-app"
                subprocess.run(
                    ["cc", "-x", "c", "-o", str(executable_fixture), "-"],
                    input="int main(void) { return 0; }\n", text=True, check=True,
                )
                environment["TEST_EXECUTABLE"] = str(executable_fixture)
                cargo.write_text(
                    '#!/bin/sh\nset -eu\nmkdir -p "target/$4/release"\n'
                    'cp "$TEST_EXECUTABLE" "target/$4/release/my-app_2"\n'
                )
                result = subprocess.run(
                    [str(project / "build.sh")], cwd=root,
                    env=environment, text=True, capture_output=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
                self.assertEqual(info["CFBundleName"], "my-app_2")
                self.assertEqual(info["CFBundleIdentifier"], "local.my-app-2")
                self.assertEqual(info["CFBundlePackageType"], "APPL")
                executable = bundle / "Contents/MacOS" / info["CFBundleExecutable"]
                self.assertTrue(os.access(executable, os.X_OK))
                subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
                subprocess.run([str(executable)], check=True)
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires macOS", result.stderr)


if __name__ == "__main__":
    unittest.main()
