//! MCP phase 1, slice A1.1: the sealed approved-clients file (ADR H3953 A1 §1.5–§1.7).
//!
//! **Not wired.** The file's whole content is sealed with the platform
//! at-rest sealer under [`CLIENTS_PURPOSE`] (authenticated encryption), so any
//! edit fails to open. A file that fails to open means **no client is
//! approved**: the store fails closed and never parses plaintext. Reading and
//! writing go through [`FileIo`], which the wiring slice backs with the
//! private-file layer (owner-only, write-then-rename). Compiles only where
//! its parent module does (`cfg(test)` or the off-by-default `mcp-grant`
//! feature).
//!
//! R2 clients (known to this app, not to the node) are treated as cloud
//! clients (ADR AI boundary, owner GO 26 Nov): they may see **counts only**
//! ([`r2_preset_allowed`]), and never `balance` or `payments`
//! ([`mcp_topic_allowed`]). A file written before that loads narrowed, never
//! wider: those topics are dropped and `rounded` becomes `counts`. A file
//! that holds `exact` is not trusted at all.
//!
//! **The file holds live clients only.** Removing a client takes its record
//! out of the file; the removal and the client's history live in the audit
//! log. At most [`MAX_CLIENTS`] records are kept, and every record is bounded
//! (id, name, topics), so the largest file this module writes stays under the
//! platform sealers' plaintext limit ([`MAX_PLAINTEXT`]); a test checks the
//! worst case. The public key is stored as hex. Files of the first format
//! (the key as a list of numbers, removed clients kept and marked) still
//! load: their removed records are dropped, and the next save writes the
//! current format.

use serde::{Deserialize, Serialize};

use crate::ai::{Preset, Topic};
use crate::at_rest::{Sealer, MAX_PLAINTEXT};
use super::session::MAX_CLIENT_NAME;
use super::ClientId;

/// The sealer purpose for the approved-clients file.
pub const CLIENTS_PURPOSE: &str = "mcp-clients-v1";
/// The file's name in the app's data directory.
pub const FILE_NAME: &str = "mcp-clients.sealed";
/// Format version written: live clients only, the key as hex.
const VERSION: u32 = 2;
/// The first format: removed clients kept with `revoked: true`, the key as
/// a list of 32 numbers. Still read.
const VERSION_1: u32 = 1;
/// Largest sealed file read. Sealed output is larger than its plaintext;
/// files written here are under [`MAX_PLAINTEXT`] before sealing.
pub const MAX_FILE_BYTES: usize = 64 * 1024;
/// Most clients kept. Approving one more is refused until the owner removes
/// one. With every record at its largest (a 64-byte id, 64 four-byte
/// characters of name, every topic) six records take about 3.3 KB, well
/// under the sealer's 4,096 bytes; eight would not fit.
pub const MAX_CLIENTS: usize = 6;

/// Whether new R2 pairings may still be made. The ADR's sunset: once the node
/// ships owner-set device approvals on file and flag boxes (N-5), this becomes
/// `false` and new clients must pair with the node itself (R1).
pub const R2_PAIRING_OPEN: bool = true;

/// One approved client as stored. No secret: the host never keeps a client's
/// secret key half.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredClient {
    pub id: String,
    pub name: String,
    /// The client's Ed25519 public key, written as 64 hex characters.
    #[serde(with = "key_hex")]
    pub public_key: [u8; 32],
    pub topics: Vec<Topic>,
    pub preset: Preset,
    pub created_ms: u64,
}

/// The public key as lowercase hex; the first format's list of 32 numbers is
/// still read.
mod key_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(key: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(key))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 32], D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Key {
            Hex(String),
            Numbers([u8; 32]),
        }
        match Key::deserialize(deserializer)? {
            Key::Numbers(key) => Ok(key),
            Key::Hex(text) if text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {
                let bytes = hex::decode(text).map_err(serde::de::Error::custom)?;
                bytes.try_into().map_err(|_| serde::de::Error::custom("not 32 bytes"))
            }
            Key::Hex(_) => Err(serde::de::Error::custom("not a 64-character lowercase hex key")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Contents<'a> {
    version: u32,
    clients: &'a [StoredClient],
}

/// A record as read: the first format also carries `revoked`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRecord {
    id: String,
    name: String,
    #[serde(with = "key_hex")]
    public_key: [u8; 32],
    topics: Vec<Topic>,
    preset: Preset,
    created_ms: u64,
    revoked: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadContents {
    version: u32,
    clients: Vec<ReadRecord>,
}

/// Why the clients could not be loaded or saved. Every load error means the
/// caller treats the app as having **no** approved clients.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// No at-rest sealer on this platform (Linux today): MCP is unavailable.
    NoSealer,
    /// The file is there but does not open, parse or check: edited, from
    /// another user or machine, or damaged. The owner approves clients again.
    Unreadable,
    /// A client asks for more detail than R2 allows (above counts).
    PresetTooWide { id: String },
    /// A client holds a topic no MCP client may have (`balance`, `payments`).
    TopicNotAllowed { id: String },
    /// Two records for one client id.
    DuplicateClient { id: String },
    /// A record past the bounds (id, name, topics), or a list that would not
    /// fit the sealer once encoded.
    TooLarge,
    /// The file could not be read or written.
    Io(String),
}

