//! The phone-alert sound. iOS plays a notification's named sound from the
//! app bundle or from the app's own `Library/Sounds`; the notification plugin
//! can only name a sound, so the app writes its one short sound there at
//! startup. Android resolves the same name against its own resources, finds
//! none, and keeps the system default sound.

#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::path::Path;

/// The name phone alerts ask for (`messageNotifications.tsx` `PHONE_SOUND`).
pub const FILE_NAME: &str = "bitsov-alert.caf";
/// A two-tone chime, 0.47 s, 16-bit mono CAF, generated for this app.
pub const BYTES: &[u8] = include_bytes!("../resources/sounds/bitsov-alert.caf");

/// Writes the sound into `sounds_dir` when it is missing or different.
/// True when it wrote. The write is atomic (a temp file, then a rename), so a
/// half-written sound is never left under the real name. Before the rename
/// the file gets the data-protection class from `protect` (iOS: class C via
/// `bitsov_ffi::file_protection`, readable from the first unlock after boot,
/// so a locked phone can still play it).
pub fn install_with(sounds_dir: &Path, protect: impl Fn(&std::fs::File) -> std::io::Result<()>) -> std::io::Result<bool> {
    use std::io::Write;
    let target = sounds_dir.join(FILE_NAME);
    if std::fs::read(&target).is_ok_and(|current| current == BYTES) {
        // Already in place, maybe from before the protection class existed:
        // apply it to the existing file too, without rewriting it.
        if let Err(error) = std::fs::OpenOptions::new().read(true).write(true).open(&target).and_then(|file| protect(&file)) {
            eprintln!("alert sound protection class not set: {error}");
        }
        return Ok(false);
    }
    std::fs::create_dir_all(sounds_dir)?;
    let temp = sounds_dir.join(format!(".{FILE_NAME}.tmp"));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(BYTES)?;
    // A sound without the class still plays once the phone is unlocked; never fail the write for it.
    if let Err(error) = protect(&file) {
        eprintln!("alert sound protection class not set: {error}");
    }
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, &target)?;
    Ok(true)
}

/// [`install_with`] with no protection change (every platform but iOS, and tests).
pub fn install(sounds_dir: &Path) -> std::io::Result<bool> {
    install_with(sounds_dir, |_| Ok(()))
}

/// iOS: `$HOME/Library/Sounds`, at startup and again each time the app comes
/// to the foreground. A launch before the first unlock after boot cannot
/// write (the data is still locked), so the later call puts the sound in
/// place. It is a cheap compare once the right file is there. A failure only
/// costs the sound; the alert itself still shows, so it is logged and never
/// stops the app.
#[cfg(target_os = "ios")]
pub fn install_ios() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::PathBuf::from(home).join("Library").join("Sounds");
    if let Err(error) = install_with(&dir, bitsov_ffi::file_protection::until_first_unlock) {
        eprintln!("alert sound not installed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bitsov-alert-sound-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_embedded_sound_is_a_short_caf_file() {
        assert_eq!(&BYTES[..4], b"caff", "a Core Audio Format file");
        assert!(BYTES.len() < 100_000, "short enough for a notification sound");
    }

    #[test]
    fn it_writes_once_and_leaves_the_right_file_alone() {
        let dir = temp_dir("once").join("Library").join("Sounds");
        assert!(install(&dir).unwrap(), "first run writes, creating the folder");
        assert_eq!(std::fs::read(dir.join(FILE_NAME)).unwrap(), BYTES);
        assert!(!install(&dir).unwrap(), "the same file is left alone");
        assert!(!dir.join(format!(".{FILE_NAME}.tmp")).exists(), "no temp file is left behind");
    }

    #[test]
    fn the_protection_class_is_applied_to_new_and_existing_files_and_its_failure_never_blocks_the_sound() {
        use std::cell::Cell;
        let dir = temp_dir("protect");
        let called = Cell::new(0);
        assert!(install_with(&dir, |file| {
            called.set(called.get() + 1);
            // Applied to the temp file, before it takes the real name.
            assert_eq!(file.metadata()?.len(), BYTES.len() as u64);
            assert!(!dir.join(FILE_NAME).exists(), "still under the temp name");
            Ok(())
        }).unwrap());
        assert_eq!(called.get(), 1);
        // A failing protection call still installs the sound.
        let other = temp_dir("protect-fails");
        assert!(install_with(&other, |_| Err(std::io::Error::other("no class"))).unwrap());
        assert_eq!(std::fs::read(other.join(FILE_NAME)).unwrap(), BYTES);
        // An installed, matching file (also one from before this class existed) is not
        // rewritten, but gets the class applied, and a failure there is not an error.
        let applied = Cell::new(0);
        let before = std::fs::metadata(dir.join(FILE_NAME)).unwrap().modified().unwrap();
        assert!(!install_with(&dir, |file| {
            applied.set(applied.get() + 1);
            assert_eq!(file.metadata()?.len(), BYTES.len() as u64);
            Ok(())
        }).unwrap());
        assert_eq!(applied.get(), 1);
        assert_eq!(std::fs::metadata(dir.join(FILE_NAME)).unwrap().modified().unwrap(), before, "not rewritten");
        assert!(!install_with(&dir, |_| Err(std::io::Error::other("no class"))).unwrap());
    }

    #[test]
    fn a_changed_or_truncated_file_is_replaced() {
        let dir = temp_dir("changed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), &BYTES[..10]).unwrap();
        assert!(install(&dir).unwrap());
        assert_eq!(std::fs::read(dir.join(FILE_NAME)).unwrap(), BYTES);
    }
}
