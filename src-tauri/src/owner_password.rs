//! One app-owned generic Keychain item per sidecar data directory. No CLI helper,
//! password file, environment value, broad query, update, or delete operation.
use base64::Engine;
use std::path::Path;
use zeroize::Zeroizing;

pub fn load(data_dir: &Path, allow_create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    let account = blake3::hash(data_dir.as_os_str().as_encoded_bytes())
        .to_hex()
        .to_string();
    load_from(
        allow_create,
        || read(&account),
        |password| add(&account, password),
    )
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
mod native {
    use super::*;
    use std::ffi::c_void;
    // Default Keychain ACL restricts the item to the creating application. Signing
    // and hardened runtime remain release requirements; unsigned dev is weaker.
    const SERVICE: &[u8] = b"tech.mindlink.bitsov.local-owner.seed-password.v1";
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainFindGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            len: *mut u32,
            data: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            len: u32,
            data: *const u8,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attrs: *mut c_void, data: *mut c_void) -> i32;
    }
    pub fn read(account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let mut len = 0;
        let mut ptr = std::ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                std::ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                &mut len,
                &mut ptr,
                std::ptr::null_mut(),
            )
        };
        if status == -25300 {
            return Ok(None);
        } // errSecItemNotFound only
        if status != 0 {
            return Err(format!(
                "Keychain refused access to this app's seed password ({status})."
            ));
        }
        let password = if ptr.is_null() || len != 44 {
            None
        } else {
            Some(Zeroizing::new(
                unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }.to_vec(),
            ))
        };
        if !ptr.is_null() {
            // Erase the Security framework's returned allocation before freeing.
            unsafe {
                use zeroize::Zeroize;
                std::slice::from_raw_parts_mut(ptr as *mut u8, len as usize).zeroize();
                SecKeychainItemFreeContent(std::ptr::null_mut(), ptr);
            }
        }
        password.map(Some).ok_or_else(|| {
            "This app's Keychain seed password is invalid; it was not replaced.".into()
        })
    }
    pub fn add(account: &str, password: &[u8]) -> Result<(), String> {
        let status = unsafe {
            SecKeychainAddGenericPassword(
                std::ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                password.len() as u32,
                password.as_ptr(),
                std::ptr::null_mut(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("Keychain could not store this app's seed password ({status}); the node was not started."))
        }
    }
}
#[cfg(target_os = "macos")]
use native::{add, read};
#[cfg(not(target_os = "macos"))]
fn read(_: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    Err("Local owner setup requires macOS Keychain.".into())
}
#[cfg(not(target_os = "macos"))]
fn add(_: &str, _: &[u8]) -> Result<(), String> {
    Err("Local owner setup requires macOS Keychain.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
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