/// File access, backed by the private-file layer when wired.
pub trait FileIo {
    /// The file's bytes, or `None` when nothing is there. Implementations
    /// must never read more than `max_bytes` (for example `Read::take`), so a
    /// damaged or inflated file cannot make the host allocate without bound.
    fn read(&self, max_bytes: usize) -> std::io::Result<Option<Vec<u8>>>;
    /// Replace the file atomically (write a temp file, then rename).
    fn write(&self, bytes: &[u8]) -> std::io::Result<()>;
}

/// Whether an R2 client may have `preset`: counts only. Exhaustive on
/// purpose: a new, wider preset must be decided here, never allowed by
/// default.
pub fn r2_preset_allowed(preset: Preset) -> bool {
    match preset {
        Preset::Counts => true,
        Preset::Rounded | Preset::Exact => false,
    }
}

/// Whether an MCP client may be given `topic`. `balance` and `payments` are
/// never in a cloud client's scope, at any detail, with no setting to bring
/// them back (owner GO, 26 Nov). `channels` stays, as counts only: no ids
/// and no amounts (the counts preset). Exhaustive on purpose: a new topic is decided here.
pub fn mcp_topic_allowed(topic: Topic) -> bool {
    match topic {
        Topic::Node | Topic::Channels | Topic::Prices | Topic::Inbox => true,
        Topic::Balance | Topic::Payments => false,
    }
}

/// The only preset an R2 client has: counts. The read path takes only this
/// type, so neither `rounded` nor `exact` can reach a client's reads at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum R2Preset {
    Counts,
}

impl R2Preset {
    /// The R2 form of `preset`, only where [`r2_preset_allowed`] says so.
    pub fn new(preset: Preset) -> Option<Self> {
        if !r2_preset_allowed(preset) {
            return None;
        }
        match preset {
            Preset::Counts => Some(Self::Counts),
            Preset::Rounded | Preset::Exact => None,
        }
    }

    /// The assistant preset this narrows to.
    pub fn preset(self) -> Preset {
        match self {
            Self::Counts => Preset::Counts,
        }
    }
}

/// Each record within the bounds the size check assumes: a valid client id
/// (at most 64 bytes, nothing JSON escapes), a name of at most
/// [`MAX_CLIENT_NAME`] characters with no control characters, and each topic
/// at most once.
fn bounded(client: &StoredClient) -> bool {
    let mut topics = client.topics.clone();
    topics.sort_by_key(|topic| *topic as u8);
    topics.dedup();
    ClientId::parse(&client.id).is_some()
        && client.name.chars().count() <= MAX_CLIENT_NAME
        && !client.name.chars().any(char::is_control)
        && topics.len() == client.topics.len()
}

fn check(clients: &[StoredClient]) -> Result<(), StoreError> {
    if !clients.iter().all(bounded) {
        return Err(StoreError::TooLarge);
    }
    let mut ids = std::collections::HashSet::new();
    if let Some(client) = clients.iter().find(|client| !ids.insert(client.id.as_str())) {
        // Two records for one id: which one holds is undefined, so neither is trusted.
        return Err(StoreError::DuplicateClient { id: client.id.clone() });
    }
    if let Some(client) = clients.iter().find(|client| !client.topics.iter().all(|topic| mcp_topic_allowed(*topic))) {
        return Err(StoreError::TopicNotAllowed { id: client.id.clone() });
    }
    match clients.iter().find(|client| !r2_preset_allowed(client.preset)) {
        Some(client) => Err(StoreError::PresetTooWide { id: client.id.clone() }),
        None => Ok(()),
    }
}

