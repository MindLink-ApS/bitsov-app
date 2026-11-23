//! Mobile-path tests: MockRuntime, temporary tickets, and loopback fakes.
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
    noise_auth_reply(listener, false).await;
}

async fn noise_auth_reply(listener: tokio::net::TcpListener, accept: bool) -> remote_access::RemoteAuthRequest {
    noise_auth_reply_with(&listener, accept).await
}

/// One refused enrollment on a listener that stays open for the next attempt.
async fn noise_auth_reply_on(listener: &tokio::net::TcpListener) -> Option<String> {
    noise_auth_reply_with(listener, false).await.client_pubkey
}

async fn noise_auth_reply_with(listener: &tokio::net::TcpListener, accept: bool) -> remote_access::RemoteAuthRequest {
    let (mut stream, _) = listener.accept().await.unwrap();
    let secret = [43; 32];
    let mut noise = snow::Builder::new("Noise_XX_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
        .local_private_key(&secret).and_then(|b| b.build_responder()).unwrap();
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
    tauri::test::mock_builder().manage(NodeState::for_api(format!("http://127.0.0.1:{port}/api/v1")))
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
    let result = remote_access_import_at(app.handle(), &state, dir.path(), &link).await.unwrap();
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
    tokio::time::timeout(Duration::from_secs(5), attach_remote(&state, dir.path(), descriptor)).await.unwrap();
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
    assert!(remote_access_import_at(app.handle(), &state, dir.path(), "invalid").await.is_err());
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
    remote_access_import_at(app.handle(), &state, dir.path(), &link).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.status_snapshot().error.is_none() { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert_eq!(state.status_snapshot().error.as_deref(), Some("This node isn't set up yet. Finish setup on a Mac, then add this phone."));
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test]
async fn replacement_ticket_interrupts_a_stalled_handshake_and_attaches() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let old = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket(old.local_addr().unwrap().to_string(), false)).unwrap();
    let attempt = pairing_retry_at(&state, dir.path());
    tokio::pin!(attempt);
    let (mut stalled, _) = tokio::select! {
        accepted = old.accept() => accepted.unwrap(),
        _ = &mut attempt => panic!("old attempt ended before handshake"),
    };
    let next = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = next.local_addr().unwrap().to_string();
    let server = tokio::spawn(noise_auth_reply(next, true));
    let replacement = ticket(endpoint.clone(), false);
    let (old_result, result) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(&mut attempt, remote_access_import_at(app.handle(), &state, dir.path(), &replacement))
    }).await.expect("replacement must release the attach lock promptly");
    old_result.unwrap();
    assert!(result.is_ok(), "replacement must cancel the stalled attempt: {result:?}");
    let authenticated = tokio::time::timeout(Duration::from_secs(4), server).await.unwrap().unwrap();
    assert!(authenticated.code.is_some());
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.remote_proxy.lock().unwrap().is_none() { tokio::task::yield_now().await; }
    }).await.expect("the replacement must install its authenticated proxy");
    let saved = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    assert_eq!(saved.endpoint(), endpoint);
    assert!(!saved.has_code(), "successful replacement must persist code consumption");
    // The fake only serves enrollment, not HTTP. Stop its subsequent auth retry.
    tokio::time::timeout(Duration::from_secs(5), remote_access_forget_at(&state, dir.path())).await.unwrap().unwrap();
    let _recovery = state.remote_recovery.lock().await;
    assert!(state.remote_proxy.lock().unwrap().is_some());
    let mut discarded = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stalled.read_to_end(&mut discarded)).await.unwrap().unwrap();
}

