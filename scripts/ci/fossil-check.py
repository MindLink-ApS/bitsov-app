#!/usr/bin/env python3
"""Reject private-record references introduced by a Git diff."""

import argparse
import hashlib
import os
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE).decode(
        "utf-8", errors="replace"
    )


def fingerprint(name):
    return hashlib.sha256(name.casefold().encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--hash-private-names", action="store_true",
                        help="Read newline-delimited repository names from stdin and emit hashes.")
    args = parser.parse_args()

    if args.hash_private_names:
        names = [name.strip() for name in sys.stdin.read().splitlines() if name.strip()]
        if not names or not all(re.fullmatch(r"[a-zA-Z0-9_.-]+", name) for name in names):
            print("Provide one repository slug per line.", file=sys.stderr)
            return 2
        print("\n".join(sorted({fingerprint(name) for name in names})))
        return 0

    hashes = {line.strip().lower() for line in
              os.environ.get("FOSSIL_PRIVATE_NAME_HASHES", "").splitlines() if line.strip()}
    if not hashes or not all(re.fullmatch(r"[a-f0-9]{64}", value) for value in hashes):
        print("Fossil check requires valid FOSSIL_PRIVATE_NAME_HASHES repository configuration.",
              file=sys.stderr)
        return 2
    if not all(sha and re.fullmatch(r"[0-9a-fA-F]{40}", sha) for sha in (args.base, args.head)):
        print("Fossil check requires full base and head commit SHAs.", file=sys.stderr)
        return 2

    patterns = {
        "session link": re.compile(re.escape("claude.ai/" + "code/session"), re.I),
        "absolute home path": re.compile(
            r"/(?:Users|home)/[^/\s]+(?:/|$)|"
            r"[a-z]:[\\/](?:Users|home)[\\/][^\\/\s]+[\\/]", re.I
        ),
        "private planning path": re.compile(
            r"(?:^|[/\\\s\"'`])(?:"
            r"\.(?:claude|codex|agents)[/\\](?:plans?|planning)|"
            r"private[-_](?:plans?|planning)|"
            r"\.?(?:private|internal)[/\\](?:docs|plans?|planning)|"
            r"pm[/\\](?:projects|plans?|planning)|"
            r"docs[/\\](?:private|internal|planning)"
            r")[/\\]", re.I
        ),
    }

    def categories(value):
        found = [label for label, pattern in patterns.items() if pattern.search(value)]
        for token in re.findall(r"[a-z0-9_.-]+", value.casefold()):
            # Prose punctuation and clone URLs must not hide a repository slug.
            trimmed = token.rstrip(".")
            candidates = {token, trimmed, trimmed.removesuffix(".git")}
            if any(fingerprint(candidate) in hashes for candidate in candidates):
                found.append("private repository name")
                break
        return found

    try:
        base = git("merge-base", args.base, args.head).strip()
        paths = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                    "--diff-filter=ACMT", "--name-only", "-z", base, args.head, "--")
        diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                   "--no-color", "--unified=0", base, args.head, "--")
    except subprocess.CalledProcessError:
        print("Fossil check could not read the complete diff; fetch both commits and their history.",
              file=sys.stderr)
        return 2

    violations = []
    for path in paths.split("\0"):
        violations.extend(("changed file path", category) for category in categories(path))
    in_hunk = False
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            in_hunk = False
        elif line.startswith("@@ "):
            in_hunk = True
        elif in_hunk and line.startswith("+"):
            violations.extend(("added line", category) for category in categories(line[1:]))

    if violations:
        # Never echo the offending text or file paths into public Actions logs.
        for location, category in sorted(set(violations)):
            print(f"Fossil check failed: {category} in {location}.", file=sys.stderr)
        return 1
    print("Fossil check passed: no prohibited references added.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
