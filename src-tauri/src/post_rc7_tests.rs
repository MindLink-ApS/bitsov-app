use super::*;
use std::io::{BufRead, Read, Write};

// Scripted node responses on a private loopback port; never a user's node.
fn responses(
    replies: Vec<(&'static str, u16, serde_json::Value)>,
) -> (NodeState, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port());
    let thread = std::thread::spawn(move || {
        for (expected, status, body) in replies {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = std::io::BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with(expected), "unexpected request: {line}");
            let mut length = 0;
            let mut auth = false;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_lowercase().strip_prefix("content-length: ") {
                    length = v.trim().parse().unwrap();
                }
                auth |= line
                    .to_lowercase()
                    .starts_with("authorization: bearer test-token");
            }
            let mut input = vec![0; length];
            reader.read_exact(&mut input).unwrap();
            if expected.starts_with("POST /api/v1/identity/restore ") {
                assert!(auth);
                let input: serde_json::Value = serde_json::from_slice(&input).unwrap();
                assert_eq!(
                    input,
                    serde_json::json!({"mnemonic": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"})
                );
            }
            let body = body.to_string();
            write!(reader.get_mut(), "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let state = NodeState::for_api(base);
    *state.token.lock().unwrap() = Some("test-token".into());
    (state, thread)
}
const PHRASE: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[tokio::test]
async fn restore_refuses_remote_before_any_request() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let state = NodeState::for_api(format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port()));
    state.remote_mode.store(true, Ordering::SeqCst);
    let result = tokio::time::timeout(Duration::from_millis(200), request_identity_restore(&state, PHRASE)).await;
    assert!(matches!(result, Ok(Err(ref e)) if e == "Identity restore is only available for the local supervised node."));
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock), "no probe or phrase may reach the remote node");
}

#[tokio::test]
async fn restore_uses_bootstrap_router_or_rc7_live_fallback() {
    for bootstrap in [true, false] {
        let probe = if bootstrap {
            serde_json::json!({"state":"bootstrap", "can_restore":true})
        } else {
            serde_json::json!({})
        };
        let (state, server) = responses(vec![
            (
                "GET /api/v1/bootstrap/state ",
                if bootstrap { 200 } else { 404 },
                probe,
            ),
            (
                "POST /api/v1/identity/restore ",
                200,
                serde_json::json!({"node_id":"restored", "restart_required":true}),
            ),
        ]);
        let restored = request_identity_restore(&state, PHRASE).await.unwrap();
        assert_eq!(restored.node_id, "restored");
        assert!(restored.restart_required);
        server.join().unwrap();
    }
}

#[tokio::test]
async fn restore_probe_failure_never_falls_back_or_sends_phrase() {
    for status in [401, 403, 500] {
        let (state, server) = responses(vec![(
            "GET /api/v1/bootstrap/state ",
            status,
            serde_json::json!({"error":"refused"}),
        )]);
        assert!(request_identity_restore(&state, PHRASE).await.is_err());
        server.join().unwrap();
    }
    let (state, server) = responses(vec![(
        "GET /api/v1/bootstrap/state ",
        200,
        serde_json::json!({"state":"bootstrap", "can_restore":false}),
    )]);
    assert!(request_identity_restore(&state, PHRASE).await.is_err());
    server.join().unwrap();
}

#[tokio::test]
async fn bootstrap_is_startable_without_live_health_route() {
    let (state, server) = responses(vec![
        ("GET /api/v1/health ", 404, serde_json::json!({})),
        (
            "GET /api/v1/bootstrap/state ",
            200,
            serde_json::json!({"state":"bootstrap", "can_restore":true}),
        ),
    ]);
    wait_for_health(&state).await.unwrap();
    server.join().unwrap();
}

