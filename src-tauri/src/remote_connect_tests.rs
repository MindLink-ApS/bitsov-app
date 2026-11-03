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
    let (stream, _) = listener.accept().await.unwrap();
    noise_auth_reply_stream(stream, accept).await
}

async fn noise_auth_reply_stream(mut stream: tokio::net::TcpStream, accept: bool) -> remote_access::RemoteAuthRequest {
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
    struct NoSavedBoxPins;
    impl bitsov_app::home_node::BoxPinStore for NoSavedBoxPins {
        fn read(&self, _: &str) -> Result<Option<bitsov_app::home_node::BoxPin>, remote_access::RemoteError> { Ok(None) }
        fn save(&self, _: &bitsov_app::home_node::BoxPin) -> Result<(), remote_access::RemoteError> { panic!("v1 fixture must not save box pins") }
    }
    app_with_pins(Arc::new(NoSavedBoxPins))
}

fn app_with_pins(pins: Arc<dyn bitsov_app::home_node::BoxPinStore>) -> tauri::App<tauri::test::MockRuntime> {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut state = NodeState::for_api(format!("http://127.0.0.1:{port}/api/v1"));
    state.remote_pins = pins;
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

// The node answered "no" to the saved pairing. The live feed's recovery (and on
// a phone, every focus change) must not dial it again: each dial would repeat
// the refusal and, on a phone, its Face ID / Touch ID prompt. Only the owner's
// action (Try again, a new link) dials again.
#[tokio::test]
async fn a_refused_pairing_is_not_redialled_until_the_owner_acts() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), false);
    let dials = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server = {
        let dials = dials.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                dials.fetch_add(1, Ordering::SeqCst);
                noise_auth_reply_stream(stream, false).await;
            }
        })
    };
    let refused = || async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !state.pairing_snapshot().refused { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.expect("the node's refusal reaches the pairing view");
    };
    remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap();
    refused().await;
    let _ = state.remote_recovery.lock().await;
    assert_eq!(dials.load(Ordering::SeqCst), 1);
    let view = serde_json::to_value(state.pairing_snapshot()).unwrap();
    assert_eq!((view["state"].as_str(), view["refused"].as_bool()), (Some("failed"), Some(true)));
    for _ in 0..3 {
        tokio::time::timeout(Duration::from_secs(3), reconnect_remote_background(&state)).await.unwrap().unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(dials.load(Ordering::SeqCst), 1, "no automatic dial after a refusal");
    // Try again is the owner's action: it dials once.
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    assert_eq!(dials.load(Ordering::SeqCst), 2);
    assert!(state.pairing_snapshot().refused);
    server.abort();
}

// A box whose answers can change mid-test. Every tunnel serves keep-alive HTTP,
// so a token request can reuse a warm tunnel without another handshake: the
// counters show both dials and token requests that reach the box.
#[derive(Default)]
struct BoxControl {
    /// Authentication requests inside a completed Noise handshake.
    handshakes: std::sync::atomic::AtomicUsize,
    /// Of those, the ones that presented a pairing code.
    ticket_auths: std::sync::atomic::AtomicUsize,
    /// `/pair/challenge` and `/pair/token` requests.
    token_requests: std::sync::atomic::AtomicUsize,
    /// Answer authentication with `authentication_failed` (revoked client).
    refuse_auth: std::sync::atomic::AtomicBool,
    /// Answer a code-bearing authentication with `already_paired`.
    already_paired: std::sync::atomic::AtomicBool,
    /// A non-zero status replaces the 200 reply on these token routes.
    challenge_status: std::sync::atomic::AtomicU16,
    token_status: std::sync::atomic::AtomicU16,
    /// Serve as a box that rebooted locked: its pinned box static and proof,
    /// and this (non-200) reply to the lock status request.
    locked: std::sync::atomic::AtomicBool,
    lock_status: std::sync::atomic::AtomicU16,
    /// Hold each authentication reply this long, so other tunnels queue.
    auth_delay_ms: std::sync::atomic::AtomicU64,
}

/// The box static a locked box presents, and the node's signature over it.
const BOX_STATIC_SECRET: [u8; 32] = [45; 32];

