# Signet development node from node `main`

This is an advanced debug workflow for a node binary you build yourself.
**Sidecar signature and checksum verification are bypassed.** The override
requires the non-default `dev-node` feature and is refused in release builds.
Use a fresh signet identity and test coins only. Do not reuse an existing
wallet or mainnet data directory.

For a node you already run, use [DEV_EXTERNAL_NODE.md](DEV_EXTERNAL_NODE.md).
For a native build that needs no node source checkout or sidecar download,
use [DEV_REMOTE_TEST.md](DEV_REMOTE_TEST.md).

## Build the node independently

Install the node repository's Rust/build prerequisites and the app's
[prerequisites](../README.md). From the app checkout, clone the public node
source into a separate temporary directory; no sibling directory or GitHub
CLI authentication is assumed:

```sh
export BITSOV_NODE_SOURCE="$(mktemp -d /tmp/bitsov-node-source.XXXXXX)"
git clone --branch main https://github.com/MindLink-ApS/BitSov-bitsov.git "$BITSOV_NODE_SOURCE"
CARGO_TARGET_DIR="$BITSOV_NODE_SOURCE/target" \
  cargo build --manifest-path "$BITSOV_NODE_SOURCE/Cargo.toml" \
  --release --locked -p konsensus-node --bin konsensus
export BITSOV_DEV_SIDECAR="$BITSOV_NODE_SOURCE/target/release/konsensus"
```

Node `main` can change independently of the app's pinned release. Record the
source commit and binary hash when reporting a compatibility problem.

## Configure signet before starting anything

The node's generated full-tier configuration can default to Bitcoin mainnet.
`init` creates files; **do not run `start` or launch the app until the
configuration below is set to signet**.

```sh
export BITSOV_DEV_DATA_DIR="$(mktemp -d /tmp/bitsov-signet.XXXXXX)"
"$BITSOV_DEV_SIDECAR" init --dir "$BITSOV_DEV_DATA_DIR" --tier full --non-interactive
```

Edit the existing `[lightning]` and `[chain]` sections in
`$BITSOV_DEV_DATA_DIR/konsensus.toml`. Replace these fields in their existing
sections, preserving the other generated fields and avoiding duplicate keys:

```toml
[lightning]
backend = "ldk"
network = "signet"
esplora_url = "https://mempool.space/signet/api"
esplora_url_fallback = "https://mempool.space/signet/api"

[chain]
backend = "esplora"
api_url = "https://mempool.space/signet"
esplora_url_fallback = "https://mempool.space/signet"
```

Both the Lightning wallet and chain provider must use signet, including their
fallback endpoints. Keep the API bound to loopback. If the node's current
schema differs, stop and follow its signet configuration documentation.
The debug launcher does not enforce the network selection for you.

The temporary data directory is for disposable testing and may be removed by
the OS. If you need persistence, choose a private directory outside your home
directory and outside the app's data directories; the host refuses protected
paths and resolves filesystem aliases. Keep any recovery material offline.

## Start and pair

From the app checkout, in the same shell with both override variables set:

```sh
npm ci --ignore-scripts
npm run tauri:dev:mainnode
```

The host uses the already initialized signet directory and starts your binary
on loopback. Compare the pairing code with the node's terminal output, then
confirm that the app reports **signet** before testing wallet or messaging
actions. Stop if the network is different or unknown. Pairing grants
read/receive access; spending requires a separate owner approval. See
[pairing](ONBOARDING_PAIRING.md) for that boundary.

Quit the app to stop its supervised node. Reusing the same two override
variables reuses the identity and pairing. This workflow is not a release
package or evidence of mainnet readiness.
