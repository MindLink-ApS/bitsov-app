# BitSov — the sovereign conversational client

**One app — iPhone, Android, Mac, PC — where you fund your node and start talking.**

BitSov is a Bitcoin-anchored sovereign mesh protocol; this repo is its **human-friendly
face**. You carry your own **node / bank / (later) AI**, connect to your own node and to
others, and everything collapses into a conversation organized as **rooms**. Payment is the
connection — reaching you costs a real Bitcoin/Lightning payment you price; the app hides
Lightning and keys behind simple UX.

## Status
Charter set, greenfield. First build: **CS-1 — app shell + node embed** (desktop, T-SELF).
Mobile / paired / hosted / calls / AI are **gated** behind their blockers and are never
marketed as shipped before they exist.

## Boundary (load-bearing — see `docs/ARCHITECTURE_BOUNDARY.md`)
This app **consumes the public BitSov node API over loopback** and bundles the released
`konsensus-node` binary as a supervised subprocess. It does **NOT** fork, vendor, or
in-process-link protocol logic. The app must remain optional to the protocol.

## Stack
Tauri v2 (Rust host) + SolidJS frontend → one codebase to iOS + Android + macOS + Windows.
The Rust host spawns/supervises the node binary and authenticates over `127.0.0.1`.

## Charter & governance
- Live lane ledger: `BOARD.md` (queue-head, blocked, human). Dated tickets: `LEDGER.md`.
- Product charter / milestones / blockers: operator's `CLAUDE_GOAL_BITSOV_APP.md` (also `docs/CHARTER.md`).
- Authority checks (Codex, adversarial): `CODEX_APP_AUTHORITY.md`; verdicts logged in `docs/authority/`.
- Protocol: https://github.com/MindLink-ApS/BitSov-bitsov

## CS-1 local run

The signed bundled-node pin is `MindLink-ApS/BitSov-bitsov@v0.3.0-rc19.2`,
replacing rc14. rc19.2 is signed and published. All five binary pins match its
authenticated signed manifest. The Darwin arm64 sidecar passed local fetch and
`--verify-only`; runtime and packaging acceptance remain separate gates.
See [the upgrade note](docs/NODE_RC19_2_UPGRADE.md) before upgrading retained state.
The release-key fingerprint pin is unchanged. Remote first run is implemented on
main (app #192 + node rc13); runtime acceptance on real hardware (Touch ID + a
fresh Pi) is still pending.

```bash
npm ci
./scripts/fetch-node-sidecar.sh
npm run authority
npm run smoke:cs1
npm run tauri dev
```

### Control center without a node (dev sample mode)

```bash
npm run dev            # open http://localhost:1420 in a browser: sample data, no host, no node
npm run tauri dev      # real host; add ?sample or ?sample=first-run to the URL in a debug build
```

With no Tauri host the shell runs on built-in sample data (`src/control/sample.ts`) and
says so in the rail. A release build inside the host never uses sample data. When the node
fails to start in a debug build, the error screen offers "Explore with sample data".

`npm run smoke:cs1` is the local Linux pass/fail smoke: it starts the signed
node sidecar on loopback, posts to `/auth/local`, reads `/identity`, and prints
`SMOKE: PASS node_id=<node_id>` when the identity path is working.

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

## Immutable constraints (inherited from the protocol charter)
Payment IS the connection · zero plaintext at any layer (incl. remote transport) · the node
is the identity anchor · honesty ceiling (no "replaces Slack/Zoom", no "surveillance-proof",
no "node in your pocket" before the relay, no "call anyone" before NAT traversal).
