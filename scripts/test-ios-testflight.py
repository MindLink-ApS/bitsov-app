#!/usr/bin/env python3
"""TestFlight build script and release check, without Xcode services or signing."""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
CHECK = ROOT / "scripts/check-ios-release.py"
BUILD = ROOT / "scripts/ios-testflight.sh"
FAKE = r'''#!/usr/bin/env python3
import json, os, sys
tool, args = os.path.basename(sys.argv[0]), sys.argv[1:]
if tool == "rustc":
    if args == ["--print", "sysroot"]: print(os.environ["FAKE_SYSROOT"])
    elif args == ["-vV"]: print("rustc 1.0.0\nhost: aarch64-apple-darwin")
    sys.exit(0)
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps([tool, *args]) + "\n")
'''


class ReleaseCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ios-release-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ("src-tauri/Info.ios.plist", "src-tauri/gen/apple/bitsov-app_iOS/Info.plist",
                     "src-tauri/gen/apple/bitsov-app_iOS/bitsov-app_iOS.entitlements",
                     "src-tauri/gen/apple/bitsov-app.xcodeproj/project.pbxproj"):
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, self.root / name)

    def check(self):
        return subprocess.run([sys.executable, str(CHECK), "--root", str(self.root)],
                              capture_output=True, text=True)

    def edit_plist(self, name, change):
        path = self.root / name
        with open(path, "rb") as handle:
            data = plistlib.load(handle)
        change(data)
        with open(path, "wb") as handle:
            plistlib.dump(data, handle)

    def test_committed_project_passes(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_each_shipping_plist_needs_usage_strings_audio_and_export_answer(self):
        for name in ("src-tauri/Info.ios.plist", "src-tauri/gen/apple/bitsov-app_iOS/Info.plist"):
            for change, message in (
                (lambda d: d.pop("NSMicrophoneUsageDescription"), "NSMicrophoneUsageDescription"),
                (lambda d: d.update(NSCameraUsageDescription=" "), "NSCameraUsageDescription"),
                (lambda d: d.pop("NSLocalNetworkUsageDescription"), "NSLocalNetworkUsageDescription"),
                (lambda d: d.pop("NSFaceIDUsageDescription"), "NSFaceIDUsageDescription"),
                (lambda d: d.update(UIBackgroundModes=["audio", "voip"]), "UIBackgroundModes"),
                (lambda d: d.pop("ITSAppUsesNonExemptEncryption"), "ITSAppUsesNonExemptEncryption"),
            ):
                with self.subTest(name=name, message=message):
                    self.setUp()
                    self.edit_plist(name, change)
                    result = self.check()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)

    def test_simulator_only_settings_never_ship(self):
        project = self.root / "src-tauri/gen/apple/bitsov-app.xcodeproj/project.pbxproj"
        original = project.read_text()
        for text, message in (
            (original.replace("ENABLE_BITCODE = NO", "ENABLE_BITCODE = YES", 1), "ENABLE_BITCODE"),
            (original.replace("ARCHS = (", 'OTHER_LDFLAGS = "-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements";\n\t\t\t\tARCHS = (', 1), "simulator builds only"),
            (original.replace("ARCHS = (", "DEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tARCHS = (", 1), "DEVELOPMENT_TEAM"),
            (original.replace('shellScript = "', 'shellScript = "if [ \\"${BITSOV_IOS_SIM_PREBUILT:-}\\" = 1 ]; then exit 0; fi\\n', 1), "limited to the simulator"),
        ):
            with self.subTest(message=message):
                self.assertNotEqual(text, original)
                project.write_text(text)
                result = self.check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                project.write_text(original)
        self.edit_plist("src-tauri/gen/apple/bitsov-app_iOS/bitsov-app_iOS.entitlements",
                        lambda d: d.update({"application-identifier": "SIMULATOR.tech.mindlink.bitsov"}))
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("simulator-only application-identifier", result.stderr)


class TestFlightBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ios-testflight-test-")
        self.addCleanup(self.tmp.cleanup)
        bin_dir = Path(self.tmp.name) / "bin"
        bin_dir.mkdir()
        for tool in ("npx", "cargo", "rustc"):
            (bin_dir / tool).write_text(FAKE)
            (bin_dir / tool).chmod(0o755)
        self.log = Path(self.tmp.name) / "calls.jsonl"
        self.sysroot = Path(self.tmp.name) / "sysroot"
        self.objcopy = self.sysroot / "lib/rustlib/aarch64-apple-darwin/bin/llvm-objcopy"
        self.objcopy.parent.mkdir(parents=True)
        self.objcopy.write_text("#!/bin/sh\n")
        self.objcopy.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", CALL_LOG=str(self.log),
                        BITSOV_IOS_SIM_PREBUILT="1", FAKE_SYSROOT=str(self.sysroot))
        self.env.pop("IOS_BUILD_NUMBER", None)

    def run_build(self, *args):
        return subprocess.run(["bash", str(BUILD), *args], env=self.env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_build_number_is_the_commit_count_as_a_single_integer(self):
        count = subprocess.run(["git", "-C", str(ROOT), "rev-list", "--count", "HEAD"],
                               capture_output=True, text=True, check=True).stdout.strip()
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        clean, call = self.calls()
        # The Swift packages are rebuilt so their entry points get re-exported.
        self.assertEqual(clean[:2], ["cargo", "clean"])
        for arg in ("--release", "aarch64-apple-ios", "tauri", "tauri-plugin-barcode-scanner"):
            self.assertIn(arg, clean)
        self.assertEqual(call[:5], ["npx", "tauri", "ios", "build", "--export-method"])
        self.assertEqual(call[5], "app-store-connect")
        config = json.loads(call[call.index("--config") + 1])
        self.assertEqual(config, {"bundle": {"iOS": {"bundleVersion": count}}})
        self.assertNotIn("--build-number", call)
        for forbidden in ("--no-sign", "DEVELOPMENT_TEAM", "-allowProvisioningUpdates"):
            self.assertFalse(any(forbidden in arg for arg in call), forbidden)
        self.assertIn(f"(build {count})", result.stdout)

    def test_override_and_passthrough(self):
        self.env["IOS_BUILD_NUMBER"] = "512"
        result = self.run_build("--", "--open")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.calls()[-1]
        self.assertEqual(json.loads(call[call.index("--config") + 1])["bundle"]["iOS"]["bundleVersion"], "512")
        self.assertEqual(call[-1], "--open")

    def test_rejects_a_build_number_app_store_connect_would_refuse(self):
        for bad in ("0", "1.2", "0.0.1.5", "abc", "-3", ""):
            with self.subTest(bad=bad):
                self.env["IOS_BUILD_NUMBER"] = bad
                result = self.run_build()
                if bad == "":
                    continue  # empty falls back to the commit count
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("positive integer", result.stderr)
        self.assertFalse(any(c[0] == "npx" and "--config" in c and '"0' in c[c.index("--config") + 1] for c in self.calls()))

    def test_refuses_without_llvm_objcopy_before_building(self):
        self.objcopy.unlink()
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rustup component add llvm-tools", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_dry_run_runs_nothing(self):
        result = self.run_build("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertIn("app-store-connect", result.stdout)


if __name__ == "__main__":
    unittest.main()
