// Included in app::tests: real host commands against a loopback mock node.
#[tokio::test]
async fn add_device_detection_is_read_only_and_distinguishes_old_nodes_from_non_owners() {
    for (status, supported) in [(404, false), (405, false), (403, true), (200, true)] {
        let (node, _dir) = paired_fake(Arc::new(move |method, path, _| {
            assert_eq!(method, "GET");
            assert!(path.starts_with("/pair/device-key/pending?approver_key_id="));
            (status, "{\"pending\":[]}".into())
        }));
        node.state.remote_mode.store(true, Ordering::SeqCst);
        assert_eq!(add_device::supported(&node.state).await.unwrap(), supported);
        assert!(node.posts().is_empty());
    }
}
#[tokio::test]
async fn add_device_non_owner_cannot_mint_or_approve_even_with_renderer_input() {
    let (node, _dir) = paired_fake(happy());
    node.state.remote_mode.store(true, Ordering::SeqCst);
    for input in [
        add_device::Input::Mint,
        add_device::Input::Approve {
            op_id: "aa".repeat(12),
        },
    ] {
        let error = add_device::run(&node.state, input).await.err().unwrap();
        assert!(error.message.contains("enrolled owner"));
    }
    assert!(node.posts().is_empty());
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
struct DelegationNode {
    node: Fake,
    _dir: tempfile::TempDir,
    pending: Arc<Mutex<serde_json::Value>>,
    enrolled: Arc<AtomicBool>,
    challenge_valid: Arc<AtomicBool>,
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
fn delegation_node() -> DelegationNode { delegation_fixture(false) }
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
fn delegation_fixture(second: bool) -> DelegationNode { delegation_fixture_with_skew(second, 0) }
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
fn second_device_fixture(fp: &str, key_id: &str, expires_at: i64) -> serde_json::Value {
    let raw = include_str!("../tests/fixtures/node356-pending.json")
        .replace(&"11".repeat(16), fp)
        .replace("owner", "c1")
        .replace(&"22".repeat(16), key_id)
        // Match only expiry fields, never digits inside a generated identifier.
        .replace("\"expires_at\": 1300", &format!("\"expires_at\": {expires_at}"))
        .replace("expires_at:1300", &format!("expires_at:{expires_at}"));
    serde_json::from_str(&raw).unwrap()
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[test]
fn second_device_fixture_preserves_identifiers_containing_expiry_digits() {
    let node = "13001111111111111111111111111111";
    let key = "22222222222213002222222222222222";
    let pending: bitsov_app::second_device::Pending =
        serde_json::from_value(second_device_fixture(node, key, 2300)).unwrap();
    assert!(pending.validate(node, "c1", 7, key, 2000).is_ok());
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
fn delegation_fixture_with_skew(second: bool, skew: i64) -> DelegationNode {
    delegation_fixture_with_claim(second, skew, None)
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
fn delegation_fixture_with_claim(second: bool, skew: i64, claim: Option<(u16, String)>) -> DelegationNode {
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};
    let (blob, public) = device_key::create(device_key::Policy::NoPromptForTests).unwrap();
    let public_hex = hex::encode(public);
    let key_id = hex::encode(&blake3::hash(&public).as_bytes()[..16]);
    let seed = SigningKey::from_bytes(&[7; 32]);
    let node_id = hex::encode(seed.verifying_key().as_bytes());
    let fp = bitsov_app::home_node::identity_fingerprint(&node_id);
    let endpoint = "box.local:9737";
    let live = "09".repeat(32);
    let box_key = "22".repeat(32);
    let sig = |message: &[u8]| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(seed.sign(message).to_bytes())
    };
    let expiry = now_unix() + 300 + skew;
    let value = serde_json::json!({"v":2,"endpoint":endpoint,"endpoints":[endpoint],"node_id":node_id,
        "transport_pubkey":live,"transport_signature":sig(format!("bitsov-remote-transport-v1:{node_id}:{live}").as_bytes()),
        "box_transport_pubkey":box_key,"box_transport_signature":sig(format!("bitsov-box-transport-v1:{node_id}:{box_key}").as_bytes()),
        "endpoints_signature":sig(&serde_json::to_vec(&serde_json::json!(["bitsov-endpoints-v2",2,node_id,live,box_key,endpoint,[endpoint]])).unwrap()),
        "code":format!("owner_{}","33".repeat(32)),"expires_at":expiry});
    let uri = format!(
        "bitsov://pair/{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).unwrap())
    );
    // Frozen node #301 layout and SAS vector, shared with the contract tests.
    let mut fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/node301-pending.json")).unwrap();
    fixture["expires_at"] = (now_unix() + 900).into();
    fixture["delegation_message"] = fixture["delegation_message"]
        .as_str()
        .unwrap()
        .replace(&format!("node:{}", "11".repeat(16)), &format!("node:{fp}"))
        .into();
    if second {
        fixture = second_device_fixture(&fp, &key_id, now_unix() + 300);
    }
    let pending = Arc::new(Mutex::new(fixture));
    let enrolled = Arc::new(AtomicBool::new(true));
    let challenge_valid = Arc::new(AtomicBool::new(true));
    let (p, en, cv) = (pending.clone(), enrolled.clone(), challenge_valid.clone());
    let k = key_id.clone();
    let token_fp = fp.clone();
    let routes: Routes = Arc::new(move |method, path, body| {
        if path == "/owner/claim-code" {
            assert_eq!(method, "GET");
            return claim.clone().unwrap_or((404, String::new()));
        }
        let body: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        if path == "/status" && second {
            return (200, serde_json::json!({"api_capabilities":if cv.load(Ordering::SeqCst) {vec!["second_device_enrollment_v1"]} else {vec![]}}).to_string());
        }
        if path == "/pair/device-keys" {
            return (200,serde_json::json!({"node":fp,"client_id":"c1","device_approvals":"enabled","device_keys":if en.load(Ordering::SeqCst) {vec![serde_json::json!({"key_id":k})]} else {vec![]}}).to_string());
        }
        if path.starts_with("/pair/ticket?") {
            return (200, serde_json::json!({"nonce":"22".repeat(32),"message":format!("bitsov-ticket-v1\nnode:{}\nnonce:{}",if cv.load(Ordering::SeqCst) {fp.clone()} else {"00".repeat(16)},"22".repeat(32))}).to_string());
        }
        if path == "/pair/ticket" && method == "POST" {
            assert_eq!(body["approver_key_id"], k);
            assert_eq!(body["nonce"], "22".repeat(32));
            let expected = if second {
                assert_eq!(body["purpose"], "second_device");
                format!("bitsov-ticket-v2\nnode:{fp}\nnonce:{}\npurpose:second_device", "22".repeat(32))
            } else { format!("bitsov-ticket-v1\nnode:{fp}\nnonce:{}", "22".repeat(32)) };
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public)
                .verify(
                    expected.as_bytes(),
                    &hex::decode(body["signature"].as_str().unwrap()).unwrap(),
                )
                .unwrap();
            return (
                200,
                serde_json::json!({"uri":uri,"expires_at":expiry}).to_string(),
            );
        }
        if path.starts_with("/pair/device-key/pending?") {
            return (
                200,
                {
                    let p = p.lock().unwrap();
                    serde_json::json!({"pending":if p.is_array() { p.clone() } else { serde_json::json!([p.clone()]) }}).to_string()
                },
            );
        }
        if path.contains("/delegation?") {
            return (200, p.lock().unwrap().to_string());
        }
        if second && (path.ends_with("/second-device/approve") || path.ends_with("/second-device/reject")) {
            assert_eq!(body["approver_key_id"], k);
            let p = p.lock().unwrap();
            let reject = path.ends_with("/reject");
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public).verify(
                p[if reject {"reject_message"} else {"approval_message"}].as_str().unwrap().as_bytes(),
                &hex::decode(body["signature"].as_str().unwrap()).unwrap(),
            ).unwrap();
            if reject { return (204, String::new()); }
            return (200,serde_json::json!({"status":"registered","op_id":p["op_id"],"key_id":hex::encode(&blake3::hash(&hex::decode(p["public_key"].as_str().unwrap()).unwrap()).as_bytes()[..16])}).to_string());
        }
        if path.ends_with("/delegate") {
            assert_eq!(body["approver_key_id"], k);
            let p = p.lock().unwrap();
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, public)
                .verify(
                    p["delegation_message"].as_str().unwrap().as_bytes(),
                    &hex::decode(body["signature"].as_str().unwrap()).unwrap(),
                )
                .unwrap();
            return (200,serde_json::json!({"status":"registered","op_id":p["op_id"],"key_id":hex::encode(&blake3::hash(&hex::decode(p["public_key"].as_str().unwrap()).unwrap()).as_bytes()[..16])}).to_string());
        }
        happy()(method, path, "")
    });
    let (node, dir) = paired_fake(routes);
    node.state.remote_mode.store(true, Ordering::SeqCst);
    if second {
        let token = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"cid":"c1","epc":7,"idf":token_fp})).unwrap()));
        *node.state.token.lock().unwrap() = Some(token.clone());
        if let AuthMode::Paired(ref mut session) = *node.state.auth.lock().unwrap() { session.token = token; }
    }
    *node.state.node_id.lock().unwrap() = Some(node_id);
    *node.state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
    let store = device_store(&node.state).unwrap();
    device::save_blob(&store, &blob).unwrap();
    device::save_record(
        &store,
        &device::Record {
            public_key: public_hex,
            key_id: Some(key_id),
            registered: true,
            ..Default::default()
        },
    )
    .unwrap();
    DelegationNode {
        node,
        _dir: dir,
        pending,
        enrolled,
        challenge_valid,
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn owner_claim_code_uses_the_owner_local_api_and_existing_bearer_without_persistence() {
    let code = remote_access::second_tests::claim_code();
    let expires = now_unix() + 300;
    let d = delegation_fixture_with_claim(false, 0, Some((200,
        serde_json::json!({"state":"open", "code":code, "expires_at":expires, "device_name":"New device"}).to_string())));
    d.node.state.remote_mode.store(false, Ordering::SeqCst);
    let view = add_device::run(&d.node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await.unwrap();
    let value = serde_json::to_value(view).unwrap();
    assert_eq!(value["state"], "claim_code");
    assert_eq!(value["claim"]["state"], "open");
    assert_eq!(value["claim"]["code"], code);
    assert_eq!(value["claim"]["expires_at"], expires);
    let seen = d.node.seen.lock().unwrap();
    let requests: Vec<_> = seen.iter().filter(|(_, path, _, _)| path == "/api/v1/owner/claim-code").collect();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].2.as_deref(), Some("tok.1"));
    assert!(requests[0].3.is_empty());
    drop(seen);
    assert!(!d.node.state.add_device.lock().await.is_active());
    let store = device_store(&d.node.state).unwrap();
    for entry in std::fs::read_dir(store).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            assert!(!std::fs::read(path).unwrap().windows(code.len()).any(|bytes| bytes == code.as_bytes()));
        }
    }
    let ready = serde_json::to_value(add_device::run(&d.node.state, add_device::Input::Status).await.unwrap()).unwrap();
    assert_eq!(ready["owner"], true, "local enrolled owners can open the code sheet");
    assert!(!ready.to_string().contains(&code));
}

