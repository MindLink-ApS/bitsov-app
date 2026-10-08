# Remote first-run SAS (Mac)

The Mac host accepts strict legacy PairLink v1 and identity-signed v2 endpoint
lists. It verifies the complete ordered descriptor before authentication and
uses the same transport pins at every fallback address. Bootstrap tickets pin
the persistent box key until a verified finalize receipt supplies the identity.

A dedicated Noise connection owns each SAS ceremony. Rust retains its completed
handshake hash, validates the physical claim-code checksum, and derives the full
BLAKE3 digest and four BIP-39 comparison words using the N3 transcript. The claim
code never leaves the host. The node's frozen SAS vector is included in tests.

The owner chooses the password once. Before create-pending, the host protects it
with the same Secure Enclave envelope as Remember, under a domain-separated box
identifier. The webview clears its password and claim-code inputs immediately.
Create-pending sends only the password commitment, SAS version, and device key.
Only explicit Match requests the Touch ID signature. Recovery words are shown
only after comparison; finalize includes the backup answers, full SAS digest,
proof, and password over the same pinned Noise connection. Box approval remains
a separate node-side gate. A failed backup check requires corrected user input;
only box-approval-pending can automatically retry confirmation.

After a verified finalize receipt, the password is saved under the verified
node identity, the device record and signed box pin are persisted, and the
provisional envelope is removed. Password memory expires separately from long
network or biometric operations. Reconnection retains the original fallback
routing hints without claiming they gained an identity signature.

## Protocol dependencies still requiring node confirmation

The supplied N3/N4 reference documents specify only `box_transport_pubkey` and
`box_transport_signature` in the finalize response. The unlocked listener uses a
different, seed-derived static key. The documented response therefore cannot
provide the live pin needed to reach the home screen after the first unlock.
The app accepts optional identity-signed `transport_pubkey` and
`transport_signature` in that receipt, validates both, and otherwise refuses an
unknown live responder. It reports that an identity-signed link from the
unlocked node is required. There is no TOFU fallback.

The first-unlock binding currently retains the epoch from the authenticated
bootstrap token. The node references do not establish whether fingerprint
rebinding preserves that epoch. Confirm this against the actual node source or
provide an authenticated postcommit binding before claiming end-to-end
interoperability. A dedicated Secure Enclave path retains the Match biometric context for one
first-unlock signature, bound to the same key, node and client, for 120 seconds.
It cannot silently authorize general device operations. An expired context
requires an explicit normal Touch ID unlock.

A lost finalize receipt or app exit during local receipt persistence requires
checking the box and importing a fresh verified descriptor; no silent replay or
unverified identity adoption is attempted. The provisional encrypted password
remains protected in Keychain if it could not be migrated.

Validation is offline: TypeScript typecheck, Vitest, and Cargo check/tests with
`TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`. Rust transport tests need local
loopback sockets. Neither the app nor a window is launched. Hardware biometric
and real-node first-run end-to-end verification is still required.
