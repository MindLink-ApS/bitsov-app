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
            op_id: "aa".repeat(16),
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
fn delegation_node() -> DelegationNode {
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
    let expiry = now_unix() + 300;
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
    // Independent fixture: node's v2 bytes, not the app's message constructor.
    let message = format!("bitsov-owner-delegation-v2\nnode:{fp}\nclient_pubkey:{}\nepoch:1\ndevice_key:04{}\nop_id:{}\nnonce:{}\nsas_digest:{}", "22".repeat(32),"44".repeat(64),"aa".repeat(16),"33".repeat(16),"00".repeat(32));
    let pending = Arc::new(Mutex::new(
        serde_json::json!({"op_id":"aa".repeat(16),"client_id":"new-client","name":"My phone",
        "public_key":format!("04{}","44".repeat(64)),"expires_at":now_unix()+900,"sas_version":1,"box_nonce":"55".repeat(16),
        "sas_words":["abandon","abandon","abandon","abandon"],"delegation_message":message}),
    ));
    let enrolled = Arc::new(AtomicBool::new(true));
    let challenge_valid = Arc::new(AtomicBool::new(true));
    let (p, en, cv) = (pending.clone(), enrolled.clone(), challenge_valid.clone());
    let k = key_id.clone();
    let routes: Routes = Arc::new(move |method, path, body| {
        let body: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        if path == "/pair/device-keys" {
            return (200,serde_json::json!({"node":fp,"client_id":"c1","device_approvals":"enabled","device_keys":if en.load(Ordering::SeqCst) {vec![serde_json::json!({"key_id":k})]} else {vec![]}}).to_string());
        }
        if path.starts_with("/pair/ticket?") {
            return (200, serde_json::json!({"nonce":"22".repeat(32),"message":format!("bitsov-ticket-v1\nnode:{}\nnonce:{}",if cv.load(Ordering::SeqCst) {fp.clone()} else {"00".repeat(16)},"22".repeat(32))}).to_string());
        }
        if path == "/pair/ticket" && method == "POST" {
            assert_eq!(body["approver_key_id"], k);
            assert_eq!(body["nonce"], "22".repeat(32));
            let expected = format!("bitsov-ticket-v1\nnode:{fp}\nnonce:{}", "22".repeat(32));
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
                serde_json::json!({"pending":[p.lock().unwrap().clone()]}).to_string(),
            );
        }
        if path.contains("/delegation?") {
            return (200, p.lock().unwrap().to_string());
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
                op_id: "aa".repeat(16)
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
        serde_json::json!(["abandon", "abandon", "abandon", "abandon"])
    );
    assert_eq!(view["uri"], "", "discard ticket after a confirmed join");
    assert!(matches!(
        add_device::run(
            s,
            add_device::Input::Approve {
                op_id: "aa".repeat(16)
            }
        )
        .await
        .unwrap(),
        add_device::View::Done
    ));
    assert!(add_device::run(
        s,
        add_device::Input::Approve {
            op_id: "aa".repeat(16)
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
                op_id: "aa".repeat(16)
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
