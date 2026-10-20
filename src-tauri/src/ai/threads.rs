//! Sealed, bounded text transcripts. Never persist broker JSON or disclosure bodies.
//! A revision rejects a late answer after Forget (including across track switches).
use super::{
    assistants::Assistant,
    watches::{Notice, Rule},
};
use crate::at_rest::Sealer;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

#[cfg(any(test, all(target_os = "macos", not(feature = "mobile"))))]
mod storage;

const MAX_TURNS: usize = 100;
// Covers 100 maximum-length turns even with six-byte JSON escapes.
// Reserve room for a bounded Secure Enclave key envelope as well as the text.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024 + 16 * 1024 + 64;
const MAX_SETTINGS_BYTES: u64 = 4096 + 16 * 1024 + 64;

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
pub use storage::MacSealer;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub at: u64,
    pub question: String,
    pub answer: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Thread {
    pub revision: String,
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub notices: Vec<Notice>,
    #[serde(default)]
    pub disabled_watches: Vec<Rule>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Load,
    Append { revision: String, turn: Turn },
    Forget,
    SetWatch { rule: Rule, enabled: bool },
}

fn revision() -> Result<String, String> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not create a thread revision.")?;
    Ok(hex::encode(bytes))
}
fn check(thread: &Thread) -> Result<(), String> {
    if thread.notices.len() > MAX_TURNS
        || thread.notices.iter().any(|n| n.text.chars().count() > 500)
        || thread.turns.len() > MAX_TURNS
        || thread.turns.iter().any(|t| {
            t.question.chars().count() > super::MAX_QUESTION_CHARS
                || t.answer.chars().count() > 16_000
        })
    {
        return Err("The assistant thread is too large.".into());
    }
    Ok(())
}

/// Caller serializes operations with the host's thread lock. File replacement is
/// atomic; only ciphertext is ever written, including temporary files.
pub fn apply(
    dir: &Path,
    assistant: Assistant,
    request: Request,
    sealer: &dyn Sealer,
) -> Result<Thread, String> {
    apply_inner(dir, assistant, request, sealer, &[])
}

/// Host-only append: notice text comes from deterministic rules, never model output.
pub fn append_notices(
    dir: &Path,
    assistant: Assistant,
    notices: &[Notice],
    sealer: &dyn Sealer,
) -> Result<Thread, String> {
    if notices.iter().any(|n| n.rule.assistant() != assistant) {
        return Err("Wrong notice thread.".into());
    }
    apply_inner(dir, assistant, Request::Load, sealer, notices)
}
#[derive(Debug, Serialize)]
pub struct WatchUpdate {
    pub revision: String,
    pub notices: Option<Vec<Notice>>,
}
#[allow(clippy::too_many_arguments)]
pub fn poll_watches(
    dir: &Path,
    assistant: Assistant,
    revision: Option<&str>,
    sample: &super::watches::Sample,
    cache: &mut std::collections::HashMap<&'static str, Thread>,
    engine: &mut super::watches::Engine,
    open: bool,
    now: u64,
    sealer: &dyn Sealer,
) -> Result<WatchUpdate, String> {
    if !open {
        engine.reset(assistant);
        return Ok(WatchUpdate {
            revision: String::new(),
            notices: None,
        });
    }
    // Validate role boundaries before storage, even on the generation handshake.
    let mut validated = engine.clone();
    validated.poll(true, now, assistant, sample, &[])?;
    if !cache.contains_key(assistant.id()) {
        cache.insert(
            assistant.id(),
            apply(dir, assistant, Request::Load, sealer)?,
        );
    }
    let saved = &cache[assistant.id()];
    if revision != Some(saved.revision.as_str()) {
        return Ok(WatchUpdate {
            revision: saved.revision.clone(),
            notices: Some(saved.notices.clone()),
        });
    }
    let mut next = engine.clone();
    let notices = next.poll(true, now, assistant, sample, &saved.disabled_watches)?;
    let update = if notices.is_empty() {
        WatchUpdate {
            revision: saved.revision.clone(),
            notices: None,
        }
    } else {
        let saved = append_notices(dir, assistant, &notices, sealer)?;
        let update = WatchUpdate {
            revision: saved.revision.clone(),
            notices: Some(saved.notices.clone()),
        };
        cache.insert(assistant.id(), saved);
        update
    };
    // Only consume dedupe state after the notice is durably saved.
    *engine = next;
    Ok(update)
}

