//! Mobile-path tests: MockRuntime, temporary tickets, and loopback fakes.
use super::*;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn ticket(endpoint: String, first_run: bool) -> String {
    ticket_for(endpoint, first_run, 42)
}

fn ticket_for(endpoint: String, first_run: bool, seed: u8) -> String {
    let node = SigningKey::from_bytes(&[seed; 32]);
    let public = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from([43; 32]));
    let node_id = hex::encode(node.verifying_key().as_bytes());
    let transport_pubkey = hex::encode(public.as_bytes());
    let signature = node.sign(remote_access::descriptor_signature_message(&node_id, &transport_pubkey).as_bytes());
    let mut value = if first_run {
        serde_json::json!({"v": 2, "endpoint": endpoint, "endpoints": [endpoint], "box_transport_pubkey": transport_pubkey})
    } else {
        serde_json::json!({"v": 1, "endpoint": endpoint, "node_id": node_id,
            "transport_pubkey": transport_pubkey,
            "transport_signature": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())})
    };
    value["code"] = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([44; 32]).into();
    format!("bitsov://pair/{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap()))
}

async fn noise_responder(listener: tokio::net::TcpListener) {
    noise_auth_reply(listener, false).await;
}

async fn noise_auth_reply(listener: tokio::net::TcpListener, accept: bool) -> remote_access::RemoteAuthRequest {
    let (mut stream, _) = listener.accept().await.unwrap();
    let secret = [43; 32];
    let mut noise = snow::Builder::new("Noise_XX_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
        .local_private_key(&secret).build_responder().unwrap();
    let mut output = [0; 1024];
    for step in 0..2 {
        let length = stream.read_u32().await.unwrap();
        let mut message = vec![0; length as usize];
        stream.read_exact(&mut message).await.unwrap();
        noise.read_message(&message, &mut output).unwrap();
        if step == 0 {
            let length = noise.write_message(&[], &mut output).unwrap();
            stream.write_u32(length as u32).await.unwrap();
            stream.write_all(&output[..length]).await.unwrap();
        }
    }
    // Refuse after the verified Noise exchange so attachment completes without
    // a real node, proxy, token, Keychain access, or retry loop.
    let mut noise = noise.into_transport_mode().unwrap();
    let length = stream.read_u32().await.unwrap();
    let mut message = vec![0; length as usize];
    stream.read_exact(&mut message).await.unwrap();
    assert_eq!(u16::from_be_bytes([message[0], message[1]]) as usize, message.len() - 2);
    let length = noise.read_message(&message[2..], &mut output).unwrap();
    let request = serde_json::from_slice(&output[..length]).unwrap();
    let reply = if accept {
        br#"{"v":1,"status":"ok","client_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","scopes":["read"]}"#.as_slice()
    } else {
        br#"{"v":1,"status":"error","code":"test_refusal","message":"test complete"}"#.as_slice()
    };
    let length = noise.write_message(reply, &mut output).unwrap();
    stream.write_u32((length + 2) as u32).await.unwrap();
    stream.write_u16(length as u16).await.unwrap();
    stream.write_all(&output[..length]).await.unwrap();
    request
}

fn app() -> tauri::App<tauri::test::MockRuntime> {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    struct NoSavedBoxPins;
    impl bitsov_app::home_node::BoxPinStore for NoSavedBoxPins {
        fn read(&self, _: &str) -> Result<Option<bitsov_app::home_node::BoxPin>, remote_access::RemoteError> { Ok(None) }
        fn save(&self, _: &bitsov_app::home_node::BoxPin) -> Result<(), remote_access::RemoteError> { panic!("v1 fixture must not save box pins") }
    }
    let mut state = NodeState::for_api(format!("http://127.0.0.1:{port}/api/v1"));
    state.remote_pins = Arc::new(NoSavedBoxPins);
    tauri::test::mock_builder().manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap()
}


#[tokio::test]
async fn connect_clears_error_and_dials_without_restart() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), false);
    let server = tokio::spawn(noise_responder(listener));
    *state.error.lock().unwrap() = Some("Pair this phone with your box to continue.".into());
    let result = remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap();
    assert!(!result.restart_required);
    assert!(state.status_snapshot().error.is_none());
    tokio::time::timeout(Duration::from_secs(3), server).await.unwrap().unwrap();
    let _guard = state.remote_recovery.lock().await;
    assert!(state.remote_mode.load(Ordering::SeqCst));
}

