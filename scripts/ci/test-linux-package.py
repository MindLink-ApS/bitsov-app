#!/usr/bin/env python3
"""Exercise Linux packaging workflow commands with offline bundle fixtures."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
RELEASE = Path("src-tauri/target/x86_64-unknown-linux-gnu/release")


def step_command(name):
    workflow = (ROOT / ".github/workflows/linux-package.yml").read_text()
    match = re.search(
        rf"^      - name: {re.escape(name)}\n        run: ([|>]-?)\n"
        r"((?:          [^\n]*\n|\n)+)", workflow, re.MULTILINE,
    )
    if match is None:
        raise AssertionError(f"missing run block: {name}")
    command = textwrap.dedent(match[2]).strip()
    return " ".join(command.splitlines()) if match[1].startswith(">") else command


TOOLS = r'''
import json, os, pathlib, sys, tarfile
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
if name == "npm":
    pathlib.Path(os.environ["TEST_BUILD_ARGS"]).write_text(json.dumps(args))
elif name == "file":
    assert len(args) == 1 and pathlib.Path(args[0]).is_file(), args
    print(args[0] + ": " + os.environ["TEST_FILE_TYPE"])
elif name == "dpkg-deb":
    if args[0] == "--field":
        assert args[2:] == ["Architecture"], args
        print(os.environ["TEST_DEB_ARCH"])
    elif args[0] == "--contents":
        print("offline deb fixture")
    elif args[0] == "--fsys-tarfile":
        with tarfile.open(os.environ["TEST_DEB_TAR"], "r") as archive:
            with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as output:
                for member in archive.getmembers():
                    output.addfile(member, archive.extractfile(member) if member.isfile() else None)
    else:
        sys.exit("unexpected deb operation: " + repr(args))
else:
    sys.exit("unexpected command: " + name)
'''

APPIMAGE = r'''
import os, pathlib, shutil, sys
if sys.argv[1:] != ["--appimage-extract"]:
    sys.exit("only extraction is allowed")
pathlib.Path(os.environ["TEST_EXTRACTION_TRACE"]).write_text("extracted")
if os.environ["TEST_EXTRACTION"] == "fail":
    sys.exit(23)
if os.environ["TEST_EXTRACTION"] != "missing":
    shutil.copytree(os.environ["TEST_APPDIR"], "squashfs-root", symlinks=True)
'''


class LinuxPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="linux package ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / RELEASE
        self.release.mkdir(parents=True)
        (self.release / "bitsov-app").write_bytes(b"offline executable fixture")
        self.appimages = self.release / "bundle/appimage"
        self.debs = self.release / "bundle/deb"
        self.appimages.mkdir(parents=True)
        self.debs.mkdir(parents=True)
        self.appimage = self.appimages / "BitSov Remote Test.AppImage"
        self.executable(self.appimage, APPIMAGE)
        (self.debs / "remote-test.deb").touch()
        self.appdir = self.root / "appdir"
        (self.appdir / "usr/bin").mkdir(parents=True)
        (self.appdir / "usr/bin/bitsov-app").write_bytes(b"offline app fixture")
        self.runner_temp = self.root / "runner temp"
        self.runner_temp.mkdir()
        fakebin = self.root / "fakebin"
        fakebin.mkdir()
        for name in ("npm", "file", "dpkg-deb"):
            self.executable(fakebin / name, TOOLS)
        self.env = dict(
            os.environ, PATH=str(fakebin) + os.pathsep + os.environ["PATH"],
            RUNNER_TEMP=str(self.runner_temp), GITHUB_WORKSPACE=str(self.root),
            TEST_BUILD_ARGS=str(self.root / "build-args.json"),
            TEST_FILE_TYPE="ELF 64-bit LSB executable, x86-64",
            TEST_DEB_ARCH="amd64", TEST_DEB_TAR=str(self.root / "deb.tar"),
            TEST_APPDIR=str(self.appdir), TEST_EXTRACTION="ok",
            TEST_EXTRACTION_TRACE=str(self.root / "extraction-trace"),
        )
        self.deb_archive()

    def executable(self, path, body):
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o755)

    def deb_archive(self, entries=("./usr/bin/bitsov-app",)):
        with tarfile.open(self.root / "deb.tar", "w") as archive:
            for name in entries:
                member = tarfile.TarInfo(name)
                member.size = 7
                archive.addfile(member, io.BytesIO(b"fixture"))

    def run_step(self, name="Inspect Linux bundles"):
        return subprocess.run(
            ["bash", "-euo", "pipefail", "-c", step_command(name)],
            cwd=self.root, env=self.env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15,
        )

    def test_build_explicitly_names_the_binary_that_inspection_requires(self):
        result = self.run_step("Build remote-only bundles")
        self.assertEqual(result.returncode, 0, result.stdout)
        args = json.loads(Path(self.env["TEST_BUILD_ARGS"]).read_text())
        config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        for index, arg in enumerate(args):
            if arg == "--config":
                value = args[index + 1]
                patch = json.loads(value if value.startswith("{") else (ROOT / value).read_text())
                config.update(patch)
        self.assertEqual(config.get("mainBinaryName"), "bitsov-app")
        self.assertEqual(config["bundle"]["externalBin"], [])
        self.assertEqual(args[args.index("--target") + 1], "x86_64-unknown-linux-gnu")
        self.assertEqual(args[args.index("--bundles") + 1], "appimage,deb")
        self.assertIn("--no-sign", args)
        self.assertEqual(args[-2:], ["--", "--locked"])

    def test_clean_bundles_are_accepted_and_appimage_is_only_extracted(self):
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(Path(self.env["TEST_EXTRACTION_TRACE"]).is_file(), "AppImage was not extracted")
        self.assertEqual(Path(self.env["TEST_EXTRACTION_TRACE"]).read_text(), "extracted")

    def test_sidecar_in_appimage_is_rejected_including_symlinks_and_directories(self):
        for name, kind in (("usr/bin/konsensus", "file"),
                           ("usr/bin/konsensus-x86_64-unknown-linux-gnu", "file"),
                           ("usr/lib/konsensus-resources", "directory"),
                           ("usr/bin/konsensus-link", "symlink")):
            with self.subTest(name=name):
                path = self.appdir / name
                path.parent.mkdir(parents=True, exist_ok=True)
                if kind == "directory":
                    path.mkdir()
                elif kind == "symlink":
                    path.symlink_to("missing-target")
                else:
                    path.write_bytes(b"sidecar fixture")
                result = self.run_step()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("Remote-only AppImage contains a node executable", result.stdout)
                if kind == "directory":
                    path.rmdir()
                else:
                    path.unlink()

    def test_appimage_extraction_failure_is_fatal(self):
        self.env["TEST_EXTRACTION"] = "fail"
        self.assertNotEqual(self.run_step().returncode, 0)

    def test_missing_extracted_tree_is_fatal(self):
        self.env["TEST_EXTRACTION"] = "missing"
        self.assertNotEqual(self.run_step().returncode, 0)

    def test_deb_must_contain_the_inspected_binary_path(self):
        self.deb_archive(("./usr/bin/bit-sov-remote-test",))
        self.assertNotEqual(self.run_step().returncode, 0)

    def test_existing_deb_sidecar_rejection_is_preserved(self):
        for name in ("./usr/bin/konsensus", "./usr/bin/konsensus-x86_64-unknown-linux-gnu",
                     "./usr/lib/konsensus-resources/config"):
            with self.subTest(name=name):
                self.deb_archive(("./usr/bin/bitsov-app", name))
                result = self.run_step()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("Remote-only bundle contains a node executable", result.stdout)

    def test_wrong_deb_architecture_is_rejected(self):
        self.env["TEST_DEB_ARCH"] = "arm64"
        self.assertNotEqual(self.run_step().returncode, 0)

    def test_non_x86_64_executable_is_rejected(self):
        self.env["TEST_FILE_TYPE"] = "ELF 64-bit LSB executable, ARM aarch64"
        self.assertNotEqual(self.run_step().returncode, 0)

    def test_missing_or_multiple_bundles_are_rejected(self):
        for directory, suffix in ((self.appimages, ".AppImage"), (self.debs, ".deb")):
            original = next(directory.iterdir())
            payload, mode = original.read_bytes(), original.stat().st_mode
            with self.subTest(suffix=suffix, count=0):
                original.unlink()
                self.assertNotEqual(self.run_step().returncode, 0)
                original.write_bytes(payload)
                original.chmod(mode)
            with self.subTest(suffix=suffix, count=2):
                extra = directory / ("extra" + suffix)
                extra.touch()
                self.assertNotEqual(self.run_step().returncode, 0)
                extra.unlink()


if __name__ == "__main__":
    unittest.main()
