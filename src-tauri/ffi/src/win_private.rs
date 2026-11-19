//! Owner-only private files on Windows, handed out as verified handles.
//!
//! Every private folder and file is created with an explicit protected
//! security descriptor: the current user owns it and holds the only access
//! entry, and nothing is inherited. New files use `CREATE_NEW`. Existing
//! objects are opened without truncation and are verified on the open handle
//! (kind, reparse flag, link count, owner and access list) before any I/O.
//! All later reads, writes, flushes and the final rename go through that same
//! handle, so the object that was checked is the object that is used.
//!
//! Objects in the wrong state are refused and left untouched: never repaired,
//! never deleted. Elevated processes, and processes whose elevation cannot be
//! read, are refused at every entry point before anything is created.
//!
//! Scope: protects against other ordinary accounts on the same PC. It does not
//! protect against software running as the same user, administrators, or a
//! folder above the private root being replaced.

use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_INSUFFICIENT_BUFFER, GENERIC_READ,
    GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetLengthSid,
    GetSecurityDescriptorControl, GetTokenInformation, IsValidSid, TokenElevation, TokenUser,
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PRESENT,
    SE_DACL_PROTECTED, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FileRenameInfoEx, FlushFileBuffers, GetFileInformationByHandle,
    SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, CREATE_NEW, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_RENAME_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use zeroize::Zeroizing;

use crate::private_policy::{
    self as policy, AceFacts, AceType, ObjectFacts, ObjectKind, Refusal, SecurityFacts,
};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
// FILE_RENAME_INFO flags for FileRenameInfoEx (winbase.h).
const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 0x1;
const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 0x2;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;

fn refused(refusal: Refusal) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, refusal)
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

/// Memory the OS allocated with `LocalAlloc`. Freed on drop.
struct LocalBox(*mut c_void);

impl Drop for LocalBox {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from an API that allocates with
            // LocalAlloc and transfers ownership to the caller.
            unsafe { LocalFree(self.0) };
        }
    }
}

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL character",
        ));
    }
    wide.push(0);
    Ok(wide)
}

/// The current user's SID, copied out of the process token.
pub struct UserSid {
    bytes: Box<[u8]>,
    string: String,
}

impl UserSid {
    fn as_psid(&self) -> PSID {
        // EqualSid and friends only read through this pointer.
        self.bytes.as_ptr() as PSID
    }

    /// The SID in `S-1-…` form, for building descriptors.
    pub fn as_str(&self) -> &str {
        &self.string
    }
}

impl std::fmt::Debug for UserSid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UserSid(..)")
    }
}

fn open_process_token() -> io::Result<OwnedHandle> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle; `token` is a valid
    // out pointer and receives a handle we own on success.
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if ok == 0 || token.is_null() {
        return Err(last_error());
    }
    // SAFETY: the handle was just returned to us and is closed exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(token) })
}

fn token_is_elevated(token: &OwnedHandle) -> io::Result<bool> {
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: the buffer is a TOKEN_ELEVATION of the stated size.
    let ok = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    if ok == 0 || returned as usize != std::mem::size_of::<TOKEN_ELEVATION>() {
        return Err(last_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}

fn token_user(token: &OwnedHandle) -> io::Result<UserSid> {
    let mut needed = 0u32;
    // SAFETY: a size query with a null buffer of length zero.
    let ok = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    // SAFETY: reads the calling thread's last-error value.
    if ok != 0
        || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
        || needed == 0
        || needed > 4096
    {
        return Err(refused(Refusal::InvalidSid));
    }
    // u64 storage keeps TOKEN_USER (pointer-aligned) correctly aligned.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: the buffer holds at least `needed` bytes and outlives the call.
    let ok = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points
    // into the same buffer, which is still alive.
    let sid = unsafe { (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid };
    // SAFETY: `sid` points into `buffer`; IsValidSid checks its structure.
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(refused(Refusal::InvalidSid));
    }
    // SAFETY: the SID is valid, so GetLengthSid returns its exact length.
    let length = unsafe { GetLengthSid(sid) } as usize;
    // SAFETY: `length` bytes at `sid` lie inside `buffer`.
    let bytes: Box<[u8]> = unsafe { std::slice::from_raw_parts(sid as *const u8, length) }.into();
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: valid SID in, LocalAlloc'd NUL-terminated string out.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 || text.is_null() {
        return Err(refused(Refusal::InvalidSid));
    }
    let text = LocalBox(text.cast());
    let pointer = text.0 as *const u16;
    let mut length = 0usize;
    // SAFETY: the OS string is NUL-terminated; stop at a sane bound.
    while length < 256 && unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: `length` u16 values before the NUL are initialised.
    let string = String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) })
        .map_err(|_| refused(Refusal::InvalidSid))?;
    if !policy::valid_sid_string(&string) {
        return Err(refused(Refusal::InvalidSid));
    }
    Ok(UserSid { bytes, string })
}

