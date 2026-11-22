use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

#[derive(Default)]
struct Pins {
    pin: Mutex<Option<BoxPin>>,
    writes: std::sync::atomic::AtomicUsize,
}
impl BoxPinStore for Pins {
    fn read(&self, _: &str) -> Result<Option<BoxPin>, RemoteError> {
        Ok(self.pin.lock().unwrap().clone())
    }
    fn save(&self, pin: &BoxPin) -> Result<(), RemoteError> {
        self.writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.pin.lock().unwrap() = Some(pin.clone());
        Ok(())
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/home-node.json")).unwrap()
}
fn setup(endpoint: String, pinned: bool) -> (RemoteDescriptor, Arc<Pins>) {
    let f = fixture();
    let node = SigningKey::from_bytes(&[7; 32]);
    let transport = hex::encode(X25519PublicKey::from(&StaticSecret::from([12; 32])).to_bytes());
    let node_id = f["node_id"].as_str().unwrap().to_owned();
    let signature = node.sign(descriptor_signature_message(&node_id, &transport).as_bytes());
    let descriptor = validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
        bootstrap_routes: vec![], endpoints: vec![], endpoints_signature: None, box_transport_pubkey: String::new(), box_transport_signature: None,
        v: 1,
        endpoint: endpoint.clone(),
        node_id: node_id.clone(),
        transport_pubkey: transport,
        transport_signature: base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(signature.to_bytes()),
        code: None,
        sealed_code: None,
        hosted_by: None,
    })
    .unwrap();
    let pins = Arc::new(Pins::default());
    if pinned {
        *pins.pin.lock().unwrap() = Some(
            BoxPin::verify(
                &node_id,
                &endpoint,
                f["auth"]["box_transport_pubkey"].as_str().unwrap(),
                f["auth"]["box_transport_signature"].as_str().unwrap(),
            )
            .unwrap(),
        );
    }
    (descriptor.with_pin_store(pins.clone()), pins)
}
async fn responder(
    listener: TcpListener,
    secret: u8,
    auth: Value,
) -> Result<(TcpStream, TransportState, RemoteAuthRequest), RemoteError> {
    let (mut stream, _) = listener.accept().await.unwrap();
    let secret = [secret; 32];
    let mut hs = Builder::new(NOISE_PROTOCOL.parse().unwrap())
        .local_private_key(&secret)
        .and_then(|b| b.build_responder())
        .unwrap();
    let mut out = vec![0; MAX_HANDSHAKE_FRAME];
    let msg = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
    hs.read_message(&msg, &mut out).unwrap();
    let n = hs.write_message(&[], &mut out).unwrap();
    write_frame(&mut stream, &out[..n]).await?;
    let msg = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
    hs.read_message(&msg, &mut out).unwrap();
    let mut noise = hs.into_transport_mode().unwrap();
    let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await?;
    let request = serde_json::from_slice(&decode_transport(
        &mut noise,
        &encrypted,
        MAX_AUTH_PLAINTEXT,
    )?)
    .unwrap();
    let encrypted = encode_transport(&mut noise, &serde_json::to_vec(&auth).unwrap())?;
    write_frame(&mut stream, &encrypted).await?;
    Ok((stream, noise, request))
}

