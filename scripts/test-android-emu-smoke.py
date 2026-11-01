#!/usr/bin/env python3
"""Checks for scripts/android-emu-smoke.sh and its screenshot check.

No SDK, emulator or Gradle is needed: the smoke runs in --dry-run mode and
the screenshot check reads small PNG files written here.
"""
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts/android-emu-smoke.sh"
CHECK = ROOT / "scripts/android-screenshot-check.mjs"


def png(width, height, pixel):
    """An 8-bit RGBA PNG; pixel(x, y) returns an (r, g, b) tuple."""
    rows = b"".join(
        b"\x00" + b"".join(bytes(pixel(x, y)) + b"\xff" for x in range(width))
        for y in range(height)
    )

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def dry_run(*args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ANDROID_")}
    return subprocess.run(["bash", str(SMOKE), "--dry-run", *args], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=60)


class SmokeScript(unittest.TestCase):
    def test_dry_run_builds_debug_only_and_touches_no_device(self):
        result = dry_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        self.assertIn("android build --ci --debug --apk --target aarch64", out)
        self.assertIn("install -r", out)
        self.assertIn("screencap -p", out)
        self.assertIn("reverse --list", out)
        for word in ["release", "keystore", "apksigner", "jarsigner", "signingConfig", "assembleRelease", "bundleRelease"]:
            self.assertNotIn(word.lower(), out.lower(), word)

    def test_skip_build_reuses_the_apk(self):
        result = dry_run("--skip-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("android build", result.stdout)
        self.assertIn("app-universal-debug.apk", result.stdout)

    def test_unknown_argument_fails(self):
        result = dry_run("--release")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown argument", result.stderr)

    def test_script_has_no_signing_or_physical_device_path(self):
        code = "\n".join(line for line in SMOKE.read_text().splitlines() if not line.lstrip().startswith("#"))
        for pattern in [r"keystore", r"apksigner", r"jarsigner", r"signingConfig", r"--release\b",
                        r"assembleRelease", r"reverse\s+tcp:", r"10\.0\.2\.2"]:
            self.assertIsNone(re.search(pattern, code, re.IGNORECASE), pattern)
        # Only emulator serials are accepted.
        self.assertIn("^emulator-[0-9]+$", code)


class ScreenshotCheck(unittest.TestCase):
    def check(self, data):
        with tempfile.NamedTemporaryFile(suffix=".png") as file:
            file.write(data)
            file.flush()
            return subprocess.run(["node", str(CHECK), file.name], capture_output=True, text=True, timeout=60)

    def test_black_frame_fails(self):
        result = self.check(png(60, 120, lambda x, y: (0, 0, 0)))
        self.assertEqual(result.returncode, 1)
        self.assertIn("black", result.stderr)

    def test_flat_page_fails(self):
        result = self.check(png(60, 120, lambda x, y: (250, 249, 246)))
        self.assertEqual(result.returncode, 1)
        self.assertIn("flat colour", result.stderr)

    def test_content_in_the_status_bar_only_fails(self):
        result = self.check(png(60, 120, lambda x, y: (20, 20, 20) if y < 8 else (250, 249, 246)))
        self.assertEqual(result.returncode, 1)

    def test_text_on_a_light_page_passes(self):
        def page(x, y):
            return (30, 30, 30) if 50 <= y < 60 and 10 <= x < 50 else (250, 249, 246)
        result = self.check(png(60, 120, page))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_not_a_png_fails(self):
        result = self.check(b"not an image")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a PNG", result.stderr)


if __name__ == "__main__":
    unittest.main()
