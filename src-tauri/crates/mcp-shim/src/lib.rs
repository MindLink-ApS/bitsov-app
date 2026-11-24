//! `bitsov-mcp`: connects an AI client to the BitSov app's local MCP endpoint
//! (ADR H3953 A1, build step 3).
//!
//! The AI client starts `bitsov-mcp` and speaks MCP over its stdin and stdout.
//! The shim opens the app's endpoint, proves its client key, and then passes
//! MCP frames through unchanged, one line each way. It holds nothing but its
//! own client key, in an owner-only file, and it never decides what the
//! client may read: the app does.
//!
//! - **Pairing** ([`pair`]): the shim sends its declared name and a random
//!   nonce. It computes the six words itself, from both nonces and the name as
//!   the app cleans it, and refuses if the app's words differ. On the owner's
//!   approval the app hands over the client's secret once.
//! - **A session** ([`open_session`]): `hello`, the app's single-use
//!   challenge, the signature, `ready`.
//! - **Relay** ([`relay`]): frames up to the shared cap, each way.
//!
//! This slice is macOS only; the Windows pipe client follows.

use std::io::{self, BufRead, Write};

use bitsov_mcp_wire::{clean_name, pair_code, read_frame, sign, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use zeroize::Zeroizing;

/// The app's bundle identifier: its data directory holds the endpoint.
pub const APP_ID: &str = "tech.mindlink.bitsov";
/// The endpoint directory's name inside the app's data directory.
pub const ENDPOINT_DIR: &str = "mcp";

/// A paired client: its id and the secret half of its key.
pub struct ClientKey {
    pub id: String,
    pub secret: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for ClientKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientKey").field("id", &self.id).finish_non_exhaustive()
    }
}

/// How a pairing ended without an error.
#[derive(Debug)]
pub enum PairOutcome {
    Approved(ClientKey),
    /// Denied, expired, or already collected.
    Gone,
}

fn send(writer: &mut impl Write, value: Value) -> io::Result<()> {
    let mut line = value.to_string().into_bytes();
    line.push(b'\n');
    writer.write_all(&line)?;
    writer.flush()
}

fn receive(reader: &mut impl BufRead) -> io::Result<Value> {
    let frame = read_frame(reader, MAX_FRAME_BYTES)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "the app closed the connection"))?;
    serde_json::from_slice(&frame).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "the app sent something that is not JSON"))
}

fn refused(reply: &Value) -> io::Error {
    match reply.get("error").and_then(Value::as_str) {
        Some(reason) => io::Error::new(io::ErrorKind::PermissionDenied, format!("the app refused: {}", clean_name(reason))),
        None => io::Error::new(io::ErrorKind::InvalidData, "unexpected reply from the app"),
    }
}

fn hex32(value: &Value) -> Option<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(hex::decode(value.as_str()?).ok()?);
    let mut out = Zeroizing::new([0u8; 32]);
    if bytes.len() != 32 {
        return None;
    }
    out.copy_from_slice(&bytes);
    Some(out)
}

