//! Fail-closed table for the app's persistent stores: a newer or missing
//! version, garbage, truncation, an empty file, the wrong JSON shape, a
//! directory or a dangling symlink must be refused, never reset or ignored.
//! The owner-contact receipt runs the same table in its own module.

use crate::store_matrix::{assert_refuses, json_cases, write_private, Bad, Store};
use crate::spend_journal::{self, Journal, OperationRecord, OperationState};
use std::path::{Path, PathBuf};

const OP_ID: &str = "00000000-0000-4000-8000-000000000001";
const NODE: &str = "ab";

fn spend_dir(dir: &Path) -> PathBuf {
    dir.join("app-spend")
}

fn journal_load(dir: &Path) -> Result<(), String> {
    let journal = Journal::open(&spend_dir(dir)).map_err(|e| e.message)?;
    journal.pending().map(drop).map_err(|e| e.message)
}

const JOURNAL_LOCKS: &[&str] = &["spend.lock", "history.lock"];

fn call_offer() -> OperationRecord {
    OperationRecord {
        op_id: OP_ID.into(), node_id: NODE.into(), kind: "call_offer".into(), peer: "peer".into(),
        call_id: Some("call".into()), parent_op: None, request_hash: "hash".into(), cap_msat: 1_000,
        state: OperationState::Paid, paid_msat: Some(1_000), message_id: None, payment_hash: None,
        created_ms: 1, settled_ms: Some(2), reason: None, hangup_cap_msat: None,
        call_closed: false, call_answered: false,
    }
}

