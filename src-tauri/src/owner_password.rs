//! Launcher password storage. New installations begin with one app-owned item;
//! after identity commit, migrate to the biometric node-scoped item and retire
//! the exact legacy record. No password file, environment value or broad query.
use base64::Engine;
use std::path::Path;
use zeroize::Zeroizing;

pub fn load(data_dir: &Path, allow_create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    if let Some(node) = bound_node(data_dir)? {
        return super::home_keychain::password(&node, None)
            .map(|password| Zeroizing::new(password.as_bytes().to_vec()));
    }
    let account = account(data_dir);
    load_from(
        allow_create,
        || read(&account),
        |password| add(&account, password),
    )
}

const BINDING_FILE: &str = "seed-password-node.json";
fn account(data_dir: &Path) -> String {
    blake3::hash(data_dir.as_os_str().as_encoded_bytes()).to_hex().to_string()
}
fn bound_node(data_dir: &Path) -> Result<Option<String>, String> {
    let bytes = super::device::read_private(&data_dir.join(BINDING_FILE))
        .map_err(|_| "Cannot read the seed-password binding.")?;
    bytes.map(|bytes| serde_json::from_slice::<String>(&bytes).map_err(|_| "Invalid seed-password binding.".into())).transpose()
}

/// Called only after the live node identity and owner device were verified.
/// Verify the exact biometric copy before publishing the launcher binding, and
/// retire the legacy item last. A failed step preserves a recoverable copy.
pub fn bind_to_node(data_dir: &Path, node: &str) -> Result<(), String> {
    if bound_node(data_dir)?.as_deref() == Some(node) {
        // A previous rename may be visible even if its directory sync failed.
        // Re-verify and sync before retiring a legacy copy on a retry.
        let Some(legacy) = read(&account(data_dir))? else { return Ok(()); };
        return migrate(&legacy, || Ok(()),
            || super::home_keychain::password(node, None).map(|s| Zeroizing::new(s.as_bytes().to_vec())),
            || sync_binding(data_dir), || remove(&account(data_dir)));
    }
    let password = load(data_dir, false)?;
    migrate(
        &password,
        || super::home_keychain::save_password(node, &password),
        || super::home_keychain::password(node, None).map(|s| Zeroizing::new(s.as_bytes().to_vec())),
        || {
            let bytes = serde_json::to_vec(node).map_err(|_| "Cannot encode seed-password binding.")?;
            super::device::write_private(&data_dir.join(BINDING_FILE), &bytes)
                .map_err(|_| "Cannot save seed-password binding.")?;
            sync_binding(data_dir)
        },
        || remove(&account(data_dir)),
    )
}
fn sync_binding(data_dir: &Path) -> Result<(), String> {
    std::fs::File::open(data_dir.join(BINDING_FILE)).and_then(|file| file.sync_all())
        .and_then(|()| std::fs::File::open(data_dir)?.sync_all())
        .map_err(|_| "Cannot sync seed-password binding.".into())
}

fn migrate(
    password: &[u8],
    save: impl FnOnce() -> Result<(), String>,
    verify: impl FnOnce() -> Result<Zeroizing<Vec<u8>>, String>,
    publish: impl FnOnce() -> Result<(), String>,
    retire: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    save()?;
    let verified = verify()?;
    if verified.as_slice() != password { return Err("The protected seed password does not match; the launcher item was retained.".into()); }
    publish()?;
    retire()
}

fn load_from(
    allow_create: bool,
    read: impl FnOnce() -> Result<Option<Zeroizing<Vec<u8>>>, String>,
    add: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    match read()? {
        Some(password) => Ok(password),
        None if !allow_create => Err("This installation's seed password is missing from Keychain. Restore Keychain access; the app will not replace it or overwrite your identity.".into()),
        None => {
            let mut random = Zeroizing::new([0u8; 32]);
            getrandom::getrandom(&mut *random).map_err(|_| "Could not generate the seed password")?;
            let password = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*random).into_bytes());
            add(&password)?;
            Ok(password)
        }
    }
}

/// Ownership closes the descriptor (EOF once) and zeroizes the launcher copy on
/// both success and error. The password is never an argument or environment value.
pub fn deliver(
    pipe: Option<impl std::io::Write>,
    password: Zeroizing<Vec<u8>>,
) -> std::io::Result<()> {
    let mut pipe = pipe.ok_or_else(|| std::io::Error::other("password pipe unavailable"))?;
    pipe.write_all(&password)
}

