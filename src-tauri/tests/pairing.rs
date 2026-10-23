//! App pairing client against mock-node's #77 `/pair/*` shapes, over an
//! ephemeral loopback port. Mock data only; keys are generated per test.

mod support;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bitsov_app::pairing::{
    self, ClientKey, Established, PairError, PairingClient, PairingView, PrintedCodes,
};
use mock_node::pairing::{PairCrypto, PairRoutes};
use support::{mock, mock_with, NodeCrypto, Server};

const NAME: &str = "BitSov app";

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn client(server: &Server, node_dir: &Path) -> PairingClient {
    PairingClient::new(reqwest::Client::new(), server.api_base())
        .expect_challenge_dir(node_dir.join("pairing"))
        .with_code_wait(Duration::from_millis(500))
}

async fn identity_status(server: &Server, token: &str) -> u16 {
    reqwest::Client::new()
        .get(format!("{}/identity", server.api_base()))
        .bearer_auth(token)
        .send()
        .await
        .expect("identity")
        .status()
        .as_u16()
}

#[tokio::test]
async fn full_ceremony_pairs_read_receive_and_mints_a_paired_token() {
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, now());
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = client(&server, node_dir.path());
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();

    let outcome = pairing::establish(&client, &key, app_dir.path(), NAME, &codes)
        .await
        .expect("paired");
    let Established::Paired { session, ceremony } = outcome else {
        panic!("expected a pairing, got a fallback");
    };
    assert_eq!(session.scopes, ["read", "receive"]);
    assert_eq!(session.expires_at, node.now() + 600);
    let ceremony = ceremony.expect("first run runs the ceremony");
    assert!(ceremony.node_printed, "the node's printed code was captured");
    let printed = node.stdout_lines();
    assert_eq!(printed.len(), 1);
    assert!(printed[0].ends_with(&format!(": {}", ceremony.short_code)));

    assert_eq!(identity_status(&server, &session.token).await, 200);
    assert_eq!(node.calls("/api/v1/auth/local"), 0, "a pairing node is never asked for /auth/local");

    // Next app start: the stored pairing mints a token; no second ceremony.
    let again = pairing::establish(&client, &key, app_dir.path(), NAME, &codes)
        .await
        .expect("token from stored pairing");
    let Established::Paired { session, ceremony } = again else { panic!("fallback") };
    assert!(ceremony.is_none());
    assert_eq!(session.scopes, ["read", "receive"]);
    assert_eq!(node.calls("/api/v1/pair/request"), 1);
    assert_eq!(node.tokens_issued(), 2);
}

#[tokio::test]
async fn rc7_node_without_pair_routes_falls_back_to_auth_local() {
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Absent, now());
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();

    let outcome = pairing::establish(&client(&server, node_dir.path()), &key, app_dir.path(), NAME, &codes)
        .await
        .expect("fallback");
    let Established::LocalFallback { token } = &outcome else {
        panic!("expected the /auth/local fallback");
    };
    assert_eq!(identity_status(&server, token).await, 200);
    assert_eq!(node.calls("/api/v1/pair/request"), 1);
    assert_eq!(node.calls("/api/v1/auth/local"), 1);
    assert!(!app_dir.path().join(pairing::RECORD_FILE).exists());
    assert_eq!(PairingView::from_outcome(&Ok(outcome)).state, "fallback");
}

async fn assert_refused_without_fallback(
    routes_crypto: Box<dyn PairCrypto>,
    pre_pair: bool,
    status: u16,
) -> PairError {
    let node_dir = tempfile::tempdir().unwrap();
    let node = mock_with(node_dir.path(), PairRoutes::Live, now(), routes_crypto);
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = client(&server, node_dir.path());

    if pre_pair {
        let other = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(other.path()).unwrap();
        pairing::establish(&client, &key, other.path(), "other", &codes)
            .await
            .expect("first client pairs");
    }

    let app_dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let err = match pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await {
        Ok(_) => panic!("a refusal must not become a session"),
        Err(e) => e,
    };
    match &err {
        PairError::Refused { status: got, .. } => assert_eq!(*got, status, "{err}"),
        other => panic!("expected a refusal, got {other}"),
    }
    assert_eq!(node.calls("/api/v1/auth/local"), 0, "a refusal never downgrades to /auth/local");
    assert!(!app_dir.path().join(pairing::RECORD_FILE).exists());
    err
}