#[tokio::test]
async fn box_never_tofu_and_first_pairing_never_uses_box_pin() {
    for (pinned, first_pairing, secret) in [(false, false, 9), (true, true, 9), (true, false, 10)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), pinned);
        if first_pairing {
            descriptor.code =
                Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1; 32]));
        }
        let server = tokio::spawn(responder(listener, secret, fixture()["auth"].clone()));
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let result = connect_authenticated(&descriptor, &key, "fixture").await;
        assert!(result.is_err(), "unpinned/first-pairing box accepted");
        assert!(
            server.await.unwrap().is_err(),
            "client sent auth to an untrusted static"
        );
        assert_eq!(pins.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn only_identity_transport_can_learn_the_signed_box_fixture() {
    for tamper in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), false);
        let identity_pin = descriptor.transport_pubkey.clone();
        let mut auth = fixture()["auth"].clone();
        if tamper {
            auth["box_transport_pubkey"] = json!("ab".repeat(32));
        }
        let server = tokio::spawn(responder(listener, 12, auth));
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let result = connect_authenticated(&descriptor, &key, "fixture").await;
        assert_eq!(result.is_ok(), !tamper);
        assert_eq!(
            pins.writes.load(std::sync::atomic::Ordering::SeqCst),
            usize::from(!tamper)
        );
        assert_eq!(descriptor.transport_pubkey, identity_pin);
        server.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn locked_fixture_accepts_existing_auth_and_never_replaces_pin() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), true);
    let server = tokio::spawn(responder(listener, 9, fixture()["auth"].clone()));
    let dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(dir.path()).unwrap();
    let connection = LockedConnection::connect(&descriptor, &key, "fixture")
        .await
        .unwrap()
        .unwrap();
    assert!(connection
        .pin
        .matches(connection.noise.get_remote_static().unwrap()));
    let (_, _, request) = server.await.unwrap().unwrap();
    assert!(
        request.code.is_none() && request.client_pubkey.is_none() && request.signature.is_none()
    );
    assert_eq!(pins.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn password_crosses_only_the_pinned_noise_session_and_errors_never_echo_it() {
    for status in [200, 202, 204, 401, 403, 409, 429, 500] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (descriptor, _) = setup(listener.local_addr().unwrap().to_string(), true);
        let server = tokio::spawn(async move {
            let (mut stream, mut noise, _) = responder(listener, 9, fixture()["auth"].clone())
                .await
                .unwrap();
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            assert!(!encrypted.windows(18).any(|b| b == b"fixture-password!!"));
            let request = decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT).unwrap();
            let split = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            assert!(request.starts_with(b"POST /api/v1/node/unlock HTTP/1.1\r\n"));
            let body: Value = serde_json::from_slice(&request[split + 4..]).unwrap();
            assert_eq!(body["password"], "fixture-password!!");
            assert_eq!(body.as_object().unwrap().len(), 4);
            // A hostile endpoint may echo the password: the client returns only fixed copy.
            let echo = if status == 204 {
                ""
            } else {
                "fixture-password!!"
            };
            let reply = format!(
                "HTTP/1.1 {status} Reply\r\nContent-Length: {}\r\n\r\n{echo}",
                echo.len()
            );
            // Deliberately split HTTP headers across two Noise frames.
            for chunk in reply.as_bytes().chunks(11) {
                let encrypted = encode_transport(&mut noise, chunk).unwrap();
                write_frame(&mut stream, &encrypted).await.unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let mut connection = LockedConnection::connect(&descriptor, &key, "fixture")
            .await
            .unwrap()
            .unwrap();
        let body = crate::home_node::UnlockBody {
            challenge: "aa".repeat(32),
            key_id: "key".into(),
            signature: "der".into(),
            password: zeroize::Zeroizing::new("fixture-password!!".into()),
        };
        let result = connection.unlock(&body).await;
        assert_eq!(result.is_ok(), status == 204);
        if let Err(error) = result {
            assert!(!error.to_string().contains("fixture-password"));
        }
        server.await.unwrap();
    }
}

#[test]
fn saved_box_pin_is_reverified_and_bound_to_node_and_endpoint() {
    let (descriptor, pins) = setup("node.example:4242".into(), true);
    assert!(descriptor.box_pin().unwrap().is_some());
    pins.pin.lock().unwrap().as_mut().unwrap().endpoint = "attacker.example:4242".into();
    assert!(descriptor.box_pin().is_err());
    pins.pin.lock().unwrap().as_mut().unwrap().endpoint = descriptor.endpoint.clone();
    pins.pin.lock().unwrap().as_mut().unwrap().signature = "invalid".into();
    assert!(descriptor.box_pin().is_err());
}

#[tokio::test]
async fn identity_pinned_session_can_repair_a_stale_box_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), true);
    pins.pin.lock().unwrap().as_mut().unwrap().endpoint = "old.example:4242".into();
    let server = tokio::spawn(responder(listener, 12, fixture()["auth"].clone()));
    let dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(dir.path()).unwrap();
    connect_authenticated(&descriptor, &key, "fixture")
        .await
        .unwrap();
    assert_eq!(
        descriptor.box_pin().unwrap().unwrap().endpoint,
        descriptor.endpoint()
    );
    server.await.unwrap().unwrap();
}


