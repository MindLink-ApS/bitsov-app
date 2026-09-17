# Internal Mac package spike

Scope: build an unsigned Apple Silicon `.app` with the released, GPG-verified
rc6 sidecar. No installer, launch, funds, signing, notarization, public download,
or change to the operator's running app. Claude reviews this Codex-built change.

## Reproduce

Use an isolated checkout, not the live app tree. Prerequisites: Node 22, Rust,
Apple command-line build tools, `gh`, and `gpg`. The lockfiles select dependencies.

```bash
npm ci --ignore-scripts --no-audit --no-fund
GNUPGHOME="$(mktemp -d)" bash scripts/fetch-node-sidecar.sh
bash scripts/test-authority-source.sh
npm run authority
npm run tauri -- build --bundles app --no-sign --ci -- --locked

APP=src-tauri/target/release/bundle/macos/BitSov.app
test -x "$APP/Contents/MacOS/bitsov-app" &&
test -x "$APP/Contents/MacOS/konsensus" &&
test -s "$APP/Contents/Resources/icon.icns" &&
plutil -lint "$APP/Contents/Info.plist" &&
cmp src-tauri/bin/konsensus-aarch64-apple-darwin "$APP/Contents/MacOS/konsensus" &&
echo 'PACKAGE: PASS (structure and sidecar integrity only)'
```

Expected bundle: `src-tauri/target/release/bundle/macos/BitSov.app`.
Do not launch it as part of this check: startup uses the normal application data
directory and control-plane port 3141. A future runtime test needs an explicitly
isolated macOS account/environment, with no existing node or wallet to adopt.

## What the spike establishes

- The sidecar fetch verifies the pinned release signature and binary checksum.
- The authority gate examines app source rather than strings inside the downloaded
  protocol binary. Its regression test also rejects an external API URL in source.
- A release build must embed both the app executable and the fetched sidecar.
- Package structure and a successful build do not prove runtime, recovery,
  Gatekeeper acceptance, or notarization.

## Evidence: 2026-09-14

Base: `93c56e0a2346f76e477803850b3b9e48ea426806`.
Host: macOS 26.6.2, arm64; Rust 1.91.1; Node 22.19.0; Tauri CLI 2.11.4.

- rc6 sidecar: GPG and SHA256 verification PASS using an empty temporary keyring.
- Authority regression tests: PASS (clean checkout, embedded binary URL,
  rejection of non-loopback app-source URL).
- `npm run authority`: PASS after the source-scope fix; failed before it when
  the real sidecar was present.
- Frontend: TypeScript and Vite release build PASS.
- Rust release build: PASS, `Finished release profile [optimized] ... in 4m 27s`.
  The produced app executable is Mach-O arm64. No executable was launched.
- First Mac package attempt: FAIL (command exit 1), after compilation:

  ```text
  Bundling BitSov.app
  failed to bundle project: Failed to create app icon: `No matching IconType`
  ```

  The original configured icon was only `icons/icon.png` (1024 x 1024, RGBA). Valid PNG
  checks do not establish macOS icon conversion compatibility. The bundler left
  no usable `.app`; do not treat the release executable as a complete package.

## Approved follow-up: package PASS

After explicit approval to continue, generated `icons/icon.icns` from the
existing brand PNG with the locked Tauri CLI and added it to `bundle.icon`:

```bash
npm run tauri -- icon src-tauri/icons/icon.png --output /tmp/bitsov-generated-icons
```

Only the generated `icon.icns` was brought into the repository; other platform
icons and the existing source PNG were not changed.

The second package command exited 0; cached Rust compilation took 10.77 seconds.
Tauri reported `Finished 1 bundle`. Static inspection established:

- A complete 66 MiB `BitSov.app`, with both executable files, icon, and Info.plist.
- Both executables are Mach-O arm64; bundled sidecar matches the verified rc6
  binary byte-for-byte (`cmp` exit 0).
- Info.plist names `bitsov-app`, `icon.icns`, and identifier `tech.mindlink.bitsov`.
- `otool -L` lists only Apple system libraries/frameworks for both executables,
  with no Homebrew/local build dependency paths in that direct dependency list.
- No Developer ID signing: `codesign -dvv` reports a linker ad-hoc signature,
  no TeamIdentifier, no sealed resources, and an unbound Info.plist.
- Authority and all three source-gate regression cases still PASS.

The second attempt closes the icon packaging blocker, not the runtime milestone.
No executable was launched. No installer/public artifact was uploaded or Apple
submission attempted. Clean-machine startup, supported macOS version, runtime
identity/recovery, Developer ID signing, and notarization remain separate gates.
In particular, the default Info.plist says macOS 10.13 while the arm64 sidecar's
Mach-O minimum is 11.0; this is not evidence of support for either version.

Signing/notarization ownership remains with Rasmus. This spike does not inspect
private signing identities, enroll an account, submit to Apple, or establish any
account/notarization lead time. The website download gate remains closed.

## rc7 re-pin evidence: 2026-09-17

Follow-up to PR #13, based on its reviewed head `0889f17`. Historical rc6
results above remain unchanged. The commands above now fetch the rc7 pin.

- Fresh fetch of `v0.3.0-rc7` Darwin arm64: pinned GPG signature and SHA256
  verification PASS, using a temporary keyring (no personal signing keys).
- `npm run tauri -- build --bundles app --no-sign --ci -- --locked`: exit 0,
  one `BitSov.app` produced; TypeScript, Vite, and Rust release build passed.
- Package executables and icon present; `plutil -lint` PASS; both executables
  Mach-O arm64. `cmp` confirms the packaged sidecar matches the freshly
  verified download. Direct `otool -L` dependencies are Apple system paths.
- `npm run authority`: PASS. `bash scripts/test-authority-source.sh`: five
  cases PASS, including rejection of external API URLs in `src-tauri/src/bin/`
  and `src/bin/`. Only the exact `src-tauri/bin/` sidecar path is exempt.
- No app or node was launched locally. Linux runtime evidence belongs to the
  PR's sidecar CI job, which now tests rc7's untouched init defaults. Retired
  rc6 endpoint override variables cause the smoke script to fail explicitly.

This is an internal, unsigned package check, not a public distribution or
macOS runtime PASS. The bundler still does not independently verify an existing
sidecar: package-time rejection of stale/tampered binaries remains a separate
pre-public-download gate. Developer ID/notarization, minimum-OS alignment, and
isolated Mac runtime/recovery remain open.
