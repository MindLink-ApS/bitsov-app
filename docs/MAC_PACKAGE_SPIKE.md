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
- Mac package: FAIL (command exit 1), after compilation:

  ```text
  Bundling BitSov.app
  failed to bundle project: Failed to create app icon: `No matching IconType`
  ```

  The configured icon is only `icons/icon.png` (1024 x 1024, RGBA). Valid PNG
  checks do not establish macOS icon conversion compatibility. The bundler left
  no usable `.app`; do not treat the release executable as a complete package.

## Next bounded ticket

Generate a macOS ICNS from the existing brand PNG with Tauri's icon tool, wire
that explicit icon into `bundle.icon`, and repeat the same unsigned package
command once. Inspect the completed bundle and compare its sidecar bytes to the
verified download. This is a proposed fix, not tested evidence from this spike.
Do not expand into an installer, signing, or runtime work in that ticket.

This spike stopped after one build attempt. No public artifact was uploaded,
and no Apple submission was attempted; the blocker precedes notarization.

Signing/notarization ownership remains with Rasmus. This spike does not inspect
private signing identities, enroll an account, submit to Apple, or establish any
account/notarization lead time. The website download gate remains closed.
