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
//! R2 clients (known to this app, not to the node) may see at most
//! `rounded` data: [`Preset::Exact`] is refused here, on load and on save.

use serde::{Deserialize, Serialize};

use crate::ai::{Preset, Topic};
use crate::at_rest::Sealer;

/// The sealer purpose for the approved-clients file.
pub const CLIENTS_PURPOSE: &str = "mcp-clients-v1";
/// The file's name in the app's data directory.
pub const FILE_NAME: &str = "mcp-clients.sealed";
/// Format version inside the sealed content.
const VERSION: u32 = 1;
/// Largest sealed file read; a client record is a few hundred bytes.
pub const MAX_FILE_BYTES: usize = 64 * 1024;

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
    /// The client's Ed25519 public key.
    pub public_key: [u8; 32],
    pub topics: Vec<Topic>,
    pub preset: Preset,
    pub created_ms: u64,
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contents {
    version: u32,
    clients: Vec<StoredClient>,
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
    /// A client asks for more than R2 allows (`exact`).
    PresetTooWide { id: String },
    /// Two records for one client id.
    DuplicateClient { id: String },
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

/// Whether an R2 client may have `preset`. Exhaustive on purpose: a new,
/// wider preset must be decided here, never allowed by default.
pub fn r2_preset_allowed(preset: Preset) -> bool {
    match preset {
        Preset::Counts | Preset::Rounded => true,
        Preset::Exact => false,
    }
}

/// A preset an R2 client may have: counts or rounded, never exact. The read
/// path takes only this type, so `exact` cannot reach a client's reads at
/// all (ADR A1 §1.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum R2Preset {
    Counts,
    Rounded,
}

impl R2Preset {
    /// The R2 form of `preset`, only where [`r2_preset_allowed`] says so.
    pub fn new(preset: Preset) -> Option<Self> {
        if !r2_preset_allowed(preset) {
            return None;
        }
        match preset {
            Preset::Counts => Some(Self::Counts),
            Preset::Rounded => Some(Self::Rounded),
            Preset::Exact => None,
        }
    }

    /// The assistant preset this narrows to.
    pub fn preset(self) -> Preset {
        match self {
            Self::Counts => Preset::Counts,
            Self::Rounded => Preset::Rounded,
        }
    }
}

fn check(clients: &[StoredClient]) -> Result<(), StoreError> {
    let mut ids = std::collections::HashSet::new();
    if let Some(client) = clients.iter().find(|client| !ids.insert(client.id.as_str())) {
        // Two records for one id: which one holds is undefined, so neither is trusted.
        return Err(StoreError::DuplicateClient { id: client.id.clone() });
    }
    match clients.iter().find(|client| !r2_preset_allowed(client.preset)) {
        Some(client) => Err(StoreError::PresetTooWide { id: client.id.clone() }),
        None => Ok(()),
    }
}

/// Load the stored client records. A missing file is no records; anything
/// that does not open and check is [`StoreError::Unreadable`] (fail closed).
/// **Revoked records are returned too** (kept for the owner's history):
/// a caller that authorizes anything must skip records with `revoked: true`.
pub fn load(io: &dyn FileIo, sealer: Option<&dyn Sealer>) -> Result<Vec<StoredClient>, StoreError> {
    let sealer = sealer.ok_or(StoreError::NoSealer)?;
    let Some(sealed) = io.read(MAX_FILE_BYTES + 1).map_err(|error| StoreError::Io(error.to_string()))? else {
        return Ok(Vec::new());
    };
    if sealed.len() > MAX_FILE_BYTES {
        return Err(StoreError::Unreadable);
    }
    let plain = sealer.open(CLIENTS_PURPOSE, &sealed).map_err(|_| StoreError::Unreadable)?;
    let contents: Contents = serde_json::from_slice(&plain).map_err(|_| StoreError::Unreadable)?;
    if contents.version != VERSION {
        return Err(StoreError::Unreadable);
    }
    // A file that holds a wider preset than R2 allows is not trusted at all.
    check(&contents.clients).map_err(|_| StoreError::Unreadable)?;
    Ok(contents.clients)
}

/// Save the approved clients, sealed. Refuses a client above `rounded`.
pub fn save(io: &dyn FileIo, sealer: Option<&dyn Sealer>, clients: &[StoredClient]) -> Result<(), StoreError> {
    let sealer = sealer.ok_or(StoreError::NoSealer)?;
    check(clients)?;
    let plain = serde_json::to_vec(&Contents { version: VERSION, clients: clients.to_vec() })
        .map_err(|error| StoreError::Io(error.to_string()))?;
    let plain = zeroize::Zeroizing::new(plain);
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
    use super::testing::{MemFile, TagSealer};
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
        let body = serde_json::to_vec(&Contents { version: VERSION, clients: twice }).unwrap();
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
        StoredClient { id: id.into(), name: "Desk".into(), public_key: [7u8; 32], topics: vec![Topic::Node], preset, created_ms: 1, revoked: false }
    }

    #[test]
    fn saved_clients_load_back_and_a_missing_file_is_no_clients() {
        let (file, sealer) = (MemFile::default(), TagSealer);
        assert_eq!(load(&file, Some(&sealer)), Ok(vec![]));
        let clients = vec![client("mcp-01", Preset::Counts), client("mcp-02", Preset::Rounded)];
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
        let plain = serde_json::to_vec(&Contents { version: VERSION, clients: vec![] }).unwrap();
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
        let plain = serde_json::to_vec(&Contents { version: VERSION, clients: vec![client("mcp-03", Preset::Exact)] }).unwrap();
        *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, &plain).unwrap());
        assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        assert!(r2_preset_allowed(Preset::Rounded) && r2_preset_allowed(Preset::Counts) && !r2_preset_allowed(Preset::Exact));
    }

    #[test]
    fn the_r2_preset_is_counts_or_rounded_and_never_exact() {
        for preset in [Preset::Exact, Preset::Rounded, Preset::Counts] {
            match R2Preset::new(preset) {
                Some(r2) => {
                    assert!(r2_preset_allowed(preset));
                    assert_eq!(r2.preset(), preset, "converts back unchanged");
                    assert!(matches!(r2.preset(), Preset::Counts | Preset::Rounded));
                }
                None => assert_eq!(preset, Preset::Exact),
            }
        }
        // Exhaustive with two arms: a third (wider) variant would not compile here.
        for r2 in [R2Preset::Counts, R2Preset::Rounded] {
            match r2 {
                R2Preset::Counts | R2Preset::Rounded => {}
            }
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
        for plain in [br#"{"version":2,"clients":[]}"#.to_vec(), br#"{"version":1,"clients":[],"extra":1}"#.to_vec()] {
            *file.bytes.borrow_mut() = Some(sealer.seal(CLIENTS_PURPOSE, &plain).unwrap());
            assert_eq!(load(&file, Some(&sealer)), Err(StoreError::Unreadable));
        }
    }

    #[test]
    fn the_r2_pairing_sunset_is_still_open_until_n5() {
        // Flips to false when the node ships owner-set device approvals on file
        // and flag boxes (N-5). This test makes that change a deliberate edit.
        const { assert!(R2_PAIRING_OPEN) };
    }
}
