#!/usr/bin/env python3
"""G1 pre-bundle regression tests; no network, no build, no sidecar execution."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

from sidecar_test_support import ASSETS, PAYLOAD, PAYLOADS, ROOT, ReleaseFixture


class ProductionPinTests(unittest.TestCase):
    def test_published_pins_are_complete_and_match_signed_release(self):
        # Literal entries authenticated from the published SHA256SUMS. Exercise
        # the production lookup, without the fixture's replacement pin table.
        expected = """0fbfd27ac928492548598f76a250449e60e9dc9ed863f9b889a014bd27e4725b  bitsov-darwin-aarch64
dbca8de0eb226ba9f69b60c6988018d5440db92828adee6156be5e0bbabc6960  bitsov-darwin-x86_64
f5b24311d4152e6158e2e67547baf15d2e21003f924168520bff427072f37ff3  bitsov-linux-aarch64
18947d9725490f8514b46b31eeb722dccdc1a12aaa703081efdbcc5a9e179544  bitsov-linux-x86_64
5b7c39ae20b5b24ca073f2200f2493f9e8c73309bd3d5bf1a45ed3ea2463c13c  bitsov-windows-x86_64"""
        result = subprocess.run([
            "bash", "-c",
            'source scripts/fetch-node-sidecar.sh; require_complete_checksum_pin; '
            'for asset in "$@"; do printf "%s  %s\\n" "$(pinned_checksum "$asset")" "$asset"; done',
            "pins", *[line.split()[1] for line in expected.splitlines()],
        ], cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout.strip(), expected)

    def test_unpublished_pin_refuses_fetch_and_verify_before_network(self):
        # Removing the placeholder gate must fail this test, even offline.
        with tempfile.TemporaryDirectory(prefix="draft-pin-") as tmp:
            root = Path(tmp)
            scripts = root / "scripts"
            scripts.mkdir()
            source = (ROOT / "scripts/fetch-node-sidecar.sh").read_text()
            # Keep testing draft refusal after the production release pins are filled.
            draft_pins = "\n".join(
                f"PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2  {asset}" for asset in ASSETS.values())
            source, count = re.subn(r"(?m)^EXPECTED_SHA256SUMS='[^']*'",
                                    lambda _: f"EXPECTED_SHA256SUMS='{draft_pins}'", source)
            self.assertEqual(count, 1)
            (scripts / "fetch-node-sidecar.sh").write_text(source)
            fakebin = root / "fakebin"
            fakebin.mkdir()
            trace = root / "network-called"
            gh = fakebin / "gh"
            gh.write_text(f'#!/bin/sh\ntouch "{trace}"\nexit 97\n')
            gh.chmod(0o755)
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}")
            for args in ([], ["--verify-only"]):
                with self.subTest(args=args):
                    result = subprocess.run(["bash", "scripts/fetch-node-sidecar.sh", *args],
                                            cwd=root, env=env, text=True,
                                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertIn("REFUSED: checksum pin incomplete", result.stdout)
                    self.assertFalse(trace.exists(), "must refuse before network access")
                    self.assertFalse((root / "src-tauri").exists())


class SidecarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = ReleaseFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="verify sidecars ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = self.fixture.prepare(self.root)
        self.bin = self.root / "src-tauri/bin"
        self.bin.mkdir(parents=True)
        self.sidecar = self.bin / "konsensus-aarch64-apple-darwin"
        self.sidecar.write_bytes(PAYLOAD)
        self.sidecar.chmod(0o755)

    def run_verify(self, command=None):
        return subprocess.run(command or ["bash", "scripts/fetch-node-sidecar.sh", "--verify-only"],
                              cwd=self.root, env=self.env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def assert_refused(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("REFUSED", result.stdout)

    def test_mismatched_binary_refused_with_expected_and_actual_hash(self):
        self.sidecar.write_bytes(b"stray binary")
        result = self.run_verify()
        self.assert_refused(result)
        self.assertIn(hashlib.sha256(PAYLOAD).hexdigest(), result.stdout)
        self.assertIn(hashlib.sha256(b"stray binary").hexdigest(), result.stdout)
        self.assertIn(self.sidecar.name, result.stdout)
        self.assertEqual(self.sidecar.read_bytes(), b"stray binary")  # never silently repair

    def test_verified_binaries_for_every_published_target_pass(self):
        for triple, asset in ASSETS.items():
            target = self.bin / f"konsensus-{triple}"
            target.write_bytes(PAYLOADS[asset])
            target.chmod(0o755)
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stdout)
        for triple in ASSETS:
            self.assertIn(f"konsensus-{triple}", result.stdout)

    def test_extra_mismatched_target_also_refused(self):
        (self.bin / "konsensus-x86_64-apple-darwin").write_bytes(b"stray")
        self.assert_refused(self.run_verify())

    def test_unknown_target_refused_even_with_matching_bytes(self):
        (self.bin / "konsensus-unpublished").write_bytes(PAYLOAD)
        result = self.run_verify()
        self.assert_refused(result)
        self.assertIn("konsensus-unpublished", result.stdout)
        self.assertIn("expected sha256", result.stdout)
        self.assertIn(hashlib.sha256(PAYLOAD).hexdigest(), result.stdout)

    def test_missing_sidecars_refused(self):
        self.sidecar.unlink()
        self.assert_refused(self.run_verify())

    def test_symlink_directory_and_dangling_symlink_refused(self):
        self.sidecar.unlink()
        self.sidecar.symlink_to(self.root / "release/bitsov-darwin-aarch64")
        self.assert_refused(self.run_verify())
        self.sidecar.unlink()
        self.sidecar.symlink_to(self.root / "missing")
        self.assert_refused(self.run_verify())
        self.sidecar.unlink()
        self.sidecar.mkdir()
        self.assert_refused(self.run_verify())

    def test_fetch_still_installs_verified_bytes_and_refuses_tampering(self):
        uname = self.root / "fakebin/uname"
        uname.write_text('#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n')
        uname.chmod(0o755)
        self.sidecar.unlink()
        result = self.run_verify(["bash", "scripts/fetch-node-sidecar.sh"])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.sidecar.read_bytes(), PAYLOAD)
        self.sidecar.unlink()
        (self.root / "release/bitsov-darwin-aarch64").write_bytes(b"bad download")
        self.assert_refused(self.run_verify(["bash", "scripts/fetch-node-sidecar.sh"]))
        self.assertFalse(self.sidecar.exists())

    def test_missing_duplicate_or_malformed_manifest_entry_refused(self):
        sums = self.root / "release/SHA256SUMS"
        original = sums.read_text()
        for manifest in ("", original + original, "bad-hash  bitsov-darwin-aarch64\n"):
            with self.subTest(manifest=manifest):
                sums.write_text(manifest)
                self.fixture.sign(sums.parent)
                result = self.run_verify()
                self.assert_refused(result)
                self.assertIn("expected sha256", result.stdout)
                self.assertIn(hashlib.sha256(PAYLOAD).hexdigest(), result.stdout)

    def test_each_incomplete_target_pin_blocks_fetch_and_verify(self):
        script = self.root / "scripts/fetch-node-sidecar.sh"
        original = script.read_text()
        for asset, payload in PAYLOADS.items():
            for invalid in ("PLACEHOLDER_SHA256_FROM_SIGNED_RC19_2", "bad-hash"):
                with self.subTest(asset=asset, invalid=invalid):
                    script.write_text(original.replace(hashlib.sha256(payload).hexdigest(), invalid))
                    for command in (["bash", str(script)], ["bash", str(script), "--verify-only"]):
                        result = self.run_verify(command)
                        self.assert_refused(result)
                        self.assertIn("checksum pin incomplete", result.stdout)
                        self.assertNotIn("downloading", result.stdout)
        script.write_text(original)

    def test_valid_signed_manifest_cannot_override_recorded_pin(self):
        sums = self.root / "release/SHA256SUMS"
        changed = b"different but signed binary"
        self.sidecar.write_bytes(changed)
        sums.write_text(sums.read_text().replace(
            hashlib.sha256(PAYLOAD).hexdigest(), hashlib.sha256(changed).hexdigest()))
        self.fixture.sign(sums.parent)
        result = self.run_verify()
        self.assert_refused(result)
        self.assertIn("signed SHA256SUMS differs from the checksum pin", result.stdout)

    def test_tampered_or_missing_signature_refused(self):
        sums = self.root / "release/SHA256SUMS"
        sums.write_text(sums.read_text() + "tampered\n")
        self.assert_refused(self.run_verify())
        (sums.parent / "SHA256SUMS.asc").unlink()
        self.assertNotEqual(self.run_verify().returncode, 0)

    def test_throwaway_key_import_path_passes(self):
        empty = self.root / "empty-keyring"
        empty.mkdir(mode=0o700)
        self.env["GNUPGHOME"] = str(empty)
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse((empty / "private-keys-v1.d").exists())

    def test_key_import_works_when_mkdir_cannot_set_permissions(self):
        # Git Bash can create a private temporary directory, but `mkdir -m`
        # fails on the Windows runner. Keep the real GPG/signature checks.
        empty = self.root / "empty-keyring"
        empty.mkdir(mode=0o700)
        self.env["GNUPGHOME"] = str(empty)
        mkdir = self.root / "fakebin/mkdir"
        mkdir.write_text(
            '#!/bin/sh\n'
            'if [ "$1" = -m ]; then\n'
            '  echo "mkdir: cannot change permissions" >&2\n'
            '  exit 1\n'
            'fi\n'
            'exec /bin/mkdir "$@"\n')
        mkdir.chmod(0o755)
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse((empty / "private-keys-v1.d").exists())

    def test_tauri_hook_refuses_mismatch_and_accepts_verified_binary(self):
        config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        hook = config["build"].get("beforeBundleCommand")
        self.assertIsInstance(hook, str, "Tauri must run the G1 pre-bundle gate")
        result = self.run_verify(["bash", "-c", hook])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.sidecar.write_bytes(b"stray binary")
        self.assert_refused(self.run_verify(["bash", "-c", hook]))

    def test_default_tauri_hook_refuses_an_empty_sidecar_directory(self):
        config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
        self.sidecar.unlink()
        result = self.run_verify(["bash", "-c", config["build"]["beforeBundleCommand"]])
        self.assert_refused(result)
        self.assertIn("no src-tauri/bin/konsensus-* sidecars", result.stdout)
        self.assertEqual(list(self.bin.iterdir()), [])

    def test_remote_test_bundle_hook_allows_an_empty_sidecar_directory(self):
        overlay = ROOT / "src-tauri/tauri.remote-only.conf.json"
        self.assertTrue(overlay.exists(), "remote-test overlay must be explicit")
        config = json.loads(overlay.read_text())
        self.sidecar.unlink()
        result = self.run_verify(["bash", "-c", config["build"]["beforeBundleCommand"]])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(list(self.bin.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
