# N-2DEV interop provenance

Source: BitSov-bitsov main `22ab59ba372a377793de119943d4a9ff10e29d9a`, PRs #356/#357.

- `sas.rs::second_device_vectors`: node `crates/konsensus-api/src/sas.rs`,
  `t1_sas_v2_fields_and_domain`, copied with its frozen digest and words.
- `node356-pending.json`: synthetic owner view assembled independently in the exact
  field order of `pairing/second_device.rs::second_message_locked` and the additive
  fields emitted by `pairing/ticket.rs::owner_device_view`. Times and identifiers
  are deterministic test fixtures, not real enrollments.
- `remote_access/second_tests.rs`: in-process pinned Noise fixture. It verifies
  P-256 registration proofs and independently concatenates the SAS v2 transcript
  and ticket commitment bytes using the node's documented domains.

The node defines `second_` console codes as prefix + unpadded base64url for 32 bytes;
owner-issued codes remain prefix `owner_` + 64 lowercase hex characters. Both are
strictly one-use. The app does not change the node's default-off rollout flag.
