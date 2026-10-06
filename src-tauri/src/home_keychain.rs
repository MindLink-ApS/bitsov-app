//! Exact, node-scoped Keychain items. No renderer-supplied password or item name.
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

#[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
extern "C" {
    fn bitsov_home_store(
        service: *const std::ffi::c_char,
        bytes: *const u8,
        count: usize,
        secret: i32,
    ) -> i32;
    fn bitsov_home_read(
        service: *const std::ffi::c_char,
        output: *mut u8,
        capacity: usize,
        length: *mut usize,
    ) -> i32;
}

fn store(node: &str, suffix: &str, bytes: &[u8], secret: bool) -> Result<(), String> {
    let name = service(node, suffix)?;
    #[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
    {
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid Keychain item.")?;
        // SAFETY: all input buffers are live for this synchronous call; Swift copies
        // at most bytes.len(), retains no pointers, and creates the ACL itself.
        let status = unsafe {
            bitsov_home_store(
                name.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
                i32::from(secret),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "Keychain could not save the home-node item ({status})."
            ))
        }
    }
    #[cfg(not(all(target_os = "macos", desktop, not(feature = "mobile"))))]
    {
        let _ = (name, bytes, secret);
        Err("Home-node unlock requires macOS Keychain.".into())
    }
}
fn read(node: &str, suffix: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let name = service(node, suffix)?;
    #[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
    {
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid Keychain item.")?;
        let mut bytes = Zeroizing::new(vec![0; 16384]);
        let mut length = 0;
        // SAFETY: output is a live writable buffer of capacity bytes.len(). The
        // Swift bridge enforces capacity and does not retain pointers.
        let status = unsafe {
            bitsov_home_read(name.as_ptr(), bytes.as_mut_ptr(), bytes.len(), &mut length)
        };
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
    #[cfg(not(all(target_os = "macos", desktop, not(feature = "mobile"))))]
    {
        let _ = name;
        Err("Home-node unlock requires macOS Keychain.".into())
    }
}

pub struct MacBoxPins;
impl BoxPinStore for MacBoxPins {
    fn read(&self, node: &str) -> Result<Option<BoxPin>, RemoteError> {
        read(node, "box-transport")
            .map_err(RemoteError::Local)?
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|_| RemoteError::Local("Invalid box pin in Keychain.".into()))
            })
            .transpose()
    }
    fn save(&self, pin: &BoxPin) -> Result<(), RemoteError> {
        let verified =
            BoxPin::verify(&pin.node_id, &pin.endpoint, &pin.public_key, &pin.signature)?;
        let bytes = serde_json::to_vec(&verified)
            .map_err(|_| RemoteError::Local("Cannot encode box pin.".into()))?;
        store(&pin.node_id, "box-transport", &bytes, false).map_err(RemoteError::Local)
    }
}

pub fn save_binding(node: &str, binding: &UnlockBinding) -> Result<(), String> {
    store(
        node,
        "unlock-binding",
        &serde_json::to_vec(binding).map_err(|_| "Invalid unlock binding.")?,
        false,
    )
}
pub fn binding(node: &str) -> Result<UnlockBinding, String> {
    let bytes = read(node, "unlock-binding")?
        .ok_or("Reconnect once while your node is unlocked to prepare this device.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid saved unlock binding.".into())
}

/// Called by the existing owner ceremony (or a future approved device enrollment),
/// never by a command accepting a typed password from the renderer.
#[allow(dead_code)]
pub fn save_password(node: &str, password: &[u8]) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 {
        return Err("Invalid seed password length.".into());
    }
    store(node, "seed-password", password, true)
}
pub fn password(node: &str) -> Result<Zeroizing<String>, String> {
    let bytes = read(node, "seed-password")?.ok_or(
        "This device has no enrolled unlock password. Use an owner device that already has it.",
    )?;
    let value = std::str::from_utf8(&bytes).map_err(|_| "Invalid seed password in Keychain.")?;
    if value.is_empty() {
        return Err("Invalid seed password in Keychain.".into());
    }
    Ok(Zeroizing::new(value.to_owned()))
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
        for node in ["", "../another", "ab\0cd", &"AB".repeat(32)] {
            assert!(service(node, "seed-password").is_err());
        }
    }
}