#[tokio::test]
async fn connect_rejects_first_run_before_persisting_or_dialing() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), true);
    let error = remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap_err();
    assert_eq!(error.kind, remote_access::ConnectionErrorKind::Unclaimed);
    assert!(remote_access::load_persisted(dir.path()).unwrap().is_none());
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test]
async fn forget_cancels_connect_and_prevents_descriptor_resurrection() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), false);
    remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap();
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept()).await.unwrap().unwrap();
    remote_access_forget_at(&state, dir.path()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), stream.read_to_end(&mut bytes)).await.unwrap().unwrap();
    assert!(remote_access::load_persisted(dir.path()).unwrap().is_none());
    assert!(state.remote_proxy.lock().unwrap().is_none());
    assert!(state.pairing.lock().unwrap().is_none());
}

#[tokio::test]
async fn connect_retires_live_proxy_and_its_unauthenticated_sockets() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let old = ticket("127.0.0.1:1".into(), false);
    remote_access::import_pairing_link(dir.path(), &old).unwrap();
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    let store = dir.path().join(PAIRING_STORE_DIR);
    let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
    let proxy = remote_access::start_proxy(&state.api_base, dir.path(), descriptor, key,
        PAIRING_CLIENT_NAME, store, state.remote_proxy_auth.clone(), state.remote_retry.clone()).await.unwrap();
    let addr = proxy.local_addr();
    let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio::task::yield_now().await;
    *state.remote_proxy.lock().unwrap() = Some(proxy);
    state.remote_mode.store(true, Ordering::SeqCst);
    *state.ready.lock().unwrap() = true;
    *state.node_id.lock().unwrap() = Some("old-node".into());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let next = ticket(listener.local_addr().unwrap().to_string(), false);
    let server = tokio::spawn(noise_responder(listener));
    remote_access_connect_at(app.handle(), &state, dir.path(), &next).await.unwrap();
    let mut byte = [0; 1];
    assert!(matches!(tokio::time::timeout(Duration::from_secs(1), idle.read(&mut byte)).await.unwrap(),
        Ok(0) | Err(_)));
    let _rebound = tokio::net::TcpListener::bind(addr).await.expect("old listener released before connect returns");
    assert!(!state.status_snapshot().ready);
    assert!(state.status_snapshot().node_id.is_none());
    tokio::time::timeout(Duration::from_secs(3), server).await.unwrap().unwrap();
}

#[test]
fn connection_errors_are_structured_and_never_echo_peer_secrets() {
    use remote_access::{ConnectionError, RemoteError};
    for (error, kind) in [
        (RemoteError::Unclaimed, "unclaimed"),
        (RemoteError::LocalNetwork, "local_network"),
        (RemoteError::Transport("sensitive-peer-text".into()), "unreachable"),
        (RemoteError::HandshakeUnavailable, "unreachable"),
        (RemoteError::Expired(1), "expired"),
        (RemoteError::Expired(86401), "clock"),
        (RemoteError::RateLimited(1), "busy"),
        (RemoteError::Refused(remote_access::USED_TICKET_MESSAGE.into()), "used"),
        (RemoteError::Invalid("sensitive-peer-text".into()), "other"),
    ] {
        let json = serde_json::to_value(ConnectionError::from(&error)).unwrap();
        assert_eq!(json["kind"], kind);
        assert!(!json.to_string().contains("sensitive-peer-text"));
    }
    for endpoint in ["100.64.0.1:9737", "100.127.255.255:9737", "box.tail.ts.net:9737"] {
        assert_eq!(serde_json::to_value(ConnectionError::for_endpoint(&RemoteError::HandshakeUnavailable, Some(endpoint))).unwrap()["kind"], "tailscale");
    }
    for endpoint in ["100.63.255.255:9737", "100.128.0.1:9737", "box.ts.net.evil:9737"] {
        assert_eq!(serde_json::to_value(ConnectionError::for_endpoint(&RemoteError::HandshakeUnavailable, Some(endpoint))).unwrap()["kind"], "unreachable");
    }
}