#[test]
fn spend_pending_snapshot_fails_closed() {
    let valid = serde_json::json!({
        "id": "slot", "node_id": NODE, "request_hash": "hash", "max_msat": 1_000,
        "target": null, "over_budget": false, "budgeted": true, "all_in": true,
    });
    let store = Store {
        name: "spend-pending.json",
        valid: serde_json::to_vec(&valid).unwrap(),
        version_key: None,
        prepare: &|dir| std::fs::create_dir_all(spend_dir(dir)).unwrap(),
        file: &|dir| spend_dir(dir).join("spend-pending.json"),
        load: &journal_load,
        may_create: JOURNAL_LOCKS,
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
    // The lock-free accounting read must agree with the journal.
    let read_only = Store { load: &|dir| spend_journal::read_pending(&spend_dir(dir)).map(drop).map_err(|e| e.message), ..store };
    assert_ne!(assert_refuses(&read_only, &json_cases(&read_only)), 0);
}

#[test]
fn spend_operation_record_fails_closed() {
    let load = |dir: &Path| -> Result<(), String> {
        let journal = Journal::open(&spend_dir(dir)).map_err(|e| e.message)?;
        match journal.operation_record(OP_ID) {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Ok(()),
            Err(e) => Err(e.message),
        }
    };
    let store = Store {
        name: "ops/<id>.json",
        valid: serde_json::to_vec(&call_offer()).unwrap(),
        version_key: None,
        prepare: &|dir| std::fs::create_dir_all(spend_dir(dir).join("ops")).unwrap(),
        file: &|dir| spend_dir(dir).join("ops").join(format!("{OP_ID}.json")),
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
}

/// A pending slot that names an operation must never re-create a damaged or
/// dangling operation record as a fresh legacy one.
#[test]
fn spend_pending_never_replaces_its_damaged_operation_record() {
    let pending = serde_json::json!({
        "id": "slot", "node_id": NODE, "request_hash": "hash", "max_msat": 1_000,
        "target": null, "over_budget": false, "operation_id": OP_ID,
    });
    let store = Store {
        name: "ops/<id>.json behind spend-pending.json",
        valid: serde_json::to_vec(&call_offer()).unwrap(),
        version_key: None,
        prepare: &|dir| {
            std::fs::create_dir_all(spend_dir(dir).join("ops")).unwrap();
            write_private(&spend_dir(dir).join("spend-pending.json"), &serde_json::to_vec(&pending).unwrap());
        },
        file: &|dir| spend_dir(dir).join("ops").join(format!("{OP_ID}.json")),
        load: &journal_load,
        may_create: &[],
    };
    let cases = [Bad::Garbage, Bad::Empty, Bad::Truncated(10), Bad::Directory, Bad::DanglingSymlink, Bad::WrongShape("{}")];
    assert_eq!(assert_refuses(&store, &cases), cases.len());
}

#[test]
fn spend_call_index_fails_closed() {
    let index = |dir: &Path| {
        let key = serde_json::to_vec(&(NODE, "peer", "call")).unwrap();
        spend_dir(dir).join("call-index").join(format!("{}.json", blake3::hash(&key).to_hex()))
    };
    let load = |dir: &Path| {
        spend_journal::read_call_admission(&spend_dir(dir), NODE, "peer", "call").map(drop).map_err(|e| e.message)
    };
    let store = Store {
        name: "call-index/<hash>.json",
        valid: serde_json::to_vec(&serde_json::json!({"op_id": OP_ID, "created_ms": 1})).unwrap(),
        version_key: None,
        prepare: &|dir| {
            std::fs::create_dir_all(spend_dir(dir).join("ops")).unwrap();
            write_private(&spend_dir(dir).join("ops").join(format!("{OP_ID}.json")), &serde_json::to_vec(&call_offer()).unwrap());
        },
        file: &index,
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
}

#[test]
fn budget_book_fails_closed() {
    let load = |dir: &Path| crate::budget::load(dir, NODE).map(drop).map_err(|e| e.message);
    let store = Store {
        name: "budget-<id>.json",
        valid: serde_json::to_vec(&crate::budget::Book::new(NODE)).unwrap(),
        version_key: Some("version"),
        prepare: &|_| {},
        file: &|dir| crate::budget::book_path(dir, NODE),
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
}

fn client_key(dir: &Path) {
    write_private(&dir.join(crate::pairing::key::KEY_FILE), "11".repeat(32).as_bytes());
}

#[test]
fn pairing_record_fails_closed() {
    let valid = tempfile::tempdir().unwrap();
    client_key(valid.path());
    let key = crate::pairing::key::ClientKey::load_or_create(valid.path()).unwrap();
    crate::pairing::save_remote_record(valid.path(), &key, "client".into(), vec!["read".into()]).unwrap();
    // A saved record is reused as is; anything else must not be paired over.
    let load = |dir: &Path| {
        let key = crate::pairing::key::ClientKey::load_or_create(dir).map_err(|e| e.to_string())?;
        crate::pairing::save_remote_record_once(dir, &key, "other".into(), vec![]).map_err(|e| e.to_string())
    };
    let store = Store {
        name: "pairing.json",
        valid: std::fs::read(valid.path().join(crate::pairing::RECORD_FILE)).unwrap(),
        version_key: None,
        prepare: &client_key,
        file: &|dir| dir.join(crate::pairing::RECORD_FILE),
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
}

fn key_cases() -> Vec<Bad> {
    vec![Bad::Garbage, Bad::Empty, Bad::Truncated(1), Bad::Truncated(32), Bad::Truncated(63),
        Bad::WrongShape("1111"), Bad::Directory, Bad::DanglingSymlink]
}

#[test]
fn plain_client_key_fails_closed() {
    let load = |dir: &Path| crate::pairing::key::ClientKey::load_or_create(dir).map(drop).map_err(|e| e.to_string());
    let store = Store {
        name: "client-ed25519.key",
        valid: "11".repeat(32).into_bytes(),
        version_key: None,
        prepare: &|_| {},
        file: &|dir| dir.join(crate::pairing::key::KEY_FILE),
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &key_cases()), 0);
}

/// Before migration a damaged legacy key must not be replaced by a new identity.
#[test]
fn legacy_client_key_under_a_sealer_fails_closed() {
    use crate::at_rest::test_sealer::MemorySealer;
    let load = |dir: &Path| {
        crate::pairing::key::ClientKey::load_or_create_sealed(dir, &MemorySealer).map(drop).map_err(|e| e.to_string())
    };
    let store = Store {
        name: "client-ed25519.key (sealer installed)",
        valid: "11".repeat(32).into_bytes(),
        version_key: None,
        prepare: &|_| {},
        file: &|dir| dir.join(crate::pairing::key::KEY_FILE),
        load: &load,
        may_create: &[],
    };
    let mut cases = key_cases();
    // A valid legacy key migrates by design; the table checks damaged inputs only.
    cases.retain(|c| !matches!(c, Bad::WrongShape(_)));
    assert_ne!(assert_refuses(&store, &cases), 0);
}

#[test]
fn sealed_client_key_fails_closed() {
    use crate::at_rest::{test_sealer::MemorySealer, Sealer};
    let load = |dir: &Path| {
        crate::pairing::key::ClientKey::load_or_create_sealed(dir, &MemorySealer).map(drop).map_err(|e| e.to_string())
    };
    let sealed = MemorySealer.seal(crate::at_rest::CLIENT_SEED_PURPOSE, &[0x11; 32]).unwrap();
    let store = Store {
        name: "client-ed25519.sealed",
        valid: sealed.clone(),
        version_key: None,
        prepare: &|_| {},
        file: &|dir| dir.join(crate::pairing::key::SEALED_KEY_FILE),
        load: &load,
        may_create: &[],
    };
    let cases = vec![Bad::Garbage, Bad::Empty, Bad::Truncated(5), Bad::Truncated(sealed.len() - 1),
        Bad::Directory, Bad::DanglingSymlink];
    assert_ne!(assert_refuses(&store, &cases), 0);
}

#[test]
fn remote_access_descriptor_fails_closed() {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let link = serde_json::json!({"v": 2, "endpoint": "box.local:9737", "endpoints": ["box.local:9737"],
        "box_transport_pubkey": "22".repeat(32), "code": b64.encode([3; 32])});
    let uri = format!("bitsov://pair/{}", b64.encode(serde_json::to_vec(&link).unwrap()));
    let valid = tempfile::tempdir().unwrap();
    crate::remote_access::import_pairing_link(valid.path(), &uri).unwrap();
    let path = |dir: &Path| dir.join(crate::remote_access::REMOTE_CONFIG_DIR).join(crate::remote_access::REMOTE_CONFIG_FILE);
    let load = |dir: &Path| crate::remote_access::load_persisted(dir).map(drop).map_err(|e| e.to_string());
    let store = Store {
        name: "remote-access/descriptor.json",
        valid: std::fs::read(path(valid.path())).unwrap(),
        version_key: Some("v"),
        prepare: &|_| {},
        file: &path,
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
}

#[test]
fn trust_acknowledgement_fails_closed() {
    let valid = tempfile::tempdir().unwrap();
    crate::trust::acknowledge(valid.path(), NODE, false, false).unwrap();
    let load = |dir: &Path| crate::trust::acknowledged(dir, NODE, false).map(drop);
    let store = Store {
        name: "trust-v1.json",
        valid: std::fs::read(valid.path().join("trust-v1.json")).unwrap(),
        version_key: None,
        prepare: &|_| {},
        file: &|dir| dir.join("trust-v1.json"),
        load: &load,
        may_create: &[],
    };
    assert_ne!(assert_refuses(&store, &json_cases(&store)), 0);
}
