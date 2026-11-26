#!/usr/bin/env python3
"""Native package routing with authenticated offline sidecars and fake OS tools."""
import hashlib
import json
import os
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
if os.environ.get("TEST_BETA") == "1":
    app = bundle / "macos/BitSov Beta.app"
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
    if os.environ.get("TEST_BETA") == "1":
        config_index = args.index("--config")
        assert args[config_index + 1] == "src-tauri/tauri.beta.conf.json", args
        args = args[:config_index] + args[config_index + 2:]
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
    shutil.copy2("src-tauri/bin/bitsov-mcp-" + triple, app / "Contents/MacOS/bitsov-mcp")
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
elif name == "sleep":
    pass
elif name == "cargo":
    # Only the MCP shim, built from this checkout for the package's target.
    assert args[:5] == ["build", "--locked", "--release", "--manifest-path", "src-tauri/Cargo.toml"], args
    assert args[5:8] == ["-p", "bitsov-mcp", "--target"] and len(args) == 9, args
    built = pathlib.Path(os.environ["CARGO_TARGET_DIR"]) / args[8] / "release/bitsov-mcp"
    built.parent.mkdir(parents=True, exist_ok=True)
    built.write_bytes(b"fake shim " + args[8].encode())
    built.chmod(0o755)
elif name == "hdiutil":
    if args[0] == "create":
        assert args == ["create", "-srcfolder", str(app), "-volname", "BitSov", "-format", "UDZO", str(dmg)], args
        assert pathlib.Path("verified-app").exists()
        assert not dmg.exists(), "a stale or partial image must be removed before create"
        tries = pathlib.Path("hdiutil-creates")
        count = int(tries.read_text()) + 1 if tries.exists() else 1
        tries.write_text(str(count))
        if scenario == "dmg-busy-always" or (scenario == "dmg-busy-once" and count == 1):
            dmg.write_text("partial image")
            sys.exit("hdiutil: create failed - Resource busy")
        if scenario == "dmg-other-error":
            sys.exit("hdiutil: create failed - No space left on device")
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
                    custom_dir=False, fetch=False, implicit_arm64=False, beta=False):
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
            if beta:
                app = bundle / "macos/BitSov Beta.app"
            dmg = bundle / ("dmg/BitSov_0.0.1_" + ("aarch64" if arch == "arm64" else "x86_64") + ".dmg")
            app.mkdir(parents=True)
            dmg.parent.mkdir(parents=True)
            dmg.write_text("stale image")
            # The other target must survive cleanup of this target's artifacts.
            other = root / output / "other-target/release/bundle/keep"
            other.parent.mkdir(parents=True)
            other.write_text("other build")
            for name in ("uname", "sysctl", "npm", "file", "codesign", "hdiutil", "plutil", "spctl", "otool",
                         "open", "curl", "cargo", "xcrun", "security", "sleep"):
                tool = root / "fakebin" / name
                tool.write_text(TOOLS)
                tool.chmod(0o755)
            trace = root / "trace"
            env.update(TRACE=str(trace), TEST_ARCH=arch, TEST_TRIPLE=triple,
                       TEST_OUTPUT=str(expected_output), TEST_OS=os_name, TEST_SCENARIO=scenario,
                       TEST_IMPLICIT_ARM64="1" if implicit_arm64 else "0",
                       TEST_BETA="1" if beta else "0",
                       BITSOV_MAC_SIGNING_IDENTITY="-", BITSOV_MAC_NOTARY_PROFILE="",
                       BITSOV_MAC_PROVISION_PROFILE="", BITSOV_USE_EXISTING_SIDECAR="0")
            env.pop("CARGO_TARGET_DIR", None)
            if custom_dir:
                env["CARGO_TARGET_DIR"] = str(output)
            command = ["bash", "scripts/package-mac.sh", "--dmg"]
            command += args if args is not None else ["--arch", arch]
            if beta:
                command += ["--beta"]
            if not fetch:
                command += ["--use-existing-sidecar"]
            result = subprocess.run(command, cwd=root, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            events = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
            self.assertEqual(other.read_text(), "other build")
            if implicit_arm64 and result.returncode == 0:
                self.assertTrue((root / "src-tauri/target/package-mac.log").is_file())
            return result, events, dmg.read_text() if dmg.exists() else None, sidecar.read_bytes()

    def test_beta_native_targets_keep_profile_and_bundle_routes(self):
        for arch in ("arm64", "x86_64"):
            for custom in (False, True):
                with self.subTest(arch=arch, custom=custom):
                    result, events, image, _ = self.run_package(arch, custom_dir=custom, beta=True)
                    self.assertEqual(result.returncode, 0, result.stdout)
                    self.assertEqual(image, "verified image")
                    build = next(e for e in events if e[0] == "npm" and "build" in e[1])
                    self.assertIn("--config", build[1])
                    self.assertIn("src-tauri/tauri.beta.conf.json", build[1])
                    self.assertIn("--target", build[1])
                    signed = [e[1][-1] for e in events if e[0] == "codesign" and "--sign" in e[1]]
                    self.assertTrue(any(p.endswith("/macos/BitSov Beta.app") for p in signed))

    def test_beta_implicit_arm64_keeps_profile_and_legacy_output(self):
        result, events, image, _ = self.run_package("arm64", args=[], implicit_arm64=True, beta=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(image, "verified image")
        build = next(e for e in events if e[0] == "npm" and "build" in e[1])
        self.assertIn("src-tauri/tauri.beta.conf.json", build[1])
        self.assertNotIn("--target", build[1])

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


    def test_image_create_retries_once_only_on_a_busy_device(self):
        creates = lambda events: sum(1 for e in events if e[0] == "hdiutil" and e[1][0] == "create")
        result, events, image, _ = self.run_package(scenario="dmg-busy-once")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(creates(events), 2)
        self.assertEqual(image, "verified image")
        self.assertIn("retrying once", result.stdout)
        for scenario, attempts in (("dmg-busy-always", 2), ("dmg-other-error", 1)):
            with self.subTest(scenario=scenario):
                result, events, _, _ = self.run_package(scenario=scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(creates(events), attempts)
                self.assertFalse(any(e[0] == "hdiutil" and e[1][0] == "verify" for e in events))
                self.assertNotIn("PACKAGE: PASS", result.stdout)

LOCAL_TOOLS = r'''#!/usr/bin/env python3
import json, os, pathlib, plistlib, subprocess, sys, zipfile
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ["TRACE"], "a") as trace:
    trace.write(json.dumps([name, args]) + "\n")
scenario = os.environ["TEST_SCENARIO"]
bundle = pathlib.Path(os.environ["CARGO_TARGET_DIR"]) / "x86_64-apple-darwin/release/bundle"
app = bundle / "macos/BitSov Remote Test.app"
if name == "uname":
    print(("Linux" if scenario == "linux" else "Darwin") if args == ["-s"] else
          ("arm64" if scenario == "arm-host" else "x86_64"))
elif name == "sysctl":
    if scenario == "probe-fail":
        sys.exit(1)
    print("1" if scenario == "translated" else "0")
elif name == "npm":
    if args == ["--version"]:
        if scenario == "version-fail":
            sys.exit(44)
        print("10.0.0-fixture")
    elif args != ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]:
        assert args == ["run", "tauri", "--", "build", "--bundles", "app", "--no-sign", "--ci",
                        "--target", "x86_64-apple-darwin", "--config",
                        "src-tauri/tauri.remote-only.conf.json", "--", "--locked"], args
        assert not bundle.exists(), "stale output survived"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Resources").mkdir()
        exe = app / "Contents/MacOS/bitsov-app"
        exe.write_text("app fixture")
        exe.chmod(0o755)
        (app / "Contents/Resources/icon.icns").write_bytes(b"icns")
        plist = {"CFBundleIdentifier": "tech.mindlink.bitsov.remotetest",
                 "CFBundleName": "BitSov Remote Test", "LSMinimumSystemVersion": "11.0"}
        if scenario == "wrong-identifier":
            plist["CFBundleIdentifier"] = "tech.mindlink.bitsov.beta"
        if scenario == "wrong-product":
            plist["CFBundleName"] = "BitSov"
        if scenario == "missing-plist-minimum":
            del plist["LSMinimumSystemVersion"]
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps(plist))
        if scenario == "sidecar":
            (app / "Contents/MacOS/konsensus").write_text("unexpected node")
        if scenario == "nested-sidecar":
            (app / "Contents/Resources/konsensus-x86_64-apple-darwin").symlink_to("missing")
        pathlib.Path("dist").mkdir(exist_ok=True)
        pathlib.Path("dist/index.html").write_text("release")
elif name == "file":
    if args[0] == "-b":
        print("Mach-O universal binary with 2 architectures" if scenario == "universal" else
              "Mach-O 64-bit executable x86_64")
elif name == "plutil":
    data = plistlib.loads(pathlib.Path(args[-1]).read_bytes())
    if args[0] == "-extract":
        print(data[args[1]])
elif name == "otool":
    if args[0] == "-l" and scenario != "missing-macho-minimum":
        print("cmd LC_VERSION_MIN_MACOSX\ncmdsize 16\nversion 11.0\nsdk 13.3" if scenario == "legacy-minimum"
              else "cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 1\nminos 11.0\nsdk 13.3")
elif name == "codesign":
    if "--sign" in args:
        assert args[args.index("--sign") + 1] == "-", args
        assert "--timestamp" not in args and "--options" not in args, args
        if pathlib.Path(args[-1]) == app:
            (app / "Contents/_CodeSignature").mkdir(exist_ok=True)
            (app / "Contents/_CodeSignature/CodeResources").write_text("fixture seal")
    if "--verify" in args:
        assert (app / "Contents/_CodeSignature/CodeResources").is_file(), args
elif name == "hdiutil":
    if args[0] == "create":
        assert pathlib.Path(args[args.index("-srcfolder") + 1]) == app, args
        pathlib.Path(args[-1]).write_bytes(b"verified image")
    else:
        assert args[0] == "verify" and pathlib.Path(args[-1]).read_bytes() == b"verified image", args
elif name == "ditto":
    assert args[:3] == ["-c", "-k", "--keepParent"] and pathlib.Path(args[3]) == app, args
    with zipfile.ZipFile(args[4], "w") as archive:
        for item in app.rglob("*"):
            if item.is_file():
                archive.write(item, item.relative_to(app.parent))
elif name == "shasum":
    if "-c" in args and scenario == "checksum-mismatch":
        next(pathlib.Path(".").glob("*.dmg")).write_bytes(b"changed image")
    sys.exit(subprocess.call(["/usr/bin/shasum", *args]))
elif name in ("rustc", "cargo", "sw_vers", "xcrun"):
    print(name + " fixture-version")
elif name == "spctl":
    sys.exit(3)
else:
    sys.exit("unexpected tool: " + name)
'''


class LocalIntelPackagingTests(unittest.TestCase):
    source_sha = "0123456789abcdef0123456789abcdef01234567"

    def run_local(self, scenario="success", sha=None, package_args=None):
        with tempfile.TemporaryDirectory(prefix="local intel ") as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            for name in ("package-mac.sh", "check-mac-bundle.sh", "fetch-node-sidecar.sh",
                         "build-local-mac-intel.sh"):
                source = ROOT / "scripts" / name
                self.assertTrue(source.is_file(), f"missing local packaging entry point: {name}")
                shutil.copy2(source, root / "scripts" / name)
            (root / "src-tauri/src").mkdir(parents=True)
            for name in ("tauri.conf.json", "tauri.remote-only.conf.json"):
                shutil.copy2(ROOT / "src-tauri" / name, root / "src-tauri" / name)
            shutil.copy2(ROOT / "src-tauri/src/profile.rs", root / "src-tauri/src/profile.rs")
            if scenario == "wrong-config":
                config = root / "src-tauri/tauri.remote-only.conf.json"
                data = json.loads(config.read_text())
                data["identifier"] = "tech.mindlink.bitsov.beta"
                config.write_text(json.dumps(data))
            if scenario == "config-sidecar":
                config = root / "src-tauri/tauri.remote-only.conf.json"
                data = json.loads(config.read_text())
                data["bundle"]["externalBin"] = ["bin/konsensus"]
                config.write_text(json.dumps(data))
            fakebin = root / "fakebin"
            fakebin.mkdir()
            for name in ("uname", "sysctl", "npm", "file", "plutil", "otool", "codesign", "hdiutil",
                         "ditto", "shasum", "rustc", "cargo", "sw_vers", "xcrun", "spctl",
                         "gh", "gpg", "open", "curl", "security"):
                tool = fakebin / name
                tool.write_text(LOCAL_TOOLS)
                tool.chmod(0o755)
            output = root / "target with spaces"
            stale = output / "x86_64-apple-darwin/release/bundle/dmg/build-info.txt"
            stale.parent.mkdir(parents=True)
            stale.write_text("stale receipt")
            trace = root / "trace"
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", TRACE=str(trace),
                       CARGO_TARGET_DIR=str(output), TEST_SCENARIO=scenario,
                       BITSOV_MAC_SIGNING_IDENTITY="-", BITSOV_MAC_NOTARY_PROFILE="",
                       BITSOV_MAC_PROVISION_PROFILE="", BITSOV_USE_EXISTING_SIDECAR="0")
            command = ["bash", "scripts/build-local-mac-intel.sh"] + ([self.source_sha] if sha is None else sha)
            if package_args is not None:
                command = ["bash", "scripts/package-mac.sh", "--arch", "x86_64", *package_args]
            result = subprocess.run(command, cwd=root, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            events = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
            receipts = {p.name: p.read_bytes() for p in stale.parent.glob("*") if p.is_file()}
            return result, events, receipts

    def test_archive_build_records_profile_minima_toolchains_and_verified_checksums(self):
        for scenario in ("success", "legacy-minimum"):
            with self.subTest(scenario=scenario):
                result, events, files = self.run_local(scenario)
                self.assertEqual(result.returncode, 0, result.stdout)
                info = files["build-info.txt"].decode()
                for expected in (self.source_sha, "tech.mindlink.bitsov.remotetest", "BitSov Remote Test",
                                 "x86_64", "LSMinimumSystemVersion=11.0", "minos=11.0",
                                 "signet-only", "remote-only", "node=", "npm=", "rustc=", "cargo=",
                                 "clang=", "macOS=", "profile.rs.sha256=", "config.sha256="):
                    self.assertIn(expected, info)
                sums = files["SHA256SUMS"].decode().splitlines()
                self.assertEqual(len(sums), 3)
                for line in sums:
                    digest, name = line.split("  ", 1)
                    self.assertEqual(hashlib.sha256(files[name]).hexdigest(), digest)
                self.assertTrue(any(e[0] == "shasum" and "-c" in e[1] for e in events))
                self.assertFalse(any(e[0] in ("gh", "gpg", "open", "curl", "security") for e in events))

    def test_wrong_host_or_translation_stops_before_install_or_build(self):
        for scenario in ("arm-host", "linux", "translated", "probe-fail"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_local(scenario)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil", "ditto") for e in events))

    def test_full_source_sha_is_required_without_git(self):
        for sha in ([], [""], ["abc1234"], ["g" * 40], [self.source_sha, "extra"]):
            with self.subTest(sha=sha):
                result, events, _ = self.run_local(sha=sha)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil", "ditto") for e in events))

    def test_wrong_profile_configuration_stops_before_build(self):
        for scenario in ("wrong-config", "config-sidecar"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_local(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil", "ditto") for e in events))

    def test_wrong_identifier_product_arch_or_sidecar_never_reaches_signing(self):
        for scenario in ("wrong-identifier", "wrong-product", "sidecar", "nested-sidecar", "universal",
                         "missing-plist-minimum"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_local(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(e[0] in ("codesign", "hdiutil", "ditto") for e in events))

    def test_missing_macho_minimum_does_not_emit_successful_receipt(self):
        result, _, files = self.run_local("missing-macho-minimum")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("SHA256SUMS", files)

    def test_checksum_mismatch_is_fatal(self):
        result, _, _ = self.run_local("checksum-mismatch")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("FAILED", result.stdout)

    def test_toolchain_version_failure_does_not_emit_a_manifest(self):
        result, _, files = self.run_local("version-fail")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("SHA256SUMS", files)

    def test_remote_only_rejects_conflicting_packaging_modes(self):
        for args in (["--remote-only", "--beta"], ["--remote-only", "--use-existing-sidecar"]):
            with self.subTest(args=args):
                result, events, _ = self.run_local(package_args=args)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(any(e[0] in ("npm", "codesign", "hdiutil", "gh", "gpg") for e in events))


if __name__ == "__main__":
    unittest.main()
