#!/usr/bin/env python3
"""Release metadata, signing eligibility, updater manifests and checksums."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
SIGNING_SECRETS = {
    "macos": ("APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID",
              "APPLE_TEAM_ID", "APPLE_APP_PASSWORD"),
    "windows": ("WINDOWS_SIGNING_CERTIFICATE", "WINDOWS_SIGNING_PASSWORD"),
    "android": ("ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD",
                "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"),
}


def signing_mode(platform, env):
    present = [bool(env.get(name)) for name in SIGNING_SECRETS[platform]]
    if all(present):
        return "signed-notarized" if platform == "macos" else "signed"
    if platform != "macos" and any(present):
        raise ValueError(f"Incomplete {platform} signing configuration / Ufuldstændig signeringsopsætning")
    return "unsigned"


def release_tag(version, ref, dry_run):
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid release version / Ugyldig udgivelsesversion")
    tag = f"v{version}"
    if ref.startswith("refs/tags/"):
        if ref != f"refs/tags/{tag}":
            raise ValueError("Tag and app version differ / Tag og appversion er forskellige")
    elif not dry_run:
        raise ValueError("Publishing requires a version tag / Udgivelse kræver et versionstag")
    return tag


def metadata():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    tauri = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    cargo = tomllib.loads((ROOT / "src-tauri/Cargo.toml").read_text())["package"]["version"]
    if len({version, tauri, cargo}) != 1:
        raise ValueError("Package versions differ / Pakkeversionerne er forskellige")
    dry_run = os.environ.get("RELEASE_DRY_RUN", "false") == "true"
    tag = release_tag(version, os.environ["GITHUB_REF"], dry_run)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"version={version}\ntag={tag}\ndry-run={str(dry_run).lower()}\n")


def assemble(directory, version, tag, repository, updater):
    """Allow only one complete artifact set; never emit unsigned updater entries."""
    files = {path.name: path for path in directory.iterdir()}
    if any(not path.is_file() or path.is_symlink() or not path.stat().st_size
           for path in files.values()):
        raise ValueError("Empty or unsafe release artifact / Tom eller usikker udgivelsesfil")
    prefix = f"BitSov-{version}"
    groups = {
        "app": [f"{prefix}-macos-universal-{mode}.app.zip" for mode in ["unsigned", "signed-notarized"]],
        "dmg": [f"{prefix}-macos-universal-{mode}.dmg" for mode in ["unsigned", "signed-notarized"]],
        "windows": [f"{prefix}-windows-x86_64-{mode}-setup.exe" for mode in ["unsigned", "signed"]],
        "android": [f"{prefix}-android-arm64-{mode}.apk" for mode in ["unsigned", "signed"]],
    }
    selected = {}
    for group, candidates in groups.items():
        matches = [name for name in candidates if name in files]
        if len(matches) != 1:
            raise ValueError(f"Expected one {group} artifact / Forventede én {group}-fil")
        selected[group] = matches[0]
    if selected["app"].removesuffix(".app.zip") != selected["dmg"].removesuffix(".dmg"):
        raise ValueError("macOS signing labels differ / macOS-signaturmærker er forskellige")
    allowed = set(selected.values())
    manifest = None
    if updater:
        archive = selected["app"].removesuffix(".zip") + ".tar.gz"
        allowed.add(archive)
        platforms = {}
        for name, targets in [(archive, ["darwin-aarch64", "darwin-x86_64"]),
                              (selected["windows"], ["windows-x86_64"])]:
            signature_name = name + ".sig"
            allowed.add(signature_name)
            if name not in files or signature_name not in files:
                raise ValueError("Missing signed update / Signeret opdatering mangler")
            signature = files[signature_name].read_text().strip()
            if not signature:
                raise ValueError("Empty update signature / Tom opdateringssignatur")
            entry = {"url": f"https://github.com/{repository}/releases/download/{quote(tag, safe='')}/{quote(name)}",
                     "signature": signature}
            platforms.update({target: entry for target in targets})
        manifest = {"version": version, "notes": "BitSov update / BitSov-opdatering", "platforms": platforms}
    if set(files) != allowed:
        raise ValueError("Unexpected release artifacts / Uventede udgivelsesfiler")
    if manifest is not None:
        (directory / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def sign_updater(path, version):
    if not os.environ.get("TAURI_SIGNING_PRIVATE_KEY"):
        raise ValueError("Updater signing key missing / Signeringsnøgle til opdatering mangler")
    # Keep keys in the environment, never in command arguments or captured logs.
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    result = subprocess.run([npm, "run", "tauri", "--", "signer", "sign",
                             "--app-version", version, str(path.resolve())],
                            cwd=ROOT, capture_output=True)
    if result.returncode:
        raise ValueError("Updater signing failed / Signering af opdatering mislykkedes")
    signature = Path(str(path) + ".sig")
    if not signature.is_file() or not signature.read_text().strip():
        raise ValueError("Updater signature missing / Opdateringssignatur mangler")


def checksums(directory):
    files = sorted(path for path in directory.iterdir() if path.name != "SHA256SUMS")
    if not files or any(not path.is_file() or path.is_symlink() for path in files):
        raise ValueError("Invalid checksum input / Ugyldigt input til kontrolsummer")
    with (directory / "SHA256SUMS").open("w") as output:
        for path in files:
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            output.write(f"{digest}  {path.name}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("metadata")
    signing = commands.add_parser("signing")
    signing.add_argument("platform", choices=SIGNING_SECRETS)
    signing = commands.add_parser("sign-updater")
    signing.add_argument("path", type=Path)
    signing.add_argument("version")
    assembly = commands.add_parser("assemble")
    assembly.add_argument("directory", type=Path)
    assembly.add_argument("version")
    assembly.add_argument("tag")
    assembly.add_argument("repository")
    assembly.add_argument("--updater", action="store_true")
    sums = commands.add_parser("checksums")
    sums.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "metadata":
        metadata()
    elif args.command == "signing":
        print(signing_mode(args.platform, os.environ))
    elif args.command == "sign-updater":
        sign_updater(args.path, args.version)
    elif args.command == "assemble":
        assemble(args.directory, args.version, args.tag, args.repository, args.updater)
    elif args.command == "checksums":
        checksums(args.directory)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
