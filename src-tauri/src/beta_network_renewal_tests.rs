use super::*;

#[derive(Clone, Copy)]
pub(in crate::app) enum Renewal { Reauth, Direct, Unauthorized, Due }

pub(in crate::app) async fn established(product: bool, legacy: bool, remote: bool) -> (NodeState, tempfile::TempDir, StatusServer, Arc<ReportControl>) {
    let control = Arc::new(ReportControl::default());
    control.require_latest.store(true, Ordering::SeqCst);
    let routes = if legacy { mock_node::pairing::PairRoutes::Absent } else { mock_node::pairing::PairRoutes::Live };
    let identifier = if product { "tech.mindlink.bitsov" } else { BETA };
    let (state, dir, server) = auth_fixture_controlled_for_identifier(identifier, Some("signet".into()), routes, None, control.clone());
    finish_auth(&state, dir.path()).await;
    assert!(state.status_snapshot().ready, "initial signet authentication must succeed");
    assert!(state.token.lock().unwrap().is_some());
    assert_eq!(state.status_snapshot().node_id.as_deref(), Some(mock_node::NODE_ID));
    assert_eq!(matches!(*state.auth.lock().unwrap(), AuthMode::Local), legacy);
    assert_eq!(matches!(*state.auth.lock().unwrap(), AuthMode::Paired(_)), !legacy);
    state.remote_mode.store(remote, Ordering::SeqCst);
    *state.configured_network.lock().unwrap() = Some("signet".into());
    (state, dir, server, control)
}

pub(in crate::app) fn open_approvals(state: &NodeState) {
    state.spend.lock().unwrap().arm(now_ms(), act::SpendBasis::NodeGrant);
    state.autopay.lock().unwrap().arm(now_ms(), 10_000, act::SpendBasis::NodeGrant);
    *state.node_grant.lock().unwrap() = Some(NodeGrant { expires_at: i64::MAX, budget_msat: 10_000, remaining_msat: 10_000, ..Default::default() });
    assert!(state.node_grant.lock().unwrap().is_some());
    assert_eq!(state.spend.lock().unwrap().view(now_ms()).state, act::SpendState::Open);
    assert_eq!(state.autopay.lock().unwrap().view(now_ms()).state, budget::AutopayState::Open);
}

pub(in crate::app) async fn assert_retired(state: &NodeState, control: &ReportControl, epoch: u64, refusal: &str) {
    assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], refusal);
    assert!(state.token.lock().unwrap().is_none());
    assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated));
    assert!(!state.status_snapshot().ready);
    assert_eq!(state.pairing_snapshot().state, "failed");
    assert!(*state.network_auth_epoch.lock().unwrap() > epoch);
    assert!(state.node_grant.lock().unwrap().is_none());
    assert_eq!(state.spend.lock().unwrap().view(now_ms()).state, act::SpendState::Locked);
    assert_eq!(state.autopay.lock().unwrap().view(now_ms()).state, budget::AutopayState::Off);
    let before = control.count("/renewal-probe");
    assert!(call_api(state, reqwest::Method::GET, "/renewal-probe", None).await.is_err());
    assert_eq!(control.count("/renewal-probe"), before, "retired credentials must not dispatch another read");
}

async fn renew(state: &NodeState, action: Renewal) -> Result<(), String> {
    match action {
        Renewal::Reauth => reauthenticate(state).await,
        Renewal::Direct => refresh_paired(state).await,
        Renewal::Unauthorized | Renewal::Due => {
            let (status, _) = call_api(state, reqwest::Method::GET, "/renewal-probe", None).await?;
            if status.is_success() { Ok(()) } else { Err("protected read refused".into()) }
        }
    }
}

async fn renewal_case(product: bool, legacy: bool, remote: bool, action: Renewal, reply: ReportReply) {
    let (state, _dir, _server, control) = established(product, legacy, remote).await;
    open_approvals(&state);
    let previous = state.token.lock().unwrap().clone();
    let epoch = *state.network_auth_epoch.lock().unwrap();
    let statuses = control.count("/status");
    let exchanges = control.count(if legacy { "/auth/local" } else { "/pair/token" });
    let locals = control.count("/auth/local");
    let allowed = product || (reply.status == 200 && reply.raw.is_none() && reply.network.as_ref().and_then(|n| n.as_str()) == Some("signet"));
    let refusal = if reply.network.as_ref().and_then(|n| n.as_str()) == Some("bitcoin") { "mainnet" } else { "unknown" };
    *control.reply.lock().unwrap() = Some(reply);
    if matches!(action, Renewal::Due) {
        if let AuthMode::Paired(session) = &mut *state.auth.lock().unwrap() { session.expires_at = now_unix() + 1; }
    } else if let AuthMode::Paired(session) = &mut *state.auth.lock().unwrap() {
        session.expires_at = now_unix() + 86_400;
        assert!(!session.needs_refresh(now_unix()));
    }
    if matches!(action, Renewal::Unauthorized) { control.probe_401.store(true, Ordering::SeqCst); }
    let result = renew(&state, action).await;
    assert_eq!(result.is_ok(), allowed, "renewal must use the current report");
    assert_eq!(control.count("/status") - statuses, usize::from(!product));
    assert_eq!(control.count(if legacy { "/auth/local" } else { "/pair/token" }) - exchanges, 1);
    if !legacy { assert_eq!(control.count("/auth/local"), locals, "paired renewal must keep its mode"); }
    let reads = match action {
        Renewal::Unauthorized => if allowed { 2 } else { 1 },
        Renewal::Due => usize::from(allowed),
        _ => 0,
    };
    assert_eq!(control.count("/renewal-probe"), reads, "refusal must prevent dispatch or retry");
    if allowed {
        assert!(state.status_snapshot().ready);
        assert_eq!(state.status_snapshot().node_id.as_deref(), Some(mock_node::NODE_ID));
        assert!(*state.token.lock().unwrap() != previous, "renewal must publish a fresh credential");
        assert_eq!(matches!(*state.auth.lock().unwrap(), AuthMode::Local), legacy);
        assert_eq!(matches!(*state.auth.lock().unwrap(), AuthMode::Paired(_)), !legacy);
        assert_eq!(*state.network_auth_epoch.lock().unwrap(), epoch);
        assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
        assert!(state.node_grant.lock().unwrap().is_some());
    } else { assert_retired(&state, &control, epoch, refusal).await; }
}