/// A record written before the cloud scope (owner GO, 26 Nov), read narrowed
/// and never wider: `balance` and `payments` are dropped, `rounded` becomes
/// `counts`. A client that had only those two topics has nothing left to
/// read and is dropped (`None`): it pairs again for what it may read.
/// `exact` is left for [`check`] to refuse the whole file.
fn narrowed(mut client: StoredClient) -> Option<StoredClient> {
    let had_topics = !client.topics.is_empty();
    client.topics.retain(|topic| mcp_topic_allowed(*topic));
    if had_topics && client.topics.is_empty() {
        return None;
    }
    if client.preset == Preset::Rounded {
        client.preset = Preset::Counts;
    }
    Some(client)
}

/// Load the approved clients. A missing file is no records; anything that
/// does not open and check is [`StoreError::Unreadable`] (fail closed). A
/// first-format file loads too, without its removed records.
pub fn load(io: &dyn FileIo, sealer: Option<&dyn Sealer>) -> Result<Vec<StoredClient>, StoreError> {
    let sealer = sealer.ok_or(StoreError::NoSealer)?;
    let Some(sealed) = io.read(MAX_FILE_BYTES + 1).map_err(|error| StoreError::Io(error.to_string()))? else {
        return Ok(Vec::new());
    };
    if sealed.len() > MAX_FILE_BYTES {
        return Err(StoreError::Unreadable);
    }
    let plain = sealer.open(CLIENTS_PURPOSE, &sealed).map_err(|_| StoreError::Unreadable)?;
    let contents: ReadContents = serde_json::from_slice(&plain).map_err(|_| StoreError::Unreadable)?;
    if contents.version != VERSION && contents.version != VERSION_1 {
        return Err(StoreError::Unreadable);
    }
    let mut clients = Vec::with_capacity(contents.clients.len());
    for record in contents.clients {
        let removed = match (contents.version, record.revoked) {
            (VERSION, None) => false,
            (VERSION_1, Some(revoked)) => revoked,
            _ => return Err(StoreError::Unreadable),
        };
        if !removed {
            let ReadRecord { id, name, public_key, topics, preset, created_ms, revoked: _ } = record;
            clients.extend(narrowed(StoredClient { id, name, public_key, topics, preset, created_ms }));
        }
    }
    // A file that still holds `exact` (or anything else that does not check
    // once narrowed) is not trusted at all.
    check(&clients).map_err(|_| StoreError::Unreadable)?;
    Ok(clients)
}

/// The plaintext [`save`] seals, or why it would not fit the sealer.
fn encode(clients: &[StoredClient]) -> Result<zeroize::Zeroizing<Vec<u8>>, StoreError> {
    check(clients)?;
    let plain = serde_json::to_vec(&Contents { version: VERSION, clients })
        .map_err(|error| StoreError::Io(error.to_string()))?;
    let plain = zeroize::Zeroizing::new(plain);
    if plain.len() > MAX_PLAINTEXT {
        return Err(StoreError::TooLarge);
    }
    Ok(plain)
}

/// Save the approved clients, sealed. Refuses a client above `rounded`.
pub fn save(io: &dyn FileIo, sealer: Option<&dyn Sealer>, clients: &[StoredClient]) -> Result<(), StoreError> {
    let sealer = sealer.ok_or(StoreError::NoSealer)?;
    let plain = encode(clients)?;
    let sealed = sealer.seal(CLIENTS_PURPOSE, &plain).map_err(StoreError::Io)?;
    if sealed.len() > MAX_FILE_BYTES {
        return Err(StoreError::Io("too many clients to store".into()));
    }
    io.write(&sealed).map_err(|error| StoreError::Io(error.to_string()))
}

/// A fresh scratch name beside `path`: `<name>.<random>.tmp`.
#[cfg(any(all(unix, not(target_os = "android")), windows))]
fn scratch_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|_| std::io::Error::other("no randomness"))?;
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", hex::encode(random)));
    Ok(path.with_file_name(name))
}

/// The clients file on disk, through the app's private-file layer: written
/// atomically (temp file, then rename), owner-only, never through a link.
pub struct PrivateFile {
    pub path: std::path::PathBuf,
}