#[tokio::test]
async fn unclaimed_box_exports_a_structured_error_before_any_dial() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let descriptor = remote_access::parse_pairing_link(&ticket(listener.local_addr().unwrap().to_string(), true)).unwrap();
    attach_remote(&state, dir.path(), descriptor).await;
    let status = serde_json::to_value(state.status_snapshot()).unwrap();
    assert_eq!(status["connection_error"]["kind"], "unclaimed");
    assert!(status["connection_error"]["detail"].as_str().unwrap().contains("Finish setup"));
    assert!(state.pairing.lock().unwrap().is_none());
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test]
async fn foreground_reconnects_saved_link_without_import_and_ignores_duplicates() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    // No saved link is an ordinary first launch, not an error.
    resume_remote_at(&state, dir.path()).await.unwrap();
    assert!(state.pairing.lock().unwrap().is_none());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket(listener.local_addr().unwrap().to_string(), false)).unwrap();
    let server = tokio::spawn(noise_responder(listener));
    let guard = state.remote_recovery.lock().await;
    tokio::time::timeout(Duration::from_millis(100), resume_remote_at(&state, dir.path())).await.unwrap().unwrap();
    assert!(state.pairing.lock().unwrap().is_none());
    drop(guard);
    tokio::time::timeout(Duration::from_secs(3), resume_remote_at(&state, dir.path())).await.unwrap().unwrap();
    server.await.unwrap();
    assert!(state.remote_mode.load(Ordering::SeqCst));
    remote_access::forget_persisted(dir.path()).unwrap();
    resume_remote_at(&state, dir.path()).await.unwrap();
}

#[test]
fn local_network_error_is_available_to_the_renderer_without_string_matching() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    state.remote_retry.failed(&remote_access::RemoteError::LocalNetwork);
    let status = serde_json::to_value(state.status_snapshot()).unwrap();
    assert_eq!(status["connection_error"]["kind"], "local_network");
    assert!(status["connection_error"]["detail"].as_str().unwrap().contains("Settings"));
}

#[test]
fn native_foreground_events_only_resume_the_main_client() {
    // Tauri's top-level Resumed also represents event-loop Poll, not app foreground.
    assert!(!is_remote_resume_event(&RunEvent::Resumed));
    #[cfg(mobile)]
    assert!(is_remote_resume_window(MAIN_WINDOW_LABEL, &tauri::WindowEvent::Resumed));
    assert!(is_remote_resume_window(MAIN_WINDOW_LABEL, &tauri::WindowEvent::Focused(true)));
    for (label, focused) in [(MAIN_WINDOW_LABEL, false), ("sealed", true)] {
        assert!(!is_remote_resume_window(label, &tauri::WindowEvent::Focused(focused)));
    }
    assert!(!is_remote_resume_event(&RunEvent::Ready));
}

#[tokio::test]
async fn foreground_after_ticket_expiry_uses_existing_auth_without_replaying_ticket() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let original = ticket(endpoint.to_string(), false);
    let mut wire: serde_json::Value = serde_json::from_slice(&engine.decode(original.strip_prefix("bitsov://pair/").unwrap()).unwrap()).unwrap();
    let expiry = now_unix() + 2;
    wire["expires_at"] = expiry.into();
    let link = format!("bitsov://pair/{}", engine.encode(serde_json::to_vec(&wire).unwrap()));
    remote_access::import_pairing_link(dir.path(), &link).unwrap();
    let key = ClientKey::load_or_create(&dir.path().join(PAIRING_STORE_DIR)).unwrap();
    let server = tokio::spawn(noise_auth_reply(listener, true));
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    remote_access::authenticate_pinned_transport_and_save_record(
        dir.path(), descriptor, &key, PAIRING_CLIENT_NAME,
        &dir.path().join(PAIRING_STORE_DIR), &state.remote_retry,
    ).await.unwrap();
    assert!(server.await.unwrap().code.is_some());
    assert!(!remote_access::load_persisted(dir.path()).unwrap().unwrap().has_code());
    while now_unix() < expiry { tokio::time::sleep(Duration::from_millis(50)).await; }
    assert!(matches!(remote_access::parse_pairing_link(&link), Err(remote_access::RemoteError::Expired(_))));
    let listener = tokio::net::TcpListener::bind(endpoint).await.unwrap();
    let server = tokio::spawn(noise_auth_reply(listener, false));
    tokio::time::timeout(Duration::from_secs(3), resume_remote_at(&state, dir.path())).await.unwrap().unwrap();
    let resumed = server.await.unwrap();
    assert!(resumed.code.is_none());
    assert!(resumed.signature.is_none());
    assert!(state.pairing.lock().unwrap().is_some());
}