/// A client id as the app makes them: `mcp-` and hex, short.
pub fn valid_client_id(id: &str) -> bool {
    id.len() <= 64 && id.strip_prefix("mcp-").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Ask the app to pair. `show_code` gets the six words to show the owner;
/// `wait` is called before every status poll and returns false to give up.
pub fn pair(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    name: &str,
    shim_nonce: &[u8; 32],
    show_code: impl FnOnce(&[&'static str; 6]),
    mut wait: impl FnMut() -> bool,
) -> io::Result<PairOutcome> {
    let name = clean_name(name);
    if name.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "give this client a name"));
    }
    send(writer, json!({ "pair": { "name": name, "nonce": hex::encode(shim_nonce) } }))?;
    let reply = receive(reader)?;
    let asked = &reply["pair"];
    let (Some(id), Some(host_nonce)) = (asked.get("id").and_then(Value::as_str), asked.get("host_nonce").and_then(hex32)) else {
        return Err(refused(&reply));
    };
    if !valid_client_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the app sent a malformed client id"));
    }
    let id = id.to_owned();
    // The words shown are our own; the app's are only a cross-check.
    let ours = pair_code(shim_nonce, &host_nonce, &name);
    if asked.get("code") != Some(&json!(ours)) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the app's six words do not match; not pairing"));
    }
    show_code(&ours);
    loop {
        if !wait() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "the request was not approved in time"));
        }
        send(writer, json!({ "pair_status": true }))?;
        let reply = receive(reader)?;
        match reply.get("pair").and_then(Value::as_str) {
            Some("waiting") => continue,
            Some("gone") => return Ok(PairOutcome::Gone),
            Some("approved") => {
                if reply.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "the app approved a different request"));
                }
                let secret = reply.get("secret").and_then(hex32)
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "the app sent no usable key"))?;
                return Ok(PairOutcome::Approved(ClientKey { id, secret }));
            }
            _ => return Err(refused(&reply)),
        }
    }
}

/// Prove this client's key: hello, sign the app's challenge, ready.
pub fn open_session(reader: &mut impl BufRead, writer: &mut impl Write, key: &ClientKey) -> io::Result<()> {
    send(writer, json!({ "hello": key.id }))?;
    let reply = receive(reader)?;
    let Some(challenge) = reply.get("challenge").and_then(hex32) else {
        return Err(refused(&reply));
    };
    send(writer, json!({ "signature": hex::encode(sign(&key.secret, &key.id, &challenge)) }))?;
    let reply = receive(reader)?;
    if reply.get("ready") == Some(&Value::Bool(true)) {
        Ok(())
    } else {
        Err(refused(&reply))
    }
}

fn pass(from: &mut impl BufRead, to: &mut impl Write) -> io::Result<()> {
    while let Some(frame) = read_frame(from, MAX_FRAME_BYTES)? {
        to.write_all(&frame)?;
        to.write_all(b"\n")?;
        to.flush()?;
    }
    Ok(())
}

/// Pass MCP frames both ways until the app closes the connection. The
/// client's frames go up on a thread; when the client's input ends (or a
/// frame is too long), `close_app_writes` tells the app. An over-long frame
/// from the app is an error.
pub fn relay<AR, AW, CR, CW>(
    mut app_reader: AR,
    app_writer: AW,
    client_reader: CR,
    mut client_writer: CW,
    close_app_writes: impl FnOnce(AW) + Send + 'static,
) -> io::Result<()>
where
    AR: BufRead,
    AW: Write + Send + 'static,
    CR: BufRead + Send + 'static,
    CW: Write,
{
    std::thread::spawn(move || {
        let (mut client_reader, mut app_writer) = (client_reader, app_writer);
        let _ = pass(&mut client_reader, &mut app_writer);
        close_app_writes(app_writer);
    });
    pass(&mut app_reader, &mut client_writer)
}

