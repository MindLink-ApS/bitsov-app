#!/usr/bin/env python3
"""Exercise the public-record gate against real temporary Git histories."""

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CHECKER = Path(__file__).with_name("fossil-check.py")
SESSION = "claude.ai/" + "code/session/fixture"
HOME_PATH = "/".join(("", "Users", "example", "project"))
PRIVATE_NAME = "fixture-confidential-repository"
PLANNING_PATH = "/".join(("docs", "private", "plan.md"))


class FossilCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.set_names(PRIVATE_NAME)
        self.git("init", "-q")
        self.write("notes.txt", SESSION + "\nold public text\n")
        self.commit()
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=tests@example.invalid",
             "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
            cwd=self.repo, env=self.env, text=True, stderr=subprocess.PIPE,
        ).strip()

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def set_names(self, *names):
        self.env["FOSSIL_PRIVATE_NAME_HASHES"] = "\n".join(
            hashlib.sha256(name.strip().casefold().encode()).hexdigest() for name in names
        )

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "-qm", "Update fixture")

    def check(self, expected, base=None):
        result = subprocess.run(
            [sys.executable, str(CHECKER), "--base", base or self.base,
             "--head", self.git("rev-parse", "HEAD")],
            cwd=self.repo, env=self.env, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_clean_addition_ignores_unchanged_fossils(self):
        self.write("notes.txt", SESSION + "\nnew public text\n")
        self.commit()
        self.check(0)

    def test_removing_a_fossil_passes(self):
        self.write("notes.txt", "public text\n")
        self.commit()
        self.check(0)

    def test_added_fossils_fail_without_echoing_the_content(self):
        values = [SESSION, "++ " + SESSION, "prefix\u2028" + SESSION,
                  HOME_PATH, HOME_PATH.replace("Users", "home"),
                  "C:" + HOME_PATH.replace("/", "\\"),
                  PRIVATE_NAME.upper(), PLANNING_PATH,
                  "/".join(("private-planning", "plan.md")),
                  "/".join(("pm", "projects", "fixture", "plan.md")),
                  "/".join((".private", "plans", "plan.md")),
                  "/".join((".claude", "plans", "plan.md"))]
        for index, value in enumerate(values):
            with self.subTest(index=index):
                self.write("added.txt", value + "\n")
                self.commit()
                result = self.check(1)
                self.assertNotIn(value, result.stdout + result.stderr)
                self.base = self.git("rev-parse", "HEAD")

    def test_names_are_literal_and_newline_delimited(self):
        self.set_names("repo.with.punctuation", "second-fixture-name")
        self.write("added.txt", "repoXwithpunctuation\n")
        self.commit()
        self.check(0)
        self.write("added.txt", "second-fixture-name\n")
        self.commit()
        self.check(1)

    def test_repository_names_match_complete_slugs(self):
        self.set_names("fixture")
        self.write("added.txt", "fixture-public\nfixture.example.invalid\n")
        self.commit()
        self.check(0)
        self.write("added.txt", "organization/fixture/plan.md\n")
        self.commit()
        self.check(1)

    def test_repository_name_punctuation_and_git_urls(self):
        for value in [PRIVATE_NAME + ".", PRIVATE_NAME + "...",
                      "https://example.invalid/owner/" + PRIVATE_NAME + ".git",
                      "git@example.invalid:owner/" + PRIVATE_NAME.upper() + ".git."]:
            self.write("added.txt", value + "\n")
            self.commit()
            self.check(1)
            self.base = self.git("rev-parse", "HEAD")

    def test_hash_generation_normalizes_names_without_echoing_them(self):
        result = subprocess.run(
            [sys.executable, str(CHECKER), "--hash-private-names"],
            input=" \n" + PRIVATE_NAME.upper() + " \n", text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.env["FOSSIL_PRIVATE_NAME_HASHES"])
        self.assertNotIn(PRIVATE_NAME.upper(), result.stdout + result.stderr)

    def test_added_file_path_is_checked(self):
        self.write(PLANNING_PATH, "public text\n")
        self.commit()
        self.check(1)

    def test_rename_cannot_hide_a_fossil(self):
        self.git("mv", "notes.txt", "renamed.txt")
        self.commit()
        self.check(1)

    def test_pr_diff_uses_the_merge_base(self):
        self.git("checkout", "-qb", "proposal")
        self.write("proposal.txt", "public text\n")
        self.commit()
        proposal = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "--detach", self.base)
        self.write("base-only.txt", SESSION + "\n")
        self.commit()
        advanced_base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "--detach", proposal)
        self.check(0, base=advanced_base)

    def test_missing_private_name_configuration_fails_closed(self):
        for value in ("", " \n "):
            self.env["FOSSIL_PRIVATE_NAME_HASHES"] = value
            self.check(2)

    def test_invalid_hash_configuration_fails_closed(self):
        self.env["FOSSIL_PRIVATE_NAME_HASHES"] = "invalid"
        self.check(2)

    def test_invalid_or_unavailable_revision_fails_closed(self):
        self.check(2, base="not-a-commit")
        self.check(2, base="f" * 40)


if __name__ == "__main__":
    unittest.main()
