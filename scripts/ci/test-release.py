#!/usr/bin/env python3
"""Offline checks for release eligibility and complete, signed artifact sets."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("release.py")
sys.dont_write_bytecode = True


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("release", SCRIPT)
        cls.release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.release)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def artifacts(self, updater=False):
        names = ["BitSov-0.0.1-macos-universal-unsigned.app.zip",
                 "BitSov-0.0.1-macos-universal-unsigned.dmg",
                 "BitSov-0.0.1-windows-x86_64-unsigned-setup.exe",
                 "BitSov-0.0.1-android-arm64-unsigned.apk"]
        if updater:
            names.append("BitSov-0.0.1-macos-universal-unsigned.app.tar.gz")
        for name in names:
            (self.root / name).write_bytes(b"artifact contents")
            if updater and name.endswith((".app.tar.gz", "-setup.exe")):
                (self.root / (name + ".sig")).write_text("public-signature\n")
        return names

    def test_publish_requires_a_matching_version_tag(self):
        for ref, dry_run in [("refs/heads/main", False),
                             ("refs/tags/v0.0.2", False),
                             ("refs/tags/v0.0.2", True)]:
            with self.subTest(ref=ref, dry_run=dry_run), self.assertRaises(ValueError):
                self.release.release_tag("0.0.1", ref, dry_run)
        self.assertEqual(self.release.release_tag("0.0.1", "refs/tags/v0.0.1", False),
                         "v0.0.1")
        self.assertEqual(self.release.release_tag("0.0.1", "refs/heads/main", True),
                         "v0.0.1")

    def test_macos_requires_all_five_secrets(self):
        names = self.release.SIGNING_SECRETS["macos"]
        for mask in range(32):
            env = {name: "sensitive-value" for i, name in enumerate(names) if mask & (1 << i)}
            expected = "signed-notarized" if mask == 31 else "unsigned"
            self.assertEqual(self.release.signing_mode("macos", env), expected)

    def test_partial_windows_and_android_configuration_fails_without_values(self):
        for platform in ["windows", "android"]:
            names = self.release.SIGNING_SECRETS[platform]
            self.assertEqual(self.release.signing_mode(platform, {}), "unsigned")
            self.assertEqual(self.release.signing_mode(platform, dict.fromkeys(names, "secret")), "signed")
            for missing in names:
                with self.subTest(platform=platform, missing=missing):
                    env = {name: "sensitive-value" for name in names if name != missing}
                    with self.assertRaises(ValueError) as error:
                        self.release.signing_mode(platform, env)
                    self.assertNotIn("sensitive-value", str(error.exception))

    def assemble(self, updater=False):
        self.release.assemble(self.root, "0.0.1", "v0.0.1", "example/project", updater)

    def test_unsigned_release_has_checksums_and_no_update_manifest(self):
        names = self.artifacts()
        self.assemble()
        self.release.checksums(self.root)
        self.assertFalse((self.root / "latest.json").exists())
        lines = (self.root / "SHA256SUMS").read_text().splitlines()
        digest = hashlib.sha256(b"artifact contents").hexdigest()
        self.assertEqual(lines, [f"{digest}  {name}" for name in sorted(names)])

    def test_manifest_uses_both_macos_architectures_and_embedded_signatures(self):
        self.artifacts(updater=True)
        self.assemble(updater=True)
        manifest = json.loads((self.root / "latest.json").read_text())
        platforms = manifest["platforms"]
        self.assertEqual(set(platforms), {"darwin-aarch64", "darwin-x86_64", "windows-x86_64"})
        self.assertEqual(platforms["darwin-aarch64"], platforms["darwin-x86_64"])
        for entry in platforms.values():
            self.assertEqual(entry["signature"], "public-signature")
            self.assertTrue(entry["url"].startswith(
                "https://github.com/example/project/releases/download/v0.0.1/"))

    def test_missing_or_empty_artifact_blocks_assembly(self):
        names = self.artifacts()
        for name in names:
            path = self.root / name
            path.write_bytes(b"")
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.assemble()
            path.write_bytes(b"artifact contents")

    def test_missing_empty_or_unexpected_updater_signature_blocks_assembly(self):
        self.artifacts(updater=True)
        sig = next(self.root.glob("*.exe.sig"))
        sig.write_text("")
        with self.assertRaises(ValueError):
            self.assemble(updater=True)
        sig.unlink()
        with self.assertRaises(ValueError):
            self.assemble(updater=True)
        with self.assertRaises(ValueError):
            self.assemble(updater=False)

    def test_unexpected_or_duplicate_artifacts_block_assembly(self):
        self.artifacts()
        (self.root / "credential.p12").write_bytes(b"never upload")
        with self.assertRaises(ValueError):
            self.assemble()
        (self.root / "credential.p12").unlink()
        (self.root / "BitSov-0.0.1-android-arm64-signed.apk").write_bytes(b"duplicate")
        with self.assertRaises(ValueError):
            self.assemble()

    def test_failed_configured_signer_stops_without_leaking_key(self):
        payload = self.root / "payload"
        payload.write_bytes(b"payload")
        env = os.environ | {"TAURI_SIGNING_PRIVATE_KEY": "invalid-test-key",
                            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": ""}
        result = subprocess.run(["python3", str(SCRIPT), "sign-updater", str(payload), "0.0.1"],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("invalid-test-key", result.stdout + result.stderr)
        self.assertFalse(payload.with_suffix(".sig").exists())

    def test_real_tauri_signer_creates_a_version_bound_signature(self):
        key = self.root / "disposable.key"
        generated = subprocess.run(["npm", "run", "tauri", "--", "signer", "generate",
                                    "--ci", "--password", "", "--write-keys", str(key)],
                                   cwd=SCRIPT.parents[2], capture_output=True)
        self.assertEqual(generated.returncode, 0, "Disposable key generation failed")
        payload = self.root / "payload"
        payload.write_bytes(b"final release bytes")
        env = os.environ | {"TAURI_SIGNING_PRIVATE_KEY": key.read_text(),
                            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": ""}
        result = subprocess.run([sys.executable, str(SCRIPT), "sign-updater", str(payload), "0.0.1"],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        import base64
        signature = base64.b64decode(Path(str(payload) + ".sig").read_bytes()).decode()
        self.assertIn("0.0.1", signature)
        self.assertNotIn(key.read_text().strip(), result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