#[tokio::test]
async fn closed_pairing_409_is_a_failure_not_a_fallback() {
    let err = assert_refused_without_fallback(Box::new(NodeCrypto), true, 409).await;
    let view = PairingView::from_outcome(&Err(err));
    assert_eq!(view.state, "failed");
    assert!(view.reason.unwrap().contains("closed"));
}

struct RejectingCrypto;
impl PairCrypto for RejectingCrypto {
    fn random(&self, out: &mut [u8]) {
        NodeCrypto.random(out)
    }
    fn verify(&self, _: &str, _: &[u8], _: &str) -> bool {
        false
    }
    fn short_code(&self, challenge: &[u8]) -> String {
        NodeCrypto.short_code(challenge)
    }
    fn client_id(&self, pubkey_hex: &str) -> String {
        NodeCrypto.client_id(pubkey_hex)
    }
}

#[tokio::test]
async fn rejected_proof_401_is_a_failure_not_a_fallback() {
    assert_refused_without_fallback(Box::new(RejectingCrypto), false, 401).await;
}

#[tokio::test]
async fn revoked_stored_pairing_is_a_failure_not_a_fallback() {
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, now());
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = client(&server, node_dir.path());
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await.unwrap();

    node.revoke_all();
    let err = pairing::establish(&client, &key, app_dir.path(), NAME, &codes)
        .await
        .expect_err("revoked pairing is refused");
    assert!(matches!(err, PairError::Refused { status: 404, .. }), "{err}");
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
}

#[tokio::test]
async fn unreachable_node_is_a_failure_not_a_fallback() {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let app_dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let client = PairingClient::new(reqwest::Client::new(), format!("http://127.0.0.1:{port}/api/v1"));
    let err = pairing::establish(&client, &key, app_dir.path(), NAME, &PrintedCodes::default())
        .await
        .expect_err("no node");
    assert!(matches!(err, PairError::Transport { .. }), "{err}");
}

#[tokio::test]
async fn short_code_mismatch_trips_and_does_not_pair() {
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock_with(node_dir.path(), PairRoutes::Live, now(), Box::new(support::LyingCodeCrypto));
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let err = pairing::establish(&client(&server, node_dir.path()), &key, app_dir.path(), NAME, &codes)
        .await
        .expect_err("tripwire");
    assert!(matches!(err, PairError::Tripwire { .. }), "{err}");
    assert_eq!(node.calls("/api/v1/pair/confirm"), 0, "nothing is signed after the tripwire");
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
}

#[tokio::test]
async fn challenge_path_outside_the_node_data_dir_is_refused() {
    let node_dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, now());
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let err = pairing::establish(&client(&server, elsewhere.path()), &key, app_dir.path(), NAME, &codes)
        .await
        .expect_err("unexpected challenge location");
    assert!(matches!(err, PairError::Local(_)), "{err}");
    assert_eq!(node.calls("/api/v1/pair/confirm"), 0);
}

#[tokio::test]
async fn paired_token_is_refreshed_before_it_expires() {
    let t0 = now();
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, t0);
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = client(&server, node_dir.path());
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let Established::Paired { mut session, .. } =
        pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await.unwrap()
    else {
        panic!("fallback")
    };
    assert_eq!(session.expires_at, t0 + 600);
    let first = session.token.clone();

    // Plenty of life left: no refresh.
    assert!(!pairing::refresh_if_needed(&mut session, &client, &key, t0 + 400).await.unwrap());
    assert_eq!(node.tokens_issued(), 1);

    // Inside the margin, still before expiry: refresh now.
    let t1 = t0 + 600 - pairing::REFRESH_MARGIN_SECS + 20;
    node.set_now(t1);
    assert!(pairing::refresh_if_needed(&mut session, &client, &key, t1).await.unwrap());
    assert_eq!(node.tokens_issued(), 2);
    assert_ne!(session.token, first);
    assert_eq!(session.expires_at, t1 + 600);
    assert_eq!(identity_status(&server, &first).await, 200, "refreshed while the old token was still valid");
    assert_eq!(identity_status(&server, &session.token).await, 200);

    node.set_now(t0 + 600);
    assert_eq!(identity_status(&server, &first).await, 401);
    assert_eq!(identity_status(&server, &session.token).await, 200);
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
}

