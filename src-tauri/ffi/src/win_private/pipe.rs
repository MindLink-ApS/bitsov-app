//! The MCP endpoint's named pipe on Windows (ADR H3953 A1 §1.3): this user
//! only, this computer only, at most [`MAX_CONNECTIONS`] clients at once.
//!
//! - The DACL is the private-file descriptor: the current user SID only.
//! - `PIPE_REJECT_REMOTE_CLIENTS` refuses clients from other computers.
//! - The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so
//!   [`PipeListener::bind`] fails if a pipe of that name already exists.
//!   One instance always waits for the next client, so the name stays ours
//!   while the listener lives.
//! - A client whose process token is not this user, is elevated, or cannot be
//!   read is disconnected before a byte is read. So is a client over the cap.
//!
//! The client side ([`connect_owner`], used by the `bitsov-mcp` shim) checks the
//! server the same way: a pipe served by another user, or by an elevated
//! process, is closed before a byte is written. It also opens the pipe at
//! identification level only, so a server can never act as the client.
//!
//! Residual: the client is found by process id (`GetNamedPipeClientProcessId`).
//! A client that exits right after connecting could have its id reused by a
//! new process; that process passes only if it is this user, unelevated.
//! Programs running as the same user are not kept apart (ADR A1 §2).

use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_NOT_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::Security::{EqualSid, TOKEN_QUERY};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::{
    current_user, last_error, refused, token_is_elevated, token_user, SecurityDescriptor, UserSid,
};
use crate::private_policy::{self as policy, ObjectKind};

pub use policy::MCP_PIPE_MAX_CONNECTIONS as MAX_CONNECTIONS;

// The flags the platform-neutral policy names are the Windows ones.
const _: () = assert!(policy::MCP_PIPE_OPEN_MODE == PIPE_ACCESS_DUPLEX);
const _: () = assert!(policy::MCP_PIPE_FIRST_INSTANCE == FILE_FLAG_FIRST_PIPE_INSTANCE);
const _: () = assert!(
    policy::MCP_PIPE_MODE == PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS
);

/// Buffer size each way: one full frame.
const BUFFER_BYTES: u32 = 64 * 1024;

/// The listening side. Not `Sync`: one thread accepts.
pub struct PipeListener {
    name: Vec<u16>,
    user: UserSid,
    descriptor: SecurityDescriptor,
    /// The instance waiting for the next client.
    waiting: OwnedHandle,
    /// One clone per live connection.
    live: Arc<()>,
}

/// One accepted client. Read and write through [`Self::pipe`]; dropping it
/// closes the pipe and frees its slot.
pub struct PipeConnection {
    pipe: File,
    _slot: Arc<()>,
}

impl PipeConnection {
    pub fn pipe(&self) -> &File {
        &self.pipe
    }
}

impl std::fmt::Debug for PipeConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PipeConnection(..)")
    }
}

impl PipeListener {
    /// The pipe for the current user, `\\.\pipe\bitsov-mcp-<SID>`. Refused in
    /// an elevated process.
    pub fn bind() -> io::Result<Self> {
        let user = current_user()?;
        let name = policy::mcp_pipe_name(user.as_str()).map_err(refused)?;
        Self::bind_named(user, &name)
    }

    fn bind_named(user: UserSid, name: &str) -> io::Result<Self> {
        let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let descriptor = SecurityDescriptor::private(&user, ObjectKind::File)?;
        let waiting = instance(&name, &descriptor, true)?;
        Ok(Self { name, user, descriptor, waiting, live: Arc::new(()) })
    }

    fn live_connections(&self) -> usize {
        Arc::strong_count(&self.live) - 1
    }

    /// Wait for one client. `Ok(None)`: a client came and was refused (not
    /// this user, elevated, over the cap, or already gone).
    pub fn accept_one(&mut self) -> io::Result<Option<PipeConnection>> {
        let connected = connect(&self.waiting)?;
        let admit = connected
            && self.live_connections() < MAX_CONNECTIONS
            && client_is_owner(&self.waiting, &self.user);
        if !admit {
            // A disconnected instance takes no client until it is connected
            // again, so it is replaced: the new one is created first, so the
            // name is never released, and dropping the old one cuts the client.
            let next = instance(&self.name, &self.descriptor, false)?;
            drop(std::mem::replace(&mut self.waiting, next));
            return Ok(None);
        }
        let next = instance(&self.name, &self.descriptor, false)?;
        let pipe = std::mem::replace(&mut self.waiting, next);
        Ok(Some(PipeConnection { pipe: File::from(pipe), _slot: Arc::clone(&self.live) }))
    }

