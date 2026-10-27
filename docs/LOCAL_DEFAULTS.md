# Local defaults for beta builds

New local nodes use signet, an encrypted recovery-phrase file, and a password
stored by the app in Keychain. Setup stops if protected password storage is
unavailable. The app provides no plaintext fallback or unencrypted setup option.
Passwords reach the node through an inherited pipe, never arguments or environment
variables.

On the next local unlock, an existing plaintext phrase is encrypted in the node's
versioned file format. The app reads back and decrypts the durable ciphertext
before clearing plaintext memory and zero-filling, syncing, and removing the
original file. An interrupted migration or overwrite resumes from the encrypted
sibling. A missing password, an invalid file, or a conflicting identity
stops startup without replacing the seed.

The API, mesh, Lightning, and any enabled STUN listener bind to loopback by
default. The app does not launch the home-box setup page. An owner can explicitly
configure `[remote_access].listen_addr` at the node to retain LAN listeners; remote
clients continue to use the authenticated Noise transport, while the API remains
on loopback.

Hostname-form listeners, including `localhost`, retain their configured ports
and are mapped to IPv4 loopback without DNS resolution. Numeric IPv6 listeners
use IPv6 loopback. Explicit remote-access listeners retain the node's parsing.

Beta builds refuse mainnet before starting a local node or granting a live remote
session. Retained mainnet installations are refused, never converted to signet.
A live remote peer must report its test network through authenticated `/status`.
Home-box setup accepts an optional `network` field in the bootstrap descriptor or
on the pinned connection's status response. It allows signet and, in development
builds, regtest. Mainnet and explicit unknown values are refused with a plain
reason.

Node rc19.2 has no bootstrap status route or network declaration. Its pinned,
identity-free session can reach setup without granting live readiness. Before
creating an identity, the app asks the owner to confirm that this box runs signet
with test coins only and is not using real money. Only an explicit confirmation
continues; cancellation, closing the dialog, or leaving setup refuses. The app
records that answer with the box key in local setup state. The record never
auto-confirms another attempt. Pending inputs stay in the host, expire after
15 minutes, and are dropped on dismissal.

Every live status read, including overview and money preflight, checks a reported
network. A later mainnet report retires the session and closes money approvals;
the owner's earlier confirmation cannot override it. A delayed successful check
cannot clear that refusal; the owner must explicitly replace the connection.
Provisional enrollment without a network declaration remains refused.
Developers can deliberately compile with the Cargo feature
`developer-mainnet` to lift the network restriction. Runtime environment variables
and saved settings cannot lift it; the feature is absent from the default build.

Verification uses `cargo test --locked --lib`, the integration contracts under
`src-tauri/tests`, `npm test`, and `npm run build`. Setting
`BITSOV_OWNER_TEST_BINARY` to a node CLI enables the library contract that checks
fresh encrypted setup and verifies a migrated seed with the independent node CLI.
