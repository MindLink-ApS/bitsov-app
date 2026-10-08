#[allow(dead_code)]
mod support;
use bitsov_app::{
    ai_pairing::{AiPairing, Request},
    pairing::{self, ClientKey, Established, PairingClient, PrintedCodes},
};
use mock_node::pairing::PairRoutes;
use std::time::Duration;
use support::{mock, Server};

#[tokio::test]
async fn separate_identity_survives_restart_and_never_uses_legacy_owner_auth() {
    let node_dir = tempfile::tempdir().unwrap();
    let owner_dir = tempfile::tempdir().unwrap();
    let ai_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, 2_000_000_000);
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = PairingClient::new(reqwest::Client::new(), server.api_base())
        .expect_challenge_dir(node_dir.path().join("pairing"))
        .with_code_wait(Duration::ZERO);
    let owner_key = ClientKey::load_or_create(owner_dir.path()).unwrap();
    let Established::Paired { session: owner, .. } =
        pairing::establish(&client, &owner_key, owner_dir.path(), "Owner", &codes)
            .await
            .unwrap()
    else {
        panic!()
    };
    let owner_record = std::fs::read(owner_dir.path().join(pairing::RECORD_FILE)).unwrap();
    node.open_pairing_window(300);
    let mut ai = AiPairing::default();
    let view = ai
        .update(
            Request::Create,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000,
        )
        .await
        .unwrap();
    assert_eq!(view.state, "paired");
    assert_ne!(view.client_id.as_deref(), Some(owner.client_id.as_str()));
    let ai_key = ClientKey::load_or_create(ai_dir.path()).unwrap();
    assert_ne!(ai_key.public_hex(), owner_key.public_hex());
    // The AI key cannot mint a token for the owner's client id/scopes.
    let mut impersonation = owner.clone();
    assert!(matches!(
        pairing::refresh(&mut impersonation, &client, &ai_key).await,
        Err(pairing::PairError::Refused { status: 401, .. })
    ));

    let json = serde_json::to_string(&view).unwrap();
    assert!(!json.contains(&owner.token));
    assert_eq!(
        std::fs::read(owner_dir.path().join(pairing::RECORD_FILE)).unwrap(),
        owner_record
    );
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
    // Status reuses the stored AI identity and never starts a new ceremony.
    // This older mock has no grant route: fail closed, do not call it approved.
    let mut restarted = AiPairing::default();
    assert!(restarted
        .update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .is_err());
    assert_eq!(node.calls("/api/v1/pair/request"), 2);
}

#[tokio::test]
async fn absent_pairing_routes_never_mint_a_local_owner_token() {
    let node_dir = tempfile::tempdir().unwrap();
    let ai_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Absent, 2_000_000_000);
    let codes = PrintedCodes::default();
    let server = Server::start(node.clone(), codes.clone());
    let client = PairingClient::new(reqwest::Client::new(), server.api_base());
    assert!(AiPairing::default()
        .update(
            Request::Create,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .is_err());
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
}

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Console {
    tokens: HashMap<String, String>,
    grants: HashMap<String, Value>,
    revoked: Option<String>,
    ask: Option<(String, Value)>,
    extra_scope: bool,
    elevation_status: Option<String>,
}
fn live_grant(id: &str) -> Value {
    json!({
        "client_id": id, "expires_at": 2_000_086_400_i64,
        "budget_msat":1000000, "remaining_msat":900000, "per_call_max_msat":55000,
        "payee_allowlist":["ab".repeat(32)], "allow_liquidity_fees":false,
        "breakers":{"paused":false,"limits":{"max_payments_per_minute":10,"max_payments_per_hour":60,"max_consecutive_failures":5,"max_msat_per_10_minutes":1000000}}
    })
}

