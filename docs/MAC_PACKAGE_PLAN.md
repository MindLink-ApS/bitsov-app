# Mac package plan

Assessment only. No `.app` was built, signed, notarized, or published for this
document. The protocol pin stays `v0.3.0-rc7`. Windows packaging (PR #23) is
out of scope. PR #13's branch `factory/mac-package-spike` was compared and
left unchanged.

| | |
|---|---|
| Main | `7fc92947914e55d12340b88a31be730c8eae5d10` (2026-09-27, #31) |
| PR #13 | [#13](https://github.com/MindLink-ApS/bitsov-app/pull/13), `factory/mac-package-spike` |
| PR #13 head | `0889f17c3c4b02c2cfdddd0f200efcafa22c66bc` (2026-09-14) |
| Merge base | `93c56e0a2346f76e477803850b3b9e48ea426806` |
| Spike commits | `b8135eb` source-gate scope, `0889f17` ICNS + spike notes |
| Spike diff vs main | 6 files, +147 / −3 |

`0889f17` is not an ancestor of main. `git merge-tree --write-tree origin/main
origin/factory/mac-package-spike` exits 1.

## Recommendation: REPLACE

Cut a fresh `factory/mac-package-v2` from current main when the package work
starts. Leave PR #13 open for a human to close. This document does not close
it and does not open the v2 branch.

Reasons:

1. The two spike commits have no remaining payload once conflicts are resolved
   toward main. The ICNS blob and `bundle.icon` entry are already identical on
   main. The source-gate behavior main has is the stricter one from #14
   (`ec13f2a`), whose parent is `93c56e0a`, the same merge base, not
   `0889f17`.
2. Replaying `b8135eb` would put back `grep --exclude-dir=bin`. That exempts
   every directory named `bin`. Main's `control_plane_urls_ok` prunes only the
   exact sidecar directory `src-tauri/bin`, and the regression script rejects
   a control-plane URL under `src-tauri/src/bin` and under `src/bin`.
3. Main since the merge base is the rc7 confirmation (#14), quit-stops-the-node
   (#16 / #17), Jarvis J1–J4 (#21, #22, #20, #26, #27), the J0 isolation spike
   (#24), the SIT reader (#29), the sealed assistant window (#30), and the
   macOS sandbox launcher (#28, #31). Those commits are the tree a package has
   to be built from. Rebasing the spike does not add them, and a conflict
   resolution that keeps the spike side drops the lifecycle CI step and the
   rc7 section of `docs/MAC_PACKAGE_SPIKE.md`.
4. `BOARD.md` still says the rc7 follow-up builds on reviewed head `0889f17`.
   That follow-up is already on main as #14. The sentence describes the review
   base from 2026-09-17, not an unmerged parent of `7fc9294`.

## Conflict table

Compared `origin/main` (`7fc9294`) with `origin/factory/mac-package-spike`
(`0889f17`). Four content conflicts. Two spike paths auto-merge because they
already match main.

| Path | Kind | Spike `0889f17` | Main `7fc9294` | Spike side, if kept |
|---|---|---|---|---|
| `.github/workflows/authority-check.yml` | content | Inserts `bash scripts/test-authority-source.sh` after the authority gate | That step is present, followed by `bash scripts/test-app-lifecycle.sh` (#16 / #17) | Lifecycle step disappears |
| `docs/MAC_PACKAGE_SPIKE.md` | add/add | Spike notes through the 2026-09-14 unsigned package PASS | Same notes, plus the 2026-09-17 rc7 section from #14 | rc7 evidence disappears |
| `scripts/authority-check.sh` | content | `SRC_ONLY` with `grep --exclude-dir=bin` | `control_plane_urls_ok` prunes only `-path src-tauri/bin` | Any directory named `bin` leaves the G2 scan |
| `scripts/test-authority-source.sh` | add/add | Three cases: clean tree, URL bytes in the sidecar path, URL in `src-tauri/src/main.rs` | Those three, plus a URL in `src-tauri/src/bin/helper.rs` and a URL in `src/bin/tool.ts` | The two nested-`bin` rejections disappear |

| Path | Merge | State on main |
|---|---|---|
| `src-tauri/icons/icon.icns` | clean | Same blob on both sides (`234da315ee7a2e140923211f72af916bef06ca63`) |
| `src-tauri/tauri.conf.json` | clean | `bundle.icon` already lists `icons/icon.icns` then `icons/icon.png`; diff is empty |

### Source gate: superseded

The spike's source-gate fix is already on main, in a tighter form, via #14.
It does not need to be revived.

`b8135eb` stopped G2 from reading protocol URLs inside the downloaded sidecar.
The mechanism was `grep --exclude-dir=bin`, so a file under `src/bin/` or
`src-tauri/src/bin/` would also have been skipped. #14 replaced that with a
`find` that prunes `src-tauri/bin` and still walks every other `bin` directory.
`scripts/test-authority-source.sh` on main has five cases. The rc7 section of
`docs/MAC_PACKAGE_SPIKE.md` records that those five passed, including the two
nested directories. The Authority Check workflow already runs that script, then
the app-lifecycle script.

## Packaging steps for current main

These are the steps for a later `factory/mac-package-v2` cut from `7fc9294` or
newer. They were not run for this assessment. Host for the bundle: Apple
Silicon macOS. Product `BitSov`, identifier `tech.mindlink.bitsov`, unsigned
`.app` only (`--bundles app --no-sign`).

Preconditions: Node 22, Rust, Apple command-line tools, `gh`, `gpg`. Lockfiles
select dependencies. Use an isolated checkout. Startup of the built app uses
the normal application data directory and control-plane port 3141, so this
procedure stops at static inspection.

### 1. Sidecar verification (fail-closed `SHA256SUMS.asc`)

The node binary is not committed. Remove any existing
`src-tauri/bin/konsensus-*` before fetching, so a stale file cannot be the one
Tauri bundles. `scripts/fetch-node-sidecar.sh` pins `v0.3.0-rc7` from
`MindLink-ApS/BitSov-bitsov` and installs nothing unless both checks pass.

1. Download `bitsov-darwin-aarch64`, `SHA256SUMS`, and `SHA256SUMS.asc`.
2. `verify_release_signature` accepts the detached signature only when `gpg
   --verify` exits 0, a `GOODSIG` is present, a `VALIDSIG` names
   `B299274C200301714DC6F51A7C2D6F8AC842EF6E`, and none of `REVKEYSIG`,
   `EXPKEYSIG`, `EXPSIG`, `BADSIG`, `ERRSIG`, `KEYREVOKED`, `KEYEXPIRED`,
   `SIGEXPIRED`, or `NO_PUBKEY` appear. `VALIDSIG` alone is cryptographic
   validity; GnuPG still emits it next to revoked or expired statuses, and
   those statuses are refusals. If the pin is absent from the caller's
   keyring, the script imports `RELEASE_KEY.asc` from the genome `main` into a
   throwaway `GNUPGHOME` and requires that file's fingerprint to equal the pin.
   The caller's keyring is left untouched. A refusal prints `REFUSED:` and the
   script exits before `install`.
3. The binary's sha256 must match its line in the signed `SHA256SUMS`.

```bash
rm -f src-tauri/bin/konsensus-*
GNUPGHOME="$(mktemp -d)" bash scripts/fetch-node-sidecar.sh
test -x src-tauri/bin/konsensus-aarch64-apple-darwin
```

The bundler still does not re-verify a sidecar that is already on disk. The
`rm` above plus the post-bundle `cmp` in step 5 are the package-time checks.
`scripts/authority-check.sh` checks source and configuration, not the sidecar
bytes. `scripts/test-fetch-verify.sh` exercises the signature predicate with
local keys and no network; the Build workflow already runs it.

### 2. Authority gate, as it stands on main

Run the gate that main already has. There is no further source-gate patch to
take from PR #13.

```bash
bash scripts/test-authority-source.sh
npm run authority
```

Expected: `AUTHORITY SOURCE TESTS: PASS` (five cases) and `AUTHORITY: PASS`.

### 3. Bundle `assistant.html`

The sealed assistant page is `assistant.html` at the repo root, with its script
entry `src/assistant/main.tsx`. Tauri embeds `frontendDist` (`../dist`) into
the app binary. On macOS the bundled origin is `tauri://localhost` with no
port, and navigation for that window allows only `/assistant.html`
(`assistant_document_allowed` in `src-tauri/src/main.rs`). A loose copy under
`Contents/Resources` is not how this tree serves the page, and it is not the
check.

Current `tauri build` omits the page. Three release gates do that, and a
package that includes the sealed window changes them together:

| Gate | Where | Current release behavior |
|---|---|---|
| Vite input | `vite.config.ts` | `includeAssistant` is false when `TAURI_ENV_DEBUG=false`. The Tauri CLI sets that for a release bundle, so Rollup's input is only `index.html`. A plain `npm run build` leaves the variable unset and still emits the page. |
| Capability set | `src-tauri/build.rs` | `PROFILE=release` compiles `capabilities/default.json` only. `capabilities/assistant.json` is the empty grant for window label `assistant`. |
| Window open | `assistant_dev_enabled` | True only for a debug build with `BITSOV_ASSISTANT=1`. Release builds skip `install_assistant_menu`. The sit-mock builder is `debug_assertions` plus feature `sit-mock`. |

> **Superseded (F6, [MAC_PACKAGE.md](MAC_PACKAGE.md)).** The unsigned package
> does not ship the page. The release excludes `assistant.html` and the fixture,
> and `scripts/check-mac-bundle.sh` enforces that. The Vite row above was also
> wrong about the CLI: release builds leave `TAURI_ENV_DEBUG` unset, never
> `false`. F6 fixes the gate.

`v2` includes the page in the frontend dist that `tauri-build` embeds, compiles
`capabilities/assistant.json` into that same release binary, and opens the
window only through the existing label check. Privileged commands already
refuse every label other than `main` (`reject_sealed_window`). The page CSP in
`assistant.html` stays `default-src 'none'` with `script-src 'self'` and
`style-src 'self'` for the production file. The dev-server plugin relaxes
`style-src` only while Vite is serving the file.

Check, before the Rust compile that embeds `dist`:

```bash
test -s dist/assistant.html
```

The release binary must be built from a tree that contains #30 (`66c57bf`).
This assessment does not change the three gates.

### 4. Bundle the sandbox profile in the binary

The profile that ships is the string `render_profile` builds in
`src-tauri/src/jarvis/sandbox/profile.rs`. The macOS launcher
(`src-tauri/src/model_launch.rs`, `cfg(target_os = "macos")`) passes that
string to `/usr/bin/sandbox-exec` as `-p`. The profile is an argument so it
never sits in a file the confined child can overwrite. If `sandbox-exec` is
missing, the model is not started.

`scripts/spike/j0-confined-child.sb` is the J0 spike profile, including the
test-only `SYSTEM_EXEC` switch. It is not a bundle resource. `v2` does not add
it, or any `.sb` file, to `bundle.resources`.

The package base includes #31 (`7fc9294`), which reaps the sandbox process
group after the leader exits. Building from current main is what carries that
in. There is no separate profile asset to copy into `BitSov.app`.

Check after the bundle exists: no `*.sb` anywhere under `BitSov.app`. The
launcher source on the packaged commit still contains the `-p` argument and
the `render_profile` call.

### 5. Unsigned `.app`

`src-tauri/tauri.conf.json` already lists `icons/icon.icns`. Regenerate that
file only when `src-tauri/icons/icon.png` changes, with the locked Tauri CLI,
and bring in only `icon.icns`.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run tauri -- build --bundles app --no-sign --ci -- --locked

APP=src-tauri/target/release/bundle/macos/BitSov.app
test -x "$APP/Contents/MacOS/bitsov-app" &&
test -x "$APP/Contents/MacOS/konsensus" &&
test -s "$APP/Contents/Resources/icon.icns" &&
plutil -lint "$APP/Contents/Info.plist" &&
cmp src-tauri/bin/konsensus-aarch64-apple-darwin "$APP/Contents/MacOS/konsensus" &&
test -z "$(find "$APP" -name '*.sb' -print)" &&
echo 'PACKAGE: PASS (structure and sidecar integrity only)'
```

`cmp` is the package-time sidecar check against the file step 1 just
verified. `tauri.conf.json` sets no `minimumSystemVersion`. The 2026-09-14
spike recorded a default Info.plist minimum of 10.13 against a sidecar Mach-O
minimum of 11.0. That alignment was not remeasured here and stays open.

Both executables are expected to be Mach-O arm64, with direct `otool -L`
dependencies on Apple system paths. `codesign -dvv` on this unsigned bundle
reports a linker ad-hoc signature. That signature is not Developer ID
distribution signing.

Do not launch the `.app` as part of this check.

## HUMAN

These stay with a person. This plan does not perform them and does not record
a signing identity, an Apple submission, or a download URL.

| Action | What remains human |
|---|---|
| Developer ID signing | Sign the `.app` with a Developer ID Application identity. `--no-sign` is the internal check. |
| Notarization | Submit and staple. Gatekeeper acceptance on a clean machine is a separate result from a successful unsigned bundle. |
| Publish | The app stays unpublished. `/bitsov/app` stays a waitlist. No app artifact is added to website release metadata, and no app release is cut, until a real signed binary exists. |
| Close PR #13 | After `factory/mac-package-v2` exists, a human closes #13. This document only recommends that. |
| Pin | Stay on `v0.3.0-rc7` until a separate re-pin ticket. |
| Windows | PR #23 and the Windows sidecar target are outside this package. |

Historical unsigned-package evidence for rc6 and rc7 remains in
`docs/MAC_PACKAGE_SPIKE.md`. Those runs predate the assistant window and the
sandbox launcher. A `v2` package records its own structural check against the
commit it built.
