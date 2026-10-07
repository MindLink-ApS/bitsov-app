//! Sealed, bounded text transcripts. Never persist broker JSON or disclosure bodies.
//! A revision rejects a late answer after Forget (including across track switches).
use super::assistants::Assistant;
use crate::at_rest::Sealer;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

const MAX_TURNS: usize = 100;
// Covers 100 maximum-length turns even with six-byte JSON escapes.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

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
}
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Load,
    Append { revision: String, turn: Turn },
    Forget,
}

fn revision() -> Result<String, String> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not create a thread revision.")?;
    Ok(hex::encode(bytes))
}
fn check(thread: &Thread) -> Result<(), String> {
    if thread.turns.len() > MAX_TURNS
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
    let path = dir.join(format!("{}.sealed", assistant.id()));
    let purpose = format!("ai-thread-v1:{}", assistant.id());
    // Forget must not read/decrypt the old file, including oversized/corrupt files.
    let mut thread = if matches!(request, Request::Forget) {
        Thread {
            revision: revision()?,
            turns: vec![],
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
            },
            Err(_) => return Err("Could not read the assistant thread.".into()),
        }
    };
    match request {
        Request::Load if path.exists() => return Ok(thread),
        Request::Load => {}
        Request::Forget => {
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
    temp.persist(&path)
        .map_err(|_| "Could not save the assistant thread.")?;
    Ok(thread)
}

/// Mac implementation of the existing Sealer interface. Uses the app's native
/// Keychain bridge; a random encryption key never enters a renderer or disk file.
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
pub struct MacSealer;
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
impl MacSealer {
    fn key(purpose: &str, create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
        use bitsov_ffi::home_keychain::{add_item, read_item};
        const SERVICE: &str = "tech.mindlink.bitsov.ai-threads.v1";
        let read =
            || read_item(SERVICE, purpose, 32).map_err(|_| "Invalid thread key name.".to_string());
        let (mut status, mut length, mut bytes) = read()?;
        if status == -25300 && create {
            let mut key = Zeroizing::new(vec![0; 32]);
            getrandom::getrandom(&mut key).map_err(|_| "Could not create the thread key.")?;
            let added = add_item(SERVICE, purpose, &key).map_err(|_| "Invalid thread key name.")?;
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
impl Sealer for MacSealer {
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
