#!/usr/bin/env python3
"""Exercise the real packaging script without builds, downloads, mounts or ports."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


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
                       os.environ.get("TAURI_BUNDLER_DMG_IGNORE_CI")]) + "\n")
app = pathlib.Path("src-tauri/target/release/bundle/macos/BitSov.app")
dmg = pathlib.Path("src-tauri/target/release/bundle/dmg/BitSov_0.0.1_aarch64.dmg")
if name == "uname":
    print("Darwin" if args == ["-s"] else "arm64")
elif name == "npm":
    if args == ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]:
        sys.exit(17 if scenario == "install-fail" else 0)
    assert args in (["run", "tauri", "--", "build", "--bundles", b,
                    "--no-sign", "--ci", "--", "--locked"] for b in ("app", "app,dmg")), args
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
        plistlib.dump({"LSMinimumSystemVersion": "11.0"}, f)
    pathlib.Path("dist").mkdir(exist_ok=True)
    pathlib.Path("dist/index.html").write_text("release")
    if scenario == "invalid-app":
        binary.unlink()
    if "app,dmg" in args:
        dmg.parent.mkdir(parents=True)
        (dmg.parent / "bundle_dmg.sh").write_text("# generated\n")
        if scenario in ("fallback", "invalid-app", "create-fail", "verify-fail", "missing-script", "logging-fail"):
            dmg.write_text("partial image")
            if scenario == "missing-script":
                (dmg.parent / "bundle_dmg.sh").unlink()
            print("error running bundle_dmg.sh", file=sys.stderr)
            sys.exit(1)
        if scenario == "other-bundle-fail":
            print("other bundler failure", file=sys.stderr)
            sys.exit(24)
        if scenario != "missing-dmg":
            dmg.write_text("tauri image")
elif name == "hdiutil":
    if args[0] == "create":
        assert args[args.index("-srcfolder") + 1] == str(app), args
        assert args[args.index("-format") + 1] == "UDZO", args
        assert args[args.index("-volname") + 1] == "BitSov", args
        assert args[-1] == str(dmg), args
        assert not dmg.exists(), "partial DMG was not removed"
        assert app.is_dir()
        if scenario == "create-fail":
            sys.exit(31)
        dmg.write_text("fallback image")
    elif args == ["verify", str(dmg)]:
        assert dmg.stat().st_size
        if scenario in ("verify-fail", "primary-verify-fail"):
            sys.exit(32)
    else:
        sys.exit("unexpected hdiutil operation: " + repr(args))
elif name == "plutil":
    with open(args[-1], "rb") as f:
        p = plistlib.load(f)
    if args[0] == "-extract":
        print(p[args[1]])
elif name not in ("file", "otool", "codesign"):
    sys.exit("forbidden command: " + name)
'''


class PackagingTests(unittest.TestCase):
    def run_package(self, scenario, dmg=True):
        with tempfile.TemporaryDirectory(prefix="package mac test ") as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            for name in ("package-mac.sh", "check-mac-bundle.sh"):
                shutil.copy2(ROOT / "scripts" / name, root / "scripts" / name)
            (root / "src-tauri/bin").mkdir(parents=True)
            shutil.copy2(ROOT / "src-tauri/tauri.conf.json", root / "src-tauri/tauri.conf.json")
            sidecar = root / "src-tauri/bin/konsensus-aarch64-apple-darwin"
            sidecar.write_text('#!/bin/sh\necho NODE_LAUNCHED >> "$TRACE"\nexit 99\n')
            sidecar.chmod(0o755)
            # Stale outputs must never let an unsuccessful build pass.
            (root / APP).mkdir(parents=True)
            (root / DMG).parent.mkdir(parents=True)
            (root / DMG).write_text("stale image")
            if scenario == "logging-fail":
                (root / "src-tauri/target/package-mac.log").mkdir()
            fakebin = root / "fakebin"
            fakebin.mkdir()
            for name in ("uname", "npm", "hdiutil", "plutil", "file", "otool", "codesign",
                         "open", "osascript", "vite", "curl", "cargo"):
                tool = fakebin / name
                tool.write_text(STUB)
                tool.chmod(0o755)
            trace = root / "trace.jsonl"
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", TRACE=str(trace),
                       SCENARIO=scenario, CI="false", TAURI_BUNDLER_DMG_IGNORE_CI="true")
            result = subprocess.run(
                ["bash", "scripts/package-mac.sh", "--use-existing-sidecar"] + (["--dmg"] if dmg else []),
                cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            events = [json.loads(line) for line in trace.read_text().splitlines()]
            self.assertTrue(all(e[0] in ("uname", "npm", "hdiutil", "plutil", "file", "otool", "codesign")
                                for e in events), events)
            image = (root / DMG).read_text() if (root / DMG).exists() else None
            return result, events, image

    def test_fallback_recovers_dmg_script_failure(self):
        result, events, image = self.run_package("fallback")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(image, "fallback image")
        self.assertIn("falling back", result.stdout.lower())
        self.assertEqual([e[1][0] for e in events if e[0] == "hdiutil"], ["create", "verify"])

    def test_finder_is_disabled_even_with_conflicting_environment(self):
        result, events, _ = self.run_package("success")
        self.assertEqual(result.returncode, 0, result.stdout)
        build = next(e for e in events if e[0] == "npm" and "build" in e[1])
        self.assertEqual(build[2:], ["true", "false"])

    def test_primary_dmg_is_verified_without_fallback(self):
        result, events, image = self.run_package("success")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(image, "tauri image")
        self.assertEqual([e[1][0] for e in events if e[0] == "hdiutil"], ["verify"])

    def test_app_only_never_uses_hdiutil(self):
        result, events, image = self.run_package("success", dmg=False)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIsNone(image)
        self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_unrelated_failures_never_create_an_image(self):
        for scenario in ("install-fail", "compile-fail", "invalid-app", "other-bundle-fail",
                         "missing-script", "missing-dmg", "logging-fail"):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("PACKAGE: PASS", result.stdout)
                self.assertFalse(any(e[0] == "hdiutil" for e in events))

    def test_creation_and_verification_failures_are_fatal(self):
        for scenario, operations in (("create-fail", ["create"]),
                                     ("verify-fail", ["create", "verify"]),
                                     ("primary-verify-fail", ["verify"])):
            with self.subTest(scenario=scenario):
                result, events, _ = self.run_package(scenario)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn("PACKAGE: PASS", result.stdout)
                self.assertEqual([e[1][0] for e in events if e[0] == "hdiutil"], operations)


if __name__ == "__main__":
    unittest.main()
