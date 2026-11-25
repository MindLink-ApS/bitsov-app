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
//! Anything else closes the connection, and a failed handshake is audited.
//! On macOS the listener is a Unix socket in an owner-only directory; on
//! Windows it is a named pipe for this user only (`bitsov_ffi`). Either way a
//! peer of any other user is closed before a byte is read, and at most
//! [`MAX_CONNECTIONS`] connections are open at once.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::identity::Identities;
use super::pairing::{PairError, Pairing};
use super::server::{ReadFailed, Reads, MAX_FRAME_BYTES};
use super::session::{clean, AuditRow, Begun, Outcome, Registry, Sessions, MAX_CLIENT_NAME};
use super::store::{self, r2_preset_allowed, FileIo, R2Preset, StoreError, StoredClient, R2_PAIRING_OPEN};
use crate::ai::{Preset, Topic};
use crate::at_rest::Sealer;

/// At most this many connections at once (ADR A1 §2); the listener refuses more.
pub const MAX_CONNECTIONS: usize = 8;

/// The tool name on audit rows for a refused handshake.
pub const HANDSHAKE_AUDIT_TOOL: &str = "handshake";

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
    with_newline(value.to_string().into_bytes())
}

fn with_newline(mut out: Vec<u8>) -> Vec<u8> {
    out.push(b'\n');
    out
}

/// The first phase of one frame ([`Host::begin_frame`]).
#[derive(Debug)]
pub enum Begin {
    /// Fully handled under the host: send this step.
    Done(Step),
    /// A ready client's frame that may read: run [`Pending::read`] without
    /// the host, then [`Host::finish_frame`].
    Read(Pending),
}

/// A ready client's frame between [`Host::begin_frame`] and
/// [`Host::finish_frame`]. It keeps the frame it was begun with, so the read
/// and the audit row always describe the same call.
#[derive(Debug)]
pub struct Pending {
    begun: Begun,
    preset: R2Preset,
    frame: Vec<u8>,
}

/// What a [`Pending::read`] produced.
#[derive(Debug)]
pub struct ReadDone {
    reply: Option<Vec<u8>>,
    outcome: Outcome,
}

impl Pending {
    /// Run the frame with reads narrowed to the client's preset. Touches no
    /// host state, so no lock is held while the node is read. A read source
    /// that panics counts as a failed read: the client gets the usual
    /// failed-read reply and the call is audited as [`Outcome::ReadFailed`].
    pub fn read(&self, source: &dyn ReadSource) -> ReadDone {
        let reads = catch_unwind(AssertUnwindSafe(|| source.reads_for(self.preset)));
        let reads: Box<dyn Reads + '_> = match reads {
            Ok(reads) => Box::new(NoPanic(reads)),
            Err(_) => Box::new(Failing),
        };
        let (reply, outcome) = self.begun.read(&self.frame, reads.as_ref());
        ReadDone { reply, outcome }
    }
}

/// Reads whose panics become a failed read.
struct NoPanic<'a>(Box<dyn Reads + 'a>);

impl Reads for NoPanic<'_> {
    fn read(&self, topic: Topic, since_ms: Option<u64>) -> Result<Value, ReadFailed> {
        catch_unwind(AssertUnwindSafe(|| self.0.read(topic, since_ms))).unwrap_or(Err(ReadFailed))
    }
}

/// Reads from a source that could not even be opened.
struct Failing;

impl Reads for Failing {
    fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
        Err(ReadFailed)
    }
}

struct Delivery {
    secret: Zeroizing<[u8; 32]>,
    expires_ms: u64,
}

/// The host side of every MCP connection.
///
/// The stored records ([`Host::stored`]) are the truth: the registry and the
/// identities are built from them, and every change the owner makes goes
/// through [`Host::commit`], which saves them sealed or undoes the change.
#[derive(Default)]
pub struct Host {
    pub registry: Registry,
    pub identities: Identities,
    pub pairing: Pairing,
    sessions: Sessions,
    pub audit: Vec<AuditRow>,
    deliveries: HashMap<String, Delivery>,
    stored: Vec<StoredClient>,
    /// Set when the clients file was there but did not load: nothing is saved
    /// over it until the owner chooses to start over ([`Host::start_over`]).
    blocked: Option<StoreError>,
}

/// Where a ready client's reads come from, narrowed to that client's preset
/// (counts by default, at most rounded). The preset is an [`R2Preset`], so
/// `exact` cannot be asked for here.
pub trait ReadSource {
    fn reads_for(&self, preset: R2Preset) -> Box<dyn Reads + '_>;
}