#[tokio::test]
async fn owner_claim_code_refuses_unauthenticated_and_ordinary_pairings() {
    for auth in [AuthMode::Unauthenticated, AuthMode::Local] {
        let node = fake(auth, happy());
        assert!(add_device::run(&node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await.is_err());
        assert!(!node.targets().iter().any(|p| p.contains("/owner/claim-code")));
    }
    let (node, _dir) = paired_fake(happy());
    assert!(add_device::run(&node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await.is_err());
    assert!(!node.targets().iter().any(|p| p.contains("/owner/claim-code")));
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn owner_claim_code_never_uses_a_remote_router_or_a_revoked_owner() {
    let d = delegation_node();
    assert!(add_device::run(&d.node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await.is_err());
    assert!(d.node.targets().is_empty(), "remote requests must be refused before reaching a proxy");
    d.node.state.remote_mode.store(false, Ordering::SeqCst);
    d.enrolled.store(false, Ordering::SeqCst);
    assert!(add_device::run(&d.node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await.is_err());
    assert!(!d.node.targets().iter().any(|p| p.contains("/owner/claim-code")));
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn owner_claim_code_local_status_remains_available_with_second_device_capability() {
    let d = delegation_fixture(true);
    d.node.state.remote_mode.store(false, Ordering::SeqCst);
    let view = add_device::run(&d.node.state, add_device::Input::Status).await.unwrap();
    assert_eq!(serde_json::to_value(view).unwrap()["owner"], true);
    assert!(!d.node.targets().iter().any(|p| p.contains("/owner/claim-code")), "status must not fetch a code");
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn owner_claim_code_projects_closed_claimed_and_unavailable_without_secrets() {
    for state in ["closed", "claimed", "unavailable"] {
        let d = delegation_fixture_with_claim(false, 0, Some((200, serde_json::json!({"state":state}).to_string())));
        d.node.state.remote_mode.store(false, Ordering::SeqCst);
        let view = add_device::run(&d.node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await.unwrap();
        assert_eq!(serde_json::to_value(view).unwrap()["claim"], serde_json::json!({"state":state}));
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn owner_claim_code_rejects_errors_expiry_and_malformed_responses_without_echoing_secrets() {
    let code = remote_access::second_tests::claim_code();
    for (status, body) in [
        (403, serde_json::json!({"error":code})),
        (429, serde_json::json!({"error":code})),
        (200, serde_json::json!({"state":"open", "code":code, "expires_at":now_unix()-1, "device_name":"Phone"})),
        (200, serde_json::json!({"state":"open", "code":"invalid", "expires_at":now_unix()+300, "device_name":"Phone"})),
        (200, serde_json::json!({"state":"claimed", "code":code})),
    ] {
        let d = delegation_fixture_with_claim(false, 0, Some((status, body.to_string())));
        d.node.state.remote_mode.store(false, Ordering::SeqCst);
        let result = add_device::run(&d.node.state, serde_json::from_value(serde_json::json!({"action":"claim_code"})).unwrap()).await;
        assert!(result.is_err(), "must refuse response at HTTP {status} for state {}", body["state"]);
        let error = result.err().unwrap();
        assert!(!error.message.contains(&code));
        assert!(!error.message.contains("invalid"));
    }
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn add_device_mints_then_delegates_exact_v2_bytes_using_owner_token() {
    let d = delegation_node();
    let s = &d.node.state;
    assert!(matches!(
        add_device::run(s, add_device::Input::Mint).await.unwrap(),
        add_device::View::Ticket { .. }
    ));
    assert!(
        add_device::run(
            s,
            add_device::Input::Approve {
                op_id: "aa".repeat(12)
            }
        )
        .await
        .is_err(),
        "must first display comparison"
    );
    let view =
        serde_json::to_value(add_device::run(s, add_device::Input::Poll).await.unwrap()).unwrap();
    assert_eq!(
        view["pending"][0]["words"],
        serde_json::json!(["noodle", "gallery", "demand", "science"])
    );
    assert_eq!(view["uri"], "", "discard ticket after a confirmed join");
    assert!(matches!(
        add_device::run(
            s,
            add_device::Input::Approve {
                op_id: "aa".repeat(12)
            }
        )
        .await
        .unwrap(),
        add_device::View::Done
    ));
    assert!(add_device::run(
        s,
        add_device::Input::Approve {
            op_id: "aa".repeat(12)
        }
    )
    .await
    .is_err());
    let posts = d.node.posts();
    assert_eq!(posts.len(), 2);
    assert!(posts[1].0.ends_with("/delegate"));
    for (_, _, token, _) in d.node.seen.lock().unwrap().iter() {
        assert_eq!(token.as_deref(), Some("tok.1"));
    }
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn add_device_refuses_changed_comparison_revocation_and_wrong_node_challenge() {
    for failure in ["changed", "revoked", "challenge", "expired"] {
        let d = delegation_node();
        let s = &d.node.state;
        if failure == "challenge" {
            d.challenge_valid.store(false, Ordering::SeqCst);
            assert!(add_device::run(s, add_device::Input::Mint).await.is_err());
            assert!(d.node.posts().is_empty());
            continue;
        }
        add_device::run(s, add_device::Input::Mint).await.unwrap();
        add_device::run(s, add_device::Input::Poll).await.unwrap();
        if failure == "changed" {
            d.pending.lock().unwrap()["name"] = "different device".into();
        }
        if failure == "expired" {
            d.pending.lock().unwrap()["expires_at"] = (now_unix() - 1).into();
        }
        if failure == "revoked" {
            d.enrolled.store(false, Ordering::SeqCst);
        }
        assert!(add_device::run(
            s,
            add_device::Input::Approve {
                op_id: "aa".repeat(12)
            }
        )
        .await
        .is_err());
        assert_eq!(d.node.posts().len(), 1, "no delegation after {failure}");
    }
}
#[tokio::test]
async fn legacy_device_cancellation_waits_for_the_joining_lifecycle() {
    let (node, _dir) = paired_fake(happy());
    let guard = node.state.add_device.lock().await;
    let cancel = legacy_device_change(&node.state, false);
    tokio::pin!(cancel);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut cancel)
        .await
        .is_err());
    assert!(node.posts().is_empty());
    drop(guard);
    cancel.await.unwrap();
}
#[tokio::test]
async fn add_device_detection_does_not_mistake_legacy_operation_status_for_pending_route() {
    // On old nodes, /device-key/pending is captured as an arbitrary operation id.
    let (node, _dir) = paired_fake(Arc::new(|_, _, _| {
        (
            200,
            r#"{"op_id":"pending","status":"lost","delegation_message":null}"#.into(),
        )
    }));
    node.state.remote_mode.store(true, Ordering::SeqCst);
    assert!(!add_device::supported(&node.state).await.unwrap());
}

// No enclave, UI runtime, or app launch: exercise reply persistence and the real cancel command.
#[tokio::test]
async fn add_device_invalid_reply_retains_operation_for_cancellation() {
    for (field, value) in [
        ("box_nonce", serde_json::json!("55".repeat(15))),
        ("key_id", serde_json::json!("66".repeat(17))),
        ("sas_version", serde_json::json!(2)),
        ("expires_at", serde_json::json!(-1)),
        ("expires_at", serde_json::json!(i64::MAX)),
        ("box_nonce", serde_json::Value::Null),
        ("op_id", serde_json::json!("aa".repeat(16))),
    ] {
        let (node, _dir) = paired_fake(Arc::new(|method, path, _| {
            assert_eq!(method, "DELETE");
            assert!(path.starts_with("/pair/device-key/"));
            (200, "{}".into())
        }));
        node.state.remote_mode.store(true, Ordering::SeqCst);
        let store = device_store(&node.state).unwrap();
        let mut record = device::Record::default();
        let mut reply = node_enrollment_reply();
        reply[field] = value;
        assert!(
            add_device::accept_enrollment_reply(
                &node.state,
                &store,
                &mut record,
                &serde_json::to_vec(&reply).unwrap(),
                1000
            )
            .is_err(),
            "{field}"
        );
        assert_eq!(
            device::load_record(&store).unwrap().pending.unwrap().op_id,
            reply["op_id"]
        );
        add_device::join(&node.state, add_device::JoinInput::Cancel)
            .await
            .unwrap();
        assert!(device::load_record(&store).unwrap().pending.is_none());
        let seen = node.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].1,
            format!(
                "/api/v1/pair/device-key/{}",
                reply["op_id"].as_str().unwrap()
            )
        );
    }
}
fn node_enrollment_reply() -> serde_json::Value {
    let p: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/node301-pending.json")).unwrap();
    serde_json::json!({"op_id":p["op_id"], "key_id":"66".repeat(16),
        "fingerprint":"6666-6666-6666-6666", "expires_at":1900,
        "sas_version":p["sas_version"], "box_nonce":p["box_nonce"]})
}
#[test]
fn add_device_enrollment_accepts_node_shape_and_bounded_clock_skew() {
    let state = NodeState::default();
    let dir = tempfile::tempdir().unwrap();
    for (expiry, accepted) in [
        (970, false),
        (971, true),
        (1000, true),
        (1900, true),
        (1930, true),
        (1931, false),
    ] {
        let mut reply = node_enrollment_reply();
        reply["expires_at"] = expiry.into();
        let mut record = device::Record::default();
        assert_eq!(
            add_device::accept_enrollment_reply(
                &state,
                dir.path(),
                &mut record,
                &serde_json::to_vec(&reply).unwrap(),
                1000
            )
            .is_ok(),
            accepted,
            "{expiry}"
        );
    }
}

#[test]
fn second_device_start_has_no_claim_code_contract() {
    assert!(serde_json::from_value::<add_device::JoinInput>(serde_json::json!({"action":"start_second"})).is_ok());
    assert!(serde_json::from_value::<add_device::JoinInput>(serde_json::json!({"action":"start_second","claim_code":""})).is_err());
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_owner_approves_or_rejects_signed_console_comparison_and_refuses_replay() {
    for reject in [false, true] {
        let d = delegation_fixture(true);
        let state = &d.node.state;
        assert!(add_device::run(state, add_device::Input::Approve { op_id:"aa".repeat(12) }).await.is_err());
        let view = serde_json::to_value(add_device::run(state, add_device::Input::Status).await.unwrap()).unwrap();
        assert_eq!(view["second_device"], true);
        assert_eq!(view["pending"][0]["can_approve"], true);
        let result = add_device::run(state, if reject {add_device::Input::Reject {op_id:"aa".repeat(12)}} else {add_device::Input::Approve {op_id:"aa".repeat(12)}}).await.unwrap();
        assert_eq!(serde_json::to_value(result).unwrap()["state"], if reject {"rejected"} else {"done"});
        assert!(add_device::run(state, add_device::Input::Approve {op_id:"aa".repeat(12)}).await.is_err());
    }
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_owner_refuses_wrong_words_expiry_changed_op_and_revoked_owner() {
    for change in ["words", "expiry", "changed", "revoked"] {
        let d = delegation_fixture(true);
        let state = &d.node.state;
        add_device::run(state, add_device::Input::Status).await.unwrap();
        if change == "revoked" { d.enrolled.store(false, Ordering::SeqCst); }
        else {
            let mut p = d.pending.lock().unwrap();
            match change {
                "words" => p["sas_words"][0] = "abandon".into(),
                "expiry" => p["expires_at"] = (now_unix()-1).into(),
                _ => p["nonce"] = "99".repeat(16).into(),
            }
        }
        assert!(add_device::run(state, add_device::Input::Approve {op_id:"aa".repeat(12)}).await.is_err());
        assert!(d.node.posts().is_empty());
    }
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_mint_signs_purpose_and_binds_current_ticket() {
    let d = delegation_fixture(true);
    let view = serde_json::to_value(add_device::run(&d.node.state, add_device::Input::Mint).await.unwrap()).unwrap();
    assert_eq!(view["second_device"], true);
    assert!(view["uri"].as_str().unwrap().starts_with("bitsov://pair/"));
}
#[tokio::test]
async fn second_device_cannot_start_on_normal_pairing_or_flag_off() {
    let (node, _dir) = paired_fake(happy());
    node.state.remote_mode.store(true, Ordering::SeqCst);
    assert!(add_device::join(&node.state, add_device::JoinInput::StartSecond {}).await.is_err());
    assert!(node.posts().is_empty());
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_join_uses_pinned_noise_node_digest_and_never_claims_on_refusal() {
    for status in [204, 403, 409, 410] {
        let (uri, server) = remote_access::second_tests::node(status).await;
        let (node, dir) = paired_fake(Arc::new(|method,path,_| {
            assert!(path.starts_with("/pair/device-key/"));
            match method {
                "DELETE" => (204,String::new()),
                "GET" => (200,r#"{"status":"pending"}"#.into()),
                _ => panic!("unexpected request"),
            }
        }));
        let state = &node.state;
        state.remote_mode.store(true,Ordering::SeqCst);
        *state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
        remote_access::import_pairing_link(dir.path(),&uri).unwrap();
        let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
        *state.node_id.lock().unwrap() = Some(descriptor.node_id().into());
        let ctx = state.pairing.lock().unwrap().clone().unwrap();
        let descriptor = remote_access::authenticate_pinned_transport_and_save_record(dir.path(),descriptor,&ctx.key,"Phone",&ctx.store,&state.remote_retry).await.unwrap();
        assert!(!descriptor.has_code());
        assert!(descriptor.enrollment_commitment().is_some());
        let restored = remote_access::load_persisted(dir.path()).unwrap().unwrap();
        assert!(!restored.has_code());
        assert!(restored.enrollment_commitment() == descriptor.enrollment_commitment());
        *state.remote_descriptor.lock().unwrap() = Some(descriptor);
        if let AuthMode::Paired(ref mut session) = *state.auth.lock().unwrap() { session.scopes.clear(); session.client_id = "c".repeat(32); }
        let result = add_device::join(state,add_device::JoinInput::StartSecond {}).await;
        if status == 204 {
            let view = serde_json::to_value(result.unwrap()).unwrap();
            assert_eq!(view["state"],"waiting");
            assert_eq!(view["second_device"],true);
            assert_eq!(view["words"].as_array().unwrap().len(),4);
            let poll = serde_json::to_value(add_device::join(state,add_device::JoinInput::Poll).await.unwrap()).unwrap();
            assert_eq!(poll["state"],"waiting");
            assert_eq!(poll["second_device"],true);
            assert!(add_device::join(state,add_device::JoinInput::StartSecond {}).await.is_err());
            // Process restart loses SAS words but retains the pending operation.
            *state.add_device.lock().await = add_device::Setup::default();
            let restarted = add_device::join(state,add_device::JoinInput::Status).await.err().unwrap();
            assert_eq!(restarted.code, "enrollment_restart");
        } else {
            let error = result.err().unwrap();
            assert!(!error.message.contains("claim code"));
            assert!(device::load_record(&device_store(state).unwrap()).unwrap().pending.is_some());
        }
        server.await.unwrap();
        add_device::join(state,add_device::JoinInput::Cancel).await.unwrap();
        assert!(device::load_record(&device_store(state).unwrap()).unwrap().pending.is_none());
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_background_poll_promotes_access_before_registered_view() {
    crate::profile::install("tech.mindlink.bitsov.remotetest").unwrap();
    use base64::Engine;
    let (uri, server) = remote_access::second_tests::node(204).await;
    let descriptor = remote_access::parse_pairing_link(&uri).unwrap();
    let node_id = descriptor.node_id().to_string();
    let fingerprint = bitsov_app::home_node::identity_fingerprint(&node_id);
    let client = "c".repeat(32);
    let token = format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"cid":client,"epc":7,"idf":fingerprint})).unwrap()));
    let registered = Arc::new(AtomicBool::new(false));
    let key = Arc::new(Mutex::new(String::new()));
    let (r,k) = (registered.clone(),key.clone());
    let identity = node_id.clone();
    let fail_identity = AtomicBool::new(true);
    let (node, dir) = paired_fake(Arc::new(move |_,path,_| {
        let value = if path.starts_with("/pair/challenge?") {
            serde_json::json!({"challenge":"bitsov-pair-token-v1:fixture"})
        } else if path == "/pair/token" {
            serde_json::json!({"token":token,"expires_at":now_unix()+86400,"scopes":["read","receive"]})
        } else if path == "/identity" {
            if fail_identity.swap(false,Ordering::SeqCst) { return (503,"{}".into()); }
            serde_json::json!({"node_id":identity})
        }
        else if path == "/pair/device-keys" { serde_json::json!({"node":fingerprint,"client_id":client,"device_keys":[{"key_id":*k.lock().unwrap()}]}) }
        else if path.starts_with("/pair/device-key/pending?") { serde_json::json!({"pending":[]}) }
        else if path.starts_with("/pair/device-key/") { serde_json::json!({"status":if r.load(Ordering::SeqCst) {"registered"} else {"pending"}}) }
        else { return (404,"{}".into()); };
        (200,value.to_string())
    }));
    let state = &node.state;
    state.remote_mode.store(true,Ordering::SeqCst);
    *state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
    remote_access::import_pairing_link(dir.path(),&uri).unwrap();
    let ctx = state.pairing.lock().unwrap().clone().unwrap();
    let descriptor = remote_access::authenticate_pinned_transport_and_save_record(dir.path(),descriptor,&ctx.key,"Phone",&ctx.store,&state.remote_retry).await.unwrap();
    *state.remote_descriptor.lock().unwrap() = Some(descriptor);
    *state.node_id.lock().unwrap() = Some(node_id.clone());
    *state.expected_remote_node_id.lock().unwrap() = Some(node_id);
    if let AuthMode::Paired(ref mut session) = *state.auth.lock().unwrap() { session.scopes.clear(); session.client_id = "c".repeat(32); }
    add_device::join(state,add_device::JoinInput::StartSecond {}).await.unwrap();
    server.await.unwrap();
    *key.lock().unwrap() = device::load_record(&device_store(state).unwrap()).unwrap().key_id.unwrap();
    registered.store(true,Ordering::SeqCst);
    // Simulate the App poll winning, with token issuance succeeding but the
    // identity request failing once. Never expose completion before retry.
    assert!(do_device_key_status(state).await.is_err());
    assert!(matches!(&*state.auth.lock().unwrap(), AuthMode::Paired(s) if s.scopes == ["read","receive"]));
    assert!(remote_access::load_persisted(dir.path()).unwrap().unwrap().enrollment_commitment().is_some());
    let view = do_device_key_status(state).await.unwrap();
    assert_eq!(view.state,device::DeviceState::Registered);
    assert!(remote_access::load_persisted(dir.path()).unwrap().unwrap().enrollment_commitment().is_none());
    assert!(state.remote_descriptor.lock().unwrap().as_ref().unwrap().enrollment_commitment().is_none());
    assert!(!view.second_device);
    assert!(matches!(&*state.auth.lock().unwrap(), AuthMode::Paired(s) if s.scopes == ["read","receive"]));
    assert!(*state.ready.lock().unwrap());
    assert!(state.error.lock().unwrap().is_none());
    assert_eq!(serde_json::to_value(add_device::join(state,add_device::JoinInput::Poll).await.unwrap()).unwrap()["state"],"done");
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_flag_off_stops_a_reviewed_approval_without_signing() {
    let d = delegation_fixture(true);
    add_device::run(&d.node.state, add_device::Input::Status).await.unwrap();
    d.challenge_valid.store(false, Ordering::SeqCst);
    let view = add_device::run(&d.node.state, add_device::Input::Approve {op_id:"aa".repeat(12)}).await.unwrap();
    assert!(matches!(view, add_device::View::Unsupported { .. }));
    assert!(d.node.posts().is_empty());
}
#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_foreign_ticket_cannot_be_approved_but_can_be_rejected() {
    let d = delegation_fixture(true);
    {
        let mut p = d.pending.lock().unwrap();
        p["issuer"] = "88".repeat(16).into();
        for field in ["approval_message", "reject_message"] {
            p[field] = p[field].as_str().unwrap().replace("issuer:console", &format!("issuer:{}", "88".repeat(16))).into();
        }
    }
    let view = serde_json::to_value(add_device::run(&d.node.state, add_device::Input::Status).await.unwrap()).unwrap();
    assert_eq!(view["pending"][0]["can_approve"], false);
    assert!(add_device::run(&d.node.state, add_device::Input::Approve {op_id:"aa".repeat(12)}).await.is_err());
    assert!(d.node.posts().is_empty());
    assert!(matches!(add_device::run(&d.node.state, add_device::Input::Reject {op_id:"aa".repeat(12)}).await.unwrap(), add_device::View::Rejected));
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn phone_first_join_accepts_zero_owner_devices_and_requires_console_claim() {
    for (platform, name) in [("android", "BitSov app on this Android phone"), ("ios", "BitSov app on this iPhone")] {
        let (uri, server) = remote_access::second_tests::first_node(name).await;
        let descriptor = remote_access::parse_pairing_link(&uri).unwrap();
        let node_id = descriptor.node_id().to_string();
        let fingerprint = bitsov_app::home_node::identity_fingerprint(&node_id);
        let (node, dir) = paired_fake(Arc::new(move |method, path, _| {
            assert_eq!(method, "GET");
            if path == "/pair/device-keys" {
                (200, serde_json::json!({"node":fingerprint,"client_id":"c".repeat(32),"owner_device_count":0,"device_keys":[],"device_approvals":"enabled"}).to_string())
            } else {
                assert!(path.starts_with("/pair/device-key/"));
                (200, r#"{"status":"pending"}"#.into())
            }
        }));
        let state = &node.state;
        state.remote_mode.store(true, Ordering::SeqCst);
        *state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
        remote_access::import_pairing_link(dir.path(), &uri).unwrap();
        let ctx = state.pairing.lock().unwrap().clone().unwrap();
        let descriptor = remote_access::authenticate_pinned_transport_and_save_record(dir.path(), descriptor, &ctx.key, name, &ctx.store, &state.remote_retry).await.unwrap();
        *state.remote_descriptor.lock().unwrap() = Some(descriptor);
        *state.node_id.lock().unwrap() = Some(node_id);
        if let AuthMode::Paired(ref mut session) = *state.auth.lock().unwrap() { session.client_id = "c".repeat(32); }
        assert!(add_device::join_on_platform(state, add_device::JoinInput::StartSecond {}, platform).await.is_err());
        let invalid = add_device::join_on_platform(state, add_device::JoinInput::Start { claim_code: String::new().into() }, platform).await.err().unwrap();
        assert!(invalid.message.contains("claim code"));
        assert!(device::load_record(&device_store(state).unwrap()).is_none());
        let result = add_device::join_on_platform(state, add_device::JoinInput::Start { claim_code: remote_access::second_tests::claim_code().into() }, platform).await;
        let view = serde_json::to_value(result.unwrap()).unwrap();
        assert_eq!(view["state"], "waiting");
        assert_eq!(view["second_device"], false);
        assert_eq!(view["words"].as_array().unwrap().len(), 4);
        assert!(!device::load_record(&device_store(state).unwrap()).unwrap().registered);
        server.await.unwrap();
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_mint_accepts_clock_skew_but_refuses_overlong_tickets() {
    for (skew, accepted) in [(-30, true), (30, true), (60, false)] {
        let d = delegation_fixture_with_skew(true, skew);
        assert_eq!(add_device::run(&d.node.state, add_device::Input::Mint).await.is_ok(), accepted, "skew={skew}");
    }
}

#[cfg(all(target_os = "macos", not(feature = "mobile")))]
#[tokio::test]
async fn second_device_poll_skips_bad_entries_and_keeps_valid_comparisons() {
    let d = delegation_fixture(true);
    let valid = d.pending.lock().unwrap().clone();
    let mut malformed = valid.clone(); malformed["expires_at"] = "bad".into();
    let mut wrong_words = valid.clone(); wrong_words["sas_words"][0] = "abandon".into();
    let mut expired = valid.clone(); expired["expires_at"] = (now_unix() - 31).into();
    *d.pending.lock().unwrap() = serde_json::json!([malformed, valid, wrong_words, expired]);
    let view = serde_json::to_value(add_device::run(&d.node.state, add_device::Input::Poll).await.unwrap()).unwrap();
    assert_eq!(view["pending"].as_array().unwrap().len(), 1);
    assert_eq!(view["pending"][0]["op_id"], valid["op_id"]);
    assert!(d.node.posts().is_empty());
    *d.pending.lock().unwrap() = valid;
    assert!(add_device::run(&d.node.state, add_device::Input::Approve {op_id:"aa".repeat(12)}).await.is_ok());
}
