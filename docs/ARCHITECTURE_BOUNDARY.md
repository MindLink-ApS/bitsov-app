# API-consumer boundary

The app consumes the BitSov node's HTTP and WebSocket API. It does not link
node protocol crates, fork protocol logic or vendor a node implementation.
The app remains optional: a node has its own identity, storage and API.

For a managed desktop node, Tauri supervises a separately built, released
node binary. Packaging pins that sidecar and verifies its release signature
and checksums. The Rust host owns credentials and API requests; the renderer
uses restricted Tauri commands instead of opening node connections itself.
The source checks in `scripts/authority-check.sh` enforce these boundaries.

Local node traffic uses loopback HTTP/WebSocket. Loopback is a local trust
boundary, not transport encryption. The app requires an explicit local-trust
acknowledgment before the funds interface. See [pairing](ONBOARDING_PAIRING.md)
for authentication, granted scopes and the limitations of local storage.

Remote connections use a pinned Noise transport, with delegated device
permissions and owner approval where required. See
[remote pairing](REMOTE_FIRST_RUN.md) for the verification flow. This
app-to-node connection is separate from encryption between nodes: message
contents are available to the sender's node and the recipient's node.