#[tokio::test]
async fn console_approval_and_revocations_are_isolated_from_the_owner() {
    let node_dir = tempfile::tempdir().unwrap();
    let owner_dir = tempfile::tempdir().unwrap();
    let ai_dir = tempfile::tempdir().unwrap();
    let node = mock(node_dir.path(), PairRoutes::Live, 2_000_000_000);
    let console = Arc::new(Mutex::new(Console::default()));
    let hook_console = console.clone();
    let hook_node = node.clone();
    let codes = PrintedCodes::default();
    let server = Server::start_with_handler(
        node.clone(),
        codes.clone(),
        Arc::new(move |method, target, bearer, body| {
            let mut c = hook_console.lock().unwrap();
            if target.starts_with("/api/v1/pair/challenge?")
                && c.revoked.as_ref().is_some_and(|id| target.ends_with(id))
            {
                return Some((404, "{}".into()));
            }
            if target == "/api/v1/pair/token" {
                let input: Value = serde_json::from_slice(body).unwrap();
                let (status, body) = hook_node.handle(method, target, bearer, body);
                if status != 200 {
                    return Some((status, body));
                }
                let mut reply: Value = serde_json::from_str(&body).unwrap();
                c.tokens.insert(
                    reply["token"].as_str().unwrap().into(),
                    input["client_id"].as_str().unwrap().into(),
                );
                if c.extra_scope {
                    reply["scopes"] = json!(["read", "receive", "admin"]);
                }
                return Some((status, reply.to_string()));
            }
            if target == "/api/v1/pair/grant" {
                let id = c
                    .tokens
                    .get(bearer.unwrap_or(""))
                    .expect("AI must use its own issued token");
                return Some((200, json!({"grant":c.grants.get(id)}).to_string()));
            }
            if target == "/api/v1/pair/elevation/ab12" {
                return Some((
                    200,
                    json!({"status":c.elevation_status.as_deref().unwrap_or("pending")})
                        .to_string(),
                ));
            }
            if target == "/api/v1/pair/elevation-request" {
                let id = c
                    .tokens
                    .get(bearer.unwrap_or(""))
                    .expect("issued AI token")
                    .clone();
                let request: Value = serde_json::from_slice(body).unwrap();
                c.ask = Some((id, request));
                return Some((200, json!({"op_id":"ab12", "expires_at":2_000_000_600_i64, "owner_action":"konsensus grant --op ab12"}).to_string()));
            }
            None
        }),
    );
    let client = PairingClient::new(reqwest::Client::new(), server.api_base())
        .expect_challenge_dir(node_dir.path().join("pairing"))
        .with_code_wait(Duration::ZERO);
    let key = ClientKey::load_or_create(owner_dir.path()).unwrap();
    let Established::Paired { session: owner, .. } =
        pairing::establish(&client, &key, owner_dir.path(), "Owner", &codes)
            .await
            .unwrap()
    else {
        panic!()
    };
    console
        .lock()
        .unwrap()
        .grants
        .insert(owner.client_id.clone(), live_grant(&owner.client_id));
    let owner_record = std::fs::read(owner_dir.path().join(pairing::RECORD_FILE)).unwrap();
    node.open_pairing_window(300);
    let mut ai = AiPairing::default();
    let paired = ai
        .update(
            Request::Create,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000,
        )
        .await
        .unwrap();
    let id = paired.client_id.unwrap();
    assert_ne!(id, owner.client_id);
    let requested = ai
        .update(
            Request::RequestGrant {
                payees: vec!["AB".repeat(32)],
            },
            &client,
            ai_dir.path(),
            &codes,
            Some(std::path::Path::new("/tmp/My Node/konsensus.toml")),
            2_000_000_000,
        )
        .await
        .unwrap();
    assert_eq!(requested.state, "pending");
    assert_eq!(
        console.lock().unwrap().ask,
        Some((
            id.clone(),
            json!({"scopes":["spend"],"budget":{"budget_msat":1000000,"per_call_max_msat":55000,"ttl_secs":86400,"payee_allowlist":["ab".repeat(32)],"allow_liquidity_fees":false}})
        ))
    );
    let command = &requested.pending.unwrap().owner_action;
    assert!(command.contains("--per-call 55"));
    assert!(command.contains("--max-payments-per-minute 10"));
    assert!(command.ends_with("--config '/tmp/My Node/konsensus.toml'"));
    assert_eq!(
        requested.pair_revoke.unwrap(),
        format!("konsensus pair-revoke --client-id {id} --config '/tmp/My Node/konsensus.toml'")
    );
    assert_eq!(
        ai.update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .unwrap()
        .state,
        "pending"
    );
    console.lock().unwrap().elevation_status = Some("lost".into());
    assert_eq!(
        ai.update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .unwrap()
        .state,
        "paired"
    );
    console.lock().unwrap().elevation_status = None;
    for payees in [
        vec![],
        vec!["$(owner-command)".into()],
        vec!["a".repeat(65)],
    ] {
        assert!(ai
            .update(
                Request::RequestGrant { payees },
                &client,
                ai_dir.path(),
                &codes,
                None,
                2_000_000_000
            )
            .await
            .is_err());
    }
    console
        .lock()
        .unwrap()
        .grants
        .insert(id.clone(), live_grant(&id));
    let live = ai
        .update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000,
        )
        .await
        .unwrap();
    assert_eq!(live.state, "active");
    assert_eq!(live.grant.unwrap().remaining_msat, 900000);
    // Each owner override that widens AI policy stays visible but unusable.
    for (field, value) in [
        ("per_call_max_msat", json!(55001)),
        ("budget_msat", json!(1000001)),
        ("payee_allowlist", Value::Null),
        ("payee_allowlist", json!([])),
        ("breakers", Value::Null),
        ("allow_liquidity_fees", json!(true)),
    ] {
        let mut g = live_grant(&id);
        g[field] = value;
        console.lock().unwrap().grants.insert(id.clone(), g);
        assert_eq!(
            ai.update(
                Request::Status,
                &client,
                ai_dir.path(),
                &codes,
                None,
                2_000_000_000
            )
            .await
            .unwrap()
            .state,
            "unsafe"
        );
    }
    let mut paused = live_grant(&id);
    paused["breakers"]["paused"] = json!(true);
    console.lock().unwrap().grants.insert(id.clone(), paused);
    assert_eq!(
        ai.update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .unwrap()
        .state,
        "paused"
    );
    // Simulate owner-console grant-revoke for precisely the AI id.
    console.lock().unwrap().grants.remove(&id);
    assert_eq!(
        ai.update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .unwrap()
        .state,
        "paired"
    );
    // Simulate pair-revoke: token challenge reports unknown client.
    console.lock().unwrap().revoked = Some(id.clone());
    let revoked = ai
        .update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000,
        )
        .await
        .unwrap();
    assert_eq!(revoked.state, "revoked");
    assert!(revoked.grant.is_none());
    assert_eq!(
        node.calls("/api/v1/pair/request"),
        2,
        "polling must not re-pair"
    );
    assert_eq!(
        console.lock().unwrap().grants.get(&owner.client_id),
        Some(&live_grant(&owner.client_id))
    );
    assert_eq!(
        std::fs::read(owner_dir.path().join(pairing::RECORD_FILE)).unwrap(),
        owner_record
    );
    let mut owner_refreshed = owner.clone();
    pairing::refresh(&mut owner_refreshed, &client, &key)
        .await
        .unwrap();
    assert_eq!(owner_refreshed.client_id, owner.client_id);
    // A token carrying owner-only authority cannot enter the AI lifecycle.
    console.lock().unwrap().revoked = None;
    console.lock().unwrap().extra_scope = true;
    assert!(ai
        .update(
            Request::Status,
            &client,
            ai_dir.path(),
            &codes,
            None,
            2_000_000_000
        )
        .await
        .err()
        .unwrap()
        .contains("unexpected authority"));
    assert_eq!(node.calls("/api/v1/auth/local"), 0);
}
