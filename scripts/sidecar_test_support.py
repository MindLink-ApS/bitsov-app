"""Offline release fixture: real GPG/signatures/hashes, only gh is replaced.

The release key pin is changed ONLY in a temporary copy of the production script;
production has no environment variable or flag for bypassing its trust root.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = b'#!/bin/sh\necho NODE_LAUNCHED >> "$TRACE"\nexit 99\n'
ASSETS = {
    "aarch64-apple-darwin": "bitsov-darwin-aarch64",
    "x86_64-apple-darwin": "bitsov-darwin-x86_64",
    "x86_64-unknown-linux-gnu": "bitsov-linux-x86_64",
    "aarch64-unknown-linux-gnu": "bitsov-linux-aarch64",
    "x86_64-pc-windows-msvc.exe": "bitsov-windows-x86_64",
}
PAYLOADS = {asset: PAYLOAD if asset == "bitsov-darwin-aarch64"
            else PAYLOAD + f"# {asset}\n".encode() for asset in ASSETS.values()}
GH_STUB = '''#!/usr/bin/env python3
import os, pathlib, shutil, sys
args = sys.argv[1:]
fixture = pathlib.Path(os.environ["RELEASE_FIXTURE"])
if args[:2] == ["release", "download"]:
    assert args[2] == "v0.3.0-rc11", args
    assert args[args.index("--repo") + 1] == "MindLink-ApS/BitSov-bitsov", args
    dest = pathlib.Path(args[args.index("--dir") + 1])
    for i, arg in enumerate(args):
        if arg == "-p":
            name = args[i + 1]
            assert name in ("SHA256SUMS", "SHA256SUMS.asc") or name.startswith("bitsov-"), args
            shutil.copyfile(fixture / name, dest / name)
elif args == ["api", "repos/MindLink-ApS/BitSov-bitsov/contents/RELEASE_KEY.asc?ref=main",
              "-H", "Accept: application/vnd.github.raw"]:
    sys.stdout.write((fixture / "RELEASE_KEY.asc").read_text())
else:
    sys.exit("unexpected gh operation: " + repr(args))
'''


class ReleaseFixture:
    def __init__(self):
        # Short GPG socket path, including on macOS.
        self.tmp = tempfile.TemporaryDirectory(prefix="sidecar-", dir="/tmp")
        self.path = Path(self.tmp.name)
        self.home = self.path / "g"
        self.home.mkdir(mode=0o700)
        self.env = dict(os.environ, GNUPGHOME=str(self.home))
        self.gpg("--passphrase", "", "--quick-gen-key", "Sidecar test <test@example.invalid>",
                 "ed25519", "sign", "0")
        listing = self.gpg("--with-colons", "--list-keys").stdout.decode()
        self.pin = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
        (self.path / "RELEASE_KEY.asc").write_bytes(self.gpg("--armor", "--export", self.pin).stdout)

    def gpg(self, *args):
        return subprocess.run(["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", *args],
                              env=self.env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def prepare(self, root):
        release = root / "release"
        release.mkdir()
        shutil.copy2(self.path / "RELEASE_KEY.asc", release / "RELEASE_KEY.asc")
        for asset, payload in PAYLOADS.items():
            (release / asset).write_bytes(payload)
        (release / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256(payload).hexdigest()}  {asset}\n" for asset, payload in PAYLOADS.items()))
        self.sign(release)
        scripts = root / "scripts"
        scripts.mkdir(exist_ok=True)
        source = (ROOT / "scripts/fetch-node-sidecar.sh").read_text()
        source = source.replace('KEY_FPR="B299274C200301714DC6F51A7C2D6F8AC842EF6E"',
                                f'KEY_FPR="{self.pin}"')
        (scripts / "fetch-node-sidecar.sh").write_text(source)
        fakebin = root / "fakebin"
        fakebin.mkdir(exist_ok=True)
        gh = fakebin / "gh"
        gh.write_text(GH_STUB)
        gh.chmod(0o755)
        return dict(self.env, PATH=f"{fakebin}:{os.environ['PATH']}", RELEASE_FIXTURE=str(release))

    def sign(self, release):
        self.gpg("--armor", "--detach-sign", "-o", str(release / "SHA256SUMS.asc"),
                 str(release / "SHA256SUMS"))

    def close(self):
        subprocess.run(["gpgconf", "--kill", "gpg-agent"], env=self.env, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.tmp.cleanup()