    /// Wait for a client that is admitted; refused ones are dropped and the
    /// wait goes on.
    pub fn accept_owner(&mut self) -> io::Result<PipeConnection> {
        loop {
            if let Some(connection) = self.accept_one()? {
                return Ok(connection);
            }
        }
    }
}

fn instance(name: &[u16], descriptor: &SecurityDescriptor, first: bool) -> io::Result<OwnedHandle> {
    let attributes = descriptor.attributes();
    let open_mode = if first {
        policy::MCP_PIPE_OPEN_MODE | policy::MCP_PIPE_FIRST_INSTANCE
    } else {
        policy::MCP_PIPE_OPEN_MODE
    };
    // SAFETY: a NUL-terminated name, and attributes whose descriptor outlives
    // the call; a handle we own comes back on success.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            policy::MCP_PIPE_MODE,
            // The cap, plus the instance that waits for the next client, plus
            // its replacement while a refused client is being dropped.
            MAX_CONNECTIONS as u32 + 2,
            BUFFER_BYTES,
            BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(last_error());
    }
    // SAFETY: the handle was just returned to us and is closed exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Block until a client connects. `Ok(false)`: it connected and left already.
fn connect(pipe: &OwnedHandle) -> io::Result<bool> {
    // SAFETY: a valid pipe handle, synchronous (no OVERLAPPED).
    if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), std::ptr::null_mut()) } != 0 {
        return Ok(true);
    }
    // SAFETY: reads this thread's last-error value.
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => Ok(true),
        ERROR_NO_DATA => Ok(false),
        code => Err(io::Error::from_raw_os_error(code as i32)),
    }
}

/// The current user's MCP pipe name. Refused in an elevated process.
pub fn current_user_pipe_name() -> io::Result<String> {
    let user = current_user()?;
    policy::mcp_pipe_name(user.as_str()).map_err(refused)
}

/// Client side: open the pipe `name` and keep it only if its server process is
/// this user and not elevated. Refused in an elevated process.
///
/// The pipe is opened for overlapped I/O and handed out as a read half and a
/// write half ([`OwnerPipe::split`]). A synchronous pipe handle serialises
/// every operation on it, so a read blocked waiting for the app would hold up
/// a write from another thread, and the relay would deadlock. Each half has
/// its own event, and a read and a write can be in flight at the same time.
pub fn connect_owner(name: &str) -> io::Result<OwnerPipe> {
    use std::os::windows::fs::OpenOptionsExt;
    let user = current_user()?;
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OVERLAPPED)
        // Identification level: the server can read who we are, never act as us.
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(name)?;
    let pipe = OwnedHandle::from(pipe);
    let mut pid = 0u32;
    // SAFETY: an open pipe handle and a valid out pointer.
    let found = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } != 0;
    if !found || !process_is_owner(pid, &user) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the pipe is not served by this user's BitSov app",
        ));
    }
    Ok(OwnerPipe(Arc::new(pipe)))
}

/// A client connection to this user's pipe, opened for overlapped I/O.
pub struct OwnerPipe(Arc<OwnedHandle>);

impl std::fmt::Debug for OwnerPipe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OwnerPipe(..)")
    }
}

impl OwnerPipe {
    /// A read half and a write half, usable from two threads at once.
    pub fn split(self) -> io::Result<(PipeHalf, PipeHalf)> {
        Ok((PipeHalf::new(Arc::clone(&self.0))?, PipeHalf::new(self.0)?))
    }
}

/// One direction of an [`OwnerPipe`]: its own event and `OVERLAPPED`, one
/// operation at a time. The pipe closes when both halves are dropped.
pub struct PipeHalf {
    pipe: Arc<OwnedHandle>,
    event: OwnedHandle,
}

impl std::fmt::Debug for PipeHalf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PipeHalf(..)")
    }
}