/// One fixed source for every client, whatever its preset (tests, and the
/// single-preset callers of [`Host::on_frame`]).
struct Fixed<'a>(&'a dyn Reads);

impl Reads for Fixed<'_> {
    fn read(&self, topic: Topic, since_ms: Option<u64>) -> Result<Value, ReadFailed> {
        self.0.read(topic, since_ms)
    }
}

impl ReadSource for Fixed<'_> {
    fn reads_for(&self, _preset: R2Preset) -> Box<dyn Reads + '_> {
        Box::new(Fixed(self.0))
    }
}

/// Why an owner's change was not kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeError {
    Pair(PairError),
    /// A preset wider than R2 allows (`exact`).
    PresetTooWide,
    UnknownClient,
    /// Saving failed; nothing changed.
    Store(StoreError),
    /// The clients file did not load, so nothing is saved over it until the
    /// owner starts over; nothing changed.
    StoreBlocked(StoreError),
    /// The client **is** revoked now (no session, no key), but the record
    /// could not be saved: after a restart it would be back until a later
    /// save succeeds. Revocation never waits for the disk.
    RevokedNotSaved(StoreError),
}

fn hex32(value: &Value) -> Option<[u8; 32]> {
    let bytes = hex::decode(value.as_str()?).ok()?;
    bytes.try_into().ok()
}

impl Host {
    /// A refused hello or signature, or a revoked client's frame: audited
    /// (ADR A1 §1.4). The client id is cleaned and capped like every row.
    fn refuse_audited(&mut self, client: &str, reason: &str, now_ms: u64) -> Step {
        self.audit.push(AuditRow {
            at_ms: now_ms,
            client: clean(client, MAX_CLIENT_NAME),
            tool: HANDSHAKE_AUDIT_TOOL.to_owned(),
            arguments: reason.to_owned(),
            outcome: Outcome::NotAuthorised,
        });
        Step::refuse(reason)
    }

    /// A host for the clients on file. Revoked records are kept for the
    /// owner's history and never authorised; a record whose key does not load
    /// is kept but not authorised either.
    /// A host from the result of [`store::load`]. A file that is there but
    /// does not load (unreadable, tampered, the wrong mode) gives no clients
    /// **and** blocks saving, so it is never overwritten by accident.
    pub fn from_load(loaded: Result<Vec<StoredClient>, StoreError>) -> Self {
        match loaded {
            Ok(records) => Self::from_stored(records),
            Err(error) => Host { blocked: Some(error), ..Host::default() },
        }
    }

    /// Why saving is blocked, if it is (the app shows it and offers to start over).
    pub fn blocked(&self) -> Option<&StoreError> {
        self.blocked.as_ref()
    }

    /// The owner chose to start over after the old file was moved aside: saves
    /// are allowed again, starting from no clients.
    pub fn start_over(&mut self) {
        self.blocked = None;
    }

    pub fn from_stored(records: Vec<StoredClient>) -> Self {
        let mut host = Host::default();
        for record in &records {
            if record.revoked || !r2_preset_allowed(record.preset) {
                continue;
            }
            if host.identities.insert(&record.id, &record.public_key).is_ok() {
                host.registry.add(&record.id, &record.name, &record.topics);
            }
        }
        host.stored = records;
        host
    }

    /// The records to save: every approved client, revoked ones included.
    pub fn stored(&self) -> &[StoredClient] {
        &self.stored
    }

    /// The preset a client's reads are narrowed to: counts or rounded. A
    /// record that somehow holds a wider preset gets counts (such a record is
    /// never authorised anyway, see [`Host::from_stored`]).
    pub fn preset(&self, client: &str) -> R2Preset {
        self.stored.iter().find(|record| record.id == client && !record.revoked)
            .and_then(|record| R2Preset::new(record.preset))
            .unwrap_or(super::broker::DEFAULT_PRESET)
    }

    /// The owner approves a waiting pairing request with the topics and
    /// preset chosen (at most `rounded`). Not saved: see [`Host::commit`].
    pub fn approve(&mut self, id: &str, topics: &[Topic], preset: Preset, now_ms: u64) -> Result<(), ChangeError> {
        if !r2_preset_allowed(preset) {
            return Err(ChangeError::PresetTooWide);
        }
        let issued = self.pairing.approve(id, topics, now_ms, &mut self.registry, &mut self.identities).map_err(ChangeError::Pair)?;
        let public_key = self.identities.public_key(id).ok_or(ChangeError::UnknownClient)?;
        let name = self.registry.active(id).map(|client| client.name.clone()).unwrap_or_default();
        self.stored.retain(|record| record.id != id);
        self.stored.push(StoredClient { id: id.to_owned(), name, public_key, topics: topics.to_vec(), preset, created_ms: now_ms, revoked: false });
        self.deliveries.insert(id.to_owned(), Delivery { secret: issued.secret, expires_ms: now_ms.saturating_add(DELIVERY_TTL_MS) });
        Ok(())
    }

