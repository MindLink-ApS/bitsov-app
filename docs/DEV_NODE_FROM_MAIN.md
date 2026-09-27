# Dev node from genome `main` (DEV ONLY)

> **Sidecar verification is bypassed on this path.** The product app runs only the
> `konsensus` sidecar that `scripts/fetch-node-sidecar.sh` installs after checking the
> pinned release's GPG signature and sha256. This path runs **any binary you point it
> at**, with no signature, hash or version check. Use it only on your own machine, with a
> binary you built yourself. It is not a release, and nothing here publishes one.

Why it exists: the pinned rc7 sidecar has no pairing (#77), so the control center
(#42/#43) can't be tried against a real node. Genome `main` has pairing.

## What it is

- `BITSOV_DEV_SIDECAR=<abs path>` runs that `konsensus` instead of `bin/konsensus-<triple>`.
- `BITSOV_DEV_DATA_DIR=<abs path>` is the node and app data dir. You must set both or neither.
  The host refuses the product app data dir
  (`~/Library/Application Support/tech.mindlink.bitsov`), anything under `~/.konsensus`,
  and `$HOME` itself.
- `npm run tauri:dev:mainnode` (`scripts/dev-node-from-main.sh`) prints a banner with the
  binary's sha256, then runs `tauri dev --features dev-node` with
  `src-tauri/tauri.dev-node.conf.json`. That file sets a separate identifier
  (`tech.mindlink.bitsov.devnode`) and no `externalBin`, so the verified sidecar isn't
  involved at all. The window title reads **"BitSov — DEV NODE (genome main, UNVERIFIED)"**.
- **It can't reach a release build.** The override exists only in `debug_assertions` builds
  with the non-default `dev-node` feature. Every other build compiles a stub that never
  reads the environment. `dev-node` together with `--release` is a `compile_error!`, and
  `scripts/test-dev-node-release-guard.sh` proves that by compiling the combination.
  See `src-tauri/src/dev_node.rs`.

## Tonight: fresh node → pair → funding QR

The node is a **mainnet** node (LDK, `network = "bitcoin"`). Deposit only what you can
afford to lose. Nobody here funds it for you.

**1. Build the node from genome main** (about 5 minutes the first time):

```bash
cd ~/Desktop/BitSov-bitsov && git fetch origin
git worktree add --detach /tmp/bitsov-node-main origin/main   # skip if it already exists
cd /tmp/bitsov-node-main && git checkout --detach origin/main
cargo build --release --locked --target aarch64-apple-darwin -p konsensus-node --bin konsensus
shasum -a 256 target/aarch64-apple-darwin/release/konsensus
```

**2. Get the control center with this dev path.** Until this PR, #42 and #43 land, combine
them locally. Nothing is pushed:

```bash
cd ~/Desktop/bitsov-app && git fetch origin
git worktree add --detach /tmp/bitsov-tonight origin/feat/control-center-ai
cd /tmp/bitsov-tonight
git cherry-pick origin/main..origin/feat/dev-node-from-main
npm ci
```

**3. Start the app on a fresh node.** Pick a new, durable dir. Don't use `/tmp`, because
macOS clears it on reboot and a funded node's keys live in this dir:

```bash
cd /tmp/bitsov-tonight
BITSOV_DEV_SIDECAR=/tmp/bitsov-node-main/target/aarch64-apple-darwin/release/konsensus \
BITSOV_DEV_DATA_DIR="$HOME/BitSov-dev-node" \
npm run tauri:dev:mainnode
```

On first start the app runs `konsensus init` into that dir, which creates the identity,
`konsensus.toml` and the `NODE_INITIALIZED` marker. It then starts the node on
`127.0.0.1:3141`.

**4. Pair.** This happens automatically on first start. The terminal prints
`[node/out] bitsov pairing code for "<pair_id>": XXXX-XXXX`, and the window shows
**"This app is paired"**, access **read + receive**, and the same code followed by
"matches what your node printed". The code is a tripwire, not a lock (see
`docs/ONBOARDING_PAIRING.md`).

**5. Funding QR.** Read the local-trust notice, then click **"I understand — continue to
funding"** → **Wallet** tab → **Deposit to your node** shows the QR and the `bc1…` address.
The node re-checks its wallet every few seconds. The balance and "sats seen" update on
their own.

**6. Back up the recovery phrase before depositing.** The app never shows it. It is the
plaintext file `$HOME/BitSov-dev-node/mnemonic.txt` (mode 0600). Copy it somewhere safe
offline. Losing that dir without the phrase loses the funds.

**Quit** with Cmd-Q. The app stops the node (SIGTERM, then SIGKILL after 30 s). Starting
again with the same two variables reuses the node and the stored pairing.

## Limits

- **Sends:** app #42 refuses variable-price sends unless the node advertises the price-cap
  capability from genome #80 (in review). A `main` build doesn't have it. For sends, build
  from the #80 head (`2f43cfc`) in step 1. Funding and every read work on `main`.
- **Spend:** a paired app gets `read + receive` only. Spending needs the node started by
  you with `--owner-control` and a grant through the owner CLI (genome
  `docs/security/pairing.md`). This path does neither.
- **Live feed pill:** the first smoke run showed "Node up, live feed reconnecting" on an open
  `/ws`. Fixed on #43 (`d4e6048`): the host replays the socket's link state when the shell
  subscribes.

## Smoke run (2026-09-27, this Mac)

Setup: genome `a59815d` (sha256 `6cf4c406f9d15deb48a108dabeda561e9713d1339260ec191882d9f656a47f1f`),
app `feat/control-center-ai` `bd5a09f` with this change cherry-picked, and a throwaway data
dir `/tmp/bitsov-e-smoke-node`. No seed was imported and no funds were sent. No messages
were sent.

Results:

- **init and start:** OK. Paired, with scopes `read` + `receive`, and the short code matched
  the node's stdout.
- **Node view:** Healthy, node id `3f298626…086a49fe` (equal to `GET /identity`), 0 peers,
  block height 968,850, ldk / esplora.
- **Wallet:** 0 sats, 0 channels, and the deposit QR shown.