/// Refuse an elevated process, or one whose elevation cannot be read, and
/// return the current user's SID only after that check passes.
pub fn current_user() -> io::Result<UserSid> {
    let token = open_process_token();
    let elevated = token
        .as_ref()
        .map_err(|_| ())
        .and_then(|t| token_is_elevated(t).map_err(|_| ()));
    policy::elevation_policy(elevated).map_err(refused)?;
    let token = token.map_err(|_| refused(Refusal::TokenQueryFailed))?;
    token_user(&token)
}

/// Startup check: Err for an elevated process or a failed token query.
pub fn elevation_gate() -> io::Result<()> {
    current_user().map(drop)
}

/// A self-relative security descriptor parsed from SDDL. Freed on drop.
struct SecurityDescriptor(LocalBox);

impl SecurityDescriptor {
    fn private(user: &UserSid, kind: ObjectKind) -> io::Result<Self> {
        let sddl = policy::private_sddl(user.as_str(), kind).map_err(refused)?;
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: NUL-terminated SDDL in; LocalAlloc'd descriptor out.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || descriptor.is_null() {
            return Err(last_error());
        }
        Ok(Self(LocalBox(descriptor)))
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0 .0,
            bInheritHandle: 0,
        }
    }
}

fn create_file(
    path: &Path,
    access: u32,
    share: FILE_SHARE_MODE,
    attributes: Option<&SECURITY_ATTRIBUTES>,
    disposition: u32,
    flags: u32,
) -> io::Result<OwnedHandle> {
    let wide = wide(path)?;
    let attributes = attributes.map_or(std::ptr::null(), |a| a as *const SECURITY_ATTRIBUTES);
    // SAFETY: NUL-terminated path; the descriptor (if any) outlives the call.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            access,
            share,
            attributes,
            disposition,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(last_error());
    }
    // SAFETY: a fresh handle we own and close exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn object_facts(handle: &impl AsRawHandle) -> io::Result<(ObjectFacts, u64)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: valid handle and a correctly sized out structure.
    if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0 {
        return Err(last_error());
    }
    let facts = ObjectFacts {
        is_dir: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        is_reparse: info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        links: info.nNumberOfLinks,
    };
    Ok((
        facts,
        (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
    ))
}