#[cfg(unix)]
fn own_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// The client key file: owner-only, one per user (macOS).
#[cfg(unix)]
pub mod key_file {
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};
    use zeroize::Zeroizing;

    use super::{hex32, own_uid, valid_client_id, ClientKey};

    pub const FILE_NAME: &str = "client-key.json";
    const MAX_BYTES: u64 = 4096;

    /// `~/Library/Application Support/bitsov-mcp` on macOS.
    pub fn default_dir() -> io::Result<PathBuf> {
        let home = std::env::var_os("HOME").filter(|h| !h.is_empty())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
        Ok(PathBuf::from(home).join("Library/Application Support/bitsov-mcp"))
    }

    fn private_dir(dir: &Path) -> io::Result<()> {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.file_type().is_dir() || meta.uid() != own_uid() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the key directory is not this user's directory"));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }

    /// Store a new key. An existing key is never overwritten: `forget` first.
    pub fn save(dir: &Path, key: &ClientKey) -> io::Result<()> {
        private_dir(dir)?;
        let body = Zeroizing::new(json!({ "id": key.id, "secret": hex::encode(*key.secret) }).to_string());
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW).open(dir.join(FILE_NAME))?;
        file.write_all(body.as_bytes())?;
        file.sync_all()
    }

    fn check(file: &File) -> io::Result<()> {
        let meta = file.metadata()?;
        let private = meta.file_type().is_file() && meta.uid() == own_uid() && meta.mode() & 0o077 == 0
            && meta.nlink() == 1 && meta.len() <= MAX_BYTES;
        if private { Ok(()) } else {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "the key file is not private to this user; pair again"))
        }
    }

    /// Load the key; a file that is not private to this user is refused.
    pub fn load(dir: &Path) -> io::Result<ClientKey> {
        let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(dir.join(FILE_NAME))?;
        check(&file)?;
        let mut body = Zeroizing::new(Vec::new());
        Read::by_ref(&mut file).take(MAX_BYTES + 1).read_to_end(&mut body)?;
        let bad = || io::Error::new(io::ErrorKind::InvalidData, "the key file is damaged; pair again");
        let value: Value = serde_json::from_slice(&body).map_err(|_| bad())?;
        let id = value.get("id").and_then(Value::as_str).filter(|id| valid_client_id(id)).ok_or_else(bad)?;
        let secret = value.get("secret").and_then(hex32).ok_or_else(bad)?;
        Ok(ClientKey { id: id.to_owned(), secret })
    }

    /// Before pairing: refuse if anything at all is at the key path (a good
    /// key, a damaged or widened file, a link). The app hands a secret over
    /// only once, so pairing must not start unless that secret can be saved.
    pub fn ready_to_pair(dir: &Path) -> io::Result<()> {
        match std::fs::symlink_metadata(dir.join(FILE_NAME)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "a key file is already there (paired, or damaged); run `bitsov-mcp forget` first",
            )),
        }
    }

    /// Delete the key. True if there was one.
    pub fn forget(dir: &Path) -> io::Result<bool> {
        match std::fs::remove_file(dir.join(FILE_NAME)) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
}