#[tokio::test]
async fn locked_status_preserves_optional_attempt_budget_without_echoing_other_fields() {
    for attempts in [None, Some(0), Some(17)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (descriptor, _) = setup(listener.local_addr().unwrap().to_string(), true);
        let server = tokio::spawn(async move {
            let (mut stream, mut noise, _) = responder(listener, 9, fixture()["auth"].clone()).await.unwrap();
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            let request = decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT).unwrap();
            assert!(request.starts_with(b"GET /api/v1/node/lock HTTP/1.1"));
            let node = fixture()["node_id"].as_str().unwrap().to_owned();
            let mut body = json!({"state":"locked", "node_id":node,
                "fingerprint":crate::home_node::identity_fingerprint(&node)});
            if let Some(attempts) = attempts { body["attempts_left"] = json!(attempts); }
            let body = body.to_string();
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            let encrypted = encode_transport(&mut noise, reply.as_bytes()).unwrap();
            write_frame(&mut stream, &encrypted).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let mut connection = LockedConnection::connect(&descriptor, &key, "fixture").await.unwrap().unwrap();
        assert_eq!(connection.status().await.unwrap().attempts_left, attempts);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn bootstrap_sas_preserves_one_completed_session_across_requests_and_fallbacks() {
    let live = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first = dead.local_addr().unwrap().to_string(); drop(dead);
    let second = live.local_addr().unwrap().to_string();
    let box_key = hex::encode(X25519PublicKey::from(&StaticSecret::from([9;32])).to_bytes());
    let descriptor = validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
        v:2, endpoint:first.clone(), endpoints:vec![first, second], bootstrap_routes:vec![], endpoints_signature:None,
        node_id:String::new(), transport_pubkey:String::new(), transport_signature:String::new(),
        box_transport_pubkey:box_key.clone(), box_transport_signature:None, code:None,sealed_code:None,hosted_by:None,
    }).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = live.accept().await.unwrap();
        let secret = [9;32];
        let mut hs = Builder::new(NOISE_PROTOCOL.parse().unwrap()).local_private_key(&secret).and_then(|b| b.build_responder()).unwrap();
        let mut out = vec![0;MAX_HANDSHAKE_FRAME];
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await.unwrap(); hs.read_message(&message, &mut out).unwrap();
        let n = hs.write_message(&[], &mut out).unwrap(); write_frame(&mut stream, &out[..n]).await.unwrap();
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await.unwrap(); hs.read_message(&message, &mut out).unwrap();
        let hash = hs.get_handshake_hash().to_vec();
        let client_static = hs.get_remote_static().unwrap().to_vec();
        let mut noise = hs.into_transport_mode().unwrap();
        let message = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
        let auth: RemoteAuthRequest = serde_json::from_slice(&decode_transport(&mut noise, &message, MAX_AUTH_PLAINTEXT).unwrap()).unwrap();
        assert_eq!(auth.v, 1); assert!(auth.code.is_none());
        let reply = json!({"status":"ok","v":1,"client_id":"a".repeat(32),"scopes":["read","receive","identity"]});
        let frame = encode_transport(&mut noise, &serde_json::to_vec(&reply).unwrap()).unwrap(); write_frame(&mut stream, &frame).await.unwrap();
        for (path, body) in [("/api/v1/identity/create-pending", "commitment"), ("/api/v1/identity/finalize", "chosen password")] {
            let message = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            let request = decode_transport(&mut noise, &message, MAX_NOISE_PLAINTEXT).unwrap();
            let text = std::str::from_utf8(&request).unwrap();
            assert!(text.starts_with(&format!("POST {path} HTTP/1.1\r\n")));
            assert!(text.contains("Authorization: Bearer bst-token\r\n"));
            assert!(text.ends_with(body));
            let frame = encode_transport(&mut noise, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
            write_frame(&mut stream, &frame).await.unwrap();
        }
        (hash, client_static)
    });
    let dir = tempfile::tempdir().unwrap(); let key = ClientKey::load_or_create(dir.path()).unwrap();
    let mut connection = BootstrapConnection::connect(&descriptor,&key,"fixture").await.unwrap();
    let binding = connection.binding;
    for (path, body) in [("/api/v1/identity/create-pending", "commitment"), ("/api/v1/identity/finalize", "chosen password")] {
        let (status, _) = connection.request("POST",path,body.as_bytes(),"bst-token").await.unwrap(); assert_eq!(status,200);
    }
    let (hash, client_static) = server.await.unwrap();
    assert_eq!(&binding.handshake_hash[..], &hash); assert_eq!(&binding.client_static[..], &client_static);
    assert_eq!(hex::encode(binding.box_public_key),box_key);
}

