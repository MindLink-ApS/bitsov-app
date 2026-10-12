use super::*;

// Abort drops the listener AND its accepted keep-alive sockets. Rebinding the
// same address below therefore exercises reqwest reconnecting to a new node.
fn restartable_node(listener: tokio::net::TcpListener, caps: &'static str) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            connections.spawn(async move {
                let mut reader = tokio::io::BufReader::new(stream);
                loop {
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                        if line == "\r\n" { break; }
                        request.push_str(&line);
                    }
                    let body = if request.starts_with("GET /api/v1/status ") {
                        format!("{{\"api_capabilities\":{caps}}}")
                    } else {
                        assert!(request.starts_with("GET /api/v1/identity "));
                        serde_json::json!({"node_id": OWN}).to_string()
                    };
                    let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                    if reader.get_mut().write_all(reply.as_bytes()).await.is_err() { return; }
                }
            });
        }
    })
}

#[tokio::test]
async fn paid_send_preflight_local_restart_on_same_port_invalidates_caps() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = restartable_node(listener, r#"["paid_send_caps_v1"]"#);
    let state = NodeState::for_api(format!("http://{address}/api/v1"));
    *state.auth.lock().unwrap() = AuthMode::Local;
    *state.token.lock().unwrap() = Some("tok.1".into());
    *state.node_id.lock().unwrap() = Some(OWN.into());
    require_price_caps(&state, false).await.unwrap();
    server.abort();
    let _ = server.await;
    // JoinSet cancellation closes accepted sockets on the next runtime turn.
    tokio::task::yield_now().await;
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let server = restartable_node(listener, "[]");
    // Ordinary HTTP recovery, with no WebSocket/auth/identity transition.
    assert_eq!(fetch_node_id(&state).await.unwrap(), OWN);
    let result = require_price_caps(&state, false).await;
    server.abort();
    let _ = server.await;
    assert_eq!(result.err().unwrap().code, "price_cap_unavailable");
}

// No WebSocket event or failed handshake: a restarted node can accept the
// very first reconnect while the live feed is still sleeping in backoff.
#[tokio::test]
async fn paid_send_preflight_fresh_remote_handshake_refuses_downgraded_caps() {
    let downgraded = Arc::new(AtomicBool::new(false));
    let changed = downgraded.clone();
    let routes: Routes = Arc::new(move |_, path, _| {
        if path == "/status" && changed.load(Ordering::SeqCst) {
            (200, serde_json::json!({"api_capabilities": []}).to_string())
        } else { (0, String::new()) }
    });
    let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(routes));
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
    g1_approved(&node, 500_000).await;
    require_price_caps(&node.state, false).await.unwrap();
    *node.state.all_in_caps_node.lock().unwrap() = Some(OWN.into());
    downgraded.store(true, Ordering::SeqCst);
    // The same admission gate used by serve_connection's fresh Noise handshake.
    node.state.remote_retry.run(|| async { Ok(()) }).await.unwrap();
    let error = do_conversation_send(&node.state, A, false, "gm", 7000, None, None).await.unwrap_err();
    assert_eq!(error.code, "price_cap_unavailable");
    assert_eq!(composes(&node), 0);
    assert_eq!(budget_now(&node.state).spent_msat, 0);
    assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
}

