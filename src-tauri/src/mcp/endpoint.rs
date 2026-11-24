//! MCP phase 1, slice A1.2: the local endpoint (ADR H3953 A1 §1.3–§1.4).
//!
//! **Not wired.** Nothing in the app creates a listener; the owner's switch
//! and the shim come in later slices. Compiles only where its parent module
//! does (`cfg(test)` or the off-by-default `mcp-grant` feature).
//!
//! One line is one frame (newline-delimited JSON), at most
//! [`MAX_FRAME_BYTES`]. A connection starts unauthenticated and only two
//! things are accepted:
//! - `{"hello": "<client id>"}`: the host answers a single-use challenge
//!   (slice 4); `{"signature": "<hex>"}` over it makes the connection
//!   ready, and only then do MCP frames reach the session layer (slices 1–3).
//! - `{"pair": {"name": "…", "nonce": "<hex>"}}`: a pairing request with six
//!   words for the owner (slice 5). `{"pair_status": true}` polls it; on the
//!   owner's approval the client's secret is handed over exactly once and the
//!   connection closes.
//! Anything else closes the connection. On macOS the listener is a Unix
//! socket in an owner-only directory, and a peer of any other user is closed
//! before a byte is read.

use std::collections::HashMap;
use std::io::BufRead;

use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::identity::Identities;
use super::pairing::{PairError, Pairing};
use super::server::{Reads, MAX_FRAME_BYTES};
use super::session::{AuditRow, Registry, Sessions};
use super::store::R2_PAIRING_OPEN;
use crate::ai::Topic;

/// How long an approved client's secret waits to be collected.
pub const DELIVERY_TTL_MS: u64 = 5 * 60_000;

/// Where one connection stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conn {
    Start,
    /// A known client was challenged and must sign.
    Challenged { client: String, challenge: [u8; 32] },
    /// Proved its key: MCP frames go to the session layer.
    Ready { client: String },
    /// Asked to pair; waits for the owner.
    Pairing { id: String },
    Closed,
}

/// What to do after one frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub reply: Option<Vec<u8>>,
    pub close: bool,
}

impl Step {
    fn send(value: Value) -> Self {
        Self { reply: Some(line(value)), close: false }
    }
    fn send_and_close(value: Value) -> Self {
        Self { reply: Some(line(value)), close: true }
    }
    fn refuse(message: &str) -> Self {
        Self::send_and_close(json!({ "error": message }))
    }
}

fn line(value: Value) -> Vec<u8> {
    let mut out = value.to_string().into_bytes();
    out.push(b'\n');
    out
}

struct Delivery {
    secret: Zeroizing<[u8; 32]>,
    expires_ms: u64,
}

/// The host side of every MCP connection.
#[derive(Default)]
pub struct Host {
    pub registry: Registry,
    pub identities: Identities,
    pub pairing: Pairing,
    sessions: Sessions,
    pub audit: Vec<AuditRow>,
    deliveries: HashMap<String, Delivery>,
}

fn hex32(value: &Value) -> Option<[u8; 32]> {
    let bytes = hex::decode(value.as_str()?).ok()?;
    bytes.try_into().ok()
}

impl Host {
    /// The owner approves a waiting pairing request in the app.
    pub fn approve(&mut self, id: &str, topics: &[Topic], now_ms: u64) -> Result<(), PairError> {
        let issued = self.pairing.approve(id, topics, now_ms, &mut self.registry, &mut self.identities)?;
        self.deliveries.insert(id.to_owned(), Delivery { secret: issued.secret, expires_ms: now_ms.saturating_add(DELIVERY_TTL_MS) });
        Ok(())
    }

    /// The owner denies a waiting pairing request.
    pub fn deny(&mut self, id: &str, now_ms: u64) -> bool {
        self.pairing.deny(id, now_ms)
    }

