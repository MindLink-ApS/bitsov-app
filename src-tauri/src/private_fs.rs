//! Windows private storage for the app's owner-only stores.
//!
//! A thin facade over `bitsov_ffi::win_private`: every read, write and
//! publish goes through a verified handle, never a path check followed by a
//! separate open. Objects in the wrong state are refused and left unchanged.
//! Unix stores keep their existing code paths and do not use this module.

use std::io;
use std::path::Path;

use bitsov_ffi::private_policy::ObjectKind;
use bitsov_ffi::win_private::{self, Access, VerifiedFile};
use zeroize::Zeroizing;

/// Create `dir` as a private folder, or verify an existing one.
pub(crate) fn ensure_dir(dir: &Path) -> io::Result<()> {
    win_private::create_dir_private(dir).map(drop)
}

/// Read a whole private file through a verified handle, at most `max` bytes.
pub(crate) fn read(path: &Path, max: u64) -> io::Result<Zeroizing<Vec<u8>>> {
    win_private::open_verified(path, ObjectKind::File, Access::Read)?.read_bounded(max)
}

/// Like [`read`], but `None` when nothing at all is at `path`.
pub(crate) fn read_optional(path: &Path, max: u64) -> io::Result<Option<Zeroizing<Vec<u8>>>> {
    if crate::pairing::key::nothing_at(path) {
        return Ok(None);
    }
    read(path, max).map(Some)
}

/// Verify an existing private file without reading it (markers, or a file
/// about to be replaced).
pub(crate) fn verify_file(path: &Path) -> io::Result<()> {
    win_private::open_verified(path, ObjectKind::File, Access::Read).map(drop)
}

/// Write `bytes` to a new scratch file `scratch`, run `check` on the bytes read
/// back through the same handle, then publish it as `dest` by handle and flush
/// the folder. A leftover `scratch` is refused (`AlreadyExists`), never reused
/// or deleted; a failed check deletes only the scratch object this call made.
pub(crate) fn write_checked<E>(
    scratch: &Path,
    dest: &Path,
    bytes: &[u8],
    replace: bool,
    io_error: impl Fn(io::Error) -> E,
    check: impl FnOnce(&[u8]) -> Result<(), E>,
) -> Result<(), E> {
    let mut file = win_private::create_new_private(scratch).map_err(&io_error)?;
    if let Err(error) = written(&mut file, bytes) {
        let _ = file.discard();
        return Err(io_error(error));
    }
    let readback = match file.read_bounded(bytes.len() as u64) {
        Ok(readback) => readback,
        Err(error) => {
            let _ = file.discard();
            return Err(io_error(error));
        }
    };
    if let Err(error) = check(&readback) {
        let _ = file.discard();
        return Err(error);
    }
    win_private::publish(file, dest, bytes, replace).map_err(io_error)
}

/// Replace `dest`: an existing object there must first verify (kind, reparse
/// flag, link count, owner, access list) and is otherwise refused and left
/// unchanged; then [`write_checked`] with replacement.
pub(crate) fn write_replacing_verified<E>(
    scratch: &Path,
    dest: &Path,
    bytes: &[u8],
    io_error: impl Fn(io::Error) -> E,
    check: impl FnOnce(&[u8]) -> Result<(), E>,
) -> Result<(), E> {
    if !crate::pairing::key::nothing_at(dest) {
        verify_file(dest).map_err(&io_error)?;
    }
    write_checked(scratch, dest, bytes, true, io_error, check)
}

fn written(file: &mut VerifiedFile, bytes: &[u8]) -> io::Result<()> {
    file.replace_contents(bytes)
}

/// Verify an existing private folder without changing it.
pub(crate) fn verify_dir(path: &Path) -> io::Result<()> {
    win_private::open_verified(path, ObjectKind::Dir, Access::Read).map(drop)
}

/// Flush a private folder's entries. Every error is returned.
pub(crate) fn sync_dir(dir: &Path) -> io::Result<()> {
    win_private::sync_dir(dir)
}

/// A new private scratch file (`CREATE_NEW`): anything already at `path`
/// fails with `AlreadyExists` and is left as it is.
pub(crate) fn create_new(path: &Path) -> io::Result<VerifiedFile> {
    win_private::create_new_private(path)
}

/// Rename a verified scratch file over `dest` by handle, then flush the
/// folder. An error does not say whether the rename happened.
pub(crate) fn publish_replacing(file: VerifiedFile, dest: &Path, bytes: &[u8]) -> io::Result<()> {
    win_private::publish(file, dest, bytes, true)
}

/// Open an existing private file for writing or deletion by handle.
pub(crate) fn open_writable(path: &Path) -> io::Result<VerifiedFile> {
    win_private::open_verified(path, ObjectKind::File, Access::ReadWrite)
}

/// Open or create a private lock file; exclusion comes from OS locks.
pub(crate) fn open_lock(path: &Path) -> io::Result<VerifiedFile> {
    win_private::open_lock(path)
}

/// Create an empty private marker file and make it durable. An existing
/// object at `path` is verified instead and left as it is.
pub(crate) fn ensure_marker(path: &Path) -> io::Result<()> {
    match win_private::create_new_private(path) {
        Ok(file) => {
            file.sync()?;
            drop(file);
            let parent = path
                .parent()
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            win_private::sync_dir(parent)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => verify_file(path),
        Err(error) => Err(error),
    }
}

/// Adversarial fixtures for the Windows store tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    /// Elevated runs are refused before any storage; those tests return early.
    pub(crate) fn elevated() -> bool {
        bitsov_ffi::win_private::elevation_gate().is_err()
    }

    /// A fresh ordinary folder under the system temp folder.
    pub(crate) fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("bitsov-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A folder owned by a system account, never by the test user.
    pub(crate) fn foreign_owned_dir() -> PathBuf {
        PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"))
    }

    fn run(command: &mut Command) {
        let status = command.stdout(Stdio::null()).status().unwrap();
        assert!(status.success(), "{command:?}");
    }

    /// Add an explicit read entry for Everyone, widening the access list.
    pub(crate) fn grant_everyone_read(path: &Path) {
        run(Command::new("icacls")
            .arg(path)
            .args(["/grant", "*S-1-1-0:(R)"]));
    }

    /// Replace nothing; create a junction at `link` pointing at `target`.
    pub(crate) fn junction(link: &Path, target: &Path) {
        run(Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target));
    }
}
