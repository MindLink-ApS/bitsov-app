//! Existing-path record preparation, compiled only by unit tests.
use super::*;
use std::io::Read;
use std::os::unix::fs::MetadataExt;

const HEADER: &[u8; 8] = b"BSLSS002";
const RECORD_BYTES: usize = 100;
const LEGACY_LIMIT: usize = 4096;
static RECORD_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase { TempSynced, Verified, Published, Durable, BeforeCleanup, Complete }

struct Record {
    bytes: Zeroizing<Vec<u8>>,
    seed: Zeroizing<[u8; 32]>,
    protected: bool,
}

fn local(message: &str) -> PairError { PairError::Local(message.into()) }
fn io(error: std::io::Error) -> PairError {
    PairError::Local(format!("cannot access the client identity record: {error}"))
}

fn opened(bytes: &[u8], sealer: &dyn Sealer) -> Result<Zeroizing<[u8; 32]>, PairError> {
    if bytes.len() != RECORD_BYTES || !bytes.starts_with(HEADER) {
        return Err(local("the protected client identity format is unsupported"));
    }
    let seed = sealer.open(at_rest::CLIENT_SEED_PURPOSE, bytes).map_err(PairError::Local)?;
    let seed: [u8; 32] = seed.as_slice().try_into()
        .map_err(|_| local("the protected client identity is corrupt"))?;
    Ok(Zeroizing::new(seed))
}

fn read_record(path: &Path, sealer: &dyn Sealer, legacy: bool) -> Result<Option<Record>, PairError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io(error)),
    };
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(local("the client identity record must be a regular private file"));
    }
    check_owner_only(path, "client key file")?;
    let mut bytes = Zeroizing::new(Vec::new());
    std::fs::File::open(path).map_err(io)?.take(MAX_SEALED_KEY_BYTES + 1)
        .read_to_end(&mut bytes).map_err(io)?;
    if bytes.len() > MAX_SEALED_KEY_BYTES as usize {
        return Err(local("the client identity record is oversized"));
    }
    let protected = bytes.starts_with(HEADER);
    let seed = if protected {
        opened(&bytes, sealer)?
    } else {
        if !legacy || bytes.len() > LEGACY_LIMIT {
            return Err(local("the client identity record format is unsupported"));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| local("the client identity record is corrupt"))?.trim();
        if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(local("the client identity record is corrupt"));
        }
        let decoded = Zeroizing::new(hex::decode(text)
            .map_err(|_| local("the client identity record is corrupt"))?);
        Zeroizing::new(decoded.as_slice().try_into()
            .map_err(|_| local("the client identity record is corrupt"))?)
    };
    Ok(Some(Record { bytes, seed, protected }))
}

fn sync_dir(dir: &Path) -> Result<(), PairError> {
    std::fs::File::open(dir).and_then(|file| file.sync_all()).map_err(io)
}

fn publish(
    dir: &Path,
    bytes: &[u8],
    seed: &[u8; 32],
    replace: bool,
    sealer: &dyn Sealer,
    checkpoint: &mut dyn FnMut(Phase) -> Result<(), PairError>,
) -> Result<(), PairError> {
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(io)?;
    temp.write_all(bytes).and_then(|()| temp.as_file().sync_all()).map_err(io)?;
    checkpoint(Phase::TempSynced)?;
    let reopened = read_record(temp.path(), sealer, false)?
        .ok_or_else(|| local("the temporary client identity is absent"))?;
    if *reopened.seed != *seed {
        return Err(local("the protected client identity does not reopen to the same key"));
    }
    checkpoint(Phase::Verified)?;
    if replace {
        temp.persist(dir.join(KEY_FILE)).map_err(|error| io(error.error))?;
    } else {
        temp.persist_noclobber(dir.join(KEY_FILE)).map_err(|error| io(error.error))?;
    }
    checkpoint(Phase::Published)?;
    sync_dir(dir)?;
    checkpoint(Phase::Durable)
}

fn load(dir: &Path, sealer: Option<&dyn Sealer>) -> Result<ClientKey, PairError> {
    load_with(dir, sealer, &mut |_| Ok(()))
}

fn load_with(
    dir: &Path,
    sealer: Option<&dyn Sealer>,
    checkpoint: &mut dyn FnMut(Phase) -> Result<(), PairError>,
) -> Result<ClientKey, PairError> {
    let sealer = at_rest::linux::required(sealer).map_err(PairError::Local)?;
    let _lock = RECORD_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    restrict_dir(dir)?;
    let primary = read_record(&dir.join(KEY_FILE), &sealer, true)?;
    let secondary = read_record(&dir.join(SEALED_KEY_FILE), &sealer, false)?;
    let seed = if let Some(secondary) = &secondary {
        if let Some(primary) = &primary {
            if *primary.seed != *secondary.seed {
                return Err(local("the client identity records disagree"));
            }
        }
        if let Some(primary) = primary.as_ref().filter(|record| record.protected) {
            sync_dir(dir)?;
            checkpoint(Phase::Durable)?;
            primary.seed.clone()
        } else {
            publish(dir, &secondary.bytes, &secondary.seed, primary.is_some(), &sealer, checkpoint)?;
            secondary.seed.clone()
        }
    } else if let Some(primary) = primary.as_ref().filter(|record| record.protected) {
        primary.seed.clone()
    } else {
        let seed = match &primary {
            Some(primary) => primary.seed.clone(),
            None => {
                let mut seed = Zeroizing::new([0; 32]);
                getrandom::fill(&mut seed[..])
                    .map_err(|_| local("no randomness for the client identity"))?;
                seed
            }
        };
        let bytes = sealer.seal(at_rest::CLIENT_SEED_PURPOSE, &seed[..]).map_err(PairError::Local)?;
        publish(dir, &bytes, &seed, primary.is_some(), &sealer, checkpoint)?;
        seed
    };
    if secondary.is_some() {
        checkpoint(Phase::BeforeCleanup)?;
        std::fs::remove_file(dir.join(SEALED_KEY_FILE)).map_err(io)?;
        sync_dir(dir)?;
    }
    checkpoint(Phase::Complete)?;
    Ok(ClientKey::from_seed(*seed))
}

mod tests;
