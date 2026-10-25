# Local defaults for beta builds

New local nodes use signet, an encrypted recovery-phrase file, and a password
stored by the app in Keychain. Setup stops if protected password storage is
unavailable. The app provides no plaintext fallback or unencrypted setup option.
Passwords reach the node through an inherited pipe, never arguments or environment
variables.

On the next local unlock, an existing plaintext phrase is encrypted in the node's
versioned file format. The app reads back and decrypts the durable ciphertext
before removing the plaintext file. An interrupted migration resumes from the
encrypted sibling. A missing password, an invalid file, or a conflicting identity
stops startup without replacing the seed.

The API, mesh, Lightning, and any enabled STUN listener bind to loopback by
default. The app does not launch the home-box setup page. An owner can explicitly
configure `[remote_access].listen_addr` at the node to retain LAN listeners; remote
clients continue to use the authenticated Noise transport, while the API remains
on loopback.

Beta builds refuse mainnet before starting a local node or granting a remote
session. Retained mainnet installations are refused, never converted to signet.
A remote peer must report its test network through authenticated `/status`.
Protocols that cannot do this before bootstrap or provisional enrollment are
refused too. Developers can deliberately compile with the Cargo feature
`developer-mainnet` to lift the network restriction. Runtime environment variables
and saved settings cannot lift it; the feature is absent from the default build.

Verification uses `cargo test --locked --lib`, the integration contracts under
`src-tauri/tests`, `npm test`, and `npm run build`. Setting
`BITSOV_OWNER_TEST_BINARY` to a node CLI enables the library contract that checks
fresh encrypted setup and verifies a migrated seed with the independent node CLI.
