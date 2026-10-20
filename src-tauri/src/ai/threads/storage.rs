//! Versioned thread envelopes and resumable migration from login-Keychain AES keys.

use super::{
    check, decrypt, encrypt, Assistant, Rule, Sealer, Thread, MAX_FILE_BYTES, MAX_SETTINGS_BYTES,
};
use std::{io::Read, path::Path, sync::OnceLock};
use zeroize::Zeroizing;

const MAGIC: &[u8] = b"bitsov-ai-se-v2\0";
const MAX_WRAPPED_KEY: usize = 16384;
const ASSISTANTS: [Assistant; 3] = [Assistant::Node, Assistant::Wallet, Assistant::Inbox];

// Called under the host thread lock, which also covers the subsequent operation.
// None = not attempted this launch; false = deferred until the next launch;
// true = the sweep finished and retired all legacy keys. Cache failures too so
// a corrupt/unknown file cannot trigger enclave and Keychain work on every read.
fn prepare_migration(complete: &OnceLock<bool>, sweep: impl FnOnce() -> Result<bool, String>) {
    complete.get_or_init(|| match sweep() {
        Ok(retired) => retired,
        Err(error) => {
            eprintln!("[ai-threads] Secure Enclave migration incomplete; retaining remaining legacy keys: {error}");
            false
        }
    });
}

trait LegacySealer: Sealer {
    fn delete_key(&self, purpose: &str) -> Result<(), String>;
}

struct ThreadSealer<'a> {
    hardware: &'a dyn Sealer,
    legacy: &'a dyn LegacySealer,
}