fn apply_inner(
    dir: &Path,
    assistant: Assistant,
    request: Request,
    sealer: &dyn Sealer,
    notices: &[Notice],
) -> Result<Thread, String> {
    let path = dir.join(format!("{}.sealed", assistant.id()));
    let purpose = format!("ai-thread-v1:{}", assistant.id());
    // Forget must not read/decrypt the old file, including oversized/corrupt files.
    let mut thread = if matches!(request, Request::Forget) {
        Thread {
            revision: revision()?,
            turns: vec![],
            notices: vec![],
            disabled_watches: vec![],
        }
    } else {
        match std::fs::metadata(&path) {
            Ok(meta) => {
                if meta.len() > MAX_FILE_BYTES {
                    return Err("The assistant thread is too large.".into());
                }
                let bytes =
                    std::fs::read(&path).map_err(|_| "Could not read the assistant thread.")?;
                let plain = sealer.open(&purpose, &bytes)?;
                let saved: Thread = serde_json::from_slice(&plain)
                    .map_err(|_| "The assistant thread is corrupt.")?;
                check(&saved)?;
                saved
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Thread {
                revision: revision()?,
                turns: vec![],
                notices: vec![],
                disabled_watches: vec![],
            },
            Err(_) => return Err("Could not read the assistant thread.".into()),
        }
    };
    // Separate preferences survive Forget, even if the transcript is corrupt.
    thread.disabled_watches = watch_settings(dir, assistant, None, sealer)?;
    thread.notices.extend_from_slice(notices);
    if thread.notices.len() > MAX_TURNS {
        thread.notices.drain(..thread.notices.len() - MAX_TURNS);
    }
    match request {
        Request::Load if path.exists() && notices.is_empty() => return Ok(thread),
        Request::Load => {}
        Request::SetWatch { rule, enabled } => {
            thread.disabled_watches =
                watch_settings(dir, assistant, Some((rule, enabled)), sealer)?;
            return Ok(thread);
        }
        Request::Forget => {
            thread.notices.clear();
            thread.turns.clear();
            thread.revision = revision()?;
        }
        Request::Append {
            revision: expected,
            turn,
        } => {
            if expected != thread.revision {
                return Err("This thread was changed or forgotten. Reopen the assistant.".into());
            }
            thread.turns.push(turn);
            if thread.turns.len() > MAX_TURNS {
                thread.turns.remove(0);
            }
            // Append merges under the host lock. Only Forget changes the generation,
            // so answers completing in other mounted views cannot overwrite each other.
        }
    }
    check(&thread)?;
    let plain = Zeroizing::new(
        serde_json::to_vec(&thread).map_err(|_| "Could not encode the assistant thread.")?,
    );
    let ciphertext = sealer.seal(&purpose, &plain)?;
    if ciphertext.len() as u64 > MAX_FILE_BYTES {
        return Err("The assistant thread is too large.".into());
    }
    write_sealed(dir, &path, &ciphertext, &purpose, &plain, sealer)?;
    Ok(thread)
}

// Shared by ordinary saves and migration: even a save after a deferred migration
// must verify its candidate on disk before replacing the old ciphertext.
fn write_sealed(
    dir: &Path,
    path: &Path,
    ciphertext: &[u8],
    purpose: &str,
    plain: &[u8],
    sealer: &dyn Sealer,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|_| "Could not create the assistant folder.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect the assistant folder.")?;
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(dir).map_err(|_| "Could not save the assistant thread.")?;
    temp.write_all(&ciphertext)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|_| "Could not save the assistant thread.")?;
    let readback =
        std::fs::read(temp.path()).map_err(|_| "Could not read back the assistant thread.")?;
    if sealer.open(purpose, &readback)?.as_slice() != plain {
        return Err("The saved assistant thread failed verification.".into());
    }
    temp.persist(&path)
        .map_err(|_| "Could not save the assistant thread.")?;
    Ok(())
}