#[cfg(all(desktop, not(feature = "mobile")))]
#[tokio::test]
async fn paid_send_preflight_adopting_same_identity_invalidates_caps() {
    let downgraded = Arc::new(AtomicBool::new(false));
    let changed = downgraded.clone();
    let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
    let arrived = Mutex::new(Some(arrived_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release = Mutex::new(release_rx);
    let routes: Routes = Arc::new(move |m, path, b| match path {
        "/health" => (200, "{}".into()),
        "/auth/local" => (200, serde_json::json!({"token": "tok.1"}).to_string()),
        "/identity" => {
            if let Some(tx) = arrived.lock().unwrap().take() {
                tx.send(()).unwrap();
                release.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            }
            (200, serde_json::json!({"node_id": OWN}).to_string())
        }
        "/status" if changed.load(Ordering::SeqCst) =>
            (200, serde_json::json!({"api_capabilities": []}).to_string()),
        _ => happy()(m, path, b),
    });
    let node = fake(AuthMode::Local, routes);
    require_price_caps(&node.state, false).await.unwrap();
    let during_adoption = async {
        arrived_rx.await.unwrap();
        // Evidence acquired during adoption must also expire when it completes.
        require_price_caps(&node.state, false).await.unwrap();
        downgraded.store(true, Ordering::SeqCst);
        release_tx.send(()).unwrap();
    };
    let (adopted, ()) = tokio::join!(adopt_matching_identity(&node.state, OWN), during_adoption);
    assert!(adopted.unwrap());
    assert_eq!(require_price_caps(&node.state, false).await.err().unwrap().code, "price_cap_unavailable");
}

#[tokio::test]
async fn paid_send_preflight_discards_status_crossing_successful_handshake() {
    let downgraded = Arc::new(AtomicBool::new(false));
    let changed = downgraded.clone();
    let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
    let arrived = Mutex::new(Some(arrived_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release = Mutex::new(release_rx);
    let routes: Routes = Arc::new(move |m, path, b| {
        let reply = if path == "/status" && changed.load(Ordering::SeqCst) {
            (200, serde_json::json!({"api_capabilities": []}).to_string())
        } else { happy()(m, path, b) };
        if path == "/status" {
            if let Some(tx) = arrived.lock().unwrap().take() {
                tx.send(()).unwrap();
                release.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            }
        }
        reply
    });
    let node = fake(AuthMode::Local, routes);
    let interrupt = async {
        arrived_rx.await.unwrap();
        downgraded.store(true, Ordering::SeqCst);
        node.state.remote_retry.run(|| async { Ok(()) }).await.unwrap();
        release_tx.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(require_price_caps(&node.state, false), interrupt);
    assert_eq!(result.err().unwrap().code, "price_cap_unavailable");
    assert_eq!(node.targets(), ["GET /status", "GET /status"]);
}

// A read launched beside own-price can return a usable snapshot which becomes
// invalid while own-price is still held. A sequential reader sees the change.
async fn stale_preflight_read_refuses(change: &str, expected: &str) {
    let enabled = Arc::new(AtomicBool::new(false));
    let changed = Arc::new(AtomicBool::new(false));
    let grant = Arc::new(Mutex::new(g1_grant(3600, 400_000, 400_000)));
    grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
    let (held_tx, held_rx) = tokio::sync::oneshot::channel();
    let held = Mutex::new(Some(held_tx));
    let (snapshot_tx, snapshot_rx) = tokio::sync::oneshot::channel();
    let snapshot = Mutex::new(Some(snapshot_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release = Mutex::new(release_rx);
    let peer_change = change == "peer";
    let (active, updated, live_grant) = (enabled.clone(), changed.clone(), grant.clone());
    let routes: Routes = Arc::new(move |_, path, _| {
        if !active.load(Ordering::SeqCst) { return (0, String::new()); }
        if path == "/payments/price/0" {
            if let Some(tx) = held.lock().unwrap().take() {
                tx.send(()).unwrap();
                release.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            }
        }
        let reply = match path {
            "/pricing/peers" if peer_change => serde_json::json!([
                {"peer_id": A, "prices": {"communication": if updated.load(Ordering::SeqCst) { 9000 } else { 2000 }}, "age_secs": 0, "stale": false}
            ]).to_string(),
            "/pair/grant" if !peer_change => serde_json::json!({"grant": *live_grant.lock().unwrap()}).to_string(),
            _ => return (0, String::new()),
        };
        // Capture the response before notifying: changing server state cannot
        // alter a reply already returned to the host by a concurrent read.
        if let Some(tx) = snapshot.lock().unwrap().take() { let _ = tx.send(()); }
        (200, reply)
    });
    let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(routes));
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
    g1_approved(&node, 500_000).await;
    *node.state.all_in_caps_node.lock().unwrap() = Some(OWN.into());
    enabled.store(true, Ordering::SeqCst);
    let interrupt = async {
        held_rx.await.unwrap();
        // Old code returns the early snapshot. Correct code cannot issue that
        // read yet; the bounded wait lets us release own-price in either case.
        let _ = tokio::time::timeout(Duration::from_millis(500), snapshot_rx).await;
        match change {
            "revoked" => *grant.lock().unwrap() = serde_json::Value::Null,
            "exhausted" => {
                let mut grant = grant.lock().unwrap();
                grant["used_msat"] = serde_json::json!(400_000);
                grant["remaining_msat"] = serde_json::json!(0);
            }
            "peer" => changed.store(true, Ordering::SeqCst),
            _ => unreachable!(),
        }
        release_tx.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(
        do_conversation_send(&node.state, A, false, "gm", 7000, None, None),
        interrupt,
    );
    assert_eq!(result.unwrap_err().code, expected);
    assert_eq!(composes(&node), 0);
    assert_eq!(budget_now(&node.state).spent_msat, 0);
    assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
}

#[tokio::test]
async fn paid_send_preflight_refuses_grant_revoked_during_stalled_own_price() {
    stale_preflight_read_refuses("revoked", "grant_ended").await;
}

#[tokio::test]
async fn paid_send_preflight_refuses_grant_exhausted_during_stalled_own_price() {
    stale_preflight_read_refuses("exhausted", "grant_exhausted").await;
}

#[tokio::test]
async fn paid_send_preflight_refuses_peer_price_raised_during_stalled_own_price() {
    stale_preflight_read_refuses("peer", "price_changed").await;
}

// Count serialized pre-compose round trips, excluding the compose POST itself.
// Capabilities may be reused; prices and authority must be fresh and ordered.
#[tokio::test]
async fn paid_send_preflight_takes_at_most_four_round_trips() {
    let (node, _dir, g1) = g1_node(&["read", "receive"]);
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
    g1_approved(&node, 500_000).await;
    // The quote shown before Send already established the all-in contract.
    *node.state.all_in_caps_node.lock().unwrap() = Some(OWN.into());

    for (text, statuses) in [("gm", 1), ("again", 0)] {
        node.seen.lock().unwrap().clear();
        do_conversation_send(&node.state, A, false, text, 7000, None, None).await.unwrap();
        let targets = node.targets();
        let compose = targets.iter().position(|p| p == "POST /messages/compose").unwrap();
        assert_eq!(targets[..compose].iter().filter(|p| *p == "GET /status").count(), statuses);
        assert_eq!(&targets[statuses..compose], [
            "GET /payments/price/0", "GET /pricing/peers", "GET /pair/grant",
        ], "prices first, grant last, no duplicate status or extra reads: {targets:?}");
        assert_eq!(compose, statuses + 3);
        assert!(compose <= 4, "one status RTT plus three sequential reads: {targets:?}");
    }
}

#[tokio::test]
async fn paid_send_preflight_failed_reads_refuse_without_reserving_or_composing() {
    for failed in ["/status", "/payments/price/0", "/pricing/peers", "/pair/grant"] {
        let enabled = Arc::new(AtomicBool::new(false));
        let active = enabled.clone();
        let routes: Routes = Arc::new(move |_, path, _| {
            if active.load(Ordering::SeqCst) && path == failed {
                (503, "unavailable".into())
            } else { (0, String::new()) }
        });
        let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(routes));
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        *node.state.all_in_caps_node.lock().unwrap() = Some(OWN.into());
        enabled.store(true, Ordering::SeqCst);
        let error = do_conversation_send(&node.state, A, false, "gm", 7000, None, None).await.unwrap_err();
        assert_eq!(error.code, match failed { "/pair/grant" => "grant_unknown", "/status" => "price_quote_unavailable", _ => "node" }, "{failed}: {error:?}");
        assert_eq!(composes(&node), 0, "{failed}");
        assert_eq!(budget_now(&node.state).spent_msat, 0);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }
}

#[tokio::test]
async fn paid_send_preflight_capabilities_are_shared_but_not_across_connections() {
    let supported = Arc::new(AtomicBool::new(true));
    let offers = supported.clone();
    let routes: Routes = Arc::new(move |m, path, b| {
        if path == "/status" && !offers.load(Ordering::SeqCst) {
            return (200, serde_json::json!({"api_capabilities": []}).to_string());
        }
        happy()(m, path, b)
    });
    let node = fake(AuthMode::Local, routes);
    require_price_caps(&node.state, false).await.unwrap();
    require_price_caps(&node.state, true).await.unwrap();
    assert_eq!(node.targets(), ["GET /status", "GET /status"]);
    supported.store(false, Ordering::SeqCst);
    // A remote connection failure ends the old connection even at the same id.
    node.state.remote_retry.failed(&remote_access::RemoteError::HandshakeUnavailable);
    assert_eq!(require_price_caps(&node.state, false).await.err().unwrap().code, "price_cap_unavailable");
    assert_eq!(node.targets(), ["GET /status", "GET /status", "GET /status"]);
    supported.store(true, Ordering::SeqCst);
    *node.state.node_id.lock().unwrap() = Some(C.into());
    require_price_caps(&node.state, false).await.unwrap();
    assert_eq!(node.targets().len(), 4);
}

#[tokio::test]
async fn paid_send_preflight_keeps_price_before_grant_decisions() {
    let routes: Routes = Arc::new(|_, path, _| match path {
        "/payments/price/0" => (503, "own-price failed".into()),
        "/pricing/peers" => (503, "peer-price failed".into()),
        _ => (0, String::new()),
    });
    let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(routes));
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1_approved(&node, 500_000).await;
    *g1.grant.lock().unwrap() = serde_json::Value::Null;
    let error = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
    assert!(error.message.contains("own-price failed"), "{error:?}");
    assert!(node.state.node_grant.lock().unwrap().is_some(), "grant decision cannot close approvals before the price decision");
    assert_eq!(composes(&node), 0);
}

#[tokio::test]
async fn paid_send_preflight_refreshes_the_token_once() {
    let (node, _dir, g1) = g1_node(&["read", "receive"]);
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
    g1_approved(&node, 500_000).await;
    require_price_caps(&node.state, false).await.unwrap();
    if let AuthMode::Paired(session) = &mut *node.state.auth.lock().unwrap() {
        session.expires_at = now_unix() + 30;
    }
    node.seen.lock().unwrap().clear();
    do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap();
    let targets = node.targets();
    assert_eq!(targets.iter().filter(|p| p.starts_with("GET /pair/challenge")).count(), 1);
    assert_eq!(targets.iter().filter(|p| *p == "POST /pair/token").count(), 1);
    assert_eq!(composes(&node), 1);
}

#[tokio::test]
async fn paid_send_preflight_late_reads_cannot_cross_reconnect_pause_or_lock() {
    for change in ["reconnect_status", "reconnect_prices", "pause", "lock"] {
        let enabled = Arc::new(AtomicBool::new(false));
        let active = enabled.clone();
        let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
        let arrived = Mutex::new(Some(arrived_tx));
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release = Mutex::new(release_rx);
        let held = if change == "reconnect_status" { "/status" } else { "/payments/price/0" };
        let routes: Routes = Arc::new(move |_, path, _| {
            if active.load(Ordering::SeqCst) && path == held {
                if let Some(tx) = arrived.lock().unwrap().take() {
                    tx.send(()).unwrap();
                    release.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
                }
            }
            (0, String::new())
        });
        let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(routes));
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        *node.state.all_in_caps_node.lock().unwrap() = Some(OWN.into());
        enabled.store(true, Ordering::SeqCst);
        let interrupt = async {
            arrived_rx.await.unwrap();
            match change {
                "pause" => { do_budget_pause(&node.state).unwrap(); }
                "lock" => { node.state.autopay.lock().unwrap().lock(); }
                _ => node.state.invalidate_send_capabilities(),
            }
            release_tx.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(
            do_conversation_send(&node.state, A, false, "gm", 7000, None, None),
            interrupt,
        );
        assert!(result.is_err(), "{change}");
        assert_eq!(composes(&node), 0, "{change}");
        assert_eq!(budget_now(&node.state).spent_msat, 0);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
        if change == "reconnect_status" {
            assert!(node.state.send_capabilities.lock().await.is_none(), "late status must not populate the new connection's cache");
            let before = node.targets().len();
            require_price_caps(&node.state, false).await.unwrap();
            assert_eq!(node.targets().len(), before + 1);
        }
    }
}

#[tokio::test]
async fn paid_send_preflight_price_ceiling_precedes_revoked_grant() {
    let (node, _dir, g1) = g1_node(&["read", "receive"]);
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1_approved(&node, 500_000).await;
    *g1.grant.lock().unwrap() = serde_json::Value::Null;
    let error = do_message_send(&node.state, A, false, "gm", 6000, None).await.unwrap_err();
    assert_eq!(error.code, "price_changed");
    assert!(node.state.node_grant.lock().unwrap().is_some());
    assert_eq!(composes(&node), 0);
}