macro_rules! renewal_variant {
    ($name:ident, $legacy:expr, $remote:expr, $action:ident) => {
        mod $name {
            use super::*;
            #[tokio::test] async fn bitcoin() { renewal_case(false, $legacy, $remote, Renewal::$action, ReportReply::network(Some("bitcoin"))).await; }
            #[tokio::test] async fn absent() { renewal_case(false, $legacy, $remote, Renewal::$action, ReportReply::network(None)).await; }
            #[tokio::test] async fn signet() { renewal_case(false, $legacy, $remote, Renewal::$action, ReportReply::network(Some("signet"))).await; }
            #[tokio::test] async fn product_bitcoin() { renewal_case(true, $legacy, $remote, Renewal::$action, ReportReply::network(Some("bitcoin"))).await; }
            #[tokio::test] async fn product_absent() { renewal_case(true, $legacy, $remote, Renewal::$action, ReportReply::network(None)).await; }
            #[tokio::test] async fn product_signet() { renewal_case(true, $legacy, $remote, Renewal::$action, ReportReply::network(Some("signet"))).await; }
        }
    };
}
renewal_variant!(reauth_local, false, false, Reauth);
renewal_variant!(reauth_remote, false, true, Reauth);
renewal_variant!(reauth_legacy, true, false, Reauth);
renewal_variant!(direct_local, false, false, Direct);
renewal_variant!(direct_remote, false, true, Direct);
renewal_variant!(unauthorized_local, false, false, Unauthorized);
renewal_variant!(unauthorized_remote, false, true, Unauthorized);
renewal_variant!(unauthorized_legacy, true, false, Unauthorized);
renewal_variant!(due_local, false, false, Due);
renewal_variant!(due_remote, false, true, Due);

#[tokio::test]
async fn successful_refresh_preserves_unready_state() {
    let (state, _dir, _server, control) = established(false, false, false).await;
    *state.ready.lock().unwrap() = false;
    *control.reply.lock().unwrap() = Some(ReportReply::network(Some("signet")));
    refresh_paired(&state).await.unwrap();
    assert!(!state.status_snapshot().ready);
    assert!(state.token.lock().unwrap().is_some());
}

#[tokio::test]
async fn failed_reports_retire_renewal_authority() {
    for legacy in [false, true] {
        for (status, raw) in [(401, None), (500, None), (200, Some("unreadable".into()))] {
            renewal_case(false, legacy, false, Renewal::Reauth, ReportReply { network: None, status, raw }).await;
        }
    }
}

#[tokio::test]
async fn buffered_report_cannot_restore_renewal_authority() {
    for legacy in [false, true] {
        let (state, _dir, _server, control) = established(false, legacy, false).await;
        open_approvals(&state);
        let barrier = Arc::new(ReportPause::default());
        *control.pause.lock().unwrap() = Some(barrier.clone());
        let renewal = reauthenticate(&state);
        tokio::pin!(renewal);
        tokio::select! {
            _ = barrier.arrived.notified() => {},
            result = &mut renewal => panic!("renewal ended before its report: {result:?}"),
            _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("report was not requested"),
        }
        let epoch = *state.network_auth_epoch.lock().unwrap();
        state.refuse_network(crate::network_policy::NetworkRefusal::Mainnet);
        barrier.release();
        assert!(renewal.await.is_err(), "a buffered report must not publish credentials");
        assert_retired(&state, &control, epoch, "mainnet").await;
    }
}

#[tokio::test]
async fn obsolete_report_preserves_replacement_session() {
    for legacy in [false, true] {
        for network in ["signet", "bitcoin"] {
            let (state, _dir, _server, control) = established(false, legacy, false).await;
            open_approvals(&state);
            *control.reply.lock().unwrap() = Some(ReportReply::network(Some(network)));
            let barrier = Arc::new(ReportPause::default());
            *control.pause.lock().unwrap() = Some(barrier.clone());
            let renewal = reauthenticate(&state);
            tokio::pin!(renewal);
            tokio::select! {
                _ = barrier.arrived.notified() => {},
                result = &mut renewal => panic!("renewal ended before its report: {result:?}"),
                _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("report was not requested"),
            }
            state.remote_connect_generation.send_modify(|generation| *generation += 1);
            *state.token.lock().unwrap() = Some("replacement".into());
            *state.auth.lock().unwrap() = AuthMode::Local;
            *state.node_id.lock().unwrap() = Some("replacement-node".into());
            barrier.release();
            assert!(renewal.await.is_err());
            assert!(state.token.lock().unwrap().as_deref() == Some("replacement"));
            assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Local));
            assert!(state.status_snapshot().ready);
            assert_eq!(state.status_snapshot().node_id.as_deref(), Some("replacement-node"));
            assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
            assert!(state.node_grant.lock().unwrap().is_some());
        }
    }
}
