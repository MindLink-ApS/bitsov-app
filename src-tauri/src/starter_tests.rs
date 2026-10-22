// Included in control_act_tests to exercise the real authenticated HTTP boundary.
const STARTER_ID: &str = "12345678-1234-4234-8234-123456789abc";
fn starter_routes(network: &'static str, configured: bool) -> Routes {
    Arc::new(move |method, path, body| {
        if path == "/status" {
            return (200, serde_json::json!({"status":"ok","node_id":OWN,"network":network,
                "api_capabilities":["starter_channel_request_v1"]}).to_string());
        }
        if path == "/onboarding/starter-channel" {
            if method == "POST" {
                assert_eq!(serde_json::from_str::<serde_json::Value>(body).unwrap(), serde_json::json!({"request_id":STARTER_ID}));
                return (202, serde_json::json!({"state":"requested","request_id":STARTER_ID,
                    "hub_configured":true,"hub_alias":"Hub","verified":false,"hub_ln_pubkey":"secret-routing-key"}).to_string());
            }
            return (200, serde_json::json!({"state":"not_requested","hub_configured":configured}).to_string());
        }
        happy()(method, path, body)
    })
}
#[tokio::test]
async fn starter_receive_request_needs_no_approval_and_only_posts_request_id() {
    let (node, _dir) = paired_fake(starter_routes("signet", true));
    let view = do_starter_request(&node.state, OWN, STARTER_ID).await.unwrap();
    assert_eq!(view.state, "requested");
    let json = serde_json::to_value(view).unwrap();
    assert!(json.get("hub_ln_pubkey").is_none());
    assert_eq!(node.posts(), [("/onboarding/starter-channel".into(), serde_json::json!({"request_id":STARTER_ID}))]);
    assert!(node.seen.lock().unwrap().iter().all(|(_, _, bearer, _)| bearer.as_deref() == Some("tok.1")));
}
#[tokio::test]
async fn starter_refuses_wrong_network_hub_identity_and_unpaired_before_post() {
    for (network, configured, own) in [("mainnet", true, OWN), ("regtest", true, OWN), ("signet", false, OWN), ("signet", true, A)] {
        let (node, _dir) = paired_fake(starter_routes(network, configured));
        assert!(do_starter_request(&node.state, own, STARTER_ID).await.is_err());
        assert!(node.posts().is_empty());
    }
    let node = fake(AuthMode::Local, starter_routes("signet", true));
    assert!(do_starter_request(&node.state, OWN, STARTER_ID).await.is_err());
    assert!(node.targets().is_empty());
}
#[tokio::test]
async fn starter_rejects_invalid_ids_before_network_and_handles_existing_operation_conflict() {
    let (node, _dir) = paired_fake(starter_routes("signet", true));
    for id in ["../../status", "12345678-1234-1234-8234-123456789abc", "12345678-1234-4234-0234-123456789abc"] {
        assert!(do_starter_request(&node.state, OWN, id).await.is_err());
    }
    assert!(node.targets().is_empty());
    let routes: Routes = Arc::new(|m, p, b| {
        if m == "POST" && p == "/onboarding/starter-channel" {
            return (409, serde_json::json!({"code":"starter_already_requested","request_id":STARTER_ID}).to_string());
        }
        starter_routes("signet", true)(m, p, b)
    });
    let (node, _dir) = paired_fake(routes);
    assert_eq!(do_starter_request(&node.state, OWN, STARTER_ID).await.unwrap().state, "not_requested");
    assert_eq!(node.posts().len(), 1);
    assert_eq!(node.targets().last().unwrap(), "GET /onboarding/starter-channel");
}
#[tokio::test]
async fn starter_serializes_with_node_replacement_through_dispatch() {
    let (node, _dir) = paired_fake(starter_routes("signet", true));
    let change = node.state.remote_change.lock().await;
    let blocked = tokio::time::timeout(Duration::from_millis(25), do_starter_request(&node.state, OWN, STARTER_ID)).await;
    assert!(blocked.is_err(), "request waits until the node replacement finishes");
    assert!(node.targets().is_empty(), "no discovery on the outgoing node");
    drop(change);
    do_starter_request(&node.state, OWN, STARTER_ID).await.unwrap();
}
#[tokio::test]
async fn starter_holds_node_connection_until_post_response_and_fences_discovery() {
    let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (seen, done) = (entered.clone(), release.clone());
    let routes: Routes = Arc::new(move |m, p, b| {
        if m == "POST" && p == "/onboarding/starter-channel" {
            seen.store(true, Ordering::SeqCst);
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !done.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        starter_routes("signet", true)(m, p, b)
    });
    let (node, _dir) = paired_fake(routes);
    let (request, ()) = tokio::join!(do_starter_request(&node.state, OWN, STARTER_ID), async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !entered.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(1)).await; }
        }).await.unwrap();
        let change = node.state.remote_change.try_lock();
        release.store(true, Ordering::SeqCst);
        assert!(change.is_err(), "replacement cannot change credentials while POST is outstanding");
    });
    request.unwrap();
    let _change = node.state.remote_change.lock().await;
    assert!(tokio::time::timeout(Duration::from_millis(25), read_starter_current(&node.state, OWN)).await.is_err());
}
