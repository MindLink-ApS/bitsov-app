# Open-source readiness audit — bitsov-app

Audited 2026-10-23 against `main` at the time of the run, plus every remote branch
(43 remote branches, 466 unique commits, 1,401 tracked files). This was a read-only pass. No secret
values appear in this file. Findings give only the path, commit, line and type.

Method: `gitleaks v8.21.2 git --log-opts=--all`, plus a regex sweep over every added line
in `git log --all -p` (AWS/Stripe/GitHub/Slack/Google/OpenAI/Anthropic keys, JWTs,
Supabase/Blockstream credentials, `xprv`/WIF/`nsec`, LND macaroons, PEM private keys,
`password=`/`*_TOKEN=` assignments, BIP39-like word runs, tailnet `100.64/10` and RFC1918
IPs, `*.ts.net`, `/Users/…`, e-mail addresses). Sensitive filenames (`.env`, `*.pem`,
`*.key`, `*.p12`, keystores, `*.mobileprovision`, wallet/db files) were also checked across
history, and none were ever committed. npm licences come from `package-lock.json` and
cargo licences from `cargo metadata --locked` (584 crates).

## Verdict

**No live secret found. Nothing needs a history rewrite.** You can open the repo once
the P1 items below are done. P1 is mostly a LICENSE file, deciding which branches to
publish, and moving the factory/agent docs out.

---

## Ranked checklist

### P0 — Blockers (live secret in history → rotate + rewrite history)

- [x] **None.** All 17 gitleaks hits and every regex hit were triaged as test fixtures or
      public values (table below). Nothing needs rotating and no `git filter-repo` is needed.

### P1 — Must fix before flipping the repo public

- [ ] **Add `LICENSE` (MIT, to match BitSov-bitsov).** Without it the code is "all rights
      reserved". Also add `license = "MIT"` to `src-tauri/Cargo.toml`,
      `src-tauri/ffi/Cargo.toml` and `src-tauri/crates/mock-node/Cargo.toml` (none of them
      has a licence field), and add `"license": "MIT"` to `package.json`. Keep
      `"private": true` there, because it only blocks an npm publish.
