# Contributing

BitSov is a signet-only beta. Use test coins and a separate test node for
development. See the [README](README.md) for prerequisites, a clean-checkout
build and pairing instructions.

## Build and test

From the repository root, using Node.js 22.12 or newer (see `.nvmrc`):

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

The Fossil Check workflow scans added lines and changed paths.

Maintainers keep the private repository names in the repository secret
`FOSSIL_PRIVATE_NAMES`, one slug per line. Only the checking step receives the
secret, Actions masks it in logs, and the script keeps only keyed digests under
a key that exists for that run, and prints neither names nor digests. Pull
requests from forks and from Dependabot receive no secrets; for those the
check runs the public patterns only and says so in a notice. On every other
event a missing secret fails the check. Existing context and deletions are
allowed so cleanup can proceed.

To run the check locally without the private list:

```sh
FOSSIL_REQUIRE_PRIVATE_NAMES=false python3 scripts/ci/fossil-check.py \
  --base "$(git rev-parse origin/main)" --head "$(git rev-parse HEAD)"
```
