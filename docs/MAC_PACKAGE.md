# Unsigned macOS package

Internal build of `BitSov.app` for Apple Silicon. It is unsigned and not
notarized, and it is not published. It is for internal testers who accept a
Gatekeeper warning. It is not a public download. The protocol pin stays
`v0.3.0-rc7`. Windows packaging is out of scope.

This follows [MAC_PACKAGE_PLAN.md](MAC_PACKAGE_PLAN.md) §1, §2, §4 and §5.
It deviates from §3; see [Deviation](#deviation-release-excludes-the-assistant-page).
The earlier rc6/rc7 spike evidence is in
[MAC_PACKAGE_SPIKE.md](MAC_PACKAGE_SPIKE.md).

## Build locally

Needs macOS arm64, Node 22, Rust, Apple command-line tools, `gh`, and `gpg`.
Use a checkout that is not the tree your running app was built from.

```bash
bash scripts/package-mac.sh            # .app only
bash scripts/package-mac.sh --dmg      # .app and .dmg
```

What the script does:

1. **Sidecar.** Deletes every `src-tauri/bin/konsensus-*`. Then it runs
   `scripts/fetch-node-sidecar.sh` with a throwaway `GNUPGHOME`. That script
   fetches the pinned rc7 release and checks its signature fail-closed. It is
   unchanged here.
   For local dev, `--use-existing-sidecar` (or
   `BITSOV_USE_EXISTING_SIDECAR=1`) keeps an existing
   `src-tauri/bin/konsensus-aarch64-apple-darwin` and skips the fetch. The
   script does not re-verify that file, so use it only with a file the fetch
   script installed.
2. **Build.** Runs `npm ci --ignore-scripts --no-audit --no-fund`. It deletes
   `src-tauri/target/release/bundle` so a stale bundle cannot be checked or
   uploaded. Then it runs
   `npm run tauri -- build --bundles app[,dmg] --no-sign --ci -- --locked`.
   `--ci` skips the Finder layout step of the DMG script, so no volume window
   opens.
3. **Static checks.** Runs `scripts/check-mac-bundle.sh` (below).
4. **Inspection (informational).** `file`, `otool -L`, the sidecar's Mach-O
   `minos`, and `codesign -dvv`. With `--dmg` it also runs `hdiutil verify`,
   which checks the image checksum without mounting it.

It prints `PACKAGE: PASS (structure and sidecar integrity only)` at the end.
The script never opens, launches, or executes the app or the node, and binds
no port. A running app uses port 3141 and the normal application data
directory. A package build does not touch either.

Output:

- `src-tauri/target/release/bundle/macos/BitSov.app`
- `src-tauri/target/release/bundle/dmg/BitSov_<version>_aarch64.dmg` (with `--dmg`)

## Bundle checks

`scripts/check-mac-bundle.sh [--app PATH] [--sidecar PATH] [--dist PATH]`
reads files only. Any failure means exit 1 and `MAC BUNDLE CHECK: FAIL`.

| Check | Why |
|---|---|
| `Contents/MacOS/bitsov-app` and `Contents/MacOS/konsensus` are executable | The app and the bundled node exist |
| `cmp` of the bundled `konsensus` against the verified sidecar | The bundler does not re-verify a sidecar that is already on disk |
| `Contents/Resources/icon.icns` is non-empty | Icon packaging (spike blocker) |
| `Info.plist` lints (`plutil -lint`, or `plistlib` off macOS) | Well-formed bundle |
| `LSMinimumSystemVersion` is `11.0` | Matches the sidecar's Mach-O minimum |
| No `*.sb` anywhere in the bundle | The sandbox profile is passed to `sandbox-exec` as an argument, never shipped as a file (plan §4) |
| Release `dist/` has `index.html` and no `assistant.html` / `assistant-*` | Release excludes the assistant page |
| No `assistant.html` file anywhere in the bundle | Same |
| App binary contains none of the markers below | Release excludes the page and the fixture |

Binary markers:

| Marker | Source |
|---|---|
| `assets/assistant-` | Asset key of the page's Vite chunk. Tauri stores asset keys uncompressed. |
| `script-src 'self'; style-src 'self'; img-src 'none'` | The CSP in `assistant.html`. It is only found if the page was embedded uncompressed. Tauri brotli-compresses asset bodies, so the `dist/` check is the main gate for the page. |
| `Positive controls are answerable from a fresh read` | The `rule` field of `jarvis/fixtures/questions.json` |
| `first_channel_local_msat` | A question key in the fixture. The fixture is embedded only by `include_str!` in `sit_mock.rs`, uncompressed. |

`/assistant.html` is **not** a marker. `main.rs` compiles that navigation
literal into every build.

`scripts/test-check-mac-bundle.sh` tests the checker on fake bundle trees.
It uses no network and builds nothing. It has 19 cases: the good tree passes,
and each of these fails: missing or mismatched sidecar, missing verified
sidecar, missing or non-executable app, missing icon, malformed plist,
10.13 minimum, a `*.sb` file, the assistant page or chunk in dist, missing
dist, a loose `assistant.html`, and each of the four binary markers.
Authority Check runs it on Linux, together with `shellcheck` on the three
scripts. Mac Package runs it on macOS.

## Deviation: release excludes the assistant page

Plan §3 proposed shipping the sealed assistant window in the release package
(`v2`). This package does **not** do that. The three release gates keep the
release behavior main intended for them:

| Gate | Release behavior (unchanged) |
|---|---|
| `vite.config.ts` `assistantIncluded` | false under a Tauri release build (fixed here, see below) |
| `src-tauri/build.rs` capabilities | `PROFILE=release` compiles `capabilities/default.json` only |
| `assistant_dev_enabled` | debug build with `BITSOV_ASSISTANT=1` only |

**Fix to the Vite gate.** The first local package build of this branch failed
`check-mac-bundle.sh`. The release `dist/` had `assistant.html`,
`assets/assistant-*.js`, and `assets/assistant-*.css`, and the app binary
carried the `/assets/assistant-*` asset keys. Main's gate was
`TAURI_ENV_DEBUG !== 'false'`. Tauri CLI 2.11.4
(`crates/tauri-cli/src/helpers/mod.rs`, `command_env`) sets
`TAURI_ENV_DEBUG=true` only for debug builds and never sets it to `false`, so
the gate never excluded the page. It now reads: under Tauri
(`TAURI_ENV_PLATFORM` set, which every CLI hook gets), include the page only
when `TAURI_ENV_DEBUG === 'true'`. Outside Tauri (plain `npm run build`),
include it. `tests/vite-release-gate.test.tsx` covers the four cases. The
capability gate and the window gate were already correct; the page was dead
weight in the binary, not a reachable window.

The bundle checks above enforce this on every package build. The 50-question
fixture (`jarvis/fixtures/questions.json`) is test data only and never ships.
Shipping the assistant window needs a separate ticket that changes all three
gates together and removes the matching checks.

## Minimum macOS version

`tauri.conf.json` sets `bundle.macOS.minimumSystemVersion` to `"11.0"`, so
`Info.plist` has `LSMinimumSystemVersion` 11.0. Before this, the Tauri default
was 10.13, while the rc7 arm64 sidecar's Mach-O minimum is 11.0 (spike,
2026-09-14). JSON has no comments, so this note is the record.
`package-mac.sh` prints the sidecar `minos`. 11.0 is the build floor, not a
tested support claim. No macOS version has runtime evidence yet.