fn box_proof() -> (String, String) {
    let node = SigningKey::from_bytes(&[42; 32]);
    let node_id = hex::encode(node.verifying_key().as_bytes());
    let key = hex::encode(x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(BOX_STATIC_SECRET)).as_bytes());
    let signature = node.sign(format!("bitsov-box-transport-v1:{node_id}:{key}").as_bytes());
    (key, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

/// A box pin saved by an earlier session: with it, every status probe is an
/// authenticated handshake with the box.
#[derive(Default)]
struct SavedBoxPins(std::sync::Mutex<Option<bitsov_app::home_node::BoxPin>>);

impl bitsov_app::home_node::BoxPinStore for SavedBoxPins {
    fn read(&self, _: &str) -> Result<Option<bitsov_app::home_node::BoxPin>, remote_access::RemoteError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, pin: &bitsov_app::home_node::BoxPin) -> Result<(), remote_access::RemoteError> {
        *self.0.lock().unwrap() = Some(pin.clone());
        Ok(())
    }
}

impl BoxControl {
    fn counts(&self) -> (usize, usize) {
        (self.handshakes.load(Ordering::SeqCst), self.token_requests.load(Ordering::SeqCst))
    }
    fn refuse(&self, refuse: bool, challenge_status: u16) {
        self.refuse_auth.store(refuse, Ordering::SeqCst);
        self.challenge_status.store(challenge_status, Ordering::SeqCst);
    }
}

async fn controlled_box_session(mut stream: tokio::net::TcpStream, node_id: String, control: Arc<BoxControl>) -> std::io::Result<()> {
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
    let locked = control.locked.load(Ordering::SeqCst);
    let secret = if locked { BOX_STATIC_SECRET } else { [43; 32] };
    let mut noise = snow::Builder::new("Noise_XX_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
        .local_private_key(&secret).build_responder().unwrap();
    let mut plain = vec![0; 65536];
    noise.read_message(&frame(&mut stream).await?, &mut plain).unwrap();
    let len = noise.write_message(&[], &mut plain).unwrap();
    write(&mut stream, &plain[..len]).await?;
    noise.read_message(&frame(&mut stream).await?, &mut plain).unwrap();
    let mut noise = noise.into_transport_mode().unwrap();
    let auth = frame(&mut stream).await?;
    let len = noise.read_message(&auth[2..], &mut plain).unwrap();
    let request: remote_access::RemoteAuthRequest = serde_json::from_slice(&plain[..len]).unwrap();
    control.handshakes.fetch_add(1, Ordering::SeqCst);
    if request.code.is_some() { control.ticket_auths.fetch_add(1, Ordering::SeqCst); }
    let delay = control.auth_delay_ms.load(Ordering::SeqCst);
    if delay > 0 { tokio::time::sleep(Duration::from_millis(delay)).await; }
    let reply: Vec<u8> = if control.refuse_auth.load(Ordering::SeqCst) {
        br#"{"v":1,"status":"error","code":"authentication_failed","message":"unknown client"}"#.to_vec()
    } else if request.code.is_some() && control.already_paired.load(Ordering::SeqCst) {
        br#"{"v":1,"status":"error","code":"already_paired","message":"client already paired"}"#.to_vec()
    } else if locked {
        let (key, signature) = box_proof();
        format!(r#"{{"v":1,"status":"ok","client_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","scopes":["read"],"box_transport_pubkey":"{key}","box_transport_signature":"{signature}"}}"#).into_bytes()
    } else {
        br#"{"v":1,"status":"ok","client_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","scopes":["read"]}"#.to_vec()
    };
    let reply = reply.as_slice();
    encrypted_write(&mut stream, &mut noise, reply).await?;
    if !reply.starts_with(br#"{"v":1,"status":"ok""#) { return Ok(()); }
    let mut request = Vec::new();
    loop {
        let encrypted = frame(&mut stream).await?;
        let len = noise.read_message(&encrypted[2..], &mut plain).unwrap();
        request.extend_from_slice(&plain[..len]);
        while let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            let head = std::str::from_utf8(&request[..end]).unwrap().to_owned();
            let body_len = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())).unwrap_or(0);
            if request.len() < end + 4 + body_len { break; }
            request.drain(..end + 4 + body_len);
            let path = head.split_whitespace().nth(1).unwrap();
            let refusal = |status: &std::sync::atomic::AtomicU16| match status.load(Ordering::SeqCst) {
                0 => None,
                code => Some((code, serde_json::json!({"error":"unknown client"}))),
            };
            let (status, body) = if path.starts_with("/api/v1/pair/challenge") {
                control.token_requests.fetch_add(1, Ordering::SeqCst);
                refusal(&control.challenge_status).unwrap_or((200, serde_json::json!({"challenge":"bitsov-pair-token-v1:test"})))
            } else if path == "/api/v1/pair/token" {
                control.token_requests.fetch_add(1, Ordering::SeqCst);
                refusal(&control.token_status).unwrap_or((200,
                    serde_json::json!({"token":"fixture.token", "expires_at":now_unix()+600, "scopes":["read"]})))
            } else if path == "/api/v1/node/lock" {
                (control.lock_status.load(Ordering::SeqCst), serde_json::json!({"error":"unavailable"}))
            } else if path == "/api/v1/identity" {
                (200, serde_json::json!({"node_id":node_id,"network":"regtest"}))
            } else { (404, serde_json::json!({"error":"not found"})) };
            let body = body.to_string();
            let response = format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            encrypted_write(&mut stream, &mut noise, response.as_bytes()).await?;
        }
    }
}