impl ThreadSealer<'_> {
    fn seal_device_bound(&self, purpose: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
        // The pairing bridge accepts 4 KB, so wrap a fresh data key, not the
        // transcript. Neither this key nor the enclave private key goes in Keychain.
        let mut key = Zeroizing::new(vec![0; 32]);
        getrandom::getrandom(&mut key).map_err(|_| "Could not create the thread key.")?;
        let key_purpose = format!("ai-storage-key-v2:{purpose}");
        let wrapped = self.hardware.seal(&key_purpose, &key)?;
        if wrapped.is_empty()
            || wrapped.len() > MAX_WRAPPED_KEY
            || self.hardware.open(&key_purpose, &wrapped)?.as_slice() != key.as_slice()
        {
            return Err("Could not verify the device-bound thread key.".into());
        }
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&(wrapped.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&wrapped);
        bytes.extend_from_slice(&encrypt(&key, purpose, plain)?);
        Ok(bytes)
    }

    // Caller holds the host thread lock for this entire sweep AND the subsequent
    // operation. No key is retired until every existing file has been read back.
    // Each replacement is independent; after a crash the directory can contain
    // either format. Uncommitted temporary files are ciphertext and are ignored.
    // True means all legacy keys were retired; no files means no retirement.
    fn migrate(&self, dir: &Path) -> Result<bool, String> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => {
                return Err("Could not inspect assistant storage; retaining legacy keys.".into())
            }
        };
        let files: Vec<_> = ASSISTANTS
            .into_iter()
            .flat_map(|assistant| {
                [false, true].map(move |settings| {
                    let id = assistant.id();
                    if settings {
                        (
                            format!("{id}-watches.sealed"),
                            format!("ai-watch-settings-v1:{id}"),
                            assistant,
                            true,
                        )
                    } else {
                        (
                            format!("{id}.sealed"),
                            format!("ai-thread-v1:{id}"),
                            assistant,
                            false,
                        )
                    }
                })
            })
            .collect();
        // Unknown ciphertext may need a legacy key. Do not assume it is disposable.
        let mut failure = None;
        for entry in entries {
            let entry =
                entry.map_err(|_| "Could not inspect assistant storage; retaining legacy keys.")?;
            let name = entry.file_name();
            if entry.path().extension().is_some_and(|ext| ext == "sealed")
                && !files.iter().any(|(file, _, _, _)| name == file.as_str())
            {
                failure = Some("Unknown assistant ciphertext; retaining legacy keys.".to_string());
            }
        }
        let mut found = false;
        for (file, purpose, assistant, settings) in &files {
            let path = dir.join(file);
            let result = (|| {
                let bytes = match read_bounded(
                    &path,
                    if *settings {
                        MAX_SETTINGS_BYTES
                    } else {
                        MAX_FILE_BYTES
                    },
                )? {
                    Some(bytes) => bytes,
                    None => return Ok(()),
                };
                found = true;
                let plain = self.open(purpose, &bytes)?;
                validate(&plain, *assistant, *settings)?;
                if !bytes.starts_with(MAGIC) {
                    let sealed = self.seal_device_bound(purpose, &plain)?;
                    super::write_sealed(dir, &path, &sealed, purpose, &plain, self)?;
                    sync_dir(dir)?;
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                eprintln!("[ai-threads] Migration of {file} deferred; keeping ciphertext and legacy keys: {error}");
                failure = Some(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        if found {
            // Also covers a previous crash after rename but before directory sync.
            sync_dir(dir)?;
            for (_, purpose, _, _) in &files {
                self.legacy.delete_key(purpose)?;
            }
        }
        Ok(found)
    }
}

fn sync_dir(dir: &Path) -> Result<(), String> {
    std::fs::File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Could not sync assistant storage; retaining legacy keys.".into())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read the assistant thread.".into()),
    };
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the assistant thread.")?;
    if bytes.len() as u64 > limit {
        return Err("The assistant thread is too large.".into());
    }
    Ok(Some(bytes))
}

fn validate(plain: &[u8], assistant: Assistant, settings: bool) -> Result<(), String> {
    if settings {
        let disabled: Vec<Rule> =
            serde_json::from_slice(plain).map_err(|_| "Invalid watch settings.")?;
        if disabled.len() > 7 || disabled.iter().any(|r| r.assistant() != assistant) {
            return Err("Invalid watch settings.".into());
        }
        Ok(())
    } else {
        let thread: Thread =
            serde_json::from_slice(plain).map_err(|_| "The assistant thread is corrupt.")?;
        check(&thread)
    }
}

impl Sealer for ThreadSealer<'_> {
    fn seal(&self, purpose: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
        match self.seal_device_bound(purpose, plain) {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                eprintln!("[ai-threads] Secure Enclave sealing unavailable; using legacy Keychain AES storage: {error}");
                self.legacy.seal(purpose, plain)
            }
        }
    }
    fn open(&self, purpose: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        let Some(body) = bytes.strip_prefix(MAGIC) else {
            return self.legacy.open(purpose, bytes);
        };
        let length = body
            .get(..4)
            .ok_or("Invalid device-bound thread envelope.")?;
        let length = u32::from_le_bytes(length.try_into().unwrap()) as usize;
        if length == 0 || length > MAX_WRAPPED_KEY {
            return Err("Invalid device-bound thread envelope.".into());
        }
        let wrapped = body
            .get(4..4 + length)
            .ok_or("Invalid device-bound thread envelope.")?;
        let key = self
            .hardware
            .open(&format!("ai-storage-key-v2:{purpose}"), wrapped)?;
        // A recognized envelope is authoritative, even when the enclave is
        // temporarily locked/unavailable. Never read an older legacy copy instead.
        decrypt(&key, purpose, &body[4 + length..])
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
mod macos {
    use super::*;
    use crate::ai::threads::LegacyMacSealer;

    struct Enclave;
    impl Sealer for Enclave {
        fn seal(&self, purpose: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
            bitsov_ffi::pairing_sealer::seal(purpose, plain)
        }
        fn open(&self, purpose: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            // The bridge's invalid-blob advice is pairing-specific. Never tell an
            // assistant user to clear their pairing identity to fix a transcript.
            bitsov_ffi::pairing_sealer::open(purpose, bytes).map_err(|_| {
                "Could not open device-bound assistant storage; retry on the original Mac.".into()
            })
        }
    }
    impl LegacySealer for LegacyMacSealer {
        fn delete_key(&self, purpose: &str) -> Result<(), String> {
            let status = bitsov_ffi::home_keychain::delete_items(&Self::service()?, purpose)
                .map_err(|_| "Invalid thread key name.")?;
            if status != 0 && status != -25300 {
                return Err(format!(
                    "Keychain could not retire the legacy thread key ({status})."
                ));
            }
            Ok(())
        }
    }

    /// Device-only, non-synced Secure Enclave wrapping via the pairing bridge.
    /// Prompt-free, not biometry-gated. Legacy Keychain AES is a logged fallback.
    pub struct MacSealer;
    static MIGRATION_COMPLETE: OnceLock<bool> = OnceLock::new();
    fn sealer() -> ThreadSealer<'static> {
        ThreadSealer {
            hardware: &Enclave,
            legacy: &LegacyMacSealer,
        }
    }
    impl MacSealer {
        /// Best effort, once per process, under the host thread lock. Never abort
        /// setup or prevent access to a healthy thread because another cannot migrate.
        pub fn prepare(&self, dir: &Path) {
            prepare_migration(&MIGRATION_COMPLETE, || sealer().migrate(dir));
        }
    }
    impl Sealer for MacSealer {
        fn seal(&self, purpose: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
            sealer().seal(purpose, plain)
        }
        fn open(&self, purpose: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            sealer().open(purpose, bytes)
        }
    }
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
pub use macos::MacSealer;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::threads::{apply, watch_settings, Request, Turn};
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    #[derive(Default)]
    struct Keys(Mutex<HashMap<String, Vec<u8>>>);
    impl Sealer for Keys {
        fn seal(&self, purpose: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
            let mut keys = self.0.lock().unwrap();
            let key = keys.entry(purpose.into()).or_insert(vec![42; 32]);
            encrypt(key, purpose, plain)
        }
        fn open(&self, purpose: &str, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            let keys = self.0.lock().unwrap();
            decrypt(
                keys.get(purpose).ok_or("missing legacy key")?,
                purpose,
                bytes,
            )
        }
    }
    impl LegacySealer for Keys {
        fn delete_key(&self, purpose: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(purpose);
            Ok(())
        }
    }
    struct Hardware;
    impl Sealer for Hardware {
        fn seal(&self, p: &str, b: &[u8]) -> Result<Vec<u8>, String> {
            encrypt(&[73; 32], p, b)
        }
        fn open(&self, p: &str, b: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            decrypt(&[73; 32], p, b)
        }
    }
    struct Unavailable;
    impl Sealer for Unavailable {
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("Secure Enclave unavailable".into())
        }
        fn open(&self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Err("Secure Enclave unavailable".into())
        }
    }
    fn seed(dir: &Path, keys: &Keys, assistant: Assistant) -> String {
        let first = apply(dir, assistant, Request::Load, keys).unwrap();
        apply(
            dir,
            assistant,
            Request::Append {
                revision: first.revision.clone(),
                turn: Turn {
                    at: 7,
                    question: "Keep this question".into(),
                    answer: "Keep this answer".into(),
                },
            },
            keys,
        )
        .unwrap();
        first.revision
    }
    fn assert_thread(dir: &Path, assistant: Assistant, revision: &str, sealer: &dyn Sealer) {
        let thread = apply(dir, assistant, Request::Load, sealer).unwrap();
        assert_eq!(thread.revision, revision);
        assert_eq!(thread.turns.len(), 1);
        assert_eq!(thread.turns[0].question, "Keep this question");
        assert_eq!(thread.turns[0].answer, "Keep this answer");
        assert_eq!(thread.turns[0].at, 7);
    }

    #[test]
    fn migration_preserves_all_threads_and_settings_before_retiring_all_keys() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        let revisions: Vec<_> = [Assistant::Node, Assistant::Wallet, Assistant::Inbox]
            .map(|a| (a, seed(dir.path(), &keys, a)))
            .into();
        watch_settings(
            dir.path(),
            Assistant::Inbox,
            Some((Rule::Unread, false)),
            &keys,
        )
        .unwrap();
        let store = ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        };
        store.migrate(dir.path()).unwrap();
        assert!(keys.0.lock().unwrap().is_empty());
        for (assistant, revision) in revisions {
            assert_thread(dir.path(), assistant, &revision, &store);
            let bytes =
                std::fs::read(dir.path().join(format!("{}.sealed", assistant.id()))).unwrap();
            assert!(bytes.starts_with(MAGIC));
        }
        assert_eq!(
            watch_settings(dir.path(), Assistant::Inbox, None, &store).unwrap(),
            vec![Rule::Unread]
        );
        store.migrate(dir.path()).unwrap();
    }

    #[test]
    fn complete_migration_skips_later_sweeps_in_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        let revision = seed(dir.path(), &keys, Assistant::Node);
        let store = ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        };
        let complete = std::sync::OnceLock::new();
        let mut sweeps = 0;
        for _ in 0..3 {
            prepare_migration(&complete, || {
                sweeps += 1;
                store.migrate(dir.path())
            });
        }
        assert_eq!(sweeps, 1);
        assert_eq!(complete.get(), Some(&true));
        assert!(keys.0.lock().unwrap().is_empty());
        assert_thread(dir.path(), Assistant::Node, &revision, &store);
    }

    #[test]
    fn incomplete_migration_retries_only_once_per_launch() {
        for unknown_file in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let keys = Keys::default();
            let revision = seed(dir.path(), &keys, Assistant::Node);
            let blocked = dir.path().join(if unknown_file {
                "unknown.sealed"
            } else {
                "wallet.sealed"
            });
            std::fs::write(&blocked, b"corrupt ciphertext").unwrap();
            let store = ThreadSealer {
                hardware: &Hardware,
                legacy: &keys,
            };
            let mut sweeps = 0;
            for launch in 1..=2 {
                // A new process gets a fresh in-memory flag, with the same files/keys.
                let complete = std::sync::OnceLock::new();
                for _ in 0..3 {
                    prepare_migration(&complete, || {
                        sweeps += 1;
                        store.migrate(dir.path())
                    });
                }
                assert_eq!(sweeps, launch);
                assert_eq!(complete.get(), Some(&false));
                assert_eq!(keys.0.lock().unwrap().len(), 1);
                assert_eq!(std::fs::read(&blocked).unwrap(), b"corrupt ciphertext");
                assert_thread(dir.path(), Assistant::Node, &revision, &store);
            }
            std::fs::remove_file(blocked).unwrap();
            let complete = std::sync::OnceLock::new();
            for _ in 0..3 {
                prepare_migration(&complete, || {
                    sweeps += 1;
                    store.migrate(dir.path())
                });
            }
            assert_eq!(sweeps, 3);
            assert_eq!(complete.get(), Some(&true));
            assert!(keys.0.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn no_files_does_not_mark_legacy_keys_retired() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        keys.seal("ai-thread-v1:node", b"old data").unwrap();
        let store = ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        };
        for path in [dir.path().to_path_buf(), dir.path().join("absent")] {
            let complete = std::sync::OnceLock::new();
            let mut sweeps = 0;
            for _ in 0..2 {
                prepare_migration(&complete, || {
                    sweeps += 1;
                    store.migrate(&path)
                });
            }
            assert_eq!(sweeps, 1);
            assert_eq!(complete.get(), Some(&false));
            assert_eq!(keys.0.lock().unwrap().len(), 1);
        }
    }

    #[test]
    fn crash_mid_migration_resumes_with_both_formats_and_all_legacy_keys() {
        // Panic at the second file's key wrapping, after the first file committed.
        struct Crash(AtomicUsize);
        impl Sealer for Crash {
            fn seal(&self, p: &str, b: &[u8]) -> Result<Vec<u8>, String> {
                assert_ne!(
                    self.0.fetch_add(1, Ordering::SeqCst),
                    1,
                    "simulated process death"
                );
                Hardware.seal(p, b)
            }
            fn open(&self, p: &str, b: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
                Hardware.open(p, b)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        let node = seed(dir.path(), &keys, Assistant::Node);
        let wallet = seed(dir.path(), &keys, Assistant::Wallet);
        let hardware = Crash(AtomicUsize::new(0));
        let crashing = ThreadSealer {
            hardware: &hardware,
            legacy: &keys,
        };
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || crashing.migrate(dir.path())
        ))
        .is_err());
        assert_eq!(keys.0.lock().unwrap().len(), 2);
        let migrated = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|p| std::fs::read(p.unwrap().path()).unwrap())
            .filter(|b| b.starts_with(MAGIC))
            .count();
        assert_eq!(migrated, 1);
        // A hard crash may also leave an uncommitted temporary ciphertext.
        std::fs::write(dir.path().join(".tmp-crashed"), b"incomplete ciphertext").unwrap();
        let resumed = ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        };
        assert_thread(dir.path(), Assistant::Node, &node, &resumed);
        assert_thread(dir.path(), Assistant::Wallet, &wallet, &resumed);
        resumed.migrate(dir.path()).unwrap();
        assert!(keys.0.lock().unwrap().is_empty());
        assert_thread(dir.path(), Assistant::Node, &node, &resumed);
        assert_thread(dir.path(), Assistant::Wallet, &wallet, &resumed);
    }

    #[test]
    fn unavailable_enclave_preserves_legacy_files_and_supports_new_writes() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        let revision = seed(dir.path(), &keys, Assistant::Node);
        let path = dir.path().join("node.sealed");
        let original = std::fs::read(&path).unwrap();
        let store = ThreadSealer {
            hardware: &Unavailable,
            legacy: &keys,
        };
        assert!(store.migrate(dir.path()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_thread(dir.path(), Assistant::Node, &revision, &store);
        apply(dir.path(), Assistant::Inbox, Request::Load, &store).unwrap();
        assert_eq!(keys.0.lock().unwrap().len(), 2);
        let recovered = ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        };
        recovered.migrate(dir.path()).unwrap();
        assert!(keys.0.lock().unwrap().is_empty());
        assert_thread(dir.path(), Assistant::Node, &revision, &recovered);
    }

    #[test]
    fn corrupt_thread_is_untouched_and_blocks_key_retirement_but_not_other_threads() {
        for invalid_json in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let keys = Keys::default();
            seed(dir.path(), &keys, Assistant::Node);
            let wallet = seed(dir.path(), &keys, Assistant::Wallet);
            let corrupt = if invalid_json {
                keys.seal("ai-thread-v1:node", b"invalid json").unwrap()
            } else {
                b"corrupt ciphertext".to_vec()
            };
            std::fs::write(dir.path().join("node.sealed"), &corrupt).unwrap();
            let store = ThreadSealer {
                hardware: &Hardware,
                legacy: &keys,
            };
            assert!(store.migrate(dir.path()).is_err());
            assert_eq!(
                std::fs::read(dir.path().join("node.sealed")).unwrap(),
                corrupt
            );
            assert_eq!(keys.0.lock().unwrap().len(), 2);
            assert!(apply(dir.path(), Assistant::Node, Request::Load, &store).is_err());
            assert_thread(dir.path(), Assistant::Wallet, &wallet, &store);
            assert!(std::fs::read(dir.path().join("wallet.sealed"))
                .unwrap()
                .starts_with(MAGIC));
        }
    }

    #[test]
    fn failed_disk_readback_never_replaces_legacy_ciphertext_or_deletes_keys() {
        struct BadReadback(AtomicUsize);
        impl Sealer for BadReadback {
            fn seal(&self, p: &str, b: &[u8]) -> Result<Vec<u8>, String> {
                Hardware.seal(p, b)
            }
            fn open(&self, p: &str, b: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
                if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                    Hardware.open(p, b)
                } else {
                    Err("readback failed".into())
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        let revision = seed(dir.path(), &keys, Assistant::Node);
        let path = dir.path().join("node.sealed");
        let original = std::fs::read(&path).unwrap();
        let hardware = BadReadback(AtomicUsize::new(0));
        assert!(ThreadSealer {
            hardware: &hardware,
            legacy: &keys
        }
        .migrate(dir.path())
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_thread(dir.path(), Assistant::Node, &revision, &keys);
        assert_eq!(keys.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn ordinary_save_also_verifies_disk_before_replacing_a_legacy_thread() {
        struct ReadbackUnavailable(AtomicUsize);
        impl Sealer for ReadbackUnavailable {
            fn seal(&self, p: &str, b: &[u8]) -> Result<Vec<u8>, String> {
                Hardware.seal(p, b)
            }
            fn open(&self, p: &str, b: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
                if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                    Hardware.open(p, b)
                } else {
                    Err("enclave locked during disk readback".into())
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        let revision = seed(dir.path(), &keys, Assistant::Node);
        let path = dir.path().join("node.sealed");
        let original = std::fs::read(&path).unwrap();
        let hardware = ReadbackUnavailable(AtomicUsize::new(0));
        let store = ThreadSealer {
            hardware: &hardware,
            legacy: &keys,
        };
        assert!(apply(
            dir.path(),
            Assistant::Node,
            Request::Append {
                revision: revision.clone(),
                turn: Turn {
                    at: 8,
                    question: "new question".into(),
                    answer: "new answer".into()
                },
            },
            &store
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_thread(dir.path(), Assistant::Node, &revision, &keys);
    }

    #[test]
    fn device_bound_ciphertext_never_falls_back_on_open_failure() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::default();
        seed(dir.path(), &keys, Assistant::Node);
        ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        }
        .migrate(dir.path())
        .unwrap();
        let path = dir.path().join("node.sealed");
        let original = std::fs::read(&path).unwrap();
        let unavailable = ThreadSealer {
            hardware: &Unavailable,
            legacy: &keys,
        };
        assert!(unavailable.migrate(dir.path()).is_err());
        assert!(apply(dir.path(), Assistant::Node, Request::Load, &unavailable).is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert!(keys.0.lock().unwrap().is_empty());
    }

    #[test]
    fn envelope_handles_large_threads_and_rejects_tampering_wrong_purpose_and_truncation() {
        let keys = Keys::default();
        let store = ThreadSealer {
            hardware: &Hardware,
            legacy: &keys,
        };
        let plain = vec![17; 100_000];
        let bytes = store.seal("ai-thread-v1:node", &plain).unwrap();
        assert_eq!(*store.open("ai-thread-v1:node", &bytes).unwrap(), plain);
        assert!(store.open("ai-thread-v1:wallet", &bytes).is_err());
        for len in [MAGIC.len(), MAGIC.len() + 3, bytes.len() - 1] {
            assert!(store.open("ai-thread-v1:node", &bytes[..len]).is_err());
        }
        let mut bad = bytes;
        *bad.last_mut().unwrap() ^= 1;
        assert!(store.open("ai-thread-v1:node", &bad).is_err());
        assert!(keys.0.lock().unwrap().is_empty());
    }
}