#[tokio::test]
async fn old_refresh_cannot_publish_after_connection_generation_changes() {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let state = NodeState::for_api(format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port()));
    let store = dir.path().join(PAIRING_STORE_DIR);
    *state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
        client: PairingClient::new(state.http.clone(), state.api_base.clone()),
        key: Arc::new(ClientKey::load_or_create(&store).unwrap()), store,
        data_dir: dir.path().to_owned(),
    }));
    *state.auth.lock().unwrap() = AuthMode::Paired(PairedSession {
        client_id: "a".repeat(32), token: "old".into(), scopes: vec!["read".into()], expires_at: now_unix(),
    });
    let (seen, reached) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            stream.read(&mut bytes).await.unwrap();
            let body = if index == 0 { serde_json::json!({"challenge":"bitsov-pair-token-v1:test"}) }
                else { serde_json::json!({"token":"late-old-token", "scopes":["read"], "expires_at":now_unix()+600}) }.to_string();
            if index == 1 {
                seen.send(()).unwrap();
                released.await.unwrap();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                stream.write_all(response.as_bytes()).await.unwrap();
                break;
            }
            let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let refresh = refresh_paired(&state);
    tokio::pin!(refresh);
    tokio::select! { _ = reached => {}, _ = &mut refresh => panic!("refresh finished before response") }
    state.remote_connect_generation.send_modify(|generation| {
        *generation += 1;
        *state.auth.lock().unwrap() = AuthMode::Unauthenticated;
        *state.token.lock().unwrap() = None;
    });
    release.send(()).unwrap();
    assert!(refresh.await.is_err());
    assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated));
    assert!(state.token.lock().unwrap().is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn replacing_another_node_retires_its_retry_deadline() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket("127.0.0.1:1".into(), false)).unwrap();
    state.remote_retry.failed(&remote_access::RemoteError::RateLimited(60));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let next = ticket_for(listener.local_addr().unwrap().to_string(), false, 41);
    remote_access_connect_at(app.handle(), &state, dir.path(), &next).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), listener.accept()).await.is_ok());
    remote_access_forget_at(&state, dir.path()).await.unwrap();
}

#[tokio::test]
async fn reconnecting_same_node_keeps_its_retry_deadline() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let same = ticket(listener.local_addr().unwrap().to_string(), false);
    remote_access::import_pairing_link(dir.path(), &same).unwrap();
    state.remote_retry.failed(&remote_access::RemoteError::RateLimited(60));
    remote_access_connect_at(app.handle(), &state, dir.path(), &same).await.unwrap();
    assert!(state.remote_retry.remaining().unwrap() >= 60);
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
    remote_access_forget_at(&state, dir.path()).await.unwrap();
}

