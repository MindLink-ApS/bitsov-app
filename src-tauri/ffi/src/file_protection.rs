//! iOS data protection for one file the app hands to the system.
use std::os::fd::AsRawFd;

/// `F_SETPROTECTIONCLASS` from Apple's `<sys/fcntl.h>` (not in the libc crate).
const F_SETPROTECTIONCLASS: libc::c_int = 64;
/// Class C, "complete until first user authentication".
const PROTECTION_CLASS_C: libc::c_int = 3;

/// Makes `file` readable from the first unlock after boot onwards, also while
/// the phone is locked (class C).
pub fn until_first_unlock(file: &std::fs::File) -> std::io::Result<()> {
    // SAFETY: a valid open descriptor owned by `file` for the whole call and
    // two integer arguments; nothing is retained.
    if unsafe { libc::fcntl(file.as_raw_fd(), F_SETPROTECTIONCLASS, PROTECTION_CLASS_C) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
