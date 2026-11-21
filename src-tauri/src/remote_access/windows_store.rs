//! Windows storage for the remote-access descriptor, on the private-file layer.
//!
//! The descriptor is only ever stored with its pairing code sealed. Without a
//! sealer nothing is serialized and no folder or file is touched. An existing
//! descriptor must verify before it is replaced; the new one is written to a
//! new private scratch file, read back through the same handle (including the
//! sealed code) and published by handle.

use std::path::Path;

use super::{
    open_sealed_code, pairing, stored_bytes, RemoteDescriptor, RemoteError, MAX_LINK_BYTES,
    REMOTE_CONFIG_FILE,
};
use crate::at_rest::Sealer;

pub(super) fn persist_with(
    path: &Path,
    descriptor: &RemoteDescriptor,
    sealer: Option<&dyn Sealer>,
) -> Result<(), RemoteError> {
    // Seal and serialize first: a missing sealer or a failed seal touches no file.
    let sealer =
        sealer.ok_or_else(|| RemoteError::Local(pairing::key::NO_PROTECTED_STORAGE.into()))?;
    let bytes = stored_bytes(descriptor, Some(sealer))?;
    if bytes.len() > MAX_LINK_BYTES {
        return Err(RemoteError::Local(
            "the remote access descriptor is oversized".into(),
        ));
    }
    let dir = path
        .parent()
        .ok_or_else(|| RemoteError::Local("remote config has no parent directory".into()))?;
    pairing::key::restrict_dir(dir).map_err(|e| RemoteError::Local(e.to_string()))?;
    crate::private_fs::write_replacing_verified(
        &dir.join(format!("{REMOTE_CONFIG_FILE}.tmp")),
        path,
        &bytes,
        |error| RemoteError::Local(format!("cannot persist remote descriptor: {error}")),
        |readback| {
            if descriptor.code.is_some() {
                let stored = serde_json::from_slice(readback).map_err(|_| {
                    RemoteError::Local("cannot verify protected pairing code".into())
                })?;
                let (opened, _) = open_sealed_code(stored, Some(sealer))?;
                if opened.code != descriptor.code {
                    return Err(RemoteError::Local(
                        "protected pairing code does not reopen to the same code".into(),
                    ));
                }
            }
            Ok(())
        },
    )
}

/// The descriptor file's bytes, read through one verified handle.
pub(super) fn read_descriptor_file(path: &Path) -> std::io::Result<Vec<u8>> {
    crate::private_fs::read(path, MAX_LINK_BYTES as u64).map(|bytes| bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::private_fs::fixtures::temp_root;

    #[test]
    fn no_sealer_touches_nothing_and_never_serializes_the_code() {
        let descriptor: RemoteDescriptor = serde_json::from_value(serde_json::json!({
            "v": 1, "endpoint": "https://node.example:8443", "node_id": "node",
            "transport_pubkey": "00", "transport_signature": "00", "code": "one-time",
        }))
        .unwrap();
        let dir = temp_root("no-sealer-descriptor").join("remote-access");
        let error = persist_with(&dir.join("descriptor.json"), &descriptor, None).unwrap_err();
        assert!(
            error
                .to_string()
                .contains(pairing::key::NO_PROTECTED_STORAGE),
            "{error}"
        );
        assert!(pairing::key::nothing_at(&dir), "no folder is created");
    }
}
