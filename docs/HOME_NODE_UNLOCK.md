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

`bitsov.node.<node_id>.seed-password` uses
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `biometryCurrentSet`.
The existing owner ceremony saves this copy before finalize. After the live
identity and owner-device registration are verified, migration reads it through
biometry, compares it with the launcher password, atomically publishes a public
node binding, then deletes the exact legacy launcher item. Existing local-owner
installations migrate on a verified start too. Future launches read the biometric
item; missing/invalid bindings or Keychain denial never trigger an unprotected
fallback. A failed migration retains its recovery copy and reports a warning.

Unlock has no password input or password-bearing IPC. The host opens a dedicated
Noise connection, checks its remote static against the box pin, validates lock
identity and client binding, obtains a fresh challenge, signs the exact U2
message with the existing enrolled Secure Enclave key, and reads the password
through Keychain. It rechecks challenge expiry after biometric interaction and
sends the body once over the same connection. Password and request buffers use
zeroizing storage; no password passes through the loopback proxy. Error copy
never incorporates the server's unlock response body. A 204 starts normal
identity-pinned reconnection; it never retries the password body.

Remote enrollment/password transfer from another owner device is separate from
this change. A Mac without the enrolled password or device key refuses unlock;
it never asks the user to type a seed password. Pairing a read-only client alone
does not enroll it for unlock.

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

Run `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`,
`npm test`, and `npm run build`. Rust fixtures need loopback listener access.
Physical Touch ID cancellation, enrollment changes, and release-signed Keychain
access still require a manual Mac check. Swift/Security framework allocations
are outside Rust's zeroization guarantees.
