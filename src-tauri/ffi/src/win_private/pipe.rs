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
//! Residual: the client is found by process id (`GetNamedPipeClientProcessId`).
//! A client that exits right after connecting could have its id reused by a
//! new process; that process passes only if it is this user, unelevated.
//! Programs running as the same user are not kept apart (ADR A1 §2).

use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{EqualSid, TOKEN_QUERY};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
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

fn client_is_owner(pipe: &OwnedHandle, user: &UserSid) -> bool {
    let mut pid = 0u32;
    // SAFETY: a connected pipe handle and a valid out pointer.
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 || pid == 0 {
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
    fn the_pipe_name_is_per_user() {
        let user = current_user().unwrap();
        let name = policy::mcp_pipe_name(user.as_str()).unwrap();
        assert!(name.starts_with(r"\\.\pipe\bitsov-mcp-S-1-"));
    }
}