#[tokio::test]
async fn forget_interrupts_stalled_dial_and_foreground_cannot_resurrect_it() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket(listener.local_addr().unwrap().to_string(), false)).unwrap();
    let attempt = pairing_retry_at(&state, dir.path());
    tokio::pin!(attempt);
    let (mut stalled, _) = tokio::select! {
        accepted = listener.accept() => accepted.unwrap(),
        _ = &mut attempt => panic!("dial ended unexpectedly"),
    };
    let (old, forgotten) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(&mut attempt, remote_access_forget_at(&state, dir.path()))
    }).await.expect("Forget must interrupt the in-flight handshake");
    old.unwrap();
    forgotten.unwrap();
    assert!(state.remote_recovery.try_lock().is_ok());
    assert!(state.pairing.lock().unwrap().is_none());
    assert!(state.remote_proxy.lock().unwrap().is_none());
    assert!(remote_access::load_persisted(dir.path()).unwrap().is_none());
    resume_remote_at(&state, dir.path()).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
    let mut discarded = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stalled.read_to_end(&mut discarded)).await.unwrap().unwrap();
}

#[tokio::test(start_paused = true)]
async fn forget_interrupts_backoff_without_clearing_the_retry_budget() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket(listener.local_addr().unwrap().to_string(), false)).unwrap();
    state.remote_retry.failed(&remote_access::RemoteError::RateLimited(60));
    let attempt = pairing_retry_at(&state, dir.path());
    tokio::pin!(attempt);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            _ = async {
                while state.remote_recovery.try_lock().is_ok() { tokio::time::sleep(Duration::from_millis(1)).await; }
            } => {},
            _ = &mut attempt => panic!("backoff must retain the attempt"),
        }
    }).await.expect("connect must enter recovery");
    assert!(state.remote_recovery.try_lock().is_err());
    assert!(remote_access_import_at(app().handle(), &state, dir.path(), "invalid").await.is_err());
    assert!(state.remote_recovery.try_lock().is_err(), "invalid import must not cancel");
    let (old, forgotten) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(&mut attempt, remote_access_forget_at(&state, dir.path()))
    }).await.expect("Forget must wake the retry sleep");
    old.unwrap();
    forgotten.unwrap();
    assert!(state.remote_recovery.try_lock().is_ok());
    assert!(state.remote_retry.remaining().unwrap() >= 59);
    assert!(remote_access::load_persisted(dir.path()).unwrap().is_none());
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn rejected_import_does_not_cancel_an_established_proxy_recovery() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let link = ticket("127.0.0.1:1234".into(), false);
    remote_access::import_pairing_link(dir.path(), &link).unwrap();
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    let store = dir.path().join(PAIRING_STORE_DIR);
    let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
    let proxy = remote_access::start_proxy(&state.api_base, dir.path(), descriptor,
        key, PAIRING_CLIENT_NAME, store, state.remote_proxy_auth.clone(), state.remote_retry.clone()).await.unwrap();
    *state.remote_proxy.lock().unwrap() = Some(proxy);
    state.remote_mode.store(true, Ordering::SeqCst);
    state.remote_retry.failed(&remote_access::RemoteError::RateLimited(60));
    let recovery = reconnect_remote_at(&state, dir.path());
    tokio::pin!(recovery);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            _ = async {
                while state.remote_recovery.try_lock().is_ok() { tokio::time::sleep(Duration::from_millis(1)).await; }
            } => {},
            _ = &mut recovery => panic!("recovery must wait through backoff"),
        }
    }).await.expect("connect must enter recovery");
    let replacement = ticket("127.0.0.1:5678".into(), false);
    let result = tokio::select! {
        result = remote_access_import_at(app.handle(), &state, dir.path(), &replacement) => result,
        _ = &mut recovery => panic!("a rejected import must not cancel recovery"),
    };
    assert!(result.unwrap_err().to_string().contains("already active"));
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut recovery).await.is_err());
    let (old, forgotten) = tokio::join!(&mut recovery, remote_access_forget_at(&state, dir.path()));
    old.unwrap();
    forgotten.unwrap();
    assert!(state.remote_proxy.lock().unwrap().is_some(), "Forget preserves the established transport");
    assert!(state.remote_retry.remaining().unwrap() >= 59);
    // Forget stopped that recovery before auth finished, so nothing is ready yet:
    // a bootstrap queued now resumes the auth, still inside the same backoff, and
    // Forget can stop it too. Behind a ready session it does nothing at all; see
    // remote_connect_tests::a_queued_bootstrap_does_not_redo_a_ready_session.
    let queued = connect_remote_at(&state, dir.path(), true);
    tokio::pin!(queued);
    assert!(tokio::time::timeout(Duration::from_secs(5), &mut queued).await.is_err(),
        "a bootstrap with auth unfinished must wait out the backoff");
    let (queued, forgotten) = tokio::join!(&mut queued, remote_access_forget_at(&state, dir.path()));
    queued.unwrap();
    forgotten.unwrap();
    assert!(!state.status_snapshot().ready);
    assert!(state.remote_retry.remaining().is_some(), "Forget keeps the backoff");
}

