#!/usr/bin/env python3
"""Reject private-record references introduced by a Git diff or by its commits."""

import argparse
import hashlib
import hmac
import os
import re
import secrets
import subprocess
import sys


NAMES_ENV = "FOSSIL_PRIVATE_NAMES"
REQUIRE_ENV = "FOSSIL_REQUIRE_PRIVATE_NAMES"


# Reserved tokens and attribution phrases, normalized with casefold and spaces.
POLICY_FINGERPRINTS = {
    "00d7db78ea92db6430e44f4c925706d022d4decfd0a87c78139c9f2bf79f4bd3",
    "09cf980b5ff304ac11b7f6d2c5c263da2a867425798ef5cc5d2ebcf55c4fcd23",
    "0f5615faa87fd36f43f13b7c18bf3f8fcfa024a9f0e514baf59d139b2497261f",
    "108bb55ae60dc859346977247d5bbaec5586c6217a1009581bd459566fe2051c",
    "12d1cf1e8b064be4f05a11dd13a2a22bfea206270de662baf6c75aad41001c0e",
    "19e05df6b2e5fb94f3ee7eed2c02d340a1128a00231f5f6949641a143ab3b57a",
    "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
    "6cb784e0f985cba22d0642283892ad0f90dcd48385524de0dec0f51624456a43",
    "756e76603e7ebf94efe40b9d0d3d4d2849b06cbf779fb06eb6ef4af22ea8dc7a",
    "7c82602500857aa6ed0cf38c4c3e4ec645bdcaa82c00b9155eb08be100c778a9",
    "8eaccb0a677bee7ce210ad4a10603b5b5e9f676da230c5a43629cb888afe9be8",
    "9cd1998fff368cf5fe0d979e1e5b2cbd105d33c42042f93f0c3156304c278b50",
    "9d6eca6d8f5af4e96b67d6fe8e78b0316308dcd6a47f4e83e15043d62a344332",
    "ab9b03aa53d93f046f030af5e5d08a7a1a7a82202259f1c4e24475dec0c5b9f9",
    "add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c",
    "b516d02533b682b6700125a567297f43e79f352fce105ae1288227156efd11d1",
    "bd392ae093ef59bb954cf39ed9988c2656f56e39852b6bfe58e096da4adbc3d7",
    "c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d",
    "cc84e268a498d8e9f4390ec0f2be083cacdcbf546f0a2709691ee93fd3c7f4f9",
    "fb30153f540276446f6390b239fdc8029e86b09cad68127526de7b60d6a34d34",
    "fc8e97b66791870baccf2bf685580210091576601d74b4b11d2515f2b4ae0bd5",
}

# Only these complete, case-sensitive lines at these paths are scanner examples.
EXACT_EXAMPLES = {
    "scripts/ci/fossil-check.py": {
        "fe63a27d5c6003107c9099396a15992a13a6a373924ca9c7f9f17db2910b4b29",
        "5fb0efd039f3a2a12d2c7e0da2c983bdcd751375562ac4e47088f0c0bd40fe09",
    },
    "scripts/ci/test-fossil-check.py": {
        "4a6d709ba2e44e9118ba3e8f59f27b672a8b57a6f6b5305f88972ab50e1cdd87",
        "ce9c85e9db39ff24cee09f88598e810b46f0e86b8df62ab586f6cb3bf17a73e7",
    },
}


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE).decode(
        "utf-8", errors="replace"
    )


def fingerprint(name):
    return hashlib.sha256(name.casefold().encode()).hexdigest()


def load_private_names():
    """Return keyed fingerprints of the configured names, or None when not configured.

    The names are removed from the environment so that no child process inherits
    them, and only HMAC-SHA256 digests under a key drawn for this run are kept.
    The key never leaves this process, so the digests cannot be compared with
    anything outside it. Neither names nor digests are ever printed.
    """
    raw = os.environ.pop(NAMES_ENV, "")
    names = [name.strip() for name in raw.splitlines() if name.strip()]
    del raw
    if not names:
        return None, None
    if not all(re.fullmatch(r"[a-zA-Z0-9_.-]+", name) for name in names):
        raise ValueError
    key = secrets.token_bytes(32)
    digests = {keyed_fingerprint(key, name) for name in names}
    del names
    return key, digests


def keyed_fingerprint(key, name):
    return hmac.new(key, name.casefold().encode(), hashlib.sha256).digest()


def private_names_required():
    value = os.environ.get(REQUIRE_ENV, "true").strip().lower()
    if value not in ("true", "false"):
        raise ValueError
    return value == "true"


def notice(message):
    prefix = "::notice title=Fossil Check::" if os.environ.get("GITHUB_ACTIONS") == "true" else ""
    print(prefix + message)


