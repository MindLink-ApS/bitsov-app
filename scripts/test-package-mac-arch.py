#!/usr/bin/env python3
"""Native package routing with authenticated offline sidecars and fake OS tools."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from sidecar_test_support import PAYLOADS, ROOT, ReleaseFixture


TOOLS = r'''#!/usr/bin/env python3
import json, os, pathlib, plistlib, shutil, sys
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ["TRACE"], "a") as trace:
    trace.write(json.dumps([name, args, os.environ.get("CARGO_TARGET_DIR")]) + "\n")
arch = os.environ["TEST_ARCH"]
triple = os.environ["TEST_TRIPLE"]
implicit_arm64 = os.environ["TEST_IMPLICIT_ARM64"] == "1"
bundle = pathlib.Path(os.environ["TEST_OUTPUT"])
if not implicit_arm64:
    bundle /= triple
bundle /= "release/bundle"
app = bundle / "macos/BitSov.app"
dmg = bundle / ("dmg/BitSov_0.0.1_" + ("aarch64" if arch == "arm64" else "x86_64") + ".dmg")
scenario = os.environ["TEST_SCENARIO"]
if name == "uname":
    print(os.environ["TEST_OS"] if args == ["-s"] else arch)
elif name == "sysctl":
    assert args == ["-in", "sysctl.proc_translated"], args
    if scenario == "probe-fail":
        sys.exit(1)
    if scenario != "probe-absent":
        print("1" if scenario == "translated" else "0")
elif name == "npm":
    if args == ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]:
        sys.exit(0)
    if implicit_arm64:
        assert args == ["run", "tauri", "--", "build", "--bundles", "app", "--no-sign", "--ci", "--", "--locked"], args
    else:
        assert args[:9] == ["run", "tauri", "--", "build", "--bundles", "app", "--no-sign", "--ci", "--target"], args
        assert args[9] == triple and args[-2:] == ["--", "--locked"], args
    assert not app.exists() and not dmg.exists(), "stale target outputs survived"
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/Resources").mkdir()
    binary = app / "Contents/MacOS/bitsov-app"
    binary.write_text("app fixture")
    binary.chmod(0o755)
    shutil.copy2("src-tauri/bin/konsensus-" + triple, app / "Contents/MacOS/konsensus")
    (app / "Contents/Resources/icon.icns").write_bytes(b"icns")
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"LSMinimumSystemVersion": "11.0"}))
    pathlib.Path("dist").mkdir(exist_ok=True)
    pathlib.Path("dist/index.html").write_text("release")
elif name == "file":
    if args[0] == "-b":
        actual = arch
        if scenario == "wrong-app" and pathlib.Path(args[-1]).name == "bitsov-app":
            actual = "arm64" if arch == "x86_64" else "x86_64"
        if scenario == "wrong-node" and pathlib.Path(args[-1]).name == "konsensus":
            actual = "arm64" if arch == "x86_64" else "x86_64"
        print("Mach-O universal binary with 2 architectures" if scenario == "universal" else
              "Mach-O 64-bit executable " + actual)
elif name == "codesign":
    assert "--deep" not in args or "--verify" in args, args
    if "--sign" in args and pathlib.Path(args[-1]) == app and scenario != "missing-seal":
        (app / "Contents/_CodeSignature").mkdir(exist_ok=True)
        (app / "Contents/_CodeSignature/CodeResources").write_text("fixture seal")
    if "--verify" in args:
        assert "--strict" in args and (app / "Contents/_CodeSignature/CodeResources").is_file(), args
        if scenario == "invalid-signature":
            sys.exit(41)
        pathlib.Path("verified-app").touch()
elif name == "hdiutil":
    if args[0] == "create":
        assert args == ["create", "-srcfolder", str(app), "-volname", "BitSov", "-format", "UDZO", str(dmg)], args
        assert pathlib.Path("verified-app").exists()
        dmg.write_text("verified image")
    else:
        assert args == ["verify", str(dmg)] and dmg.read_text() == "verified image", args
elif name == "plutil":
    data = plistlib.loads(pathlib.Path(args[-1]).read_bytes())
    if args[0] == "-extract":
        print(data[args[1]])
elif name == "spctl":
    sys.exit(3)
elif name != "otool":
    sys.exit("unexpected tool: " + name)
'''


class NativePackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = ReleaseFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()

    def run_package(self, arch="x86_64", args=None, scenario="success", os_name="Darwin",
                    custom_dir=False, fetch=False, implicit_arm64=False):
        with tempfile.TemporaryDirectory(prefix="native package ") as tmp:
            root = Path(tmp)
            env = self.fixture.prepare(root)
            for name in ("package-mac.sh", "check-mac-bundle.sh"):
                shutil.copy2(ROOT / "scripts" / name, root / "scripts" / name)
            (root / "src-tauri/bin").mkdir(parents=True)
            shutil.copy2(ROOT / "src-tauri/tauri.conf.json", root / "src-tauri/tauri.conf.json")
            triple = "aarch64-apple-darwin" if arch == "arm64" else "x86_64-apple-darwin"
            asset = "bitsov-darwin-aarch64" if arch == "arm64" else "bitsov-darwin-x86_64"
            sidecar = root / ("src-tauri/bin/konsensus-" + triple)
            sidecar.write_bytes(PAYLOADS["bitsov-darwin-aarch64"] if scenario == "wrong-asset" else PAYLOADS[asset])
            sidecar.chmod(0o755)
            output = root / "custom target" if custom_dir else Path("src-tauri/target")
            expected_output = Path("src-tauri/target") if implicit_arm64 else output
            bundle = root / expected_output
            if not implicit_arm64:
                bundle /= triple
            bundle /= "release/bundle"
            app = bundle / "macos/BitSov.app"
            dmg = bundle / ("dmg/BitSov_0.0.1_" + ("aarch64" if arch == "arm64" else "x86_64") + ".dmg")
            app.mkdir(parents=True)
            dmg.parent.mkdir(parents=True)
            dmg.write_text("stale image")
            # The other target must survive cleanup of this target's artifacts.
            other = root / output / "other-target/release/bundle/keep"
            other.parent.mkdir(parents=True)
            other.write_text("other build")
            for name in ("uname", "sysctl", "npm", "file", "codesign", "hdiutil", "plutil", "spctl", "otool",
                         "open", "curl", "cargo", "xcrun", "security"):
                tool = root / "fakebin" / name
                tool.write_text(TOOLS)
                tool.chmod(0o755)
            trace = root / "trace"
            env.update(TRACE=str(trace), TEST_ARCH=arch, TEST_TRIPLE=triple,
                       TEST_OUTPUT=str(expected_output), TEST_OS=os_name, TEST_SCENARIO=scenario,
                       TEST_IMPLICIT_ARM64="1" if implicit_arm64 else "0",
                       BITSOV_MAC_SIGNING_IDENTITY="-", BITSOV_MAC_NOTARY_PROFILE="",
                       BITSOV_MAC_PROVISION_PROFILE="", BITSOV_USE_EXISTING_SIDECAR="0")
            env.pop("CARGO_TARGET_DIR", None)
            if custom_dir:
                env["CARGO_TARGET_DIR"] = str(output)
            command = ["bash", "scripts/package-mac.sh", "--dmg"]
            command += args if args is not None else ["--arch", arch]
            if not fetch:
                command += ["--use-existing-sidecar"]
            result = subprocess.run(command, cwd=root, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            events = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
            self.assertEqual(other.read_text(), "other build")
            if implicit_arm64 and result.returncode == 0:
                self.assertTrue((root / "src-tauri/target/package-mac.log").is_file())
            return result, events, dmg.read_text() if dmg.exists() else None, sidecar.read_bytes()

    def test_explicit_native_targets_and_custom_output_directories(self):
        for arch, triple in (("arm64", "aarch64-apple-darwin"), ("x86_64", "x86_64-apple-darwin")):
            for custom in (False, True):
                with self.subTest(arch=arch, custom=custom):
                    result, events, image, payload = self.run_package(arch, custom_dir=custom)
                    self.assertEqual(result.returncode, 0, result.stdout)
                    self.assertEqual(image, "verified image")
                    self.assertEqual(payload, PAYLOADS["bitsov-darwin-aarch64" if arch == "arm64" else "bitsov-darwin-x86_64"])
                    build = next(e for e in events if e[0] == "npm" and "build" in e[1])
                    self.assertEqual(build[1][9], triple)
                    self.assertTrue(build[2].endswith("/custom target" if custom else "/src-tauri/target"))

    def test_intel_host_default_and_fetch_select_signed_intel_asset(self):
        for args in ([], ["--arch", "x86_64"]):
            with self.subTest(args=args):
                result, _, image, payload = self.run_package(args=args, fetch=True)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertEqual(image, "verified image")
                self.assertEqual(payload, PAYLOADS["bitsov-darwin-x86_64"])

    def test_implicit_arm64_keeps_legacy_build_paths_and_native_checks(self):
        for custom in (False, True):
            for fetch in (False, True):
                with self.subTest(custom=custom, fetch=fetch):
                    result, events, image, payload = self.run_package(
                        "arm64", args=[], custom_dir=custom, fetch=fetch, implicit_arm64=True)
                    self.assertEqual(result.returncode, 0, result.stdout)
                    self.assertEqual(image, "verified image")
                    self.assertEqual(payload, PAYLOADS["bitsov-darwin-aarch64"])
                    build = next(e for e in events if e[0] == "npm" and "build" in e[1])
                    self.assertEqual(build[1], ["run", "tauri", "--", "build", "--bundles", "app",
                                               "--no-sign", "--ci", "--", "--locked"])
                    self.assertTrue(build[2].endswith("/src-tauri/target"), build)
                    app = "src-tauri/target/release/bundle/macos/BitSov.app"
                    inspected = [e[1] for e in events if e[0] == "file"]
                    self.assertIn(["-b", app + "/Contents/MacOS/bitsov-app"], inspected)
                    self.assertIn(["-b", app + "/Contents/MacOS/konsensus"], inspected)
                    self.assertIn("PASS  app executable is native arm64", result.stdout)
                    self.assertIn("PASS  bundled sidecar is native arm64", result.stdout)
                    images = [e[1] for e in events if e[0] == "hdiutil"]
                    self.assertEqual(images[-1], ["verify",
                        "src-tauri/target/release/bundle/dmg/BitSov_0.0.1_aarch64.dmg"])

    def test_unsupported_hosts_targets_and_missing_arch_stop_before_build(self):
        for arch, os_name, args in (("x86_64", "Linux", ["--arch", "x86_64"]),
                                   ("arm64", "Darwin", ["--arch", "x86_64"]),
                                   ("x86_64", "Darwin", ["--arch", "arm64"]),
                                   ("x86_64", "Darwin", ["--arch", "universal2"]),
                                   ("x86_64", "Darwin", ["--arch"])):
            with self.subTest(arch=arch, os_name=os_name, args=args):
                result, events, _, _ = self.run_package(arch, args=args, os_name=os_name)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil") for e in events))

    def test_wrong_signed_asset_never_reaches_build(self):
        result, events, _, _ = self.run_package(scenario="wrong-asset")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("expected sha256", result.stdout)
        self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil") for e in events))

    def test_empty_architecture_is_an_argument_error(self):
        result, events, _, _ = self.run_package(args=["--arch", ""])
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil") for e in events))
        result = subprocess.run(["bash", "scripts/check-mac-bundle.sh", "--arch", ""],
                                cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 2, result.stdout)

    def test_translated_intel_process_is_refused_before_build(self):
        result, events, _, _ = self.run_package(scenario="translated")
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil") for e in events))

    def test_translation_probe_error_is_refused_and_absent_flag_is_native(self):
        for scenario, status in (("probe-fail", 2), ("probe-absent", 0)):
            with self.subTest(scenario=scenario):
                result, events, _, _ = self.run_package(scenario=scenario)
                self.assertEqual(result.returncode, status, result.stdout)
                if status:
                    self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil") for e in events))

    def test_wrong_or_universal_executables_stop_before_signing(self):
        for arch in ("arm64", "x86_64"):
            for scenario in ("wrong-app", "wrong-node", "universal"):
                with self.subTest(arch=arch, scenario=scenario):
                    result, events, _, _ = self.run_package(arch, scenario=scenario)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn("FAIL", result.stdout)
                    self.assertFalse(any(e[0] in ("codesign", "hdiutil") for e in events))

    def test_intel_missing_seal_or_invalid_signature_never_creates_image(self):
        for scenario in ("missing-seal", "invalid-signature"):
            with self.subTest(scenario=scenario):
                result, events, _, _ = self.run_package(scenario=scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(e[0] == "hdiutil" for e in events))


if __name__ == "__main__":
    unittest.main()