// Protocol fixture: real pinned Noise, owner-ticket auth, token challenge and
// identity routes. No sidecar, Keychain prompt, window, or live node data.
async fn connected_node_session(mut stream: tokio::net::TcpStream, node_id: String) -> std::io::Result<()> {
    async fn frame(stream: &mut tokio::net::TcpStream) -> std::io::Result<Vec<u8>> {
        let len = stream.read_u32().await? as usize;
        assert!(len < 65536);
        let mut bytes = vec![0; len];
        stream.read_exact(&mut bytes).await?;
        Ok(bytes)
    }
    async fn write(stream: &mut tokio::net::TcpStream, bytes: &[u8]) -> std::io::Result<()> {
        stream.write_u32(bytes.len() as u32).await?;
        stream.write_all(bytes).await
    }
    async fn encrypted_write(stream: &mut tokio::net::TcpStream, noise: &mut snow::TransportState, bytes: &[u8]) -> std::io::Result<()> {
        let mut out = vec![0; bytes.len() + 32];
        let len = noise.write_message(bytes, &mut out[2..]).unwrap();
        out[..2].copy_from_slice(&(len as u16).to_be_bytes());
        write(stream, &out[..len + 2]).await
    }
    let mut noise = snow::Builder::new("Noise_XX_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
        .local_private_key(&[43; 32]).build_responder().unwrap();
    let mut plain = vec![0; 65536];
    noise.read_message(&frame(&mut stream).await?, &mut plain).unwrap();
    let len = noise.write_message(&[], &mut plain).unwrap();
    write(&mut stream, &plain[..len]).await?;
    noise.read_message(&frame(&mut stream).await?, &mut plain).unwrap();
    let mut noise = noise.into_transport_mode().unwrap();
    let auth = frame(&mut stream).await?;
    noise.read_message(&auth[2..], &mut plain).unwrap();
    encrypted_write(&mut stream, &mut noise,
        br#"{"v":1,"status":"ok","client_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","scopes":["read"]}"#).await?;
    let mut request = Vec::new();
    loop {
        let encrypted = frame(&mut stream).await?;
        let len = noise.read_message(&encrypted[2..], &mut plain).unwrap();
        request.extend_from_slice(&plain[..len]);
        let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") else { continue; };
        let head = std::str::from_utf8(&request[..end]).unwrap();
        let body_len = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())).unwrap_or(0);
        if request.len() < end + 4 + body_len { continue; }
        let path = head.split_whitespace().nth(1).unwrap();
        let (status, body) = if path.starts_with("/api/v1/pair/challenge") {
            (200, serde_json::json!({"challenge":"bitsov-pair-token-v1:test"}))
        } else if path == "/api/v1/pair/token" {
            (200, serde_json::json!({"token":"fixture.token", "expires_at":now_unix()+600, "scopes":["read"]}))
        } else if path == "/api/v1/identity" {
            (200, serde_json::json!({"node_id":node_id,"network":"regtest"}))
        } else { (404, serde_json::json!({"error":"not found"})) };
        let body = body.to_string();
        let response = format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        encrypted_write(&mut stream, &mut noise, response.as_bytes()).await?;
        return Ok(());
    }
}

async fn connected_node(seed: u8) -> (String, String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket_for(listener.local_addr().unwrap().to_string(), false, seed);
    let id = hex::encode(SigningKey::from_bytes(&[seed; 32]).verifying_key().as_bytes());
    let identity = id.clone();
    let task = tokio::spawn(async move {
        let mut sessions = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = sessions.join_next(), if !sessions.is_empty() => {},
                accepted = listener.accept() => {
                    let (stream, _) = accepted.unwrap();
                    let id = identity.clone();
                    sessions.spawn(async move { let _ = connected_node_session(stream, id).await; });
                }
            }
        }
    });
    (link, id, task)
}

