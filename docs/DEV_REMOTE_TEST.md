# Remote-only test Mac bundle (DEV ONLY)

This beta supports signet test nodes only. The host requires an explicit signet
network report before becoming ready. A missing, unreadable or different
network report refuses the connection and clears session authority. Use test
coins only. The profile does not modify the node's files.

First-run owner setup also requires a signet report from the bootstrap router.
Older nodes that omit this report cannot be initialized from this test app.
Provisional second-device enrollment is unavailable when its restricted session
cannot report the network. Use a node and pairing flow that can confirm signet;
the app does not relax this requirement for setup.

Use this profile to pair a test Mac with a remote node without downloading or
bundling a local `konsensus` sidecar. For a node already running on this Mac's
loopback interface, see [DEV_EXTERNAL_NODE.md](DEV_EXTERNAL_NODE.md).

## Build

For a local unsigned release archive on Apple Silicon, see
[Local Apple Silicon remote test package](LOCAL_MAC_ARM64.md).

On macOS, with the usual npm and Rust/Tauri build prerequisites installed:

```bash
npm ci --ignore-scripts
npm run tauri:build:remote-test
```

This runs `tauri build --debug --bundles app` with
`src-tauri/tauri.remote-only.conf.json`. It builds the frontend and a debug
**BitSov Remote Test.app**, without launching it or creating a DMG. The usual
output is `src-tauri/target/debug/bundle/macos/BitSov Remote Test.app`; when
`CARGO_TARGET_DIR` is set, look under that directory's `debug/bundle/macos/`.
An empty `src-tauri/bin/` is supported. No `BITSOV_DEV_*` variables or `dev-node`
feature are needed.

## Isolation and pairing

- The bundle identifier is `tech.mindlink.bitsov.remotetest`. Tauri therefore
  keeps its app data under
  `~/Library/Application Support/tech.mindlink.bitsov.remotetest/`, separate from
  the production app and other dev profiles. Pairing records, client keys and
  app state use this profile's directory.
- On macOS, the same bundled-identifier check also prefixes AI-thread and
  home-node Keychain services with `tech.mindlink.bitsov.remotetest.`:
  - `tech.mindlink.bitsov.ai-threads.v1` becomes
    `tech.mindlink.bitsov.remotetest.tech.mindlink.bitsov.ai-threads.v1`.
  - `bitsov.node.<id>.seed-password` and its `.wrapped-v1` envelope become
    `tech.mindlink.bitsov.remotetest.bitsov.node.<id>.seed-password` and
    `tech.mindlink.bitsov.remotetest.bitsov.node.<id>.seed-password.wrapped-v1`.
    This includes provisional setup escrow, whose `<id>` is derived from the
    setup box key. The same prefix also separates `box-transport` pins and
    `unlock-binding` items.
  Reads, writes, replacement, escrow deletion and AI legacy-key retirement use
  these scoped names. Keychain-store and old-password fallbacks retain the
  prefix; the test app never looks up or migrates these production items, even
  when both apps pair to the same node. Production and other profile service
  names remain unchanged. Existing unprefixed items from older remote-test
  builds are deliberately not imported or deleted, since they may belong to
  production; enroll the test app's remembered password again if needed.
- This is separate local storage, not a separate macOS account, Keychain,
  Secure Enclave or remote node. Both apps use the same OS storage facilities;
  normal access/biometric prompts for the test app's own items can still occur.
  Device-bound key blobs and assistant ciphertext live in each app's data
  directory. The legacy local-owner launcher service remains unchanged (its
  account is derived from the data-directory path); remote-only mode cannot
  enter the local-node launcher/setup flow. Other dev profiles do not receive
  this Keychain prefix.
- Pairing both apps to one remote node shares that node's identity, funds and
  server-side state. Actions authorized on that node have real effects visible
  to its other clients; use a separate test node for server-side isolation.
- The window title is **BitSov Remote Test — DEV, REMOTE ONLY**.
- The bundled identifier selects a permanent remote-only policy in the host.
  Startup checks saved remote pairing first. Without it, the app asks you to
  pair and never resolves a dev/external node or initializes a local node.
  Local initialization and supervised process launch are also refused at their
  entry points, even if a sidecar executable happens to be present.
- Paste a remote node's pairing link in onboarding, review the ticket and choose
  **Use remote node**, then quit and reopen this test app. Pairing takes effect
  at the next start, using the existing pinned, encrypted remote transport.
- Forgetting a link returns the next launch to the unpaired remote-only state.
  A malformed link or failed remote connection never enables a local fallback.
  The desktop UI's local-node choice cannot override this profile policy.

## Release behavior and checks

The overlay alone sets `bundle.externalBin: []` and replaces
`beforeBundleCommand` with an informational message. The default
`src-tauri/tauri.conf.json` still bundles `bin/konsensus` and runs
`bash scripts/fetch-node-sidecar.sh --verify-only`. Normal release packaging
still requires the pinned, signature-verified sidecar; this profile is an
explicit development bundle, not a replacement release workflow.

Run the offline bundle-hook regression suite with:

```bash
python3 scripts/test-verify-sidecars.py
```

It executes the default hook against an empty sidecar directory and requires a
refusal, then checks that the remote-test hook accepts that same condition.
The fixture uses a temporary GPG keyring and signed release metadata; it never
launches a sidecar or an app window.

Headless compile/frontend checks (no Rust test execution):

```bash
npx tsc --noEmit
npm test
TAURI_CONFIG="$(cat src-tauri/tauri.remote-only.conf.json)" \
  cargo check --manifest-path src-tauri/Cargo.toml --locked --tests
```

`cargo check --tests` also type-checks the Rust profile-policy, exact Keychain
service-name and escrow-deletion isolation regression tests;
it does not run them. The overlay is supplied so Tauri's build script does not
require a sidecar merely to compile this profile.
