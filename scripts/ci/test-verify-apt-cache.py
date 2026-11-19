#!/usr/bin/env python3
"""A same-size cached-deb substitution must never reach installation."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from subprocess import CompletedProcess

spec = importlib.util.spec_from_file_location(
    "verify_apt_cache", Path(__file__).with_name("verify-apt-cache.py")
)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class CacheVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / "libexample_1.0_amd64.deb"
        self.archive.write_bytes(b"original")
        self.metadata = (
            "Package: libexample\nVersion: 1.0\nArchitecture: amd64\n"
            "Size: 8\nSHA256: " + hashlib.sha256(b"original").hexdigest() + "\n"
        )

    def test_valid_archive_matches_authenticated_index(self):
        self.assertTrue(verifier.matches(self.archive, self.metadata))

    def test_same_size_substitution_is_rejected(self):
        self.archive.write_bytes(b"tampered")
        self.assertFalse(verifier.matches(self.archive, self.metadata))

    def test_missing_sha256_is_rejected(self):
        self.assertFalse(verifier.matches(self.archive, "Size: 8\n"))

    def test_wrong_size_is_rejected(self):
        self.assertFalse(verifier.matches(self.archive, self.metadata.replace("Size: 8", "Size: 9")))

    def test_renamed_package_is_rejected(self):
        self.assertFalse(verifier.matches(self.archive, self.metadata.replace("Package: libexample", "Package: another")))

    def test_epoch_encoded_in_apt_filename(self):
        renamed = self.archive.with_name("libexample_1%3a1.0_amd64.deb")
        self.archive.rename(renamed)
        self.assertTrue(verifier.matches(renamed, self.metadata.replace("Version: 1.0", "Version: 1:1.0")))

    def test_isa_variant_filename_matches_base_architecture(self):
        renamed = self.archive.with_name("libexample_1.0_amd64v3.deb")
        self.archive.rename(renamed)
        self.assertTrue(verifier.matches(renamed, self.metadata))

    def test_isa_variant_still_requires_hash(self):
        renamed = self.archive.with_name("libexample_1.0_amd64v3.deb")
        self.archive.rename(renamed)
        renamed.write_bytes(b"tampered")
        self.assertFalse(verifier.matches(renamed, self.metadata))

    def test_other_architecture_is_rejected(self):
        for name in ("libexample_1.0_arm64.deb", "libexample_1.0_amd64x.deb", "libexample_1.0_amd64v.deb"):
            renamed = self.archive.with_name(name)
            self.archive.rename(renamed)
            self.assertFalse(verifier.matches(renamed, self.metadata), name)
            self.archive = renamed

    def test_tampered_file_is_removed_before_apt_can_reuse_it(self):
        self.archive.write_bytes(b"tampered")
        with patch.object(verifier.subprocess, "run", return_value=CompletedProcess([], 0, self.metadata)):
            verifier.main(self.temp.name)
        self.assertFalse(self.archive.exists())

    def test_unknown_package_is_removed(self):
        with patch.object(verifier.subprocess, "run", return_value=CompletedProcess([], 100, "")):
            verifier.main(self.temp.name)
        self.assertFalse(self.archive.exists())

    def test_valid_cache_entry_is_retained(self):
        with patch.object(verifier.subprocess, "run", return_value=CompletedProcess([], 0, self.metadata)):
            verifier.main(self.temp.name)
        self.assertEqual(self.archive.read_bytes(), b"original")


if __name__ == "__main__":
    unittest.main()
