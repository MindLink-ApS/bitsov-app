//! Exact, node-scoped Keychain items. Typed secrets are saved only after acceptance and opt-in.
use bitsov_app::home_node::{BoxPin, BoxPinStore, UnlockBinding};
use bitsov_app::remote_access::RemoteError;
use zeroize::Zeroizing;

fn service(node: &str, suffix: &str) -> Result<String, String> {
    if node.len() != 64
        || !node
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid home-node identity.".into());
    }
    Ok(format!("bitsov.node.{node}.{suffix}"))
}

fn store(
    node: &str,
    suffix: &str,
    bytes: &[u8],
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<(), String> {
    let name = service(node, suffix)?;
    #[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
    {
        let _ = device_blob;
        let status = bitsov_ffi::home_keychain::store(&name, bytes, secret)
            .map_err(|_| "Invalid Keychain item.")?;
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "Keychain could not save the home-node item ({status})."
            ))
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = name;
        android_store(device_blob, node, suffix, bytes, secret, false)
    }
    #[cfg(not(any(
        target_os = "android",
        all(target_os = "macos", desktop, not(feature = "mobile"))
    )))]
    {
        let _ = (name, bytes, secret, device_blob);
        Err("Home-node unlock requires protected device storage.".into())
    }
}
#[cfg(target_os = "android")]
fn android_store(
    device_blob: Option<&[u8]>,
    node: &str,
    suffix: &str,
    bytes: &[u8],
    secret: bool,
    reenroll: bool,
) -> Result<(), String> {
    super::device_key::store_home_item(device_blob, node, suffix, bytes, secret, reenroll)
        .map_err(|error| format!("Android encrypted storage refused the home-node item: {error}"))
}
fn read(
    node: &str,
    suffix: &str,
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let name = service(node, suffix)?;
    #[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
    {
        let _ = (secret, device_blob);
        let (status, length, mut bytes) =
            bitsov_ffi::home_keychain::read(&name, 16384).map_err(|_| "Invalid Keychain item.")?;
        if status == -25300 {
            return Ok(None);
        }
        if status != 0 || length > bytes.len() {
            return Err(format!(
                "Keychain access was cancelled or unavailable ({status})."
            ));
        }
        bytes.truncate(length);
        Ok(Some(bytes))
    }
    #[cfg(target_os = "android")]
    {
        let _ = name;
        super::device_key::read_home_item(device_blob, node, suffix, secret)
            .map(|value| value.map(Zeroizing::new))
            .map_err(|error| {
                format!("Android encrypted storage refused the home-node item: {error}")
            })
    }
    #[cfg(not(any(
        target_os = "android",
        all(target_os = "macos", desktop, not(feature = "mobile"))
    )))]
    {
        let _ = (name, secret, device_blob);
        Err("Home-node unlock requires protected device storage.".into())
    }
}

pub struct MacBoxPins;
impl BoxPinStore for MacBoxPins {
    fn read(&self, node: &str) -> Result<Option<BoxPin>, RemoteError> {
        read(node, "box-transport", false, None)
            .map_err(RemoteError::Local)?
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(|_| {
                    RemoteError::Local(
                        if cfg!(target_os = "android") {
                            "Invalid box pin in Android app storage."
                        } else {
                            "Invalid box pin in Keychain."
                        }
                        .into(),
                    )
                })
            })
            .transpose()
    }
    fn save(&self, pin: &BoxPin) -> Result<(), RemoteError> {
        let verified =
            BoxPin::verify(&pin.node_id, &pin.endpoint, &pin.public_key, &pin.signature)?;
        let bytes = serde_json::to_vec(&verified)
            .map_err(|_| RemoteError::Local("Cannot encode box pin.".into()))?;
        store(&pin.node_id, "box-transport", &bytes, false, None).map_err(RemoteError::Local)
    }
}

pub fn save_binding(node: &str, binding: &UnlockBinding) -> Result<(), String> {
    store(
        node,
        "unlock-binding",
        &serde_json::to_vec(binding).map_err(|_| "Invalid unlock binding.")?,
        false,
        None,
    )
}
pub fn binding(node: &str) -> Result<UnlockBinding, String> {
    let bytes = read(node, "unlock-binding", false, None)?
        .ok_or("Reconnect once while your node is unlocked to prepare this device.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid saved unlock binding.".into())
}

/// Called by the owner ceremony or Remember after a node-accepted typed unlock.
#[cfg(not(target_os = "android"))]
pub fn save_password(node: &str, password: &[u8]) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 {
        return Err("Invalid seed password length.".into());
    }
    store(node, "seed-password", password, true, None)
}

/// Save a password under the Android device key's biometric-bound companion
/// key. Called only by `home_unlock::remember` with a password the node has
/// just accepted; it must never be exposed as a password-bearing renderer
/// command. `reenroll` is the owner's explicit choice to replace a companion
/// key Keystore has permanently invalidated.
#[cfg(target_os = "android")]
pub fn save_password_for_device(
    node: &str,
    password: &[u8],
    device_blob: &[u8],
    reenroll: bool,
) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 {
        return Err("Invalid seed password length.".into());
    }
    service(node, "seed-password")?;
    android_store(Some(device_blob), node, "seed-password", password, true, reenroll)
}

pub fn password(node: &str, device_blob: Option<&[u8]>) -> Result<Zeroizing<String>, String> {
    let bytes = read(node, "seed-password", true, device_blob)?.ok_or(
        "This device has no enrolled unlock password. Use an owner device that already has it.",
    )?;
    let invalid = if cfg!(target_os = "android") {
        "Invalid seed password in Android encrypted storage."
    } else {
        "Invalid seed password in Keychain."
    };
    let value = std::str::from_utf8(&bytes).map_err(|_| invalid)?;
    if value.is_empty() {
        return Err(invalid.into());
    }
    Ok(Zeroizing::new(value.to_owned()))
}

/// Whether this device holds a remembered password for `node`. Existence only:
/// the password is never read, unwrapped or decrypted, so no Touch ID or
/// fingerprint prompt can appear. `None` is unknown. `Some(true)` does not
/// promise the copy still opens (enrolled fingerprints may have changed).
pub fn password_remembered(node: &str) -> Option<bool> {
    let name = service(node, "seed-password").ok()?;
    #[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
    {
        match bitsov_ffi::home_keychain::exists(&name).ok()? {
            0 => Some(true),
            -25300 => Some(false),
            _ => None,
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = name;
        super::device_key::has_home_item(node, "seed-password").ok()
    }
    #[cfg(not(any(
        target_os = "android",
        all(target_os = "macos", desktop, not(feature = "mobile"))
    )))]
    {
        let _ = name;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_node_scoped_password_name_rejects_item_injection() {
        assert_eq!(
            service(&"ab".repeat(32), "seed-password").unwrap(),
            format!("bitsov.node.{}.seed-password", "ab".repeat(32))
        );
        assert_ne!(service(&"ab".repeat(32), "seed-password").unwrap(),
            service(&"cd".repeat(32), "seed-password").unwrap());
        for node in ["", "../another", "ab\0cd", &"AB".repeat(32)] {
            assert!(service(node, "seed-password").is_err());
        }
    }
}
