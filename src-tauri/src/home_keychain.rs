//! Exact, profile- and node-scoped Keychain items. Secrets require acceptance and opt-in.
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
    #[cfg(any(target_os = "ios", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    {
        let _ = device_blob;
        let name = crate::profile::current()?.keychain_service(&name);
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
    #[cfg(windows)]
    {
        let _ = name;
        windows_store(windows_root()?, node, suffix, bytes, secret, device_blob)
    }
    #[cfg(not(any(
        windows,
        target_os = "android",
        target_os = "ios",
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
    #[cfg(any(target_os = "ios", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    {
        let _ = (secret, device_blob);
        let name = crate::profile::current()?.keychain_service(&name);
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
    #[cfg(windows)]
    {
        let _ = name;
        windows_read(windows_root()?, node, suffix, secret, device_blob)
    }
    #[cfg(not(any(
        windows,
        target_os = "android",
        target_os = "ios",
        all(target_os = "macos", desktop, not(feature = "mobile"))
    )))]
    {
        let _ = (name, secret, device_blob);
        Err("Home-node unlock requires protected device storage.".into())
    }
}

/// Windows keeps only the two public home-node records, as owner-only files
/// under `app-client/home-node-store-v1/<blake3(node)>/`. Secrets, device
/// blobs and every other item still require protected device storage.
#[cfg(windows)]
static WINDOWS_PAIRING_STORE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Set once at startup to the private pairing folder (`app-client`).
#[cfg(windows)]
pub fn set_windows_pairing_store(store: &std::path::Path) -> Result<(), String> {
    WINDOWS_PAIRING_STORE
        .set(store.to_path_buf())
        .map_err(|_| "Home-node storage was set up twice.".into())
}

#[cfg(windows)]
fn windows_root() -> Result<&'static std::path::Path, String> {
    WINDOWS_PAIRING_STORE
        .get()
        .map(|path| path.as_path())
        .ok_or_else(|| "Home-node unlock requires protected device storage.".into())
}

#[cfg(windows)]
const WINDOWS_RECORD_BYTES: u64 = 16384;

/// The record's folder and file, or the usual refusal for anything that is
/// not one of the two public records.
#[cfg(windows)]
fn windows_record(
    store: &std::path::Path,
    node: &str,
    suffix: &str,
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    service(node, suffix)?;
    if secret || device_blob.is_some() || !matches!(suffix, "box-transport" | "unlock-binding") {
        return Err("Home-node unlock requires protected device storage.".into());
    }
    let dir = store
        .join("home-node-store-v1")
        .join(blake3::hash(node.as_bytes()).to_hex().as_str());
    let file = dir.join(format!("{suffix}.json"));
    Ok((dir, file))
}

#[cfg(windows)]
fn windows_store(
    store: &std::path::Path,
    node: &str,
    suffix: &str,
    bytes: &[u8],
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<(), String> {
    let (dir, file) = windows_record(store, node, suffix, secret, device_blob)?;
    if bytes.is_empty() || bytes.len() as u64 > WINDOWS_RECORD_BYTES {
        return Err("Invalid home-node item.".into());
    }
    let refused = |_| "Could not save the home-node item in private storage.".to_string();
    // Each level gets its own protected descriptor; none is inherited.
    for level in [store.to_path_buf(), store.join("home-node-store-v1"), dir.clone()] {
        crate::private_fs::ensure_dir(&level).map_err(refused)?;
    }
    crate::private_fs::write_new(&dir.join(format!("{suffix}.json.tmp")), &file, bytes, true).map_err(refused)
}

#[cfg(windows)]
fn windows_read(
    store: &std::path::Path,
    node: &str,
    suffix: &str,
    secret: bool,
    device_blob: Option<&[u8]>,
) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let (_, file) = windows_record(store, node, suffix, secret, device_blob)?;
    crate::private_fs::read_optional(&file, WINDOWS_RECORD_BYTES)
        .map_err(|_| "Could not read the home-node item from private storage.".into())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    const NODE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn elevated() -> bool {
        bitsov_ffi::win_private::elevation_gate().is_err()
    }

    fn store_dir(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("bitsov-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.join("app-client")
    }

    #[test]
    fn public_records_round_trip_and_secrets_stay_refused() {
        if elevated() {
            return;
        }
        let store = store_dir("round-trip");
        for suffix in ["box-transport", "unlock-binding"] {
            assert!(windows_read(&store, NODE, suffix, false, None).unwrap().is_none());
            windows_store(&store, NODE, suffix, b"{\"v\":1}", false, None).unwrap();
            windows_store(&store, NODE, suffix, b"{\"v\":2}", false, None).unwrap();
            assert_eq!(windows_read(&store, NODE, suffix, false, None).unwrap().unwrap().as_slice(), b"{\"v\":2}");
        }
        for (suffix, secret, blob) in [
            ("seed-password", true, None),
            ("box-transport", true, None),
            ("unlock-binding", false, Some(&b"blob"[..])),
            ("other", false, None),
        ] {
            assert!(windows_store(&store, NODE, suffix, b"x", secret, blob).is_err());
            assert!(windows_read(&store, NODE, suffix, secret, blob).is_err());
        }
        assert!(windows_store(&store, "not-a-node", "box-transport", b"x", false, None).is_err());
    }

    #[test]
    fn a_tampered_record_is_refused_and_left_unchanged() {
        if elevated() {
            return;
        }
        let store = store_dir("tampered");
        windows_store(&store, NODE, "box-transport", b"{}", false, None).unwrap();
        let (dir, file) = windows_record(&store, NODE, "box-transport", false, None).unwrap();
        // Replace the record with an ordinary file, which inherits its access list.
        std::fs::remove_file(&file).unwrap();
        std::fs::write(&file, b"planted").unwrap();
        assert!(windows_read(&store, NODE, "box-transport", false, None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"planted");
        // Extra access entry on a record this layer wrote.
        windows_store(&store, NODE, "unlock-binding", b"{}", false, None).unwrap();
        let (_, binding) = windows_record(&store, NODE, "unlock-binding", false, None).unwrap();
        crate::private_fs::fixtures::grant_everyone_read(&binding);
        assert!(windows_read(&store, NODE, "unlock-binding", false, None).is_err());
        assert_eq!(std::fs::read(&binding).unwrap(), b"{}");
        // Wrong owner: a system folder is never accepted as the store.
        let foreign = crate::private_fs::fixtures::foreign_owned_dir();
        assert!(windows_store(&foreign, NODE, "box-transport", b"{}", false, None).is_err());
        // A leftover scratch file blocks a save instead of being reused.
        std::fs::write(dir.join("unlock-binding.json.tmp"), b"leftover").unwrap();
        assert!(windows_store(&store, NODE, "unlock-binding", b"{}", false, None).is_err());
        assert_eq!(std::fs::read(dir.join("unlock-binding.json.tmp")).unwrap(), b"leftover");
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