#[test]
fn v1_refuses_even_empty_v2_wire_fields() {
    let node = SigningKey::from_bytes(&[7;32]);
    let live = [12;32];
    let node_id = hex::encode(node.verifying_key().as_bytes());
    let public = hex::encode(live);
    let value = json!({"v":1,"endpoint":"box.local:9737","node_id":node_id,
        "transport_pubkey":public,"transport_signature":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(node.sign(descriptor_signature_message(&node_id,&public).as_bytes()).to_bytes()),
        "code":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3;32]), "endpoints":[]});
    let uri = format!("bitsov://pair/{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap()));
    assert!(parse_pairing_link(&uri).is_err());
}

#[test]
fn finalize_preserves_fallback_routes_and_rejects_changed_or_unsigned_pins() {
    let dir=tempfile::tempdir().unwrap();
    let pins=Arc::new(Pins::default());
    let box_key="22".repeat(32);
    let previous=validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
        v:2,endpoint:"dead.local:9737".into(),endpoints:vec!["dead.local:9737".into(),"192.168.1.2:9737".into()],bootstrap_routes:vec![],endpoints_signature:None,
        node_id:String::new(),transport_pubkey:String::new(),transport_signature:String::new(),box_transport_pubkey:box_key.clone(),box_transport_signature:None,
        code:None,sealed_code:None,hosted_by:None,
    }).unwrap().with_pin_store(pins);
    persist_at(&config_path(dir.path()), &previous).unwrap();
    let node=SigningKey::from_bytes(&[7;32]);let id=hex::encode(node.verifying_key().as_bytes());let live="09".repeat(32);
    let sign=|text:String|base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(node.sign(text.as_bytes()).to_bytes());
    let box_sig=sign(format!("bitsov-box-transport-v1:{id}:{box_key}"));let live_sig=sign(descriptor_signature_message(&id,&live));
    assert!(commit_bootstrap(dir.path(),&previous,&id,&"33".repeat(32),&box_sig,&live,&live_sig).is_err());
    assert!(commit_bootstrap(dir.path(),&previous,&id,&box_key,"forged",&live,&live_sig).is_err());
    assert!(commit_bootstrap(dir.path(),&previous,&id,&box_key,&box_sig,"","").is_err());
    let committed=commit_bootstrap(dir.path(),&previous,&id,&box_key,&box_sig,&live,&live_sig).unwrap();
    let proxy=RemoteProxy {stopped:None,descriptor:Arc::new(Mutex::new(previous.clone())),local_addr:"127.0.0.1:1".parse().unwrap(),
        shutdown:watch::channel(false).0,last_error:Arc::new(Mutex::new(None))};
    proxy.finish_bootstrap(committed.clone()).unwrap();
    assert_eq!(proxy.descriptor.lock().unwrap().node_id,id);
    let (unrelated, _) = setup("other:9737".into(), false);
    assert!(proxy.finish_bootstrap(unrelated).is_err());
    assert_eq!(proxy.descriptor.lock().unwrap().node_id,id);
    assert_eq!(committed.bootstrap_routes,previous.endpoints);
    assert_eq!(committed.box_pin().unwrap().unwrap().public_key,box_key);
    let restored=load_persisted(dir.path()).unwrap().unwrap();
    assert_eq!(restored.bootstrap_routes,previous.endpoints);
    assert_eq!(restored.transport_pubkey,live);
    assert!(commit_bootstrap(dir.path(),&previous,&id,&box_key,&box_sig,&live,"forged").is_err());
}

