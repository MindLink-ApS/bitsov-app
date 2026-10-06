//! The retained rc7 page-price repair. Call only after local startup refusal and consent.
use serde::Deserialize;
use std::{fs, io::Write, path::Path};

pub fn refusal(line: &str) -> bool {
    // Match the node's validation diagnostic, allowing its error-context prefix.
    // Do not match other keys, floors (e.g. 10000), or arbitrary mentions.
    const DIAGNOSTIC: &str = "pricing.web_content_msat must be at least 1000 msat (1 sat): porch read floor (BROWSE.md §3)";
    let line = line.trim();
    line.strip_suffix(DIAGNOSTIC)
        .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with(": "))
        || line == "web_content_msat must be at least 1000"
        || line == "Error: web_content_msat must be at least 1000"
}

fn updated_config(original: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Config {
        pricing: Pricing,
    }
    #[derive(Deserialize)]
    struct Pricing {
        web_content_msat: toml::Spanned<i64>,
    }
    let parsed: Config = toml::from_str(original)
        .map_err(|_| "Cannot safely read the existing page price.".to_string())?;
    let price = parsed.pricing.web_content_msat;
    // The consent copy describes the retained rc7 default, not a different
    // operator price. Fail closed if someone has changed it since the refusal.
    if *price.get_ref() != 50 {
        return Err(
            "The page price is no longer the old 0.05 sat setting; no settings were changed."
                .into(),
        );
    }
    let mut updated = original.to_owned();
    updated.replace_range(price.span(), "1000");
    Ok(updated)
}

pub fn repair(config: &Path) -> Result<(), String> {
    fn write(config: &Path) -> Result<(), String> {
        let metadata = fs::symlink_metadata(config).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file()
            || config.file_name().is_none_or(|n| n != "konsensus.toml")
        {
            return Err("The managed node config must be a regular konsensus.toml file.".into());
        }
        let original = fs::read_to_string(config).map_err(|e| e.to_string())?;
        let updated = updated_config(&original)?;
        let parent = config.parent().ok_or("node config directory is unknown")?;
        let backup = config.with_extension("toml.bak");
        let prepare = |contents: &str| -> Result<tempfile::NamedTempFile, String> {
            let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            temp.write_all(contents.as_bytes())
                .map_err(|e| e.to_string())?;
            temp.as_file()
                .set_permissions(metadata.permissions())
                .map_err(|e| e.to_string())?;
            temp.as_file().sync_all().map_err(|e| e.to_string())?;
            Ok(temp)
        };
        // A retry may reuse the identical backup, but must never overwrite an
        // earlier backup or follow a backup symlink.
        match fs::symlink_metadata(&backup) {
            Ok(meta)
                if meta.file_type().is_file()
                    && fs::read(&backup).map_err(|e| e.to_string())? == original.as_bytes() => {}
            Ok(_) => {
                return Err(
                    "The settings backup already exists and differs; no settings were changed."
                        .into(),
                )
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                prepare(&original)?
                    .persist_noclobber(&backup)
                    .map_err(|e| e.to_string())?;
            }
            Err(e) => return Err(e.to_string()),
        }
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        let temp = prepare(&updated)?;
        // Avoid clobbering an intervening edit during backup preparation.
        if fs::symlink_metadata(config)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
            || fs::read(config).map_err(|e| e.to_string())? != original.as_bytes()
        {
            return Err(
                "The node settings changed during repair; please review them again.".into(),
            );
        }
        temp.persist(config).map_err(|e| e.to_string())?;
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    write(config).map_err(|e| format!("Page-price update failed; your node remains stopped. {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../tests/fixtures/rc7-pricing.toml");

    #[test]
    fn preserves_all_bytes_except_the_target_value_including_crlf() {
        for original in [FIXTURE.to_owned(), FIXTURE.replace('\n', "\r\n")] {
            assert_eq!(
                updated_config(&original).unwrap(),
                original.replacen("=  50 #", "=  1000 #", 1)
            );
        }
        // A parser span, rather than line matching, also handles quoted keys
        // and ignores fake table/key text inside multiline strings.
        let input = "note = '''\n[pricing]\nweb_content_msat = 50\n'''\n[\"pricing\"]\n'web_content_msat' = 5_0 # keep\n";
        assert_eq!(
            updated_config(input).unwrap(),
            input.replace("= 5_0 #", "= 1000 #")
        );
    }

    #[test]
    fn never_rewrites_other_prices_missing_keys_or_invalid_toml() {
        for input in [
            FIXTURE.replace("=  50 #", "=  1000 #"),
            FIXTURE.replace("=  50 #", "=  9000 #"),
            FIXTURE.replace("=  50 #", "=  999 #"),
            FIXTURE.replace("=  50 #", "=  '50' #"),
            "[web]\nweb_content_msat = 50\n".into(),
            "[pricing]\nweb_content_msat = 50\nweb_content_msat = 60\n".into(),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let config = dir.path().join("konsensus.toml");
            fs::write(&config, &input).unwrap();
            assert!(repair(&config).is_err());
            assert_eq!(fs::read_to_string(&config).unwrap(), input);
            assert!(!config.with_extension("toml.bak").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replacement_preserves_backup_permissions_and_old_open_file() {
        use std::io::Read;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("konsensus.toml");
        fs::write(&config, FIXTURE).unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        let mut old = fs::File::open(&config).unwrap();
        repair(&config).unwrap();
        let mut retained = String::new();
        old.read_to_string(&mut retained).unwrap();
        assert_eq!(
            retained, FIXTURE,
            "replacement must not truncate the old inode"
        );
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            FIXTURE.replacen("=  50 #", "=  1000 #", 1)
        );
        assert_eq!(
            fs::read_to_string(config.with_extension("toml.bak")).unwrap(),
            FIXTURE
        );
        for path in [&config, &config.with_extension("toml.bak")] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_and_preserves_preexisting_backups() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let external = dir.path().join("external.toml");
        let config = dir.path().join("konsensus.toml");
        let backup = config.with_extension("toml.bak");
        fs::write(&external, FIXTURE).unwrap();
        symlink(&external, &config).unwrap();
        assert!(repair(&config).is_err());
        fs::remove_file(&config).unwrap();
        fs::write(&config, FIXTURE).unwrap();
        symlink(&external, &backup).unwrap();
        assert!(repair(&config).is_err());
        fs::remove_file(&backup).unwrap();
        fs::write(&backup, "older backup").unwrap();
        assert!(repair(&config).is_err());
        assert_eq!(fs::read_to_string(&backup).unwrap(), "older backup");
        assert_eq!(fs::read_to_string(&config).unwrap(), FIXTURE);
        assert_eq!(fs::read_to_string(&external).unwrap(), FIXTURE);
        // Retrying after a backup-only interruption is safe.
        fs::write(&backup, FIXTURE).unwrap();
        repair(&config).unwrap();
        assert_eq!(fs::read_to_string(&backup).unwrap(), FIXTURE);
    }
}
