use super::*;

// All three replies are held until all three requests arrive. Serial I/O
// cannot pass this test, regardless of scheduler speed or the machine's RTT.
#[tokio::test]
async fn paid_send_preflight_takes_at_most_two_round_trips() {
    let enabled = Arc::new(AtomicBool::new(false));
    let arrivals = Arc::new((Mutex::new(0usize), std::sync::Condvar::new()));
    let (active, reads) = (enabled.clone(), arrivals.clone());
    let routes: Routes = Arc::new(move |_, path, _| {
        if active.load(Ordering::SeqCst)
            && matches!(path, "/payments/price/0" | "/pricing/peers" | "/pair/grant")
        {
            let (lock, wake) = &*reads;
            let mut count = lock.lock().unwrap();
            *count += 1;
            wake.notify_all();
            let (_guard, timeout) = wake.wait_timeout_while(count, Duration::from_secs(2), |n| *n < 3).unwrap();
            if timeout.timed_out() { return (503, "preflight reads were serialized".into()); }
        }
        (0, String::new())
    });
    let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(routes));
    with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
    g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
    g1_approved(&node, 500_000).await;
    // The quote shown before Send already established the all-in contract.
    *node.state.all_in_caps_node.lock().unwrap() = Some(OWN.into());
    node.seen.lock().unwrap().clear();
    enabled.store(true, Ordering::SeqCst);

    do_conversation_send(&node.state, A, false, "gm", 7000, None, None).await.unwrap();
    let targets = node.targets();
    let compose = targets.iter().position(|p| p == "POST /messages/compose").unwrap();
    let statuses = targets[..compose].iter().filter(|p| *p == "GET /status").count();
    assert_eq!(*arrivals.0.lock().unwrap(), 3);
    assert_eq!(compose, statuses + 3, "no extra pre-compose requests: {targets:?}");
    assert!(statuses + 1 <= 2, "one status RTT plus one concurrent read RTT: {targets:?}");

    // A second send reuses capabilities, but always reads prices and grant.
    *arrivals.0.lock().unwrap() = 0;
    node.seen.lock().unwrap().clear();
    do_conversation_send(&node.state, A, false, "again", 7000, None, None).await.unwrap();
    assert!(!node.targets().iter().any(|p| p == "GET /status"));
    assert_eq!(*arrivals.0.lock().unwrap(), 3);
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
    assert_eq!(node.targets(), ["GET /status"]);
    supported.store(false, Ordering::SeqCst);
    // A remote connection failure ends the old connection even at the same id.
    node.state.remote_retry.failed(&remote_access::RemoteError::HandshakeUnavailable);
    assert_eq!(require_price_caps(&node.state, false).await.err().unwrap().code, "price_cap_unavailable");
    assert_eq!(node.targets(), ["GET /status", "GET /status"]);
    supported.store(true, Ordering::SeqCst);
    *node.state.node_id.lock().unwrap() = Some(C.into());
    require_price_caps(&node.state, false).await.unwrap();
    assert_eq!(node.targets().len(), 3);
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
async fn paid_send_preflight_parallel_readers_refresh_the_token_once() {
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
