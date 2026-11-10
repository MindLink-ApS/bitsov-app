# BitSov

BitSov is a client for a node you control. It brings conversations, payments,
wallet activity and node settings into one interface. Messages use the
recipient node's price and your spending approvals and limits.

**This is a signet-only beta. Use signet test coins, never mainnet funds.**
This describes the supported beta deployment; it does not mean every development
profile enforces the network for you. Check your node's configuration before
connecting.

## What works today

The code includes local desktop node supervision, pairing to your own local or
remote node, contacts, paid messages, rooms, file transfers, wallet views and
payment approvals. Availability depends on the connected node's capabilities
and the permissions its owner grants. Room messages are separate paid messages
to each member, encrypted between the sender's node and each recipient's node;
both endpoint nodes can read their contents.

Calls and meetings are experimental. Real-device and cross-network acceptance
is still incomplete, and some networks cannot connect without a media relay,
which the app does not provide. AI interfaces and a local broker exist, but a
complete paid AI service is not shipped. Starter balance is an optional,
disabled-by-default signet feature, not a guaranteed source of test coins.

The app uses SolidJS and Tauri 2. Desktop development is centered on macOS.
Windows has a compile check; Windows and Android are previews, and mobile
source and build projects are not a promise of production-ready distribution.
There are no production signing, notarization or app-store guarantees here.

## Build from a clean checkout

Install Git and Node.js 22 with npm. Clone this repository using its HTTPS URL
and run the following from its root:

```sh
git clone https://github.com/MindLink-ApS/bitsov-app.git
cd bitsov-app
npm ci --ignore-scripts
npm test
npm run build
```

The frontend output is in `dist/`. These commands need no node checkout,
sidecar binary or GitHub CLI login. While this repository is private, cloning
it still requires repository access; after publication the same URL is public.

For a browser preview:

```sh
npm run dev
```

Open the local URL printed by Vite. Without the Tauri host this uses sample
data: it does not connect to a node or perform payments.

### Native development build on macOS

Install the stable Rust toolchain and Xcode command line tools, following the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). After the npm
installation above:

```sh
npm run tauri:build:remote-test
```

This builds a debug **BitSov Remote Test.app** in
`src-tauri/target/debug/bundle/macos/` (or under `CARGO_TARGET_DIR` if set).
It uses the existing remote-only profile, needs no sibling checkout or
authenticated `gh`, and does not bundle or start a local node. Building it does
not launch a window. See [remote-only development](docs/DEV_REMOTE_TEST.md)
for storage isolation and pairing details.

The default bundled-node package is a separate build path: it requires the
pinned, signature-verified `v0.3.0-rc23` node sidecar. See
[Mac packaging](docs/MAC_PACKAGE.md) and [the current node pin](src-tauri/bin/README.md).

## Preview builds

**English:** The Windows Preview and Android Preview workflows provide an unsigned
Windows x64 NSIS installer and an Android ARM64 debug APK. These are unsigned previews
for testing, not supported releases: Windows has no code signature, and Android uses
only a disposable debug key, not a distribution signature. Download `bitsov-preview-*`
artifacts from the workflow run; both the artifact and the installer/APK filename
contain `-preview-`. Artifacts expire after **3 days**. Builds run on pull requests
to `main` that change the frontend, `src-tauri`, or the relevant build workflow,
and can also be started with **Run workflow** (`workflow_dispatch`). They use no
repository secrets and do not publish releases or run the app.

**Dansk:** Workflowene Windows Preview og Android Preview leverer et usigneret
NSIS-installationsprogram til Windows x64 og en debug-APK til Android ARM64. Det er
usignerede forhåndsudgaver til test, ikke understøttede udgivelser: Windows har ingen
kodesignatur, og Android bruger kun en midlertidig debugnøgle, ikke en
distributionssignatur. Hent `bitsov-preview-*`-artefakter fra workflowkørslen; både
artefaktnavnet og installationsprogrammets/APK-filens navn indeholder `-preview-`.
Artefakter udløber efter **3 dage**. Byg køres ved pull requests til `main`, som
ændrer frontend, `src-tauri` eller det relevante build-workflow, og kan også startes
med **Run workflow** (`workflow_dispatch`). De bruger ingen repository-hemmeligheder
og hverken publicerer udgivelser eller starter appen.

## Pair with your own signet node

Run a compatible BitSov node configured for **signet**. Get its pairing
link or one-use QR from its trusted setup interface or an existing owner
device. In onboarding, choose your home node, scan or paste that link, and
review the node details before connecting. Follow any restart instruction
shown by your build. For owner enrollment, use the physical claim code from
your node and compare all four words on the two trusted devices before
approving. Ordinary app pairing grants read/receive access; spending needs a
separate owner approval.

Remote app-to-node traffic uses a pinned, encrypted Noise connection. Message
encryption between nodes is a separate boundary: your node and the recipient's
node process plaintext. The local desktop API uses loopback HTTP/WebSocket;
it is not an encrypted app-to-node connection.

- [Remote pairing and first-run verification](docs/REMOTE_FIRST_RUN.md)
- [App pairing and adding another owner device](docs/ONBOARDING_PAIRING.md)
- [Attach to a signet node already running on your computer](docs/DEV_EXTERNAL_NODE.md)
- [Build a separate signet development node](docs/DEV_NODE_FROM_MAIN.md)

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test and propose changes.
Report security concerns privately as described in [SECURITY.md](SECURITY.md).