async fn controlled_box(link: impl FnOnce(String) -> String) -> (String, Arc<BoxControl>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = link(listener.local_addr().unwrap().to_string());
    let id = hex::encode(SigningKey::from_bytes(&[42; 32]).verifying_key().as_bytes());
    let control = Arc::new(BoxControl::default());
    let task = {
        let control = control.clone();
        tokio::spawn(async move {
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = sessions.join_next(), if !sessions.is_empty() => {},
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let (id, control) = (id.clone(), control.clone());
                        sessions.spawn(async move { let _ = controlled_box_session(stream, id, control).await; });
                    }
                }
            }
        })
    };
    (link, control, task)
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap_or_else(|_| panic!("timed out waiting until {what}"));
}

/// The live feed's socket: always a new connection to the proxy, so it would
/// need a new tunnel (and a handshake) to reach the box. Returns the status.
async fn live_feed_socket(state: &NodeState) -> u16 {
    let address = state.remote_proxy.lock().unwrap().as_ref().unwrap().local_addr();
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let request = format!("GET /api/v1/ws HTTP/1.1\r\nHost: {address}\r\n{}: {}\r\nConnection: close\r\n\r\n",
        remote_access::LOCAL_AUTH_HEADER, state.remote_proxy_auth);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = vec![0; 1024];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut response)).await
        .expect("the proxy answers the live feed's socket").unwrap();
    std::str::from_utf8(&response[..read]).unwrap().split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Make the current session due, then refresh it the way the live feed does
/// before it opens its socket.
async fn live_feed_token_refresh(state: &NodeState) {
    if let AuthMode::Paired(session) = &mut *state.auth.lock().unwrap() { session.expires_at = now_unix(); }
    ensure_fresh_token(state).await;
}

/// `node_status`, every 1.5 s: the probe interval elapsed every time.
async fn status_poll(state: &NodeState) {
    *state.home_last_probe.lock().unwrap() = None;
    home_unlock::refresh(state).await;
}

async fn connected_controlled_box(app: &tauri::App<tauri::test::MockRuntime>, dir: &Path) -> (Arc<BoxControl>, tokio::task::JoinHandle<()>) {
    let state = app.state::<NodeState>();
    let (link, control, task) = controlled_box(|endpoint| ticket(endpoint, false)).await;
    remote_access_connect_at(app.handle(), &state, dir, &link).await.unwrap();
    until("the session is ready", || state.status_snapshot().ready).await;
    drop(state.remote_recovery.lock().await);
    (control, task)
}

