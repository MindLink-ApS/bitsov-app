//! Where the bundled `bitsov-mcp` shim is, for an AI app's settings to point to.
//!
//! The shim ships with the app as a second `externalBin`: Tauri puts it next
//! to the app's own executable (`BitSov.app/Contents/MacOS/bitsov-mcp` on
//! macOS, beside `BitSov.exe` on Windows). [`shim_path`] finds it from the
//! running executable. It refuses, with a plain one-line reason, when:
//! - the app runs under macOS App Translocation (opened straight from a
//!   download, so it lives at a random path that changes every launch);
//! - the shim is not there (a build without it), or is not a plain,
//!   executable file (a link, a folder, or damaged).
//!
//! A settings file written earlier records the path it used. When the app has
//! since been moved or renamed, [`compare_recorded`] says so, so the window
//! can offer to update the AI app's settings.
//!
//! **Not wired**: nothing writes settings yet. Compiles only where its parent
//! does (`cfg(test)` or the off-by-default `mcp-grant` feature).

use std::path::{Component, Path, PathBuf};

/// The shim's file name beside the app's executable.
#[cfg(windows)]
pub const SHIM_FILE: &str = "bitsov-mcp.exe";
#[cfg(not(windows))]
pub const SHIM_FILE: &str = "bitsov-mcp";

/// The folder macOS runs a translocated app from.
const TRANSLOCATION: &str = "AppTranslocation";

/// Why the shim's path cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShimRefusal {
    /// The app could not tell where its own executable is.
    NoExecutable,
    /// macOS App Translocation: the app runs from a random temporary path.
    Translocated,
    /// No shim beside the executable: this build does not include it.
    NotBundled,
    /// Something other than a plain executable file is at the shim's path.
    Damaged,
}

impl ShimRefusal {
    /// A short, stable code for the window.
    pub fn code(self) -> &'static str {
        match self {
            ShimRefusal::NoExecutable => "app_location_unknown",
            ShimRefusal::Translocated => "app_translocated",
            ShimRefusal::NotBundled => "shim_not_bundled",
            ShimRefusal::Damaged => "shim_damaged",
        }
    }

    /// What the owner can do, in one plain line.
    pub fn message(self) -> &'static str {
        match self {
            ShimRefusal::NoExecutable => "BitSov could not find its own location. Quit BitSov, open it again, and try again.",
            ShimRefusal::Translocated => "Move BitSov to your Applications folder, open it from there, and try again.",
            ShimRefusal::NotBundled => "This copy of BitSov cannot connect AI apps. Install the full BitSov app.",
            ShimRefusal::Damaged => "Part of BitSov is damaged. Install BitSov again.",
        }
    }
}

/// The bundled shim's absolute path, from the running app's executable.
pub fn shim_path() -> Result<PathBuf, ShimRefusal> {
    let exe = std::env::current_exe().map_err(|_| ShimRefusal::NoExecutable)?;
    shim_beside(&exe)
}

/// Whether `path` is under a macOS App Translocation folder.
pub fn is_translocated(path: &Path) -> bool {
    path.components().any(|part| matches!(part, Component::Normal(name) if name == TRANSLOCATION))
}

/// The shim beside the executable `exe`, checked: an absolute path, not
/// translocated, and a plain file (not a link or folder) that can run.
pub fn shim_beside(exe: &Path) -> Result<PathBuf, ShimRefusal> {
    if !exe.is_absolute() {
        return Err(ShimRefusal::NoExecutable);
    }
    if is_translocated(exe) {
        return Err(ShimRefusal::Translocated);
    }
    let shim = exe.parent().ok_or(ShimRefusal::NoExecutable)?.join(SHIM_FILE);
    let meta = match std::fs::symlink_metadata(&shim) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(ShimRefusal::NotBundled),
        Err(_) => return Err(ShimRefusal::Damaged),
    };
    if !meta.file_type().is_file() {
        return Err(ShimRefusal::Damaged);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 || meta.len() == 0 {
            return Err(ShimRefusal::Damaged);
        }
    }
    #[cfg(not(unix))]
    if meta.len() == 0 {
        return Err(ShimRefusal::Damaged);
    }
    Ok(shim)
}

/// A shim path an AI app's settings were written with, against today's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    /// The same shim: nothing to do.
    Current,
    /// The app was moved or renamed since: the settings point to `from`, the
    /// shim is now at `to`. The window offers to update the settings.
    Moved { from: PathBuf, to: PathBuf },
}

impl Recorded {
    /// What the owner sees for a moved app, in one plain line.
    pub const MOVED_MESSAGE: &'static str =
        "BitSov has moved since you added an AI app. Update the AI app's settings to keep it connected.";
}

/// Compare the recorded shim path with the current one. The same path, or
/// two spellings of the same file (case, `.` and `..`), is current.
pub fn compare_recorded(recorded: &Path, current: &Path) -> Recorded {
    let same = match (std::fs::canonicalize(recorded), std::fs::canonicalize(current)) {
        (Ok(a), Ok(b)) => a == b,
        _ => normal(recorded) == normal(current),
    };
    if same {
        Recorded::Current
    } else {
        Recorded::Moved { from: recorded.to_path_buf(), to: current.to_path_buf() }
    }
}