    /// Handle one frame (one line, without its newline) from `conn`.
    pub fn on_frame(&mut self, conn: &mut Conn, frame: &[u8], now_ms: u64, reads: &dyn Reads) -> Step {
        self.deliveries.retain(|_, delivery| now_ms < delivery.expires_ms);
        if frame.len() > MAX_FRAME_BYTES {
            *conn = Conn::Closed;
            return Step::refuse("frame too large");
        }
        let state = std::mem::replace(conn, Conn::Closed);
        if let Conn::Ready { client } = &state {
            let reply = self.sessions.handle(client, frame, now_ms, &self.registry, reads, &mut self.audit);
            // A client revoked while connected is refused by the session layer on every frame.
            *conn = state.clone();
            return Step { reply: reply.map(|mut out| { out.push(b'\n'); out }), close: false };
        }
        let Ok(Value::Object(message)) = serde_json::from_slice::<Value>(frame) else {
            return Step::refuse("expected a handshake message");
        };
        match (state, message.len()) {
            (Conn::Start, 1) if message.contains_key("hello") => {
                let Some(client) = message["hello"].as_str() else { return Step::refuse("bad hello") };
                if self.registry.active(client).is_none() {
                    return Step::refuse("unknown client");
                }
                match self.identities.challenge(client, now_ms) {
                    Ok(challenge) => {
                        *conn = Conn::Challenged { client: client.to_owned(), challenge };
                        Step::send(json!({ "challenge": hex::encode(challenge) }))
                    }
                    Err(_) => Step::refuse("unknown client"),
                }
            }
            (Conn::Challenged { client, challenge }, 1) if message.contains_key("signature") => {
                let Some(signature) = message["signature"].as_str().and_then(|s| hex::decode(s).ok()) else {
                    return Step::refuse("bad signature");
                };
                // The registry is checked again: a client revoked during the handshake gets nothing.
                if self.registry.active(&client).is_some() && self.identities.verify(&client, &challenge, &signature, now_ms) {
                    *conn = Conn::Ready { client };
                    Step::send(json!({ "ready": true }))
                } else {
                    Step::refuse("not authorised")
                }
            }
            (Conn::Start, 1) if message.contains_key("pair") => {
                if !R2_PAIRING_OPEN {
                    return Step::refuse("pairing with this app is closed; pair with your box");
                }
                let request = &message["pair"];
                let (Some(name), Some(nonce)) = (request.get("name").and_then(Value::as_str), request.get("nonce").and_then(hex32)) else {
                    return Step::refuse("bad pair request");
                };
                match self.pairing.request(name, &nonce, now_ms) {
                    Ok(asked) => {
                        *conn = Conn::Pairing { id: asked.id.clone() };
                        Step::send(json!({ "pair": { "id": asked.id, "host_nonce": hex::encode(asked.host_nonce), "code": asked.code } }))
                    }
                    Err(PairError::Busy) => Step::refuse("too many pairing requests waiting"),
                    Err(_) => Step::refuse("bad pair request"),
                }
            }
            (Conn::Pairing { id }, 1) if message.get("pair_status") == Some(&Value::Bool(true)) => {
                if let Some(delivery) = self.deliveries.remove(&id) {
                    // Handed over once; the client reconnects with hello.
                    return Step::send_and_close(json!({ "pair": "approved", "id": id, "secret": hex::encode(*delivery.secret) }));
                }
                if self.pairing.waiting(now_ms).iter().any(|shown| shown.id == id) {
                    *conn = Conn::Pairing { id };
                    return Step::send(json!({ "pair": "waiting" }));
                }
                Step::send_and_close(json!({ "pair": "gone" }))
            }
            _ => Step::refuse("unexpected message"),
        }
    }
}

