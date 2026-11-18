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

TARGET = "aarch64-apple-darwin"
MIN_FREE = 110 * 1024**3
MAX_SECONDS = 3600


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
    # A failed priority change must prevent execution, rather than merely warn.
    process = subprocess.Popen(command, cwd=root, env=env, start_new_session=True,
                               preexec_fn=lambda: os.nice(10))
    try:
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
    except BaseException:
        # Stop descendants too; terminating only npm can leave Cargo running.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                break
            if sig == signal.SIGTERM:
                time.sleep(0.2)
                process.poll()
        process.wait()
        raise


def probe(command, root):
    return subprocess.check_output(command, cwd=root, text=True, timeout=15).strip()


def verify_bundle(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != "tech.mindlink.bitsov.remotetest":
        raise RuntimeError("The bundle must use the isolated remote test identifier.")
    if any(path.name.startswith("konsensus") for path in app.rglob("*")):
        raise RuntimeError("A remote test bundle must not contain a node sidecar.")
    binary = app / "Contents/MacOS/bitsov-app"
    if probe(["lipo", "-archs", str(binary)], app) != "arm64":
        raise RuntimeError("The app executable must contain only arm64 code.")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build(root, target, output):
    deadline = time.monotonic() + MAX_SECONDS
    if output.exists():
        raise RuntimeError("The artifact directory must not already exist.")
    if (root == target or root in target.parents or target in root.parents
            or root == output or root in output.parents or output in root.parents):
        raise RuntimeError("Target and artifact directories must be outside the source checkout.")
    if target == output or target in output.parents or output in target.parents:
        raise RuntimeError("Target and artifact directories must be separate.")
    if probe(["git", "status", "--porcelain"], root):
        raise RuntimeError("Commit source changes before packaging.")
    commit = probe(["git", "rev-parse", "HEAD"], root)
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        raise RuntimeError("A full source commit is required.")
    env = os.environ.copy()
    # Keep local build settings independent of signing and development overrides.
    for name in list(env):
        if name.startswith(("APPLE_", "TAURI_", "BITSOV_", "VITE_")):
            del env[name]
    env.update(CARGO_TARGET_DIR=str(target), CARGO_BUILD_JOBS="2", CI="true")
    bundle = target / TARGET / "release/bundle"
    if bundle.exists():
        raise RuntimeError("Remove the previous target bundle before packaging.")
    run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], root, env, deadline)
    run(["npm", "run", "tauri", "--", "build", "--bundles", "app", "--no-sign", "--ci",
         "--target", TARGET, "--config", "src-tauri/tauri.remote-only.conf.json",
         "--", "--locked"], root, env, deadline)
    app = bundle / "macos/BitSov Remote Test.app"
    verify_bundle(app)
    metadata = {"commit": commit, "target": TARGET, "profile": "remote-only-signet",
                "signing": "none", "versions": {
                    name: probe(command, root) for name, command in (
                        ("rustc", ["rustc", "--version"]), ("cargo", ["cargo", "--version"]),
                        ("node", ["node", "--version"]), ("npm", ["npm", "--version"]))}}
    output.parent.mkdir(parents=True, exist_ok=True)
    # Publish locally only after every step succeeds. An incomplete run leaves no manifest.
    with tempfile.TemporaryDirectory(prefix=".arm64-package-", dir=output.parent) as staging:
        staging = Path(staging)
        archive = staging / "BitSov-Remote-Test-arm64.app.zip"
        run(["ditto", "-c", "-k", "--keepParent", str(app), str(archive)], root, env, deadline)
        (staging / "build.json").write_text(json.dumps(metadata, indent=2) + "\n")
        files = [archive, staging / "build.json"]
        manifest = "".join(f"{sha256(path)}  {path.name}\n" for path in files)
        (staging / "SHA256SUMS").write_text(manifest)
        for line in (staging / "SHA256SUMS").read_text().splitlines():
            digest, filename = line.split("  ")
            if sha256(staging / filename) != digest:
                raise RuntimeError("Artifact checksum verification failed.")
        check_disk()
        if time.monotonic() >= deadline:
            raise RuntimeError("The 60-minute build deadline expired.")
        staging.rename(output)
    print(f"Local artifact: {output / archive.name}")
    print(manifest, end="")


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    def timeout(*_):
        raise RuntimeError("The 60-minute build deadline expired.")
    signal.signal(signal.SIGALRM, timeout)
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
        signal.alarm(MAX_SECONDS)
        try:
            build(root, Path(target).resolve(), args.output_dir.resolve())
        finally:
            signal.alarm(0)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Local packaging stopped: {error}", file=sys.stderr)
        sys.exit(1)
