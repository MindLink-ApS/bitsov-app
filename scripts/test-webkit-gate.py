#!/usr/bin/env python3
"""Run with python3 scripts/test-webkit-gate.py (only Python, Git and Bash needed).

Execute the workflow's actual gate in a disposable Git repo, not a copied matcher.
No browser, network, npm install, or changes to the working checkout are needed.
"""

import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


WORKFLOW = (Path(__file__).resolve().parents[1] / ".github/workflows/webkit.yml").read_text()
STEP = WORKFLOW.split("      - name: Detect UI changes\n", 1)[1].split("\n      - ", 1)[0]
GATE = re.search(r"        run: \|\n(.*)", STEP, re.DOTALL)
if GATE is None:
    raise RuntimeError("Cannot find the workflow's inline gate")
GATE = textwrap.dedent(GATE[1])

# Config testDir/testMatch, pages opened by the specs, and their imported assets.
MUST_RUN = [
    "tests/a11y/safe-areas.spec.ts",
    "tests/a11y/safe-areas-followups.spec.ts",
    "tests/a11y/dynamic-type.spec.ts",
    "tests/a11y/inputs.spec.ts",
    "tests/a11y/nested/future.spec.ts",
    "tests/fixtures/safe-areas.html",
    "tests/fixtures/safe-areas.ts",
    "tests/fixtures/nested/component.tsx",
    "docs/ui/u2b-dynamic-type/harness/preview.html",
    "docs/ui/u2b-dynamic-type/harness/preview.tsx",
    "docs/ui/u2b-dynamic-type/harness/geometry.ts",
    "src/control/Shell.tsx", "src/styles.css", "src/assets/font.woff2",
    "public/icon.svg", "index.html", "assistant.html", "future.html",
    "pages/nested/entry.html",
    "playwright.webkit.config.ts", "playwright.inputs.config.ts",
    "playwright.safe-areas.config.ts", "playwright.config.mts",
    "vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts",
    "vite.preview.config.ts", "config/vite.config.ts",
    "vitest.config.ts", "tsconfig.json", "tsconfig.node.json",
    "config/tsconfig.app.json", "package.json", "package-lock.json",
    ".github/workflows/webkit.yml", "scripts/test-webkit-gate.py",
    "tests/a11y/path with spaces.spec.ts", "tests/fixtures/line\nbreak.ts",
]
MAY_SKIP = [
    "README.md", "docs/architecture.md", "docs/qa/report.md",
    "src-tauri/src/lib.rs", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
    ".github/workflows/rust.yml", "scripts/package-mac.sh",
    "tests/backend.test.ts", "docs/not-an-entry.html.md",
]


class WebKitGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="webkit-gate-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.output = self.root / "output"
        self.git("init", "-q")
        self.git("config", "user.name", "Gate scenarios")
        self.git("config", "user.email", "gate@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        self.write("src/original.ts")
        self.write("docs/original.txt")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def write(self, path):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n")

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "scenario")
        return self.git("rev-parse", "HEAD")

    def check_gate(self, should_run, base=None, head=None):
        self.output.write_text("")
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", GATE],
            cwd=self.repo, capture_output=True, text=True,
            env={**os.environ, "BASE_SHA": self.base if base is None else base,
                 "HEAD_SHA": self.git("rev-parse", "HEAD") if head is None else head,
                 "RUNNER_TEMP": str(self.root), "GITHUB_OUTPUT": str(self.output)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual("run=false" not in self.output.read_text().splitlines(),
                         should_run, result.stdout + result.stderr)

    def test_single_path_changes(self):
        for should_run, paths in [(True, MUST_RUN), (False, MAY_SKIP)]:
            for path in paths:
                with self.subTest(path=path, should_run=should_run):
                    self.git("reset", "--hard", "-q", self.base)
                    self.write(path)
                    self.commit()
                    self.check_gate(should_run)

    def test_empty_diff(self):
        self.check_gate(False)

    def test_mixed_changes(self):
        self.write("docs/architecture.md")
        self.write("tests/fixtures/safe-areas.ts")
        self.commit()
        self.check_gate(True)

    def test_deleted_ui_path(self):
        (self.repo / "src/original.ts").unlink()
        self.commit()
        self.check_gate(True)

    def test_renames_in_both_directions(self):
        for old, new in [("src/original.ts", "docs/moved.txt"),
                         ("docs/original.txt", "src/moved.ts")]:
            with self.subTest(old=old, new=new):
                self.git("reset", "--hard", "-q", self.base)
                self.git("mv", old, new)
                self.commit()
                self.check_gate(True)

    def test_merge_base_excludes_changes_only_on_main(self):
        self.write("tests/fixtures/main-only.ts")
        main = self.commit()
        self.git("checkout", "--detach", "-q", self.base)
        self.write("docs/pr-only.md")
        self.commit()
        self.check_gate(False, base=main)

    def test_diff_errors_run_tests(self):
        for base, head in [("missing-base", self.base), (self.base, "missing-head"),
                           ("", self.base), (self.base, "")]:
            with self.subTest(base=base, head=head):
                self.check_gate(True, base=base, head=head)

if __name__ == "__main__":
    unittest.main(verbosity=2)