impl FileIo for PrivateFile {
    #[cfg(all(unix, not(target_os = "android")))]
    fn read(&self, max_bytes: usize) -> std::io::Result<Option<Vec<u8>>> {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        // O_NONBLOCK: a FIFO planted at the path cannot hang the host; it is
        // then refused as not a regular file.
        let mut file = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        // Checked on the open handle: a regular file of this user, readable by no one else.
        let meta = file.metadata()?;
        if !meta.file_type().is_file() || meta.uid() != bitsov_ffi::effective_uid() || meta.mode() & 0o077 != 0 {
            return Err(std::io::Error::other("the clients file is not private to this user"));
        }
        let mut bytes = Vec::new();
        file.by_ref().take(max_bytes as u64).read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    #[cfg(windows)]
    fn read(&self, max_bytes: usize) -> std::io::Result<Option<Vec<u8>>> {
        crate::private_fs::read_optional(&self.path, max_bytes as u64).map(|bytes| bytes.map(|b| b.to_vec()))
    }

    #[cfg(not(any(all(unix, not(target_os = "android")), windows)))]
    fn read(&self, _max_bytes: usize) -> std::io::Result<Option<Vec<u8>>> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no private storage on this platform"))
    }

    /// A temp file beside the target (new, 0600, never through a link),
    /// synced, then renamed over it; the directory is made 0700.
    #[cfg(all(unix, not(target_os = "android")))]
    fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let dir = self.path.parent().ok_or_else(|| std::io::Error::other("no directory"))?;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let tmp = scratch_path(&self.path)?;
        let written = (|| {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
                .custom_flags(libc::O_NOFOLLOW).open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
            return written;
        }
        // The new file is in place. A failed directory sync after the rename
        // does not make the save a failure: memory and disk already agree.
        let _ = std::fs::File::open(dir).and_then(|d| d.sync_all());
        Ok(())
    }

    /// The app's verified private store: the folder and file must verify
    /// before anything is replaced, and the bytes are published only after a
    /// read-back matches.
    #[cfg(windows)]
    fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let dir = self.path.parent().ok_or_else(|| std::io::Error::other("no directory"))?;
        crate::private_fs::ensure_dir(dir)?;
        // A scratch name of its own each time: one left behind by a crash never
        // blocks a later save.
        let tmp = scratch_path(&self.path)?;
        crate::private_fs::write_replacing_verified(&tmp, &self.path, bytes, |e| e, |readback| {
            if readback == bytes { Ok(()) } else { Err(std::io::Error::other("read-back did not match")) }
        })
    }

    #[cfg(not(any(all(unix, not(target_os = "android")), windows)))]
    fn write(&self, _bytes: &[u8]) -> std::io::Result<()> {
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no private storage on this platform"))
    }
}

/// Test doubles for the store, shared with the endpoint's tests.
#[cfg(test)]
pub(crate) mod testing {
    use std::cell::RefCell;

    use zeroize::Zeroizing;

    use super::FileIo;
    use crate::at_rest::Sealer;

    /// Not secret (the body is plain); it only lets tests prove tamper refusal.
    pub(crate) struct TagSealer;

