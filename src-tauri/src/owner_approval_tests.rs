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
        "Let this app spend · Budget: up to 1\u{202f}234\u{202f}567 msat · Each payment: up to 1 sat · For: 1 h · To: any contact, within the budget · Requested by app abcdef…123456");
    let mut v = view();
    v["request"] = json!({"kind":"first_contact","terms":{"recipient":"AB12-CD34","max_total_msat":1,"budget_msat":1000000}});
    assert_eq!(checked_approval(&v, "owner", v["approval_message"].as_str().unwrap()).unwrap(),
        "Let this app message someone new · To: ab12cd34 · First message: up to 1 msat · Contact budget: up to 1\u{202f}000 sats · Requested by app abcdef…123456");
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
#[cfg(all(target_os = "macos", not(feature = "mobile"), feature = "native-test-keys"))]
#[tokio::test]
async fn existing_device_signer_returns_der_hex_verifiable_with_p256_sha256() {
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};
    let (blob, public) = device_key::create(device_key::Policy::NoPromptForTests).unwrap();
    let v = view();
    let message = v["approval_message"].as_str().unwrap();
    let signature = sign_checked(&v, "owner", message, |exact, reason| {
        assert_eq!(reason, "Let this app spend · Budget: up to 1\u{202f}234\u{202f}567 msat · Each payment: up to 1 sat · For: 1 h · To: any contact, within the budget · Requested by app abcdef…123456");
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
    check_requester_passthrough(view()).await;
    check_requester_passthrough(breaker_view()).await;
    let mut first_contact = view();
    first_contact["request"] = json!({"kind":"first_contact", "terms":{"recipient":"ab".repeat(32), "max_total_msat":1000, "budget_msat":2000}});
    check_requester_passthrough(first_contact).await;
}

#[tokio::test]
async fn malformed_requests_are_refused_before_network_access() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let mut invalid = vec![
        Value::Null,
        json!([]),
        json!(["breaker_reset", {}]),
        json!(["spend_grant", {"budget_msat":1000, "per_call_max_msat":1000, "window_secs":60, "recipient":null}]),
        json!("breaker_reset"),
        json!(true),
        json!(1),
        json!({}),
        json!({"kind":"unknown", "terms":{}}),
        json!({"kind":"breaker_reset"}),
        json!({"kind":"breaker_reset", "terms":null}),
        json!({"kind":"breaker_reset", "terms":[]}),
        json!({"kind":"breaker_reset", "terms":"invalid"}),
        json!({"kind":"breaker_reset", "terms":true}),
        json!({"kind":"breaker_reset", "terms":1}),
        json!({"kind":"spend_grant", "terms":[1000,1000,60,null]}),
        json!({"kind":"first_contact", "terms":{"recipient":"ab", "max_total_msat":1000, "budget_msat":null}}),
        json!({"kind":"spend_grant", "terms":{"budget_msat":1000, "per_call_max_msat":1000, "window_secs":60, "recipient":null}}),
        json!({"kind":"breaker_reset", "terms":{"budget_msat":1}}),
        json!({"kind":"spend_grant", "terms":{}}),
        json!({"kind":"first_contact", "terms":{"recipient":"ab"}}),
    ];
    for mut body in [
        view()["request"].clone(),
        json!({"kind":"first_contact", "terms":{"recipient":"ab", "max_total_msat":1000}}),
        json!({"kind":"breaker_reset", "terms":{}}),
    ] {
        body["unexpected"] = json!(true);
        invalid.push(body.clone());
        body.as_object_mut().unwrap().remove("unexpected");
        body["terms"]["unexpected"] = json!(true);
        invalid.push(body);
    }
    for bad_number in [json!("1000"), json!(-1), json!(1.5), Value::Null] {
        let mut body = view()["request"].clone();
        body["terms"]["budget_msat"] = bad_number;
        invalid.push(body);
    }
    let mut forwarded = Vec::new();
    for body in invalid {
        let error = create(&state, body.clone()).await.unwrap_err();
        if error.code != "approval_invalid" {
            forwarded.push((body, error.code));
        }
    }
    assert!(forwarded.is_empty(), "malformed bodies were forwarded: {forwarded:?}");
}