/// No transcript read is needed to preserve an off switch during Forget.
pub fn watch_settings(
    dir: &Path,
    assistant: Assistant,
    change: Option<(Rule, bool)>,
    sealer: &dyn Sealer,
) -> Result<Vec<Rule>, String> {
    let path = dir.join(format!("{}-watches.sealed", assistant.id()));
    let purpose = format!("ai-watch-settings-v1:{}", assistant.id());
    let mut disabled: Vec<Rule> = match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Ok(meta) if meta.len() <= MAX_SETTINGS_BYTES => {
            let bytes = std::fs::read(&path).map_err(|_| "Could not read watch settings.")?;
            serde_json::from_slice(&sealer.open(&purpose, &bytes)?)
                .map_err(|_| "Invalid watch settings.")?
        }
        _ => return Err("Could not read watch settings.".into()),
    };
    if disabled.len() > 7 || disabled.iter().any(|r| r.assistant() != assistant) {
        return Err("Invalid watch settings.".into());
    }
    if let Some((rule, enabled)) = change {
        if rule.assistant() != assistant {
            return Err("That watch belongs to another assistant.".into());
        }
        disabled.retain(|r| *r != rule);
        if !enabled {
            disabled.push(rule);
        }
        let plain =
            Zeroizing::new(serde_json::to_vec(&disabled).map_err(|_| "Invalid watch settings.")?);
        write_sealed(
            dir, &path, &sealer.seal(&purpose, &plain)?, &purpose, &plain, sealer,
        )?;
    }
    Ok(disabled)
}

/// Legacy AES keys in Keychain (including the migratable login-Keychain fallback).
/// This storage is not Secure Enclave-backed or biometry-gated.
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
struct LegacyMacSealer;
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
impl LegacyMacSealer {
    fn service() -> Result<String, String> {
        Ok(crate::profile::current()?.keychain_service("tech.mindlink.bitsov.ai-threads.v1"))
    }
    fn key(purpose: &str, create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
        use bitsov_ffi::home_keychain::{add_item, read_item};
        let service = Self::service()?;
        let read =
            || read_item(&service, purpose, 32).map_err(|_| "Invalid thread key name.".to_string());
        let (mut status, mut length, mut bytes) = read()?;
        if status == -25300 && create {
            let mut key = Zeroizing::new(vec![0; 32]);
            getrandom::getrandom(&mut key).map_err(|_| "Could not create the thread key.")?;
            let added = add_item(&service, purpose, &key).map_err(|_| "Invalid thread key name.")?;
            if added != 0 && added != -25299 {
                return Err(format!("Keychain could not save the thread key ({added})."));
            }
            (status, length, bytes) = read()?;
        }
        if status != 0 || length != 32 {
            return Err(format!(
                "Keychain could not open the thread key ({status})."
            ));
        }
        bytes.truncate(32);
        Ok(bytes)
    }
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
impl Sealer for LegacyMacSealer {
    fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        encrypt(&Self::key(purpose, true)?, purpose, plaintext)
    }
    fn open(&self, purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        decrypt(&Self::key(purpose, false)?, purpose, sealed)
    }
}