impl PipeHalf {
    fn new(pipe: Arc<OwnedHandle>) -> io::Result<Self> {
        // SAFETY: an unnamed manual-reset event, default security; owned below.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(last_error());
        }
        // SAFETY: the handle was just returned to us and is closed exactly once.
        Ok(Self { pipe, event: unsafe { OwnedHandle::from_raw_handle(event) } })
    }

    /// Run one overlapped operation to completion. `start` issues it with the
    /// given `OVERLAPPED`; this waits for it before returning, so the buffer
    /// and the `OVERLAPPED` outlive the operation.
    fn complete(&mut self, start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> i32) -> io::Result<usize> {
        let mut overlapped = OVERLAPPED { hEvent: self.event.as_raw_handle(), ..Default::default() };
        let handle = self.pipe.as_raw_handle();
        if start(handle, &mut overlapped) == 0 {
            // SAFETY: reads this thread's last-error value.
            match unsafe { GetLastError() } {
                ERROR_IO_PENDING => {}
                ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED => return Ok(0),
                code => return Err(io::Error::from_raw_os_error(code as i32)),
            }
        }
        let mut done = 0u32;
        // SAFETY: the operation was issued on `handle` with `overlapped`, both
        // alive here; waiting (TRUE) returns only once it has completed.
        if unsafe { GetOverlappedResult(handle, &overlapped, &mut done, 1) } == 0 {
            // SAFETY: reads this thread's last-error value.
            return match unsafe { GetLastError() } {
                ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED => Ok(0),
                code => Err(io::Error::from_raw_os_error(code as i32)),
            };
        }
        Ok(done as usize)
    }
}

impl io::Read for PipeHalf {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ptr = buf.as_mut_ptr();
        // SAFETY: `ptr` is valid for `len` bytes until `complete` returns.
        self.complete(|handle, overlapped| unsafe { ReadFile(handle, ptr, len, std::ptr::null_mut(), overlapped) })
    }
}

impl io::Write for PipeHalf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ptr = buf.as_ptr();
        // SAFETY: `ptr` is valid for `len` bytes until `complete` returns.
        let written = self.complete(|handle, overlapped| unsafe { WriteFile(handle, ptr, len, std::ptr::null_mut(), overlapped) })?;
        if written == 0 && len > 0 {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the app closed the connection"));
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn client_is_owner(pipe: &OwnedHandle, user: &UserSid) -> bool {
    let mut pid = 0u32;
    // SAFETY: a connected pipe handle and a valid out pointer.
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return false;
    }
    process_is_owner(pid, user)
}

