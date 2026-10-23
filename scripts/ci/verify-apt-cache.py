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


def matches(archive, metadata):
    wanted = identity(archive)
    if wanted is None or archive.is_symlink() or not archive.is_file():
        return False
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    for stanza in metadata.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in stanza.splitlines() if ": " in line and not line.startswith(" "))
        actual = tuple(fields.get(key) for key in ("Package", "Version", "Architecture"))
        if (actual == wanted and fields.get("SHA256") == digest
                and fields.get("Size") == str(archive.stat().st_size)):
            return True
    return False


def main(directory):
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


if __name__ == "__main__":
    main(sys.argv[1])
