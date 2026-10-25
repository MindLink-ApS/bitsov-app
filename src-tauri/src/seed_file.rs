//! Local seed-file protection using the node's versioned at-rest format.
use std::path::Path;
use zeroize::Zeroizing;
use super::device;

const FAILURE: &str = "Could not protect the local recovery phrase. Restore Keychain access and check the node files before unlocking.";

pub fn initialize(program: &Path, data_dir: &Path, password: Zeroizing<Vec<u8>>) -> Result<(), String> {
    use super::{SharedChild, owner_password, local_owner};
    let mut cmd = std::process::Command::new(program);
    cmd.args(["init", "--dir"]).arg(data_dir)
        .args(["--non-interactive", "--tier", "full", "--password-fd", "0"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let child = SharedChild::spawn(&mut cmd).map_err(|_| "Could not initialize the protected local node.")?;
    if owner_password::deliver(child.take_stdin(), password).is_err() {
        let _ = child.kill(); let _ = child.wait();
        return Err("The seed password pipe failed; setup was stopped.".into());
    }
    if !child.wait().map_err(|_| "Local node setup did not finish.")?.success() {
        return Err("Protected local node setup failed; no plaintext fallback was attempted.".into());
    }
    local_owner::protect_config(&data_dir.join("konsensus.toml"), true)
}

fn key(password: &[u8], salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = argon2::Params::new(64 * 1024, 3, 1, Some(32)).map_err(|_| FAILURE)?;
    let mut key = Zeroizing::new([0; 32]);
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(password, salt, &mut *key).map_err(|_| FAILURE)?;
    Ok(key)
}
fn decrypt(bytes: &[u8], password: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    use ring::aead;
    if bytes.len() < 45 || bytes[0] != 1 { return Err(FAILURE.into()); }
    let key = key(password, &bytes[1..17])?;
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &*key).map_err(|_| FAILURE)?);
    let nonce = aead::Nonce::try_assume_unique_for_key(&bytes[17..29]).map_err(|_| FAILURE)?;
    let mut plain = Zeroizing::new(bytes[29..].to_vec());
    let len = key.open_in_place(nonce, aead::Aad::empty(), &mut plain).map_err(|_| FAILURE)?.len();
    plain.truncate(len);
    Ok(plain)
}
pub(super) fn encrypt(phrase: &[u8], password: &[u8]) -> Result<Vec<u8>, String> {
    use ring::aead;
    let mut header = [0u8; 29];
    header[0] = 1;
    getrandom::getrandom(&mut header[1..]).map_err(|_| FAILURE)?;
    let key = key(password, &header[1..17])?;
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &*key).map_err(|_| FAILURE)?);
    let nonce = aead::Nonce::try_assume_unique_for_key(&header[17..]).map_err(|_| FAILURE)?;
    let mut sealed = Zeroizing::new(phrase.to_vec());
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut *sealed).map_err(|_| FAILURE)?;
    Ok([header.as_slice(), sealed.as_slice()].concat())
}
fn private_bytes(path: &Path) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.is_file() || meta.len() > 8192 { return Err(FAILURE.into()); }
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() != 1 { return Err(FAILURE.into()); }
        }
    }
    device::read_private(path).map(|v| v.map(Zeroizing::new)).map_err(|_| FAILURE.into())
}
pub fn config_value(config: &Path) -> Result<toml::Value, String> {
    let text = Zeroizing::new(std::fs::read_to_string(config).map_err(|_| FAILURE)?);
    toml::from_str(&text).map_err(|_| FAILURE.into())
}
pub fn mnemonic_path(config: &Path) -> Result<std::path::PathBuf, String> {
    let value = config_value(config)?;
    let path = value.get("identity").and_then(|v| v.get("mnemonic_file")).and_then(|v| v.as_str()).ok_or(FAILURE)?;
    let path = Path::new(path);
    Ok(if path.is_absolute() { path.to_path_buf() } else { config.parent().ok_or(FAILURE)?.join(path) })
}
pub fn save_config(config: &Path, value: &toml::Value) -> Result<(), String> {
    use std::io::Write;
    let dir = config.parent().ok_or(FAILURE)?;
    let text = Zeroizing::new(toml::to_string_pretty(value).map_err(|_| FAILURE)?);
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|_| FAILURE)?;
    tmp.write_all(text.as_bytes()).and_then(|()| tmp.as_file().sync_all()).map_err(|_| FAILURE)?;
    tmp.persist(config).map_err(|_| FAILURE)?;
    std::fs::File::open(dir).and_then(|dir| dir.sync_all()).map_err(|_| FAILURE.into())
}

fn sync_encrypted(path: &Path) -> Result<(), String> {
    // Reused ciphertext may have been copied by another process. Verification
    // alone does not prove its contents are durable before plaintext retirement.
    std::fs::File::open(path).and_then(|file| file.sync_all()).map_err(|_| FAILURE)?;
    std::fs::File::open(path.parent().ok_or(FAILURE)?).and_then(|dir| dir.sync_all()).map_err(|_| FAILURE.into())
}

