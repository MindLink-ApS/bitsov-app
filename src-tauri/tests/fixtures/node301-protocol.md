# Node #301 wire fixture

Checked against BitSov-bitsov merged commit `d63c11f` (PR #301).
`node301-pending.json` uses deterministic public inputs from the node's
`crates/konsensus-api/src/sas.rs::tests::sas_vector_and_all_fields_bound`:
P-256-shaped key `04` + 64 × `44`, box nonce 16 × `55`, digest
`960be0e8e070d1089b55da2113669f8530ee396eb36cd0fa04e82cb9ae346f35`,
and words `noodle gallery demand science`. These are protocol test bytes,
not a generated device key or a captured live enrollment.

The remaining deterministic fields follow these node definitions:

| Field | Bytes / layout | Node source under `crates/konsensus-api/src/` |
| --- | --- | --- |
| Operation ID | 12 random bytes, lowercase hex | `pairing/device.rs:466` (`op_bytes`) |
| Ticket nonce and owner ticket code suffix | 32 random bytes, lowercase hex | `pairing/ticket.rs` (`random_hex`) |
| Box nonce | 16 random bytes, lowercase hex | `pairing/device.rs` (`DeviceSas::nonce`) |
| Key ID | First 16 bytes of BLAKE3(public key), lowercase hex | `pairing/device.rs` (`key_id_for`) |
| Delegation nonce | 16 random bytes, lowercase hex | `pairing/device.rs` (`delegation_nonce`) |
| Node fingerprint | 16 bytes, lowercase hex | `pairing.rs` (`identity_fingerprint`) |
| Client public key / SAS digest | 32 bytes each, lowercase hex | `pairing/device.rs` (`delegation_message`) |
| Device public key | 65 bytes, uncompressed P-256, prefix `04` | `pairing/device.rs` (`parse_public_key`) |
| v2 delegation | Domain, node, client_pubkey, epoch, device_key, op_id, nonce, sas_digest; newline-separated, no trailing newline | `pairing/device.rs:252` (`delegation_message`) |
| Ticket / enrollment lifetime | 300 / 900 seconds | `pairing/ticket.rs::TTL` / `pairing.rs::ELEVATION_TTL_SECS` |

The JSON is shared by pure contract tests and the host's owner/delegation
mock. Host tests supply a fresh expiry and their node fingerprint. The app
must not link node crates; this frozen fixture makes the wire contract
reviewable independently of the client validators.