#[test]
fn bootstrap_preview_and_import_use_box_fingerprint_without_an_identity() {
    let link = json!({"v":2,"endpoint":"box.local:9737","endpoints":["box.local:9737"],
        "box_transport_pubkey":"22".repeat(32),"code":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3;32])});
    let uri = format!("bitsov://pair/{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&link).unwrap()));
    assert_eq!(preview_pairing_link(&uri).unwrap().node_id_fingerprint,"22222222…22222222");
    let dir=tempfile::tempdir().unwrap();
    assert_eq!(import_pairing_link(dir.path(),&uri).unwrap().node_id_fingerprint,"22222222…22222222");
}

// PR #287 locked AuthResponse additions, using the exact proof domain/encoding
// from remote_bootstrap_tests.rs and the deterministic identity in home-node.json.
fn pr287_auth() -> Value {
    serde_json::from_str::<Value>(include_str!("../../tests/fixtures/remote-first-run-pr287.json"))
        .unwrap()["locked_auth"].clone()
}

#[tokio::test]
async fn pr287_locked_auth_accepts_valid_live_proof_and_rejects_tampering() {
    for case in ["valid", "missing-key", "missing-signature", "wrong-key", "wrong-domain", "padded"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (descriptor, _) = setup(listener.local_addr().unwrap().to_string(), true);
        let mut auth = pr287_auth();
        match case {
            "missing-key" => { auth.as_object_mut().unwrap().remove("transport_pubkey"); }
            "missing-signature" => { auth.as_object_mut().unwrap().remove("transport_signature"); }
            "wrong-key" => auth["transport_pubkey"] = "2a".repeat(32).into(),
            "wrong-domain" => auth["transport_signature"] = auth["box_transport_signature"].clone(),
            "padded" => auth["transport_signature"] = format!("{}=", auth["transport_signature"].as_str().unwrap()).into(),
            _ => {}
        }
        let server = tokio::spawn(responder(listener, 9, auth));
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let result = LockedConnection::connect(&descriptor, &key, "fixture").await;
        assert_eq!(result.is_ok(), case == "valid", "{case}");
        server.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn pr287_lost_receipt_recovers_only_through_pinned_locked_auth() {
    for case in ["valid", "absent", "wrong-static", "wrong-node", "wrong-client", "wrong-box-proof", "not-locked"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let mut auth = pr287_auth();
        let node = fixture()["node_id"].as_str().unwrap().to_owned();
        let box_key = auth["box_transport_pubkey"].as_str().unwrap().to_owned();
        let descriptor = validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
            v: 1, endpoint, endpoints: vec![], bootstrap_routes: vec![], endpoints_signature: None,
            node_id: String::new(), transport_pubkey: String::new(), transport_signature: String::new(),
            box_transport_pubkey: box_key, box_transport_signature: None,
            code: None, sealed_code: None, hosted_by: None,
        }).unwrap();
        let expected_client = auth["client_id"].as_str().unwrap().to_owned();
        if case == "absent" {
            auth.as_object_mut().unwrap().remove("transport_pubkey");
            auth.as_object_mut().unwrap().remove("transport_signature");
        }
        if case == "wrong-client" { auth["client_id"] = "b".repeat(32).into(); }
        if case == "wrong-box-proof" { auth["box_transport_signature"] = auth["transport_signature"].clone(); }
        let server_node = node.clone();
        let server = tokio::spawn(async move {
            let result = responder(listener, if case == "wrong-static" { 12 } else { 9 }, auth).await;
            if case == "wrong-static" { assert!(result.is_err(), "auth reached unknown live responder"); return; }
            let (mut stream, mut noise, request) = result.unwrap();
            assert!(request.code.is_none() && request.signature.is_none());
            if case == "valid" || case == "not-locked" {
                let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
                let request = decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT).unwrap();
                assert!(request.starts_with(b"GET /api/v1/node/lock HTTP/1.1"));
                let body = json!({"state": if case == "not-locked" { "unlocked" } else { "locked" },
                    "node_id":server_node,"fingerprint":crate::home_node::identity_fingerprint(&server_node)}).to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                let encrypted = encode_transport(&mut noise, response.as_bytes()).unwrap();
                write_frame(&mut stream, &encrypted).await.unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let trusted_node = if case == "wrong-node" { "ab".repeat(32) } else { node };
        let result = recover_bootstrap(&descriptor, &key, "fixture", &trusted_node, &expected_client).await;
        assert_eq!(result.is_ok(), case == "valid", "{case}");
        if let Ok(Some(proofs)) = result {
            assert_eq!(proofs.transport_pubkey, pr287_auth()["transport_pubkey"]);
            assert_eq!(proofs.transport_signature, pr287_auth()["transport_signature"]);
            assert_eq!(proofs.pin.node_id, trusted_node);
        }
        assert!(!descriptor.has_live_pin(), "recovery must not mutate pins before full verification");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn pr287_precommit_recovery_keeps_bootstrap_available_without_adopting_a_pin() {
    for state in ["bootstrap", "locked"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node = fixture()["node_id"].as_str().unwrap().to_owned();
        let box_key = fixture()["auth"]["box_transport_pubkey"].as_str().unwrap().to_owned();
        let descriptor = validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
            v: 1, endpoint: listener.local_addr().unwrap().to_string(), endpoints: vec![],
            bootstrap_routes: vec![], endpoints_signature: None, node_id: String::new(),
            transport_pubkey: String::new(), transport_signature: String::new(),
            box_transport_pubkey: box_key, box_transport_signature: None,
            code: None, sealed_code: None, hosted_by: None,
        }).unwrap();
        let server = tokio::spawn(async move {
            let auth = json!({"status":"ok","v":1,"client_id":"a".repeat(32),"scopes":["read","receive","identity"]});
            let (mut stream, mut noise, _) = responder(listener, 9, auth).await.unwrap();
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            let request = decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT).unwrap();
            assert!(request.starts_with(b"GET /api/v1/bootstrap/state HTTP/1.1"));
            let body = json!({"state":state}).to_string();
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            let encrypted = encode_transport(&mut noise, reply.as_bytes()).unwrap();
            write_frame(&mut stream, &encrypted).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let result = recover_bootstrap(&descriptor, &key, "fixture", &node, &"a".repeat(32)).await;
        if state == "bootstrap" { assert!(matches!(result, Ok(None))); }
        else { assert!(result.is_err()); }
        assert!(!descriptor.has_live_pin());
        assert!(descriptor.node_id().is_empty());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn joining_sas_uses_one_authenticated_transcript_and_never_replays_ticket() {
    let live = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (descriptor, _) = setup(live.local_addr().unwrap().to_string(), true);
    let box_key = fixture()["auth"]["box_transport_pubkey"].as_str().unwrap().to_owned();
    let server = tokio::spawn(async move {
        let (mut stream, _) = live.accept().await.unwrap();
        let secret = [12;32];
        let mut hs = Builder::new(NOISE_PROTOCOL.parse().unwrap()).local_private_key(&secret).and_then(|b| b.build_responder()).unwrap();
        let mut out = vec![0;MAX_HANDSHAKE_FRAME];
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await.unwrap(); hs.read_message(&message, &mut out).unwrap();
        let n = hs.write_message(&[], &mut out).unwrap(); write_frame(&mut stream, &out[..n]).await.unwrap();
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await.unwrap(); hs.read_message(&message, &mut out).unwrap();
        let hash = hs.get_handshake_hash().to_vec();
        let client_static = hs.get_remote_static().unwrap().to_vec();
        let mut noise = hs.into_transport_mode().unwrap();
        let message = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
        let auth: RemoteAuthRequest = serde_json::from_slice(&decode_transport(&mut noise, &message, MAX_AUTH_PLAINTEXT).unwrap()).unwrap();
        assert_eq!(auth.v, 1); assert!(auth.code.is_none());
        let reply = fixture()["auth"].clone();
        let frame = encode_transport(&mut noise, &serde_json::to_vec(&reply).unwrap()).unwrap(); write_frame(&mut stream, &frame).await.unwrap();
        for (path, body) in [("/api/v1/pair/device-key", "commitment"), ("/api/v1/pair/device-key/aa/finalize", "SAS-bound possession proof")] {
            let message = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            let request = decode_transport(&mut noise, &message, MAX_NOISE_PLAINTEXT).unwrap();
            let text = std::str::from_utf8(&request).unwrap();
            assert!(text.starts_with(&format!("POST {path} HTTP/1.1\r\n")));
            assert!(text.contains("Authorization: Bearer bst-token\r\n"));
            assert!(text.ends_with(body));
            let frame = encode_transport(&mut noise, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
            write_frame(&mut stream, &frame).await.unwrap();
        }
        (hash, client_static)
    });
    let dir = tempfile::tempdir().unwrap(); let key = ClientKey::load_or_create(dir.path()).unwrap();
    let mut connection = BootstrapConnection::connect_device(&descriptor,&key,"fixture").await.unwrap();
    let binding = connection.binding;
    for (path, body) in [("/api/v1/pair/device-key", "commitment"), ("/api/v1/pair/device-key/aa/finalize", "SAS-bound possession proof")] {
        let (status, _) = connection.request("POST",path,body.as_bytes(),"bst-token").await.unwrap(); assert_eq!(status,200);
    }
    let (hash, client_static) = server.await.unwrap();
    assert_eq!(&binding.handshake_hash[..], &hash); assert_eq!(&binding.client_static[..], &client_static);
    assert_eq!(hex::encode(binding.box_public_key),box_key);
}

#[tokio::test]
async fn owner_ticket_auth_refusal_has_expiry_used_and_revocation_guidance_without_echo() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (mut descriptor, _) = setup(listener.local_addr().unwrap().to_string(), true);
    let code = format!("owner_{}", "ab".repeat(32));
    descriptor.code = Some(code.clone());
    let server = tokio::spawn(responder(listener, 12, json!({"status":"error","v":1,"code":"authentication_failed","message":"bad proof"})));
    let dir=tempfile::tempdir().unwrap(); let key=ClientKey::load_or_create(dir.path()).unwrap();
    let error=connect_authenticated(&descriptor,&key,"joining device").await.err().unwrap().to_string();
    assert!(error.contains("expired")); assert!(error.contains("already used")); assert!(error.contains("revoked"));
    assert!(!error.contains(&code));
    let (_,_,request)=server.await.unwrap().unwrap(); assert_eq!(request.code.as_deref(),Some(code.as_str()));
}

#[tokio::test]
async fn second_device_lost_pairing_reply_recovers_without_replaying_ticket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (mut descriptor, _) = setup(listener.local_addr().unwrap().to_string(), true);
    descriptor.code = Some(format!("second_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([77;32])));
    let dir = tempfile::tempdir().unwrap();
    persist_at(&config_path(dir.path()), &descriptor).unwrap();
    let store = dir.path().join("pairing");
    let key = ClientKey::load_or_create(&store).unwrap();
    let server = tokio::spawn(async move {
        // Consume the signed proof but lose the authenticated response.
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut hs = Builder::new(NOISE_PROTOCOL.parse().unwrap()).local_private_key(&[12;32]).and_then(|b| b.build_responder()).unwrap();
        let mut out = vec![0;MAX_HANDSHAKE_FRAME];
        let msg = read_frame(&mut stream,MAX_HANDSHAKE_FRAME).await.unwrap(); hs.read_message(&msg,&mut out).unwrap();
        let n = hs.write_message(&[],&mut out).unwrap(); write_frame(&mut stream,&out[..n]).await.unwrap();
        let msg = read_frame(&mut stream,MAX_HANDSHAKE_FRAME).await.unwrap(); hs.read_message(&msg,&mut out).unwrap();
        let mut noise = hs.into_transport_mode().unwrap();
        let encrypted = read_frame(&mut stream,MAX_TRANSPORT_FRAME).await.unwrap();
        let first: Value = serde_json::from_slice(&decode_transport(&mut noise,&encrypted,MAX_AUTH_PLAINTEXT).unwrap()).unwrap();
        assert!(first["code"].as_str().unwrap().starts_with("second_"));
        drop(stream);
        let mut auth = fixture()["auth"].clone(); auth["scopes"] = json!([]);
        let (_, _, next) = responder(listener,12,auth).await.unwrap();
        assert!(next.code.is_none(), "a sent ticket may never be retried");
    });
    let result = authenticate_pinned_transport_and_save_record(dir.path(),descriptor,&key,"Phone",&store,&RemoteRetry::default()).await.unwrap();
    assert!(!result.has_code());
    assert!(result.enrollment_commitment().is_some());
    assert!(!load_persisted(dir.path()).unwrap().unwrap().has_code());
    server.await.unwrap();
}

#[tokio::test]
async fn second_device_one_use_pairing_requires_a_node_identity_before_saving_record() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (mut descriptor, _) = setup(listener.local_addr().unwrap().to_string(), false);
    descriptor.node_id.clear();
    descriptor.code = Some(format!("second_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([77;32])));
    let dir = tempfile::tempdir().unwrap();
    persist_at(&config_path(dir.path()), &descriptor).unwrap();
    let store = dir.path().join("pairing");
    let key = ClientKey::load_or_create(&store).unwrap();
    let auth = json!({"status":"ok","v":1,"client_id":"0123456789abcdef0123456789abcdef","scopes":[]});
    let server = tokio::spawn(responder(listener, 12, auth));
    let result = authenticate_pinned_transport_and_save_record(dir.path(),descriptor,&key,"Phone",&store,&RemoteRetry::default()).await;
    server.await.unwrap().unwrap();
    assert!(matches!(result, Err(RemoteError::Invalid(ref message)) if message == "unexpected provisional pairing"));
    assert!(!store.join(pairing::RECORD_FILE).exists());
    let saved = saved_descriptor(&std::fs::read(config_path(dir.path())).unwrap()).unwrap();
    assert!(!saved.has_code(), "the consumed ticket must stay retired");
}

#[test]
fn second_device_cleanup_does_not_overwrite_a_replacement_or_forgotten_descriptor() {
    for replaced in [false, true] {
        let (mut current, _) = setup("127.0.0.1:9737".into(), true);
        current.enrollment_commitment = Some([1;32]);
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(dir.path());
        if replaced {
            let mut replacement = current.clone();
            replacement.enrollment_commitment = Some([2;32]);
            persist_at(&path, &replacement).unwrap();
        }
        let before = std::fs::read(&path).ok();
        assert!(clear_enrollment_commitment(dir.path(), &mut current).is_err());
        assert_eq!(current.enrollment_commitment, Some([1;32]));
        assert_eq!(std::fs::read(&path).ok(), before);
    }
}