    /// The owner revokes a client and the record is saved. The revocation
    /// holds in memory **even when saving fails** (then
    /// [`ChangeError::RevokedNotSaved`]): cutting access never waits for the
    /// disk, and the next successful save carries it.
    pub fn revoke_saved(&mut self, io: &dyn FileIo, sealer: Option<&dyn Sealer>, id: &str) -> Result<(), ChangeError> {
        self.revoke(id)?;
        if let Some(error) = &self.blocked {
            return Err(ChangeError::RevokedNotSaved(error.clone()));
        }
        store::save(io, sealer, &self.stored).map_err(ChangeError::RevokedNotSaved)
    }

    /// Revoke in memory only: no new session, no further frame on a live one,
    /// and its key is dropped. The record stays, marked revoked. Use
    /// [`Host::revoke_saved`].
    fn revoke(&mut self, id: &str) -> Result<(), ChangeError> {
        let record = self.stored.iter_mut().find(|record| record.id == id && !record.revoked).ok_or(ChangeError::UnknownClient)?;
        record.revoked = true;
        self.registry.revoke(id);
        self.identities.revoke(id);
        self.deliveries.remove(id);
        Ok(())
    }

    /// Apply one owner change (an approval) and save the records sealed. If
    /// the change or the save fails, the host is as before: the records, the
    /// keys and open challenges, the registry, the waiting pairing requests,
    /// and no new secret waiting for collection. While saving is blocked
    /// ([`Host::from_load`]) nothing is changed. Revocation does not go
    /// through here: see [`Host::revoke_saved`].
    pub fn commit<R>(
        &mut self,
        io: &dyn FileIo,
        sealer: Option<&dyn Sealer>,
        change: impl FnOnce(&mut Host) -> Result<R, ChangeError>,
    ) -> Result<R, ChangeError> {
        if let Some(error) = &self.blocked {
            return Err(ChangeError::StoreBlocked(error.clone()));
        }
        // Snapshots of the real state, not a rebuild: a rebuild would drop
        // open challenges and undo in-memory revocations.
        let (stored, registry, identities, pairing) =
            (self.stored.clone(), self.registry.clone(), self.identities.clone(), self.pairing.clone());
        let waiting: Vec<String> = self.deliveries.keys().cloned().collect();
        let undo = move |host: &mut Host| {
            host.stored = stored;
            host.registry = registry;
            host.identities = identities;
            host.pairing = pairing;
            host.deliveries.retain(|id, _| waiting.contains(id));
        };
        let result = match change(self) {
            Ok(result) => result,
            Err(error) => {
                undo(self);
                return Err(error);
            }
        };
        if let Err(error) = store::save(io, sealer, &self.stored) {
            undo(self);
            return Err(ChangeError::Store(error));
        }
        Ok(result)
    }

    /// The owner denies a waiting pairing request.
    pub fn deny(&mut self, id: &str, now_ms: u64) -> bool {
        self.pairing.deny(id, now_ms)
    }

    /// Handle one frame with one read source for every client.
    pub fn on_frame(&mut self, conn: &mut Conn, frame: &[u8], now_ms: u64, reads: &dyn Reads) -> Step {
        self.on_frame_from(conn, frame, now_ms, &Fixed(reads))
    }

    /// Handle one frame (one line, without its newline) from `conn`; a ready
    /// client reads through `source`, narrowed to its own preset. The same
    /// as [`Host::begin_frame`], [`Pending::read`] and [`Host::finish_frame`]
    /// in a row; a caller sharing the host between connections uses those
    /// three so the read runs without the host's lock.
    pub fn on_frame_from(&mut self, conn: &mut Conn, frame: &[u8], now_ms: u64, source: &dyn ReadSource) -> Step {
        match self.begin_frame(conn, frame, now_ms) {
            Begin::Done(step) => step,
            Begin::Read(pending) => {
                let read = pending.read(source);
                self.finish_frame(conn, pending, read)
            }
        }
    }

