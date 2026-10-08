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

## Protocol dependencies

Node PR #287 supplies the complete finalize receipt for the new SAS path:
`node_id`, `client_id`, `epoch` (u64), the enrolled `device_key_id`, and both
`box_transport_pubkey` / `box_transport_signature` and
`transport_pubkey` / `transport_signature`. The app requires all these fields,
checks the receipt against the confirmed ceremony, device and bootstrap pairing,
and verifies both Ed25519 signatures under the trusted committed `node_id`.
Keys are canonical lowercase 32-byte hex; signatures are canonical base64url
without padding. The exact live proof is these UTF-8 bytes, with no newline:

```text
bitsov-remote-transport-v1:<node_id>:<transport_pubkey>
```

The box proof retains the `bitsov-box-transport-v1` domain. Bootstrap and LOCKED
must present the already pinned box Noise static; UNLOCKED must present the
verified seed-derived live static. An absent, partial, malformed or invalid
live proof cannot install a pin. There is no TOFU fallback.

The receipt's `client_id` and `epoch` describe the pairing and are not part of
that identity-scoped signature. The node preserves the epoch across commit;
the app checks it against the authenticated bootstrap token, persists the
receipt binding, discards that token, and obtains a fresh token after unlock.
Before saving its binding or marking the node ready, the app checks the fresh
`cid`, `epc`, and identity fingerprint against the saved first-run context. A
mismatch clears authentication and leaves the saved binding intact.

Before sending finalize, the host writes private recovery context containing
the SAS-confirmed identity, pinned box, client/epoch and device public key.
It contains no password, mnemonic, token or device signature. If the reply is
lost, continuation never replays finalize: it authenticates through Noise with
the already pinned box static and validates the locked-mode auth reply's two
transport proofs under the saved identity, its client id, and locked status.
This recovers the signed live pin without importing another descriptor and also
resumes after app exit or interrupted local persistence. Definite precommit
refusals clear recovery context. A pinned, authenticated box still reporting
bootstrap may return to setup/cancellation without adopting any identity or
live pin; uncertain recovery context remains until cancellation or completion.
Older locked replies
may omit both live fields; they provide no new pin and recovery fails closed.

Ordinary completion retains the Match biometric context for one first-unlock
signature bound to the same key, node and client for 120 seconds. An expired
context or recovered lost receipt requires an explicit Touch ID unlock. Passive
recovery never reads the provisional password; explicit unlock can migrate its
protected box-scoped envelope to the verified node identity. Recovery context
is cleared after password migration and successful fresh-token verification.

The offline PR #287 fixtures use its exact response shapes and proof domains,
with deterministic test keys and signatures independently generated using
Python cryptography. Tests cover both signature domains, missing and malformed
fields, changed client/epoch, journal restoration, and real in-process Noise
recovery including rejection before auth to an unknown live responder.

Validation is offline: TypeScript typecheck, Vitest, and Cargo check/tests with
`TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`. Rust transport tests need local
loopback sockets. Neither the app nor a window is launched. Hardware biometric
and real-node first-run end-to-end verification is still required.
