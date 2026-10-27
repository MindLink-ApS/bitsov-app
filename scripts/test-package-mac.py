#!/usr/bin/env python3
"""Exercise the real packaging script without builds, downloads, mounts or ports."""
import datetime
import json
import plistlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from sidecar_test_support import PAYLOAD, ReleaseFixture

ROOT = Path(__file__).resolve().parents[1]
APP = Path("src-tauri/target/release/bundle/macos/BitSov.app")
DMG = Path("src-tauri/target/release/bundle/dmg/BitSov_0.0.1_aarch64.dmg")

# Only external build/macOS commands are replaced. The package script, bundle
# checker, filesystem operations, and config version lookup are real.
STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, plistlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
scenario = os.environ["SCENARIO"]
with open(os.environ["TRACE"], "a") as f:
    f.write(json.dumps([name, args, os.environ.get("CI"),
                       os.environ.get("TAURI_BUNDLER_DMG_IGNORE_CI"),
                       os.environ.get("CARGO_TARGET_DIR")]) + "\n")
app = pathlib.Path("src-tauri/target/release/bundle/macos/BitSov.app")
dmg = pathlib.Path("src-tauri/target/release/bundle/dmg/BitSov_0.0.1_aarch64.dmg")
if name == "uname":
    print("Darwin" if args == ["-s"] else "arm64")
elif name == "npm":
    if args == ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]:
        sys.exit(17 if scenario == "install-fail" else 0)
    assert args == ["run", "tauri", "--", "build", "--bundles", "app",
                    "--no-sign", "--ci", "--", "--locked"], args
    assert not app.exists() and not dmg.exists(), "stale bundle survived"
    if scenario == "compile-fail":
        print("compilation failed", file=sys.stderr)
        sys.exit(23)
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/Resources").mkdir()
    binary = app / "Contents/MacOS/bitsov-app"
    binary.write_text("#!/bin/sh\necho APP_LAUNCHED >> \"$TRACE\"\nexit 99\n")
    binary.chmod(0o755)
    import shutil
    shutil.copy2("src-tauri/bin/konsensus-aarch64-apple-darwin", app / "Contents/MacOS/konsensus")
    (app / "Contents/Resources/icon.icns").write_bytes(b"icns")
    with (app / "Contents/Info.plist").open("wb") as f:
        plistlib.dump({"LSMinimumSystemVersion": "11.0", "CFBundleIdentifier": "org.example.client"}, f)
    pathlib.Path("dist").mkdir(exist_ok=True)
    pathlib.Path("dist/index.html").write_text("release")
    if scenario == "invalid-app":
        binary.unlink()
    framework = app / "Contents/Frameworks/Example.framework/Versions/A"
    framework.mkdir(parents=True)
    (framework / "Example").write_bytes(b"framework code")
    (framework / "Resources").mkdir()
    (framework / "Resources/data.txt").write_text("resource")
    (framework.parent / "Current").symlink_to("A", target_is_directory=True)
    (framework.parent.parent / "Example").symlink_to("Versions/Current/Example")
    (framework.parent.parent / "Resources").symlink_to("Versions/Current/Resources", target_is_directory=True)
    if scenario == "other-bundle-fail":
        sys.exit(24)
elif name == "hdiutil":
    if args[0] == "create":
        assert args[args.index("-srcfolder") + 1] == str(app), args
        assert args[args.index("-format") + 1] == "UDZO", args
        assert args[args.index("-volname") + 1] == "BitSov", args
        assert args[-1] == str(dmg), args
        assert not dmg.exists(), "stale DMG survived"
        assert app.is_dir()
        if scenario == "create-fail":
            sys.exit(31)
        assert pathlib.Path("verified-app").exists(), "DMG created before strict verification"
        dmg.write_text("verified image")
    elif args == ["verify", str(dmg)]:
        assert dmg.stat().st_size
        if scenario == "verify-fail":
            sys.exit(32)
    else:
        sys.exit("unexpected hdiutil operation: " + repr(args))
elif name == "plutil":
    with open(args[-1], "rb") as f:
        p = plistlib.load(f)
    if args[0] == "-extract":
        print(p[args[1]])
elif name == "file":
    if args[0] == "-b":
        print("Mach-O 64-bit executable arm64" if pathlib.Path(args[-1]).name in
              ("bitsov-app", "konsensus", "Example") else "data")
elif name == "codesign":
    if "--sign" in args:
        assert "--force" in args and "--deep" not in args, args
        if scenario == "sign-fail":
            sys.exit(40)
        target = pathlib.Path(args[-1])
        if target == app:
            if scenario != "missing-seal":
                (app / "Contents/_CodeSignature").mkdir(exist_ok=True)
                (app / "Contents/_CodeSignature/CodeResources").write_text("sealed resources")
        elif target.name == "konsensus":
            # Signing changes bytes: the source hash check must precede this.
            with target.open("ab") as f:
                f.write(b"signature")
    elif args == ["-dv", "--verbose=4", str(app)]:
        print("TeamIdentifier=ABCDE12345", file=sys.stderr)
    elif "--extract-certificates" in args:
        prefix = args[args.index("--extract-certificates") + 1]
        pathlib.Path(prefix + "0").write_bytes(b"synthetic certificate")
    elif "--verify" in args:
        assert "--deep" in args and "--strict" in args, args
        if scenario == "signature-invalid":
            sys.exit(41)
        assert (app / "Contents/_CodeSignature/CodeResources").is_file()
        if os.environ.get("BITSOV_MAC_SIGNING_IDENTITY") != "-":
            assert (app / "Contents/embedded.provisionprofile").is_file()
        pathlib.Path("verified-app").touch()
