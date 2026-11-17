# App release checklist

**Signed pin:** rc24 is published, and all five binary pins come from its
verified signed `SHA256SUMS`. Fetch and pre-bundle verification enforce those pins.
Runtime, packaging and hardware acceptance remain separate gates.
The last written upgrade note is [rc19.2 release gates](NODE_RC19_2_UPGRADE.md).

## G1: only the pinned, verified node may be bundled

- [ ] Confirm the pin in `scripts/fetch-node-sidecar.sh` (currently
  `MindLink-ApS/BitSov-bitsov@v0.3.0-rc24`) and the release-key fingerprint.
  A pin change requires its own review; a locally built node is not a release asset.
- [ ] Fetch via `bash scripts/fetch-node-sidecar.sh`, then run
  `bash scripts/fetch-node-sidecar.sh --verify-only`. This downloads the pinned
  release's SHA256SUMS and detached signature, verifies the signature with the
  same trust policy as fetch, and checks every `src-tauri/bin/konsensus-*`.
  Retain the file/target, tag, and accepted sha256 output in the release evidence.
- [ ] Treat any missing file, unknown target, unavailable/invalid trust bundle,
  missing/duplicate/malformed checksum entry, or hash mismatch as a blocked
  package. Compare the reported expected and actual hashes; re-fetch the pinned
  asset and remove unintended files before retrying. Do not override the gate.
- [ ] Build through `scripts/package-mac.sh` or the checked-in Tauri configuration.
  The package script and `beforeBundleCommand` enforce verification, including
  with `--use-existing-sidecar` or `BITSOV_USE_EXISTING_SIDECAR=1`. Existing files
  still require network access for authenticated release metadata.
- [ ] Require Mac Package CI's verification and bundle checks to pass before
  accepting its artifacts. The package script compares bundled node bytes before
  signing; final packaging and CI zip checks verify the signed bundle.
- [ ] Run the offline regressions:
  `bash scripts/test-fetch-verify.sh`, `python3 scripts/test-verify-sidecars.py`,
  `python3 scripts/test-package-mac.py`, and `bash scripts/test-check-mac-bundle.sh`.
  Run `bash scripts/authority-check.sh`, `npx tsc --noEmit`, and `npx vitest run`.
  Authority Check audits source/configuration; it does not replace binary verification.

## Distribution

- [ ] Follow [MAC_PACKAGE.md](MAC_PACKAGE.md) for bundle inspection, Developer ID
  signing, notarization, and clean-machine Gatekeeper checks. An unsigned test
  artifact is not a public release. Preserve G1 evidence for the input sidecar
  before any later code-signing operation changes its bytes.
- [ ] Keep public downloads disabled until the signed and notarized release
  requirements and the applicable authority gates are satisfied.
