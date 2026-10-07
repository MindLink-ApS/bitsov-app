# Mac home-node unlock

The client consumes U1's signed box transport fields and U2's locked router.
The existing identity transport pin remains unchanged. An identity-pinned,
unlocked session verifies the Ed25519 `bitsov-box-transport-v1` proof and saves
its box pin and endpoint in Keychain under `bitsov.node.<node_id>.box-transport`.
A locked session can use that pin, but cannot learn or replace it. Older live
nodes without the fields remain usable; they cannot prepare remote unlock.

The host retains the paired client's public signing context (`cid`, `epc`, `idf`)
from the last identity-pinned token, including token refreshes. U2's challenge
response does not supply the epoch. Missing context fails closed; reconnect to
the unlocked node once to prepare it.

New passwords use `bitsov.node.<node_id>.seed-password.wrapped-v1`: a
versioned envelope containing only AES-GCM ciphertext (including nonce/tag), an
ephemeral P-256 public key, and an opaque Secure Enclave key blob. The enclave
key is a P-256 **key-agreement** key with `privateKeyUsage` +
`biometryCurrentSet` and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
Encryption uses ephemeral ECDH against its public key, HKDF-SHA256 with purpose
`bitsov.home-seed-password.wrap.v1`, and the node id as both HKDF salt and GCM
AAD. Wrapping needs no biometric prompt; decryption requires Touch ID through
the enclave private key. No software-key or non-biometric decrypt fallback exists.

All macOS Keychain writes prefer data protection. Only
`errSecMissingEntitlement` (`-34018`, expected in the unsigned Mac Package build)
retries in the local login keychain with the **same service/account**. Data
protection uses `WhenUnlockedThisDeviceOnly`; legacy uses the unlocked login
keychain and its application ACL, has no exact `ThisDeviceOnly` class, and does
not sync. The password envelope remains hardware/device/biometry-bound in
either store. Reads check data protection first, checking legacy only for
not-found or missing-entitlement; authentication/other errors stop immediately.
This also covers box pins, unlock bindings and the bootstrap launcher item.
Desktop pairing records and client Ed25519 seeds remain in their existing
owner-only files; this branch has no direct `security-framework` crate callers.

Existing signed builds' biometric data-protection
`bitsov.node.<node_id>.seed-password` items remain readable when no envelope
exists. New saves always write envelopes. An invalidated/corrupt envelope is
authoritative: failure enters `no-password`, never an old-password fallback.
Type the password and explicitly Remember again to replace it. If the separate
approval key also invalidated, first restore device approval. Unsigned builds
have no old data-protection items to migrate.

The existing owner ceremony saves the wrapped copy before finalize. After the live
identity and owner-device registration are verified, migration reads it through
biometry, compares it with the launcher password, atomically publishes a public
node binding, then deletes the exact legacy launcher item. Existing local-owner
installations migrate on a verified start too. Future launches read the biometric
item; missing/invalid bindings or Keychain denial never trigger an unprotected
fallback. A failed migration retains its recovery copy and reports a warning.

Unlock never returns a password from a command. The typed-password command is
write-only; its accepted password stays `Zeroizing` in host memory. Only after
the node returns **204**, and explicit Remember opt-in within **120 seconds**,
does the remote Remember flow save it. Decline/expiry drops the secret, and the
blocking worker rechecks expiry before storage. The host opens a dedicated
Noise connection, checks its remote static against the box pin, validates lock
identity and client binding, obtains a fresh challenge, signs the exact U2
message with the existing enrolled Secure Enclave signing key, and decrypts the
remembered password (or uses the typed password). It rechecks challenge expiry
after biometric interaction and sends the body once over the same connection. Password and request buffers use
zeroizing storage; no password passes through the loopback proxy. Error copy
never incorporates the server's unlock response body. A 204 starts normal
identity-pinned reconnection; it never retries the password body.

Remote enrollment/password transfer from another owner device is separate from
this change. A Mac with an approved device key can type its node password when
no remembered copy opens. Pairing a read-only client alone does not enroll it
for unlock.

## Verification

`tests/fixtures/home-node.json` contains synthetic keys only. Its Ed25519 and
X25519 values and signature were generated independently with Node's crypto API
(Ed25519 seed `07` repeated 32 times, box X25519 secret `09` repeated 32 times).
The fixture follows the U1 proof encoding and U2 auth response. Tests run real
Noise handshakes and encrypted HTTP, including missing/wrong pins, first-pairing
refusal, proof tampering, error statuses, fragmented responses and no secret
reflection. Frontend tests exercise the locked view and click-only unlock.
Migration tests cover cancellation, mismatched protected copies, and publish
failure before legacy deletion.

For checks that do not launch the app, run `npx vitest run`, `npx tsc --noEmit`,
`cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --test mac_keychain_contract --test mac_typed_unlock_contract`,
`cargo check --offline --locked --manifest-path src-tauri/Cargo.toml --all-targets`,
and `bash scripts/cs2-local-smoke.sh`. The native unit probe in
`src-tauri/native/tests/home_keychain_probe.swift` can be concatenated after
`device_key.swift` into a standalone `/tmp` Swift executable: it uses a
**test-only non-biometric enclave key**, checks round trips, tampering and node
binding, and exercises the fallback status matrix without Keychain calls.
Rust FFI unit tests reject invalid identifiers and malformed native results
without invoking Keychain. Avoid running app test binaries on an active desktop.
Physical Touch ID cancellation, enrollment changes, signed-build migration and
end-to-end pairing still require a manual Mac check. Swift plaintext `Data`
buffers are reset on exit; framework-internal copies are outside Rust's
zeroization guarantees.
