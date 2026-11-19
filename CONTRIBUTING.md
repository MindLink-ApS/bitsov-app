# Contributing

BitSov is a signet-only beta. Use test coins and a separate test node for
development. See the [README](README.md) for prerequisites, a clean-checkout
build and pairing instructions.

## Build and test

From the repository root, using Node.js 22:

```sh
npm ci --ignore-scripts
npm test
npm run build
```

These checks are headless and need no node. With Rust and the native Tauri
prerequisites installed, type-check the host and its tests without running
test binaries:

```sh
TAURI_CONFIG="$(cat src-tauri/tauri.remote-only.conf.json)" \
  cargo check --manifest-path src-tauri/Cargo.toml --locked --tests
```

Use targeted checks for the files you change. The diff-scanner tests run with
`python3 scripts/ci/test-fossil-check.py`. Do not run `cargo fmt` or test
binaries that open application windows.

## Propose a change

Open an issue for a substantial change, then send a focused pull request with
the problem, resulting behavior and checks you ran. Describe limitations
honestly; implemented code and real-device acceptance are different evidence.
Keep English and Danish copy consistent when changing user-visible text.

Keep source, documentation, screenshots and commit messages suitable for a
public repository. Use neutral examples; omit personal paths, infrastructure
addresses, private repository references and assistant session links. Report
security concerns through [SECURITY.md](SECURITY.md).

The Fossil Check workflow scans added lines and changed paths. Maintainers
store one SHA-256 hash per line in the Actions repository variable
`FOSSIL_PRIVATE_NAME_HASHES`. To add a hash, run the helper locally:

```sh
python3 scripts/ci/fossil-check.py --hash-private-names
```

Enter one repository slug per line on standard input, then signal end-of-file
(Ctrl-D on an empty line on macOS/Linux). The helper strips surrounding
whitespace and case-folds each slug before hashing it. Append the emitted hashes
to `FOSSIL_PRIVATE_NAME_HASHES` in the repository's Actions variables, preserving
all existing hashes. Keep the input names out of repository variables, tracked
files and shell history.

Only hashes enter CI step environments, so private names do not appear in
the step's environment log. Missing or invalid hash configuration fails the
check. Existing context and deletions are allowed so cleanup can proceed.