#[tokio::test]
async fn proxy_published_during_import_cancellation_keeps_recovering() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    let link = ticket(endpoint.clone(), false);
    remote_access::import_pairing_link(dir.path(), &link).unwrap();
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    let store = dir.path().join(PAIRING_STORE_DIR);
    let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
    // A real attach saves the authenticated client before publishing a proxy.
    pairing::save_remote_record(&store, &key,
        "0123456789abcdef0123456789abcdef".into(), vec!["read".into()]).unwrap();
    let proxy = remote_access::start_proxy(&state.api_base, dir.path(), descriptor,
        key, PAIRING_CLIENT_NAME, store, state.remote_proxy_auth.clone(), state.remote_retry.clone()).await.unwrap();
    state.remote_mode.store(true, Ordering::SeqCst);
    state.remote_retry.failed(&remote_access::RemoteError::RateLimited(1));
    // Model an attach that publishes its proxy while import is waiting for the
    // cancelled operation to release recovery (after import's first proxy check).
    let guard = state.remote_recovery.lock().await;
    let replacement = ticket("127.0.0.1:5678".into(), false);
    let mut cancelled = state.remote_connect_generation.subscribe();
    let import = remote_access_import_at(app.handle(), &state, dir.path(), &replacement);
    tokio::pin!(import);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            changed = cancelled.changed() => changed.unwrap(),
            _ = &mut import => panic!("import must wait for the cancelled attach"),
        }
    }).await.expect("import must cancel the old generation before waiting for recovery");
    *state.remote_proxy.lock().unwrap() = Some(proxy);
    drop(guard);
    assert!(import.await.unwrap_err().to_string().contains("already active"));
    // Observe the recovered dial. Polling try_lock can itself take the lock
    // while the recovery task calls try_lock, making that task skip its work.
    let (_retried, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await.expect("the raced proxy must continue auth recovery after rejection").unwrap();
    assert_eq!(remote_access::load_persisted(dir.path()).unwrap().unwrap().endpoint(), endpoint);
    tokio::time::timeout(Duration::from_secs(5), remote_access_forget_at(&state, dir.path())).await.unwrap().unwrap();
}

