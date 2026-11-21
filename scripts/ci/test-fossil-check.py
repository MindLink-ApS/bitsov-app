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

RESERVED = tuple("".join(map(chr, codes)) for codes in (
    (99, 111, 100, 101, 120),
    (102, 97, 98, 108, 101),
    (103, 114, 111, 107),
    (103, 114, 111, 107, 98, 111, 116),
    (99, 108, 97, 117, 100, 101),
    (97, 116, 108, 97, 115),
    (110, 111, 118, 97),
))
ATTRIBUTIONS = tuple(
    f"{name} {role}"
    for name in ("cursor", "composer")
    for role in ("agent", "review", "reviewer", "findings")
) + tuple(
    f"{action} by {name}"
    for name in ("cursor", "composer")
    for action in ("reviewed", "generated", "authored")
)
SCANNER_EXAMPLES = (
    ("scripts/ci/fossil-check.py",
     '        "session link": re.compile(re.escape("' + RESERVED[4]
     + '.ai/" + "code/session"), re.I),'),
    ("scripts/ci/fossil-check.py",
     r'            r"\.(?:' + RESERVED[4] + "|" + RESERVED[0]
     + r'|agents)[/\\](?:plans?|planning)|"'),
    ("scripts/ci/test-fossil-check.py",
     'SESSION = "' + RESERVED[4] + '.ai/" + "code/session/fixture"'),
    ("scripts/ci/test-fossil-check.py",
     '                  "/".join((".' + RESERVED[4] + '", "plans", "plan.md"))]'),
)


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

    def check_change(self, name, content, expected):
        self.write(name, content)
        self.commit()
        try:
            result = self.check(expected)
            output = result.stdout + result.stderr
            self.assertNotIn(name, output)
            if expected == 1:
                self.assertIn("internal attribution", result.stderr)
                self.assertNotIn(content.strip(), output)
                for token in RESERVED + ("cursor", "composer"):
                    self.assertNotIn(token, output.casefold())
            return result
        finally:
            self.base = self.git("rev-parse", "HEAD")

    def test_reserved_tokens_in_added_comments_titles_and_docs(self):
        for index, name in enumerate(RESERVED):
            for variant, token in enumerate((name, name.upper(), name.title())):
                examples = (
                    ("sample.rs", f"// [{token}]: regression\n"),
                    ("tests/sample.test.ts", f'it("({token}) regression", () => {{}});\n'),
                    ("docs/notes.md", f"## Review: {token}!\n"),
                )
                for location, (path, content) in enumerate(examples):
                    with self.subTest(index=index, variant=variant, location=location):
                        self.check_change(path, content, 1)

    def test_attribution_phrases_are_case_insensitive(self):
        for index, phrase in enumerate(ATTRIBUTIONS):
            for variant, text in enumerate((phrase, phrase.upper(), phrase.title())):
                with self.subTest(index=index, variant=variant):
                    self.check_change("docs/notes.md", f"// [{text.replace(' ', '-')}]: note\n", 1)

    def test_attribution_phrases_do_not_span_added_lines(self):
        for index, phrase in enumerate(ATTRIBUTIONS):
            words = phrase.upper().split()
            for split in range(1, len(words)):
                with self.subTest(index=index, split=split):
                    content = " ".join(words[:split]) + "\n" + " ".join(words[split:]) + "\n"
                    self.check_change(f"docs/wrapped-{index}-{split}.md", content, 0)

    def test_adjacent_added_lines_keep_independent_word_boundaries(self):
        for index, phrase in enumerate(ATTRIBUTIONS):
            words = phrase.split()
            for split in range(1, len(words)):
                with self.subTest(index=index, split=split):
                    content = ("Update the " + " ".join(words[:split]) + "\n"
                               + " ".join(words[split:]) + " status is ready\n")
                    self.check_change(f"docs/adjacent-{index}-{split}.md", content, 0)

    def test_inline_attribution_still_fails_between_benign_added_lines(self):
        for index, phrase in enumerate(ATTRIBUTIONS):
            with self.subTest(index=index):
                text = "\t-- ".join(phrase.upper().split())
                content = f"public text before\n// [{text}]: note\npublic text after\n"
                self.check_change(f"docs/inline-{index}.md", content, 1)

    def test_attribution_fragments_do_not_join_unrelated_changes(self):
        context = "".join(f"unchanged line {index}\n" for index in range(20))
        self.write("notes.md", context)
        self.commit()
        self.base = self.git("rev-parse", "HEAD")
        self.check_change("notes.md", "reviewed by\n" + context + "composer\n", 0)
        self.write("first.md", "reviewed by\n")
        self.write("second.md", "composer\n")
        self.commit()
        self.check(0)
        self.base = self.git("rev-parse", "HEAD")
        self.check_change("first.md", "reviewed by\ncomposer\n", 0)

    def test_punctuation_and_underscores_bound_reserved_tokens(self):
        for index, token in enumerate(RESERVED):
            with self.subTest(index=index):
                self.check_change("notes.md", f"prefix_{token}_suffix /{token}.md {token}'s\n", 1)

    def test_reserved_tokens_in_changed_paths_are_redacted(self):
        for index, token in enumerate(RESERVED):
            with self.subTest(index=index):
                result = self.check_change(f"docs/{token.upper()}-notes.md", "public text\n", 1)
                self.assertIn("changed file path", result.stderr)
                self.assertNotIn(token, result.stdout + result.stderr)

    def test_attribution_phrases_in_changed_paths(self):
        for index, phrase in enumerate(ATTRIBUTIONS):
            with self.subTest(index=index):
                path = "docs/" + phrase.upper().replace(" ", "-") + ".md"
                self.check_change(path, "public text\n", 1)

    def test_benign_text_beside_historical_attribution_and_removal(self):
        for index, token in enumerate(RESERVED):
            with self.subTest(index=index):
                self.write("historical.md", f"// {token}\n")
                self.commit()
                self.base = self.git("rev-parse", "HEAD")
                self.check_change("historical.md", f"// {token}\nnew public text\n", 0)
                self.check_change("historical.md", "new public text\n", 0)

    def test_renaming_a_file_rechecks_attribution(self):
        self.write("historical.md", f"// {RESERVED[0]}\n")
        self.commit()
        self.base = self.git("rev-parse", "HEAD")
        self.git("mv", "historical.md", "renamed.md")
        self.commit()
        result = self.check(1)
        self.assertIn("internal attribution", result.stderr)
        self.assertNotIn(RESERVED[0], result.stdout + result.stderr)

    def test_ordinary_ui_words_provider_identifiers_licences_and_substrings(self):
        provider = "".join(map(chr, (79, 112, 101, 110, 65, 73)))
        lines = [
            "cursor position; composer input; MessageComposer; CursorPosition",
            f"{provider}-compatible endpoint; parse_{provider.lower()}_models",
            "Copyright (c) Example Contributors; SPDX-License-Identifier: MIT",
        ] + [f"prefix{token}suffix {token}Component" for token in RESERVED]
        self.check_change("src/components.txt", "\n".join(lines) + "\n", 0)

    def test_scanner_examples_require_exact_path_and_content(self):
        for index, (path, line) in enumerate(SCANNER_EXAMPLES):
            with self.subTest(index=index):
                self.check_change(path, line + "\n", 0)
                self.check_change(path, line + f" # {RESERVED[0]}\n", 1)
                self.check_change(path, line + " \n", 1)
                self.check_change(f"other/{Path(path).name}", line + "\n", 1)

    def test_added_header_text_cannot_select_an_exception_path(self):
        path, line = SCANNER_EXAMPLES[0]
        self.check_change("notes.md", f"++ b/{path}\n{line}\n", 1)

    def test_filename_alone_does_not_exempt_new_attribution(self):
        for path in ("scripts/ci/fossil-check.py", "scripts/ci/test-fossil-check.py"):
            self.check_change(path, f"// {RESERVED[0]}\n", 1)

    def test_complete_scanner_and_fixture_additions_pass(self):
        self.set_names("synthetic-" + "unreferenced-repository")
        for path in (CHECKER, Path(__file__)):
            self.write("scripts/ci/" + path.name, path.read_text())
        self.commit()
        self.check(0)


if __name__ == "__main__":
    unittest.main()
