#!/usr/bin/env python3
"""Check the iOS release inputs before a TestFlight archive. No signing access.

usage: scripts/check-ios-release.py [--root DIR] [--xcode] [--toolchain]

Static checks read the two shipping Info.plists, the entitlements file and the
Xcode project. --xcode also asks xcodebuild for the Release device settings
(`-showBuildSettings`), which reads the project only. --toolchain checks this
Mac's Rust toolchain for the llvm-objcopy a Release link needs.
"""
import argparse
import pathlib
import plistlib
import re
import subprocess
import sys

PLISTS = ("src-tauri/Info.ios.plist", "src-tauri/gen/apple/bitsov-app_iOS/Info.plist")
ENTITLEMENTS = "src-tauri/gen/apple/bitsov-app_iOS/bitsov-app_iOS.entitlements"
PROJECT = "src-tauri/gen/apple/bitsov-app.xcodeproj/project.pbxproj"
USAGE = ("NSMicrophoneUsageDescription", "NSCameraUsageDescription",
         "NSLocalNetworkUsageDescription", "NSFaceIDUsageDescription")
# Simulator-only entitlements are linked by the simulator smoke on the command
# line; a device build gets these from its provisioning profile instead.
SIMULATOR_ONLY = ("application-identifier", "keychain-access-groups",
                  "com.apple.developer.team-identifier")


def static_problems(root: pathlib.Path) -> list[str]:
    problems = []
    for name in PLISTS:
        with open(root / name, "rb") as handle:
            info = plistlib.load(handle)
        for key in USAGE:
            if not str(info.get(key, "")).strip():
                problems.append(f"{name}: {key} is missing or empty")
        if info.get("UIBackgroundModes") != ["audio"]:
            problems.append(f"{name}: UIBackgroundModes must be exactly [audio]")
        if info.get("ITSAppUsesNonExemptEncryption") is not False:
            problems.append(f"{name}: ITSAppUsesNonExemptEncryption must be set (false)")
    with open(root / ENTITLEMENTS, "rb") as handle:
        entitlements = plistlib.load(handle)
    for key in SIMULATOR_ONLY:
        if key in entitlements:
            problems.append(f"{ENTITLEMENTS}: simulator-only {key} must not be committed")
    project = (root / PROJECT).read_text()
    if re.search(r"ENABLE_BITCODE = (YES|\"YES\")", project):
        problems.append(f"{PROJECT}: ENABLE_BITCODE must be NO")
    if "__entitlements" in project or "sectcreate" in project:
        problems.append(f"{PROJECT}: linked entitlements belong to simulator builds only")
    if re.search(r"DEVELOPMENT_TEAM = [^;\s\"]+;|DEVELOPMENT_TEAM = \"[^\"]+\";", project):
        problems.append(f"{PROJECT}: DEVELOPMENT_TEAM must stay unset; the account owner picks it in Xcode")
    for script in re.findall(r'shellScript = ("(?:\\.|[^"\\])*");', project):
        if "BITSOV_IOS_SIM_PREBUILT" in script and "iphonesimulator" not in script:
            problems.append(f"{PROJECT}: a prebuilt library phase must be limited to the simulator")
    return problems


def xcode_problems(root: pathlib.Path) -> list[str]:
    output = subprocess.run(
        ["xcodebuild", "-project", str(root / "src-tauri/gen/apple/bitsov-app.xcodeproj"),
         "-scheme", "bitsov-app_iOS", "-configuration", "release", "-sdk", "iphoneos",
         "-showBuildSettings"],
        check=True, capture_output=True, text=True).stdout
    settings = dict(re.findall(r"^\s+([A-Z0-9_]+) = (.*)$", output, flags=re.M))
    problems = []
    if settings.get("ENABLE_BITCODE", "NO") != "NO":
        problems.append("Release ENABLE_BITCODE is not NO")
    if "__entitlements" in settings.get("OTHER_LDFLAGS", ""):
        problems.append("Release OTHER_LDFLAGS links simulator entitlements")
    if settings.get("BITSOV_IOS_SIM_PREBUILT"):
        problems.append("Release sets BITSOV_IOS_SIM_PREBUILT")
    if settings.get("DEVELOPMENT_TEAM"):
        problems.append("Release has a committed DEVELOPMENT_TEAM")
    if settings.get("CODE_SIGN_ENTITLEMENTS") != "bitsov-app_iOS/bitsov-app_iOS.entitlements":
        problems.append("Release CODE_SIGN_ENTITLEMENTS is not the committed entitlements file")
    if settings.get("PRODUCT_BUNDLE_IDENTIFIER") != "tech.mindlink.bitsov":
        problems.append("Release bundle identifier is not tech.mindlink.bitsov")
    if settings.get("ENABLE_TESTABILITY", "NO") != "NO":
        problems.append("Release ENABLE_TESTABILITY is not NO")
    return problems


def toolchain_problems() -> list[str]:
    """Xcode 27 keeps tauri's Swift @_cdecl entry points local in Release; swift-rs
    re-exports them only when rustup's llvm-tools provides llvm-objcopy."""
    sysroot = subprocess.run(["rustc", "--print", "sysroot"], check=True, capture_output=True, text=True).stdout.strip()
    host = re.search(r"^host: (\S+)$", subprocess.run(["rustc", "-vV"], check=True, capture_output=True, text=True).stdout, flags=re.M)
    tool = pathlib.Path(sysroot) / "lib/rustlib" / (host.group(1) if host else "") / "bin/llvm-objcopy"
    if not tool.is_file():
        return ["llvm-objcopy is missing, so a Release build cannot link; run: rustup component add llvm-tools"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--xcode", action="store_true", help="also check xcodebuild Release device settings")
    parser.add_argument("--toolchain", action="store_true", help="also check this Mac's Rust toolchain for Release links")
    args = parser.parse_args()
    problems = static_problems(args.root)
    if args.xcode:
        problems += xcode_problems(args.root)
    if args.toolchain:
        problems += toolchain_problems()
    for problem in problems:
        print(f"iOS release check: {problem}", file=sys.stderr)
    if not problems:
        extra = [name for name, on in (("Xcode Release settings", args.xcode), ("toolchain", args.toolchain)) if on]
        print("iOS release check: ok" + (f" (with {', '.join(extra)})" if extra else ""))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