#[test]
fn registered_key_id_matches_known_sec1_p256_key() {
    // P-256's standard generator, uncompressed SEC1 (private scalar = 1).
    let mut record = device::Record {
        public_key: concat!(
            "04",
            "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
            "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
        ).into(),
        key_id: Some("fbbd51dc2db9576d035086edbf28a328".into()),
        registered: true,
        ..Default::default()
    };
    assert_eq!(registered_key_id(&record).unwrap(), "fbbd51dc2db9576d035086edbf28a328");
    for bad_id in [None, Some("00".repeat(16)), Some("FBBD51DC2DB9576D035086EDBF28A328".into())] {
        record.key_id = bad_id;
        assert_eq!(registered_key_id(&record).unwrap_err().code, "approval_forbidden");
    }
    record.key_id = Some("fbbd51dc2db9576d035086edbf28a328".into());
    record.registered = false;
    assert_eq!(registered_key_id(&record).unwrap_err().code, "approval_forbidden");
}

#[test]
fn breaker_expiry_formats_calendar_boundaries_and_refuses_out_of_range() {
    let mut v = breaker_view();
    let message = v["approval_message"].as_str().unwrap().to_owned();
    for (timestamp, expected) in [
        (0, "1970-01-01 00:00:00 UTC"),
        (951827696, "2000-02-29 12:34:56 UTC"),
        (1900000000, "2030-03-17 17:46:40 UTC"),
    ] {
        v["breaker_reset"]["grant_expires_at"] = json!(timestamp);
        assert!(checked_approval(&v, "owner", &message).unwrap().contains(&format!("Grant ends: {expected} ·")));
    }
    v["breaker_reset"]["grant_expires_at"] = json!(i64::MAX);
    assert_eq!(checked_approval(&v, "owner", &message).unwrap_err().code, "node");
}

#[cfg(all(target_os = "macos", not(feature = "mobile"), feature = "native-test-keys"))]
#[test]
fn registered_key_refuses_a_record_id_that_does_not_match_its_public_key() {
    let dir = tempfile::tempdir().unwrap();
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    *state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
        client: PairingClient::new(state.http.clone(), state.api_base.clone()),
        key: Arc::new(ClientKey::load_or_create(dir.path()).unwrap()),
        store: dir.path().to_owned(),
        data_dir: dir.path().to_owned(),
    }));
    let (blob, public) = device_key::create(device_key::Policy::NoPromptForTests).unwrap();
    device::save_blob(dir.path(), &blob).unwrap();
    let mut record = device::Record {
        public_key: hex::encode(&public),
        key_id: Some(hex::encode(&blake3::hash(&public).as_bytes()[..16])),
        registered: true,
        ..Default::default()
    };
    device::save_record(dir.path(), &record).unwrap();
    assert_eq!(registered_key(&state).unwrap(), (blob, record.key_id.clone().unwrap()));
    record.key_id = Some("00".repeat(16));
    device::save_record(dir.path(), &record).unwrap();
    assert_eq!(registered_key(&state).unwrap_err().code, "approval_forbidden");
}

async fn check_requester_passthrough(expected_view: Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let state = NodeState::for_api(format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port()));
    *state.token.lock().unwrap() = Some("test-pairing-token".into());
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

fn breaker_view() -> Value {
    let mut v = view();
    v["request"] = json!({"kind":"breaker_reset", "terms":{}});
    v["breaker_reset"] = json!({
        "tripped":["grant_paused", "rate_limit_minute", "rate_limit_hour", "velocity_limit", "future_trip"],
        "breakers": {"limits":{"max_payments_per_minute":2,"max_payments_per_hour":12,
            "max_consecutive_failures":3,"max_msat_per_10_minutes":9000},
            "payments_last_minute":1,"payments_last_hour":7,"reserved_msat_last_10_minutes":1234,
            "consecutive_failures":3,"unresolved_payments":0,"paused":true},
        "budget_msat":10000,"remaining_msat":8766,"per_call_max_msat":1000,
        "grant_expires_at":2000000000,"resets_last_day":2,"state_digest":"ab".repeat(32)
    });
    v
}

#[tokio::test]
async fn breaker_approval_signs_exact_message_and_reads_top_level_snapshot() {
    let v = breaker_view();
    let message = v["approval_message"].as_str().unwrap();
    let signature = sign_checked(&v, "owner", message, |exact, reason| {
        assert_eq!(exact.as_bytes(), message.as_bytes());
        assert_eq!(reason, "Reset this app’s paused spending · Tripped: paused after failed payments, too many payments this minute, +3 more · Budget: up to 10 sats, 8\u{202f}766 msat left · Each payment: up to 1 sat · Grant ends: 2033-05-18 03:33:20 UTC · Device resets in the last day: 2 of 3 · Requested by app abcdef…123456");
        std::future::ready(Ok("signature".into()))
    }).await.unwrap();
    assert_eq!(signature, "signature");
    assert_eq!(checked_approval(&v, "owner", "changed").unwrap_err().code, "approval_changed");
    assert_eq!(checked_approval(&v, "requester", message).unwrap_err().code, "approval_self");

    let mut missing = v.clone();
    missing.as_object_mut().unwrap().remove("breaker_reset");
    assert_eq!(checked_approval(&missing, "owner", message).unwrap(),
        "Reset this app’s paused spending · Your node did not include the grant’s state · Requested by app abcdef…123456");
}

