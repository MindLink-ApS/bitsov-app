//! Provisional first-run password escrow. Ordinary node credentials are untouched.
use super::home_keychain;

fn escrow_id(box_key: &str) -> Result<String, String> {
    if box_key.len() != 64
        || !box_key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid setup box key.".into());
    }
    Ok(hex::encode(blake3::derive_key(
        "bitsov remote setup password escrow v1",
        box_key.as_bytes(),
    )))
}

#[cfg(not(test))]
fn save(box_key: &str, password: &[u8]) -> Result<(), String> {
    home_keychain::save_password(&escrow_id(box_key)?, password)
}

pub fn password(box_key: &str, blob: &[u8]) -> Result<zeroize::Zeroizing<String>, String> {
    home_keychain::password(&escrow_id(box_key)?, Some(blob))
}

#[cfg(all(target_os = "macos", not(test)))]
pub fn forget(box_key: &str) -> Result<(), String> {
    forget_with(crate::profile::current()?, box_key, |name, account| {
        bitsov_ffi::home_keychain::delete_items(name, account)
            .map_err(|_| "Invalid setup envelope.".into())
    })
}

#[cfg(any(target_os = "macos", test))]
fn forget_with(
    profile: crate::profile::AppProfile,
    box_key: &str,
    delete: impl FnOnce(&str, &str) -> Result<i32, String>,
) -> Result<(), String> {
    let name = profile.keychain_service(&format!(
        "bitsov.node.{}.seed-password.wrapped-v1",
        escrow_id(box_key)?
    ));
    let status = delete(&name, "BitSov")?;
    if status != 0 {
        return Err("Could not remove the provisional setup envelope.".into());
    }
    Ok(())
}
#[cfg(all(not(target_os = "macos"), not(test)))]
pub fn forget(_: &str) -> Result<(), String> {
    Ok(())
}

/// Owns provisional escrow until a finalize may have committed. Dropping an
/// uncommitted attempt must remove only this box's wrapped envelope.
pub struct Escrow {
    box_key: String,
    provisional: bool,
}
impl Escrow {
    pub fn save(box_key: String, password: &[u8]) -> Result<Self, String> {
        let escrow = Self {
            box_key,
            provisional: true,
        };
        save(&escrow.box_key, password)?;
        Ok(escrow)
    }

    pub fn retain_for_recovery(&mut self) {
        self.provisional = false;
    }

    pub fn resume_cleanup(&mut self) {
        self.provisional = true;
    }

    pub fn clear(&mut self) -> Result<(), String> {
        if self.provisional {
            forget(&self.box_key)?;
            self.provisional = false;
        }
        Ok(())
    }
}

impl Drop for Escrow {
    fn drop(&mut self) {
        // Cancellation and early returns cannot await cleanup. Deletion uses
        // exact service/account queries and never requests biometric access.
        let _ = self.clear();
    }
}

