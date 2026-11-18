#!/usr/bin/env python3
"""Exercise local packaging guards and output using temporary build fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("build-local-mac-arm64.py")


class LocalArmBuild(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "native arm64 local builder is missing")
        spec = importlib.util.spec_from_file_location("local_arm_build", SCRIPT)
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def resources(self, load=0, free=120 * 1024**3):
        stack = __import__("contextlib").ExitStack()
        stack.enter_context(patch.object(os, "getloadavg", return_value=(load, 0, 0)))
        stack.enter_context(patch.object(self.builder.shutil, "disk_usage",
                                        return_value=(200 * 1024**3, 0, free)))
        return stack

    def test_load_boundary_refuses_before_any_command(self):
        for load in (20, 21, float("nan")):
            with self.subTest(load=load), self.resources(load=load):
                with self.assertRaises(RuntimeError):
                    self.builder.check_resources()
        with self.resources(load=19.99):
            self.builder.check_resources()

    def test_disk_floor_and_unreadable_load_refuse(self):
        with self.resources(free=110 * 1024**3 - 1):
            with self.assertRaises(RuntimeError):
                self.builder.check_resources()
        with self.resources(free=110 * 1024**3):
            self.builder.check_resources()
        with patch.object(os, "getloadavg", side_effect=OSError("unavailable")):
            with self.assertRaises(RuntimeError):
                self.builder.check_resources()

    def test_only_native_arm64_mac_is_supported(self):
        for system, machine in (("Linux", "aarch64"), ("Darwin", "x86_64")):
            with patch.object(self.builder.platform, "system", return_value=system), \
                 patch.object(self.builder.platform, "machine", return_value=machine):
                with self.assertRaises(RuntimeError):
                    self.builder.check_host()

    def test_shared_lock_refuses_a_second_build_and_releases_after_error(self):
        lock = self.root / "build.lock"
        with self.builder.build_lock(lock):
            with self.assertRaises(RuntimeError):
                with self.builder.build_lock(lock):
                    self.fail("second build started")
        with self.builder.build_lock(lock):
            pass

    def test_commands_run_with_reduced_priority(self):
        output = self.root / "priority"
        with self.resources():
            self.builder.run([sys.executable, "-c",
                              "import os,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpriority(os.PRIO_PROCESS,0)))",
                              str(output)], self.root, os.environ.copy(), time.monotonic() + 10)
        self.assertGreaterEqual(int(output.read_text()), 10)

    def test_timeout_stops_the_entire_process_group(self):
        marker = self.root / "survived"
        child = "import pathlib,sys,time; time.sleep(1); pathlib.Path(sys.argv[1]).touch()"
        parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]]); time.sleep(10)"
        with self.resources():
            with self.assertRaises(RuntimeError):
                self.builder.run([sys.executable, "-c", parent, child, str(marker)],
                                 self.root, os.environ.copy(), time.monotonic() + 0.2)
        time.sleep(1.1)
        self.assertFalse(marker.exists())

    def test_timeout_kills_a_descendant_that_ignores_termination(self):
        marker = self.root / "survived"
        child = "import pathlib,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(1.5); pathlib.Path(sys.argv[1]).touch()"
        parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]]); time.sleep(10)"
        with self.resources(), self.assertRaises(RuntimeError):
            self.builder.run([sys.executable, "-c", parent, child, str(marker)],
                             self.root, os.environ.copy(), time.monotonic() + 0.4)
        time.sleep(1.6)
        self.assertFalse(marker.exists())

    def test_expired_deadline_never_starts_a_command(self):
        marker = self.root / "started"
        with self.resources(), self.assertRaises(RuntimeError):
            self.builder.run(["touch", str(marker)], self.root, os.environ.copy(), time.monotonic() - 1)
        self.assertFalse(marker.exists())

    def test_high_load_before_each_command_prevents_execution(self):
        marker = self.root / "started"
        with self.resources(load=20), self.assertRaises(RuntimeError):
            self.builder.run(["touch", str(marker)], self.root, os.environ.copy(), time.monotonic() + 10)
        self.assertFalse(marker.exists())

    def test_low_disk_during_command_stops_children(self):
        with self.resources(free=109 * 1024**3), self.assertRaises(RuntimeError):
            self.builder.run([sys.executable, "-c", "import time; time.sleep(10)"],
                             self.root, os.environ.copy(), time.monotonic() + 5)

    def test_bundle_identity_native_binary_and_sidecar_absence(self):
        app = self.root / "BitSov Remote Test.app"
        binary = app / "Contents/MacOS/bitsov-app"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"native executable")
        info = app / "Contents/Info.plist"
        data = {"CFBundleIdentifier": "tech.mindlink.bitsov.remotetest"}
        info.write_bytes(plistlib.dumps(data))
        with patch.object(subprocess, "check_output", return_value="arm64\n"):
            self.builder.verify_bundle(app)
            data["CFBundleIdentifier"] = "tech.mindlink.bitsov"
            info.write_bytes(plistlib.dumps(data))
            with self.assertRaises(RuntimeError):
                self.builder.verify_bundle(app)
            data["CFBundleIdentifier"] = "tech.mindlink.bitsov.remotetest"
            info.write_bytes(plistlib.dumps(data))
            (binary.parent / "konsensus").touch()
            with self.assertRaises(RuntimeError):
                self.builder.verify_bundle(app)
            (binary.parent / "konsensus").unlink()
        for arch in ("x86_64\n", "x86_64 arm64\n"):
            with patch.object(subprocess, "check_output", return_value=arch), self.assertRaises(RuntimeError):
                self.builder.verify_bundle(app)

    def test_build_selects_remote_profile_and_writes_verified_local_manifest(self):
        target, output = self.root / "target", self.root / "artifacts"
        source = self.root / "source"
        source.mkdir()
        commands = []
        def external(command, root, env, deadline):
            commands.append(command)
            self.assertEqual(env["CARGO_BUILD_JOBS"], "2")
            self.assertEqual(env["CARGO_TARGET_DIR"], str(target))
            self.assertLessEqual(deadline, time.monotonic() + 3600)
            if command[:3] == ["npm", "run", "tauri"]:
                app = target / "aarch64-apple-darwin/release/bundle/macos/BitSov Remote Test.app"
                (app / "Contents/MacOS").mkdir(parents=True)
                (app / "Contents/MacOS/bitsov-app").write_bytes(b"executable")
                (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
                    "CFBundleIdentifier": "tech.mindlink.bitsov.remotetest"}))
            elif command[0] == "ditto":
                Path(command[-1]).write_bytes(b"local archive")
        def probe(command, **kwargs):
            if command[:3] == ["git", "rev-parse", "HEAD"]:
                return "a" * 40 + "\n"
            if command[:2] == ["git", "status"]:
                return ""
            if command[0] == "lipo":
                return "arm64\n"
            return "version fixture\n"
        with self.resources(), patch.object(subprocess, "check_output", side_effect=probe), \
             patch.object(self.builder, "run", side_effect=external):
            self.builder.build(source, target, output)
        self.assertEqual(commands[0], ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"])
        self.assertEqual(commands[1], ["npm", "run", "tauri", "--", "build", "--bundles", "app",
                                      "--no-sign", "--ci", "--target", "aarch64-apple-darwin",
                                      "--config", "src-tauri/tauri.remote-only.conf.json", "--", "--locked"])
        manifest = (output / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(manifest), 2)
        for line in manifest:
            digest, filename = line.split("  ")
            self.assertEqual(hashlib.sha256((output / filename).read_bytes()).hexdigest(), digest)
        self.assertEqual(json.loads((output / "build.json").read_text())["commit"], "a" * 40)

    def test_dirty_source_and_stale_output_are_refused(self):
        source = self.root / "source"
        source.mkdir()
        with patch.object(subprocess, "check_output", return_value=" M changed\n"), \
             patch.object(self.builder, "run") as run:
            with self.assertRaises(RuntimeError):
                self.builder.build(source, self.root / "target", self.root / "out")
            run.assert_not_called()
        output = self.root / "out"
        output.mkdir()
        with self.assertRaises(RuntimeError):
            self.builder.build(source, self.root / "target", output)

    def test_failed_build_leaves_no_artifact_manifest(self):
        source, target, output = [self.root / name for name in ("source", "target", "output")]
        source.mkdir()
        with patch.object(subprocess, "check_output", side_effect=["", "a" * 40]), \
             patch.object(self.builder, "run", side_effect=RuntimeError("compile failed")):
            with self.assertRaises(RuntimeError):
                self.builder.build(source, target, output)
        self.assertFalse(output.exists())

    def test_source_ancestors_and_overlapping_output_directories_are_refused(self):
        source = self.root / "source"
        source.mkdir()
        for target, output in ((self.root, self.root.with_name(self.root.name + "-out")),
                               (self.root / "target", self.root / "target/out"),
                               (self.root / "out/target", self.root / "out")):
            with self.subTest(target=target, output=output), \
                 patch.object(self.builder, "run") as run:
                with self.assertRaises(RuntimeError):
                    self.builder.build(source, target, output)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
