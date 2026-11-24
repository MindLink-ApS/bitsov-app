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
/// half-written sound is never left under the real name.
pub fn install(sounds_dir: &Path) -> std::io::Result<bool> {
    let target = sounds_dir.join(FILE_NAME);
    if std::fs::read(&target).is_ok_and(|current| current == BYTES) {
        return Ok(false);
    }
    std::fs::create_dir_all(sounds_dir)?;
    let temp = sounds_dir.join(format!(".{FILE_NAME}.tmp"));
    std::fs::write(&temp, BYTES)?;
    std::fs::rename(&temp, &target)?;
    Ok(true)
}

/// iOS startup: `$HOME/Library/Sounds`. A failure only costs the sound; the
/// alert itself still shows, so it is logged and never stops the app.
#[cfg(target_os = "ios")]
pub fn install_ios() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::PathBuf::from(home).join("Library").join("Sounds");
    if let Err(error) = install(&dir) {
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
    fn a_changed_or_truncated_file_is_replaced() {
        let dir = temp_dir("changed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), &BYTES[..10]).unwrap();
        assert!(install(&dir).unwrap());
        assert_eq!(std::fs::read(dir.join(FILE_NAME)).unwrap(), BYTES);
    }
}