/// The process `pid` runs as `user` and is not elevated. Any failure to tell
/// is a no.
fn process_is_owner(pid: u32, user: &UserSid) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: query-only access; the handle is owned just below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    // SAFETY: the handle was just returned to us and is closed exactly once.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: a valid process handle and a valid out pointer.
    if unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut token) } == 0
        || token.is_null()
    {
        return false;
    }
    // SAFETY: the handle was just returned to us and is closed exactly once.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let elevated = token_is_elevated(&token).map_err(drop);
    let same_user = token_user(&token)
        // SAFETY: both SIDs are valid and alive for the call.
        .map(|sid| unsafe { EqualSid(sid.as_psid(), user.as_psid()) } != 0)
        .map_err(drop);
    policy::mcp_pipe_client_allowed(elevated, same_user)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_name() -> String {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        format!(
            r"\\.\pipe\bitsov-mcp-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn client(name: &str) -> io::Result<File> {
        std::fs::OpenOptions::new().read(true).write(true).open(name)
    }

    #[test]
    fn a_client_of_this_user_is_accepted_and_bytes_flow_both_ways() {
        let name = test_name();
        let mut listener = PipeListener::bind_named(current_user().unwrap(), &name).unwrap();
        let mut ours = client(&name).unwrap();
        let connection = listener.accept_owner().unwrap();
        ours.write_all(b"{\"hello\":\"x\"}\n").unwrap();
        let mut got = [0u8; 14];
        (&*connection.pipe()).read_exact(&mut got).unwrap();
        assert_eq!(&got, b"{\"hello\":\"x\"}\n");
        (&*connection.pipe()).write_all(b"ok\n").unwrap();
        let mut back = [0u8; 3];
        ours.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"ok\n");
    }

    #[test]
    fn a_second_listener_cannot_take_an_existing_pipe_name() {
        let name = test_name();
        let _first = PipeListener::bind_named(current_user().unwrap(), &name).unwrap();
        assert!(PipeListener::bind_named(current_user().unwrap(), &name).is_err());
    }

    #[test]
    fn connections_over_the_cap_are_refused_and_a_freed_slot_is_reused() {
        let name = test_name();
        let mut listener = PipeListener::bind_named(current_user().unwrap(), &name).unwrap();
        let mut clients = Vec::new();
        let mut connections = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            clients.push(client(&name).unwrap());
            connections.push(listener.accept_one().unwrap().expect("under the cap"));
        }
        let mut late = client(&name).unwrap();
        assert!(listener.accept_one().unwrap().is_none(), "the ninth is refused");
        let mut buf = [0u8; 1];
        assert!(!matches!(late.read(&mut buf), Ok(n) if n > 0), "and disconnected");
        // Still at the cap, a refused client leaves a fresh instance behind.
        let _later = client(&name).unwrap();
        assert!(listener.accept_one().unwrap().is_none(), "the cap holds");
        drop(connections.pop());
        let _again = client(&name).unwrap();
        assert!(listener.accept_one().unwrap().is_some(), "a freed slot takes a new client");
    }

    #[test]
    fn a_client_connects_only_to_a_pipe_served_by_this_user() {
        let name = test_name();
        let mut listener = PipeListener::bind_named(current_user().unwrap(), &name).unwrap();
        let (_reader, mut writer) = connect_owner(&name).expect("served by this user").split().unwrap();
        let connection = listener.accept_owner().unwrap();
        writer.write_all(b"ping\n").unwrap();
        let mut got = [0u8; 5];
        (&*connection.pipe()).read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping\n");
        assert!(connect_owner(&test_name()).is_err(), "no such pipe");
    }

    /// The relay's shape: one thread blocked reading from the app while
    /// another writes to it. With one synchronous handle the write waited
    /// behind the read and nothing moved.
    #[test]
    fn a_write_goes_through_while_a_read_waits_on_the_same_pipe() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let name = test_name();
        let mut listener = PipeListener::bind_named(current_user().unwrap(), &name).unwrap();
        let (mut reader, mut writer) = connect_owner(&name).unwrap().split().unwrap();
        let connection = listener.accept_owner().unwrap();

        let (got_tx, got_rx) = channel();
        std::thread::spawn(move || {
            let mut reply = [0u8; 5];
            got_tx.send(reader.read_exact(&mut reply).map(|()| reply)).unwrap();
        });
        // Let the reader block in its read first.
        std::thread::sleep(Duration::from_millis(200));
        let (sent_tx, sent_rx) = channel();
        std::thread::spawn(move || sent_tx.send(writer.write_all(b"ping\n").map(|()| writer)).unwrap());
        let _writer = sent_rx.recv_timeout(Duration::from_secs(5)).expect("the write is not held up by the read").unwrap();

        let mut request = [0u8; 5];
        (&*connection.pipe()).read_exact(&mut request).unwrap();
        assert_eq!(&request, b"ping\n");
        (&*connection.pipe()).write_all(b"pong\n").unwrap();
        let reply = got_rx.recv_timeout(Duration::from_secs(5)).expect("the read completes").unwrap();
        assert_eq!(&reply, b"pong\n");

        // The app closing the connection reads as the end of the stream.
        let (mut reader, _writer) = {
            let name = test_name();
            let mut listener = PipeListener::bind_named(current_user().unwrap(), &name).unwrap();
            let halves = connect_owner(&name).unwrap().split().unwrap();
            drop(listener.accept_owner().unwrap());
            halves
        };
        let mut rest = Vec::new();
        assert_eq!(reader.read_to_end(&mut rest).unwrap(), 0);
    }

    #[test]
    fn the_pipe_name_is_per_user() {
        let user = current_user().unwrap();
        let name = policy::mcp_pipe_name(user.as_str()).unwrap();
        assert!(name.starts_with(r"\\.\pipe\bitsov-mcp-S-1-"));
        assert_eq!(current_user_pipe_name().unwrap(), name);
    }
}