fn security_facts(handle: &impl AsRawHandle, user: &UserSid) -> io::Result<SecurityFacts> {
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: valid handle; owner and DACL pointers point into `descriptor`,
    // which we own and free after use.
    let status = unsafe {
        GetSecurityInfo(
            handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _descriptor = LocalBox(descriptor);
    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: `descriptor` is the live descriptor returned above.
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
        return Err(last_error());
    }
    // SAFETY: both SIDs are valid for the duration of the call.
    let owner_is_user = !owner.is_null() && unsafe { EqualSid(owner, user.as_psid()) } != 0;
    let dacl_present = control & SE_DACL_PRESENT != 0 && !dacl.is_null();
    let mut aces = Vec::new();
    if dacl_present {
        let mut size = ACL_SIZE_INFORMATION::default();
        // SAFETY: `dacl` points into the live descriptor.
        let ok = unsafe {
            GetAclInformation(
                dacl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        for index in 0..size.AceCount.min(64) {
            let mut ace: *mut c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the ACL's entry count.
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
                return Err(last_error());
            }
            // SAFETY: every ACE starts with an ACE_HEADER.
            let header = unsafe { std::ptr::read_unaligned(ace as *const ACE_HEADER) };
            let ace_type = match header.AceType {
                ACCESS_ALLOWED_ACE_TYPE => AceType::Allow,
                ACCESS_DENIED_ACE_TYPE => AceType::Deny,
                other => AceType::Other(other),
            };
            let for_user = match ace_type {
                AceType::Allow | AceType::Deny => {
                    // Allowed and denied ACEs share the ACCESS_ALLOWED_ACE layout;
                    // the SID starts at `SidStart`.
                    let sid = unsafe {
                        // SAFETY: field address inside the ACE returned by GetAce.
                        std::ptr::addr_of!((*(ace as *const ACCESS_ALLOWED_ACE)).SidStart)
                    } as PSID;
                    // SAFETY: the SID lies inside the ACE; IsValidSid checks it.
                    unsafe { IsValidSid(sid) != 0 && EqualSid(sid, user.as_psid()) != 0 }
                }
                AceType::Other(_) => false,
            };
            aces.push(AceFacts {
                ace_type,
                flags: header.AceFlags,
                for_user,
            });
        }
        if size.AceCount > 64 {
            aces.push(AceFacts {
                ace_type: AceType::Other(0xff),
                flags: 0,
                for_user: false,
            });
        }
    }
    Ok(SecurityFacts {
        owner_is_user,
        dacl_present,
        dacl_protected: control & SE_DACL_PROTECTED != 0,
        aces,
    })
}

fn verify(handle: &impl AsRawHandle, kind: ObjectKind, user: &UserSid) -> io::Result<()> {
    let (facts, _) = object_facts(handle)?;
    policy::check_object(kind, &facts).map_err(refused)?;
    policy::check_security(kind, &security_facts(handle, user)?).map_err(refused)
}

/// How a verified object was opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Shared reads only.
    Read,
    /// Exclusive read/write that may also be published by rename.
    ReadWrite,
}

/// An open, verified private object. All I/O goes through this handle.
#[derive(Debug)]
pub struct VerifiedFile {
    file: File,
    kind: ObjectKind,
    access: Access,
}

impl VerifiedFile {
    pub fn kind(&self) -> ObjectKind {
        self.kind
    }

    /// Size, read from the handle.
    pub fn len(&self) -> io::Result<u64> {
        object_facts(&self.file).map(|(_, size)| size)
    }

    pub fn is_empty(&self) -> io::Result<bool> {
        self.len().map(|len| len == 0)
    }

    /// The whole file, refused when it is larger than `max` bytes.
    pub fn read_bounded(&mut self, max: u64) -> io::Result<Zeroizing<Vec<u8>>> {
        self.require_file()?;
        if self.len()? > max {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "private file is oversized",
            ));
        }
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Zeroizing::new(Vec::new());
        (&mut self.file).take(max + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > max {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "private file is oversized",
            ));
        }
        Ok(bytes)
    }

    /// Replace the contents through this handle, then flush them. Truncation
    /// happens only here, after the object was verified.
    pub fn replace_contents(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.require_writable()?;
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(bytes)?;
        self.file.sync_all()
    }

    /// Flush file data and metadata.
    pub fn sync(&self) -> io::Result<()> {
        self.require_writable()?;
        self.file.sync_all()
    }

    /// The underlying file, for OS locks (`try_lock`/`lock`).
    pub fn as_file(&self) -> &File {
        &self.file
    }

    fn require_file(&self) -> io::Result<()> {
        if self.kind == ObjectKind::File {
            Ok(())
        } else {
            Err(refused(Refusal::WrongKind))
        }
    }

    fn require_writable(&self) -> io::Result<()> {
        self.require_file()?;
        if self.access == Access::ReadWrite {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private file was opened read-only",
            ))
        }
    }
}

const FILE_FLAGS: u32 = FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT;
const DIR_FLAGS: u32 = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;

fn verified(
    handle: OwnedHandle,
    kind: ObjectKind,
    access: Access,
    user: &UserSid,
) -> io::Result<VerifiedFile> {
    verify(&handle, kind, user)?;
    Ok(VerifiedFile {
        file: File::from(handle),
        kind,
        access,
    })
}

/// Open an existing private object without truncating it, and verify it.
pub fn open_verified(path: &Path, kind: ObjectKind, access: Access) -> io::Result<VerifiedFile> {
    let user = current_user()?;
    open_verified_as(path, kind, access, &user)
}

fn open_verified_as(
    path: &Path,
    kind: ObjectKind,
    access: Access,
    user: &UserSid,
) -> io::Result<VerifiedFile> {
    let (rights, share) = match (kind, access) {
        (ObjectKind::Dir, _) => (GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE),
        (ObjectKind::File, Access::Read) => (GENERIC_READ, FILE_SHARE_READ),
        (ObjectKind::File, Access::ReadWrite) => (GENERIC_READ | GENERIC_WRITE | DELETE, 0),
    };
    let flags = if kind == ObjectKind::Dir {
        DIR_FLAGS
    } else {
        FILE_FLAGS
    };
    let handle = create_file(path, rights, share, None, OPEN_EXISTING, flags)?;
    let access = if kind == ObjectKind::Dir {
        Access::Read
    } else {
        access
    };
    verified(handle, kind, access, user)
}

/// Create `path` as a private folder. Missing ancestors are created plainly;
/// an existing leaf is opened and verified, never repaired.
pub fn create_dir_private(path: &Path) -> io::Result<VerifiedFile> {
    let user = current_user()?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let descriptor = SecurityDescriptor::private(&user, ObjectKind::Dir)?;
    let attributes = descriptor.attributes();
    let wide = wide(path)?;
    // SAFETY: NUL-terminated path; descriptor outlives the call.
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        // SAFETY: reads the calling thread's last-error value.
        let code = unsafe { GetLastError() };
        if code != ERROR_ALREADY_EXISTS {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
    }
    open_verified_as(path, ObjectKind::Dir, Access::Read, &user)
}