def is_example(value, path):
    return hashlib.sha256(value.encode()).hexdigest() in EXACT_EXAMPLES.get(path, ())


def has_attribution(value):
    tokens = re.findall(r"[^\W_]+", value.casefold())
    return any(fingerprint(" ".join(tokens[start:start + size])) in POLICY_FINGERPRINTS
               for start in range(len(tokens)) for size in (1, 2, 3))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head")
    args = parser.parse_args()

    try:
        key, private_digests = load_private_names()
    except ValueError:
        print(f"Fossil check requires {NAMES_ENV} to hold one repository slug per line.",
              file=sys.stderr)
        return 2
    try:
        required = private_names_required()
    except ValueError:
        print(f"Fossil check requires {REQUIRE_ENV} to be true or false.", file=sys.stderr)
        return 2
    if private_digests is None:
        if required:
            print(f"Fossil check requires the {NAMES_ENV} repository secret.", file=sys.stderr)
            return 2
        notice("Private repository names are not available to this run, for example on a "
               "pull request from a fork. Checking the public patterns only.")
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

    # Commit metadata only: hosts that exist on one machine or one private network.
    local_address = re.compile(
        r"(?<=[a-z0-9_.%+-])@(?:(?:[a-z0-9-]+\.)*(?:localhost|localdomain|local|lan|internal|home)|"
        r"\[?\d{1,3}(?:\.\d{1,3}){3}\]?)(?![a-z0-9-]|\.[a-z0-9])", re.I
    )
    private_ip = re.compile(
        r"(?<![\d.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|"
        r"192\.168(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2})(?![\d.]*\d)|"
        r"(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*:[0-9a-f:]*", re.I
    )

    def categories(value, path=None, attribution=True):
        found = [label for label, pattern in patterns.items() if pattern.search(value)]
        # Whether attribution trailers belong in commit metadata is not decided, so
        # commit messages and identities are checked for content only.
        if attribution and not is_example(value, path) and has_attribution(value):
            found.append("internal attribution")
        for token in re.findall(r"[a-z0-9_.-]+", value.casefold()) if private_digests else ():
            # Prose punctuation and clone URLs must not hide a repository slug.
            trimmed = token.rstrip(".")
            candidates = {token, trimmed, trimmed.removesuffix(".git")}
            if any(keyed_fingerprint(key, candidate) in private_digests
                   for candidate in candidates):
                found.append("private repository name")
                break
        return found

    def message_categories(line):
        found = categories(line, attribution=False)
        if local_address.search(line):
            found.append("machine-local email address")
        if private_ip.search(line):
            found.append("private network address")
        return found

    def identity_categories(name, email):
        found = categories(name, attribution=False) + categories(email, attribution=False)
        host = email.rpartition("@")[2].strip("[]").casefold()
        if not host or "." not in host or ":" in host or local_address.search("x@" + host):
            found.append("machine-local email address")
        return found

    try:
        base = git("merge-base", args.base, args.head).strip()
        paths = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                    "--diff-filter=ACMT", "--name-only", "-z", base, args.head, "--")
        diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                   "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0",
                   base, args.head, "--")
        log = git("log", "--no-show-signature",
                  "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e",
                  args.head, "^" + args.base, "--")
    except subprocess.CalledProcessError:
        print("Fossil check could not read the complete diff; fetch both commits and their history.",
              file=sys.stderr)
        return 2

    violations = []
    for path in paths.split("\0"):
        violations.extend(("changed file path", category) for category in categories(path))
    in_hunk = False
    current_path = None

    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            in_hunk = False
            current_path = None
        elif not in_hunk and line.startswith("+++ b/"):
            current_path = line[len("+++ b/"):]
        elif line.startswith("@@ "):
            in_hunk = True
        elif in_hunk and line.startswith("+"):
            violations.extend(("added line", category)
                              for category in categories(line[1:], current_path))

    for record in log.split("\x1e"):
        fields = record.strip("\n").split("\0")
        if len(fields) != 6:
            continue
        sha, author, author_email, committer, committer_email, message = fields
        where = f"commit {sha[:12]}"
        for name, email in ((author, author_email), (committer, committer_email)):
            violations.extend((f"{where} identity", category)
                              for category in identity_categories(name, email))
        for line in message.split("\n"):
            violations.extend((f"{where} message", category)
                              for category in message_categories(line))

    if violations:
        # Never echo the offending text or file paths into public Actions logs.
        for location, category in sorted(set(violations)):
            print(f"Fossil check failed: {category} in {location}.", file=sys.stderr)
        return 1
    print("Fossil check passed: no prohibited references added or committed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