    /// The part of one frame that needs the host: the whole handshake, or for
    /// a ready client the authorisation and rate limit. Does no I/O and runs
    /// no read. [`Begin::Read`] means the frame's read is still to run
    /// ([`Pending::read`], without the host) and [`Host::finish_frame`] after.
    pub fn begin_frame(&mut self, conn: &mut Conn, frame: &[u8], now_ms: u64) -> Begin {
        self.deliveries.retain(|_, delivery| now_ms < delivery.expires_ms);
        if frame.len() > MAX_FRAME_BYTES {
            *conn = Conn::Closed;
            return Begin::Done(Step::refuse("frame too large"));
        }
        let state = std::mem::replace(conn, Conn::Closed);
        if let Conn::Ready { client } = &state {
            // A client revoked while connected loses the connection on its next frame.
            if self.registry.active(client).is_none() {
                return Begin::Done(self.refuse_audited(client, "client not authorised", now_ms));
            }
            let preset = self.preset(client);
            let begun = self.sessions.begin(client, frame, now_ms, &self.registry, &mut self.audit);
            *conn = state;
            return match begun {
                Ok(begun) => Begin::Read(Pending { begun, preset, frame: frame.to_vec() }),
                Err(reply) => Begin::Done(Step { reply: reply.map(with_newline), close: false }),
            };
        }
        Begin::Done(self.handshake(conn, state, frame, now_ms))
    }

    /// The audit row for a read that ran, and the reply. A client revoked
    /// while its read ran gets no reply and loses the connection. The check
    /// is made here, under the host: a revoke landing after this call and
    /// before the caller writes the reply still lets that one reply out.
    pub fn finish_frame(&mut self, conn: &mut Conn, pending: Pending, read: ReadDone) -> Step {
        let still_active = self.registry.active(pending.begun.client()).is_some();
        self.sessions.finish(pending.begun, read.outcome, &mut self.audit);
        if !still_active {
            *conn = Conn::Closed;
            return Step::refuse("client not authorised");
        }
        Step { reply: read.reply.map(with_newline), close: false }
    }

