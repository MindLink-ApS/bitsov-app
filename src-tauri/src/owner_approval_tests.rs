use super::*;
use serde_json::json;

fn view() -> Value {
    json!({"op_id":"12345678-1234-1234-1234-123456789abc", "node":"fp", "client_id":"requester",
        "client_pubkey":"ABCDEF000000123456", "epoch":1, "grant_op":null,
        "request":{"kind":"spend_grant","terms":{"budget_msat":1234567,"per_call_max_msat":1000,"window_secs":3600}},
        "nonce":"ab".repeat(16), "expires_at":1790000300,
        "approval_message":"bitsov-owner-approval-v1\nnode:fp\nterms:é", "status":"pending", "owner_action":null})
}

#[test]
fn node_errors_map_exactly_and_keep_only_contract_metadata() {
    for (status, code) in [
        (400, "approval_invalid"),
        (403, "approval_forbidden"),
        (404, "approval_unknown"),
        (409, "approval_expired"),
        (429, "approval_rate_limited"),
        (500, "approval_unsaved"),
        (502, "node"),
    ] {
        let err = refusal(
            status,
            r#"{"error":"node refused","reason":"other","remaining_msat":17}"#,
        );
        assert_eq!(err.code, code);
        assert_eq!(err.message, "node refused");
        assert!(err.remaining_msat.is_none());
    }
    for reason in [
        "seed_not_encrypted",
        "seed_password_not_typed",
        "owner_key_unavailable",
    ] {
        let body = json!({"error":"off", "reason":reason}).to_string();
        let err = refusal(403, &body);
        assert_eq!(err.code, "approval_off");
        assert_eq!(err.reason.as_deref(), Some(reason));
        assert_eq!(refusal(409, &body).code, "approval_expired");
    }
    let err = refusal(
        409,
        r#"{"code":"budget_exceeded","reason":"over budget","remaining_msat":123}"#,
    );
    assert_eq!(err.code, "approval_budget_exceeded");
    let wire = serde_json::to_value(err).unwrap();
    assert_eq!(wire["remaining_msat"], 123);
    assert_eq!(wire["reason"], "over budget");
    assert_eq!(
        refusal(403, r#"{"code":"budget_exceeded"}"#).code,
        "approval_forbidden"
    );
    assert_eq!(refusal(409, r#"{"code":409}"#).code, "approval_expired");
    assert_eq!(refusal(400, "not json").code, "approval_invalid");
    let err = refusal(
        403,
        &json!({"error":format!("bad\u{0000}\u{001b}\u{202e}{}", "x".repeat(500))}).to_string(),
    );
    assert!(!err.message.contains(['\0', '\u{001b}', '\u{202e}']));
    assert!(err.message.chars().count() <= 160);
}

#[test]
fn changed_and_self_guards_precede_signing_and_preserve_exact_bytes() {
    let v = view();
    let message = v["approval_message"].as_str().unwrap();
    assert!(checked_approval(&v, "owner", message).is_ok());
    for changed in [
        format!("{message}\n"),
        message.replace('é', "e\u{301}"),
        message.replace('\n', "\r\n"),
    ] {
        assert_eq!(
            checked_approval(&v, "owner", &changed).unwrap_err().code,
            "approval_changed"
        );
    }
    assert_eq!(
        checked_approval(&v, "requester", message).unwrap_err().code,
        "approval_self"
    );
    assert_eq!(
        checked_approval(&v, "requester", "changed")
            .unwrap_err()
            .code,
        "approval_changed"
    );
}

#[test]
fn prompt_matches_renderer_approval_reason() {
    assert_eq!(checked_approval(&view(), "owner", view()["approval_message"].as_str().unwrap()).unwrap(),
        "Let this app spend · Budget: up to 1,234.567 sats · Each payment: up to 1 sat · For: 1 h · To: any contact, within the budget · Requested by app abcdef…123456");
    let mut v = view();
    v["request"] = json!({"kind":"first_contact","terms":{"recipient":"AB12-CD34","max_total_msat":1,"budget_msat":1000000}});
    assert_eq!(checked_approval(&v, "owner", v["approval_message"].as_str().unwrap()).unwrap(),
        "Let this app message someone new · To: ab12cd34 · First message: up to 0.001 sats · Contact budget: up to 1,000 sats · Requested by app abcdef…123456");
}

#[test]
fn operation_ids_cannot_change_routes() {
    assert!(operation_path("12345678-1234-1234-1234-123456789abc").is_ok());
    for id in [
        "",
        "../device-keys",
        "abc?x=y",
        "abc/approve",
        "%2f",
        "abcd",
    ] {
        assert_eq!(operation_path(id).unwrap_err().code, "approval_invalid");
    }
}

#[tokio::test]
async fn pending_and_approve_refuse_local_before_network_or_key_access() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    assert_eq!(
        pending(&state).await.unwrap_err().code,
        "approval_forbidden"
    );
    assert_eq!(
        approve(&state, view()["op_id"].as_str().unwrap(), "message")
            .await
            .unwrap_err()
            .code,
        "approval_forbidden"
    );
}

// This is the existing production signer with a fresh, explicitly no-prompt
// enclave test key. No Tauri runtime or webview is constructed.
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn existing_device_signer_returns_der_hex_verifiable_with_p256_sha256() {
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};
    let (blob, public) = device_key::create(device_key::Policy::NoPromptForTests).unwrap();
    let v = view();
    let message = v["approval_message"].as_str().unwrap();
    let signature = sign_checked(&v, "owner", message, |exact, reason| {
        assert_eq!(reason, "Let this app spend · Budget: up to 1,234.567 sats · Each payment: up to 1 sat · For: 1 h · To: any contact, within the budget · Requested by app abcdef…123456");
        device_sign(blob, exact, reason)
    }).await.unwrap();
    assert!(signature
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    let der = hex::decode(signature).unwrap();
    assert_eq!(der[0], 0x30);
    assert!(der.len() <= 72);
    let verifier = UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public);
    verifier.verify(message.as_bytes(), &der).unwrap();
    assert!(verifier
        .verify(format!("{message}\n").as_bytes(), &der)
        .is_err());
}

#[tokio::test]
async fn requester_commands_keep_node_views_and_map_http_refusals() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let state = NodeState::for_api(format!("http://{}/api/v1", listener.local_addr().unwrap()));
    *state.token.lock().unwrap() = Some("test-pairing-token".into());
    let expected_view = view();
    let keys = json!({"device_approvals":"enabled","owner_device_count":1,
        "device_keys":[{"key_id":"ab".repeat(16),"fingerprint":"ABCD","name":null,"registered_at":1}]});
    let replies = vec![
        (
            "POST /api/v1/pair/approval-request HTTP/1.1".to_string(),
            200,
            expected_view.clone(),
        ),
        (
            format!(
                "GET /api/v1/pair/approval/{} HTTP/1.1",
                expected_view["op_id"].as_str().unwrap()
            ),
            200,
            expected_view.clone(),
        ),
        (
            "GET /api/v1/pair/device-keys HTTP/1.1".to_string(),
            200,
            keys.clone(),
        ),
        (
            "POST /api/v1/pair/approval-request HTTP/1.1".to_string(),
            409,
            json!({"code":"budget_exceeded","reason":"daily","remaining_msat":9}),
        ),
    ];
    let request_body = expected_view["request"].clone();
    let sent_body = request_body.clone();
    let server = tokio::spawn(async move {
        for (line, status, reply) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = std::str::from_utf8(&bytes[..end]).unwrap();
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .map(|n| n.parse().unwrap())
                        .unwrap_or(0);
                    if bytes.len() < end + 4 + length {
                        continue;
                    }
                    assert_eq!(head.lines().next().unwrap(), line);
                    assert!(head
                        .to_ascii_lowercase()
                        .contains("authorization: bearer test-pairing-token"));
                    if line.starts_with("POST") {
                        assert_eq!(
                            serde_json::from_slice::<Value>(&bytes[end + 4..]).unwrap(),
                            sent_body
                        );
                    }
                    break;
                }
            }
            let body = reply.to_string();
            socket.write_all(format!("HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    assert_eq!(
        create(&state, request_body.clone()).await.unwrap(),
        expected_view
    );
    assert_eq!(
        status(&state, expected_view["op_id"].as_str().unwrap())
            .await
            .unwrap(),
        expected_view
    );
    assert_eq!(device_keys(&state).await.unwrap(), keys);
    let error = create(&state, request_body).await.unwrap_err();
    assert_eq!(error.code, "approval_budget_exceeded");
    assert_eq!(error.remaining_msat, Some(9));
    server.await.unwrap();
}

#[test]
fn first_contact_prompt_distinguishes_absent_and_null_budget_like_renderer() {
    let mut v = view();
    v["request"] = json!({"kind":"first_contact","terms":{"recipient":"ab","max_total_msat":1000}});
    let message = v["approval_message"].as_str().unwrap().to_owned();
    assert_eq!(checked_approval(&v, "owner", &message).unwrap(),
        "Let this app message someone new · To: ab · First message: up to 1 sat · Requested by app abcdef…123456");
    v["request"]["terms"]["budget_msat"] = Value::Null;
    assert_eq!(checked_approval(&v, "owner", &message).unwrap(),
        "Let this app message someone new · To: ab · First message: up to 1 sat · Contact budget: up to 0 sats · Requested by app abcdef…123456");
}

#[tokio::test]
async fn approval_refusals_never_invoke_the_signer() {
    let v = view();
    for (client, message, expected) in [
        ("owner", "changed", "approval_changed"),
        (
            "requester",
            v["approval_message"].as_str().unwrap(),
            "approval_self",
        ),
    ] {
        let result = sign_checked(&v, client, message, |_, _| {
            panic!("refused approval reached the biometric signer");
            #[allow(unreachable_code)]
            std::future::ready(Ok(String::new()))
        })
        .await;
        assert_eq!(result.unwrap_err().code, expected);
    }
}
