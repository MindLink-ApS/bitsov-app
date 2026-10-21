//! Host-only mobile tests: MockRuntime, temporary tickets, and loopback fakes.
use super::*;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn ticket(endpoint: String, first_run: bool) -> String {
    let node = SigningKey::from_bytes(&[42; 32]);
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
    noise.read_message(&message[2..], &mut output).unwrap();
    let length = noise.write_message(br#"{"v":1,"status":"error","code":"test_refusal","message":"test complete"}"#, &mut output).unwrap();
    stream.write_u32((length + 2) as u32).await.unwrap();
    stream.write_u16(length as u16).await.unwrap();
    stream.write_all(&output[..length]).await.unwrap();
}

fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder().manage(NodeState::for_api("http://127.0.0.1:1/api/v1"))
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap()
}

#[tokio::test]
async fn import_clears_unpaired_error_and_attaches_without_restart() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), false);
    assert!(!remote_access::preview_pairing_link(&link).unwrap().first_run);
    let server = tokio::spawn(noise_responder(listener));
    set_error(&state, "Pair this phone with your home node to continue.");
    let result = remote_access_import_at(app.handle(), &state, dir.path(), &link).unwrap();
    assert!(state.status_snapshot().error.is_none());
    assert!(!result.restart_required);
    tokio::time::timeout(Duration::from_secs(3), server).await.unwrap().unwrap();
    // Wait for the background task to release the recovery lock before cleanup.
    let _recovery = state.remote_recovery.lock().await;
    assert!(state.remote_mode.load(Ordering::SeqCst));
    assert_eq!(state.pairing_snapshot().state, "failed");
}

#[tokio::test]
async fn retry_with_saved_ticket_connects_before_remote_mode_or_pairing_context_exists() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket(listener.local_addr().unwrap().to_string(), false)).unwrap();
    let server = tokio::spawn(noise_responder(listener));
    assert!(!state.remote_mode.load(Ordering::SeqCst));
    assert!(state.pairing.lock().unwrap().is_none());
    let view = tokio::time::timeout(Duration::from_secs(3), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    server.await.unwrap();
    assert!(view.remote);
    assert!(state.status_snapshot().error.is_none());
}

#[tokio::test]
async fn first_run_ticket_is_not_dialed_on_attach_or_retry() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), true);
    remote_access::import_pairing_link(dir.path(), &link).unwrap();
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    tokio::time::timeout(Duration::from_millis(200), attach_remote(&state, dir.path(), descriptor)).await.unwrap();
    pairing_retry_at(&state, dir.path()).await.unwrap();
    assert_eq!(state.status_snapshot().error.as_deref(), Some("This node isn't set up yet. Finish setup on a Mac, then add this phone."));
    assert!(state.remote_proxy.lock().unwrap().is_none());
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test]
async fn invalid_import_preserves_error_and_does_not_start_remote_mode() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    set_error(&state, "Pair this phone with your home node to continue.");
    assert!(remote_access_import_at(app.handle(), &state, dir.path(), "invalid").is_err());
    assert_eq!(state.status_snapshot().error.as_deref(), Some("Pair this phone with your home node to continue."));
    assert!(!state.remote_mode.load(Ordering::SeqCst));
    assert!(remote_access::load_persisted(dir.path()).unwrap().is_none());
}

#[tokio::test]
async fn first_run_import_reports_setup_guidance_without_dialing() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), true);
    assert!(remote_access::preview_pairing_link(&link).unwrap().first_run);
    remote_access_import_at(app.handle(), &state, dir.path(), &link).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.status_snapshot().error.is_none() { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert_eq!(state.status_snapshot().error.as_deref(), Some("This node isn't set up yet. Finish setup on a Mac, then add this phone."));
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test]
async fn import_during_recovery_preserves_the_saved_ticket() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket("127.0.0.1:1234".into(), false)).unwrap();
    let recovery = state.remote_recovery.lock().await;
    let error = remote_access_import_at(app.handle(), &state, dir.path(), &ticket("127.0.0.1:5678".into(), false)).unwrap_err();
    assert!(error.contains("already in progress"));
    assert_eq!(remote_access::load_persisted(dir.path()).unwrap().unwrap().endpoint(), "127.0.0.1:1234");
    drop(recovery);
}
