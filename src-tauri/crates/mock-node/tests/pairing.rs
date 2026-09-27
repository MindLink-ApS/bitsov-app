//! Shape and state-machine tests for the in-memory `/pair/*` mock (#77 shapes).
//!
//! Toy crypto on purpose: mock-node carries no crypto dependency. The app's
//! integration tests drive the same mock with real Ed25519.

use std::sync::atomic::{AtomicU8, Ordering};

use mock_node::pairing::{PairCrypto, PairRoutes, PairingMock, PairingMockConfig};
use serde_json::{json, Value};

/// "Signature" = hex of the message. Enough to exercise the state machine.
struct ToyCrypto(AtomicU8);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl PairCrypto for ToyCrypto {
    fn random(&self, out: &mut [u8]) {
        for byte in out {
            *byte = self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn verify(&self, _pubkey_hex: &str, message: &[u8], signature_hex: &str) -> bool {
        hex(message) == signature_hex
    }
    fn short_code(&self, challenge: &[u8]) -> String {
        format!("CODE-{:02X}", challenge[0])
    }
    fn client_id(&self, pubkey_hex: &str) -> String {
        format!("client-{pubkey_hex}")
    }
}

fn mock(routes: PairRoutes) -> (PairingMock, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let node = PairingMock::new(
        PairingMockConfig {
            data_dir: dir.path().to_path_buf(),
            routes,
            token_ttl_secs: 600,
            now: 1_000,
        },
        Box::new(ToyCrypto(AtomicU8::new(7))),
    );
    (node, dir)
}

fn post(node: &PairingMock, path: &str, body: Value) -> (u16, Value) {
    let (status, text) = node.handle("POST", path, None, body.to_string().as_bytes());
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn get(node: &PairingMock, path: &str, bearer: Option<&str>) -> (u16, Value) {
    let (status, text) = node.handle("GET", path, bearer, b"");
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

const PUBKEY: &str = "ab";

fn request(node: &PairingMock) -> (String, std::path::PathBuf) {
    let (status, body) = post(
        node,
        "/api/v1/pair/request",
        json!({ "client_name": "BitSov app", "client_pubkey": PUBKEY }),
    );
    assert_eq!(status, 200, "{body}");
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["challenge_path", "expires_at", "pair_id"]);
    (
        body["pair_id"].as_str().unwrap().to_string(),
        body["challenge_path"].as_str().unwrap().into(),
    )
}

fn confirm(node: &PairingMock, pair_id: &str, challenge: &[u8]) -> (u16, Value) {
    let mut msg = pair_id.as_bytes().to_vec();
    msg.extend_from_slice(PUBKEY.as_bytes());
    msg.extend_from_slice(challenge);
    post(
        node,
        "/api/v1/pair/confirm",
        json!({ "pair_id": pair_id, "signature": hex(&msg) }),
    )
}

#[test]
fn rc7_routes_are_absent_but_auth_local_answers() {
    let (node, _dir) = mock(PairRoutes::Absent);
    let (status, text) = node.handle(
        "POST",
        "/api/v1/pair/request",
        None,
        json!({ "client_name": "x", "client_pubkey": PUBKEY }).to_string().as_bytes(),
    );
    assert_eq!(status, 404);
    assert!(text.is_empty(), "an unrouted path has no JSON body");
    let (status, body) = post(&node, "/api/v1/auth/local", json!({}));
    assert_eq!(status, 200);
    assert!(body["token"].is_string());
    assert_eq!(node.calls("/api/v1/auth/local"), 1);
}

#[test]
fn request_writes_a_0600_challenge_file_and_prints_the_code() {
    let (node, dir) = mock(PairRoutes::Live);
    let (pair_id, path) = request(&node);
    assert!(path.starts_with(dir.path()));
    let challenge = std::fs::read(&path).expect("challenge file");
    assert_eq!(challenge.len(), 32);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let code = format!("CODE-{:02X}", challenge[0]);
    assert_eq!(
        node.stdout_lines(),
        vec![format!("bitsov pairing code for \"{pair_id}\": {code}")]
    );
}

#[test]
fn ceremony_then_token_then_authenticated_read() {
    let (node, _dir) = mock(PairRoutes::Live);
    let (pair_id, path) = request(&node);
    let challenge = std::fs::read(&path).unwrap();
    let (status, body) = confirm(&node, &pair_id, &challenge);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["scopes"], json!(["read", "receive"]));
    assert!(!path.exists(), "the challenge is consumed");
    let client_id = body["client_id"].as_str().unwrap().to_string();

    let (status, body) = get(
        &node,
        &format!("/api/v1/pair/challenge?client_id={client_id}"),
        None,
    );
    assert_eq!(status, 200);
    let challenge = body["challenge"].as_str().unwrap().to_string();
    assert!(challenge.starts_with("bitsov-pair-token-v1:"));
    let (status, body) = post(
        &node,
        "/api/v1/pair/token",
        json!({
            "client_id": client_id,
            "challenge": challenge,
            "signature": hex(challenge.as_bytes()),
        }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["expires_at"], json!(1_600));
    assert_eq!(body["scopes"], json!(["read", "receive"]));
    let token = body["token"].as_str().unwrap().to_string();

    let (status, _) = get(&node, "/api/v1/identity", Some(&token));
    assert_eq!(status, 200);
    node.set_now(1_600);
    let (status, _) = get(&node, "/api/v1/identity", Some(&token));
    assert_eq!(status, 401, "an expired paired token is refused");
    assert_eq!(node.tokens_issued(), 1);
}

#[test]
fn a_bad_proof_is_401_and_burns_the_attempt() {
    let (node, _dir) = mock(PairRoutes::Live);
    let (pair_id, _path) = request(&node);
    let (status, body) = confirm(&node, &pair_id, &[0u8; 32]);
    assert_eq!(status, 401);
    assert!(body["error"].is_string());
    assert_eq!(body["code"], json!(401));
}

#[test]
fn pairing_closes_once_a_client_is_paired() {
    let (node, _dir) = mock(PairRoutes::Live);
    let (pair_id, path) = request(&node);
    let challenge = std::fs::read(&path).unwrap();
    assert_eq!(confirm(&node, &pair_id, &challenge).0, 200);
    let (status, body) = post(
        &node,
        "/api/v1/pair/request",
        json!({ "client_name": "second", "client_pubkey": "cd" }),
    );
    assert_eq!(status, 409, "{body}");
}

#[test]
fn unknown_fields_are_rejected_like_deny_unknown_fields() {
    let (node, _dir) = mock(PairRoutes::Live);
    let (status, _) = post(
        &node,
        "/api/v1/pair/request",
        json!({ "client_name": "x", "client_pubkey": PUBKEY, "scopes": ["spend"] }),
    );
    assert_eq!(status, 422);
}

#[test]
fn bootstrap_node_reports_state_and_grants_identity() {
    let (node, _dir) = mock(PairRoutes::Bootstrap);
    let (status, body) = get(&node, "/api/v1/bootstrap/state", None);
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({ "state": "bootstrap", "can_restore": true, "can_create": true })
    );
    let (pair_id, path) = request(&node);
    let challenge = std::fs::read(&path).unwrap();
    let (status, body) = confirm(&node, &pair_id, &challenge);
    assert_eq!(status, 200);
    assert_eq!(body["scopes"], json!(["read", "receive", "identity"]));

    let (live, _dir) = mock(PairRoutes::Live);
    assert_eq!(get(&live, "/api/v1/bootstrap/state", None).0, 404);
}