/// Create a new private file. Fails with `AlreadyExists` if anything is at
/// `path`; an existing object is never opened, truncated or replaced.
pub fn create_new_private(path: &Path) -> io::Result<VerifiedFile> {
    let user = current_user()?;
    let descriptor = SecurityDescriptor::private(&user, ObjectKind::File)?;
    let attributes = descriptor.attributes();
    let handle = create_file(
        path,
        GENERIC_READ | GENERIC_WRITE | DELETE,
        0,
        Some(&attributes),
        CREATE_NEW,
        FILE_FLAGS,
    )?;
    verified(handle, ObjectKind::File, Access::ReadWrite, &user)
}

/// Open or create a lock file. Other openers may read and write it but not
/// delete or rename it while it is open; mutual exclusion comes from OS locks
/// on [`VerifiedFile::as_file`], not from share modes.
pub fn open_lock(path: &Path) -> io::Result<VerifiedFile> {
    let user = current_user()?;
    let descriptor = SecurityDescriptor::private(&user, ObjectKind::File)?;
    let attributes = descriptor.attributes();
    let handle = create_file(
        path,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        Some(&attributes),
        OPEN_ALWAYS,
        FILE_FLAGS,
    )?;
    verified(handle, ObjectKind::File, Access::ReadWrite, &user)
}

/// Read `file` back through its own handle and compare it with `expected`,
/// flush it, rename it over `dest` by handle, then flush `dest`'s folder.
/// The renamed object is exactly the one that was written and checked.
pub fn publish(mut file: VerifiedFile, dest: &Path, expected: &[u8]) -> io::Result<()> {
    current_user()?;
    file.require_writable()?;
    let readback = file.read_bounded(expected.len() as u64)?;
    if readback.as_slice() != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "private file did not read back as written",
        ));
    }
    file.file.sync_all()?;
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "publish target has no folder")
        })?;
    let name = dest
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "publish target has no name"))?;
    // A full, verbatim path, as the rename-by-handle call requires.
    let target = std::fs::canonicalize(parent)?.join(name);
    rename_by_handle(&file.file, &target)?;
    drop(file);
    sync_dir(parent)
}

fn rename_by_handle(file: &File, target: &Path) -> io::Result<()> {
    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    if name.contains(&0) || name.len() > 32_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid publish target",
        ));
    }
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let size = offset + (name.len() + 1) * std::mem::size_of::<u16>();
    let size = size.max(std::mem::size_of::<FILE_RENAME_INFO>());
    let mut buffer = vec![0u64; size.div_ceil(8)];
    let info = buffer.as_mut_ptr() as *mut FILE_RENAME_INFO;
    // SAFETY: `buffer` is zeroed, 8-byte aligned and large enough for the
    // header plus the name and its terminating NUL.
    unsafe {
        (*info).Anonymous.Flags =
            FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = (name.len() * std::mem::size_of::<u16>()) as u32;
        let dest = std::ptr::addr_of_mut!((*info).FileName).cast::<u16>();
        std::ptr::copy_nonoverlapping(name.as_ptr(), dest, name.len());
    }
    // SAFETY: valid handle opened with DELETE access; buffer described above.
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            info as *const c_void,
            size as u32,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// Flush a folder so new, renamed or deleted entries are durable. The error
/// always propagates; this never reports success it did not get.
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    current_user()?;
    let handle = create_file(
        dir,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        DIR_FLAGS,
    )?;
    let (facts, _) = object_facts(&handle)?;
    policy::check_object(ObjectKind::Dir, &facts).map_err(refused)?;
    // SAFETY: valid folder handle opened for writing.
    if unsafe { FlushFileBuffers(handle.as_raw_handle()) } == 0 {
        return Err(last_error());
    }
    Ok(())
}

/// Test support: create an object with an arbitrary descriptor, to plant
/// adversarial fixtures. Not used by production code.
#[cfg(test)]
pub(crate) fn create_with_sddl(path: &Path, sddl: &str, dir: bool) -> io::Result<()> {
    let wide_sddl: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: as in SecurityDescriptor::private.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    let descriptor = SecurityDescriptor(LocalBox(descriptor));
    let attributes = descriptor.attributes();
    if dir {
        let wide = wide(path)?;
        // SAFETY: NUL-terminated path; descriptor outlives the call.
        if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
            return Err(last_error());
        }
        return Ok(());
    }
    let handle = create_file(
        path,
        GENERIC_READ | GENERIC_WRITE,
        0,
        Some(&attributes),
        CREATE_NEW,
        FILE_FLAGS,
    )?;
    let mut file = File::from(handle);
    file.write_all(b"fixture")?;
    file.sync_all()
}

#[cfg(test)]
#[path = "win_private_tests.rs"]
mod tests;