/// `path` without `.` parts, and with `..` taken back one part.
fn normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake app folder: the executable, and optionally the shim beside it.
    fn app(shim: Option<&[u8]>) -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let macos = temp.path().join("BitSov.app").join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let exe = macos.join("bitsov-app");
        std::fs::write(&exe, b"app").unwrap();
        if let Some(bytes) = shim {
            let path = macos.join(SHIM_FILE);
            std::fs::write(&path, bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        (temp, exe)
    }

    #[test]
    fn the_shim_beside_the_executable_is_found() {
        let (_temp, exe) = app(Some(b"shim"));
        let shim = shim_beside(&exe).unwrap();
        assert_eq!(shim, exe.parent().unwrap().join(SHIM_FILE));
        assert!(shim.is_absolute());
    }

    #[test]
    fn no_shim_means_not_bundled() {
        let (_temp, exe) = app(None);
        assert_eq!(shim_beside(&exe), Err(ShimRefusal::NotBundled));
    }

    #[test]
    fn a_translocated_app_is_refused_before_anything_is_read() {
        let (temp, _) = app(Some(b"shim"));
        let translocated = temp.path().join("AppTranslocation").join("0A1B2C3D").join("d").join("BitSov.app/Contents/MacOS/bitsov-app");
        assert!(is_translocated(&translocated));
        assert_eq!(shim_beside(&translocated), Err(ShimRefusal::Translocated));
        // The word inside a name is not the folder.
        assert!(!is_translocated(Path::new("/Applications/NotAppTranslocationReally/BitSov.app")));
        assert!(!is_translocated(Path::new("/Applications/BitSov.app/Contents/MacOS/bitsov-app")));
    }

    #[test]
    fn a_relative_executable_path_is_refused() {
        assert_eq!(shim_beside(Path::new("BitSov.app/Contents/MacOS/bitsov-app")), Err(ShimRefusal::NoExecutable));
    }

    #[test]
    fn a_folder_or_an_empty_file_at_the_shim_path_is_damaged() {
        let (_temp, exe) = app(None);
        std::fs::create_dir(exe.parent().unwrap().join(SHIM_FILE)).unwrap();
        assert_eq!(shim_beside(&exe), Err(ShimRefusal::Damaged));
        let (_temp, exe) = app(Some(b""));
        assert_eq!(shim_beside(&exe), Err(ShimRefusal::Damaged));
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_or_non_executable_shim_is_damaged() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, exe) = app(None);
        let elsewhere = temp.path().join("elsewhere");
        std::fs::write(&elsewhere, b"shim").unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, exe.parent().unwrap().join(SHIM_FILE)).unwrap();
        assert_eq!(shim_beside(&exe), Err(ShimRefusal::Damaged), "a link is never followed");
        let (_temp, exe) = app(Some(b"shim"));
        let shim = exe.parent().unwrap().join(SHIM_FILE);
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(shim_beside(&exe), Err(ShimRefusal::Damaged));
    }

    #[test]
    fn the_test_binary_has_no_bundled_shim() {
        // Test executables run from the build folder, where no shim is placed.
        assert!(matches!(shim_path(), Err(ShimRefusal::NotBundled) | Err(ShimRefusal::Damaged)));
    }

    #[test]
    fn a_moved_or_renamed_app_is_noticed_and_the_same_path_is_current() {
        let (temp, exe) = app(Some(b"shim"));
        let shim = shim_beside(&exe).unwrap();
        assert_eq!(compare_recorded(&shim, &shim), Recorded::Current);
        // Another spelling of the same file.
        let dotted = exe.parent().unwrap().join(".").join("..").join("MacOS").join(SHIM_FILE);
        assert_eq!(compare_recorded(&dotted, &shim), Recorded::Current);
        // Renamed: BitSov.app → BitSov 2.app.
        let renamed = temp.path().join("BitSov 2.app");
        std::fs::rename(temp.path().join("BitSov.app"), &renamed).unwrap();
        let now = shim_beside(&renamed.join("Contents/MacOS/bitsov-app")).unwrap();
        assert_eq!(compare_recorded(&shim, &now), Recorded::Moved { from: shim.clone(), to: now.clone() });
        // Moved to another folder.
        let moved = temp.path().join("Apps");
        std::fs::create_dir(&moved).unwrap();
        std::fs::rename(&renamed, moved.join("BitSov.app")).unwrap();
        let there = shim_beside(&moved.join("BitSov.app/Contents/MacOS/bitsov-app")).unwrap();
        assert!(matches!(compare_recorded(&shim, &there), Recorded::Moved { .. }));
        // Neither exists: compared as written.
        assert_eq!(compare_recorded(Path::new("/gone/a/../b/bitsov-mcp"), Path::new("/gone/b/bitsov-mcp")), Recorded::Current);
        assert!(matches!(compare_recorded(Path::new("/gone/a/bitsov-mcp"), Path::new("/gone/b/bitsov-mcp")), Recorded::Moved { .. }));
    }

    #[test]
    fn every_refusal_has_its_own_code_and_a_one_line_message() {
        let all = [ShimRefusal::NoExecutable, ShimRefusal::Translocated, ShimRefusal::NotBundled, ShimRefusal::Damaged];
        let mut codes: Vec<_> = all.iter().map(|r| r.code()).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), all.len());
        for line in all.iter().map(|r| r.message()).chain([Recorded::MOVED_MESSAGE]) {
            assert!(!line.contains('\n') && line.len() < 120 && line.ends_with('.'), "{line}");
        }
    }
}