#[test]
fn client_key_file_is_0600_in_a_0700_dir_and_is_reused() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("app-client");
    let first = ClientKey::load_or_create(&store).unwrap();
    let second = ClientKey::load_or_create(&store).unwrap();
    assert_eq!(first.public_hex(), second.public_hex());
    assert_eq!(first.public_hex().len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = std::fs::metadata(store.join(pairing::KEY_FILE)).unwrap();
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
        let dir = std::fs::metadata(&store).unwrap();
        assert_eq!(dir.permissions().mode() & 0o777, 0o700);
    }
}

#[cfg(unix)]
#[test]
fn client_key_file_readable_by_others_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    ClientKey::load_or_create(dir.path()).unwrap();
    let path = dir.path().join(pairing::KEY_FILE);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let err = ClientKey::load_or_create(dir.path()).expect_err("refused");
    assert!(err.to_string().contains("0600"), "{err}");
}

#[tokio::test]
async fn bootstrap_node_is_detected_and_grants_identity_during_first_run() {
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Bootstrap, now());
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = client(&server, node_dir.path());
    assert_eq!(pairing::bootstrap_state(&client).await.unwrap().as_deref(), Some("bootstrap"));
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let Established::Paired { session, .. } =
        pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await.unwrap()
    else {
        panic!("fallback")
    };
    assert_eq!(session.scopes, ["read", "receive", "identity"]);

    let live_dir = tempfile::tempdir().unwrap();
    let live = Server::start(mock(live_dir.path(), PairRoutes::Live, now()), PrintedCodes::default());
    assert_eq!(pairing::bootstrap_state(&client_for(&live)).await.unwrap(), None);
}

fn client_for(server: &Server) -> PairingClient {
    PairingClient::new(reqwest::Client::new(), server.api_base())
}

#[test]
fn view_states_cover_pending_paired_failed_fallback() {
    assert_eq!(PairingView::starting().state, "starting");
    assert_eq!(PairingView::pending().state, "pending");

    let paired = PairingView::from_outcome(&Ok(Established::Paired {
        session: pairing::PairedSession {
            client_id: "c".into(),
            scopes: vec!["read".into(), "receive".into()],
            token: "secret-token".into(),
            expires_at: 1,
        },
        ceremony: Some(pairing::Ceremony {
            short_code: "ABCD-EFGH".into(),
            node_printed: true,
        }),
    }));
    assert_eq!(paired.state, "paired");
    assert_eq!(paired.scopes, ["read", "receive"]);
    assert_eq!(paired.short_code.as_deref(), Some("ABCD-EFGH"));
    assert!(paired.code_from_node);
    let json = serde_json::to_string(&paired).unwrap();
    assert!(!json.contains("secret-token"), "the view never carries the token");

    let fallback = PairingView::from_outcome(&Ok(Established::LocalFallback {
        token: "local-secret".into(),
    }));
    assert_eq!(fallback.state, "fallback");
    assert!(!serde_json::to_string(&fallback).unwrap().contains("local-secret"));

    let failed = PairingView::from_outcome(&Err(PairError::Refused {
        step: "/pair/confirm",
        status: 401,
        reason: "pairing proof did not verify".into(),
    }));
    assert_eq!(failed.state, "failed");
    assert!(failed.reason.unwrap().contains("did not verify"));
}

// Port of PR #379 (304883d8) local_token_challenge + issue_local_token_challenge.
// Independent of the app's signing helper; verifies the wire header and query id.
fn verifies_challenge(target: &str, header: Option<&str>, public_hex: &str, now: i64) -> bool {
    let Some(client_id) = target.strip_prefix("/api/v1/pair/challenge?client_id=") else { return false };
    let Some((timestamp, signature)) = header.and_then(|v| v.strip_prefix("PairChallenge "))
        .and_then(|v| v.split_once(':')) else { return false };
    let Ok(timestamp) = timestamp.parse::<i64>() else { return false };
    if now.abs_diff(timestamp) > 30 { return false; }
    if signature.len() != 128 || !signature.bytes().all(|b| b.is_ascii_hexdigit()) { return false; }
    NodeCrypto.verify(public_hex,
        format!("bitsov-pair-challenge-v1:{client_id}:{timestamp}").as_bytes(), signature)
}

