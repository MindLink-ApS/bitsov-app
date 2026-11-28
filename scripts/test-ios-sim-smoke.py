#!/usr/bin/env python3
"""Exercise smoke orchestration without Xcode services or signing access."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parent / "ios-sim-smoke.sh"
NODE = shutil.which("node")
FAKE_TOOL = r'''#!/usr/bin/env python3
import json, os, pathlib, plistlib, struct, sys, zlib
def png(screen):
    # 40x80 RGBA: a flat background, plus a dark block unless the screen is flat.
    width, height = 40, 80
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            if screen == "black":
                pixel = (0, 0, 0, 255)
            elif screen != "flat" and 30 <= y < 50 and 5 <= x < 35:
                pixel = (20, 20, 20, 255)
            else:
                pixel = (250, 249, 246, 255)
            row += bytes(pixel)
        rows.append(b"\x00" + bytes(row))
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))
tool, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps([tool, *args]) + "\n")
if os.environ.get("FAIL_TOOL") == tool:
    sys.exit(9)
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
if tool == "xcodebuild":
    if args == ["-version"]:
        print("Xcode test")
    else:
        app = root / "test-results/ios-smoke/derived-data/Build/Products/debug-iphonesimulator/BitSov.app"
        app.mkdir(parents=True, exist_ok=True)
        (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "tech.mindlink.bitsov"}))
elif tool == "rustup":
    print("aarch64-apple-ios-sim\nx86_64-apple-ios")
elif tool == "cargo":
    if args == ["--version"]:
        print("cargo test")
    else:
        target = args[args.index("--target") + 1]
        lib = pathlib.Path(os.environ["CARGO_TARGET_DIR"]) / target / "debug/libbitsov_app.a"
        lib.parent.mkdir(parents=True, exist_ok=True)
        lib.write_bytes(b"library")
elif tool == "npm":
    if args == ["--version"]:
        print("10.0.0")
elif tool == "xcrun":
    if args == ["--sdk", "iphonesimulator", "--show-sdk-path"]:
        print("/simulator-sdk")
    elif args == ["simctl", "list", "devices", "available", "--json"]:
        devices = [
            {"udid": "IPAD", "name": "iPad", "isAvailable": True, "state": "Booted", "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPad"},
            {"udid": "DUO", "name": "Foldable", "isAvailable": True, "state": "Booted", "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"},
            {"udid": "PHONE", "name": "Smoke phone", "isAvailable": True, "state": os.environ.get("PHONE_STATE", "Shutdown"), "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16"},
        ]
        print(json.dumps({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-18-0": devices}}))
    elif args[:4] == ["simctl", "io", "PHONE", "screenshot"]:
        pathlib.Path(args[4]).write_bytes(png(os.environ.get("SCREEN", "app")))
elif tool == "lsof":
    sys.exit(0 if os.environ.get("PORT_BUSY") == "1" else 1)
elif tool == "mdfind":
    print(os.environ.get("SIMULATOR_APP", ""))
elif tool == "xcode-select":
    print(root / "no-developer-dir")
'''


class SmokeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ios-smoke-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        # A missing implementation must fail the behavior tests, not fixture setup.
        self.script = SOURCE if not SOURCE.exists() else self.root / "scripts/ios-sim-smoke.sh"
        if SOURCE.exists():
            shutil.copy2(SOURCE, self.script)
        check = SOURCE.parent / "ios-screenshot-check.mjs"
        if check.exists():
            shutil.copy2(check, self.root / "scripts/ios-screenshot-check.mjs")
        apple = self.root / "src-tauri/gen/apple"
        (apple / "bitsov-app.xcodeproj").mkdir(parents=True)
        (self.root / "src-tauri/tauri.ios.conf.json").write_text('{"bundle":{"externalBin":[]}}')
        (self.root / "node_modules/.bin").mkdir(parents=True)
        (self.root / "node_modules/.bin/vite").touch()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("xcodebuild", "xcrun", "cargo", "rustup", "npm", "mdfind", "xcode-select", "open", "lsof"):
            tool = self.bin / name
            tool.write_text(FAKE_TOOL)
            tool.chmod(0o755)
        (self.bin / "node").symlink_to(NODE)
        self.log = self.root / "calls.jsonl"
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        CALL_LOG=str(self.log), FIXTURE_ROOT=str(self.root))
        self.env.pop("IOS_SIM_UDID", None)
        self.env.pop("IOS_SIM_NO_WINDOW", None)
        self.env.pop("PORT_BUSY", None)
        self.env.update(IOS_SMOKE_SCREENSHOT_ATTEMPTS="2", IOS_SMOKE_SCREENSHOT_DELAY="0")

    def run_smoke(self, *args):
        return subprocess.run(["bash", str(self.script), *args], env=self.env,
                              text=True, capture_output=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_dry_run_needs_no_toolchain_and_writes_nothing(self):
        result = self.run_smoke("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("iphonesimulator", result.stdout)
        self.assertIn("CODE_SIGNING_ALLOWED=NO", result.stdout)
        self.assertIn("screenshot", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.root / "test-results").exists())

    def test_stops_at_first_failure_with_plain_step(self):
        self.env["FAIL_TOOL"] = "xcodebuild"
        result = self.run_smoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Xcode version", result.stderr)
        self.assertEqual(self.calls(), [["xcodebuild", "-version"]])

    def test_unsigned_build_launch_and_capture_on_iphone_only(self):
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls()
        build = next(c for c in calls if c[0] == "xcodebuild" and "build" in c)
        for flag in ("CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "BITSOV_IOS_SIM_PREBUILT=1"):
            self.assertIn(flag, build)
        self.assertEqual(build[build.index("-sdk") + 1], "iphonesimulator")
        self.assertEqual(build[build.index("-configuration") + 1], "debug")
        self.assertNotIn("-allowProvisioningUpdates", build)
        rust = next(c for c in calls if c[:2] == ["cargo", "build"])
        self.assertIn("tauri/custom-protocol", rust)
        self.assertIn(["xcrun", "simctl", "boot", "PHONE"], calls)
        self.assertIn(["xcrun", "simctl", "launch", "--terminate-running-process", "PHONE", "tech.mindlink.bitsov"], calls)
        self.assertTrue((self.root / "test-results/ios-smoke/launch.png").is_file())
        self.assertIn("screenshot shows content", result.stdout)
        self.assertIn("continuing headless", result.stdout)
        self.assertFalse(any(c[0] == "open" for c in calls))

    def test_simulator_entitlements_are_linked_not_signed(self):
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        build = next(c for c in self.calls() if c[0] == "xcodebuild" and "build" in c)
        ldflags = next(a for a in build if a.startswith("OTHER_LDFLAGS="))
        self.assertIn("-sectcreate -Xlinker __TEXT -Xlinker __entitlements", ldflags)
        entitlements = self.root / "test-results/ios-smoke/simulator.entitlements"
        self.assertIn(str(entitlements), ldflags)
        self.assertIn("application-identifier", entitlements.read_text())
        self.assertFalse(any(c[0] in ("codesign", "security") for c in self.calls()))

    def test_skips_foldable_iphone_even_when_booted(self):
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("DUO", json.dumps(self.calls()))
        self.env["IOS_SIM_UDID"] = "DUO"
        result = self.run_smoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("standard (not foldable) iPhone", result.stderr)

    def test_opens_simulator_window_when_present(self):
        app = self.root / "Simulator.app"
        app.mkdir()
        self.env["SIMULATOR_APP"] = str(app)
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["open", "-a", str(app), "--args", "-CurrentDeviceUDID", "PHONE"], self.calls())
        self.env["IOS_SIM_NO_WINDOW"] = "1"
        self.log.unlink()
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c[0] == "open" for c in self.calls()))

    def test_refuses_to_launch_while_host_uses_app_loopback_port(self):
        self.env["PORT_BUSY"] = "1"
        result = self.run_smoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("127.0.0.1:3141", result.stderr)
        calls = self.calls()
        self.assertIn(["lsof", "-nP", "-iTCP@127.0.0.1:3141", "-sTCP:LISTEN"], calls)
        self.assertFalse(any(c[:3] in (["xcrun", "simctl", "install"], ["xcrun", "simctl", "launch"]) for c in calls))

    def test_black_or_blank_screenshot_fails(self):
        for screen, message in (("black", "screenshot is black"), ("flat", "one flat colour")):
            with self.subTest(screen=screen):
                self.env["SCREEN"] = screen
                result = self.run_smoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                shots = [c for c in self.calls() if c[:2] == ["xcrun", "simctl"] and c[2] == "io"]
                self.assertGreaterEqual(len(shots), 2)
                self.log.unlink()

    def test_reuses_booted_iphone(self):
        self.env["PHONE_STATE"] = "Booted"
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(["xcrun", "simctl", "boot", "PHONE"], self.calls())

    def test_refuses_non_iphone_or_real_device_id(self):
        for device in ("IPAD", "REAL-DEVICE"):
            with self.subTest(device=device):
                self.env["IOS_SIM_UDID"] = device
                result = self.run_smoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("iPhone simulator", result.stderr)
                self.assertFalse(any(c[:2] == ["xcrun", "simctl"] and c[2] in ("install", "launch") for c in self.calls()))

    def test_prebuilt_phase_accepts_only_unsigned_simulator(self):
        apple = SOURCE.parent.parent / "src-tauri/gen/apple"
        source = apple / "project.yml"
        phase = source.read_text().split('      - script: |\n', 1)[1]
        phase = '\n'.join(line[10:] for line in phase.splitlines() if line.startswith('          '))
        project = (apple / "bitsov-app.xcodeproj/project.pbxproj").read_text()
        checked_in_phase = json.loads(re.search(r'shellScript = ("(?:\\.|[^"\\])*");', project).group(1))
        lib = self.root / "Externals/arm64/debug/libapp.a"
        lib.parent.mkdir(parents=True)
        lib.write_bytes(b"library")
        env = dict(self.env, BITSOV_IOS_SIM_PREBUILT="1", SRCROOT=str(self.root),
                   ARCHS="arm64", CURRENT_ARCH="undefined_arch", CONFIGURATION="debug")
        for script in (phase, checked_in_phase):
            for platform, signing, expected in (("iphonesimulator", "NO", 0),
                                                 ("iphoneos", "NO", 1),
                                                 ("iphonesimulator", "YES", 1)):
                with self.subTest(platform=platform, signing=signing):
                    env.update(PLATFORM_NAME=platform, CODE_SIGNING_ALLOWED=signing)
                    result = subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, expected, result.stderr)
            env.update(PLATFORM_NAME="iphonesimulator", CODE_SIGNING_ALLOWED="NO")
            for archive in (None, b""):
                lib.unlink(missing_ok=True)
                if archive is not None:
                    lib.write_bytes(archive)
                result = subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
            lib.write_bytes(b"library")
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