    /// [`TagSealer`] with the real sealers' plaintext limit: more than
    /// [`crate::at_rest::MAX_PLAINTEXT`] bytes is refused, as the Apple
    /// enclave bridge and Windows DPAPI do.
    pub(crate) struct LimitSealer;
    impl Sealer for LimitSealer {
        fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            if plaintext.is_empty() || plaintext.len() > crate::at_rest::MAX_PLAINTEXT {
                return Err("invalid protected storage input".into());
            }
            TagSealer.seal(purpose, plaintext)
        }
        fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            TagSealer.open(purpose, sealed)
        }
    }
    impl TagSealer {
        fn tag(purpose: &str, body: &[u8]) -> [u8; 32] {
            let mut hasher = blake3::Hasher::new_keyed(&[9u8; 32]);
            hasher.update(purpose.as_bytes());
            hasher.update(&[0]);
            hasher.update(body);
            *hasher.finalize().as_bytes()
        }
    }
    impl Sealer for TagSealer {
        fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            let mut out = Self::tag(purpose, plaintext).to_vec();
            out.extend_from_slice(plaintext);
            Ok(out)
        }
        fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            let (tag, body) = sealed.split_at_checked(32).ok_or("short")?;
            if tag != Self::tag(purpose, body) {
                return Err("tag mismatch".into());
            }
            Ok(Zeroizing::new(body.to_vec()))
        }
    }

    #[derive(Default)]
    pub(crate) struct MemFile {
        pub(crate) bytes: RefCell<Option<Vec<u8>>>,
        pub(crate) fail_write: bool,
        pub(crate) asked: std::cell::Cell<Option<usize>>,
    }
    impl FileIo for MemFile {
        fn read(&self, max_bytes: usize) -> std::io::Result<Option<Vec<u8>>> {
            self.asked.set(Some(max_bytes));
            Ok(self.bytes.borrow().as_ref().map(|b| b[..b.len().min(max_bytes)].to_vec()))
        }
        fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
            if self.fail_write {
                return Err(std::io::Error::other("disk full"));
            }
            *self.bytes.borrow_mut() = Some(bytes.to_vec());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::testing::{LimitSealer, MemFile, TagSealer};
    use std::cell::RefCell;

    /// A test sealer with integrity: a keyed BLAKE3 tag over purpose and body.
    #[cfg(all(unix, not(target_os = "android")))]
    #[test]
    fn the_private_file_round_trips_and_refuses_widened_or_linked_files() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let file = PrivateFile { path: temp.path().join("mcp").join("clients.sealed") };
        assert_eq!(file.read(16).unwrap(), None, "nothing there yet");
        let clients = vec![client("mcp-01", Preset::Counts)];
        save(&file, Some(&TagSealer), &clients).unwrap();
        assert_eq!(std::fs::metadata(&file.path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(load(&file, Some(&TagSealer)), Ok(clients));
        assert_eq!(file.read(4).unwrap().unwrap().len(), 4, "never more than asked for");

        std::fs::set_permissions(&file.path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(file.read(64).is_err(), "a widened file is refused");
        assert!(matches!(load(&file, Some(&TagSealer)), Err(StoreError::Io(_))), "and loads no clients");

        std::fs::remove_file(&file.path).unwrap();
        std::os::unix::fs::symlink(temp.path().join("elsewhere"), &file.path).unwrap();
        assert!(file.read(64).is_err(), "a link is not followed");
    }

    #[test]
    fn two_records_for_one_client_are_refused_on_save_and_on_load() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        let twice = vec![client("mcp-01", Preset::Counts), client("mcp-01", Preset::Rounded)];
        assert_eq!(save(&file, Some(&sealer), &twice), Err(StoreError::DuplicateClient { id: "mcp-01".into() }));
        let body = serde_json::to_vec(&Contents { version: VERSION, clients: &twice }).unwrap();
        *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, &body).unwrap());
        assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
    }

    #[cfg(all(unix, not(target_os = "android")))]
    #[test]
    fn a_fifo_at_the_path_is_refused_without_hanging_and_scratch_names_never_collide() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("clients.sealed");
        let status = std::process::Command::new("mkfifo").arg(&path).status().unwrap();
        assert!(status.success());
        let file = PrivateFile { path: path.clone() };
        assert!(file.read(64).is_err(), "a FIFO is not a regular file, and the read does not block");
        std::fs::remove_file(&path).unwrap();
        // A scratch file left behind by a crash does not block the next save.
        std::fs::write(temp.path().join("clients.sealed.tmp"), b"left over").unwrap();
        file.write(b"one").unwrap();
        file.write(b"two").unwrap();
        assert_eq!(file.read(64).unwrap().unwrap(), b"two");
        assert_ne!(scratch_path(&path).unwrap(), scratch_path(&path).unwrap());
    }

    fn client(id: &str, preset: Preset) -> StoredClient {
        StoredClient { id: id.into(), name: "Desk".into(), public_key: [7u8; 32], topics: vec![Topic::Node], preset, created_ms: 1 }
    }

    #[test]
    fn saved_clients_load_back_and_a_missing_file_is_no_clients() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        assert_eq!(load(&file, Some(&sealer)), Ok(vec![]));
        let clients = vec![client("mcp-01", Preset::Counts), client("mcp-02", Preset::Counts)];
        save(&file, Some(&sealer), &clients).unwrap();
        assert_eq!(load(&file, Some(&sealer)), Ok(clients));
        assert!(!String::from_utf8_lossy(file.bytes.borrow().as_ref().unwrap()).is_empty());
    }

    #[test]
    fn any_edit_fails_closed_to_no_clients() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        save(&file, Some(&sealer), &[client("mcp-01", Preset::Counts)]).unwrap();
        let good = file.bytes.borrow().clone().unwrap();
        for at in [0, 31, 32, good.len() - 1] {
            let mut bad = good.clone();
            bad[at] ^= 1;
            *file.bytes.borrow_mut() = Some(bad);
            assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable), "byte {at}");
        }
        // Truncated, empty, or plaintext JSON: all refused, never parsed as plain.
        for bad in [good[..10].to_vec(), Vec::new(), br#"{"version":1,"clients":[]}"#.to_vec()] {
            *file.bytes.borrow_mut() = Some(bad);
            assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        }
    }

    #[test]
    fn a_file_sealed_for_another_purpose_or_too_large_is_refused() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        let plain = serde_json::to_vec(&Contents { version: VERSION, clients: &[] }).unwrap();
        *file.bytes.borrow_mut() = Some(sealer.seal("client-ed25519-seed-v1", &plain).unwrap());
        assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        *file.bytes.borrow_mut() = Some(vec![0u8; MAX_FILE_BYTES * 4]);
        assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        assert_eq!(file.asked.get(), Some(MAX_FILE_BYTES + 1), "the read itself is capped");
    }

    #[test]
    fn exact_is_refused_for_r2_clients_on_save_and_on_load() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        assert_eq!(
            save(&file, Some(&sealer), &[client("mcp-01", Preset::Counts), client("mcp-02", Preset::Exact)]),
            Err(StoreError::PresetTooWide { id: "mcp-02".into() })
        );
        assert!(file.bytes.borrow().is_none(), "nothing written");
        // A validly sealed file that holds `exact` (written by older or other code) is not trusted.
        let plain = serde_json::to_vec(&Contents { version: VERSION, clients: &[client("mcp-03", Preset::Exact)] }).unwrap();
        *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, &plain).unwrap());
        assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        assert!(r2_preset_allowed(Preset::Counts) && !r2_preset_allowed(Preset::Rounded) && !r2_preset_allowed(Preset::Exact));
    }

    #[test]
    fn the_r2_preset_is_counts_or_rounded_and_never_exact() {
        for preset in [Preset::Exact, Preset::Rounded, Preset::Counts] {
            match R2Preset::new(preset) {
                Some(r2) => {
                    assert!(r2_preset_allowed(preset));
                    assert_eq!(r2.preset(), preset, "converts back unchanged");
                    assert_eq!(r2.preset(), Preset::Counts);
                }
                None => assert!(matches!(preset, Preset::Rounded | Preset::Exact)),
            }
        }
        // Exhaustive with one arm: a second (wider) variant would not compile here.
        match R2Preset::Counts {
            R2Preset::Counts => {}
        }
    }

    #[test]
    fn without_a_sealer_mcp_is_unavailable() {
        let file = MemFile::default();
        assert_eq!(load(&file, None), Err(StoreError::NoSealer));
        assert_eq!(save(&file, None, &[]), Err(StoreError::NoSealer));
    }

    #[test]
    fn a_failed_write_reports_and_leaves_the_old_file() {
        let sealer = TagSealer;
        let file = MemFile::default();
        save(&file, Some(&sealer), &[client("mcp-01", Preset::Counts)]).unwrap();
        let before = file.bytes.borrow().clone();
        let failing = MemFile { bytes: RefCell::new(before.clone()), fail_write: true, ..MemFile::default() };
        assert!(matches!(save(&failing, Some(&sealer), &[]), Err(StoreError::Io(_))));
        assert_eq!(*failing.bytes.borrow(), before);
    }

    #[test]
    fn unknown_fields_and_other_versions_are_refused() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        for plain in [br#"{"version":3,"clients":[]}"#.to_vec(), br#"{"version":2,"clients":[],"extra":1}"#.to_vec()] {
            *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, &plain).unwrap());
            assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        }
    }

    /// The largest record the checks allow: a 64-byte id, 64 four-byte
    /// characters of name, every topic an MCP client may have, the only R2
    /// preset, the largest time.
    fn largest(n: usize) -> StoredClient {
        let id = format!("{n:x}{}", "z".repeat(64)).chars().take(64).collect::<String>();
        StoredClient {
            id,
            name: "\u{1D11E}".repeat(MAX_CLIENT_NAME),
            public_key: [0xff; 32],
            topics: vec![Topic::Channels, Topic::Node, Topic::Inbox, Topic::Prices],
            preset: Preset::Counts,
            created_ms: u64::MAX,
        }
    }

    #[test]
    fn the_largest_allowed_file_fits_the_sealer_limit() {
        let full: Vec<StoredClient> = (0..MAX_CLIENTS).map(largest).collect();
        let plain = encode(&full).unwrap();
        assert!(plain.len() <= MAX_PLAINTEXT, "{} bytes", plain.len());
        // Margin for later fields: at least 10% under the limit.
        assert!(plain.len() * 10 <= MAX_PLAINTEXT * 9, "{} bytes", plain.len());
        let (file, sealer) = (MemFile::default(), LimitSealer);
        save(&file, Some(&sealer), &full).unwrap();
        assert_eq!(load(&file, Some(&sealer)).unwrap(), full);
        // One record past the bounds is refused, never sealed.
        let mut long = largest(0);
        long.name.push('x');
        assert_eq!(encode(&[long]), Err(StoreError::TooLarge));
        let mut doubled = largest(0);
        doubled.topics.push(Topic::Node);
        assert_eq!(encode(&[doubled]), Err(StoreError::TooLarge));
        let mut odd = largest(0);
        odd.id = "Has\"quotes".into();
        assert_eq!(encode(&[odd]), Err(StoreError::TooLarge));
        let mut control = largest(0);
        control.name = "a\u{7}b".into();
        assert_eq!(encode(&[control]), Err(StoreError::TooLarge));
    }

    #[test]
    fn a_list_that_would_not_fit_the_sealer_is_refused_before_sealing() {
        let (file, sealer) = (MemFile::default(), LimitSealer);
        let too_many: Vec<StoredClient> = (0..MAX_CLIENTS + 3).map(largest).collect();
        assert_eq!(save(&file, Some(&sealer), &too_many), Err(StoreError::TooLarge));
        assert!(file.bytes.borrow().is_none());
    }

    #[test]
    fn forty_approvals_and_removals_in_a_row_keep_saving_under_the_real_limit() {
        let (file, sealer) = (MemFile::default(), LimitSealer);
        // Five long-lived clients at their largest, then 40 added and removed.
        let mut clients: Vec<StoredClient> = (0..MAX_CLIENTS - 1).map(largest).collect();
        save(&file, Some(&sealer), &clients).unwrap();
        for n in 0..40 {
            let mut added = largest(1000 + n);
            added.id = format!("mcp-{n:016x}");
            clients.push(added.clone());
            save(&file, Some(&sealer), &clients).unwrap();
            clients.retain(|client| client.id != added.id);
            save(&file, Some(&sealer), &clients).unwrap();
            let on_disk = load(&file, Some(&sealer)).unwrap();
            assert!(on_disk.iter().all(|client| client.id != added.id), "removal {n} is on disk");
        }
        assert_eq!(load(&file, Some(&sealer)).unwrap(), clients);
    }

    #[test]
    fn a_first_format_file_still_loads_without_its_removed_records() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        let numbers = (0..32).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
        let old = format!(
            r#"{{"version":1,"clients":[{{"id":"mcp-01","name":"Desk","public_key":[{numbers}],"topics":["node"],"preset":"counts","created_ms":1,"revoked":false}},{{"id":"mcp-02","name":"Old","public_key":[{numbers}],"topics":["node"],"preset":"rounded","created_ms":2,"revoked":true}}]}}"#
        );
        *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, old.as_bytes()).unwrap());
        let mut key = [0u8; 32];
        for (n, byte) in key.iter_mut().enumerate() {
            *byte = n as u8;
        }
        let loaded = load(&file, Some(&sealer)).unwrap();
        assert_eq!(loaded, vec![StoredClient { id: "mcp-01".into(), name: "Desk".into(), public_key: key, topics: vec![Topic::Node], preset: Preset::Counts, created_ms: 1 }]);
        // The next save writes the current format: version 2, the key as hex, no removed record.
        save(&file, Some(&sealer), &loaded).unwrap();
        let sealed = file.bytes.borrow().clone().unwrap();
        let plain = String::from_utf8(sealer.open(CLIENTS_PURPOSE, &sealed).unwrap().to_vec()).unwrap();
        assert!(plain.contains(r#""version":2"#) && plain.contains(&hex::encode(key)), "{plain}");
        assert!(!plain.contains("revoked") && !plain.contains("mcp-02"), "{plain}");
        assert_eq!(load(&file, Some(&sealer)).unwrap(), loaded);
    }

    /// A record as an older app wrote it, in either format.
    fn written_before(version: u32, id: &str, topics: &str, preset: &str) -> String {
        match version {
            1 => {
                let numbers = (0..32).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
                format!(r#"{{"id":"{id}","name":"Desk","public_key":[{numbers}],"topics":{topics},"preset":"{preset}","created_ms":1,"revoked":false}}"#)
            }
            _ => {
                let key = hex::encode((0..32u8).collect::<Vec<_>>());
                format!(r#"{{"id":"{id}","name":"Desk","public_key":"{key}","topics":{topics},"preset":"{preset}","created_ms":1}}"#)
            }
        }
    }

    #[test]
    fn an_old_file_with_balance_payments_or_rounded_loads_narrowed_never_wider() {
        for version in [1, 2] {
            let (file, sealer) = (MemFile::default(), TagSealer);
            let records = [
                written_before(version, "mcp-01", r#"["balance","channels","payments","node"]"#, "rounded"),
                written_before(version, "mcp-02", r#"["balance","payments"]"#, "counts"),
                written_before(version, "mcp-03", r#"["inbox","prices"]"#, "counts"),
                written_before(version, "mcp-05", "[]", "counts"),
            ];
            let plain = format!(r#"{{"version":{version},"clients":[{}]}}"#, records.join(","));
            *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, plain.as_bytes()).unwrap());
            let loaded = load(&file, Some(&sealer)).unwrap();
            let seen: Vec<(&str, &[Topic], Preset)> = loaded.iter().map(|client| (client.id.as_str(), client.topics.as_slice(), client.preset)).collect();
            // mcp-02 had only balance and payments: nothing is left to read, so it is dropped.
            // mcp-05 never had a topic; the narrowing does not change it.
            assert_eq!(seen, [
                ("mcp-01", &[Topic::Channels, Topic::Node][..], Preset::Counts),
                ("mcp-03", &[Topic::Inbox, Topic::Prices][..], Preset::Counts),
                ("mcp-05", &[][..], Preset::Counts),
            ], "version {version}");
            assert!(loaded.iter().all(|client| client.topics.iter().all(|topic| mcp_topic_allowed(*topic))));
            // Saved again, the narrowed records are what is on file.
            save(&file, Some(&sealer), &loaded).unwrap();
            let sealed = file.bytes.borrow().clone().unwrap();
            let plain = String::from_utf8(sealer.open(CLIENTS_PURPOSE, &sealed).unwrap().to_vec()).unwrap();
            for gone in ["balance", "payments", "rounded"] {
                assert!(!plain.contains(gone), "version {version}: {gone} in {plain}");
            }
            // `exact` is still not trusted at all.
            let plain = format!(r#"{{"version":{version},"clients":[{}]}}"#, written_before(version, "mcp-04", r#"["node"]"#, "exact"));
            *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, plain.as_bytes()).unwrap());
            assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable), "version {version}");
        }
    }

    #[test]
    fn balance_payments_and_rounded_are_never_saved() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        for topic in [Topic::Balance, Topic::Payments] {
            let mut wide = client("mcp-01", Preset::Counts);
            wide.topics.push(topic);
            assert_eq!(save(&file, Some(&sealer), &[wide]), Err(StoreError::TopicNotAllowed { id: "mcp-01".into() }));
        }
        assert_eq!(save(&file, Some(&sealer), &[client("mcp-01", Preset::Rounded)]), Err(StoreError::PresetTooWide { id: "mcp-01".into() }));
        assert!(file.bytes.borrow().is_none(), "nothing written");
        for topic in [Topic::Balance, Topic::Payments] {
            assert!(!mcp_topic_allowed(topic));
        }
        for topic in [Topic::Node, Topic::Channels, Topic::Prices, Topic::Inbox] {
            assert!(mcp_topic_allowed(topic));
        }
    }

    #[test]
    fn the_formats_do_not_mix() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        let key = hex::encode([0xab_u8; 32]);
        for plain in [
            // `revoked` belongs to the first format only.
            format!(r#"{{"version":2,"clients":[{{"id":"mcp-01","name":"D","public_key":"{key}","topics":[],"preset":"counts","created_ms":1,"revoked":false}}]}}"#),
            // The first format always carried it.
            format!(r#"{{"version":1,"clients":[{{"id":"mcp-01","name":"D","public_key":"{key}","topics":[],"preset":"counts","created_ms":1}}]}}"#),
            // Upper-case or short hex is not a key.
            format!(r#"{{"version":2,"clients":[{{"id":"mcp-01","name":"D","public_key":"{}","topics":[],"preset":"counts","created_ms":1}}]}}"#, key.to_uppercase()),
            r#"{"version":2,"clients":[{"id":"mcp-01","name":"D","public_key":"abcd","topics":[],"preset":"counts","created_ms":1}]}"#.to_owned(),
        ] {
            *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, plain.as_bytes()).unwrap());
            assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable), "{plain}");
        }
    }

    #[test]
    fn the_r2_pairing_sunset_is_still_open_until_n5() {
        // Flips to false when the node ships owner-set device approvals on file
        // and flag boxes (N-5). This test makes that change a deliberate edit.
        const { assert!(R2_PAIRING_OPEN) };
    }
}