#[test]
fn only_known_marker_refusals_offer_repair() {
    for reason in [
        "identity_without_marker",
        "identity_and_state_without_marker",
    ] {
        assert!(initialization_refusal(&format!(
            "Error: node startup refused ({reason}): missing marker"
        )));
    }
    for reason in [
        "state_without_identity",
        "initialized_missing_identity",
        "initialized_store_corrupt",
        "some_identity_without_marker",
        "NODE_INITIALIZED",
        "connection refused",
    ] {
        assert!(!initialization_refusal(reason));
    }
}

#[tokio::test]
async fn repair_needs_pending_local_refusal_and_explicit_consent() {
    let state = NodeState::default();
    assert!(repair_initialized_files(&state, true).await.is_err());
    *state.initialization_repair.lock().unwrap() = InitializationRepair::Required;
    assert!(repair_initialized_files(&state, false).await.is_err());
    assert_eq!(
        *state.initialization_repair.lock().unwrap(),
        InitializationRepair::Required
    );
    state.remote_mode.store(true, Ordering::SeqCst);
    assert!(repair_initialized_files(&state, true).await.is_err());
    state.remote_mode.store(false, Ordering::SeqCst);
    *state.external_node.lock().unwrap() = Some("/external".into());
    assert!(repair_initialized_files(&state, true).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn repair_runs_once_on_consent_and_failure_stays_pending() {
    use std::os::unix::fs::PermissionsExt;
    for succeed in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("mock-node");
        let args = dir.path().join("args");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit {}\n",
                args.display(),
                if succeed { 0 } else { 1 }
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = NodeState::default();
        let config = dir.path().join("a dir/konsensus.toml");
        *state.config.lock().unwrap() = Some(config.clone());
        *state.dev_sidecar.lock().unwrap() = Some(program);
        *state.initialization_repair.lock().unwrap() = InitializationRepair::Required;
        state.sidecar_terminated.store(true, Ordering::SeqCst);
        assert!(repair_initialized_files(&state, false).await.is_err());
        assert!(!args.exists());
        let (first, duplicate) = tokio::join!(
            repair_initialized_files(&state, true),
            repair_initialized_files(&state, true),
        );
        assert_eq!(first.is_ok(), succeed);
        assert!(duplicate.is_err(), "in-flight repair cannot run twice");
        assert_eq!(
            std::fs::read_to_string(&args).unwrap(),
            format!(
                "repair\nmark-initialized\n--config\n{}\n--confirm\n",
                config.display()
            )
        );
        assert_eq!(
            *state.initialization_repair.lock().unwrap(),
            if succeed {
                InitializationRepair::None
            } else {
                InitializationRepair::Required
            }
        );
        if succeed {
            assert!(repair_initialized_files(&state, true).await.is_err());
        }
    }
}

#[tokio::test]
async fn restored_live_identity_clears_bootstrap_view() {
    let (state, server) = responses(vec![
        ("GET /api/v1/health ", 200, serde_json::json!({})),
        (
            "POST /api/v1/auth/local ",
            200,
            serde_json::json!({"token":"test-token"}),
        ),
        (
            "GET /api/v1/identity ",
            200,
            serde_json::json!({"node_id":"restored"}),
        ),
    ]);
    *state.auth.lock().unwrap() = AuthMode::Local;
    state.pairing_view.lock().unwrap().bootstrap = Some("bootstrap".into());
    assert!(adopt_matching_identity(&state, "restored").await.unwrap());
    assert!(state.pairing_snapshot().bootstrap.is_none());
    assert!(state.status_snapshot().ready);
    server.join().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn supervised_refusal_waits_for_consent_then_repairs_and_starts_normally() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("mock-marker");
    let calls = dir.path().join("calls");
    let program = dir.path().join("mock-node");
    std::fs::write(&program, format!(r#"#!/bin/sh
printf '%s\n' "$1" >> '{}'
if [ "$1" = repair ]; then touch '{}'; exit 0; fi
if [ -f '{}' ]; then exec sleep 30; fi
printf '%s\n' 'Error: refusing to start: missing marker (identity_and_state_without_marker). Repair: konsensus repair mark-initialized --confirm' >&2
exit 1
"#, calls.display(), marker.display(), marker.display())).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (state, server) = responses(vec![
        ("GET /api/v1/health ", 200, serde_json::json!({})),
        ("POST /api/v1/pair/request ", 404, serde_json::json!({})),
        (
            "POST /api/v1/auth/local ",
            200,
            serde_json::json!({"token":"test-token"}),
        ),
        (
            "GET /api/v1/identity ",
            200,
            serde_json::json!({"node_id":"existing"}),
        ),
    ]);
    let config = dir.path().join("konsensus.toml");
    *state.config.lock().unwrap() = Some(config.clone());
    *state.dev_sidecar.lock().unwrap() = Some(program);
    let app = tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<NodeState>();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    spawn_node(app.handle(), &config).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !state.sidecar_terminated.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // The waiter has seen stderr, but consent is unavailable until the
    // original startup wait returns failure (no competing authentication).
    assert_eq!(
        state.status_snapshot().initialization_repair,
        InitializationRepair::None
    );
    assert!(
        node_repair_initialized(window.clone(), app.handle().clone(), app.state(), true)
            .await
            .is_err()
    );
    assert!(wait_for_health(&state).await.is_err());
    assert_eq!(
        state.status_snapshot().initialization_repair,
        InitializationRepair::Required
    );
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "start\n");
    assert!(!marker.exists());
    assert!(
        node_repair_initialized(window.clone(), app.handle().clone(), app.state(), false)
            .await
            .is_err()
    );
    assert!(!marker.exists());
    node_repair_initialized(window, app.handle().clone(), app.state(), true)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&calls).unwrap(),
        "start\nrepair\nstart\n"
    );
    assert_eq!(
        state.status_snapshot().initialization_repair,
        InitializationRepair::None
    );
    assert!(state.status_snapshot().ready);
    assert_eq!(state.status_snapshot().node_id.as_deref(), Some("existing"));
    state.stop_for_restart(Duration::from_secs(2));
    server.join().unwrap();
}