    /// A frame of a connection that is not ready yet. Under the host only;
    /// no read and no I/O.
    fn handshake(&mut self, conn: &mut Conn, state: Conn, frame: &[u8], now_ms: u64) -> Step {
        let Ok(Value::Object(message)) = serde_json::from_slice::<Value>(frame) else {
            return Step::refuse("expected a handshake message");
        };
        match (state, message.len()) {
            (Conn::Start, 1) if message.contains_key("hello") => {
                let Some(client) = message["hello"].as_str() else { return Step::refuse("bad hello") };
                if self.registry.active(client).is_none() {
                    return self.refuse_audited(client, "unknown client", now_ms);
                }
                match self.identities.challenge(client, now_ms) {
                    Ok(challenge) => {
                        *conn = Conn::Challenged { client: client.to_owned(), challenge };
                        Step::send(json!({ "challenge": hex::encode(challenge) }))
                    }
                    Err(_) => self.refuse_audited(client, "unknown client", now_ms),
                }
            }
            (Conn::Challenged { client, challenge }, 1) if message.contains_key("signature") => {
                let Some(signature) = message["signature"].as_str().and_then(|s| hex::decode(s).ok()) else {
                    return self.refuse_audited(&client, "bad signature", now_ms);
                };
                // The registry is checked again: a client revoked during the handshake gets nothing.
                if self.registry.active(&client).is_some() && self.identities.verify(&client, &challenge, &signature, now_ms) {
                    *conn = Conn::Ready { client };
                    Step::send(json!({ "ready": true }))
                } else {
                    self.refuse_audited(&client, "not authorised", now_ms)
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

/// Read one frame (shared with the shim): see [`bitsov_mcp_wire::read_frame`].
pub use bitsov_mcp_wire::read_frame;

/// Windows: the owner-only named pipe (ADR A1 §1.3), built in `bitsov_ffi`.
#[cfg(windows)]
pub mod windows {
    pub use bitsov_ffi::win_private::pipe::{PipeConnection, PipeListener};

    const _: () = assert!(bitsov_ffi::win_private::pipe::MAX_CONNECTIONS == super::MAX_CONNECTIONS);
}

/// macOS: the owner-only listener (ADR A1 §1.3).
#[cfg(target_os = "macos")]
pub mod unix {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    /// The socket's file name inside the endpoint directory.
    pub use bitsov_mcp_wire::SOCKET_NAME;

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

    /// Accept one connection, closing any peer that is not this user. A peer
    /// whose credentials cannot be read (it may already be gone) is closed
    /// too, and the wait goes on.
    pub fn accept_owner(listener: &UnixListener) -> std::io::Result<UnixStream> {
        loop {
            let (stream, _) = listener.accept()?;
            if owner_peer(bitsov_ffi::peer_uid(&stream), bitsov_ffi::effective_uid()) {
                return Ok(stream);
            }
            drop(stream);
        }
    }

    /// Only a readable peer uid equal to ours is admitted.
    pub(super) fn owner_peer(peer: std::io::Result<u32>, own: u32) -> bool {
        matches!(peer, Ok(uid) if uid == own)
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
        host.approve(&id, topics, Preset::Counts, 2).unwrap();
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

    use crate::mcp::store::testing::{MemFile, TagSealer};

    /// Reads that say which preset they were narrowed to.
    struct ByPreset;
    impl ReadSource for ByPreset {
        fn reads_for(&self, preset: R2Preset) -> Box<dyn Reads + '_> {
            struct Tagged(R2Preset);
            impl Reads for Tagged {
                fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
                    Ok(json!({ "preset": format!("{:?}", self.0) }))
                }
            }
            Box::new(Tagged(preset))
        }
    }

    #[test]
    fn every_stored_preset_reaches_the_read_path_as_counts_or_rounded() {
        let mut host = Host::default();
        let (id, _) = paired(&mut host, &[Topic::Node]);
        let record = host.stored()[0].clone();
        for (stored, read) in [(Preset::Counts, R2Preset::Counts), (Preset::Rounded, R2Preset::Rounded), (Preset::Exact, R2Preset::Counts)] {
            // An exact record cannot be approved or loaded; forge one directly anyway.
            let host = Host::from_stored(vec![StoredClient { preset: stored, ..record.clone() }]);
            assert_eq!(host.preset(&id), read, "{stored:?}");
            assert!(matches!(host.preset(&id).preset(), Preset::Counts | Preset::Rounded));
            assert_eq!(host.registry.active(&id).is_some(), stored != Preset::Exact, "an exact record is never authorised");
        }
        assert_eq!(Host::default().preset("mcp-unknown"), R2Preset::Counts);
    }

    fn call_read_node(host: &mut Host, conn: &mut Conn, at: u64, source: &dyn ReadSource) -> Value {
        let step = host.on_frame_from(conn, br#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"read_node"}}"#, at, source);
        serde_json::from_slice(step.reply.as_ref().unwrap()).unwrap()
    }

    #[test]
    fn approved_clients_are_saved_sealed_and_open_a_session_after_a_restart() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        let mut host = Host::default();
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Desk", "nonce": hex::encode([3u8; 32])}})), 0, &Fake));
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        host.commit(&file, Some(&sealer), |h| h.approve(&id, &[Topic::Node], Preset::Rounded, 1)).unwrap();
        let done = reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 2, &Fake));
        let secret: [u8; 32] = hex::decode(done["secret"].as_str().unwrap()).unwrap().try_into().unwrap();

        // A restart: only the sealed file is left.
        let records = crate::mcp::store::load(&file, Some(&sealer)).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!((records[0].id.as_str(), records[0].preset, records[0].revoked), (id.as_str(), Preset::Rounded, false));
        let mut host = Host::from_stored(records);
        let mut conn = ready(&mut host, &id, &secret);
        let out = call_read_node(&mut host, &mut conn, 20, &ByPreset);
        assert!(out["result"]["content"].to_string().contains("Rounded"), "reads use this client's own preset: {out}");
    }

    #[test]
    fn a_failed_save_leaves_no_trace_and_no_secret_to_collect() {
        let file = MemFile { fail_write: true, ..MemFile::default() };
        let mut host = Host::default();
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Desk", "nonce": hex::encode([3u8; 32])}})), 0, &Fake));
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        let error = host.commit(&file, Some(&TagSealer), |h| h.approve(&id, &[Topic::Node], Preset::Counts, 1)).unwrap_err();
        assert!(matches!(error, ChangeError::Store(_)));
        assert!(host.stored().is_empty());
        assert!(host.registry.active(&id).is_none());
        assert!(host.identities.public_key(&id).is_none());
        let status = reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 2, &Fake));
        assert_eq!(status["pair"], "waiting", "the request is back, so the owner can approve again");
        assert!(status.get("secret").is_none(), "the secret of an approval that was not saved is never handed over");
        // No sealer (Linux): nothing is approved either.
        assert!(matches!(Host::default().commit(&MemFile::default(), None, |_| Ok(())), Err(ChangeError::Store(StoreError::NoSealer))));
    }