elif name == "security":
    assert args[:2] == ["cms", "-D"], args
    pathlib.Path(args[args.index("-o") + 1]).write_bytes(pathlib.Path(args[args.index("-i") + 1]).read_bytes())
elif name == "spctl":
    assert args == ["-a", "-vv", "-t", "exec", str(app)], args
    print("rejected (ad-hoc signature)", file=sys.stderr)
    sys.exit(3)
elif name == "ditto":
    pathlib.Path(args[-1]).write_text("notary upload")
elif name == "xcrun":
    if scenario == "notary-fail":
        sys.exit(42)
elif name not in ("otool",):
    sys.exit("forbidden command: " + name)
'''


class PackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = ReleaseFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()

    def run_package(self, scenario, dmg=True, signing_env=None):
        with tempfile.TemporaryDirectory(prefix="package mac test ") as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            for name in ("package-mac.sh", "check-mac-bundle.sh", "mac-keychain-entitlements.py"):
                shutil.copy2(ROOT / "scripts" / name, root / "scripts" / name)
            fixture_env = self.fixture.prepare(root)
            (root / "src-tauri/bin").mkdir(parents=True)
            shutil.copy2(ROOT / "src-tauri/tauri.conf.json", root / "src-tauri/tauri.conf.json")
            shutil.copy2(ROOT / "src-tauri/Entitlements.plist", root / "src-tauri/Entitlements.plist")
            profile = {"TeamIdentifier": ["ABCDE12345"], "Platform": ["OSX"],
                       "ExpirationDate": datetime.datetime(2099, 1, 1),
                       "ProvisionsAllDevices": True, "DeveloperCertificates": [b"synthetic certificate"],
                       "Entitlements": {"com.apple.application-identifier": "ABCDE12345.org.example.*",
                                        "com.apple.developer.team-identifier": "ABCDE12345",
                                        "keychain-access-groups": ["ABCDE12345.*"]}}
            if scenario == "wrong-certificate":
                profile["DeveloperCertificates"] = [b"another certificate"]
            (root / "profile.provisionprofile").write_bytes(plistlib.dumps(profile))
            sidecar = root / "src-tauri/bin/konsensus-aarch64-apple-darwin"
            sidecar.write_bytes(b"stray binary" if scenario == "bad-sidecar" else PAYLOAD)
            sidecar.chmod(0o755)
            if scenario == "extra-sidecar":
                (sidecar.parent / "konsensus-x86_64-apple-darwin").write_bytes(b"stray binary")
            # Stale outputs must never let an unsuccessful build pass.
            (root / APP).mkdir(parents=True)
            (root / DMG).parent.mkdir(parents=True)
            (root / DMG).write_text("stale image")
            if scenario == "logging-fail":
                (root / "src-tauri/target/package-mac.log").mkdir()
            fakebin = root / "fakebin"
            for name in ("uname", "npm", "hdiutil", "plutil", "file", "otool", "codesign", "spctl", "ditto", "xcrun", "security",
                         "open", "osascript", "vite", "curl", "cargo"):
                tool = fakebin / name
                tool.write_text(STUB)
                tool.chmod(0o755)
            trace = root / "trace.jsonl"
            env = dict(fixture_env, TRACE=str(trace),
                       SCENARIO=scenario, CI="false", TAURI_BUNDLER_DMG_IGNORE_CI="true",
                       CARGO_TARGET_DIR=str(root / "wrong-target"))
            env.update(BITSOV_MAC_SIGNING_IDENTITY="-", BITSOV_MAC_NOTARY_PROFILE="",
                       BITSOV_MAC_PROVISION_PROFILE="profile.provisionprofile")
            env.update(signing_env or {})
            result = subprocess.run(
                ["bash", "scripts/package-mac.sh", "--use-existing-sidecar"] + (["--dmg"] if dmg else []),
                cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            events = [json.loads(line) for line in trace.read_text().splitlines()]
            self.assertTrue(all(e[0] in ("uname", "npm", "hdiutil", "plutil", "file", "otool", "codesign", "spctl", "ditto", "xcrun", "security")
                                for e in events), events)
            image = (root / DMG).read_text() if (root / DMG).exists() else None
            return result, events, image

    def test_unverified_sidecars_stop_before_build_or_package(self):
        for scenario in ("bad-sidecar", "extra-sidecar"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("expected sha256", result.stdout)
                self.assertIn("actual sha256", result.stdout)
                self.assertFalse(any(e[0] in ("npm", "hdiutil") for e in events))

    def test_signs_inside_out_and_verifies_before_image_creation(self):
        result, events, image = self.run_package("success")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(image, "verified image")
        build = next(e for e in events if e[0] == "npm" and "build" in e[1])
        self.assertEqual(build[1][build[1].index("--bundles") + 1], "app")
        signs = [e[1] for e in events if e[0] == "codesign" and "--sign" in e[1]]
        targets = [s[-1] for s in signs]
        framework = str(APP / "Contents/Frameworks/Example.framework")
        self.assertIn(str(APP / "Contents/MacOS/konsensus"), targets)
        self.assertLess(targets.index(framework + "/Versions/A/Example"), targets.index(framework))
        self.assertEqual(targets[-1], str(APP))
        self.assertNotIn(framework + "/Example", targets)
        self.assertFalse(any("/Versions/Current/" in t for t in targets))
        self.assertTrue(all(s[s.index("--sign") + 1] == "-" for s in signs))
        self.assertTrue(all("--options" not in s and "--entitlements" not in s for s in signs))
        verify = next(i for i, e in enumerate(events) if e[0] == "codesign" and "--verify" in e[1])
        create = next(i for i, e in enumerate(events) if e[0] == "hdiutil")
        assess = next(i for i, e in enumerate(events) if e[0] == "spctl")
        self.assertLess(verify, assess)
        self.assertLess(assess, create)
        self.assertIn("rejected (ad-hoc signature)", result.stdout)
        self.assertFalse(any(e[0] in ("ditto", "xcrun") for e in events))

    def test_invalid_signatures_never_reach_dmg_creation(self):
        for scenario in ("sign-fail", "signature-invalid", "missing-seal"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("PACKAGE: PASS", result.stdout)
                self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_developer_id_and_notary_are_opt_in(self):
        identity = "Developer ID Application: Test (TEAM)"
        result, events, _ = self.run_package("success", signing_env={
            "BITSOV_MAC_SIGNING_IDENTITY": identity, "BITSOV_MAC_NOTARY_PROFILE": "test-profile"})
        self.assertEqual(result.returncode, 0, result.stdout)
        signs = [e[1] for e in events if e[0] == "codesign" and "--sign" in e[1]]
        self.assertTrue(all(s[s.index("--sign") + 1] == identity for s in signs))
        app_sign = next(s for s in signs if s[-1] == str(APP))
        self.assertIn("--entitlements", app_sign)
        self.assertIn("runtime", app_sign)
        notary = [e[1] for e in events if e[0] == "xcrun"]
        self.assertIn(["notarytool", "submit", "src-tauri/target/BitSov-notary.zip",
                       "--keychain-profile", "test-profile", "--wait"], notary)
        self.assertIn(["stapler", "staple", str(APP)], notary)
        staple = next(i for i, e in enumerate(events) if e[0] == "xcrun" and e[1] == ["stapler", "staple", str(APP)])
        self.assertTrue(any(i > staple and e[0] == "codesign" and "--verify" in e[1]
                            for i, e in enumerate(events)))

    def test_profile_and_certificate_refusals_stop_before_packaging(self):
        for scenario, profile in [("success", ""), ("wrong-certificate", "profile.provisionprofile")]:
            result, events, _ = self.run_package(scenario, signing_env={
                "BITSOV_MAC_SIGNING_IDENTITY": "Developer ID Application: Test",
                "BITSOV_MAC_PROVISION_PROFILE": profile})
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_notarization_cannot_succeed_with_adhoc_or_failed_submission(self):
        for scenario, identity in (("success", "-"), ("notary-fail", "Developer ID Application: Test")):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario, signing_env={
                    "BITSOV_MAC_SIGNING_IDENTITY": identity, "BITSOV_MAC_NOTARY_PROFILE": "test-profile"})
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_build_environment_overrides_conflicting_caller_settings(self):
        result, events, _ = self.run_package("success")
        self.assertEqual(result.returncode, 0, result.stdout)
        build = next(e for e in events if e[0] == "npm" and "build" in e[1])
        self.assertEqual(build[2:4], ["true", "false"])
        self.assertTrue(build[4].endswith("/src-tauri/target"), build)

    def test_app_only_never_uses_hdiutil(self):
        result, events, image = self.run_package("success", dmg=False)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIsNone(image)
        self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_unrelated_failures_never_create_an_image(self):
        for scenario in ("install-fail", "compile-fail", "invalid-app", "other-bundle-fail",
                         "logging-fail"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("PACKAGE: PASS", result.stdout)
                self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_creation_and_verification_failures_are_fatal(self):
        for scenario, operations in (("create-fail", ["create"]),
                                     ("verify-fail", ["create", "verify"])):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("PACKAGE: PASS", result.stdout)
                self.assertEqual([e[1][0] for e in events if e[0] == "hdiutil"], operations)


if __name__ == "__main__":
    unittest.main()