#[cfg(unix)]
#[test]
fn a_delayed_exit_report_cannot_terminate_or_offer_repair_for_the_replacement() {
    let state = NodeState::default();
    let old = state
        .spawn_child(std::process::Command::new("/bin/sh").args(["-c", "exit 1"]))
        .unwrap();
    old.wait().unwrap();
    state.stop_for_restart(Duration::from_secs(1));
    let new = state
        .spawn_child(std::process::Command::new("/bin/sleep").arg("30"))
        .unwrap();
    state.record_node_exit(&old, true, true);
    assert!(!state.sidecar_terminated.load(Ordering::SeqCst));
    assert!(!state.initialization_refused.load(Ordering::SeqCst));
    assert_eq!(
        state.status_snapshot().initialization_repair,
        InitializationRepair::None
    );
    new.kill().unwrap();
    new.wait().unwrap();
    state.record_node_exit(&new, false, false);
    assert!(state.sidecar_terminated.load(Ordering::SeqCst));
    state.stop_for_restart(Duration::from_secs(1));
}

#[cfg(unix)]
#[tokio::test]
async fn price_floor_refusal_is_only_offered_after_failed_stderr_exit() {
    use std::os::unix::fs::PermissionsExt;
    for (diagnostic, output, exit, offered) in [
        ("pricing.web_content_msat must be at least 1000 msat (1 sat): porch read floor (BROWSE.md §3)", "&2", 1, true),
        ("pricing.web_content_msat must be at least 1000 msat (1 sat): porch read floor (BROWSE.md §3)", "&1", 1, false),
        ("pricing.web_content_msat must be at least 1000 msat (1 sat): porch read floor (BROWSE.md §3)", "&2", 0, false),
        ("pricing.web_content_msat must be at least 10000", "&2", 1, false),
        ("pricing.message_msat must be at least 1000", "&2", 1, false),
        ("rc7 ordinary startup", "&2", 0, false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("mock-node");
        let config = dir.path().join("konsensus.toml");
        let original = include_str!("../tests/fixtures/rc7-pricing.toml");
        std::fs::write(&config, original).unwrap();
        std::fs::write(&program, format!("#!/bin/sh\nprintf '%s\\n' '{diagnostic}' >{output}\nexit {exit}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = NodeState::default();
        *state.config.lock().unwrap() = Some(config.clone());
        *state.dev_sidecar.lock().unwrap() = Some(program);
        let app = tauri::test::mock_builder().manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let state = app.state::<NodeState>();
        spawn_node(app.handle(), &config).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !state.sidecar_terminated.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        assert_eq!(serde_json::to_value(state.status_snapshot().initialization_repair).unwrap(), "none");
        assert!(wait_for_health(&state).await.is_err());
        assert_eq!(serde_json::to_value(state.status_snapshot().initialization_repair).unwrap(),
            if offered { "price_floor_required" } else { "none" });
        assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
        assert!(!config.with_extension("toml.bak").exists());
        state.stop_for_restart(Duration::from_secs(1));
    }
}

#[tokio::test]
async fn price_floor_repair_requires_its_own_local_stopped_consent() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("konsensus.toml");
    let original = include_str!("../tests/fixtures/rc7-pricing.toml");
    std::fs::write(&config, original).unwrap();
    let state = NodeState::default();
    *state.config.lock().unwrap() = Some(config.clone());
    for (pending, stopped, confirmed, remote, external) in [
        (InitializationRepair::None, true, true, false, false),
        (InitializationRepair::Required, true, true, false, false),
        (InitializationRepair::PriceFloorRequired, false, true, false, false),
        (InitializationRepair::PriceFloorRequired, true, false, false, false),
        (InitializationRepair::PriceFloorRequired, true, true, true, false),
        (InitializationRepair::PriceFloorRequired, true, true, false, true),
    ] {
        *state.initialization_repair.lock().unwrap() = pending;
        state.sidecar_terminated.store(stopped, Ordering::SeqCst);
        state.remote_mode.store(remote, Ordering::SeqCst);
        *state.external_node.lock().unwrap() = external.then(|| dir.path().into());
        assert!(repair_price_floor_files(&state, confirmed).is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
        assert!(!config.with_extension("toml.bak").exists());
    }
    state.remote_mode.store(false, Ordering::SeqCst);
    *state.external_node.lock().unwrap() = None;
    assert!(repair_price_floor_files(&state, true).is_ok());
    assert_eq!(std::fs::read_to_string(&config).unwrap(), original.replacen("=  50 #", "=  1000 #", 1));
    assert_eq!(std::fs::read_to_string(config.with_extension("toml.bak")).unwrap(), original);
    assert!(repair_price_floor_files(&state, true).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn retained_node_requires_two_separate_consents_then_authenticates_normally() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("konsensus.toml");
    let marker = dir.path().join("mock-marker");
    let calls = dir.path().join("calls");
    let program = dir.path().join("mock-node");
    let seed = dir.path().join("identity/mnemonic");
    std::fs::create_dir(seed.parent().unwrap()).unwrap();
    std::fs::write(&seed, "existing-identity").unwrap();
    let original = include_str!("../tests/fixtures/rc7-pricing.toml");
    std::fs::write(&config, &original).unwrap();
    assert!(!local_owner::launch_enabled(true, &config).unwrap(),
        "a retained seed beside the config must not enable owner mode");
    std::fs::write(&program, format!(r#"#!/bin/sh
printf '%s\n' "$1" >> '{}'
if [ "$1" = repair ]; then touch '{}'; exit 0; fi
if [ ! -f '{}' ]; then
  printf '%s\n' 'Error: refusing to start (identity_without_marker)' >&2
  exit 1
fi
if grep -q '=  50 #' "$3"; then
  printf '%s\n' 'Error: pricing.web_content_msat must be at least 1000 msat (1 sat): porch read floor (BROWSE.md §3)' >&2
  exit 1
fi
exec sleep 30
"#, calls.display(), marker.display(), marker.display())).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    // Health remains unavailable until both repairs have happened. This also
    // covers the health request racing stderr/exit on the intermediate start.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let state = NodeState::for_api(format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port()));
    let server_config = config.clone();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut authenticated = false;
        loop {
            assert!(Instant::now() < deadline, "node never finished authentication");
            let (stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5)); continue;
                }
                Err(e) => panic!("{e}"),
            };
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = std::io::BufReader::new(stream);
            let mut request = String::new();
            // Health probes race sidecar exit and can be cancelled after TCP
            // connect but before sending HTTP. Retire that idle fixture socket;
            // the overall deadline still requires real authentication to finish.
            match reader.read_line(&mut request) {
                Ok(0) => continue,
                Ok(_) => {},
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(e) => panic!("{e}"),
            }
            let mut length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header == "\r\n" || header.is_empty() { break; }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            reader.read_exact(&mut vec![0; length]).unwrap();
            let repaired = std::fs::read_to_string(&server_config).unwrap().contains("=  1000 #");
            let (status, body, done) = if request.starts_with("GET /api/v1/health ") {
                (if repaired { 200 } else { 503 }, "{}", false)
            } else if request.starts_with("GET /api/v1/bootstrap/state ") || request.starts_with("POST /api/v1/pair/request ") {
                (404, "{}", false)
            } else if request.starts_with("POST /api/v1/auth/local ") {
                assert!(repaired, "must not authenticate before price consent");
                authenticated = true;
                (200, r#"{"token":"test-token"}"#, false)
            } else {
                assert!(request.starts_with("GET /api/v1/identity "), "{request}");
                assert!(authenticated);
                (200, r#"{"node_id":"existing"}"#, true)
            };
            write!(reader.get_mut(), "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            if done { break; }
        }
    });
    state.owner.active.store(local_owner::launch_enabled(true, &config).unwrap(), Ordering::SeqCst);
    assert!(!state.status_snapshot().local_owner, "upgrade must not request a new seed password");
    *state.config.lock().unwrap() = Some(config.clone());
    *state.dev_sidecar.lock().unwrap() = Some(program);
    let app = tauri::test::mock_builder().manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let state = app.state::<NodeState>();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default()).build().unwrap();
    spawn_node(app.handle(), &config).unwrap();
    assert!(wait_for_health(&state).await.is_err());
    assert_eq!(state.status_snapshot().initialization_repair, InitializationRepair::Required);
    assert!(node_repair_price_floor(window.clone(), app.handle().clone(), app.state(), true).await.is_err());
    assert!(node_repair_initialized(window.clone(), app.handle().clone(), app.state(), false).await.is_err());
    assert!(!marker.exists(), "marker repair needs its own consent");
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "start\n");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
    assert!(node_repair_initialized(window.clone(), app.handle().clone(), app.state(), true).await.is_err());
    assert!(marker.exists());
    assert_eq!(state.status_snapshot().initialization_repair, InitializationRepair::PriceFloorRequired);
    assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
    assert!(!config.with_extension("toml.bak").exists());
    assert!(node_repair_initialized(window.clone(), app.handle().clone(), app.state(), true).await.is_err());
    assert!(node_repair_price_floor(window.clone(), app.handle().clone(), app.state(), false).await.is_err());
    assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
    node_repair_price_floor(window, app.handle().clone(), app.state(), true).await.unwrap();
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "start\nrepair\nstart\nstart\n");
    assert_eq!(std::fs::read_to_string(config.with_extension("toml.bak")).unwrap(), original);
    assert!(state.status_snapshot().ready);
    assert!(!state.status_snapshot().local_owner, "retained identity cannot reopen ceremony");
    assert_eq!(std::fs::read_to_string(seed).unwrap(), "existing-identity");
    assert_eq!(state.status_snapshot().node_id.as_deref(), Some("existing"));
    assert_eq!(state.status_snapshot().initialization_repair, InitializationRepair::None);
    state.stop_for_restart(Duration::from_secs(2));
    server.join().unwrap();
}
