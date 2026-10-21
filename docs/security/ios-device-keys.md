# iOS device and client keys

The approval key uses the existing Apple CryptoKit Secure Enclave bridge on iOS.
The node contract (`konsensus-api/src/pairing/device.rs`, `parse_public_key`
and `verify_p256`) is a 65-byte SEC1 uncompressed P-256 public key
(`04 || X || Y`, hex on the wire) and an ASN.1 DER ECDSA signature over SHA-256.
The shared bridge preserves these encodings and canonical messages.

`SecAccessControl` uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` with
`privateKeyUsage` and `biometryCurrentSet`. Each ordinary signature receives a
fresh `LAContext`; biometric enrollment changes invalidate access. The existing
one-use, 120-second, key/node/client-bound setup authorization remains shared.
iOS rejects the non-biometric test policy in both Rust and Swift. There is no
software signing fallback. Only the enclave-wrapped CryptoKit representation,
public key, and signatures leave the bridge; the raw private key is never exported.
The wrapper blob creates no synchronizable Keychain item and cannot be used on
another enclave. Face ID purpose text is present in both plist sources and the
XcodeGen specification.

The separate Ed25519 client identity cannot live in the P-256-only enclave. Its
32-byte seed is stored as a generic-password item in the Data Protection
Keychain with `WhenUnlockedThisDeviceOnly` and `kSecAttrSynchronizable = false`.
Its account includes the app/profile directory relative to Application Support,
so a changed iOS container UUID does not rotate identity. Only the app process
receives a short-lived seed for Ed25519 signing; nothing is returned to the
renderer or logged. Rust migration buffers are zeroized; Swift clears owned Data
buffers, but Foundation/Security may have internal copies outside our control.

Migration inserts without replacing an existing item, reads back and verifies
it, durably records the public identity, then overwrites, syncs, and removes the
legacy file. Failed reads, writes, verification, and identity conflicts preserve
the original file and fail closed. A missing Keychain item after migration never
silently creates a new identity. Recovery accepts a partially or fully zeroed
cleanup file only when the public marker matches the Keychain identity and every
remaining byte matches its original hex encoding. Symlinks and hardlinks are
refused. Overwriting cannot promise erasure of historic APFS/flash blocks or old
backups; migration removes the live plaintext file and prevents new plaintext
writes. It does not manipulate existing backups.

On iOS, deletion of the app removes its container but can leave the client
Keychain item behind. Before any pairing task or command runs, startup checks
the app data directory. A `.ios-setup-complete` marker, or any other surviving
app/pairing data, protects the existing identity, including on upgrades from
versions without this marker. Unknown, corrupt or incomplete state also counts;
an inspection error aborts setup without deleting anything. Only an absent/empty
directory, or an `app-client` directory containing nothing except the legacy
client key, qualifies for fresh-install cleanup.

Fresh-install cleanup deletes the exact profile-scoped client Keychain item
without reading its seed or allowing authentication UI, then unlinks the legacy
file without parsing it and syncs the directory. This also recovers the stale
Keychain seed plus conflicting/corrupt legacy-file case when no app/pairing state
survives. Keychain errors stop setup and retain the legacy file; an already
absent item/file is success. Cleanup can repeat after interruption at any step.
The empty, owner-only setup marker is synced only after cleanup and synchronous
app setup succeed, before background tasks or commands can create pairing state.
An existing install's conflicting identities still fail closed; they are never
silently reset. Unlinking does not guarantee erasure of historical flash blocks.

Approval keys use CryptoKit `SecureEnclave.P256.Signing.PrivateKey` with their
wrapped `dataRepresentation` in app files. The bridge creates no persistent
Keychain key and assigns no application tag. There are therefore no app-tagged
approval keys to enumerate/delete on reinstall; their stored wrappers disappear
with the container. Cleanup does not search unrelated Keychain or enclave keys.

At iOS startup, before descriptor access, the app data directory is excluded from
backups. Source inspection of `remote-access/descriptor.json` found that only its
optional one-time pairing code is secret. iOS now uses the existing enclave
sealer to migrate/store this code, with no plaintext fallback. Node IDs, public
transport keys, signatures and endpoints remain public metadata.

macOS retains its existing Secure Enclave-sealed client storage, native signing
behavior and legacy availability policy. Android and the host mobile-check stub
are unchanged.

## Verification

- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --manifest-path src-tauri/Cargo.toml --lib`
- `cargo test --manifest-path src-tauri/ffi/Cargo.toml --test apple_device_key_contract`
- `bash scripts/test-ios-keychain.sh` (headless, fake Keychain, synthetic data)
- `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run authority`
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios`

The host Rust contract test substitutes the native ABI with a mock and exercises
the production Apple wrapper without Keychain access or authentication UI. It
covers hardware/biometric availability, policy and message forwarding, native
refusals without fallback, invalid input bounds, and malformed native output.
Like Android, the wrapper requires a 65-byte uncompressed public key and a DER
sequence signature of at most 72 bytes; the node still verifies the signature.
The Swift mock harness requires access to LocalAuthentication services even
though it never prompts or reads real keys. A restrictive process sandbox can
prevent `LAContext` from retaining its no-interaction setting.

Install-lifecycle tests cover fresh cleanup, existing-state preservation,
interrupted cleanup retries, and recovery from conflicting orphaned identities.
Device testing still needs to exercise Face ID approval/cancellation, locked
state, biometric enrollment changes, an actual upgrade migration, and deletion
followed by reinstall on a signed iPhone build. Host mocks and cross-compilation
do not establish those hardware/entitlement outcomes.

## Security

Threats addressed: extraction from app-container files/backups, migration onto a
different device, biometric enrollment changes, and accidental identity rotation
on Keychain errors. Fresh-install cleanup also prevents silent reuse of a prior
installation's client identity when its app/pairing data is gone, without
rotating identities on upgrades or ordinary restarts. Accessibility is
WhenUnlockedThisDeviceOnly; synchronization is disabled. Approval private keys
are never exported. Seeds, private blobs,
pairing codes and biometric data are never logged or exposed to the renderer.
A compromised unlocked app process or device OS remains outside this protection.

References: [Apple enclave keys](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey),
[Keychain synchronization](https://developer.apple.com/documentation/security/ksecattrsynchronizable).