/// Read one frame: bytes up to a newline, without it. `None` at end of
/// stream. A line longer than `max` is an error, read no further than
/// `max + 1` bytes.
pub fn read_frame(reader: &mut impl BufRead, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    let read = std::io::Read::take(&mut *reader, max as u64 + 1).read_until(b'\n', &mut buf)?;
    if read == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if buf.len() > max {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    Ok(Some(buf))
}

/// macOS: the owner-only listener (ADR A1 §1.3).
#[cfg(target_os = "macos")]
pub mod unix {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    /// The socket's file name inside the endpoint directory.
    pub const SOCKET_NAME: &str = "mcp.sock";

    /// Bind in `dir`, which is created 0700 and must be a real directory owned
    /// by this user. A stale socket of ours is replaced; anything else is not.
    pub fn bind(dir: &Path) -> std::io::Result<UnixListener> {
        std::fs::create_dir_all(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.file_type().is_dir() || meta.uid() != bitsov_ffi::effective_uid() {
            return Err(std::io::Error::other("endpoint directory is not this user's directory"));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let path = dir.join(SOCKET_NAME);
        if let Ok(existing) = std::fs::symlink_metadata(&path) {
            use std::os::unix::fs::FileTypeExt;
            if !existing.file_type().is_socket() || existing.uid() != bitsov_ffi::effective_uid() {
                return Err(std::io::Error::other("something else is at the socket path"));
            }
            std::fs::remove_file(&path)?;
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    /// Accept one connection, closing any peer that is not this user.
    pub fn accept_owner(listener: &UnixListener) -> std::io::Result<UnixStream> {
        loop {
            let (stream, _) = listener.accept()?;
            if bitsov_ffi::peer_uid(&stream)? == bitsov_ffi::effective_uid() {
                return Ok(stream);
            }
            drop(stream);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::identity::sign;
    use crate::mcp::server::ReadFailed;

    struct Fake;
    impl Reads for Fake {
        fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
            Ok(json!({ "ok": true }))
        }
    }

    fn reply(step: &Step) -> Value {
        serde_json::from_slice(step.reply.as_ref().expect("a reply").strip_suffix(b"\n").unwrap()).unwrap()
    }

    fn frame(value: Value) -> Vec<u8> {
        value.to_string().into_bytes()
    }

    /// Pair a client through the endpoint, the way the shim does. Returns (id, secret).
    fn paired(host: &mut Host, topics: &[Topic]) -> (String, [u8; 32]) {
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Desk", "nonce": hex::encode([3u8; 32])}})), 0, &Fake));
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        assert_eq!(asked["pair"]["code"].as_array().unwrap().len(), 6);
        assert_eq!(reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 1, &Fake))["pair"], "waiting");
        host.approve(&id, topics, 2).unwrap();
        let step = host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 3, &Fake);
        assert!(step.close, "the secret is handed over and the connection closes");
        let done = reply(&step);
        assert_eq!(done["pair"], "approved");
        let secret: [u8; 32] = hex::decode(done["secret"].as_str().unwrap()).unwrap().try_into().unwrap();
        (id, secret)
    }

    fn ready(host: &mut Host, id: &str, secret: &[u8; 32]) -> Conn {
        let mut conn = Conn::Start;
        let challenge = reply(&host.on_frame(&mut conn, &frame(json!({"hello": id})), 10, &Fake));
        let challenge: [u8; 32] = hex::decode(challenge["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
        let ok = host.on_frame(&mut conn, &frame(json!({"signature": hex::encode(sign(secret, id, &challenge))})), 11, &Fake);
        assert_eq!(reply(&ok)["ready"], true);
        conn
    }

    #[test]
    fn pairing_then_hello_and_signature_open_an_mcp_session() {
        let mut host = Host::default();
        let (id, secret) = paired(&mut host, &[Topic::Node]);
        let mut conn = ready(&mut host, &id, &secret);
        let list = host.on_frame(&mut conn, br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, 12, &Fake);
        let tools: Value = serde_json::from_slice(list.reply.as_ref().unwrap()).unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 1, "only the approved topic");
        let call = host.on_frame(&mut conn, br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_node"}}"#, 13, &Fake);
        let result: Value = serde_json::from_slice(call.reply.as_ref().unwrap()).unwrap();
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(host.audit.len(), 1);
    }

    #[test]
    fn the_secret_is_handed_over_once_and_expires_if_never_collected() {
        let mut host = Host::default();
        let (id, _) = paired(&mut host, &[Topic::Node]);
        // A second connection asking for the same request gets nothing.
        let mut conn = Conn::Pairing { id: id.clone() };
        assert_eq!(reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 4, &Fake))["pair"], "gone");

        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Late", "nonce": hex::encode([4u8; 32])}})), 0, &Fake));
        let late = asked["pair"]["id"].as_str().unwrap().to_owned();
        host.approve(&late, &[Topic::Node], 1).unwrap();
        let step = host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 1 + DELIVERY_TTL_MS, &Fake);
        assert_eq!(reply(&step)["pair"], "gone", "an uncollected secret is dropped after its time");
    }

    #[test]
    fn mcp_frames_before_the_handshake_and_unknown_clients_are_refused() {
        let mut host = Host::default();
        let mut conn = Conn::Start;
        let step = host.on_frame(&mut conn, br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, 0, &Fake);
        assert!(step.close);
        assert_eq!(conn, Conn::Closed);
        let mut conn = Conn::Start;
        let step = host.on_frame(&mut conn, &frame(json!({"hello": "mcp-0000000000000000"})), 0, &Fake);
        assert_eq!(reply(&step)["error"], "unknown client");
        assert!(step.close);
        assert!(host.audit.is_empty());
    }

    #[test]
    fn a_wrong_or_replayed_signature_closes_the_connection() {
        let mut host = Host::default();
        let (id, secret) = paired(&mut host, &[Topic::Node]);
        let mut conn = Conn::Start;
        let challenge = reply(&host.on_frame(&mut conn, &frame(json!({"hello": id})), 10, &Fake));
        let challenge: [u8; 32] = hex::decode(challenge["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
        let good = hex::encode(sign(&secret, &id, &challenge));
        let wrong = hex::encode(sign(&[9u8; 32], &id, &challenge));
        let step = host.on_frame(&mut conn, &frame(json!({"signature": wrong})), 11, &Fake);
        assert!(step.close);
        assert_eq!(reply(&step)["error"], "not authorised");
        // The challenge was answered (wrongly) and is used up: replaying the good answer fails too.
        let mut again = Conn::Challenged { client: id.clone(), challenge };
        assert!(host.on_frame(&mut again, &frame(json!({"signature": good})), 12, &Fake).close);
    }

    #[test]
    fn a_client_revoked_mid_session_is_refused_on_its_next_frame() {
        let mut host = Host::default();
        let (id, secret) = paired(&mut host, &[Topic::Node]);
        let mut conn = ready(&mut host, &id, &secret);
        assert!(host.registry.revoke(&id));
        let step = host.on_frame(&mut conn, br#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_node"}}"#, 20, &Fake);
        let out: Value = serde_json::from_slice(step.reply.as_ref().unwrap()).unwrap();
        assert_eq!(out["error"]["message"], "client not authorised");
    }

    #[test]
    fn a_denied_request_ends_and_oversized_or_garbled_frames_close() {
        let mut host = Host::default();
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Notes", "nonce": hex::encode([5u8; 32])}})), 0, &Fake));
        assert!(host.deny(asked["pair"]["id"].as_str().unwrap(), 1));
        assert_eq!(reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 2, &Fake))["pair"], "gone");

        for bad in [vec![b' '; MAX_FRAME_BYTES + 1], b"not json".to_vec(), br#"{"hello":"a","extra":1}"#.to_vec(),
            frame(json!({"pair": {"name": "x", "nonce": "short"}}))] {
            let mut conn = Conn::Start;
            assert!(host.on_frame(&mut conn, &bad, 0, &Fake).close);
            assert_eq!(conn, Conn::Closed);
        }
    }

    #[test]
    fn frames_are_read_one_line_at_a_time_and_long_lines_are_refused() {
        let mut input = std::io::Cursor::new(b"{\"a\":1}\n{\"b\":2}\n".to_vec());
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(br#"{"a":1}"#.to_vec()));
        assert_eq!(read_frame(&mut input, 64).unwrap(), Some(br#"{"b":2}"#.to_vec()));
        assert_eq!(read_frame(&mut input, 64).unwrap(), None);
        let mut long = std::io::Cursor::new(vec![b'x'; 200]);
        assert!(read_frame(&mut long, 64).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_listener_is_owner_only_and_accepts_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("bitsov-mcp-endpoint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let listener = unix::bind(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let socket = dir.join(unix::SOCKET_NAME);
        assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);
        let _client = std::os::unix::net::UnixStream::connect(&socket).unwrap();
        assert!(unix::accept_owner(&listener).is_ok(), "the same user is accepted");
        // A file that is not our socket at the path is never removed.
        drop(listener);
        std::fs::remove_file(&socket).unwrap();
        std::fs::write(&socket, b"not a socket").unwrap();
        assert!(unix::bind(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