// An established session whose box then refuses it (a revoked app): the token
// refresh that learns of it stops every automatic path. Status polling, token
// refresh and the live feed (its recovery, its refresh and its socket) neither
// dial nor repeat the token exchange until the owner acts; then both resume.
#[tokio::test]
async fn a_refused_session_stops_status_probes_token_refresh_and_live_recovery() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let (control, task) = connected_controlled_box(&app, dir.path()).await;
    control.refuse(true, 404);
    let before = control.counts();
    live_feed_token_refresh(&state).await;
    assert_eq!(control.counts(), (before.0, before.1 + 1), "the refresh reached the box over its warm tunnel");
    let view = serde_json::to_value(state.pairing_snapshot()).unwrap();
    assert_eq!((view["state"].as_str(), view["refused"].as_bool()), (Some("failed"), Some(true)));
    assert!(!state.status_snapshot().ready);
    assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated), "the due session is retired");
    let refused = control.counts();
    for _ in 0..3 {
        status_poll(&state).await;
        live_feed_token_refresh(&state).await;
        assert!(refresh_paired(&state).await.is_err());
        tokio::time::timeout(Duration::from_secs(3), reconnect_remote_background(&state)).await.unwrap().unwrap();
        assert_eq!(live_feed_socket(&state).await, 403);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(control.counts(), refused, "no dial and no token request while refused");
    assert!(state.pairing_snapshot().refused);
    // The owner acts (Try again) after the box accepts the app again.
    control.refuse(false, 0);
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    until("the session is ready again", || state.status_snapshot().ready).await;
    assert!(control.counts().1 > refused.1, "token requests resume");
    assert!(!state.pairing_snapshot().refused);
    let resumed = control.counts();
    assert_eq!(live_feed_socket(&state).await, 404, "the socket reaches the box again");
    assert_eq!(control.counts().0, resumed.0 + 1, "dials resume");
    state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
    task.abort();
}

// The live feed's socket is the first to meet the refusal: the proxy records
// it. A due token refresh then stays quiet, and the next status poll shows the
// refusal, all without another dial or token request.
#[tokio::test]
async fn a_refusal_met_by_the_proxy_stops_refresh_and_reaches_the_pairing_view() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let (control, task) = connected_controlled_box(&app, dir.path()).await;
    control.refuse(true, 404);
    let before = control.counts();
    assert_eq!(live_feed_socket(&state).await, 403);
    assert_eq!(control.counts(), (before.0 + 1, before.1), "one refused dial");
    let refused = control.counts();
    live_feed_token_refresh(&state).await;
    assert_eq!(control.counts(), refused, "no token request after the proxy met the refusal");
    status_poll(&state).await;
    let view = serde_json::to_value(state.pairing_snapshot()).unwrap();
    assert_eq!((view["state"].as_str(), view["refused"].as_bool()), (Some("failed"), Some(true)));
    assert!(!state.status_snapshot().ready);
    for _ in 0..3 {
        status_poll(&state).await;
        assert_eq!(live_feed_socket(&state).await, 403);
    }
    assert_eq!(control.counts(), refused, "no dial and no token request while refused");
    state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
    task.abort();
}

// A remote-mode token exchange the node answers 401, 403 or 404 is a refusal of
// this app's pairing, end to end: the snapshot says so, and nothing redials.
#[tokio::test]
async fn a_refused_token_exchange_after_attach_marks_the_pairing_refused() {
    for (challenge, token) in [(401, 0), (0, 403), (0, 404)] {
        let app = app();
        let state = app.state::<NodeState>();
        let dir = tempfile::tempdir().unwrap();
        let (link, control, task) = controlled_box(|endpoint| ticket(endpoint, false)).await;
        control.challenge_status.store(challenge, Ordering::SeqCst);
        control.token_status.store(token, Ordering::SeqCst);
        remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap();
        until("the refusal reaches the pairing view", || state.pairing_snapshot().refused).await;
        drop(state.remote_recovery.lock().await);
        assert_eq!(state.pairing_snapshot().state, "failed", "{challenge} {token}");
        let refused = control.counts();
        status_poll(&state).await;
        tokio::time::timeout(Duration::from_secs(3), reconnect_remote_background(&state)).await.unwrap().unwrap();
        assert_eq!(control.counts(), refused, "{challenge} {token}: nothing redials");
        state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
        task.abort();
    }
}