#[cfg(target_os = "macos")]
use bitsov_ffi::owner_password::{add, read, remove};
#[cfg(not(target_os = "macos"))]
fn read(_: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    Err("Local owner setup requires macOS Keychain.".into())
}
#[cfg(not(target_os = "macos"))]
fn add(_: &str, _: &[u8]) -> Result<(), String> {
    Err("Local owner setup requires macOS Keychain.".into())
}

#[cfg(not(target_os = "macos"))]
fn remove(_: &str) -> Result<(), String> { Err("Local owner setup requires macOS Keychain.".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visible_but_unsynced_binding_is_verified_and_synced_again_before_retirement() {
        use std::cell::Cell;
        let visible = Cell::new(false);
        let attempts = Cell::new(0);
        let retired = Cell::new(false);
        for fail_sync in [true, false] {
            let result = migrate(b"secret", || Ok(()), || {
                attempts.set(attempts.get() + 1);
                Ok(Zeroizing::new(b"secret".to_vec()))
            }, || {
                visible.set(true);
                if fail_sync { Err("directory sync failed".into()) } else { Ok(()) }
            }, || { retired.set(true); Ok(()) });
            assert!(visible.get());
            assert_eq!(result.is_err(), fail_sync);
            assert_eq!(retired.get(), !fail_sync);
        }
        assert_eq!(attempts.get(), 2);
    }
    #[test]
    fn migration_never_retires_legacy_until_protected_copy_and_binding_are_verified() {
        use std::cell::RefCell;
        let events = RefCell::new(Vec::new());
        migrate(b"secret", || { events.borrow_mut().push("save"); Ok(()) },
            || { events.borrow_mut().push("biometry"); Ok(Zeroizing::new(b"secret".to_vec())) },
            || { events.borrow_mut().push("bind"); Ok(()) },
            || { events.borrow_mut().push("retire"); Ok(()) }).unwrap();
        assert_eq!(*events.borrow(), ["save", "biometry", "bind", "retire"]);
        for value in [Err("cancelled".into()), Ok(Zeroizing::new(b"wrong".to_vec()))] {
            assert!(migrate(b"secret", || Ok(()), || value,
                || panic!("must not bind"), || panic!("must not delete recovery copy")).is_err());
        }
        assert!(migrate(b"secret", || Ok(()), || Ok(Zeroizing::new(b"secret".to_vec())),
            || Err("disk full".into()), || panic!("must retain legacy item")).is_err());
    }
    #[test]
    fn invalid_node_binding_never_falls_back_to_unprotected_keychain() {
        let dir = tempfile::tempdir().unwrap();
        super::super::device::write_private(&dir.path().join(BINDING_FILE), b"not json").unwrap();
        assert!(load(dir.path(), true).unwrap_err().contains("binding"));
    }
    #[test]
    fn descriptor_delivery_closes_at_eof_and_never_uses_argv_or_environment() {
        use std::io::Read;
        let mut command = std::process::Command::new("/usr/bin/wc");
        command
            .arg("-c")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        let child = shared_child::SharedChild::spawn(&mut command).unwrap();
        let password = Zeroizing::new(vec![b'x'; 44]);
        deliver(child.take_stdin(), password).unwrap();
        assert!(child.wait().unwrap().success());
        let mut output = String::new();
        child
            .take_stdout()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert_eq!(output.trim(), "44");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["-c"]);
        assert_eq!(command.get_envs().count(), 0);
        assert!(deliver(None::<std::io::Sink>, Zeroizing::new(vec![1; 44])).is_err());
    }
    #[test]
    fn stores_random_password_before_returning_and_reuses_exact_item() {
        let mut stored = Vec::new();
        let password = load_from(
            true,
            || Ok(None),
            |value| {
                stored = value.to_vec();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(password.len(), 44);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&*password)
                .unwrap()
                .len(),
            32
        );
        assert_eq!(*password, stored);
        let again = load_from(
            false,
            || Ok(Some(Zeroizing::new(stored.clone()))),
            |_| panic!("must not overwrite"),
        )
        .unwrap();
        assert_eq!(*again, stored);
    }
    #[test]
    fn missing_existing_password_access_refusal_and_save_failure_never_return_a_password() {
        assert!(load_from(false, || Ok(None), |_| panic!("must not create"))
            .unwrap_err()
            .contains("missing"));
        assert_eq!(
            load_from(true, || Err("denied".into()), |_| panic!("must not create")).unwrap_err(),
            "denied"
        );
        assert_eq!(
            load_from(true, || Ok(None), |_| Err("save failed".into())).unwrap_err(),
            "save failed"
        );
    }
}