## CI artifact

`.github/workflows/mac-package.yml` ("Mac Package") runs on pushes to `main`,
on `workflow_dispatch`, when a PR is opened non-draft or marked ready for
review, and on every push to a PR labeled `full-ci`. Draft PRs without the
label skip it (macOS minutes cost 10x Linux):

- Runner: `macos-14` (arm64). Toolchain: Node 22 and stable Rust. Permissions:
  `contents: read`. It uses `github.token` read-only for `gh release download`.
- Runs the checker tests, then `scripts/package-mac.sh --dmg`. The sidecar goes
  through the same fetch-and-verify path as the Build workflow's `sidecar`
  job.
- Uploads the artifact `bitsov-unsigned-macos-arm64-<sha>`:
  `BitSov-unsigned-macos-arm64.app.zip` (`ditto -c -k --keepParent`) and the
  `.dmg`. The artifact is kept for 7 days.
- Download it from the run's **Summary → Artifacts** page, or with
  `gh run download <run-id> -n bitsov-unsigned-macos-arm64-<sha>`.

No secrets, signing, notarization, releases, tags, or `gh release` are used.
Mac Package is **not a merge gate**. Like the `sidecar` job, it depends on
network access and on the genome's published release. Keep it out of branch
protection.

## Install the unsigned app (internal testers)

1. Unzip `BitSov-unsigned-macos-arm64.app.zip`, or open the `.dmg`. Drag
   `BitSov.app` to `/Applications`.
2. The first launch is blocked because the app is not notarized. Allow it
   once in either of these ways:
   - Right-click (Control-click) `BitSov.app` → **Open** → **Open**.
   - Try to open it once. Then go to **System Settings → Privacy & Security**,
     find the "BitSov was blocked" message, choose **Open Anyway**, and
     confirm.
3. **Alternative (manual, advanced).** Remove the quarantine attribute that
   the download added:

   ```bash
   xattr -dr com.apple.quarantine /Applications/BitSov.app
   ```

   This skips the Gatekeeper prompt for this copy only. Use it only for a
   build you got from this repository's CI or built yourself.

The app starts a local node on port 3141 and uses the normal application data
directory. Do not run it next to another BitSov app instance.

## HUMAN

None of these are done by this repository or its CI.

| Step | What remains human |
|---|---|
| Developer ID signing | Sign with a Developer ID Application identity (`codesign --sign "Developer ID Application: …" --options runtime`). The bundled `konsensus` sidecar must be signed too. |
| Hardened runtime and entitlements | Choose and review the entitlements that the app and the sidecar need under the hardened runtime. Examples: network client/server for the node, and `sandbox-exec` child launch. |
| Notarization | `xcrun notarytool submit BitSov.dmg --wait` with the team's credentials, then `xcrun stapler staple` on the `.app` / `.dmg` |
| Gatekeeper on a clean machine | `spctl -a -vv` and a first launch on a machine that has never seen the app, with no existing node or wallet |
| Publishing | No release, tag, website download, or release metadata until a signed and notarized build exists. `/bitsov/app` stays a waitlist. |
| PR #13 | `factory/mac-package-spike` stays open. A human decides whether to close it. |
| Pin | Stay on `v0.3.0-rc7` until a separate re-pin ticket. |