#[tokio::test]
async fn connect_reaches_ready_and_replaces_a_ready_node_without_restart() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let (first, first_id, first_node) = connected_node(42).await;
    let (second, second_id, second_node) = connected_node(41).await;
    let mut proxy_address = None;
    for (link, expected) in [(first, first_id), (second, second_id)] {
        *state.room_routing_policy.lock().unwrap() = Some(("ldk".into(), act::RoutingFeePolicy::default()));
        *state.configured_network.lock().unwrap() = Some("regtest".into());
        *state.last_remint.lock().unwrap() = Some(Instant::now());
        let result = remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap();
        assert!(!result.restart_required);
        assert!(state.room_routing_policy.lock().unwrap().is_none());
        assert!(state.configured_network.lock().unwrap().is_none());
        assert!(state.last_remint.lock().unwrap().is_none());
        let ready = tokio::time::timeout(Duration::from_secs(5), async {
            while !state.status_snapshot().ready { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await;
        assert!(ready.is_ok(), "state={}, error={:?}, kind={:?}", state.pairing_snapshot().state,
            state.pairing_snapshot().reason, state.remote_retry.connection_error().map(|e| e.kind));
        assert_eq!(state.status_snapshot().node_id.as_deref(), Some(expected.as_str()));
        assert_eq!(state.pairing_snapshot().state, "paired");
        assert!(state.status_snapshot().error.is_none());
        assert!(!remote_access::load_persisted(dir.path()).unwrap().unwrap().has_code());
        let address = state.remote_proxy.lock().unwrap().as_ref().unwrap().local_addr();
        if let Some(previous) = proxy_address { assert_eq!(address, previous); }
        proxy_address = Some(address);
    }
    let proxy = state.remote_proxy.lock().unwrap().take().unwrap();
    proxy.stop_and_wait().await;
    first_node.abort();
    second_node.abort();
}

#[tokio::test]
async fn failed_import_replaces_surviving_proxy_and_finishes_auth() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let (old, old_id, old_node) = connected_node(42).await;
    remote_access::import_pairing_link(dir.path(), &old).unwrap();
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    let store = dir.path().join(PAIRING_STORE_DIR);
    let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
    let proxy = remote_access::start_proxy(&state.api_base, dir.path(), descriptor, key,
        PAIRING_CLIENT_NAME, store, state.remote_proxy_auth.clone(), state.remote_retry.clone()).await.unwrap();
    let addr = proxy.local_addr();
    let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
    *state.remote_proxy.lock().unwrap() = Some(proxy);
    state.remote_mode.store(true, Ordering::SeqCst);
    // A previously ready connection must be hidden during failed-import teardown.
    *state.ready.lock().unwrap() = true;
    // A directory at the atomic-write staging path makes import fail without
    // damaging the previous persisted descriptor.
    let staging = dir.path().join(remote_access::REMOTE_CONFIG_DIR).join(format!("{}.tmp", remote_access::REMOTE_CONFIG_FILE));
    std::fs::create_dir(&staging).unwrap();
    let next = ticket_for("127.0.0.1:1".into(), false, 41);
    let result = remote_access_connect_at(app.handle(), &state, dir.path(), &next).await;
    assert!(!state.status_snapshot().ready, "failed import must hide readiness before reconnecting");
    std::fs::remove_dir(staging).unwrap();
    assert!(result.is_err());
    assert_eq!(remote_access::load_persisted(dir.path()).unwrap().unwrap().node_id(), old_id);
    let recovered = tokio::time::timeout(Duration::from_secs(5), async {
        while !state.status_snapshot().ready { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await;
    assert!(recovered.is_ok(), "failed import must resume the cancelled authentication");
    assert_eq!(state.status_snapshot().node_id.as_deref(), Some(old_id.as_str()));
    let mut byte = [0; 1];
    assert!(matches!(tokio::time::timeout(Duration::from_secs(1), idle.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    let proxy = state.remote_proxy.lock().unwrap().take().unwrap();
    assert_eq!(proxy.local_addr(), addr);
    proxy.stop_and_wait().await;
    old_node.abort();
}

#[tokio::test]
async fn connect_reports_the_sealed_window_rejection() {
    let app = app();
    let window = tauri::WebviewWindowBuilder::new(&app, "assistant", Default::default()).build().unwrap();
    let error = remote_access_connect(window, app.handle().clone(), app.state::<NodeState>(), "".into()).await.unwrap_err();
    assert_eq!(error.detail, "this command is only available to the main window");
}

#[tokio::test]
async fn phone_setup_is_unknown_until_saved_descriptor_has_been_checked() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    assert_eq!(state.status_snapshot().phone_setup, None);
    let dir = tempfile::tempdir().unwrap();
    connect_remote_at(&state, dir.path(), true).await.unwrap();
    assert_eq!(state.status_snapshot().phone_setup, Some(true));
}

#[tokio::test]
async fn unreadable_saved_descriptor_routes_to_review_and_error_recovery() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let remote = dir.path().join(remote_access::REMOTE_CONFIG_DIR);
    std::fs::create_dir_all(&remote).unwrap();
    std::fs::write(remote.join(remote_access::REMOTE_CONFIG_FILE), b"invalid").unwrap();
    assert!(connect_remote_at(&state, dir.path(), true).await.is_err());
    assert_eq!(state.status_snapshot().phone_setup, Some(false));
}