fn owner_ticket(endpoint: String) -> String {
    let node = SigningKey::from_bytes(&[42; 32]);
    let public = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from([43; 32]));
    let node_id = hex::encode(node.verifying_key().as_bytes());
    let transport_pubkey = hex::encode(public.as_bytes());
    let signature = node.sign(remote_access::descriptor_signature_message(&node_id, &transport_pubkey).as_bytes());
    let value = serde_json::json!({"v": 1, "endpoint": endpoint, "node_id": node_id,
        "transport_pubkey": transport_pubkey,
        "transport_signature": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        "code": format!("owner_{}", "ab".repeat(32)), "expires_at": now_unix() + 300});
    format!("bitsov://pair/{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap()))
}

// An app that is already paired scans another ticket for the same box. The box
// answers `already_paired`: it refused the ticket, not the pairing. The app
// reconnects with the existing pairing (same client identity, no code) and
// never presents the ticket again; nothing shows the refused panel.
#[tokio::test]
async fn an_already_paired_ticket_reconnects_with_the_existing_pairing() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let (link, control, task) = controlled_box(owner_ticket).await;
    control.already_paired.store(true, Ordering::SeqCst);
    remote_access_connect_at(app.handle(), &state, dir.path(), &link).await.unwrap();
    until("the attach settles", || state.status_snapshot().ready || state.pairing_snapshot().state == "failed").await;
    drop(state.remote_recovery.lock().await);
    assert!(state.status_snapshot().ready, "reason={:?}", state.pairing_snapshot().reason);
    assert_eq!(state.pairing_snapshot().state, "paired");
    assert!(!state.pairing_snapshot().refused);
    assert!(!state.remote_retry.is_refused());
    assert_eq!(control.ticket_auths.load(Ordering::SeqCst), 1, "the ticket was presented once");
    assert!(control.handshakes.load(Ordering::SeqCst) >= 2, "then the existing pairing reconnected");
    assert!(!remote_access::load_persisted(dir.path()).unwrap().unwrap().has_code());
    // Later tunnels use the existing pairing too, never the ticket.
    assert_eq!(live_feed_socket(&state).await, 404, "the socket reaches the box");
    assert_eq!(control.ticket_auths.load(Ordering::SeqCst), 1);
    state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
    task.abort();
}

/// An established session whose descriptor has a valid saved box pin, so a
/// status probe opens an authenticated handshake with the box.
async fn connected_pinned_box(dir: &Path) -> (tauri::App<tauri::test::MockRuntime>, Arc<BoxControl>, tokio::task::JoinHandle<()>) {
    let pins = Arc::new(SavedBoxPins::default());
    let app = app_with_pins(pins.clone());
    let (control, task) = connected_controlled_box(&app, dir).await;
    let state = app.state::<NodeState>();
    let descriptor = state.remote_descriptor.lock().unwrap().clone().unwrap();
    let (key, signature) = box_proof();
    *pins.0.lock().unwrap() = Some(bitsov_app::home_node::BoxPin::verify(
        descriptor.node_id(), descriptor.endpoint(), &key, &signature).unwrap());
    assert!(descriptor.box_pin().unwrap().is_some(), "the saved box pin is valid");
    assert!(!descriptor.has_code(), "the session no longer carries its ticket");
    (app, control, task)
}