#[tokio::test]
async fn failed_ticket_save_restarts_the_previous_cancelled_connection() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    remote_access::import_pairing_link(dir.path(), &ticket(endpoint.clone(), false)).unwrap();
    let attempt = pairing_retry_at(&state, dir.path());
    tokio::pin!(attempt);
    let (mut stalled, _) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            accepted = listener.accept() => accepted.unwrap(),
            _ = &mut attempt => panic!("old connect ended before handshake"),
        }
    }).await.unwrap();
    // A directory at the atomic-save temporary path forces IO failure while
    // keeping the old descriptor readable, even when tests run as root.
    std::fs::create_dir(dir.path().join("remote-access/descriptor.json.tmp")).unwrap();
    let replacement = ticket("127.0.0.1:5678".into(), false);
    let (old, imported) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(&mut attempt, remote_access_import_at(app.handle(), &state, dir.path(), &replacement))
    }).await.unwrap();
    old.unwrap();
    assert!(imported.is_err());
    assert_eq!(remote_access::load_persisted(dir.path()).unwrap().unwrap().endpoint(), endpoint);
    let mut discarded = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stalled.read_to_end(&mut discarded)).await.unwrap().unwrap();
    let (_retried, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await.expect("failed save must resume the previous ticket without foreground or Reconnect").unwrap();
    remote_access_forget_at(&state, dir.path()).await.unwrap();
}

#[tokio::test]
async fn failed_ticket_save_without_previous_ticket_surfaces_pairing_guidance() {
    let app = app();
    let state = app.state::<NodeState>();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("remote-access/descriptor.json.tmp")).unwrap();
    assert!(remote_access_import_at(app.handle(), &state, dir.path(), &ticket("127.0.0.1:5678".into(), false)).await.is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.status_snapshot().error.is_none() { tokio::task::yield_now().await; }
    }).await.expect("failed save must not leave an idle app without guidance");
    assert!(state.status_snapshot().error.unwrap().contains("Pair this phone"));
    assert!(remote_access::load_persisted(dir.path()).unwrap().is_none());
}

// The client identity sits behind Face ID / Touch ID. Focus changes, foreground
// resumes and the live feed's retries must never read it; a user action reads it
// once per process and every later attempt reuses the key in memory.
#[tokio::test]
async fn background_reconnects_never_read_the_protected_client_identity() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let link = ticket(listener.local_addr().unwrap().to_string(), false);
    remote_access::import_pairing_link(dir.path(), &link).unwrap();
    // The session's first prompt was cancelled.
    let store = dir.path().join(PAIRING_STORE_DIR);
    assert!(client_key_with(&state, &store, Interaction::User, |_| Err(PairError::Local("cancelled".into()))).is_err());
    // A focus change (the Face ID sheet closing) and the live feed's recovery.
    tokio::time::timeout(Duration::from_secs(3), resume_remote_at(&state, dir.path())).await.unwrap().unwrap();
    let descriptor = remote_access::load_persisted(dir.path()).unwrap().unwrap();
    attach_remote_with(&state, dir.path(), descriptor, Interaction::Background).await;
    assert!(state.client_key.lock().unwrap().is_none());
    assert!(!dir.path().join(PAIRING_STORE_DIR).join(pairing::KEY_FILE).exists());
    assert_eq!(state.status_snapshot().error.as_deref(), Some(CONFIRM_TO_RECONNECT));
    assert!(tokio::time::timeout(Duration::from_millis(50), listener.accept()).await.is_err());
}

#[tokio::test]
async fn one_user_read_serves_every_later_retry() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    remote_access::import_pairing_link(dir.path(), &ticket(address, false)).unwrap();
    let server = tokio::spawn(async move {
        let first = noise_auth_reply_on(&listener).await;
        let second = noise_auth_reply_on(&listener).await;
        (first, second)
    });
    // The user's Try again reads the identity (the one prompt).
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    let key = state.client_key.lock().unwrap().as_ref().map(|(_, key)| key.public_hex().to_string()).unwrap();
    // Remove the stored identity: any further read would now create a new key.
    std::fs::remove_file(dir.path().join(PAIRING_STORE_DIR).join(pairing::KEY_FILE)).unwrap();
    // The node refused, so a focus change stays quiet; the next Try again
    // uses the key in memory.
    tokio::time::timeout(Duration::from_secs(5), resume_remote_at(&state, dir.path())).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    let (first, second) = tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    assert!(first.is_some());
    assert_eq!(first, second, "the same client identity authenticated both attempts");
    assert_eq!(state.client_key.lock().unwrap().as_ref().map(|(_, key)| key.public_hex().to_string()).unwrap(), key);
    assert!(!dir.path().join(PAIRING_STORE_DIR).join(pairing::KEY_FILE).exists(), "no second read or create");
}