/// Called before the child starts, after Keychain unlock. A crash after removing
/// plaintext but before saving config is recovered from the verified .enc sibling.
pub fn protect(config: &Path, password: &[u8]) -> Result<(), String> {
    let password_text = std::str::from_utf8(password).map_err(|_| FAILURE)?;
    if password_text.trim().is_empty() { return Err(FAILURE.into()); }
    let path = mnemonic_path(config)?;
    if path.extension().is_some_and(|ext| ext == "enc") {
        let legacy = private_bytes(&path.with_extension("txt"))?;
        if let Some(bytes) = private_bytes(&path)? {
            let verified = decrypt(&bytes, password)?;
            if let Some(legacy) = legacy {
                if std::str::from_utf8(&legacy).map_err(|_| FAILURE)?.trim().as_bytes() != verified.as_slice() { return Err(FAILURE.into()); }
                sync_encrypted(&path)?;
                std::fs::remove_file(path.with_extension("txt")).map_err(|_| FAILURE)?;
                std::fs::File::open(path.parent().ok_or(FAILURE)?).and_then(|dir| dir.sync_all()).map_err(|_| FAILURE)?;
            }
        } else if legacy.is_some() { return Err(FAILURE.into()); }
        return Ok(());
    }
    #[cfg(unix)]
    if std::os::unix::net::UnixStream::connect(config.with_file_name("control.sock")).is_ok() {
        return Err("Stop the local node before protecting its recovery phrase.".into());
    }
    let encrypted = path.with_extension("enc");
    if encrypted == config || path == config { return Err(FAILURE.into()); }
    let phrase = private_bytes(&path)?;
    let existing = private_bytes(&encrypted)?;
    if phrase.is_none() && existing.is_none() {
        return Err("The local recovery phrase is missing; no new identity was created.".into());
    }
    if let Some(phrase) = &phrase {
        let words = std::str::from_utf8(phrase).map_err(|_| FAILURE)?.trim();
        bip39::Mnemonic::parse_in_normalized(bip39::Language::English, words).map_err(|_| FAILURE)?;
        if existing.is_none() {
            use std::io::Write;
            let bytes = encrypt(words.as_bytes(), password)?;
            let parent = encrypted.parent().ok_or(FAILURE)?;
            let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|_| FAILURE)?;
            tmp.write_all(&bytes).and_then(|()| tmp.as_file().sync_all()).map_err(|_| FAILURE)?;
            tmp.persist_noclobber(&encrypted).map_err(|_| FAILURE)?;
            std::fs::File::open(parent).and_then(|dir| dir.sync_all()).map_err(|_| FAILURE)?;
        }
    }
    let bytes = private_bytes(&encrypted)?.ok_or(FAILURE)?;
    let verified = decrypt(&bytes, password)?;
    let verified_words = std::str::from_utf8(&verified).map_err(|_| FAILURE)?;
    bip39::Mnemonic::parse_in_normalized(bip39::Language::English, verified_words).map_err(|_| FAILURE)?;
    sync_encrypted(&encrypted)?;
    if let Some(phrase) = phrase {
        if std::str::from_utf8(&phrase).map_err(|_| FAILURE)?.trim().as_bytes() != verified.as_slice() { return Err(FAILURE.into()); }
        std::fs::remove_file(&path).map_err(|_| FAILURE)?;
        std::fs::File::open(path.parent().ok_or(FAILURE)?).and_then(|dir| dir.sync_all()).map_err(|_| FAILURE)?;
    }
    let mut value = config_value(config)?;
    value["identity"]["mnemonic_file"] = encrypted.to_str().ok_or(FAILURE)?.into();
    save_config(config, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::device;
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn real_node_setup_and_migrated_seed_share_the_encrypted_format() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let Some(binary) = std::env::var_os("BITSOV_OWNER_TEST_BINARY") else { return; };
        let dir = tempfile::tempdir().unwrap();
        let password = b"a sufficiently long password";
        initialize(Path::new(&binary), dir.path(), Zeroizing::new(password.to_vec())).unwrap();
        let config = dir.path().join("konsensus.toml");
        let path = mnemonic_path(&config).unwrap();
        assert!(path.extension().is_some_and(|ext| ext == "enc"));
        assert!(!path.with_extension("txt").exists());
        // The independent node CLI wrote this ciphertext; the host must open it.
        let phrase = decrypt(&std::fs::read(&path).unwrap(), password).unwrap();
        let signature = |path: &Path| {
            let mut child = Command::new(&binary).args(["sign-challenge", "--challenge", "bitsov-auth-v1:0000000000000000000000000000000000000000000000000000000000000000:9999999999", "--mnemonic"])
                .arg(path).args(["--password-fd", "0"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
            child.stdin.take().unwrap().write_all(password).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "node refused the protected seed");
            output.stdout
        };
        let before = signature(&path);
        assert_eq!(before.len(), 129);
        std::fs::remove_file(&path).unwrap();
        let plaintext = path.with_extension("txt");
        device::write_private(&plaintext, &phrase).unwrap();
        let mut value = config_value(&config).unwrap();
        value["identity"]["mnemonic_file"] = plaintext.to_str().unwrap().into();
        save_config(&config, &value).unwrap();
        protect(&config, password).unwrap();
        assert!(!plaintext.exists());
        assert_eq!(signature(&mnemonic_path(&config).unwrap()), before);
    }

    #[test]
    fn legacy_unlock_encrypts_and_removes_plaintext_and_can_unlock_again() {
        let dir = tempfile::tempdir().unwrap();
        let seed = dir.path().join("mnemonic.txt");
        let config = dir.path().join("konsensus.toml");
        device::write_private(&seed, PHRASE.as_bytes()).unwrap();
        std::fs::write(&config, "[identity]\nmnemonic_file = 'mnemonic.txt'\n").unwrap();
        protect(&config, b"a sufficiently long password").unwrap();
        assert!(!seed.exists());
        let encrypted = std::fs::read(seed.with_extension("enc")).unwrap();
        assert!(!encrypted.windows(PHRASE.len()).any(|v| v == PHRASE.as_bytes()));
        assert_eq!(encrypted[0], 1);
        let value: toml::Value = toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(value["identity"]["mnemonic_file"].as_str(), seed.with_extension("enc").to_str());
        protect(&config, b"a sufficiently long password").unwrap();
        assert!(protect(&config, b"wrong password").is_err());
    }
    #[test]
    fn encryption_refusals_leave_the_original_phrase_and_config_intact() {
        let dir = tempfile::tempdir().unwrap();
        let seed = dir.path().join("mnemonic.txt");
        let config = dir.path().join("konsensus.toml");
        let original = "[identity]\nmnemonic_file = 'mnemonic.txt'\n";
        device::write_private(&seed, PHRASE.as_bytes()).unwrap();
        std::fs::write(&config, original).unwrap();
        for password in [b"".as_slice(), b"   "] {
            assert!(protect(&config, password).is_err());
            assert!(!seed.with_extension("enc").exists());
        }
        device::write_private(&seed.with_extension("enc"), b"existing encrypted identity").unwrap();
        assert!(protect(&config, b"a sufficiently long password").is_err());
        assert_eq!(std::fs::read_to_string(&seed).unwrap(), PHRASE);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
    }
    #[cfg(unix)]
    #[test]
    fn migration_never_follows_a_seed_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("outside.txt");
        device::write_private(&source, PHRASE.as_bytes()).unwrap();
        std::os::unix::fs::symlink(&source, dir.path().join("mnemonic.txt")).unwrap();
        let config = dir.path().join("konsensus.toml");
        std::fs::write(&config, "[identity]\nmnemonic_file = 'mnemonic.txt'\n").unwrap();
        assert!(protect(&config, b"a sufficiently long password").is_err());
        assert_eq!(std::fs::read_to_string(source).unwrap(), PHRASE);
    }
    #[test]
    fn interrupted_migration_recovers_without_replacing_the_encrypted_copy() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("konsensus.toml");
        let seed = dir.path().join("mnemonic.txt");
        let bytes = encrypt(PHRASE.as_bytes(), b"a sufficiently long password").unwrap();
        device::write_private(&seed.with_extension("enc"), &bytes).unwrap();
        std::fs::write(&config, "[identity]\nmnemonic_file = 'mnemonic.txt'\n").unwrap();
        protect(&config, b"a sufficiently long password").unwrap();
        assert_eq!(std::fs::read(seed.with_extension("enc")).unwrap(), bytes);
        assert!(!seed.exists());
        assert!(mnemonic_path(&config).unwrap().extension().is_some_and(|ext| ext == "enc"));
    }
    #[test]
    fn encrypted_unlock_retires_only_a_matching_legacy_plaintext_copy() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("konsensus.toml");
        let seed = dir.path().join("mnemonic.txt");
        let bytes = encrypt(PHRASE.as_bytes(), b"a sufficiently long password").unwrap();
        device::write_private(&seed.with_extension("enc"), &bytes).unwrap();
        std::fs::write(&config, "[identity]\nmnemonic_file = 'mnemonic.enc'\n").unwrap();
        device::write_private(&seed, PHRASE.as_bytes()).unwrap();
        assert!(protect(&config, b"wrong password").is_err());
        assert!(seed.exists());
        protect(&config, b"a sufficiently long password").unwrap();
        assert!(!seed.exists());
        device::write_private(&seed, b"another identity").unwrap();
        assert!(protect(&config, b"a sufficiently long password").is_err());
        assert!(seed.exists());
    }
}