    #[test]
    fn exact_is_refused_and_a_revoke_is_saved_and_survives_a_restart() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        let mut host = Host::default();
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Desk", "nonce": hex::encode([3u8; 32])}})), 0, &Fake));
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        assert_eq!(host.commit(&file, Some(&sealer), |h| h.approve(&id, &[Topic::Node], Preset::Exact, 1)), Err(ChangeError::PresetTooWide));
        assert!(host.pairing.waiting(1).iter().any(|w| w.id == id), "a refused approval leaves the request waiting");
        host.commit(&file, Some(&sealer), |h| h.approve(&id, &[Topic::Node], Preset::Counts, 1)).unwrap();
        let done = reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 2, &Fake));
        let secret: [u8; 32] = hex::decode(done["secret"].as_str().unwrap()).unwrap().try_into().unwrap();
        let mut live = ready(&mut host, &id, &secret);

        host.revoke_saved(&file, Some(&sealer), &id).unwrap();
        assert!(host.on_frame(&mut live, br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, 30, &Fake).close, "a live session ends");
        assert!(host.identities.public_key(&id).is_none(), "the key is dropped with the registry entry");
        assert_eq!(host.revoke_saved(&file, Some(&sealer), &id), Err(ChangeError::UnknownClient));

        let records = crate::mcp::store::load(&file, Some(&sealer)).unwrap();
        assert!(records[0].revoked, "kept for the owner's history, marked revoked");
        let mut host = Host::from_stored(records);
        let mut conn = Conn::Start;
        assert_eq!(reply(&host.on_frame(&mut conn, &frame(json!({"hello": id})), 40, &Fake))["error"], "unknown client");
    }

    /// Pair, approve with a save, collect the secret, open a session.
    fn approved_and_ready(host: &mut Host, file: &MemFile) -> (String, [u8; 32], Conn) {
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Desk", "nonce": hex::encode([3u8; 32])}})), 0, &Fake));
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        host.commit(file, Some(&TagSealer), |h| h.approve(&id, &[Topic::Node], Preset::Counts, 1)).unwrap();
        let done = reply(&host.on_frame(&mut conn, &frame(json!({"pair_status": true})), 2, &Fake));
        let secret: [u8; 32] = hex::decode(done["secret"].as_str().unwrap()).unwrap().try_into().unwrap();
        let live = ready(host, &id, &secret);
        (id, secret, live)
    }

    #[test]
    fn a_revoke_whose_save_fails_still_cuts_the_client_off_now() {
        let mut file = MemFile::default();
        let mut host = Host::default();
        let (id, _, mut live) = approved_and_ready(&mut host, &file);
        file.fail_write = true;
        assert!(matches!(host.revoke_saved(&file, Some(&TagSealer), &id), Err(ChangeError::RevokedNotSaved(_))));
        assert!(host.on_frame(&mut live, br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, 30, &Fake).close, "the live session ends anyway");
        assert!(host.identities.public_key(&id).is_none());
        // A later failing approval must not bring it back.
        let _ = host.commit(&file, Some(&TagSealer), |h| h.approve("mcp-ffff", &[Topic::Node], Preset::Exact, 40));
        assert!(host.registry.active(&id).is_none(), "a failed commit does not undo the revoke");
        // The next successful save carries the revocation.
        file.fail_write = false;
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Other", "nonce": hex::encode([4u8; 32])}})), 50, &Fake));
        let other = asked["pair"]["id"].as_str().unwrap().to_owned();
        host.commit(&file, Some(&TagSealer), |h| h.approve(&other, &[Topic::Node], Preset::Counts, 51)).unwrap();
        let records = crate::mcp::store::load(&file, Some(&TagSealer)).unwrap();
        assert!(records.iter().any(|r| r.id == id && r.revoked));
    }

    #[test]
    fn a_file_that_did_not_load_is_never_saved_over() {
        let file = MemFile::default();
        *file.bytes.borrow_mut() = Some(b"something that does not open".to_vec());
        let loaded = crate::mcp::store::load(&file, Some(&TagSealer));
        assert!(loaded.is_err());
        let mut host = Host::from_load(loaded);
        assert!(host.blocked().is_some());
        let mut conn = Conn::Start;
        let asked = reply(&host.on_frame(&mut conn, &frame(json!({"pair": {"name": "Desk", "nonce": hex::encode([3u8; 32])}})), 0, &Fake));
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        assert!(matches!(host.commit(&file, Some(&TagSealer), |h| h.approve(&id, &[Topic::Node], Preset::Counts, 1)), Err(ChangeError::StoreBlocked(_))));
        assert_eq!(file.bytes.borrow().as_deref(), Some(&b"something that does not open"[..]), "the old file is untouched");
        assert!(host.pairing.waiting(1).iter().any(|w| w.id == id), "the request keeps waiting");
        host.start_over();
        host.commit(&file, Some(&TagSealer), |h| h.approve(&id, &[Topic::Node], Preset::Counts, 2)).unwrap();
    }

    #[test]
    fn a_failed_commit_leaves_other_clients_open_challenges_and_requests_alone() {
        let file = MemFile::default();
        let mut host = Host::default();
        let (id, secret, _) = approved_and_ready(&mut host, &file);
        // Another connection of the same client is mid-handshake.
        let mut conn = Conn::Start;
        let challenge = reply(&host.on_frame(&mut conn, &frame(json!({"hello": id})), 60, &Fake));
        let challenge: [u8; 32] = hex::decode(challenge["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
        let mut other = Conn::Start;
        let asked = reply(&host.on_frame(&mut other, &frame(json!({"pair": {"name": "Notes", "nonce": hex::encode([5u8; 32])}})), 61, &Fake));
        let waiting = asked["pair"]["id"].as_str().unwrap().to_owned();
        assert_eq!(host.commit(&file, Some(&TagSealer), |h| h.approve(&waiting, &[Topic::Node], Preset::Exact, 62)), Err(ChangeError::PresetTooWide));
        assert!(host.pairing.waiting(63).iter().any(|w| w.id == waiting));
        // The open challenge survived the failed commit: answering it opens the session.
        let ok = host.on_frame(&mut conn, &frame(json!({"signature": hex::encode(sign(&secret, &id, &challenge))})), 64, &Fake);
        assert_eq!(reply(&ok)["ready"], true);
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
        host.approve(&late, &[Topic::Node], Preset::Counts, 1).unwrap();
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
        assert_eq!(host.audit.len(), 1, "a refused hello is audited");
        assert_eq!(host.audit[0].tool, HANDSHAKE_AUDIT_TOOL);
        assert_eq!(host.audit[0].outcome, Outcome::NotAuthorised);
        assert_eq!(host.audit[0].client, "mcp-0000000000000000");

        // An attacker-chosen id is cleaned like every other audit row: no control or
        // bidi characters, trimmed, capped.
        let mut conn = Conn::Start;
        let hostile = format!("  \u{202e}evil\u{2066}\n{}  ", "x".repeat(200));
        host.on_frame(&mut conn, &frame(json!({ "hello": hostile })), 1, &Fake);
        let row = &host.audit[1].client;
        assert!(row.starts_with("evil") && !row.contains('\u{202e}') && !row.contains('\u{2066}') && !row.contains('\n'));
        assert_eq!(row, &crate::mcp::session::clean(&hostile, MAX_CLIENT_NAME));
        assert!(row.chars().count() <= MAX_CLIENT_NAME);
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
        assert_eq!(host.audit.len(), 2, "both refused signatures are audited");
        assert!(host.audit.iter().all(|row| row.client == id && row.tool == HANDSHAKE_AUDIT_TOOL));
    }

    #[test]
    fn a_client_revoked_between_hello_and_signature_is_refused() {
        let mut host = Host::default();
        let (id, secret) = paired(&mut host, &[Topic::Node]);
        let mut conn = Conn::Start;
        let challenge = reply(&host.on_frame(&mut conn, &frame(json!({"hello": id})), 10, &Fake));
        let challenge: [u8; 32] = hex::decode(challenge["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert!(host.registry.revoke(&id));
        let step = host.on_frame(&mut conn, &frame(json!({"signature": hex::encode(sign(&secret, &id, &challenge))})), 11, &Fake);
        assert!(step.close);
        assert_eq!(reply(&step)["error"], "not authorised");
        assert_eq!(conn, Conn::Closed);
        assert_eq!(host.audit.len(), 1);
    }

    #[test]
    fn a_client_revoked_mid_session_is_refused_on_its_next_frame() {
        let mut host = Host::default();
        let (id, secret) = paired(&mut host, &[Topic::Node]);
        let mut conn = ready(&mut host, &id, &secret);
        assert!(host.registry.revoke(&id));
        let step = host.on_frame(&mut conn, br#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_node"}}"#, 20, &Fake);
        assert_eq!(reply(&step)["error"], "client not authorised");
        assert!(step.close, "the connection is cut, not only the frame refused");
        assert_eq!(conn, Conn::Closed);
        assert_eq!(host.audit.last().unwrap().outcome, Outcome::NotAuthorised);
    }

    #[test]
    fn a_split_frame_reads_outside_the_host_and_a_revoke_during_the_read_withholds_the_reply() {
        let mut host = Host::default();
        let (id, secret) = paired(&mut host, &[Topic::Node]);
        let mut conn = ready(&mut host, &id, &secret);
        let call = br#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_node"}}"#;

        // Handshake frames never leave the host.
        let mut fresh = Conn::Start;
        assert!(matches!(host.begin_frame(&mut fresh, &frame(json!({"hello": id})), 12), Begin::Done(_)));

        let Begin::Read(pending) = host.begin_frame(&mut conn, call, 13) else { panic!("a read to run") };
        assert!(host.audit.is_empty(), "the row is written when the read is done");
        let done = pending.read(&Fixed(&Fake));
        let step = host.finish_frame(&mut conn, pending, done);
        assert_eq!(reply(&step)["result"]["isError"], false);
        assert_eq!(host.audit.last().unwrap().outcome, Outcome::Read);

        let Begin::Read(pending) = host.begin_frame(&mut conn, call, 14) else { panic!("a read to run") };
        let done = pending.read(&Fixed(&Fake));
        host.revoke_saved(&MemFile::default(), Some(&TagSealer), &id).unwrap();
        let step = host.finish_frame(&mut conn, pending, done);
        assert_eq!(reply(&step)["error"], "client not authorised", "the read's result is not sent");
        assert!(step.close);
        assert_eq!(conn, Conn::Closed);
        assert_eq!(host.audit.last().unwrap().outcome, Outcome::Read, "the read that ran is still audited");
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

        // At the real cap: exactly MAX_FRAME_BYTES before the newline is a frame, one more is not.
        let mut exact = vec![b'y'; MAX_FRAME_BYTES];
        exact.push(b'\n');
        let mut input = std::io::Cursor::new(exact);
        assert_eq!(read_frame(&mut input, MAX_FRAME_BYTES).unwrap().map(|f| f.len()), Some(MAX_FRAME_BYTES));
        let mut over = vec![b'y'; MAX_FRAME_BYTES + 1];
        over.push(b'\n');
        assert!(read_frame(&mut std::io::Cursor::new(over), MAX_FRAME_BYTES).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_peer_whose_uid_cannot_be_read_or_differs_is_not_admitted() {
        assert!(unix::owner_peer(Ok(501), 501));
        assert!(!unix::owner_peer(Ok(502), 501));
        assert!(!unix::owner_peer(Err(std::io::Error::other("gone")), 501));
    }

    /// The real shim, end to end against this host over a socket pair:
    /// pairing (with the owner's approval), the key-proving session, one call.
    #[cfg(unix)]
    #[test]
    fn the_shim_pairs_opens_a_session_and_reads_through_the_real_host() {
        use std::io::{BufReader, Write};
        use std::os::unix::net::UnixStream;
        use std::sync::{Arc, Mutex};

        fn serve(host: Arc<Mutex<Host>>, stream: UnixStream) -> std::thread::JoinHandle<()> {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                let mut conn = Conn::Start;
                let mut at = 100;
                while let Ok(Some(frame)) = read_frame(&mut reader, MAX_FRAME_BYTES) {
                    at += 1;
                    let step = host.lock().unwrap().on_frame(&mut conn, &frame, at, &Fake);
                    if let Some(reply) = step.reply { writer.write_all(&reply).unwrap(); }
                    if step.close { break; }
                }
            })
        }

        let host = Arc::new(Mutex::new(Host::default()));
        let (ours, theirs) = UnixStream::pair().unwrap();
        let server = serve(host.clone(), theirs);
        let mut reader = BufReader::new(ours.try_clone().unwrap());
        let mut writer = ours;
        let words = std::cell::Cell::new(None);
        let approver = host.clone();
        let outcome = bitsov_mcp::pair(&mut reader, &mut writer, "Desk assistant", &[8u8; 32], |w| words.set(Some(*w)), || {
            let mut host = approver.lock().unwrap();
            if let Some(shown) = host.pairing.waiting(150).first().cloned() {
                assert_eq!(Some(shown.code), words.get(), "the app shows the words the shim computed");
                host.approve(&shown.id, &[Topic::Node], Preset::Counts, 150).unwrap();
            }
            true
        }).unwrap();
        let bitsov_mcp::PairOutcome::Approved(key) = outcome else { panic!("approved") };
        server.join().unwrap();

        let (ours, theirs) = UnixStream::pair().unwrap();
        let server = serve(host.clone(), theirs);
        let mut reader = BufReader::new(ours.try_clone().unwrap());
        let mut writer = ours;
        bitsov_mcp::open_session(&mut reader, &mut writer, &key).unwrap();
        writer.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n").unwrap();
        let reply: Value = serde_json::from_slice(&read_frame(&mut reader, MAX_FRAME_BYTES).unwrap().unwrap()).unwrap();
        assert_eq!(reply["result"]["tools"].as_array().unwrap().len(), 1);
        writer.shutdown(std::net::Shutdown::Both).unwrap();
        server.join().unwrap();
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