#[tokio::test]
async fn local_challenge_header_verifies_for_ceremony_reuse_and_refresh() {
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    for routes in [PairRoutes::Live, PairRoutes::Bootstrap] {
        let node_dir = tempfile::tempdir().unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(app_dir.path()).unwrap();
        let public = key.public_hex().to_owned();
        let node = mock(node_dir.path(), routes, now());
        let codes = PrintedCodes::default();
        let checked = Arc::new(AtomicUsize::new(0));
        let count = checked.clone();
        let server = Server::start_with_challenge_check(node.clone(), codes.clone(), Arc::new(move |target, header| {
            let time = now();
            let valid = verifies_challenge(target, header, &public, time);
            if valid {
                // Inclusive +/-30 s window; an altered client id or stale proof fails.
                let ts = header.unwrap().strip_prefix("PairChallenge ").unwrap()
                    .split_once(':').unwrap().0.parse::<i64>().unwrap();
                assert!(verifies_challenge(target, header, &public, ts - 30));
                assert!(verifies_challenge(target, header, &public, ts + 30));
                assert!(!verifies_challenge(target, header, &public, ts - 31));
                assert!(!verifies_challenge(target, header, &public, ts + 31));
                assert!(!verifies_challenge("/api/v1/pair/challenge?client_id=other", header, &public, time));
                count.fetch_add(1, Ordering::SeqCst);
            }
            valid
        }));
        let client = client(&server, node_dir.path());
        pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await.expect("signed ceremony");
        let Established::Paired { mut session, .. } =
            pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await.expect("signed reuse")
        else { panic!("fallback") };
        pairing::refresh(&mut session, &client, &key).await.expect("signed refresh");
        assert_eq!(checked.load(Ordering::SeqCst), 3);
        assert_eq!(node.tokens_issued(), 3);
    }
}

#[tokio::test]
async fn challenge_401_is_a_clear_refusal_without_retry_token_or_fallback() {
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, now());
    let codes = PrintedCodes::default();
    let attempts = Arc::new(AtomicUsize::new(0));
    let count = attempts.clone();
    let server = Server::start_with_challenge_check(node.clone(), codes.clone(), Arc::new(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        false
    }));
    let error = pairing::establish(&client(&server, node_dir.path()), &key, app_dir.path(), NAME, &codes)
        .await.expect_err("challenge refused");
    assert!(matches!(error, PairError::Refused { step: "/pair/challenge", status: 401, .. }));
    let view = PairingView::from_outcome(&Err(error));
    assert_eq!(view.state, "failed");
    assert!(view.reason.unwrap().contains("401"));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(node.calls("/api/v1/pair/token"), 0);
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
}

#[tokio::test]
async fn old_node_ignores_local_header_and_remote_challenge_stays_unchanged() {
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    let node_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(app_dir.path()).unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, now());
    let codes = PrintedCodes::default();
    let remote = Arc::new(AtomicBool::new(false));
    let mode = remote.clone();
    let server = Server::start_with_challenge_check(node.clone(), codes.clone(), Arc::new(move |_, header| {
        if mode.load(Ordering::SeqCst) {
            assert!(header.is_none(), "remote challenge must not gain local credentials");
        } else {
            assert!(header.is_some_and(|v| v.starts_with("PairChallenge ")));
        }
        // The old mock node ignores the header; no verification is required.
        true
    }));
    let client = client(&server, node_dir.path());
    pairing::establish(&client, &key, app_dir.path(), NAME, &codes).await.expect("old node accepts header");
    remote.store(true, Ordering::SeqCst);
    pairing::establish_remote(&client, &key, app_dir.path()).await.expect("unchanged remote challenge");
    assert_eq!(node.tokens_issued(), 2);
}
