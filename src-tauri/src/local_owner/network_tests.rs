use super::*;
use crate::app::beta_network_tests::{ReportPause, ReportReply};
use crate::app::beta_network_tests::renewal_tests::{established, open_approvals, assert_retired};

#[derive(Clone, Copy)]
enum Completion { Commit, Finalize, Reconcile }

fn submitted(state: &NodeState) {
    *state.owner.pending.lock().unwrap() = Some(Metadata {
        ceremony_id: "a".repeat(32), node_id: mock_node::NODE_ID.into(), submitted: true,
    });
    state.pairing_view.lock().unwrap().bootstrap = Some("bootstrap".into());
    *state.ready.lock().unwrap() = false;
    state.owner.test_completion_dependencies.store(true, Ordering::SeqCst);
    state.owner.active.store(true, Ordering::SeqCst);
    *state.external_node.lock().unwrap() = None;
}

async fn complete(state: &NodeState, completion: Completion) -> Result<(), String> {
    match completion {
        Completion::Commit => mark_live(state, mock_node::NODE_ID).await,
        Completion::Finalize | Completion::Reconcile => {
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            if matches!(completion, Completion::Reconcile) {
                reconcile(app.handle(), state).await
            } else {
                restart_and_verify(app.handle(), state, mock_node::NODE_ID).await
            }
        }
    }
}

async fn completion_case(product: bool, completion: Completion, reply: ReportReply) {
    let (state, _dir, _server, control) = established(product, false, false).await;
    submitted(&state);
    open_approvals(&state);
    let epoch = *state.network_auth_epoch.lock().unwrap();
    let statuses = control.count("/status");
    let identities = control.count("/identity");
    let tokens = control.count("/pair/token");
    let allowed = product || (reply.status == 200 && reply.raw.is_none() && reply.network.as_ref().and_then(|n| n.as_str()) == Some("signet"));
    let refusal = if reply.network.as_ref().and_then(|n| n.as_str()) == Some("bitcoin") { "mainnet" } else { "unknown" };
    if !matches!(completion, Completion::Commit) {
        control.queue.lock().unwrap().push_back(ReportReply::network(Some("signet")));
    }
    *control.reply.lock().unwrap() = Some(reply);
    let result = complete(&state, completion).await;
    assert_eq!(result.is_ok(), allowed, "final commit must check its own report");
    let continuing = usize::from(!matches!(completion, Completion::Commit));
    assert_eq!(control.count("/status") - statuses, if product { 0 } else { 1 + continuing });
    assert_eq!(control.count("/pair/token") - tokens, continuing);
    assert_eq!(control.count("/identity") - identities, continuing, "the continuation must verify the actual identity");
    if allowed {
        assert!(state.status_snapshot().ready);
        assert_eq!(state.status_snapshot().node_id.as_deref(), Some(mock_node::NODE_ID));
        assert!(state.owner.pending.lock().unwrap().is_none());
        assert!(state.pairing_snapshot().bootstrap.is_none());
        assert!(state.token.lock().unwrap().is_some());
        assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Paired(_)));
        assert_eq!(*state.network_auth_epoch.lock().unwrap(), epoch);
        assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
    } else {
        assert_retired(&state, &control, epoch, refusal).await;
        let receipt = state.owner.pending.lock().unwrap();
        let receipt = receipt.as_ref().expect("a refused commit must retain the submitted receipt");
        assert!(receipt.submitted);
        assert_eq!(receipt.node_id, mock_node::NODE_ID);
        assert_eq!(receipt.ceremony_id, "a".repeat(32));
    }
}

macro_rules! completion_variant {
    ($name:ident, $completion:ident) => {
        mod $name {
            use super::*;
            #[tokio::test] async fn bitcoin() { completion_case(false, Completion::$completion, ReportReply::network(Some("bitcoin"))).await; }
            #[tokio::test] async fn absent() { completion_case(false, Completion::$completion, ReportReply::network(None)).await; }
            #[tokio::test] async fn signet() { completion_case(false, Completion::$completion, ReportReply::network(Some("signet"))).await; }
            #[tokio::test] async fn product_bitcoin() { completion_case(true, Completion::$completion, ReportReply::network(Some("bitcoin"))).await; }
            #[tokio::test] async fn product_absent() { completion_case(true, Completion::$completion, ReportReply::network(None)).await; }
            #[tokio::test] async fn product_signet() { completion_case(true, Completion::$completion, ReportReply::network(Some("signet"))).await; }
        }
    };
}
completion_variant!(isolated_commit, Commit);
completion_variant!(finalize_continuation, Finalize);
completion_variant!(reconcile_continuation, Reconcile);

#[tokio::test]
async fn failed_reports_retain_submitted_receipt() {
    for (status, raw) in [(401, None), (500, None), (200, Some("unreadable".into()))] {
        completion_case(false, Completion::Commit, ReportReply { network: None, status, raw }).await;
    }
}

#[tokio::test]
async fn buffered_report_cannot_complete_owner_setup() {
    let (state, _dir, _server, control) = established(false, false, false).await;
    submitted(&state);
    open_approvals(&state);
    let barrier = Arc::new(ReportPause::default());
    *control.pause.lock().unwrap() = Some(barrier.clone());
    let commit = complete(&state, Completion::Commit);
    tokio::pin!(commit);
    tokio::select! {
        _ = barrier.arrived.notified() => {},
        result = &mut commit => panic!("commit ended before its report: {result:?}"),
        _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("report was not requested"),
    }
    let epoch = *state.network_auth_epoch.lock().unwrap();
    state.refuse_network(crate::network_policy::NetworkRefusal::Mainnet);
    barrier.release();
    assert!(commit.await.is_err(), "a buffered report must not publish readiness");
    assert_retired(&state, &control, epoch, "mainnet").await;
    assert!(state.owner.pending.lock().unwrap().as_ref().unwrap().submitted);
}

#[tokio::test]
async fn obsolete_report_preserves_replacement_setup() {
    for network in ["signet", "bitcoin"] {
        let (state, _dir, _server, control) = established(false, false, false).await;
        submitted(&state);
        open_approvals(&state);
        *control.reply.lock().unwrap() = Some(ReportReply::network(Some(network)));
        let barrier = Arc::new(ReportPause::default());
        *control.pause.lock().unwrap() = Some(barrier.clone());
        let commit = complete(&state, Completion::Commit);
        tokio::pin!(commit);
        tokio::select! {
            _ = barrier.arrived.notified() => {},
            result = &mut commit => panic!("commit ended before its report: {result:?}"),
            _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("report was not requested"),
        }
        state.remote_connect_generation.send_modify(|generation| *generation += 1);
        *state.token.lock().unwrap() = Some("replacement".into());
        *state.ready.lock().unwrap() = true;
        *state.node_id.lock().unwrap() = Some("replacement-node".into());
        barrier.release();
        assert!(commit.await.is_err());
        assert!(state.token.lock().unwrap().as_deref() == Some("replacement"));
        assert!(state.status_snapshot().ready);
        assert_eq!(state.status_snapshot().node_id.as_deref(), Some("replacement-node"));
        assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
        assert!(state.node_grant.lock().unwrap().is_some());
        assert!(state.owner.pending.lock().unwrap().as_ref().unwrap().submitted);
        assert_eq!(state.pairing_snapshot().bootstrap.as_deref(), Some("bootstrap"));
    }
}
