#!/usr/bin/env python3
"""Exercise local packaging guards and output using temporary build fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("build-local-mac-arm64.py")


class LocalArmBuild(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "native arm64 local builder is missing")
        spec = importlib.util.spec_from_file_location("local_arm_build", SCRIPT)
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.source_probe = self.builder.probe
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env_patch = patch.dict(os.environ, {"CARGO_HOME": str(self.root / "cargo-cache")})
        env_patch.start()
        self.addCleanup(env_patch.stop)

    def resources(self, load=0, free=120 * 1024**3):
        stack = __import__("contextlib").ExitStack()
        stack.enter_context(patch.object(os, "getloadavg", return_value=(load, 0, 0)))
        stack.enter_context(patch.object(self.builder.shutil, "disk_usage",
                                        return_value=(200 * 1024**3, 0, free)))
        stack.enter_context(patch.object(self.builder, "check_no_other_builds"))
        return stack

    def test_existing_compilation_refuses_before_start(self):
        for process in ("R /usr/bin/rustc\n", "S /usr/bin/cargo\n", "R /usr/bin/clippy-driver\n"):
            with self.subTest(process=process), patch.object(subprocess, "check_output", return_value=process):
                with self.assertRaises(RuntimeError):
                    self.builder.check_no_other_builds()
        with patch.object(subprocess, "check_output", return_value="Z /usr/bin/cargo\nS /usr/bin/other\n"):
            self.builder.check_no_other_builds()

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
        command, pidfile, marker = self.group_command(False)
        with self.resources():
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                self.builder.run(command, self.root, os.environ.copy(), time.monotonic() + 3)
        self.assertTrue(pidfile.exists(), "descendant must be ready before timeout")
        self.assert_process_stopped(int(pidfile.read_text()))
        self.assertFalse(marker.exists())

    def test_timeout_kills_a_descendant_that_ignores_termination(self):
        command, pidfile, marker = self.group_command(True)
        with self.resources(), self.assertRaisesRegex(RuntimeError, "deadline"):
            self.builder.run(command, self.root, os.environ.copy(), time.monotonic() + 3)
        self.assertTrue(pidfile.exists(), "descendant must install its handler before timeout")
        self.assert_process_stopped(int(pidfile.read_text()))
        self.assertFalse(marker.exists())

    def group_command(self, ignore_term):
        pidfile, marker = self.root / "descendant.pid", self.root / "survived"
        child = ("import os,pathlib,signal,sys,time; "
                 + ("signal.signal(signal.SIGTERM,signal.SIG_IGN); " if ignore_term else "")
                 + "p=pathlib.Path(sys.argv[1]); t=p.with_suffix('.tmp'); t.write_text(str(os.getpid())); t.replace(p); time.sleep(20); pathlib.Path(sys.argv[2]).touch()")
        parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',*sys.argv[1:]]); time.sleep(30)"
        return [sys.executable, "-c", parent, child, str(pidfile), str(marker)], pidfile, marker

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

    def test_archive_step_after_compilation_ignores_load_but_keeps_disk_floor(self):
        marker = self.root / "archived"
        with self.resources(load=20), patch.object(self.builder, "check_no_other_builds",
                                                   side_effect=RuntimeError("busy")):
            self.builder.run(["touch", str(marker)], self.root, os.environ.copy(),
                             time.monotonic() + 10, gate=False)
        self.assertTrue(marker.exists())
        marker.unlink()
        with self.resources(free=109 * 1024**3), self.assertRaisesRegex(RuntimeError, "free disk"):
            self.builder.run(["touch", str(marker)], self.root, os.environ.copy(),
                             time.monotonic() + 10, gate=False)
        self.assertFalse(marker.exists())

    def test_low_disk_during_command_stops_children(self):
        command, pidfile, marker = self.group_command(True)
        def disk(_):
            return (200 * 1024**3, 0, (109 if pidfile.exists() else 120) * 1024**3)
        with self.resources(), patch.object(self.builder.shutil, "disk_usage", side_effect=disk), \
             self.assertRaisesRegex(RuntimeError, "free disk"):
            self.builder.run(command, self.root, os.environ.copy(), time.monotonic() + 5)
        self.assertTrue(pidfile.exists(), "disk must drop after the descendant starts")
        self.assert_process_stopped(int(pidfile.read_text()))
        self.assertFalse(marker.exists())

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
        (source / "src-tauri").mkdir()
        (source / "src-tauri/tauri.remote-only.conf.json").write_text("{}")
        commands = []
        def external(command, root, env, deadline, gate=True):
            commands.append(command)
            # Only post-compile steps (seal, archive) may skip the load and build gates.
            self.assertEqual(gate, command[0] not in ("ditto", "codesign"))
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
                app = Path(command[-2])
                with zipfile.ZipFile(command[-1], "w") as archive:
                    for path in app.rglob("*"):
                        if path.is_file():
                            archive.write(path, f"{app.name}/{path.relative_to(app).as_posix()}")
        def probe(command, **kwargs):
            if command[:3] == ["git", "rev-parse", "HEAD"]:
                return "a" * 40 + "\n"
            if command[:2] == ["git", "status"]:
                return ""
            if command[0] == "lipo":
                return "arm64\n"
            if command[0] == "codesign":
                probes.append(command)
                return ""
            return "version fixture\n"
        probes = []
        with self.resources(), patch.object(subprocess, "check_output", side_effect=probe), \
             patch.object(self.builder, "run", side_effect=external):
            self.builder.build(source, target, output)
        self.assertEqual(commands[0], ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"])
        app = str(target / "aarch64-apple-darwin/release/bundle/macos/BitSov Remote Test.app")
        # The bundle is sealed ad-hoc (no identity) and must verify strictly before it is archived.
        self.assertEqual(commands[2], ["codesign", "--force", "--deep", "--sign", "-", app])
        self.assertEqual(probes, [["codesign", "--verify", "--deep", "--strict", app]])
        self.assertEqual(commands[3][0], "ditto")
        self.assertEqual(json.loads((output / "build.json").read_text())["signing"], "ad-hoc")
        self.assertEqual(commands[1], ["npm", "run", "tauri", "--", "build", "--bundles", "app",
                                      "--no-sign", "--ci", "--target", "aarch64-apple-darwin",
                                      "--config", "src-tauri/tauri.remote-only.conf.json", "--", "--locked"])
        manifest = (output / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(manifest), 2)
        for line in manifest:
            digest, filename = line.split("  ")
            self.assertEqual(hashlib.sha256((output / filename).read_bytes()).hexdigest(), digest)
        self.assertEqual(json.loads((output / "build.json").read_text())["commit"], "a" * 40)

    def test_a_bundle_that_does_not_verify_strictly_is_never_archived(self):
        app = self.root / "BitSov Remote Test.app"
        def failing(command, **kwargs):
            raise subprocess.CalledProcessError(1, command, "code has no resources but signature indicates they must be present")
        with patch.object(subprocess, "check_output", side_effect=failing), \
             self.assertRaisesRegex(RuntimeError, "does not verify"):
            self.builder.verify_seal(app)

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

    def test_build_environment_excludes_overrides(self):
        with patch.dict(os.environ, {"RUSTFLAGS": "override", "RUSTC_WRAPPER": "override",
                                    "CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS": "true",
                                    "TAURI_CONFIG": "override", "VITE_CALL_SEAL": "override",
                                    "BITSOV_TEST": "override"}):
            env = self.builder.build_environment(self.root / "target")
        for name in ("RUSTFLAGS", "RUSTC_WRAPPER", "CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS",
                     "TAURI_CONFIG", "VITE_CALL_SEAL", "BITSOV_TEST"):
            self.assertNotIn(name, env)
        self.assertEqual(env["CARGO_BUILD_JOBS"], "2")

    def test_environment_files_and_external_cargo_config_are_refused_without_reading(self):
        source = self.root / "source"
        source.mkdir()
        config = self.root / ".cargo/config.toml"
        config.parent.mkdir()
        config.touch(mode=0)
        with self.assertRaises(RuntimeError):
            self.builder.check_inputs(source)
        config.unlink()
        (source / ".env.production.local").touch(mode=0)
        with self.assertRaises(RuntimeError):
            self.builder.check_inputs(source)

    def test_tauri_directory_cargo_config_is_refused(self):
        source = self.root / "source"
        config = source / "src-tauri/.cargo/config.toml"
        config.parent.mkdir(parents=True)
        config.touch(mode=0)
        with self.assertRaises(RuntimeError):
            self.builder.check_inputs(source)

    def test_cancellation_during_cleanup_mask_change_still_stops_children(self):
        command, pidfile, _ = self.group_command(True)
        real_mask = signal.pthread_sigmask
        original_mask = real_mask(signal.SIG_BLOCK, set())
        blocks = 0
        def interrupted_mask(how, mask):
            nonlocal blocks
            previous = real_mask(how, mask)
            if how == signal.SIG_BLOCK:
                blocks += 1
                if blocks == 2:
                    raise SystemExit(143)
            return previous
        try:
            with self.resources(), patch.object(signal, "pthread_sigmask", side_effect=interrupted_mask), \
                 self.assertRaises(SystemExit):
                self.builder.run(command, self.root, os.environ.copy(), time.monotonic() + 3)
            self.assertTrue(pidfile.exists())
            self.assert_process_stopped(int(pidfile.read_text()))
        finally:
            real_mask(signal.SIG_SETMASK, original_mask)
            if pidfile.exists():
                try:
                    group = os.getpgid(int(pidfile.read_text()))
                    os.killpg(group, signal.SIGKILL)
                    try:
                        os.waitpid(group, 0)
                    except ChildProcessError:
                        pass
                except ProcessLookupError:
                    pass
    def test_changed_source_head_or_worktree_prevents_finalization(self):
        for values in ((" M edited",), ("", "b" * 40)):
            with self.subTest(values=values), patch.object(subprocess, "check_output", side_effect=values):
                with self.assertRaises(RuntimeError):
                    self.builder.check_source(self.root, "a" * 40,
                                              env=self.builder.build_environment(self.root / "target"))

    def source_repository(self, name):
        source = self.root / name
        source.mkdir(parents=True)
        (source / "input").write_text("original")
        (source / "src-tauri").mkdir()
        (source / "src-tauri/tauri.remote-only.conf.json").write_text("{}")
        env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
        def git(*args):
            return subprocess.check_output(["git", "-c", "user.name=Package tests", "-c",
                                            "user.email=package-tests@example.invalid", *args], cwd=source,
                                           env=env, text=True, stderr=subprocess.DEVNULL).strip()
        git("init", "-q")
        git("add", "input", "src-tauri")
        git("commit", "-q", "-m", "Fixture input")
        return source, git

    def package_fixture_command(self, command, root, env, deadline, gate=True):
        app = Path(env["CARGO_TARGET_DIR"]) / self.builder.TARGET / "release/bundle/macos/BitSov Remote Test.app"
        if command[:3] == ["npm", "run", "tauri"]:
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/MacOS/bitsov-app").write_bytes(b"fixture executable")
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "tech.mindlink.bitsov.remotetest"}))
        elif command[0] == "ditto":
            with zipfile.ZipFile(command[-1], "w") as archive:
                for path in app.rglob("*"):
                    if path.is_file():
                        archive.write(path, f"{app.name}/{path.relative_to(app).as_posix()}")

    def package_fixture_probe(self, command, root, env=None):
        if command[0] == "git":
            return self.source_probe(command, root, env)
        return "arm64" if command[0] == "lipo" else "fixture version"

    def test_git_overrides_do_not_hide_dirty_source(self):
        for mode in ("repository", "worktree", "index"):
            with self.subTest(mode=mode):
                source, git = self.source_repository(f"{mode}/source")
                foreign, _ = self.source_repository(f"{mode}/foreign")
                (source / "input").write_text("edited")
                overrides = {"GIT_WORK_TREE": str(foreign)}
                if mode == "repository":
                    overrides["GIT_DIR"] = str(foreign / ".git")
                elif mode == "index":
                    git("add", "input")
                    (source / "input").write_text("original")
                    overrides = {"GIT_INDEX_FILE": str(foreign / ".git/index")}
                with patch.dict(os.environ, overrides), \
                     patch.object(self.builder, "run", side_effect=RuntimeError("Fixture build started")) as run:
                    with self.assertRaisesRegex(RuntimeError, "Commit source changes"):
                        self.builder.build(source, self.root / "target", self.root / "output")
                    run.assert_not_called()

    def test_git_overrides_do_not_hide_source_commit_changes(self):
        for phase in ("compile", "archive"):
            with self.subTest(phase=phase):
                source, git = self.source_repository(f"{phase}/source")
                foreign, foreign_git = self.source_repository(f"{phase}/foreign")
                foreign_git("commit", "--allow-empty", "-q", "-m", "Foreign fixture update")
                def external(command, *args, **kwargs):
                    self.package_fixture_command(command, *args, **kwargs)
                    if ((phase == "compile" and command[:3] == ["npm", "run", "tauri"])
                            or (phase == "archive" and command[0] == "ditto")):
                        git("commit", "--allow-empty", "-q", "-m", "Fixture update")
                overrides = {"GIT_DIR": str(foreign / ".git"), "GIT_WORK_TREE": str(foreign),
                             "GIT_INDEX_FILE": str(foreign / ".git/index")}
                output = self.root / phase / "output"
                with self.resources(), patch.dict(os.environ, overrides), \
                     patch.object(self.builder, "run", side_effect=external) as run, \
                     patch.object(self.builder, "probe", side_effect=self.package_fixture_probe):
                    with self.assertRaisesRegex(RuntimeError, "The source commit changed"):
                        self.builder.build(source, self.root / phase / "target", output)
                if phase == "compile":
                    self.assertNotIn("ditto", [call.args[0][0] for call in run.call_args_list])
                self.assertFalse(output.exists())

    def test_git_overrides_do_not_change_recorded_source_commit(self):
        source, git = self.source_repository("source")
        foreign, foreign_git = self.source_repository("foreign")
        foreign_git("commit", "--allow-empty", "-q", "-m", "Foreign fixture update")
        expected = git("rev-parse", "HEAD")
        overrides = {"GIT_DIR": str(foreign / ".git"), "GIT_WORK_TREE": str(foreign),
                     "GIT_INDEX_FILE": str(foreign / ".git/index")}
        output = self.root / "output"
        with self.resources(), patch.dict(os.environ, overrides), \
             patch.object(self.builder, "run", side_effect=self.package_fixture_command), \
             patch.object(self.builder, "probe", side_effect=self.package_fixture_probe):
            self.builder.build(source, self.root / "target", output)
        self.assertEqual(json.loads((output / "build.json").read_text())["commit"], expected)

    def start_supervisor(self, seconds=10):
        pidfile, marker, lock = [self.root / name for name in ("child.pid", "survived", "build.lock")]
        pidfile.unlink(missing_ok=True)
        program = '''
import importlib.util,os,pathlib,sys,time
spec=importlib.util.spec_from_file_location("builder",sys.argv[1])
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
b.os.getloadavg=lambda:(0,0,0)
b.shutil.disk_usage=lambda _: (200*1024**3,0,120*1024**3)
b.check_no_other_builds=lambda:None
b.install_handlers()
child="import os,pathlib,sys,time; p=pathlib.Path(sys.argv[1]); p.with_name('worker.pid').write_text(str(os.getppid())); t=p.with_suffix('.tmp'); t.write_text(str(os.getpid())); t.replace(p); time.sleep(20); pathlib.Path(sys.argv[2]).touch()"
with b.build_lock(pathlib.Path(sys.argv[4])):
    b.supervise(lambda: b.run([sys.executable,"-c",child,sys.argv[2],sys.argv[3]],pathlib.Path.cwd(),os.environ.copy(),time.monotonic()+30),int(sys.argv[5]))
'''
        process = subprocess.Popen([sys.executable, "-c", program, str(SCRIPT), str(pidfile),
                                    str(marker), str(lock), str(seconds)], stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        deadline = time.monotonic() + 4
        while not pidfile.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(pidfile.exists(), "build child must be running before interruption")
        return process, int(pidfile.read_text()), marker, lock

    def assert_process_stopped(self, pid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.02)
        self.fail("build child survived interruption")

    def test_terminal_and_termination_signals_stop_the_build(self):
        for sig in (signal.SIGHUP, signal.SIGQUIT, signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig):
                process, child, marker, _ = self.start_supervisor()
                process.send_signal(sig)
                self.assertNotEqual(process.wait(timeout=5), 0)
                self.assert_process_stopped(child)
                self.assertFalse(marker.exists())

    def test_parent_death_keeps_lock_until_worker_deadline_stops_build(self):
        process, child, marker, lock = self.start_supervisor(seconds=2)
        process.kill()
        process.wait(timeout=5)
        with self.assertRaises(RuntimeError):
            with self.builder.build_lock(lock):
                self.fail("orphaned worker lost the build lock")
        self.assert_process_stopped(child)
        deadline = time.monotonic() + 3
        while True:
            try:
                with self.builder.build_lock(lock):
                    break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)
        self.assertFalse(marker.exists())

    def test_repeated_cancellation_of_worker_and_launcher_stops_build(self):
        for _ in range(3):
            process, child, marker, _ = self.start_supervisor()
            worker = int((self.root / "worker.pid").read_text())
            os.kill(worker, signal.SIGTERM)
            process.send_signal(signal.SIGTERM)
            self.assertNotEqual(process.wait(timeout=5), 0)
            self.assert_process_stopped(child)
            self.assertFalse(marker.exists())

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

    def test_archive_must_contain_the_checked_app_bytes(self):
        app = self.root / "App.app"
        app.mkdir()
        (app / "file").write_bytes(b"checked")
        archive = self.root / "app.zip"
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("App.app/file", b"different")
        with self.assertRaises(RuntimeError):
            self.builder.verify_archive(archive, app)

    def test_edit_or_checkout_during_compilation_prevents_artifact_finalization(self):
        for mode in ("edit", "commit"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(dir=self.root) as temp:
                base = Path(temp)
                source, target, output = [base / name for name in ("source", "target", "output")]
                source.mkdir()
                tracked = source / "input"
                tracked.write_text("original")
                def git(*args):
                    subprocess.run(["git", "-c", "user.name=Package tests", "-c",
                                    "user.email=package-tests@example.invalid", *args], cwd=source,
                                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                git("init", "-q")
                git("add", "input")
                git("commit", "-q", "-m", "Fixture input")
                def external(command, *_):
                    if command[:3] == ["npm", "run", "tauri"]:
                        if mode == "edit":
                            tracked.write_text("edited")
                        else:
                            git("commit", "--allow-empty", "-q", "-m", "Fixture update")
                with patch.object(self.builder, "run", side_effect=external):
                    with self.assertRaises(RuntimeError):
                        self.builder.build(source, target, output)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
