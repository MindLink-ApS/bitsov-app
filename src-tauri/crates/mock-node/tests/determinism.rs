#[path = "common/mod.rs"]
#[allow(dead_code)]
mod common;

use mock_node::{paths, Answer, AnswerKey, Fault, MockNode, ReadFailure, Route};

#[test]
fn the_same_route_serializes_identically_every_time() {
    let node = MockNode::canonical();
    for path in common::fresh_paths() {
        let first_text = serde_json::to_string(&common::body_of(node.serve(&path))).expect("json");
        for _ in 0..20 {
            let again = serde_json::to_string(&common::body_of(node.serve(&path))).expect("json");
            assert_eq!(again, first_text, "{path}");
        }
    }
}

#[test]
fn two_canonical_nodes_agree() {
    let left = MockNode::canonical();
    let right = MockNode::canonical();
    for path in common::fresh_paths() {
        assert_eq!(left.serve(&path), right.serve(&path), "{path}");
        assert_eq!(left.read(&path).ok(), right.read(&path).ok(), "{path}");
    }
    for key in AnswerKey::ALL {
        assert_eq!(left.answer(key), right.answer(key));
    }
}

#[test]
fn prefix_less_paths_are_not_routes() {
    let node = MockNode::canonical();
    for path in ["/payments/balance", "/health", "/messages", "/status"] {
        assert_eq!(node.read(path), Err(ReadFailure::NotFound), "{path}");
        let body = common::body_of(node.serve(path));
        assert_eq!(body["code"], 404);
        assert_eq!(body["error"], "route");
    }
}

#[test]
fn a_fault_does_not_change_any_other_route() {
    let fresh = MockNode::canonical();
    let faulty = MockNode::canonical().fault(Route::Health, Fault::Error);
    assert_eq!(fresh.serve(paths::BALANCE), faulty.serve(paths::BALANCE));
    assert_eq!(fresh.serve(paths::CHANNELS), faulty.serve(paths::CHANNELS));
    assert_eq!(fresh.serve(paths::MESSAGES), faulty.serve(paths::MESSAGES));
    assert!(matches!(
        faulty.read(paths::HEALTH),
        Err(ReadFailure::RouteError)
    ));
}

#[test]
fn answers_do_not_depend_on_call_order() {
    let node = MockNode::canonical();
    let forward: Vec<Answer> = AnswerKey::ALL
        .into_iter()
        .map(|key| node.answer(key))
        .collect();
    let backward: Vec<Answer> = AnswerKey::ALL
        .into_iter()
        .rev()
        .map(|key| node.answer(key))
        .collect();
    let mut backward = backward;
    backward.reverse();
    assert_eq!(forward, backward);
}

#[test]
fn injected_faults_are_stable() {
    for mode in [Fault::Error, Fault::Timeout, Fault::Stale] {
        let node = MockNode::canonical().fault(Route::PaymentsBalance, mode);
        let first = node.serve(paths::BALANCE);
        assert_eq!(first, node.serve(paths::BALANCE));
        assert_eq!(
            node.answer(AnswerKey::TotalBalanceMsat),
            Answer::Unavailable
        );
    }
}