#[cfg(any(test, all(target_os = "macos", not(feature = "mobile"))))]
fn encrypt(key: &[u8], purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    let key =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| "Invalid thread key.")?);
    let mut nonce = [0; 12];
    getrandom::getrandom(&mut nonce).map_err(|_| "Could not seal the assistant thread.")?;
    let mut body = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(purpose.as_bytes()),
        &mut body,
    )
    .map_err(|_| "Could not seal the assistant thread.")?;
    let mut sealed = nonce.to_vec();
    sealed.extend(body);
    Ok(sealed)
}
#[cfg(any(test, all(target_os = "macos", not(feature = "mobile"))))]
fn decrypt(key: &[u8], purpose: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    if sealed.len() < 28 {
        return Err("The assistant thread is corrupt.".into());
    }
    let key =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| "Invalid thread key.")?);
    let mut body = Zeroizing::new(sealed[12..].to_vec());
    let nonce: [u8; 12] = sealed[..12].try_into().map_err(|_| "Invalid nonce.")?;
    let len = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(purpose.as_bytes()),
            &mut body,
        )
        .map_err(|_| "Could not open the assistant thread.")?
        .len();
    body.truncate(len);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestSealer;
    impl Sealer for TestSealer {
        fn seal(&self, p: &str, b: &[u8]) -> Result<Vec<u8>, String> {
            encrypt(&[42; 32], p, b)
        }
        fn open(&self, p: &str, b: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            decrypt(&[42; 32], p, b)
        }
    }
    #[test]
    fn queued_watch_sample_cannot_restore_a_forgotten_notice() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = std::collections::HashMap::new();
        let mut engine = super::super::watches::Engine::default();
        let sample = super::super::watches::Sample {
            money_ready: Some(false),
            ..Default::default()
        };
        let first = poll_watches(
            dir.path(),
            Assistant::Node,
            None,
            &sample,
            &mut cache,
            &mut engine,
            true,
            0,
            &TestSealer,
        )
        .unwrap();
        let old_revision = first.revision;
        let notice = poll_watches(
            dir.path(),
            Assistant::Node,
            Some(&old_revision),
            &sample,
            &mut cache,
            &mut engine,
            true,
            1000,
            &TestSealer,
        )
        .unwrap();
        assert_eq!(notice.notices.unwrap().len(), 1);
        let forgotten = apply(dir.path(), Assistant::Node, Request::Forget, &TestSealer).unwrap();
        cache.insert("node", forgotten.clone());
        let late = poll_watches(
            dir.path(),
            Assistant::Node,
            Some(&old_revision),
            &sample,
            &mut cache,
            &mut engine,
            true,
            1500,
            &TestSealer,
        )
        .unwrap();
        assert_eq!(late.revision, forgotten.revision);
        assert!(late.notices.unwrap().is_empty());
        assert!(
            apply(dir.path(), Assistant::Node, Request::Load, &TestSealer)
                .unwrap()
                .notices
                .is_empty()
        );
    }
    #[test]
    fn failed_notice_save_is_retried_without_losing_dedupe_state() {
        struct FailsSeal;
        impl Sealer for FailsSeal {
            fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
                Err("disk full".into())
            }
            fn open(&self, p: &str, b: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
                TestSealer.open(p, b)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cache = std::collections::HashMap::new();
        let mut engine = super::super::watches::Engine::default();
        let sample = super::super::watches::Sample {
            money_ready: Some(false),
            ..Default::default()
        };
        let initial = poll_watches(
            dir.path(),
            Assistant::Node,
            None,
            &sample,
            &mut cache,
            &mut engine,
            true,
            0,
            &TestSealer,
        )
        .unwrap();
        assert!(poll_watches(
            dir.path(),
            Assistant::Node,
            Some(&initial.revision),
            &sample,
            &mut cache,
            &mut engine,
            true,
            1500,
            &FailsSeal
        )
        .is_err());
        assert_eq!(
            poll_watches(
                dir.path(),
                Assistant::Node,
                Some(&initial.revision),
                &sample,
                &mut cache,
                &mut engine,
                true,
                3000,
                &TestSealer
            )
            .unwrap()
            .notices
            .unwrap()
            .len(),
            1
        );
        assert!(poll_watches(
            dir.path(),
            Assistant::Node,
            Some(&initial.revision),
            &sample,
            &mut cache,
            &mut engine,
            true,
            4500,
            &TestSealer
        )
        .unwrap()
        .notices
        .is_none());
    }
    #[test]
    fn closed_watch_poll_does_not_even_access_storage() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = std::collections::HashMap::new();
        let mut engine = super::super::watches::Engine::default();
        let sample = super::super::watches::Sample {
            money_ready: Some(false),
            ..Default::default()
        };
        let update = poll_watches(
            dir.path(),
            Assistant::Node,
            None,
            &sample,
            &mut cache,
            &mut engine,
            false,
            900_000,
            &TestSealer,
        )
        .unwrap();
        assert!(update.notices.is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(cache.is_empty());
    }
    #[test]
    fn notices_are_bounded_sealed_plain_data_and_forget_clears_them() {
        let dir = tempfile::tempdir().unwrap();
        let notices: Vec<_> = (0..105)
            .map(|at| Notice {
                at,
                rule: Rule::Unread,
                text: "Unread count rose.".into(),
            })
            .collect();
        let saved = append_notices(dir.path(), Assistant::Inbox, &notices, &TestSealer).unwrap();
        assert_eq!(saved.notices.len(), 100);
        assert_eq!(saved.notices[0].at, 5);
        assert!(saved.turns.is_empty());
        let value = serde_json::to_value(&saved.notices[0]).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(
            !String::from_utf8_lossy(&std::fs::read(dir.path().join("inbox.sealed")).unwrap())
                .contains("Unread")
        );
        assert!(append_notices(dir.path(), Assistant::Wallet, &notices, &TestSealer).is_err());
        assert!(
            apply(dir.path(), Assistant::Inbox, Request::Forget, &TestSealer)
                .unwrap()
                .notices
                .is_empty()
        );
    }
    #[test]
    fn watch_switch_is_sealed_scoped_and_survives_forget() {
        let dir = tempfile::tempdir().unwrap();
        let request = serde_json::from_value(
            serde_json::json!({"action":"set_watch", "rule":"unread", "enabled":false}),
        )
        .unwrap();
        let saved = apply(dir.path(), Assistant::Inbox, request, &TestSealer).unwrap();
        assert_eq!(
            serde_json::to_value(saved).unwrap()["disabled_watches"],
            serde_json::json!(["unread"])
        );
        let forgotten = apply(dir.path(), Assistant::Inbox, Request::Forget, &TestSealer).unwrap();
        assert_eq!(
            serde_json::to_value(forgotten).unwrap()["disabled_watches"],
            serde_json::json!(["unread"])
        );
        let invalid = serde_json::from_value(
            serde_json::json!({"action":"set_watch", "rule":"balance_drop", "enabled":false}),
        )
        .unwrap();
        assert!(apply(dir.path(), Assistant::Inbox, invalid, &TestSealer).is_err());
        assert!(
            !String::from_utf8_lossy(&std::fs::read(dir.path().join("inbox.sealed")).unwrap())
                .contains("unread")
        );
    }
    #[test]
    fn old_thread_without_watch_fields_remains_readable() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = TestSealer
            .seal("ai-thread-v1:node", br#"{"revision":"old","turns":[]}"#)
            .unwrap();
        std::fs::write(dir.path().join("node.sealed"), bytes).unwrap();
        let loaded = serde_json::to_value(
            apply(dir.path(), Assistant::Node, Request::Load, &TestSealer).unwrap(),
        )
        .unwrap();
        assert_eq!(loaded["notices"], serde_json::json!([]));
        assert_eq!(loaded["disabled_watches"], serde_json::json!([]));
    }
    #[test]
    fn threads_are_sealed_separate_and_forget_rejects_late_answers() {
        let dir = tempfile::tempdir().unwrap();
        let load = |a| apply(dir.path(), a, Request::Load, &TestSealer).unwrap();
        let original = load(Assistant::Wallet);
        let turn = Turn {
            at: 1,
            question: "private wallet question".into(),
            answer: "private wallet answer".into(),
        };
        let saved = apply(
            dir.path(),
            Assistant::Wallet,
            Request::Append {
                revision: original.revision,
                turn: turn.clone(),
            },
            &TestSealer,
        )
        .unwrap();
        assert_eq!(load(Assistant::Wallet).turns[0].answer, turn.answer);
        assert!(load(Assistant::Inbox).turns.is_empty());
        let bytes = std::fs::read(dir.path().join("wallet.sealed")).unwrap();
        assert!(!bytes.windows(7).any(|w| w == b"private"));
        assert!(TestSealer.open("ai-thread-v1:inbox", &bytes).is_err());
        let mut corrupt = bytes;
        corrupt[20] ^= 1;
        assert!(TestSealer.open("ai-thread-v1:wallet", &corrupt).is_err());
        let forgotten = apply(dir.path(), Assistant::Wallet, Request::Forget, &TestSealer).unwrap();
        assert!(forgotten.turns.is_empty());
        assert!(load(Assistant::Wallet).turns.is_empty());
        assert!(apply(
            dir.path(),
            Assistant::Wallet,
            Request::Append {
                revision: saved.revision,
                turn
            },
            &TestSealer
        )
        .is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
    #[test]
    fn concurrent_answers_in_one_generation_are_appended_without_losing_either() {
        let dir = tempfile::tempdir().unwrap();
        let thread = apply(dir.path(), Assistant::Inbox, Request::Load, &TestSealer).unwrap();
        for question in ["old view", "reopened view"] {
            apply(
                dir.path(),
                Assistant::Inbox,
                Request::Append {
                    revision: thread.revision.clone(),
                    turn: Turn {
                        at: 1,
                        question: question.into(),
                        answer: "counts".into(),
                    },
                },
                &TestSealer,
            )
            .unwrap();
        }
        let saved = apply(dir.path(), Assistant::Inbox, Request::Load, &TestSealer).unwrap();
        assert_eq!(
            saved
                .turns
                .iter()
                .map(|t| t.question.as_str())
                .collect::<Vec<_>>(),
            ["old view", "reopened view"]
        );
    }

    #[test]
    fn forget_recovers_an_oversized_file_without_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("inbox.sealed");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(apply(dir.path(), Assistant::Inbox, Request::Load, &TestSealer).is_err());
        assert!(
            apply(dir.path(), Assistant::Inbox, Request::Forget, &TestSealer)
                .unwrap()
                .turns
                .is_empty()
        );
        assert!(
            apply(dir.path(), Assistant::Inbox, Request::Load, &TestSealer)
                .unwrap()
                .turns
                .is_empty()
        );
        assert!(std::fs::metadata(&path).unwrap().len() < 1024);
    }
    #[test]
    fn maximum_length_unicode_turns_remain_reloadable() {
        let dir = tempfile::tempdir().unwrap();
        let purpose = "ai-thread-v1:node";
        let thread = Thread {
            revision: revision().unwrap(),
            notices: vec![],
            disabled_watches: vec![],
            turns: (0..100)
                .map(|_| Turn {
                    at: 1,
                    question: "q".repeat(500),
                    answer: "界".repeat(16_000),
                })
                .collect(),
        };
        check(&thread).unwrap();
        let bytes = TestSealer
            .seal(purpose, &serde_json::to_vec(&thread).unwrap())
            .unwrap();
        std::fs::write(dir.path().join("node.sealed"), bytes).unwrap();
        assert_eq!(
            apply(dir.path(), Assistant::Node, Request::Load, &TestSealer)
                .unwrap()
                .turns
                .len(),
            100
        );
    }

    #[test]
    fn oversize_or_unsealed_threads_fail_closed_and_forget_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let initial = apply(dir.path(), Assistant::Node, Request::Load, &TestSealer).unwrap();
        let huge = Turn {
            at: 0,
            question: "x".repeat(501),
            answer: "a".into(),
        };
        assert!(apply(
            dir.path(),
            Assistant::Node,
            Request::Append {
                revision: initial.revision,
                turn: huge
            },
            &TestSealer
        )
        .is_err());
        std::fs::write(dir.path().join("node.sealed"), b"plaintext").unwrap();
        assert!(apply(dir.path(), Assistant::Node, Request::Load, &TestSealer).is_err());
        assert!(
            apply(dir.path(), Assistant::Node, Request::Forget, &TestSealer)
                .unwrap()
                .turns
                .is_empty()
        );
    }
}
