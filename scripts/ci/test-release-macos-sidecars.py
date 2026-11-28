#!/usr/bin/env python3
"""Real checksum/signature checks with offline downloads and a fake lipo tool."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from sidecar_test_support import ReleaseFixture

LIPO = '''#!/usr/bin/env python3
import base64, json, os, pathlib, sys
args = sys.argv[1:]
if os.environ.get("FAIL_LIPO"):
    sys.exit(23)
if args[0] == "-create":
    data = {arch: base64.b64encode(pathlib.Path(name).read_bytes()).decode()
            for arch, name in zip(["arm64", "x86_64"], args[1:3])}
    pathlib.Path(args[-1]).write_text(json.dumps(data))
elif args[0] == "-verify_arch":
    assert set(json.loads(pathlib.Path(args[-1]).read_text())) == {"arm64", "x86_64"}
elif "-thin" in args:
    data = json.loads(pathlib.Path(args[0]).read_text())
    pathlib.Path(args[-1]).write_bytes(base64.b64decode(data[args[2]]))
else:
    sys.exit(24)
'''


class UniversalSidecarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = ReleaseFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = self.fixture.prepare(self.root)
        ci = self.root / "scripts/ci"
        ci.mkdir()
        shutil.copy2(ROOT / "scripts/ci/release-macos-sidecars.sh", ci)
        lipo = self.root / "fakebin/lipo"
        lipo.write_text(LIPO)
        lipo.chmod(0o755)
        self.out = self.root / "src-tauri/target/release-sidecar"

    def run_script(self, verify=False):
        return subprocess.run(["bash", "scripts/ci/release-macos-sidecars.sh"] +
                              (["--verify-only"] if verify else []), cwd=self.root,
                              env=self.env, capture_output=True, text=True)

    def test_both_authenticated_slices_survive_combination(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        data = json.loads((self.out / "konsensus-universal-apple-darwin").read_text())
        for arch, triple in [("arm64", "aarch64"), ("x86_64", "x86_64")]:
            original = self.root / f"src-tauri/bin/konsensus-{triple}-apple-darwin"
            self.assertEqual(base64.b64decode(data[arch]), original.read_bytes())
        self.assertEqual(self.run_script(verify=True).returncode, 0)

    def test_corrupt_download_is_rejected_before_combination(self):
        asset = self.root / "release/bitsov-darwin-x86_64"
        asset.write_bytes(b"corrupt download")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.out / "konsensus-universal-apple-darwin").exists())

    def test_verify_refuses_modified_slice_without_repairing_it(self):
        self.assertEqual(self.run_script().returncode, 0)
        universal = self.out / "konsensus-universal-apple-darwin"
        data = json.loads(universal.read_text())
        data["x86_64"] = base64.b64encode(b"tampered").decode()
        universal.write_text(json.dumps(data))
        result = self.run_script(verify=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(universal.read_text()), data)

    def test_missing_or_modified_thin_copy_is_rejected(self):
        self.assertEqual(self.run_script().returncode, 0)
        thin = self.out / "konsensus-aarch64-apple-darwin"
        thin.write_bytes(b"tampered")
        self.assertNotEqual(self.run_script(verify=True).returncode, 0)
        thin.unlink()
        self.assertNotEqual(self.run_script(verify=True).returncode, 0)

    def test_lipo_failure_stops_packaging(self):
        self.env["FAIL_LIPO"] = "1"
        self.assertNotEqual(self.run_script().returncode, 0)


if __name__ == "__main__":
    unittest.main()