/// Reaching the app on macOS: its socket, checked to be this user's.
#[cfg(target_os = "macos")]
pub mod macos {
    use std::io;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};

    use super::{own_uid, APP_ID, ENDPOINT_DIR};

    /// `~/Library/Application Support/<app id>/mcp/mcp.sock`.
    pub fn default_socket() -> io::Result<PathBuf> {
        let home = std::env::var_os("HOME").filter(|h| !h.is_empty())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
        Ok(PathBuf::from(home).join("Library/Application Support").join(APP_ID).join(ENDPOINT_DIR).join(bitsov_mcp_wire::SOCKET_NAME))
    }

    fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: a valid socket for the borrow and two valid out pointers.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }

    /// Connect only to an endpoint this user owns: an owner-only directory, a
    /// socket of this user, and a listening process of this user.
    pub fn connect(socket: &Path) -> io::Result<UnixStream> {
        let not_ours = || io::Error::new(io::ErrorKind::PermissionDenied, "the endpoint is not the BitSov app of this user");
        if own_uid() == 0 {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "bitsov-mcp does not run as root"));
        }
        let dir = socket.parent().ok_or_else(not_ours)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.file_type().is_dir() || meta.uid() != own_uid() || meta.mode() & 0o077 != 0 {
            return Err(not_ours());
        }
        let meta = std::fs::symlink_metadata(socket)?;
        if !meta.file_type().is_socket() || meta.uid() != own_uid() {
            return Err(not_ours());
        }
        let stream = UnixStream::connect(socket)?;
        if peer_uid(&stream)? != own_uid() {
            return Err(not_ours());
        }
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    /// A scripted app: the given replies, one per line, in order.
    fn app(replies: &[Value]) -> Cursor<Vec<u8>> {
        let mut out = Vec::new();
        for reply in replies {
            out.extend_from_slice(reply.to_string().as_bytes());
            out.push(b'\n');
        }
        Cursor::new(out)
    }

    fn sent(buf: &[u8]) -> Vec<Value> {
        buf.split(|b| *b == b'\n').filter(|l| !l.is_empty()).map(|l| serde_json::from_slice(l).unwrap()).collect()
    }

    #[test]
    fn pairing_shows_our_own_words_and_returns_the_key_once_approved() {
        let shim_nonce = [1u8; 32];
        let host_nonce = [2u8; 32];
        let code = pair_code(&shim_nonce, &host_nonce, "Desk assistant");
        let mut reader = app(&[
            json!({ "pair": { "id": "mcp-00ff", "host_nonce": hex::encode(host_nonce), "code": code } }),
            json!({ "pair": "waiting" }),
            json!({ "pair": "approved", "id": "mcp-00ff", "secret": hex::encode([9u8; 32]) }),
        ]);
        let mut writer = Vec::new();
        let mut shown = None;
        let outcome = pair(&mut reader, &mut writer, " Desk\u{202e} assistant\n", &shim_nonce, |w| shown = Some(*w), || true).unwrap();
        let PairOutcome::Approved(key) = outcome else { panic!("approved") };
        assert_eq!(key.id, "mcp-00ff");
        assert_eq!(*key.secret, [9u8; 32]);
        assert_eq!(shown, Some(code));
        let lines = sent(&writer);
        assert_eq!(lines[0]["pair"]["name"], "Desk assistant", "the cleaned name is sent and hashed");
        assert_eq!(lines.len(), 3);
        assert!(!format!("{key:?}").contains("9, 9"), "the secret is not in Debug output");
    }

    #[test]
    fn different_words_from_the_app_stop_the_pairing_before_anything_is_shown() {
        let mut reader = app(&[json!({ "pair": { "id": "mcp-01", "host_nonce": hex::encode([2u8; 32]), "code": ["a","b","c","d","e","f"] } })]);
        let mut shown = false;
        let error = pair(&mut reader, &mut Vec::new(), "Desk", &[1u8; 32], |_| shown = true, || true).unwrap_err();
        assert!(error.to_string().contains("do not match"));
        assert!(!shown);
    }

    #[test]
    fn denial_timeout_and_a_foreign_approval_end_the_pairing() {
        let host_nonce = [2u8; 32];
        let asked = json!({ "pair": { "id": "mcp-02", "host_nonce": hex::encode(host_nonce), "code": pair_code(&[1u8; 32], &host_nonce, "Desk") } });
        let gone = pair(&mut app(&[asked.clone(), json!({ "pair": "gone" })]), &mut Vec::new(), "Desk", &[1u8; 32], |_| {}, || true).unwrap();
        assert!(matches!(gone, PairOutcome::Gone));
        let late = pair(&mut app(std::slice::from_ref(&asked)), &mut Vec::new(), "Desk", &[1u8; 32], |_| {}, || false).unwrap_err();
        assert_eq!(late.kind(), io::ErrorKind::TimedOut);
        let other = json!({ "pair": "approved", "id": "mcp-99", "secret": hex::encode([9u8; 32]) });
        assert!(pair(&mut app(&[asked, other]), &mut Vec::new(), "Desk", &[1u8; 32], |_| {}, || true).is_err());
        assert!(pair(&mut app(&[]), &mut Vec::new(), "\u{2066} ", &[1u8; 32], |_| {}, || true).is_err(), "an empty name");
    }

    #[test]
    fn a_session_signs_the_apps_challenge_and_waits_for_ready() {
        let key = ClientKey { id: "mcp-0a".into(), secret: Zeroizing::new([5u8; 32]) };
        let challenge = [4u8; 32];
        let mut writer = Vec::new();
        open_session(&mut app(&[json!({ "challenge": hex::encode(challenge) }), json!({ "ready": true })]), &mut writer, &key).unwrap();
        let lines = sent(&writer);
        assert_eq!(lines[0], json!({ "hello": "mcp-0a" }));
        assert_eq!(lines[1]["signature"], hex::encode(sign(&[5u8; 32], "mcp-0a", &challenge)));
        let refused = open_session(&mut app(&[json!({ "error": "unknown client" })]), &mut Vec::new(), &key).unwrap_err();
        assert!(refused.to_string().contains("unknown client"));
    }

    #[test]
    fn the_relay_passes_lines_both_ways_and_tells_the_app_when_the_client_ends() {
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let up = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        struct Shared(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> { self.0.lock().unwrap().extend_from_slice(b); Ok(b.len()) }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        let mut down = Vec::new();
        relay(
            BufReader::new(Cursor::new(b"{\"result\":1}\n".to_vec())),
            Shared(up.clone()),
            BufReader::new(Cursor::new(b"{\"method\":\"tools/list\"}\n".to_vec())),
            &mut down,
            move |_| done_tx.send(()).unwrap(),
        ).unwrap();
        done_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the app is told the client ended");
        assert_eq!(down, b"{\"result\":1}\n");
        assert_eq!(*up.lock().unwrap(), b"{\"method\":\"tools/list\"}\n");
        let mut long = vec![b'x'; MAX_FRAME_BYTES + 1];
        long.push(b'\n');
        assert!(relay(BufReader::new(Cursor::new(long)), Vec::new(), BufReader::new(Cursor::new(Vec::new())), Vec::new(), |_| {}).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_private_never_overwritten_and_refused_when_widened() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("keys");
        let key = ClientKey { id: "mcp-0b".into(), secret: Zeroizing::new([6u8; 32]) };
        key_file::save(&dir, &key).unwrap();
        let path = dir.join(key_file::FILE_NAME);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let loaded = key_file::load(&dir).unwrap();
        assert_eq!((loaded.id.as_str(), *loaded.secret), ("mcp-0b", [6u8; 32]));
        assert!(key_file::save(&dir, &key).is_err(), "never overwritten");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(key_file::load(&dir).is_err(), "group-readable is refused");
        assert!(key_file::forget(&dir).unwrap());
        assert!(!key_file::forget(&dir).unwrap());
        std::os::unix::fs::symlink(temp.path().join("elsewhere"), &path).unwrap();
        assert!(key_file::load(&dir).is_err(), "a link is not followed");
    }

    /// Pairing burns the app's one-time secret if it cannot be saved, so a
    /// key path that is taken in any way stops `pair` before it connects.
    #[cfg(unix)]
    #[test]
    fn pairing_is_refused_while_anything_is_at_the_key_path() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("keys");
        assert!(key_file::ready_to_pair(&dir).is_ok(), "no directory yet");
        let key = ClientKey { id: "mcp-0d".into(), secret: Zeroizing::new([6u8; 32]) };
        key_file::save(&dir, &key).unwrap();
        let path = dir.join(key_file::FILE_NAME);
        let refused = |why: &str| {
            let error = key_file::ready_to_pair(&dir).expect_err(why);
            assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{why}");
            assert!(error.to_string().contains("bitsov-mcp forget"), "{why}");
        };
        refused("a good key");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(key_file::load(&dir).is_err());
        refused("a widened key that load refuses");
        std::fs::write(&path, b"not json").unwrap();
        refused("a damaged key");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(temp.path().join("missing"), &path).unwrap();
        refused("a dangling link");
        assert!(key_file::forget(&dir).unwrap(), "forget clears even a link");
        assert!(key_file::ready_to_pair(&dir).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_endpoint_must_be_this_users_socket_in_a_private_directory() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("mcp");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = dir.join(bitsov_mcp_wire::SOCKET_NAME);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert!(macos::connect(&socket).is_ok());
        drop(listener);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(macos::connect(&socket).is_err(), "a directory others can read is refused");
        let file = temp.path().join("plain");
        std::fs::write(&file, b"x").unwrap();
        assert!(macos::connect(&file).is_err(), "not a socket");
    }
}