// Status polling is the first path to meet the refusal (a revoked app): with a
// saved box pin the probe is an authenticated handshake. That one refused
// handshake stops every automatic path (polls, token refresh, the live feed's
// recovery and socket) and retires the session until the owner acts.
#[tokio::test]
async fn a_refusal_met_by_status_polling_stops_every_automatic_dial() {
    let dir = tempfile::tempdir().unwrap();
    let (app, control, task) = connected_pinned_box(dir.path()).await;
    let state = app.state::<NodeState>();
    let before = control.counts();
    status_poll(&state).await;
    assert_eq!(control.counts(), (before.0 + 1, before.1), "a poll of the live session dials the pinned box");
    assert!(state.status_snapshot().ready);
    control.refuse(true, 0);
    let before = control.counts();
    status_poll(&state).await;
    assert_eq!(control.counts(), (before.0 + 1, before.1), "exactly one refused handshake");
    let view = serde_json::to_value(state.pairing_snapshot()).unwrap();
    assert_eq!((view["state"].as_str(), view["refused"].as_bool()), (Some("failed"), Some(true)));
    assert!(!state.status_snapshot().ready);
    assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated), "the session is retired");
    assert!(state.token.lock().unwrap().is_none(), "its token is retired");
    let refused = control.counts();
    for _ in 0..3 {
        status_poll(&state).await;
        live_feed_token_refresh(&state).await;
        assert!(refresh_paired(&state).await.is_err());
        tokio::time::timeout(Duration::from_secs(3), reconnect_remote_background(&state)).await.unwrap().unwrap();
        assert_eq!(live_feed_socket(&state).await, 403);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(control.counts(), refused, "no dial and no token request while refused");
    assert!(state.pairing_snapshot().refused);
    // The owner acts (Try again) after the box accepts the app again.
    control.refuse(false, 0);
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    drop(state.remote_recovery.lock().await);
    // The fixture's token carries no unlock binding, so a pinned session stops
    // short of ready; the pairing itself is accepted and no longer refused.
    assert_eq!(state.pairing_snapshot().state, "paired");
    assert!(!state.pairing_snapshot().refused);
    assert!(!state.remote_retry.is_refused());
    assert!(control.counts().0 > refused.0, "the owner's action dials");
    assert!(control.counts().1 > refused.1, "token requests resume");
    let resumed = control.counts();
    status_poll(&state).await;
    assert!(control.counts().0 > resumed.0, "polling dials again");
    let polled = control.counts();
    assert_eq!(live_feed_socket(&state).await, 404, "the socket reaches the box again");
    assert_eq!(control.counts().0, polled.0 + 1, "tunnels dial again");
    state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
    task.abort();
}

// A box that rebooted locked answers the lock status request with an error.
// That reply shares the `Refused` variant but is not about this app's pairing:
// it never marks the pairing refused, and polling keeps dialing.
#[tokio::test]
async fn a_lock_status_error_is_not_a_refusal_of_the_pairing() {
    let dir = tempfile::tempdir().unwrap();
    let (app, control, task) = connected_pinned_box(dir.path()).await;
    let state = app.state::<NodeState>();
    control.locked.store(true, Ordering::SeqCst);
    for status in [401, 403, 404, 503] {
        control.lock_status.store(status, Ordering::SeqCst);
        let before = control.counts();
        status_poll(&state).await;
        assert_eq!(control.counts().0, before.0 + 1, "{status}: the probe reached the locked box");
        let error = state.error.lock().unwrap().clone().unwrap_or_default();
        assert!(error.contains("lock status unavailable"), "{status}: {error}");
        assert!(!state.remote_retry.is_refused(), "{status}: not a refusal");
        assert!(!state.pairing_snapshot().refused, "{status}");
    }
    state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
    task.abort();
}

// Several tunnels (live feed, API polling) open at once against a box that
// refuses this app. They queue behind the first handshake; once it is refused,
// the queued ones answer 403 without dialing.
#[tokio::test]
async fn queued_proxy_tunnels_do_not_dial_after_a_refusal() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let (control, task) = connected_controlled_box(&app, dir.path()).await;
    control.refuse(true, 0);
    control.auth_delay_ms.store(300, Ordering::SeqCst);
    let before = control.counts();
    let statuses = tokio::join!(
        live_feed_socket(&state), live_feed_socket(&state), live_feed_socket(&state),
        live_feed_socket(&state), live_feed_socket(&state),
    );
    assert_eq!(statuses, (403, 403, 403, 403, 403));
    assert_eq!(control.counts(), (before.0 + 1, before.1), "only the first tunnel reached the box");
    assert!(state.remote_retry.is_refused());
    state.remote_proxy.lock().unwrap().take().unwrap().stop_and_wait().await;
    task.abort();
}