// A node that answers "no" to the saved pairing (unknown or revoked client,
// used ticket) keeps answering "no". Focus changes, foreground resumes and the
// live feed must then stop dialling it, and the renderer must learn that only
// pairing again helps. Only the owner's action dials again.
#[tokio::test]
async fn definitive_refusal_stops_automatic_reconnects_until_the_owner_acts() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    remote_access::import_pairing_link(dir.path(), &ticket(listener.local_addr().unwrap().to_string(), false)).unwrap();
    let first = tokio::spawn(async move {
        let request = noise_auth_reply_on(&listener).await;
        (listener, request)
    });
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    let (listener, request) = tokio::time::timeout(Duration::from_secs(5), first).await.unwrap().unwrap();
    assert!(request.is_some());
    let view = serde_json::to_value(state.pairing_snapshot()).unwrap();
    assert_eq!(view["state"], "failed");
    assert_eq!(view["refused"], true);
    // A Face ID sheet closing, a return to the foreground, and the live feed.
    for _ in 0..3 {
        tokio::time::timeout(Duration::from_secs(3), resume_remote_at(&state, dir.path())).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(3), reconnect_remote_background(&state)).await.unwrap().unwrap();
    }
    assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err(), "no automatic dial after a refusal");
    assert_eq!(state.pairing_snapshot().state, "failed");
    assert!(state.pairing_snapshot().refused);
    // The owner's Try again is an action: it dials once more.
    let second = tokio::spawn(async move { noise_auth_reply_on(&listener).await });
    tokio::time::timeout(Duration::from_secs(5), pairing_retry_at(&state, dir.path())).await.unwrap().unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), second).await.unwrap().unwrap().is_some());
    assert!(state.pairing_snapshot().refused);
    // Forget clears the refusal along with the saved link.
    remote_access_forget_at(&state, dir.path()).await.unwrap();
    assert!(!state.pairing_snapshot().refused);
}

#[tokio::test]
async fn an_unreachable_node_is_not_a_refusal() {
    let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
    for error in [
        remote_access::RemoteError::HandshakeUnavailable,
        remote_access::RemoteError::Transport("cannot read frame length: early eof".into()),
        remote_access::RemoteError::RateLimited(5),
        remote_access::RemoteError::Waiting(5),
        remote_access::RemoteError::LocalNetwork,
        remote_access::RemoteError::Local("cancelled".into()),
        // The node refused a ticket, not the pairing this app already holds.
        remote_access::RemoteError::AlreadyPaired,
    ] {
        assert!(!is_definitive_refusal(&error), "{error}");
    }
    assert!(is_definitive_refusal(&remote_access::RemoteError::Refused("authentication_failed: unknown client".into())));
    assert!(is_definitive_refusal(&remote_access::RemoteError::Refused(remote_access::USED_TICKET_MESSAGE.into())));
    for (step, status, definitive) in [("/pair/token", 404, true), ("/pair/challenge", 401, true), ("/pair/token", 403, true),
        ("/pair/token", 429, false), ("/pair/token", 502, false), ("/identity", 404, false)] {
        let error = PairError::Refused { step, status, reason: String::new() };
        assert_eq!(is_definitive_token_refusal(&error), definitive, "{step} {status}");
    }
    assert!(!is_definitive_token_refusal(&PairError::Transport { step: "/pair/token", detail: "timed out".into() }));
    // A transient failure leaves the automatic reconnect in place.
    assert!(!state.pairing_snapshot().refused);
    assert!(serde_json::to_value(state.pairing_snapshot()).unwrap().get("refused").is_none());
}