// Test doubles live at the native storage boundary. None of these tests can
// call Keychain or Secure Enclave, including from spawn_blocking workers.
#[cfg(test)]
fn save(box_key: &str, password: &[u8]) -> Result<(), String> {
    let name = format!(
        "bitsov.node.{}.seed-password.wrapped-v1",
        escrow_id(box_key)?
    );
    test_store::items()
        .lock()
        .unwrap()
        .insert((name, "BitSov".into()));
    if password == b"fail-after-write" {
        return Err("test storage failure".into());
    }
    Ok(())
}
#[cfg(test)]
pub fn forget(box_key: &str) -> Result<(), String> {
    forget_with(crate::profile::AppProfile::for_identifier("tech.mindlink.bitsov"), box_key, |name, account| {
        test_store::items()
            .lock()
            .unwrap()
            .remove(&(name.into(), account.into()));
        Ok(0)
    })
}
#[cfg(test)]
pub(super) mod test_store {
    use std::{
        collections::HashSet,
        sync::{Mutex, OnceLock},
    };
    pub fn items() -> &'static Mutex<HashSet<(String, String)>> {
        static ITEMS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
        ITEMS.get_or_init(Mutex::default)
    }
    pub fn key() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        format!("{:064x}", NEXT.fetch_add(1, Ordering::Relaxed))
    }
    pub fn contains(key: &str) -> bool {
        items().lock().unwrap().contains(&(
            format!(
                "bitsov.node.{}.seed-password.wrapped-v1",
                super::escrow_id(key).unwrap()
            ),
            "BitSov".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_escrow_forget_cannot_delete_the_same_boxs_production_item() {
        use crate::profile::AppProfile;
        let key = "ab".repeat(32);
        let production = format!("bitsov.node.{}.seed-password.wrapped-v1", escrow_id(&key).unwrap());
        let remote = format!("tech.mindlink.bitsov.remotetest.{production}");
        let mut items = std::collections::HashSet::from([
            (production.clone(), "BitSov".to_string()),
            (remote.clone(), "BitSov".to_string()),
        ]);
        forget_with(AppProfile::for_identifier("tech.mindlink.bitsov.remotetest"), &key, |name, account| {
            assert_eq!(name, remote);
            assert_eq!(account, "BitSov");
            assert!(items.remove(&(name.into(), account.into())));
            Ok(0)
        }).unwrap();
        assert_eq!(items, std::collections::HashSet::from([(production.clone(), "BitSov".into())]));
        forget_with(AppProfile::for_identifier("tech.mindlink.bitsov"), &key, |name, account| {
            assert_eq!(name, production);
            assert!(items.remove(&(name.into(), account.into())));
            Ok(0)
        }).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn dropping_provisional_escrow_removes_only_its_wrapped_item() {
        let key = test_store::key();
        let other = test_store::key();
        let escrow = Escrow::save(key.clone(), b"password").unwrap();
        let other_escrow = Escrow::save(other.clone(), b"other password").unwrap();
        let ordinary = (
            format!("bitsov.node.{key}.seed-password.wrapped-v1"),
            "BitSov".into(),
        );
        test_store::items().lock().unwrap().insert(ordinary.clone());
        assert!(test_store::contains(&key));
        drop(escrow);
        assert!(!test_store::contains(&key));
        assert!(test_store::contains(&other));
        assert!(test_store::items().lock().unwrap().remove(&ordinary));
        drop(other_escrow);
    }

    #[test]
    fn partial_save_failure_and_explicit_cancel_remove_escrow() {
        let key = test_store::key();
        assert!(Escrow::save(key.clone(), b"fail-after-write").is_err());
        assert!(!test_store::contains(&key));
        let mut escrow = Escrow::save(key.clone(), b"password").unwrap();
        escrow.clear().unwrap();
        assert!(!test_store::contains(&key));
        drop(escrow);
        assert!(!test_store::contains(&key));
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_drops_provisional_escrow() {
        let key = test_store::key();
        let escrow = Escrow::save(key.clone(), b"password").unwrap();
        let task = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(900)).await;
            drop(escrow);
        });
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(899)).await;
        assert!(test_store::contains(&key));
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        task.await.unwrap();
        assert!(!test_store::contains(&key));
    }

    #[test]
    fn uncertain_finalize_retains_escrow_but_definite_rejection_rearms_cleanup() {
        let key = test_store::key();
        let mut escrow = Escrow::save(key.clone(), b"password").unwrap();
        escrow.retain_for_recovery();
        drop(escrow);
        assert!(test_store::contains(&key));
        forget(&key).unwrap();
        let mut escrow = Escrow::save(key.clone(), b"password").unwrap();
        escrow.retain_for_recovery();
        escrow.resume_cleanup();
        drop(escrow);
        assert!(!test_store::contains(&key));
    }

    #[tokio::test]
    async fn aborted_future_and_abandoned_blocking_save_clean_up() {
        let key = test_store::key();
        let escrow = Escrow::save(key.clone(), b"password").unwrap();
        let task = tokio::spawn(async move {
            let _escrow = escrow;
            std::future::pending::<()>().await;
        });
        task.abort();
        let _ = task.await;
        assert!(!test_store::contains(&key));

        let key = test_store::key();
        let saved_key = key.clone();
        let result = tokio::task::spawn_blocking(move || Escrow::save(saved_key, b"password"))
            .await
            .unwrap();
        // The result of a completed blocking save can be dropped if its caller
        // disappeared. It still owns the cleanup obligation.
        drop(result);
        assert!(!test_store::contains(&key));
    }

    #[test]
    fn provisional_namespace_is_derived_and_refuses_item_injection() {
        let key = "ab".repeat(32);
        let id = escrow_id(&key).unwrap();
        assert_ne!(id, key);
        assert_ne!(id, escrow_id(&"cd".repeat(32)).unwrap());
        for input in [
            "",
            "../node",
            "bitsov.node.secret.seed-password",
            "AB",
            "\0",
        ] {
            assert!(escrow_id(input).is_err());
        }
    }
}
