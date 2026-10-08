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

pub fn save(box_key: &str, password: &[u8]) -> Result<(), String> {
    home_keychain::save_password(&escrow_id(box_key)?, password)
}

#[cfg(target_os = "macos")]
pub fn forget(box_key: &str) -> Result<(), String> {
    let name = format!(
        "bitsov.node.{}.seed-password.wrapped-v1",
        escrow_id(box_key)?
    );
    let status = bitsov_ffi::home_keychain::delete_items(&name, "BitSov")
        .map_err(|_| "Invalid setup envelope.")?;
    if status != 0 {
        return Err("Could not remove the provisional setup envelope.".into());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub fn forget(_: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