- [ ] **Decide which branches go public.** Making a GitHub repo public exposes **every
      branch and every `refs/pull/*` ref**, including closed PRs. Branch
      `origin/spike/j0-model-eval` (commits `b52c867c4b`, `b3d46f7e57`, not on `main`) adds
      `eval/provenance.json` and `eval/results/**.json`. Those files contain the owner's
      full macOS home path (`/Users/<first.last-name>`, 15 occurrences). Delete or squash
      that branch first, or publish through a fresh mirror that carries only `main`. Its PR
      ref (#25) persists after the branch is deleted, so a fresh repo or mirror is the only
      complete fix for that one. 41 other stale feature/spike branches exist, so prune
      before publishing.
- [ ] **Remove pointers to the private PM repo.**
      - `docs/O1_NODE_FOLLOWUPS.md:13` points to `MindLink-Private/pm/projects/bitsov/O1-ORGANISM-VIEW-SPEC.md`
      - `design/UI-LANE-MORNING.md:66` refers to `~/Desktop/MindLink-Private`
      - `README.md` "Charter & governance" points readers to `BOARD.md`, `LEDGER.md`,
        `CODEX_APP_AUTHORITY.md` and "operator's `CLAUDE_GOAL_BITSOV_APP.md`"
      - `CODEX_APP_AUTHORITY.md:5` / `docs/CODEX_APP_AUTHORITY.md:5` point to `~/Desktop/CLAUDE_GOAL_BITSOV_APP.md`
- [ ] **Move or delete the factory files** (full table in §3). These are the root
      `BOARD.md`, `LEDGER.md` and `CODEX_APP_AUTHORITY.md`, plus `docs/authority/`,
      `docs/superpowers/`, `design/UI-LANE-MORNING.md` and others.
- [ ] **Rewrite `README.md`.** Its "Status: greenfield" line is stale, and its governance
      section describes the internal agent factory. Replace both with a public status line
      plus Build / Contribute / Licence sections.

### P2 — Should fix (community and hygiene)

- [ ] Add `SECURITY.md`. This is a wallet/keys app, so give a private disclosure channel
      (GitHub private vulnerability reporting, or a security@ address) and the supported
      versions.
- [ ] Add `CONTRIBUTING.md`. Cover the toolchain, `npm ci`, `fetch-node-sidecar.sh`,
      `npm test`, `cargo test`, `npm run authority`, the PR conventions and DCO/CLA (if any).
- [ ] Add `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- [ ] Add `.github/ISSUE_TEMPLATE/` (bug, feature, plus a `config.yml` that sends security
      reports to SECURITY.md) and `.github/pull_request_template.md`.
- [ ] Pin the toolchains: add `rust-toolchain.toml` (CI uses floating `stable`) and
      `.nvmrc` / `engines` (CI uses Node 22, but nothing in the repo says so).
- [ ] Document the Linux system packages in the README. Today they are listed only in
      `scripts/ci/install-tauri-prerequisites.sh`: `libwebkit2gtk-4.1-dev
      build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev
      librsvg2-dev`.
- [ ] `scripts/fetch-node-sidecar.sh` downloads through `gh release download`
      (lines 112, 241). That needs an **authenticated `gh` CLI** even for a public release.
      Add a `curl` fallback against the public release URLs, or document the `gh auth login`
      requirement.
- [ ] Replace the `~/Desktop/<repo>` sibling-checkout assumptions in
      `docs/DEV_NODE_FROM_MAIN.md:44,55` and `docs/UI_E2E_TWO_NODE.md:85` with
      `$BITSOV_NODE_DIR` or a relative path.
- [ ] `.github/workflows/build.yml:8` says "CI cost (private repo, minutes are billed)".
      Public repos get free hosted minutes, so revisit the cost-diet path filters
      (`docs/ci/DIET-2310.md`).
- [ ] Turn on GitHub secret scanning and push protection right after the flip. There are
      no `secrets.*` in any workflow today, which is good.

### P3 — Nice to have

- [ ] Decide on the 536 PNG screenshots (`design/inventory`, `design/after`, `docs/ui/**`)
      and the spike evidence dumps (`docs/spike/evidence/**`). They are harmless, but they
      make the repo heavy (`.git` is 102 MB) and are internal process evidence.
- [ ] Owner first name "Rasmus" appears as decision-maker in `BOARD.md`, `LEDGER.md`,
      `design/CHOICES.md`, `design/UI-LANE-MORNING.md`,
      `design/research/UI-INSPIRATION-0710.md`, `docs/AI-ASSISTANTS.md:78`,
      `docs/MAC_PACKAGE_SPIKE.md:98`, and in a test fixture string at
      `src-tauri/src/app.rs:9951`. It is low risk, but replace it with "maintainer" if you
      want neutrality.
- [ ] `docs/spike/evidence/model/*.txt` and `docs/spike/J0-MACOS-ISOLATION.md:229` record
      `~/Desktop/seat-drafts/...` paths and the dev machine model (Apple M4 Max). The user
      name is already redacted to `<user>`.
- [ ] Add `CHANGELOG` discipline and a `CODEOWNERS` file.

---

## 1. Secret scan (full history, all refs)

| # | Type (rule) | File | Line | Commit | At HEAD? | Verdict |
|---|---|---|---|---|---|---|
| 1 | generic-api-key | `tests/control-shell.test.tsx` | 343 | `e1650ee0b3` | yes (L345) | Test literal `TOKEN` asserting Copy-details redaction. Fake. |
| 2 | generic-api-key | `tests/control-shell.test.tsx` | 308 | `e9ed80d222` | yes | Same literal, earlier revision. Fake. |
| 3–6 | generic-api-key | `src-tauri/tests/fixtures/remote-first-run-pr287.json` | 10, 12, 23, 25 | `5649108bab` | yes | Ed25519/X25519 **public keys and signatures** from deterministic seeds (`07*32`, `09*32`, `0c*32`, documented in the file's `source`). Not secret. |
| 7 | generic-api-key | `src-tauri/tests/fixtures/home-node.json` | 13 | `862ff62c12` | yes | Public transport key. `box_secret` in the same file is a constant-byte test value. |
| 8 | generic-api-key | `scripts/sidecar_test_support.py` | 75 | `377f58cd9b` | yes | Release-key **GPG fingerprint** (public pin). |
| 9 | generic-api-key | `scripts/fetch-node-sidecar.sh` | 10 | `96dbbc43a8` | yes (pin) | Same public GPG fingerprint. |
| 10 | generic-api-key | `scripts/test_ui_e2e_harness.py` | 78 | `585b0d4fe1` | yes (L92) | JWT-shaped test string (`{alg}.{sub}.signature`), used to test redaction. Fake. |
| 11–12 | private-key | `scripts/test_two_node_harness.py` | 75, 158 | `8b6c426b0a` | yes | `-----BEGIN PRIVATE KEY-----\nsecret\n…` redaction canaries. Not a key. |
| 13–16 | generic-api-key | `eval/provenance.json` L19, `eval/results/**qwen3-8b*.json` L2 | — | `b52c867c4b`, `b3d46f7e57` | no (branch `spike/j0-model-eval` only) | `model_key` = model name string. Not secret. **The same files carry the personal path; see P1.** |
| 17 | generic-api-key | `src-tauri/src/jarvis/broker/tests.rs` | 529 | `35432295f7` | yes | Mock channel JSON with a fake 66-hex pubkey. |

Supplementary regex sweep, all hits triaged:
- `bearer` → `src-tauri/src/jarvis/assistant_feed.rs` (`#[cfg(test)]` const, readable
  placeholder token) and `scripts/test_two_node_harness.py` (redaction canary).
- `KC_SECRET=` → `scripts/spike/run-isolation-tests.sh:141`, a literal canary string written
  to a **throwaway keychain** to prove isolation. Not a credential.
- BIP39-like word run → `scripts/spike/j0spawn.c:23` is a code comment. `'abandon '*12` in
  `scripts/test_two_node_harness.py:74` is the well-known all-zero test mnemonic, used as a
  redaction canary.
- **Zero hits** for AWS, Stripe, GitHub PAT, Slack, Google, OpenAI, Anthropic, Supabase
  (`supabase.co`), Blockstream credentials, `xprv`/`tprv`, WIF, `nsec`, LND macaroons,
  real e-mail addresses (only `example.invalid` / `example.test` / `example.org`), or
  `.env` files.

## 2. Private references

| Kind | Where | Status |
|---|---|---|
| Owner's full macOS home path `/Users/<first.last>` | `eval/**` on `spike/j0-model-eval` (`b52c867c4b`, `b3d46f7e57`) | **Not on main.** P1: drop the branch or publish from a clean mirror. |
| Private PM repo `MindLink-Private/pm/…` | `docs/O1_NODE_FOLLOWUPS.md:13`, `design/UI-LANE-MORNING.md:66` | P1 |
| Out-of-repo operator charter `~/Desktop/CLAUDE_GOAL_BITSOV_APP.md` | `README.md`, `CODEX_APP_AUTHORITY.md:5`, `docs/CODEX_APP_AUTHORITY.md:5` | P1 (`docs/CHARTER.md` is the in-repo copy) |
| `~/Desktop/...` dev paths | `docs/DEV_NODE_FROM_MAIN.md`, `docs/UI_E2E_TWO_NODE.md`, `docs/spike/**` | P2/P3 |
| Generic `/Users/owner`, `/Users/operator`, `/Users/you`, `/Users/o` | tests, `src-tauri/src/jarvis/sandbox/profile.rs`, `main.rs`, `src/control/sample.ts` | OK. Placeholders. |
| Tailnet IPs (`100.64.0.1`, `100.64.0.2`, `100.127.255.255`) and `*.ts.net` (`tail.ts.net`, `box.ts.net`, `tailnet.ts.net`) | `src-tauri/src/remote_access.rs`, `remote_connect_tests.rs`, `android_network.rs`, `LocalNetworkPolicyTest.kt` | OK. CGNAT boundary values and placeholder names in classifier tests. No real tailnet. |
| RFC1918 IPs (`192.168.1.x`, `10.0.0.x`, `172.20.10.5`) | tests, sample data, network policy | OK. Test/sample values. |
| Public repo links `github.com/MindLink-ApS/BitSov-bitsov` (27), `…/bitsov-app` (2) | docs, scripts | OK. |
| Author identity | all commits are by `RaslaTL19 <info@mindlink.tech>` | OK. Company address. |
| Owner first name "Rasmus" | see P3 | Low |
| App identifier `tech.mindlink.bitsov` | `tauri*.conf.json`, Android package | OK. Public bundle ID. No Apple Team ID or Android signing config is committed. |

## 3. Factory files

| Path | What it is | Recommendation |
|---|---|---|
| `BOARD.md` | Factory lane ledger (queue-head, blocked, "Rasmus decides") | **Move** to the private PM repo |
| `LEDGER.md` | Dated agent ticket rows | **Move** |
| `CODEX_APP_AUTHORITY.md` (root) | Codex agent prompt/charter for adversarial authority checks | **Move.** It also **differs** from `docs/CODEX_APP_AUTHORITY.md`, so the two copies have drifted. |
| `docs/CODEX_APP_AUTHORITY.md` | Same agent prompt | **Move.** Before moving, extract the human-readable invariants (G1–G6) into `docs/INVARIANTS.md` and keep that. |
| `docs/authority/*.md` | Codex verdict log | **Move** (or keep as a historical design record, owner's call) |
| `docs/superpowers/plans/2026-10-21-onboarding-connect.md` | Agent execution plan ("Push only feat/…") | **Delete** |
| `design/UI-LANE-MORNING.md` | Agent lane morning summary, `/loop` questions to the owner | **Delete** |
| `design/CHOICES.md`, `design/choice-board.html` | Owner decision board for an agent | **Move**, or keep as a design record with the names neutralised |
| `docs/CHARTER.md` | `CLAUDE_GOAL_BITSOV_APP`, a `/goal` agent prompt that doubles as the product charter | **Keep, rewritten** as `docs/ROADMAP.md` without the `/goal` framing |
| `docs/TEST5_RUN2_FIXES.md`, `docs/qa/UIUX-SWEEP-*.md`, `docs/PHONE_ONBOARDING_PR*.md`, `docs/ANDROID_PARITY_SLICE_*.md`, `docs/NODE_RC*_UPGRADE.md` | Per-PR/per-run work notes | **Keep** the upgrade notes (users need them). **Move** the sweep/run notes. |
| `docs/spike/**`, `scripts/spike/**` | J0 macOS isolation spike + evidence | **Keep** if the sandbox ships (it backs `src-tauri/src/jarvis/sandbox`), else move |
| `jarvis/fixtures/questions.json` | Assistant eval fixture | **Keep.** Code reads it (`src/assistant/questions.ts`, `src-tauri/src/jarvis/sit_mock.rs`, `mock-node` tests). |
| `src-tauri/src/jarvis/**` | Product code (local assistant broker) | **Keep** |
| `scripts/authority-check.sh` + `.github/workflows/authority-check.yml` | Executable product gate (loopback-only URLs, etc.) | **Keep.** Repoint the header comment away from `CODEX_APP_AUTHORITY.md`. Nothing in code reads the factory files. |
| `.github/workflows/build.yml` `pm/**` path filter | Factory convention | **Keep or trim.** Harmless. |

## 4. Licences

**Is MIT compatible with every dependency? Yes.** Nothing copyleft gets into the shipped
binary in a way that conflicts with MIT.

**Bundled assets (`third_party/`)**
- `src/assets/fonts/inter-latin-wght-normal.woff2`: Inter, **SIL OFL 1.1**
  (`third_party/fonts/OFL-Inter.txt`).
- `src/assets/fonts/instrument-serif-latin-400-normal.woff2`: Instrument Serif,
  **OFL 1.1**.
- OFL lets you bundle the fonts with MIT software. You must keep the licence text, which
  the repo already does, and you may not sell the fonts on their own.
- Bundled sidecar: the `konsensus` node binary is fetched at build time from
  BitSov-bitsov (MIT) and is never committed.

**npm** (190 packages, 8 runtime)
- MIT 155, Apache-2.0 OR MIT 13, Apache-2.0 8, ISC 6, BSD-2/3 3, MIT OR Apache-2.0 2.
- **MPL-2.0 (weak copyleft): `axe-core`, `@axe-core/playwright`. Dev-only, for a11y tests.
  Not shipped.**
- CC-BY-4.0: 1 (`caniuse-lite`, dev/build data). Not shipped.
- Runtime deps: `@tauri-apps/api`, `@tauri-apps/plugin-barcode-scanner`,
  `@tauri-apps/plugin-notification`, `solid-js`, `jsqr`. All are MIT or Apache-2.0.

**cargo** (584 crates)
- The vast majority are MIT and/or Apache-2.0 dual licences. There are also Unicode-3.0
  (18), CC0 (12), Zlib, ISC, BSD, BSL-1.0, MITNFA and CDLA-Permissive-2.0. All are
  permissive.
- **MPL-2.0 (weak, file-level copyleft): `cssparser` 0.37.0, `cssparser-macros` 0.7.1,
  `dtoa-short` 0.3.5, `selectors` 0.38.0, `option-ext` 0.2.0.** These are transitive deps
  of Tauri/wry and `dirs`.
  - MPL-2.0 is compatible with an MIT app: you only have to publish changes to those
    files, and you are not modifying them.
  - Mention them in a `THIRD_PARTY_NOTICES` (e.g. `cargo about generate`).
- `r-efi`: `MIT OR Apache-2.0 OR LGPL-2.1-or-later`. You can pick MIT, so nothing to do.
- **No GPL, AGPL or LGPL-only crates.**
- Workspace crates `bitsov-app`, `bitsov-ffi` and `mock-node` have **no `license` field**
  (see P1).

Recommendation: add a `cargo-deny` licence allow-list to `dependency-audit.yml` so a
copyleft crate can't slip in later. Ship a generated `THIRD_PARTY_NOTICES` with release
bundles: Apache-2.0 and BSD require the attribution, and Unicode-3.0 requires the notice.

## 5. Community files

| File | Present? |
|---|---|
| `LICENSE` | **Missing (P1)** |
| `SECURITY.md` | Missing (P2) |
| `CONTRIBUTING.md` | Missing (P2) |
| `CODE_OF_CONDUCT.md` | Missing (P2) |
| `.github/ISSUE_TEMPLATE/` | Missing (P2) |
| `.github/pull_request_template.md` | Missing (P2) |
| `CODEOWNERS` | Missing (P3) |
| `CHANGELOG.md` | Present |
| `README.md` | Present. Needs a public rewrite (P1). |
| `.gitignore` | Present and good. Covers `.env*`, sidecar binaries, `*.gguf`, `target/`, `node_modules/`. |

## 6. Build reproducibility from a clean clone (assessed from the docs, nothing executed)

Documented path (`README.md` → "CS-1 local run"):
`npm ci` → `./scripts/fetch-node-sidecar.sh` → `npm run authority` → `npm run smoke:cs1`
→ `npm run tauri dev`.

What works:
- `package-lock.json` and `Cargo.lock` are committed. `npm ci` and `cargo --locked` are
  deterministic: `cargo metadata --locked` resolved all 584 crates from a clean
  environment in this audit.
- The sidecar comes from a public, **GPG- and SHA256-pinned** release and fails closed.
- `npm run dev` gives a browser-only sample mode that needs no node or Rust. That is a
  good first-contributor path.
- CI builds Linux, Android, Windows and macOS from scratch, so the steps are exercised.

Gaps an outside contributor will hit:
1. **`gh` CLI login is required.** `fetch-node-sidecar.sh` uses `gh release download`.
   Without `gh auth login` the fetch fails. P2: add a curl fallback.
2. **No toolchain pins.** There is no `rust-toolchain.toml`, `.nvmrc` or `engines`. CI uses
   floating Rust `stable` and Node 22.
3. **System packages are undocumented.** The Linux WebKitGTK/AppIndicator/etc. list lives
   only in a CI script, and the README has no macOS/Windows prerequisites (Xcode CLT,
   WebView2, MSVC).
4. `gpg` must be installed for sidecar verification. The README doesn't say so.
5. Node-from-main dev flows assume `~/Desktop/BitSov-bitsov` as a sibling checkout.
6. iOS/Android builds need the owner's signing identities. That is expected, but should be
   stated in a "Platforms" section, with debug-signing instructions.
7. `npm run authority` is a charter gate. It should be documented as a required pre-PR
   check in CONTRIBUTING.

---

*Generated by a read-only cloud audit agent. Re-run before the visibility flip, because
new commits may add findings.*