// Shared UTF-8 golden snapshots also exercised by the renderer in en and da.
#[tokio::test]
async fn shared_terms_and_biometric_snapshots_preserve_signed_bytes() {
    let fixtures: Value = serde_json::from_str(include_str!("../../tests/fixtures/owner-approval-format.json")).unwrap();
    for scenario in fixtures["scenarios"].as_array().unwrap() {
        let v = &scenario["view"];
        let original = v["approval_message"].as_str().unwrap();
        let expected = scenario["reason"].as_str().unwrap();
        let result = sign_checked(v, "owner", original, |message, reason| {
            assert_eq!(message.as_bytes(), original.as_bytes());
            assert_eq!(reason.as_bytes(), expected.as_bytes());
            let lines: Vec<&str> = scenario["lines"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert!(reason.encode_utf16().count() <= 300);
            assert!(reason.ends_with(" · Requested by app abcdef…123456"));
            if v["request"]["kind"] == "breaker_reset" {
                assert_eq!(breaker_lines(v, None).unwrap().join(" · "), lines.join(" · "));
            }
            std::future::ready(Ok("test-signature".into()))
        }).await.unwrap();
        assert_eq!(result, "test-signature");
    }
    for amount in fixtures["amounts"].as_array().unwrap() {
        let msat = amount["msat"].as_u64().unwrap();
        let text = amount["text"].as_str().unwrap();
        assert_eq!(sats(msat), text);
        // Both native consent paths retain main's exact prompt bytes.
        assert_eq!(device::intent_reason("Maya", msat, msat).as_bytes(),
            format!("approve paying up to {text} per day, at most {text} per message, to Maya").as_bytes());
        let mut v = view();
        v["client_pubkey"] = json!("ab".repeat(32));
        v["request"] = json!({"kind":"first_contact", "terms":{"recipient":"a".repeat(64), "max_total_msat":msat, "budget_msat":msat}});
        let original = v["approval_message"].as_str().unwrap();
        sign_checked(&v, "owner", original, |message, reason| {
            assert_eq!(message.as_bytes(), original.as_bytes());
            assert_eq!(reason, format!("Let this app message someone new · To: aaaaaa…aaaaaa · First message: up to {text} · Contact budget: up to {text} · Requested by app ababab…ababab"));
            std::future::ready(Ok("test-signature".into()))
        }).await.unwrap();
    }
}

#[tokio::test]
async fn prompt_limit_preserves_attribution_and_unicode_without_touching_signed_bytes() {
    let fixtures: Value = serde_json::from_str(include_str!("../../tests/fixtures/owner-approval-format.json")).unwrap();
    for case in fixtures["prompt_cases"].as_array().unwrap() {
        let mut v = fixtures["scenarios"][2]["view"].clone();
        v["breaker_reset"]["tripped"] = case["tripped"].clone();
        for (key, value) in case["snapshot"].as_object().unwrap() {
            v["breaker_reset"][key] = value.clone();
        }
        if let Some(length) = case["raw_utf16_length"].as_u64() {
            let full = format!("{} · Requested by app abcdef…123456", breaker_lines(&v, None).unwrap().join(" · "));
            assert_eq!(full.encode_utf16().count(), length as usize);
        }
        let original = v["approval_message"].as_str().unwrap();
        sign_checked(&v, "owner", original, |message, reason| {
            assert_eq!(message.as_bytes(), original.as_bytes());
            let prompt_lines: Vec<&str> = reason.split(" · ").collect();
            for line in breaker_lines(&v, None).unwrap().iter().skip(2).take(3) {
                assert!(prompt_lines.contains(&line.as_str()), "missing full line: {line}");
            }
            assert!(reason.ends_with(" · Requested by app abcdef…123456"));
            assert_eq!(reason.as_bytes(), case["reason"].as_str().unwrap().as_bytes());
            assert!(reason.encode_utf16().count() <= 300);
            std::future::ready(Ok("test-signature".into()))
        }).await.unwrap();
    }
}
