# macOS package (ad-hoc signed by default)

**Signed pin:** rc24 is published, and all five binary pins come from its
verified signed `SHA256SUMS`. Fetch and pre-bundle verification enforce those pins.
Runtime, packaging and hardware acceptance remain separate gates.
See the [pinned release verifier](../scripts/fetch-node-sidecar.sh).

Internal native build of `BitSov.app` for Apple Silicon or Intel. By default it has a valid
ad-hoc signature, no Developer ID identity, and no notarization. It is not published. It is for internal testers who accept a
Gatekeeper warning. It is not a public download. The protocol pin stays
`v0.3.0-rc24`. Windows packaging is out of scope.

See [the assistant-page packaging policy](#deviation-release-excludes-the-assistant-page)
for the release bundle's frontend boundary.

## Keychain and Touch ID

The same ad-hoc artifact supports remote pairing: Keychain writes try data
protection first and retry the local login keychain **only** for missing
entitlement (`-34018`), preserving service/account. Reads prefer data protection;
only not-found/missing-entitlement searches legacy. Signed builds retain data
protection and existing signed items remain readable. The legacy login keychain
uses its unlocked state and application ACL; it has no exact `ThisDeviceOnly`
class and is not synchronized.

“Remember on this Mac” stores an encrypted envelope in either keychain. Its
Secure Enclave agreement key requires the current Touch ID enrollment to decrypt,
so ad-hoc builds do not depend on data-protection entitlements for biometric
gating. Enrollment changes invalidate the saved copy: type the password and
Remember again (restore approval first if the signing key also invalidated).
See [HOME_NODE_UNLOCK.md](HOME_NODE_UNLOCK.md) for wrapping and migration details.

## Build locally

Needs macOS arm64 or x86_64, Node 22, Rust, Apple command-line tools, `gh`, and `gpg`.
Use a checkout that is not the tree your running app was built from.

```bash
bash scripts/package-mac.sh            # .app only
bash scripts/package-mac.sh --dmg      # .app and .dmg
```

### Explicit native architecture

Use a matching native host. Cross builds, Rosetta builds and universal packages are refused:

```bash
bash scripts/package-mac.sh --arch x86_64 --dmg  # Intel host
bash scripts/package-mac.sh --arch arm64 --dmg   # Apple Silicon host
```

An explicit `--arch` passes `--target x86_64-apple-darwin` or
`--target aarch64-apple-darwin` to Tauri. These builds honor
`CARGO_TARGET_DIR` (default `src-tauri/target`), including paths with spaces.
Outputs are isolated under `<target-dir>/<triple>/release/bundle/`:

| Architecture | Source sidecar | App | DMG |
|---|---|---|---|
| Intel | `src-tauri/bin/konsensus-x86_64-apple-darwin` | `macos/BitSov.app` | `dmg/BitSov_<version>_x86_64.dmg` |
| Apple Silicon | `src-tauri/bin/konsensus-aarch64-apple-darwin` | `macos/BitSov.app` | `dmg/BitSov_<version>_aarch64.dmg` |

The native fetcher already maps these names to `bitsov-darwin-x86_64` and
`bitsov-darwin-aarch64` in the signed rc24 `SHA256SUMS`. There is no renamed
or combined universal sidecar. Existing-sidecar mode still authenticates
every installed sidecar. Before signing, the checker requires the app and
node to be thin Mach-O executables of the selected architecture and compares
the bundled node to its authenticated source bytes.

On Intel, omitting `--arch` also selects the Intel target path. The original
implicit ARM command retains its original arguments, fixed target root and
`src-tauri/target/release/bundle/` output for existing callers. Use explicit
`--arch arm64` to select a custom Cargo target root on Apple Silicon.
Explicit target build logs are `<target-dir>/package-mac-<triple>.log`.

For a separate pre-signing check, use
`bash scripts/check-mac-bundle.sh --arch x86_64` (or `arm64`). It selects the
same target-specific app and source-sidecar defaults and honors
`CARGO_TARGET_DIR`; `--app`, `--sidecar` and `--dist` can override paths.
The original checker invocation without `--arch` keeps its legacy defaults.

### Manual Intel CI artifact

`.github/workflows/mac-package-intel.yml` is a separate workflow with only
`workflow_dispatch`. It has no push, pull-request, tag or schedule trigger.
Additional Intel runner use remains an operator decision; adding this file
does not start an Intel build. The existing ARM workflow is unchanged.
The native runner is `macos-15-intel`, as listed in the
[hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

When manually dispatched, it uses the existing ad-hoc packaging path, then
verifies the final resource seal and archives the app and Intel DMG. It uses
only a read-only workflow token for downloads, with no signing credentials,
notarization or release publication. It uploads
`bitsov-unsigned-macos-x86_64-<full-source-sha>` for seven days, containing
`BitSov-unsigned-macos-x86_64.app.zip`, the `_x86_64.dmg`, `build-info.txt`
(source SHA, target, node release/asset/source checksum and tool versions)
and archive `SHA256SUMS`. The `unsigned` name follows the ARM artifact's
convention; the bundle is ad-hoc signed.

This workflow does not launch the app or run the hardware-dependent Keychain
smoke. A native package build does not establish protected-storage support,
pairing or runtime acceptance on a physical Intel Mac. Those checks and the
sidecar's printed `minos` still need acceptance evidence on supported hardware.

`python3 scripts/test-package-mac-arch.py` exercises native target selection,
custom output roots, source-asset selection and architecture refusals offline.
The existing packaging and bundle-checker tests remain unchanged.

For a test build with sealed call audio, add `--call-seal` (with or without
`--dmg`). It adds `--features call-seal` and sets
`VITE_CALL_SEAL=sealed` for the build, matching the enabled CI configuration.
Without this option, the build arguments and environment stay unchanged.

What the script does:

1. **Sidecar.** Deletes every `src-tauri/bin/konsensus-*`. Then it runs
   `scripts/fetch-node-sidecar.sh` with a throwaway `GNUPGHOME`. That script
   fetches the pinned rc24 release and checks its signature and hash fail-closed.
   For local dev, `--use-existing-sidecar` (or
   `BITSOV_USE_EXISTING_SIDECAR=1`) keeps an existing
   `src-tauri/bin/konsensus-aarch64-apple-darwin` and skips the fetch. The
   script then runs `bash scripts/fetch-node-sidecar.sh --verify-only` to
   re-verify **every** existing sidecar against freshly downloaded, signed
   SHA256SUMS from the pinned release. Neither the flag nor the environment
   variable bypasses verification. Unknown targets or mismatched hashes stop
   packaging with expected/actual sha256 diagnostics.
2. **Build.** Runs `npm ci --ignore-scripts --no-audit --no-fund`. It deletes
   `src-tauri/target/release/bundle` so a stale bundle cannot be checked or
   uploaded. Then it runs
   `npm run tauri -- build --bundles app --no-sign --ci -- --locked`.
   Tauri's `beforeBundleCommand` runs the same verification again immediately
   before bundling, including when invoked directly outside this script.
   Tauri completes sidecar placement, resources and plist generation here.
   The script pins `CARGO_TARGET_DIR` to this checkout’s `src-tauri/target`,
   overriding any caller setting so the built and checked paths agree.
   Build output is retained in `src-tauri/target/package-mac.log`.
3. **Pre-signing static checks.** Runs `scripts/check-mac-bundle.sh` (below),
   including a byte-for-byte comparison of the bundled node with the
   authenticated source. This comparison must run **before** re-signing,
   which changes the bundled Mach-O bytes. The source in `src-tauri/bin/`
   stays untouched and remains verifiable against the release manifest.
4. **Final signing.** Signs nested Mach-O files (including
   `Contents/MacOS/konsensus` and framework binaries), then their containing
   code bundles/frameworks, deepest first. Symlinks are not followed. Finally
   signs the outer app with `codesign --force --sign -`. The main executable
   is signed as part of the outer app. There are no bundle edits after this
   point except optional notarization stapling, followed by re-verification.
   Signing deliberately does not use `--deep`.
5. **Hard signature gate.** Requires nonempty
   `Contents/_CodeSignature/CodeResources` and runs
   `codesign --verify --deep --strict --verbose=2`. Any failure stops packaging.
   `spctl -a -vv -t exec` reports Gatekeeper's assessment; rejection is expected
   for ad-hoc signatures and is informational. Code integrity and Gatekeeper
   trust are separate checks.
6. **Inspection.** Prints `file`, `otool -L`, the sidecar's Mach-O `minos`, and
   `codesign -dvv` diagnostics.
7. **DMG.** With `--dmg`, creates a plain compressed image using
   `hdiutil create -srcfolder BitSov.app -volname BitSov -format UDZO`
   (with the full paths), then requires `hdiutil verify` to pass.
   The image contains the **already verified** app. There is no Finder layout
   or Applications shortcut, and no Tauri DMG generation before signing.
   Build, signing, signature verification and image failures are fatal.

It prints `PACKAGE: PASS (structure, source sidecar integrity and final code signature)`.
The script never opens, launches, or executes the app or the node, and binds
no port. A running app uses port 3141 and the normal application data
directory. A package build does not touch either.

Output:

- `src-tauri/target/release/bundle/macos/BitSov.app`
- `src-tauri/target/release/bundle/dmg/BitSov_<version>_aarch64.dmg` (with `--dmg`)

### Why the final signature is required

The old packaging command used `--no-sign`, inspected signatures only with
`codesign -dvv || true`, and could create the DMG before bundle checks. An
arm64 executable's linker-generated ad-hoc signature is not a signature of
its containing app. The reported artifact had no
`Contents/_CodeSignature/CodeResources`, and strict verification reported
“code has no resources but signature indicates they must be present”. A
post-signing bundle edit can also invalidate a seal; the old script enforced
neither a final seal nor its validity.

The final inside-out signing stage follows
[Apple's nested-code signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/).
It runs after all Tauri modifications and replaces any stale signatures.
The DMG always comes afterward. This also replaces the earlier Tauri DMG
fallback (#120) with the same plain `hdiutil` image path on every run,
avoiding Finder automation entirely.

`python3 scripts/test-package-mac.py` exercises the real package script and
bundle checker with a real GPG release fixture and stubbed build/macOS tools.
It covers nested signing order, missing resource seals, signing and strict
verification failures, informational `spctl` rejection, image creation after
verification, optional Developer ID/notary settings, stale outputs, app-only
mode, paths with spaces, and fatal build/check/image errors. It performs no
real build, mount, app launch, or network access. Real signature/DMG evidence
requires running the package script on macOS.

### Local verification (2026-10-20)

Built on macOS 26.6.2 arm64 with Node 22.19.0 using
`bash scripts/package-mac.sh --dmg --use-existing-sidecar` after the fetch
script authenticated rc14’s signed checksum manifest. This is historical rc14
evidence, not rc24 acceptance. The unchanged source
node SHA256 was
`1b8fdecb87a308aff657a476eb92c5b100496c64076e90a45e3bee0fb2301305`.

The unsealed Tauri output reproduced the reported strict verification error.
After final signing, `Contents/_CodeSignature/CodeResources` was present and
`codesign --verify --deep --strict --verbose=2` exited 0:

```text
BitSov.app: valid on disk
BitSov.app: satisfies its Designated Requirement
```

`codesign -dvv` reported `Signature=adhoc` and `Sealed Resources version=2`.
`spctl -a -vv -t exec` rejected the app as expected. `hdiutil verify` passed
for `BitSov_0.0.1_aarch64.dmg`; a separate read-only mount confirmed the image
contains `BitSov.app`, whose strict signature verification also passed. The
image was detached afterward. Neither the app nor the node was launched.
This verifies packaging integrity; it does not establish notarization,
quarantine-launch behavior, or runtime compatibility on another Mac.

### Future Developer ID and notarization hooks

Both are off by default. No certificate or notarization credentials are
loaded by the workflow. A release operator can opt in locally or wire these
variables into a future protected release job:

```bash
BITSOV_MAC_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)' \
BITSOV_MAC_NOTARY_PROFILE='bitsov-notary' \
  bash scripts/package-mac.sh --dmg
```

- `BITSOV_MAC_SIGNING_IDENTITY`: defaults to `-` (ad-hoc). A real identity must
  already be available in an unlocked keychain. It enables hardened runtime
  and secure timestamps for app/nested code, and signs the DMG if requested.
- `BITSOV_MAC_ENTITLEMENTS`: optional app entitlements path for Developer ID
  builds; defaults to `src-tauri/Entitlements.plist`. Ad-hoc builds do not
  receive restricted entitlements. Review app and sidecar runtime needs before
  enabling a production identity; the sidecar receives no extra entitlements.
- `BITSOV_MAC_NOTARY_PROFILE`: unset/empty disables notarization. When set,
  requires a non-ad-hoc identity and a previously configured `notarytool`
  keychain profile. The script submits an app zip with `--wait`, staples the
  app, and re-verifies it before image creation. With `--dmg`, it also submits
  and staples the signed DMG. Submission/stapling failures are fatal.

The real Developer ID/notarization path still needs credentialed release
validation; offline tests only cover its command flow. `APPLE_*` environment
variables do not opt this script into signing/notarization: Tauri runs with
`--no-sign`, and the final stage uses the explicit `BITSOV_MAC_*` settings.

## Bundle checks

`scripts/check-mac-bundle.sh [--app PATH] [--sidecar PATH] [--dist PATH]`
runs on the **pre-signing** app and reads files only. Re-signing the sidecar
changes its bytes, so use `codesign --verify --deep --strict` on the final app
instead of rerunning the source-byte comparison. Any failure means exit 1 and `MAC BUNDLE CHECK: FAIL`.

| Check | Why |
|---|---|
| `Contents/MacOS/bitsov-app` and `Contents/MacOS/konsensus` are executable | The app and the bundled node exist |
| `cmp` of the bundled `konsensus` against the verified sidecar | The output must contain the exact bytes accepted by the pre-bundle release check |
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
tested support claim. Recheck the rc24 sidecar minos in CI using its published signed assets; the historical rc7 inspection is not rc24 binary evidence. No macOS version has runtime evidence yet.

## CI artifact

`.github/workflows/mac-package.yml` ("Mac Package") does not run on every
push to `main`. macos-14 is billed at 10× Linux, so the ad-hoc signed Tauri
bundle runs nightly (05:00 UTC, default branch), on `v*` tags, on
`workflow_dispatch`, and on a pull request when `full-ci` is added. The
label sticks: later pushes to that PR build again. Adding or removing any
other label (for example `merge-ready`) does not start a build. There is no iOS simulator
job; an iOS bundle would use these same triggers. The separate
[Windows and Android previews](../README.md#preview-builds) use relevant
pull requests and manual runs, with three-day artifacts. They remain
unsupported previews. These packaging jobs are not required checks.

- Runner: `macos-14` (arm64). Toolchain: Node 22 and stable Rust. Permissions:
  `contents: read` only. It uses `github.token` read-only for `gh release download`.
- Fetches the pinned sidecar and explicitly re-verifies all sidecars before
  `scripts/package-mac.sh --dmg --use-existing-sidecar`. The offline checker
  unit tests run on Linux in Authority Check, not on this 10× runner. The
  package script and Tauri hook re-check the sidecars too.
  The package script compares the bundled node to the source before signing.
  Before zipping, CI requires the resource seal and repeats strict signature
  verification on the finished app.
- Uploads the artifact `bitsov-unsigned-macos-arm64-<sha>`:
  `BitSov-unsigned-macos-arm64.app.zip` (`ditto -c -k --keepParent`) and the
  `.dmg`. The artifact is kept for 7 days.
- Download it from the run's **Summary → Artifacts** page, or with
  `gh run download <run-id> -n bitsov-unsigned-macos-arm64-<sha>`.

The artifact names retain `unsigned` for compatibility; their contents are
ad-hoc signed. No Developer ID secrets, notarization, or `gh release` are
used. A `v*` tag runs the workflow; it still does not publish a GitHub
Release. Mac Package is **not a merge gate**. Like the `sidecar` job, it
depends on network access and on the genome's published release. Keep it out
of branch protection.

Follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for G1 verification evidence
and the remaining release requirements.

## Install the ad-hoc app (internal testers)

1. Unzip `BitSov-unsigned-macos-arm64.app.zip`, or open the `.dmg`. Drag
   `BitSov.app` to `/Applications`.
2. The app is not notarized and Gatekeeper may block it. Depending on macOS
   policy/version, an override may be available:
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

These remain release-operator responsibilities; the default CI does not enable
the optional Developer ID/notarization hooks.

| Step | What remains human |
|---|---|
| Developer ID signing | Provision the certificate/keychain and opt into `BITSOV_MAC_SIGNING_IDENTITY`; validate the signed app and sidecar. |
| Hardened runtime and entitlements | Choose and review the entitlements that the app and the sidecar need under the hardened runtime. Examples: network client/server for the node, and `sandbox-exec` child launch. |
| Notarization | Configure the team’s `notarytool` profile and opt into `BITSOV_MAC_NOTARY_PROFILE`; validate tickets on the `.app` / `.dmg`. |
| Gatekeeper on a clean machine | `spctl -a -vv` and a first launch on a machine that has never seen the app, with no existing node or wallet |
| Publishing | No release, tag, website download, or release metadata until a signed and notarized build exists. `/bitsov/app` stays a waitlist. |
| PR #13 | `factory/mac-package-spike` stays open. A human decides whether to close it. |
| Pin | `v0.3.0-rc24`; fetch and verify signed checksums before packaging. |

Set `BITSOV_MAC_PROVISION_PROFILE` to the Developer ID provisioning profile
authorized for the app and its private Keychain group. Packaging validates its
team, signing certificate, application identity, groups, distribution scope, and
expiry, and embeds it before final signing.
Signed packages derive their private Keychain access group from the signing team
and bundle identifier. Pairing identities and device-key blobs require owner
presence and stay on this device. The first read migrates older storage only
after a protected readback succeeds; an authentication or migration error stops
access. The running app checks its application-identifier entitlement before
selecting storage. Ad-hoc builds keep the existing Secure-Enclave-sealed client
identity and enclave-wrapped device-key file; no plaintext fallback is allowed.
Only an entitled build migrates those files, retaining the same identity.
Keep the signing team and bundle identifier stable across releases: changing
either can make previously migrated Keychain identities inaccessible.

The Mac package workflow invokes the built executable with
`--keychain-smoke-test` before archiving. This exits before Tauri or any window
starts. It creates and reloads a throwaway client identity through the production
storage selector: an enclave-sealed file for ad-hoc apps, or the user-presence
data-protection Keychain for entitled apps. It prints the path and add/read/delete
results and removes the exact temporary identity. Authentication UI is disabled;
an entitled protected read that requires a prompt fails instead of opening one.
Status polling uses only the public record and file metadata. Protected device
material is read only for signing, on a blocking worker, with one authentication
context shared by the read, migration readback, and enclave signature.

Headless hardware tests can opt into `native-test-keys` in debug macOS builds.
The feature is rejected for release and iOS builds; ordinary builds reject the
prompt-free creation policy. Run the library tests with
`cargo test --lib --features dev-node,local-owner-ceremony,native-test-keys`.
