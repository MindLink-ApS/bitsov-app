# Local Apple Silicon remote test package

This builds the existing remote-only signet profile on a native arm64 Mac.
It creates an app ZIP and a checksum manifest on the local disk. The script
does not sign, notarize, upload, install or launch the app. The platform linker
may supply its usual ad-hoc executable signature; this is not a signed release.

Commit the source changes first. Choose separate target and artifact directories
outside the checkout, and an artifact directory that does not already exist:

```bash
CARGO_TARGET_DIR="$PWD/../arm64-target" CARGO_BUILD_JOBS=2 \
  python3 scripts/build-local-mac-arm64.py --output-dir ../arm64-artifacts
```

The script installs the locked npm dependencies without lifecycle scripts,
then runs a locked release build for `aarch64-apple-darwin`, selecting
`src-tauri/tauri.remote-only.conf.json` explicitly. It uses two Cargo jobs.
No sidecar is downloaded or bundled. The finished app must have the exact
remote-test bundle identifier, an arm64 executable, and no node sidecar.
The existing profile keeps its separate data directory and requires a signet
network report before becoming ready. Its existing storage requirements apply.

Each invocation takes a per-user lock shared across source checkouts. A second
invocation refuses immediately, as does an active Cargo or Rust compilation.
Build commands run at reduced priority. A separate worker retains the lock and
deadline if the launcher exits. The script refuses a one-minute load average
of 20 or higher, an unreadable load
average, or less than 110 GiB of free space on the root volume. It checks disk
space throughout each command and stops its process group on failure, timeout,
interruption or termination. Dependency installation, compilation and archiving
share one 60-minute budget. Run other local build tools separately.

Source state is checked before and after compilation and before finalization.
The wrapper uses a limited build environment and refuses local frontend
environment files or external Cargo configuration without reading their contents.
Use a fresh target bundle directory for retries after an incomplete package.

The output directory contains:

- `BitSov-Remote-Test-arm64.app.zip`, containing `BitSov Remote Test.app`.
- `build.json`, with the full source commit, target, profile and tool versions.
- `SHA256SUMS`, covering the ZIP and metadata, reread and verified before the
  output directory is finalized. The ZIP contents are checked against the app.

Verify the artifacts locally with `shasum -a 256 -c SHA256SUMS` from the output
directory. Incomplete builds do not finalize an artifact directory. The target
directory can be deleted after recording the archive path and checksum.

Run the offline regression suite with:

```bash
python3 scripts/test-build-local-mac-arm64.py
```

The tests use temporary bundle fixtures and local child processes. They check
resource boundaries, lock contention, reduced priority, timeout cleanup,
profile selection, bundle validation and the local checksum manifest.
Physical launch, pairing and protected-storage acceptance are separate checks.
