#!/usr/bin/env python3
"""Build an unsigned, local-only arm64 remote signet test archive."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile

TARGET = "aarch64-apple-darwin"
MIN_FREE = 110 * 1024**3
MAX_SECONDS = 3600
HANDLED_SIGNALS = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT, signal.SIGALRM}


def check_host():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("A native arm64 macOS host is required.")


def check_disk():
    if shutil.disk_usage("/")[2] < MIN_FREE:
        raise RuntimeError("At least 110 GiB of free disk is required.")


def check_resources():
    try:
        load = os.getloadavg()[0]
    except OSError as error:
        raise RuntimeError("Cannot determine the system load.") from error
    if not math.isfinite(load) or load >= 20:
        raise RuntimeError("System load must be below 20 before starting.")
    check_disk()


def check_no_other_builds():
    processes = subprocess.check_output(["ps", "-axo", "stat=,comm="], text=True, timeout=15)
    for line in processes.splitlines():
        state, command = line.strip().split(None, 1)
        if not state.startswith("Z") and Path(command).name in {"cargo", "rustc", "cargo-clippy", "clippy-driver"}:
            raise RuntimeError("Another Rust build is active; try again when it finishes.")


@contextmanager
def build_lock(path):
    # Never unlink a lock file: concurrent callers must lock the same inode.
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another local Mac build is already running.") from error
        yield


def run(command, root, env, deadline):
    if time.monotonic() >= deadline:
        raise RuntimeError("The 60-minute build deadline expired.")
    check_resources()
    check_no_other_builds()
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, HANDLED_SIGNALS)
    process = None
    def prepare_child():
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        os.nice(10)
    try:
        process = subprocess.Popen(command, cwd=root, env=env, start_new_session=True,
                                   preexec_fn=prepare_child)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("The 60-minute build deadline expired.")
            try:
                code = process.wait(timeout=min(1, remaining))
                if code:
                    raise RuntimeError(f"Command failed with exit status {code}: {command[0]}")
                check_disk()
                return
            except subprocess.TimeoutExpired:
                check_disk()
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, HANDLED_SIGNALS)
        try:
            if process is not None:
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(process.pid, sig)
                    except ProcessLookupError:
                        break
                    if sig == signal.SIGTERM:
                        time.sleep(0.2)
                        process.poll()
                process.wait()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def install_handlers():
    def cancel(sig, _):
        raise SystemExit(128 + sig)
    def timeout(*_):
        raise RuntimeError("The 60-minute build deadline expired.")
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
        signal.signal(sig, cancel)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGALRM, timeout)


def supervise(action, seconds=MAX_SECONDS):
    # The worker retains the lock and its own deadline if the launcher exits.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, HANDLED_SIGNALS)
    sys.stdout.flush()
    sys.stderr.flush()
    pid = os.fork()
    if pid == 0:
        code = 0
        try:
            os.setsid()
            install_handlers()
            signal.alarm(seconds)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            action()
        except BaseException as error:
            print(f"Local packaging stopped: {error}", file=sys.stderr)
            code = error.code if isinstance(error, SystemExit) and isinstance(error.code, int) else 1
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(code)
    try:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        _, status = os.waitpid(pid, 0)
    except BaseException:
        signal.pthread_sigmask(signal.SIG_BLOCK, HANDLED_SIGNALS)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        raise
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    if os.waitstatus_to_exitcode(status):
        raise RuntimeError("The local build worker stopped without finalizing a package.")


def probe(command, root, env=None):
    return subprocess.check_output(command, cwd=root, env=env, text=True, timeout=15).strip()


def build_environment(target):
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "TZ",
               "CARGO_HOME", "RUSTUP_HOME", "DEVELOPER_DIR", "SDKROOT"}
    env = {name: value for name, value in os.environ.items()
           if name in allowed or name.startswith("LC_")}
    for name in ("CARGO_HOME", "RUSTUP_HOME"):
        if name in env:
            env[name] = str(Path(env[name]).expanduser().resolve())
    env.update(CARGO_TARGET_DIR=str(target), CARGO_BUILD_JOBS="2", CI="true")
    return env


def check_inputs(root):
    for name in (".env", ".env.local", ".env.production", ".env.production.local"):
        path = root / name
        if path.exists() or path.is_symlink():
            raise RuntimeError("Remove local frontend environment files before packaging.")
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")).expanduser().resolve()
    configs = [cargo_home / name for name in ("config", "config.toml")]
    configs += [parent / ".cargo" / name for parent in (root, *root.parents)
                for name in ("config", "config.toml")]
    if any(path.exists() or path.is_symlink() for path in configs):
        raise RuntimeError("External Cargo configuration is unsupported for this local package.")


def check_source(root, expected=None):
    if probe(["git", "status", "--porcelain"], root):
        raise RuntimeError("Commit source changes before packaging.")
    commit = probe(["git", "rev-parse", "HEAD"], root)
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        raise RuntimeError("A full source commit is required.")
    if expected is not None and commit != expected:
        raise RuntimeError("The source commit changed during packaging.")
    return commit


def verify_bundle(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != "tech.mindlink.bitsov.remotetest":
        raise RuntimeError("The bundle must use the isolated remote test identifier.")
    if any(path.name.startswith("konsensus") for path in app.rglob("*")):
        raise RuntimeError("A remote test bundle must not contain a node sidecar.")
    binary = app / "Contents/MacOS/bitsov-app"
    if {path.name for path in binary.parent.iterdir()} != {"bitsov-app"}:
        raise RuntimeError("The remote test bundle must contain only the app executable.")
    if probe(["lipo", "-archs", str(binary)], app) != "arm64":
        raise RuntimeError("The app executable must contain only arm64 code.")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_archive(archive, app):
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError("The app archive is damaged.")
        for path in app.rglob("*"):
            if path.is_file() and not path.is_symlink():
                member = f"{app.name}/{path.relative_to(app).as_posix()}"
                digest = hashlib.sha256()
                with zipped.open(member) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
                if digest.hexdigest() != sha256(path):
                    raise RuntimeError("The archive does not match the checked app.")


def build(root, target, output):
    deadline = time.monotonic() + MAX_SECONDS
    if output.exists():
        raise RuntimeError("The artifact directory must not already exist.")
    folded_root, folded_target, folded_output = [Path(str(path).casefold())
                                                for path in (root, target, output)]
    if (folded_root == folded_target or folded_root in folded_target.parents or folded_target in folded_root.parents
            or folded_root == folded_output or folded_root in folded_output.parents or folded_output in folded_root.parents):
        raise RuntimeError("Target and artifact directories must be outside the source checkout.")
    if folded_target == folded_output or folded_target in folded_output.parents or folded_output in folded_target.parents:
        raise RuntimeError("Target and artifact directories must be separate.")
    check_inputs(root)
    commit = check_source(root)
    env = build_environment(target)
    bundle = target / TARGET / "release/bundle"
    if bundle.exists():
        raise RuntimeError("Remove the previous target bundle before packaging.")
    run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], root, env, deadline)
    run(["npm", "run", "tauri", "--", "build", "--bundles", "app", "--no-sign", "--ci",
         "--target", TARGET, "--config", "src-tauri/tauri.remote-only.conf.json",
         "--", "--locked"], root, env, deadline)
    app = bundle / "macos/BitSov Remote Test.app"
    check_source(root, commit)
    verify_bundle(app)
    metadata = {"commit": commit, "target": TARGET, "profile": "remote-only-signet",
                "signing": "none", "versions": {
                    name: probe(command, root / "src-tauri" if name in ("rustc", "cargo") else root, env)
                    for name, command in (
                        ("rustc", ["rustc", "--version"]), ("cargo", ["cargo", "--version"]),
                        ("node", ["node", "--version"]), ("npm", ["npm", "--version"]),
                        ("tauri", [str(root / "node_modules/.bin/tauri"), "--version"]))},
                "config_sha256": sha256(root / "src-tauri/tauri.remote-only.conf.json")}
    output.parent.mkdir(parents=True, exist_ok=True)
    # Publish locally only after every step succeeds. An incomplete run leaves no manifest.
    with tempfile.TemporaryDirectory(prefix=".arm64-package-", dir=output.parent) as staging:
        staging = Path(staging)
        archive = staging / "BitSov-Remote-Test-arm64.app.zip"
        run(["ditto", "-c", "-k", "--keepParent", str(app), str(archive)], root, env, deadline)
        verify_archive(archive, app)
        (staging / "build.json").write_text(json.dumps(metadata, indent=2) + "\n")
        files = [archive, staging / "build.json"]
        manifest = "".join(f"{sha256(path)}  {path.name}\n" for path in files)
        (staging / "SHA256SUMS").write_text(manifest)
        for line in (staging / "SHA256SUMS").read_text().splitlines():
            digest, filename = line.split("  ")
            if sha256(staging / filename) != digest:
                raise RuntimeError("Artifact checksum verification failed.")
        check_disk()
        check_source(root, commit)
        if time.monotonic() >= deadline:
            raise RuntimeError("The 60-minute build deadline expired.")
        staging.rename(output)
    print(f"Local artifact: {output / archive.name}")
    print(manifest, end="")


def main():
    install_handlers()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = os.environ.get("CARGO_TARGET_DIR")
    if not target:
        raise RuntimeError("Set CARGO_TARGET_DIR to a directory outside the source checkout.")
    check_host()
    lock = Path("/tmp") / f"bitsov-local-mac-build-{os.getuid()}.lock"
    with build_lock(lock):
        check_resources()
        check_no_other_builds()
        supervise(lambda: build(root, Path(target).resolve(), args.output_dir.resolve()))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Local packaging stopped: {error}", file=sys.stderr)
        sys.exit(1)
