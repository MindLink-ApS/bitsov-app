#!/usr/bin/env python3
"""Discard cached debs unless their SHA256 matches freshly updated apt indexes.

Apt's existing-archive shortcut checks size, not content. Run this after a
successful authenticated apt-get update and before apt examines the cache.
"""
import hashlib
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote


def identity(archive):
    fields = archive.stem.split("_")
    if len(fields) != 3:
        return None
    package, version, arch = (unquote(field) for field in fields)
    if not (re.fullmatch(r"[a-z0-9][a-z0-9+.-]+", package)
            and re.fullmatch(r"[0-9][A-Za-z0-9.+:~\-]*", version)
            and re.fullmatch(r"[a-z0-9][a-z0-9-]*", arch)):
        return None
    return package, version, arch


def same_architecture(file_arch, index_arch):
    """Apt names debs from an ISA-variant index (e.g. amd64v3) after the
    variant, while the index stanza keeps the base Architecture (amd64)."""
    if index_arch is None:
        return False
    variant = file_arch[len(index_arch):]
    return file_arch == index_arch or (
        file_arch.startswith(index_arch) and re.fullmatch(r"v[0-9]+", variant) is not None)


def matches(archive, metadata):
    wanted = identity(archive)
    if wanted is None or archive.is_symlink() or not archive.is_file():
        return False
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    for stanza in metadata.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in stanza.splitlines() if ": " in line and not line.startswith(" "))
        actual = tuple(fields.get(key) for key in ("Package", "Version"))
        if (actual == wanted[:2] and same_architecture(wanted[2], fields.get("Architecture"))
                and fields.get("SHA256") == digest
                and fields.get("Size") == str(archive.stat().st_size)):
            return True
    return False


def main(directory):
    kept = discarded = 0
    for archive in Path(directory).glob("*.deb"):
        wanted = identity(archive)
        metadata = ""
        if wanted is not None:
            package, version, _ = wanted
            result = subprocess.run(
                ["apt-cache", "show", f"{package}={version}"],
                capture_output=True, text=True, check=False,
            )
            if result.returncode == 0:
                metadata = result.stdout
        if not matches(archive, metadata):
            # A stale/corrupt cache is a miss, never permission to install it.
            print(f"Discarding unverified cached archive: {archive.name}")
            archive.unlink()
            discarded += 1
        else:
            kept += 1
    print(f"Cached archives: {kept} verified, {discarded} discarded")


if __name__ == "__main__":
    main(sys.argv[1])
