//! Bootstrap launcher password; shares the DP-first policy with home records.
use super::home_keychain;
use zeroize::Zeroizing;

const SERVICE: &str = "tech.mindlink.bitsov.local-owner.seed-password.v1";

pub fn read(account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let (status, length, bytes) = home_keychain::read_item(SERVICE, account, 44)
        .map_err(|_| "Invalid launcher Keychain account.")?;
    decode_password(status, length, bytes)
}

fn decode_password(status: i32, length: usize, mut bytes: Zeroizing<Vec<u8>>)
    -> Result<Option<Zeroizing<Vec<u8>>>, String>
{
    if status == -25300 { return Ok(None); }
    if status != 0 {
        return Err(format!("Keychain refused access to this app's seed password ({status})."));
    }
    if length != 44 || length > bytes.len() {
        return Err("This app's Keychain seed password is invalid; it was not replaced.".into());
    }
    bytes.truncate(length);
    Ok(Some(bytes))
}

pub fn remove(account: &str) -> Result<(), String> {
    let status = home_keychain::delete_items(SERVICE, account)
        .map_err(|_| "Invalid launcher Keychain account.")?;
    if status == 0 { Ok(()) }
    else { Err(format!("Cannot retire the launcher password ({status}).")) }
}

pub fn add(account: &str, password: &[u8]) -> Result<(), String> {
    let status = home_keychain::add_item(SERVICE, account, password)
        .map_err(|_| "Invalid launcher Keychain account.")?;
    if status == 0 { Ok(()) }
    else {
        Err(format!("Keychain could not store this app's seed password ({status}); the node was not started."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_is_distinct_from_refusal_and_invalid_lengths() {
        for status in [-34018, -25293, -128, -50] {
            assert!(decode_password(status, 44, Zeroizing::new(vec![1; 44])).is_err());
        }
        assert!(decode_password(-25300, 0, Zeroizing::new(vec![0; 44])).unwrap().is_none());
        for length in [0, 43, 45, usize::MAX] {
            assert!(decode_password(0, length, Zeroizing::new(vec![1; 44])).is_err());
        }
        assert!(decode_password(0, 44, Zeroizing::new(vec![1; 43])).is_err());
        assert_eq!(*decode_password(0, 44, Zeroizing::new(vec![1; 44])).unwrap().unwrap(), vec![1; 44]);
    }
}
